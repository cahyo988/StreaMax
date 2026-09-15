// Local sink only: no credentials, network destinations or hardware encoders.
// Run inside the container to measure its CPU quota; host thermal sysfs must be readable.
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir, arch, cpus } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const input = process.argv[2] && resolve(process.argv[2]);
const seconds = Number(process.argv[3] || 30);
const modes = (process.argv[4] || "copy,ultrafast,veryfast").split(",");
if (
  modes.some(
    (mode) => !["copy", "ultrafast", "veryfast", "540p30", "720p24"].includes(mode),
  ) ||
  new Set(modes).size !== modes.length
)
  throw new Error("Modes: copy,ultrafast,veryfast,540p30,720p24 (no duplicates)");
const thermalLimit = 80;
if (!input || !Number.isFinite(seconds) || seconds < 2 || seconds > 120) {
  console.error(
    "Usage: node scripts/benchmark-streaming.mjs /path/compatible.mp4 [seconds:2..120]",
  );
  process.exit(1);
}
const temperature = async () => {
  const readings = [];
  for (const name of await readdir("/sys/class/thermal").catch(() => [])) {
    if (!/^thermal_zone\d+$/.test(name)) continue;
    const raw = Number(
      await readFile(`/sys/class/thermal/${name}/temp`, "utf8").catch(
        () => "NaN",
      ),
    );
    if (Number.isFinite(raw) && raw > 0) readings.push(raw / 1000);
  }
  return readings.length ? Math.max(...readings) : null;
};
const capture = (binary, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (data) => {
      text = (text + data).slice(-1000000);
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(text)
        : reject(new Error(`${binary} exited ${code}`)),
    );
  });
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const probe = JSON.parse(
  await capture(process.env.FFPROBE_PATH || "ffprobe", [
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-show_streams",
    "-of",
    "json",
    input,
  ]),
);
const video = probe.streams.find((s) => s.codec_type === "video");
const audio = probe.streams.find((s) => s.codec_type === "audio");
if (
  video?.codec_name !== "h264" ||
  video.width !== 1280 ||
  video.height !== 720 ||
  video.pix_fmt !== "yuv420p" ||
  audio?.codec_name !== "aac" ||
  Number(audio.sample_rate) !== 48000 ||
  audio.channels !== 2
) {
  throw new Error(
    "Use a pre-encoded 1280x720 H.264/yuv420p + AAC 48kHz stereo source, prepared on the laptop.",
  );
}
const [fpsN, fpsD] = video.avg_frame_rate.split("/").map(Number);
if (Math.abs(fpsN / fpsD - 30) > 0.05)
  throw new Error("Use a 30 FPS source for a comparable benchmark.");
const directory = await mkdtemp(join(tmpdir(), "streamax-benchmark-"));
const results = [];
try {
  await writeFile(join(directory, "overlay.txt"), "StreaMax benchmark");
  // Copy first; never continue to a higher-load case after a thermal stop.
  for (const mode of modes) {
    const initialTemperature = await temperature();
    if (initialTemperature !== null && initialTemperature >= thermalLimit) {
      results.push({
        mode,
        skipped: `Temperature >= ${thermalLimit} C; cool the device before retrying`,
      });
      break;
    }
    // CPU cases require thermal visibility on Linux STBs.
    if (
      mode !== "copy" &&
      process.platform === "linux" &&
      initialTemperature === null
    ) {
      results.push({
        mode,
        skipped: "Thermal sensors unavailable; CPU benchmark skipped",
      });
      break;
    }
    const output = join(directory, `${mode}.flv`);
    const args = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "info",
      "-benchmark",
      "-filter_threads",
      "1",
      "-threads",
      "2",
      "-re",
      "-stream_loop",
      "-1",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      input,
      "-t",
      String(seconds),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
    ];
    if (mode === "copy") args.push("-c:v", "copy", "-c:a", "copy");
    else
      args.push(
        "-vf",
        `scale=${mode === "540p30" ? "960:540" : "1280:720"},drawtext=textfile=overlay.txt:expansion=none:fontcolor=white:fontsize=28:box=1:boxcolor=black@0.5:x=20:y=20`,
        "-r",
        mode === "720p24" ? "24" : "30",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        ["540p30", "720p24"].includes(mode) ? "ultrafast" : mode,
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        "2500k",
        "-maxrate",
        "2500k",
        "-bufsize",
        "5000k",
        "-g",
        mode === "720p24" ? "48" : "60",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "48000",
      );
    args.push("-progress", "pipe:1", "-stats_period", "1", "-f", "flv", output);
    const result = await new Promise((resolveResult, reject) => {
      const started = performance.now();
      const child = spawn(ffmpeg, args, {
        cwd: directory,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "",
        stderr = "",
        frames = 0,
        mediaSeconds = 0,
        reportedFps = null,
        speed = null;
      let maxTemperature = initialTemperature,
        thermalStopped = false,
        interrupted = false;
      const interrupt = () => {
        interrupted = true;
        child.kill("SIGKILL");
      };
      process.once("SIGINT", interrupt);
      const timer = setInterval(async () => {
        const value = await temperature();
        if (value !== null)
          maxTemperature = Math.max(maxTemperature ?? value, value);
        if (value !== null && value >= thermalLimit) {
          thermalStopped = true;
          child.kill("SIGKILL");
        }
      }, 1000);
      const timeout = setTimeout(
        () => {
          interrupted = true;
          child.kill("SIGKILL");
        },
        seconds * 5000 + 15000,
      );
      child.stdout.on("data", (data) => {
        buffer += data;
        const lines = buffer.split("\n");
        buffer = (lines.pop() || "").slice(-4096);
        for (const line of lines) {
          const [key, value] = line.trim().split("=");
          if (key === "frame") frames = Number(value);
          if (key === "fps" && Number.isFinite(Number(value)))
            reportedFps = Number(value);
          if (key === "out_time_us") mediaSeconds = Number(value) / 1000000;
          if (key === "speed" && Number.isFinite(parseFloat(value)))
            speed = parseFloat(value);
        }
      });
      child.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-16000);
      });
      const cleanup = () => {
        clearInterval(timer);
        clearTimeout(timeout);
        process.removeListener("SIGINT", interrupt);
      };
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", async (code) => {
        cleanup();
        const wallSeconds = (performance.now() - started) / 1000;
        const cpu = stderr.match(/utime=([\d.]+)s stime=([\d.]+)s/);
        const rss = stderr.match(/maxrss=(\d+)(?:KiB|kB)/);
        const size = (await stat(output).catch(() => ({ size: 0 }))).size;
        resolveResult({
          mode,
          exitCode: code,
          thermalStopped,
          interrupted,
          wallSeconds,
          deliveredFps: frames / wallSeconds,
          reportedFps,
          speed,
          bitrateKbps:
            mediaSeconds > 0 ? (size * 8) / mediaSeconds / 1000 : null,
          cpuPercent: cpu
            ? ((Number(cpu[1]) + Number(cpu[2])) / wallSeconds) * 100
            : null,
          peakMemoryMiB: rss ? Number(rss[1]) / 1024 : null,
          initialTemperatureC: initialTemperature,
          maxTemperatureC: maxTemperature,
        });
      });
    });
    results.push(result);
    if (result.exitCode !== 0 || result.thermalStopped || result.interrupted)
      break;
  }
  console.log(
    JSON.stringify(
      {
        architecture: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        seconds,
        sink: "temporary local FLV (not network delivery)",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  // Only this script's own mkdtemp directory, never input or application data.
  await rm(directory, { recursive: true, force: true });
}
