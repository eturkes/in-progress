# Security and threat model

## Security claim

Switchyard safely exposes a full shell only under this deployment model:

1. the Bun process runs unprivileged as the single trusted workstation user;
2. HTTP listens on loopback only;
3. remote browsers reach it through private Tailscale Serve HTTPS;
4. tailnet policy admits only the owner’s user devices;
5. external plugin code remains in the enforced opaque-origin sandbox;
6. dependencies and plugin directories are selected by the owner.

Anyone who can send terminal input has the workstation user’s effective shell authority, including access to that user’s repositories, credentials, agents, network, and tools. Switchyard is not a multi-user tenancy boundary or a sandbox for commands launched in its terminal.

## Trust boundaries

### Trusted

- Switchyard server + built React host bundle
- configured shell and commands the user intentionally runs
- local operating-system user and same-UID processes
- explicitly configured project roots
- Tailscale control/transport plane and owner tailnet policy

### Untrusted

- arbitrary Internet sites open in the same browser
- PTY output/escape sequences and repository contents
- external plugin JavaScript/assets, even when authored by the owner
- request paths, JSON, WebSocket frames, plugin RPC parameters
- push endpoints and delivery networks

### Outside the boundary

- root or another process able to inspect/modify the Switchyard user’s memory/files
- a compromised host browser, host bundle, Bun runtime, Tailscale client, or OS
- isolation between programs intentionally started in a terminal
- persistence of PTYs across a Switchyard/host restart

Loopback blocks remote network peers, not other accounts/processes on the same machine. This personal-workstation design treats local code as trusted; use an isolated OS account or VM if that assumption is false.

## Remote access

`server.host` defaults to `127.0.0.1`. Startup rejects every non-loopback value unless `SWITCHYARD_UNSAFE_BIND=1` is explicitly set. The supported remote path is:

```text
tailnet browser → HTTPS Tailscale Serve → http://127.0.0.1:4317
```

Tailscale Serve applies tailnet access control, strips spoofed incoming identity headers, adds `Tailscale-User-Login` for user-owned source devices, and recommends localhost-only backends when those headers authorize requests. [Tailscale Serve identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)

Hardening requirements:

- use Serve, never public Funnel;
- grant the service only to the owner’s user devices in tailnet policy;
- set `server.allowedTailscaleUsers` to the exact owner login(s);
- keep the backend loopback-only so network clients cannot forge proxy headers;
- keep Tailscale and Bun updated;
- revoke a lost phone/device immediately.

`allowedTailscaleUsers` checks a present `Tailscale-User-Login` header. A request carrying forwarded-proxy headers requires forwarded HTTPS plus that identity; a direct request requires a loopback URL host. This rejects forged `Host` DNS-rebinding requests and tagged source devices for which Serve omits user identity. A genuinely direct loopback request without proxy headers is labeled `local`. Tailnet policy **must** still keep tagged/shared/unowned devices away from the Serve endpoint; the application allowlist is defense in depth, not a replacement for network policy.

`SWITCHYARD_UNSAFE_BIND=1` materially changes the threat model: LAN/public peers may reach a remote shell, spoof Tailscale identity headers, and use plaintext HTTP. It is an escape hatch, not an endorsed mode.

## Browser sessions, CSRF, and WebSockets

`GET /api/bootstrap` derives identity and creates a random 256-bit session ID + CSRF token stored only in server memory. Cookie properties:

- `HttpOnly`
- `SameSite=Strict`
- path `/`
- server entry expires after seven idle days; cookie expires at most seven days after mint
- `Secure` when the externally observed origin is HTTPS

Every browser mutation requires:

- live cookie session;
- constant-time matching `X-Switchyard-CSRF` token;
- exact request `Origin` equal to the computed public origin or an explicit `allowedOrigins` entry;
- `Sec-Fetch-Site` absent or `same-origin`;
- request identity equal to session identity.

API responses omit CORS grants. Bootstrap rejects cross-site Fetch Metadata/origins before creating a session. It may create a new session; other authenticated routes refresh only the server-side idle timestamp. The cookie is not extended, so an active browser bootstraps a replacement after at most seven days.

