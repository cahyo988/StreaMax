type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function canonicalTimeZone(timeZone: string) {
  return formatter(timeZone).resolvedOptions().timeZone;
}

function wallTimeAt(instant: Date, timeZone: string): WallTime {
  const values = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function sameWallTime(left: WallTime, right: WallTime) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function wallEpoch(value: WallTime) {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
}

export function instantToDateTimeLocal(instant: string, timeZone: string) {
  const value = wallTimeAt(new Date(instant), timeZone);
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}T${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

export function dateTimeLocalToInstant(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Enter a valid local date and time");
  const wall: WallTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0,
  };
  const target = wallEpoch(wall);
  const normalized = new Date(target);
  if (
    normalized.getUTCFullYear() !== wall.year ||
    normalized.getUTCMonth() + 1 !== wall.month ||
    normalized.getUTCDate() !== wall.day ||
    normalized.getUTCHours() !== wall.hour ||
    normalized.getUTCMinutes() !== wall.minute
  )
    throw new Error("Enter a valid calendar date and time");

  const format = formatter(timeZone);
  let candidate = target;
  for (let i = 0; i < 6; i++) {
    const actual = wallTimeAt(new Date(candidate), timeZone);
    const adjustment = target - wallEpoch(actual);
    if (adjustment === 0) break;
    candidate += adjustment;
  }
  const matches: number[] = [];
  for (let offsetMinutes = -180; offsetMinutes <= 180; offsetMinutes += 15) {
    const possible = candidate + offsetMinutes * 60000;
    const parts = Object.fromEntries(
      format
        .formatToParts(new Date(possible))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    if (
      sameWallTime(wall, {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minute,
        second: parts.second,
      })
    )
      matches.push(possible);
  }
  if (!matches.length)
    throw new Error(
      "That local time does not exist because of a daylight-saving transition",
    );
  return new Date(Math.min(...matches)).toISOString();
}
