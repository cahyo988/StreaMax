import { test } from "node:test";
import assert from "node:assert/strict";
import { Notifications, alertEvents } from "../server/notifications.ts";
import { encrypt } from "../server/security.ts";
import { fixture, seed } from "./helpers.ts";

const secret = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
const webhook = `https://discord.com/api/webhooks/123456789012345678/${"x".repeat(40)}`;

test("notification settings mask encrypted secrets and validate official endpoints", async () => {
  const f = await fixture();
  try {
    const notifier = new Notifications(
      f.store,
      f.config.ENCRYPTION_KEY,
      async () => new Response(null, { status: 204 }),
    );
    assert.throws(
      () =>
        notifier.save({
          provider: "discord",
          target: "",
          secret: "https://127.0.0.1/admin",
          enabled: true,
          events: [],
        }),
      /Discord webhook URL is invalid/,
    );
    assert.throws(
      () =>
        notifier.save({
          provider: "telegram",
          target: "",
          secret,
          enabled: true,
          events: [],
        }),
      /Telegram bot token or chat ID is invalid/,
    );
    const result = notifier.save({
      provider: "discord",
      target: "",
      secret: webhook,
      enabled: true,
      events: [...alertEvents],
    });
    assert.deepEqual(result, {
      configured: true,
      enabled: true,
      provider: "discord",
      target: "Discord webhook",
      events: [...alertEvents],
    });
    assert.ok(!JSON.stringify(result).includes(webhook));
    assert.notEqual(f.store.get("notifications", "primary")!.secret, webhook);
    await notifier.test();
  } finally {
    await f.cleanup();
  }
});

test("Telegram delivery uses the fixed HTTPS API; events redact keys and failed sends stay generic", async () => {
  const f = await fixture();
  try {
    const { stream } = seed(f);
    const sent: Array<{ url: string; body: any }> = [];
    let fails = false;
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return fails
        ? new Response(
            JSON.stringify({
              ok: false,
              description: "secret and private diagnostic",
            }),
            { status: 401 },
          )
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const notifier = new Notifications(
      f.store,
      f.config.ENCRYPTION_KEY,
      fetcher as typeof fetch,
    );
    notifier.save({
      provider: "telegram",
      target: "@streamax_test",
      secret,
      enabled: true,
      events: ["stream.started"],
    });
    assert.equal(notifier.get().target, "@streamax_test");
    assert.ok(!JSON.stringify(notifier.get()).includes(secret));
    await notifier.notify("stream.start", "admin", stream.id, "output opened");
    assert.equal(
      sent[0].url,
      `https://api.telegram.org/bot${secret}/sendMessage`,
    );
    assert.match(sent[0].body.text, /Resource: Stream/);
    assert.deepEqual(
      f.store.events().filter((e: any) => e.action === "notification.failed"),
      [],
    );
    fails = true;
    await notifier.notify(
      "stream.start",
      "admin",
      stream.id,
      "a diagnostic containing rtmps://server/live/super-secret",
    );
    const failure = f.store
      .events()
      .find((e: any) => e.action === "notification.failed")!;
    assert.equal(
      failure.message,
      "Delivery failed; check notification settings and server connectivity.",
    );
    assert.equal(failure.result, "failure");
    assert.ok(!JSON.stringify(f.store.events()).includes("super-secret"));
    assert.throws(
      () =>
        notifier.save({
          provider: "discord",
          target: "",
          enabled: true,
          events: [],
        }),
      /new credential/,
    );
  } finally {
    await f.cleanup();
  }
});

test("automatic notifications honor selected event rules and throttle repeated retries", async () => {
  const f = await fixture();
  try {
    const { stream } = seed(f);
    let sends = 0;
    const notifier = new Notifications(
      f.store,
      f.config.ENCRYPTION_KEY,
      async () => {
        sends++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    notifier.save({
      provider: "telegram",
      target: "12345",
      secret,
      enabled: true,
      events: ["output.retrying"],
    });
    await notifier.notify("stream.start", "worker", stream.id, "");
    await notifier.notify("output.retry", "worker", stream.id, "one");
    await notifier.notify("output.retry", "worker", stream.id, "two");
    assert.equal(sends, 1);
    notifier.save({
      provider: "telegram",
      target: "12345",
      enabled: false,
      events: ["stream.started"],
    });
    await notifier.notify("stream.start", "worker", stream.id, "");
    assert.equal(sends, 1);
  } finally {
    await f.cleanup();
  }
});

test("notification API is admin-only and exposes no stored credential", async () => {
  const f = await fixture();
  try {
    const { video, playlist, profile, destination } = seed(f);
    const response = await f.request("PUT", "notifications", {
      provider: "telegram",
      target: "12345",
      secret,
      enabled: true,
      events: ["stream.started"],
    });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes(secret));
    assert.ok(
      !JSON.stringify(f.store.get("notifications", "primary")).includes(secret),
    );
    assert.equal(
      (await f.request("POST", "notifications/test", {})).statusCode,
      200,
    );
    const login = await f.app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: f.config.APP_ORIGIN },
      payload: {
        email: f.config.ADMIN_EMAIL,
        password: f.config.ADMIN_PASSWORD,
      },
    });
    const headers = {
      origin: f.config.APP_ORIGIN,
      cookie: `session=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrf,
    };
    const user = f.store.db.prepare("SELECT id FROM users LIMIT 1").get() as {
      id: string;
    };
    f.store.db
      .prepare("INSERT INTO users(id,email,password,role) VALUES(?,?,?,?)")
      .run(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "viewer@example.com",
        f.store.db
          .prepare("SELECT password FROM users WHERE id=?")
          .get(user.id)!.password,
        "viewer",
      );
    const viewerLogin = await f.app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: f.config.APP_ORIGIN },
      payload: {
        email: "viewer@example.com",
        password: f.config.ADMIN_PASSWORD,
      },
    });
    const viewerHeaders = {
      origin: f.config.APP_ORIGIN,
      cookie: `session=${viewerLogin.cookies[0].value}`,
      "x-csrf-token": viewerLogin.json().csrf,
    };
    assert.equal(
      (
        await f.app.inject({
          method: "PUT",
          url: "/api/notifications",
          headers: viewerHeaders,
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.deepEqual(
      [video.id, playlist.id, profile.id, destination.id].length,
      4,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/notifications/test",
          headers: viewerHeaders,
          payload: {},
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.cleanup();
  }
});

test("Discord never follows redirects or forwards mentions", async () => {
  const f = await fixture();
  try {
    const { stream } = seed(f);
    let options: RequestInit | undefined;
    const notifier = new Notifications(
      f.store,
      f.config.ENCRYPTION_KEY,
      async (_url, init) => {
        options = init;
        return new Response("{}", { status: 200 });
      },
    );
    notifier.save({
      provider: "discord",
      target: "",
      secret: webhook,
      enabled: true,
      events: ["stream.started"],
    });
    await notifier.notify(
      "stream.start",
      "operator",
      stream.id,
      "hello @everyone",
    );
    assert.equal(options?.redirect, "error");
    assert.deepEqual(JSON.parse(String(options?.body)).allowed_mentions, {
      parse: [],
    });
  } finally {
    await f.cleanup();
  }
});
