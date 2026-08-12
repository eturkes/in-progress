import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configForTests, type InProgressConfig } from "../src/server/config";
import { PreviewService } from "../src/server/preview";
import { ProjectRegistry } from "../src/server/projects";
import { removeDirectory, tempDirectory } from "./helpers";

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) removeDirectory(path);
});

function fixture(options: { delay?: boolean; fail?: boolean } = {}): {
  config: InProgressConfig;
  log: string;
  project: string;
  service: PreviewService;
} {
  const root = tempDirectory("preview-service");
  roots.push(root);
  const project = join(root, "project");
  const source = join(root, "preview-source");
  const artifacts = join(root, "artifacts");
  const codex = join(root, "codex");
  const executable = join(source, "bin/preview");
  const log = join(root, "argv.log");
  mkdirSync(project);
  mkdirSync(join(source, "bin"), { recursive: true });
  mkdirSync(artifacts);
  writeFileSync(codex, "#!/bin/sh\nexit 0\n");
  chmodSync(codex, 0o755);
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      `printf 'CALL\\n' >> ${JSON.stringify(log)}`,
      `printf '%s\\n' "$@" >> ${JSON.stringify(log)}`,
      `printf 'END\\n' >> ${JSON.stringify(log)}`,
      options.delay ? '[ "$1" != generate ] || sleep 0.2' : "true",
      options.fail ? '[ "$1" != generate ] || exit 9' : "true",
      'if [ "$1" = plugin-build ]; then',
      "  shift",
      "  artifact=",
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = --artifact-root ]; then artifact=$2; shift 2; else shift; fi',
      "  done",
      '  mkdir -p "$artifact/in-progress-plugin"',
      '  printf \'%s\\n\' \'{"schemaVersion":1,"projects":["fixture"]}\' > "$artifact/in-progress-plugin/preview-index.json"',
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  const config = configForTests(root, {
    projects: [
      {
        id: "fixture",
        name: "Fixture",
        path: project,
        displayPath: project,
        color: "#67d5b5",
      },
    ],
    integrations: {
      preview: {
        sourceDirectory: source,
        executable,
        artifactDirectory: artifacts,
        codexExecutable: codex,
      },
    },
  });
  const service = new PreviewService(
    config.integrations.preview,
    new ProjectRegistry(config.projects),
  );
  return { config, log, project, service };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settle(service: PreviewService): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.status("fixture").state !== "generating") return;
    await Bun.sleep(20);
  }
  throw new Error("Preview fixture did not settle");
}

describe("Preview generation service", () => {
  test("generates externally with fixed source, artifact, and subscription CLI authority", async () => {
    const { config, log, project, service } = fixture();
    expect(service.status("fixture")).toMatchObject({ dashboard: false, state: "idle" });
    expect(service.start("fixture")).toMatchObject({ state: "generating" });

    await settle(service);

    expect(service.status("fixture")).toMatchObject({
      dashboard: true,
      state: "idle",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      revision: 1,
    });
    expect(readdirSync(project)).toEqual([]);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(
      [
        "CALL",
        "generate",
        "fixture",
        "--source",
        project,
        "--artifact-root",
        config.integrations.preview!.artifactDirectory,
        "--codex-executable",
        config.integrations.preview!.codexExecutable,
        "END",
      ].join("\n"),
    );
    expect(calls).toContain("CALL\nplugin-build\n--artifact-root");
    expect(calls).toContain(`--source\nfixture\n${project}\nEND`);
    await service.close();
  });

  test("admits one aggregate-changing job at a time", async () => {
    const { service } = fixture({ delay: true });
    service.start("fixture");

    expect(() => service.start("fixture")).toThrow("already running");

    await settle(service);
    await service.close();
  });

  test("preserves the prior packaged dashboard and exposes a bounded failure", async () => {
    const { config, service } = fixture({ fail: true });
    const output = join(config.integrations.preview!.artifactDirectory, "in-progress-plugin");
    mkdirSync(output);
    writeFileSync(
      join(output, "preview-index.json"),
      '{"schemaVersion":1,"projects":["fixture"]}\n',
    );

    service.start("fixture");
    await settle(service);

    expect(service.status("fixture")).toMatchObject({
      dashboard: true,
      state: "error",
      revision: 0,
      error: "Preview generation rejected the project state",
    });
    await service.close();
  });

  test("rejects a malformed dashboard index before starting paid work", async () => {
    const { config, log, service } = fixture();
    const output = join(config.integrations.preview!.artifactDirectory, "in-progress-plugin");
    mkdirSync(output);
    writeFileSync(join(output, "preview-index.json"), '{"schemaVersion":1,"projects":null}\n');

    expect(() => service.start("fixture")).toThrow("Preview dashboard index is invalid");
    expect(existsSync(log)).toBe(false);
    await service.close();
  });

  test("cancels an active generation process group during shutdown", async () => {
    const fixtureRoot = tempDirectory("preview-cancellation");
    roots.push(fixtureRoot);
    const project = join(fixtureRoot, "project");
    const source = join(fixtureRoot, "preview-source");
    const artifacts = join(fixtureRoot, "artifacts");
    const codex = join(fixtureRoot, "codex");
    const executable = join(source, "bin/preview");
    const pidFile = join(fixtureRoot, "child.pid");
    mkdirSync(project);
    mkdirSync(join(source, "bin"), { recursive: true });
    mkdirSync(artifacts);
    writeFileSync(codex, "#!/bin/sh\nexit 0\n");
    chmodSync(codex, 0o755);
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        'trap \'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 143\' TERM',
        "sleep 30 & child=$!",
        `printf '%s\\n' "$child" > ${JSON.stringify(pidFile)}`,
        'wait "$child"',
        "",
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    const config = configForTests(fixtureRoot, {
      projects: [
        {
          id: "fixture",
          name: "Fixture",
          path: project,
          displayPath: project,
          color: "#67d5b5",
        },
      ],
      integrations: {
        preview: {
          sourceDirectory: source,
          executable,
          artifactDirectory: artifacts,
          codexExecutable: codex,
        },
      },
    });
    const service = new PreviewService(
      config.integrations.preview,
      new ProjectRegistry(config.projects),
    );
    service.start("fixture");
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) {
      await Bun.sleep(10);
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const started = performance.now();

    await service.close();

    expect(performance.now() - started).toBeLessThan(2_000);
    for (let attempt = 0; attempt < 100 && alive(pid); attempt += 1) await Bun.sleep(10);
    const leaked = alive(pid);
    if (leaked) process.kill(pid, "SIGKILL");
    expect(leaked).toBe(false);
  });
});
