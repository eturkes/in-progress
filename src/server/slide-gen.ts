import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, sep } from "node:path";
import {
  SlideGenReceiptSchema,
  type SlideGenOperationResult,
  type SlideGenReceipt,
  type SlideGenStatus,
} from "../shared/contracts";
import type { InProgressConfig } from "./config";
import { runBounded } from "./process";
import type { ProjectRegistry } from "./projects";
import { HttpError } from "./security";

const DECK_MAX_BYTES = 16 * 1024 * 1024;
const PDF_MAX_BYTES = 512 * 1024 * 1024;
const PAGE_MAX_BYTES = 64 * 1024 * 1024;
const RECEIPT_MAX_BYTES = 64 * 1024;
const GENERATE_TIMEOUT_MS = 65 * 60_000;
const RENDER_TIMEOUT_MS = 10 * 60_000;
const MAX_PAGES = 99;
const CREDENTIAL_ENV = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type SlideGenConfig = NonNullable<InProgressConfig["integrations"]["slideGen"]>;

interface ActiveOperation {
  controller: AbortController;
  receipt: Promise<SlideGenReceipt>;
}

interface ArtifactSnapshot {
  deck: SlideGenStatus["deck"];
  render: SlideGenStatus["render"];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

function processEnvironment(config: SlideGenConfig): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("GIT_") && !CREDENTIAL_ENV.has(entry[0]),
    ),
  );
  const path = [
    dirname(config.codexExecutable),
    dirname(config.uvExecutable),
    dirname(config.chromiumfishExecutable),
    "/usr/bin",
    "/bin",
  ].filter((directory, index, all) => all.indexOf(directory) === index);
  return {
    ...environment,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: path.join(delimiter),
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

async function realDirectory(path: string, label: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new HttpError(502, `${label} is unavailable`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new HttpError(409, `${label} is unsafe`);
  }
  const canonical = await realpath(path).catch(() => {
    throw new HttpError(409, `${label} is unsafe`);
  });
  if (canonical !== path) throw new HttpError(409, `${label} changed identity`);
  return true;
}

async function childDirectory(
  root: string,
  segments: readonly string[],
  label: string,
): Promise<string | null> {
  let current = root;
  if (!(await realDirectory(current, label))) return null;
  for (const segment of segments) {
    current = join(current, segment);
    if (!(await realDirectory(current, label))) return null;
    if (!within(root, current)) throw new HttpError(409, `${label} escaped its root`);
  }
  return current;
}

async function hashRegularFile(
  path: string,
  label: string,
  maxBytes: number,
  prefix?: Uint8Array,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new HttpError(409, `${label} is unsafe`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new HttpError(502, `${label} has an invalid size or type`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, before.size));
    let consumed = 0;
    let leading = Buffer.alloc(0);
    while (consumed < before.size) {
      const length = Math.min(buffer.length, before.size - consumed);
      const { bytesRead } = await handle.read(buffer, 0, length, consumed);
      if (bytesRead < 1) throw new HttpError(502, `${label} changed while reading`);
      const bytes = buffer.subarray(0, bytesRead);
      if (leading.length < (prefix?.length ?? 0)) {
        leading = Buffer.concat([leading, bytes]).subarray(0, prefix!.length);
      }
      hash.update(bytes);
      consumed += bytesRead;
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new HttpError(502, `${label} changed while reading`);
    }
    if (prefix && !leading.equals(prefix))
      throw new HttpError(502, `${label} has an invalid header`);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function validatePng(path: string, label: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new HttpError(409, `${label} is unsafe`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 24 || metadata.size > PAGE_MAX_BYTES) {
      throw new HttpError(502, `${label} has an invalid size or type`);
    }
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, 8).equals(PNG_SIGNATURE) ||
      header.toString("ascii", 12, 16) !== "IHDR" ||
      header.readUInt32BE(16) !== 2560 ||
      header.readUInt32BE(20) !== 1440
    ) {
      throw new HttpError(502, `${label} is not a 2560x1440 PNG`);
    }
  } finally {
    await handle.close();
  }
}

