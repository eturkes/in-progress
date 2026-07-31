import {
  Bell,
  Blocks,
  ChartColumn,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  Command,
  Files,
  GitBranch,
  Globe,
  Menu,
  Search,
  Sparkles,
  SquareTerminal,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ComponentType,
  type SVGProps,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BootstrapDto, EventDto, PluginDto, ProjectDto } from "../shared/contracts";
import { moveRovingTab, trapTab } from "./a11y";
import { ApiClient, bootstrap } from "./api";
import { NotificationCenter, useEventFeed } from "./components/Notifications";
import { PluginFrame, type PluginStatus } from "./components/PluginFrame";

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then(({ TerminalPane: component }) => ({
    default: component,
  })),
);

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: string | number }>;

interface RouteState {
  projectId: string | null;
  pluginId: string | null;
}

interface ToastMessage {
  id: number;
  message: string;
  tone: "neutral" | "danger";
}

const pluginIcons: Record<PluginDto["icon"], Icon> = {
  terminal: SquareTerminal,
  blocks: Blocks,
  chart: ChartColumn,
  files: Files,
  "git-branch": GitBranch,
  globe: Globe,
  sparkles: Sparkles,
};

function readRoute(pathname = window.location.pathname): RouteState {
  const match = /^\/p\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return { projectId: null, pluginId: null };
  try {
    return { projectId: decodeURIComponent(match[1]!), pluginId: decodeURIComponent(match[2]!) };
  } catch {
    return { projectId: null, pluginId: null };
  }
}

function routePath(projectId: string, pluginId: string): string {
  return `/p/${encodeURIComponent(projectId)}/${encodeURIComponent(pluginId)}`;
}

function storedValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Navigation still works when persistent browser storage is unavailable.
  }
}

function loadCollapsed(): boolean {
  return storedValue("in-progress:rail-collapsed") === "true";
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "in-progress could not start";
}

