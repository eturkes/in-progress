# Project memory

- Product name = in-progress.
- Architecture = pinned Bun/TypeScript service + React/Vite PWA; Bun native PTYs persist independently of browser views.
- Remote boundary = loopback service behind Tailscale Serve HTTPS; public/LAN binding is outside the safe default.
- Plugin v1 = sandboxed frontend iframe + MessageChannel RPC. Installing a manifest path explicitly grants only its declared capabilities; entry bytes require a live host session, while explicit non-entry `assets` are public for opaque-origin CORS; host fixes project context per frame. Opaque origin protects host integrity, not confidentiality of granted data: iframe self-navigation can disclose it.
- Runtime state = project-local ignored `.data/in-progress.db` plus integration-owned subtrees; no cloud account or external database.
- Ecosystem plugins = sibling Align/Drift/Preview/Tree Complete/Turbo Prompt repositories. Static
  views stay separate; privileged Align/Drift/Tree operations use named host adapters, never a
  generic plugin backend. Align Python/project imports are isolated; Tree fork inputs are validated,
  then mode/ID-specific trusted-host confirmation gates dispatch. `.tree-complete/project.json` owns
  in-progress's strict project decision model. Codex startup preflights its exact raw committed
  `HEAD`; Tree's worst-case fork admission preserves all readable history below the shared 4 MiB
  response boundary and rejects before over-budget reservation.
- Ecosystem `pluginDirectories` install built views; `projects` separately register every sibling
  checkout as a terminal/Codex root. Product source + native gates remain owned by each sibling.
