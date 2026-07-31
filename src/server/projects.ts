import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { GitSummary, ProjectDto, ProjectTreeEntry } from "../shared/contracts";
import type { ProjectConfig } from "./config";
import { HttpError } from "./security";

const TREE_SKIP = new Set([".git", ".data", "node_modules", "dist", "coverage"]);

function emptyGitSummary(): GitSummary {
  return {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    clean: true,
  };
}

export class ProjectRegistry {
  readonly #projects: Map<string, ProjectConfig>;
  readonly #gitCache = new Map<string, { expiresAt: number; value: Promise<GitSummary> }>();

  constructor(projects: ProjectConfig[]) {
    this.#projects = new Map(projects.map((project) => [project.id, project]));
  }

  get(id: string): ProjectConfig {
    const project = this.#projects.get(id);
    if (!project) throw new HttpError(404, "Project not found");
    return project;
  }

  all(): ProjectConfig[] {
    return [...this.#projects.values()];
  }

  async dto(project: ProjectConfig): Promise<ProjectDto> {
    const available = await stat(project.path)
      .then((info) => info.isDirectory())
      .catch(() => false);
    const git = available ? await this.git(project.id) : emptyGitSummary();
    return {
      id: project.id,
      name: project.name,
      displayPath: project.displayPath,
      color: project.color,
      branch: git.branch,
      available,
    };
  }

  async dtos(): Promise<ProjectDto[]> {
    return Promise.all(this.all().map((project) => this.dto(project)));
  }

  git(id: string): Promise<GitSummary> {
    const project = this.get(id);
    const cached = this.#gitCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.#readGit(project);
    this.#gitCache.set(id, { expiresAt: Date.now() + 2_000, value });
    return value;
  }

  async #readGit(project: ProjectConfig): Promise<GitSummary> {
    const child = Bun.spawn(
      ["git", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
      {
        cwd: project.path,
        stderr: "ignore",
        stdout: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
          child.kill("SIGKILL");
          return emptyGitSummary();
        }
        chunks.push(value);
      }
      if ((await child.exited) !== 0) return emptyGitSummary();
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const summary = emptyGitSummary();
    for (const line of new TextDecoder().decode(bytes).split("\n")) {
      if (line.startsWith("# branch.head ")) summary.branch = line.slice(14).trim();
      else if (line.startsWith("# branch.upstream ")) summary.upstream = line.slice(18).trim();
      else if (line.startsWith("# branch.ab ")) {
        const match = /\+(\d+) -(\d+)/.exec(line);
        summary.ahead = Number(match?.[1] ?? 0);
        summary.behind = Number(match?.[2] ?? 0);
      } else if (line.startsWith("? ")) summary.untracked += 1;
      else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
        const status = line.slice(2, 4);
        if (status[0] && status[0] !== ".") summary.staged += 1;
        if (status[1] && status[1] !== ".") summary.modified += 1;
      }
    }
    summary.clean = summary.staged + summary.modified + summary.untracked === 0;
    return summary;
  }

  async tree(id: string, rawParams: unknown): Promise<ProjectTreeEntry[]> {
    const params = z
      .object({
        depth: z.number().int().min(1).max(6).default(4),
        limit: z.number().int().min(1).max(2_000).default(800),
      })
      .strict()
      .parse(rawParams ?? {});
    const project = this.get(id);
    const entries: ProjectTreeEntry[] = [];

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > params.depth || entries.length >= params.limit) return;
      const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
      for (const child of children) {
        if (entries.length >= params.limit) break;
        if (TREE_SKIP.has(child.name)) continue;
        const fullPath = resolve(directory, child.name);
        const childPath = relative(project.path, fullPath).split(sep).join("/");
        const kind = child.isSymbolicLink()
          ? "symlink"
          : child.isDirectory()
            ? "directory"
            : "file";
        const entry: ProjectTreeEntry = { path: childPath, name: child.name, kind, depth };
        if (kind === "file") entry.size = (await stat(fullPath)).size;
        entries.push(entry);
        if (kind === "directory") await walk(fullPath, depth + 1);
      }
    };

    await walk(project.path, 0);
    return entries;
  }

  async readText(
    id: string,
    rawParams: unknown,
  ): Promise<{ path: string; text: string; truncated: boolean }> {
    const params = z
      .object({ path: z.string().min(1).max(1_024) })
      .strict()
      .parse(rawParams);
    const project = this.get(id);
    if (isAbsolute(params.path)) throw new HttpError(400, "Absolute paths are not allowed");
    const candidate = resolve(project.path, params.path);
    const canonical = await realpath(candidate).catch(() => {
      throw new HttpError(404, "File not found");
    });
    const pathFromRoot = relative(project.path, canonical);
    if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
      throw new HttpError(403, "Path escapes project root");
    }
    const info = await stat(canonical);
    if (!info.isFile()) throw new HttpError(400, "Path is not a regular file");
    const maxBytes = 256 * 1024;
    const bytes = new Uint8Array(
      await Bun.file(canonical)
        .slice(0, maxBytes + 1)
        .arrayBuffer(),
    );
    const truncated = bytes.length > maxBytes;
    const visible = truncated ? bytes.subarray(0, maxBytes) : bytes;
    if (visible.includes(0))
      throw new HttpError(415, "Binary files are not readable through plugin RPC");
    return {
      path: params.path,
      text: new TextDecoder("utf-8", { fatal: false }).decode(visible),
      truncated,
    };
  }
}
