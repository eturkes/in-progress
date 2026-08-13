import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { loadTreeCompleteModule } from "./tree-complete";

const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const RawConfigSchema = z
  .object({
    $schema: z.string().optional(),
    server: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(0).max(65_535).default(4317),
        allowedOrigins: z.array(z.string().url()).default([]),
        allowedTailscaleUsers: z.array(z.string().email()).default([]),
      })
      .strict()
      .default({ host: "127.0.0.1", port: 4317, allowedOrigins: [], allowedTailscaleUsers: [] }),
    projects: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
            name: z.string().min(1).max(64),
            path: z.string().min(1),
            color: ColorSchema.default("#67d5b5"),
          })
          .strict(),
      )
      .min(1),
    pluginDirectories: z.array(z.string()).default([]),
    integrations: z
      .object({
        align: z
          .object({
            sourceDirectory: z.string().min(1),
            pythonExecutable: z.string().min(1).default("/usr/bin/python3"),
          })
          .strict()
          .optional(),
        drift: z
          .object({
            executable: z.string().min(1),
            codexExecutable: z.string().min(1).default("/usr/bin/codex"),
            sessionsDirectory: z.string().min(1).default("~/.codex/sessions"),
          })
          .strict()
          .optional(),
        preview: z
          .object({
            sourceDirectory: z.string().min(1),
            artifactDirectory: z.string().min(1),
            codexExecutable: z.string().min(1).default("/usr/bin/codex"),
          })
          .strict()
          .optional(),
        treeComplete: z
          .object({
            sourceDirectory: z.string().min(1),
            mode: z.enum(["preview", "codex"]).default("preview"),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    terminal: z
      .object({
        shell: z.string().optional(),
        shellArgs: z.array(z.string().max(256)).max(16).default(["-l"]),
        scrollbackBytes: z
          .number()
          .int()
          .min(64 * 1024)
          .max(16 * 1024 * 1024)
          .default(1024 * 1024),
        maxSessionsPerProject: z.number().int().min(1).max(24).default(8),
      })
      .strict()
      .default({ shellArgs: ["-l"], scrollbackBytes: 1024 * 1024, maxSessionsPerProject: 8 }),
    notifications: z
      .object({
        vapidSubject: z
          .string()
          .regex(/^(mailto:|https:\/\/)/)
          .default("mailto:in-progress@localhost"),
      })
      .strict()
      .default({ vapidSubject: "mailto:in-progress@localhost" }),
  })
  .strict();

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  displayPath: string;
  color: string;
}

export interface InProgressConfig {
  rootDir: string;
  configPath: string;
  dataDir: string;
  server: {
    host: string;
    port: number;
    allowedOrigins: string[];
    allowedTailscaleUsers: string[];
  };
  projects: ProjectConfig[];
  pluginDirectories: string[];
  integrations: {
    align?: { sourceDirectory: string; pythonExecutable: string };
    drift?: { executable: string; codexExecutable: string; sessionsDirectory: string };
    preview?: {
      sourceDirectory: string;
      executable: string;
      artifactDirectory: string;
      codexExecutable: string;
    };
    treeComplete?: { sourceDirectory: string; mode: "preview" | "codex" };
  };
  terminal: {
    shell: string;
    shellArgs: string[];
    scrollbackBytes: number;
    maxSessionsPerProject: number;
  };
  notifications: { vapidSubject: string };
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function resolveDirectory(base: string, rawPath: string, label: string): string {
  const expanded = expandHome(rawPath);
  const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`);
  const canonical = realpathSync(absolute);
  if (!statSync(canonical).isDirectory())
    throw new Error(`${label} is not a directory: ${canonical}`);
  return canonical;
}

function resolveFile(base: string, rawPath: string, label: string): string {
  const expanded = expandHome(rawPath);
  const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`);
  const canonical = realpathSync(absolute);
  if (!statSync(canonical).isFile()) throw new Error(`${label} is not a file: ${canonical}`);
  return canonical;
}

function resolveExecutable(base: string, rawPath: string, label: string): string {
  const canonical = resolveFile(base, rawPath, label);
  try {
    accessSync(canonical, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${canonical}`);
  }
  return canonical;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

export async function loadConfig(
  configPath = process.env.IN_PROGRESS_CONFIG,
): Promise<InProgressConfig> {
  const candidate = configPath
    ? expandHome(configPath)
    : resolve(process.cwd(), "in-progress.config.json");
  const absoluteConfig = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  if (!existsSync(absoluteConfig)) throw new Error(`Config not found: ${absoluteConfig}`);
  const rootDir = dirname(realpathSync(absoluteConfig));
  const parsed = RawConfigSchema.parse(await Bun.file(absoluteConfig).json());

  if (!isLoopback(parsed.server.host) && process.env.IN_PROGRESS_UNSAFE_BIND !== "1") {
    throw new Error(
      `Refusing non-loopback bind (${parsed.server.host}). Use a private HTTPS proxy, or set IN_PROGRESS_UNSAFE_BIND=1 after reviewing the threat model.`,
    );
  }

  const seen = new Set<string>();
  const projects = parsed.projects.map((project) => {
    if (seen.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    seen.add(project.id);
    const path = resolveDirectory(rootDir, project.path, `Project ${project.id}`);
    return {
      ...project,
      path,
      displayPath: project.path.startsWith("~") ? project.path : path,
    };
  });

  const treeCompleteSourceDirectory = parsed.integrations.treeComplete
    ? resolveDirectory(
        rootDir,
        parsed.integrations.treeComplete.sourceDirectory,
        "Tree Complete source directory",
      )
    : undefined;
  const previewSourceDirectory = parsed.integrations.preview
    ? resolveDirectory(
        rootDir,
        parsed.integrations.preview.sourceDirectory,
        "Preview source directory",
      )
    : undefined;
  const previewArtifactDirectory = parsed.integrations.preview
    ? resolveDirectory(
        rootDir,
        parsed.integrations.preview.artifactDirectory,
        "Preview artifact directory",
      )
    : undefined;
  const driftSessionsDirectory = parsed.integrations.drift
    ? resolveDirectory(
        rootDir,
        parsed.integrations.drift.sessionsDirectory,
        "Codex sessions directory",
      )
    : undefined;
  if (
    previewArtifactDirectory &&
    projects.some(
      (project) =>
        within(project.path, previewArtifactDirectory) ||
        within(previewArtifactDirectory, project.path),
    )
  ) {
    throw new Error("Preview artifact directory must be separate from every project");
  }
  if (
    driftSessionsDirectory &&
    projects.some(
      (project) =>
        within(project.path, driftSessionsDirectory) ||
        within(driftSessionsDirectory, project.path),
    )
  ) {
    throw new Error("Codex sessions directory must be separate from every project");
  }

  const pluginDirectories = parsed.pluginDirectories.map((path) =>
    resolveDirectory(rootDir, path, "Plugin directory"),
  );
  if (previewArtifactDirectory) {
    const previewPluginDirectory = resolveDirectory(
      previewArtifactDirectory,
      "in-progress-plugin",
      "Preview plugin directory",
    );
    if (!pluginDirectories.includes(previewPluginDirectory)) {
      pluginDirectories.push(previewPluginDirectory);
    }
  }

  if (parsed.integrations.treeComplete?.mode === "codex" && treeCompleteSourceDirectory) {
    let preflightProjectManifest: (targetRepo: string) => Promise<void>;
    try {
      const module = await loadTreeCompleteModule(treeCompleteSourceDirectory);
      if (typeof module.preflightProjectManifest !== "function") throw new Error();
      preflightProjectManifest = module.preflightProjectManifest;
    } catch {
      throw new Error("Tree Complete codex mode requires a compatible built integration");
    }
    for (const project of projects) {
      try {
        await preflightProjectManifest(project.path);
      } catch {
        throw new Error(
          `Tree Complete codex mode requires a valid committed project manifest: ${project.displayPath}/.tree-complete/project.json`,
        );
      }
    }
  }

  return {
    configPath: realpathSync(absoluteConfig),
    rootDir,
    dataDir: resolve(rootDir, ".data"),
    server: parsed.server,
    projects,
    pluginDirectories,
    integrations: {
      ...(parsed.integrations.align
        ? {
            align: {
              sourceDirectory: resolveDirectory(
                rootDir,
                parsed.integrations.align.sourceDirectory,
                "Align source directory",
              ),
              pythonExecutable: resolveExecutable(
                rootDir,
                parsed.integrations.align.pythonExecutable,
                "Align Python executable",
              ),
            },
          }
        : {}),
      ...(parsed.integrations.drift
        ? {
            drift: {
              executable: resolveExecutable(
                rootDir,
                parsed.integrations.drift.executable,
                "Drift executable",
              ),
              codexExecutable: resolveExecutable(
                rootDir,
                parsed.integrations.drift.codexExecutable,
                "Drift Codex executable",
              ),
              sessionsDirectory: driftSessionsDirectory!,
            },
          }
        : {}),
      ...(parsed.integrations.preview
        ? {
            preview: {
              sourceDirectory: previewSourceDirectory!,
              executable: resolveExecutable(
                previewSourceDirectory!,
                join(previewSourceDirectory!, "bin/preview"),
                "Preview executable",
              ),
              artifactDirectory: previewArtifactDirectory!,
              codexExecutable: resolveExecutable(
                rootDir,
                parsed.integrations.preview.codexExecutable,
                "Codex executable",
              ),
            },
          }
        : {}),
      ...(parsed.integrations.treeComplete
        ? {
            treeComplete: {
              sourceDirectory: treeCompleteSourceDirectory!,
              mode: parsed.integrations.treeComplete.mode,
            },
          }
        : {}),
    },
    terminal: {
      shell: parsed.terminal.shell ?? process.env.SHELL ?? "/bin/sh",
      shellArgs: parsed.terminal.shellArgs,
      scrollbackBytes: parsed.terminal.scrollbackBytes,
      maxSessionsPerProject: parsed.terminal.maxSessionsPerProject,
    },
    notifications: parsed.notifications,
  };
}

export function configForTests(
  rootDir: string,
  overrides: Partial<InProgressConfig> = {},
): InProgressConfig {
  const base: InProgressConfig = {
    configPath: join(rootDir, "in-progress.config.json"),
    rootDir,
    dataDir: join(rootDir, ".data"),
    server: {
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [],
      allowedTailscaleUsers: [],
    },
    projects: [
      {
        id: "fixture",
        name: "Fixture",
        path: rootDir,
        displayPath: rootDir,
        color: "#67d5b5",
      },
    ],
    pluginDirectories: [],
    integrations: {},
    terminal: {
      shell: "/bin/sh",
      shellArgs: [],
      scrollbackBytes: 64 * 1024,
      maxSessionsPerProject: 2,
    },
    notifications: { vapidSubject: "mailto:test@localhost" },
  };
  return { ...base, ...overrides };
}
