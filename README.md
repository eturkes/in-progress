# in-progress

Local-first browser control plane for coding agents. Each configured project gets named zmx-backed terminal sessions that survive browser and in-progress restarts; the top rail switches between the trusted terminal and external project views. The React/Vite PWA works on desktop and narrow phone screens, keeps an event inbox, and sends standards-based Web Push notifications.

in-progress is a remote shell. It deliberately binds loopback and expects private HTTPS from [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve). Never expose it with Tailscale Funnel or a public reverse proxy.

## Stack

- Bun `1.3.14`: `Bun.serve`, native WebSockets/PTYs, `bun:sqlite`
- zmx `0.7.0+`: one persistent, named PTY daemon per Terminal session
- React 19 + Vite 8 PWA + xterm.js 6
- TypeScript 7, pnpm `11.3.0`
- External views: local static bundles in opaque-origin sandboxed iframes; versioned `MessageChannel` RPC
- State: ignored `.data/in-progress.db`; no account, cloud database, or telemetry
- Frontier lab: Kotlin/Restate durable workflows + Rust idempotent effect executor + Quint model

## Start

Prerequisites: Bun 1.3.14+, [zmx](https://github.com/neurosnap/zmx) 0.7.0+, Node 24+, pnpm 11.3.0+, Python 3.11+, JDK 26.0.2,
Rust/Cargo 1.97.1, Linux x86-64, and optionally Tailscale on the host and phone. Python/Rust build
the plugin ecosystem; JDK/Rust are used by the frontier gate. Preview generation additionally
requires a Codex CLI logged in through ChatGPT.

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

Creating a Terminal creates a discoverable `in-progress-…` zmx session in the server process's
`ZMX_DIR` namespace. Stopping/restarting in-progress detaches; the next process recovers matching
live sessions and zmx restores their terminal state. Deleting a Terminal explicitly kills its zmx
session. in-progress clears inherited `ZMX_SESSION`/`ZMX_SESSION_PREFIX`, so ownership never aliases
the zmx session used to launch the server.

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

Every in-progress shell receives the loopback endpoint, a shared notify-only hook token, its default project ID, and its stable Terminal session ID; `bin/in-progress-notify` is prepended to `PATH`. Agent hooks can therefore emit inbox + phone events without handling credentials directly:

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

### Pinned plugin ecosystem

`in-progress.ecosystem.config.json` wires the repositories pinned under `plugins/` into one local
control plane. Each Git submodule remains an independent product repository that owns its native
gate and static plugin output. `pluginDirectories` installs those outputs; `projects` independently
exposes each submodule in the project rail. Select the owning project before opening a terminal or
starting Codex so its shell begins at that repository root.

Initialize the pinned revisions, build the installable outputs, then start with the ecosystem
configuration. The build installs Tree Complete and Turbo Prompt from their locked dependency
graphs before compiling all derived assets; Tree Complete uses its declared pnpm `10.34.5`. It also
creates the external Preview artifact root and an initially empty aggregate when no dashboards have
been generated.

```sh
git submodule update --init --recursive
pnpm ecosystem:build
pnpm dev:ecosystem
# production: pnpm build && pnpm start:ecosystem
```

| View          | Project-bound behavior                                                        | Host authority                         |
| ------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| Align         | Compact verified lifecycle, one-click setup, and next action                  | Fixed status + local initialization    |
| Drift         | Discovers candidate report JSON; renders only native-validator-clean reports  | Fixed `drift render`                   |
| Preview       | Selects, generates, or updates the active project's validated dashboard       | Fixed read-only Codex authoring        |
| Tree Complete | Explores/forks project-identified decision lineage; default simulates locally | Narrow embedded workspace/fork service |
| Turbo Prompt  | Builds prompts from host-bound metadata, tree, instructions, and manifests    | Bounded project reads                  |

The build command compiles Drift, Preview, Tree Complete, and Turbo Prompt, then validates all five
manifests with the host validator. Each submodule still owns its full native quality gate. Preview's
published models, compiled dashboards, stages, locks, and aggregate plugin live under
`~/.local/share/in-progress/preview`, disjoint from every configured project. The build initializes
that root as a standalone local Git repository; Preview commits validated bundles, generation records,
and aggregate output after each successful package, configures no remote, and never pushes. Host status
reads inventory and generation metadata from one atomically published private index, not a possibly
newer loose record. Configuring the Preview integration also installs
`artifactDirectory/in-progress-plugin`; the generation and served iframe therefore share one package.
Stages,
locks, and recovery backups remain ignored. Projects without a matching package display an explicit
unavailable state.

In the Alignment view, **Set up Alignment** accepts the exact initiating request once, confirms the
project-local write, and freezes it verbatim with the current repository snapshot. The browser can
send only that bounded UTF-8 text; the host fixes the selected root/name, trusted Align source and
Python, `user` authority, and `in_progress` stage. Setup writes `.align` locally, contacts no model or
external service, rejects an existing baseline, and reloads the verified lifecycle view after success.

In the Preview view, **Generate Preview** creates the external dashboard. **Update Preview** supplies
the prior validated declarative model as continuity while re-verifying it against current source;
**Regenerate from scratch** omits that prior context. A bounded project-specific direction can steer
either path. Manual runs receive a trusted confirmation immediately before subscription spending.
Automatic mode receives one explicit ongoing-authorization confirmation, creates a missing Preview,
then runs at most once per new clean Git commit; dirty worktrees wait and failed commits do not loop.
Successful aggregate publication reloads the frame. The fixed invocation uses ChatGPT-authenticated Codex,
`gpt-5.6-sol`, `max` reasoning, a read-only OS sandbox, and at most one repair retry after a failed
invocation or invalid/unreadable output. Each invocation can make multiple model requests and tool
continuations. Codex can read any host-readable content, which may reach OpenAI; the sandbox prevents
writes but is not a confidentiality boundary. Project documents, repository skills, hooks, MCP
servers, plugins, web search, and other external-capability tools are disabled for this bounded
authoring run. The user-owned global `~/.codex/AGENTS.md` remains model-visible trusted authority.
Project content remains untrusted data; the read-only shell remains available for source inspection.
The experimental Codex app-server is intentionally outside this batch boundary: persistent threads
would add hidden global state without improving commit detection, schema validation, or atomic publish.
Publish every referenced plugin commit before publishing a parent commit that advances a gitlink.

Tree Complete preview state lives under host-owned `.data/` and does not mutate project files or Git
state. `codex` mode is an explicit config change and requires each target to commit a valid
`.tree-complete/project.json`; startup validates its strict contents from exact committed `HEAD`.
Every fork RPC—simulation included—
receives a trusted host confirmation showing mode and immutable IDs immediately before dispatch.
Codex mode runs inherited `codex --yolo exec` unsandboxed as the current OS user, so it can access
anything that user can; it creates retained Git branches/worktrees and commits. Shutdown drains a
valid run and can wait until the runner's 30-minute timeout.

Tree Complete pessimistically budgets every accepted fork's terminal public state and response
envelope under the host's 4 MiB limit. At the boundary it rejects before reservation with `429`,
leaving the readable retained history unchanged.

## Frontier durable execution lab

`frontier/` is an isolated next-architecture slice; it does not replace the production Bun routes.
It proves a Kotlin/Restate durable workflow calling a Rust operation executor with an immutable
SQLite receipt. The full subprocess gate kills the Kotlin endpoint after executor commit, restarts
it, and verifies Restate completion through receipt replay. See the [frontier design and exact
guarantee](frontier/README.md).

## Commands

| Command                          | Purpose                                      |
| -------------------------------- | -------------------------------------------- |
| `pnpm dev`                       | API watch mode + Vite dev server             |
| `pnpm build`                     | SDK, PWA, and Bun server bundles             |
| `pnpm start`                     | Run the production bundle                    |
| `pnpm check`                     | Format, lint, types, tests, production build |
| `pnpm check:frontier`            | Formal, Kotlin, Rust, and crash-replay gates |
| `pnpm ecosystem:build`           | Build + validate five pinned plugin outputs  |
| `pnpm dev:ecosystem`             | Run dev host with the pinned ecosystem       |
| `pnpm start:ecosystem`           | Run built host with the pinned ecosystem     |
| `pnpm plugin:validate -- <path>` | Validate a plugin root/manifest              |

## Documentation

- [Architecture](docs/architecture.md)
- [Plugin system](docs/plugin-system.md)
- [Security and threat model](docs/security.md)
- [Configuration schema](docs/in-progress-config.schema.json)

Primary runtime references: [zmx](https://github.com/neurosnap/zmx), [Bun PTYs](https://bun.sh/docs/runtime/child-process#terminal-pty-support), [Bun WebSockets](https://bun.sh/docs/runtime/http/websockets), [Bun SQLite](https://bun.sh/docs/runtime/sqlite), [xterm.js security](https://xtermjs.org/docs/guides/security/).
