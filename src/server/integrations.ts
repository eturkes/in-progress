import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import {
  DriftAnalyzeRequestSchema,
  DriftValidateTracesRequestSchema,
  TreeForkRequestSchema,
  type AlignSetupRequest,
  type AlignStatus,
  type DriftRender,
  type DriftValidatedTraces,
  driftReportPath,
} from "../shared/contracts";
import type { InProgressConfig } from "./config";
import { runBounded } from "./process";
import { ProjectRegistry } from "./projects";
import { HttpError } from "./security";
import {
  loadTreeCompleteModule,
  TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES,
  type TreeCompleteService,
} from "./tree-complete";

const AlignStatusDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    initialized: z.boolean(),
    contract: z
      .object({
        state: z.enum(["missing", "ambiguous", "provisional", "accepted"]),
        selected_id: z.string().max(200).nullable(),
      })
      .passthrough(),
    latest: z
      .object({
        snapshot: z
          .object({ stage: z.string().max(200) })
          .passthrough()
          .nullable(),
        matching_assessment_count: z.number().int().nonnegative(),
        matching_report_count: z.number().int().nonnegative(),
      })
      .passthrough(),
    totals: z
      .object({
        amendments: z.number().int().nonnegative(),
        assessments: z.number().int().nonnegative(),
        checkpoints: z.number().int().nonnegative(),
        contracts: z.number().int().nonnegative(),
        reports: z.number().int().nonnegative(),
        snapshots: z.number().int().nonnegative(),
      })
      .passthrough(),
    next_action: z
      .object({ command: z.string().max(4_096), reason: z.string().max(2_000) })
      .strict()
      .nullable(),
  })
  .passthrough();

const TreeIdSchema = z.string().min(1).max(200);
const TreeTextSchema = z.string().max(100_000);
const TreeAlternativeSchema = z
  .object({
    id: TreeIdSchema,
    label: z.string().max(2_000),
    description: TreeTextSchema,
    impact: TreeTextSchema,
    agentBrief: TreeTextSchema,
    signal: z.enum(["recommended", "balanced", "experimental"]),
  })
  .strict();
const TreeDecisionSchema = z
  .object({
    id: TreeIdSchema,
    title: z.string().max(2_000),
    question: TreeTextSchema,
    rationale: TreeTextSchema,
    chosenAlternativeId: TreeIdSchema,
    alternatives: z.array(TreeAlternativeSchema).max(100),
  })
  .strict();
const TreeVersionSchema = z
  .object({
    id: TreeIdSchema,
    parentId: TreeIdSchema.nullable(),
    name: z.string().max(2_000),
    branch: z.string().max(2_000),
    commit: z.string().max(2_000),
    createdAt: z.string().max(100),
    status: z.enum(["ready", "queued", "working", "complete", "failed"]),
    summary: TreeTextSchema,
    decisions: z.array(TreeDecisionSchema).max(200),
    forkOrigin: z
      .object({
        decisionId: TreeIdSchema,
        fromAlternativeId: TreeIdSchema,
        toAlternativeId: TreeIdSchema,
      })
      .strict()
      .optional(),
    runId: TreeIdSchema.optional(),
    changedFiles: z.number().int().nonnegative().optional(),
  })
  .strict();
