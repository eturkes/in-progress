# Project memory

- Product name = in-progress.
- Architecture = pinned Bun/TypeScript service + React/Vite PWA; each Terminal gets an explicitly
  named zmx 0.7+ daemon/PTY, bridged by a Bun PTY. Names encode config/project/session ownership;
  in-progress shutdown detaches and startup recovers live sessions from the shared zmx namespace.
- Remote boundary = loopback service behind Tailscale Serve HTTPS; public/LAN binding is outside the safe default.
- Plugin v1 = sandboxed frontend iframe + MessageChannel RPC. Installing a manifest path explicitly grants only its declared capabilities; entry bytes require a live host session, while explicit non-entry `assets` are public for opaque-origin CORS; host fixes project context per frame. Opaque origin protects host integrity, not confidentiality of granted data: iframe self-navigation can disclose it.
- Runtime state = project-local ignored `.data/in-progress.db` plus integration-owned subtrees; no cloud account or external database.
- Ecosystem plugins = pinned `plugins/{align,drift,preview,tree-complete,turbo-prompt}` Git
  submodules. Static views stay separate; privileged Align/Drift/Tree operations use named host
  adapters, never a generic plugin backend. Align Python/project imports are isolated; Tree fork
  inputs are validated, then mode/ID-specific trusted-host confirmation gates dispatch.
  `.tree-complete/project.json` owns in-progress's strict project decision model. Codex startup
  preflights its exact raw committed `HEAD`; Tree's worst-case fork admission preserves all readable
  history below the shared 4 MiB response boundary and rejects before over-budget reservation.
- Ecosystem `pluginDirectories` install built views; `projects` separately register every submodule
  as a terminal/Codex root. Product source + native gates remain owned by each submodule. Preview
  receives explicit project ID→source mappings; its aggregate gate requires the `in-progress`
  dashboard. Host `project.tree` lists nested Git roots without traversing their contents.
- Frontier lab = isolated Kotlin/Restate workflow → Rust effect executor → SQLite immutable receipt,
  modeled in Quint/TLC. Honest guarantee = one UUID/request-bound committed result, not one physical
  attempt. Full gate crashes Kotlin after executor commit and requires replayed Restate completion.
  Formal/Gradle tool state stays ignored under `.data/frontier`; production Bun routes are unchanged.
- Self-hosted Restate raw HTTP ingress reflects browser origins and has no caller auth → frontier
  ingress is Unix-only. Any future browser operation must cross the existing Bun auth/origin/CSRF gate.
- Frontier first real migration target = read-only `align.status`. `slide-gen` stays external until
  deck/render operation identity + publication receipt semantics are specified.
- Preview authoring = fixed ChatGPT-authenticated `gpt-5.6-sol`/`max` read-only Codex CLI. Manual or
  clean-commit automatic policy + bounded per-project prompt live in host SQLite; default update passes
  the prior validated model explicitly, while fresh omits it. Models/bundles/records/aggregate live at
  configured external artifact root (`~/.local/share/in-progress/preview` in ecosystem config), required
  disjoint from every project and committed to a standalone local Git repository with no remote/push.
  Preview integration automatically installs the artifact root's `in-progress-plugin` child, so
  generation status + served iframe share one package. Preview iframe remains capability-free; private
  aggregate index + generation record own status. Plugin init retries one nonce across bounded ports;
  dev `/sw.js` proxies the PWA dev worker so installed production clients cannot pin stale host code.
