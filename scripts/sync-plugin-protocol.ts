import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const protocolRoot = resolve(root, "packages/plugin-protocol");
const protocolDist = resolve(protocolRoot, "dist");
const check = process.argv.slice(2).includes("--check");
const browserStart = "/* in-progress-protocol:start */";
const browserEnd = "/* in-progress-protocol:end */";

const vendorTargets = [
  resolve(root, "plugins/tree-complete/vendor/in-progress-protocol"),
  resolve(root, "plugins/turbo-prompt/vendor/in-progress-protocol"),
  resolve(root, "plugins/preview/vendor/in-progress-protocol"),
  resolve(root, "plugins/slide-gen/vendor/in-progress-protocol"),
].filter((target) => existsSync(resolve(target, "../../package.json")));

const staticEntries = [
  resolve(root, "examples/plugins/project-map/index.html"),
  resolve(root, "plugins/align/plugin/index.html"),
  resolve(root, "plugins/drift/plugin/index.html"),
];

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(directory, path));
      else throw new Error(`Protocol artifact contains a non-file: ${path}`);
    }
  };
  await walk(directory);
  return files.sort();
}

async function vendorManifest(): Promise<string> {
  const source = JSON.parse(await readFile(resolve(protocolRoot, "package.json"), "utf8")) as {
    name: string;
    version: string;
    description: string;
    type: string;
    exports: unknown;
    dependencies: unknown;
    engines: unknown;
    sideEffects: boolean;
  };
  return `${JSON.stringify(
    {
      name: source.name,
      version: source.version,
      description: source.description,
      type: source.type,
      exports: source.exports,
      dependencies: source.dependencies,
      engines: source.engines,
      sideEffects: source.sideEffects,
    },
    null,
    2,
  )}\n`;
}

async function expectedVendor(): Promise<Map<string, Uint8Array>> {
  const expected = new Map<string, Uint8Array>();
  expected.set("package.json", new TextEncoder().encode(await vendorManifest()));
  for (const name of await filesBelow(protocolDist)) {
    expected.set(
      `dist/${name}`,
      new Uint8Array(await Bun.file(resolve(protocolDist, name)).arrayBuffer()),
    );
  }
  return expected;
}

async function syncVendor(target: string, expected: Map<string, Uint8Array>): Promise<void> {
  if (check) {
    if (!existsSync(target)) throw new Error(`Protocol vendor is missing: ${target}`);
    const actual = await filesBelow(target);
    const names = [...expected.keys()].sort();
    if (actual.join("\0") !== names.join("\0"))
      throw new Error(`Protocol vendor inventory differs: ${target}`);
    for (const [name, bytes] of expected) {
      if (
        !(await Bun.file(resolve(target, name)).bytes()).every(
          (byte, index) => byte === bytes[index],
        ) ||
        (await Bun.file(resolve(target, name)).size) !== bytes.length
      ) {
        throw new Error(`Protocol vendor differs: ${resolve(target, name)}`);
      }
    }
    return;
  }
  await rm(target, { recursive: true, force: true });
  for (const [name, bytes] of expected) {
    const path = resolve(target, name);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
}

async function syncStaticEntry(path: string, browser: string): Promise<void> {
  const source = await readFile(path, "utf8");
  const start = source.indexOf(browserStart);
  const end = source.indexOf(browserEnd);
  if (start < 0 || end < start) throw new Error(`Protocol markers are missing: ${path}`);
  const contentStart = start + browserStart.length;
  const generated = `\n${browser}\n    `;
  if (check) {
    if (source.slice(contentStart, end) !== generated)
      throw new Error(`Embedded protocol differs: ${path}`);
    return;
  }
  await writeFile(path, `${source.slice(0, contentStart)}${generated}${source.slice(end)}`);
}

if (!existsSync(resolve(protocolDist, "browser.iife.js"))) {
  throw new Error("Build @in-progress/protocol before syncing vendors");
}
const expected = await expectedVendor();
for (const target of vendorTargets) await syncVendor(target, expected);
const browser = (await readFile(resolve(protocolDist, "browser.iife.js"), "utf8"))
  .trim()
  .replace(/<\/script/gi, "<\\/script");
for (const entry of staticEntries) await syncStaticEntry(entry, browser);
console.log(
  `${check ? "Verified" : "Synchronized"} protocol → ${vendorTargets.length} vendors + ${staticEntries.length} static entries`,
);
