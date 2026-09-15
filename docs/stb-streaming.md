# Low-power STB streaming

## What changed

Previously every destination decoded video, scaled it and encoded H.264/AAC;
HLS preview added another video encoder. Streaming now probes the actual files
before launch and reports `mode`, `modeReasons`, `speed`, measured `fps`, and any
`warning` through the existing stream list/status response. No platform delivery
or device performance is inferred from the selected profile.

COPY uses `-c:v copy -c:a copy`, without video filters, frame-rate conversion,
GOP enforcement or bitrate enforcement. This avoids decoding/encoding as described
in the [FFmpeg streamcopy documentation](https://ffmpeg.org/ffmpeg.html#Streamcopy).

COPY requires H.264/yuv420p, AAC 48 kHz stereo, square pixels, resolution matching
the selected profile and FPS within 0.05 of its target (including 29.97 for 30).
Overlay text must be empty and watermark disabled. Every playlist entry is probed,
including legacy library files. File extensions and stored metadata do not decide.
Container differences alone do not force an encode.

Multiple entries must share encoding parameters, codec extradata and time bases
for COPY. Differences requiring normalization choose TRANSCODE. Different codecs
or time bases across a playlist are rejected with a visible warning because the
[concat demuxer requires matching streams](https://ffmpeg.org/ffmpeg-formats.html#concat).
Prepare those files consistently before broadcasting; transcode does not repair an
invalid concat input automatically.

## CPU fallback and resources

Overlay, resize, FPS/pixel-format/codec/audio conversion or differing playlist
parameters choose CPU TRANSCODE. Scale is only emitted when a source differs from
the profile dimensions; drawtext only when text is supplied. `STREAM_PRESET` defaults
to `ultrafast` and accepts `superfast`/`veryfast`. Encoder threads remain 2; streaming
filter threads are bounded to 1. Hardware encoder/device discovery is not used.

One FIFO encoder slot is shared by media normalization and all live destinations.
COPY/remux does not consume it. A CPU streaming output keeps the slot until its
process closes, including failure or stop. Later CPU outputs show `waiting_capacity`;
uploads are accepted and remain `queued`. An unlimited overlay stream can therefore
delay upload transcoding and other CPU outputs until stopped. Multiple COPY outputs
remain possible within `MAX_OUTPUTS`. Encode once upstream or disable overlays when
several destinations must run simultaneously on the STB.

The upload queue remains FIFO, concurrency 1, with separate resumable upload state.
Direct and resumable uploads share admission, probing, disk checks, normalization,
status updates and cleanup. `processingProgress` is 0–99 while FFmpeg works and 100
only after output finalization. UI polls existing endpoints. Shutdown cancels waits
and children; interrupted jobs become failed and require re-upload.

HLS preview now copies original source packets, so it does **not** include realtime
text/logo overlays or target resizing. It uses the source bitrate and keyframes,
which may increase preview bandwidth/delay compared with the former 360p preview.

COPY preserves source bitrate, GOP, quality and keyframe intervals. Profile bitrate
does not reduce a 15 Mbps source to 2.5 Mbps. Prepare H.264/AAC with a suitable bitrate
and roughly two-second keyframes on the laptop before transferring to the STB.
Checkpoint seeks in COPY are keyframe-granular; a reconnect can repeat a short portion.
Verify actual reception in the platform's studio.

If CPU fallback reports speed below 0.9x, the UI recommends disabling overlays or
selecting a lower profile. In Encoding profiles create 1280×720 / 24 FPS or
960×540 / 30 FPS if needed, then select it on a stopped stream. This is a manual
fallback: no automatic restart/profile downgrade and no claim that A53 can sustain
720p30 overlay. Existing CPU/memory/pid limits and no-new-privileges remain unchanged.

## Benchmark on the STB

Benchmark was run via `ssh armbian` on the actual Cortex-A53 with a 2-CPU quota and
1,258,291,200-byte container memory limit. Results are recorded below. The benchmark
script is included in the Docker image.
Stop active streams and finish pending processing before benchmarking, let the
device cool, and use a pre-encoded 720p30 H.264/AAC 48 kHz stereo source.

```sh
docker compose exec -e TMPDIR=/data streamax node scripts/benchmark-streaming.mjs /data/media/VIDEO_ID.mp4 30
```

Run inside the same container/CPU quota used for streaming. The script tests COPY,
then scale+drawtext+ultrafast, then the old scale+drawtext+veryfast settings. It uses
a temporary local FLV sink; this isolates encoding cost, not network/provider delivery.
No ingest credentials are used. JSON includes observed frame throughput, speed,
average output bitrate, CPU percentage (100% = one core), FFmpeg peak RSS, initial
and peak thermal-zone temperature. Optional fourth argument `copy,ultrafast,veryfast,540p30`
adds an ultrafast 960×540 / 30 FPS overlay comparison. Unsupported metrics are null. CPU/memory include
FFmpeg only, not the complete container; compare with `docker stats --no-stream` for
container totals. Short clips/runs include startup and drain overhead.
To measure only the alternative 24 FPS profile, pass `720p24` as the fourth argument.

The benchmark skips/stops at 80°C and does not continue to a hotter mode; Linux CPU
tests are skipped if thermal sensors are unreadable. Keep thermal sysfs readable
without adding encoder devices or elevated privileges. Let the STB cool between
repeated comparisons. Maximum test duration is bounded; temporary outputs are removed.

On-device run, 2026-09-15, 30 seconds of source media per case. Raw results:
[stb-2026-09-15.json](benchmarks/stb-2026-09-15.json).
Supplementary 24 FPS run: [stb-2026-09-15-720p24.json](benchmarks/stb-2026-09-15-720p24.json).

| Mode | FFmpeg FPS | Speed | CPU % | Peak RSS | Bitrate | Peak °C |
| --- | --- | --- | --- | --- | --- | --- |
| COPY | 30.06 | 1.000× | 4.64 | 50.6 MiB | 3452 kbps | 60 |
| ultrafast + overlay | 22.79 | 0.760× | 180.91 | 89.2 MiB | 2702 kbps | 66 |
| veryfast + overlay | 8.50 | 0.283× | 188.67 | 158.8 MiB | 2700 kbps | 70 |
| ultrafast 540p30 + overlay | 22.84 | 0.762× | 186.73 | 82.4 MiB | 2702 kbps | 70 |
| ultrafast 720p24 + overlay | 20.58 | 0.858× | 184.65 | 89.8 MiB | 2702 kbps | 67 |

FPS here comes from FFmpeg structured progress. The raw report also contains frames
divided by wall time including process startup/drain (28.78 FPS for COPY). COPY sends
at realtime speed. An initial run reproduced COPY 1.00× / 4.66% CPU / peak 57°C and
veryfast 0.281× / 188.40% CPU / peak 69°C. Peak temperatures are not a controlled thermal
comparison: cases run sequentially with different initial temperatures and wall durations.
This is a short benchmark, not proof of long-term thermal stability.
The source's retained bitrate is higher than the CPU cases' target bitrate.

Neither 540p30 nor 720p24 with overlay was **realtime** on this source despite the
lower resolution/frame-rate targets.
Prefer COPY without realtime overlays. For fixed branding, burn the overlay into
the video on the laptop, then upload the compatible finished file and leave runtime
overlays disabled.

Implementation status on the STB: only the two benchmark/preflight scripts were
added to the project and running container. Application code has not been deployed
or restarted. Existing user changes to Dockerfile/compose.yaml were preserved.

## Changed files and verification

- Streaming/resource logic: `server/stream-mode.ts`, `server/encoder-slot.ts`,
  `server/engine.ts`, `server/media.ts`, `server/app.ts`, `server/config.ts`.
- API/UI: `server/openapi.ts`, `src/main.tsx`.
- Tests: `tests/stream-mode.test.ts`, `tests/media.test.ts`,
  `tests/browser/media-queue.spec.ts`, `tests/browser/workflow.spec.ts`.
- Operations/docs: `.env.example`, `scripts/benchmark-streaming.mjs`,
  `scripts/stb-preflight.mjs`, `README.md`, `plan.md`, this guide and benchmark JSON.

Final local `npm run check` passed: TypeScript/Vite production build and 77 tests,
0 failed/skipped. Chrome browser suite passed all 3 tests. Coverage includes COPY
and overlay command selection, actual FFprobe/concat looping, real RTMP/HLS with
both modes, shared-slot cancellation, queued uploads while the encoder is occupied,
processing progress and callback failure cleanup, and existing FIFO/failure/resumable/
upload-limit/disk-space/authentication regressions. Browser checks confirm COPY mode,
processing 37%, queued versus Resume, and uploading while processing.
The existing Vite large HLS chunk warning remains non-fatal.

Then run COPY against the real ingest and observe sustained FPS, `docker stats`,
temperature and platform reception for at least 15 minutes. A 350 MB resumable upload
while COPY is active and a longer thermal soak are still device-level acceptance gates.
