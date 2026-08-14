import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const LOOPBACK = "127.0.0.1";
const EXECUTOR_PORT = 4319;
const ADMIN_PORT = 9070;
const ORCHESTRATOR_PORT = 9080;
const FABRIC_PORT = 5122;
const START_TIMEOUT_MS = 30_000;
const INVOCATION_TIMEOUT_MS = 60_000;
const LOG_LIMIT_BYTES = 64 * 1024;

const root = resolve(import.meta.dir, "..");
const artifacts = {
  bun: resolve(root, "node_modules/.bin/bun"),
  executor: resolve(root, "frontier/executor/target/debug/frontier-executor"),
  orchestrator: resolve(root, "frontier/orchestrator/src/main.ts"),
  restateCli: resolve(root, "node_modules/.bin/restate"),
  restateConfig: resolve(root, "frontier/restate.toml"),
  restateServer: resolve(root, "node_modules/.bin/restate-server"),
} as const;

type Exit = {
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
};

type ManagedProcess = {
  child: ChildProcess;
  exit?: Exit;
  exited: Promise<Exit>;
  label: string;
  stderr: string;
  stdout: string;
};

type ProbeResult = {
  digest: string;
  operationId: string;
  replayed: boolean;
  value: string;
};

type CurlJsonResult = {
  headers: ReadonlyMap<string, string>;
  payload: unknown;
  status: number;
};

type PendingCurlJson = {
  process: ManagedProcess;
  result: Promise<CurlJsonResult>;
};

const children: ManagedProcess[] = [];
let scratchRoot: string | undefined;
let cleanupPromise: Promise<void> | undefined;

function appendLog(current: string, chunk: unknown): string {
  const combined = current + String(chunk);
  return combined.length <= LOG_LIMIT_BYTES ? combined : combined.slice(-LOG_LIMIT_BYTES);
}

function startProcess(
  label: string,
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ManagedProcess {
  const child = spawn(executable, [...args], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveExit: (exit: Exit) => void = () => {};
  const managed: ManagedProcess = {
    child,
    exited: new Promise<Exit>((resolvePromise) => {
      resolveExit = resolvePromise;
    }),
    label,
    stderr: "",
    stdout: "",
  };
  const finish = (exit: Exit) => {
    if (managed.exit) return;
    managed.exit = exit;
    resolveExit(exit);
  };
  child.stdout?.on("data", (chunk) => {
    managed.stdout = appendLog(managed.stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    managed.stderr = appendLog(managed.stderr, chunk);
  });
  child.once("error", (error) => finish({ code: null, error, signal: null }));
  child.once("exit", (code, signal) => finish({ code, signal }));
  children.push(managed);
  return managed;
}

function processDiagnostics(process: ManagedProcess): string {
  const exit = process.exit;
  const status = exit
    ? exit.error
      ? `spawn error: ${exit.error.message}`
      : `exit code=${String(exit.code)} signal=${String(exit.signal)}`
    : "still running";
  const output = [
    `${process.label}: ${status}`,
    process.stdout.trim() ? `stdout:\n${process.stdout.trim()}` : "",
    process.stderr.trim() ? `stderr:\n${process.stderr.trim()}` : "",
  ].filter(Boolean);
  return output.join("\n");
}

function assertRunning(process: ManagedProcess): void {
  if (process.exit)
    throw new Error(`${process.label} stopped unexpectedly\n${processDiagnostics(process)}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds} ms`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertExecutable(label: string, path: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch (error) {
    throw new Error(`${label} is not executable: ${path}`, { cause: error });
  }
}

async function assertReadable(label: string, path: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
  } catch (error) {
    throw new Error(`${label} is not readable: ${path}`, { cause: error });
  }
}

async function assertPortAvailable(label: string, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      reject(new Error(`${label} port ${LOOPBACK}:${port} is unavailable`, { cause: error }));
    });
    server.listen({ exclusive: true, host: LOOPBACK, port }, () => {
      server.close((error) => {
        if (error) reject(new Error(`could not release ${label} port ${port}`, { cause: error }));
        else resolvePromise();
      });
    });
  });
}

