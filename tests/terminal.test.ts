import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { configForTests } from "../src/server/config";
import { NotificationService } from "../src/server/notifications";
import { ProjectRegistry } from "../src/server/projects";
import { StateStore } from "../src/server/store";
import { TerminalManager, type TerminalSocketData } from "../src/server/terminal";
import { TerminalWire, wireFrame } from "../src/shared/terminal-wire";
import { removeDirectory, tempDirectory } from "./helpers";

const roots: string[] = [];
const detectedZmxExecutable = Bun.which("zmx");

if (!detectedZmxExecutable) throw new Error("Terminal tests require zmx 0.7.0 or newer");
const zmxExecutable: string = detectedZmxExecutable;

function managerOptions(root: string, terminateOnClose = true) {
  return {
    environment: {
      ...process.env,
      ZMX_SESSION: "launcher-session",
      ZMX_SESSION_PREFIX: "launcher-",
    },
    terminateOnClose,
    zmxDirectory: join(root, "zmx"),
    zmxExecutable,
  };
}

function terminalOutput(frames: Uint8Array[]): string {
  return new TextDecoder().decode(
    Buffer.concat(
      frames
        .filter((frame) => frame[0] === TerminalWire.snapshot || frame[0] === TerminalWire.output)
        .map((frame) => frame.subarray(1)),
    ),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) removeDirectory(root);
});

