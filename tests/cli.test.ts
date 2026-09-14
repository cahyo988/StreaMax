import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../cli/streamax.mjs";

test("CLI lists streams with a read-scoped bearer key", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const output: string[] = [];
  const result = await runCli(["streams", "list"], {
    env: {
      STREAMAX_API_URL: "https://studio.example/api/",
      STREAMAX_API_KEY: "private-cli-key",
    },
    fetchImpl: async (input, init) => {
      request = { url: String(input), init: init || {} };
      return new Response(JSON.stringify([{ id: "stream-1", name: "Daily" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    stdout: (value) => output.push(value),
    stderr: (value) => output.push(value),
  });
  assert.equal(result, 0);
  assert.equal(request?.url, "https://studio.example/api/streams");
  assert.equal(request?.init.method, "GET");
  assert.equal(
    (request?.init.headers as Record<string, string>).Authorization,
    "Bearer private-cli-key",
  );
  assert.match(output[0], /Daily/);
  assert.equal(output.join(" ").includes("private-cli-key"), false);
});

test("CLI controls streams and rejects unsafe or incomplete configuration", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const settings = {
    env: {
      STREAMAX_API_URL: "http://localhost:3100/api",
      STREAMAX_API_KEY: "private-cli-key",
    },
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(input), init: init || {} };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    stdout: () => {},
    stderr: () => {},
  };
  assert.equal(
    await runCli(["streams", "restart", "id/with slash"], settings),
    0,
  );
  assert.equal(
    request?.url,
    "http://localhost:3100/api/streams/id%2Fwith%20slash/restart",
  );
  assert.equal(request?.init.method, "POST");
  assert.equal(await runCli(["streams", "start"], settings), 2);
  assert.equal(
    await runCli(["streams", "list"], {
      ...settings,
      env: { ...settings.env, STREAMAX_API_URL: "http://evil.example/api" },
    }),
    2,
  );
});
