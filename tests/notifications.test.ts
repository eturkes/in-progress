import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PushSubscription, RequestOptions } from "web-push";
import {
  NotificationService,
  PUSH_CONCURRENCY_LIMIT,
  PUSH_QUEUE_LIMIT,
} from "../src/server/notifications";
import { EVENT_RETENTION_LIMIT, StateStore } from "../src/server/store";
import type { EventDto, EventKind } from "../src/shared/contracts";
import { removeDirectory, tempDirectory } from "./helpers";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDirectory(root);
});

function event(index: number): EventDto {
  return {
    id: `event-${index}`,
    projectId: null,
    kind: "system",
    title: `Event ${index}`,
    body: "",
    url: "/",
    createdAt: new Date(index * 1_000).toISOString(),
    readAt: null,
  };
}

function subscription(index: number): PushSubscription {
  return {
    endpoint: `https://push.example.test/${index}`,
    expirationTime: null,
    keys: { auth: "auth", p256dh: "p256dh" },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for notification delivery");
}

describe("StateStore notifications", () => {
  test("enforces private data-directory permissions for existing directories", () => {
    const root = tempDirectory("store-mode");
    roots.push(root);
    const dataDir = join(root, "existing-data");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o777);

    const store = new StateStore(dataDir);
    try {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dataDir, "switchyard.db")).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });

  test("retains only the newest bounded event window", () => {
    const store = new StateStore("ignored", true);
    try {
      for (let index = 0; index <= EVENT_RETENTION_LIMIT; index += 1)
        store.insertEvent(event(index));

      const events = store.events(EVENT_RETENTION_LIMIT + 1);
      expect(events).toHaveLength(EVENT_RETENTION_LIMIT);
      expect(events[0]?.id).toBe(`event-${EVENT_RETENTION_LIMIT}`);
      expect(events.at(-1)?.id).toBe("event-1");
    } finally {
      store.close();
    }
  });
});

describe("NotificationService push delivery", () => {
  test("uses kind-aware retention and urgency policies", async () => {
    const store = new StateStore("ignored", true);
    const deliveries: Array<{ kind: EventKind; options: RequestOptions }> = [];
    const service = new NotificationService(
      store,
      "mailto:test@localhost",
      async (_, raw, options) => {
        deliveries.push({ kind: (JSON.parse(raw) as { kind: EventKind }).kind, options });
      },
    );
    service.subscribe(subscription(0));

    for (const kind of ["needs-input", "failed", "completed", "system"] as const)
      service.create({ kind, title: kind, body: "", url: "/" });
    await waitFor(() => deliveries.length === 4);

    expect(deliveries).toEqual([
      { kind: "needs-input", options: { TTL: 86_400, urgency: "high", timeout: 10_000 } },
      { kind: "failed", options: { TTL: 21_600, urgency: "high", timeout: 10_000 } },
      { kind: "completed", options: { TTL: 3_600, urgency: "normal", timeout: 10_000 } },
      { kind: "system", options: { TTL: 3_600, urgency: "normal", timeout: 10_000 } },
    ]);
    store.close();
  });

  test("caps concurrent subscription deliveries", async () => {
    const store = new StateStore("ignored", true);
    let active = 0;
    let delivered = 0;
    let peak = 0;
    const service = new NotificationService(store, "mailto:test@localhost", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      delivered += 1;
    });
    for (let index = 0; index < PUSH_CONCURRENCY_LIMIT * 2 + 1; index += 1)
      service.subscribe(subscription(index));

    service.create({ kind: "system", title: "Fan-out", body: "", url: "/" });
    await waitFor(() => delivered === PUSH_CONCURRENCY_LIMIT * 2 + 1);

    expect(peak).toBe(PUSH_CONCURRENCY_LIMIT);
    store.close();
  });

  test("keeps only the newest waiting deliveries under queue pressure", async () => {
    const store = new StateStore("ignored", true);
    const delivered: string[] = [];
    let releaseFirst = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const service = new NotificationService(store, "mailto:test@localhost", async (_, raw) => {
      const title = (JSON.parse(raw) as { title: string }).title;
      delivered.push(title);
      if (title === "Event 0") await firstBlocked;
    });
    service.subscribe(subscription(0));
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      service.create({ kind: "system", title: "Event 0", body: "", url: "/" });
      await waitFor(() => delivered.length === 1);
      for (let index = 1; index <= PUSH_QUEUE_LIMIT + 1; index += 1)
        service.create({ kind: "system", title: `Event ${index}`, body: "", url: "/" });

      releaseFirst();
      await waitFor(() => delivered.length === PUSH_QUEUE_LIMIT + 1);

      expect(delivered).not.toContain("Event 1");
      expect(delivered.at(-1)).toBe(`Event ${PUSH_QUEUE_LIMIT + 1}`);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
      warning.mockRestore();
      store.close();
    }
  });
});
