import { accessSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { NotificationEventInput, TerminalSessionDto } from "../shared/contracts";
import { TerminalWire, wireFrame } from "../shared/terminal-wire";
import type { InProgressConfig, ProjectConfig } from "./config";
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

export interface TerminalManagerOptions {
  environment?: Record<string, string | undefined>;
  terminateOnClose?: boolean;
  zmxDirectory?: string;
  zmxExecutable?: string;
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
  ordinal: number;
  createdAt: string;
  zmxName: string;
  terminal?: Bun.Terminal;
  process?: Bun.Subprocess;
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
  initializing: boolean;
  bridgeStartedAt: number;
  rapidBridgeFailures: number;
}

interface ZmxSessionEntry {
  name: string;
  createdAt: string;
  startDirectory?: string;
}

interface OwnedZmxSession {
  id: string;
  ordinal: number;
  project: ProjectConfig;
}

const SOCKET_REPLAY_CHUNK = 32 * 1024;
const SOCKET_LIVE_QUEUE_LIMIT = 512 * 1024;
const TERMINAL_INPUT_QUEUE_LIMIT = 256 * 1024;
const TERMINAL_WRAPPER = resolve(import.meta.dir, "../../bin/in-progress-terminal-session");

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function projectToken(configPath: string, projectId: string): string {
  return `${projectId.slice(0, 8)}-${digest(`${configPath}\0${projectId}`, 16)}`;
}

function zmxEnvironment(
  source: Record<string, string | undefined>,
  directory?: string,
): Record<string, string | undefined> {
  const environment = { ...source };
  // These identify the launcher's zmx context. zmx attach interprets an inherited
  // ZMX_SESSION as a request to switch that session instead of attaching ours.
  delete environment.ZMX_SESSION;
  delete environment.ZMX_SESSION_PREFIX;
  if (directory) environment.ZMX_DIR = directory;
  return environment;
}

function parseZmxSessions(raw: string): ZmxSessionEntry[] {
  const sessions: ZmxSessionEntry[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/^(?:→ | {2})/, "");
    const fields = new Map<string, string>();
    for (const field of line.split("\t")) {
      const separator = field.indexOf("=");
      if (separator > 0) fields.set(field.slice(0, separator), field.slice(separator + 1));
    }
    const name = fields.get("name");
    const created = Number(fields.get("created"));
    if (!name || !Number.isSafeInteger(created) || created <= 0 || fields.has("err")) continue;
    const createdDate = new Date(created * 1_000);
    if (Number.isNaN(createdDate.getTime())) continue;
    sessions.push({
      name,
      createdAt: createdDate.toISOString(),
      ...(fields.has("start_dir") ? { startDirectory: fields.get("start_dir") } : {}),
    });
  }
  return sessions.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.name.localeCompare(right.name),
  );
}

function backgroundDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref();
  });
}

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
  readonly #environment: Record<string, string | undefined>;
  readonly #instanceId: string;
  readonly #instancePrefix: string;
  readonly #terminateOnClose: boolean;
  readonly #zmxExecutable: string;
  #closing = false;
  #serverPort: number;

  constructor(
    config: InProgressConfig,
    projects: ProjectRegistry,
    notifications: NotificationService,
    options: TerminalManagerOptions = {},
  ) {
    this.#config = config;
    this.#projects = projects;
    this.#notifications = notifications;
    this.#environment = zmxEnvironment(options.environment ?? processEnv(), options.zmxDirectory);
    this.#instanceId = digest(config.configPath, 16);
    this.#instancePrefix = "in-progress-";
    this.#terminateOnClose = options.terminateOnClose ?? false;
    this.#zmxExecutable = options.zmxExecutable ?? Bun.which("zmx") ?? "";
    this.#serverPort = config.server.port;
    this.#assertRuntime();
    this.#recover();
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

  async create(projectId: string): Promise<TerminalSessionDto> {
    const project = this.#projects.get(projectId);
    this.#evictExited(projectId);
    const projectSessions = this.list(projectId);
    if (
      projectSessions.filter((session) => session.state === "running").length >=
      this.#config.terminal.maxSessionsPerProject
    ) {
      throw new HttpError(409, "Project session limit reached");
    }

    let id: string;
    do id = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex");
    while (this.#sessions.has(id));
    const ordinal =
      Math.max(
        0,
        ...[...this.#sessions.values()]
          .filter((candidate) => candidate.projectId === projectId)
          .map((candidate) => candidate.ordinal),
      ) + 1;
    const zmxName = `${this.#instancePrefix}${projectToken(
      this.#config.configPath,
      project.id,
    )}-s${ordinal}-${id}`;
    const session = this.#spawn(project, id, ordinal, new Date().toISOString(), zmxName, true);
    this.#sessions.set(id, session);
    try {
      await this.#awaitReady(session);
    } catch (error) {
      this.#sessions.delete(id);
      session.terminationRequested = true;
      this.#zmx("kill", session.zmxName, "--force");
      session.process?.kill("SIGTERM");
      session.terminal?.close();
      throw error;
    }
    return sessionDto(session);
  }

  terminate(projectId: string, sessionId: string): void {
    const session = this.get(projectId, sessionId);
    if (session.state === "running") {
      session.terminationRequested = true;
      const result = this.#zmx("kill", session.zmxName);
      if (!result.success) {
        session.terminationRequested = false;
        throw new HttpError(502, "zmx could not stop the terminal session");
      }
    }
    session.terminal?.close();
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
        session.terminal?.resize(cols, rows);
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
      if (session.state === "running") {
        if (this.#terminateOnClose) {
          session.terminationRequested = true;
          const result = this.#zmx("kill", session.zmxName);
          if (!result.success) console.warn(`Could not stop zmx session ${session.zmxName}`);
        } else {
          session.process?.kill("SIGTERM");
        }
      }
      session.terminal?.close();
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
    // oxlint-disable-next-line no-control-regex -- private OSC status is ESC/BEL-delimited.
    const exitPattern = /\x1b\]777;in-progress-exit;([0-9a-f]{16});([0-9]{1,3})\x07/g;
    for (const match of session.oscTail.matchAll(exitPattern)) {
      const exitCode = Number(match[2]);
      if (match[1] === session.id && exitCode >= 0 && exitCode <= 255) {
        session.exitCode = exitCode;
      }
    }
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

  async #onClientExit(
    session: TerminalSession,
    child: Bun.Subprocess,
    exitCode: number | null,
    signal?: number | string,
  ): Promise<void> {
    if (session.process !== child || session.state === "exited") return;
    session.process = undefined;
    if (session.terminal && !session.terminal.closed) session.terminal.close();
    session.terminal = undefined;

    session.rapidBridgeFailures =
      Date.now() - session.bridgeStartedAt >= 1_000 ? 0 : session.rapidBridgeFailures + 1;
    while (
      !this.#closing &&
      !session.terminationRequested &&
      this.#zmxSessionExists(session.zmxName)
    ) {
      const delay =
        session.rapidBridgeFailures <= 3
          ? session.rapidBridgeFailures * 25
          : Math.min(1_000, 100 * 2 ** (session.rapidBridgeFailures - 4));
      if (delay > 0) await backgroundDelay(delay);
      if (
        this.#closing ||
        session.terminationRequested ||
        !this.#zmxSessionExists(session.zmxName)
      ) {
        break;
      }
      try {
        this.#attachZmxClient(session, this.#projects.get(session.projectId), false);
        this.#drainInput(session);
        return;
      } catch {
        session.rapidBridgeFailures += 1;
      }
    }

    session.state = "exited";
    if (
      !session.terminationRequested &&
      session.exitCode === undefined &&
      exitCode !== null &&
      exitCode !== 0
    ) {
      session.exitCode = exitCode;
    }
    session.writerId = null;
    if (this.#closing || session.initializing) return;
    this.#broadcastStatus(session);
    const input: NotificationEventInput = {
      projectId: session.projectId,
      kind: session.terminationRequested
        ? "system"
        : session.exitCode === 0
          ? "completed"
          : "failed",
      title: session.terminationRequested ? `${session.title} stopped` : `${session.title} exited`,
      body: signal ? `Signal ${signal}` : `Exit code ${session.exitCode ?? "unknown"}`,
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
    const terminal = session.terminal;
    if (terminal && session.inputQueue.length === 0) {
      const written = Math.min(data.byteLength, Math.max(0, terminal.write(data)));
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
    const terminal = session?.terminal;
    if (!session || !terminal) return;
    while (session.inputQueue.length > 0) {
      const data = session.inputQueue[0]!;
      const written = Math.min(data.byteLength, Math.max(0, terminal.write(data)));
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
      if (session.terminal && !session.terminal.closed) session.terminal.close();
      this.#sessions.delete(session.id);
      for (const [ticket, record] of this.#tickets) {
        if (record.terminalSessionId === session.id) this.#tickets.delete(ticket);
      }
    }
  }

  #assertRuntime(): void {
    if (!this.#zmxExecutable) throw new Error("Terminal sessions require zmx 0.7.0 or newer");
    try {
      accessSync(TERMINAL_WRAPPER, constants.X_OK);
    } catch {
      throw new Error(`Terminal session wrapper is not executable: ${TERMINAL_WRAPPER}`);
    }
    const result = this.#zmx("version");
    const match = /^zmx\s+(\d+)\.(\d+)\.(\d+)/m.exec(result.stdout);
    if (!result.success || !match || (Number(match[1]) === 0 && Number(match[2]) < 7)) {
      throw new Error("Terminal sessions require zmx 0.7.0 or newer");
    }
  }

  #recover(): void {
    const result = this.#zmx("list");
    if (!result.success) throw new Error(`Could not list zmx sessions: ${result.stderr}`);
    for (const entry of parseZmxSessions(result.stdout)) {
      const metadata = this.#ownedSession(entry.name);
      if (!metadata) continue;
      if (entry.startDirectory && entry.startDirectory !== metadata.project.path) {
        console.warn(`Ignoring zmx session with stale project root: ${entry.name}`);
        continue;
      }
      if (this.#sessions.has(metadata.id)) {
        console.warn(`Ignoring duplicate zmx terminal ID: ${entry.name}`);
        continue;
      }
      const session = this.#spawn(
        metadata.project,
        metadata.id,
        metadata.ordinal,
        entry.createdAt,
        entry.name,
        false,
      );
      this.#sessions.set(session.id, session);
      this.#labelSession(session);
    }
  }

  #ownedSession(name: string): OwnedZmxSession | undefined {
    if (!name.startsWith(this.#instancePrefix)) return undefined;
    for (const project of this.#config.projects) {
      const prefix = `${this.#instancePrefix}${projectToken(
        this.#config.configPath,
        project.id,
      )}-s`;
      if (!name.startsWith(prefix)) continue;
      const match = /^([1-9][0-9]*)-([0-9a-f]{16})$/.exec(name.slice(prefix.length));
      if (!match) return undefined;
      const ordinal = Number(match[1]);
      if (!Number.isSafeInteger(ordinal)) return undefined;
      return { id: match[2]!, ordinal, project };
    }
    return undefined;
  }

  #spawn(
    project: ProjectConfig,
    id: string,
    ordinal: number,
    createdAt: string,
    zmxName: string,
    create: boolean,
  ): TerminalSession {
    const session: TerminalSession = {
      id,
      projectId: project.id,
      title: `Shell ${ordinal}`,
      ordinal,
      createdAt,
      zmxName,
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
      initializing: create,
      bridgeStartedAt: 0,
      rapidBridgeFailures: 0,
    };
    this.#attachZmxClient(session, project, create);
    return session;
  }

  #attachZmxClient(session: TerminalSession, project: ProjectConfig, create: boolean): void {
    const command = [
      this.#zmxExecutable,
      "attach",
      session.zmxName,
      ...(create
        ? [TERMINAL_WRAPPER, this.#config.terminal.shell, ...this.#config.terminal.shellArgs]
        : []),
    ];
    let child!: Bun.Subprocess;
    try {
      child = Bun.spawn(command, {
        cwd: project.path,
        env: this.#terminalEnvironment(project, session.id),
        // Bun owns the browser-facing PTY; zmx owns the durable inner PTY.
        terminal: {
          cols: 100,
          rows: 30,
          name: "xterm-256color",
          data: (_terminal, data) => this.#onOutput(session, data),
          drain: () => this.#drainInput(session),
        },
        onExit: (_process, exitCode, signalCode, error) => {
          void this.#onClientExit(
            session,
            child,
            exitCode ?? (error ? 1 : null),
            signalCode ?? undefined,
          );
        },
      });
    } catch {
      throw new HttpError(503, "zmx terminal could not start");
    }
    const terminal = child.terminal;
    if (!terminal) {
      child.kill("SIGTERM");
      throw new Error("Bun did not attach the requested pseudo-terminal");
    }
    session.process = child;
    session.terminal = terminal;
    session.bridgeStartedAt = Date.now();
  }

  #terminalEnvironment(project: ProjectConfig, id: string): Record<string, string | undefined> {
    const configuredHost = this.#config.server.host;
    const notifyHost =
      configuredHost === "::1"
        ? "[::1]"
        : configuredHost === "0.0.0.0"
          ? "127.0.0.1"
          : configuredHost;
    const environment: Record<string, string | undefined> = {
      ...this.#environment,
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
      PWD: project.path,
      IN_PROGRESS_NOTIFY_URL: `http://${notifyHost}:${this.#serverPort}/api/hooks/notify`,
      IN_PROGRESS_NOTIFY_TOKEN: this.#notifications.hookToken,
      IN_PROGRESS_PROJECT_ID: project.id,
      IN_PROGRESS_TERMINAL_SESSION_ID: id,
      PATH: `${join(this.#config.rootDir, "bin")}:${this.#environment.PATH ?? ""}`,
    };
    delete environment.OLDPWD;
    return environment;
  }

  async #awaitReady(session: TerminalSession): Promise<void> {
    let stderr = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = this.#zmx("list", "--short");
      if (result.success && result.stdout.split("\n").includes(session.zmxName)) {
        this.#labelSession(session);
        if (session.state !== "running") break;
        session.initializing = false;
        return;
      }
      stderr = result.stderr;
      if (session.state === "exited") break;
      await Bun.sleep(10);
    }
    throw new HttpError(
      503,
      stderr ? `zmx terminal could not initialize: ${stderr}` : "zmx terminal could not initialize",
    );
  }

  #labelSession(session: TerminalSession): void {
    const result = this.#zmx(
      "set",
      session.zmxName,
      "owner=in-progress",
      `instance=${this.#instanceId}`,
      `project=${session.projectId}`,
      `terminal=${session.id}`,
    );
    if (!result.success) console.warn(`Could not label zmx session ${session.zmxName}`);
  }

  #zmx(...args: string[]): { success: boolean; stdout: string; stderr: string } {
    if (!this.#zmxExecutable) return { success: false, stdout: "", stderr: "zmx not found" };
    try {
      const result = Bun.spawnSync([this.#zmxExecutable, ...args], {
        cwd: this.#config.rootDir,
        env: this.#environment,
        stderr: "pipe",
        stdout: "pipe",
      });
      return {
        success: result.success,
        stdout: result.stdout.toString().trim(),
        stderr: result.stderr.toString().trim(),
      };
    } catch (error) {
      return {
        success: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : "zmx command failed",
      };
    }
  }

  #zmxSessionExists(name: string): boolean {
    const result = this.#zmx("list", "--short");
    return result.success && result.stdout.split("\n").includes(name);
  }
}

function processEnv(): Record<string, string | undefined> {
  return { ...process.env };
}
