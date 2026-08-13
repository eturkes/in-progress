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
import { StateStore } from "../src/server/store";
import { removeDirectory, tempDirectory } from "./helpers";

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) removeDirectory(path);
});

function fixture(options: { delay?: boolean; fail?: boolean } = {}): {
  config: InProgressConfig;
  log: string;
  promptLog: string;
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
  const promptLog = join(root, "prompt.log");
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
      'if [ "$1" = generate ]; then',
      "  shift; artifact=; source=; strategy=update",
      '  while [ "$#" -gt 0 ]; do',
      '    case "$1" in',
      "      --artifact-root) artifact=$2; shift 2;;",
      "      --source) source=$2; shift 2;;",
      "      --from-scratch) strategy=fresh; shift;;",
      "      *) shift;;",
      "    esac",
      "  done",
      `  cat > ${JSON.stringify(promptLog)}`,
      `  prompt_json=$(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1], encoding="utf-8").read()))' ${JSON.stringify(promptLog)})`,
      '  revision=$(git -C "$source" rev-parse --verify HEAD 2>/dev/null || true)',
      '  if [ -n "$revision" ]; then revision_json="\\\"$revision\\\""; else revision_json=null; fi',
      '  mkdir -p "$artifact/previews/.records"',
      `  printf '{"basedOnSourceRevision":null,"project":"fixture","prompt":%s,"schemaVersion":1,"sourceDirty":false,"sourceRevision":%s,"strategy":"%s"}\n' "$prompt_json" "$revision_json" "$strategy" > "$artifact/previews/.records/fixture.json"`,
      "fi",
      'if [ "$1" = plugin-build ]; then',
      "  shift",
      "  artifact=",
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = --artifact-root ]; then artifact=$2; shift 2; else shift; fi',
      "  done",
      '  mkdir -p "$artifact/in-progress-plugin"',
      "  generation=",
      '  if [ -f "$artifact/previews/.records/fixture.json" ]; then generation=$(cat "$artifact/previews/.records/fixture.json"); fi',
      `  printf '{"generations":[%s],"projects":["fixture"],"schemaVersion":1}\n' "$generation" > "$artifact/in-progress-plugin/preview-index.json"`,
      '  if [ ! -d "$artifact/.git" ]; then git -C "$artifact" init -q --initial-branch=main; fi',
      '  git -C "$artifact" add --all -- previews in-progress-plugin',
      '  git -C "$artifact" diff --cached --quiet || git -C "$artifact" -c user.name=Fixture -c user.email=fixture@localhost commit -qm "fixture snapshot"',
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
    new StateStore(root, true),
    { automaticIntervalMs: 0 },
  );
  return { config, log, promptLog, project, service };
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
    if ((await service.status("fixture")).state !== "generating") return;
    await Bun.sleep(20);
  }
  throw new Error("Preview fixture did not settle");
}

function commit(project: string, name: string, content: string): string {
  if (!existsSync(join(project, ".git"))) {
    expect(Bun.spawnSync(["git", "init", "--initial-branch=main"], { cwd: project }).success).toBe(
      true,
    );
  }
  writeFileSync(join(project, name), content);
  expect(Bun.spawnSync(["git", "add", "--", name], { cwd: project }).success).toBe(true);
  expect(
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-m",
        `fixture ${name}`,
      ],
      { cwd: project },
    ).success,
  ).toBe(true);
  return new TextDecoder()
    .decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: project }).stdout)
    .trim();
}

