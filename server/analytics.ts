import type { Store } from "./store.ts";

export function report(store: Store, fromInput: string, toInput: string) {
  const from = Date.parse(fromInput);
  const to = Date.parse(toInput);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    to - from > 366 * 86400000
  ) {
    throw Object.assign(
      new Error("Choose a valid reporting period of 366 days or less"),
      { statusCode: 400 },
    );
  }
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const events = store.db
    .prepare(
      "SELECT id,time,actor,action,resource,message FROM events WHERE time <= ? ORDER BY id ASC LIMIT 20000",
    )
    .all(toIso) as Array<{
    id: number;
    time: string;
    actor: string;
    action: string;
    resource: string;
    message: string;
  }>;
  const streams = new Map(
    store.list("streams").map((stream) => [stream.id, stream.name]),
  );
  const sessions: Array<{
    streamId: string;
    stream: string;
    startedAt: string;
    stoppedAt: string | null;
    durationSeconds: number;
  }> = [];
  const current = new Map<string, (typeof sessions)[number]>();
  let failures = 0;
  let reconnects = 0;
  let schedulesFailed = 0;
  for (const event of events) {
    const time = Date.parse(event.time);
    if (
      time >= from &&
      ["output.failed", "stream.recovery_failed"].includes(event.action)
    )
      failures++;
    if (time >= from && event.action === "output.retry") reconnects++;
    if (time >= from && event.action === "schedule.failed") schedulesFailed++;
    if (event.action === "stream.start") {
      const prior = current.get(event.resource);
      if (prior && !prior.stoppedAt) {
        prior.stoppedAt = event.time;
        prior.durationSeconds = Math.max(
          0,
          (Math.min(time, to) - Math.max(Date.parse(prior.startedAt), from)) /
            1000,
        );
      }
      const session = {
        streamId: event.resource,
        stream: streams.get(event.resource) || event.message || event.resource,
        startedAt: event.time,
        stoppedAt: null as string | null,
        durationSeconds: 0,
      };
      current.set(event.resource, session);
      if (time < to) sessions.push(session);
    } else if (event.action === "stream.stop") {
      const active = current.get(event.resource);
      if (active && !active.stoppedAt) {
        active.stoppedAt = event.time;
        active.durationSeconds = Math.max(
          0,
          (Math.min(time, to) - Math.max(Date.parse(active.startedAt), from)) /
            1000,
        );
      }
    }
  }
  for (const session of sessions) {
    if (!session.stoppedAt)
      session.durationSeconds = Math.max(
        0,
        (Math.min(Date.now(), to) -
          Math.max(Date.parse(session.startedAt), from)) /
          1000,
      );
  }
  const inPeriod = sessions.filter(
    (session) =>
      Date.parse(session.startedAt) < to &&
      (!session.stoppedAt || Date.parse(session.stoppedAt) > from),
  );
  const samples = store.db
    .prepare(
      "SELECT destination_id,AVG(fps) AS fps,AVG(bitrate_kbps) AS bitrate,COUNT(*) AS samples FROM stream_metrics WHERE time>=? AND time<? GROUP BY destination_id",
    )
    .all(fromIso, toIso) as Array<{
    destination_id: string;
    fps: number | null;
    bitrate: number | null;
    samples: number;
  }>;
  const destinationStats = new Map<
    string,
    {
      name: string;
      uptimeMs: number;
      failedConnections: number;
      connectionSessions: number;
      openedAt: number | null;
    }
  >();
  const getDestination = (id: string, name = id) => {
    let stat = destinationStats.get(id);
    if (!stat) {
      stat = {
        name: store.get("destinations", id)?.name || name || id,
        uptimeMs: 0,
        failedConnections: 0,
        connectionSessions: 0,
        openedAt: null,
      };
      destinationStats.set(id, stat);
    }
    return stat;
  };
  for (const sample of samples) getDestination(sample.destination_id);
  const reportEnd = Math.min(to, Date.now());
  const closeConnection = (
    stat: NonNullable<ReturnType<typeof getDestination>>,
    endedAt: number,
  ) => {
    if (stat.openedAt === null) return;
    const clippedStart = Math.max(from, stat.openedAt);
    const clippedEnd = Math.min(reportEnd, endedAt);
    if (clippedEnd > clippedStart) {
      stat.uptimeMs += clippedEnd - clippedStart;
      stat.connectionSessions++;
    }
    stat.openedAt = null;
  };
  for (const event of events) {
    const time = Date.parse(event.time);
    if (event.action === "destination.connection.start") {
      const stat = getDestination(event.resource, event.message);
      if (stat.openedAt !== null) closeConnection(stat, time);
      stat.openedAt = time;
    } else if (event.action === "destination.connection.stop") {
      const stat = getDestination(event.resource, event.message);
      closeConnection(stat, time);
    } else if (
      event.action === "analytics.destination.failure" &&
      time >= from &&
      time < to
    ) {
      getDestination(event.resource, event.message).failedConnections++;
    }
  }
  for (const stat of destinationStats.values())
    closeConnection(stat, reportEnd);
  const denominatorMs = Math.max(0, reportEnd - from);
  const destinationMetrics = [...destinationStats].map(
    ([destinationId, stat]) => {
      const sample = samples.find(
        (row) => row.destination_id === destinationId,
      );
      return {
        destinationId,
        name: stat.name,
        averageFps:
          !sample || sample.fps === null
            ? null
            : Math.round(sample.fps * 10) / 10,
        averageBitrateKbps:
          !sample || sample.bitrate === null
            ? null
            : Math.round(sample.bitrate),
        samples: sample?.samples || 0,
        uptimeSeconds: Math.round(stat.uptimeMs / 1000),
        uptimePercent:
          denominatorMs > 0
            ? Math.round((stat.uptimeMs / denominatorMs) * 1000) / 10
            : null,
        failedConnections: stat.failedConnections,
        connectionSessions: stat.connectionSessions,
      };
    },
  );
  const totalSeconds = inPeriod.reduce(
    (sum, session) => sum + session.durationSeconds,
    0,
  );
  const eventCount = store.db
    .prepare("SELECT COUNT(*) AS count FROM events WHERE time>=? AND time<?")
    .get(fromIso, toIso) as { count: number };
  return {
    from: fromIso,
    to: toIso,
    sessions: inPeriod,
    summary: {
      streamingHours: Math.round(totalSeconds / 360) / 10,
      sessions: inPeriod.length,
      failedOutputs: failures,
      reconnects,
      failedSchedules: schedulesFailed,
      events: eventCount.count,
    },
    destinations: destinationMetrics,
  };
}

function csvCell(input: unknown) {
  let value = String(input ?? "");
  if (/^[\s]*[=+@\-\t\r]/.test(value)) value = `'${value}`;
  return `"${value.replaceAll('"', '""')}"`;
}
export function reportCsv(data: ReturnType<typeof report>) {
  const columns = [
    "stream",
    "stream_id",
    "started_at_utc",
    "stopped_at_utc",
    "duration_seconds",
  ];
  return (
    [
      columns.join(","),
      ...data.sessions.map((session) =>
        [
          session.stream,
          session.streamId,
          session.startedAt,
          session.stoppedAt || "RUNNING",
          Math.round(session.durationSeconds),
        ]
          .map(csvCell)
          .join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}
