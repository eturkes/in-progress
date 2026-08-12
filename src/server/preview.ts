import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PreviewStatus } from "../shared/contracts";
import type { InProgressConfig } from "./config";
import { runBounded } from "./process";
import { ProjectRegistry } from "./projects";
import { HttpError } from "./security";

const MODEL = "gpt-5.6-sol" as const;
const REASONING_EFFORT = "max" as const;
const GENERATION_TIMEOUT_MS = 70 * 60 * 1_000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1_000;
const CREDENTIAL_ENV = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]);
const PreviewIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    projects: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,62}$/)).max(10_000),
  })
  .strict()
  .refine(
    (index) =>
      new Set(index.projects).size === index.projects.length &&
      index.projects.every(
        (project, position) => position === 0 || index.projects[position - 1]! < project,
      ),
  );

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

export class PreviewService {
  readonly #states = new Map<string, RunState>();
  #active: ActiveRun | null = null;
  #closed = false;

  constructor(
    readonly config: InProgressConfig["integrations"]["preview"],
    readonly projects: ProjectRegistry,
  ) {}

  status(projectId: string): PreviewStatus {
    const integration = this.#integration();
    this.projects.get(projectId);
    const current = this.#states.get(projectId) ?? initialState();
    return {
      projectId,
      dashboard: this.#packagedProjects(integration).has(projectId),
      state: current.state,
      activeProjectId: this.#active?.projectId ?? null,
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      artifactDirectory: integration.artifactDirectory,
      revision: current.revision,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
      error: current.error,
    };
  }

  start(projectId: string): PreviewStatus {
    const integration = this.#integration();
    const project = this.projects.get(projectId);
    if (this.#closed) throw new HttpError(503, "Preview service is closed");
    if (this.#active) throw new HttpError(409, "Another Preview generation is already running");
    const before = this.status(projectId);

    const prior = this.#states.get(projectId) ?? initialState();
    const startedAt = new Date().toISOString();
    this.#states.set(projectId, {
      ...prior,
      state: "generating",
      startedAt,
      finishedAt: null,
      error: null,
    });
    const controller = new AbortController();
    const job = this.#run(projectId, project.path, integration, controller.signal);
    const active = { projectId, controller, job };
    this.#active = active;
    void job.finally(() => {
      if (this.#active === active) this.#active = null;
    });
    return {
      ...before,
      state: "generating",
      activeProjectId: projectId,
      startedAt,
      finishedAt: null,
      error: null,
    };
  }

  async #run(
    projectId: string,
    projectPath: string,
    integration: NonNullable<InProgressConfig["integrations"]["preview"]>,
    signal: AbortSignal,
  ): Promise<void> {
    const env = { ...processEnvironment(), PYTHONDONTWRITEBYTECODE: "1" };
    try {
      await runBounded(
        [
          integration.executable,
          "generate",
          projectId,
          "--source",
          projectPath,
          "--artifact-root",
          integration.artifactDirectory,
          "--codex-executable",
          integration.codexExecutable,
        ],
        {
          cwd: integration.sourceDirectory,
          env,
          timeoutMs: GENERATION_TIMEOUT_MS,
          stdoutBytes: 1024 * 1024,
          label: "Preview generation",
          signal,
        },
      );
      await runBounded(
        [
          integration.executable,
          "plugin-build",
          "--artifact-root",
          integration.artifactDirectory,
          ...this.projects.all().flatMap((project) => ["--source", project.id, project.path]),
        ],
        {
          cwd: integration.sourceDirectory,
          env,
          timeoutMs: BUILD_TIMEOUT_MS,
          stdoutBytes: 1024 * 1024,
          label: "Preview dashboard packaging",
          signal,
        },
      );
      const prior = this.#states.get(projectId) ?? initialState();
      this.#states.set(projectId, {
        ...prior,
        state: "idle",
        revision: prior.revision + 1,
        finishedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      const prior = this.#states.get(projectId) ?? initialState();
      this.#states.set(projectId, {
        ...prior,
        state: "error",
        finishedAt: new Date().toISOString(),
        error: error instanceof HttpError ? error.message : "Preview generation failed",
      });
    }
  }

  #packagedProjects(
    integration: NonNullable<InProgressConfig["integrations"]["preview"]>,
  ): Set<string> {
    const path = join(integration.artifactDirectory, "in-progress-plugin", "preview-index.json");
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
        throw new Error();
      }
      return new Set(PreviewIndexSchema.parse(JSON.parse(readFileSync(path, "utf8"))).projects);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw new HttpError(502, "Preview dashboard index is invalid");
    }
  }

  #integration(): NonNullable<InProgressConfig["integrations"]["preview"]> {
    if (!this.config) throw new HttpError(503, "Preview integration is not configured");
    return this.config;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    if (!active) return;
    active.controller.abort();
    await active.job;
  }
}
