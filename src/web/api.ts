import type {
  BootstrapDto,
  EventDto,
  PluginRpcRequest,
  TerminalSessionDto,
} from "../shared/contracts";

type JsonError = { error?: string };
let recoveryStarted = false;

async function decode<T>(response: Response, recoverSession = false): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as JsonError;
    if (body.error) message = body.error;
  } catch {
    // Preserve the HTTP status when an intermediary returned a non-JSON body.
  }
  if (
    recoverSession &&
    !recoveryStarted &&
    (response.status === 401 ||
      (response.status === 403 &&
        (message === "CSRF token rejected" || message === "Session identity changed")))
  ) {
    recoveryStarted = true;
    window.location.reload();
    throw new Error("Browser session expired; reconnecting");
  }
  throw new Error(message);
}

export async function bootstrap(): Promise<BootstrapDto> {
  return decode<BootstrapDto>(await fetch("/api/bootstrap"));
}

export class ApiClient {
  constructor(readonly csrfToken: string) {}

  async #get<T>(url: string): Promise<T> {
    return decode<T>(await fetch(url), true);
  }

  async #mutation<T>(url: string, method: "POST" | "DELETE", body?: unknown): Promise<T> {
    const headers = new Headers({ "x-in-progress-csrf": this.csrfToken });
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return undefined as T;
    return decode<T>(response, true);
  }

  async sessions(projectId: string): Promise<TerminalSessionDto[]> {
    const body = await this.#get<{ sessions: TerminalSessionDto[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
    );
    return body.sessions;
  }

  async createSession(projectId: string): Promise<TerminalSessionDto> {
    const body = await this.#mutation<{ session: TerminalSessionDto }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
      "POST",
    );
    return body.session;
  }

  async terminateSession(projectId: string, sessionId: string): Promise<void> {
    await this.#mutation<void>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      "DELETE",
    );
  }

  async terminalTicket(
    projectId: string,
    sessionId: string,
  ): Promise<{ ticket: string; expiresAt: string }> {
    return this.#mutation<{ ticket: string; expiresAt: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/ticket`,
      "POST",
    );
  }

  async events(): Promise<EventDto[]> {
    const body = await this.#get<{ events: EventDto[] }>("/api/events");
    return body.events;
  }

  async markEventRead(eventId: string): Promise<EventDto> {
    const body = await this.#mutation<{ event: EventDto }>(
      `/api/events/${encodeURIComponent(eventId)}/read`,
      "POST",
    );
    return body.event;
  }

  async pluginRpc(
    pluginId: string,
    projectId: string,
    request: PluginRpcRequest,
  ): Promise<unknown> {
    const body = await this.#mutation<{ result: unknown }>(
      `/api/plugins/${encodeURIComponent(pluginId)}/projects/${encodeURIComponent(projectId)}/rpc`,
      "POST",
      request,
    );
    return body.result;
  }

  async subscribe(subscription: PushSubscriptionJSON): Promise<number> {
    const body = await this.#mutation<{ subscriptionCount: number }>(
      "/api/notifications/subscriptions",
      "POST",
      subscription,
    );
    return body.subscriptionCount;
  }

  async unsubscribe(endpoint: string): Promise<number> {
    const body = await this.#mutation<{ subscriptionCount: number }>(
      "/api/notifications/subscriptions",
      "DELETE",
      { endpoint },
    );
    return body.subscriptionCount;
  }

  async testNotification(): Promise<EventDto> {
    const body = await this.#mutation<{ event: EventDto }>("/api/notifications/test", "POST");
    return body.event;
  }
}

export function websocketUrl(ticket: string): string {
  const url = new URL("/api/terminal", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.href;
}

export function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const bytes = atob(`${value}${padding}`.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}
