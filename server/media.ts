import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Config } from "./config.ts";

export function run(
  binary: string,
  args: string[],
  timeout = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Media processing timed out"));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-1_000_000);
    });
    child.stderr.on("data", (chunk) => {
      error = (error + chunk).slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `Media processing failed (${code}): ${error.slice(-500)}`,
            ),
          );
    });
  });
}
export async function normalize(config: Config, input: string, id: string) {
  const probe = JSON.parse(
    await run(config.FFPROBE_PATH, [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      input,
    ]),
  );
  const video = probe.streams.find((s: any) => s.codec_type === "video");
  const hasAudio = probe.streams.some((s: any) => s.codec_type === "audio");
  if (
    !video ||
    !Number.isFinite(Number(probe.format.duration)) ||
    Number(probe.format.duration) <= 0
  )
    throw new Error("A finite video file is required");
  const path = join(config.DATA_DIR, "media", `${id}.mp4`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    input,
  ];
  if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push(
    "-map",
    "0:v:0",
    "-map",
    hasAudio ? "0:a:0" : "1:a:0",
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "128k",
    "-shortest",
    "-movflags",
    "+faststart",
    "-y",
    path,
  );
  await run(config.FFMPEG_PATH, args, 60 * 60 * 1000);
  return {
    duration: Number(probe.format.duration),
    width: 1280,
    height: 720,
    fps: 30,
    codec: "h264",
    audioCodec: "aac",
    path,
  };
}
