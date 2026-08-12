const expected = new Map([
  ["cargo", "cargo 1.97.1 (c980f4866 2026-06-30)"],
  ["rustc", "rustc 1.97.1 (8bab26f4f 2026-07-14)"],
]);

for (const [command, version] of expected) {
  const check = Bun.spawnSync([command, "--version"], { stderr: "pipe", stdout: "pipe" });
  if (!check.success) {
    throw new Error(`${command} --version failed: ${check.stderr.toString().trim()}`);
  }
  const actual = check.stdout.toString().trim();
  if (!(actual === version || actual.startsWith(`${version} `))) {
    throw new Error(`frontier requires ${version}; received ${actual}`);
  }
}
