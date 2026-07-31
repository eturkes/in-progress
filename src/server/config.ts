import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

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
          .default("mailto:switchyard@localhost"),
      })
      .strict()
      .default({ vapidSubject: "mailto:switchyard@localhost" }),
  })
  .strict();

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  displayPath: string;
  color: string;
}

export interface SwitchyardConfig {
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

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export async function loadConfig(
  configPath = process.env.SWITCHYARD_CONFIG,
): Promise<SwitchyardConfig> {
  const candidate = configPath
    ? expandHome(configPath)
    : resolve(process.cwd(), "switchyard.config.json");
  const absoluteConfig = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  if (!existsSync(absoluteConfig)) throw new Error(`Config not found: ${absoluteConfig}`);
  const rootDir = dirname(realpathSync(absoluteConfig));
  const parsed = RawConfigSchema.parse(await Bun.file(absoluteConfig).json());

  if (!isLoopback(parsed.server.host) && process.env.SWITCHYARD_UNSAFE_BIND !== "1") {
    throw new Error(
      `Refusing non-loopback bind (${parsed.server.host}). Use a private HTTPS proxy, or set SWITCHYARD_UNSAFE_BIND=1 after reviewing the threat model.`,
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

  return {
    configPath: realpathSync(absoluteConfig),
    rootDir,
    dataDir: resolve(rootDir, ".data"),
    server: parsed.server,
    projects,
    pluginDirectories: parsed.pluginDirectories.map((path) =>
      resolveDirectory(rootDir, path, "Plugin directory"),
    ),
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
  overrides: Partial<SwitchyardConfig> = {},
): SwitchyardConfig {
  const base: SwitchyardConfig = {
    configPath: join(rootDir, "switchyard.config.json"),
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
