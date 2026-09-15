import type { MediaInspection } from "./media.ts";

export type StreamPlan = {
  mode: "copy" | "transcode";
  reasons: string[];
  resize: boolean;
  changeFps: boolean;
};

/** Inspect every playlist entry, not the filename or stored upload metadata. */
export function selectStreamMode(
  sources: MediaInspection[],
  target: { width: number; height: number; fps: number },
  overlay = false,
): StreamPlan {
  const reasons: string[] = [];
  if (!sources.length) reasons.push("missing inspection");
  if (overlay) reasons.push("overlay");
  const resize =
    !sources.length ||
    sources.some((m) => m.width !== target.width || m.height !== target.height);
  const changeFps =
    !sources.length ||
    sources.some(
      (m) => !Number.isFinite(m.fps) || Math.abs(m.fps - target.fps) > 0.05,
    );
  if (resize) reasons.push("resolution");
  if (changeFps) reasons.push("frame rate");
  if (sources.some((m) => m.codec !== "h264" || m.pixelFormat !== "yuv420p"))
    reasons.push("video format");
  if (
    sources.some(
      (m) =>
        !m.hasAudio ||
        m.audioCodec !== "aac" ||
        m.sampleRate !== 48000 ||
        m.channels !== 2 ||
        m.channelLayout !== "stereo",
    )
  )
    reasons.push("audio format");
  if (
    sources.some(
      (m) =>
        m.sampleAspectRatio && !["1:1", "N/A"].includes(m.sampleAspectRatio),
    )
  )
    reasons.push("pixel aspect ratio");
  const signature = (m: MediaInspection) =>
    JSON.stringify([
      m.codec,
      m.width,
      m.height,
      m.fps,
      m.pixelFormat,
      m.videoTimeBase,
      m.audioTimeBase,
      m.videoExtraData,
      m.audioExtraData,
      m.sampleRate,
      m.channels,
      m.sampleAspectRatio,
    ]);
  if (sources.some((m) => signature(m) !== signature(sources[0])))
    reasons.push("playlist encoding parameters differ");
  return {
    mode: reasons.length ? "transcode" : "copy",
    reasons,
    resize,
    changeFps,
  };
}
