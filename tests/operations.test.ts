import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, seed, until } from "./helpers.ts";
import { scheduleOccurrences } from "../server/recurrence.ts";
import { playbackPosition } from "../server/playback.ts";
import { Notifications } from "../server/notifications.ts";
import { ThresholdMonitor } from "../server/thresholds.ts";
import { configuration } from "../server/config.ts";
import { startupError } from "../server/diagnostics.ts";
import { diagnostics } from "../server/diagnostics.ts";
import { createServer } from "node:net";
import { once } from "node:events";

test("recurrence follows local clock across DST and rejects missing wall times", () => {
  const dates = scheduleOccurrences(
    "2026-03-07T17:00:00Z",
    "2026-03-07T18:00:00Z",
    "daily",
    3,
    "America/New_York",
  );
  assert.equal(dates[1].startAt, "2026-03-08T16:00:00.000Z");
  assert.throws(
    () =>
      scheduleOccurrences(
        "2026-03-07T07:30:00Z",
        "2026-03-07T08:30:00Z",
        "daily",
        3,
        "America/New_York",
      ),
    /does not exist/,
  );
});
test("recurring reservations are atomic, protect override playlists and reject later collisions", async () => {
  const f = await fixture();
  try {
    const { stream, playlist, video } = seed(f);
    const override = f.store.save("playlists", {
      name: "Morning",
      videoIds: [video.id],
    });
    const start = Date.now() + 3600000;
    const body = {
      name: "Daily",
      streamId: stream.id,
      playlistId: override.id,
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + 600000).toISOString(),
      recurrence: "daily",
      occurrences: 3,
    };
    assert.equal((await f.request("POST", "schedules", body)).statusCode, 200);
    assert.equal(f.store.list("schedules").length, 3);
    assert.equal(
      (
        await f.request("PUT", `playlists/${override.id}`, {
          name: "Edit",
          videoIds: [video.id],
        })
      ).statusCode,
      409,
    );
    const count = f.store.list("schedules").length;
    const conflicting = {
      ...body,
      startAt: new Date(start - 86400000 + 1800000).toISOString(),
      endAt: new Date(start + 1000).toISOString(),
    };
    // A series with an internal overlap must roll back its first occurrence too.
    const internal = {
      ...body,
      startAt: new Date(start + 86400000 * 10).toISOString(),
      endAt: new Date(start + 86400000 * 12).toISOString(),
    };
    assert.equal(
      (await f.request("POST", "schedules", internal)).statusCode,
      409,
    );
    assert.equal(f.store.list("schedules").length, count);
    assert.equal(f.store.get("streams", stream.id)!.playlistId, playlist.id);
  } finally {
    await f.cleanup();
  }
});
test("Now Playing preserves fixed-count boundaries and next video", () => {
  const videos = [
    { id: "a", name: "A", duration: 10 },
    { id: "b", name: "B", duration: 20 },
  ];
  assert.equal(playbackPosition(videos, 15, true)!.videoId, "b");
  assert.equal(playbackPosition(videos, 35, true)!.play, 2);
  assert.equal(playbackPosition(videos, 35, true)!.videoSeconds, 5);
  assert.equal(playbackPosition(videos, 30, false)!.nextVideoId, null);
  assert.equal(playbackPosition([videos[0]], 30, false, 3)!.completed, true);
});
test("recovery loads per-destination checkpoints while manual start resets them", async () => {
  const f = await fixture();
  try {
    f.config.FFMPEG_PATH = "streamax-missing-ffmpeg";
    const { stream, destination } = seed(f);
    f.store.save("streams", {
      ...stream,
      desired: "running",
      checkpoints: { [destination.id]: 17 },
    });
    f.engine.start(stream.id);
    await until(() => f.engine.status(stream.id)[0]?.state === "retrying");
    assert.equal(f.engine.status(stream.id)[0].nowPlaying!.elapsedSeconds, 17);
    assert.equal(f.engine.status(stream.id)[0].platformVerified, false);
    await f.engine.stop(stream.id);
    f.engine.start(stream.id);
    assert.equal(f.engine.status(stream.id)[0].nowPlaying!.elapsedSeconds, 0);
  } finally {
    await f.cleanup();
  }
});
test("resumable upload checks owner, offsets, size and incomplete completion", async () => {
  const f = await fixture();
  try {
    const created = await f.request("POST", "uploads", {
      name: "large.mp4",
      size: 6,
      fingerprint: "a".repeat(64),
    });
    assert.equal(created.statusCode, 201);
    const { id } = created.json();
    const chunk = (offset: number, bytes: string) =>
      f.app.inject({
        method: "PATCH",
        url: `/api/uploads/${id}`,
        headers: {
          ...f.headers,
          "content-type": "application/octet-stream",
          "upload-offset": String(offset),
        },
        payload: Buffer.from(bytes),
      });
    assert.equal((await chunk(0, "abc")).statusCode, 200);
    assert.equal((await chunk(0, "abc")).statusCode, 409);
    assert.equal((await f.request("GET", "uploads")).json()[0].offset, 3);
    assert.equal(
      (await f.request("POST", `uploads/${id}/complete`, {})).statusCode,
      409,
    );
    assert.equal((await chunk(3, "defg")).statusCode, 400);
    f.store.db
      .prepare("UPDATE uploads SET owner='someone-else' WHERE id=?")
      .run(id);
    assert.equal((await chunk(3, "def")).statusCode, 404);
    f.store.db.prepare("UPDATE uploads SET expires=0 WHERE id=?").run(id);
    await f.request("GET", "uploads");
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM uploads").get()!.n,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
test("durable notification retries survive notifier recreation and preserve audit integrity", async () => {
  const f = await fixture();
  try {
    const notifier = new Notifications(
      f.store,
      f.config.ENCRYPTION_KEY,
      async () => new Response(null, { status: 503 }),
    );
    notifier.save({
      provider: "telegram",
      target: "12345",
      secret: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      enabled: true,
      events: ["stream.started"],
    });
    await notifier.notify("stream.start", "worker", "stream", "test");
    assert.equal(
      f.store.db.prepare("SELECT attempts FROM notification_queue").get()!
        .attempts,
      1,
    );
    assert.equal(f.store.auditIntegrity().valid, true);
    let delivered = 0;
    const recovered = new Notifications(
      f.store,
      f.config.ENCRYPTION_KEY,
      async () => {
        delivered++;
        return new Response(JSON.stringify({ ok: true }));
      },
    );
    await recovered.flush(Date.now() + 60000);
    assert.equal(delivered, 1);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM notification_queue").get()!
        .n,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
test("threshold alerts fire once per crossing and rearm below hysteresis", async () => {
  const f = await fixture();
  try {
    f.store.save("settings", {
      id: "system",
      name: "Settings",
      thresholdAlerts: true,
      cpuThreshold: 90,
      diskThreshold: 85,
    });
    const monitor = new ThresholdMonitor(f.store, f.directory);
    monitor.evaluate(95, 60);
    monitor.evaluate(99, 60);
    monitor.evaluate(87, 60);
    monitor.evaluate(95, 60);
    assert.equal(
      f.store.events().filter((event) => event.action === "system.threshold")
        .length,
      1,
    );
    monitor.evaluate(80, 60);
    monitor.evaluate(95, 60);
    assert.equal(
      f.store.events().filter((event) => event.action === "system.threshold")
        .length,
      2,
    );
  } finally {
    await f.cleanup();
  }
});
test("configuration errors identify fields without exposing supplied secrets", () => {
  try {
    configuration({ ADMIN_PASSWORD: "private" });
    assert.fail();
  } catch (error) {
    const message = startupError(error);
    assert.match(message, /ADMIN_PASSWORD/);
    assert.ok(!message.includes("private"));
  }
  assert.match(startupError({ code: "EADDRINUSE" }), /PORT/);
});

test("startup diagnostics detect an occupied API port before server startup", async () => {
  const f = await fixture();
  const server = createServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    f.config.HOST = "127.0.0.1";
    f.config.PORT = (server.address() as { port: number }).port;
    const checks = await diagnostics(f.config);
    assert.equal(checks.find((check) => check.name === "API port")?.ok, false);
    assert.match(
      checks.find((check) => check.name === "API port")!.message,
      /already accepts connections/,
    );
    assert.ok(checks.find((check) => check.name === "FFmpeg")?.ok);
  } finally {
    server.close();
    await f.cleanup();
  }
});
