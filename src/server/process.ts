import { HttpError } from "./security";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  overflow: () => void,
  label: string,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        overflow();
        throw new HttpError(502, `${label} output exceeded its limit`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(502, `${label} output was not valid UTF-8`);
  }
}

export async function runBounded(
  argv: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    timeoutMs: number;
    stdoutBytes: number;
    label: string;
    signal?: AbortSignal;
    stdin?: string;
  },
): Promise<ProcessResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new HttpError(502, `${options.label} could not start`);
  }

  let timedOut = false;
  let externallyAborted = false;
  const streamAbort = new AbortController();
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  };
  const hardStop = () => {
    signalGroup("SIGKILL");
    streamAbort.abort();
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    signalGroup("SIGTERM");
    streamAbort.abort();
    forceTimer = setTimeout(hardStop, 8_000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const abort = () => {
    externallyAborted = true;
    stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    if (options.stdin !== undefined) {
      try {
        if (!child.stdin || typeof child.stdin === "number") throw new Error();
        child.stdin.write(options.stdin);
        child.stdin.end();
      } catch {
        hardStop();
        throw new HttpError(502, `${options.label} input could not be written`);
      }
    }
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
      hardStop();
      throw new HttpError(502, `${options.label} process pipes were unavailable`);
    }
    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readBounded(child.stdout, options.stdoutBytes, stop, options.label, streamAbort.signal),
      readBounded(child.stderr, 64 * 1024, stop, options.label, streamAbort.signal),
      child.exited,
    ]);
    if (externallyAborted) throw new HttpError(503, `${options.label} canceled`);
    if (timedOut) throw new HttpError(504, `${options.label} timed out`);
    if (stdoutResult.status === "rejected") throw stdoutResult.reason;
    if (stderrResult.status === "rejected") throw stderrResult.reason;
    if (exitResult.status === "rejected") {
      throw new HttpError(502, `${options.label} process failed`);
    }
    const stdout = stdoutResult.value;
    const stderr = stderrResult.value;
    const exitCode = exitResult.value;
    if (exitCode !== 0) {
      throw new HttpError(422, `${options.label} rejected the project state`);
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    options.signal?.removeEventListener("abort", abort);
    hardStop();
  }
}
