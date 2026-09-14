import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { pruneExpiredVideos } from "../server/retention.ts";
import { fixture } from "./helpers.ts";

test("video retention deletes only expired unreferenced media and audits it", () => {
  const directory = mkdtempSync(join(tmpdir(), "streamax-video-retention-"));
  const mediaDir = join(directory, "media");
  mkdirSync(mediaDir);
  const store = new Store(join(directory, "data"), "ab".repeat(32));
  try {
    const expired = store.save("videos", {
      id: randomUUID(),
      name: "expired.mp4",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const referenced = store.save("videos", {
      id: randomUUID(),
      name: "playlist.mp4",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const recent = store.save("videos", {
      id: randomUUID(),
      name: "recent.mp4",
      createdAt: "2026-01-19T00:00:00.000Z",
    });
    store.save("playlists", {
      id: randomUUID(),
      name: "Protected playlist",
      videoIds: [referenced.id],
    });
    for (const video of [expired, referenced, recent])
      writeFileSync(join(mediaDir, `${video.id}.mp4`), "test-media");

    const deleted = pruneExpiredVideos(
      store,
      mediaDir,
      7,
      Date.parse("2026-01-20T00:00:00.000Z"),
    );

    assert.deepEqual(deleted, [expired.id]);
    assert.equal(store.get("videos", expired.id), undefined);
    assert.ok(store.get("videos", referenced.id));
    assert.ok(store.get("videos", recent.id));
    assert.equal(existsSync(join(mediaDir, `${expired.id}.mp4`)), false);
    assert.equal(existsSync(join(mediaDir, `${referenced.id}.mp4`)), true);
    assert.equal(
      store
        .events()
        .some((event) => event.action === "video.retention_deleted"),
      true,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("zero-day video retention is disabled", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "streamax-video-retention-off-"),
  );
  const mediaDir = join(directory, "media");
  mkdirSync(mediaDir);
  const store = new Store(join(directory, "data"), "ab".repeat(32));
  try {
    const video = store.save("videos", {
      id: randomUUID(),
      name: "keep.mp4",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const path = join(mediaDir, `${video.id}.mp4`);
    writeFileSync(path, "test-media");
    assert.deepEqual(pruneExpiredVideos(store, mediaDir, 0), []);
    assert.ok(store.get("videos", video.id));
    assert.equal(existsSync(path), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worker tick runs the configured media retention policy", async () => {
  const f = await fixture();
  try {
    const video = f.store.save("videos", {
      id: randomUUID(),
      name: "old-upload.mp4",
      createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    });
    const path = join(f.config.DATA_DIR, "media", `${video.id}.mp4`);
    writeFileSync(path, "test-media");
    f.store.save("settings", {
      id: "system",
      name: "Test",
      videoRetentionDays: 1,
    });

    await f.engine.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(f.store.get("videos", video.id), undefined);
    assert.equal(existsSync(path), false);
  } finally {
    await f.cleanup();
  }
});
