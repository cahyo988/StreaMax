// Read-only StreaMax benchmark preflight. Never prints credentials or process args.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
const db = new DatabaseSync(
  join(process.env.DATA_DIR || "./data", "streamax.sqlite"),
  { readOnly: true },
);
try {
  const entities = (kind) =>
    db
      .prepare("SELECT data FROM entities WHERE kind=?")
      .all(kind)
      .map((row) => JSON.parse(row.data));
  const activeStreams = entities("streams")
    .filter((s) => s.desired === "running")
    .map((s) => ({
      id: s.id,
      overlay: Boolean(s.overlayText || s.watermark),
      outputs: s.destinationIds?.length,
    }));
  const videos = entities("videos").map((v) => ({
    id: v.id,
    status: v.status || "ready",
    width: v.width,
    height: v.height,
    fps: v.fps,
    duration: v.duration,
    size: v.size,
  }));
  const temperatures = [];
  for (const entry of await readdir("/sys/class/thermal").catch(() => [])) {
    if (!/^thermal_zone\d+$/.test(entry)) continue;
    const value = Number(
      await readFile(`/sys/class/thermal/${entry}/temp`, "utf8").catch(
        () => "NaN",
      ),
    );
    if (Number.isFinite(value))
      temperatures.push({ sensor: entry, celsius: value / 1000 });
  }
  console.log(
    JSON.stringify(
      {
        activeStreams,
        pendingMedia: videos.filter((v) =>
          ["processing", "queued"].includes(v.status),
        ),
        videos,
        temperatures,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
