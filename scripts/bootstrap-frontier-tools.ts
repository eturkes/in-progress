import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const quintHome = join(root, ".data/frontier/quint");

const apalache = {
  url: "https://github.com/apalache-mc/apalache/releases/download/v0.56.1/apalache.tgz",
  archiveSha256: "91125e5a3646b9c9d3a7d921d3323f321fac5071909f72b3960c66ff2f998ee1",
  installDirectory: join(quintHome, "apalache-dist-0.56.1"),
  files: new Map([
    [
      "apalache/bin/apalache-mc",
      "bda52d2dbdbc7f6e95289a69dfe7ddeb162493ddd3501898d33ea7d1da3a8cd7",
    ],
    [
      "apalache/lib/apalache.jar",
      "4753c0ebb2cbb266e2c6ac19ab5ca3827d726cc80fd1fc5d7c1eeb64736cd60b",
    ],
  ]),
};

const evaluator = {
  url: "https://github.com/quint-co/quint/releases/download/evaluator/v0.6.0/quint_evaluator-x86_64-unknown-linux-gnu.tar.gz",
  archiveSha256: "61755a09d5052d93a4e75e840059edfd0d3674aeda164b9d2464be3d6e21b1c2",
  installDirectory: join(quintHome, "rust-evaluator-v0.6.0"),
  files: new Map([
    ["quint_evaluator", "b2efdeac5713d153e41bf2143b94ed75d888fdd5637f4a5d61a04c695313510a"],
  ]),
};

type Tool = typeof apalache;

async function digest(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

async function installed(tool: Tool): Promise<boolean> {
  for (const [relativePath, expected] of tool.files) {
    const file = join(tool.installDirectory, relativePath);
    if (!(await Bun.file(file).exists())) return false;
    const actual = await digest(file);
    if (actual !== expected)
      throw new Error(
        `frontier tool digest mismatch: ${file}\nexpected ${expected}\nactual   ${actual}`,
      );
  }
  return true;
}

async function install(tool: Tool): Promise<void> {
  const scratch = await mkdtemp(join(quintHome, "bootstrap-"));
  try {
    const archive = join(scratch, "tool.tgz");
    const response = await fetch(tool.url);
    if (!response.ok)
      throw new Error(`frontier tool download failed: ${response.status} ${tool.url}`);
    await Bun.write(archive, await response.arrayBuffer());
    const actual = await digest(archive);
    if (actual !== tool.archiveSha256) {
      throw new Error(
        `frontier tool archive digest mismatch: ${tool.url}\nexpected ${tool.archiveSha256}\nactual   ${actual}`,
      );
    }
    const unpacked = join(scratch, "unpacked");
    await mkdir(unpacked);
    const extraction = Bun.spawnSync(["tar", "-xzf", archive, "-C", unpacked], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!extraction.success) throw new Error(`frontier tool extraction failed: ${tool.url}`);
    const entries = await Array.fromAsync(
      new Bun.Glob("*").scan({ cwd: unpacked, onlyFiles: false }),
    );
    await rm(tool.installDirectory, { recursive: true, force: true });
    await mkdir(tool.installDirectory, { recursive: true, mode: 0o700 });
    for (const entry of entries)
      await rename(join(unpacked, entry), join(tool.installDirectory, entry));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (!(await installed(tool)))
    throw new Error(`frontier tool installation incomplete: ${tool.url}`);
}

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(
    `frontier formal gate supports linux/x64, received ${process.platform}/${process.arch}`,
  );
}
await mkdir(quintHome, { recursive: true, mode: 0o700 });
await chmod(join(root, ".data/frontier"), 0o700);
await chmod(quintHome, 0o700);
for (const tool of [apalache, evaluator]) if (!(await installed(tool))) await install(tool);
await chmod(join(apalache.installDirectory, "apalache/bin/apalache-mc"), 0o700);
await chmod(join(evaluator.installDirectory, "quint_evaluator"), 0o700);
