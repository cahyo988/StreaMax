import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalTimeZone,
  dateTimeLocalToInstant,
  instantToDateTimeLocal,
} from "../shared/timezone.ts";

test("workspace timezone converts local wall time to UTC and back", () => {
  const zone = canonicalTimeZone("Asia/Jakarta");
  const instant = dateTimeLocalToInstant("2026-09-15T18:45", zone);
  assert.equal(instant, "2026-09-15T11:45:00.000Z");
  assert.equal(instantToDateTimeLocal(instant, zone), "2026-09-15T18:45");
});

test("timezone conversion rejects invalid calendar dates and DST gaps", () => {
  assert.throws(
    () => dateTimeLocalToInstant("2026-02-30T12:00", "UTC"),
    /valid calendar date/,
  );
  assert.throws(
    () => dateTimeLocalToInstant("2025-03-09T02:30", "America/New_York"),
    /daylight-saving transition/,
  );
});

test("ambiguous fall-back wall time chooses the earlier instant", () => {
  assert.equal(
    dateTimeLocalToInstant("2025-11-02T01:30", "America/New_York"),
    "2025-11-02T05:30:00.000Z",
  );
});
