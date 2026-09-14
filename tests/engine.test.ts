import { test } from "node:test";
import assert from "node:assert/strict";
import { ffmpegArgs } from "../server/engine.ts";
import {
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
  redact,
} from "../server/security.ts";
import { fixture, seed, until } from "./helpers.ts";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

test("shutdown waits for an in-flight stop before database closure", async () => {
  const f = await fixture();
  try {
    const { stream, destination } = seed(f);
    f.store.save("streams", { ...stream, desired: "running" });
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      exitCode: null,
      kill() {
        setTimeout(() => child.emit("close", 0), 50);
        return true;
      },
    });
    f.engine.outputs.set(stream.id, [
      { destinationId: destination.id, state: "live", retries: 0, child },
    ]);
    const stopping = f.engine.stop(stream.id);
    assert.equal(
      f.engine.stop(stream.id),
      stopping,
      "Concurrent stops share one operation",
    );
    await f.engine.shutdown();
    assert.equal(f.store.get("streams", stream.id)!.desired, "stopped");
    await stopping;
  } finally {
    await f.cleanup();
  }
});

test("password hashing and authenticated encryption reject incorrect secrets", async () => {
  const hash = await hashPassword("correct-long-password");
  assert.notEqual(hash, "correct-long-password");
  assert.equal(await verifyPassword("wrong-password", hash), false);
  assert.equal(await verifyPassword("correct-long-password", hash), true);
  const key = "ab".repeat(32),
    secret = encrypt("stream-key", key);
  assert.equal(decrypt(secret, key), "stream-key");
  assert.throws(() => decrypt(secret, "cd".repeat(32)));
  assert.equal(
    redact("Failed rtmps://ingest/live/secret now"),
    "Failed [destination redacted] now",
  );
});

test("FFmpeg arguments are explicit, bounded encoding settings and one output URL", () => {
  const url = "rtmp://127.0.0.1/live/a;echo-not-shell";
  const args = ffmpegArgs(
    "playlist.txt",
    {
      id: "test",
      name: "720p",
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 2500,
      audioBitrate: 128,
    },
    url,
    true,
  );
  assert.equal(args.at(-1), url);
  assert.ok(args.includes("-stream_loop"));
  assert.ok(args.includes("scale=1280:720"));
  assert.equal(args[args.indexOf("-g") + 1], "60");
  const finite = ffmpegArgs(
    "playlist.txt",
    {
      id: "test",
      name: "720p",
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 2500,
      audioBitrate: 128,
    },
    url,
    false,
    3,
  );
  assert.equal(finite[finite.indexOf("-stream_loop") + 1], "2");
  const once = ffmpegArgs(
    "playlist.txt",
    {
      id: "test",
      name: "720p",
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 2500,
      audioBitrate: 128,
    },
    url,
    false,
    1,
  );
  assert.ok(!once.includes("-stream_loop"));
});

test("failed process enters bounded recovery; stop cancels retry and releases reservation", async () => {
  const f = await fixture();
  try {
    f.config.FFMPEG_PATH = "streamax-nonexistent-ffmpeg";
    const { stream } = seed(f);
    f.engine.start(stream.id);
    f.engine.start(stream.id); // idempotent
    await until(() => f.engine.status(stream.id)[0]?.state === "retrying");
    assert.equal(f.engine.status(stream.id)[0].retries, 1);
    const other = f.store.save("streams", {
      ...stream,
      id: undefined,
      name: "Other",
    });
    assert.throws(() => f.engine.start(other.id), /reserved/);
    await f.engine.stop(stream.id);
    await new Promise((r) => setTimeout(r, 2100));
    assert.deepEqual(f.engine.status(stream.id), []);
    assert.equal(f.store.get("streams", stream.id)!.desired, "stopped");
  } finally {
    await f.cleanup();
  }
});

test("system retry setting is applied to active worker failures", async () => {
  const f = await fixture();
  try {
    f.config.FFMPEG_PATH = "streamax-nonexistent-ffmpeg";
    const { stream } = seed(f);
    f.store.save("settings", {
      id: "system",
      name: "StreaMax",
      applicationName: "StreaMax",
      maintenanceMode: false,
      retryAttempts: 0,
    });
    f.engine.start(stream.id);
    await until(() => f.engine.status(stream.id)[0]?.state === "failed");
    assert.equal(f.engine.status(stream.id)[0].retries, 0);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE action='output.retry'",
        )
        .get()!.count,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("scheduler handles missed runs and ends running schedules before restart recovery", async () => {
  const f = await fixture();
  try {
    const { stream } = seed(f);
    const missed = f.store.save("schedules", {
      name: "Missed",
      streamId: stream.id,
      startAt: new Date(0).toISOString(),
      endAt: new Date(1000).toISOString(),
      state: "pending",
    });
    await f.engine.tick();
    assert.equal(f.store.get("schedules", missed.id)!.state, "missed");
    f.store.save("streams", { ...stream, desired: "running" });
    const running = f.store.save("schedules", {
      name: "Expired",
      streamId: stream.id,
      startAt: new Date(0).toISOString(),
      endAt: new Date(1000).toISOString(),
      state: "running",
    });
    await f.engine.boot();
    assert.equal(f.store.get("streams", stream.id)!.desired, "stopped");
    assert.equal(f.store.get("schedules", running.id)!.state, "completed");
    assert.deepEqual(f.engine.status(stream.id), []);
  } finally {
    await f.cleanup();
  }
});
