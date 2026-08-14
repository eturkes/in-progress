import { z } from "zod";
import type {
  NotificationEvent,
  PluginCapability,
  PluginManifest,
  ProjectMetadata,
} from "@in-progress/protocol";
import { EventKindSchema } from "@in-progress/protocol";

export * from "@in-progress/protocol";

export type ProjectDto = ProjectMetadata;

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

export type EventDto = NotificationEvent;

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

export function driftSessionTracePath(sessionId: string): string {
  return `.drift/traces/codex-${sessionId}.drift.jsonl`;
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
  .object({ mode: z.enum(["manual", "automatic"]), prompt: PreviewPromptSchema.default("") })
  .strict();
export type PreviewSettingsRequest = z.infer<typeof PreviewSettingsRequestSchema>;

export const PushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().startsWith("https://").max(2_048),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ auth: z.string().min(1).max(512), p256dh: z.string().min(1).max(512) }),
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
