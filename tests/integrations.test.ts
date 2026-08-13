import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configForTests } from "../src/server/config";
import { IntegrationRegistry } from "../src/server/integrations";
import { runBounded } from "../src/server/process";
import { ProjectRegistry } from "../src/server/projects";
import { removeDirectory, tempDirectory } from "./helpers";

const roots: string[] = [];

function root(label: string): string {
  const path = tempDirectory(label);
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) removeDirectory(path);
});

function fixture(stage = "candidate_final"): {
  integrations: IntegrationRegistry;
  projectRoot: string;
  alignRoot: string;
} {
  const projectRoot = join(root("integration-project"), "workspace's boundary");
  mkdirSync(projectRoot);
  const alignRoot = root("integration-align");
  const alignPackage = join(alignRoot, "src/align");
  mkdirSync(alignPackage, { recursive: true });
  writeFileSync(join(alignPackage, "__init__.py"), "");
  writeFileSync(
    join(alignPackage, "__main__.py"),
    [
      "import json, shlex, sys",
      "root = sys.argv[sys.argv.index('--root') + 1]",
      "print(json.dumps({",
      "  'schema_version': 1, 'initialized': True,",
      "  'contract': {'state': 'accepted', 'selected_id': 'contract-1'},",
      `  'latest': {'snapshot': {'stage': ${JSON.stringify(stage)}}, 'matching_assessment_count': 2, 'matching_report_count': 1},`,
      "  'totals': {'amendments': 1, 'assessment_groups': 99, 'assessments': 2, 'checkpoints': 3, 'contracts': 1, 'reports': 1, 'snapshots': 3},",
      "  'next_action': {'command': shlex.join(['align', '--root', root, 'report']), 'reason': 'Regenerate ' + root + ' before reporting.'}",
      "}))",
      "",
    ].join("\n"),
  );

  const drift = join(root("integration-drift"), "drift");
  writeFileSync(
    drift,
    '#!/bin/sh\n[ "$1" = render ] || exit 2\nprintf \'INSPECT — validated %s\\n\' "$2"\n',
  );
  chmodSync(drift, 0o755);

  const config = configForTests(projectRoot, {
    integrations: {
      align: { sourceDirectory: alignRoot, pythonExecutable: "/usr/bin/python3" },
      drift: { executable: drift },
    },
  });
  const projects = new ProjectRegistry(config.projects);
  return {
    integrations: new IntegrationRegistry(config.integrations, projects, config.dataDir),
    projectRoot,
    alignRoot,
  };
}

function setupFixture(): {
  integrations: IntegrationRegistry;
  projectRoot: string;
  alignRoot: string;
} {
  const projectRoot = join(root("align-setup-project"), "workspace's boundary");
  mkdirSync(projectRoot);
  const alignRoot = root("align-setup-source");
  const alignPackage = join(alignRoot, "src/align");
  mkdirSync(alignPackage, { recursive: true });
  writeFileSync(join(alignPackage, "__init__.py"), "");
  writeFileSync(
    join(alignPackage, "__main__.py"),
    [
      "import json, pathlib, sys, time",
      "root = pathlib.Path(sys.argv[sys.argv.index('--root') + 1])",
      "state = root / '.align-fixture.json'",
      "command = sys.argv[sys.argv.index('--root') + 2]",
      "if command == 'init':",
      "    prompt = sys.stdin.buffer.read().decode('utf-8')",
      "    if prompt.startswith('slow:'): time.sleep(0.2)",
      "    if prompt.startswith('fail:'): raise SystemExit(2)",
      "    state.write_text(json.dumps({'argv': sys.argv, 'prompt': prompt}), encoding='utf-8')",
      "    print('baseline_fixture')",
      "elif command == 'status':",
      "    initialized = state.exists()",
      "    print(json.dumps({",
      "      'schema_version': 1, 'initialized': initialized,",
      "      'contract': {'state': 'missing', 'selected_id': None},",
      "      'latest': {'snapshot': {'stage': 'in_progress'} if initialized else None, 'matching_assessment_count': 0, 'matching_report_count': 0},",
      "      'totals': {'amendments': 0, 'assessments': 0, 'checkpoints': int(initialized), 'contracts': 0, 'reports': 0, 'snapshots': int(initialized)},",
      "      'next_action': None,",
      "    }))",
      "else:",
      "    raise SystemExit(2)",
      "",
    ].join("\n"),
  );
  const config = configForTests(projectRoot, {
    projects: [
      {
        id: "fixture",
        name: "Fixture's project",
        path: projectRoot,
        displayPath: projectRoot,
        color: "#67d5b5",
      },
      {
        id: "fixture-alias",
        name: "Fixture alias",
        path: projectRoot,
        displayPath: projectRoot,
        color: "#67d5b5",
      },
    ],
    integrations: { align: { sourceDirectory: alignRoot, pythonExecutable: "/usr/bin/python3" } },
  });
  const projects = new ProjectRegistry(config.projects);
  return {
    integrations: new IntegrationRegistry(config.integrations, projects, config.dataDir),
    projectRoot,
    alignRoot,
  };
}

