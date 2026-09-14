import {
  dateTimeLocalToInstant,
  instantToDateTimeLocal,
} from "../shared/timezone.ts";

export function scheduleOccurrences(
  startAt: string,
  endAt: string,
  recurrence = "none",
  count = 1,
  timeZone = "UTC",
) {
  const step = recurrence === "weekly" ? 7 : 1;
  const startWall = instantToDateTimeLocal(startAt, timeZone);
  const endWall = instantToDateTimeLocal(endAt, timeZone);
  const shift = (wall: string, days: number, original: string) => {
    const date = new Date(`${wall}:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    const instant = dateTimeLocalToInstant(
      date.toISOString().slice(0, 16),
      timeZone,
    );
    const precision = Date.parse(original) % 60000;
    return new Date(Date.parse(instant) + precision).toISOString();
  };
  return Array.from({ length: recurrence === "none" ? 1 : count }, (_, i) => ({
    startAt: i === 0 ? startAt : shift(startWall, step * i, startAt),
    endAt: i === 0 ? endAt : shift(endWall, step * i, endAt),
  }));
}
