import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createControlPlane } from "../src/server/app";
import { configForTests } from "../src/server/config";
import { removeDirectory, tempDirectory, writeJson } from "./helpers";

let app: ReturnType<typeof createControlPlane>;
let root: string;
let origin: string;
let cookie: string;
let csrfToken: string;

function testAppOptions(directory: string) {
  return {
    memoryStore: true,
    port: 0,
    terminal: { terminateOnClose: true, zmxDirectory: join(directory, "zmx") },
  };
}

beforeAll(async () => {
  root = tempDirectory("app");
  const config = configForTests(root, {
    integrations: {
      treeComplete: { sourceDirectory: root, mode: "preview" },
    },
    terminal: {
      shell: "/bin/sh",
      shellArgs: ["-c", "cat"],
      scrollbackBytes: 64 * 1024,
      maxSessionsPerProject: 2,
    },
  });
  app = createControlPlane(config, testAppOptions(root));
  origin = app.server.url.origin;
  const bootstrap = await fetch(`${origin}/api/bootstrap`);
  const body = (await bootstrap.json()) as { csrfToken: string };
  csrfToken = body.csrfToken;
  cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
});

afterAll(async () => {
  await app.close();
  removeDirectory(root);
});

function mutationHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    cookie,
    origin,
    "sec-fetch-site": "same-origin",
    "x-in-progress-csrf": csrfToken,
    ...overrides,
  };
}

