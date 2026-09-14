import { test } from "node:test";
import assert from "node:assert/strict";
import { report, reportCsv } from "../server/analytics.ts";
import { fixture, seed } from "./helpers.ts";

test("analytics derives stream sessions and sampled destination performance", async () => {
  const f = await fixture();
  try {
    const { stream, destination } = seed(f);
    const from = new Date(Date.now() - 60 * 60_000);
    const start = new Date(from.getTime() + 5 * 60_000);
    const stop = new Date(start.getTime() + 10 * 60_000);
    const recent = new Date(from.getTime() + 20 * 60_000);
    f.store.event("admin@example.com", "stream.start", stream.id, stream.name);
    f.store.db
      .prepare("UPDATE events SET time=? WHERE action='stream.start'")
      .run(start.toISOString());
    f.store.event("worker", "output.retry", stream.id, "reconnected");
    f.store.db
      .prepare("UPDATE events SET time=? WHERE action='output.retry'")
      .run(recent.toISOString());
    f.store.event("admin@example.com", "stream.stop", stream.id, stream.name);
    f.store.db
      .prepare("UPDATE events SET time=? WHERE action='stream.stop'")
      .run(stop.toISOString());
    const connectionStart = new Date(from.getTime() + 5 * 60_000);
    const connectionStop = new Date(from.getTime() + 35 * 60_000);
    f.store.event(
      "worker",
      "destination.connection.start",
      destination.id,
      destination.name,
    );
    f.store.db
      .prepare(
        "UPDATE events SET time=? WHERE action='destination.connection.start'",
      )
      .run(connectionStart.toISOString());
    f.store.event(
      "worker",
      "destination.connection.stop",
      destination.id,
      destination.name,
    );
    f.store.db
      .prepare(
        "UPDATE events SET time=? WHERE action='destination.connection.stop'",
      )
      .run(connectionStop.toISOString());
    f.store.event(
      "worker",
      "analytics.destination.failure",
      destination.id,
      destination.name,
    );
    f.store.metric(
      stream.id,
      destination.id,
      29.8,
      "3200.4kbits/s",
      "00:04:12.000",
    );
    const result = report(
      f.store,
      from.toISOString(),
      new Date(Date.now() + 1000).toISOString(),
    );
    assert.equal(result.summary.sessions, 1);
    assert.equal(result.summary.streamingHours, 0.2);
    assert.equal(result.summary.reconnects, 1);
    assert.equal(result.sessions[0].durationSeconds, 600);
    assert.equal(result.destinations[0].averageFps, 29.8);
    assert.equal(result.destinations[0].averageBitrateKbps, 3200);
    assert.equal(result.destinations[0].samples, 1);
    assert.equal(result.destinations[0].uptimeSeconds, 1800);
    assert.ok(result.destinations[0].uptimePercent! > 49.9);
    assert.ok(result.destinations[0].uptimePercent! < 50.1);
    assert.equal(result.destinations[0].failedConnections, 1);
    assert.equal(result.destinations[0].connectionSessions, 1);
  } finally {
    await f.cleanup();
  }
});

test("analytics caps ranges and protects CSV cells from spreadsheet formulas", async () => {
  const f = await fixture();
  try {
    const { stream } = seed(f);
    f.store.save("streams", {
      ...stream,
      name: '=HYPERLINK("https://bad.example")',
    });
    assert.throws(
      () =>
        report(f.store, new Date(0).toISOString(), new Date().toISOString()),
      /366 days/,
    );
    assert.throws(
      () =>
        report(f.store, new Date().toISOString(), new Date(0).toISOString()),
      /366 days/,
    );
    const now = new Date();
    f.store.event("admin", "stream.start", stream.id, "formula stream");
    f.store.event("admin", "stream.stop", stream.id, "formula stream");
    const csv = reportCsv(
      report(
        f.store,
        new Date(now.getTime() - 1000).toISOString(),
        new Date(now.getTime() + 1000).toISOString(),
      ),
    );
    assert.match(csv, /'=HYPERLINK/);
    assert.ok(!csv.includes("\n=HYPERLINK"));
  } finally {
    await f.cleanup();
  }
});

test("analytics API validates dates and sends a CSV attachment", async () => {
  const f = await fixture();
  try {
    const { stream } = seed(f);
    f.store.event("admin", "stream.start", stream.id, stream.name);
    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    assert.equal(
      (await f.request("GET", `analytics?from=${from}&to=${to}`)).json().summary
        .sessions,
      1,
    );
    const csv = await f.request("GET", `analytics.csv?from=${from}&to=${to}`);
    assert.match(String(csv.headers["content-type"]), /text\/csv/);
    assert.match(
      String(csv.headers["content-disposition"]),
      /filename="streamax-sessions-/,
    );
    assert.match(csv.body, /"Stream"/);
    assert.equal(
      (await f.request("GET", "analytics?from=invalid&to=invalid")).statusCode,
      400,
    );
  } finally {
    await f.cleanup();
  }
});
