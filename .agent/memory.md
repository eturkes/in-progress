# Project memory

- Product name = in-progress.
- Architecture = pinned Bun/TypeScript service + React/Vite PWA; each Terminal gets an explicitly
  named zmx 0.7+ daemon/PTY, bridged by a Bun PTY. Names encode config/project/session ownership;
  in-progress shutdown detaches and startup recovers live sessions from the shared zmx namespace.
- Remote boundary = loopback service behind Tailscale Serve HTTPS; public/LAN binding is outside the safe default.
- Plugin v1 = sandboxed frontend iframe + MessageChannel RPC. Installing a manifest path explicitly grants only its declared capabilities; entry bytes require a live host session, while explicit non-entry `assets` are public for opaque-origin CORS; host fixes project context per frame. Opaque origin protects host integrity, not confidentiality of granted data: iframe self-navigation can disclose it.
- Runtime state = project-local ignored `.data/in-progress.db` plus integration-owned subtrees; no cloud account or external database.
- Ecosystem plugins = pinned `plugins/{align,drift,preview,tree-complete,turbo-prompt,slide-gen}` Git
  submodules. Static views stay separate; privileged Align/Drift/Tree/Slide operations use named host
  adapters, never a generic plugin backend. Align Python/project imports are isolated; Drift analysis
  = host-native-validated + confirmed project trace → host-derived `.drift/reports/` + fixed Codex; Tree fork inputs
  are validated, then mode/ID-specific trusted-host confirmation gates dispatch.
  `.tree-complete/project.json` owns in-progress's strict project decision model. Codex startup
  preflights its exact raw committed `HEAD`; Tree's worst-case fork admission preserves all readable
  history below the shared 4 MiB response boundary and rejects before over-budget reservation.
- `@in-progress/protocol` = sole Zod schema/client owner for manifest, context, RPC, and status.
  `pnpm protocol:sync` regenerates four vendored packages plus three embedded static clients;
  `protocol:check` requires byte identity.
- Ecosystem `pluginDirectories` install built views; `projects` separately register every submodule
  as a terminal/Codex root. Product source + native gates remain owned by each submodule. Preview
  receives explicit project ID→source mappings; its aggregate gate requires the `in-progress`
  dashboard. Host `project.tree` lists nested Git roots without traversing their contents.
- Ecosystem builds use each JavaScript plugin's frozen pnpm 11 workspace policy. Slide Gen hydrates
  its checksum-pinned MoonBit dependency through one non-frozen check, then builds the release with
  `--frozen --deny-warn`.
- Frontier lab = isolated Bun/TypeScript Restate workflow → Rust effect executor → SQLite immutable receipt,
  modeled in Quint/TLC. Honest guarantee = one UUID/request-bound committed result, not one physical
  attempt. Full gate crashes the Bun workflow endpoint after executor commit and requires replayed
  Restate completion. Formal tool state stays ignored under `.data/frontier`; production routes are unchanged.
- Self-hosted Restate raw HTTP ingress reflects browser origins and has no caller auth → frontier
  ingress is Unix-only. Any future browser operation must cross the existing Bun auth/origin/CSRF gate.
- Frontier remains a probe-only lab, not a parallel production path.
- Alignment setup = trusted host chrome accepts one exact bounded initiating intent, confirms the
  project-local write, then invokes fixed isolated Align initialization with prompt on stdin,
  host-owned root/name + `user`/`in_progress`. Existing state rejects; native immutability closes
  races; fresh verified status remounts the still-read-only iframe.
- Preview authoring = fixed ChatGPT-authenticated `gpt-5.6-sol`/`max` read-only Codex CLI. Manual or
  clean-commit automatic policy + bounded per-project prompt live in host SQLite; default update passes
  the prior validated model explicitly, while fresh omits it. Models/bundles/records/aggregate live at
  configured external artifact root (`~/.local/share/in-progress/preview` in ecosystem config), required
  disjoint from every project and committed to a standalone local Git repository with no remote/push.
  Preview integration automatically installs the artifact root's `in-progress-plugin` child, so
  generation status + served iframe share one package. Preview iframe remains capability-free; private
  aggregate index + generation record own status. Plugin init retries one nonce across bounded ports;
  dev `/sw.js` proxies the PWA dev worker so installed production clients cannot pin stale host code.
- Slide Gen = MoonBit generation/render core + vanilla TypeScript plugin. Host fixes source/artifact
  roots, executable/tool paths, argv, environment, deadlines, and per-project admission. Artifacts
  stay under `~/.local/share/in-progress/slide-gen`; host validates deck/render layouts and persists
  atomic operation/hash receipts under `.data/slide-gen/`.
