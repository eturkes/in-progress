import { z } from "zod";

export const PLUGIN_API_VERSION = "1.0" as const;

export const PLUGIN_CAPABILITIES = [
  "project.metadata",
  "project.tree",
  "project.readText",
  "project.git",
  "host.notify",
  "align.status",
  "drift.render",
  "drift.validateTraces",
  "drift.recentSessions",
  "drift.importSession",
  "drift.analyze",
  "tree-complete.workspace",
  "tree-complete.createFork",
  "slide-gen.status",
  "slide-gen.generate",
  "slide-gen.render",
] as const;

export const PluginCapabilitySchema = z.enum(PLUGIN_CAPABILITIES);
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

const PluginAssetPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Asset must be a relative public-file path without hidden segments",
  );

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

const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const RelativePathSchema = z.string().min(1).max(1_024);
const ShortDateSchema = z.string().min(1).max(100);

export const PluginProjectSchema = z
  .object({
    id: ProjectIdSchema,
    name: z.string().min(1).max(64),
    color: ColorSchema,
    available: z.boolean(),
  })
  .strict();
export type PluginProject = z.infer<typeof PluginProjectSchema>;

export const ProjectMetadataSchema = PluginProjectSchema.extend({
  displayPath: z.string().min(1).max(4_096),
  branch: z.string().min(1).max(1_024).nullable(),
}).strict();
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

export const ProjectTreeParamsSchema = z
  .object({
    depth: z.number().int().min(1).max(6).optional(),
    limit: z.number().int().min(1).max(2_000).optional(),
  })
  .strict();
export type ProjectTreeParams = z.input<typeof ProjectTreeParamsSchema>;