WebSockets need separate treatment because browsers can send cookies during a cross-origin upgrade and normal CORS does not protect the handshake. Switchyard requires exact origin, the `switchyard.terminal.v1` subprotocol, the browser session cookie, unchanged identity, and a one-use 30-second ticket minted through a CSRF-protected POST. [RFC 6455 origin guidance](https://datatracker.ietf.org/doc/html/rfc6455#section-10.2), [xterm.js WebSocket warning](https://xtermjs.org/docs/guides/security/#3-websockets)

Tickets travel in the WebSocket URL query. They are random, single-use, short-lived, and consumed immediately after a successful authenticated upgrade. Reverse proxies and access logs must omit/redact query strings. Switchyard itself does not log terminal URLs, input, output, cookies, CSRF values, or hook tokens.

Terminal WebSocket limits:

- binary protocol only;
- incoming payload ≤64 KiB;
- no per-message compression;
- 32 KiB output/replay frames, 512 KiB application live queue, and 512 KiB Bun send limit with forced close;
- 256 KiB bounded PTY input queue resumed by the terminal drain callback;
- 60-second idle timeout;
- validated opcode and resize range;
- only the writer lease may send input/resize.

The per-session replay ring and per-client live queue are bounded. A client that cannot catch up is disconnected rather than accumulating unbounded application memory.

## Host UI and terminal data

Any script executing in the trusted host page can observe keystrokes and control the terminal. The host therefore:

- loads scripts/fonts from its own built assets only;
- uses a restrictive CSP and no CDN/runtime code update;
- forbids embedding through CSP + `X-Frame-Options: DENY`;
- treats PTY output, titles, links, and repository strings as data;
- relies on xterm.js rendering rather than inserting terminal content as HTML;
- pins and audits xterm.js and addons.

Terminal output may contain hostile ANSI/OSC sequences. OSC 777 notifications are an intentional control channel:

```text
ESC ] 777 ; notify ; <title> ; <body> BEL
```

Any process in that PTY can emit it and trigger inbox/Web Push events. Titles/bodies are bounded, but this is not proof that an agent—not repository code—requested attention.

## Plugin isolation

Plugin URLs share the host URL origin for simple static serving, but two independent sandbox layers omit `allow-same-origin`:

- iframe attribute: `sandbox="allow-scripts"`;
- response CSP: `sandbox allow-scripts`.

The child receives a unique opaque origin. Host cookies/storage/DOM, service workers, forms, nested frames, workers, popups, top navigation, and external network endpoints are unavailable. Plugin document CSP permits installed inline code and limits script/style/image/font/connect requests to that plugin's canonical static URL prefix; the explicit URL is necessary because `'self'` does not match the effective opaque origin. Inline permission adds no host authority—the entire configured plugin is already trusted with its manifest grants—and enables self-contained bundles that survive privacy/wallet extensions blocking opaque-frame subresources. Only the entry and manifest-declared public assets are served. Declared non-document assets receive wildcard CORS/CORP so ES modules load from the serialized opaque origin (`Origin: null`); declared navigable HTML/SVG/XML/PDF assets retain document sandbox CSP. Privileged API responses and undeclared plugin files receive no CORS or static-file access. The [HTML Standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox) defines the sandbox flags.

The only authority is a new `MessagePort` created for one plugin + selected project. The host:

- transfers it only to the exact iframe window on its first entry load;
- requires the random init nonce back on that port;
- validates every message shape and timeout;
- checks the manifest capability on every method;
- takes project identity from trusted frame state, never plugin parameters;
- validates/canonicalizes paths again server-side;
- closes the port on navigation/project change/disposal and never reconnects a navigated frame.

Adding a plugin directory is a security decision. Review its manifest and built assets, pin its repository revision locally, and grant `project.readText`/`host.notify` sparingly. The sandbox protects host integrity and removes ambient browser authority, but it is not a confidentiality boundary for data returned through granted capabilities: CSP does not govern document navigation, so a plugin can navigate its own frame to an external URL carrying that data. `host.notify` also moves plugin-supplied text into Web Push/lock-screen previews; combining it with read capabilities can disclose returned content. A plugin also can mislead the user through its rendered UI.

## Filesystem and process controls

- Project/plugin roots must exist and are canonicalized at startup.
- Project IDs are opaque validated slugs; requests never supply a working directory.
- Shell executable/arguments are config-derived arrays passed directly to `Bun.spawn`, without shell interpolation.
- Plugin entry/declared assets must remain within the canonical plugin root; absolute, hidden, malformed, missing, non-file, and symlink-escape requests fail. Undeclared files are private.
- `project.readText` accepts a relative path, resolves its final realpath beneath the selected project, requires a regular nonbinary file, and returns at most 256 KiB.
- Project tree is depth/entry bounded, does not descend symlinks, and omits common dependency/state/build directories.
- Git status uses an asynchronous subprocess with a three-second timeout, 1 MiB output cap, and two-second per-project cache.
- Running sessions are capped per project.

These controls protect the host broker from confused-deputy/path traversal attacks. They do not protect the user from code intentionally executed in the full terminal.

## Notification secrets and privacy

`.data/` is mode `0700`; `.data/switchyard.db` is mode `0600`. It contains:

- VAPID private/public keys;
- one global notification-hook bearer token;
- browser push subscription endpoints and encryption material;
- event titles, bodies, deep links, and read state.

Every Switchyard shell receives the same notify-only hook token plus its default `SWITCHYARD_PROJECT_ID`. A process possessing the token can submit a bounded event for any existing configured project by overriding that ID; it cannot use browser mutation or terminal APIs. Treat the token as a global notification capability and rotate it by removing its database metadata only while Switchyard is stopped.

Web Push encrypts payload contents for the browser under [RFC 8291](https://datatracker.ietf.org/doc/html/rfc8291) and authenticates the application server with VAPID under [RFC 8292](https://datatracker.ietf.org/doc/html/rfc8292). Push providers still observe endpoint, timing, approximate size, source IP, and delivery metadata. Switchyard sends title/body in the payload, so notification text must never contain secrets, source snippets, commands, credentials, or raw terminal output.

Notification availability is bounded: each PTY accepts ten OSC notification events per minute and the shared hook accepts 60 per minute; SQLite keeps the newest 2,000 events; the asynchronous Web Push queue keeps 100 waiting events and discards the oldest waiting delivery under sustained pressure; subscription fan-out is capped at eight concurrent ten-second requests. Inbox persistence and SSE delivery remain synchronous even when a queued push is discarded. Urgent action/failure pushes receive longer provider TTLs than completion/system updates.

Browser permission must follow an explicit user gesture. On iOS/iPadOS, Web Push works only for an added-to-Home-Screen web app launched from that icon. [WebKit Web Push requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## Threat/control matrix

| Threat                           | Primary controls                                                 | Residual risk                                         |
| -------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Internet scanning                | loopback bind + private Serve; no Funnel                         | proxy/tailnet misconfiguration                        |
| Unauthorized tailnet user/device | tailnet grants + user header allowlist                           | tagged devices need explicit network exclusion        |
| Malicious website / CSRF         | Strict cookie, exact Origin, Fetch Metadata, CSRF token, no CORS | trusted-origin XSS defeats these                      |
| Cross-site WebSocket hijack      | Origin + session-bound one-use ticket + subprotocol              | ticket exposure through external query logging        |
| Host XSS/dependency compromise   | self-only built assets, CSP, pinned dependencies                 | host JS compromise equals shell compromise            |
| Malicious plugin                 | opaque-origin iframe+CSP, no direct connect, capability broker   | deceptive UI; navigation can leak granted data        |
| Path/symlink escape              | startup realpath + request-time beneath-root checks              | TOCTOU from a trusted local process changing paths    |
| Hostile terminal output          | xterm parser, bounded frames/replay, no HTML injection           | terminal emulator/addon vulnerability                 |
| Output/session DoS               | frame/backpressure/idle/ring/session limits                      | intentionally run process can consume host CPU/RAM    |
| Lost phone                       | Tailscale device revocation + OS lock                            | existing browser session until device/network revoked |
| Push-provider compromise         | standards encryption + minimal payload policy                    | metadata exposure; unsafe user-authored text          |
| Local same-user compromise       | outside boundary                                                 | complete Switchyard/repository access                 |

## Deployment checklist

- [ ] `server.host` is `127.0.0.1`/`::1`/`localhost`.
- [ ] Tailscale Serve, not Funnel, proxies the configured port.
- [ ] Tailnet policy admits only the owner’s user devices; no tagged/shared device route.
- [ ] `allowedTailscaleUsers` contains the exact owner login.
- [ ] `allowedOrigins` is empty or contains only intentional exact HTTPS origins.
- [ ] `.data/` and config permissions exclude other local users.
- [ ] Plugin manifests/assets and `project.readText`/`host.notify` grants were reviewed.
- [ ] No secrets appear in notification titles/bodies.
- [ ] `pnpm check` passes on pinned dependencies before deployment.
