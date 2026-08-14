import { tmpdir } from "node:os";
import { join } from "node:path";

export const BROWSER_TEST_PORT = 4397;
export const BROWSER_TEST_HOST_ROOT = join(
  tmpdir(),
  `in-progress-browser-host-${BROWSER_TEST_PORT}`,
);
export const BROWSER_TEST_OUTPUT_ROOT = join(
  tmpdir(),
  `in-progress-browser-output-${BROWSER_TEST_PORT}`,
);
