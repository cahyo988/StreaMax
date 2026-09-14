import { existsSync } from "node:fs";
import { configuration } from "../server/config.ts";
import { diagnostics, startupError } from "../server/diagnostics.ts";

try {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const checks = await diagnostics(configuration());
  for (const check of checks) console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
} catch (error) {
  console.error(startupError(error));
  process.exitCode = 1;
}
