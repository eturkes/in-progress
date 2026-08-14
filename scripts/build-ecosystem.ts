import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  "slide-gen": resolve(pluginsRoot, "slide-gen"),
  "tree-complete": resolve(pluginsRoot, "tree-complete"),
  "turbo-prompt": resolve(pluginsRoot, "turbo-prompt"),
} as const;
const projectSources = [
  ["in-progress", hostRoot],
  ["align", checkouts.align],
  ["drift", checkouts.drift],
  ["preview", checkouts.preview],
  ["slide-gen", checkouts["slide-gen"]],
  ["tree-complete", checkouts["tree-complete"]],
  ["turbo-prompt", checkouts["turbo-prompt"]],
] as const;
const previewArtifacts = resolve(homedir(), ".local/share/in-progress/preview");
const slideArtifacts = resolve(homedir(), ".local/share/in-progress/slide-gen");
const slideMoonHome = resolve(checkouts["slide-gen"], ".install/moon");
const slideMoonEnv = {
  MOON_HOME: slideMoonHome,
  PATH: `${resolve(slideMoonHome, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
} as const;
const installs = [
  {
    label: "Slide Gen dependencies",
    cwd: checkouts["slide-gen"],
    argv: ["pnpm", "install", "--frozen-lockfile"],
    env: {},
  },
  {
    label: "Tree Complete dependencies",
    cwd: checkouts["tree-complete"],
    argv: ["pnpm", "install", "--frozen-lockfile"],
    env: {},
  },
  {
    label: "Turbo Prompt dependencies",
    cwd: checkouts["turbo-prompt"],
    argv: ["pnpm", "install", "--frozen-lockfile"],
    env: {},
  },
] as const;

const builds = [
  {
    label: "Slide Gen MoonBit toolchain",
    cwd: checkouts["slide-gen"],
    argv: ["sh", resolve(checkouts["slide-gen"], "tools/moon_toolchain.sh")],
    env: {},
  },
  {
    label: "Slide Gen MoonBit dependency",
    cwd: checkouts["slide-gen"],
    argv: ["sh", resolve(checkouts["slide-gen"], "tools/moon_deps.sh")],
    env: slideMoonEnv,
  },
  {
    label: "Slide Gen MoonBit resolution",
    cwd: checkouts["slide-gen"],
    argv: [resolve(slideMoonHome, "bin/moon"), "check", "--target", "native", "--deny-warn"],
    env: slideMoonEnv,
  },
  {
    label: "Slide Gen native core",
    cwd: checkouts["slide-gen"],
    argv: [
      resolve(slideMoonHome, "bin/moon"),
      "build",
      "--target",
      "native",
      "--release",
      "--frozen",
      "--deny-warn",
    ],
    env: slideMoonEnv,
  },
  {
    label: "Slide Gen plugin",
    cwd: checkouts["slide-gen"],
    argv: ["pnpm", "build:plugin"],
    env: {},
  },
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
      "--artifact-root",
      previewArtifacts,
      "--git-track",
      ...projectSources.flatMap(([id, path]) => ["--source", id, path]),
    ],
    env: {},
  },
  {
    label: "Turbo Prompt",
    cwd: checkouts["turbo-prompt"],
    argv: ["pnpm", "build"],
    env: {},
  },
  {
    label: "Tree Complete",
    cwd: checkouts["tree-complete"],
    argv: ["pnpm", "build"],
    env: {},
  },
] as const;

const pluginRoots = [
  resolve(checkouts.align, "plugin"),
  resolve(checkouts.drift, "plugin"),
  resolve(previewArtifacts, "in-progress-plugin"),
  resolve(checkouts["tree-complete"], "dist/plugin"),
  resolve(checkouts["turbo-prompt"], "dist"),
  resolve(checkouts["slide-gen"], "dist/plugin"),
];

for (const root of Object.values(checkouts)) {
  if (!existsSync(resolve(root, ".git"))) {
    throw new Error(`Plugin submodules missing → run git submodule update --init --recursive`);
  }
}

await mkdir(slideArtifacts, { recursive: true, mode: 0o700 });

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
let previewIndex: unknown;
try {
  previewIndex = JSON.parse(
    await readFile(resolve(previewArtifacts, "in-progress-plugin/preview-index.json"), "utf8"),
  ) as unknown;
} catch {
  throw new Error("Preview plugin index is malformed");
}
if (
  typeof previewIndex !== "object" ||
  previewIndex === null ||
  (previewIndex as { schemaVersion?: unknown }).schemaVersion !== 1 ||
  !Array.isArray((previewIndex as { projects?: unknown }).projects)
) {
  throw new Error("Preview plugin index is incompatible");
}
console.log(`✓ Preview dashboards: ${(previewIndex as { projects: unknown[] }).projects.length}`);

const config = await loadConfig(resolve(hostRoot, "in-progress.ecosystem.config.json"));
console.log("✓ ecosystem config: canonical paths and executable authority");

const smokeData = await mkdtemp(resolve(tmpdir(), "in-progress-tree-smoke-"));
const smokeProjects = new ProjectRegistry(config.projects);
const smokeIntegrations = new IntegrationRegistry(config.integrations, smokeProjects, smokeData);
try {
  for (const project of config.projects) {
    await smokeIntegrations.dispatch(project.id, "tree-complete.workspace", undefined);
    console.log(`✓ Tree Complete host DTO: ${project.id}`);
    await smokeIntegrations.dispatch(project.id, "slide-gen.status", undefined);
    console.log(`✓ Slide Gen host DTO: ${project.id}`);
  }
} finally {
  await smokeIntegrations.close();
  await rm(smokeData, { recursive: true, force: true });
}
