import { lookup } from "node:dns/promises";
import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { decrypt, encrypt } from "./security.ts";
import type { Store } from "./store.ts";

export const webhookEvents = [
  "stream.started",
  "stream.stopped",
  "stream.failed",
  "schedule.started",
  "schedule.failed",
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];
type Address = { address: string; family: number };
export type WebhookRequest = (
  url: URL,
  body: string,
  headers: Record<string, string>,
) => Promise<number>;

function ipv4Number(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255))
    return -1;
  return parts.reduce((value, part) => value * 256 + part, 0);
}

export function isPublicWebhookAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const denied: Array<[number, number]> = [
      [0x00000000, 0x00ffffff], // Current network
      [0x0a000000, 0x0affffff], // Private
      [0x64400000, 0x647fffff], // Carrier-grade NAT
      [0x7f000000, 0x7fffffff], // Loopback
      [0xa9fe0000, 0xa9feffff], // Link-local
      [0xac100000, 0xac1fffff], // Private
      [0xc0000000, 0xc00000ff], // IETF protocol assignments
      [0xc0000200, 0xc00002ff], // Documentation
      [0xc0586300, 0xc05863ff], // 6to4 relay anycast
      [0xc0a80000, 0xc0a8ffff], // Private
      [0xc6120000, 0xc613ffff], // Benchmarking
      [0xc6336400, 0xc63364ff], // Documentation
      [0xcb007100, 0xcb0071ff], // Documentation
      [0xe0000000, 0xffffffff], // Multicast and reserved
    ];
    return (
      value >= 0 &&
      !denied.some(([start, end]) => value >= start && value <= end)
    );
  }
  if (family !== 6 || address.includes("%")) return false;
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const v4 = ipv4Number(normalized.slice(lastColon + 1));
    if (v4 < 0) return false;
    normalized = `${normalized.slice(0, lastColon)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return false;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
  if (
    words.length !== 8 ||
    words.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)
  )
    return false;
  if (words.slice(0, 5).every((part) => part === 0) && words[5] === 0xffff) {
    const embedded = `${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`;
    return isPublicWebhookAddress(embedded);
  }
  const globalUnicast = (words[0] & 0xe000) === 0x2000;
  const documentation = words[0] === 0x2001 && words[1] === 0x0db8;
  const special = words[0] === 0x2001 && words[1] < 0x0200;
  const transition = words[0] === 0x2002;
  const documentationRange = words[0] === 0x3fff && words[1] < 0x1000;
  return (
    globalUnicast &&
    !documentation &&
    !special &&
    !transition &&
    !documentationRange
  );
}

async function requestPublicHttps(
  url: URL,
  body: string,
  headers: Record<string, string>,
) {
  canonicalEndpoint(url.toString());
  const signal = AbortSignal.timeout(5000);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await new Promise<Address[]>((resolve, reject) => {
        const abort = () => reject(new Error("Webhook DNS lookup timed out"));
        signal.addEventListener("abort", abort, { once: true });
        lookup(hostname, { all: true, verbatim: true })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicWebhookAddress(item.address))
  )
    throw new Error("Webhook host resolves to a non-public address");
  const destination = addresses[0];
  return new Promise<number>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname,
        port: Number(url.port || 443),
        path: url.pathname,
        method: "POST",
        headers,
        servername: family ? undefined : hostname,
        rejectUnauthorized: true,
        agent: false,
        signal,
        family: destination.family,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [destination]);
          else callback(null, destination.address, destination.family);
        },
      },
      (response) => {
        const status = response.statusCode || 500;
        response.destroy();
        resolve(status);
      },
    );
    request.setTimeout(5000, () =>
      request.destroy(new Error("Webhook request timed out")),
    );
    request.once("error", reject);
    request.end(body);
  });
}

function canonicalEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Webhook endpoint must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\s'"\\]/.test(value)
  )
    throw new Error(
      "Webhook endpoint must use HTTPS without credentials or query parameters",
    );
  return url.toString();
}

export class Webhooks {
  private pending = new Set<Promise<boolean>>();
  private active = new Map<string, Promise<boolean>>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private executing = 0;

  constructor(
    private store: Store,
    private encryptionKey: string,
    private request: WebhookRequest = requestPublicHttps,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, resource TEXT NOT NULL,
      event TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
    ); CREATE INDEX IF NOT EXISTS webhook_deliveries_pending
      ON webhook_deliveries(state, next_attempt_at);`);
    this.timer = setInterval(() => this.resume(), 1000);
    this.timer.unref();
  }

  private resume() {
    if (this.closed) return;
    const rows = this.store.db
      .prepare(
        "SELECT id FROM webhook_deliveries WHERE state='pending' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 10",
      )
      .all(Date.now()) as Array<{ id: string }>;
    for (const row of rows) {
      if (this.active.size >= 10) break;
      void this.process(row.id).catch(() => {});
    }
  }

  get() {
    const saved = this.store.get("settings", "outbound-webhook");
    let endpointHost = "";
    if (saved?.endpoint) {
      try {
        endpointHost = new URL(decrypt(saved.endpoint, this.encryptionKey))
          .host;
      } catch {
        endpointHost = "Configured endpoint";
      }
    }
    return {
      configured: Boolean(saved?.endpoint && saved?.secret),
      endpointHost,
      enabled: Boolean(saved?.enabled),
      events: saved?.events || [],
    };
  }

  save(input: {
    endpoint?: string;
    secret?: string;
    enabled: boolean;
    events: WebhookEvent[];
  }) {
    const previous = this.store.get("settings", "outbound-webhook");
    if (!input.endpoint && !previous?.endpoint)
      throw new Error("Webhook endpoint is required");
    if (!input.secret && !previous?.secret)
      throw new Error("Webhook signing secret is required");
    if (input.secret && (input.secret.length < 16 || input.secret.length > 256))
      throw new Error("Webhook signing secret must be 16–256 characters");
    const endpoint = input.endpoint
      ? canonicalEndpoint(input.endpoint)
      : decrypt(previous!.endpoint, this.encryptionKey);
    const secret =
      input.secret || decrypt(previous!.secret, this.encryptionKey);
    this.store.save("settings", {
      id: "outbound-webhook",
      name: "Signed outbound webhook",
      endpoint: input.endpoint
        ? encrypt(endpoint, this.encryptionKey)
        : previous!.endpoint,
      secret: input.secret
        ? encrypt(secret, this.encryptionKey)
        : previous!.secret,
      enabled: input.enabled,
      events: [...new Set(input.events)],
    });
    return this.get();
  }

  async notify(
    action: string,
    actor: string,
    resource: string,
    details: string,
  ) {
    const event: WebhookEvent | undefined =
      action === "stream.start"
        ? "stream.started"
        : action === "schedule.started"
          ? "schedule.started"
          : action === "stream.stop"
            ? "stream.stopped"
            : ["output.failed", "stream.recovery_failed"].includes(action)
              ? "stream.failed"
              : action === "schedule.failed"
                ? "schedule.failed"
                : undefined;
    if (!event) return;
    const saved = this.store.get("settings", "outbound-webhook");
    if (!saved?.enabled || !saved.events?.includes(event)) return;
    const task = this.deliver(saved, event, actor, resource, details);
    this.pending.add(task);
    try {
      await task;
    } finally {
      this.pending.delete(task);
    }
  }

  private async deliver(
    saved: Record<string, any>,
    event: WebhookEvent | "webhook.test",
    actor: string,
    resource: string,
    details: string,
  ) {
    try {
      return await this.send(saved, event, actor, resource, details);
    } catch {
      // Corrupt encrypted configuration must not reject an event callback.
    }
    this.store.event(
      "webhook",
      "webhook.delivery_failed",
      resource,
      "Signed webhook delivery failed; check configuration and receiver availability",
      "",
      "failure",
      { event },
    );
    return false;
  }

  private async send(
    saved: Record<string, any>,
    event: WebhookEvent | "webhook.test",
    actor: string,
    resource: string,
    details: string,
  ) {
    const stream = this.store.get("streams", resource);
    const schedule = this.store.get("schedules", resource);
    const body = JSON.stringify({
      schema_version: 1,
      id: randomUUID(),
      event,
      occurred_at: new Date().toISOString(),
      actor,
      resource: {
        id: resource,
        name: stream?.name || schedule?.name || resource,
      },
      details: details.slice(0, 500),
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac(
      "sha256",
      decrypt(saved.secret, this.encryptionKey),
    )
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const headers = {
      "content-type": "application/json",
      "user-agent": "StreaMax-Webhooks/1.0",
      "x-streamax-event": event,
      "x-streamax-delivery": JSON.parse(body).id as string,
      "x-streamax-timestamp": timestamp,
      "x-streamax-signature": `sha256=${signature}`,
    };
    const url = new URL(
      canonicalEndpoint(decrypt(saved.endpoint, this.encryptionKey)),
    );
    const count = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE state='pending'",
      )
      .get() as { count: number };
    if (count.count >= 1000) throw new Error("Webhook queue is full");
    const id = headers["x-streamax-delivery"];
    this.store.db
      .prepare(
        "INSERT INTO webhook_deliveries(id,payload,resource,event,next_attempt_at) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        encrypt(
          JSON.stringify({
            url: url.toString(),
            body,
            headers,
            secret: decrypt(saved.secret, this.encryptionKey),
          }),
          this.encryptionKey,
        ),
        resource,
        event,
        Date.now(),
      );
    return this.process(id);
  }

  private process(id: string): Promise<boolean> {
    const existing = this.active.get(id);
    if (existing) return existing;
    const task = this.attempt(id).finally(() => this.active.delete(id));
    this.active.set(id, task);
    return task;
  }

  private async attempt(id: string) {
    while (this.executing >= 10 && !this.closed)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (this.closed) return false;
    this.executing++;
    try {
      return await this.perform(id);
    } finally {
      this.executing--;
    }
  }

  private async perform(id: string) {
    const row = this.store.db
      .prepare(
        "SELECT * FROM webhook_deliveries WHERE id=? AND state='pending'",
      )
      .get(id) as
      | {
          payload: string;
          resource: string;
          event: string;
          attempts: number;
          next_attempt_at: number;
        }
      | undefined;
    if (!row) return true;
    let delivered = false;
    try {
      const envelope = JSON.parse(decrypt(row.payload, this.encryptionKey)) as {
        url: string;
        body: string;
        headers: Record<string, string>;
        secret: string;
      };
      const url = new URL(canonicalEndpoint(envelope.url));
      for (let attempt = row.attempts; attempt < 3; attempt++) {
        if (this.closed) return false;
        if (row.next_attempt_at > Date.now())
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(row.next_attempt_at - Date.now(), 1500),
            ),
          );
        if (this.closed) return false;
        this.store.db
          .prepare("UPDATE webhook_deliveries SET attempts=? WHERE id=?")
          .run(attempt + 1, id);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const headers = {
          ...envelope.headers,
          "x-streamax-timestamp": timestamp,
          "x-streamax-signature": `sha256=${createHmac("sha256", envelope.secret).update(`${timestamp}.${envelope.body}`).digest("hex")}`,
        };
        try {
          const status = await this.request(url, envelope.body, headers);
          if (status >= 200 && status < 300) {
            delivered = true;
            break;
          }
        } catch {
          /* Receiver/network diagnostics may contain credentials. */
        }
        row.next_attempt_at = Date.now() + (attempt + 1) * 500;
        this.store.db
          .prepare("UPDATE webhook_deliveries SET next_attempt_at=? WHERE id=?")
          .run(row.next_attempt_at, id);
      }
    } catch {
      /* Corrupt queued envelopes fail closed and are audited. */
    }
    this.store.db
      .prepare("UPDATE webhook_deliveries SET state=?, payload='' WHERE id=?")
      .run(delivered ? "delivered" : "failed", id);
    this.store.event(
      "webhook",
      delivered ? "webhook.delivered" : "webhook.delivery_failed",
      row.resource,
      delivered
        ? "Signed webhook delivered"
        : "Signed webhook delivery failed after bounded attempts",
      "",
      delivered ? "success" : "failure",
      { event: row.event, deliveryId: id },
    );
    this.store.db.exec(
      "DELETE FROM webhook_deliveries WHERE state!='pending' AND rowid NOT IN (SELECT rowid FROM webhook_deliveries WHERE state!='pending' ORDER BY rowid DESC LIMIT 1000)",
    );
    return delivered;
  }

  async test() {
    const saved = this.store.get("settings", "outbound-webhook");
    if (!saved?.endpoint || !saved?.secret)
      throw new Error("Configure the signed webhook first");
    const delivered = await this.deliver(
      saved,
      "webhook.test",
      "admin",
      "test",
      "Manual delivery test; no stream or schedule changed.",
    );
    if (!delivered) throw new Error("Signed webhook test delivery failed");
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all(this.pending);
    await Promise.all(this.active.values());
  }
}
