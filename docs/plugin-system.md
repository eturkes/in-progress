# Plugin system v1

An in-progress plugin is a **static project view**, not an in-process module. It may use any frontend stack and live in a separate repository. Installation is an explicit local-directory configuration; in-progress executes no package manager, build hook, server, or plugin backend.

```text
plugin iframe (opaque origin)
      │ typed request / response / status
      │ dedicated MessagePort
      ▼
trusted React host
      │ validates method + declared capability
      │ fixes selected project in the route
      ▼
Bun host API ── canonical project root / Git / notifications
```

## Repository output and installation

Build the plugin repository to a self-contained static directory:

```text
dist/
├── in-progress.plugin.json
├── index.html
└── assets/
    └── app.js
```

Reference that directory from in-progress configuration:

```json
{
  "pluginDirectories": [
    "/home/me/Projects/in-progress-project-map/dist",
    "/home/me/Projects/in-progress-plugins"
  ]
}
```

Each configured path may itself contain `in-progress.plugin.json`; otherwise in-progress scans its immediate child directories/symlinks as plugin roots. It does not recurse further. Paths are resolved relative to the config file, canonicalized, and must exist. Restart in-progress after changing manifests/assets.

`integrations.preview.artifactDirectory` additionally installs its `in-progress-plugin` child. An
identical explicit `pluginDirectories` entry is deduplicated; the integration-owned package prevents
generation metadata and the served Preview iframe from resolving to different artifact trees.
Development exposes a narrow PWA worker for `/` + `/p/*`, allowing an installed production worker to
update without intercepting `/api/*` or `/plugins/*`.

At startup the registry:

1. validates every manifest strictly;
2. rejects duplicate plugin IDs;
3. requires `entry` to be a top-level HTML filename;
4. resolves the entry and requires a regular file inside the canonical plugin root;
5. resolves each explicitly declared asset and requires a regular file inside that root;
6. treats adding the directory as consent to all declared capabilities.

`/plugins/<plugin-id>/` serves the entry. Only paths listed in `assets` are otherwise public; the manifest, repository metadata, source files, environment files, and undeclared build output are not served. Asset requests reject malformed encoding, hidden/path-traversal segments, absolute paths, symlink escapes, missing paths, and non-files.

The in-tree `examples/plugins/project-map` is the protocol reference. Validate a new build with:

```sh
pnpm plugin:validate -- /absolute/path/to/plugin/dist
```

The validator also requires unique capabilities, an HTML entry document, at most 20,000 assets, and no dangling/escaping asset symlinks.

## Manifest

```json
{
  "apiVersion": "1.0",
  "id": "project-map",
  "name": "Project map",
  "version": "1.0.0",
  "description": "Project structure and Git pulse",
  "entry": "index.html",
  "assets": [],
  "icon": "git-branch",
  "capabilities": ["project.metadata", "project.tree", "project.git"]
}
```

| Field          | Contract                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- |
| `apiVersion`   | Required literal `"1.0"`                                                                  |
| `id`           | Required; `^[a-z][a-z0-9-]{1,62}$`; globally unique                                       |
| `name`         | Required; 1–48 characters                                                                 |
| `version`      | Required SemVer-like `x.y.z` with optional prerelease                                     |
| `description`  | Required; at most 180 characters                                                          |
| `entry`        | Required top-level `.html`/`.htm` filename; 1–240 characters                              |
| `assets`       | Optional unique public relative-file allowlist; at most 20,000; default empty             |
| `icon`         | Optional: `blocks`, `chart`, `files`, `git-branch`, `globe`, `sparkles`; default `blocks` |
| `capabilities` | Optional unique intent list; at most 16; default empty                                    |

Unknown fields fail validation. `terminal` is reserved for the built-in host view. A future incompatible host protocol receives a new API version; plugins must never infer compatibility from in-progress’s application version.

## Isolation

The entry URL is same-origin at the URL layer, but the host embeds it with:

```html
<iframe sandbox="allow-scripts" src="/plugins/project-map/"></iframe>
```

Plugin HTTP responses independently enforce:

```text
default-src 'none';
script-src <public-origin>/plugins/<plugin-id>/ 'unsafe-inline';
style-src <public-origin>/plugins/<plugin-id>/ 'unsafe-inline';
img-src <public-origin>/plugins/<plugin-id>/ data:;
font-src <public-origin>/plugins/<plugin-id>/;
connect-src <public-origin>/plugins/<plugin-id>/;
worker-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
frame-ancestors 'self';
sandbox allow-scripts
```

