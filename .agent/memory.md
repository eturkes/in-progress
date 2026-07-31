# Project memory

- Product name = Switchyard.
- Architecture = pinned Bun/TypeScript service + React/Vite PWA; Bun native PTYs persist independently of browser views.
- Remote boundary = loopback service behind Tailscale Serve HTTPS; public/LAN binding is outside the safe default.
- Plugin v1 = sandboxed frontend iframe + MessageChannel RPC. Installing a manifest path explicitly grants only its declared capabilities; entry + explicit `assets` are the only public files; host fixes project context per frame. Opaque origin protects host integrity, not confidentiality of granted data: iframe self-navigation can disclose it.
- Runtime state = project-local ignored `.data/switchyard.db`; no cloud account or external database.
