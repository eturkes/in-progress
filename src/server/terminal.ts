import { join } from "node:path";
import type { NotificationEventInput, TerminalSessionDto } from "../shared/contracts";
import { TerminalWire, wireFrame } from "../shared/terminal-wire";
import type { InProgressConfig } from "./config";
import { NotificationService } from "./notifications";
import { ProjectRegistry } from "./projects";
import { HttpError } from "./security";

export interface TerminalSocketData {
  kind: "terminal";
  projectId: string;
  terminalSessionId: string;
  connectionId: string;
  flow?: SocketFlow;
}

interface SocketFlow {
  replay: Uint8Array | null;
  replayOffset: number;
  queue: Uint8Array[];
  queuedBytes: number;
  backpressured: boolean;
}

interface Ticket {
  browserSessionId: string;
  projectId: string;
  terminalSessionId: string;
  expiresAt: number;
}

class ByteRing {
  readonly #chunks: Uint8Array[] = [];
  #size = 0;

  constructor(readonly limit: number) {}

  push(raw: Uint8Array): void {
    const chunk = raw.slice();
    this.#chunks.push(chunk);
    this.#size += chunk.byteLength;
    while (this.#size > this.limit && this.#chunks.length > 0) {
      const first = this.#chunks[0]!;
      const excess = this.#size - this.limit;
      if (first.byteLength <= excess) {
        this.#chunks.shift();
        this.#size -= first.byteLength;
      } else {
        this.#chunks[0] = first.slice(excess);
        this.#size -= excess;
      }
    }
  }

  bytes(): Uint8Array {
    const result = new Uint8Array(this.#size);
    let offset = 0;
    for (const chunk of this.#chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

interface TerminalSession {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  terminal: Bun.Terminal;
  process: Bun.Subprocess;
  output: ByteRing;
  clients: Map<string, Bun.ServerWebSocket<TerminalSocketData>>;
  writerId: string | null;
  state: "running" | "exited";
  exitCode?: number;
  terminationRequested: boolean;
  notificationTimes: number[];
  oscTail: string;
  oscDecoder: TextDecoder;
  inputQueue: Uint8Array[];
  inputBytes: number;
}

const SOCKET_REPLAY_CHUNK = 32 * 1024;
const SOCKET_LIVE_QUEUE_LIMIT = 512 * 1024;
const TERMINAL_INPUT_QUEUE_LIMIT = 256 * 1024;

function statusFrame(session: TerminalSession, connectionId: string): Uint8Array {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      session: sessionDto(session),
      writable: session.writerId === connectionId,
    }),
  );
  return wireFrame(TerminalWire.status, payload);
}

function sessionDto(session: TerminalSession): TerminalSessionDto {
  const dto: TerminalSessionDto = {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    createdAt: session.createdAt,
    attachedClients: session.clients.size,
    state: session.state,
  };
  if (session.exitCode !== undefined) dto.exitCode = session.exitCode;
  return dto;
}

export class TerminalManager {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #tickets = new Map<string, Ticket>();
  readonly #config: InProgressConfig;
  readonly #projects: ProjectRegistry;
  readonly #notifications: NotificationService;
  #closing = false;
  #serverPort: number;

  constructor(
    config: InProgressConfig,
    projects: ProjectRegistry,
    notifications: NotificationService,
  ) {
    this.#config = config;
    this.#projects = projects;
    this.#notifications = notifications;
    this.#serverPort = config.server.port;
  }

  setServerPort(port: number): void {
    this.#serverPort = port;
  }

  list(projectId: string): TerminalSessionDto[] {
    this.#projects.get(projectId);
    return [...this.#sessions.values()]
      .filter((session) => session.projectId === projectId)
      .map(sessionDto);
  }

  get(projectId: string, sessionId: string): TerminalSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.projectId !== projectId)
      throw new HttpError(404, "Terminal session not found");
    return session;
  }