describe("Preview generation service", () => {
  test("generates externally with fixed source, artifact, and subscription CLI authority", async () => {
    const { config, log, project, service } = fixture();
    expect(await service.status("fixture")).toMatchObject({ dashboard: false, state: "idle" });
    expect(await service.start("fixture", { strategy: "update", prompt: "" })).toMatchObject({
      state: "generating",
    });

    await settle(service);

    expect(await service.status("fixture")).toMatchObject({
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
        "--prompt-stdin",
        "END",
      ].join("\n"),
    );
    expect(calls).toContain("CALL\nplugin-build\n--artifact-root");
    expect(calls).toContain(`--source\nfixture\n${project}\nEND`);
    await service.close();
  });

  test("admits one aggregate-changing job at a time", async () => {
    const { service } = fixture({ delay: true });
    await service.start("fixture", { strategy: "update", prompt: "" });

    await expect(service.start("fixture", { strategy: "update", prompt: "" })).rejects.toThrow(
      "already running",
    );

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

    await service.start("fixture", { strategy: "update", prompt: "" });
    await settle(service);

    expect(await service.status("fixture")).toMatchObject({
      dashboard: true,
      state: "error",
      revision: 0,
      error: "Preview generation rejected the project state",
    });
    await service.close();
  });

  test("derives generated revision only from the atomically packaged record", async () => {
    const { config, service } = fixture();
    const artifacts = config.integrations.preview!.artifactDirectory;
    const output = join(artifacts, "in-progress-plugin");
    mkdirSync(output);
    writeFileSync(
      join(output, "preview-index.json"),
      '{"schemaVersion":1,"projects":["fixture"]}\n',
    );
    mkdirSync(join(artifacts, "previews/.records"), { recursive: true });
    writeFileSync(
      join(artifacts, "previews/.records/fixture.json"),
      '{"basedOnSourceRevision":null,"project":"fixture","prompt":"","schemaVersion":1,"sourceDirty":false,"sourceRevision":null,"strategy":"fresh"}\n',
    );

    expect(await service.status("fixture")).toMatchObject({
      dashboard: true,
      generatedRevision: null,
      stale: true,
    });
    await service.close();
  });

  test("rejects a malformed dashboard index before starting paid work", async () => {
    const { config, log, service } = fixture();
    const output = join(config.integrations.preview!.artifactDirectory, "in-progress-plugin");
    mkdirSync(output);
    writeFileSync(join(output, "preview-index.json"), '{"schemaVersion":1,"projects":null}\n');

    await expect(service.start("fixture", { strategy: "update", prompt: "" })).rejects.toThrow(
      "Preview dashboard index is invalid",
    );
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
      new StateStore(fixtureRoot, true),
      { automaticIntervalMs: 0 },
    );
    await service.start("fixture", { strategy: "update", prompt: "" });
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

  test("automatic mode runs once per clean commit and reuses the saved prompt", async () => {
    const { log, promptLog, project, service } = fixture();
    const firstRevision = commit(project, "first.txt", "first\n");

    await service.configure("fixture", {
      mode: "automatic",
      prompt: "Emphasize the durable workflow.",
    });
    await service.scanAutomatic();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await service.status("fixture");
      if (status.dashboard && status.state !== "generating") break;
      await Bun.sleep(20);
    }

    expect(await service.status("fixture")).toMatchObject({
      mode: "automatic",
      dashboard: true,
      generatedRevision: firstRevision,
      stale: false,
    });
    expect(readFileSync(promptLog, "utf8")).toBe("Emphasize the durable workflow.");
    const firstCalls = readFileSync(log, "utf8");
    expect(firstCalls).toContain(`--expected-revision\n${firstRevision}`);
    expect(firstCalls).toContain("--from-scratch");

    await service.scanAutomatic();
    expect(readFileSync(log, "utf8")).toBe(firstCalls);

    await service.configure("fixture", {
      mode: "automatic",
      prompt: "Emphasize the revised operator path.",
    });
    await service.scanAutomatic();
    await settle(service);
    expect(readFileSync(promptLog, "utf8")).toBe("Emphasize the revised operator path.");
    const promptUpdateCalls = readFileSync(log, "utf8");
    expect(promptUpdateCalls).not.toBe(firstCalls);
    expect((await service.status("fixture")).stale).toBe(false);

    const secondRevision = commit(project, "second.txt", "second\n");
    await Bun.sleep(2_050);
    await service.scanAutomatic();
    await settle(service);

    expect(await service.status("fixture")).toMatchObject({
      generatedRevision: secondRevision,
      stale: false,
    });
    const secondCalls = readFileSync(log, "utf8");
    expect(secondCalls.match(/\n--expected-revision\n/g)?.length).toBe(3);
    expect(secondCalls.match(/\n--from-scratch\n/g)?.length).toBe(1);
    await service.close();
  });

  test("automatic failure is suppressed until the source commit changes", async () => {
    const { log, project, service } = fixture({ fail: true });
    const failedRevision = commit(project, "first.txt", "first\n");
    await service.configure("fixture", { mode: "automatic", prompt: "" });
    await service.scanAutomatic();
    await settle(service);

    const failed = await service.status("fixture");
    expect(failed).toMatchObject({ state: "error", generatedRevision: null });
    expect(failed.automaticBlockedReason).toContain("already failed for this commit");
    const firstCalls = readFileSync(log, "utf8");
    expect(firstCalls).toContain(failedRevision);

    await service.scanAutomatic();
    expect(readFileSync(log, "utf8")).toBe(firstCalls);

    commit(project, "second.txt", "second\n");
    await Bun.sleep(2_050);
    await service.scanAutomatic();
    await settle(service);
    expect(readFileSync(log, "utf8")).not.toBe(firstCalls);
    await service.close();
  });

  test("automatic mode waits without spending while the worktree is dirty", async () => {
    const { log, project, service } = fixture();
    commit(project, "tracked.txt", "committed\n");
    writeFileSync(join(project, "tracked.txt"), "dirty\n");

    const configured = await service.configure("fixture", {
      mode: "automatic",
      prompt: "",
    });
    await service.scanAutomatic();

    expect(configured.automaticBlockedReason).toContain("clean worktree");
    expect(existsSync(log)).toBe(false);
    await service.close();
  });
});
