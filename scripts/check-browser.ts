import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { BROWSER_TEST_HOST_ROOT, BROWSER_TEST_OUTPUT_ROOT } from "./browser-test-contract";

const root = resolve(import.meta.dir, "..");
let exitCode = 1;
try {
  const lookup = Bun.spawnSync(["chromiumfish", "path"], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (lookup.exitCode !== 0) throw new Error("chromiumfish path failed");
  const executable = lookup.stdout.toString().trim();
  if (!executable) throw new Error("chromiumfish returned an empty executable path");

  const test = Bun.spawn(["pnpm", "exec", "playwright", "test"], {
    cwd: root,
    env: { ...process.env, CHROMIUM_PATH: executable },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await test.exited;
} finally {
  await Promise.all([
    rm(BROWSER_TEST_HOST_ROOT, { recursive: true, force: true }),
    rm(BROWSER_TEST_OUTPUT_ROOT, { recursive: true, force: true }),
  ]);
}

process.exit(exitCode);
