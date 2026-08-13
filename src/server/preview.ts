import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  PreviewGenerationRequestSchema,
  PreviewPromptSchema,
  PreviewSettingsRequestSchema,
  type PreviewGenerationRequest,
  type PreviewSettingsRequest,
  type PreviewStatus,
} from "../shared/contracts";
import type { InProgressConfig } from "./config";
import { runBounded } from "./process";
import { ProjectRegistry } from "./projects";
import { HttpError } from "./security";
import type { StateStore } from "./store";

const MODEL = "gpt-5.6-sol" as const;
const REASONING_EFFORT = "max" as const;
const GENERATION_TIMEOUT_MS = 70 * 60 * 1_000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1_000;
const AUTOMATIC_INTERVAL_MS = 5_000;
const CREDENTIAL_ENV = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]);
const ARTIFACT_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PAGER: "cat",
  PATH: "/usr/bin:/bin",
};
const RevisionSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const GenerationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    sourceRevision: RevisionSchema.nullable(),
    sourceDirty: z.boolean(),
    strategy: z.enum(["fresh", "update"]),
    basedOnSourceRevision: RevisionSchema.nullable(),
    prompt: PreviewPromptSchema,
  })
  .strict();
const PreviewIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    projects: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,62}$/)).max(1_000),
    generations: z.array(GenerationRecordSchema).max(1_000).default([]),
  })
  .strict()
  .refine(
    (index) =>
      new Set(index.projects).size === index.projects.length &&
      index.projects.every(
        (project, position) => position === 0 || index.projects[position - 1]! < project,
      ) &&
      new Set(index.generations.map((record) => record.project)).size ===
        index.generations.length &&
      index.generations.every(
        (record, position) =>
          index.projects.includes(record.project) &&
          (position === 0 || index.generations[position - 1]!.project < record.project),
      ),
  );
const StoredSettingsSchema = z
  .object({
    mode: z.enum(["manual", "automatic"]),
    prompt: PreviewPromptSchema,
    failedRevision: RevisionSchema.nullable(),
  })
  .strict();

type StoredSettings = z.infer<typeof StoredSettingsSchema>;

interface RunState {
  state: PreviewStatus["state"];
  revision: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

interface ActiveRun {
  projectId: string;
  controller: AbortController;
  job: Promise<void>;
}

interface PreviewServiceOptions {
  automaticIntervalMs?: number;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !CREDENTIAL_ENV.has(entry[0]),
    ),
  );
}

function initialState(): RunState {
  return { state: "idle", revision: 0, startedAt: null, finishedAt: null, error: null };
}

function initialSettings(): StoredSettings {
  return { mode: "manual", prompt: "", failedRevision: null };
}

export class PreviewService {
  readonly #states = new Map<string, RunState>();
  readonly #automaticTimer: ReturnType<typeof setInterval> | null;
  #active: ActiveRun | null = null;
  #admitting = false;
  #artifactGitCache: { expiresAt: number; value: Promise<boolean> } | null = null;
  #closed = false;
  #scanning = false;

  constructor(
    readonly config: InProgressConfig["integrations"]["preview"],
    readonly projects: ProjectRegistry,
    readonly store: StateStore,
    options: PreviewServiceOptions = {},
  ) {
    const interval = options.automaticIntervalMs ?? AUTOMATIC_INTERVAL_MS;
    this.#automaticTimer =
      this.config && interval > 0 ? setInterval(() => void this.scanAutomatic(), interval) : null;
    this.#automaticTimer?.unref();
    if (this.config && interval > 0) queueMicrotask(() => void this.scanAutomatic());
  }

  async status(projectId: string): Promise<PreviewStatus> {
    const integration = this.#integration();
    this.projects.get(projectId);
    const [git, sourceRevision, artifactGitTracked] = await Promise.all([
      this.projects.git(projectId),
      this.projects.gitRevision(projectId),
      this.#artifactGitTracked(integration),
    ]);
    const current = this.#states.get(projectId) ?? initialState();
    const settings = this.#settings(projectId);
    const packaged = this.#packageIndex(integration);
    const record =
      packaged.generations.find((candidate) => candidate.project === projectId) ?? null;
    const dashboard = packaged.projects.includes(projectId);
    const sourceDirty = git.available && !git.clean;
    const stale =
      !dashboard ||
      !record ||
      !artifactGitTracked ||
      record.prompt !== settings.prompt ||
      (sourceRevision !== null &&
        (record?.sourceRevision !== sourceRevision || record.sourceDirty || sourceDirty));
    let automaticBlockedReason: string | null = null;
    if (settings.mode === "automatic") {
      if (sourceRevision === null) {
        automaticBlockedReason = "Automatic Preview requires a project Git commit";
      } else if (sourceDirty) {
        automaticBlockedReason = "Automatic Preview waits for a clean worktree";
      } else if (settings.failedRevision === sourceRevision) {
        automaticBlockedReason =
          "Automatic Preview already failed for this commit; run manually or commit a new change";
      }
    }
    return {
      projectId,
      dashboard,
      state: current.state,
      activeProjectId: this.#active?.projectId ?? null,
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      artifactDirectory: integration.artifactDirectory,
      revision: current.revision,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
      error: current.error,
      mode: settings.mode,
      prompt: settings.prompt,
      sourceRevision,
      generatedRevision: record?.sourceRevision ?? null,
      sourceDirty,
      stale,
      automaticBlockedReason,
      lastStrategy: record?.strategy ?? null,
      artifactGitTracked,
    };
  }

