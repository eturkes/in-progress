import { z } from "zod";

export const PLUGIN_API_VERSION = "1.0" as const;

const PluginAssetPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Asset must be a relative public-file path without hidden segments",
  );

export const PluginCapabilitySchema = z.enum([
  "project.metadata",
  "project.tree",
  "project.readText",
  "project.git",
  "host.notify",
  "align.status",
  "drift.render",
  "drift.validateTraces",
  "drift.analyze",
  "tree-complete.workspace",
  "tree-complete.createFork",
]);

export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

export const PluginManifestSchema = z
  .object({
    apiVersion: z.literal(PLUGIN_API_VERSION),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,62}$/)
      .refine((id) => id !== "terminal", 'Plugin id "terminal" is reserved'),
    name: z.string().min(1).max(48),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    description: z.string().max(180),
    entry: z
      .string()
      .min(1)
      .max(240)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.html?$/i, "Entry must be a top-level HTML filename"),
    assets: z
      .array(PluginAssetPathSchema)
      .max(20_000)
      .default([])
      .refine((values) => new Set(values).size === values.length, "Assets must be unique"),
    icon: z.enum(["blocks", "chart", "files", "git-branch", "globe", "sparkles"]).default("blocks"),
    capabilities: z
      .array(PluginCapabilitySchema)
      .max(16)
      .default([])
      .refine((values) => new Set(values).size === values.length, "Capabilities must be unique"),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.assets.includes(manifest.entry)) {
      context.addIssue({
        code: "custom",
        message: "Entry document must not also be a public asset",
        path: ["assets"],
      });
    }
  });

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface ProjectDto {
  id: string;
  name: string;
  displayPath: string;
  color: string;
  branch: string | null;
  available: boolean;
}

export interface PluginDto {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: PluginManifest["icon"] | "terminal";
  capabilities: PluginCapability[];
  kind: "host" | "iframe";
  entryUrl?: string;
}

export interface TerminalSessionDto {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  attachedClients: number;
  state: "running" | "exited";
  exitCode?: number;
}

export const EventKindSchema = z.enum(["needs-input", "completed", "failed", "system"]);
export type EventKind = z.infer<typeof EventKindSchema>;

export interface EventDto {
  id: string;
  projectId: string | null;
  kind: EventKind;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  readAt: string | null;
}

export interface BootstrapDto {
  apiVersion: 1;
  csrfToken: string;
  identity: string;
  projects: ProjectDto[];
  plugins: PluginDto[];
  authority: {
    treeCompleteMode: "preview" | "codex" | null;
  };
  notification: {
    available: boolean;
    publicKey: string;
    subscriptionCount: number;
  };
}

export interface PreviewStatus {
  projectId: string;
  dashboard: boolean;
  state: "idle" | "generating" | "error";
  activeProjectId: string | null;
  model: "gpt-5.6-sol";
  reasoningEffort: "max";
  artifactDirectory: string;
  revision: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  mode: "manual" | "automatic";
  prompt: string;
  sourceRevision: string | null;
  generatedRevision: string | null;
  sourceDirty: boolean;
  stale: boolean;
  automaticBlockedReason: string | null;
  lastStrategy: "fresh" | "update" | null;
  artifactGitTracked: boolean;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export const AlignSetupRequestSchema = z
  .object({
    prompt: z
      .string()
      .refine((value) => value.trim().length > 0, "Alignment intent cannot be empty")
      .refine((value) => !value.includes("\0"), "Alignment intent cannot contain a null byte")
      .refine(
        (value) => !hasLoneSurrogate(value),
        "Alignment intent cannot contain a lone surrogate",
      )
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 60_000,
        "Alignment intent cannot exceed 60000 UTF-8 bytes",
      ),
  })
  .strict();

export type AlignSetupRequest = z.infer<typeof AlignSetupRequestSchema>;

export const DriftTracePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\0"), "Drift trace path cannot contain a null byte")
  .refine((value) => !hasLoneSurrogate(value), "Drift trace path cannot contain a lone surrogate")
  .refine(
    (value) =>
      !value.startsWith("/") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Drift trace path must be project-relative",
  )
  .regex(/\.jsonl$/i, "Drift trace must be JSONL");

export const DriftAnalyzeRequestSchema = z.object({ path: DriftTracePathSchema }).strict();

export type DriftAnalyzeRequest = z.infer<typeof DriftAnalyzeRequestSchema>;