describe("HTTP bootstrap and terminal authorization", () => {
  test("bootstrap creates a no-store session and advertises the built-in terminal", async () => {
    const response = await fetch(`${origin}/api/bootstrap`, { headers: { cookie } });
    const body = (await response.json()) as {
      apiVersion: number;
      csrfToken: string;
      identity: string;
      projects: { id: string }[];
      plugins: { id: string; kind: string }[];
      authority: { treeCompleteMode: string | null };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      apiVersion: 1,
      csrfToken,
      identity: "local",
      authority: { treeCompleteMode: "preview" },
    });
    expect(body.projects).toEqual([expect.objectContaining({ id: "fixture" })]);
    expect(body.plugins).toEqual([expect.objectContaining({ id: "terminal", kind: "host" })]);
  });

  test("rejects missing or cross-origin CSRF credentials", async () => {
    const missing = await fetch(`${origin}/api/projects/fixture/sessions`, { method: "POST" });
    const crossOrigin = await fetch(`${origin}/api/projects/fixture/sessions`, {
      headers: mutationHeaders({ origin: "https://evil.example" }),
      method: "POST",
    });
    const wrongToken = await fetch(`${origin}/api/projects/fixture/sessions`, {
      headers: mutationHeaders({ "x-in-progress-csrf": "wrong" }),
      method: "POST",
    });

    expect(missing.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(wrongToken.status).toBe(403);
  });

  test("requires bootstrap before authenticated read endpoints", async () => {
    const response = await fetch(`${origin}/api/events`);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("requires a live session for plugin documents while leaving declared module assets loadable", async () => {
    const pluginFixture = tempDirectory("plugin-document-auth");
    const pluginRoot = join(pluginFixture, "plugin");
    mkdirSync(pluginRoot);
    writeFileSync(join(pluginRoot, "index.html"), "<!doctype html><p>private dashboard</p>\n");
    writeFileSync(join(pluginRoot, "app.js"), "export const ready = true;\n");
    writeJson(join(pluginRoot, "in-progress.plugin.json"), {
      apiVersion: "1.0",
      id: "fixture-plugin",
      name: "Fixture plugin",
      version: "1.0.0",
      description: "Session boundary fixture",
      entry: "index.html",
      assets: ["app.js"],
      capabilities: [],
    });
    const guarded = createControlPlane(
      configForTests(pluginFixture, { pluginDirectories: [pluginRoot] }),
      testAppOptions(pluginFixture),
    );
    const guardedOrigin = guarded.server.url.origin;
    try {
      const unauthenticated = await fetch(`${guardedOrigin}/plugins/fixture-plugin/`);
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.text()).not.toContain("private dashboard");

      const bootstrap = await fetch(`${guardedOrigin}/api/bootstrap`);
      const session = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
      const document = await fetch(`${guardedOrigin}/plugins/fixture-plugin/`, {
        headers: { cookie: session },
      });
      expect(document.status).toBe(200);
      expect(await document.text()).toContain("private dashboard");
      expect(document.headers.get("access-control-allow-origin")).toBeNull();
      expect(document.headers.get("cache-control")).toBe("private, no-store");
      expect(document.headers.get("content-security-policy")).toContain("sandbox allow-scripts");

      const asset = await fetch(`${guardedOrigin}/plugins/fixture-plugin/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await guarded.close();
      removeDirectory(pluginFixture);
    }
  });

  test("binds Preview generation to the selected project and same-origin CSRF session", async () => {
    const fixture = tempDirectory("preview-route");
    const project = join(fixture, "project");
    const source = join(fixture, "preview");
    const artifacts = join(fixture, "artifacts");
    const executable = join(source, "bin/preview");
    const codex = join(fixture, "codex");
    mkdirSync(project);
    mkdirSync(join(source, "bin"), { recursive: true });
    mkdirSync(artifacts);
    writeFileSync(codex, "#!/bin/sh\nexit 0\n");
    chmodSync(codex, 0o755);
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        'if [ "$1" = plugin-build ]; then',
        "  shift; artifact=",
        '  while [ "$#" -gt 0 ]; do',
        '    if [ "$1" = --artifact-root ]; then artifact=$2; shift 2; else shift; fi',
        "  done",
        '  mkdir -p "$artifact/in-progress-plugin"',
        '  printf \'%s\\n\' \'{"schemaVersion":1,"projects":["fixture"]}\' > "$artifact/in-progress-plugin/preview-index.json"',
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    const guarded = createControlPlane(
      configForTests(fixture, {
        projects: [
          {
            id: "fixture",
            name: "Fixture",
            path: project,
            displayPath: project,
            color: "#67d5b5",
          },
        ],
        integrations: {
          preview: {
            sourceDirectory: source,
            executable,
            artifactDirectory: artifacts,
            codexExecutable: codex,
          },
        },
      }),
      testAppOptions(fixture),
    );
    const guardedOrigin = guarded.server.url.origin;
    try {
      const bootstrap = await fetch(`${guardedOrigin}/api/bootstrap`);
      const body = (await bootstrap.json()) as { csrfToken: string };
      const session = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
      const headers = {
        cookie: session,
        origin: guardedOrigin,
        "sec-fetch-site": "same-origin",
        "x-in-progress-csrf": body.csrfToken,
      };

      const initial = await fetch(`${guardedOrigin}/api/projects/fixture/preview`, {
        headers: { cookie: session },
      });
      expect(await initial.json()).toMatchObject({ status: { dashboard: false, state: "idle" } });
      expect(
        (await fetch(`${guardedOrigin}/api/projects/fixture/preview`, { method: "POST" })).status,
      ).toBe(403);
      const started = await fetch(`${guardedOrigin}/api/projects/fixture/preview`, {
        headers,
        method: "POST",
      });
      expect(started.status).toBe(202);
      expect(await started.json()).toMatchObject({ status: { state: "generating" } });

      let status: { dashboard: boolean; state: string } | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await fetch(`${guardedOrigin}/api/projects/fixture/preview`, {
          headers: { cookie: session },
        });
        status = ((await response.json()) as { status: { dashboard: boolean; state: string } })
          .status;
        if (status?.state !== "generating") break;
        await Bun.sleep(10);
      }
      expect(status).toMatchObject({ dashboard: true, state: "idle" });
    } finally {
      await guarded.close();
      removeDirectory(fixture);
    }
  });

  test("bounds the shared agent notification hook", async () => {
    const responses = await Promise.all(
      Array.from({ length: 61 }, (_, index) =>
        fetch(`${origin}/api/hooks/notify`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${app.notifications.hookToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            projectId: "fixture",
            kind: "system",
            title: `Hook ${index}`,
            body: "",
            url: "/",
          }),
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(60);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });

  test("creates a real PTY session and issues a one-use browser-session-bound ticket", async () => {
    const create = await fetch(`${origin}/api/projects/fixture/sessions`, {
      headers: mutationHeaders(),
      method: "POST",
    });
    const created = (await create.json()) as {
      session: { id: string; projectId: string; state: string };
    };
    expect(create.status).toBe(201);
    expect(created.session).toMatchObject({ projectId: "fixture", state: "running" });

    const ticketResponse = await fetch(
      `${origin}/api/projects/fixture/sessions/${created.session.id}/ticket`,
      { headers: mutationHeaders(), method: "POST" },
    );
    const ticket = (await ticketResponse.json()) as { ticket: string; expiresAt: string };
    expect(ticketResponse.status).toBe(201);
    expect(ticket.ticket.length).toBeGreaterThan(32);
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());

    const record = app.terminals.consumeTicket(ticket.ticket);
    expect(record).toMatchObject({ projectId: "fixture", terminalSessionId: created.session.id });
    expect(() => app.terminals.consumeTicket(ticket.ticket)).toThrow(
      "Terminal ticket invalid or expired",
    );

    const terminate = await fetch(`${origin}/api/projects/fixture/sessions/${created.session.id}`, {
      headers: mutationHeaders(),
      method: "DELETE",
    });
    expect(terminate.status).toBe(204);
  });
});
