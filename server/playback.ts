export type MediaItem = { id: string; name: string; duration: number };
export function playbackPosition(
  videos: MediaItem[],
  elapsed: number,
  loop: boolean,
  playCount = 1,
) {
  const duration = videos.reduce(
    (sum, video) => sum + Number(video.duration || 0),
    0,
  );
  if (!duration) return null;
  const total = loop ? null : duration * playCount;
  const position = Math.max(
    0,
    total === null ? elapsed : Math.min(elapsed, total),
  );
  const completed = total !== null && position >= total;
  let offset = completed ? duration : position % duration;
  let index = 0;
  while (index < videos.length - 1 && offset >= videos[index].duration)
    offset -= videos[index++].duration;
  return {
    videoId: videos[index].id,
    videoName: videos[index].name,
    videoSeconds: offset,
    videoDuration: videos[index].duration,
    nextVideoId: completed
      ? null
      : videos[index + 1]?.id ||
        (loop || position + (videos[index].duration - offset) < total!
          ? videos[0].id
          : null),
    play: completed ? playCount : Math.floor(position / duration) + 1,
    totalPlays: loop ? null : playCount,
    elapsedSeconds: position,
    totalSeconds: total,
    completed,
  };
}
