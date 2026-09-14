import { decrypt, encrypt, redact } from "./security.ts";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";

export const alertEvents = [
  "stream.started",
  "stream.stopped",
  "stream.failed",
  "output.retrying",
  "schedule.failed",
  "system.threshold",
  "stream.stalled",
] as const;
export type AlertEvent = (typeof alertEvents)[number];
const eventNames: Record<string, AlertEvent | undefined> = {
  "stream.start": "stream.started",
  "stream.stop": "stream.stopped",
  "output.failed": "stream.failed",
  "stream.recovery_failed": "stream.failed",
  "output.retry": "output.retrying",
  "schedule.failed": "schedule.failed",
  "system.threshold": "system.threshold",
  "output.stalled": "stream.stalled",
};
type Fetch = typeof fetch;
type Settings = {
  provider: "discord" | "telegram";
  target: string;
  secret: string;
  enabled: boolean;
  events: AlertEvent[];
};

export class Notifications {
  private lastSent = new Map<string, number>();
  private pending = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  constructor(
    private store: Store,
    private encryptionKey: string,
    private request: Fetch = fetch,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS notification_queue(id TEXT PRIMARY KEY,envelope TEXT NOT NULL,resource TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL)",
    );
  }
  start() {
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  flush(now = Date.now()): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drain(now).finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }
  private async drain(now: number) {
    const jobs = this.store.db
      .prepare(
        "SELECT * FROM notification_queue WHERE next_at<=? ORDER BY next_at LIMIT 10",
      )
      .all(now) as any[];
    for (const job of jobs) {
      try {
        const envelope = JSON.parse(decrypt(job.envelope, this.encryptionKey));
        await this.send(envelope.settings, envelope.text);
        this.store.db
          .prepare("DELETE FROM notification_queue WHERE id=?")
          .run(job.id);
      } catch {
        const attempts = job.attempts + 1;
        if (attempts >= 3)
          this.store.db
            .prepare("DELETE FROM notification_queue WHERE id=?")
            .run(job.id);
        else
          this.store.db
            .prepare(
              "UPDATE notification_queue SET attempts=?,next_at=? WHERE id=?",
            )
            .run(attempts, now + 10000 * attempts, job.id);
        this.store.event(
          "notification",
          "notification.failed",
          job.resource,
          "Delivery failed; check notification settings and server connectivity.",
          "",
          "failure",
          { attempts, retryScheduled: attempts < 3 },
        );
      }
    }
  }
  get() {
    const settings = this.store.get("notifications", "primary");
    if (!settings)
      return {
        configured: false,
        enabled: false,
        provider: null,
        target: "",
        events: [],
      };
    return {
      configured: Boolean(settings.secret),
      enabled: settings.enabled,
      provider: settings.provider,
      target:
        settings.provider === "discord" ? "Discord webhook" : settings.target,
      events: settings.events,
    };
  }
  save(input: {
    provider: Settings["provider"];
    target: string;
    secret?: string;
    enabled: boolean;
    events: AlertEvent[];
  }) {
    const previous = this.store.get("notifications", "primary");
    if (previous && previous.provider !== input.provider && !input.secret)
      throw new Error("A new credential is required when changing providers");
    if (!input.secret && !previous?.secret)
      throw new Error("Notification credentials are required");
    const credential = input.secret || previous!.secret;
    const plaintext = input.secret
      ? input.secret
      : decrypt(credential, this.encryptionKey);
    if (
      input.provider === "telegram" &&
      (!/^\d{5,15}:[A-Za-z\d_-]{20,80}$/.test(plaintext) ||
        !input.target.trim() ||
        input.target.length > 128)
    )
      throw new Error("Telegram bot token or chat ID is invalid");
    if (input.provider === "discord") {
      try {
        const url = new URL(plaintext);
        if (
          url.protocol !== "https:" ||
          !["discord.com", "discordapp.com"].includes(url.hostname) ||
          url.port ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !/^\/api\/webhooks\/\d{15,25}\/[A-Za-z\d._-]{20,200}$/.test(
            url.pathname,
          )
        )
          throw new Error();
      } catch {
        throw new Error("Discord webhook URL is invalid");
      }
    }
    const secret = input.secret
      ? encrypt(input.secret, this.encryptionKey)
      : previous!.secret;
    const settings = {
      id: "primary",
      name: "Primary notification channel",
      provider: input.provider,
      target: input.target.trim(),
      secret,
      enabled: input.enabled,
      events: [...new Set(input.events)],
    };
    this.store.save("notifications", settings);
    return this.get();
  }
  private configuration(): Settings {
    const settings = this.store.get("notifications", "primary");
    if (!settings?.secret)
      throw new Error("Configure a notification channel first");
    return {
      ...settings,
      secret: decrypt(settings.secret, this.encryptionKey),
    } as unknown as Settings;
  }
  private async send(settings: Settings, message: string) {
    let url: string;
    let body: unknown;
    if (settings.provider === "telegram") {
      url = `https://api.telegram.org/bot${settings.secret}/sendMessage`;
      body = { chat_id: settings.target, text: message };
    } else {
      // Lock delivery to Discord's official webhook hosts to prevent an
      // operator typo or imported database entry becoming an arbitrary fetch.
      const webhook = new URL(settings.secret);
      if (
        webhook.protocol !== "https:" ||
        !["discord.com", "discordapp.com"].includes(webhook.hostname) ||
        webhook.port ||
        webhook.username ||
        webhook.password ||
        webhook.search ||
        webhook.hash ||
        !/^\/api\/webhooks\/\d{15,25}\/[A-Za-z\d._-]{20,200}$/.test(
          webhook.pathname,
        )
      )
        throw new Error("Discord webhook URL is invalid");
      webhook.searchParams.set("wait", "true");
      url = webhook.toString();
      body = {
        content: message.slice(0, 1900),
        allowed_mentions: { parse: [] },
      };
    }
    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
    } catch {
      throw new Error(
        "Notification delivery failed. Check server connectivity and the provider credentials.",
      );
    }
    if (!response.ok)
      throw new Error(
        "Notification provider rejected the message. Check credentials and destination settings.",
      );
    if (settings.provider === "telegram") {
      try {
        const result = (await response.json()) as { ok?: boolean };
        if (result.ok !== true) throw new Error();
      } catch {
        throw new Error(
          "Notification provider rejected the message. Check credentials and destination settings.",
        );
      }
    }
  }
  async test() {
    await this.send(
      this.configuration(),
      "StreaMax test notification · Delivery is working.",
    );
  }
  async notify(
    action: string,
    actor: string,
    resource: string,
    message: string,
  ) {
    const task = this.deliver(action, actor, resource, message);
    this.pending.add(task);
    try {
      await task;
    } finally {
      this.pending.delete(task);
    }
  }
  private async deliver(
    action: string,
    actor: string,
    resource: string,
    message: string,
  ) {
    const event = eventNames[action];
    if (!event) return;
    const settings = this.store.get("notifications", "primary");
    if (!settings?.enabled || !settings.events.includes(event)) return;
    const key = `${event}:${resource}`;
    const now = Date.now();
    if (
      event === "output.retrying" &&
      now - (this.lastSent.get(key) || 0) < 30_000
    )
      return;
    this.lastSent.set(key, now);
    const name =
      this.store.get("streams", resource)?.name ||
      this.store.get("schedules", resource)?.name ||
      resource;
    const text = [
      `StreaMax · ${event.replaceAll(".", " ")}`,
      `Resource: ${name}`,
      `Time: ${new Date().toISOString()}`,
      ...(message ? [`Details: ${redact(message).slice(0, 1000)}`] : []),
      `By: ${actor}`,
    ]
      .join("\n")
      .slice(0, 1800);
    if (
      Number(
        this.store.db
          .prepare("SELECT COUNT(*) AS n FROM notification_queue")
          .get()!.n,
      ) >= 1000
    ) {
      this.store.event(
        "notification",
        "notification.queue_full",
        resource,
        "Notification queue capacity reached",
        "",
        "failure",
      );
      return;
    }
    this.store.db
      .prepare(
        "INSERT INTO notification_queue(id,envelope,resource,next_at) VALUES(?,?,?,?)",
      )
      .run(
        randomUUID(),
        encrypt(
          JSON.stringify({
            settings: {
              ...settings,
              secret: decrypt(settings.secret, this.encryptionKey),
            },
            text,
          }),
          this.encryptionKey,
        ),
        resource,
        now,
      );
    await this.flush();
  }
  async close() {
    clearInterval(this.timer);
    await Promise.all(this.pending);
    await this.draining;
  }
}
