import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { probeDestination } from "../server/destination-probe.ts";

test("destination probe opens only the configured RTMP TCP endpoint", async () => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    assert.deepEqual(
      await probeDestination(`rtmp://127.0.0.1:${address.port}/live`, 1000),
      { transport: "tcp" },
    );
    await assert.rejects(probeDestination("https://example.com/live"));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
