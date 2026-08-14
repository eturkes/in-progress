import * as restate from "@restatedev/restate-sdk";

import {
  PROBE_KIND,
  ProbeInputSchema,
  ProbeRequestSchema,
  probeRequestBody,
  type ProbeInput,
  type ProbeRequest,
  type ProbeResult,
} from "./contracts.ts";
import { ExecutorClient } from "./executor-client.ts";

export interface ProbeExecutor {
  execute(request: ProbeRequest): Promise<ProbeResult>;
}

export interface ProbeDurability {
  readonly key: string;
  run<T>(name: string, action: () => Promise<T>): PromiseLike<T>;
}

export function validatedProbeRequest(operationId: string, input: unknown): ProbeRequest {
  try {
    const request = ProbeRequestSchema.parse({
      operationId,
      kind: PROBE_KIND,
      input: ProbeInputSchema.parse(input),
    });
    probeRequestBody(request);
    return request;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid probe request";
    throw new restate.TerminalError(message, { errorCode: 400 });
  }
}

export async function runProbe(
  ctx: ProbeDurability,
  input: ProbeInput,
  executor: ProbeExecutor,
  crashAfterExecutor?: () => never,
): Promise<ProbeResult> {
  const request = validatedProbeRequest(ctx.key, input);
  return await ctx.run("idempotent executor call", async () => {
    const result = await executor.execute(request);
    crashAfterExecutor?.();
    return result;
  });
}

const executor = new ExecutorClient();
const crashAfterExecutor =
  process.env.IN_PROGRESS_FRONTIER_CRASH_AFTER_EXECUTOR === "1"
    ? () => process.exit(86)
    : undefined;

export const probeWorkflow = restate.workflow({
  name: "ProbeWorkflow",
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: ProbeInput) =>
      await runProbe(ctx, input, executor, crashAfterExecutor),
  },
});
