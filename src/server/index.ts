import { createControlPlane } from "./app";
import { loadConfig } from "./config";

const config = await loadConfig();
const app = createControlPlane(config);

console.log(`Switchyard listening at ${app.server.url}`);
if (config.server.host === "127.0.0.1") {
  console.log(`Private mobile HTTPS: tailscale serve --bg ${app.server.port}`);
}

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  console.log(`Stopping Switchyard (${signal})`);
  await app.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
