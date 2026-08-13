import { describe, expect, test } from "bun:test";
import {
  NotificationEventInputSchema,
  PluginManifestSchema,
  PreviewGenerationRequestSchema,
  PreviewSettingsRequestSchema,
} from "../src/shared/contracts";
import { DEVELOPMENT_CSP_NONCE_PLACEHOLDER } from "../src/shared/development";
import { authorizePluginRequest } from "../src/web/plugin-authority";
import viteConfig from "../vite.config";

describe("shared trust-boundary contracts", () => {
  test("development HTML and HMR use the loopback proxy contract", async () => {
    expect(typeof viteConfig).toBe("function");
    if (typeof viteConfig !== "function") throw new Error("Vite config must resolve by command");
    const development = await viteConfig({
      command: "serve",
      isPreview: false,
      isSsrBuild: false,
      mode: "development",
    });
    const production = await viteConfig({
      command: "build",
      isPreview: false,
      isSsrBuild: false,
      mode: "production",
    });

    expect(development.html?.cspNonce).toBe(DEVELOPMENT_CSP_NONCE_PLACEHOLDER);
    expect(development.server?.ws).toMatchObject({ clientPort: 5173 });
    expect(production.html).toBeUndefined();
  });

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

  test("Preview browser authority is limited to mode, strategy, and a bounded prompt", () => {
    expect(
      PreviewGenerationRequestSchema.parse({ strategy: "update", prompt: "  Focus here.  " }),
    ).toEqual({ strategy: "update", prompt: "Focus here." });
    expect(PreviewSettingsRequestSchema.parse({ mode: "automatic", prompt: "" })).toEqual({
      mode: "automatic",
      prompt: "",
    });
    expect(() =>
      PreviewGenerationRequestSchema.parse({ strategy: "fresh", prompt: "x".repeat(8_001) }),
    ).toThrow();
    expect(
      PreviewGenerationRequestSchema.parse({ strategy: "fresh", prompt: ` ${"x".repeat(8_000)} ` }),
    ).toEqual({ strategy: "fresh", prompt: "x".repeat(8_000) });
    expect(() =>
      PreviewGenerationRequestSchema.parse({ strategy: "fresh", prompt: "\ud800" }),
    ).toThrow();
    expect(() =>
      PreviewSettingsRequestSchema.parse({ mode: "automatic", prompt: "", path: "/tmp" }),
    ).toThrow();
  });

  test("ecosystem build uses Preview's checkout-owned launcher", async () => {
    const source = await Bun.file(new URL("../scripts/build-ecosystem.ts", import.meta.url)).text();
    expect(source).toContain('resolve(checkouts.preview, "bin/preview")');
    expect(source).not.toContain('"uv", "run"');
    expect(source).toMatch(/"--artifact-root",\s+previewArtifacts/);
    expect(source).toContain('"--git-track"');
    expect(source).toContain('...projectSources.flatMap(([id, path]) => ["--source", id, path])');
    expect(source).toContain('"in-progress-plugin/preview-index.json"');
    expect(source).toContain('"tree-complete.workspace"');
    expect(source).toContain("TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES");
  });

  test("Preview generation confirmation discloses the fixed paid boundary", async () => {
    const { confirmPreviewAutomatic, confirmPreviewGeneration } =
      await import("../src/web/preview-authority");
    const prompts: string[] = [];
    const accepted = confirmPreviewGeneration(
      {
        projectId: "fixture",
        dashboard: false,
        state: "idle",
        activeProjectId: null,
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        artifactDirectory: "/external/preview",
        revision: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        mode: "manual",
        prompt: "",
        sourceRevision: "a".repeat(40),
        generatedRevision: null,
        sourceDirty: false,
        stale: true,
        automaticBlockedReason: null,
        lastStrategy: null,
        artifactGitTracked: true,
      },
      { id: "fixture", name: "Fixture" },
      { strategy: "fresh", prompt: "Lead with the release workflow." },
      (message) => {
        prompts.push(message);
        return true;
      },
    );

    expect(accepted).toBe(true);
    expect(prompts[0]).toMatch(/Regenerate Preview from scratch.*Fixture.*Project ID: fixture/s);
    expect(prompts[0]).toMatch(/gpt-5\.6-sol.*max/s);
    expect(prompts[0]).toMatch(/ChatGPT subscription.*subscription usage/s);
    expect(prompts[0]).toMatch(
      /failed Codex invocation.*invalid\/unreadable.*two Codex invocations.*multiple model requests/s,
    );
    expect(prompts[0]).toMatch(
      /any host-readable content.*OpenAI.*not a confidentiality boundary.*trust the source checkout/s,
    );
    expect(prompts[0]).toMatch(
      /Repository instructions and skills are suppressed.*global ~\/\.codex\/AGENTS\.md.*trusted authority/s,
    );
    expect(prompts[0]).toContain("/external/preview");
    expect(prompts[0]).toContain("Lead with the release workflow.");

    const automatic = confirmPreviewAutomatic(
      {
        projectId: "fixture",
        dashboard: true,
        state: "idle",
        activeProjectId: null,
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        artifactDirectory: "/external/preview",
        revision: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        mode: "manual",
        prompt: "",
        sourceRevision: "a".repeat(40),
        generatedRevision: "9".repeat(40),
        sourceDirty: false,
        stale: true,
        automaticBlockedReason: null,
        lastStrategy: "update",
        artifactGitTracked: true,
      },
      { id: "fixture", name: "Fixture" },
      "Keep the evidence ledger compact.",
      (message) => {
        prompts.push(message);
        return true;
      },
    );
    expect(automatic).toBe(true);
    expect(prompts[1]).toMatch(/ongoing subscription-spending.*new clean Git commit/s);
    expect(prompts[1]).toMatch(/failed commit is not retried.*local Git repository/s);

    prompts.length = 0;
    confirmPreviewGeneration(
      {
        projectId: "fixture",
        dashboard: true,
        state: "idle",
        activeProjectId: null,
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        artifactDirectory: "/external/preview",
        revision: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        mode: "automatic",
        prompt: "Old direction.",
        sourceRevision: "a".repeat(40),
        generatedRevision: "a".repeat(40),
        sourceDirty: false,
        stale: false,
        automaticBlockedReason: null,
        lastStrategy: "update",
        artifactGitTracked: true,
      },
      { id: "fixture", name: "Fixture" },
      { strategy: "update", prompt: "New direction." },
      (message) => {
        prompts.push(message);
        return false;
      },
    );
    expect(prompts[0]).toMatch(/Automatic mode is active.*future runs at clean new commits/s);
  });

  test("ecosystem config exposes every plugin submodule as an editable project", async () => {
    const config = await Bun.file(
      new URL("../in-progress.ecosystem.config.json", import.meta.url),
    ).json();
    expect(config.projects).toEqual([
      { id: "in-progress", name: "in-progress", path: ".", color: "#67d5b5" },
      { id: "align", name: "Align", path: "./plugins/align", color: "#e8b55b" },
      { id: "drift", name: "Drift", path: "./plugins/drift", color: "#62dfbc" },
      { id: "preview", name: "Preview", path: "./plugins/preview", color: "#4c57a8" },
      {
        id: "tree-complete",
        name: "Tree Complete",
        path: "./plugins/tree-complete",
        color: "#ccf45b",
      },
      {
        id: "turbo-prompt",
        name: "Turbo Prompt",
        path: "./plugins/turbo-prompt",
        color: "#315ed4",
      },
    ]);
  });

  test("Tree Complete mutations require a trusted host confirmation", () => {
    const prompts: string[] = [];
    const confirm = (message: string) => {
      prompts.push(message);
      return false;
    };

    expect(
      authorizePluginRequest(
        "project.tree",
        undefined,
        "Tree Complete",
        "tree-complete",
        "Fixture",
        "fixture",
        "preview",
        confirm,
      ),
    ).toEqual({ allowed: true, params: undefined });
    expect(prompts).toHaveLength(0);

    expect(
      authorizePluginRequest(
        "tree-complete.createFork",
        { baseVersionId: "root", decisionId: "storage", alternativeId: "sqlite" },
        "Tree Complete",
        "tree-complete",
        "Fixture",
        "fixture",
        "preview",
        confirm,
      ),
    ).toEqual({ allowed: false, error: "Fork canceled by the user" });
    expect(prompts[0]).toMatch(/Tree Complete.*Fixture/s);
    expect(prompts[0]).toMatch(/Plugin ID: tree-complete.*Project ID: fixture/s);
    expect(prompts[0]).toMatch(/Base version: root.*Decision: storage.*Alternative: sqlite/s);
    expect(prompts[0]).toMatch(
      /simulation state.*does not run Codex.*change the project repository/s,
    );

    prompts.length = 0;
    authorizePluginRequest(
      "tree-complete.createFork",
      { baseVersionId: "root", decisionId: "storage", alternativeId: "sqlite" },
      "Tree Complete",
      "tree-complete",
      "Fixture",
      "fixture",
      "codex",
      confirm,
    );
    expect(prompts[0]).toMatch(
      /codex --yolo.*unsandboxed.*OS user.*anything.*Git branch\/worktree.*commit/s,
    );
  });

  test("rejects malformed Tree fork requests before prompting and escapes hostile labels", () => {
    const prompts: string[] = [];
    const confirm = (message: string) => {
      prompts.push(message);
      return false;
    };

    expect(
      authorizePluginRequest(
        "tree-complete.createFork",
        { baseVersionId: "", decisionId: "storage", alternativeId: "sqlite" },
        "Tree Complete",
        "tree-complete",
        "Fixture",
        "fixture",
        "preview",
        confirm,
      ),
    ).toEqual({ allowed: false, error: "Invalid Tree Complete fork request" });
    expect(prompts).toHaveLength(0);

    authorizePluginRequest(
      "tree-complete.createFork",
      { baseVersionId: "root\n", decisionId: "storage\u202e", alternativeId: "sqlite" },
      "Tree\nComplète\u202e",
      "tree-complete",
      "Fixture\u2028spoof",
      "fixture",
      "preview",
      confirm,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("\u202e");
    expect(prompts[0]).not.toContain("\u2028");
    expect(prompts[0]).toContain("\\u{202e}");
    expect(prompts[0]).toContain("\\u{2028}");
    expect(prompts[0]).toContain("Compl\\u{e8}te");
    expect(prompts[0]).toContain("root\\u{a}");
  });
});
