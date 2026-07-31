import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PluginManifestSchema, type PluginManifest } from "../src/shared/contracts";

const MANIFEST_NAME = "switchyard.plugin.json";
const MAX_ASSETS = 20_000;

export interface ValidatedPlugin {
  manifest: PluginManifest;
  manifestPath: string;
  root: string;
  entry: string;
  assetCount: number;
}

export class PluginValidationError extends Error {}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function locateManifest(inputPath: string): Promise<{ manifestPath: string; root: string }> {
  const absolute = resolve(inputPath);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new PluginValidationError(`Plugin path does not exist: ${absolute}`);
  }

  const manifestPath = info.isDirectory() ? join(absolute, MANIFEST_NAME) : absolute;
  if (!info.isDirectory() && manifestPath.split(sep).at(-1) !== MANIFEST_NAME) {
    throw new PluginValidationError(`Manifest file must be named ${MANIFEST_NAME}`);
  }

  const root = await realpath(info.isDirectory() ? absolute : dirname(absolute));
  let canonicalManifest: string;
  try {
    canonicalManifest = await realpath(manifestPath);
  } catch {
    throw new PluginValidationError(`Plugin manifest does not exist: ${manifestPath}`);
  }
  if (!within(root, canonicalManifest) || !(await stat(canonicalManifest)).isFile()) {
    throw new PluginValidationError("Plugin manifest escapes its root or is not a regular file");
  }
  return { manifestPath: canonicalManifest, root };
}

async function validateAssets(root: string): Promise<number> {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      count += 1;
      if (count > MAX_ASSETS) {
        throw new PluginValidationError(`Plugin contains more than ${MAX_ASSETS} assets`);
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (entry.isFile()) continue;
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(path);
        } catch {
          throw new PluginValidationError(
            `Plugin contains a dangling symlink: ${relative(root, path)}`,
          );
        }
        if (!within(root, target)) {
          throw new PluginValidationError(
            `Plugin asset symlink escapes its root: ${relative(root, path)}`,
          );
        }
        continue;
      }
      const kind = (await lstat(path)).mode;
      throw new PluginValidationError(
        `Plugin contains a non-static asset (${kind}): ${relative(root, path)}`,
      );
    }
  }
  return count;
}

export async function validatePlugin(inputPath: string): Promise<ValidatedPlugin> {
  const { manifestPath, root } = await locateManifest(inputPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new PluginValidationError(
      `Plugin manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    throw new PluginValidationError(`Plugin manifest is invalid: ${issues}`);
  }
  const manifest = parsed.data;
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    throw new PluginValidationError("Plugin capabilities must be unique");
  }
  if (isAbsolute(manifest.entry) || manifest.entry.includes("\0")) {
    throw new PluginValidationError(`Plugin ${manifest.id} entry must be a relative path`);
  }

  const requestedEntry = resolve(root, manifest.entry);
  let entry: string;
  try {
    entry = await realpath(requestedEntry);
  } catch {
    throw new PluginValidationError(
      `Plugin ${manifest.id} entry does not exist: ${manifest.entry}`,
    );
  }
  if (!within(root, entry) || !(await stat(entry)).isFile()) {
    throw new PluginValidationError(
      `Plugin ${manifest.id} entry escapes its root or is not a regular file`,
    );
  }
  if (!new Set([".html", ".htm"]).has(extname(entry).toLowerCase())) {
    throw new PluginValidationError(`Plugin ${manifest.id} entry must be an HTML document`);
  }

  for (const assetPath of manifest.assets) {
    let asset: string;
    try {
      asset = await realpath(resolve(root, assetPath));
    } catch {
      throw new PluginValidationError(`Plugin ${manifest.id} asset does not exist: ${assetPath}`);
    }
    if (!within(root, asset) || !(await stat(asset)).isFile()) {
      throw new PluginValidationError(
        `Plugin ${manifest.id} asset escapes its root or is not a regular file: ${assetPath}`,
      );
    }
  }

  const assetCount = await validateAssets(root);
  return { manifest, manifestPath, root, entry, assetCount };
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length > 3) {
    throw new PluginValidationError(
      `Usage: bun ${process.argv[1] ?? "scripts/validate-plugin.ts"} <plugin-directory>`,
    );
  }
  const result = await validatePlugin(inputPath);
  const capabilities = result.manifest.capabilities.join(", ") || "none";
  console.log(
    `Valid plugin ${result.manifest.id}@${result.manifest.version}: ${result.assetCount} assets; capabilities: ${capabilities}`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
