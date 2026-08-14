import { createHash } from "node:crypto";

import { z } from "zod";

export const PROBE_KIND = "frontier-probe" as const;
export const MAX_VALUE_BYTES = 8 * 1024;
export const MAX_REQUEST_BYTES = 16 * 1024;

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const ProbeInputSchema = z
  .object({
    value: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_VALUE_BYTES, {
      message: `probe value exceeds ${MAX_VALUE_BYTES} UTF-8 bytes`,
    }),
  })
  .strict();

export const ProbeRequestSchema = z
  .object({
    operationId: z.string().regex(canonicalUuid, "workflow key must be a canonical UUID"),
    kind: z.literal(PROBE_KIND),
    input: ProbeInputSchema,
  })
  .strict();

export const ProbeResultSchema = z
  .object({
    operationId: z.string().regex(canonicalUuid),
    value: z.string(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    replayed: z.boolean(),
  })
  .strict();

export const ExecutorErrorSchema = z
  .object({
    error: z.enum(["invalid_request", "operation_id_conflict"]),
  })
  .strict();

export type ProbeInput = z.infer<typeof ProbeInputSchema>;
export type ProbeRequest = z.infer<typeof ProbeRequestSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export function probeRequestBody(request: ProbeRequest): string {
  const body = JSON.stringify(ProbeRequestSchema.parse(request));
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error(`probe request exceeds ${MAX_REQUEST_BYTES} wire bytes`);
  }
  return body;
}

export function resultDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
