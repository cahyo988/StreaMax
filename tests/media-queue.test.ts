import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.ts";
import { join } from "node:path";
import { MediaQueue } from "../server/media-queue.ts";
import {
  inspectMedia,
  needsTranscode,
  normalize,
  run,
} from "../server/media.ts";
import { fixture, until } from "./helpers.ts";

async function silentVideo(f: Awaited<ReturnType<typeof fixture>>) {
  const source = join(f.directory, "sample-source.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    source,
  ]);
  return readFile(source);
}
function directUpload(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes: Buffer,
  name = "sample.mp4",
) {
  const boundary = "direct-pipeline";
  return f.app.inject({
    method: "POST",
    url: "/api/videos",
    headers: {
      ...f.headers,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: video/mp4\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

test(
  "three uploads run FIFO; failed middle job cleans files and does not block the next",
  { timeout: 30000 },
  async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    let active = 0,
      maxActive = 0;
    const f = await fixture({
      mediaNormalizer: async (config, input, id, inspection, signal) => {
        started.push(id);
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (started.length === 1) await gate;
          if (started.length === 2) {
            await writeFile(
              join(config.DATA_DIR, "media", `${id}.mp4`),
              "partial output",
            );
            throw new Error("Simulated encoder failure");
          }
          return await normalize(config, input, id, inspection, signal);
        } finally {
          active--;
        }
      },
    });
    try {
      const bytes = await silentVideo(f);
      const responses = [];
      for (const name of ["a.mp4", "b.mp4", "c.mp4"]) {
        const response = await directUpload(f, bytes, name);
        assert.equal(response.statusCode, 201, response.body);
        responses.push(response.json());
      }
      const [a, b, c] = responses;
      const listed = (await f.request("GET", "videos")).json();
      assert.equal(listed.find((v: any) => v.id === a.id).status, "processing");
      assert.equal(listed.find((v: any) => v.id === b.id).status, "queued");
      assert.equal(listed.find((v: any) => v.id === c.id).status, "queued");
      assert.deepEqual(started, [a.id]);
      release();
      await until(() => f.store.get("videos", c.id)?.status === "ready", 20000);
      assert.deepEqual(started, [a.id, b.id, c.id]);
      assert.equal(maxActive, 1);
      assert.equal(f.store.get("videos", b.id)?.status, "failed");
      await assert.rejects(access(join(f.directory, "media", `${b.id}.mp4`)));
      await assert.rejects(
        access(join(f.directory, "uploads", `${b.id}.upload`)),
      );
      const failedEvents = f.store.db
        .prepare(
          "SELECT resource FROM events WHERE action='video.processing.failed'",
        )
        .all();
      assert.equal(failedEvents[0].resource, b.id);
    } finally {
      release();
      await f.cleanup();
    }
  },
);

test("upload size limits reject oversized multipart, session and chunk data", async () => {
  const f = await fixture();
  try {
    const oversized = Buffer.alloc(f.config.MAX_UPLOAD_MB * 1024 * 1024 + 1);
    assert.equal((await directUpload(f, oversized)).statusCode, 413);
    assert.equal(
      (
        await f.request("POST", "uploads", {
          name: "huge.mp4",
          size: oversized.length,
          fingerprint: "e".repeat(64),
        })
      ).statusCode,
      400,
    );
    const session = await f.request("POST", "uploads", {
      name: "small.mp4",
      size: 1,
      fingerprint: "f".repeat(64),
    });
    const chunk = await f.app.inject({
      method: "PATCH",
      url: `/api/uploads/${session.json().id}`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "upload-offset": "0",
      },
      payload: Buffer.alloc(1024 * 1024 + 1),
    });
    assert.equal(chunk.statusCode, 413);
    assert.equal(f.store.list("videos").length, 0);
    assert.ok(
      (await readdir(join(f.directory, "uploads"))).every((p) =>
        p.endsWith(".part"),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("disk checks reject direct uploads, session creation and completion without consuming resumable data", async () => {
  let free = 0;
  const f = await fixture({ availableDiskBytes: async () => free });
  try {
    assert.equal((await directUpload(f, Buffer.from("small"))).statusCode, 507);
    assert.equal(
      (
        await f.request("POST", "uploads", {
          name: "small.mp4",
          size: 1,
          fingerprint: "d".repeat(64),
        })
      ).statusCode,
      507,
    );
    assert.deepEqual((await f.request("GET", "uploads")).json(), []);
    free = 1e12;
    const bytes = await silentVideo(f);
    const session = await f.request("POST", "uploads", {
      name: "small.mp4",
      size: bytes.length,
      fingerprint: "d".repeat(64),
    });
    const id = session.json().id;
    await f.app.inject({
      method: "PATCH",
      url: `/api/uploads/${id}`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "upload-offset": "0",
      },
      payload: bytes,
    });
    free = 0;
    assert.equal(
      (await f.request("POST", `uploads/${id}/complete`)).statusCode,
      507,
    );
    assert.equal(
      (await f.request("GET", "uploads")).json()[0].offset,
      bytes.length,
    );
    assert.equal(f.store.list("videos").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("legacy video status defaults to ready without mutating persisted JSON", async () => {
  const f = await fixture();
  try {
    const video = f.store.save("videos", {
      name: "Legacy",
      path: "/private/path.mp4",
    });
    const response = (await f.request("GET", "videos")).json()[0];
    assert.equal(response.status, "ready");
    assert.equal(response.path, undefined);
    assert.equal(f.store.get("videos", video.id)?.status, undefined);
  } finally {
    await f.cleanup();
  }
});

test("media queue is FIFO, survives a failed job and waits for cancellation cleanup", async () => {
  const queue = new MediaQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue(async () => {
    order.push("a");
    await gate;
    throw new Error("bad input");
  });
  const failure = assert.rejects(first, /bad input/);
  const second = queue.enqueue(async () => {
    order.push("b");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["a"]);
  assert.equal(queue.size(), 2);
  release();
  await failure;
  await second;
  let finished = false;
  const third = queue.enqueue(async (signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.resolve();
    finished = true;
  });
  await queue.close();
  await third;
  assert.equal(finished, true);
  assert.equal(queue.size(), 0);
  assert.deepEqual(order, ["a", "b"]);
  await assert.rejects(
    queue.enqueue(async () => {}),
    /closed/,
  );
});

test(
  "real MP4 compatibility uses FFprobe and remuxes without resizing; other containers remux too",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      const source = join(f.directory, "compatible.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        source,
      ]);
      const inspected = await inspectMedia(f.config, source);
      assert.ok(inspected.container.split(",").includes("mp4"));
      assert.equal(needsTranscode(inspected), false);
      const normalized = await normalize(f.config, source, "copy");
      assert.equal(normalized.transcoded, false);
      assert.equal(normalized.width, 320);
      const packetHashes = async (path: string) =>
        JSON.parse(
          await run("ffprobe", [
            "-v",
            "error",
            "-show_packets",
            "-show_data_hash",
            "sha256",
            "-show_entries",
            "packet=data_hash",
            "-of",
            "json",
            path,
          ]),
        ).packets;
      assert.deepEqual(
        await packetHashes(normalized.path),
        await packetHashes(source),
      );
      const accepted = await directUpload(f, await readFile(source));
      assert.equal(accepted.statusCode, 201, accepted.body);
      assert.equal(accepted.json().status, "ready");
      assert.equal(accepted.json().transcoded, false);
      assert.equal(
        (await inspectMedia(f.config, normalized.path)).audioCodec,
        "aac",
      );
      const mkv = join(f.directory, "compatible.mkv");
      await run("ffmpeg", ["-v", "error", "-i", source, "-c", "copy", mkv]);
      assert.equal((await normalize(f.config, mkv, "remux")).transcoded, false);
      for (const change of [
        { codec: "hevc" },
        { audioCodec: null },
        { width: 1920 },
        { fps: 60 },
        { pixelFormat: "yuv444p" },
        { sampleRate: 44100 },
        { channels: 1 },
      ]) {
        assert.equal(needsTranscode({ ...inspected, ...change }), true);
      }
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "resumable and multipart processing accept further uploads and expose ready status",
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const source = join(f.directory, "silent.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-t",
        "3",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        source,
      ]);
      const bytes = await readFile(source);
      const session = await f.request("POST", "uploads", {
        name: "silent.mp4",
        size: bytes.length,
        fingerprint: "a".repeat(64),
      });
      assert.equal(session.statusCode, 201, session.body);
      const uploadId = session.json().id;
      const chunk = await f.app.inject({
        method: "PATCH",
        url: `/api/uploads/${uploadId}`,
        headers: {
          ...f.headers,
          "content-type": "application/octet-stream",
          "upload-offset": "0",
        },
        payload: bytes,
      });
      assert.equal(chunk.statusCode, 200, chunk.body);
      const complete = await f.request("POST", `uploads/${uploadId}/complete`);
      assert.equal(complete.statusCode, 201, complete.body);
      assert.equal(complete.json().status, "queued");
      const boundary = "media-queue-test";
      const multipart = await f.app.inject({
        method: "POST",
        url: "/api/videos",
        headers: {
          ...f.headers,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="next.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(multipart.statusCode, 201, multipart.body);
      assert.equal(multipart.json().status, "queued");
      const ids = [complete.json().id, multipart.json().id];
      for (const id of ids) {
        await until(() => f.store.get("videos", id)?.status === "ready", 20000);
        assert.equal((await f.request("GET", `media/${id}`)).statusCode, 200);
        await assert.rejects(
          access(join(f.directory, "uploads", `${id}.upload`)),
        );
      }
    } finally {
      await f.cleanup();
    }
  },
);

test("failed inspection preserves resumable source and offset", async () => {
  const f = await fixture();
  try {
    const session = await f.request("POST", "uploads", {
      name: "invalid.mp4",
      size: 4,
      fingerprint: "b".repeat(64),
    });
    const id = session.json().id;
    await f.app.inject({
      method: "PATCH",
      url: `/api/uploads/${id}`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "upload-offset": "0",
      },
      payload: Buffer.from("nope"),
    });
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await f.request("POST", `uploads/${id}/complete`)).statusCode,
        400,
      );
    assert.equal((await f.request("GET", "uploads")).json()[0].offset, 4);
    assert.equal(f.store.list("videos").length, 0);
  } finally {
    await f.cleanup();
  }
});

test(
  "shutdown cancels active FFmpeg before closing storage and restart reconciles interrupted jobs",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    let reopened: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      const source = join(f.directory, "long.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=size=320x180:rate=30",
        "-t",
        "60",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        source,
      ]);
      const bytes = await readFile(source);
      const session = await f.request("POST", "uploads", {
        name: "long.mp4",
        size: bytes.length,
        fingerprint: "c".repeat(64),
      });
      const id = session.json().id;
      await f.app.inject({
        method: "PATCH",
        url: `/api/uploads/${id}`,
        headers: {
          ...f.headers,
          "content-type": "application/octet-stream",
          "upload-offset": "0",
        },
        payload: bytes,
      });
      const complete = await f.request("POST", `uploads/${id}/complete`);
      assert.equal(complete.statusCode, 201, complete.body);
      const videoId = complete.json().id;
      assert.equal(
        (await f.request("DELETE", `videos/${videoId}`)).statusCode,
        409,
      );
      assert.equal(
        (await f.request("GET", `media/${videoId}`)).statusCode,
        409,
      );
      const interruptedId = randomUUID();
      f.store.save("videos", {
        id: interruptedId,
        name: "Interrupted",
        status: "processing",
      });
      await writeFile(
        join(f.directory, "uploads", `${interruptedId}.upload`),
        "temporary",
      );
      await writeFile(
        join(f.directory, "media", `${interruptedId}.mp4`),
        "partial",
      );
      await f.app.close();
      await assert.rejects(
        access(join(f.directory, "uploads", `${videoId}.upload`)),
      );
      reopened = await buildApp(f.config, { startEngine: false });
      assert.equal(reopened.store.get("videos", videoId)?.status, "failed");
      assert.equal(
        reopened.store.get("videos", interruptedId)?.status,
        "failed",
      );
      await assert.rejects(
        access(join(f.directory, "uploads", `${interruptedId}.upload`)),
      );
      await assert.rejects(
        access(join(f.directory, "media", `${interruptedId}.mp4`)),
      );
    } finally {
      await reopened?.app.close();
      await f.cleanup();
    }
  },
);