async function readReceipt(path: string): Promise<SlideGenReceipt | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new HttpError(409, "slide-gen receipt is unsafe");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > RECEIPT_MAX_BYTES) {
      throw new HttpError(502, "slide-gen receipt has an invalid size or type");
    }
    const bytes = await handle.readFile();
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new HttpError(502, "slide-gen receipt is malformed");
    }
    const parsed = SlideGenReceiptSchema.safeParse(document);
    if (!parsed.success) throw new HttpError(502, "slide-gen receipt is incompatible");
    return parsed.data;
  } finally {
    await handle.close();
  }
}

export class SlideGenService {
  readonly #operations = new Map<string, ActiveOperation>();
  readonly #admitting = new Set<string>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(
    readonly config: SlideGenConfig,
    readonly projects: ProjectRegistry,
    readonly dataDir: string,
  ) {}

  async status(projectId: string): Promise<SlideGenStatus> {
    const project = this.projects.get(projectId);
    const [sourceAvailable, artifacts, lastReceipt] = await Promise.all([
      realDirectory(project.path, "slide-gen source directory"),
      this.#artifacts(projectId),
      readReceipt(join(this.dataDir, "slide-gen", `${project.id}.json`)),
    ]);
    return {
      projectId: project.id,
      sourceAvailable,
      busy: this.#operations.has(project.path) || this.#admitting.has(project.path),
      ...artifacts,
      lastReceipt,
    };
  }

  generate(projectId: string): Promise<SlideGenOperationResult> {
    return this.#mutate(projectId, "generate");
  }

  render(projectId: string): Promise<SlideGenOperationResult> {
    return this.#mutate(projectId, "render");
  }

  async #mutate(projectId: string, kind: "generate" | "render"): Promise<SlideGenOperationResult> {
    if (this.#closed) throw new HttpError(503, "slide-gen integration is closed");
    const project = this.projects.get(projectId);
    if (this.#operations.has(project.path) || this.#admitting.has(project.path)) {
      throw new HttpError(409, "A slide-gen operation is already running for this project");
    }
    this.#admitting.add(project.path);
    try {
      if (!(await realDirectory(project.path, "slide-gen source directory"))) {
        throw new HttpError(409, "slide-gen source directory is unavailable");
      }
      if (!(await realDirectory(this.config.artifactDirectory, "slide-gen artifact directory"))) {
        throw new HttpError(409, "slide-gen artifact directory is unavailable");
      }
      if (this.#closed) throw new HttpError(503, "slide-gen integration is closed");
    } finally {
      this.#admitting.delete(project.path);
    }
    const controller = new AbortController();
    const receipt = this.#execute(projectId, kind, controller.signal);
    const operation = { controller, receipt };
    this.#operations.set(project.path, operation);
    let result: SlideGenReceipt;
    try {
      result = await receipt;
    } finally {
      if (this.#operations.get(project.path) === operation) this.#operations.delete(project.path);
    }
    return { receipt: result, status: await this.status(projectId) };
  }

  async #execute(
    projectId: string,
    kind: "generate" | "render",
    signal: AbortSignal,
  ): Promise<SlideGenReceipt> {
    const project = this.projects.get(projectId);
    const startedAt = new Date().toISOString();
    const sourceRevision = await this.projects.gitRevision(projectId);
    const argv =
      kind === "generate"
        ? [
            this.config.executable,
            "generate",
            "--source",
            project.path,
            "--artifact-root",
            this.config.artifactDirectory,
            "--",
            project.id,
          ]
        : [
            this.config.executable,
            "render",
            "--artifact-root",
            this.config.artifactDirectory,
            "--",
            project.id,
          ];
    await runBounded(argv, {
      cwd: this.config.sourceDirectory,
      env: processEnvironment(this.config),
      timeoutMs: kind === "generate" ? GENERATE_TIMEOUT_MS : RENDER_TIMEOUT_MS,
      stdoutBytes: 1024 * 1024,
      label: `slide-gen ${kind}`,
      signal,
    });
    const artifacts = await this.#artifacts(projectId);
    if (!artifacts.deck) throw new HttpError(502, "slide-gen did not publish a validated deck");
    if (kind === "generate" && artifacts.render) {
      throw new HttpError(502, "slide-gen generation retained a stale render");
    }
    if (kind === "render" && !artifacts.render) {
      throw new HttpError(502, "slide-gen did not publish a validated render");
    }
    const receipt = SlideGenReceiptSchema.parse({
      operationId: randomUUID(),
      kind,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceRevision,
      deckSha256: artifacts.deck.sha256,
      pdfSha256: artifacts.render?.sha256 ?? null,
      pageCount: artifacts.render?.pageCount ?? 0,
    });
    await this.#writeReceipt(project.id, receipt);
    return receipt;
  }

  async #artifacts(projectId: string): Promise<ArtifactSnapshot> {
    const project = this.projects.get(projectId);
    const deckDirectory = await childDirectory(
      this.config.artifactDirectory,
      ["decks", project.id],
      "slide-gen deck directory",
    );
    const deckHash = deckDirectory
      ? await hashRegularFile(join(deckDirectory, "deck.html"), "slide-gen deck", DECK_MAX_BYTES)
      : null;
    const renderDirectory = await childDirectory(
      this.config.artifactDirectory,
      ["renders", project.id],
      "slide-gen render directory",
    );
    let render: SlideGenStatus["render"] = null;
    if (renderDirectory) {
      if (!deckHash) throw new HttpError(502, "slide-gen render exists without a deck");
      const entries = await readdir(renderDirectory, { withFileTypes: true });
      if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
        throw new HttpError(502, "slide-gen render contains a non-file entry");
      }
      const pageNumbers = entries
        .flatMap((entry) => {
          const match = /^page_(\d{2})\.png$/.exec(entry.name);
          return match ? [Number(match[1])] : [];
        })
        .sort((left, right) => left - right);
      const expected = [
        "deck.pdf",
        ...pageNumbers.map((page) => `page_${String(page).padStart(2, "0")}.png`),
      ].sort();
      const actual = entries.map((entry) => entry.name).sort();
      if (
        pageNumbers.length < 1 ||
        pageNumbers.length > MAX_PAGES ||
        pageNumbers.some((page, index) => page !== index + 1) ||
        actual.join("\0") !== expected.join("\0")
      ) {
        throw new HttpError(502, "slide-gen render layout is invalid");
      }
      await Promise.all(
        pageNumbers.map(async (page) => {
          const name = `page_${String(page).padStart(2, "0")}.png`;
          await validatePng(join(renderDirectory, name), `slide-gen ${name}`);
        }),
      );
      const pdfHash = await hashRegularFile(
        join(renderDirectory, "deck.pdf"),
        "slide-gen PDF",
        PDF_MAX_BYTES,
        Buffer.from("%PDF-", "ascii"),
      );
      if (!pdfHash) throw new HttpError(502, "slide-gen PDF is missing");
      render = {
        pdfPath: `renders/${project.id}/deck.pdf`,
        sha256: pdfHash,
        pageCount: pageNumbers.length,
      };
    }
    return {
      deck: deckHash ? { path: `decks/${project.id}/deck.html`, sha256: deckHash } : null,
      render,
    };
  }

  async #writeReceipt(projectId: string, receipt: SlideGenReceipt): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    if (!(await realDirectory(this.dataDir, "in-progress data directory"))) {
      throw new HttpError(502, "in-progress data directory is unavailable");
    }
    const directory = join(this.dataDir, "slide-gen");
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    if (!(await realDirectory(directory, "slide-gen receipt directory"))) {
      throw new HttpError(502, "slide-gen receipt directory is unavailable");
    }
    const stage = join(directory, `.receipt-${randomUUID()}.json`);
    const destination = join(directory, `${projectId}.json`);
    try {
      await writeFile(stage, `${JSON.stringify(receipt)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(stage, destination);
    } catch {
      throw new HttpError(502, "slide-gen receipt could not be published");
    } finally {
      await unlink(stage).catch((error) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const operations = [...this.#operations.values()];
    for (const operation of operations) operation.controller.abort();
    this.#closing = Promise.allSettled(operations.map((operation) => operation.receipt)).then(
      () => undefined,
    );
    return this.#closing;
  }
}
