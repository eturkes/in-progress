import { existsSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import {
  AlignSetupRequestSchema,
  NotificationEventInputSchema,
  PluginRpcRequestSchema,
  PreviewGenerationRequestSchema,
  PreviewSettingsRequestSchema,
  PushSubscriptionSchema,
  type BootstrapDto,
} from "../shared/contracts";
import type { InProgressConfig } from "./config";
import { IntegrationRegistry } from "./integrations";
import { NotificationService } from "./notifications";
import { PluginRegistry } from "./plugins";
import { PreviewService } from "./preview";
import { ProjectRegistry } from "./projects";
import {
  HttpError,
  requestOrigin,
  SecurityGate,
  secureDevelopmentHost,
  secureHeaders,
} from "./security";
import { StateStore } from "./store";
import { TerminalManager, type TerminalManagerOptions, type TerminalSocketData } from "./terminal";

interface AppOptions {
  memoryStore?: boolean;
  port?: number;
  terminal?: TerminalManagerOptions;
}

function api(data: unknown, init: ResponseInit = {}): Response {
  return secureHeaders(Response.json(data, init));
}

export function developmentProxyTarget(webProxy: string, requested: URL): URL {
  const target = new URL(webProxy);
  if (requested.pathname === "/sw.js") {
    target.pathname = "/dev-sw.js";
    target.search = "?dev-sw";
  } else {
    target.pathname = requested.pathname;
    target.search = requested.search;
  }
  return target;
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return api({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) {
    return api({ error: "Request validation failed", issues: error.issues }, { status: 400 });
  }
  console.error(error);
  return api({ error: "Internal server error" }, { status: 500 });
}

async function jsonBody(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new HttpError(413, "Request body too large");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new HttpError(413, "Request body too large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "Request body is not valid UTF-8");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Malformed JSON");
  }
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

export function createControlPlane(config: InProgressConfig, options: AppOptions = {}) {
  const store = new StateStore(config.dataDir, options.memoryStore);
  const notifications = new NotificationService(store, config.notifications.vapidSubject);
  const projects = new ProjectRegistry(config.projects);
  const preview = new PreviewService(config.integrations.preview, projects, store);
  const integrations = new IntegrationRegistry(config.integrations, projects, config.dataDir);
  const plugins = new PluginRegistry(config.pluginDirectories);
  const security = new SecurityGate(
    config.server.allowedOrigins,
    config.server.allowedTailscaleUsers,
  );
  const terminals = new TerminalManager(config, projects, notifications, options.terminal);
  const webRoot = resolve(config.rootDir, "dist/web");
  const webProxy = process.env.IN_PROGRESS_WEB_PROXY;
  let hookTimes: number[] = [];

  async function route(
    request: Request,
    bunServer: Bun.Server<TerminalSocketData>,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/healthz" && request.method === "GET") {
        return api({ ok: true, version: "0.1.0" });
      }

      if (
        pathname === "/api/terminal" &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        const offered = request.headers
          .get("sec-websocket-protocol")
          ?.split(",")
          .map((value) => value.trim());
        if (!offered?.includes("in-progress.terminal.v1")) {
          throw new HttpError(426, "Terminal WebSocket subprotocol required");
        }
        const ticketValue = url.searchParams.get("ticket") ?? "";
        const ticket = terminals.ticket(ticketValue);
        security.assertWebSocket(request, ticket.browserSessionId);
        const upgraded = bunServer.upgrade(request, {
          data: {
            kind: "terminal",
            projectId: ticket.projectId,
            terminalSessionId: ticket.terminalSessionId,
            connectionId: crypto.randomUUID(),
          },
          headers: { "Sec-WebSocket-Protocol": "in-progress.terminal.v1" },
        });
        if (upgraded) {
          terminals.consumeTicket(ticketValue);
          return undefined;
        }
        return api({ error: "WebSocket upgrade failed" }, { status: 400 });
      }

      if (pathname === "/api/bootstrap" && request.method === "GET") {
        const auth = security.session(request);
        const body: BootstrapDto = {
          apiVersion: 1,
          csrfToken: auth.csrfToken,
          identity: auth.identity,
          projects: await projects.dtos(),
          plugins: plugins.dtos(),
          authority: {
            treeCompleteMode: config.integrations.treeComplete?.mode ?? null,
          },
          notification: {
            available: true,
            publicKey: notifications.publicKey,
            subscriptionCount: store.subscriptionCount(),
          },
        };
        const response = api(body);
        if (auth.setCookie) response.headers.set("Set-Cookie", auth.setCookie);
        return response;
      }

      if (pathname === "/api/events" && request.method === "GET") {
        security.requireSession(request);
        return api({ events: store.events(100) });
      }

      if (pathname === "/api/events/stream" && request.method === "GET") {
        const auth = security.requireSession(request);
        bunServer.timeout(request, 0);
        let cleanup = () => {};
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(": connected\n\n"));
            const remove = notifications.onEvent((event, announce) => {
              controller.enqueue(
                encoder.encode(
                  `event: ${announce ? "in-progress" : "in-progress-update"}\ndata: ${JSON.stringify(event)}\n\n`,
                ),
              );
            });
            const heartbeat = setInterval(
              () => controller.enqueue(encoder.encode(": heartbeat\n\n")),
              20_000,
            );
            cleanup = () => {
              clearInterval(heartbeat);
              remove();
            };
            request.signal.addEventListener("abort", cleanup, { once: true });
          },
          cancel: () => cleanup(),
        });
        const response = secureHeaders(
          new Response(stream, {
            headers: {
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream; charset=utf-8",
              "X-Accel-Buffering": "no",
            },
          }),
        );
        if (auth.setCookie) response.headers.set("Set-Cookie", auth.setCookie);
        return response;
      }

      const markRead = /^\/api\/events\/([0-9a-f-]+)\/read$/.exec(pathname);
      if (markRead && request.method === "POST") {
        security.assertBrowserMutation(request);
        const event = store.markEventRead(markRead[1]!);
        if (!event) throw new HttpError(404, "Event not found");
        notifications.broadcastUpdate(event);
        return api({ event });
      }

      const sessionsRoute = /^\/api\/projects\/([a-z][a-z0-9-]+)\/sessions$/.exec(pathname);
      if (sessionsRoute && request.method === "GET") {
        security.requireSession(request);
        return api({ sessions: terminals.list(sessionsRoute[1]!) });
      }
      if (sessionsRoute && request.method === "POST") {
        security.assertBrowserMutation(request);
        return api({ session: await terminals.create(sessionsRoute[1]!) }, { status: 201 });
      }

      const alignmentRoute = /^\/api\/projects\/([a-z][a-z0-9-]+)\/alignment$/.exec(pathname);
      if (alignmentRoute && request.method === "GET") {
        security.requireSession(request);
        bunServer.timeout(request, 20);
        return api({
          status: await integrations.dispatch(alignmentRoute[1]!, "align.status", undefined),
        });
      }
      if (alignmentRoute && request.method === "POST") {
        security.assertBrowserMutation(request);
        bunServer.timeout(request, 100);
        const input = AlignSetupRequestSchema.parse(await jsonBody(request, 512 * 1024));
        return api(
          { status: await integrations.initializeAlign(alignmentRoute[1]!, input) },
          { status: 201 },
        );
      }

      const previewRoute = /^\/api\/projects\/([a-z][a-z0-9-]+)\/preview$/.exec(pathname);
      if (previewRoute && request.method === "GET") {
        security.requireSession(request);
        return api({ status: await preview.status(previewRoute[1]!) });
      }
      if (previewRoute && request.method === "POST") {
        security.assertBrowserMutation(request);
        const input = PreviewGenerationRequestSchema.parse(await jsonBody(request));
        return api({ status: await preview.start(previewRoute[1]!, input) }, { status: 202 });
      }
      if (previewRoute && request.method === "PUT") {
        security.assertBrowserMutation(request);
        const input = PreviewSettingsRequestSchema.parse(await jsonBody(request));
        return api({ status: await preview.configure(previewRoute[1]!, input) });
      }

      const sessionRoute = /^\/api\/projects\/([a-z][a-z0-9-]+)\/sessions\/([0-9a-f-]+)$/.exec(
        pathname,
      );
      if (sessionRoute && request.method === "DELETE") {
        security.assertBrowserMutation(request);
        terminals.terminate(sessionRoute[1]!, sessionRoute[2]!);
        return secureHeaders(new Response(null, { status: 204 }));
      }

      const ticketRoute =
        /^\/api\/projects\/([a-z][a-z0-9-]+)\/sessions\/([0-9a-f-]+)\/ticket$/.exec(pathname);
      if (ticketRoute && request.method === "POST") {
        const auth = security.assertBrowserMutation(request);
        return api(terminals.issueTicket(ticketRoute[1]!, ticketRoute[2]!, auth.sessionId), {
          status: 201,
        });
      }

      const rpcRoute = /^\/api\/plugins\/([a-z][a-z0-9-]+)\/projects\/([a-z][a-z0-9-]+)\/rpc$/.exec(
        pathname,
      );
      if (rpcRoute && request.method === "POST") {
        security.assertBrowserMutation(request);
        const rpc = PluginRpcRequestSchema.parse(await jsonBody(request));
        if (rpc.method === "drift.analyze") bunServer.timeout(request, 21 * 60);
        if (rpc.method === "drift.importSession") bunServer.timeout(request, 75);
        const result = await plugins.dispatch(
          rpcRoute[1]!,
          rpcRoute[2]!,
          rpc,
          projects,
          notifications,
          integrations,
        );
        return api({ result });
      }

      if (pathname === "/api/notifications/subscriptions" && request.method === "POST") {
        security.assertBrowserMutation(request);
        notifications.subscribe(PushSubscriptionSchema.parse(await jsonBody(request)));
        return api({ subscriptionCount: store.subscriptionCount() }, { status: 201 });
      }
      if (pathname === "/api/notifications/subscriptions" && request.method === "DELETE") {
        security.assertBrowserMutation(request);
        const body = z
          .object({ endpoint: z.string().url().startsWith("https://").max(2_048) })
          .strict()
          .parse(await jsonBody(request));
        notifications.unsubscribe(body.endpoint);
        return api({ subscriptionCount: store.subscriptionCount() });
      }
      if (pathname === "/api/notifications/test" && request.method === "POST") {
        security.assertBrowserMutation(request);
        const event = notifications.create({
          kind: "system",
          title: "in-progress is connected",
          body: "Phone notifications are ready.",
          url: "/",
        });
        return api({ event }, { status: 201 });
      }

      if (pathname === "/api/hooks/notify" && request.method === "POST") {
        const authorization = request.headers.get("authorization") ?? "";
        const expected = `Bearer ${notifications.hookToken}`;
        if (!equalSecret(authorization, expected)) throw new HttpError(401, "Hook token rejected");
        const now = Date.now();
        hookTimes = hookTimes.filter((time) => now - time < 60_000);
        if (hookTimes.length >= 60) throw new HttpError(429, "Notification hook rate exceeded");
        hookTimes.push(now);
        const input = NotificationEventInputSchema.parse(await jsonBody(request));
        projects.get(input.projectId ?? "");
        return api({ event: notifications.create(input) }, { status: 201 });
      }

      if (pathname.startsWith("/api/")) throw new HttpError(404, "API route not found");

      const pluginAsset = /^\/plugins\/([a-z][a-z0-9-]+)\/?(.*)$/.exec(pathname);
      if (pluginAsset && request.method === "GET") {
        const assetPath = pluginAsset[2] ?? "";
        if (!assetPath) security.requireSession(request);
        const asset = plugins.asset(pluginAsset[1]!, assetPath);
        const file = Bun.file(asset);
        const mime = file.type.split(";", 1)[0] ?? "";
        const document =
          mime === "text/html" ||
          mime === "image/svg+xml" ||
          mime === "application/xml" ||
          mime === "text/xml" ||
          mime === "application/pdf" ||
          mime.endsWith("+xml");
        const assetBase = `${requestOrigin(request)}/plugins/${pluginAsset[1]!}/`;
        return secureHeaders(new Response(file), document ? "plugin" : "plugin-asset", assetBase);
      }

      if (request.method !== "GET" && request.method !== "HEAD")
        throw new HttpError(405, "Method not allowed");

      if (webProxy) {
        const target = developmentProxyTarget(webProxy, url);
        const headers = new Headers(request.headers);
        for (const name of [
          "authorization",
          "cookie",
          "tailscale-user-login",
          "tailscale-user-name",
          "tailscale-user-profile-pic",
          "x-forwarded-for",
          "x-forwarded-host",
          "x-forwarded-proto",
        ]) {
          headers.delete(name);
        }
        const upstream = await fetch(target, {
          headers,
          method: request.method,
        });
        return await secureDevelopmentHost(upstream);
      }

      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(pathname);
      } catch {
        throw new HttpError(400, "Malformed asset path");
      }
      const candidate = resolve(webRoot, `.${decodedPath}`);
      if (within(webRoot, candidate) && existsSync(candidate) && statSync(candidate).isFile()) {
        const canonical = realpathSync(candidate);
        if (within(webRoot, canonical))
          return secureHeaders(new Response(Bun.file(canonical)), "host");
      }
      const index = resolve(webRoot, "index.html");
      if (existsSync(index)) return secureHeaders(new Response(Bun.file(index)), "host");
      throw new HttpError(404, "Web build not found; run pnpm build:web");
    } catch (error) {
      return errorResponse(error);
    }
  }

  const server = Bun.serve<TerminalSocketData>({
    hostname: config.server.host,
    port: options.port ?? config.server.port,
    fetch: route,
    websocket: {
      data: {} as TerminalSocketData,
      backpressureLimit: 512 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      maxPayloadLength: 64 * 1024,
      perMessageDeflate: false,
      open(socket) {
        try {
          terminals.attach(socket);
        } catch (error) {
          socket.close(1011, error instanceof Error ? error.message : "Terminal attach failed");
        }
      },
      message(socket, message) {
        try {
          terminals.message(socket, message);
        } catch (error) {
          socket.close(1008, error instanceof Error ? error.message : "Terminal protocol error");
        }
      },
      close(socket) {
        terminals.detach(socket);
      },
      drain(socket) {
        terminals.drain(socket);
      },
    },
  });
  terminals.setServerPort(server.port ?? config.server.port);

  const sweep = setInterval(() => {
    security.sweep();
    terminals.sweep();
  }, 60_000);
  sweep.unref();

  return {
    config,
    integrations,
    notifications,
    plugins,
    preview,
    projects,
    security,
    server,
    store,
    terminals,
    async close(): Promise<void> {
      clearInterval(sweep);
      await server.stop(true);
      terminals.close();
      try {
        await preview.close();
        await integrations.close();
      } finally {
        store.close();
      }
    },
  };
}
