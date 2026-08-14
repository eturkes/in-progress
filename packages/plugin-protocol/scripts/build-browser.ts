import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "dist/browser.iife.js");
await mkdir(resolve(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, "src/browser-global.ts")],
  format: "iife",
  minify: true,
  naming: "browser.iife.js",
  outdir: resolve(root, "dist"),
  sourcemap: "none",
  target: "browser",
});
if (!result.success || !(await Bun.file(output).exists())) {
  for (const log of result.logs) console.error(log);
  throw new Error("Protocol browser bundle failed");
}
const browser = await readFile(output, "utf8");
await writeFile(
  output,
  `${browser
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()}\n`,
  "utf8",
);
