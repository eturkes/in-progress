import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/server/config";
import { IntegrationRegistry } from "../src/server/integrations";
import { ProjectRegistry } from "../src/server/projects";
import { TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES } from "../src/server/tree-complete";
import { validatePlugin } from "./validate-plugin";

const hostRoot = resolve(import.meta.dir, "..");
const pluginsRoot = resolve(hostRoot, "plugins");
const checkouts = {
  align: resolve(pluginsRoot, "align"),
  drift: resolve(pluginsRoot, "drift"),
  preview: resolve(pluginsRoot, "preview"),
  "tree-complete": resolve(pluginsRoot, "tree-complete"),
  "turbo-prompt": resolve(pluginsRoot, "turbo-prompt"),
} as const;
const projectSources = [
  ["in-progress", hostRoot],
  ["align", checkouts.align],
  ["drift", checkouts.drift],
  ["preview", checkouts.preview],
  ["tree-complete", checkouts["tree-complete"]],
  ["turbo-prompt", checkouts["turbo-prompt"]],
] as const;
const treePnpm = ["pnpm", "dlx", "pnpm@10.34.5"] as const;
const treePnpmEnv = { npm_config_manage_package_manager_versions: "false" } as const;

const installs = [
  {
    label: "Tree Complete dependencies",
    cwd: checkouts["tree-complete"],
    argv: [...treePnpm, "install", "--ignore-workspace", "--frozen-lockfile"],
    env: treePnpmEnv,
  },
  {
    label: "Turbo Prompt dependencies",
    cwd: checkouts["turbo-prompt"],
    argv: ["npm", "ci"],
    env: {},
  },
] as const;

const builds = [
  {
    label: "Drift",
    cwd: checkouts.drift,
    argv: ["cargo", "build", "--release", "--locked"],
    env: {},
  },
  {
    label: "Preview",
    cwd: checkouts.preview,
    argv: [
      resolve(checkouts.preview, "bin/preview"),
      "plugin-build",
      ...projectSources.flatMap(([id, path]) => ["--source", id, path]),
    ],
    env: {},
  },
  {
    label: "Turbo Prompt",
    cwd: checkouts["turbo-prompt"],
    argv: ["npm", "run", "build"],
    env: {},
  },
  {
    label: "Tree Complete",
    cwd: checkouts["tree-complete"],
    argv: [...treePnpm, "build"],
    env: treePnpmEnv,
  },
] as const;

const pluginRoots = [
  resolve(checkouts.align, "plugin"),
  resolve(checkouts.drift, "plugin"),
  resolve(checkouts.preview, "dist/in-progress-plugin"),
  resolve(checkouts["tree-complete"], "dist/plugin"),
  resolve(checkouts["turbo-prompt"], "dist"),
];

for (const root of Object.values(checkouts)) {
  if (!existsSync(resolve(root, ".git"))) {
    throw new Error(`Plugin submodules missing → run git submodule update --init --recursive`);
  }
}

for (const step of [...installs, ...builds]) {
  console.log(`→ ${step.label}: ${step.argv.join(" ")}`);
  const child = Bun.spawn([...step.argv], {
    cwd: step.cwd,
    env: { ...process.env, ...step.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${step.label} failed (${exitCode})`);
}

const embeddedModulePath = resolve(checkouts["tree-complete"], "dist/server/server/embedded.js");
const embedded = (await import(`${pathToFileURL(embeddedModulePath).href}?ecosystem-build`)) as {
  TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES?: unknown;
  createEmbeddedService?: unknown;
  preflightProjectManifest?: unknown;
};
if (typeof embedded.createEmbeddedService !== "function") {
  throw new Error("Tree Complete embedded service export is missing");
}
if (typeof embedded.preflightProjectManifest !== "function") {
  throw new Error("Tree Complete committed-manifest preflight export is missing");
}
if (embedded.TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES !== TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES) {
  throw new Error("Tree Complete public-response byte contract is incompatible");
}

const plugins = [];
for (const root of pluginRoots) {
  const plugin = await validatePlugin(root);
  plugins.push(plugin);
  console.log(`✓ ${plugin.manifest.id}@${plugin.manifest.version}: ${root}`);
}

const preview = plugins.find((plugin) => plugin.manifest.id === "preview");
if (!preview) throw new Error("Preview plugin is missing");
const previewEntry = await readFile(preview.entry, "utf8");
const previewMarker = '<script id="preview-plugin-data" type="application/json">';
const previewStart = previewEntry.indexOf(previewMarker);
const previewEnd = previewEntry.indexOf("</script>", previewStart + previewMarker.length);
if (previewStart < 0 || previewEnd < 0) {
  throw new Error("Preview plugin dashboard data is missing");
}
let dashboards: unknown;
try {
  dashboards = JSON.parse(
    previewEntry.slice(previewStart + previewMarker.length, previewEnd),
  ) as unknown;
} catch {
  throw new Error("Preview plugin dashboard data is malformed");
}
if (
  typeof dashboards !== "object" ||
  dashboards === null ||
  !Object.hasOwn(dashboards, "in-progress")
) {
  throw new Error("Preview plugin omits the required in-progress dashboard");
}
console.log("✓ Preview dashboard: in-progress");

const config = await loadConfig(resolve(hostRoot, "in-progress.ecosystem.config.json"));
console.log("✓ ecosystem config: canonical paths and executable authority");

const smokeData = await mkdtemp(resolve(tmpdir(), "in-progress-tree-smoke-"));
const smokeProjects = new ProjectRegistry(config.projects);
const smokeIntegrations = new IntegrationRegistry(config.integrations, smokeProjects, smokeData);
try {
  for (const project of config.projects) {
    await smokeIntegrations.dispatch(project.id, "tree-complete.workspace", undefined);
    console.log(`✓ Tree Complete host DTO: ${project.id}`);
  }
} finally {
  await smokeIntegrations.close();
  await rm(smokeData, { recursive: true, force: true });
}
