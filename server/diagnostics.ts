import { constants } from "node:fs";
import { access, mkdir, statfs } from "node:fs/promises";
import { run } from "./media.ts";
import type { Config } from "./config.ts";
import { ZodError } from "zod";
import { createConnection } from "node:net";

export function startupError(error: unknown): string {
  if (error instanceof ZodError)
    return error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE")
    return "PORT is already in use. Stop the other server or choose another PORT and update the Vite proxy.";
  if (code === "EACCES" || code === "EPERM")
    return "Access denied. Check DATA_DIR permissions and the listening port.";
  return "Startup failed. Run npm run doctor to check configuration, storage and FFmpeg.";
}

export async function diagnostics(config: Config) {
  const checks: { name: string; ok: boolean; message: string }[] = [];
  for (const [name, binary] of [
    ["FFmpeg", config.FFMPEG_PATH],
    ["FFprobe", config.FFPROBE_PATH],
  ]) {
    try {
      const version = await run(binary, ["-version"], 5000);
      checks.push({ name, ok: true, message: version.split("\n")[0] });
    } catch {
      checks.push({
        name,
        ok: false,
        message: `Executable unavailable. Check ${name === "FFmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"}.`,
      });
    }
  }
  try {
    await mkdir(config.DATA_DIR, { recursive: true });
    await access(config.DATA_DIR, constants.R_OK | constants.W_OK);
    const disk = await statfs(config.DATA_DIR);
    checks.push({
      name: "Storage",
      ok: disk.bavail * disk.bsize > 100 * 1024 * 1024,
      message: `${Math.floor((disk.bavail * disk.bsize) / 1024 / 1024)} MB available`,
    });
  } catch {
    checks.push({
      name: "Storage",
      ok: false,
      message: "DATA_DIR must be readable and writable.",
    });
  }
  checks.push({
    name: "Browser origin",
    ok: true,
    message: `Open ${config.APP_ORIGIN}; hostname, protocol and port must match exactly.`,
  });
  checks.push(
    await new Promise((resolve) => {
      const socket = createConnection({
        host:
          config.HOST === "0.0.0.0" || config.HOST === "::"
            ? "127.0.0.1"
            : config.HOST,
        port: config.PORT,
      });
      const finish = (check: {
        name: string;
        ok: boolean;
        message: string;
      }) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(check);
      };
      const timer = setTimeout(
        () =>
          finish({
            name: "API port",
            ok: false,
            message: `Could not check port ${config.PORT}; verify it is available.`,
          }),
        500,
      );
      socket.once("connect", () =>
        finish({
          name: "API port",
          ok: false,
          message: `Port ${config.PORT} already accepts connections; stop the other server or choose another port.`,
        }),
      );
      socket.once("error", (error: NodeJS.ErrnoException) =>
        finish(
          error.code === "ECONNREFUSED"
            ? {
                name: "API port",
                ok: true,
                message: `Port ${config.PORT} appears available`,
              }
            : {
                name: "API port",
                ok: false,
                message: `Could not check port ${config.PORT}; verify network permissions.`,
              },
        ),
      );
    }),
  );
  return checks;
}
