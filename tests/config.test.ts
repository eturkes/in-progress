import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { removeDirectory, tempDirectory, writeJson } from "./helpers";

const roots: string[] = [];
const originalUnsafeBind = process.env.IN_PROGRESS_UNSAFE_BIND;

function root(): string {
  const path = tempDirectory("config");
  roots.push(path);
  return path;
}

function writeTreeModule(sourceRoot: string, preflightBody = ""): void {
  const moduleDirectory = join(sourceRoot, "dist/server/server");
  mkdirSync(moduleDirectory, { recursive: true });
  writeFileSync(
    join(moduleDirectory, "embedded.js"),
    [
      "export const TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES = 4194304;",
      "export async function createEmbeddedService() { throw new Error('not used'); }",
      `export async function preflightProjectManifest(targetRepo) { ${preflightBody} }`,
      "",
    ].join("\n"),
  );
}

afterEach(() => {
  for (const path of roots.splice(0)) removeDirectory(path);
  if (originalUnsafeBind === undefined) delete process.env.IN_PROGRESS_UNSAFE_BIND;
  else process.env.IN_PROGRESS_UNSAFE_BIND = originalUnsafeBind;
});

describe("loadConfig", () => {
  test("resolves project and plugin paths relative to the canonical config directory", async () => {
    const directory = root();
    const project = join(directory, "workspace");
    const plugins = join(directory, "plugin-dist");
    const align = join(directory, "align");
    const treeComplete = join(directory, "tree-complete");
    const drift = join(directory, "drift");
    mkdirSync(project);
    mkdirSync(plugins);
    mkdirSync(align);
    mkdirSync(treeComplete);
    writeTreeModule(
      treeComplete,
      "if (!targetRepo.endsWith('/workspace')) throw new Error('wrong project');",
    );
    mkdirSync(join(project, ".tree-complete"));
    writeFileSync(join(project, ".tree-complete/project.json"), "{}\n");
    writeFileSync(drift, "binary");
    chmodSync(drift, 0o755);
    symlinkSync("plugin-dist", join(directory, "plugins"));
    const configPath = join(directory, "in-progress.config.json");
    writeJson(configPath, {
      projects: [{ id: "demo", name: "Demo", path: "./workspace" }],
      pluginDirectories: ["./plugins"],
      integrations: {
        align: { sourceDirectory: "./align", pythonExecutable: drift },
        drift: { executable: "./drift" },
        treeComplete: { sourceDirectory: "./tree-complete", mode: "codex" },
      },
    });

    const config = await loadConfig(configPath);

    expect(config.rootDir).toBe(realpathSync(directory));
    expect(config.configPath).toBe(realpathSync(configPath));
    expect(config.dataDir).toBe(join(realpathSync(directory), ".data"));
    expect(config.projects[0]).toMatchObject({
      id: "demo",
      path: realpathSync(project),
      displayPath: realpathSync(project),
      color: "#67d5b5",
    });
    expect(config.pluginDirectories).toEqual([realpathSync(plugins)]);
    expect(config.integrations).toEqual({
      align: {
        sourceDirectory: realpathSync(align),
        pythonExecutable: realpathSync(drift),
      },
      drift: { executable: realpathSync(drift) },
      treeComplete: { sourceDirectory: realpathSync(treeComplete), mode: "codex" },
    });
    expect(config.server).toEqual({
      host: "127.0.0.1",
      port: 4317,
      allowedOrigins: [],
      allowedTailscaleUsers: [],
    });
    expect(config.terminal.scrollbackBytes).toBe(1024 * 1024);
    expect(config.terminal.maxSessionsPerProject).toBe(8);
  });

  test("rejects a non-loopback bind unless the explicit unsafe switch is enabled", async () => {
    const directory = root();
    mkdirSync(join(directory, "workspace"));
    const configPath = join(directory, "in-progress.config.json");
    writeJson(configPath, {
      server: { host: "0.0.0.0" },
      projects: [{ id: "demo", name: "Demo", path: "workspace" }],
    });
    delete process.env.IN_PROGRESS_UNSAFE_BIND;

    await expect(loadConfig(configPath)).rejects.toThrow("Refusing non-loopback bind (0.0.0.0)");

    process.env.IN_PROGRESS_UNSAFE_BIND = "1";
    expect((await loadConfig(configPath)).server.host).toBe("0.0.0.0");
  });

  test("rejects duplicate project ids after schema validation", async () => {
    const directory = root();
    mkdirSync(join(directory, "workspace"));
    const configPath = join(directory, "in-progress.config.json");
    writeJson(configPath, {
      projects: [
        { id: "demo", name: "One", path: "workspace" },
        { id: "demo", name: "Two", path: "workspace" },
      ],
    });

    await expect(loadConfig(configPath)).rejects.toThrow("Duplicate project id: demo");
  });

  test("rejects unknown nested fields and non-directory roots", async () => {
    const directory = root();
    const projectFile = join(directory, "workspace");
    const configPath = join(directory, "in-progress.config.json");
    writeFileSync(projectFile, "not a directory");
    writeJson(configPath, {
      server: { host: "127.0.0.1", typo: true },
      projects: [{ id: "demo", name: "Demo", path: "workspace" }],
    });

    await expect(loadConfig(configPath)).rejects.toThrow();

    writeJson(configPath, {
      projects: [{ id: "demo", name: "Demo", path: "workspace" }],
    });
    await expect(loadConfig(configPath)).rejects.toThrow("is not a directory");
  });

  test("preflights the per-project manifest required by Tree Complete codex mode", async () => {
    const directory = root();
    mkdirSync(join(directory, "workspace"));
    const treeComplete = join(directory, "tree-complete");
    mkdirSync(treeComplete);
    writeTreeModule(treeComplete, "throw new Error('manifest is not committed');");
    const configPath = join(directory, "in-progress.config.json");
    writeJson(configPath, {
      projects: [{ id: "demo", name: "Demo", path: "workspace" }],
      integrations: {
        treeComplete: { sourceDirectory: "tree-complete", mode: "codex" },
      },
    });

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Tree Complete codex mode requires a valid committed project manifest",
    );
  });

  test("requires Tree Complete's built preflight contract before codex mode", async () => {
    const directory = root();
    mkdirSync(join(directory, "workspace"));
    mkdirSync(join(directory, "tree-complete"));
    const configPath = join(directory, "in-progress.config.json");
    writeJson(configPath, {
      projects: [{ id: "demo", name: "Demo", path: "workspace" }],
      integrations: {
        treeComplete: { sourceDirectory: "tree-complete", mode: "codex" },
      },
    });

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Tree Complete codex mode requires a compatible built integration",
    );
  });
});
