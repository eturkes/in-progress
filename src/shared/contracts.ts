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
}

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