async function waitForHttp(
  label: string,
  url: string,
  process: ManagedProcess,
  accept: (status: number) => boolean,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastObservation = "no response";
  while (Date.now() < deadline) {
    assertRunning(process);
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      lastObservation = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (accept(response.status)) return;
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(
    `${label} did not become ready at ${url}: ${lastObservation}\n${processDiagnostics(process)}`,
  );
}

async function connectOnce(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection({ host: LOOPBACK, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connection timed out"));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForTcp(label: string, port: number, process: ManagedProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastObservation = "no connection";
  while (Date.now() < deadline) {
    assertRunning(process);
    try {
      await connectOnce(port);
      return;
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(
    `${label} did not accept connections at ${LOOPBACK}:${port}: ${lastObservation}\n${processDiagnostics(process)}`,
  );
}

async function waitForUnixSocket(
  label: string,
  path: string,
  process: ManagedProcess,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastObservation = "socket is absent";
  while (Date.now() < deadline) {
    assertRunning(process);
    try {
      const metadata = await lstat(path);
      if (metadata.isSocket()) return;
      lastObservation = "path exists but is not a Unix socket";
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(
    `${label} did not create ${path}: ${lastObservation}\n${processDiagnostics(process)}`,
  );
}

async function runProcess(
  label: string,
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMilliseconds = START_TIMEOUT_MS,
): Promise<ManagedProcess> {
  const process = startProcess(label, executable, args, env);
  const exit = await withTimeout(process.exited, timeoutMilliseconds, label);
  if (exit.error || exit.signal || exit.code !== 0) {
    throw new Error(`${label} failed\n${processDiagnostics(process)}`);
  }
  return process;
}

async function fetchJson(
  label: string,
  url: string,
  init: RequestInit,
  expectedStatus: number,
  timeoutMilliseconds = START_TIMEOUT_MS,
): Promise<{ payload: unknown; response: Response }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${response.status}: ${text}`);
  }
  try {
    return { payload: JSON.parse(text) as unknown, response };
  } catch (error) {
    throw new Error(`${label}: invalid JSON response: ${text}`, { cause: error });
  }
}

function parseCurlHeaders(raw: string): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

function startCurlJson(
  label: string,
  curl: string,
  socketPath: string,
  outputRoot: string,
  outputStem: string,
  path: string,
  init: { body?: string; method: "GET" | "POST" },
  expectedStatus: number,
  env: NodeJS.ProcessEnv,
  timeoutMilliseconds = START_TIMEOUT_MS,
): PendingCurlJson {
  const bodyPath = resolve(outputRoot, `${outputStem}.body.json`);
  const headersPath = resolve(outputRoot, `${outputStem}.headers`);
  const args = [
    "--silent",
    "--show-error",
    "--http1.1",
    "--noproxy",
    "*",
    "--unix-socket",
    socketPath,
    "--connect-timeout",
    "3",
    "--max-time",
    String(Math.ceil(timeoutMilliseconds / 1_000)),
    "--request",
    init.method,
    "--header",
    "accept: application/json",
    "--dump-header",
    headersPath,
    "--output",
    bodyPath,
    "--write-out",
    "%{http_code}",
  ];
  if (init.body !== undefined) {
    args.push("--header", "content-type: application/json", "--data-binary", init.body);
  }
  args.push(`http://localhost${path}`);
  const process = startProcess(label, curl, args, env);
  const result = process.exited.then(async (exit): Promise<CurlJsonResult> => {
    if (exit.error || exit.signal || exit.code !== 0) {
      throw new Error(`${label} failed\n${processDiagnostics(process)}`);
    }
    const status = Number(process.stdout.trim());
    const [body, rawHeaders] = await Promise.all([
      readFile(bodyPath, "utf8"),
      readFile(headersPath, "utf8"),
    ]);
    if (!Number.isInteger(status)) {
      throw new Error(`${label}: curl returned an invalid HTTP status: ${process.stdout}`);
    }
    if (status !== expectedStatus) {
      throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${status}: ${body}`);
    }
    try {
      return {
        headers: parseCurlHeaders(rawHeaders),
        payload: JSON.parse(body) as unknown,
        status,
      };
    } catch (error) {
      throw new Error(`${label}: invalid JSON response: ${body}`, { cause: error });
    }
  });
  return { process, result };
}

async function curlJson(
  label: string,
  curl: string,
  socketPath: string,
  outputRoot: string,
  outputStem: string,
  path: string,
  init: { body?: string; method: "GET" | "POST" },
  expectedStatus: number,
  env: NodeJS.ProcessEnv,
  timeoutMilliseconds = START_TIMEOUT_MS,
): Promise<CurlJsonResult> {
  const call = startCurlJson(
    label,
    curl,
    socketPath,
    outputRoot,
    outputStem,
    path,
    init,
    expectedStatus,
    env,
    timeoutMilliseconds,
  );
  return await withTimeout(call.result, timeoutMilliseconds + 1_000, label);
}

function probeResult(payload: unknown, label: string): ProbeResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`${label}: expected a JSON object`);
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.operationId !== "string" ||
    typeof record.value !== "string" ||
    typeof record.digest !== "string" ||
    typeof record.replayed !== "boolean"
  ) {
    throw new Error(`${label}: malformed probe result: ${JSON.stringify(payload)}`);
  }
  return {
    digest: record.digest,
    operationId: record.operationId,
    replayed: record.replayed,
    value: record.value,
  };
}

function childEnvironment(scratch: string): NodeJS.ProcessEnv {
  return {
    CI: "1",
    HOME: resolve(scratch, "home"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_PROXY: "127.0.0.1,localhost,::1",
    PATH: process.env.PATH,
    TMPDIR: resolve(scratch, "tmp"),
    XDG_CACHE_HOME: resolve(scratch, "cache"),
    XDG_CONFIG_HOME: resolve(scratch, "config"),
    XDG_STATE_HOME: resolve(scratch, "state"),
    no_proxy: "127.0.0.1,localhost,::1",
  };
}

async function stopChildren(): Promise<void> {
  const running = children.filter((process) => !process.exit);
  for (const process of running) process.child.kill("SIGTERM");
  await Promise.all(
    running.map(async (process) => {
      try {
        await withTimeout(process.exited, 3_000, `${process.label} graceful shutdown`);
      } catch {
        process.child.kill("SIGKILL");
      }
    }),
  );
  await Promise.all(
    running.map(async (process) => {
      if (process.exit) return;
      await withTimeout(process.exited, 3_000, `${process.label} forced shutdown`);
    }),
  );
}

function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    const errors: unknown[] = [];
    try {
      await stopChildren();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (scratchRoot) await rm(scratchRoot, { force: true, recursive: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "frontier E2E cleanup failed");
  })();
  return cleanupPromise;
}

async function run(): Promise<void> {
  const curl = Bun.which("curl");
  if (!curl) throw new Error("curl is unavailable on PATH");
  await Promise.all([
    assertExecutable("curl", curl),
    assertExecutable("Bun", artifacts.bun),
    assertExecutable("frontier executor", artifacts.executor),
    assertReadable("frontier orchestrator", artifacts.orchestrator),
    assertExecutable("Restate CLI", artifacts.restateCli),
    assertExecutable("Restate server", artifacts.restateServer),
    assertReadable("Restate config", artifacts.restateConfig),
  ]);
  await Promise.all([
    assertPortAvailable("executor", EXECUTOR_PORT),
    assertPortAvailable("Restate admin", ADMIN_PORT),
    assertPortAvailable("orchestrator", ORCHESTRATOR_PORT),
    assertPortAvailable("Restate fabric", FABRIC_PORT),
  ]);

  scratchRoot = await mkdtemp(resolve(tmpdir(), "in-progress-frontier-e2e-"));
  await chmod(scratchRoot, 0o700);
  const privateDirectories = [
    "cache",
    "config",
    "curl",
    "executor",
    "home",
    "restate",
    "state",
    "tmp",
  ].map((name) => resolve(scratchRoot!, name));
  await Promise.all(privateDirectories.map((path) => mkdir(path, { mode: 0o700 })));

  const baseEnv = childEnvironment(scratchRoot);
  const executorUrl = `http://${LOOPBACK}:${EXECUTOR_PORT}`;
  const adminUrl = `http://${LOOPBACK}:${ADMIN_PORT}`;
  const curlRoot = resolve(scratchRoot, "curl");
  const restateBase = resolve(scratchRoot, "restate");
  const ingressSocket = resolve(restateBase, "ingress.sock");
  const executor = startProcess(
    "frontier executor",
    artifacts.executor,
    [
      "--ledger",
      resolve(scratchRoot, "executor/operations.sqlite"),
      "--bind",
      `${LOOPBACK}:${EXECUTOR_PORT}`,
    ],
    baseEnv,
  );
  await waitForHttp(
    "frontier executor",
    `${executorUrl}/healthz`,
    executor,
    (status) => status === 204,
  );
  console.log("✓ executor ready with private ledger");

  const restate = startProcess(
    "Restate server",
    artifacts.restateServer,
    [
      "--config-file",
      artifacts.restateConfig,
      "--base-dir",
      scratchRoot,
      "--node-name",
      "restate",
      "--no-logo",
    ],
    baseEnv,
  );
  await waitForHttp("Restate admin", `${adminUrl}/health`, restate, (status) => status === 200);
  await waitForUnixSocket("Restate ingress", ingressSocket, restate);
  console.log("✓ Restate ready with private base directory and Unix ingress");

  const crashingEnv = {
    ...baseEnv,
    IN_PROGRESS_EXECUTOR_URL: executorUrl,
    IN_PROGRESS_FRONTIER_CRASH_AFTER_EXECUTOR: "1",
  };
  const firstOrchestrator = startProcess(
    "frontier orchestrator (crash run)",
    artifacts.bun,
    [artifacts.orchestrator],
    crashingEnv,
  );
  await waitForTcp("frontier orchestrator", ORCHESTRATOR_PORT, firstOrchestrator);

  const cliEnv = {
    ...baseEnv,
    RESTATE_CLI_CONFIG_HOME: resolve(scratchRoot, "config/restate-cli"),
    RESTATE_ENVIRONMENT: "local",
  };
  await mkdir(cliEnv.RESTATE_CLI_CONFIG_HOME, { mode: 0o700 });
  await runProcess(
    "Restate deployment registration",
    artifacts.restateCli,
    [
      "deployments",
      "register",
      `http://${LOOPBACK}:${ORCHESTRATOR_PORT}`,
      "--yes",
      "--connect-timeout",
      "3000",
      "--request-timeout",
      "30000",
    ],
    cliEnv,
    45_000,
  );
  await waitForHttp(
    "ProbeWorkflow registration",
    `${adminUrl}/services/ProbeWorkflow`,
    restate,
    (status) => status === 200,
  );
  console.log("✓ ProbeWorkflow deployment registered");

  const operationId = "2d9d455c-5bf4-4af4-a2a0-0f5745e71957";
  const value = "frontier-after-commit-recovery";
  const operation = {
    input: { value },
    kind: "frontier-probe",
    operationId,
  };
  const invocationCall = startCurlJson(
    "ProbeWorkflow invocation",
    curl,
    ingressSocket,
    curlRoot,
    "workflow-invocation",
    `/ProbeWorkflow/${operationId}/run`,
    { body: JSON.stringify({ value }), method: "POST" },
    200,
    baseEnv,
    INVOCATION_TIMEOUT_MS,
  );
  const invocation = invocationCall.result.then(
    (result) => ({ result }) as const,
    (error: unknown) => ({ error }) as const,
  );

  let firstEvent:
    | { exit: Exit; kind: "exit" }
    | {
        kind: "invocation";
        outcome: { error: unknown } | { result: CurlJsonResult };
      };
  try {
    firstEvent = await withTimeout(
      Promise.race([
        firstOrchestrator.exited.then((exit) => ({ exit, kind: "exit" }) as const),
        invocation.then((outcome) => ({ kind: "invocation", outcome }) as const),
      ]),
      START_TIMEOUT_MS,
      "crash-after-executor hook",
    );
  } catch (error) {
    throw new Error(
      [
        "crash boundary made no progress",
        processDiagnostics(firstOrchestrator),
        processDiagnostics(invocationCall.process),
        processDiagnostics(restate),
        processDiagnostics(executor),
      ].join("\n\n"),
      { cause: error },
    );
  }
  if (firstEvent.kind === "invocation") {
    if ("error" in firstEvent.outcome) {
      throw new Error("ProbeWorkflow invocation failed before the crash hook ran", {
        cause: firstEvent.outcome.error,
      });
    }
    throw new Error(
      `ProbeWorkflow invocation completed before the crash hook ran: ${JSON.stringify(firstEvent.outcome.result.payload)}`,
    );
  }
  const firstExit = firstEvent.exit;
  if (firstExit.error || firstExit.signal !== null || firstExit.code !== 86) {
    throw new Error(
      `crash-after-executor process did not halt with code 86\n${processDiagnostics(firstOrchestrator)}`,
    );
  }

  const committed = await fetchJson(
    "post-crash executor replay",
    `${executorUrl}/v1/operations`,
    { body: JSON.stringify(operation), method: "POST" },
    200,
  );
  const committedResult = probeResult(committed.payload, "post-crash executor replay");
  strictEqual(committedResult.operationId, operationId);
  strictEqual(committedResult.value, value);
  strictEqual(committedResult.replayed, true);
  match(committedResult.digest, /^[0-9a-f]{64}$/);
  console.log("✓ first orchestrator halted after executor commit");

  const recoveryEnv = { ...baseEnv, IN_PROGRESS_EXECUTOR_URL: executorUrl };
  const secondOrchestrator = startProcess(
    "frontier orchestrator (recovery run)",
    artifacts.bun,
    [artifacts.orchestrator],
    recoveryEnv,
  );
  await waitForTcp("frontier orchestrator recovery", ORCHESTRATOR_PORT, secondOrchestrator);

  const invocationOutcome = await invocation;
  if ("error" in invocationOutcome) {
    throw new Error("ProbeWorkflow invocation failed during recovery", {
      cause: invocationOutcome.error,
    });
  }
  const invocationResult = probeResult(
    invocationOutcome.result.payload,
    "ProbeWorkflow invocation",
  );
  deepStrictEqual(invocationResult, committedResult);
  strictEqual(invocationResult.replayed, true);
  const invocationId = invocationOutcome.result.headers.get("x-restate-id");
  if (!invocationId) throw new Error("ProbeWorkflow response omitted x-restate-id");
  match(invocationId, /^inv_[A-Za-z0-9]+$/);
  console.log("✓ Restate recovered the invocation through executor replay");

  const attached = await curlJson(
    "Restate invocation attach",
    curl,
    ingressSocket,
    curlRoot,
    "invocation-attach",
    `/restate/invocation/${encodeURIComponent(invocationId)}/attach`,
    { method: "GET" },
    200,
    baseEnv,
    INVOCATION_TIMEOUT_MS,
  );
  deepStrictEqual(attached.payload, invocationOutcome.result.payload);
  console.log("✓ invocation attach matches the recovered response");

  await curlJson(
    "completed workflow key reuse",
    curl,
    ingressSocket,
    curlRoot,
    "workflow-key-reuse",
    `/ProbeWorkflow/${operationId}/run`,
    { body: JSON.stringify({ value: `${value}-changed` }), method: "POST" },
    409,
    baseEnv,
  );
  console.log("✓ completed workflow key rejects a changed second invocation");

  const directReplay = await fetchJson(
    "direct executor replay",
    `${executorUrl}/v1/operations`,
    { body: JSON.stringify(operation), method: "POST" },
    200,
  );
  deepStrictEqual(probeResult(directReplay.payload, "direct executor replay"), invocationResult);

  const conflict = await fetchJson(
    "executor operation-id conflict",
    `${executorUrl}/v1/operations`,
    {
      body: JSON.stringify({ ...operation, input: { value: `${value}-conflict` } }),
      method: "POST",
    },
    409,
  );
  deepStrictEqual(conflict.payload, { error: "operation_id_conflict" });
  console.log("✓ direct replay matches; changed body conflicts with HTTP 409");
}

async function main(): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (failure === undefined) failure = error;
    else console.error("cleanup failed", error);
  }
  if (failure !== undefined) throw failure;
}

let interrupted = false;
const interrupt = (signal: NodeJS.Signals) => {
  if (interrupted) return;
  interrupted = true;
  console.error(`received ${signal}; stopping frontier E2E children`);
  void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

await main();