export function App() {
  const [data, setData] = useState<BootstrapDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void bootstrap().then(
      (next) => {
        if (active) setData(next);
      },
      (bootstrapError: unknown) => {
        if (active) setError(friendlyError(bootstrapError));
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  if (!data) {
    return (
      <main className="boot-screen">
        <div className="brand-mark large" aria-hidden="true">
          <span />
          <span />
        </div>
        {error ? (
          <div className="boot-error">
            <h1>Control plane unavailable</h1>
            <p>{error}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="boot-loading" role="status">
            <span className="spinner" />
            Connecting to in-progress
          </div>
        )}
      </main>
    );
  }

  return <ControlPlane bootstrapData={data} />;
}

function ControlPlane({ bootstrapData }: { bootstrapData: BootstrapDto }) {
  const api = useMemo(() => new ApiClient(bootstrapData.csrfToken), [bootstrapData.csrfToken]);
  const [route, setRoute] = useState<RouteState>(readRoute);
  const [railCollapsed, setRailCollapsed] = useState(loadCollapsed);
  const [projectDrawer, setProjectDrawer] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [pluginStatuses, setPluginStatuses] = useState<Record<string, PluginStatus>>({});
  const toastCounter = useRef(0);
  const projectSearchRef = useRef<HTMLInputElement>(null);
  const projectOpenerRef = useRef<HTMLElement | null>(null);
  const drawerWasOpenRef = useRef(false);

  const showToast = useCallback((message: string, tone: "neutral" | "danger" = "neutral") => {
    const id = ++toastCounter.current;
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      4_000,
    );
  }, []);

  const onForegroundEvent = useCallback(
    (event: EventDto) =>
      showToast(
        `${event.title}${event.body ? ` — ${event.body}` : ""}`,
        event.kind === "failed" ? "danger" : "neutral",
      ),
    [showToast],
  );
  const feed = useEventFeed({ api, onForegroundEvent });
  const hostConnected = online && feed.connected;

  const project =
    bootstrapData.projects.find((candidate) => candidate.id === route.projectId) ??
    bootstrapData.projects.find(
      (candidate) => candidate.id === storedValue("in-progress:last-project"),
    ) ??
    bootstrapData.projects[0] ??
    null;
  const plugin =
    bootstrapData.plugins.find((candidate) => candidate.id === route.pluginId) ??
    bootstrapData.plugins.find(
      (candidate) =>
        project && candidate.id === storedValue(`in-progress:last-plugin:${project.id}`),
    ) ??
    bootstrapData.plugins.find((candidate) => candidate.id === "terminal") ??
    bootstrapData.plugins[0] ??
    null;

  const navigate = useCallback((projectId: string, pluginId: string, replace = false) => {
    const path = routePath(projectId, pluginId);
    if (replace) window.history.replaceState({}, "", path);
    else window.history.pushState({}, "", path);
    setRoute({ projectId, pluginId });
    storeValue("in-progress:last-project", projectId);
    storeValue(`in-progress:last-plugin:${projectId}`, pluginId);
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("popstate", onPopState);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (projectDrawer && !drawerWasOpenRef.current) {
      const active = document.activeElement as HTMLElement | null;
      const rail = projectSearchRef.current?.closest("#project-rail");
      projectOpenerRef.current =
        active && active !== document.body && !rail?.contains(active)
          ? active
          : document.querySelector<HTMLElement>('button[aria-controls="project-rail"]');
      window.setTimeout(() => projectSearchRef.current?.focus(), 0);
    } else if (!projectDrawer && drawerWasOpenRef.current) {
      projectOpenerRef.current?.focus();
      projectOpenerRef.current = null;
    }
    drawerWasOpenRef.current = projectDrawer;
  }, [projectDrawer]);

  useEffect(() => {
    if (!project || !plugin) return;
    if (route.projectId !== project.id || route.pluginId !== plugin.id)
      navigate(project.id, plugin.id, true);
  }, [navigate, plugin, project, route.pluginId, route.projectId]);

  const selectProject = useCallback(
    (nextProject: ProjectDto) => {
      const remembered = storedValue(`in-progress:last-plugin:${nextProject.id}`);
      const nextPlugin = bootstrapData.plugins.some((candidate) => candidate.id === remembered)
        ? remembered!
        : "terminal";
      navigate(nextProject.id, nextPlugin);
      setProjectDrawer(false);
    },
    [bootstrapData.plugins, navigate],
  );

  const selectPlugin = useCallback(
    (nextPlugin: PluginDto) => {
      if (!project) return;
      navigate(project.id, nextPlugin.id);
    },
    [navigate, project],
  );

  const navigateUrl = useCallback((url: string) => {
    const target = new URL(url, window.location.href);
    if (target.origin !== window.location.origin) return;
    window.history.pushState({}, "", `${target.pathname}${target.search}${target.hash}`);
    setRoute(readRoute(target.pathname));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setProjectDrawer(false);
        setNotificationOpen(false);
        setPaletteOpen((value) => !value);
        return;
      }
      if (event.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (notificationOpen) setNotificationOpen(false);
        else if (projectDrawer) setProjectDrawer(false);
        return;
      }
      const number = Number(event.key);
      if (event.altKey && !modifier && number >= 1 && number <= 9) {
        const next = bootstrapData.projects[number - 1];
        if (next) {
          event.preventDefault();
          selectProject(next);
        }
        return;
      }
      if (modifier && event.altKey && number >= 1 && number <= 9) {
        const next = bootstrapData.plugins[number - 1];
        if (next) {
          event.preventDefault();
          selectPlugin(next);
        }
        return;
      }
      if (modifier && event.shiftKey && (event.key === "[" || event.key === "]")) {
        const current = bootstrapData.plugins.findIndex((candidate) => candidate.id === plugin?.id);
        if (current >= 0) {
          event.preventDefault();
          const direction = event.key === "]" ? 1 : -1;
          const index =
            (current + direction + bootstrapData.plugins.length) % bootstrapData.plugins.length;
          const next = bootstrapData.plugins[index];
          if (next) selectPlugin(next);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    bootstrapData.plugins,
    bootstrapData.projects,
    notificationOpen,
    paletteOpen,
    plugin?.id,
    projectDrawer,
    selectPlugin,
    selectProject,
  ]);

  const toggleRail = () => {
    setRailCollapsed((current) => {
      storeValue("in-progress:rail-collapsed", String(!current));
      return !current;
    });
  };

  const filteredProjects = bootstrapData.projects.filter((candidate) =>
    `${candidate.name} ${candidate.displayPath}`
      .toLowerCase()
      .includes(projectFilter.toLowerCase()),
  );
  const projectUnread = (projectId: string) =>
    feed.events.filter((event) => event.projectId === projectId && !event.readAt).length;

  const setCurrentPluginStatus = useCallback(
    (status: PluginStatus) => {
      if (!project || !plugin) return;
      setPluginStatuses((current) => ({ ...current, [`${project.id}:${plugin.id}`]: status }));
    },
    [plugin, project],
  );

  useEffect(() => {
    document.title =
      project && plugin ? `${plugin.name} — ${project.name} · in-progress` : "in-progress";
  }, [plugin, project]);

  if (!project || !plugin) {
    return (
      <main className="boot-screen">
        <div className="boot-error">
          <h1>Nothing is configured</h1>
          <p>
            Add at least one project and plugin to in-progress.config.json, then restart the host.
          </p>
        </div>
      </main>
    );
  }

  const shortcutModifier = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";

  return (
    <div className={`control-plane ${railCollapsed ? "rail-is-collapsed" : ""}`}>
      {projectDrawer ? (
        <button
          type="button"
          className="drawer-scrim is-visible"
          aria-label="Close project drawer"
          tabIndex={-1}
          onClick={() => setProjectDrawer(false)}
        />
      ) : null}
      <aside
        id="project-rail"
        className={`project-rail ${projectDrawer ? "is-open" : ""}`}
        aria-label="Projects"
        aria-modal={projectDrawer ? true : undefined}
        role={projectDrawer ? "dialog" : undefined}
        inert={notificationOpen || paletteOpen ? true : undefined}
        onKeyDown={(event) => {
          if (projectDrawer) trapTab(event);
        }}
      >
        <div className="rail-brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="brand-copy">
            <strong>in-progress</strong>
            <span>agent control</span>
          </div>
          <button
            type="button"
            className="icon-button mobile-only"
            onClick={() => setProjectDrawer(false)}
            aria-label="Close projects"
          >
            <ChevronLeft size={19} />
          </button>
        </div>
        <div className="rail-section-label">
          <span>PROJECTS</span>
          <span>{bootstrapData.projects.length}</span>
        </div>
        <label className="project-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Filter projects</span>
          <input
            ref={projectSearchRef}
            type="search"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            placeholder="Find a project"
          />
          {projectFilter ? (
            <button
              type="button"
              onClick={() => setProjectFilter("")}
              aria-label="Clear project filter"
            >
              <X size={14} />
            </button>
          ) : null}
        </label>
        <nav className="project-list">
          {filteredProjects.map((candidate, index) => {
            const unread = projectUnread(candidate.id);
            return (
              <button
                type="button"
                className={`project-item ${candidate.id === project.id ? "is-active" : ""}`}
                key={candidate.id}
                aria-current={candidate.id === project.id ? "page" : undefined}
                aria-label={`${candidate.name}, ${candidate.available ? "available" : "offline"}`}
                onClick={() => selectProject(candidate)}
                title={railCollapsed ? `${candidate.name} · ${candidate.displayPath}` : undefined}
                style={{ "--project-color": candidate.color } as CSSProperties}
              >
                <span className="project-glyph" aria-hidden="true">
                  {candidate.name.slice(0, 2).toUpperCase()}
                  <span
                    className={`availability ${candidate.available ? "is-online" : "is-offline"}`}
                  />
                </span>
                <span className="sr-only">{candidate.available ? "Available" : "Offline"}</span>
                <span className="project-copy">
                  <strong>{candidate.name}</strong>
                  <span>
                    {candidate.branch ? <GitBranch size={12} /> : null}
                    {candidate.branch ?? candidate.displayPath}
                  </span>
                </span>
                {unread > 0 ? (
                  <span className="project-badge">{unread > 99 ? "99+" : unread}</span>
                ) : null}
                {index < 9 ? <span className="shortcut-hint">⌥{index + 1}</span> : null}
              </button>
            );
          })}
          {filteredProjects.length === 0 ? (
            <p className="no-projects">No project matches “{projectFilter}”.</p>
          ) : null}
        </nav>
        <div className="rail-footer">
          <div className="identity-avatar" aria-hidden="true">
            {bootstrapData.identity.slice(0, 1).toUpperCase()}
          </div>
          <div className="identity-copy">
            <strong>{bootstrapData.identity}</strong>
            <span className={hostConnected ? "online" : "offline"}>
              {hostConnected ? "Host connected" : online ? "Host reconnecting" : "Browser offline"}
            </span>
          </div>
          <button
            type="button"
            className="icon-button collapse-button"
            onClick={toggleRail}
            aria-label={railCollapsed ? "Expand project rail" : "Collapse project rail"}
          >
            {railCollapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
          </button>
        </div>
      </aside>

      <main
        className="workspace"
        inert={projectDrawer || notificationOpen || paletteOpen ? true : undefined}
      >
        <header className="plugin-bar">
          <button
            type="button"
            className="icon-button menu-button"
            onClick={() => {
              setNotificationOpen(false);
              setPaletteOpen(false);
              setProjectDrawer(true);
            }}
            aria-label="Open projects"
            aria-controls="project-rail"
            aria-expanded={projectDrawer}
          >
            <Menu size={20} />
          </button>
          <div className="mobile-project-title">
            <strong>{project.name}</strong>
            <span>{project.branch ?? "project"}</span>
          </div>
          <div
            className="plugin-tabs"
            role="tablist"
            aria-label="Project views"
            onKeyDown={moveRovingTab}
          >
            {bootstrapData.plugins.map((candidate, index) => {
              const PluginIcon = pluginIcons[candidate.icon];
              const status = pluginStatuses[`${project.id}:${candidate.id}`];
              return (
                <button
                  type="button"
                  id={`plugin-tab-${candidate.id}`}
                  role="tab"
                  aria-selected={candidate.id === plugin.id}
                  aria-controls="plugin-viewport"
                  tabIndex={candidate.id === plugin.id ? 0 : -1}
                  className={`plugin-tab ${candidate.id === plugin.id ? "is-active" : ""} ${status ? `has-${status.state}` : ""}`}
                  key={candidate.id}
                  onClick={() => selectPlugin(candidate)}
                  title={
                    index < 9
                      ? `${candidate.description} · shortcut ${shortcutModifier}+Alt+${index + 1}`
                      : candidate.description
                  }
                >
                  <PluginIcon size={17} />
                  <span>{status?.title ?? candidate.name}</span>
                  {status?.state === "busy" ? (
                    <span className="mini-spinner" aria-label="Busy" />
                  ) : null}
                  {status?.badge ? <span className="plugin-badge">{status.badge}</span> : null}
                  {status?.state === "attention" || status?.state === "error" ? (
                    <span className="plugin-status-dot" aria-label={status.state} />
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="host-actions">
            <button
              type="button"
              className="command-button"
              onClick={() => {
                setProjectDrawer(false);
                setNotificationOpen(false);
                setPaletteOpen(true);
              }}
              title="Command palette"
              aria-label={`Open command palette, ${shortcutModifier}+Shift+P`}
            >
              <Command size={15} />
              <span>{shortcutModifier === "⌘" ? "⌘⇧P" : "Ctrl⇧P"}</span>
            </button>
            <span
              className={`host-state ${hostConnected ? "is-online" : "is-offline"}`}
              title={
                hostConnected ? "Host connected" : online ? "Host reconnecting" : "Browser offline"
              }
            >
              {hostConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
            </span>
            <button
              type="button"
              className="notification-button"
              onClick={() => {
                setProjectDrawer(false);
                setPaletteOpen(false);
                setNotificationOpen(true);
              }}
              aria-label={`Notifications${feed.unread ? `, ${feed.unread} unread` : ""}`}
            >
              <Bell size={18} />
              {feed.unread > 0 ? <span>{feed.unread > 99 ? "99+" : feed.unread}</span> : null}
            </button>
          </div>
        </header>
        {!hostConnected ? (
          <div className="offline-banner" role="status">
            <WifiOff size={15} />
            {online
              ? "Reconnecting to host — durable processes continue."
              : "Browser offline — durable processes continue on the host."}
          </div>
        ) : null}
        <div
          id="plugin-viewport"
          className="plugin-viewport"
          role="tabpanel"
          aria-labelledby={`plugin-tab-${plugin.id}`}
        >
          {plugin.kind === "host" ? (
            <Suspense
              fallback={
                <div className="terminal-placeholder" role="status">
                  <span className="spinner" />
                  <span>Loading terminal…</span>
                </div>
              }
            >
              <TerminalPane key={project.id} api={api} project={project} onToast={showToast} />
            </Suspense>
          ) : (
            <PluginFrame
              key={`${project.id}:${plugin.id}`}
              api={api}
              project={project}
              plugin={plugin}
              onStatus={setCurrentPluginStatus}
              onToast={showToast}
            />
          )}
        </div>
      </main>

      <NotificationCenter
        api={api}
        available={bootstrapData.notification.available}
        publicKey={bootstrapData.notification.publicKey}
        events={feed.events}
        loading={feed.loading}
        open={notificationOpen}
        projects={bootstrapData.projects}
        onClose={() => setNotificationOpen(false)}
        onMarkRead={feed.markRead}
        onMarkAllRead={feed.markAllRead}
        onNavigate={navigateUrl}
        onToast={showToast}
      />

      <CommandPalette
        open={paletteOpen}
        projects={bootstrapData.projects}
        plugins={bootstrapData.plugins}
        activeProject={project}
        onClose={() => setPaletteOpen(false)}
        onProject={selectProject}
        onPlugin={selectPlugin}
        onNotifications={() => {
          setPaletteOpen(false);
          window.setTimeout(() => setNotificationOpen(true), 0);
        }}
      />

      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div className={`toast toast--${toast.tone}`} key={toast.id}>
            {toast.tone === "danger" ? <CircleAlert size={17} /> : <Sparkles size={16} />}
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              aria-label="Dismiss message"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface CommandPaletteProps {
  open: boolean;
  projects: ProjectDto[];
  plugins: PluginDto[];
  activeProject: ProjectDto;
  onClose: () => void;
  onProject: (project: ProjectDto) => void;
  onPlugin: (plugin: PluginDto) => void;
  onNotifications: () => void;
}

function CommandPalette({
  open,
  projects,
  plugins,
  activeProject,
  onClose,
  onProject,
  onPlugin,
  onNotifications,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      openerRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else if (!open && wasOpenRef.current) {
      openerRef.current?.focus();
      openerRef.current = null;
    }
    wasOpenRef.current = open;
  }, [open]);

  const normalized = query.trim().toLowerCase();
  const matchingProjects = projects.filter((project) =>
    `${project.name} ${project.displayPath}`.toLowerCase().includes(normalized),
  );
  const matchingPlugins = plugins.filter((plugin) =>
    `${plugin.name} ${plugin.description}`.toLowerCase().includes(normalized),
  );
  const actionMatches = "notifications activity inbox".includes(normalized);

  return (
    <div
      className={`palette-layer ${open ? "is-open" : ""}`}
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      <button
        type="button"
        className="palette-scrim"
        onClick={onClose}
        tabIndex={-1}
        aria-label="Close command palette"
      />
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={trapTab}
      >
        <label className="palette-input">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Jump to a project or view…"
          />
          <kbd>esc</kbd>
        </label>
        <div className="palette-results">
          {matchingProjects.length > 0 ? (
            <div className="palette-group">
              <p>Projects</p>
              {matchingProjects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  onClick={() => {
                    onProject(project);
                    onClose();
                  }}
                >
                  <span className="palette-project-dot" style={{ background: project.color }} />
                  <strong>{project.name}</strong>
                  <span>{project.branch ?? project.displayPath}</span>
                </button>
              ))}
            </div>
          ) : null}
          {matchingPlugins.length > 0 ? (
            <div className="palette-group">
              <p>Views in {activeProject.name}</p>
              {matchingPlugins.map((plugin) => {
                const PluginIcon = pluginIcons[plugin.icon];
                return (
                  <button
                    type="button"
                    key={plugin.id}
                    onClick={() => {
                      onPlugin(plugin);
                      onClose();
                    }}
                  >
                    <PluginIcon size={16} />
                    <strong>{plugin.name}</strong>
                    <span>{plugin.description}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {actionMatches ? (
            <div className="palette-group">
              <p>Actions</p>
              <button type="button" onClick={onNotifications}>
                <Bell size={16} />
                <strong>Open notification inbox</strong>
                <span>Review agent events</span>
              </button>
            </div>
          ) : null}
          {matchingProjects.length === 0 && matchingPlugins.length === 0 && !actionMatches ? (
            <div className="palette-empty">No matching command.</div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