export const DriftValidateTracesRequestSchema = z
  .object({
    paths: z
      .array(DriftTracePathSchema)
      .min(1)
      .max(32)
      .refine((paths) => new Set(paths).size === paths.length, "Drift trace paths must be unique"),
  })
  .strict();

export type DriftValidateTracesRequest = z.infer<typeof DriftValidateTracesRequestSchema>;

export interface DriftValidatedTraces {
  paths: string[];
}

export function driftReportPath(tracePath: string): string {
  const basename = tracePath.split("/").at(-1) ?? "trace.jsonl";
  const stem = basename.replace(/\.jsonl$/i, "");
  const slug =
    [...stem]
      .map((character) => (/^[A-Za-z0-9._-]$/.test(character) ? character : "-"))
      .join("")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 64) || "trace";
  let digest = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(tracePath)) {
    digest ^= BigInt(byte);
    digest = BigInt.asUintN(64, digest * 0x100000001b3n);
  }
  return `.drift/reports/${slug}-${digest.toString(16).padStart(16, "0")}.drift.json`;
}

export const PreviewPromptSchema = z
  .string()
  .refine((value) => !value.includes("\0"), "Preview prompt cannot contain a null byte")
  .refine((value) => !hasLoneSurrogate(value), "Preview prompt cannot contain a lone surrogate")
  .transform((value) => value.trim())
  .pipe(z.string().max(8_000));

export const PreviewGenerationRequestSchema = z
  .object({
    strategy: z.enum(["update", "fresh"]).default("update"),
    prompt: PreviewPromptSchema.default(""),
  })
  .strict();

export type PreviewGenerationRequest = z.infer<typeof PreviewGenerationRequestSchema>;

export const PreviewSettingsRequestSchema = z
  .object({
    mode: z.enum(["manual", "automatic"]),
    prompt: PreviewPromptSchema.default(""),
  })
  .strict();

export type PreviewSettingsRequest = z.infer<typeof PreviewSettingsRequestSchema>;

export const TreeForkRequestSchema = z
  .object({
    baseVersionId: z.string().min(1).max(200),
    decisionId: z.string().min(1).max(200),
    alternativeId: z.string().min(1).max(200),
  })
  .strict();

export type TreeForkRequest = z.infer<typeof TreeForkRequestSchema>;

export const PluginRpcRequestSchema = z
  .object({
    method: z.enum([
      "project.metadata",
      "project.tree",
      "project.readText",
      "project.git",
      "host.notify",
      "align.status",
      "drift.render",
      "drift.validateTraces",
      "drift.analyze",
      "tree-complete.workspace",
      "tree-complete.createFork",
    ]),
    params: z.unknown().optional(),
  })
  .strict();

export type PluginRpcRequest = z.infer<typeof PluginRpcRequestSchema>;

export const PushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().startsWith("https://").max(2_048),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({
      auth: z.string().min(1).max(512),
      p256dh: z.string().min(1).max(512),
    }),
  })
  .strict();

export const NotificationEventInputSchema = z
  .object({
    projectId: z.string().max(64).nullable().optional(),
    kind: EventKindSchema.default("completed"),
    title: z.string().trim().min(1).max(100),
    body: z.string().trim().max(240).default(""),
    url: z
      .string()
      .regex(/^\/(?!\/)[^\\\r\n]*$/, "URL must be a same-origin absolute path")
      .max(300)
      .default("/"),
  })
  .strict();

export type NotificationEventInput = z.infer<typeof NotificationEventInputSchema>;

export interface ProjectTreeEntry {
  path: string;
  name: string;
  kind: "directory" | "file" | "symlink";
  depth: number;
  size?: number;
}

export interface GitSummary {
  available: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  clean: boolean;
}

export interface AlignStatus {
  initialized: boolean;
  contract: {
    state: "missing" | "ambiguous" | "provisional" | "accepted";
    id: string | null;
  };
  latest: {
    stage: "pre_task" | "in_progress" | "candidate_final" | "released" | null;
    assessmentCount: number;
    reportCount: number;
  };
  totals: {
    amendments: number;
    assessments: number;
    checkpoints: number;
    contracts: number;
    reports: number;
    snapshots: number;
  };
  nextAction: {
    command: string;
    reason: string;
  } | null;
}

export interface DriftRender {
  path: string;
  text: string;
}
