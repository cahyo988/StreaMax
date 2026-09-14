import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { fixture, seed, until, createPngFixture } from "./helpers.ts";
import { run } from "../server/media.ts";
import { encrypt } from "../server/security.ts";

test(
  "real upload, normalization, preview and local RTMP broadcast",
  { timeout: 60000 },
  async (t) => {
    try {
      await run("ffmpeg", ["-version"]);
      await run("ffprobe", ["-version"]);
    } catch {
      t.skip("FFmpeg and FFprobe must be installed for media integration");
      return;
    }
    const f = await fixture();
    let receiver: ReturnType<typeof spawn> | undefined;
    try {
      const input = join(f.directory, "source.mp4");
      await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        input,
      ]);
      const bytes = await readFile(input),
        boundary = "streamax-test-boundary";
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const uploaded = await f.app.inject({
        method: "POST",
        url: "/api/videos",
        headers: {
          ...f.headers,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
      const video = uploaded.json();
      assert.equal(video.audioCodec, "aac");
      assert.equal(video.width, 1280);
      const preview = await f.request("GET", `media/${video.id}`);
      assert.equal(preview.statusCode, 200);
      assert.match(String(preview.headers["content-type"]), /video\/mp4/);
      assert.ok(preview.rawPayload.length > 1000);
      const { stream, playlist, destination, profile } = seed(f);
      await writeFile(
        join(f.directory, "workspace-logo.png"),
        createPngFixture(),
      );
      f.store.save("streams", {
        ...stream,
        overlayText: "StreaMax: 100% 'live' [test]",
        watermark: true,
        livePreview: true,
      });
      f.store.save("playlists", { ...playlist, videoIds: [video.id] });
      f.store.save("profiles", {
        ...profile,
        width: 640,
        height: 360,
        bitrate: 600,
      });
      const probe = createServer();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const port = (probe.address() as any).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const url = `rtmp://127.0.0.1:${port}/live`;
      const output = join(f.directory, "received.flv");
      receiver = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-listen",
          "1",
          "-i",
          `${url}/smoke`,
          "-c",
          "copy",
          "-y",
          output,
        ],
        { windowsHide: true, stdio: "ignore" },
      );
      receiver.on("error", () => {});
      await new Promise((r) => setTimeout(r, 600));
      f.store.save("destinations", {
        ...destination,
        url,
        secret: encrypt("smoke", f.config.ENCRYPTION_KEY),
      });
      assert.equal(
        (await f.request("POST", `streams/${stream.id}/start`, {})).statusCode,
        200,
      );
      await until(() => f.engine.status(stream.id)[0]?.state === "live", 15000);
      await new Promise((r) => setTimeout(r, 3500));
      const livePreview = await f.request(
        "GET",
        `preview/${stream.id}/live.m3u8`,
      );
      assert.equal(livePreview.statusCode, 200, livePreview.body);
      assert.match(livePreview.body, /#EXTM3U/);
      const segment = livePreview.body
        .split("\n")
        .find((line) => /^live\d+\.ts$/.test(line))!;
      assert.ok(segment);
      assert.equal(
        (await f.request("GET", `preview/${stream.id}/${segment}`)).statusCode,
        200,
      );
      assert.equal(
        (await f.app.inject({ url: `/api/preview/${stream.id}/live.m3u8` }))
          .statusCode,
        401,
      );
      assert.ok(f.engine.status(stream.id)[0].nowPlaying!.elapsedSeconds > 0);
      assert.equal(
        (await f.request("POST", `streams/${stream.id}/stop`, {})).statusCode,
        200,
      );
      await until(() => receiver!.exitCode !== null, 10000);
      const received = JSON.parse(
        await run("ffprobe", [
          "-v",
          "error",
          "-show_format",
          "-of",
          "json",
          output,
        ]),
      );
      assert.ok(
        Number(received.format.duration) > 2,
        "Receiver should contain more than one playlist loop",
      );
      assert.equal(f.store.get("streams", stream.id)!.desired, "stopped");
    } finally {
      if (receiver && receiver.exitCode === null) {
        receiver.kill("SIGKILL");
        await once(receiver, "close");
      }
      await f.cleanup();
    }
  },
);
