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
  },
): Promise<ProcessResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new HttpError(502, `${options.label} could not start`);
  }

  let timedOut = false;
  const streamAbort = new AbortController();
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
    }
    streamAbort.abort();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  try {
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
      stop();
      throw new HttpError(502, `${options.label} process pipes were unavailable`);
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, options.stdoutBytes, stop, options.label, streamAbort.signal),
      readBounded(child.stderr, 64 * 1024, stop, options.label, streamAbort.signal),
      child.exited,
    ]);
    if (timedOut) throw new HttpError(504, `${options.label} timed out`);
    if (exitCode !== 0) {
      throw new HttpError(422, `${options.label} rejected the project state`);
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    stop();
  }
}
