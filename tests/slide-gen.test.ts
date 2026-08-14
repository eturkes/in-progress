import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configForTests } from "../src/server/config";
import { IntegrationRegistry } from "../src/server/integrations";
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

function executable(path: string, body = "#!/bin/sh\nexit 0\n"): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function fixture(): {
  artifacts: string;
  config: ReturnType<typeof configForTests>;
  data: string;
  project: string;
  registry: IntegrationRegistry;
} {
  const home = root("slide-gen");
  const project = join(home, "project");
  const tool = join(home, "tool");
  const artifacts = join(home, "artifacts");
  const data = join(home, "data");
  mkdirSync(project);
  mkdirSync(tool);
  mkdirSync(artifacts);
  const slideGen = executable(
    join(tool, "slide-gen.exe"),
    [
      "#!/bin/sh",
      "set -eu",
      "operation=$1",
      "shift",
      "source=",
      "artifacts=",
      'while [ "$#" -gt 0 ]; do',
      "  case $1 in",
      "    --source) source=$2; shift 2 ;;",
      "    --artifact-root) artifacts=$2; shift 2 ;;",
      "    --) shift; break ;;",
      "    *) exit 91 ;;",
      "  esac",
      "done",
      "project=$1",
      'printf \'%s|%s|%s|%s\\n\' "$operation" "$source" "$artifacts" "$project" > "$artifacts/last-argv"',
      'if [ "$operation" = generate ]; then',
      '  [ -n "$source" ] || exit 92',
      '  [ ! -e "$source/slow" ] || sleep 2',
      '  mkdir -p "$artifacts/decks/$project"',
      '  printf \'<!doctype html><title>%s</title>\\n\' "$project" > "$artifacts/decks/$project/deck.html"',
      "  exit 0",
      "fi",
      '[ "$operation" = render ] || exit 93',
      '[ -f "$artifacts/decks/$project/deck.html" ] || exit 94',
      'mkdir -p "$artifacts/renders/$project"',
      "printf '\\211PNG\\r\\n\\032\\n\\000\\000\\000\\rIHDR\\000\\000\\012\\000\\000\\000\\005\\240' > \"$artifacts/renders/$project/page_01.png\"",
      "printf '%%PDF-1.7\\nfixture\\n' > \"$artifacts/renders/$project/deck.pdf\"",
      "",
    ].join("\n"),
  );
  const config = configForTests(home, {
    dataDir: data,
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
      slideGen: {
        sourceDirectory: tool,
        artifactDirectory: artifacts,
        executable: slideGen,
        codexExecutable: executable(join(tool, "codex")),
        uvExecutable: executable(join(tool, "uv")),
        chromiumfishExecutable: executable(join(tool, "chromiumfish")),
      },
    },
  });
  const projects = new ProjectRegistry(config.projects);
  return {
    artifacts,
    config,
    data,
    project,
    registry: new IntegrationRegistry(config.integrations, projects, data),
  };
}

describe("slide-gen integration", () => {
  test("publishes validated receipts and restores them across host instances", async () => {
    const instance = fixture();
    expect(await instance.registry.dispatch("fixture", "slide-gen.status", undefined)).toEqual({
      projectId: "fixture",
      sourceAvailable: true,
      busy: false,
      deck: null,
      render: null,
      lastReceipt: null,
    });

    const generated = (await instance.registry.dispatch(
      "fixture",
      "slide-gen.generate",
      undefined,
    )) as {
      receipt: { kind: string; deckSha256: string | null; pageCount: number };
      status: { busy: boolean; deck: unknown; render: unknown };
    };
    const deck = readFileSync(join(instance.artifacts, "decks/fixture/deck.html"));
    expect(generated.receipt).toMatchObject({
      kind: "generate",
      deckSha256: createHash("sha256").update(deck).digest("hex"),
      pageCount: 0,
    });
    expect(generated.status).toMatchObject({ busy: false, render: null });
    expect(generated.status.deck).not.toBeNull();
    expect(readFileSync(join(instance.artifacts, "last-argv"), "utf8")).toBe(
      `generate|${instance.project}|${instance.artifacts}|fixture\n`,
    );

    const rendered = (await instance.registry.dispatch(
      "fixture",
      "slide-gen.render",
      undefined,
    )) as {
      receipt: { kind: string; pdfSha256: string | null; pageCount: number };
      status: { render: { pageCount: number } | null };
    };
    const pdf = readFileSync(join(instance.artifacts, "renders/fixture/deck.pdf"));
    expect(rendered.receipt).toMatchObject({
      kind: "render",
      pdfSha256: createHash("sha256").update(pdf).digest("hex"),
      pageCount: 1,
    });
    expect(rendered.status.render?.pageCount).toBe(1);
    expect(readFileSync(join(instance.artifacts, "last-argv"), "utf8")).toBe(
      `render||${instance.artifacts}|fixture\n`,
    );

    await instance.registry.close();
    const restored = new IntegrationRegistry(
      instance.config.integrations,
      new ProjectRegistry(instance.config.projects),
      instance.data,
    );
    const status = (await restored.dispatch("fixture", "slide-gen.status", undefined)) as {
      lastReceipt: { kind: string } | null;
      render: { pageCount: number } | null;
    };
    expect(status.lastReceipt?.kind).toBe("render");
    expect(status.render?.pageCount).toBe(1);
    await restored.close();
  });

  test("serializes each project and cancels its subprocess group on close", async () => {
    const instance = fixture();
    writeFileSync(join(instance.project, "slow"), "slow\n");
    const active = instance.registry.dispatch("fixture", "slide-gen.generate", undefined);
    await expect(
      instance.registry.dispatch("fixture", "slide-gen.render", undefined),
    ).rejects.toMatchObject({ status: 409 });
    for (
      let attempt = 0;
      attempt < 100 && !existsSync(join(instance.artifacts, "last-argv"));
      attempt += 1
    ) {
      await Bun.sleep(10);
    }
    expect(existsSync(join(instance.artifacts, "last-argv"))).toBe(true);
    await instance.registry.close();
    await expect(active).rejects.toThrow("canceled");
  });

  test("rejects an open or malformed render layout", async () => {
    const instance = fixture();
    await instance.registry.dispatch("fixture", "slide-gen.generate", undefined);
    await instance.registry.dispatch("fixture", "slide-gen.render", undefined);
    writeFileSync(join(instance.artifacts, "renders/fixture/unexpected.txt"), "unexpected\n");
    await expect(
      instance.registry.dispatch("fixture", "slide-gen.status", undefined),
    ).rejects.toThrow("render layout is invalid");
    await instance.registry.close();
  });
});
