import {
  AlertCircle,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  CircleCheck,
  CircleX,
  Inbox,
  LoaderCircle,
  Settings2,
  Send,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventDto, EventKind, ProjectDto } from "../../shared/contracts";
import { moveRovingTab, trapTab } from "../a11y";
import { applicationServerKey, type ApiClient } from "../api";

interface UseEventFeedOptions {
  api: ApiClient;
  onForegroundEvent: (event: EventDto) => void;
}

export function useEventFeed({ api, onForegroundEvent }: UseEventFeedOptions) {
  const [events, setEvents] = useState<EventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    const merge = (incoming: EventDto[]) => {
      setEvents((current) => {
        const byId = new Map(current.map((event) => [event.id, event]));
        for (const event of incoming) byId.set(event.id, event);
        return [...byId.values()]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 100);
      });
    };
    const sync = async () => {
      try {
        const authoritative = await api.events();
        if (active) merge(authoritative);
      } catch {
        // A later SSE open/visibility change retries; auth expiry reloads through ApiClient.
      } finally {
        if (active) setLoading(false);
      }
    };

    const consumeNotificationDeepLink = async () => {
      const target = new URL(window.location.href);
      const eventId = target.searchParams.get("in-progress-event");
      if (!eventId) return;
      target.searchParams.delete("in-progress-event");
      try {
        merge([await api.markEventRead(eventId)]);
      } catch {
        // The event may have expired from bounded retention; navigation still succeeds.
      } finally {
        window.history.replaceState({}, "", `${target.pathname}${target.search}${target.hash}`);
      }
    };

    void sync();
    void consumeNotificationDeepLink();

    const stream = new EventSource("/api/events/stream");
    stream.addEventListener("open", () => {
      setConnected(true);
      void sync();
    });
    stream.addEventListener("error", () => {
      setConnected(false);
      void sync();
    });
    stream.addEventListener("in-progress", ({ data }: MessageEvent<string>) => {
      try {
        const event = JSON.parse(data) as EventDto;
        merge([event]);
        if (document.visibilityState === "visible") onForegroundEvent(event);
      } catch {
        // Ignore malformed external event data; the persisted feed remains authoritative.
      }
    });
    stream.addEventListener("in-progress-update", ({ data }: MessageEvent<string>) => {
      try {
        merge([JSON.parse(data) as EventDto]);
      } catch {
        // The next authoritative sync repairs malformed transient updates.
      }
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      stream.close();
    };
  }, [api, onForegroundEvent]);

  const markRead = useCallback(
    async (eventId: string) => {
      const updated = await api.markEventRead(eventId);
      setEvents((current) => current.map((event) => (event.id === eventId ? updated : event)));
    },
    [api],
  );

  const markAllRead = useCallback(async () => {
    const unread = events.filter((event) => !event.readAt);
    await Promise.all(unread.map((event) => api.markEventRead(event.id)));
    const readAt = new Date().toISOString();
    setEvents((current) => current.map((event) => (event.readAt ? event : { ...event, readAt })));
  }, [api, events]);

  return {
    events,
    loading,
    unread: events.filter((event) => !event.readAt).length,
    connected,
    markRead,
    markAllRead,
  };
}

interface NotificationCenterProps {
  api: ApiClient;
  available: boolean;
  publicKey: string;
  events: EventDto[];
  loading: boolean;
  open: boolean;
  projects: ProjectDto[];
  onClose: () => void;
  onMarkRead: (eventId: string) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  onNavigate: (url: string) => void;
  onToast: (message: string, tone?: "neutral" | "danger") => void;
}

type FeedFilter = "all" | EventKind;

const eventIcons: Record<EventKind, React.ReactNode> = {
  "needs-input": <AlertCircle size={16} />,
  completed: <CircleCheck size={16} />,
  failed: <CircleX size={16} />,
  system: <Bell size={16} />,
};

