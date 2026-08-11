# in-progress

Local-first browser control plane for coding agents. Each configured project gets browser-detached Bun PTY sessions; the top rail switches between the trusted terminal and external project views. The React/Vite PWA works on desktop and narrow phone screens, keeps an event inbox, and sends standards-based Web Push notifications.

in-progress is a remote shell. It deliberately binds loopback and expects private HTTPS from [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve). Never expose it with Tailscale Funnel or a public reverse proxy.

## Stack

- Bun `1.3.14`: `Bun.serve`, native WebSockets/PTYs, `bun:sqlite`
- React 19 + Vite 8 PWA + xterm.js 6
- TypeScript 7, pnpm `11.3.0`
- External views: local static bundles in opaque-origin sandboxed iframes; versioned `MessageChannel` RPC
- State: ignored `.data/in-progress.db`; no account, cloud database, or telemetry

## Start

Prerequisites: Bun 1.3.14+, Node 24+, pnpm 11.3.0+, and optionally Tailscale on the host and phone.

```sh
pnpm install
pnpm check
pnpm dev
```

`pnpm dev` starts the API on `127.0.0.1:4317` and Vite on `127.0.0.1:5173`. Production embeds the web build behind one server:

```sh
pnpm build
pnpm start
```

Open `http://127.0.0.1:4317`. Copy `in-progress.config.json` to `in-progress.config.local.json` for private paths if desired, then start with:

```sh
IN_PROGRESS_CONFIG=./in-progress.config.local.json pnpm start
```

### SSH development

Run `pnpm dev` on the repository host. From the browser machine, forward both loopback ports through a second SSH connection:

```sh
ssh -NT -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:4317:127.0.0.1:4317 \
  -L 127.0.0.1:5173:127.0.0.1:5173 \
  -p <ssh-port> <ssh-host>
```

Open `http://127.0.0.1:4317`; port `5173` carries Vite HMR only. Both services remain remote-loopback-only.

The [configuration schema](docs/in-progress-config.schema.json) documents every field. Paths are resolved relative to the config file and must already exist.

## Private phone access

Keep `server.host` on `127.0.0.1`, set an explicit owner allowlist, then proxy the loopback port:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4317,
    "allowedTailscaleUsers": ["you@example.com"]
  }
}
```

```sh
tailscale serve --bg 4317
tailscale serve status
```

Open the reported `https://…ts.net` URL from a tailnet-connected phone. For user-owned source devices, Tailscale Serve terminates HTTPS, applies tailnet access rules, removes spoofed identity headers, and forwards `Tailscale-User-Login`; in-progress rejects proxy-marked requests without that identity and trusts it only because the backend remains loopback-only. Leave `allowedOrigins` empty unless a deliberate proxy topology changes the browser origin.

Do not set `IN_PROGRESS_UNSAFE_BIND=1` for ordinary use. See [security](docs/security.md) before changing the network boundary.

## Phone notifications

Use the notification control in the PWA to subscribe and send a test event. Web Push requires a secure context, so use the Tailscale HTTPS URL on a phone.

On iPhone/iPad, first add in-progress to the Home Screen, launch that installed web app, then enable notifications from a direct tap. Apple supports Web Push only for Home Screen web apps and requires the permission request to follow user interaction; no Apple developer account is required. [WebKit details](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

Push payloads contain the configured event title/body and deep link. Keep secrets and terminal output out of notification text.

## Agent notification hooks

Every in-progress shell receives the loopback endpoint, a shared notify-only hook token, and its default project ID; `bin/in-progress-notify` is prepended to `PATH`. Agent hooks can therefore emit inbox + phone events without handling credentials directly:

```sh
in-progress-notify --kind needs-input --title "Agent is waiting" "Review the proposed migration"
in-progress-notify --kind completed --title "Checks passed" "Ready for review"
in-progress-notify --kind failed --title "Build failed" "Open the terminal for details"
```

Kinds: `needs-input`, `completed`, `failed`, `system`. The helper only works inside an in-progress-created terminal. A process exit also creates an event. Terminal programs may emit an OSC notification directly:

```sh
printf '\033]777;notify;Agent update;Ready for review\a'
```

## Plugins

Add a built directory containing `in-progress.plugin.json` to `pluginDirectories`. in-progress serves only its entry and explicit `assets` allowlist under `/plugins/<id>/`, places the entry page in `sandbox="allow-scripts"`, and grants exactly the manifest capabilities through a project-bound `MessagePort`. A self-contained HTML entry is the most compatible package across extension-heavy browser profiles.

Installation trusts a plugin with data returned by its declared capabilities. The opaque-origin sandbox protects host cookies, DOM, and privileged APIs, but cannot stop the frame from disclosing granted data through its own navigation; review and pin plugin builds.

The reference view lives at `examples/plugins/project-map`. See [plugin system](docs/plugin-system.md) for the manifest, RPC protocol, SDK, and separate-repository workflow.

## Commands

| Command                          | Purpose                                      |
| -------------------------------- | -------------------------------------------- |
| `pnpm dev`                       | API watch mode + Vite dev server             |
| `pnpm build`                     | SDK, PWA, and Bun server bundles             |
| `pnpm start`                     | Run the production bundle                    |
| `pnpm check`                     | Format, lint, types, tests, production build |
| `pnpm plugin:validate -- <path>` | Validate a plugin root/manifest              |

## Documentation

- [Architecture](docs/architecture.md)
- [Plugin system](docs/plugin-system.md)
- [Security and threat model](docs/security.md)
- [Configuration schema](docs/in-progress-config.schema.json)

Primary runtime references: [Bun PTYs](https://bun.sh/docs/runtime/child-process#terminal-pty-support), [Bun WebSockets](https://bun.sh/docs/runtime/http/websockets), [Bun SQLite](https://bun.sh/docs/runtime/sqlite), [xterm.js security](https://xtermjs.org/docs/guides/security/).