Because `allow-same-origin` is absent, HTML assigns the child a unique opaque origin. The plugin cannot read host DOM, cookies, local storage, service workers, API responses, terminal keystrokes, or another plugin. CSP limits script/style/image/font/connect requests to that plugin's canonical static URL prefix; this permits declared same-plugin asset fetches while blocking external endpoints and host APIs. Inline script/style is also allowed: installation already trusts that code with its declared capabilities, while the opaque-origin sandbox protects the host. Plugin document responses use an explicit URL because `'self'` would not match from the effective opaque origin. Declared non-document assets are intentionally public and use wildcard CORS/CORP so ES modules load from the serialized opaque origin (`Origin: null`). Declared HTML/SVG/XML/PDF assets retain the sandbox policy if navigated directly; API responses never receive plugin CORS grants. The [HTML Standard sandbox model](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox) defines this behavior.

Package the entry as one self-contained HTML file when possible. Some privacy and wallet extensions block subresource requests from opaque-origin frames; inline bundles avoid that browser-profile dependency. Static relative assets remain supported. Workers, nested frames, forms, popups, downloads, and top navigation are unavailable. Host RPC is the only authority to host/project data. This is not a confidentiality sandbox once a capability returns data: browser CSP does not restrict document navigation, so malicious plugin code can navigate its own frame to an external URL containing that data. Installation therefore requires trusting the plugin with every declared capability.

## Handshake

The host creates one `MessageChannel` per plugin frame/project and sends one initialization message with a transferred port:

```ts
{
  type: "in-progress:init",
  nonce: string,
  context: {
    apiVersion: "1.0",
    capabilities: Capability[],
    project: {
      id: string,
      name: string,
      color: string,
      available: boolean
    },
    theme: {
      mode: "dark" | "light",
      tokens: Record<string, string>
    }
  }
}
```

An opaque-origin child cannot be addressed with a useful fixed `targetOrigin`, so the host uses the iframe’s exact `contentWindow`, transfers a fresh port, and treats the random nonce echoed on that port as readiness proof. The plugin must accept initialization only when `event.source === window.parent`, type/version match, and one port exists; then reply:

```ts
port.postMessage({ kind: "ready", nonce });
```

