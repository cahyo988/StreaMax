import { spawn, type ChildProcess } from "node:child_process";
import {
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { decrypt } from "./security.ts";
import { Store, type Entity } from "./store.ts";
import type { Config } from "./config.ts";
import { pruneExpiredVideos } from "./retention.ts";
import { playbackPosition } from "./playback.ts";

export type Output = {
  destinationId: string;
  state: string;
  retries: number;
  fps?: number;
  bitrate?: string;
  elapsed?: string;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  lastProgress?: number;
  lastMetricAt?: number;
  connectionStartedAt?: string;
  positionSeconds?: number;
  lastCheckpointAt?: number;
};
export function ffmpegArgs(
  playlist: string,
  profile: Entity,
  url: string,
  loop: boolean,
  playCount?: number,
  playback?: {
    offset: number;
    remaining?: number;
    textFile?: string;
    logoFile?: string;
    position?: string;
    preview?: string;
  },
) {
  const right = playback?.position?.endsWith("right");
  const bottom = playback?.position?.startsWith("bottom");
  const filters = [`scale=${profile.width}:${profile.height}`];
  if (playback?.textFile)
    filters.push(
      `drawtext=textfile=${playback.textFile}:expansion=none:fontcolor=white:fontsize=28:box=1:boxcolor=black@0.5:x=${right ? "w-tw-20" : "20"}:y=${bottom ? "h-th-20" : "20"}`,
    );
  const videoFilter = filters.join(",");
  const complex = Boolean(playback?.logoFile || playback?.preview);
  const rendered = playback?.logoFile
    ? `[0:v]${videoFilter}[base];movie=${playback.logoFile},scale=160:-1,format=rgba,colorchannelmixer=aa=0.75[logo];[base][logo]overlay=${right ? "W-w-20" : "20"}:${bottom ? "H-h-70" : "70"}[rendered]`
    : `[0:v]${videoFilter}[rendered]`;
  const graph =
    rendered +
    (playback?.preview
      ? ";[rendered]split[branded][previewInput];[previewInput]scale=640:360[preview]"
      : ";[rendered]null[branded]");
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "warning",
    "-re",
    ...(loop
      ? ["-stream_loop", "-1"]
      : playCount !== undefined && playCount > 1
        ? ["-stream_loop", String(playCount - 1)]
        : []),
    "-f",
    "concat",
    "-safe",
    "1",
    ...(playback?.offset ? ["-ss", String(playback.offset)] : []),
    "-i",
    playlist,
    ...(playback?.remaining !== undefined
      ? ["-t", String(playback.remaining)]
      : []),
    ...(complex
      ? ["-filter_complex", graph, "-map", "[branded]"]
      : ["-map", "0:v:0", "-vf", videoFilter]),
    "-map",
    "0:a:0",
    "-r",
    String(profile.fps),
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    `${profile.bitrate}k`,
    "-maxrate",
    `${profile.bitrate}k`,
    "-bufsize",
    `${profile.bitrate * 2}k`,
    "-g",
    String(profile.fps * 2),
    "-c:a",
    "aac",
    "-b:a",
    `${profile.audioBitrate}k`,
    "-ar",
    "48000",
    "-progress",
    "pipe:1",
    "-stats_period",
    "2",
    "-rw_timeout",
    "15000000",
    "-f",
    "flv",
    url,
    ...(playback?.preview
      ? [
          "-map",
          "[preview]",
          "-map",
          "0:a:0",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-preset",
          "ultrafast",
          "-r",
          "15",
          "-g",
          "30",
          "-b:v",
          "500k",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          ...(playback.remaining !== undefined
            ? ["-t", String(playback.remaining)]
            : []),
          "-f",
          "hls",
          "-hls_time",
          "2",
          "-hls_list_size",
          "4",
          "-hls_flags",
          "delete_segments+temp_file+omit_endlist",
          "-hls_start_number_source",
          "epoch",
          playback.preview,
        ]
      : []),
  ];
}
export class Engine {
  outputs = new Map<string, Output[]>();
  private interval?: NodeJS.Timeout;
  private closed = false;
  private stopping = new Map<string, Promise<void>>();
  private ticking?: Promise<void>;
  private retentionTask?: Promise<void>;
  private nextRetentionSweep = 0;
  constructor(
    private store: Store,
    private config: Config,
  ) {}
  status(id: string) {
    const stream = this.store.get("streams", id);
    const playlist =
      stream &&
      this.store.get("playlists", stream.activePlaylistId || stream.playlistId);
    const videos = (playlist?.videoIds || [])
      .map((videoId: string) => this.store.get("videos", videoId))
      .filter(Boolean);
    return (this.outputs.get(id) || []).map(({ child, timer, ...output }) => ({
      ...output,
      platformVerified: false,
      outputStatus: output.state === "live" ? "sending" : output.state,
      nowPlaying: playbackPosition(
        videos,
        output.positionSeconds || 0,
        stream?.loop,
        stream?.playCount || 1,
      ),
    }));
  }
  validate(stream: Entity) {
    const playlist = this.store.get(
      "playlists",
      stream.activePlaylistId || stream.playlistId,
    );
    const profile = this.store.get("profiles", stream.profileId);
    if (!playlist?.videoIds.length || !profile)
      throw new Error("Select a nonempty playlist and encoding profile");
    for (const id of playlist.videoIds) {
      const video = this.store.get("videos", id);
      if (!video) throw new Error("Playlist contains missing media");
      if (video.status && video.status !== "ready")
        throw new Error("Playlist contains media that is not ready");
    }
    if (!stream.destinationIds.length)
      throw new Error("Select at least one destination");
    for (const id of stream.destinationIds) {
      const destination = this.store.get("destinations", id);
      if (!destination?.enabled)
        throw new Error("A destination is missing or disabled");
      for (const other of this.store.list("streams")) {
        if (
          other.id !== stream.id &&
          other.desired === "running" &&
          other.destinationIds.includes(id)
        )
          throw new Error("Destination is reserved by another running stream");
      }
    }
    const used = this.store
      .list("streams")
      .filter((s) => s.id !== stream.id && s.desired === "running")
      .reduce(
        (n, s) => n + s.destinationIds.length + Number(Boolean(s.livePreview)),
        0,
      );
    if (
      used +
        stream.destinationIds.length +
        Number(Boolean(stream.livePreview)) >
      this.config.MAX_OUTPUTS
    )
      throw new Error("Worker output capacity reached");
    return { playlist, profile };
  }
  start(id: string, actor = "worker", playlistOverride?: string) {
    if (this.closed || this.stopping.has(id))
      throw new Error("Worker is shutting down or stream is stopping");
    let stream = this.store.get("streams", id);
    if (!stream) throw new Error("Stream not found");
    if (this.outputs.has(id)) return;
    if (playlistOverride)
      stream = { ...stream, activePlaylistId: playlistOverride };
    else if (stream.desired !== "running")
      stream = { ...stream, activePlaylistId: undefined };
    const { playlist } = this.validate(stream);
    mkdirSync(join(this.config.DATA_DIR, "media"), { recursive: true });
    const file = join(this.config.DATA_DIR, "media", `${id}.txt`);
    if (stream.overlayText)
      writeFileSync(
        join(this.config.DATA_DIR, "media", `${id}-overlay.txt`),
        stream.overlayText,
      );
    if (stream.watermark) {
      const logo = join(this.config.DATA_DIR, "workspace-logo.png");
      if (!existsSync(logo))
        throw new Error(
          "Upload a workspace PNG logo in Settings before enabling the watermark",
        );
      copyFileSync(logo, join(this.config.DATA_DIR, "media", `${id}-logo.png`));
    }
    if (stream.livePreview) {
      const directory = join(this.config.DATA_DIR, "preview", id);
      mkdirSync(directory, { recursive: true });
      for (const name of readdirSync(directory))
        if (/^(live\.m3u8|live\d+\.ts)(\.tmp)?$/.test(name))
          unlinkSync(join(directory, name));
    }
    writeFileSync(
      file,
      playlist.videoIds
        .map(
          (videoId: string) =>
            `file '${videoId}.mp4'\nduration ${Number(this.store.get("videos", videoId)!.duration)}`,
        )
        .join("\n"),
    );
    this.store.save("streams", {
      ...stream,
      desired: "running",
      startedAt: new Date().toISOString(),
      error: null,
      checkpoints: stream.desired === "running" ? stream.checkpoints || {} : {},
    });
    const outputs: Output[] = stream.destinationIds.map(
      (destinationId: string) => ({
        destinationId,
        state: "starting",
        retries: 0,
        positionSeconds:
          stream.desired === "running"
            ? Number(stream.checkpoints?.[destinationId] || 0)
            : 0,
      }),
    );
    this.outputs.set(id, outputs);
    this.store.event(actor, "stream.start", id, stream.name);
    for (const output of outputs) this.launch(id, file, output);
  }
  private launch(id: string, file: string, output: Output) {
    const stream = this.store.get("streams", id)!;
    const destination = this.store.get("destinations", output.destinationId)!;
    const profile = this.store.get("profiles", stream.profileId)!;
    const playlist = this.store.get(
      "playlists",
      stream.activePlaylistId || stream.playlistId,
    )!;
    const duration = playlist.videoIds.reduce(
      (sum: number, videoId: string) =>
        sum + Number(this.store.get("videos", videoId)?.duration || 0),
      0,
    );
    const position = output.positionSeconds || 0;
    const remaining = stream.loop
      ? undefined
      : Math.max(0, duration * (stream.playCount || 1) - position);
    if (remaining !== undefined && remaining <= 0) {
      output.state = "completed";
      if (this.outputs.get(id)!.every((o) => o.state === "completed"))
        void this.stop(id);
      return;
    }
    let url: string;
    try {
      url = `${destination.url.replace(/\/$/, "")}/${decrypt(destination.secret, this.config.ENCRYPTION_KEY)}`;
    } catch {
      this.fail(id, file, output);
      return;
    }
    const child = spawn(
      this.config.FFMPEG_PATH,
      ffmpegArgs(file, profile, url, true, undefined, {
        offset: duration ? position % duration : 0,
        remaining,
        textFile: stream.overlayText ? `${id}-overlay.txt` : undefined,
        logoFile: stream.watermark ? `${id}-logo.png` : undefined,
        position: stream.overlayPosition,
        preview:
          stream.livePreview &&
          stream.destinationIds[0] === output.destinationId
            ? join(this.config.DATA_DIR, "preview", id, "live.m3u8")
            : undefined,
      }),
      {
        cwd: join(this.config.DATA_DIR, "media"),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    output.child = child;
    output.state = "starting";
    output.lastProgress = Date.now();
    let buffer = "";
    let settled = false;
    let lastFrame = 0;
    child.stdout!.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const [key, value] = line.trim().split("=");
        if (key === "fps") output.fps = Number(value);
        if (key === "bitrate") output.bitrate = value;
        if (key === "out_time") output.elapsed = value;
        if (key === "out_time_us" && Number.isFinite(Number(value))) {
          output.positionSeconds =
            position + Math.max(0, Number(value) / 1_000_000);
          if (Date.now() - (output.lastCheckpointAt || 0) >= 5000)
            this.checkpoint(id, output);
        }
        if (key === "frame" && Number(value) > lastFrame) {
          lastFrame = Number(value);
          if (output.state !== "live") {
            output.state = "live";
            output.connectionStartedAt = new Date().toISOString();
            this.store.event(
              "worker",
              "destination.connection.start",
              output.destinationId,
              destination.name,
            );
          }
          output.lastProgress = Date.now();
          if (Date.now() - (output.lastMetricAt || 0) >= 30_000) {
            this.store.metric(
              id,
              output.destinationId,
              output.fps,
              output.bitrate,
              output.elapsed,
            );
            output.lastMetricAt = Date.now();
          }
        }
      }
    });
    // Raw FFmpeg diagnostics may include credentials outside URLs. Persist only
    // controlled lifecycle messages; progress is parsed separately above.
    child.stderr!.resume();
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      this.checkpoint(id, output);
      output.child = undefined;
      if (output.connectionStartedAt) {
        this.store.event(
          "worker",
          "destination.connection.stop",
          output.destinationId,
          destination.name,
        );
        output.connectionStartedAt = undefined;
      }
      if (this.closed || this.outputs.get(id)?.includes(output) !== true)
        return;
      if (code === 0 && !stream.loop) {
        output.state = "completed";
        if (this.outputs.get(id)!.every((o) => o.state === "completed"))
          void this.stop(id, "worker");
      } else this.fail(id, file, output);
    };
    child.on("error", () => finish(-1));
    child.on("close", finish);
  }
  private fail(id: string, file: string, output: Output) {
    const retryAttempts = Number(
      this.store.get("settings", "system")?.retryAttempts ?? 5,
    );
    if (output.retries >= retryAttempts) {
      output.state = "failed";
      const destination = this.store.get("destinations", output.destinationId);
      this.store.event(
        "worker",
        "analytics.destination.failure",
        output.destinationId,
        destination?.name || "",
      );
      this.store.event(
        "worker",
        "output.failed",
        id,
        `Destination ${output.destinationId}; retry budget exhausted`,
      );
      return;
    }
    output.state = "retrying";
    output.retries += 1;
    this.store.event(
      "worker",
      "output.retry",
      id,
      `Destination ${output.destinationId}; attempt ${output.retries}/${retryAttempts}`,
    );
    output.timer = setTimeout(
      () => {
        if (!this.closed && this.outputs.get(id)?.includes(output))
          this.launch(id, file, output);
      },
      Math.min(1000 * 2 ** output.retries, 30_000),
    );
  }
  private checkpoint(id: string, output: Output) {
    const stream = this.store.get("streams", id);
    if (!stream) return;
    this.store.save("streams", {
      ...stream,
      checkpoints: {
        ...stream.checkpoints,
        [output.destinationId]: output.positionSeconds || 0,
      },
    });
    output.lastCheckpointAt = Date.now();
  }
  stop(id: string, actor = "worker", preserveDesired = false): Promise<void> {
    const pending = this.stopping.get(id);
    if (pending) return pending;
    const task = this.stopOutputs(id, actor, preserveDesired).finally(() => {
      this.stopping.delete(id);
    });
    this.stopping.set(id, task);
    return task;
  }
  private async stopOutputs(
    id: string,
    actor: string,
    preserveDesired: boolean,
  ) {
    const outputs = this.outputs.get(id) || [];
    this.outputs.delete(id);
    await Promise.all(
      outputs.map(async (output) => {
        clearTimeout(output.timer);
        const child = output.child;
        if (!child || child.exitCode !== null) return;
        await new Promise<void>((resolve) => {
          const force = setTimeout(() => child.kill("SIGKILL"), 3000);
          child.once("close", () => {
            clearTimeout(force);
            resolve();
          });
          child.kill("SIGTERM");
        });
      }),
    );
    const stream = this.store.get("streams", id);
    if (stream && !preserveDesired)
      this.store.save("streams", { ...stream, desired: "stopped" });
    if (outputs.length)
      this.store.event(actor, "stream.stop", id, stream?.name || "");
  }
  async tick(now = Date.now()) {
    for (const schedule of this.store
      .list("schedules")
      .sort(
        (a, b) => Number(b.state === "running") - Number(a.state === "running"),
      )) {
      if (schedule.state === "pending" && Date.parse(schedule.startAt) <= now) {
        if (Date.parse(schedule.endAt) <= now) {
          this.store.save("schedules", { ...schedule, state: "missed" });
          continue;
        }
        try {
          const stream = this.store.get("streams", schedule.streamId);
          if (stream?.desired === "running")
            throw new Error("Stream is already running");
          this.start(schedule.streamId, "scheduler", schedule.playlistId);
          this.store.save("schedules", { ...schedule, state: "running" });
          this.store.event(
            "scheduler",
            "schedule.started",
            schedule.id,
            schedule.name,
          );
        } catch (error) {
          this.store.save("schedules", { ...schedule, state: "failed" });
          this.store.event(
            "scheduler",
            "schedule.failed",
            schedule.id,
            (error as Error).message,
          );
        }
      } else if (
        schedule.state === "running" &&
        Date.parse(schedule.endAt) <= now
      ) {
        await this.stop(schedule.streamId, "scheduler");
        this.store.save("schedules", { ...schedule, state: "completed" });
      }
    }
    for (const outputs of this.outputs.values())
      for (const output of outputs) {
        if (output.child && Date.now() - (output.lastProgress || 0) > 60_000) {
          this.store.event(
            "worker",
            "output.stalled",
            output.destinationId,
            "No encoder progress for 60 seconds; restarting output",
          );
          output.lastProgress = Date.now();
          output.child.kill("SIGKILL");
        }
      }
    this.store.db
      .prepare("DELETE FROM sessions WHERE expires < ?")
      .run(Date.now());
    const retentionDays =
      this.store.get("settings", "system")?.videoRetentionDays ?? 0;
    if (
      retentionDays > 0 &&
      now >= this.nextRetentionSweep &&
      !this.retentionTask
    ) {
      this.nextRetentionSweep = now + 60 * 60 * 1000;
      this.retentionTask = Promise.resolve()
        .then(() => {
          pruneExpiredVideos(
            this.store,
            join(this.config.DATA_DIR, "media"),
            retentionDays,
            now,
          );
        })
        .catch(() => {
          this.store.event(
            "worker",
            "video.retention_failed",
            "",
            "Video retention sweep failed",
          );
        })
        .finally(() => {
          this.retentionTask = undefined;
        });
    }
  }
  async boot() {
    // Expired schedules must stop their streams before restart reconciliation.
    for (const schedule of this.store.list("schedules"))
      if (
        schedule.state === "running" &&
        Date.parse(schedule.endAt) <= Date.now()
      ) {
        await this.stop(schedule.streamId, "scheduler");
        this.store.save("schedules", { ...schedule, state: "completed" });
      }
    for (const stream of this.store.list("streams"))
      if (stream.desired === "running") {
        try {
          this.start(stream.id);
        } catch (error) {
          this.store.save("streams", {
            ...stream,
            desired: "stopped",
            error: (error as Error).message,
          });
          this.store.event(
            "worker",
            "stream.recovery_failed",
            stream.id,
            (error as Error).message,
          );
        }
      }
    this.interval = setInterval(() => {
      if (this.ticking || this.closed) return;
      this.ticking = this.tick()
        .catch(() =>
          this.store.event(
            "worker",
            "scheduler.error",
            "",
            "Scheduler tick failed",
          ),
        )
        .finally(() => {
          this.ticking = undefined;
        });
    }, 1000);
  }
  async shutdown() {
    this.closed = true;
    clearInterval(this.interval);
    await this.ticking;
    await this.retentionTask;
    await Promise.all([
      ...this.stopping.values(),
      ...[...this.outputs.keys()].map((id) => this.stop(id, "shutdown", true)),
    ]);
  }
}
