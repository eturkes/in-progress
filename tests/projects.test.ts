import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ProjectRegistry } from "../src/server/projects";
import { fixtureProject, removeDirectory, tempDirectory } from "./helpers";

const roots: string[] = [];

function root(label: string): string {
  const path = tempDirectory(label);
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) removeDirectory(path);
});

describe("ProjectRegistry filesystem boundary", () => {
  test("reads Git status asynchronously and shares the short-lived result", async () => {
    const directory = root("git");
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: directory }).success).toBeTrue();
    writeFileSync(join(directory, "staged.txt"), "staged\n");
    writeFileSync(join(directory, "untracked.txt"), "untracked\n");
    const fsmonitor = join(directory, ".git/hooks/project-fsmonitor");
    const marker = join(directory, ".git/fsmonitor-executed");
    writeFileSync(
      fsmonitor,
      `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\nprintf token\\n\n`,
    );
    chmodSync(fsmonitor, 0o755);
    expect(Bun.spawnSync(["git", "add", "staged.txt"], { cwd: directory }).success).toBeTrue();
    expect(
      Bun.spawnSync(["git", "config", "core.fsmonitor", fsmonitor], { cwd: directory }).success,
    ).toBeTrue();
    const registry = new ProjectRegistry([fixtureProject(directory)]);

    const first = registry.git("fixture");
    const second = registry.git("fixture");

    expect(first).toBe(second);
    expect(await first).toMatchObject({
      available: true,
      staged: 1,
      modified: 0,
      untracked: 1,
      clean: false,
    });
    expect(existsSync(marker)).toBeFalse();
    expect((await registry.dto(registry.get("fixture"))).branch).toBeString();
  });

  test("distinguishes unavailable Git status from a verified clean worktree", async () => {
    const directory = root("not-git");
    const registry = new ProjectRegistry([fixtureProject(directory)]);

    expect(await registry.git("fixture")).toEqual({
      available: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      clean: false,
    });
  });

  test("tree skips generated directories without truncating later siblings", async () => {
    const directory = root("tree");
    mkdirSync(join(directory, ".git"));
    writeFileSync(join(directory, ".git", "secret"), "hidden");
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "main.ts"), "export {};\n");
    writeFileSync(join(directory, "README.md"), "visible\n");
    const registry = new ProjectRegistry([fixtureProject(directory)]);

    const tree = await registry.tree("fixture", { depth: 3, limit: 100 });

    expect(tree.map((entry) => entry.path)).toContain("README.md");
    expect(tree.map((entry) => entry.path)).toContain("src/main.ts");
    expect(tree.some((entry) => entry.path.startsWith(".git"))).toBeFalse();
  });

  test("tree reports symlinks but never traverses them", async () => {
    const directory = root("tree-link");
    const outside = root("tree-outside");
    writeFileSync(join(outside, "private.txt"), "outside");
    symlinkSync(outside, join(directory, "linked"));
    const registry = new ProjectRegistry([fixtureProject(directory)]);

    const tree = await registry.tree("fixture", { depth: 6, limit: 100 });

    expect(tree).toContainEqual({ path: "linked", name: "linked", kind: "symlink", depth: 0 });
    expect(tree.some((entry) => entry.path.includes("private.txt"))).toBeFalse();
  });

  test("readText reads bounded text and rejects traversal, symlink escape, and binary content", async () => {
    const directory = root("read");
    const outside = root("outside");
    writeFileSync(join(directory, "plain.txt"), "hello\n");
    writeFileSync(join(directory, "large.txt"), "x".repeat(256 * 1024 + 17));
    writeFileSync(join(directory, "binary.bin"), new Uint8Array([1, 0, 2]));
    writeFileSync(join(outside, "private.txt"), "outside\n");
    symlinkSync(join(outside, "private.txt"), join(directory, "escape.txt"));
    const registry = new ProjectRegistry([fixtureProject(directory)]);

    expect(await registry.readText("fixture", { path: "plain.txt" })).toEqual({
      path: "plain.txt",
      text: "hello\n",
      truncated: false,
    });
    const large = await registry.readText("fixture", { path: "large.txt" });
    expect(large.text.length).toBe(256 * 1024);
    expect(large.truncated).toBeTrue();
    await expect(
      registry.readText("fixture", { path: relative(directory, join(outside, "private.txt")) }),
    ).rejects.toThrow("Path escapes project root");
    await expect(registry.readText("fixture", { path: "escape.txt" })).rejects.toThrow(
      "Path escapes project root",
    );
    await expect(
      registry.readText("fixture", { path: join(directory, "plain.txt") }),
    ).rejects.toThrow("Absolute paths are not allowed");
    await expect(registry.readText("fixture", { path: "binary.bin" })).rejects.toThrow(
      "Binary files",
    );
  });
});
