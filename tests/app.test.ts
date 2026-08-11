import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createControlPlane } from "../src/server/app";
import { configForTests } from "../src/server/config";
import { removeDirectory, tempDirectory, writeJson } from "./helpers";

let app: ReturnType<typeof createControlPlane>;
let root: string;
let origin: string;
let cookie: string;
let csrfToken: string;

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
  app = createControlPlane(config, { memoryStore: true, port: 0 });
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
      { memoryStore: true, port: 0 },
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
