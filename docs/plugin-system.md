# Plugin system v1

A Switchyard plugin is a **static project view**, not an in-process module. It may use any frontend stack and live in a separate repository. Installation is an explicit local-directory configuration; Switchyard executes no package manager, build hook, server, or plugin backend.

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
├── switchyard.plugin.json
├── index.html
└── assets/
    └── app.js
```

Reference that directory from Switchyard configuration:

```json
{
  "pluginDirectories": [
    "/home/me/Projects/switchyard-project-map/dist",
    "/home/me/Projects/switchyard-plugins"
  ]
}
```

Each configured path may itself contain `switchyard.plugin.json`; otherwise Switchyard scans its immediate child directories/symlinks as plugin roots. It does not recurse further. Paths are resolved relative to the config file, canonicalized, and must exist. Restart Switchyard after changing manifests/assets.

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

Unknown fields fail validation. `terminal` is reserved for the built-in host view. A future incompatible host protocol receives a new API version; plugins must never infer compatibility from Switchyard’s application version.

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
  type: "switchyard:init",
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

`@switchyard/plugin-sdk` implements handshake, version/capability checks, 15-second RPC timeouts, disposal, and typed context:

```ts
import { connectSwitchyard } from "@switchyard/plugin-sdk";

const host = await connectSwitchyard();
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
pnpm --dir /absolute/path/to/switchyard build:sdk
pnpm add file:/absolute/path/to/switchyard/packages/plugin-sdk
```

Keep emitted asset URLs relative to the plugin root and list every emitted file other than the entry in `assets`. Vite plugins use `defineConfig({ base: "./" })`; its default root-absolute `/assets/*` targets the Switchyard host instead and is blocked by plugin CSP. A single-file HTML build avoids both path and opaque-frame extension failures.

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

Traversal does not descend into symlinks and excludes `.git`, `.data`, `node_modules`, `dist`, and `coverage`.

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

## Compatibility rules

- Host and plugin must agree on API `1.0`; fail closed otherwise.
- Additive optional context/status fields may appear within v1; ignore unknown non-security data.
- Capability names and method semantics remain stable for the v1 lifetime.
- New authority always requires a new manifest capability and host enforcement.
- A plugin never receives an arbitrary filesystem root, terminal object, auth credential, CSRF token, or raw network primitive.
- Backend/process plugins are outside v1. Add them only with a separate OS sandbox and protocol design.
