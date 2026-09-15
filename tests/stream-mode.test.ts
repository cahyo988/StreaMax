import { test } from "node:test";
import assert from "node:assert/strict";
import { selectStreamMode } from "../server/stream-mode.ts";
import { ffmpegArgs } from "../server/engine.ts";
import { EncoderSlot } from "../server/encoder-slot.ts";
import { inspectMedia, run } from "../server/media.ts";
import type { MediaInspection } from "../server/media.ts";
import { fixture, seed, until } from "./helpers.ts";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";

const source: MediaInspection = {
  duration: 2,
  width: 1280,
  height: 720,
  fps: 30,
  codec: "h264",
  audioCodec: "aac",
  pixelFormat: "yuv420p",
  sampleRate: 48000,
  channels: 2,
  channelLayout: "stereo",
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  hasAudio: true,
  videoTimeBase: "1/15360",
  audioTimeBase: "1/48000",
  videoExtraData: "same",
  audioExtraData: "same",
  sampleAspectRatio: "1:1",
};
const profile = {
  id: "profile",
  name: "720p",
  width: 1280,
  height: 720,
  fps: 30,
  bitrate: 2500,
  audioBitrate: 128,
};

test("progress callback failure rejects after child cleanup; pre-aborted work never spawns", async () => {
  await assert.rejects(
    run(
      process.execPath,
      [
        "-e",
        "process.stdout.write('out_time_us=1\\n'); setInterval(() => {}, 1000)",
      ],
      5000,
      undefined,
      () => {
        throw new Error("Progress storage failed");
      },
    ),
    /Media processing failed/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    run("missing-program", [], 1000, controller.signal),
    /interrupted/,
  );
});

test("compatible playlist and overlay OFF copy video/audio without filters or rate controls, including preview", () => {
  const plan = selectStreamMode([source, source], profile);
  assert.equal(plan.mode, "copy");
  const args = ffmpegArgs(
    "list.txt",
    profile,
    "rtmp://localhost/live/key",
    true,
    undefined,
    { offset: 0, plan, preview: "live.m3u8" },
  );
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  for (const flag of ["libx264", "-vf", "-filter_complex", "-r", "-b:v", "-g"])
    assert.ok(!args.includes(flag), flag);
  assert.ok(!args.join(" ").includes("drawtext"));
  assert.equal(
    selectStreamMode([{ ...source, container: "matroska,webm" }], profile).mode,
    "copy",
  );
});

test("overlay forces one ultrafast encoder without unnecessary scale or FPS conversion", () => {
  const plan = selectStreamMode([source], profile, true);
  const args = ffmpegArgs(
    "list.txt",
    profile,
    "rtmp://localhost/live/key",
    true,
    undefined,
    { offset: 0, plan, textFile: "overlay.txt", preview: "live.m3u8" },
  );
  assert.equal(plan.mode, "transcode");
  assert.equal(args.filter((a) => a === "libx264").length, 1);
  assert.ok(args.includes("ultrafast"));
  assert.ok(args.join(" ").includes("drawtext="));
  assert.ok(!args.join(" ").includes("scale="));
  assert.ok(!args.includes("-r"));
});

test("actual codec, resolution, FPS, audio and concat signatures govern fallback", () => {
  for (const patch of [
    { codec: "hevc" },
    { pixelFormat: "yuv444p" },
    { width: 1920, height: 1080 },
    { fps: 60 },
    { fps: NaN },
    { audioCodec: "mp3" },
    { channels: 1 },
    { sampleRate: 44100 },
    { channelLayout: "mono" },
    { hasAudio: false },
    { sampleAspectRatio: "4:3" },
  ])
    assert.equal(
      selectStreamMode([{ ...source, ...patch }], profile).mode,
      "transcode",
      JSON.stringify(patch),
    );
  for (const patch of [
    { videoTimeBase: "1/90000" },
    { videoExtraData: "different" },
    { audioExtraData: "different" },
  ])
    assert.equal(
      selectStreamMode([source, { ...source, ...patch }], profile).mode,
      "transcode",
    );
  const plan = selectStreamMode(
    [{ ...source, width: 1920, height: 1080, fps: 60 }],
    profile,
  );
  const args = ffmpegArgs("list.txt", profile, "out.flv", false, 1, {
    offset: 0,
    plan,
  });
  assert.ok(args.includes("scale=1280:720"));
  assert.equal(args[args.indexOf("-r") + 1], "30");
  const anamorphic = ffmpegArgs("list.txt", profile, "out.flv", false, 1, {
    offset: 0,
    plan: selectStreamMode([{ ...source, sampleAspectRatio: "4:3" }], profile),
  });
  assert.ok(anamorphic.includes("setsar=1"));
});

