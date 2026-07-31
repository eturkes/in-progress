# Switchyard roadmap

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
