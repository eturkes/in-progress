import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  NotificationEventInputSchema,
  PluginManifestSchema,
  type PluginCapability,
  type PluginDto,
  type PluginManifest,
  type PluginRpcRequest,
} from "../shared/contracts";
import { NotificationService } from "./notifications";
import { IntegrationRegistry } from "./integrations";
import { ProjectRegistry } from "./projects";
import { HttpError } from "./security";

interface InstalledPlugin {
  manifest: PluginManifest;
  root: string;
  entry: string;
  assets: Map<string, string>;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function manifestCandidates(configuredRoot: string): string[] {
  const direct = join(configuredRoot, "in-progress.plugin.json");
  if (existsSync(direct)) return [configuredRoot];
  const candidates: string[] = [];
  for (const entry of readdirSync(configuredRoot, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink())
      candidates.push(join(configuredRoot, entry.name));
  }
  return candidates;
}

export class PluginRegistry {
  readonly #plugins = new Map<string, InstalledPlugin>();

  constructor(pluginDirectories: string[]) {
    for (const configuredRoot of pluginDirectories) {
      for (const candidate of manifestCandidates(configuredRoot)) this.#load(candidate);
    }
  }

  #load(rawRoot: string): void {
    const root = realpathSync(rawRoot);
    const manifestPath = join(root, "in-progress.plugin.json");
    if (!existsSync(manifestPath)) return;
    const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (this.#plugins.has(manifest.id)) throw new Error(`Duplicate plugin id: ${manifest.id}`);
    if (isAbsolute(manifest.entry)) throw new Error(`Plugin ${manifest.id} entry must be relative`);
    const entry = realpathSync(resolve(root, manifest.entry));
    if (!within(root, entry) || !statSync(entry).isFile()) {
      throw new Error(`Plugin ${manifest.id} entry escapes its root or is not a file`);
    }
    const assets = new Map<string, string>();
    for (const assetPath of manifest.assets) {
      let asset: string;
      try {
        asset = realpathSync(resolve(root, assetPath));
      } catch {
        throw new Error(`Plugin ${manifest.id} asset does not exist: ${assetPath}`);
      }
      if (!within(root, asset) || !statSync(asset).isFile()) {
        throw new Error(`Plugin ${manifest.id} asset escapes its root or is not a file`);
      }
      if (asset === entry) {
        throw new Error(`Plugin ${manifest.id} entry document must not also be a public asset`);
      }
      assets.set(assetPath, asset);
    }
    this.#plugins.set(manifest.id, { manifest, root, entry, assets });
  }

  dtos(): PluginDto[] {
    return [
      {
        id: "terminal",
        name: "Terminal",
        version: "1.0.0",
        description: "Durable project shell",
        icon: "terminal",
        capabilities: [],
        kind: "host",
      },
      ...[...this.#plugins.values()].map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        icon: manifest.icon,
        capabilities: manifest.capabilities,
        kind: "iframe" as const,
        entryUrl: `/plugins/${manifest.id}/`,
      })),
    ];
  }

  get(id: string): InstalledPlugin {
    const plugin = this.#plugins.get(id);
    if (!plugin) throw new HttpError(404, "Plugin not found");
    return plugin;
  }

  asset(id: string, rawPath: string): string {
    const plugin = this.get(id);
    if (!rawPath) return plugin.entry;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      throw new HttpError(400, "Malformed plugin asset path");
    }
    if (isAbsolute(decoded) || decoded.includes("\0"))
      throw new HttpError(400, "Invalid plugin asset path");
    const requested = plugin.assets.get(decoded);
    if (!requested || !existsSync(requested)) throw new HttpError(404, "Plugin asset not found");
    const canonical = realpathSync(requested);
    if (!within(plugin.root, canonical) || !statSync(canonical).isFile()) {
      throw new HttpError(403, "Plugin asset escapes plugin root");
    }
    return canonical;
  }

  assertCapability(id: string, capability: PluginCapability): void {
    if (!this.get(id).manifest.capabilities.includes(capability)) {
      throw new HttpError(403, `Plugin capability not granted: ${capability}`);
    }
  }

  async dispatch(
    pluginId: string,
    projectId: string,
    request: PluginRpcRequest,
    projects: ProjectRegistry,
    notifications: NotificationService,
    integrations: IntegrationRegistry,
  ): Promise<unknown> {
    this.assertCapability(pluginId, request.method);
    switch (request.method) {
      case "project.metadata":
        return await projects.dto(projects.get(projectId));
      case "project.tree":
        return projects.tree(projectId, request.params);
      case "project.readText":
        return projects.readText(projectId, request.params);
      case "project.git":
        return await projects.git(projectId);
      case "host.notify": {
        const input = NotificationEventInputSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(request.params ?? {}),
          projectId,
        });
        return notifications.create(input);
      }
      case "align.status":
      case "drift.render":
      case "drift.validateTraces":
      case "drift.recentSessions":
      case "drift.importSession":
      case "drift.analyze":
      case "tree-complete.workspace":
      case "tree-complete.createFork":
        return integrations.dispatch(projectId, request.method, request.params);
    }
  }
}
