import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validatePlugin } from "../scripts/validate-plugin";
import { PluginManifestSchema } from "../src/shared/contracts";
import { PluginRegistry } from "../src/server/plugins";
import { removeDirectory, tempDirectory, writeJson } from "./helpers";

const roots: string[] = [];

function root(label: string): string {
  const path = tempDirectory(label);
  roots.push(path);
  return path;
}

function manifest(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: "1.0",
    id,
    name: "Fixture plugin",
    version: "1.2.3",
    description: "Fixture",
    entry: "index.html",
    assets: ["plugin.js"],
    capabilities: ["project.metadata", "project.tree"],
    ...overrides,
  };
}

function createPlugin(parent: string, id: string, overrides: Record<string, unknown> = {}): string {
  const directory = join(parent, id);
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, "in-progress.plugin.json"), manifest(id, overrides));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Plugin</title>\n");
  writeFileSync(join(directory, "plugin.js"), "export {};\n");
  return directory;
}

afterEach(() => {
  for (const path of roots.splice(0)) removeDirectory(path);
});

describe("plugin manifest and registry", () => {
  test("manifest schema is strict and rejects unsupported capabilities and API versions", () => {
    expect(PluginManifestSchema.parse(manifest("valid-plugin"))).toMatchObject({
      id: "valid-plugin",
      icon: "blocks",
    });
    expect(() => PluginManifestSchema.parse(manifest("bad", { apiVersion: "2.0" }))).toThrow();
    expect(() =>
      PluginManifestSchema.parse(manifest("bad", { capabilities: ["project.execute"] })),
    ).toThrow();
    expect(() => PluginManifestSchema.parse({ ...manifest("bad"), unexpected: true })).toThrow();
    expect(() => PluginManifestSchema.parse(manifest("terminal"))).toThrow("reserved");
    expect(() =>
      PluginManifestSchema.parse(manifest("nested", { entry: "dist/index.html" })),
    ).toThrow("top-level");
    expect(() => PluginManifestSchema.parse(manifest("hidden", { assets: [".env"] }))).toThrow(
      "hidden",
    );
  });

  test("loads static assets, advertises capabilities, and rejects undeclared capabilities", () => {
    const plugins = root("plugins");
    createPlugin(plugins, "project-map");
    const registry = new PluginRegistry([plugins]);

    expect(registry.dtos()).toEqual([
      expect.objectContaining({ id: "terminal", kind: "host" }),
      expect.objectContaining({
        id: "project-map",
        kind: "iframe",
        entryUrl: "/plugins/project-map/",
        capabilities: ["project.metadata", "project.tree"],
      }),
    ]);
    expect(registry.asset("project-map", "")).toEndWith("/project-map/index.html");
    expect(registry.asset("project-map", "plugin.js")).toEndWith("/project-map/plugin.js");
    expect(() => registry.asset("project-map", "in-progress.plugin.json")).toThrow(
      "Plugin asset not found",
    );
    expect(() => registry.assertCapability("project-map", "project.metadata")).not.toThrow();
    expect(() => registry.assertCapability("project-map", "project.git")).toThrow(
      "Plugin capability not granted: project.git",
    );

    const direct = createPlugin(root("direct-plugin"), "direct");
    createPlugin(direct, "nested");
    expect(new PluginRegistry([direct]).dtos().map(({ id }) => id)).toEqual(["terminal", "direct"]);
  });

  test("rejects duplicate ids, entry escapes, traversal assets, and symlink asset escapes", () => {
    const plugins = root("plugin-boundary");
    createPlugin(plugins, "one", { id: "duplicate" });
    createPlugin(plugins, "two", { id: "duplicate" });
    expect(() => new PluginRegistry([plugins])).toThrow("Duplicate plugin id: duplicate");

    const separate = root("plugin-escape");
    const outside = root("asset-outside");
    writeFileSync(join(outside, "outside.html"), "<!doctype html>outside");
    const plugin = createPlugin(separate, "escape", { entry: "escape.html" });
    symlinkSync(join(outside, "outside.html"), join(plugin, "escape.html"));
    expect(() => new PluginRegistry([separate])).toThrow("entry escapes its root");

    const assets = root("plugin-assets");
    const assetPlugin = createPlugin(assets, "assets");
    symlinkSync(join(outside, "outside.html"), join(assetPlugin, "outside.html"));
    const registry = new PluginRegistry([assets]);
    expect(() => registry.asset("assets", "%2e%2e%2foutside.html")).toThrow(
      "Plugin asset not found",
    );
    expect(() => registry.asset("assets", "outside.html")).toThrow("Plugin asset not found");

    const declaredAssets = root("declared-plugin-assets");
    const declaredPlugin = createPlugin(declaredAssets, "declared", {
      assets: ["plugin.js", "outside.html"],
    });
    symlinkSync(join(outside, "outside.html"), join(declaredPlugin, "outside.html"));
    expect(() => new PluginRegistry([declaredAssets])).toThrow("asset escapes its root");
  });
});

describe("validatePlugin", () => {
  test("validates a standalone plugin directory and manifest file", async () => {
    const plugins = root("validator");
    const directory = createPlugin(plugins, "project-map");

    const byDirectory = await validatePlugin(directory);
    const byManifest = await validatePlugin(join(directory, "in-progress.plugin.json"));

    expect(byDirectory.manifest.id).toBe("project-map");
    expect(byDirectory.entry).toEndWith("/index.html");
    expect(byDirectory.assetCount).toBe(3);
    expect(byManifest).toEqual(byDirectory);
  });

  test("rejects invalid JSON, duplicate capabilities, non-HTML entries, and escaping asset symlinks", async () => {
    const plugins = root("validator-invalid");
    const invalidJson = join(plugins, "json");
    mkdirSync(invalidJson, { recursive: true });
    writeFileSync(join(invalidJson, "in-progress.plugin.json"), "{");
    await expect(validatePlugin(invalidJson)).rejects.toThrow("not valid JSON");

    const duplicate = createPlugin(plugins, "duplicate-caps", {
      capabilities: ["project.tree", "project.tree"],
    });
    await expect(validatePlugin(duplicate)).rejects.toThrow(/capabilities must be unique/i);

    const scriptEntry = createPlugin(plugins, "script-entry", { entry: "plugin.js" });
    await expect(validatePlugin(scriptEntry)).rejects.toThrow(/entry:.*html/i);

    const outside = root("validator-outside");
    writeFileSync(join(outside, "secret.js"), "secret\n");
    const escaping = createPlugin(plugins, "escaping");
    symlinkSync(join(outside, "secret.js"), join(escaping, "secret.js"));
    await expect(validatePlugin(escaping)).rejects.toThrow("asset symlink escapes its root");
  });
});
