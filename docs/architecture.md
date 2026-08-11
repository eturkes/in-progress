# Architecture

## Decisions

| Concern         | Decision                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Runtime         | Pinned Bun + TypeScript; one unprivileged process                                                  |
| HTTP/realtime   | Native `Bun.serve` + native binary WebSockets/SSE                                                  |
| Terminal        | `Bun.Terminal` PTY per session; xterm.js in the trusted host UI                                    |
| UI              | React/Vite installable PWA; responsive project rail + plugin rail + view pane                      |
| Persistence     | `bun:sqlite` in `.data/in-progress.db`; PTY processes remain in memory                             |
| Remote boundary | Loopback HTTP behind private Tailscale Serve HTTPS                                                 |
| Plugins         | Local static directories; forced opaque iframe origin; project-bound `MessageChannel` capabilities |
| Integrations    | Optional host-owned fixed adapters for Align, Drift, and Tree Complete; no generic plugin backend  |
| Notifications   | SQLite inbox + SSE foreground delivery + VAPID Web Push background delivery                        |

The Bun primitives remove native addons and extra daemons: `Bun.spawn` attaches a real PTY, `Bun.serve` owns HTTP/WebSocket lifecycle and limits, and `bun:sqlite` supplies a synchronous embedded database. Primary references: [PTY](https://bun.sh/docs/runtime/child-process#terminal-pty-support), [WebSockets](https://bun.sh/docs/runtime/http/websockets), [SQLite](https://bun.sh/docs/runtime/sqlite).

## Topology

```text
phone / desktop browser
        │
        │ private HTTPS + WSS (tailnet)
        ▼
 Tailscale Serve
        │ loopback HTTP; identity headers
        ▼
┌────────────────────────── in-progress / Bun ──────────────────────────┐
│ Bun.serve                                                            │
│ ├─ dist/web React PWA          ├─ binary terminal WebSockets         │
│ ├─ JSON API + event SSE        └─ sandboxed plugin static assets     │
│                                                                      │
│ project registry ─ plugin capability broker ─ notification service   │
│                         │                                            │
│              fixed native/embedded integrations                      │
│          │                         │                    │              │
│     Bun.Terminal             local files        bun:sqlite + Push    │
│          │                                              │             │
│   shell / coding agent                          browser push service   │
└──────────────────────────────────────────────────────────────────────┘
```

Development substitutes Vite at `IN_PROGRESS_WEB_PROXY=http://127.0.0.1:5173`; authorization, cookie, Tailscale identity, and forwarding headers are stripped before that proxy request. Production serves `dist/web` and SPA-falls back to its `index.html`. API, host, and plugin responses receive distinct cache/CSP/security headers.

## Configuration and startup

`loadConfig()` parses `in-progress.config.json`, or `IN_PROGRESS_CONFIG`, before opening sockets:

1. resolve the config and its containing root;
2. apply defaults and reject unknown fields;
3. refuse a non-loopback server host unless `IN_PROGRESS_UNSAFE_BIND=1`;
4. expand `~/`, resolve project/plugin/integration paths relative to the config, require existence, then canonicalize with `realpath`;
5. reject duplicate project/plugin IDs;
6. in Tree Complete Codex mode, load the canonical built preflight and strictly validate each
   project's manifest from exact committed `HEAD`;
7. place runtime state in `<config-root>/.data`.

The machine-readable contract is [in-progress-config.schema.json](in-progress-config.schema.json).

## Project and terminal lifecycle

Project configuration is static for a server run. Each project record supplies the trusted canonical working directory used for sanitized read-only Git queries, plugin reads, and new shells.

Integration configuration is also static and host-owned. Align gets one fixed read-only status
invocation; Drift gets one fixed validating render invocation; Tree Complete loads one built
embedded service per selected project with host-fixed project/data roots and runner mode. Static
plugin manifests grant access to those named methods but cannot configure code, argv, paths, or
mode. Align starts through isolated Python with a fixed trusted source path. Tree fork mutation
additionally crosses a trusted React-host confirmation containing the configured mode and validated
fork IDs.

`POST /api/projects/:project/sessions` creates:

- UUID session ID;
- `Bun.Terminal` initially sized 100×30 and named `xterm-256color`;
- configured shell + argument vector, spawned directly without shell interpolation;
- working directory fixed to the configured project root;
- bounded byte replay ring (`terminal.scrollbackBytes`);
- injected project-scoped notification environment;
- in-memory client map and one writer lease.

Changing project/view or losing the browser connection does **not** kill the PTY. Reattach receives the byte-ring snapshot, then live output. Sessions survive browser reload/network loss only while the in-progress process remains alive; a daemon restart or host reboot ends them. Session metadata and scrollback are intentionally not stored in SQLite.

Multiple clients may observe one session. The newest attachment owns input/resize; another client sends `claim` to take the writer lease. All clients receive output/status. Explicit delete sends `SIGTERM` and closes the PTY. Process exit creates a `completed`/`failed` event.

### Terminal WebSocket

Attach is two-stage:

1. same-origin, CSRF-protected `POST /api/projects/:project/sessions/:session/ticket` returns a random one-use ticket expiring in 30 seconds;
2. browser opens `/api/terminal?ticket=…` with subprotocol `in-progress.terminal.v1`.

The server validates the ticket, browser session, WebSocket origin, and identity before upgrade; it consumes the ticket only after a successful upgrade, then attaches immutable project/PTY socket metadata. A rejected/failed handshake does not burn the ticket; it remains usable until success or 30-second expiry. Text frames are rejected. Compression is disabled; incoming client messages are capped at 64 KiB; the Bun send backpressure cap is 512 KiB with close-on-limit; idle timeout is 60 seconds.

Binary frames start with one opcode:

|   Code | Name       | Direction       | Payload                         |
| -----: | ---------- | --------------- | ------------------------------- |
| `0x01` | `input`    | client → server | raw PTY bytes                   |
| `0x02` | `resize`   | client → server | columns `u16be`, rows `u16be`   |
| `0x03` | `ping`     | client → server | empty                           |
| `0x04` | `claim`    | client → server | empty                           |
| `0x81` | `output`   | server → client | raw PTY bytes                   |
| `0x82` | `snapshot` | server → client | first bounded replay chunk      |
| `0x83` | `status`   | server → client | UTF-8 JSON `{session,writable}` |
| `0x84` | `pong`     | server → client | empty                           |

Replay and live output are emitted in at most 32 KiB frames. Replay starts with `snapshot`; any remaining chunks use `output`, followed by queued live bytes. Per-client live output and per-session terminal input queues are bounded; Bun drain callbacks resume each direction after backpressure. Resize is accepted only from the writer and clamped to 2–1000 columns and 1–500 rows. xterm.js renders output as terminal data; host code must never copy terminal titles/buffer data into `innerHTML`. [xterm.js security](https://xtermjs.org/docs/guides/security/)

## Browser/API session

`GET /api/bootstrap` establishes an in-memory browser session and returns the CSRF token, identity, projects, plugins, and push status. Server entries expire after seven idle days; the `HttpOnly`, `SameSite=Strict` cookie expires at most seven days after mint and is `Secure` when the externally observed origin is HTTPS. Any server restart invalidates sessions; a still-open browser bootstraps a replacement.

Bootstrap establishes or refreshes the session; other read endpoints and plugin entry documents require and refresh an existing session. Declared plugin module/style/font/image assets remain unauthenticated because the opaque-origin frame cannot attach host credentials to their CORS loads. Every browser mutation requires the cookie, `X-In-Progress-CSRF`, exact expected/allowlisted `Origin`, same Tailscale identity, and—when supplied—`Sec-Fetch-Site: same-origin`.

Core routes:

| Route                                             | Purpose                              |
| ------------------------------------------------- | ------------------------------------ |
| `GET /api/bootstrap`                              | session + navigation/bootstrap model |
| `GET /api/projects/:id/sessions`                  | list in-memory PTYs                  |
| `POST /api/projects/:id/sessions`                 | create PTY                           |
| `DELETE /api/projects/:id/sessions/:sid`          | terminate PTY                        |
| `POST …/:sid/ticket`                              | mint one-use WebSocket ticket        |
| `GET /api/events`                                 | latest 100 inbox events              |
| `GET /api/events/stream`                          | live SSE + 20-second heartbeat       |
| `POST /api/events/:id/read`                       | mark event read                      |
| `POST /api/plugins/:plugin/projects/:project/rpc` | capability broker                    |
| `POST/DELETE /api/notifications/subscriptions`    | manage browser push subscription     |
| `POST /api/notifications/test`                    | test inbox + push                    |
| `POST /api/hooks/notify`                          | terminal/agent bearer hook           |
| `GET /plugins/:id/`                               | authenticated plugin entry document  |
| `GET /healthz`                                    | process health/version               |

## Plugins

The authenticated entry and manifest-declared assets are served from `/plugins/:id/`; undeclared plugin-root files remain private. Document CSP includes `sandbox allow-scripts`; the host iframe also has `sandbox="allow-scripts"`. Omitting `allow-same-origin` changes the child to a unique opaque origin even though its URL shares the host origin. It therefore has no host cookies/storage/DOM access. CSP limits connections and subresources to that plugin's static URL prefix, enabling declared ES-module graphs while blocking host APIs and external endpoints. Inline code is permitted because a configured plugin is already trusted with its declared capabilities; self-contained entry documents are the most extension-compatible package. Browsers do not apply connect restrictions to document navigation, so an installed plugin can navigate its own frame to disclose data returned by granted capabilities. Plugin installation remains a confidentiality trust decision.

The React host creates one `MessageChannel` per `{plugin,project}` entry load, transfers only minimal project identity, fixes project context before RPC, and brokers only manifest-declared methods. Navigation, project/view switch, or frame disposal closes the channel; a navigated frame never receives a replacement. See [plugin system](plugin-system.md).

## Events and Web Push

Events have UUID, optional project, kind, title/body, root-relative deep link, created time, and optional read time. Creation synchronously writes SQLite and emits to SSE listeners, then enqueues Web Push without delaying the caller. SQLite retains the newest 2,000 events.

`NotificationService` generates VAPID keys and a hook token once, persisting both in the mode-0600 SQLite file. Subscriptions and last-success timestamps share that database. One serial queue retains at most 100 waiting events, dropping the oldest waiting delivery under sustained pressure. Each event fans out to at most eight subscriptions concurrently with a ten-second request timeout; 404/410 endpoints are removed. `needs-input` uses high urgency / 24-hour TTL, `failed` high / six hours, and `completed` + `system` normal / one hour. Payloads contain event ID/kind/title/body/url.

The PWA service worker displays a notification and focuses/opens the root-relative deep link on click. Web Push payload encryption and VAPID follow [RFC 8291](https://datatracker.ietf.org/doc/html/rfc8291) and [RFC 8292](https://datatracker.ietf.org/doc/html/rfc8292). Push delivery can wake the installed PWA; loading its private deep link still requires the phone to reach the tailnet URL.

## SQLite ownership

`.data/` is created mode `0700`; `in-progress.db` is mode `0600`, strict SQLite with WAL, foreign keys, and a five-second busy timeout.

Persistent data:

- `meta`: VAPID keypair + notification hook token;
- `push_subscriptions`: endpoint/subscription JSON/timestamps;
- `events`: newest 2,000 inbox records.

Repositories, terminal bytes, commands, and browser sessions are never written to the database.
