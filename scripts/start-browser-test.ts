import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createControlPlane } from "../src/server/app";
import { configForTests } from "../src/server/config";
import { BROWSER_TEST_HOST_ROOT, BROWSER_TEST_PORT } from "./browser-test-contract";

const root = resolve(import.meta.dir, "..");
const scratch = BROWSER_TEST_HOST_ROOT;
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { mode: 0o700 });
const zmxDirectory = join(scratch, "zmx");
await mkdir(zmxDirectory, { mode: 0o700 });

const port = BROWSER_TEST_PORT;

const base = configForTests(root);
const config = configForTests(root, {
  configPath: join(root, "in-progress.browser.test.json"),
  dataDir: scratch,
  server: { ...base.server, port },
  projects: [
    {
      id: "in-progress",
      name: "in-progress",
      path: root,
      displayPath: root,
      color: "#67d5b5",
    },
  ],
  pluginDirectories: [resolve(root, "examples/plugins")],
});

const app = createControlPlane(config, {
  memoryStore: true,
  terminal: { terminateOnClose: true, zmxDirectory },
});
console.log(`Browser test host listening at ${app.server.url}`);

let stop: (() => void) | undefined;
const stopped = new Promise<void>((resolveStopped) => {
  stop = resolveStopped;
});
let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } finally {
    await rm(scratch, { recursive: true, force: true });
    stop?.();
  }
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await stopped;
