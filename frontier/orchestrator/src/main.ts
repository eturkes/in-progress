import { createServer, type Http2Server } from "node:http2";

import * as restate from "@restatedev/restate-sdk";

import { probeWorkflow } from "./probe-workflow.ts";

const HOST = "127.0.0.1";
const PORT = 9080;

export async function startOrchestrator(): Promise<Http2Server> {
  const handler = restate.createEndpointHandler({ services: [probeWorkflow] });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

if (import.meta.main) {
  const server = await startOrchestrator();
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  console.log(`frontier orchestrator listening at http://${HOST}:${PORT}`);
}