function relativeTime(value: string, now: number): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function devicePushAvailable(hostAvailable: boolean): boolean {
  return (
    hostAvailable &&
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function serviceWorkerRegistration(timeoutMs = 8_000): Promise<ServiceWorkerRegistration> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("The in-progress service worker did not become ready")),
      timeoutMs,
    );
    void navigator.serviceWorker.ready.then(
      (registration) => {
        window.clearTimeout(timeout);
        resolve(registration);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function subscriptionUsesKey(subscription: PushSubscription, publicKey: string): boolean {
  const configured = subscription.options.applicationServerKey;
  if (!configured) return false;
  const actual = new Uint8Array(configured);
  const expected = applicationServerKey(publicKey);
  return (
    actual.byteLength === expected.byteLength &&
    actual.every((byte, index) => byte === expected[index])
  );
}

export function NotificationCenter({
  api,
  available,
  publicKey,
  events,
  loading,
  open,
  projects,
  onClose,
  onMarkRead,
  onMarkAllRead,
  onNavigate,
  onToast,
}: NotificationCenterProps) {
  const [view, setView] = useState<"inbox" | "settings">("inbox");
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    "Notification" in window ? Notification.permission : "denied",
  );
  const supported = devicePushAvailable(available);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement as HTMLElement | null;
      openerRef.current =
        active && active !== document.body && !panelRef.current?.contains(active)
          ? active
          : document.querySelector<HTMLElement>(".notification-button");
      window.setTimeout(() => closeRef.current?.focus(), 0);
    } else if (!open && wasOpenRef.current) {
      openerRef.current?.focus();
      openerRef.current = null;
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setClock(Date.now());
    const interval = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [open]);

  useEffect(() => {
    if (!open || !supported) return;
    setPermission(Notification.permission);
    let active = true;
    void serviceWorkerRegistration()
      .then(async (registration) => {
        let current = await registration.pushManager.getSubscription();
        if (current && !subscriptionUsesKey(current, publicKey)) {
          await api.unsubscribe(current.endpoint).catch(() => undefined);
          await current.unsubscribe();
          current = null;
          if (Notification.permission === "granted") {
            current = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: applicationServerKey(publicKey),
            });
          }
        }
        if (current) await api.subscribe(current.toJSON());
        if (active) setSubscription(current);
      })
      .catch(() => {
        if (active) setSubscription(null);
      });
    return () => {
      active = false;
    };
  }, [api, open, publicKey, supported]);

  useEffect(() => {
    if (!open) setView("inbox");
  }, [open]);

  const filtered = useMemo(
    () => (filter === "all" ? events : events.filter((event) => event.kind === filter)),
    [events, filter],
  );
  const unread = events.filter((event) => !event.readAt).length;

  const enablePush = async () => {
    setPushBusy(true);
    try {
      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);
      if (nextPermission !== "granted")
        throw new Error("Browser notification permission was not granted");
      const registration = await serviceWorkerRegistration();
      let existing = await registration.pushManager.getSubscription();
      if (existing && !subscriptionUsesKey(existing, publicKey)) {
        await api.unsubscribe(existing.endpoint).catch(() => undefined);
        const removed = await existing.unsubscribe();
        if (!removed) throw new Error("The old push subscription could not be replaced");
        existing = null;
      }
      const next =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        }));
      try {
        await api.subscribe(next.toJSON());
      } catch (error) {
        if (!existing) await next.unsubscribe().catch(() => false);
        throw error;
      }
      setSubscription(next);
      onToast("Phone notifications enabled on this device");
    } catch (pushError) {
      onToast(
        pushError instanceof Error ? pushError.message : "Could not enable notifications",
        "danger",
      );
    } finally {
      setPushBusy(false);
    }
  };

  const disablePush = async () => {
    if (!subscription) return;
    setPushBusy(true);
    try {
      const results = await Promise.allSettled([
        api.unsubscribe(subscription.endpoint),
        subscription.unsubscribe().then((removed) => {
          if (!removed) throw new Error("Browser subscription removal failed");
        }),
      ]);
      const registration = await serviceWorkerRegistration();
      setSubscription(await registration.pushManager.getSubscription());
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      onToast("Phone notifications disabled on this device");
    } catch (pushError) {
      onToast(
        pushError instanceof Error ? pushError.message : "Could not disable notifications",
        "danger",
      );
    } finally {
      setPushBusy(false);
    }
  };

  const testPush = async () => {
    setPushBusy(true);
    try {
      await api.testNotification();
      onToast("Test notification queued");
    } catch (pushError) {
      onToast(
        pushError instanceof Error ? pushError.message : "Test notification failed",
        "danger",
      );
    } finally {
      setPushBusy(false);
    }
  };

  const openEvent = async (event: EventDto) => {
    if (!event.readAt) {
      try {
        await onMarkRead(event.id);
      } catch {
        onToast("Could not mark notification read", "danger");
      }
    }
    onClose();
    onNavigate(event.url);
  };

  return (
    <>
      {open ? (
        <button
          type="button"
          className="scrim is-visible"
          onClick={onClose}
          aria-label="Close notification center"
          tabIndex={-1}
        />
      ) : null}
      <aside
        ref={panelRef}
        className={`notification-center ${open ? "is-open" : ""}`}
        aria-hidden={!open}
        aria-label="Notifications"
        aria-modal={open ? true : undefined}
        role="dialog"
        inert={open ? undefined : true}
        onKeyDown={trapTab}
      >
        <header className="notification-header">
          <div>
            <p className="eyebrow">ACTIVITY</p>
            <h2>{view === "inbox" ? "Notification inbox" : "Notification settings"}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close notifications"
          >
            <X size={19} />
          </button>
        </header>
        <div
          className="notification-view-tabs"
          role="tablist"
          aria-label="Notification views"
          onKeyDown={moveRovingTab}
        >
          <button
            type="button"
            id="notification-tab-inbox"
            role="tab"
            aria-selected={view === "inbox"}
            aria-controls="notification-panel-inbox"
            tabIndex={view === "inbox" ? 0 : -1}
            className={view === "inbox" ? "is-active" : ""}
            onClick={() => setView("inbox")}
          >
            <Inbox size={16} />
            Inbox
            {unread > 0 ? (
              <span className="count-badge">{unread > 99 ? "99+" : unread}</span>
            ) : null}
          </button>
          <button
            type="button"
            id="notification-tab-settings"
            role="tab"
            aria-selected={view === "settings"}
            aria-controls="notification-panel-settings"
            tabIndex={view === "settings" ? 0 : -1}
            className={view === "settings" ? "is-active" : ""}
            onClick={() => setView("settings")}
          >
            <Settings2 size={16} />
            Settings
          </button>
        </div>

        {view === "inbox" ? (
          <div
            id="notification-panel-inbox"
            className="notification-inbox"
            role="tabpanel"
            aria-labelledby="notification-tab-inbox"
          >
            <div className="inbox-tools">
              <div className="filter-chips" aria-label="Filter notifications">
                {(["all", "needs-input", "completed", "failed", "system"] as const).map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    className={filter === kind ? "is-active" : ""}
                    aria-pressed={filter === kind}
                    onClick={() => setFilter(kind)}
                  >
                    {kind === "all"
                      ? "All"
                      : kind === "needs-input"
                        ? "Input"
                        : kind[0]?.toUpperCase() + kind.slice(1)}
                  </button>
                ))}
              </div>
              {unread > 0 ? (
                <button
                  type="button"
                  className="mark-all"
                  onClick={() =>
                    void onMarkAllRead().catch(() =>
                      onToast("Could not mark all notifications read", "danger"),
                    )
                  }
                >
                  <CheckCheck size={15} />
                  Read all
                </button>
              ) : null}
            </div>
            <div className="event-list">
              {loading ? (
                <div className="event-empty" role="status">
                  <LoaderCircle className="spin" size={20} />
                  Loading activity…
                </div>
              ) : filtered.length === 0 ? (
                <div className="event-empty">
                  <Check size={22} />
                  <strong>Nothing waiting</strong>
                  <span>New agent events will appear here.</span>
                </div>
              ) : (
                filtered.map((event) => {
                  const project = projects.find((item) => item.id === event.projectId);
                  return (
                    <button
                      type="button"
                      className={`event-card event-card--${event.kind} ${event.readAt ? "is-read" : ""}`}
                      key={event.id}
                      onClick={() => void openEvent(event)}
                    >
                      <span className="event-kind" aria-hidden="true">
                        {eventIcons[event.kind]}
                      </span>
                      <span className="event-copy">
                        <span className="event-meta">
                          <span>{project?.name ?? "System"}</span>
                          <time dateTime={event.createdAt}>
                            {relativeTime(event.createdAt, clock)}
                          </time>
                        </span>
                        <strong>{event.title}</strong>
                        {event.body ? <span>{event.body}</span> : null}
                      </span>
                      {!event.readAt ? <span className="unread-dot" aria-label="Unread" /> : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div
            id="notification-panel-settings"
            className="notification-settings"
            role="tabpanel"
            aria-labelledby="notification-tab-settings"
          >
            <section className="settings-card">
              <div className="settings-icon">
                {subscription ? <Bell size={21} /> : <BellOff size={21} />}
              </div>
              <div className="settings-copy">
                <h3>Phone push</h3>
                <p>
                  {subscription
                    ? "This browser receives completion, failure, and input-needed events."
                    : "Receive agent events when in-progress is closed or in the background."}
                </p>
              </div>
              <button
                type="button"
                className={subscription ? "secondary-button" : "primary-button"}
                disabled={pushBusy || !supported || permission === "denied"}
                onClick={() => void (subscription ? disablePush() : enablePush())}
              >
                {pushBusy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : subscription ? (
                  "Disable"
                ) : (
                  "Enable"
                )}
              </button>
            </section>
            {!supported ? (
              <p className="settings-note danger-note">
                Push requires an installed service worker and a secure HTTPS connection.
              </p>
            ) : permission === "denied" ? (
              <p className="settings-note danger-note">
                Notifications are blocked in browser settings. Allow them there, then reopen this
                panel.
              </p>
            ) : (
              <p className="settings-note">
                Permission is requested only after you press Enable. Push previews may include event
                titles and summaries.
              </p>
            )}
            <section className="settings-row">
              <div>
                <h3>Delivery check</h3>
                <p>Queue a real system event for every subscribed device.</p>
              </div>
              <button
                type="button"
                className="secondary-button"
                disabled={pushBusy || !subscription}
                onClick={() => void testPush()}
              >
                <Send size={15} />
                Send test
              </button>
            </section>
          </div>
        )}
      </aside>
    </>
  );
}