describe("TerminalManager", () => {
  test("spawns an interactive shell with a controlling terminal and job control", async () => {
    const root = tempDirectory("terminal");
    roots.push(root);
    const config = configForTests(root, {
      terminal: {
        shell: "/bin/bash",
        shellArgs: ["--noprofile", "--norc", "-i"],
        scrollbackBytes: 64 * 1024,
        maxSessionsPerProject: 2,
      },
    });
    const store = new StateStore(config.dataDir, true);
    const notifications = new NotificationService(store, config.notifications.vapidSubject);
    const manager = new TerminalManager(
      config,
      new ProjectRegistry(config.projects),
      notifications,
      managerOptions(root),
    );
    try {
      const session = await manager.create("fixture");
      const frames: Uint8Array[] = [];
      const socket = {
        data: {
          kind: "terminal",
          projectId: "fixture",
          terminalSessionId: session.id,
          connectionId: "fixture-client",
        },
        send(frame: Uint8Array) {
          frames.push(frame.slice());
          return frame.byteLength;
        },
        close() {},
      } as unknown as Bun.ServerWebSocket<TerminalSocketData>;

      manager.attach(socket);
      const command = new TextEncoder().encode(
        "set -o | command grep '^monitor'; printf '__zmx=%s__ __prefix=%s__\\n' \"$ZMX_SESSION\" \"${ZMX_SESSION_PREFIX-unset}\"\n",
      );
      manager.message(socket, Buffer.from(wireFrame(TerminalWire.input, command)));

      let output = "";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        output = terminalOutput(frames);
        if (/^monitor\s+(?:on|off)$/m.test(output)) break;
        await Bun.sleep(25);
      }

      expect(output).not.toContain("no job control");
      expect(output).toMatch(/^monitor\s+on$/m);
      expect(output).toMatch(/__zmx=in-progress-fixture-[0-9a-f]{16}-s1-[0-9a-f]{16}__/);
      expect(output).not.toContain("__zmx=launcher-session__");
      expect(output).toContain("__prefix=unset__");
    } finally {
      manager.close();
      store.close();
    }
  });

  test("keeps final output ahead of exit status and classifies requested signals", async () => {
    const root = tempDirectory("terminal-exit");
    roots.push(root);
    const config = configForTests(root, {
      terminal: {
        shell: "/bin/bash",
        shellArgs: ["--noprofile", "--norc", "-i"],
        scrollbackBytes: 64 * 1024,
        maxSessionsPerProject: 2,
      },
    });
    const store = new StateStore(config.dataDir, true);
    const notifications = new NotificationService(store, config.notifications.vapidSubject);
    const manager = new TerminalManager(
      config,
      new ProjectRegistry(config.projects),
      notifications,
      managerOptions(root),
    );
    try {
      const session = await manager.create("fixture");
      const frames: Uint8Array[] = [];
      let backpressureFirstSend = true;
      const socket = {
        data: {
          kind: "terminal",
          projectId: "fixture",
          terminalSessionId: session.id,
          connectionId: "ordered-client",
        },
        send(frame: Uint8Array) {
          frames.push(frame.slice());
          if (backpressureFirstSend) {
            backpressureFirstSend = false;
            return -1;
          }
          return frame.byteLength;
        },
        close() {},
      } as unknown as Bun.ServerWebSocket<TerminalSocketData>;

      manager.attach(socket);
      manager.message(
        socket,
        Buffer.from(
          wireFrame(
            TerminalWire.input,
            new TextEncoder().encode("printf '__in-progress_tail__\\n'; exit 7\n"),
          ),
        ),
      );
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (manager.list("fixture")[0]?.state === "exited") break;
        await Bun.sleep(25);
      }
      manager.drain(socket);

      const tailIndex = frames.findIndex(
        (frame) =>
          frame[0] === TerminalWire.output &&
          new TextDecoder().decode(frame.subarray(1)).includes("__in-progress_tail__"),
      );
      const exitedStatusIndex = frames.findIndex((frame) => {
        if (frame[0] !== TerminalWire.status) return false;
        return (
          (
            JSON.parse(new TextDecoder().decode(frame.subarray(1))) as {
              session: { state: string };
            }
          ).session.state === "exited"
        );
      });
      expect(tailIndex).toBeGreaterThanOrEqual(0);
      expect(exitedStatusIndex).toBeGreaterThan(tailIndex);
      expect(manager.list("fixture")[0]).toMatchObject({ state: "exited", exitCode: 7 });
      expect(store.events(10)[0]).toMatchObject({ kind: "failed", title: "Shell 1 exited" });

      const stopped = await manager.create("fixture");
      manager.terminate("fixture", stopped.id);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (manager.list("fixture").find((item) => item.id === stopped.id)?.state === "exited")
          break;
        await Bun.sleep(25);
      }
      const stoppedSession = manager.list("fixture").find((item) => item.id === stopped.id);
      expect(stoppedSession).toMatchObject({ state: "exited" });
      expect(stoppedSession?.exitCode).toBeUndefined();
      expect(store.events(10)[0]).toMatchObject({ kind: "system", title: "Shell 2 stopped" });
    } finally {
      manager.close();
      store.close();
    }
  });

  test("recovers its named zmx session after a manager restart", async () => {
    const root = tempDirectory("terminal-recovery");
    roots.push(root);
    const config = configForTests(root, {
      terminal: {
        shell: "/bin/bash",
        shellArgs: ["--noprofile", "--norc", "-i"],
        scrollbackBytes: 64 * 1024,
        maxSessionsPerProject: 2,
      },
    });
    const store = new StateStore(config.dataDir, true);
    const notifications = new NotificationService(store, config.notifications.vapidSubject);
    const projects = new ProjectRegistry(config.projects);
    const first = new TerminalManager(config, projects, notifications, managerOptions(root, false));
    let second: TerminalManager | undefined;
    try {
      const created = await first.create("fixture");
      const firstFrames: Uint8Array[] = [];
      const firstSocket = {
        data: {
          kind: "terminal",
          projectId: "fixture",
          terminalSessionId: created.id,
          connectionId: "before-restart",
        },
        send(frame: Uint8Array) {
          firstFrames.push(frame.slice());
          return frame.byteLength;
        },
        close() {},
      } as unknown as Bun.ServerWebSocket<TerminalSocketData>;
      first.attach(firstSocket);
      first.message(
        firstSocket,
        Buffer.from(
          wireFrame(
            TerminalWire.input,
            new TextEncoder().encode("printf '__before_restart__\\n'\n"),
          ),
        ),
      );
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (terminalOutput(firstFrames).includes("__before_restart__")) break;
        await Bun.sleep(25);
      }
      expect(terminalOutput(firstFrames)).toContain("__before_restart__");

      first.close();
      second = new TerminalManager(config, projects, notifications, managerOptions(root));
      expect(second.list("fixture")).toEqual([
        expect.objectContaining({ id: created.id, projectId: "fixture", state: "running" }),
      ]);

      const recoveredFrames: Uint8Array[] = [];
      const recoveredSocket = {
        data: {
          kind: "terminal",
          projectId: "fixture",
          terminalSessionId: created.id,
          connectionId: "after-restart",
        },
        send(frame: Uint8Array) {
          recoveredFrames.push(frame.slice());
          return frame.byteLength;
        },
        close() {},
      } as unknown as Bun.ServerWebSocket<TerminalSocketData>;
      second.attach(recoveredSocket);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (terminalOutput(recoveredFrames).includes("__before_restart__")) break;
        await Bun.sleep(25);
      }
      expect(terminalOutput(recoveredFrames)).toContain("__before_restart__");

      second.message(
        recoveredSocket,
        Buffer.from(
          wireFrame(
            TerminalWire.input,
            new TextEncoder().encode("printf '__after_restart__\\n'\n"),
          ),
        ),
      );
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (terminalOutput(recoveredFrames).includes("__after_restart__")) break;
        await Bun.sleep(25);
      }
      expect(terminalOutput(recoveredFrames)).toContain("__after_restart__");
      second.terminate("fixture", created.id);
    } finally {
      first.close();
      second?.close();
      store.close();
    }
  });

  test("reattaches its bridge when zmx detaches the client", async () => {
    const root = tempDirectory("terminal-reattach");
    roots.push(root);
    const config = configForTests(root, {
      terminal: {
        shell: "/bin/bash",
        shellArgs: ["--noprofile", "--norc", "-i"],
        scrollbackBytes: 64 * 1024,
        maxSessionsPerProject: 2,
      },
    });
    const store = new StateStore(config.dataDir, true);
    const notifications = new NotificationService(store, config.notifications.vapidSubject);
    const manager = new TerminalManager(
      config,
      new ProjectRegistry(config.projects),
      notifications,
      managerOptions(root),
    );
    try {
      const session = await manager.create("fixture");
      const frames: Uint8Array[] = [];
      const socket = {
        data: {
          kind: "terminal",
          projectId: "fixture",
          terminalSessionId: session.id,
          connectionId: "reattach-client",
        },
        send(frame: Uint8Array) {
          frames.push(frame.slice());
          return frame.byteLength;
        },
        close() {},
      } as unknown as Bun.ServerWebSocket<TerminalSocketData>;
      manager.attach(socket);

      manager.message(socket, Buffer.from(wireFrame(TerminalWire.input, Uint8Array.of(0x1c))));
      await Bun.sleep(100);
      manager.message(
        socket,
        Buffer.from(
          wireFrame(
            TerminalWire.input,
            new TextEncoder().encode("printf '__bridge_reattached__\\n'\n"),
          ),
        ),
      );
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (terminalOutput(frames).includes("__bridge_reattached__")) break;
        await Bun.sleep(25);
      }

      expect(terminalOutput(frames)).toContain("__bridge_reattached__");
      expect(manager.list("fixture")[0]).toMatchObject({ id: session.id, state: "running" });
      expect(store.events(10)).toEqual([]);
    } finally {
      manager.close();
      store.close();
    }
  });

  test("rejects zmx initialization failure without retaining a phantom session", async () => {
    const root = tempDirectory("terminal-init-failure");
    roots.push(root);
    const config = configForTests(root);
    const store = new StateStore(config.dataDir, true);
    const notifications = new NotificationService(store, config.notifications.vapidSubject);
    const manager = new TerminalManager(
      config,
      new ProjectRegistry(config.projects),
      notifications,
      {
        ...managerOptions(root),
        zmxDirectory: join(root, "socket-directory-that-leaves-no-room-for-a-session-name"),
      },
    );
    try {
      await expect(manager.create("fixture")).rejects.toThrow("zmx terminal could not initialize");
      expect(manager.list("fixture")).toEqual([]);
      expect(store.events(10)).toEqual([]);
    } finally {
      manager.close();
      store.close();
    }
  });
});
