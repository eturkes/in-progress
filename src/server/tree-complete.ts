import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { TreeForkRequest } from "../shared/contracts";

export const TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

export interface TreeCompleteService {
  workspace(): Promise<unknown>;
  createFork(request: TreeForkRequest): Promise<unknown>;
  close(): Promise<void>;
}

export interface TreeCompleteModule {
  TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES: typeof TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES;
  createEmbeddedService(options: {
    targetRepo: string;
    dataDir: string;
    mode: "preview" | "codex";
  }): Promise<TreeCompleteService>;
  preflightProjectManifest?: (targetRepo: string) => Promise<void>;
}

export async function loadTreeCompleteModule(sourceDirectory: string): Promise<TreeCompleteModule> {
  const modulePath = await realpath(join(sourceDirectory, "dist/server/server/embedded.js"));
  const pathFromSource = relative(sourceDirectory, modulePath);
  if (
    pathFromSource === ".." ||
    pathFromSource.startsWith(`..${sep}`) ||
    isAbsolute(pathFromSource)
  ) {
    throw new Error("Tree Complete embedded service escapes its source directory");
  }
  const imported = (await import(pathToFileURL(modulePath).href)) as Partial<TreeCompleteModule>;
  if (typeof imported.createEmbeddedService !== "function") {
    throw new Error("Tree Complete embedded service is incompatible");
  }
  if (
    imported.TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES !== TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES
  ) {
    throw new Error("Tree Complete public-response byte contract is incompatible");
  }
  return imported as TreeCompleteModule;
}