export const ProjectTreeEntrySchema = z
  .object({
    path: RelativePathSchema,
    name: z.string().min(1).max(512),
    kind: z.enum(["directory", "file", "symlink"]),
    depth: z.number().int().min(0).max(6),
    size: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
export type ProjectTreeEntry = z.infer<typeof ProjectTreeEntrySchema>;

export const ProjectReadTextParamsSchema = z.object({ path: RelativePathSchema }).strict();
export const ProjectTextSchema = z
  .object({
    path: RelativePathSchema,
    text: z.string().max(256 * 1024),
    truncated: z.boolean(),
  })
  .strict();
export type ProjectText = z.infer<typeof ProjectTextSchema>;

export const GitSummarySchema = z
  .object({
    available: z.boolean(),
    branch: z.string().max(1_024).nullable(),
    upstream: z.string().max(1_024).nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    staged: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    untracked: z.number().int().nonnegative(),
    clean: z.boolean(),
  })
  .strict();
export type GitSummary = z.infer<typeof GitSummarySchema>;

export const EventKindSchema = z.enum(["needs-input", "completed", "failed", "system"]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const NotificationInputSchema = z
  .object({
    kind: EventKindSchema.optional(),
    title: z.string().trim().min(1).max(100),
    body: z.string().trim().max(240).optional(),
    url: z
      .string()
      .regex(/^\/(?!\/)[^\\\r\n]*$/)
      .max(300)
      .optional(),
  })
  .strict();
export type NotificationInput = z.input<typeof NotificationInputSchema>;

export const NotificationEventSchema = z
  .object({
    id: z.string().min(1).max(200),
    projectId: ProjectIdSchema.nullable(),
    kind: EventKindSchema,
    title: z.string().max(100),
    body: z.string().max(240),
    url: z.string().max(300),
    createdAt: ShortDateSchema,
    readAt: ShortDateSchema.nullable(),
  })
  .strict();
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

export const AlignStatusSchema = z
  .object({
    initialized: z.boolean(),
    contract: z
      .object({
        state: z.enum(["missing", "ambiguous", "provisional", "accepted"]),
        id: z.string().max(200).nullable(),
      })
      .strict(),
    latest: z
      .object({
        stage: z.enum(["pre_task", "in_progress", "candidate_final", "released"]).nullable(),
        assessmentCount: z.number().int().nonnegative(),
        reportCount: z.number().int().nonnegative(),
      })
      .strict(),
    totals: z
      .object({
        amendments: z.number().int().nonnegative(),
        assessments: z.number().int().nonnegative(),
        checkpoints: z.number().int().nonnegative(),
        contracts: z.number().int().nonnegative(),
        reports: z.number().int().nonnegative(),
        snapshots: z.number().int().nonnegative(),
      })
      .strict(),
    nextAction: z
      .object({ command: z.string().max(4_096), reason: z.string().max(2_000) })
      .strict()
      .nullable(),
  })
  .strict();
export type AlignStatus = z.infer<typeof AlignStatusSchema>;

export const DriftTracePathSchema = RelativePathSchema.refine(
  (value) =>
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  "Drift trace path must be a safe project-relative path",
).refine((value) => /\.jsonl$/i.test(value), "Drift trace must be JSONL");
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

export const DriftValidatedTracesSchema = z
  .object({ paths: z.array(DriftTracePathSchema).max(32) })
  .strict();
export type DriftValidatedTraces = z.infer<typeof DriftValidatedTracesSchema>;

export const DriftRenderRequestSchema = z
  .object({ path: RelativePathSchema.refine((value) => /\.json$/i.test(value)) })
  .strict();
export const DriftRenderSchema = z
  .object({ path: RelativePathSchema, text: z.string().max(1024 * 1024) })
  .strict();
export type DriftRender = z.infer<typeof DriftRenderSchema>;

export const DriftCodexSessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const DriftImportSessionRequestSchema = z
  .object({ sessionId: DriftCodexSessionIdSchema })
  .strict();
export type DriftImportSessionRequest = z.infer<typeof DriftImportSessionRequestSchema>;

export const DriftCodexSessionSchema = z
  .object({
    id: DriftCodexSessionIdSchema,
    startedAt: ShortDateSchema,
    updatedAt: ShortDateSchema,
    source: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    byteSize: z
      .number()
      .int()
      .min(1)
      .max(32 * 1024 * 1024),
  })
  .strict();
export type DriftCodexSession = z.infer<typeof DriftCodexSessionSchema>;
export const DriftRecentSessionsSchema = z
  .object({ sessions: z.array(DriftCodexSessionSchema).max(20), truncated: z.boolean() })
  .strict();
export type DriftRecentSessions = z.infer<typeof DriftRecentSessionsSchema>;
export const DriftImportedSessionSchema = z
  .object({ path: DriftTracePathSchema, session: DriftCodexSessionSchema })
  .strict();
export type DriftImportedSession = z.infer<typeof DriftImportedSessionSchema>;

const TreeIdSchema = z.string().min(1).max(200);
const TreeTextSchema = z.string().max(100_000);
export const TreeForkRequestSchema = z
  .object({
    baseVersionId: TreeIdSchema,
    decisionId: TreeIdSchema,
    alternativeId: TreeIdSchema,
  })
  .strict();
export type TreeForkRequest = z.infer<typeof TreeForkRequestSchema>;

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
    createdAt: ShortDateSchema,
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
            id: z.string().min(1).max(64),
            label: z.string().max(120),
            detail: z.string().max(500),
            status: z.enum(["passed", "simulated"]),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
const TreeRunSchema = z
  .object({
    id: TreeIdSchema,
    versionId: TreeIdSchema,
    mode: z.enum(["preview", "codex"]),
    phase: z.enum(["queued", "preparing", "generating", "verifying", "complete", "failed"]),
    progress: z.number().finite().min(0).max(100),
    startedAt: ShortDateSchema,
    completedAt: ShortDateSchema.optional(),
    error: z.string().max(2_000).optional(),
    result: TreeRunResultSchema.optional(),
    logs: z
      .array(
        z
          .object({
            id: TreeIdSchema,
            at: ShortDateSchema,
            message: z.string().max(500),
            tone: z.enum(["muted", "active", "success", "error"]),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export const TreeWorkspaceSchema = z
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
    updatedAt: ShortDateSchema,
  })
  .strict();
export type TreeWorkspace = z.infer<typeof TreeWorkspaceSchema>;
export const TreeForkResponseSchema = z
  .object({ runId: TreeIdSchema, versionId: TreeIdSchema, workspace: TreeWorkspaceSchema })
  .strict();
export type TreeForkResponse = z.infer<typeof TreeForkResponseSchema>;

export const SlideGenReceiptSchema = z
  .object({
    operationId: z.string().uuid(),
    kind: z.enum(["generate", "render"]),
    startedAt: ShortDateSchema,
    finishedAt: ShortDateSchema,
    sourceRevision: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .nullable(),
    deckSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    pdfSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    pageCount: z.number().int().nonnegative(),
  })
  .strict();
export type SlideGenReceipt = z.infer<typeof SlideGenReceiptSchema>;

export const SlideGenStatusSchema = z
  .object({
    projectId: ProjectIdSchema,
    sourceAvailable: z.boolean(),
    busy: z.boolean(),
    deck: z
      .object({ path: RelativePathSchema, sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict()
      .nullable(),
    render: z
      .object({
        pdfPath: RelativePathSchema,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        pageCount: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    lastReceipt: SlideGenReceiptSchema.nullable(),
  })
  .strict();
export type SlideGenStatus = z.infer<typeof SlideGenStatusSchema>;
export const SlideGenOperationResultSchema = z
  .object({ receipt: SlideGenReceiptSchema, status: SlideGenStatusSchema })
  .strict();
export type SlideGenOperationResult = z.infer<typeof SlideGenOperationResultSchema>;

export const PluginThemeSchema = z
  .object({
    mode: z.enum(["dark", "light"]),
    tokens: z
      .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), z.string().max(256))
      .refine((tokens) => Object.keys(tokens).length <= 64, "Theme has too many tokens"),
  })
  .strict();
export type PluginTheme = z.infer<typeof PluginThemeSchema>;
export const PluginContextSchema = z
  .object({
    apiVersion: z.literal(PLUGIN_API_VERSION),
    capabilities: z
      .array(PluginCapabilitySchema)
      .max(16)
      .refine((values) => new Set(values).size === values.length),
    project: PluginProjectSchema,
    theme: PluginThemeSchema,
  })
  .strict();
export type PluginContext = z.infer<typeof PluginContextSchema>;

export const PluginStatusSchema = z
  .object({
    state: z.enum(["idle", "busy", "attention", "error"]).optional(),
    badge: z.string().max(8).nullable().optional(),
    title: z.string().max(80).nullable().optional(),
  })
  .strict();
export type PluginStatus = z.input<typeof PluginStatusSchema>;

export const PluginMethodSchemas = {
  "project.metadata": { params: z.undefined(), result: ProjectMetadataSchema },
  "project.tree": {
    params: ProjectTreeParamsSchema.optional(),
    result: z.array(ProjectTreeEntrySchema).max(2_000),
  },
  "project.readText": { params: ProjectReadTextParamsSchema, result: ProjectTextSchema },
  "project.git": { params: z.undefined(), result: GitSummarySchema },
  "host.notify": { params: NotificationInputSchema, result: NotificationEventSchema },
  "align.status": { params: z.undefined(), result: AlignStatusSchema },
  "drift.render": { params: DriftRenderRequestSchema, result: DriftRenderSchema },
  "drift.validateTraces": {
    params: DriftValidateTracesRequestSchema,
    result: DriftValidatedTracesSchema,
  },
  "drift.recentSessions": { params: z.undefined(), result: DriftRecentSessionsSchema },
  "drift.importSession": {
    params: DriftImportSessionRequestSchema,
    result: DriftImportedSessionSchema,
  },
  "drift.analyze": { params: DriftAnalyzeRequestSchema, result: DriftRenderSchema },
  "tree-complete.workspace": { params: z.undefined(), result: TreeWorkspaceSchema },
  "tree-complete.createFork": { params: TreeForkRequestSchema, result: TreeForkResponseSchema },
  "slide-gen.status": { params: z.undefined(), result: SlideGenStatusSchema },
  "slide-gen.generate": { params: z.undefined(), result: SlideGenOperationResultSchema },
  "slide-gen.render": { params: z.undefined(), result: SlideGenOperationResultSchema },
} as const satisfies Record<PluginCapability, { params: z.ZodType; result: z.ZodType }>;

type MethodSchemas = typeof PluginMethodSchemas;
export type PluginMethodMap = {
  [Method in keyof MethodSchemas]: {
    params: z.input<MethodSchemas[Method]["params"]>;
    result: z.output<MethodSchemas[Method]["result"]>;
  };
};

export const PluginRpcRequestSchema = z
  .object({ method: PluginCapabilitySchema, params: z.unknown().optional() })
  .strict();
export type PluginRpcRequest = z.infer<typeof PluginRpcRequestSchema>;

export function parsePluginParams<Method extends PluginCapability>(
  method: Method,
  value: unknown,
): PluginMethodMap[Method]["params"] {
  return PluginMethodSchemas[method].params.parse(value) as PluginMethodMap[Method]["params"];
}

export function parsePluginResult<Method extends PluginCapability>(
  method: Method,
  value: unknown,
): PluginMethodMap[Method]["result"] {
  return PluginMethodSchemas[method].result.parse(value) as PluginMethodMap[Method]["result"];
}
