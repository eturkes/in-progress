# Frontier durable execution lab

Isolated vertical slice for the next execution architecture. The production Bun server, PTYs, and
plugins remain unchanged; `ProbeWorkflow` proves the durable boundary before a real integration is
migrated.

## Language ownership

| Boundary                             | Owner            | Reason                                                                   |
| ------------------------------------ | ---------------- | ------------------------------------------------------------------------ |
| Browser host, plugins, local API     | TypeScript + Bun | Existing web/runtime boundary; direct platform fit                       |
| Durable workflow policy              | TypeScript + Bun | Restate journal without a second policy language or VM                   |
| Native effects, process/artifact I/O | Rust             | Small auditable authority surface + explicit transactional I/O           |
| Lifecycle model                      | Quint + TLC      | Executable cross-language state machine + exhaustive finite safety check |

## Topology

```text
HTTP client
   │ workflow UUID + ProbeInput
   ▼
Restate 1.7.3 ── durable journal / retry / pause / 30-day completion retention
   │ private invocation socket: .data/frontier/restate/frontier-local/ingress.sock
   │ service protocol, loopback
   ▼
Bun/TypeScript workflow endpoint + Restate SDK 1.16.5
   │ strict bounded operation request, loopback
   ▼
Rust executor ── SQLite IMMEDIATE transaction ── immutable keyed receipt
```

The executor, fabric, admin, and workflow listeners are loopback-only; invocation ingress is a Unix
socket below mode-0700 state because self-hosted Restate's HTTP ingress does not provide
browser-origin or caller authentication. The executor accepts one fixed operation kind; it is not a
generic command runner. Its direct parent and database deny group/other access. This is a same-user
local boundary, not isolation from hostile processes running as the same OS user. A future Bun route
may proxy a fixed operation after its existing session/origin/CSRF checks; the raw ingress socket
stays private.

## Guarantee

The slice guarantees **at most one committed receipt for one operation UUID and canonical
request**, not one physical process attempt:

- a versioned SHA-256 request hash permanently binds UUID → semantic request;
- one SQLite transaction writes the probe result and immutable receipt;
- same UUID + same request replays that receipt; changed request returns `409` without mutation;
- TypeScript accepts a receipt only when operation ID, value, and `SHA-256(UTF-8(value))` agree;
- an executor commit followed by orchestrator death converges through Restate retry + executor replay.

`replayed` is transport metadata and is not part of the immutable receipt. The current “effect” is
only the committed probe row. A real adapter must place its externally visible result inside this
transactional boundary or publish a key-addressed immutable artifact before claiming the same
guarantee. Duplicate discarded physical attempts may still occur.

The Quint model covers admitted successful requests, retry-window exhaustion, pause/resume, crashes
before commit, and crashes after commit but before workflow journaling. Stable invalid-input and
UUID-conflict rejections are protocol checks outside that success model. Its three-attempt window is
a finite-state abstraction of the configured runtime limit, not a literal conformance value. TLC
proves that abstract machine; Rust/TypeScript/unit/subprocess gates supply implementation evidence, not
a machine-checked refinement proof. Restate pauses after 70 failed run attempts; an operator may
resume. Workflow completion/journal/idempotency retention is 30 days, while executor receipts
persist indefinitely. Operation UUIDs must never be reused.

## Gates

Prerequisites: Linux x86-64, Rust/Cargo `1.97.1`, Node 24+, pnpm `11.21.0`, and the
repository-pinned Bun. `pnpm install` installs the Restate server, TypeScript SDK, and Quint. The
formal gate downloads checksum-pinned Apalache `0.56.1` and Quint evaluator `0.6.0` into ignored
`.data/frontier/`.

```sh
pnpm check:frontier
```

Sub-gates:

```sh
pnpm frontier:config       # exact Restate config parses
pnpm frontier:model        # typecheck + named traces + deterministic simulation + TLC
pnpm frontier:orchestrator # TypeScript contract tests
pnpm frontier:executor     # rustfmt + clippy + unit/concurrency/crash tests
pnpm frontier:e2e          # three-process commit→halt→replay recovery
```

The E2E gate requires ports `4319`, `5122`, `9070`, and `9080` to be free. It builds both
services, creates private temporary state, registers the endpoint, kills the Bun workflow endpoint immediately after
the executor commit, restarts it, checks Restate completion/attach equality, exercises replay and
conflict, then removes all children and state. The crash hook is startup-only and active solely when
`IN_PROGRESS_FRONTIER_CRASH_AFTER_EXECUTOR=1` is set.

## Scope closure

This lab owns one probe only. It does not duplicate a production integration. Production adapters
stay on Bun unless an operation needs a durable journal and can place its externally visible result
inside the Rust receipt boundary. Slide Gen remains a production MoonBit adapter with its own
validated publication receipts; it does not use this probe workflow.
