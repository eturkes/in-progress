import { describe, expect, test } from "bun:test";
import {
  requestOrigin,
  SecurityGate,
  secureDevelopmentHost,
  secureHeaders,
} from "../src/server/security";
import { DEVELOPMENT_CSP_NONCE_PLACEHOLDER } from "../src/shared/development";

const ORIGIN = "http://127.0.0.1:4317";

function request(headers: Record<string, string> = {}, url = `${ORIGIN}/api/bootstrap`): Request {
  return new Request(url, { headers });
}

function cookieFrom(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

describe("SecurityGate", () => {
  test("mints a strict browser session and requires same-origin CSRF on mutations", () => {
    const gate = new SecurityGate([], []);
    const session = gate.session(request());
    expect(session.identity).toBe("local");
    expect(session.setCookie).toContain("HttpOnly");
    expect(session.setCookie).toContain("SameSite=Strict");
    expect(session.setCookie).not.toContain("; Secure");
    const cookie = cookieFrom(session.setCookie!);
    const valid = request({
      cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-in-progress-csrf": session.csrfToken,
    });

    expect(gate.assertBrowserMutation(valid).sessionId).toBe(session.sessionId);
    expect(() =>
      gate.assertBrowserMutation(request({ cookie, "x-in-progress-csrf": session.csrfToken })),
    ).toThrow("Origin rejected");
    expect(() =>
      gate.assertBrowserMutation(
        request({
          cookie,
          origin: ORIGIN,
          "sec-fetch-site": "cross-site",
          "x-in-progress-csrf": session.csrfToken,
        }),
      ),
    ).toThrow("Cross-site request rejected");
    expect(() =>
      gate.assertBrowserMutation(
        request({ cookie, origin: ORIGIN, "sec-fetch-site": "same-origin" }),
      ),
    ).toThrow("CSRF token rejected");
    expect(() => gate.session(request({}, "http://rebind.attacker.example/api/bootstrap"))).toThrow(
      "Direct request host rejected",
    );
    expect(() => gate.session(request({ "sec-fetch-site": "cross-site" }))).toThrow(
      "Cross-site bootstrap rejected",
    );
  });

  test("marks proxy HTTPS cookies Secure and binds sessions to an allowed Tailscale identity", () => {
    const gate = new SecurityGate([], ["alice@example.com", "bob@example.com"]);
    const initial = request({
      host: "in-progress.example.ts.net",
      "tailscale-user-login": "alice@example.com",
      "x-forwarded-proto": "https",
    });
    const session = gate.session(initial);
    expect(requestOrigin(initial)).toBe("https://in-progress.example.ts.net");
    expect(session.setCookie).toContain("; Secure");
    const cookie = cookieFrom(session.setCookie!);
    const mutationHeaders = {
      cookie,
      host: "in-progress.example.ts.net",
      origin: "https://in-progress.example.ts.net",
      "sec-fetch-site": "same-origin",
      "x-forwarded-proto": "https",
      "x-in-progress-csrf": session.csrfToken,
    };

    expect(
      gate.assertBrowserMutation(
        request({ ...mutationHeaders, "tailscale-user-login": "alice@example.com" }),
      ).identity,
    ).toBe("alice@example.com");
    expect(() =>
      gate.assertBrowserMutation(
        request({ ...mutationHeaders, "tailscale-user-login": "bob@example.com" }),
      ),
    ).toThrow("Session identity changed");
    expect(() => gate.session(request({ "tailscale-user-login": "mallory@example.com" }))).toThrow(
      "Proxy identity requires forwarding headers",
    );
    expect(() =>
      gate.session(
        request({
          host: "in-progress.example.ts.net",
          "tailscale-user-login": "mallory@example.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toThrow("Tailscale identity is not allowed");
    expect(() =>
      gate.session(request({ host: "in-progress.example.ts.net", "x-forwarded-proto": "https" })),
    ).toThrow("Authenticated proxy identity required");
  });

  test("requires origin and browser session agreement for WebSocket tickets", () => {
    const gate = new SecurityGate([], []);
    const session = gate.session(request());
    const cookie = cookieFrom(session.setCookie!);
    const valid = request({ cookie, origin: ORIGIN });

    expect(gate.assertWebSocket(valid, session.sessionId).identity).toBe("local");
    expect(() =>
      gate.assertWebSocket(request({ cookie, origin: "https://evil.example" }), session.sessionId),
    ).toThrow("WebSocket origin rejected");
    expect(() => gate.assertWebSocket(valid, "wrong-session")).toThrow(
      "WebSocket session rejected",
    );
  });
});

describe("secureHeaders", () => {
  test("keeps host documents unframeable and plugin documents opaque-origin sandboxed", () => {
    const host = secureHeaders(new Response("host"), "host");
    const pluginBase = "https://in-progress.example.ts.net/plugins/project-map/";
    const plugin = secureHeaders(new Response("plugin"), "plugin", pluginBase);
    const pluginAsset = secureHeaders(new Response("asset"), "plugin-asset", pluginBase);
    const hostCsp = host.headers.get("content-security-policy")!;
    const pluginCsp = plugin.headers.get("content-security-policy")!;

    expect(host.headers.get("x-frame-options")).toBe("DENY");
    expect(hostCsp).toContain("frame-ancestors 'none'");
    expect(plugin.headers.has("x-frame-options")).toBeFalse();
    expect(pluginCsp).toContain("sandbox allow-scripts");
    expect(pluginCsp).not.toContain("allow-same-origin");
    expect(pluginCsp).toContain(`script-src ${pluginBase}`);
    expect(pluginCsp).toContain("'unsafe-inline'");
    expect(pluginCsp).toContain(`connect-src ${pluginBase}`);
    expect(pluginCsp).not.toContain("script-src 'self'");
    expect(plugin.headers.get("access-control-allow-origin")).toBeNull();
    expect(plugin.headers.get("cross-origin-resource-policy")).toBeNull();
    expect(plugin.headers.get("cache-control")).toBe("private, no-store");
    expect(pluginAsset.headers.get("access-control-allow-origin")).toBe("*");
    expect(pluginAsset.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(pluginAsset.headers.has("x-frame-options")).toBeFalse();
    expect(pluginAsset.headers.has("content-security-policy")).toBeFalse();
  });

  test("replaces Vite's development nonce without weakening production CSP", async () => {
    const source = `<meta property="csp-nonce" nonce="${DEVELOPMENT_CSP_NONCE_PLACEHOLDER}"><script nonce="${DEVELOPMENT_CSP_NONCE_PLACEHOLDER}">refresh()</script>`;
    const development = await secureDevelopmentHost(
      new Response(source, {
        headers: {
          "Content-Length": String(source.length),
          "Content-Type": "text/html; charset=utf-8",
          ETag: "stale-after-nonce-replacement",
        },
      }),
    );
    const html = await development.text();
    const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
    const nextHtml = await (
      await secureDevelopmentHost(
        new Response(source, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      )
    ).text();
    const nextNonce = /<script nonce="([^"]+)">/.exec(nextHtml)?.[1];
    const developmentCsp = development.headers.get("content-security-policy")!;
    const productionCsp = secureHeaders(new Response("host"), "host").headers.get(
      "content-security-policy",
    )!;

    expect(nonce).toBeTruthy();
    expect(nonce).not.toBe(DEVELOPMENT_CSP_NONCE_PLACEHOLDER);
    expect(nextNonce).toBeTruthy();
    expect(nextNonce).not.toBe(nonce);
    expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
    expect(developmentCsp).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(developmentCsp).toContain("worker-src 'self' blob:");
    expect(development.headers.has("content-length")).toBeFalse();
    expect(development.headers.has("etag")).toBeFalse();
    expect(productionCsp).toContain("script-src 'self';");
    expect(productionCsp).toContain("worker-src 'self';");
    expect(productionCsp).not.toContain("nonce-");
    expect(productionCsp).not.toContain("blob:");
  });
});