test("shared encoder slot serializes work, cancels queued waiters, and releases idempotently", async () => {
  const slot = new EncoderSlot();
  const signal = new AbortController();
  const release = await slot.acquire(signal.signal);
  const cancelled = new AbortController();
  const waiting = slot.acquire(cancelled.signal);
  const rejected = assert.rejects(waiting, /interrupted/);
  cancelled.abort();
  await rejected;
  let entered = false;
  const second = slot.acquire(signal.signal).then((done) => {
    entered = true;
    return done;
  });
  await Promise.resolve();
  assert.equal(entered, false);
  release();
  release();
  (await second)();
  (await slot.acquire(signal.signal))();
});

test(
  "real FFprobe and COPY survive a repeated concat playlist with playable H264/AAC output",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      const input = join(f.directory, "sample.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x240:rate=30",
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
        "-g",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        input,
      ]);
      const media = await inspectMedia(f.config, input);
      assert.equal(media.channelLayout, "stereo");
      assert.ok(media.videoExtraData);
      const target = { ...profile, width: 320, height: 240 };
      const plan = selectStreamMode([media, media], target);
      assert.equal(plan.mode, "copy");
      const list = join(f.directory, "list.txt");
      await writeFile(list, "file 'sample.mp4'\nfile 'sample.mp4'\n");
      const output = join(f.directory, "copy.flv");
      await run(
        "ffmpeg",
        [
          "-y",
          ...ffmpegArgs(list, target, output, false, 2, { offset: 0, plan }),
        ],
        15000,
      );
      const result = await inspectMedia(f.config, output);
      assert.equal(result.codec, "h264");
      assert.equal(result.audioCodec, "aac");
      assert.ok(result.duration >= 3.8);
      await run(
        "ffmpeg",
        ["-v", "error", "-i", output, "-f", "null", "-"],
        10000,
      );
      assert.ok((await readFile(output)).length > 1000);
    } finally {
      await f.cleanup();
    }
  },
);

test("stopping an output waiting for a CPU slot does not spawn it later", async () => {
  const f = await fixture();
  try {
    const { stream, video } = seed(f);
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=30",
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
      "-c:a",
      "aac",
      join(f.directory, "media", `${video.id}.mp4`),
    ]);
    const slot = (f.engine as any).encoderSlot as EncoderSlot;
    const release = await slot.acquire(new AbortController().signal);
    f.engine.start(stream.id);
    await until(
      () => f.engine.status(stream.id)[0]?.state === "waiting_capacity",
    );
    await f.engine.stop(stream.id);
    release();
    assert.deepEqual(f.engine.status(stream.id), []);
  } finally {
    await f.cleanup();
  }
});

test("stream CPU slot keeps uploads queued, progress becomes visible after release", async () => {
  let entered = false;
  const f = await fixture({
    mediaNormalizer: async (...args) => {
      entered = true;
      const { normalize } = await import("../server/media.ts");
      return normalize(...args);
    },
  });
  const release = await ((f.engine as any).encoderSlot as EncoderSlot).acquire(
    new AbortController().signal,
  );
  try {
    const input = join(f.directory, "silent.mp4");
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=30",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      input,
    ]);
    const boundary = "shared-slot";
    const response = await f.app.inject({
      method: "POST",
      url: "/api/videos",
      headers: {
        ...f.headers,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="silent.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
        ),
        await readFile(input),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(response.statusCode, 201);
    const video = response.json();
    assert.equal(video.status, "queued");
    assert.equal(f.store.get("videos", video.id)?.status, "queued");
    assert.equal(entered, false);
    release();
    await until(() => f.store.get("videos", video.id)?.status === "ready");
    assert.equal(f.store.get("videos", video.id)?.processingProgress, 100);
  } finally {
    release();
    await f.cleanup();
  }
});
