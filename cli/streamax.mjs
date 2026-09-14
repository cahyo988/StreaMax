#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const usage = `Usage:
  npm run cli -- streams list
  npm run cli -- streams start <id>
  npm run cli -- streams stop <id>
  npm run cli -- streams restart <id>

Set STREAMAX_API_URL to the StreaMax API base (for example https://studio.example/api)
and STREAMAX_API_KEY to an admin-issued key with the required read/write permission.`;

export async function runCli(
  args,
  {
    env = process.env,
    fetchImpl = fetch,
    stdout = (value) => console.log(value),
    stderr = (value) => console.error(value),
  } = {},
) {
  const [resource, action, id] = args;
  if (
    resource !== "streams" ||
    !["list", "start", "stop", "restart"].includes(action) ||
    (action !== "list" && !id)
  ) {
    stderr(usage);
    return 2;
  }
  const base = env.STREAMAX_API_URL?.replace(/\/+$/, "");
  const apiKey = env.STREAMAX_API_KEY;
  if (!base || !apiKey) {
    stderr("STREAMAX_API_URL and STREAMAX_API_KEY are required.");
    return 2;
  }
  if (
    !/^https:\/\//i.test(base) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(base)
  ) {
    stderr("The API URL must use HTTPS (HTTP is allowed only for localhost).");
    return 2;
  }
  const endpoint =
    action === "list"
      ? `${base}/streams`
      : `${base}/streams/${encodeURIComponent(id)}/${action}`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: action === "list" ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(action === "list" ? {} : { "Content-Type": "application/json" }),
      },
      ...(action === "list" ? {} : { body: "{}" }),
    });
  } catch {
    stderr("Could not connect to the StreaMax API.");
    return 1;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    stderr(body?.error || `StreaMax API returned HTTP ${response.status}.`);
    return 1;
  }
  stdout(JSON.stringify(body, null, 2));
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