  create(projectId: string): TerminalSessionDto {
    const project = this.#projects.get(projectId);
    this.#evictExited(projectId);
    const projectSessions = this.list(projectId);
    if (
      projectSessions.filter((session) => session.state === "running").length >=
      this.#config.terminal.maxSessionsPerProject
    ) {
      throw new HttpError(409, "Project session limit reached");
    }

    const id = crypto.randomUUID();
    let session!: TerminalSession;
    const configuredHost = this.#config.server.host;
    const notifyHost =
      configuredHost === "::1"
        ? "[::1]"
        : configuredHost === "0.0.0.0"
          ? "127.0.0.1"
          : configuredHost;
    const notifyUrl = `http://${notifyHost}:${this.#serverPort}/api/hooks/notify`;
    const command = [this.#config.terminal.shell, ...this.#config.terminal.shellArgs];
    const child = Bun.spawn(command, {
      cwd: project.path,
      env: {
        ...processEnv(),
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
        IN_PROGRESS_NOTIFY_URL: notifyUrl,
        IN_PROGRESS_NOTIFY_TOKEN: this.#notifications.hookToken,
        IN_PROGRESS_PROJECT_ID: project.id,
        PATH: `${join(this.#config.rootDir, "bin")}:${globalThis.process.env.PATH ?? ""}`,
      },
      // A spawn-owned PTY makes the child its session leader with a controlling
      // terminal; a preconstructed Bun.Terminal loses Linux shell job control.
      terminal: {
        cols: 100,
        rows: 30,
        name: "xterm-256color",
        data: (_terminal, data) => this.#onOutput(session, data),
        drain: () => this.#drainInput(session),
      },
      onExit: (_process, exitCode, signalCode, error) => {
        this.#onExit(session, exitCode ?? (error ? 1 : null), signalCode ?? undefined);
      },
    });
    const terminal = child.terminal;
    if (!terminal) {
      child.kill("SIGTERM");
      throw new Error("Bun did not attach the requested pseudo-terminal");
    }
    session = {
      id,
      projectId,
      title: `Shell ${projectSessions.length + 1}`,
      createdAt: new Date().toISOString(),
      terminal,
      process: child,
      output: new ByteRing(this.#config.terminal.scrollbackBytes),
      clients: new Map(),
      writerId: null,
      state: "running",
      terminationRequested: false,
      notificationTimes: [],
      oscTail: "",
      oscDecoder: new TextDecoder(),
      inputQueue: [],
      inputBytes: 0,
    };
    this.#sessions.set(id, session);
    return sessionDto(session);
  }

  terminate(projectId: string, sessionId: string): void {
    const session = this.get(projectId, sessionId);
    if (session.state === "running") {
      session.terminationRequested = true;
      session.process.kill("SIGTERM");
    }
    session.terminal.close();
  }

  issueTicket(
    projectId: string,
    sessionId: string,
    browserSessionId: string,
  ): { ticket: string; expiresAt: string } {
    const session = this.get(projectId, sessionId);
    if (session.state !== "running") throw new HttpError(409, "Terminal session has exited");
    const ticket = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const expiresAt = Date.now() + 30_000;
    this.#tickets.set(ticket, {
      browserSessionId,
      projectId,
      terminalSessionId: sessionId,
      expiresAt,
    });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  ticket(ticket: string): Ticket {
    const record = this.#tickets.get(ticket);
    if (!record || record.expiresAt < Date.now())
      throw new HttpError(401, "Terminal ticket invalid or expired");
    return record;
  }

  consumeTicket(ticket: string): Ticket {
    const record = this.ticket(ticket);
    this.#tickets.delete(ticket);
    return record;
  }

  attach(socket: Bun.ServerWebSocket<TerminalSocketData>): void {
    const session = this.get(socket.data.projectId, socket.data.terminalSessionId);
    session.clients.set(socket.data.connectionId, socket);
    session.writerId = socket.data.connectionId;
    const replay = session.output.bytes();
    socket.data.flow = {
      replay: replay.byteLength > 0 ? replay : null,
      replayOffset: 0,
      queue: [],
      queuedBytes: 0,
      backpressured: false,
    };
    this.#broadcastStatus(session);
    this.#pumpSocket(socket);
  }

  message(socket: Bun.ServerWebSocket<TerminalSocketData>, raw: string | Buffer): void {
    if (typeof raw === "string") {
      socket.close(1003, "Binary terminal protocol required");
      return;
    }
    const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const opcode = data[0];
    const session = this.get(socket.data.projectId, socket.data.terminalSessionId);
    if (opcode === TerminalWire.input) {
      if (session.writerId !== socket.data.connectionId) {
        this.#sendControl(socket, statusFrame(session, socket.data.connectionId));
        return;
      }
      if (data.byteLength > 1 && !this.#writeInput(session, data.subarray(1))) {
        socket.close(1009, "Terminal input queue exceeded");
      }
    } else if (opcode === TerminalWire.resize && data.byteLength === 5) {
      if (session.writerId !== socket.data.connectionId) return;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const cols = view.getUint16(1);
      const rows = view.getUint16(3);
      if (cols >= 2 && cols <= 1_000 && rows >= 1 && rows <= 500)
        session.terminal.resize(cols, rows);
    } else if (opcode === TerminalWire.claim) {
      session.writerId = socket.data.connectionId;
      this.#broadcastStatus(session);
    } else if (opcode === TerminalWire.ping) {
      this.#sendControl(socket, wireFrame(TerminalWire.pong));
    } else {
      socket.close(1003, "Invalid terminal frame");
    }
  }

  detach(socket: Bun.ServerWebSocket<TerminalSocketData>): void {
    const session = this.#sessions.get(socket.data.terminalSessionId);
    if (!session) return;
    session.clients.delete(socket.data.connectionId);
    if (session.writerId === socket.data.connectionId) {
      session.writerId = [...session.clients.keys()].at(-1) ?? null;
    }
    this.#broadcastStatus(session);
  }

  drain(socket: Bun.ServerWebSocket<TerminalSocketData>): void {
    const flow = socket.data.flow;
    if (!flow) return;
    flow.backpressured = false;
    this.#pumpSocket(socket);
  }

  sweep(): void {
    const now = Date.now();
    for (const [ticket, record] of this.#tickets)
      if (record.expiresAt < now) this.#tickets.delete(ticket);
  }

  close(): void {
    this.#closing = true;
    for (const session of this.#sessions.values()) {
      if (session.state === "running") session.process.kill("SIGTERM");
      session.terminal.close();
    }
    this.#sessions.clear();
  }

  #onOutput(session: TerminalSession | undefined, data: Uint8Array): void {
    if (!session) return;
    session.output.push(data);
    for (const socket of session.clients.values()) {
      for (let offset = 0; offset < data.byteLength; offset += SOCKET_REPLAY_CHUNK) {
        this.#sendOutput(socket, data.subarray(offset, offset + SOCKET_REPLAY_CHUNK));
      }
    }

    session.oscTail =
      `${session.oscTail}${session.oscDecoder.decode(data, { stream: true })}`.slice(-2_048);
    // oxlint-disable-next-line no-control-regex -- OSC notifications are ESC/BEL-delimited.
    const pattern = /\x1b\]777;notify;([^;\x07]{1,100});([^\x07]{0,240})\x07/g;
    for (const match of session.oscTail.matchAll(pattern)) {
      const now = Date.now();
      session.notificationTimes = session.notificationTimes.filter((time) => now - time < 60_000);
      if (session.notificationTimes.length >= 10) continue;
      session.notificationTimes.push(now);
      this.#notifications.create({
        projectId: session.projectId,
        kind: "completed",
        title: match[1]!,
        body: match[2]!,
        url: `/p/${session.projectId}/terminal?session=${session.id}`,
      });
    }
    const lastBell = session.oscTail.lastIndexOf("\x07");
    if (lastBell >= 0) session.oscTail = session.oscTail.slice(lastBell + 1);
  }

  #onExit(
    session: TerminalSession | undefined,
    exitCode: number | null,
    signal?: number | string,
  ): void {
    if (!session || session.state === "exited") return;
    session.state = "exited";
    if (exitCode !== null) session.exitCode = exitCode;
    session.writerId = null;
    this.#broadcastStatus(session);
    if (this.#closing) return;
    const input: NotificationEventInput = {
      projectId: session.projectId,
      kind: session.terminationRequested ? "system" : exitCode === 0 ? "completed" : "failed",
      title: session.terminationRequested ? `${session.title} stopped` : `${session.title} exited`,
      body: signal ? `Signal ${signal}` : `Exit code ${exitCode ?? "unknown"}`,
      url: `/p/${session.projectId}/terminal?session=${session.id}`,
    };
    this.#notifications.create(input);
  }

  #broadcastStatus(session: TerminalSession): void {
    for (const [connectionId, socket] of session.clients)
      this.#sendControl(socket, statusFrame(session, connectionId));
  }

  #sendControl(socket: Bun.ServerWebSocket<TerminalSocketData>, frame: Uint8Array): void {
    this.#sendFrame(socket, frame);
  }

  #sendOutput(socket: Bun.ServerWebSocket<TerminalSocketData>, data: Uint8Array): void {
    this.#sendFrame(socket, wireFrame(TerminalWire.output, data));
  }

  #sendFrame(socket: Bun.ServerWebSocket<TerminalSocketData>, frame: Uint8Array): void {
    const flow = socket.data.flow;
    if (!flow) return;
    if (flow.replay || flow.backpressured || flow.queue.length > 0) {
      if (flow.queuedBytes + frame.byteLength > SOCKET_LIVE_QUEUE_LIMIT) {
        socket.close(1013, "Terminal client fell behind");
        return;
      }
      const copy = frame.slice();
      flow.queue.push(copy);
      flow.queuedBytes += copy.byteLength;
      if (!flow.replay && !flow.backpressured) this.#pumpSocket(socket);
      return;
    }
    const result = socket.send(frame);
    if (result === -1) flow.backpressured = true;
    else if (result === 0) socket.close(1013, "Terminal client unavailable");
  }

  #pumpSocket(socket: Bun.ServerWebSocket<TerminalSocketData>): void {
    const flow = socket.data.flow;
    if (!flow || flow.backpressured) return;

    while (flow.replay && flow.replayOffset < flow.replay.byteLength) {
      const end = Math.min(flow.replay.byteLength, flow.replayOffset + SOCKET_REPLAY_CHUNK);
      const opcode = flow.replayOffset === 0 ? TerminalWire.snapshot : TerminalWire.output;
      const result = socket.send(wireFrame(opcode, flow.replay.subarray(flow.replayOffset, end)));
      flow.replayOffset = end;
      if (result === 0) {
        socket.close(1013, "Terminal replay failed");
        return;
      }
      if (result === -1) {
        flow.backpressured = true;
        return;
      }
    }
    flow.replay = null;

    while (flow.queue.length > 0) {
      const frame = flow.queue.shift()!;
      flow.queuedBytes -= frame.byteLength;
      const result = socket.send(frame);
      if (result === 0) {
        socket.close(1013, "Terminal output failed");
        return;
      }
      if (result === -1) {
        flow.backpressured = true;
        return;
      }
    }
  }

  #writeInput(session: TerminalSession, data: Uint8Array): boolean {
    if (session.inputQueue.length === 0) {
      const written = Math.min(data.byteLength, Math.max(0, session.terminal.write(data)));
      if (written >= data.byteLength) return true;
      data = data.subarray(written);
    }
    if (session.inputBytes + data.byteLength > TERMINAL_INPUT_QUEUE_LIMIT) return false;
    const copy = data.slice();
    session.inputQueue.push(copy);
    session.inputBytes += copy.byteLength;
    return true;
  }

  #drainInput(session: TerminalSession | undefined): void {
    if (!session) return;
    while (session.inputQueue.length > 0) {
      const data = session.inputQueue[0]!;
      const written = Math.min(data.byteLength, Math.max(0, session.terminal.write(data)));
      if (written === 0) return;
      session.inputBytes -= written;
      if (written < data.byteLength) {
        session.inputQueue[0] = data.subarray(written);
        return;
      }
      session.inputQueue.shift();
    }
  }

  #evictExited(projectId: string): void {
    const exited = [...this.#sessions.values()]
      .filter((session) => session.projectId === projectId && session.state === "exited")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (exited.length >= this.#config.terminal.maxSessionsPerProject) {
      const session = exited.shift()!;
      for (const socket of session.clients.values()) socket.close(1000, "Session history evicted");
      if (!session.terminal.closed) session.terminal.close();
      this.#sessions.delete(session.id);
      for (const [ticket, record] of this.#tickets) {
        if (record.terminalSessionId === session.id) this.#tickets.delete(ticket);
      }
    }
  }
}

function processEnv(): Record<string, string | undefined> {
  return { ...process.env };
}
