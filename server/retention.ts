import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";

export function pruneExpiredVideos(
  store: Store,
  mediaDir: string,
  retentionDays: number,
  now = Date.now(),
) {
  if (retentionDays <= 0) return [] as string[];
  const expiresBefore = now - retentionDays * 86400000;
  const referenced = new Set(
    store.list("playlists").flatMap((playlist) => playlist.videoIds),
  );
  const deleted: string[] = [];
  for (const video of store.list("videos")) {
    const createdAt = Date.parse(video.createdAt || "");
    if (
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(video.id) ||
      !Number.isFinite(createdAt) ||
      ["queued", "processing", "uploaded"].includes(video.status) ||
      createdAt >= expiresBefore ||
      referenced.has(video.id)
    )
      continue;
    const path = join(mediaDir, `${video.id}.mp4`);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      continue;
    }
    store.delete("videos", video.id);
    store.event(
      "retention",
      "video.retention_deleted",
      video.id,
      "Expired by workspace media retention policy",
      "",
      "success",
      { retentionDays },
    );
    deleted.push(video.id);
  }
  return deleted;
}