const TreeRunResultSchema = z
  .object({
    changeKind: z.enum(["measured", "simulated"]),
    changedFileCount: z.number().int().nonnegative(),
    changedFiles: z.array(z.string().max(240)).max(40),
    changedFilesTruncated: z.boolean(),
    checks: z
      .array(
        z
          .object({
            id: TreeIdSchema,
            label: z.string().max(2_000),
            detail: TreeTextSchema,
            status: z.enum(["passed", "simulated"]),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();
const TreeRunSchema = z
  .object({
    id: TreeIdSchema,
    versionId: TreeIdSchema,
    mode: z.enum(["preview", "codex"]),
    phase: z.enum(["queued", "preparing", "generating", "verifying", "complete", "failed"]),
    progress: z.number().finite().min(0).max(100),
    startedAt: z.string().max(100),
    completedAt: z.string().max(100).optional(),
    error: TreeTextSchema.optional(),
    result: TreeRunResultSchema.optional(),
    logs: z
      .array(
        z
          .object({
            id: TreeIdSchema,
            at: z.string().max(100),
            message: TreeTextSchema,
            tone: z.enum(["muted", "active", "success", "error"]),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();
const TreeWorkspaceSchema = z
  .object({
    project: z
      .object({
        id: TreeIdSchema,
        name: z.string().max(2_000),
        description: TreeTextSchema,
        repository: z.string().max(4_096),
        defaultBranch: z.string().max(2_000),
      })
      .strict(),
    runner: z
      .object({
        mode: z.enum(["preview", "codex"]),
        available: z.boolean(),
        label: z.string().max(2_000),
        detail: TreeTextSchema,
      })
      .strict(),
    versions: z.array(TreeVersionSchema).max(5_000),
    runs: z.array(TreeRunSchema).max(5_000),
    updatedAt: z.string().max(100),
  })
  .strict();

const TreeForkResponseSchema = z
  .object({
    runId: z.string().min(1).max(200),
    versionId: z.string().min(1).max(200),
    workspace: TreeWorkspaceSchema,
  })
  .strict();

const ISOLATED_TOOL_ENV = {
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/bin:/bin",
};
const DRIFT_ANALYZE_TIMEOUT_MS = 20 * 60_000 + 30_000;
const DRIFT_ATTEMPTS = 2;
const DRIFT_MODEL = "gpt-5.6-sol";
const DRIFT_OBSERVER_TIMEOUT_SECONDS = 600;

const ALIGN_BOOTSTRAP = [
  "import runpy,sys",
  "sys.path.insert(0,sys.argv[1])",
  "sys.argv=['align','--root',sys.argv[2],'status','--format','json']",
  "runpy.run_module('align',run_name='__main__',alter_sys=True)",
].join(";");

const ALIGN_INIT_BOOTSTRAP = [
  "import runpy,sys",
  "source,root,title=sys.argv[1:4]",
  "sys.path.insert(0,source)",
  "sys.argv=['align','--root',root,'init','--prompt','-','--authority','user','--stage','in_progress','--title',title]",
  "runpy.run_module('align',run_name='__main__',alter_sys=True)",
].join(";");

function localProjectText(text: string, projectPath: string): string {
  const quotedFragment = projectPath.replaceAll("'", "'\"'\"'");
  const byteFragment = [...new TextEncoder().encode(projectPath)]
    .map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`)
    .join("");
  return text
    .replaceAll(byteFragment, "\\x2e")
    .replaceAll(quotedFragment, ".")
    .replaceAll(projectPath, ".")
    .replaceAll("'.'", ".")
    .replaceAll("$'\\x2e'", ".");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

function pathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function ensureDriftReportDirectory(projectRoot: string): Promise<string> {
  let current = projectRoot;
  for (const segment of [".drift", "reports"]) {
    const candidate = join(current, segment);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new HttpError(502, "Drift report directory is unavailable");
      }
      try {
        await mkdir(candidate, { mode: 0o700 });
        info = await lstat(candidate);
      } catch (createError) {
        if (errorCode(createError) !== "EEXIST") {
          throw new HttpError(502, "Drift report directory could not be created");
        }
        info = await lstat(candidate).catch(() => {
          throw new HttpError(409, "Drift report directory is unsafe");
        });
      }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new HttpError(409, "Drift report directory is unsafe");
    }
    const canonical = await realpath(candidate).catch(() => {
      throw new HttpError(409, "Drift report directory is unsafe");
    });
    if (!pathWithin(projectRoot, canonical)) {
      throw new HttpError(409, "Drift report directory is unsafe");
    }
    current = canonical;
  }
  return current;
}

export class IntegrationRegistry {
  readonly #treeServices = new Map<string, Promise<TreeCompleteService>>();
  readonly #alignInitializations = new Map<string, Promise<AlignStatus>>();
  readonly #driftAnalyses = new Map<string, Promise<DriftRender>>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(
    readonly config: InProgressConfig["integrations"],
    readonly projects: ProjectRegistry,
    readonly dataDir: string,
  ) {}

  async dispatch(
    projectId: string,
    method:
      | "align.status"
      | "drift.render"
      | "drift.validateTraces"
      | "drift.analyze"
      | "tree-complete.workspace"
      | "tree-complete.createFork",
    params: unknown,
  ): Promise<unknown> {
    if (this.#closed) throw new HttpError(503, "Integration registry is closed");
    switch (method) {
      case "align.status": {
        z.undefined().parse(params);
        return await this.#alignStatus(projectId);
      }
      case "drift.render":
        return await this.#driftRender(projectId, params);
      case "drift.validateTraces":
        return await this.#driftValidateTraces(projectId, params);
      case "drift.analyze":
        return await this.#driftAnalyze(projectId, params);
      case "tree-complete.workspace": {
        z.undefined().parse(params);
        return await this.#treeWorkspace(projectId);
      }
      case "tree-complete.createFork":
        return await this.#treeCreateFork(projectId, params);
    }
  }

  async #alignStatus(projectId: string): Promise<AlignStatus> {
    const integration = this.config.align;
    if (!integration) throw new HttpError(503, "Align integration is not configured");
    const project = this.projects.get(projectId);
    const { stdout } = await runBounded(
      [
        integration.pythonExecutable,
        "-I",
        "-B",
        "-S",
        "-c",
        ALIGN_BOOTSTRAP,
        join(integration.sourceDirectory, "src"),
        project.path,
      ],
      {
        cwd: integration.sourceDirectory,
        env: ISOLATED_TOOL_ENV,
        timeoutMs: 15_000,
        stdoutBytes: 8 * 1024 * 1024,
        label: "Align status",
      },
    );
    let document: unknown;
    try {
      document = JSON.parse(stdout);
    } catch {
      throw new HttpError(502, "Align returned malformed JSON");
    }
    const parsed = AlignStatusDocumentSchema.safeParse(document);
    if (!parsed.success) throw new HttpError(502, "Align returned an incompatible status document");
    const status = parsed.data;
    const rawStage = status.latest.snapshot?.stage;
    const stage =
      rawStage === "pre_task" ||
      rawStage === "in_progress" ||
      rawStage === "candidate_final" ||
      rawStage === "released"
        ? rawStage
        : null;
    return {
      initialized: status.initialized,
      contract: { state: status.contract.state, id: status.contract.selected_id },
      latest: {
        stage,
        assessmentCount: status.latest.matching_assessment_count,
        reportCount: status.latest.matching_report_count,
      },
      totals: {
        amendments: status.totals.amendments,
        assessments: status.totals.assessments,
        checkpoints: status.totals.checkpoints,
        contracts: status.totals.contracts,
        reports: status.totals.reports,
        snapshots: status.totals.snapshots,
      },
      nextAction: status.next_action
        ? {
            command: localProjectText(status.next_action.command, project.path),
            reason: localProjectText(status.next_action.reason, project.path),
          }
        : null,
    };
  }

  async initializeAlign(projectId: string, request: AlignSetupRequest): Promise<AlignStatus> {
    if (this.#closed) throw new HttpError(503, "Integration registry is closed");
    const projectKey = this.projects.get(projectId).path;
    if (this.#alignInitializations.has(projectKey)) {
      throw new HttpError(409, "Alignment is already being initialized");
    }
    const operation = this.#initializeAlign(projectId, request);
    let tracked: Promise<AlignStatus>;
    tracked = operation.finally(() => {
      if (this.#alignInitializations.get(projectKey) === tracked) {
        this.#alignInitializations.delete(projectKey);
      }
    });
    this.#alignInitializations.set(projectKey, tracked);
    return tracked;
  }

  async #initializeAlign(projectId: string, request: AlignSetupRequest): Promise<AlignStatus> {
    const integration = this.config.align;
    if (!integration) throw new HttpError(503, "Align integration is not configured");
    const project = this.projects.get(projectId);
    if ((await this.#alignStatus(projectId)).initialized) {
      throw new HttpError(409, "Alignment is already initialized");
    }
    await runBounded(
      [
        integration.pythonExecutable,
        "-I",
        "-B",
        "-S",
        "-c",
        ALIGN_INIT_BOOTSTRAP,
        join(integration.sourceDirectory, "src"),
        project.path,
        project.name,
      ],
      {
        cwd: integration.sourceDirectory,
        env: ISOLATED_TOOL_ENV,
        timeoutMs: 60_000,
        stdoutBytes: 4 * 1024,
        label: "Align setup",
        stdin: request.prompt,
      },
    );
    const status = await this.#alignStatus(projectId);
    if (!status.initialized) throw new HttpError(502, "Align setup did not initialize the project");
    return status;
  }

  async #driftRender(projectId: string, rawParams: unknown): Promise<DriftRender> {
    const integration = this.config.drift;
    if (!integration) throw new HttpError(503, "Drift integration is not configured");
    const params = z
      .object({
        path: z
          .string()
          .min(1)
          .max(1_024)
          .regex(/\.json$/i, "Drift report must be JSON"),
      })
      .strict()
      .parse(rawParams);
    const project = this.projects.get(projectId);
    const report = await this.projects.resolveFile(projectId, params.path);
    const { stdout } = await runBounded([integration.executable, "render", report], {
      cwd: project.path,
      env: ISOLATED_TOOL_ENV,
      timeoutMs: 15_000,
      stdoutBytes: 1024 * 1024,
      label: "Drift render",
    });
    return { path: params.path, text: stdout };
  }

  async #driftTraceIsValid(projectPath: string, trace: string): Promise<boolean> {
    const integration = this.config.drift;
    if (!integration) throw new HttpError(503, "Drift integration is not configured");
    try {
      await runBounded([integration.executable, "validate", trace], {
        cwd: projectPath,
        env: ISOLATED_TOOL_ENV,
        timeoutMs: 5_000,
        stdoutBytes: 64 * 1024,
        label: "Drift trace validation",
      });
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 422) return false;
      throw error;
    }
  }

  async #driftValidateTraces(projectId: string, rawParams: unknown): Promise<DriftValidatedTraces> {
    if (!this.config.drift) throw new HttpError(503, "Drift integration is not configured");
    const params = DriftValidateTracesRequestSchema.parse(rawParams);
    const project = this.projects.get(projectId);
    const valid: string[] = [];
    for (let offset = 0; offset < params.paths.length; offset += 4) {
      const chunk = params.paths.slice(offset, offset + 4);
      const results = await Promise.all(
        chunk.map(async (path) => {
          const trace = await this.projects.resolveFile(projectId, path);
          return await this.#driftTraceIsValid(project.path, trace);
        }),
      );
      for (const [index, isValid] of results.entries()) {
        if (isValid) valid.push(chunk[index]!);
      }
    }
    return { paths: valid };
  }

  async #driftAnalyze(projectId: string, rawParams: unknown): Promise<DriftRender> {
    if (this.#closed) throw new HttpError(503, "Integration registry is closed");
    const projectKey = this.projects.get(projectId).path;
    if (this.#driftAnalyses.has(projectKey)) {
      throw new HttpError(409, "A Drift trace is already being analyzed for this project");
    }
    const operation = this.#runDriftAnalysis(projectId, rawParams);
    let tracked: Promise<DriftRender>;
    tracked = operation.finally(() => {
      if (this.#driftAnalyses.get(projectKey) === tracked) this.#driftAnalyses.delete(projectKey);
    });
    this.#driftAnalyses.set(projectKey, tracked);
    return await tracked;
  }

  async #runDriftAnalysis(projectId: string, rawParams: unknown): Promise<DriftRender> {
    const integration = this.config.drift;
    if (!integration) throw new HttpError(503, "Drift integration is not configured");
    const params = DriftAnalyzeRequestSchema.parse(rawParams);
    const project = this.projects.get(projectId);
    const trace = await this.projects.resolveFile(projectId, params.path);
    if (!(await this.#driftTraceIsValid(project.path, trace))) {
      throw new HttpError(422, "Selected JSONL is not a valid Drift trace");
    }
    const reportPath = driftReportPath(params.path);
    const reportDirectory = await ensureDriftReportDirectory(project.path);
    const report = join(reportDirectory, reportPath.split("/").at(-1)!);
    const existing = await lstat(report).catch((error) => {
      if (errorCode(error) === "ENOENT") return null;
      throw new HttpError(502, "Drift report destination is unavailable");
    });
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new HttpError(409, "Drift report destination is unsafe");
    }
    await runBounded(
      [
        integration.executable,
        "analyze",
        "--codex",
        integration.codexExecutable,
        "--model",
        DRIFT_MODEL,
        "--timeout-seconds",
        String(DRIFT_OBSERVER_TIMEOUT_SECONDS),
        "--attempts",
        String(DRIFT_ATTEMPTS),
        "-o",
        report,
        "--",
        trace,
      ],
      {
        cwd: project.path,
        env: ISOLATED_TOOL_ENV,
        timeoutMs: DRIFT_ANALYZE_TIMEOUT_MS,
        stdoutBytes: 1024 * 1024,
        label: "Drift analysis",
      },
    );
    return await this.#driftRender(projectId, { path: reportPath });
  }

  async #treeWorkspace(projectId: string): Promise<unknown> {
    const project = this.projects.get(projectId);
    const redactions = this.#treeRedactions(project.path);
    try {
      const service = await this.#treeService(projectId);
      return boundedTreeResult(await service.workspace(), TreeWorkspaceSchema, redactions);
    } catch (error) {
      throw treeError(error, redactions, "Tree Complete workspace failed");
    }
  }

  async #treeCreateFork(projectId: string, rawParams: unknown): Promise<unknown> {
    const request = TreeForkRequestSchema.parse(rawParams);
    const project = this.projects.get(projectId);
    const redactions = this.#treeRedactions(project.path);
    try {
      const service = await this.#treeService(projectId);
      return boundedTreeResult(
        await service.createFork(request),
        TreeForkResponseSchema,
        redactions,
      );
    } catch (error) {
      throw treeError(error, redactions, "Tree Complete rejected the fork");
    }
  }

  #treeService(projectId: string): Promise<TreeCompleteService> {
    if (this.#closed) {
      return Promise.reject(new HttpError(503, "Integration registry is closed"));
    }
    const integration = this.config.treeComplete;
    if (!integration) {
      return Promise.reject(new HttpError(503, "Tree Complete integration is not configured"));
    }
    const existing = this.#treeServices.get(projectId);
    if (existing) return existing;
    const project = this.projects.get(projectId);
    const pending = (async () => {
      let module;
      try {
        module = await loadTreeCompleteModule(integration.sourceDirectory);
      } catch {
        throw new HttpError(503, "Tree Complete integration is not built");
      }
      let service: unknown;
      try {
        service = await module.createEmbeddedService({
          targetRepo: project.path,
          dataDir: join(this.dataDir, "tree-complete", project.id),
          mode: integration.mode,
        });
      } catch {
        throw new HttpError(503, "Tree Complete integration could not start");
      }
      const workspace = treeServiceMethod(service, "workspace");
      const createFork = treeServiceMethod(service, "createFork");
      const close = treeServiceMethod(service, "close");
      if (
        typeof workspace !== "function" ||
        typeof createFork !== "function" ||
        typeof close !== "function"
      ) {
        if (typeof close === "function") {
          try {
            await Reflect.apply(close, service, []);
          } catch {
            // Preserve the stable compatibility failure; the rejected candidate is never cached.
          }
        }
        throw new HttpError(503, "Tree Complete embedded service is incompatible");
      }
      return service as TreeCompleteService;
    })();
    this.#treeServices.set(projectId, pending);
    void pending.catch(() => this.#treeServices.delete(projectId));
    return pending;
  }

  #treeRedactions(projectPath: string): string[] {
    const source = this.config.treeComplete?.sourceDirectory;
    return [projectPath, this.dataDir, source].filter((value): value is string => Boolean(value));
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const alignInitializations = [...this.#alignInitializations.values()];
    this.#alignInitializations.clear();
    const driftAnalyses = [...this.#driftAnalyses.values()];
    this.#driftAnalyses.clear();
    const pending = [...this.#treeServices.values()];
    this.#treeServices.clear();
    this.#closing = (async () => {
      await Promise.allSettled([...alignInitializations, ...driftAnalyses]);
      const services = await Promise.allSettled(pending);
      const failures: unknown[] = services.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      const closeResults = await Promise.allSettled(
        services.flatMap((result) =>
          result.status === "fulfilled"
            ? [Promise.resolve().then(async () => await result.value.close())]
            : [],
        ),
      );
      failures.push(
        ...closeResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more integrations failed to close");
      }
    })();
    return this.#closing;
  }
}

function treeServiceMethod(service: unknown, name: "workspace" | "createFork" | "close"): unknown {
  if (service === null || (typeof service !== "object" && typeof service !== "function")) {
    return undefined;
  }
  try {
    return Reflect.get(service, name);
  } catch {
    return undefined;
  }
}

function boundedTreeResult<T extends z.ZodType>(
  value: unknown,
  schema: T,
  redactions: string[],
): z.infer<T> {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new HttpError(502, "Tree Complete returned non-JSON data");
  }
  if (typeof encoded !== "string") {
    throw new HttpError(502, "Tree Complete returned non-JSON data");
  }
  if (Buffer.byteLength(encoded) > TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES) {
    throw new HttpError(502, "Tree Complete response exceeded its limit");
  }
  const redacted = redactTreeValue(JSON.parse(encoded), redactions);
  const parsed = schema.safeParse(redacted);
  if (!parsed.success) throw new HttpError(502, "Tree Complete returned incompatible data");
  return parsed.data;
}

function redactTreeValue(value: unknown, redactions: string[]): unknown {
  if (typeof value === "string") {
    return redactions.reduce((text, path) => text.replaceAll(path, "[local path]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactTreeValue(item, redactions));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactTreeValue(item, redactions)]),
  );
}

function treeError(error: unknown, redactions: string[], fallback: string): HttpError {
  if (error instanceof HttpError) return error;
  const candidate = error as { statusCode?: unknown; message?: unknown };
  const allowed = new Set([400, 404, 409, 422, 429, 503]);
  const status =
    typeof candidate?.statusCode === "number" && allowed.has(candidate.statusCode)
      ? candidate.statusCode
      : 502;
  const raw = typeof candidate?.message === "string" ? candidate.message : fallback;
  const message = redactions
    .reduce((text, path) => text.replaceAll(path, "[local path]"), raw)
    .replaceAll(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, 300);
  return new HttpError(status, message || fallback);
}
