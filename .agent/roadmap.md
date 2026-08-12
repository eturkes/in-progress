# in-progress roadmap

## Outcome

Browser + phone-ready personal agent control plane: durable project PTYs, project rail, plugin views, sandboxed external-plugin protocol, Web Push.

## Build sequence

- [x] Architecture + threat model frozen
- [x] Shared contracts + config + plugin SDK
- [x] Bun server: auth, projects, plugin RPC, PTY, persistence, push
- [x] Responsive React PWA + xterm terminal + plugin host + inbox
- [x] Reference plugin + author/deployment/security docs
- [x] Unit/integration/build + desktop/mobile browser QA
- [x] Adversarial review, cleanup, scoped commit

## Success criteria

- Project switch never destroys PTY; browser reload reattaches + replays bounded scrollback.
- External plugin code has opaque origin, no ambient cookies/filesystem/API access, and network fetches limited to its static asset prefix; every RPC is declared + project-scoped. Installation trusts the plugin with granted data because self-navigation can disclose it.
- Server binds loopback by default; mutation endpoints require same-origin session CSRF; WebSocket validates origin + CSRF.
- Installed PWA can subscribe to standard Web Push and deep-link notification events.
- 390 px viewport retains project/plugin/terminal/notification access; primary navigation targets are at least 44 px and dense terminal controls remain spaced/reachable.
- Fresh clone: `pnpm install && pnpm check`; runtime: `pnpm start`.

## Ecosystem integration

- [x] Survey Align, Drift, Preview, Tree Complete, Turbo Prompt contracts + trust boundaries
- [x] Specify fixed Align/Drift adapters + bounded typed RPC
- [x] Package Align/Drift static views
- [x] Package Preview snapshots into one project-selecting static view
- [x] Adapt Turbo Prompt to host-bound project analysis
- [x] Expose Tree Complete as a project-bound embedded service + static client
- [x] Register local ecosystem config; run native + host + browser gates
- [x] Adversarial review, cleanup, scoped commits

### Integration invariants

- Static plugin iframe remains opaque-origin + networkless; manifest capability = sole data authority.
- Native executable/module authority comes only from canonical host config; plugin input never selects
  executable, project root, data root, command, model, or runner mode.
- `tree-complete.createFork` always crosses a trusted host confirmation immediately before dispatch.
- Default Tree Complete mode mutates only host-owned simulation state; project files/Git remain
  unchanged. Codex mode remains explicit configuration + requires a committed project manifest.

## Next - evidence-led ecosystem use

- [x] Register every sibling checkout as a project-rail terminal/Codex root while loading its built
      plugin output independently.
- [ ] Dogfood each view against real repository tasks; record observed friction before extending the
      host or plugin protocol.
- [ ] Keep API 1.0 stable; add host authority only for a bounded usage-backed operation that cannot
      remain inside a static project view.

## Frontier durable execution

- [x] Boundary allocation → TypeScript/Bun UI, Kotlin/Restate policy, Rust effects, Quint model
- [x] Model commit ambiguity + retry exhaustion/pause/resume; gate with named traces/simulation/TLC
- [x] Build UUID/request-bound Rust receipt ledger + strict loopback protocol
- [x] Build Kotlin workflow + cross-language receipt validation
- [x] Kill workflow endpoint after executor commit → restart/replay/attach full-chain proof
- [x] Pin formal binaries, Gradle distribution/dependencies/artifacts, Cargo graph, Restate config
- [ ] Migrate `align.status` as the first real fixed bounded operation; preserve plugin API
- [ ] Define `slide-gen` deck/render operation identity + publication receipt before integration

### Frontier invariants

- One operation UUID permanently binds one canonical request; UUIDs are never reused.
- One committed immutable result receipt; physical attempts may repeat and be discarded.
- Ambiguous transport/process failure remains retryable; only validated stable rejection terminates.
- Raw Restate invocation ingress = private Unix socket; browser traffic must cross Bun auth/origin/CSRF.
- Restate completion retention = 30 days; executor receipt retention = indefinite.
- Existing Bun production behavior remains unchanged until a real adapter passes equivalent gates.