The initialization context exposes only the identity needed to label the selected project. Path and Git metadata require `project.metadata`. The host ignores window-level RPC and closes a channel on timeout, navigation, project change, or frame disposal. A navigated frame is rejected instead of receiving a replacement port; plugins implement view changes without document navigation. A `MessagePort` is a two-ended capability; see the [HTML Standard’s channel messaging model](https://html.spec.whatwg.org/multipage/web-messaging.html#channel-messaging).

## SDK

`@in-progress/plugin-sdk` implements handshake, version/capability checks, disposal, typed context,
15-second ordinary RPC deadlines, a 75-second `drift.importSession` deadline, and the fixed 21-minute
`drift.analyze` deadline:

```ts
import { connectInProgress } from "@in-progress/plugin-sdk";

const host = await connectInProgress();
const [project, tree, git] = await Promise.all([
  host.call("project.metadata"),
  host.call("project.tree", { depth: 4, limit: 800 }),
  host.call("project.git"),
]);

render({ project, tree, git, theme: host.context.theme });
host.setStatus({ state: "idle", badge: null, title: "Project map" });
```

Separate repositories may consume the built package, copy its generated declarations, or implement the small language-neutral wire contract. Do not import host application internals.

For an unpublished local checkout, build the SDK once and link it from the plugin repository:

```sh
pnpm --dir /absolute/path/to/in-progress build:sdk
pnpm add file:/absolute/path/to/in-progress/packages/plugin-sdk
```

Keep emitted asset URLs relative to the plugin root and list every emitted file other than the entry in `assets`. Vite plugins use `defineConfig({ base: "./" })`; its default root-absolute `/assets/*` targets the in-progress host instead and is blocked by plugin CSP. A single-file HTML build avoids both path and opaque-frame extension failures.

Raw requests and responses on the port:

```ts
// plugin → host
{ kind: "request", id: crypto.randomUUID(), method, params }

// host → plugin
{ kind: "response", id, ok: true, result }
{ kind: "response", id, ok: false, error: "safe message" }

// plugin → host UI; no capability required
{ kind: "event", name: "status", payload: { state, badge, title } }
```

`state` is `idle | busy | attention | error`; `badge` and `title` are nullable strings. The host bounds badges to 8 characters, titles to 80 characters, and request IDs to 128 characters. Unknown events/messages are ignored. Every request ID must be unique among pending calls. A frame may have at most eight in-flight calls and make 40 calls per ten seconds.

## Capabilities and methods

The host checks that `method` appears in the installed manifest on every call. It also fixes `projectId` from the frame context; plugin input cannot redirect a request to another configured project.

### `project.metadata`

Permission: `project.metadata`. No parameters. Returns the initialized project DTO:

```ts
{
  (id, name, displayPath, color, branch, available);
}
```

### `project.tree`

Permission: `project.tree`.

```ts
{ depth?: 1..6, limit?: 1..2000 } // defaults: 4, 800
```

Returns ordered entries:

```ts
{
  path: string;                     // slash-separated, project-relative
  name: string;
  kind: "directory" | "file" | "symlink";
  depth: number;                    // root children = 0
  size?: number;                    // files only
}[]
```

Traversal does not descend into symlinks or nested Git repositories/worktrees and excludes `.git`, `.data`, `node_modules`, `dist`, and `coverage`.

### `project.readText`

Permission: `project.readText`.

```ts
{
  path: string;
} // relative; 1–1024 characters
```

The host resolves the canonical file, rejects project-root escapes and non-regular/binary files, and returns at most 256 KiB:

```ts
{ path: string, text: string, truncated: boolean }
```

This capability can expose source, credentials, and ignored files inside the project. Declare it only when the view genuinely needs content; never forward results to notifications.

### `project.git`

Permission: `project.git`. No parameters. Returns a three-second bounded `git status --porcelain=v2` summary:

```ts
{
  available: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  clean: boolean;
}
```

`available: false` means Git could not return a verified bounded status; counters are zero and
`clean` remains false rather than claiming a clean worktree.

### `host.notify`

Permission: `host.notify`.

```ts
{
  kind?: "needs-input" | "completed" | "failed" | "system";
  title: string;  // trimmed, 1–100
  body?: string;  // trimmed, ≤240
  url?: string;   // root-relative, ≤300
}
```

The host overwrites `projectId` with the bound project, stores the event, updates foreground clients, and sends Web Push. Notification text leaves the machine as an encrypted Web Push payload and may appear on a lock screen; combining this capability with a read capability can disclose returned content. Keep repository secrets out.

### `align.status`

Permission: `align.status`. Requires the trusted host-side Align integration. No parameters. The
host runs one fixed, read-only `align status --format json` command against the frame-bound project,
using isolated Python and a fixed trusted Align source. It validates schema v1, removes
history/source payloads and canonical host paths, then returns:

```ts
{
  initialized: boolean;
  contract: {
    state: "missing" | "ambiguous" | "provisional" | "accepted";
    id: string | null;
  };
  latest: {
    stage: "pre_task" | "in_progress" | "candidate_final" | "released" | null;
    assessmentCount: number;
    reportCount: number;
  };
  totals: {
    amendments: number; assessments: number; checkpoints: number;
    contracts: number; reports: number; snapshots: number;
  };
  nextAction: { command: string; reason: string } | null;
}
```

The plugin cannot select a root, executable, argument, model, or mutating Align command. Exact
prompts, clauses, evidence, assessments, history, and reports remain outside this capability.

### Host-owned Alignment setup

Alignment's static iframe retains only `align.status`; trusted React chrome owns **Set up
Alignment**. `GET /api/projects/:id/alignment` supplies the same projected status to that chrome.
After the user enters the exact initiating intent, a trusted confirmation names the selected
project/root, `.align` write, immutable intent, initial `in_progress` snapshot, and absence of model or
external-service use. Only then does the CSRF-protected POST accept:

```ts
{
  prompt: string; // exact nonblank UTF-8 text, ≤60,000 encoded bytes
}
```

The host fixes canonical project root/name, configured Align source/Python, `user` authority,
`in_progress` stage, every argument, timeout, and output bound. Prompt text crosses stdin and never
argv. Python runs `-I -B -S` from the trusted Align checkout with a sanitized environment, so the
selected repository supplies neither imports nor startup hooks. One setup per canonical project path
is admitted at a time—even when config IDs alias it; verified initialized state rejects the operation
before invocation. Native Align
immutability remains the final race-safe boundary, and the host accepts success only after a fresh
schema-validated status reports `initialized: true`. The successful response contains projected
status—not the intent—and remounts the read-only iframe.

Align owns the on-disk transaction. A native crash or forced timeout can leave fail-closed partial
`.align` state; the host never deletes, replaces, or guesses how to repair it. Inspect that state in
the project before any manual recovery.

### `drift.validateTraces`

Permission: `drift.validateTraces`. Requires the trusted host-side Drift integration; read-only and
does not contact a model.

```ts
{
  paths: string[]; // 1–32 unique project-relative `.jsonl` candidates
}

// response
{
  paths: string[]; // ordered subset accepted by native `drift validate`
}
```

The server canonicalizes every candidate to a regular file beneath the frame-bound project and runs
fixed, isolated, five-second native validation in groups of four. It returns paths only—never trace
contents or validator diagnostics. Plugins use this result to prevent arbitrary JSONL, Align
journals, and raw Codex streams from enabling analysis.

### `drift.recentSessions`

Permission: `drift.recentSessions`. Requires the trusted host-side Drift integration; read-only,
metadata-only, and model-free. Parameters are `undefined`.

```ts
{
  sessions: Array<{
    id: string; // opaque canonical UUID
    startedAt: string;
    updatedAt: string;
    source: string;
    byteSize: number;
  }>;
  truncated: boolean;
}
```

The server scans the configured Codex session root through a fixed year/month/day layout with entry,
file, metadata-line, and 32 MiB source bounds. It rejects symlinks, malformed metadata, subagent
sources, duplicate IDs, and sessions whose recorded cwd does not canonicalize to the selected
project. Up to 20 newest matches are returned without source paths or rollout content.

### `drift.importSession`

Permission: `drift.importSession`. Requires explicit user action and trusted confirmation.

```ts
{
  sessionId: string;
}

// response
{
  path: string; // `.drift/traces/codex-SESSION_ID.drift.jsonl`
  session: {
    id: string;
    startedAt: string;
    updatedAt: string;
    source: string;
    byteSize: number;
  }
}
```

The browser supplies one UUID only. Confirmation names plugin/project/session identity, deterministic
project output, external local-session read, potentially sensitive message/tool evidence, and
local-only/model-free behavior. The server re-discovers the ID under the configured root and exact
project cwd immediately before invocation; source path, executable, adapter, output, environment,
and limits remain host-owned. Native `drift import codex-session` excludes developer/system messages,
compaction payloads, encrypted reasoning, and unrecognized record families; it retains visible
transcript and linked tool evidence without treating Codex completion as task success.

Import writes a random private stage beneath real `.drift/traces/`, natively revalidates it, then
renames it over the deterministic mode-`0600` trace. Failure preserves prior output and removes the
stage. Import and analysis share one canonical-project mutation admission. Analysis remains a
separate confirmation because only that second action discloses trace content to OpenAI.

### `drift.analyze`

Permission: `drift.analyze`. Requires the trusted host-side Drift integration and explicit user
action in the plugin UI.

```ts
{
  path: string;
} // project-relative native `drift.trace/v1` `.jsonl`
```

The trusted host validates this exact request before presenting a confirmation containing stable
plugin/project identity, trace path, deterministic report path, ChatGPT subscription use, OpenAI
disclosure, and project-local create/replace semantics. Cancellation dispatches nothing. Approval
authorizes one CSRF-protected invocation; plugin code cannot preauthorize future runs.

The server canonicalizes and natively prevalidates one regular trace beneath the frame-bound project
before any write, then admits one analysis per canonical project path. It creates only real `.drift/reports/` directories beneath that root,
rejecting symlinks and non-directories, then derives a bounded filename from the trace basename plus
stable path digest. Existing output must be a regular non-symlink file. Executables, root, output,
`gpt-5.6-sol`, two attempts, 600-second attempt deadline, sandbox, arguments, environment,
20.5-minute process deadline, and output limits stay host-fixed. Drift validates before model use, invokes authenticated Codex in
its isolated read-only observer workspace, atomically writes a mode-`0600` self-contained report,
then revalidates it through `drift render` before returning:

```ts
{
  path: string; // derived `.drift/reports/*.drift.json`
  text: string; // native validated rendering
}
```

Trace contents may reach OpenAI and remain embedded in the local report. A browser disconnect does
not cancel an admitted host operation; returning to Drift and rescanning discovers a completed
report. Native failure after directory creation may leave empty `.drift/reports/`; failure after
atomic report publication may leave a valid report discoverable even if the final host response
fails.

### `drift.render`

Permission: `drift.render`. Requires the trusted host-side Drift integration.

```ts
{
  path: string;
} // project-relative `.json` report path
```

The host canonicalizes one regular file inside the frame-bound project, invokes the configured
binary with fixed `drift render <canonical-file>` arguments, and returns at most 1 MiB only after
Drift exits successfully and therefore revalidates the self-contained report:

```ts
{
  path: string;
  text: string;
}
```

Plugins usually combine this with `project.tree` to discover candidate reports. They cannot pass
raw CLI arguments, model options, or paths outside the selected project.

### `tree-complete.workspace`

Permission: `tree-complete.workspace`. Requires the trusted host-side Tree Complete integration.
No parameters. Returns Tree Complete's public workspace document for the frame-bound project. The
host loads the separately built embedded service once per configured project, fixes its target and
private data directory, validates/bounds the JSON response, and removes canonical project,
integration, and data paths.

### `tree-complete.createFork`

Permission: `tree-complete.createFork`. Requires an explicit user action in the plugin UI.

```ts
{
  baseVersionId: string;
  decisionId: string;
  alternativeId: string;
}
```

The host forwards only those three bounded IDs to the project-bound embedded service. `preview`
mode reads repository identity/branch/HEAD, keeps separate host-owned simulation state per project,
and produces a simulated child lineage without changing project files or Git state. `codex` mode
requires a valid committed `.tree-complete/project.json`, may create a Git branch/worktree, change
files, and commit, and runs inherited `codex --yolo exec` unsandboxed as the current OS user. Enable
it only for trusted same-user repositories after reviewing Tree Complete's worktree/agent boundary.
The plugin cannot select the repository, data path, runner mode, executable, prompt, branch name, or
raw command.

Tree Complete and the host share a 4 MiB compact-JSON response contract. Before reservation, the
service projects the candidate plus every active run at their largest permitted terminal state;
`429 workspace_history_limit_reached` therefore preserves the existing readable history instead
of accepting a fork whose eventual response would exceed the host boundary.

Manifest installation is not sufficient consent for this mutation. Before every request, the
trusted React host first validates the parameter object, then displays its own confirmation naming
the plugin/project display names plus stable IDs, configured mode, and escaped immutable fork IDs. Preview wording
discloses host-state simulation; Codex wording discloses unsandboxed OS-user authority. Rejection or
invalid input returns an RPC error without contacting the embedded service; sandboxed plugin code
cannot bypass that host-owned gate. Shutdown drains accepted work; a valid Codex run can hold close
until its 30-minute runner timeout.

### Host-owned Preview generation

Preview's iframe manifest declares no capability. The sandboxed static runtime only selects a
packaged dashboard matching its host-bound project ID. Trusted React host chrome owns the contextual
**Generate Preview** / **Update Preview** button and calls fixed project routes directly; plugin code
cannot originate, alter, or replay this authority through RPC.

Manual POST confirmation names the project, update/fresh strategy, bounded Preview direction, external
destination, ChatGPT-subscription use, `gpt-5.6-sol`, `max`, repair retry, and host-readable-content
disclosure. Enabling automatic mode confirms ongoing spending once; the host then admits one run per
new clean Git commit and suppresses retries for the same failed revision. Repository instructions/skills
remain suppressed while global Codex instructions remain trusted authority. Request bodies can select
only `update|fresh`, the bounded direction, or `manual|automatic`; the server fixes source, executable,
model, effort, sandbox, destination, and remaining argv.

Update supplies the prior validated model path plus recorded source revision to an ephemeral Codex run;
fresh omits both. The server admits one aggregate-changing job globally, polls status, preserves the prior
aggregate on failure, and remounts the no-store iframe only after successful atomic packaging. The
external artifact root is a local-only Git repository containing validated publishes, generation records,
and aggregate output; the tool defines no remote/push path. Dashboard state is derived from a private,
strict, sorted aggregate index rather than untrusted iframe status text.

## Compatibility rules

- Host and plugin must agree on API `1.0`; fail closed otherwise.
- Additive optional init-context/status fields may appear within v1; ignore unknown non-security
  data there. Native-adapter RPC results use exact host schemas and require a coordinated rebuild.
- Capability names and method semantics remain stable for the v1 lifetime.
- New iframe-originated authority always requires a new manifest capability and host enforcement.
- A plugin never receives an arbitrary filesystem root, terminal object, auth credential, CSRF token, or raw network primitive.
- Backend/process plugins are outside v1. Add them only with a separate OS sandbox and protocol design.
- Native integrations are host-owned fixed adapters configured separately from manifests; a plugin
  capability never grants generic process execution.
