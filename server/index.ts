import { existsSync } from "node:fs";
import { configuration } from "./config.ts";
import { buildApp } from "./app.ts";
import { diagnostics, startupError } from "./diagnostics.ts";

try {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = configuration();
  const failed = (await diagnostics(config)).filter((check) => !check.ok);
  if (failed.length) {
    console.error(
      `Startup checks failed:\n${failed.map((check) => `${check.name}: ${check.message}`).join("\n")}`,
    );
    process.exitCode = 1;
    process.exit();
  }
  const { app } = await buildApp(config, { logger: true });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  // Validation may contain secret input: never serialize the environment.
  console.error(
    "StreaMax could not start. Check .env, data permissions and port availability.",
  );
  console.error(startupError(error));
  process.exitCode = 1;
}
