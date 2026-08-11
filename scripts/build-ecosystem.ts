import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/server/config";
import { IntegrationRegistry } from "../src/server/integrations";
import { ProjectRegistry } from "../src/server/projects";
import { TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES } from "../src/server/tree-complete";
import { validatePlugin } from "./validate-plugin";

const hostRoot = resolve(import.meta.dir, "..");
const projectsRoot = resolve(hostRoot, "..");

const builds = [
  {
    label: "Drift",
    cwd: resolve(projectsRoot, "drift"),
    argv: ["cargo", "build", "--release", "--locked"],
  },
  {
    label: "Preview",
    cwd: resolve(projectsRoot, "preview"),
    argv: [resolve(projectsRoot, "preview/bin/preview"), "plugin-build"],
  },
  {
    label: "Turbo Prompt",
    cwd: resolve(projectsRoot, "turbo-prompt"),
    argv: ["npm", "run", "build"],
  },
  {
    label: "Tree Complete",
    cwd: resolve(projectsRoot, "tree-complete"),
    argv: ["pnpm", "build"],
  },
] as const;

const pluginRoots = [
  resolve(projectsRoot, "align/plugin"),
  resolve(projectsRoot, "drift/plugin"),
  resolve(projectsRoot, "preview/dist/in-progress-plugin"),
  resolve(projectsRoot, "tree-complete/dist/plugin"),
  resolve(projectsRoot, "turbo-prompt/dist"),
];

for (const build of builds) {
  if (!existsSync(build.cwd)) throw new Error(`${build.label} checkout missing: ${build.cwd}`);
  console.log(`→ ${build.label}: ${build.argv.join(" ")}`);
  const child = Bun.spawn([...build.argv], {
    cwd: build.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${build.label} build failed (${exitCode})`);
}

const embeddedModulePath = resolve(projectsRoot, "tree-complete/dist/server/server/embedded.js");
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

for (const root of pluginRoots) {
  const plugin = await validatePlugin(root);
  console.log(`✓ ${plugin.manifest.id}@${plugin.manifest.version}: ${root}`);
}

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
