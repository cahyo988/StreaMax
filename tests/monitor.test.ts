import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNetworkCounters } from "../server/monitor.ts";

test("Linux network counters sum receive and transmit bytes across interfaces", () => {
  const counters = parseNetworkCounters(`Inter-| Receive | Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
    lo: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0
  eth0: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0
broken: not-a-counter
`);
  assert.deepEqual(counters, { received: 400, sent: 600 });
});

test("network parser safely treats empty and malformed input as zero", () => {
  assert.deepEqual(parseNetworkCounters(""), { received: 0, sent: 0 });
});
