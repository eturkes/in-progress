import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import {
  Accessibility,
  Clipboard,
  Eraser,
  Plus,
  RefreshCw,
  SquareTerminal,
  Unplug,
  X,
} from "lucide-react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectDto, TerminalSessionDto } from "../../shared/contracts";
import { TerminalWire, resizeFrame, wireFrame } from "../../shared/terminal-wire";
import { moveRovingTab } from "../a11y";
import { type ApiClient, websocketUrl } from "../api";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

interface TerminalPaneProps {
  api: ApiClient;
  project: ProjectDto;
  onToast: (message: string, tone?: "neutral" | "danger") => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected terminal error";
}

function storedSession(projectId: string): string | null {
  try {
    return window.localStorage.getItem(`switchyard:last-session:${projectId}`);
  } catch {
    return null;
  }
}

function currentSession(projectId: string): string | null {
  return new URL(window.location.href).searchParams.get("session") ?? storedSession(projectId);
}

function rememberSession(projectId: string, sessionId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionId);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  try {
    window.localStorage.setItem(`switchyard:last-session:${projectId}`, sessionId);
  } catch {
    // The URL remains the session source when persistent storage is unavailable.
  }
}

function storedScreenReaderMode(projectId: string): boolean {
  try {
    return window.localStorage.getItem(`switchyard:screen-reader:${projectId}`) === "true";
  } catch {
    return false;
  }
}

function rememberScreenReaderMode(projectId: string, enabled: boolean): void {
  try {
    window.localStorage.setItem(`switchyard:screen-reader:${projectId}`, String(enabled));
  } catch {
    // The preference remains active until this view is remounted.
  }
}

