export const IN_PROGRESS_PLUGIN_API_VERSION = "1.0" as const;

export type Capability =
  | "project.metadata"
  | "project.tree"
  | "project.readText"
  | "project.git"
  | "host.notify";

export interface PluginProject {
  id: string;
  name: string;
  color: string;
  available: boolean;
}

export interface ProjectMetadata extends PluginProject {
  displayPath: string;
  branch: string | null;
}

export interface ProjectTreeParams {
  depth?: number;
  limit?: number;
}

export interface ProjectTreeEntry {
  path: string;
  name: string;
  kind: "directory" | "file" | "symlink";
  depth: number;
  size?: number;
}

export interface ProjectText {
  path: string;
  text: string;
  truncated: boolean;
}

export interface GitSummary {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  clean: boolean;
}

export type EventKind = "needs-input" | "completed" | "failed" | "system";

export interface NotificationInput {
  kind?: EventKind;
  title: string;
  body?: string;
  url?: string;
}

export interface NotificationEvent {
  id: string;
  projectId: string | null;
  kind: EventKind;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  readAt: string | null;
}

export interface PluginMethodMap {
  "project.metadata": { params: undefined; result: ProjectMetadata };
  "project.tree": { params: ProjectTreeParams | undefined; result: ProjectTreeEntry[] };
  "project.readText": { params: { path: string }; result: ProjectText };
  "project.git": { params: undefined; result: GitSummary };
  "host.notify": { params: NotificationInput; result: NotificationEvent };
}

export interface PluginTheme {
  mode: "dark" | "light";
  tokens: Record<string, string>;
}

export interface PluginContext {
  apiVersion: typeof IN_PROGRESS_PLUGIN_API_VERSION;
  capabilities: Capability[];
  project: PluginProject;
  theme: PluginTheme;
}

export type PluginStatus = {
  state?: "idle" | "busy" | "attention" | "error";
  badge?: string | null;
  title?: string | null;
};

type InitMessage = {
  type: "in-progress:init";
  nonce: string;
  context: PluginContext;
};

type RpcResponse =
  | { kind: "response"; id: string; ok: true; result: unknown }
  | { kind: "response"; id: string; ok: false; error: string };

export class InProgressClient {
  readonly context: PluginContext;
  readonly #port: MessagePort;
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }
  >();

  constructor(port: MessagePort, context: PluginContext) {
    this.#port = port;
    this.context = context;
    port.addEventListener("message", (event: MessageEvent<RpcResponse>) => {
      if (event.data?.kind !== "response") return;
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      window.clearTimeout(pending.timer);
      if (event.data.ok) pending.resolve(event.data.result);
      else pending.reject(new Error(event.data.error));
    });
    port.start();
  }

  call<M extends Capability>(
    method: M,
    ...args: undefined extends PluginMethodMap[M]["params"]
      ? [params?: PluginMethodMap[M]["params"]]
      : [params: PluginMethodMap[M]["params"]]
  ): Promise<PluginMethodMap[M]["result"]> {
    if (!this.context.capabilities.includes(method)) {
      return Promise.reject(new Error(`Capability not granted: ${method}`));
    }
    const params = args[0];
    const id = crypto.randomUUID();
    return new Promise<PluginMethodMap[M]["result"]>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC timed out: ${method}`));
      }, 15_000);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.#port.postMessage({ kind: "request", id, method, params });
    });
  }

  setStatus(status: PluginStatus): void {
    this.#port.postMessage({ kind: "event", name: "status", payload: status });
  }

  dispose(): void {
    for (const pending of this.#pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("Plugin connection disposed"));
    }
    this.#pending.clear();
    this.#port.close();
  }
}

export function connectInProgress(timeoutMs = 10_000): Promise<InProgressClient> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("in-progress host handshake timed out"));
    }, timeoutMs);

    function receive(event: MessageEvent<InitMessage>): void {
      if (event.source !== window.parent || event.data?.type !== "in-progress:init") return;
      if (event.data.context.apiVersion !== IN_PROGRESS_PLUGIN_API_VERSION) {
        window.clearTimeout(timer);
        window.removeEventListener("message", receive);
        event.ports[0]?.close();
        reject(new Error(`Unsupported host API: ${event.data.context.apiVersion}`));
        return;
      }
      const port = event.ports[0];
      if (!port) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      port.postMessage({ kind: "ready", nonce: event.data.nonce });
      resolve(new InProgressClient(port, event.data.context));
    }

    window.addEventListener("message", receive);
  });
}

export function definePlugin<T>(definition: T): T {
  return definition;
}
