import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import * as restate from "@restatedev/restate-sdk";

import {
  MAX_VALUE_BYTES,
  PROBE_KIND,
  resultDigest,
  type ProbeRequest,
  type ProbeResult,
} from "../src/contracts.ts";
import { ExecutorClient, requireLoopbackEndpoint } from "../src/executor-client.ts";
import { runProbe, validatedProbeRequest, type ProbeDurability } from "../src/probe-workflow.ts";

const OPERATION_ID = "3f6dfba4-5f40-4a58-9cf9-56c7228c6c49";
const PROBE_DIGEST = "ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serverResponding(status: number, responseBody: string) {
  let capturedBody = "";
  const server = createServer(async (request, response) => {
    capturedBody = await new Response(request as never).text();
    response.writeHead(status, {
      "content-length": Buffer.byteLength(responseBody),
      "content-type": "application/json",
    });
    response.end(responseBody);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP port");
  return {
    body: () => capturedBody,
    endpoint: `http://127.0.0.1:${address.port}`,
  };
}

function request(value = "probe"): ProbeRequest {
  return { input: { value }, kind: PROBE_KIND, operationId: OPERATION_ID };
}

function result(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    digest: PROBE_DIGEST,
    operationId: OPERATION_ID,
    replayed: false,
    value: "probe",
    ...overrides,
  };
}

describe("executor endpoint", () => {
  test("accepts only explicit HTTP loopback endpoints", () => {
    expect(requireLoopbackEndpoint("http://127.0.0.1:4319").hostname).toBe("127.0.0.1");
    expect(requireLoopbackEndpoint("http://[::1]:4319").hostname).toBe("[::1]");
    for (const endpoint of [
      "https://127.0.0.1:4319",
      "http://192.0.2.1:4319",
      "http://localhost:4319",
      "http://127.0.0.1:4319/path",
      "http://user@127.0.0.1:4319",
      "http://127.0.0.1:4319?override=true",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
    ]) {
      expect(() => requireLoopbackEndpoint(endpoint), endpoint).toThrow();
    }
  });

  test("sends the strict wire contract and correlates the receipt", async () => {
    const peer = await serverResponding(201, JSON.stringify(result()));
    const received = await new ExecutorClient(peer.endpoint).execute(request());
    expect(received).toEqual(result());
    expect(peer.body()).toBe(
      `{"operationId":"${OPERATION_ID}","kind":"frontier-probe","input":{"value":"probe"}}`,
    );
  });

  test("retries ambiguous responses and terminates durable contract failures", async () => {
    type ErrorClass = abstract new (...arguments_: never[]) => Error;
    const cases: ReadonlyArray<[number, string, ErrorClass]> = [
      [201, "{", Error],
      [201, JSON.stringify(result({ operationId: "00000000-0000-0000-0000-000000000000" })), Error],
      [201, JSON.stringify(result({ digest: resultDigest("wrong"), value: "wrong" })), Error],
      [201, JSON.stringify(result({ digest: "a".repeat(64) })), Error],
      [201, JSON.stringify(result({ replayed: true })), Error],
      [202, JSON.stringify(result()), Error],
      [408, "{}", Error],
      [429, "{}", Error],
      [500, "{}", Error],
      [403, '{"error":"invalid_request"}', Error],
      [409, "{}", Error],
      [409, '{"error":"operation_id_conflict"}', restate.TerminalError],
      [400, '{"error":"invalid_request"}', restate.TerminalError],
    ];
    for (const [status, body, expected] of cases) {
      const peer = await serverResponding(status, body);
      expect(new ExecutorClient(peer.endpoint).execute(request())).rejects.toBeInstanceOf(expected);
    }
  });
});

describe("workflow", () => {
  test("validates canonical identity and UTF-8 wire limits before the durable call", () => {
    expect(validatedProbeRequest(OPERATION_ID, { value: "probe" }).operationId).toBe(OPERATION_ID);
    expect(resultDigest("界\n")).toBe(
      "174b4c1869b668204e1fe9b948c3946954b2e7d2f32585faab5d8e9188f5334c",
    );
    for (const key of [OPERATION_ID.toUpperCase(), "not-a-uuid", "1-1-1-1-1"]) {
      expect(() => validatedProbeRequest(key, { value: "probe" })).toThrow(restate.TerminalError);
    }
    expect(() =>
      validatedProbeRequest(OPERATION_ID, {
        value: "界".repeat(Math.floor(MAX_VALUE_BYTES / 3) + 1),
      }),
    ).toThrow(restate.TerminalError);
    expect(() => validatedProbeRequest(OPERATION_ID, { value: "\0".repeat(3_000) })).toThrow(
      restate.TerminalError,
    );
    expect(
      validatedProbeRequest(OPERATION_ID, { value: "x".repeat(MAX_VALUE_BYTES) }),
    ).toBeDefined();
  });

  test("keeps the crash boundary inside the durable step after the executor receipt", async () => {
    const events: string[] = [];
    const durability: ProbeDurability = {
      key: OPERATION_ID,
      async run(_name, action) {
        events.push("run:start");
        const value = await action();
        events.push("run:return");
        return value;
      },
    };
    const executor = {
      async execute() {
        events.push("executor:receipt");
        return result();
      },
    };
    const crash = () => {
      events.push("crash");
      throw new Error("simulated process halt after receipt");
    };
    let failure: unknown;
    try {
      await runProbe(durability, { value: "probe" }, executor, crash);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("simulated process halt after receipt");
    expect(events).toEqual(["run:start", "executor:receipt", "crash"]);
  });
});
