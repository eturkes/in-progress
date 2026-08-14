import { defineConfig } from "@playwright/test";
import { BROWSER_TEST_OUTPUT_ROOT, BROWSER_TEST_PORT } from "./scripts/browser-test-contract";

const executablePath = process.env.CHROMIUM_PATH;
if (!executablePath) throw new Error("Set CHROMIUM_PATH to the ChromiumFish executable");

export default defineConfig({
  testDir: "./e2e",
  outputDir: BROWSER_TEST_OUTPUT_ROOT,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${BROWSER_TEST_PORT}`,
    browserName: "chromium",
    launchOptions: { executablePath },
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun scripts/start-browser-test.ts",
    url: `http://127.0.0.1:${BROWSER_TEST_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
