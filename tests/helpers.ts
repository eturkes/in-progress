import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectConfig } from "../src/server/config";

export function tempDirectory(label: string): string {
  return mkdtempSync(join(tmpdir(), `switchyard-${label}-`));
}

export function removeDirectory(path: string): void {
  rmSync(path, { force: true, recursive: true });
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function fixtureProject(root: string, id = "fixture"): ProjectConfig {
  return {
    id,
    name: "Fixture",
    path: root,
    displayPath: root,
    color: "#67d5b5",
  };
}