export function TerminalPane({ api, project, onToast }: TerminalPaneProps) {
  const [sessions, setSessions] = useState<TerminalSessionDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialSession = useMemo(() => currentSession(project.id), [project.id]);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.sessions(project.id);
      setSessions(next);
      const preferred =
        next.find((session) => session.id === initialSession) ??
        next.find((session) => session.state === "running") ??
        next[0];
      setSelectedId(preferred?.id ?? null);
      if (preferred) rememberSession(project.id, preferred.id);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [api, initialSession, project.id]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const createSession = useCallback(async () => {
    if (creating || !project.available) return;
    setCreating(true);
    setError(null);
    try {
      const session = await api.createSession(project.id);
      setSessions((current) => [...current, session]);
      setSelectedId(session.id);
      rememberSession(project.id, session.id);
    } catch (createError) {
      const message = errorMessage(createError);
      setError(message);
      onToast(message, "danger");
    } finally {
      setCreating(false);
    }
  }, [api, creating, onToast, project.available, project.id]);

  const terminateSession = useCallback(
    async (session: TerminalSessionDto) => {
      if (
        session.state === "running" &&
        !window.confirm(`Stop ${session.title}? Its process will exit.`)
      )
        return;
      try {
        await api.terminateSession(project.id, session.id);
        setSessions((current) =>
          current.map((item) =>
            item.id === session.id ? { ...item, state: "exited", exitCode: item.exitCode } : item,
          ),
        );
        onToast(`${session.title} stopped`);
      } catch (terminateError) {
        onToast(errorMessage(terminateError), "danger");
      }
    },
    [api, onToast, project.id],
  );

  const selectSession = (sessionId: string) => {
    setSelectedId(sessionId);
    rememberSession(project.id, sessionId);
  };

  const updateSession = useCallback((updated: TerminalSessionDto) => {
    setSessions((current) =>
      current.map((session) => (session.id === updated.id ? updated : session)),
    );
  }, []);

  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  return (
    <section className="terminal-plugin" aria-label={`${project.name} terminal`}>
      <div className="session-strip">
        <div
          className="session-tabs"
          role="tablist"
          aria-label="Terminal sessions"
          onKeyDown={moveRovingTab}
        >
          {sessions.map((session) => (
            <div
              className={`session-tab ${session.id === selectedId ? "is-active" : ""}`}
              key={session.id}
            >
              <button
                type="button"
                id={`session-tab-${session.id}`}
                role="tab"
                aria-selected={session.id === selectedId}
                aria-controls="terminal-session-panel"
                tabIndex={session.id === selectedId ? 0 : -1}
                onClick={() => selectSession(session.id)}
              >
                <span
                  className={`session-state session-state--${session.state}`}
                  aria-hidden="true"
                />
                <span className="sr-only">{session.state}</span>
                <span>{session.title}</span>
              </button>
              {session.state === "running" ? (
                <button
                  type="button"
                  className="session-close"
                  aria-label={`Stop ${session.title}`}
                  title={`Stop ${session.title}`}
                  onClick={() => void terminateSession(session)}
                >
                  <X size={13} strokeWidth={2} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="icon-button new-session"
          onClick={() => void createSession()}
          disabled={creating || !project.available}
          aria-label="New terminal session"
          title="New terminal session"
        >
          {creating ? <span className="spinner" /> : <Plus size={17} />}
        </button>
      </div>

      <div
        id="terminal-session-panel"
        className="terminal-session"
        role="tabpanel"
        aria-labelledby={selectedId ? `session-tab-${selectedId}` : undefined}
      >
        {loading ? (
          <TerminalPlaceholder label="Finding durable sessions…" />
        ) : error && sessions.length === 0 ? (
          <TerminalEmpty
            icon={<Unplug size={25} />}
            title="Terminal unavailable"
            body={error}
            action="Try again"
            onAction={() => void loadSessions()}
          />
        ) : !project.available ? (
          <TerminalEmpty
            icon={<Unplug size={25} />}
            title="Project path is offline"
            body={`${project.displayPath} is not currently available on the host.`}
          />
        ) : !selected ? (
          <TerminalEmpty
            icon={<SquareTerminal size={27} />}
            title="Open a durable shell"
            body="It keeps running when you switch projects or close this browser."
            action={creating ? "Starting…" : "Start session"}
            onAction={() => void createSession()}
          />
        ) : selected.state === "exited" ? (
          <TerminalEmpty
            icon={<SquareTerminal size={27} />}
            title={`${selected.title} exited`}
            body={`Exit code ${selected.exitCode ?? "unknown"}. Start a fresh shell to continue.`}
            action="New session"
            onAction={() => void createSession()}
          />
        ) : (
          <TerminalConnection
            key={selected.id}
            api={api}
            projectId={project.id}
            session={selected}
            onSession={updateSession}
            onToast={onToast}
          />
        )}
      </div>
    </section>
  );
}

interface TerminalEmptyProps {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}

function TerminalEmpty({ icon, title, body, action, onAction }: TerminalEmptyProps) {
  return (
    <div className="terminal-empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action && onAction ? (
        <button type="button" className="primary-button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

function TerminalPlaceholder({ label }: { label: string }) {
  return (
    <div className="terminal-placeholder" role="status">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

interface TerminalConnectionProps {
  api: ApiClient;
  projectId: string;
  session: TerminalSessionDto;
  onSession: (session: TerminalSessionDto) => void;
  onToast: (message: string, tone?: "neutral" | "danger") => void;
}

interface WireStatus {
  session: TerminalSessionDto;
  writable: boolean;
}

const decoder = new TextDecoder();

function TerminalConnection({
  api,
  projectId,
  session,
  onSession,
  onToast,
}: TerminalConnectionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const modifiersRef = useRef({ ctrl: false, alt: false });
  const writableRef = useRef(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [writable, setWritable] = useState(false);
  const [screenReaderMode, setScreenReaderMode] = useState(() => storedScreenReaderMode(projectId));
  const initialScreenReaderModeRef = useRef(screenReaderMode);
  const [modifiers, setModifiers] = useState({ ctrl: false, alt: false });
  const [retry, setRetry] = useState(0);

  const send = useCallback((frame: Uint8Array) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    const copy = new Uint8Array(frame.byteLength);
    copy.set(frame);
    socketRef.current.send(copy.buffer);
  }, []);

  const applyModifiers = useCallback((raw: string): string => {
    const active = modifiersRef.current;
    let data = raw;
    if (active.ctrl && data.length === 1) {
      if (data === "/") data = "\x1f";
      else {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
      }
    }
    if (active.alt) data = `\x1b${data}`;
    if (active.ctrl || active.alt) {
      modifiersRef.current = { ctrl: false, alt: false };
      setModifiers({ ctrl: false, alt: false });
    }
    return data;
  }, []);

  const sendInput = useCallback(
    (raw: string) => {
      if (!writableRef.current) return;
      send(wireFrame(TerminalWire.input, new TextEncoder().encode(applyModifiers(raw))));
    },
    [applyModifiers, send],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: true,
      fontFamily: '"Iosevka", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      fontWeight: "400",
      lineHeight: 1.16,
      rightClickSelectsWord: true,
      screenReaderMode: initialScreenReaderModeRef.current,
      scrollback: 10_000,
      theme: {
        background: "#0b0e14",
        foreground: "#dbe4ee",
        cursor: "#67d5b5",
        cursorAccent: "#0b0e14",
        selectionBackground: "#315d56aa",
        black: "#121722",
        red: "#ff6b78",
        green: "#67d5b5",
        yellow: "#f2b84b",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#58c7d6",
        white: "#dbe4ee",
        brightBlack: "#68758a",
        brightRed: "#ff8993",
        brightGreen: "#84e3c7",
        brightYellow: "#ffd074",
        brightBlue: "#9bb9ff",
        brightMagenta: "#cfb4ff",
        brightCyan: "#82dce7",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((_event, rawUrl) => {
        try {
          const url = new URL(rawUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:") return;
          const opened = window.open(url.href, "_blank", "noopener,noreferrer");
          if (opened) opened.opener = null;
        } catch {
          // Only absolute HTTP(S) links are activated.
        }
      }),
    );
    terminal.open(host);
    terminalRef.current = terminal;
    const dataDisposable = terminal.onData(sendInput);
    const resizeDisposable = terminal.onResize(({ cols, rows }) => send(resizeFrame(cols, rows)));
    let fitFrame = 0;
    const fitTerminal = () => {
      window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // The viewport may have been detached during a project switch.
        }
      });
    };
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(host);
    window.visualViewport?.addEventListener("resize", fitTerminal);
    fitTerminal();
    terminal.focus();

    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", fitTerminal);
      window.cancelAnimationFrame(fitFrame);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [send, sendInput]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.screenReaderMode = screenReaderMode;
  }, [screenReaderMode]);

  useEffect(() => {
    if (terminalRef.current)
      terminalRef.current.options.disableStdin = connection !== "connected" || !writable;
  }, [connection, writable]);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;

    const connect = async () => {
      if (disposed) return;
      writableRef.current = false;
      setWritable(false);
      setConnection(attempt === 0 ? "connecting" : "reconnecting");
      try {
        const { ticket } = await api.terminalTicket(projectId, session.id);
        if (disposed) return;
        const socket = new WebSocket(websocketUrl(ticket), "switchyard.terminal.v1");
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;
        socket.addEventListener("open", () => {
          attempt = 0;
          setConnection("connected");
          const terminal = terminalRef.current;
          if (terminal) {
            send(resizeFrame(terminal.cols, terminal.rows));
            terminal.focus();
          }
        });
        socket.addEventListener("message", ({ data }: MessageEvent<ArrayBuffer>) => {
          const frame = new Uint8Array(data);
          const opcode = frame[0];
          const payload = frame.subarray(1);
          if (opcode === TerminalWire.output) terminalRef.current?.write(payload);
          else if (opcode === TerminalWire.snapshot) {
            terminalRef.current?.reset();
            terminalRef.current?.write(payload);
          } else if (opcode === TerminalWire.status) {
            try {
              const status = JSON.parse(decoder.decode(payload)) as WireStatus;
              writableRef.current = status.writable;
              setWritable(status.writable);
              onSession(status.session);
              if (status.session.state === "exited") socket.close(1000, "Session exited");
            } catch {
              onToast("Terminal sent an invalid status frame", "danger");
            }
          }
        });
        socket.addEventListener("close", (event) => {
          if (socketRef.current === socket) socketRef.current = null;
          writableRef.current = false;
          setWritable(false);
          if (disposed || event.code === 1000) {
            setConnection("offline");
            return;
          }
          attempt += 1;
          setConnection("reconnecting");
          const delay = Math.min(6_000, 500 * 2 ** Math.min(attempt, 4));
          reconnectTimerRef.current = window.setTimeout(() => void connect(), delay);
        });
        socket.addEventListener("error", () => socket.close());
      } catch (connectError) {
        if (disposed) return;
        writableRef.current = false;
        setWritable(false);
        attempt += 1;
        setConnection("offline");
        if (attempt === 1) onToast(errorMessage(connectError), "danger");
        const delay = Math.min(6_000, 750 * 2 ** Math.min(attempt, 3));
        reconnectTimerRef.current = window.setTimeout(() => void connect(), delay);
      }
    };

    void connect();
    const heartbeat = window.setInterval(() => send(wireFrame(TerminalWire.ping)), 20_000);
    return () => {
      disposed = true;
      window.clearInterval(heartbeat);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close(1000, "View changed");
      socketRef.current = null;
    };
  }, [api, onSession, onToast, projectId, retry, send, session.id]);

  const copySelection = async () => {
    const selection = terminalRef.current?.getSelection() ?? "";
    if (!selection) {
      onToast("Select terminal text to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(selection);
      onToast("Selection copied");
    } catch {
      onToast("Clipboard access was denied", "danger");
    }
  };

  const onPasteCapture = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData("text");
    const lines = text.split(/\r?\n/).length;
    if (lines > 1 && !window.confirm(`Paste ${lines} lines into ${session.title}?`)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const toggleModifier = (name: "ctrl" | "alt") => {
    const next = { ...modifiersRef.current, [name]: !modifiersRef.current[name] };
    modifiersRef.current = next;
    setModifiers(next);
    terminalRef.current?.focus();
  };

  const sendAccessory = (label: string, value: string) => {
    const cursorSuffix: Record<string, string> = { "←": "D", "↑": "A", "↓": "B", "→": "C" };
    const suffix = cursorSuffix[label];
    const resolved = suffix
      ? `\x1b${terminalRef.current?.modes.applicationCursorKeysMode ? "O" : "["}${suffix}`
      : value;
    sendInput(resolved);
    terminalRef.current?.focus();
  };

  const accessoryKeys = [
    ["Esc", "\x1b"],
    ["Tab", "\t"],
    ["/", "/"],
    ["-", "-"],
    ["|", "|"],
    ["←", "\x1b[D"],
    ["↑", "\x1b[A"],
    ["↓", "\x1b[B"],
    ["→", "\x1b[C"],
  ] as const;

  const connectionLabel =
    connection === "connected"
      ? "Live"
      : connection === "connecting"
        ? "Connecting"
        : connection === "reconnecting"
          ? "Reconnecting"
          : "Offline";

  return (
    <div className="terminal-connection">
      <div className="terminal-toolbar">
        <div className={`connection-pill connection-pill--${connection}`} role="status">
          <span aria-hidden="true" />
          {connectionLabel}
        </div>
        {connection === "connected" && !writable ? (
          <button
            type="button"
            className="take-control"
            onClick={() => send(wireFrame(TerminalWire.claim))}
          >
            Read-only · take control
          </button>
        ) : connection === "connected" ? (
          <span className="writer-label">You have input control</span>
        ) : (
          <span className="writer-label">Input paused while disconnected</span>
        )}
        <div className="toolbar-spacer" />
        <button
          type="button"
          className="toolbar-button"
          onClick={() => void copySelection()}
          title="Copy selection"
        >
          <Clipboard size={15} />
          <span>Copy</span>
        </button>
        <button
          type="button"
          className="toolbar-button"
          onClick={() => terminalRef.current?.clear()}
          title="Clear local viewport"
        >
          <Eraser size={15} />
          <span>Clear</span>
        </button>
        <button
          type="button"
          className={`toolbar-button ${screenReaderMode ? "is-active" : ""}`}
          onClick={() =>
            setScreenReaderMode((value) => {
              rememberScreenReaderMode(projectId, !value);
              return !value;
            })
          }
          aria-pressed={screenReaderMode}
          title="Screen-reader mode"
        >
          <Accessibility size={15} />
          <span>Accessible</span>
        </button>
        {connection !== "connected" ? (
          <button
            type="button"
            className="toolbar-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={15} />
            <span>Retry</span>
          </button>
        ) : null}
      </div>
      <div
        ref={hostRef}
        className="terminal-host"
        style={{ "--terminal-accent": "#67d5b5" } as CSSProperties}
        onPasteCapture={onPasteCapture}
        aria-label={`${session.title} terminal output`}
      />
      <div className="terminal-accessory" aria-label="Terminal keys">
        <button
          type="button"
          className={modifiers.ctrl ? "is-latched" : ""}
          aria-pressed={modifiers.ctrl}
          disabled={connection !== "connected" || !writable}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => toggleModifier("ctrl")}
        >
          Ctrl
        </button>
        <button
          type="button"
          className={modifiers.alt ? "is-latched" : ""}
          aria-pressed={modifiers.alt}
          disabled={connection !== "connected" || !writable}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => toggleModifier("alt")}
        >
          Alt
        </button>
        {accessoryKeys.map(([label, value]) => (
          <button
            type="button"
            key={label}
            disabled={connection !== "connected" || !writable}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => sendAccessory(label, value)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
