import { AlertTriangle, Blocks, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  PLUGIN_API_VERSION,
  type PluginCapability,
  type PluginDto,
  type PluginRpcRequest,
  type ProjectDto,
} from "../../shared/contracts";
import type { ApiClient } from "../api";
import { authorizePluginRequest } from "../plugin-authority";
import { type ResolvedTheme, pluginTheme } from "../theme";

export interface PluginStatus {
  state: "idle" | "busy" | "attention" | "error";
  badge: string | null;
  title: string | null;
}

interface PluginFrameProps {
  api: ApiClient;
  plugin: PluginDto;
  project: ProjectDto;
  theme: ResolvedTheme;
  treeCompleteMode: "preview" | "codex" | null;
  onStatus: (status: PluginStatus) => void;
  onToast: (message: string, tone?: "neutral" | "danger") => void;
}

type PluginMessage =
  | { kind: "ready"; nonce: string }
  | { kind: "request"; id: string; method: PluginCapability; params?: unknown }
  | { kind: "event"; name: "status"; payload?: unknown };

function safeStatus(value: unknown): PluginStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const state = candidate.state ?? "idle";
  if (state !== "idle" && state !== "busy" && state !== "attention" && state !== "error")
    return null;
  const badge = typeof candidate.badge === "string" ? candidate.badge.slice(0, 8) : null;
  const title = typeof candidate.title === "string" ? candidate.title.slice(0, 80) : null;
  return { state, badge, title };
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : "Plugin RPC failed";
}