  async configure(projectId: string, input: PreviewSettingsRequest): Promise<PreviewStatus> {
    this.#integration();
    this.projects.get(projectId);
    if (this.#closed) throw new HttpError(503, "Preview service is closed");
    const settings = PreviewSettingsRequestSchema.parse(input);
    this.#saveSettings(projectId, { ...settings, failedRevision: null });
    if (settings.mode === "automatic") queueMicrotask(() => void this.scanAutomatic());
    return this.status(projectId);
  }

  async start(projectId: string, input: PreviewGenerationRequest): Promise<PreviewStatus> {
    const integration = this.#integration();
    const project = this.projects.get(projectId);
    const request = PreviewGenerationRequestSchema.parse(input);
    if (this.#closed) throw new HttpError(503, "Preview service is closed");
    if (this.#active || this.#admitting)
      throw new HttpError(409, "Another Preview generation is already running");
    this.#admitting = true;
    try {
      const before = await this.status(projectId);
      if (this.#closed) throw new HttpError(503, "Preview service is closed");
      const settings = this.#settings(projectId);
      this.#saveSettings(projectId, { ...settings, prompt: request.prompt, failedRevision: null });
      this.#launch({
        projectId,
        projectPath: project.path,
        integration,
        strategy: request.strategy,
        prompt: request.prompt,
        expectedRevision: null,
        automatic: false,
        sourceRevision: before.sourceRevision,
      });
      return {
        ...before,
        state: "generating",
        activeProjectId: projectId,
        prompt: request.prompt,
        stale: before.stale || request.prompt !== before.prompt,
        startedAt: this.#states.get(projectId)!.startedAt,
        finishedAt: null,
        error: null,
      };
    } finally {
      this.#admitting = false;
    }
  }

  async scanAutomatic(): Promise<void> {
    if (this.#closed || this.#active || this.#admitting || this.#scanning || !this.config) return;
    this.#scanning = true;
    this.#admitting = true;
    try {
      for (const project of this.projects.all()) {
        let settings: StoredSettings;
        try {
          settings = this.#settings(project.id);
        } catch {
          continue;
        }
        if (settings.mode !== "automatic") continue;
        let status: PreviewStatus;
        try {
          status = await this.status(project.id);
        } catch {
          continue;
        }
        if (this.#closed || this.#active) break;
        if (!status.stale || status.automaticBlockedReason || status.sourceRevision === null)
          continue;
        const integration = this.#integration();
        this.#launch({
          projectId: project.id,
          projectPath: project.path,
          integration,
          strategy: status.dashboard ? "update" : "fresh",
          prompt: settings.prompt,
          expectedRevision: status.sourceRevision,
          automatic: true,
          sourceRevision: status.sourceRevision,
        });
        break;
      }
    } finally {
      this.#admitting = false;
      this.#scanning = false;
    }
  }

  #launch(input: {
    projectId: string;
    projectPath: string;
    integration: NonNullable<InProgressConfig["integrations"]["preview"]>;
    strategy: PreviewGenerationRequest["strategy"];
    prompt: string;
    expectedRevision: string | null;
    automatic: boolean;
    sourceRevision: string | null;
  }): void {
    const prior = this.#states.get(input.projectId) ?? initialState();
    const startedAt = new Date().toISOString();
    this.#states.set(input.projectId, {
      ...prior,
      state: "generating",
      startedAt,
      finishedAt: null,
      error: null,
    });
    const controller = new AbortController();
    const job = this.#run(input, controller.signal);
    const active = { projectId: input.projectId, controller, job };
    this.#active = active;
    void job.finally(() => {
      if (this.#active === active) this.#active = null;
      if (!this.#closed) queueMicrotask(() => void this.scanAutomatic());
    });
  }

  async #run(
    input: {
      projectId: string;
      projectPath: string;
      integration: NonNullable<InProgressConfig["integrations"]["preview"]>;
      strategy: PreviewGenerationRequest["strategy"];
      prompt: string;
      expectedRevision: string | null;
      automatic: boolean;
      sourceRevision: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const env = { ...processEnvironment(), PYTHONDONTWRITEBYTECODE: "1" };
    const generationArgv = [
      input.integration.executable,
      "generate",
      input.projectId,
      "--source",
      input.projectPath,
      "--artifact-root",
      input.integration.artifactDirectory,
      "--codex-executable",
      input.integration.codexExecutable,
      "--prompt-stdin",
      ...(input.strategy === "fresh" ? ["--from-scratch"] : []),
      ...(input.expectedRevision ? ["--expected-revision", input.expectedRevision] : []),
    ];
    try {
      await runBounded(generationArgv, {
        cwd: input.integration.sourceDirectory,
        env,
        timeoutMs: GENERATION_TIMEOUT_MS,
        stdoutBytes: 1024 * 1024,
        label: "Preview generation",
        signal,
        stdin: input.prompt,
      });
      await runBounded(
        [
          input.integration.executable,
          "plugin-build",
          "--artifact-root",
          input.integration.artifactDirectory,
          "--git-track",
          ...this.projects.all().flatMap((project) => ["--source", project.id, project.path]),
        ],
        {
          cwd: input.integration.sourceDirectory,
          env,
          timeoutMs: BUILD_TIMEOUT_MS,
          stdoutBytes: 1024 * 1024,
          label: "Preview dashboard packaging",
          signal,
        },
      );
      const prior = this.#states.get(input.projectId) ?? initialState();
      this.#states.set(input.projectId, {
        ...prior,
        state: "idle",
        revision: prior.revision + 1,
        finishedAt: new Date().toISOString(),
        error: null,
      });
      const settings = this.#settings(input.projectId);
      this.#saveSettings(input.projectId, { ...settings, failedRevision: null });
    } catch (error) {
      const prior = this.#states.get(input.projectId) ?? initialState();
      this.#states.set(input.projectId, {
        ...prior,
        state: "error",
        finishedAt: new Date().toISOString(),
        error: error instanceof HttpError ? error.message : "Preview generation failed",
      });
      const settings = this.#settings(input.projectId);
      const canceled = error instanceof HttpError && error.status === 503;
      if (
        !canceled &&
        input.sourceRevision !== null &&
        (input.automatic || settings.mode === "automatic")
      ) {
        this.#saveSettings(input.projectId, {
          ...settings,
          failedRevision: input.sourceRevision,
        });
      }
    } finally {
      this.#artifactGitCache = null;
    }
  }

  #packageIndex(
    integration: NonNullable<InProgressConfig["integrations"]["preview"]>,
  ): z.infer<typeof PreviewIndexSchema> {
    const path = join(integration.artifactDirectory, "in-progress-plugin", "preview-index.json");
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 * 1024) {
        throw new Error();
      }
      return PreviewIndexSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, projects: [], generations: [] };
      }
      throw new HttpError(502, "Preview dashboard index is invalid");
    }
  }

  #artifactGitTracked(
    integration: NonNullable<InProgressConfig["integrations"]["preview"]>,
  ): Promise<boolean> {
    const cached = this.#artifactGitCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.#readArtifactGitTracked(integration);
    this.#artifactGitCache = { expiresAt: Date.now() + 2_000, value };
    return value;
  }

  async #readArtifactGitTracked(
    integration: NonNullable<InProgressConfig["integrations"]["preview"]>,
  ): Promise<boolean> {
    const path = join(integration.artifactDirectory, ".git");
    try {
      const metadata = lstatSync(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
      const [status, remotes] = await Promise.all([
        runBounded(
          [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=normal",
            "--",
            ".gitignore",
            "previews",
            "in-progress-plugin",
          ],
          {
            cwd: integration.artifactDirectory,
            env: ARTIFACT_GIT_ENV,
            timeoutMs: 3_000,
            stdoutBytes: 1024 * 1024,
            label: "Preview artifact Git status",
          },
        ),
        runBounded(["git", "remote"], {
          cwd: integration.artifactDirectory,
          env: ARTIFACT_GIT_ENV,
          timeoutMs: 3_000,
          stdoutBytes: 64 * 1024,
          label: "Preview artifact Git remotes",
        }),
      ]);
      const lines = status.stdout.trimEnd().split("\n");
      return lines.length === 1 && lines[0] === "## main" && remotes.stdout.trim() === "";
    } catch {
      return false;
    }
  }

  #settings(projectId: string): StoredSettings {
    const raw = this.store.getMeta(`preview.settings.${projectId}`);
    if (raw === null) return initialSettings();
    try {
      return StoredSettingsSchema.parse(JSON.parse(raw));
    } catch {
      throw new HttpError(500, "Preview settings are invalid");
    }
  }

  #saveSettings(projectId: string, settings: StoredSettings): void {
    this.store.setMeta(
      `preview.settings.${projectId}`,
      JSON.stringify(StoredSettingsSchema.parse(settings)),
    );
  }

  #integration(): NonNullable<InProgressConfig["integrations"]["preview"]> {
    if (!this.config) throw new HttpError(503, "Preview integration is not configured");
    return this.config;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#automaticTimer) clearInterval(this.#automaticTimer);
    const active = this.#active;
    if (!active) return;
    active.controller.abort();
    await active.job;
  }
}
