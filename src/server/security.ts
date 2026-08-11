import { timingSafeEqual } from "node:crypto";
import { DEVELOPMENT_CSP_NONCE_PLACEHOLDER } from "../shared/development";

const SESSION_COOKIE = "in-progress-session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SESSIONS = 256;

interface Session {
  csrfToken: string;
  identity: string;
  touchedAt: number;
}

export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  identity: string;
  setCookie?: string;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Buffer.from(bytes).toString("base64");
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requestOrigin(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwarded === "https" ? "https:" : new URL(request.url).protocol;
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    request.headers.get("host") ??
    new URL(request.url).host;
  try {
    return new URL(`${protocol}//${host}`).origin;
  } catch {
    return new URL(request.url).origin;
  }
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  return new Bun.CookieMap(raw).get(name) ?? null;
}

function isProxied(request: Request): boolean {
  return (
    request.headers.has("x-forwarded-for") ||
    request.headers.has("x-forwarded-host") ||
    request.headers.has("x-forwarded-proto")
  );
}

function isDirectLoopback(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export class SecurityGate {
  readonly #sessions = new Map<string, Session>();
  readonly #allowedOrigins: Set<string>;
  readonly #allowedTailscaleUsers: Set<string>;

  constructor(allowedOrigins: string[], allowedTailscaleUsers: string[]) {
    this.#allowedOrigins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
    this.#allowedTailscaleUsers = new Set(allowedTailscaleUsers);
  }

  #liveSession(request: Request): { id: string; session: Session } | null {
    const id = cookieValue(request, SESSION_COOKIE);
    const session = id ? this.#sessions.get(id) : undefined;
    if (!id || !session) return null;
    if (Date.now() - session.touchedAt >= SESSION_TTL_MS) {
      this.#sessions.delete(id);
      return null;
    }
    return { id, session };
  }

  identity(request: Request): string {
    const tailscaleUser = request.headers.get("tailscale-user-login");
    const proxied = isProxied(request);
    if (!tailscaleUser && proxied)
      throw new HttpError(401, "Authenticated proxy identity required");
    if (!tailscaleUser) {
      if (!isDirectLoopback(request)) throw new HttpError(421, "Direct request host rejected");
      return "local";
    }
    if (!proxied) throw new HttpError(401, "Proxy identity requires forwarding headers");
    if (!requestOrigin(request).startsWith("https:"))
      throw new HttpError(400, "Authenticated proxy HTTPS required");
    if (this.#allowedTailscaleUsers.size > 0 && !this.#allowedTailscaleUsers.has(tailscaleUser)) {
      throw new HttpError(403, "Tailscale identity is not allowed");
    }
    return tailscaleUser;
  }

  sameOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return false;
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      return false;
    }
    if (this.#allowedOrigins.has(normalized)) return true;
    if (!isProxied(request) && !isDirectLoopback(request)) return false;
    return normalized === requestOrigin(request);
  }

  assertBrowserMutation(request: Request): AuthContext {
    if (!this.sameOrigin(request)) throw new HttpError(403, "Origin rejected");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin")
      throw new HttpError(403, "Cross-site request rejected");
    const live = this.#liveSession(request);
    const supplied = request.headers.get("x-in-progress-csrf") ?? "";
    if (!live || !constantEqual(live.session.csrfToken, supplied)) {
      throw new HttpError(403, "CSRF token rejected");
    }
    const identity = this.identity(request);
    if (identity !== live.session.identity) throw new HttpError(403, "Session identity changed");
    live.session.touchedAt = Date.now();
    return { sessionId: live.id, csrfToken: live.session.csrfToken, identity };
  }

  requireSession(request: Request): AuthContext {
    const live = this.#liveSession(request);
    if (!live) throw new HttpError(401, "Browser session required");
    const identity = this.identity(request);
    if (identity !== live.session.identity) throw new HttpError(403, "Session identity changed");
    live.session.touchedAt = Date.now();
    return { sessionId: live.id, csrfToken: live.session.csrfToken, identity };
  }

  session(request: Request): AuthContext {
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      throw new HttpError(403, "Cross-site bootstrap rejected");
    }
    if (request.headers.has("origin") && !this.sameOrigin(request)) {
      throw new HttpError(403, "Bootstrap origin rejected");
    }
    const identity = this.identity(request);
    const current = this.#liveSession(request);
    if (current && current.session.identity === identity) {
      current.session.touchedAt = Date.now();
      return { sessionId: current.id, csrfToken: current.session.csrfToken, identity };
    }

    this.sweep();
    if (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.#sessions.entries()].sort(
        ([, left], [, right]) => left.touchedAt - right.touchedAt,
      )[0];
      if (oldest) this.#sessions.delete(oldest[0]);
    }
    const sessionId = randomToken();
    const csrfToken = randomToken();
    this.#sessions.set(sessionId, { csrfToken, identity, touchedAt: Date.now() });
    const secure = requestOrigin(request).startsWith("https:") ? "; Secure" : "";
    return {
      sessionId,
      csrfToken,
      identity,
      setCookie: `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1_000}${secure}`,
    };
  }

  assertWebSocket(request: Request, sessionId: string): AuthContext {
    if (!this.sameOrigin(request)) throw new HttpError(403, "WebSocket origin rejected");
    const live = this.#liveSession(request);
    if (!live || live.id !== sessionId) throw new HttpError(403, "WebSocket session rejected");
    const identity = this.identity(request);
    if (identity !== live.session.identity) throw new HttpError(403, "WebSocket identity changed");
    live.session.touchedAt = Date.now();
    return { sessionId, csrfToken: live.session.csrfToken, identity };
  }

  sweep(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.#sessions) {
      if (session.touchedAt < cutoff) this.#sessions.delete(id);
    }
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function hostContentSecurityPolicy(scriptNonce?: string, allowBlobWorkers = false): string {
  const nonceSource = scriptNonce ? ` 'nonce-${scriptNonce}'` : "";
  const blobWorkerSource = allowBlobWorkers ? " blob:" : "";
  return `default-src 'self'; script-src 'self'${nonceSource}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; worker-src 'self'${blobWorkerSource}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

export function secureHeaders(
  response: Response,
  kind: "api" | "host" | "plugin" | "plugin-asset" = "api",
  pluginAssetBase?: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  if (kind === "api" || kind === "host") headers.set("X-Frame-Options", "DENY");
  if (kind === "host" || kind === "plugin") {
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
  }

  if (kind === "api") {
    headers.set("Cache-Control", "no-store");
  } else if (kind === "host") {
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Content-Security-Policy", hostContentSecurityPolicy());
  } else if (kind === "plugin") {
    const assets = pluginAssetBase ?? "'none'";
    headers.set(
      "Content-Security-Policy",
      `default-src 'none'; script-src ${assets} 'unsafe-inline'; style-src ${assets} 'unsafe-inline'; img-src ${assets} data:; font-src ${assets}; connect-src ${assets}; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`,
    );
    headers.set("Cache-Control", "private, no-store");
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("Cache-Control", "no-cache");
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export async function secureDevelopmentHost(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/html" || response.body === null) return secureHeaders(response, "host");

  const nonce = randomNonce();
  const html = (await response.text()).replaceAll(DEVELOPMENT_CSP_NONCE_PLACEHOLDER, nonce);
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("etag");
  const secured = secureHeaders(
    new Response(html, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
    "host",
  );
  secured.headers.set("Content-Security-Policy", hostContentSecurityPolicy(nonce, true));
  return secured;
}
