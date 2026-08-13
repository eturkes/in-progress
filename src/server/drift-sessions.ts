import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { DriftCodexSessionIdSchema, type DriftCodexSession } from "../shared/contracts";

const MAX_LAYOUT_ENTRIES = 4_096;
const MAX_SESSION_FILES = 2_048;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

const SessionMetaSchema = z
  .object({
    type: z.literal("session_meta"),
    payload: z
      .object({
        id: DriftCodexSessionIdSchema,
        timestamp: z.string().min(1).max(100),
        cwd: z.string().min(1).max(8_192),
        source: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
      })
      .passthrough(),
  })
  .passthrough();

export interface ResolvedDriftCodexSession extends DriftCodexSession {
  path: string;
}

export interface DiscoveredDriftCodexSessions {
  sessions: ResolvedDriftCodexSession[];
  truncated: boolean;
}

interface EntryList {
  names: string[];
  consumed: number;
  truncated: boolean;
}

function pathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function safeDirectory(root: string, candidate: string): Promise<string | null> {
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    const canonical = await realpath(candidate);
    return pathWithin(root, canonical) ? canonical : null;
  } catch {
    return null;
  }
}

async function boundedEntries(
  directory: string,
  remaining: number,
  pattern: RegExp,
  kind: "directory" | "file",
): Promise<EntryList> {
  if (remaining <= 0) return { names: [], consumed: 0, truncated: true };
  const names: string[] = [];
  let consumed = 0;
  let truncated = false;
  try {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (consumed >= remaining) {
        truncated = true;
        break;
      }
      consumed += 1;
      const expectedKind = kind === "directory" ? entry.isDirectory() : entry.isFile();
      if (expectedKind && pattern.test(entry.name)) names.push(entry.name);
    }
  } catch {
    return { names: [], consumed, truncated };
  }
  names.sort((left, right) => right.localeCompare(left));
  return { names, consumed, truncated };
}

async function rolloutCandidates(sessionsRoot: string): Promise<{
  paths: string[];
  truncated: boolean;
}> {
  const paths: string[] = [];
  let remaining = MAX_LAYOUT_ENTRIES;
  let truncated = false;
  const years = await boundedEntries(sessionsRoot, remaining, /^\d{4}$/, "directory");
  remaining -= years.consumed;
  truncated ||= years.truncated;

  outer: for (const yearName of years.names) {
    const year = await safeDirectory(sessionsRoot, join(sessionsRoot, yearName));
    if (!year) continue;
    const months = await boundedEntries(year, remaining, /^\d{2}$/, "directory");
    remaining -= months.consumed;
    truncated ||= months.truncated;
    for (const monthName of months.names) {
      const month = await safeDirectory(sessionsRoot, join(year, monthName));
      if (!month) continue;
      const days = await boundedEntries(month, remaining, /^\d{2}$/, "directory");
      remaining -= days.consumed;
      truncated ||= days.truncated;
      for (const dayName of days.names) {
        const day = await safeDirectory(sessionsRoot, join(month, dayName));
        if (!day) continue;
        const files = await boundedEntries(
          day,
          remaining,
          /^rollout-.+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/,
          "file",
        );
        remaining -= files.consumed;
        truncated ||= files.truncated;
        for (const fileName of files.names) {
          if (paths.length >= MAX_SESSION_FILES) {
            truncated = true;
            break outer;
          }
          paths.push(join(day, fileName));
        }
        if (remaining <= 0) {
          truncated = true;
          break outer;
        }
      }
    }
  }
  return { paths, truncated };
}

function canonicalTimestamp(value: string): string | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

async function readMetadata(
  sessionsRoot: string,
  projectRoot: string,
  candidate: string,
): Promise<ResolvedDriftCodexSession | null> {
  let canonical: string;
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    canonical = await realpath(candidate);
  } catch {
    return null;
  }
  if (!pathWithin(sessionsRoot, canonical)) return null;

  let handle;
  try {
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_SESSION_BYTES) return null;
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 && bytesRead === buffer.length) return null;
    const line = buffer.subarray(0, newline < 0 ? bytesRead : newline);
    if (line.at(-1) === 0x0d) return null;
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      return null;
    }
    const parsed = SessionMetaSchema.safeParse(document);
    if (!parsed.success || !basename(canonical).endsWith(`-${parsed.data.payload.id}.jsonl`)) {
      return null;
    }
    const startedAt = canonicalTimestamp(parsed.data.payload.timestamp);
    if (!startedAt) return null;
    let recordedProject: string;
    try {
      recordedProject = await realpath(parsed.data.payload.cwd);
    } catch {
      return null;
    }
    if (recordedProject !== projectRoot) return null;
    return {
      id: parsed.data.payload.id,
      startedAt,
      updatedAt: info.mtime.toISOString(),
      source: parsed.data.payload.source,
      byteSize: info.size,
      path: canonical,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function discoverDriftCodexSessions(
  sessionsRoot: string,
  projectRoot: string,
): Promise<DiscoveredDriftCodexSessions> {
  const candidates = await rolloutCandidates(sessionsRoot);
  const discovered: ResolvedDriftCodexSession[] = [];
  for (let offset = 0; offset < candidates.paths.length; offset += 8) {
    const chunk = candidates.paths.slice(offset, offset + 8);
    const metadata = await Promise.all(
      chunk.map(async (path) => await readMetadata(sessionsRoot, projectRoot, path)),
    );
    discovered.push(
      ...metadata.filter((value): value is ResolvedDriftCodexSession => value !== null),
    );
  }

  const counts = new Map<string, number>();
  for (const session of discovered) counts.set(session.id, (counts.get(session.id) ?? 0) + 1);
  const sessions = discovered
    .filter((session) => counts.get(session.id) === 1)
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.startedAt.localeCompare(left.startedAt),
    );
  return { sessions, truncated: candidates.truncated };
}
