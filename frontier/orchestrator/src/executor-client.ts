import * as restate from "@restatedev/restate-sdk";

import {
  ExecutorErrorSchema,
  ProbeResultSchema,
  probeRequestBody,
  resultDigest,
  type ProbeRequest,
  type ProbeResult,
} from "./contracts.ts";

const RESPONSE_LIMIT_BYTES = 32 * 1024;
const EXECUTOR_PATH = "/v1/operations";
const DEFAULT_ENDPOINT = "http://127.0.0.1:4319";

export function requireLoopbackEndpoint(raw: string): URL {
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/?$/.exec(raw);
  if (!match) {
    throw new Error("executor endpoint must be an HTTP loopback URL with an explicit port");
  }
  const port = Number(match[1]);
  if (port < 1 || port > 65_535) throw new Error("executor endpoint port is out of range");
  return new URL(raw);
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel();
    throw new Error("executor response exceeds 32768 bytes");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error("executor response exceeds 32768 bytes");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function terminalExecutorError(status: number, body: string): restate.TerminalError | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = ExecutorErrorSchema.safeParse(parsed);
  if (!error.success) return undefined;
  if (status === 409 && error.data.error === "operation_id_conflict") {
    return new restate.TerminalError("executor operation ID conflicts with its stored request", {
      errorCode: 409,
    });
  }
  if ([400, 413, 415, 422].includes(status) && error.data.error === "invalid_request") {
    return new restate.TerminalError("executor rejected the operation contract", {
      errorCode: 400,
    });
  }
  return undefined;
}

export class ExecutorClient {
  readonly #operationsUrl: URL;

  constructor(endpoint = process.env.IN_PROGRESS_EXECUTOR_URL ?? DEFAULT_ENDPOINT) {
    this.#operationsUrl = new URL(EXECUTOR_PATH, requireLoopbackEndpoint(endpoint));
  }

  async execute(request: ProbeRequest): Promise<ProbeResult> {
    const body = probeRequestBody(request);
    const response = await fetch(this.#operationsUrl, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const responseBody = await readLimitedBody(response);
    const terminalError = terminalExecutorError(response.status, responseBody);
    if (terminalError) throw terminalError;
    if (!response.ok) {
      throw new Error(`executor temporarily unavailable: HTTP ${response.status}`);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(responseBody);
    } catch {
      throw new Error("executor returned an invalid result");
    }
    const parsed = ProbeResultSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("executor returned an invalid result");
    const result = parsed.data;
    if (result.operationId !== request.operationId) {
      throw new Error("executor returned a mismatched operation ID");
    }
    if (result.value !== request.input.value) {
      throw new Error("executor returned a mismatched result value");
    }
    if (result.digest !== resultDigest(result.value)) {
      throw new Error("executor returned an invalid result digest");
    }
    const metadataConsistent =
      (response.status === 201 && !result.replayed) || (response.status === 200 && result.replayed);
    if (!metadataConsistent) throw new Error("executor returned inconsistent receipt metadata");
    return result;
  }
}
