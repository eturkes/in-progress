import { z } from "zod";
import {
  type PluginCapability,
  type PluginContext,
  PluginContextSchema,
  type PluginMethodMap,
  type PluginStatus,
  PluginStatusSchema,
  parsePluginParams,
  parsePluginResult,
} from "./schemas.js";

const RpcResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      kind: z.literal("response"),
      id: z.string(),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("response"),
      id: z.string(),
      ok: z.literal(false),
      error: z.string().max(4_096),
    })
    .strict(),
]);

interface PendingCall {
  method: PluginCapability;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: number;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface PluginCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ConnectInProgressOptions {
  target?: Window;
  timeoutMs?: number;
  requiredCapabilities?: readonly PluginCapability[];
  applyTheme?: boolean;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Operation aborted", "AbortError");
}

function methodTimeout(method: PluginCapability): number {
  if (method === "slide-gen.generate") return 66 * 60_000;
  if (method === "drift.analyze") return 21 * 60_000;
  if (method === "drift.importSession") return 75_000;
  if (method === "slide-gen.render") return 11 * 60_000;
  return 15_000;
}

export class InProgressClient {
  readonly context: PluginContext;
  readonly #pending = new Map<string, PendingCall>();
  readonly #port: MessagePort;
  readonly #target: Window;

  constructor(port: MessagePort, context: PluginContext, target: Window = window) {
    this.#port = port;
    this.#target = target;
    this.context = PluginContextSchema.parse(context);
    port.addEventListener("message", (event: MessageEvent<unknown>) => {
      const parsed = RpcResponseSchema.safeParse(event.data);
      if (!parsed.success) return;
      const response = parsed.data;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#finish(response.id, pending);
      if (!response.ok) {
        pending.reject(new Error(response.error));
        return;
      }
      try {
        pending.resolve(parsePluginResult(pending.method, response.result));
      } catch {
        pending.reject(new Error(`Host returned an invalid ${pending.method} result`));
      }
    });
    port.start();
  }

  call<Method extends PluginCapability>(
    method: Method,
    ...args: undefined extends PluginMethodMap[Method]["params"]
      ? [params?: PluginMethodMap[Method]["params"], options?: PluginCallOptions]
      : [params: PluginMethodMap[Method]["params"], options?: PluginCallOptions]
  ): Promise<PluginMethodMap[Method]["result"]> {
    if (!this.context.capabilities.includes(method)) {
      return Promise.reject(new Error(`Capability not granted: ${method}`));
    }
    let params: PluginMethodMap[Method]["params"];
    try {
      params = parsePluginParams(method, args[0]);
    } catch {
      return Promise.reject(new Error(`Invalid ${method} request`));
    }
    const options = args[1];
    if (options?.signal?.aborted) return Promise.reject(abortError(options.signal));
    const id = crypto.randomUUID();
    return new Promise<PluginMethodMap[Method]["result"]>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? methodTimeout(method);
      const timer = this.#target.setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#finish(id, pending);
        reject(new Error(`Host RPC timed out: ${method}`));
      }, timeoutMs);
      const pending: PendingCall = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      };
      if (options?.signal) {
        pending.signal = options.signal;
        pending.abort = () => {
          if (!this.#pending.has(id)) return;
          this.#finish(id, pending);
          reject(abortError(options.signal!));
        };
        options.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.#pending.set(id, pending);
      this.#port.postMessage({
        kind: "request",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    });
  }

  setStatus(status: PluginStatus): void {
    this.#port.postMessage({
      kind: "event",
      name: "status",
      payload: PluginStatusSchema.parse(status),
    });
  }

  dispose(): void {
    for (const [id, pending] of this.#pending) {
      this.#finish(id, pending);
      pending.reject(new Error("Plugin connection disposed"));
    }
    this.#port.close();
  }

  #finish(id: string, pending: PendingCall): void {
    this.#pending.delete(id);
    this.#target.clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
  }
}

export function applyPluginTheme(
  theme: PluginContext["theme"],
  root = document.documentElement,
): void {
  root.dataset.theme = theme.mode;
  root.style.colorScheme = theme.mode;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(
      `--host-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      value,
    );
  }
}

export function connectInProgress(
  options: ConnectInProgressOptions = {},
): Promise<InProgressClient> {
  const target = options.target ?? window;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const required = options.requiredCapabilities ?? [];
  return new Promise((resolve, reject) => {
    const timer = target.setTimeout(() => {
      target.removeEventListener("message", receive);
      reject(new Error("in-progress host handshake timed out"));
    }, timeoutMs);

    function receive(event: MessageEvent<unknown>): void {
      if (event.source !== target.parent || event.ports.length !== 1) return;
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        (data as { type?: unknown }).type !== "in-progress:init"
      )
        return;
      const port = event.ports[0]!;
      const record = data as { nonce?: unknown; context?: unknown };
      const parsed = PluginContextSchema.safeParse(record.context);
      if (!parsed.success || typeof record.nonce !== "string") {
        target.clearTimeout(timer);
        target.removeEventListener("message", receive);
        port.close();
        reject(new Error("Unsupported or invalid in-progress host API"));
        return;
      }
      const missing = required.find((capability) => !parsed.data.capabilities.includes(capability));
      if (missing) {
        target.clearTimeout(timer);
        target.removeEventListener("message", receive);
        port.close();
        reject(new Error(`Required capability not granted: ${missing}`));
        return;
      }
      if (options.applyTheme ?? true)
        applyPluginTheme(parsed.data.theme, target.document.documentElement);
      target.clearTimeout(timer);
      target.removeEventListener("message", receive);
      const client = new InProgressClient(port, parsed.data, target);
      port.postMessage({ kind: "ready", nonce: record.nonce });
      target.addEventListener("pagehide", () => client.dispose(), { once: true });
      resolve(client);
    }

    target.addEventListener("message", receive);
  });
}
