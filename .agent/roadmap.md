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

- Project switch/browser reload/in-progress restart never destroys a live zmx PTY; reattach restores
  terminal state + bounded host replay. Explicit Terminal deletion owns zmx termination.
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

- [x] Pin every plugin repository as a submodule + register each as a project-rail terminal/Codex
      root while loading its built output independently.
- [ ] Dogfood each view against real repository tasks; record observed friction before extending the
      host or plugin protocol.
- [ ] Keep API 1.0 stable; add host authority only for a bounded usage-backed operation that cannot
      remain inside a static project view.

## Preview create/update action

- [x] Move generated dashboard state behind a configured host-owned artifact root outside target repos.
- [x] Add fixed Preview status/generate authority; pin subscription Codex to `gpt-5.6-sol` + `max`.
- [x] Render one Preview action as Generate when absent, Update when published; track async completion.
- [x] Atomically rebuild/reload the aggregate without mutating the selected project checkout.
- [x] Cover config, authority, concurrency, failure preservation, plugin runtime, and end-to-end routing.
- [x] Run Preview + host gates, browser QA, adversarial review, cleanup, and scoped commits.

### Preview invariants

- Selected project path = read-only source; generated/staged/plugin artifacts remain outside it.
- Browser confirmation immediately precedes each token-spending generation request.
- Model = `gpt-5.6-sol`; reasoning effort = `max`; authenticated local Codex CLI = sole provider path.
- One project operation at a time; prior published dashboard survives generation/validation failure.

## Preview commit lifecycle

- [x] Evolve a validated prior dashboard by default; explicit fresh regeneration omits prior context.
- [x] Accept one bounded Preview-specific prompt reused by manual + automatic runs.
- [x] Persist per-project manual/automatic policy; automatic mode reacts only to clean new Git commits.
- [x] Suppress repeat automatic spending after a failure at the same commit; retry on a new commit or
      explicit manual action.
- [x] Initialize the external artifact root as a local-only Git repository; snapshot validated bundles,
      generation records, and aggregate output while excluding locks/stages/backups.
- [x] Add trusted responsive controls + paid-boundary disclosures for update, fresh, and ongoing auto.
- [x] Run Preview + host gates, desktop/mobile browser QA, adversarial review, cleanup, and scoped commits.

### Commit-lifecycle invariants

- Incremental context = prior validated declarative model + recorded source commit; fresh = current source
  alone. Both publish atomically only after deterministic validation.
- Automatic authorization is explicit and durable; dirty worktrees wait, unchanged/failed commits do not
  spend again, and restart resumes comparison from artifact metadata + host policy.
- Artifact Git has no configured remote and receives no push; target project repositories remain untouched.
- Codex app-server remains outside this bounded batch path: experimental persistent threads add global
  state/authority without improving commit detection, schema validation, or atomic publication.

## Preview publication visibility repair

- [x] Trace generated bundle → aggregate record → host status → served iframe bytes.
- [x] Derive the installed Preview package from the integration artifact root; deduplicate exact config.
- [x] Retry nonce-bound iframe initialization across remount races; retain one accepted MessagePort.
- [x] Let stale production workers migrate through the canonical development proxy without intercepting
      API or plugin documents.
- [x] Run host gates, live initial/remount browser QA, cleanup, and scoped commit.

### Visibility invariants

- Preview status + iframe package share `artifactDirectory/in-progress-plugin`; configuration cannot
  silently report a newer bundle than the one served.
- Handshake retries remain bounded, reuse one nonce, and close every unaccepted port.
- Development worker navigation handles only `/` + `/p/*`; `/api/*` + `/plugins/*` remain live network
  boundaries.

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
