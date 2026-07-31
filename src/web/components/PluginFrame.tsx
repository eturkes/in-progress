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

export interface PluginStatus {
  state: "idle" | "busy" | "attention" | "error";
  badge: string | null;
  title: string | null;
}

interface PluginFrameProps {
  api: ApiClient;
  plugin: PluginDto;
  project: ProjectDto;
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

export function PluginFrame({ api, plugin, project, onStatus, onToast }: PluginFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const connectedRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setPhase("loading");
    setError(null);
    connectedRef.current = false;
    onStatus({ state: "busy", badge: null, title: null });
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      portRef.current?.close();
      portRef.current = null;
    };
  }, [generation, onStatus, plugin.id, project.id]);

  const connect = () => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    if (connectedRef.current) {
      portRef.current?.close();
      portRef.current = null;
      setPhase("error");
      setError("The plugin navigated away from its installed entry.");
      onStatus({ state: "error", badge: null, title: null });
      return;
    }
    connectedRef.current = true;
    portRef.current?.close();
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);

    const nonce = crypto.randomUUID();
    const channel = new MessageChannel();
    let ready = false;
    const inFlight = new Set<string>();
    let requestTimes: number[] = [];
    portRef.current = channel.port1;
    channel.port1.addEventListener("message", ({ data }: MessageEvent<PluginMessage>) => {
      if (!data || typeof data !== "object") return;
      if (data.kind === "ready") {
        if (data.nonce !== nonce) {
          if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
          setPhase("error");
          setError("Plugin handshake could not be verified.");
          onStatus({ state: "error", badge: null, title: null });
          channel.port1.close();
          return;
        }
        if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
        ready = true;
        setPhase("ready");
        onStatus({ state: "idle", badge: null, title: null });
        return;
      }
      if (!ready) return;
      if (data.kind === "event" && data.name === "status") {
        const next = safeStatus(data.payload);
        if (next) onStatus(next);
        return;
      }
      if (data.kind !== "request" || typeof data.id !== "string" || typeof data.method !== "string")
        return;
      const id = data.id.slice(0, 128);
      const now = Date.now();
      requestTimes = requestTimes.filter((time) => now - time < 10_000);
      if (!id || inFlight.has(id) || inFlight.size >= 8 || requestTimes.length >= 40) {
        channel.port1.postMessage({
          kind: "response",
          id,
          ok: false,
          error: "Plugin request limit reached",
        });
        return;
      }
      if (!plugin.capabilities.includes(data.method)) {
        channel.port1.postMessage({
          kind: "response",
          id,
          ok: false,
          error: `Capability not granted: ${data.method}`,
        });
        return;
      }
      const request: PluginRpcRequest = { method: data.method };
      if (data.params !== undefined) request.params = data.params;
      requestTimes.push(now);
      inFlight.add(id);
      void api
        .pluginRpc(plugin.id, project.id, request)
        .then(
          (result) => channel.port1.postMessage({ kind: "response", id, ok: true, result }),
          (rpcError: unknown) =>
            channel.port1.postMessage({
              kind: "response",
              id,
              ok: false,
              error: messageText(rpcError),
            }),
        )
        .finally(() => inFlight.delete(id));
    });
    channel.port1.start();

    target.postMessage(
      {
        type: "switchyard:init",
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
          theme: {
            mode: "dark",
            tokens: {
              background: "#0b0e14",
              surface: "#121722",
              surfaceRaised: "#18202c",
              border: "#283142",
              text: "#e7ecf4",
              muted: "#909cb0",
              accent: "#67d5b5",
              warning: "#f2b84b",
              danger: "#ff6b78",
              uiFont: "Atkinson Hyperlegible Next",
              monoFont: "Iosevka",
            },
          },
        },
      },
      "*",
      [channel.port2],
    );

    timeoutRef.current = window.setTimeout(() => {
      setPhase("error");
      setError("Plugin did not complete its host handshake.");
      onStatus({ state: "error", badge: null, title: null });
      channel.port1.close();
    }, 10_000);
  };

  const reload = () => {
    connectedRef.current = false;
    portRef.current?.close();
    portRef.current = null;
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
