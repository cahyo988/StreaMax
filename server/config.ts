import { z } from "zod";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function configuration(env = process.env) {
  const parsed = z
    .object({
      HOST: z.string().default("127.0.0.1"),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      APP_ORIGIN: z.url().default("http://127.0.0.1:5173"),
      DATA_DIR: z.string().default("./data"),
      BACKUP_DIR: z
        .string()
        .default("")
        .refine(
          (value) => !value || isAbsolute(value),
          "BACKUP_DIR must be absolute",
        ),
      ADMIN_EMAIL: z.email(),
      ADMIN_PASSWORD: z.string().min(12),
      ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
      COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
      MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(102400).default(1024),
      MAX_OUTPUTS: z.coerce.number().int().min(1).max(32).default(4),
      FFMPEG_PATH: z.string().default("ffmpeg"),
      FFPROBE_PATH: z.string().default("ffprobe"),
      STREAM_PRESET: z
        .enum(["ultrafast", "superfast", "veryfast"])
        .default("ultrafast"),
    })
    .parse(env);
  const dataDir = resolve(parsed.DATA_DIR);
  const backupDir = parsed.BACKUP_DIR ? resolve(parsed.BACKUP_DIR) : "";
  if (backupDir) {
    const relativeBackup = relative(dataDir, backupDir);
    if (
      relativeBackup === "" ||
      (relativeBackup !== ".." && !relativeBackup.startsWith(`..${sep}`))
    )
      throw new Error("BACKUP_DIR must be outside DATA_DIR");
  }
  return { ...parsed, DATA_DIR: dataDir, BACKUP_DIR: backupDir };
}
export type Config = ReturnType<typeof configuration>;