describe("fixed integration adapters", () => {
  test("enforces a hard deadline across a subprocess group and inherited pipes", async () => {
    const directory = root("integration-process-group");
    const executable = join(directory, "forking-tool");
    const pidFile = join(directory, "descendant.pid");
    writeFileSync(executable, '#!/bin/sh\nsleep 30 &\nprintf \'%s\\n\' "$!" > "$1"\nwait\n');
    chmodSync(executable, 0o755);
    const started = performance.now();

    await expect(
      runBounded([executable, pidFile], {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 150,
        stdoutBytes: 1_024,
        label: "Forking fixture",
      }),
    ).rejects.toThrow("timed out");

    expect(performance.now() - started).toBeLessThan(2_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 20 && alive(); attempt += 1) await Bun.sleep(25);
    const leaked = alive();
    if (leaked) process.kill(pid, "SIGKILL");
    expect(leaked).toBe(false);
  });

  test("reaps same-group descendants after a successful tool exit", async () => {
    const directory = root("integration-successful-descendant");
    const executable = join(directory, "backgrounding-tool");
    const pidFile = join(directory, "descendant.pid");
    writeFileSync(
      executable,
      '#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\nprintf \'%s\\n\' "$!" > "$1"\n',
    );
    chmodSync(executable, 0o755);

    await expect(
      runBounded([executable, pidFile], {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 2_000,
        stdoutBytes: 1_024,
        label: "Backgrounding fixture",
      }),
    ).resolves.toEqual({ stdout: "", stderr: "" });

    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 20 && alive(); attempt += 1) await Bun.sleep(25);
    const leaked = alive();
    if (leaked) process.kill(pid, "SIGKILL");
    expect(leaked).toBe(false);
  });

  test("delivers bounded subprocess input without exposing it through argv", async () => {
    const directory = root("integration-stdin");
    const executable = join(directory, "stdin-tool");
    writeFileSync(executable, "#!/bin/sh\nprintf 'argv=%s\\n' \"$#\"\ncat\n");
    chmodSync(executable, 0o755);

    await expect(
      runBounded([executable], {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 2_000,
        stdoutBytes: 1_024,
        label: "Input fixture",
        stdin: "Preview-only direction\n",
      }),
    ).resolves.toEqual({ stdout: "argv=0\nPreview-only direction\n", stderr: "" });
  });

  test("maps Align's verified status document to a bounded plugin DTO", async () => {
    const { integrations, projectRoot } = fixture();

    const status = await integrations.dispatch("fixture", "align.status", undefined);

    expect(status).toEqual({
      initialized: true,
      contract: { state: "accepted", id: "contract-1" },
      latest: { stage: "candidate_final", assessmentCount: 2, reportCount: 1 },
      totals: {
        amendments: 1,
        assessments: 2,
        checkpoints: 3,
        contracts: 1,
        reports: 1,
        snapshots: 3,
      },
      nextAction: { command: "align --root . report", reason: "Regenerate . before reporting." },
    });
    expect(JSON.stringify(status)).not.toContain(projectRoot);
  });

  test("initializes Align from exact stdin while fixing every other authority", async () => {
    const { integrations, projectRoot, alignRoot } = setupFixture();
    const prompt = "  Keep argv-looking text literal: --root /tmp/other\r\nFinal line.\n";

    const status = await integrations.initializeAlign("fixture", { prompt });
    const capture = JSON.parse(readFileSync(join(projectRoot, ".align-fixture.json"), "utf8")) as {
      argv: string[];
      prompt: string;
    };

    expect(status).toMatchObject({
      initialized: true,
      latest: { stage: "in_progress" },
      totals: { checkpoints: 1, snapshots: 1 },
    });
    expect(capture.prompt).toBe(prompt);
    expect(capture.argv[0]).toBe(join(alignRoot, "src/align/__main__.py"));
    expect(capture.argv.slice(1)).toEqual([
      "--root",
      projectRoot,
      "init",
      "--prompt",
      "-",
      "--authority",
      "user",
      "--stage",
      "in_progress",
      "--title",
      "Fixture's project",
    ]);
    expect(capture.argv).not.toContain(prompt);
    expect(JSON.stringify(status)).not.toContain(prompt);
    await expect(
      integrations.initializeAlign("fixture", { prompt: "Replacement intent" }),
    ).rejects.toThrow("already initialized");
  });

  test("admits only one concurrent Align initialization per project", async () => {
    const { integrations } = setupFixture();
    const first = integrations.initializeAlign("fixture", { prompt: "slow:first intent" });
    await Bun.sleep(20);

    await expect(
      integrations.initializeAlign("fixture-alias", { prompt: "second intent" }),
    ).rejects.toThrow("already being initialized");
    await expect(first).resolves.toMatchObject({ initialized: true });
  });

  test("releases Align setup admission after failure and drains accepted setup on close", async () => {
    const failed = setupFixture();
    await expect(
      failed.integrations.initializeAlign("fixture", { prompt: "fail:first intent" }),
    ).rejects.toThrow("rejected the project state");
    await expect(
      failed.integrations.initializeAlign("fixture", { prompt: "retry intent" }),
    ).resolves.toMatchObject({ initialized: true });

    const draining = setupFixture();
    const setup = draining.integrations.initializeAlign("fixture", { prompt: "slow:exact intent" });
    await Bun.sleep(20);
    await expect(draining.integrations.close()).resolves.toBeUndefined();
    await expect(setup).resolves.toMatchObject({ initialized: true });
    await expect(
      draining.integrations.initializeAlign("fixture", { prompt: "later" }),
    ).rejects.toThrow("closed");
  });

  test("isolates Align initialization imports and startup hooks from the selected project", async () => {
    const { integrations, projectRoot, alignRoot } = setupFixture();
    const marker = join(projectRoot, "project-python-executed-during-setup");
    writeFileSync(
      join(projectRoot, "align.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('align shadow')\n`,
    );
    writeFileSync(
      join(projectRoot, "sitecustomize.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('startup hook')\n`,
    );

    await integrations.initializeAlign("fixture", { prompt: "Exact intent" });

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(alignRoot, "src/align/__pycache__"))).toBe(false);
  });

  test("isolates Align imports and startup hooks from the selected project", async () => {
    const { integrations, projectRoot, alignRoot } = fixture();
    const marker = join(projectRoot, "project-python-executed");
    writeFileSync(
      join(projectRoot, "align.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('align shadow')\n`,
    );
    writeFileSync(
      join(projectRoot, "sitecustomize.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('startup hook')\n`,
    );

    await integrations.dispatch("fixture", "align.status", undefined);

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(alignRoot, "src/align/__pycache__"))).toBe(false);
  });

  test("runs Align with bytecode disabled and an explicit isolated environment", async () => {
    const directory = root("integration-python-wrapper");
    const executable = join(directory, "python-recorder");
    const argvFile = join(directory, "argv");
    const envFile = join(directory, "env");
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "${0%/*}/argv"',
        'env | sort > "${0%/*}/env"',
        'exec /usr/bin/python3 "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    const inheritedKey = "IN_PROGRESS_ALIGN_ENV_LEAK";
    const inheritedValue = process.env[inheritedKey];
    process.env[inheritedKey] = "must-not-propagate";
    try {
      const { integrations } = fixture();
      integrations.config.align!.pythonExecutable = executable;

      await integrations.dispatch("fixture", "align.status", undefined);
    } finally {
      if (inheritedValue === undefined) delete process.env[inheritedKey];
      else process.env[inheritedKey] = inheritedValue;
    }

    const argv = readFileSync(argvFile, "utf8").split("\n");
    const environment = readFileSync(envFile, "utf8");
    expect(argv.slice(0, 4)).toEqual(["-I", "-B", "-S", "-c"]);
    expect(environment).toContain("LANG=C.UTF-8\n");
    expect(environment).toContain("LC_ALL=C.UTF-8\n");
    expect(environment).toContain("PATH=/usr/bin:/bin\n");
    expect(environment).not.toContain(`${inheritedKey}=`);
  });

  test("renders only canonical project-local Drift JSON through the configured binary", async () => {
    const { integrations, projectRoot } = fixture();
    writeFileSync(join(projectRoot, "run.drift.json"), "{}\n");

    const rendered = await integrations.dispatch("fixture", "drift.render", {
      path: "run.drift.json",
    });

    expect(rendered).toEqual({
      path: "run.drift.json",
      text: expect.stringContaining("INSPECT — validated"),
    });
    await expect(
      integrations.dispatch("fixture", "drift.render", { path: "../outside.json" }),
    ).rejects.toThrow("File not found");
    await expect(
      integrations.dispatch("fixture", "drift.render", { path: "report.txt" }),
    ).rejects.toThrow("Drift report must be JSON");
  });

  test("suppresses a persisted Align stage outside the current CLI protocol", async () => {
    const { integrations } = fixture("candidate final; echo injected");

    const status = await integrations.dispatch("fixture", "align.status", undefined);

    expect(status).toMatchObject({ latest: { stage: null } });
  });

  test("fails closed when an integration is not configured", async () => {
    const projectRoot = root("integration-disabled");
    const config = configForTests(projectRoot);
    const integrations = new IntegrationRegistry(
      config.integrations,
      new ProjectRegistry(config.projects),
      config.dataDir,
    );

    await expect(integrations.dispatch("fixture", "align.status", undefined)).rejects.toThrow(
      "not configured",
    );
    await expect(
      integrations.initializeAlign("fixture", { prompt: "Exact intent" }),
    ).rejects.toThrow("not configured");
    await expect(
      integrations.dispatch("fixture", "drift.render", { path: "report.json" }),
    ).rejects.toThrow("not configured");
  });

  test("loads Tree Complete's bounded embedded service per host-bound project", async () => {
    const projectRoot = root("tree-project");
    const treeRoot = root("tree-service");
    const moduleDirectory = join(treeRoot, "dist/server/server");
    mkdirSync(moduleDirectory, { recursive: true });
    writeFileSync(
      join(moduleDirectory, "embedded.js"),
      [
        "export const TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES = 4194304;",
        "export async function createEmbeddedService(options) {",
        "  const workspace = {",
        "    project: { id: 'fixture', name: 'Fixture', description: 'Fixture tree', repository: options.targetRepo, defaultBranch: 'main' },",
        "    runner: { mode: options.mode, label: 'Preview', available: true, detail: options.dataDir },",
        "    versions: [{ id: 'base', parentId: null, name: 'Base', branch: 'main', commit: 'abc', createdAt: new Date(0).toISOString(), status: 'ready', summary: options.targetRepo, decisions: [] }],",
        "    runs: [], updatedAt: new Date(0).toISOString()",
        "  };",
        "  return {",
        "    async workspace() { return workspace; },",
        "    async createFork(request) {",
        "      if (request.alternativeId === 'non-json') return undefined;",
        "      const result = structuredClone(workspace);",
        "      if (request.alternativeId === 'malformed') result.versions[0][options.targetRepo] = 'path-bearing key';",
        "      return { runId: 'run-1', versionId: 'version-1', workspace: result };",
        "    },",
        "    async close() { if (options.targetRepo.includes('close-failure')) throw new Error('embedded close failed'); }",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    const config = configForTests(projectRoot, {
      integrations: {
        treeComplete: { sourceDirectory: treeRoot, mode: "preview" },
      },
    });
    const integrations = new IntegrationRegistry(
      config.integrations,
      new ProjectRegistry(config.projects),
      config.dataDir,
    );

    const workspace = await integrations.dispatch("fixture", "tree-complete.workspace", undefined);
    const fork = await integrations.dispatch("fixture", "tree-complete.createFork", {
      baseVersionId: "base",
      decisionId: "storage",
      alternativeId: "sqlite",
    });

    expect(workspace).toMatchObject({
      project: { id: "fixture", repository: "[local path]" },
      runner: { mode: "preview", detail: expect.stringContaining("[local path]") },
      versions: [{ summary: "[local path]" }],
    });
    expect(fork).toMatchObject({ runId: "run-1", versionId: "version-1" });
    expect(JSON.stringify({ workspace, fork })).not.toContain(projectRoot);
    expect(JSON.stringify({ workspace, fork })).not.toContain(treeRoot);
    await expect(
      integrations.dispatch("fixture", "tree-complete.createFork", {
        baseVersionId: "base",
        decisionId: "storage",
        alternativeId: "",
      }),
    ).rejects.toThrow();
    await expect(
      integrations.dispatch("fixture", "tree-complete.createFork", {
        baseVersionId: "base",
        decisionId: "storage",
        alternativeId: "malformed",
      }),
    ).rejects.toThrow("incompatible data");
    await expect(
      integrations.dispatch("fixture", "tree-complete.createFork", {
        baseVersionId: "base",
        decisionId: "storage",
        alternativeId: "non-json",
      }),
    ).rejects.toThrow("non-JSON data");
    await integrations.close();

    const closeFailureRoot = root("tree-close-failure");
    const closeFailureConfig = configForTests(closeFailureRoot, {
      integrations: {
        treeComplete: { sourceDirectory: treeRoot, mode: "preview" },
      },
    });
    const closeFailureRegistry = new IntegrationRegistry(
      closeFailureConfig.integrations,
      new ProjectRegistry(closeFailureConfig.projects),
      closeFailureConfig.dataDir,
    );
    await closeFailureRegistry.dispatch("fixture", "tree-complete.workspace", undefined);
    const firstClose = closeFailureRegistry.close();
    expect(closeFailureRegistry.close()).toBe(firstClose);
    await expect(firstClose).rejects.toThrow("integrations failed to close");
    await expect(
      closeFailureRegistry.dispatch("fixture", "tree-complete.workspace", undefined),
    ).rejects.toThrow("Integration registry is closed");
  });

  test("normalizes Tree Complete initialization failures without exposing host paths", async () => {
    const projectRoot = root("tree-init-project");
    const treeRoot = root("tree-init-service");
    const moduleDirectory = join(treeRoot, "dist/server/server");
    mkdirSync(moduleDirectory, { recursive: true });
    writeFileSync(
      join(moduleDirectory, "embedded.js"),
      "export const TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES = 4194304; export async function createEmbeddedService(options) { throw new Error('failed at ' + options.targetRepo + ' using ' + options.dataDir); }\n",
    );
    const config = configForTests(projectRoot, {
      integrations: {
        treeComplete: { sourceDirectory: treeRoot, mode: "preview" },
      },
    });
    const integrations = new IntegrationRegistry(
      config.integrations,
      new ProjectRegistry(config.projects),
      config.dataDir,
    );

    const failure = await integrations
      .dispatch("fixture", "tree-complete.workspace", undefined)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 503,
      message: "Tree Complete integration could not start",
    });
    expect(String(failure)).not.toContain(projectRoot);
    expect(String(failure)).not.toContain(treeRoot);
    await integrations.close();
  });

  test("closes incompatible Tree Complete services without caching cleanup failures", async () => {
    const treeRoot = root("tree-incompatible-service");
    const moduleDirectory = join(treeRoot, "dist/server/server");
    mkdirSync(moduleDirectory, { recursive: true });
    writeFileSync(
      join(moduleDirectory, "embedded.js"),
      [
        "import { appendFileSync } from 'node:fs';",
        "export const TREE_COMPLETE_PUBLIC_RESPONSE_MAX_BYTES = 4194304;",
        "export async function createEmbeddedService(options) {",
        "  return {",
        "    async workspace() { return {}; },",
        "    async close() {",
        "      appendFileSync(options.targetRepo + '/tree-close.log', 'close\\n');",
        "      if (options.targetRepo.includes('cleanup-failure')) throw new Error('cleanup leaked ' + options.targetRepo);",
        "    }",
        "  };",
        "}",
        "",
      ].join("\n"),
    );

    for (const label of ["cleanup-success", "cleanup-failure"]) {
      const projectRoot = root(`tree-incompatible-${label}`);
      const config = configForTests(projectRoot, {
        integrations: {
          treeComplete: { sourceDirectory: treeRoot, mode: "preview" },
        },
      });
      const integrations = new IntegrationRegistry(
        config.integrations,
        new ProjectRegistry(config.projects),
        config.dataDir,
      );

      const failure = await integrations
        .dispatch("fixture", "tree-complete.workspace", undefined)
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        status: 503,
        message: "Tree Complete embedded service is incompatible",
      });
      expect(String(failure)).not.toContain("cleanup leaked");
      expect(readFileSync(join(projectRoot, "tree-close.log"), "utf8")).toBe("close\n");
      const firstClose = integrations.close();
      expect(integrations.close()).toBe(firstClose);
      await expect(firstClose).resolves.toBeUndefined();
    }
  });

  test("rejects a Tree Complete embedded-module symlink escape", async () => {
    const projectRoot = root("tree-symlink-project");
    const treeRoot = root("tree-symlink-service");
    const outside = root("tree-symlink-outside");
    const moduleDirectory = join(treeRoot, "dist/server/server");
    mkdirSync(moduleDirectory, { recursive: true });
    const outsideModule = join(outside, "embedded.js");
    writeFileSync(outsideModule, "export async function createEmbeddedService() {}\n");
    symlinkSync(outsideModule, join(moduleDirectory, "embedded.js"));
    const config = configForTests(projectRoot, {
      integrations: {
        treeComplete: { sourceDirectory: treeRoot, mode: "preview" },
      },
    });
    const integrations = new IntegrationRegistry(
      config.integrations,
      new ProjectRegistry(config.projects),
      config.dataDir,
    );

    await expect(
      integrations.dispatch("fixture", "tree-complete.workspace", undefined),
    ).rejects.toThrow("Tree Complete integration is not built");
    await integrations.close();
  });
});
