import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { PushSubscription } from "web-push";
import type { EventDto, EventKind } from "../shared/contracts";

export const EVENT_RETENTION_LIMIT = 2_000;

interface EventRow {
  id: string;
  project_id: string | null;
  kind: EventKind;
  title: string;
  body: string;
  url: string;
  created_at: string;
  read_at: string | null;
}

function eventDto(row: EventRow): EventDto {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    url: row.url,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export class StateStore {
  readonly #db: Database;

  constructor(dataDir: string, memory = false) {
    if (!memory) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(dataDir, 0o700);
    }
    const path = memory ? ":memory:" : join(dataDir, "switchyard.db");
    this.#db = new Database(path, { create: true, strict: true });
    if (!memory) chmodSync(path, 0o600);
    this.#db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        subscription_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_success_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('needs-input', 'completed', 'failed', 'system')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at DESC);
    `);
  }

  getMeta(key: string): string | null {
    const row = this.#db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .query(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  saveSubscription(subscription: PushSubscription): void {
    const now = new Date().toISOString();
    this.#db
      .query(
        "INSERT INTO push_subscriptions(endpoint, subscription_json, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json",
      )
      .run(subscription.endpoint, JSON.stringify(subscription), now);
  }

  subscriptions(): PushSubscription[] {
    const rows = this.#db
      .query<{ subscription_json: string }, []>("SELECT subscription_json FROM push_subscriptions")
      .all();
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.subscription_json) as PushSubscription];
      } catch {
        return [];
      }
    });
  }

  subscriptionCount(): number {
    const row = this.#db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM push_subscriptions")
      .get();
    return row?.count ?? 0;
  }

  removeSubscription(endpoint: string): void {
    this.#db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  markSubscriptionSuccess(endpoint: string): void {
    this.#db
      .query("UPDATE push_subscriptions SET last_success_at = ? WHERE endpoint = ?")
      .run(new Date().toISOString(), endpoint);
  }

  insertEvent(event: EventDto): void {
    this.#db.transaction((record: EventDto) => {
      this.#db
        .query(
          "INSERT INTO events(id, project_id, kind, title, body, url, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.id,
          record.projectId,
          record.kind,
          record.title,
          record.body,
          record.url,
          record.createdAt,
          record.readAt,
        );
      this.#db
        .query(
          "DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
        )
        .run(EVENT_RETENTION_LIMIT);
    })(event);
  }

  events(limit = 100): EventDto[] {
    return this.#db
      .query<EventRow, [number]>(
        "SELECT id, project_id, kind, title, body, url, created_at, read_at FROM events ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map(eventDto);
  }

  markEventRead(id: string): EventDto | null {
    this.#db
      .query("UPDATE events SET read_at = coalesce(read_at, ?) WHERE id = ?")
      .run(new Date().toISOString(), id);
    const row = this.#db
      .query<EventRow, [string]>(
        "SELECT id, project_id, kind, title, body, url, created_at, read_at FROM events WHERE id = ?",
      )
      .get(id);
    return row ? eventDto(row) : null;
  }

  close(): void {
    this.#db.close();
  }
}
