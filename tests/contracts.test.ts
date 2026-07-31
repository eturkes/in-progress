import { describe, expect, test } from "bun:test";
import { NotificationEventInputSchema, PluginManifestSchema } from "../src/shared/contracts";

describe("shared trust-boundary contracts", () => {
  test("notification targets stay on the control-plane origin", () => {
    const input = { title: "Done", url: "/p/fixture/terminal" };
    expect(NotificationEventInputSchema.parse(input).url).toBe(input.url);
    expect(() =>
      NotificationEventInputSchema.parse({ ...input, url: "https://evil.example" }),
    ).toThrow();
    expect(() =>
      NotificationEventInputSchema.parse({ ...input, url: "//evil.example/path" }),
    ).toThrow();
    expect(() =>
      NotificationEventInputSchema.parse({ ...input, url: "/\\evil.example/path" }),
    ).toThrow();
  });

  test("plugin capabilities are a set and the iframe entry is an HTML document", () => {
    const manifest = {
      apiVersion: "1.0",
      id: "fixture-plugin",
      name: "Fixture",
      version: "1.0.0",
      description: "Fixture",
      entry: "index.html",
      assets: [],
      capabilities: ["project.tree"],
    };
    expect(PluginManifestSchema.parse(manifest)).toMatchObject(manifest);
    expect(() =>
      PluginManifestSchema.parse({ ...manifest, capabilities: ["project.tree", "project.tree"] }),
    ).toThrow();
    expect(() => PluginManifestSchema.parse({ ...manifest, entry: "plugin.js" })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...manifest, entry: "nested/index.html" })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...manifest, id: "terminal" })).toThrow();
  });
});