export function PluginFrame({
  api,
  plugin,
  project,
  theme,
  treeCompleteMode,
  onStatus,
  onToast,
}: PluginFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const attemptPortsRef = useRef(new Set<MessagePort>());
  const retryTimersRef = useRef<number[]>([]);
  const connectedRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const clearRetryTimers = () => {
    for (const timer of retryTimersRef.current) window.clearTimeout(timer);
    retryTimersRef.current = [];
  };

  const closePorts = () => {
    for (const port of attemptPortsRef.current) port.close();
    attemptPortsRef.current.clear();
    portRef.current = null;
  };

  useEffect(() => {
    setPhase("loading");
    setError(null);
    connectedRef.current = false;
    onStatus({ state: "busy", badge: null, title: null });
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      clearRetryTimers();
      closePorts();
    };
  }, [onStatus, plugin.id, project.id]);

  const connect = () => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    if (connectedRef.current) {
      clearRetryTimers();
      closePorts();
      setPhase("error");
      setError("The plugin navigated away from its installed entry.");
      onStatus({ state: "error", badge: null, title: null });
      return;
    }
    connectedRef.current = true;
    clearRetryTimers();
    closePorts();
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);

    const nonce = crypto.randomUUID();
    let ready = false;
    const inFlight = new Set<string>();
    let requestTimes: number[] = [];
    const initMessage = {
      type: "in-progress:init",
      nonce,
      context: {
        apiVersion: PLUGIN_API_VERSION,
        capabilities: plugin.capabilities,
        project: {
          id: project.id,
          name: project.name,
          color: project.color,
          available: project.available,
        },
        theme: pluginTheme(theme),
      },
    };

    const attempt = () => {
      if (ready) return;
      const channel = new MessageChannel();
      const port = channel.port1;
      attemptPortsRef.current.add(port);
      port.addEventListener("message", ({ data }: MessageEvent<PluginMessage>) => {
        if (!data || typeof data !== "object") return;
        if (data.kind === "ready") {
          if (data.nonce !== nonce) {
            if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
            clearRetryTimers();
            closePorts();
            setPhase("error");
            setError("Plugin handshake could not be verified.");
            onStatus({ state: "error", badge: null, title: null });
            return;
          }
          if (ready) return;
          if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
          clearRetryTimers();
          ready = true;
          portRef.current = port;
          for (const pending of attemptPortsRef.current) {
            if (pending === port) continue;
            pending.close();
            attemptPortsRef.current.delete(pending);
          }
          setPhase("ready");
          onStatus({ state: "idle", badge: null, title: null });
          return;
        }
        if (!ready || portRef.current !== port) return;
        if (data.kind === "event" && data.name === "status") {
          const next = safeStatus(data.payload);
          if (next) onStatus(next);
          return;
        }
        if (
          data.kind !== "request" ||
          typeof data.id !== "string" ||
          typeof data.method !== "string"
        )
          return;
        const id = data.id.slice(0, 128);
        const now = Date.now();
        requestTimes = requestTimes.filter((time) => now - time < 10_000);
        if (!id || inFlight.has(id) || inFlight.size >= 8 || requestTimes.length >= 40) {
          port.postMessage({
            kind: "response",
            id,
            ok: false,
            error: "Plugin request limit reached",
          });
          return;
        }
        if (!plugin.capabilities.includes(data.method)) {
          port.postMessage({
            kind: "response",
            id,
            ok: false,
            error: `Capability not granted: ${data.method}`,
          });
          return;
        }
        requestTimes.push(now);
        const authority = authorizePluginRequest(
          data.method,
          data.params,
          plugin.name,
          plugin.id,
          project.name,
          project.id,
          treeCompleteMode,
          window.confirm.bind(window),
        );
        if (!authority.allowed) {
          port.postMessage({
            kind: "response",
            id,
            ok: false,
            error: authority.error,
          });
          return;
        }
        const request: PluginRpcRequest = { method: data.method };
        if (authority.params !== undefined) request.params = authority.params;
        inFlight.add(id);
        void api
          .pluginRpc(plugin.id, project.id, request)
          .then(
            (result) => port.postMessage({ kind: "response", id, ok: true, result }),
            (rpcError: unknown) =>
              port.postMessage({
                kind: "response",
                id,
                ok: false,
                error: messageText(rpcError),
              }),
          )
          .finally(() => inFlight.delete(id));
      });
      port.start();
      target.postMessage(initMessage, "*", [channel.port2]);
    };

    attempt();
    retryTimersRef.current = [100, 500].map((delay) => window.setTimeout(attempt, delay));

    timeoutRef.current = window.setTimeout(() => {
      clearRetryTimers();
      closePorts();
      setPhase("error");
      setError("Plugin did not complete its host handshake.");
      onStatus({ state: "error", badge: null, title: null });
    }, 10_000);
  };

  const reload = () => {
    connectedRef.current = false;
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    clearRetryTimers();
    closePorts();
    setPhase("loading");
    setError(null);
    setGeneration((value) => value + 1);
    onToast(`Reloading ${plugin.name}`);
  };

  return (
    <section className="plugin-frame-shell" aria-label={`${plugin.name} plugin`}>
      {phase === "loading" ? (
        <div className="plugin-loading" role="status">
          <div className="plugin-loading-mark">
            <Blocks size={20} />
          </div>
          <span>Connecting {plugin.name}…</span>
        </div>
      ) : null}
      {phase === "error" ? (
        <div className="plugin-error" role="alert">
          <div className="empty-icon danger">
            <AlertTriangle size={25} />
          </div>
          <h2>{plugin.name} is unavailable</h2>
          <p>{error}</p>
          <button type="button" className="primary-button" onClick={reload}>
            <RefreshCw size={16} />
            Reload plugin
          </button>
        </div>
      ) : null}
      <iframe
        key={generation}
        ref={iframeRef}
        className={phase === "ready" ? "is-ready" : ""}
        src={plugin.entryUrl}
        title={`${plugin.name} — ${project.name}`}
        tabIndex={phase === "ready" ? 0 : -1}
        aria-hidden={phase === "ready" ? undefined : true}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={connect}
        onError={() => {
          setPhase("error");
          setError("The plugin entry could not be loaded.");
          onStatus({ state: "error", badge: null, title: null });
        }}
      />
    </section>
  );
}
