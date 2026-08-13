import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { GitSummary, ProjectDto, ProjectTreeEntry } from "../shared/contracts";
import type { ProjectConfig } from "./config";
import { runBounded } from "./process";
import { HttpError } from "./security";

const TREE_SKIP = new Set([".git", ".data", "node_modules", "dist", "coverage"]);
const GIT_STATUS_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PAGER: "cat",
  PATH: "/usr/bin:/bin",
};

function emptyGitSummary(available = false): GitSummary {
  return {
    available,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    clean: available,
  };
}

interface ProjectGitState {
  summary: GitSummary;
  revision: string | null;
}

export class ProjectRegistry {
  readonly #projects: Map<string, ProjectConfig>;
  readonly #gitCache = new Map<
    string,
    {
      expiresAt: number;
      value: Promise<ProjectGitState>;
      summary: Promise<GitSummary>;
      revision: Promise<string | null>;
    }
  >();

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
    return this.#gitState(id).summary;
  }

  gitRevision(id: string): Promise<string | null> {
    return this.#gitState(id).revision;
  }

  #gitState(id: string): {
    value: Promise<ProjectGitState>;
    summary: Promise<GitSummary>;
    revision: Promise<string | null>;
  } {
    const project = this.get(id);
    const cached = this.#gitCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const value = this.#readGit(project);
    const entry = {
      expiresAt: Date.now() + 2_000,
      value,
      summary: value.then((state) => state.summary),
      revision: value.then((state) => state.revision),
    };
    this.#gitCache.set(id, entry);
    return entry;
  }

  async #readGit(project: ProjectConfig): Promise<ProjectGitState> {
    let stdout: string;
    try {
      ({ stdout } = await runBounded(
        [
          "git",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "status",
          "--porcelain=v2",
          "--branch",
          "--untracked-files=normal",
        ],
        {
          cwd: project.path,
          env: GIT_STATUS_ENV,
          timeoutMs: 3_000,
          stdoutBytes: 1024 * 1024,
          label: "Git status",
        },
      ));
    } catch {
      return { summary: emptyGitSummary(), revision: null };
    }

    const summary = emptyGitSummary(true);
    let revision: string | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("# branch.oid ")) {
        const candidate = line.slice(13).trim();
        if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidate)) revision = candidate;
      } else if (line.startsWith("# branch.head ")) summary.branch = line.slice(14).trim();
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
    return { summary, revision };
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
        if (kind === "directory") {
          const nestedGit = await stat(resolve(fullPath, ".git"))
            .then(() => true)
            .catch(() => false);
          if (!nestedGit) await walk(fullPath, depth + 1);
        }
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
    const canonical = await this.resolveFile(id, params.path);
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

  async resolveFile(id: string, projectRelativePath: string): Promise<string> {
    const project = this.get(id);
    if (isAbsolute(projectRelativePath)) throw new HttpError(400, "Absolute paths are not allowed");
    const candidate = resolve(project.path, projectRelativePath);
    const canonical = await realpath(candidate).catch(() => {
      throw new HttpError(404, "File not found");
    });
    const pathFromRoot = relative(project.path, canonical);
    if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
      throw new HttpError(403, "Path escapes project root");
    }
    const info = await stat(canonical);
    if (!info.isFile()) throw new HttpError(400, "Path is not a regular file");
    return canonical;
  }
}
