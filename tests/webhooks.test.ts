import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { fixture, seed, until } from "./helpers.ts";
import { isPublicWebhookAddress } from "../server/webhooks.ts";
import { Store } from "../server/store.ts";
import { buildApp } from "../server/app.ts";

test("signed webhooks are encrypted, event-filtered and verifiable", async () => {
  const deliveries: Array<{
    url: URL;
    body: string;
    headers: Record<string, string>;
  }> = [];
  const f = await fixture({
    webhookRequest: async (url, body, headers) => {
      deliveries.push({ url, body, headers });
      return 204;
    },
  });
  try {
    const endpoint = "https://hooks.example.com/streamax/events";
    const secret = "test-secret-that-is-long-enough";
    const configured = await f.request("PUT", "webhooks", {
      endpoint,
      secret,
      enabled: true,
      events: ["stream.started", "schedule.started"],
    });
    assert.equal(configured.statusCode, 200);
    assert.equal(configured.json().endpointHost, "hooks.example.com");
    assert.ok(!configured.body.includes(endpoint));
    assert.ok(!configured.body.includes(secret));
    const saved = f.store.get("settings", "outbound-webhook")!;
    assert.ok(!JSON.stringify(saved).includes(endpoint));
    assert.ok(!JSON.stringify(saved).includes(secret));

    const testDelivery = await f.request("POST", "webhooks/test", {});
    assert.equal(testDelivery.statusCode, 200);
    const first = deliveries[0];
    assert.equal(first.headers["x-streamax-event"], "webhook.test");
    assert.equal(
      first.headers["x-streamax-delivery"],
      JSON.parse(first.body).id,
    );
    assert.match(
      first.headers["x-streamax-signature"],
      /^sha256=[a-f0-9]{64}$/,
    );
    const expected = createHmac("sha256", secret)
      .update(`${first.headers["x-streamax-timestamp"]}.${first.body}`)
      .digest("hex");
    assert.equal(first.headers["x-streamax-signature"], `sha256=${expected}`);

    const { stream } = seed(f);
    f.store.event("admin@example.com", "stream.start", stream.id, stream.name);
    await until(() => deliveries.length === 2);
    const started = deliveries[1];
    assert.equal(started.headers["x-streamax-event"], "stream.started");
    assert.equal(JSON.parse(started.body).resource.name, stream.name);

    const schedule = f.store.save("schedules", {
      name: "Evening schedule",
      streamId: stream.id,
    });
    f.store.event("scheduler", "schedule.started", schedule.id, schedule.name);
    await until(() => deliveries.length === 3);
    assert.equal(deliveries[2].headers["x-streamax-event"], "schedule.started");
    assert.equal(JSON.parse(deliveries[2].body).resource.id, schedule.id);
    f.store.event("admin", "stream.stop", stream.id);
    assert.equal(deliveries.length, 3);
    const updated = await f.request("PUT", "webhooks", {
      enabled: false,
      events: ["stream.started"],
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(
      f.store.get("settings", "outbound-webhook")!.secret,
      saved.secret,
    );
    f.store.event("admin", "stream.start", stream.id);
    assert.equal(deliveries.length, 3);
  } finally {
    await f.cleanup();
  }
});

test("webhook configuration rejects unsafe URLs and delivery retries are bounded", async () => {
  let attempts = 0;
  const f = await fixture({
    webhookRequest: async () => {
      attempts += 1;
      return 503;
    },
  });
  try {
    for (const endpoint of [
      "http://hooks.example.com/streamax",
      "https://user:pass@hooks.example.com/streamax",
      "https://hooks.example.com/streamax?token=secret",
    ]) {
      const invalid = await f.request("PUT", "webhooks", {
        endpoint,
        secret: "test-secret-that-is-long-enough",
        enabled: true,
        events: ["stream.started"],
      });
      assert.equal(invalid.statusCode, 400);
    }
    assert.equal(isPublicWebhookAddress("8.8.8.8"), true);
    assert.equal(isPublicWebhookAddress("127.0.0.1"), false);
    assert.equal(isPublicWebhookAddress("10.0.0.1"), false);
    assert.equal(isPublicWebhookAddress("::1"), false);
    assert.equal(isPublicWebhookAddress("fd12::1"), false);
    assert.equal(isPublicWebhookAddress("::ffff:127.0.0.1"), false);
    assert.equal(isPublicWebhookAddress("2002:7f00:1::1"), false);
    assert.equal(isPublicWebhookAddress("2001:4860:4860::8888"), true);

    assert.equal(
      (
        await f.request("PUT", "webhooks", {
          endpoint: "https://hooks.example.com/streamax",
          secret: "test-secret-that-is-long-enough",
          enabled: true,
          events: ["stream.started"],
        })
      ).statusCode,
      200,
    );
    const failed = await f.request("POST", "webhooks/test", {});
    assert.equal(failed.statusCode, 502);
    assert.equal(attempts, 3);
    assert.equal(
      f.store.events({ action: "webhook.delivery_failed" })[0].result,
      "failure",
    );
  } finally {
    await f.cleanup();
  }
});

test("webhooks require an administrator and corrupt credentials fail without an unhandled rejection", async () => {
  let calls = 0;
  const f = await fixture({
    webhookRequest: async () => {
      calls++;
      return 204;
    },
  });
  try {
    f.store.db
      .prepare("UPDATE users SET role='operator' WHERE email=?")
      .run(f.config.ADMIN_EMAIL);
    for (const [method, path] of [
      ["GET", "webhooks"],
      ["PUT", "webhooks"],
      ["POST", "webhooks/test"],
    ] as const)
      assert.equal(
        (await f.request(method, path, method === "GET" ? undefined : {}))
          .statusCode,
        403,
      );
    assert.equal(calls, 0);
    f.store.save("settings", {
      id: "outbound-webhook",
      enabled: true,
      events: ["stream.started"],
      secret: "corrupt",
      endpoint: "corrupt",
    });
    f.store.event("worker", "stream.start", "stream-1");
    await until(
      () => f.store.events({ action: "webhook.delivery_failed" }).length === 1,
    );
    assert.equal(calls, 0);
  } finally {
    await f.cleanup();
  }
});

test("production webhook transport rejects loopback before opening a socket", async () => {
  let connections = 0;
  const listener = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const f = await fixture();
  try {
    await f.request("PUT", "webhooks", {
      endpoint: `https://127.0.0.1:${address.port}/events`,
      secret: "test-secret-that-is-long-enough",
      enabled: true,
      events: [],
    });
    assert.equal(
      (await f.request("POST", "webhooks/test", {})).statusCode,
      502,
    );
    assert.equal(connections, 0);
  } finally {
    await f.cleanup();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("pending encrypted webhook delivery resumes after reopening the application", async () => {
  let snapshot: any;
  const f = await fixture({
    webhookRequest: async () => {
      snapshot = f.store.db
        .prepare("SELECT * FROM webhook_deliveries WHERE state='pending'")
        .get();
      return 204;
    },
  });
  let restarted: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await f.request("PUT", "webhooks", {
      endpoint: "https://hooks.example.com/events",
      secret: "test-secret-that-is-long-enough",
      enabled: true,
      events: ["stream.started"],
    });
    assert.equal(
      (await f.request("POST", "webhooks/test", {})).statusCode,
      200,
    );
    assert.ok(snapshot?.payload);
    assert.ok(!snapshot.payload.includes("hooks.example.com"));
    await f.app.close();
    // Restore the persisted state of an interrupted first attempt.
    const store = new Store(f.directory, f.config.ENCRYPTION_KEY);
    store.db
      .prepare(
        "UPDATE webhook_deliveries SET state='pending',payload=?,attempts=1,next_attempt_at=0 WHERE id=?",
      )
      .run(snapshot.payload, snapshot.id);
    store.close();
    const recovered: Array<{ body: string; headers: Record<string, string> }> =
      [];
    restarted = await buildApp(f.config, {
      startEngine: false,
      webhookRequest: async (_url, body, headers) => {
        recovered.push({ body, headers });
        return 204;
      },
    });
    await until(() => recovered.length === 1);
    assert.equal(recovered[0].headers["x-streamax-delivery"], snapshot.id);
    assert.equal(JSON.parse(recovered[0].body).id, snapshot.id);
    const result = restarted.store.db
      .prepare(
        "SELECT state,attempts,payload FROM webhook_deliveries WHERE id=?",
      )
      .get(snapshot.id) as any;
    assert.equal(result.state, "delivered");
    assert.equal(result.attempts, 2);
    assert.equal(result.payload, "");
  } finally {
    await restarted?.app.close();
    await f.cleanup();
  }
});
