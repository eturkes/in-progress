import { afterEach, describe, expect, test } from "bun:test";
import { configForTests } from "../src/server/config";
import { NotificationService } from "../src/server/notifications";
import { ProjectRegistry } from "../src/server/projects";
import { StateStore } from "../src/server/store";
import { TerminalManager, type TerminalSocketData } from "../src/server/terminal";
import { TerminalWire, wireFrame } from "../src/shared/terminal-wire";
import { removeDirectory, tempDirectory } from "./helpers";

const roots: string[] = [];

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
    );
    try {
      const session = manager.create("fixture");
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
      const command = new TextEncoder().encode("set -o | command grep '^monitor'\n");
      manager.message(socket, Buffer.from(wireFrame(TerminalWire.input, command)));

      let output = "";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        output = new TextDecoder().decode(
          Buffer.concat(
            frames
              .filter(
                (frame) => frame[0] === TerminalWire.snapshot || frame[0] === TerminalWire.output,
              )
              .map((frame) => frame.subarray(1)),
          ),
        );
        if (/^monitor\s+(?:on|off)$/m.test(output)) break;
        await Bun.sleep(25);
      }

      expect(output).not.toContain("no job control");
      expect(output).toMatch(/^monitor\s+on$/m);
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
    );
    try {
      const session = manager.create("fixture");
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

      const stopped = manager.create("fixture");
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
});
