import { spawn } from "node:child_process";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { Config } from "./config.ts";

export type MediaInspection = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audioCodec: string | null;
  pixelFormat: string | null;
  sampleRate: number | null;
  channels: number | null;
  container: string;
  hasAudio: boolean;
  channelLayout?: string;
  videoTimeBase?: string;
  audioTimeBase?: string;
  videoExtraData?: string;
  audioExtraData?: string;
  sampleAspectRatio?: string;
};
const fpsOf = (value: unknown) => {
  const [a, b] = String(value ?? "0/1")
    .split("/")
    .map(Number);
  return b && Number.isFinite(a / b) ? a / b : Number(value) || 0;
};
export function run(
  binary: string,
  args: string[],
  timeout = 30_000,
  signal?: AbortSignal,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  if (signal?.aborted)
    return Promise.reject(new Error("Media processing interrupted"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    const cancel = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    let timedOut = false;
    let callbackFailed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (c) => {
      output = (output + c).slice(-1_000_000);
      try {
        if (!callbackFailed) onOutput?.(c.toString());
      } catch {
        callbackFailed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (c) => {
      error = (error + c).slice(-4000);
    });
    child.on("error", (e) => {
      signal?.removeEventListener("abort", cancel);
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", cancel);
      clearTimeout(timer);
      code === 0 && !signal?.aborted && !timedOut && !callbackFailed
        ? resolve(output)
        : reject(
            new Error(
              `Media processing failed (${code}): ${error.slice(-500)}`,
            ),
          );
    });
  });
}
export async function inspectMedia(
  config: Config,
  input: string,
  signal?: AbortSignal,
): Promise<MediaInspection> {
  const probe = JSON.parse(
    await run(
      config.FFPROBE_PATH,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-show_data_hash",
        "sha256",
        "-of",
        "json",
        input,
      ],
      30_000,
      signal,
    ),
  );
  const video = probe.streams?.find((s: any) => s.codec_type === "video");
  const audio = probe.streams?.find((s: any) => s.codec_type === "audio");
  const duration = Number(probe.format?.duration);
  if (
    !video ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(Number(video.width)) ||
    Number(video.width) <= 0 ||
    !Number.isFinite(Number(video.height)) ||
    Number(video.height) <= 0
  )
    throw new Error("A finite video file is required");
  return {
    duration,
    width: Number(video.width),
    height: Number(video.height),
    fps: fpsOf(video.avg_frame_rate || video.r_frame_rate),
    codec: String(video.codec_name || ""),
    audioCodec: audio?.codec_name ?? null,
    pixelFormat: video.pix_fmt ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ? Number(audio.channels) : null,
    container: String(probe.format?.format_name || ""),
    hasAudio: Boolean(audio),
    channelLayout: audio?.channel_layout,
    videoTimeBase: video.time_base,
    audioTimeBase: audio?.time_base,
    videoExtraData: video.extradata_hash,
    audioExtraData: audio?.extradata_hash,
    sampleAspectRatio: video.sample_aspect_ratio,
  };
}
export function needsTranscode(m: MediaInspection) {
  return (
    m.codec !== "h264" ||
    m.audioCodec !== "aac" ||
    !Number.isFinite(m.width) ||
    m.width <= 0 ||
    m.height <= 0 ||
    m.fps <= 0 ||
    m.width > 1280 ||
    m.height > 720 ||
    m.fps > 30.01 ||
    m.pixelFormat !== "yuv420p" ||
    m.sampleRate !== 48000 ||
    m.channels !== 2
  );
}
export async function normalize(
  config: Config,
  input: string,
  id: string,
  inspection?: MediaInspection,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void,
) {
  inspection ??= await inspectMedia(config, input);
  if (signal?.aborted) throw new Error("Media processing interrupted");
  const output = join(config.DATA_DIR, "media", `${id}.mp4`);
  let progressBuffer = "";
  const progress = (chunk: string) => {
    progressBuffer += chunk;
    const lines = progressBuffer.split("\n");
    progressBuffer = (lines.pop() || "").slice(-4096);
    for (const line of lines) {
      const [key, value] = line.trim().split("=");
      if (key === "out_time_us" && Number.isFinite(Number(value)))
        onProgress?.(
          Math.max(
            0,
            Math.min(
              99,
              Math.floor(
                (Number(value) / 1_000_000 / inspection!.duration) * 100,
              ),
            ),
          ),
        );
    }
  };
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-progress",
    "pipe:1",
    "-stats_period",
    "2",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    input,
  ];
  if (!needsTranscode(inspection)) {
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-y",
      output,
    );
    try {
      await run(config.FFMPEG_PATH, args, 60 * 60 * 1000, signal, progress);
      return {
        ...inspection,
        container: "mp4",
        path: output,
        transcoded: false,
      };
    } catch {
      await unlink(output).catch(() => {});
      throw new Error("Compatible media could not be remuxed");
    }
  }
  if (!inspection.hasAudio)
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push(
    "-map",
    "0:v:0",
    "-map",
    inspection.hasAudio ? "0:a:0" : "1:a:0",
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
    output,
  );
  try {
    await run(config.FFMPEG_PATH, args, 60 * 60 * 1000, signal, progress);
  } catch (error) {
    await unlink(output).catch(() => {});
    throw error;
  }
  return {
    duration: inspection.duration,
    width: 1280,
    height: 720,
    fps: 30,
    codec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    sampleRate: 48000,
    channels: 2,
    container: "mp4",
    hasAudio: true,
    path: output,
    transcoded: true,
  };
}
