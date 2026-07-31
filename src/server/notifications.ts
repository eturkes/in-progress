import { EventEmitter } from "node:events";
import webpush, { type PushSubscription, type RequestOptions, type SendResult } from "web-push";
import type { EventDto, NotificationEventInput } from "../shared/contracts";
import { StateStore } from "./store";

export const PUSH_QUEUE_LIMIT = 100;
export const PUSH_CONCURRENCY_LIMIT = 8;

type PushSender = (
  subscription: PushSubscription,
  payload: string,
  options: RequestOptions,
) => Promise<SendResult | void>;

const pushPolicy = {
  "needs-input": { TTL: 86_400, urgency: "high" },
  failed: { TTL: 21_600, urgency: "high" },
  completed: { TTL: 3_600, urgency: "normal" },
  system: { TTL: 3_600, urgency: "normal" },
} as const satisfies Record<EventDto["kind"], Pick<RequestOptions, "TTL" | "urgency">>;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class NotificationService {
  readonly #events = new EventEmitter<{ event: [EventDto, boolean] }>();
  readonly #keys: VapidKeys;
  readonly #sendNotification: PushSender;
  readonly #pushQueue: EventDto[] = [];
  #drainingPushes = false;
  #pushDrainScheduled = false;
  #reportedQueuePressure = false;

  constructor(
    readonly store: StateStore,
    vapidSubject: string,
    sendNotification: PushSender = (subscription, payload, options) =>
      webpush.sendNotification(subscription, payload, options),
  ) {
    this.#sendNotification = sendNotification;
    const persisted = store.getMeta("vapidKeys");
    this.#keys = persisted ? (JSON.parse(persisted) as VapidKeys) : webpush.generateVAPIDKeys();
    if (!persisted) store.setMeta("vapidKeys", JSON.stringify(this.#keys));
    webpush.setVapidDetails(vapidSubject, this.#keys.publicKey, this.#keys.privateKey);
  }

  get publicKey(): string {
    return this.#keys.publicKey;
  }

  get hookToken(): string {
    const persisted = this.store.getMeta("hookToken");
    if (persisted) return persisted;
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    this.store.setMeta("hookToken", token);
    return token;
  }

  subscribe(subscription: PushSubscription): void {
    this.store.saveSubscription(subscription);
  }

  unsubscribe(endpoint: string): void {
    this.store.removeSubscription(endpoint);
  }

  onEvent(listener: (event: EventDto, announce: boolean) => void): () => void {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  create(input: NotificationEventInput, sendPush = true): EventDto {
    const event: EventDto = {
      id: crypto.randomUUID(),
      projectId: input.projectId ?? null,
      kind: input.kind,
      title: input.title,
      body: input.body,
      url: input.url,
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    this.store.insertEvent(event);
    this.#events.emit("event", event, true);
    if (sendPush) this.#enqueuePush(event);
    return event;
  }

  broadcastUpdate(event: EventDto): void {
    this.#events.emit("event", event, false);
  }

  #enqueuePush(event: EventDto): void {
    if (this.#pushQueue.length >= PUSH_QUEUE_LIMIT) {
      this.#pushQueue.shift();
      if (!this.#reportedQueuePressure) {
        console.warn(
          `Push queue reached ${PUSH_QUEUE_LIMIT} events; dropping oldest queued deliveries`,
        );
        this.#reportedQueuePressure = true;
      }
    }
    this.#pushQueue.push(event);
    this.#schedulePushDrain();
  }

  #schedulePushDrain(): void {
    if (this.#drainingPushes || this.#pushDrainScheduled) return;
    this.#pushDrainScheduled = true;
    queueMicrotask(() => {
      this.#pushDrainScheduled = false;
      void this.#drainPushQueue();
    });
  }

  async #drainPushQueue(): Promise<void> {
    if (this.#drainingPushes) return;
    this.#drainingPushes = true;
    try {
      let event = this.#pushQueue.shift();
      while (event) {
        try {
          await this.#push(event);
        } catch (error) {
          console.error("Push event fan-out failed", error);
        }
        event = this.#pushQueue.shift();
      }
    } finally {
      this.#drainingPushes = false;
      this.#reportedQueuePressure = false;
      if (this.#pushQueue.length > 0) this.#schedulePushDrain();
    }
  }

  async #push(event: EventDto): Promise<void> {
    const payload = JSON.stringify({
      id: event.id,
      kind: event.kind,
      title: event.title,
      body: event.body,
      url: event.url,
    });
    const subscriptions = this.store.subscriptions();
    const options: RequestOptions = { ...pushPolicy[event.kind], timeout: 10_000 };
    for (let offset = 0; offset < subscriptions.length; offset += PUSH_CONCURRENCY_LIMIT) {
      await Promise.allSettled(
        subscriptions
          .slice(offset, offset + PUSH_CONCURRENCY_LIMIT)
          .map((subscription) => this.#deliver(subscription, payload, options)),
      );
    }
  }

  async #deliver(
    subscription: PushSubscription,
    payload: string,
    options: RequestOptions,
  ): Promise<void> {
    try {
      await this.#sendNotification(subscription, payload, options);
      this.store.markSubscriptionSuccess(subscription.endpoint);
    } catch (error) {
      const statusCode =
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 0;
      if (statusCode === 404 || statusCode === 410)
        this.store.removeSubscription(subscription.endpoint);
      else console.error("Push delivery failed", { statusCode });
    }
  }
}
