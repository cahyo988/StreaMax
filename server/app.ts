import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
} from "node:fs";
import {
  readFile,
  copyFile,
  lstat,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
  stat,
  statfs,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { cpus, freemem, totalmem, uptime, loadavg } from "node:os";
import { z, ZodError } from "zod";
import type { Config } from "./config.ts";
import { Store, type Kind, type Entity } from "./store.ts";
import { Engine } from "./engine.ts";
import {
  hashPassword,
  verifyPassword,
  encrypt,
  tokenHash,
} from "./security.ts";
import { normalize, inspectMedia, needsTranscode } from "./media.ts";
import { MediaQueue } from "./media-queue.ts";
import { EncoderSlot } from "./encoder-slot.ts";
import {
  Notifications,
  alertEvents,
  type AlertEvent,
} from "./notifications.ts";
import { report, reportCsv } from "./analytics.ts";
import { readNetworkCounters, readTemperatureC } from "./monitor.ts";
import { canonicalTimeZone } from "../shared/timezone.ts";
import { openApiDocument, swaggerUiDocument } from "./openapi.ts";
import {
  probeDestination,
  type DestinationProbeResult,
} from "./destination-probe.ts";
import { Webhooks, webhookEvents, type WebhookRequest } from "./webhooks.ts";
import { diagnostics } from "./diagnostics.ts";
import { scheduleOccurrences } from "./recurrence.ts";
import { registerUploads } from "./uploads.ts";
import { ThresholdMonitor } from "./thresholds.ts";

type User = { id: string; email: string; role: string; csrf: string };
type ApiKey = { id: string; permissions: string[] };
type ResourceKind = Exclude<Kind, "notifications" | "settings">;
declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    apiKey: ApiKey | null;
  }
}
const id = z.uuid();
const name = z.string().trim().min(1).max(120);
const MAX_WORKSPACE_LOGO_BYTES = 1024 * 1024;
function pngLogoDimensions(image: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    image.length > MAX_WORKSPACE_LOGO_BYTES ||
    image.length < 45 ||
    !image.subarray(0, 8).equals(signature)
  )
    throw problem("Choose a valid PNG logo smaller than 1 MB");
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let dataEnded = false;
  let sawEnd = false;
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  while (offset < image.length) {
    if (offset + 12 > image.length) throw problem("PNG logo is truncated");
    const length = image.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (length > MAX_WORKSPACE_LOGO_BYTES || chunkEnd > image.length)
      throw problem("PNG logo contains an invalid chunk");
    const type = image.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type))
      throw problem("PNG logo contains an invalid chunk");
    if (
      crc32(image.subarray(typeStart, dataEnd)) !== image.readUInt32BE(dataEnd)
    )
      throw problem("PNG logo checksum is invalid");
    const chunk = image.subarray(dataStart, dataEnd);
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13)
        throw problem("PNG logo header is invalid");
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const bitDepth = chunk[8];
      const colorType = chunk[9];
      if (
        !width ||
        !height ||
        width > 2048 ||
        height > 1024 ||
        width * height > 4_194_304 ||
        bitDepth !== 8 ||
        ![2, 3, 6].includes(colorType) ||
        chunk[10] !== 0 ||
        chunk[11] !== 0 ||
        chunk[12] > 1
      )
        throw problem("PNG logo dimensions or color format are not supported");
      sawHeader = true;
    } else if (type === "IHDR") {
      throw problem("PNG logo has multiple headers");
    }
    if (["acTL", "fcTL", "fdAT"].includes(type))
      throw problem("Animated PNG logos are not supported");
    if (type === "IDAT") {
      if (dataEnded) throw problem("PNG image data is not contiguous");
      sawData = true;
    } else if (sawData && type !== "IEND") {
      dataEnded = true;
    }
    if (
      type[0] === type[0].toUpperCase() &&
      !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)
    )
      throw problem("PNG logo uses an unsupported critical chunk");
    if (type === "IEND") {
      if (length !== 0 || !sawData || chunkEnd !== image.length)
        throw problem("PNG logo end marker is invalid");
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!sawEnd) throw problem("PNG logo is incomplete");
  return { width, height };
}
const uniqueIds = z
  .array(id)
  .min(1)
  .max(100)
  .refine(
    (v) => new Set(v).size === v.length,
    "Duplicate items are not allowed",
  );
const schemas = {
  playlists: z.object({ name, videoIds: z.array(id).min(1).max(500) }),
  profiles: z.object({
    name,
    width: z
      .number()
      .int()
      .min(320)
      .max(1920)
      .refine((v) => v % 2 === 0),
    height: z
      .number()
      .int()
      .min(240)
      .max(1080)
      .refine((v) => v % 2 === 0),
    fps: z.number().int().min(15).max(60),
    bitrate: z.number().int().min(300).max(12000),
    audioBitrate: z.number().int().min(64).max(320),
  }),
  destinations: z.object({
    name,
    platform: z.enum(["YouTube", "Facebook", "Twitch", "Custom"]),
    url: z
      .string()
      .max(500)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["rtmp:", "rtmps:"].includes(url.protocol) &&
            Boolean(url.hostname) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            !/[\s'"\\]/.test(value)
          );
        } catch {
          return false;
        }
      }, "Use an RTMP(S) ingest URL without credentials, query or fragment"),
    key: z
      .string()
      .min(1)
      .max(500)
      .regex(/^[^\s]+$/)
      .optional(),
    enabled: z.boolean().default(true),
  }),
  streams: z.object({
    name,
    playlistId: id,
    profileId: id,
    destinationIds: uniqueIds,
    loop: z.boolean().default(true),
    playCount: z.number().int().min(2).max(1000).optional(),
    overlayText: z.string().max(200).default(""),
    watermark: z.boolean().default(false),
    overlayPosition: z
      .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
      .default("top-left"),
    livePreview: z.boolean().default(false),
  }),
  schedules: z.object({
    name,
    streamId: id,
    startAt: z.iso.datetime({ offset: true }),
    endAt: z.iso.datetime({ offset: true }),
    recurrence: z.enum(["none", "daily", "weekly"]).default("none"),
    occurrences: z.number().int().min(1).max(366).default(1),
    playlistId: id.optional(),
  }),
};
const problem = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });

export async function buildApp(
  config: Config,
  options: {
    startEngine?: boolean;
    logger?: boolean;
    notificationFetch?: typeof fetch;
    destinationProbe?: (address: string) => Promise<DestinationProbeResult>;
    webhookRequest?: WebhookRequest;
    availableDiskBytes?: () => Promise<number>;
    mediaNormalizer?: typeof normalize;
  } = {},
) {
  const store = new Store(config.DATA_DIR, config.ENCRYPTION_KEY);
  await store.bootstrap(config);
  const encoderSlot = new EncoderSlot();
  const engine = new Engine(store, config, encoderSlot);
  const thresholds = new ThresholdMonitor(store, config.DATA_DIR);
  const notifications = new Notifications(
    store,
    config.ENCRYPTION_KEY,
    options.notificationFetch,
  );
  const webhooks = new Webhooks(
    store,
    config.ENCRYPTION_KEY,
    options.webhookRequest,
  );
  const testDestination = options.destinationProbe ?? probeDestination;
  const normalizeMedia = options.mediaNormalizer ?? normalize;
  const availableDiskBytes =
    options.availableDiskBytes ??
    (async () => {
      const disk = await statfs(config.DATA_DIR);
      return disk.bavail * disk.bsize;
    });
  store.onEvent = (actor, action, resource, message) => {
    void notifications.notify(action, actor, resource, message);
    void webhooks.notify(action, actor, resource, message);
  };
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 65 * 60 * 1000,
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "StreaMax API",
        version: "0.1.0",
      },
      servers: [{ url: "/api" }],
    },
  });
  const mediaDir = join(config.DATA_DIR, "media");
  const uploadDir = join(config.DATA_DIR, "uploads");
  const logoPath = join(config.DATA_DIR, "workspace-logo.png");
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(uploadDir, { recursive: true });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_MB * 1024 * 1024,
      files: 1,
      fields: 2,
      parts: 3,
    },
  });
  await app.register(staticFiles, {
    root: mediaDir,
    prefix: "/api/media/",
    decorateReply: true,
    serve: false,
  });
  const backupDirectory = async () => {
    try {
      const [dataRoot, backupRoot] = await Promise.all([
        realpath(config.DATA_DIR),
        realpath(config.BACKUP_DIR),
      ]);
      const fromData = relative(dataRoot, backupRoot);
      if (
        fromData === "" ||
        (fromData !== ".." && !fromData.startsWith(`..${sep}`))
      )
        throw problem("BACKUP_DIR must resolve outside DATA_DIR", 503);
      return backupRoot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return config.BACKUP_DIR;
      throw error;
    }
  };
  app.decorateRequest("user", null);
  app.decorateRequest("apiKey", null);
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
    );
    if (
      !req.routeOptions.url?.startsWith("/api/") &&
      !req.url.startsWith("/api/")
    )
      return;
    reply.header("Cache-Control", "no-store");
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const path = req.url.split("?")[0];
    if (
      write &&
      req.headers.origin !== new URL(config.APP_ORIGIN).origin &&
      !req.headers.authorization
    )
      throw problem("Request origin is not allowed", 403);
    if (
      path === "/api/login" ||
      path === "/api/health" ||
      (path === "/api/branding/logo" && !write)
    )
      return;
    const authorization = req.headers.authorization;
    if (authorization) {
      const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
      if (!bearer) throw problem("Invalid API key", 401);
      const key = store.db
        .prepare(
          "SELECT api_keys.id,api_keys.user_id,api_keys.permissions,users.email,users.role FROM api_keys JOIN users ON users.id=api_keys.user_id WHERE api_keys.token_hash=? AND api_keys.revoked_at IS NULL AND (api_keys.expires_at IS NULL OR api_keys.expires_at>?) AND users.active=1",
        )
        .get(tokenHash(bearer), Date.now()) as any;
      if (!key) throw problem("Invalid or expired API key", 401);
      req.apiKey = {
        id: key.id,
        permissions: JSON.parse(key.permissions),
      };
      req.user = {
        id: key.user_id,
        email: key.email,
        role: key.role,
        csrf: "",
      };
      if (!req.apiKey.permissions.includes(write ? "write" : "read"))
        throw problem("API key does not have permission for this request", 403);
      if (["/api/logout", "/api/password"].includes(path))
        throw problem("This operation requires an interactive session", 403);
    } else {
      const token = req.cookies.session;
      const row =
        token &&
        store.db
          .prepare(
            "SELECT users.id,users.email,users.role,sessions.csrf FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND active=1",
          )
          .get(tokenHash(token), Date.now());
      if (!row) throw problem("Please sign in", 401);
      req.user = row as User;
    }
    if (write && !req.apiKey && req.headers["x-csrf-token"] !== req.user!.csrf)
      throw problem("Session security token is missing or expired", 403);
    const maintenanceWriteAllowed =
      ["/api/logout", "/api/password"].includes(path) ||
      /^\/api\/streams\/[^/]+\/stop$/.test(path);
    if (
      write &&
      req.user.role === "viewer" &&
      !["/api/logout", "/api/password"].includes(path)
    )
      throw problem("Viewers cannot modify resources", 403);
    const systemSettings = store.get("settings", "system");
    if (
      write &&
      systemSettings?.maintenanceMode &&
      req.user.role !== "admin" &&
      !maintenanceWriteAllowed
    )
      throw problem("The workspace is in maintenance mode", 503);
  });
  app.setErrorHandler((error, req, reply) => {
    const code =
      error instanceof ZodError
        ? 400
        : (error as Error & { statusCode?: number }).statusCode || 500;
    if (
      req.method !== "GET" &&
      req.url !== "/api/login" &&
      req.url.startsWith("/api/")
    ) {
      store.event(
        req.user?.email || "anonymous",
        "request.failed",
        req.routeOptions.url || "unmatched",
        "Request rejected",
        req.ip,
        "failure",
        { method: req.method, statusCode: code },
      );
    }
    if (error instanceof ZodError)
      return reply.code(code).send({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    const e = error as Error & { statusCode?: number; code?: string };
    if (code >= 500) app.log.error({ code: e.code }, "Request failed");
    return reply.code(code).send({
      error:
        code >= 500
          ? "Operation failed. Check server configuration and available storage."
          : e.message,
    });
  });
  await app.register(swaggerUi, {
    routePrefix: "/api/docs",
    validatorUrl: false,
    transformSpecification: (_specification, request) =>
      swaggerUiDocument(
        `${request.protocol}://${request.host}/api`,
        request.user?.csrf,
      ),
    uiConfig: {
      deepLinking: true,
      docExpansion: "list",
      displayRequestDuration: true,
      withCredentials: true,
      requestInterceptor: async (request) => {
        if (
          ["post", "put", "patch", "delete"].includes(
            (request.method || "get").toLowerCase(),
          )
        ) {
          const response = await fetch("/api/docs/json", {
            credentials: "same-origin",
            cache: "no-store",
          });
          if (response.ok) {
            const definition = await response.json();
            const csrfToken = definition.info["x-csrf-token"];
            if (csrfToken) request.headers["X-CSRF-Token"] = csrfToken;
          }
        }
        return request;
      },
    },
  });
  app.get("/api/health", async () => ({
    status: "ok",
    applicationName:
      store.get("settings", "system")?.applicationName || "StreaMax",
    logoAvailable: existsSync(logoPath),
    logoVersion: store.get("settings", "branding")?.logoUpdatedAt || "",
  }));
  app.get("/api/openapi.json", async () => openApiDocument);
  app.get("/api/branding/logo", async (_req, reply) => {
    if (!existsSync(logoPath))
      throw problem("Workspace logo is not configured", 404);
    return reply
      .type("image/png")
      .header("Cache-Control", "public, max-age=300")
      .send(await readFile(logoPath));
  });
  app.get("/api/backups", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    if (!config.BACKUP_DIR) return { configured: false, backups: [] };
    const root = await backupDirectory();
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { configured: true, backups: [] };
      throw error;
    }
    const backups = [];
    for (const name of entries) {
      if (!/^streamax-\d{8}T\d{6}Z-\d+\.tar\.gz$/.test(name)) continue;
      const path = join(root, name);
      try {
        const info = await lstat(path);
        if (info.isFile())
          backups.push({
            name,
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    backups.sort((a, b) => b.name.localeCompare(a.name));
    return { configured: true, backups: backups.slice(0, 100) };
  });
  app.get<{ Params: { name: string } }>(
    "/api/backups/:name",
    async (req, reply) => {
      if (req.user!.role !== "admin")
        throw problem("Admin access required", 403);
      if (!config.BACKUP_DIR)
        throw problem("Set BACKUP_DIR to enable backup downloads", 503);
      const name = req.params.name;
      if (
        !/^streamax-\d{8}T\d{6}Z-\d+\.tar\.gz$/.test(name) ||
        basename(name) !== name
      )
        throw problem("Backup archive not found", 404);
      const path = join(await backupDirectory(), name);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw problem("Backup archive not found", 404);
        throw error;
      }
      if (!info.isFile()) throw problem("Backup archive not found", 404);
      store.event(req.user!.email, "backup.downloaded", "backup", name, req.ip);
      return reply
        .type("application/gzip")
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", `attachment; filename="${name}"`)
        .send(createReadStream(path));
    },
  );
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          email: z.email(),
          password: z.string().min(1).max(256),
          remember: z.boolean().default(false),
        })
        .parse(req.body);
      const user = store.db
        .prepare("SELECT * FROM users WHERE email=? AND active=1")
        .get(body.email.toLowerCase()) as any;
      // Use a real hash for both paths so missing users still incur password work.
      const fallback = store.db
        .prepare("SELECT password FROM users LIMIT 1")
        .get()!.password as string;
      const valid = await verifyPassword(
        body.password,
        user?.password || fallback,
      );
      if (!user || !valid) {
        store.event(
          "anonymous",
          "auth.failed",
          "",
          "Invalid credentials",
          req.ip,
          "failure",
        );
        throw problem("Invalid email or password", 401);
      }
      const token = randomBytes(32).toString("hex");
      const csrf = randomBytes(24).toString("hex");
      const lifetime = (body.remember ? 30 * 24 : 12) * 60 * 60;
      store.db
        .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
        .run(tokenHash(token), user.id, csrf, Date.now() + lifetime * 1000);
      store.db
        .prepare("UPDATE users SET last_login=? WHERE id=?")
        .run(new Date().toISOString(), user.id);
      reply.setCookie("session", token, {
        httpOnly: true,
        sameSite: "strict",
        secure: config.COOKIE_SECURE === "true",
        path: "/",
        maxAge: lifetime,
      });
      store.event(user.email, "auth.login", user.id, "", req.ip);
      return { id: user.id, email: user.email, role: user.role, csrf };
    },
  );
  app.get("/api/me", async (req) => req.user);
  app.post("/api/logout", async (req, reply) => {
    store.db
      .prepare("DELETE FROM sessions WHERE token=?")
      .run(tokenHash(req.cookies.session!));
    reply.clearCookie("session", { path: "/" });
    store.event(req.user!.email, "auth.logout", req.user!.id, "", req.ip);
    return { ok: true };
  });
  app.post("/api/password", async (req) => {
    const body = z
      .object({
        currentPassword: z.string().max(256),
        password: z.string().min(12).max(256),
      })
      .parse(req.body);
    const user = store.db
      .prepare("SELECT password FROM users WHERE id=?")
      .get(req.user!.id)!;
    if (!(await verifyPassword(body.currentPassword, user.password as string)))
      throw problem("Current password is incorrect");
    store.db
      .prepare("UPDATE users SET password=? WHERE id=?")
      .run(await hashPassword(body.password), req.user!.id);
    store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user!.id);
    store.event(
      req.user!.email,
      "auth.password_changed",
      req.user!.id,
      "",
      req.ip,
      "success",
      { sessionsRevoked: true },
    );
    return { ok: true };
  });
  app.get("/api/notifications", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    return notifications.get();
  });
  app.get("/api/settings", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    const settings = store.get("settings", "system");
    const profiles = store.list("profiles");
    return {
      applicationName: settings?.applicationName || "StreaMax",
      maintenanceMode: Boolean(settings?.maintenanceMode),
      defaultProfileId:
        profiles.find((profile) => profile.id === settings?.defaultProfileId)
          ?.id ||
        profiles[0]?.id ||
        "",
      defaultBitrate: settings?.defaultBitrate || 2500,
      retryAttempts: settings?.retryAttempts ?? 5,
      videoRetentionDays: settings?.videoRetentionDays ?? 0,
      thresholdAlerts: settings?.thresholdAlerts ?? false,
      cpuThreshold: settings?.cpuThreshold ?? 90,
      diskThreshold: settings?.diskThreshold ?? 90,
      timeZone: canonicalTimeZone(
        settings?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
      logoAvailable: existsSync(logoPath),
      logoUpdatedAt: store.get("settings", "branding")?.logoUpdatedAt || "",
    };
  });
  app.put("/api/settings", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    const body = z
      .object({
        applicationName: name,
        maintenanceMode: z.boolean(),
        defaultProfileId: z.string().max(64),
        defaultBitrate: z.number().int().min(300).max(12000),
        retryAttempts: z.number().int().min(0).max(10),
        videoRetentionDays: z.number().int().min(0).max(3650),
        thresholdAlerts: z.boolean().default(false),
        cpuThreshold: z.number().int().min(10).max(100).default(90),
        diskThreshold: z.number().int().min(10).max(100).default(90),
        timeZone: z.string().trim().min(1).max(100),
      })
      .parse(req.body);
    try {
      body.timeZone = canonicalTimeZone(body.timeZone);
    } catch {
      throw problem("Choose a valid IANA time zone");
    }
    if (body.defaultProfileId && !store.get("profiles", body.defaultProfileId))
      throw problem("Choose an existing encoding profile");
    store.save("settings", {
      id: "system",
      name: body.applicationName,
      ...body,
    });
    store.event(
      req.user!.email,
      "system.settings_updated",
      "system",
      "",
      req.ip,
      "success",
      body,
    );
    return body;
  });
  app.put("/api/branding/logo", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    const file = await req.file();
    if (!file || file.fieldname !== "file" || file.mimetype !== "image/png")
      throw problem("Upload one PNG image in the file field");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.file) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_WORKSPACE_LOGO_BYTES) {
        file.file.destroy();
        throw problem("Workspace logo must be smaller than 1 MB", 413);
      }
      chunks.push(bytes);
    }
    const image = Buffer.concat(chunks, size);
    const dimensions = pngLogoDimensions(image);
    const temporaryPath = join(
      config.DATA_DIR,
      `.workspace-logo-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, image, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, logoPath);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
    const logoUpdatedAt = new Date().toISOString();
    store.save("settings", {
      id: "branding",
      name: "Workspace branding",
      logoUpdatedAt,
    });
    store.event(
      req.user!.email,
      "workspace.logo_updated",
      "branding",
      "",
      req.ip,
      "success",
      dimensions,
    );
    return { logoAvailable: true, logoUpdatedAt };
  });
  app.delete("/api/branding/logo", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    try {
      await unlink(logoPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    store.save("settings", {
      id: "branding",
      name: "Workspace branding",
      logoUpdatedAt: "",
    });
    store.event(
      req.user!.email,
      "workspace.logo_removed",
      "branding",
      "",
      req.ip,
    );
    return { logoAvailable: false, logoUpdatedAt: "" };
  });
  app.put("/api/notifications", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    const body = z
      .object({
        provider: z.enum(["discord", "telegram"]),
        target: z.string().trim().max(128).default(""),
        secret: z.string().max(300).optional(),
        enabled: z.boolean(),
        events: z.array(z.enum(alertEvents)).max(alertEvents.length),
      })
      .parse(req.body);
    try {
      const result = notifications.save(
        body as {
          provider: "discord" | "telegram";
          target: string;
          secret?: string;
          enabled: boolean;
          events: AlertEvent[];
        },
      );
      store.event(
        req.user!.email,
        "notification.settings_updated",
        "primary",
        "",
        req.ip,
        "success",
        { provider: body.provider, enabled: body.enabled, events: body.events },
      );
      return result;
    } catch (error) {
      throw problem((error as Error).message);
    }
  });
  app.post(
    "/api/notifications/test",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      if (req.user!.role !== "admin")
        throw problem("Admin access required", 403);
      try {
        await notifications.test();
        store.event(
          req.user!.email,
          "notification.test_sent",
          "primary",
          "",
          req.ip,
        );
        return { ok: true };
      } catch (error) {
        throw problem((error as Error).message, 502);
      }
    },
  );
  app.get("/api/webhooks", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    return webhooks.get();
  });
  app.put("/api/webhooks", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    const body = z
      .object({
        endpoint: z.string().trim().max(2048).optional(),
        secret: z.string().max(256).optional(),
        enabled: z.boolean(),
        events: z.array(z.enum(webhookEvents)).max(webhookEvents.length),
      })
      .parse(req.body);
    try {
      const result = webhooks.save(body);
      store.event(
        req.user!.email,
        "webhook.settings_updated",
        "outbound-webhook",
        "",
        req.ip,
        "success",
        { enabled: body.enabled, events: body.events },
      );
      return result;
    } catch (error) {
      throw problem((error as Error).message);
    }
  });
  app.post(
    "/api/webhooks/test",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      if (req.user!.role !== "admin")
        throw problem("Admin access required", 403);
      try {
        await webhooks.test();
        store.event(
          req.user!.email,
          "webhook.test_sent",
          "outbound-webhook",
          "",
          req.ip,
        );
        return { ok: true };
      } catch {
        throw problem("Signed webhook test delivery failed", 502);
      }
    },
  );
  app.get("/api/users", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    return store.db
      .prepare("SELECT id,email,role,active,last_login FROM users")
      .all();
  });
  app.post("/api/users", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    const body = z
      .object({
        email: z.email(),
        password: z.string().min(12).max(256),
        role: z.enum(["admin", "operator", "viewer"]),
      })
      .parse(req.body);
    if (
      store.db
        .prepare("SELECT id FROM users WHERE email=?")
        .get(body.email.toLowerCase())
    )
      throw problem("Email is already registered", 409);
    const userId = randomUUID();
    store.db
      .prepare("INSERT INTO users(id,email,password,role) VALUES(?,?,?,?)")
      .run(
        userId,
        body.email.toLowerCase(),
        await hashPassword(body.password),
        body.role,
      );
    store.event(req.user!.email, "user.create", userId, "", req.ip, "success", {
      role: body.role,
    });
    return { id: userId };
  });
  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    const body = z.object({ active: z.boolean() }).parse(req.body);
    if (req.params.id === req.user!.id)
      throw problem("You cannot deactivate your own account");
    store.db
      .prepare("UPDATE users SET active=? WHERE id=?")
      .run(Number(body.active), req.params.id);
    if (!body.active)
      store.db
        .prepare("DELETE FROM sessions WHERE user_id=?")
        .run(req.params.id);
    store.event(
      req.user!.email,
      "user.update",
      req.params.id,
      "",
      req.ip,
      "success",
      { active: body.active },
    );
    return { ok: true };
  });
  app.get("/api/developer-keys", async (req) => {
    if (req.user!.role !== "admin" || req.apiKey)
      throw problem("Admin session required", 403);
    return store.db
      .prepare(
        "SELECT api_keys.id,api_keys.user_id,users.email,api_keys.name,api_keys.permissions,api_keys.created_at,api_keys.expires_at,api_keys.revoked_at FROM api_keys JOIN users ON users.id=api_keys.user_id ORDER BY api_keys.created_at DESC",
      )
      .all()
      .map((key: any) => ({
        ...key,
        permissions: JSON.parse(key.permissions),
        expiresAt: key.expires_at
          ? new Date(key.expires_at).toISOString()
          : null,
        expires_at: undefined,
        createdAt: key.created_at,
        created_at: undefined,
        revokedAt: key.revoked_at,
        revoked_at: undefined,
      }));
  });
  app.post("/api/developer-keys", async (req) => {
    if (req.user!.role !== "admin" || req.apiKey)
      throw problem("Admin session required", 403);
    const body = z
      .object({
        name,
        permissions: z
          .array(z.enum(["read", "write"]))
          .min(1)
          .max(2),
        expiresAt: z.iso.datetime().optional(),
      })
      .parse(req.body);
    if (
      body.expiresAt &&
      (Date.parse(body.expiresAt) <= Date.now() ||
        Date.parse(body.expiresAt) > Date.now() + 365 * 86400000)
    )
      throw problem("API key expiration must be within the next 365 days");
    const id = randomUUID();
    const secret = `smx_${randomBytes(32).toString("base64url")}`;
    store.db
      .prepare(
        "INSERT INTO api_keys(id,user_id,name,token_hash,permissions,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        req.user!.id,
        body.name,
        tokenHash(secret),
        JSON.stringify([...new Set(body.permissions)]),
        new Date().toISOString(),
        body.expiresAt ? Date.parse(body.expiresAt) : null,
      );
    store.event(req.user!.email, "api_key.create", id, "", req.ip, "success", {
      name: body.name,
      permissions: body.permissions,
      expiresAt: body.expiresAt,
    });
    return { id, key: secret };
  });
  app.delete<{ Params: { id: string } }>(
    "/api/developer-keys/:id",
    async (req) => {
      if (req.user!.role !== "admin" || req.apiKey)
        throw problem("Admin session required", 403);
      const key = store.db
        .prepare("SELECT id,revoked_at FROM api_keys WHERE id=?")
        .get(req.params.id) as any;
      if (!key) throw problem("API key not found", 404);
      if (!key.revoked_at)
        store.db
          .prepare("UPDATE api_keys SET revoked_at=? WHERE id=?")
          .run(new Date().toISOString(), req.params.id);
      store.event(req.user!.email, "api_key.revoke", req.params.id, "", req.ip);
      return { ok: true };
    },
  );

  function safe(kind: Kind, value: Entity) {
    const { secret, path, ...data } = value;
    // Legacy library records were saved only after successful normalization.
    if (kind === "videos") return { ...data, status: data.status ?? "ready" };
    if (kind === "streams")
      return { ...data, outputs: engine.status(value.id) };
    return data;
  }
  app.get("/api/diagnostics", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    return diagnostics(config);
  });
  function validateReferences(kind: Kind, value: Entity) {
    const requireEntity = (type: Kind, entityId: string) => {
      if (!store.get(type, entityId))
        throw problem(`Selected ${type} resource does not exist`);
    };
    if (kind === "playlists")
      for (const videoId of value.videoIds) requireEntity("videos", videoId);
    if (kind === "streams") {
      const playlist = store.get("playlists", value.playlistId);
      if (!playlist)
        throw problem("Selected playlists resource does not exist");
      if (value.playCount !== undefined && playlist.videoIds.length !== 1)
        throw problem(
          "A fixed play count is only available for one-video playlists",
        );
      if (value.playCount !== undefined && value.loop)
        throw problem(
          "A fixed play count cannot be combined with continuous looping",
        );
      requireEntity("profiles", value.profileId);
      for (const destinationId of value.destinationIds)
        requireEntity("destinations", destinationId);
    }
    if (kind === "schedules") {
      requireEntity("streams", value.streamId);
      if (value.playlistId) {
        requireEntity("playlists", value.playlistId);
        if (
          store.get("streams", value.streamId)!.playCount &&
          store.get("playlists", value.playlistId)!.videoIds.length !== 1
        )
          throw problem(
            "Fixed playback requires a one-video scheduled playlist",
          );
      }
      if (
        Date.parse(value.startAt) <= Date.now() ||
        Date.parse(value.endAt) <= Date.parse(value.startAt)
      )
        throw problem(
          "Schedule must start in the future and end after its start",
        );
      const stream = store.get("streams", value.streamId)!;
      for (const other of store.list("schedules")) {
        if (
          other.id === value.id ||
          !["pending", "running"].includes(other.state)
        )
          continue;
        const otherStream = store.get("streams", other.streamId)!;
        if (
          Date.parse(value.startAt) < Date.parse(other.endAt) &&
          Date.parse(other.startAt) < Date.parse(value.endAt) &&
          (stream.id === otherStream.id ||
            stream.destinationIds.some((d: string) =>
              otherStream.destinationIds.includes(d),
            ))
        )
          throw problem(
            "Schedule overlaps another reservation for this stream or destination",
            409,
          );
      }
    }
  }
  function isInUse(kind: Kind, entityId: string, deleting = false) {
    if (
      kind === "playlists" &&
      store
        .list("schedules")
        .some(
          (s) =>
            s.playlistId === entityId &&
            (deleting || ["pending", "running"].includes(s.state)),
        )
    )
      return true;
    if (
      deleting &&
      kind === "profiles" &&
      store.get("settings", "system")?.defaultProfileId === entityId
    )
      return true;
    if (kind === "videos")
      return store.list("playlists").some((p) => p.videoIds.includes(entityId));
    if (kind === "schedules")
      return store.get(kind, entityId)?.state === "running";
    if (kind === "streams")
      return (
        store.get(kind, entityId)?.desired === "running" ||
        store
          .list("schedules")
          .some(
            (s) =>
              s.streamId === entityId &&
              (deleting || ["pending", "running"].includes(s.state)),
          )
      );
    return store.list("streams").some((s) => {
      const references =
        kind === "playlists"
          ? s.playlistId === entityId
          : kind === "profiles"
            ? s.profileId === entityId
            : s.destinationIds.includes(entityId);
      return (
        references &&
        (deleting ||
          s.desired === "running" ||
          store
            .list("schedules")
            .some(
              (job) =>
                job.streamId === s.id &&
                ["pending", "running"].includes(job.state),
            ))
      );
    });
  }
  app.patch<{ Params: { id: string } }>(
    "/api/destinations/:id/enabled",
    async (req) => {
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      const destination = store.get("destinations", req.params.id);
      if (!destination) throw problem("Resource not found", 404);
      if (isInUse("destinations", destination.id))
        throw problem(
          "Stop the stream or remove its pending schedules before editing",
          409,
        );
      const saved = store.save("destinations", {
        ...destination,
        enabled: body.enabled,
      });
      store.event(
        req.user!.email,
        "destination.update",
        saved.id,
        "",
        req.ip,
        "success",
        { enabled: saved.enabled },
      );
      return safe("destinations", saved);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/destinations/:id/test",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      if (req.user!.role !== "admin")
        throw problem("Admin access required", 403);
      const destination = store.get("destinations", req.params.id);
      if (!destination) throw problem("Resource not found", 404);
      try {
        const result = await testDestination(destination.url);
        store.event(
          req.user!.email,
          "destination.test",
          destination.id,
          "",
          req.ip,
          "success",
          { transport: result.transport },
        );
        return {
          ok: true,
          transport: result.transport,
          message:
            "Endpoint reachable; the stream key and platform ingest are not verified.",
        };
      } catch {
        store.event(
          req.user!.email,
          "destination.test",
          destination.id,
          "",
          req.ip,
          "failure",
        );
        return {
          ok: false,
          message: "Could not connect to the destination endpoint.",
        };
      }
    },
  );
  for (const kind of [
    "videos",
    "playlists",
    "profiles",
    "destinations",
    "streams",
    "schedules",
  ] as ResourceKind[]) {
    app.get(`/api/${kind}`, async () =>
      store.list(kind).map((value) => safe(kind, value)),
    );
    if (kind !== "videos") {
      const upsert = async (req: any) => {
        const entityId = req.params?.id;
        const previous = entityId ? store.get(kind, entityId) : undefined;
        if (entityId && !previous) throw problem("Resource not found", 404);
        if (entityId && isInUse(kind, entityId))
          throw problem(
            "Stop the stream or remove its pending schedules before editing",
            409,
          );
        const value = {
          ...previous,
          ...schemas[kind].parse(req.body),
          id: entityId || randomUUID(),
        } as Entity;
        if (kind === "streams" && !Object.hasOwn(req.body, "playCount"))
          delete value.playCount;
        if (kind === "schedules" && !Object.hasOwn(req.body, "playlistId"))
          delete value.playlistId;
        if (kind === "destinations") {
          if (!value.key && !previous?.secret)
            throw problem("Stream key is required");
          value.secret = value.key
            ? encrypt(value.key, config.ENCRYPTION_KEY)
            : previous!.secret;
          delete value.key;
        }
        if (kind === "streams") value.desired = "stopped";
        if (kind === "schedules") value.state = "pending";
        validateReferences(kind, value);
        let saved: Entity;
        if (kind === "schedules") {
          if (entityId && value.recurrence !== "none")
            throw problem(
              "Create a new schedule to generate a recurring series",
            );
          let occurrences;
          try {
            occurrences = scheduleOccurrences(
              value.startAt,
              value.endAt,
              value.recurrence,
              value.occurrences,
              store.get("settings", "system")?.timeZone ||
                Intl.DateTimeFormat().resolvedOptions().timeZone,
            );
          } catch {
            throw problem(
              "A recurring occurrence falls on an invalid local time; adjust the schedule time",
            );
          }
          store.db.exec("BEGIN IMMEDIATE");
          try {
            const seriesId = occurrences.length > 1 ? randomUUID() : undefined;
            const entries = occurrences.map((times, index) => {
              const entry = {
                ...value,
                ...times,
                id: index === 0 ? value.id : randomUUID(),
                recurrence: "none",
                occurrences: 1,
                seriesId,
              };
              validateReferences(kind, entry);
              return store.save(kind, entry);
            });
            store.db.exec("COMMIT");
            saved = entries[0];
          } catch (error) {
            store.db.exec("ROLLBACK");
            throw error;
          }
        } else saved = store.save(kind, value);
        store.event(
          req.user.email,
          `${kind}.${entityId ? "update" : "create"}`,
          saved.id,
          "",
          req.ip,
          "success",
          { kind },
        );
        return safe(kind, saved);
      };
      app.post(`/api/${kind}`, upsert);
      app.put(`/api/${kind}/:id`, upsert);
    }
    app.delete<{ Params: { id: string } }>(`/api/${kind}/:id`, async (req) => {
      const entity = store.get(kind, req.params.id);
      if (!entity) throw problem("Resource not found", 404);
      if (kind === "videos" && ["queued", "processing"].includes(entity.status))
        throw problem("Video processing is pending", 409);
      if (isInUse(kind, entity.id, true))
        throw problem("Resource is in use; remove its references first", 409);
      if (kind === "videos")
        await unlink(join(mediaDir, `${entity.id}.mp4`)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          },
        );
      store.delete(kind, entity.id);
      store.event(
        req.user!.email,
        `${kind}.delete`,
        entity.id,
        "",
        req.ip,
        "success",
        { kind },
      );
      return { ok: true };
    });
  }
  const mediaQueue = new MediaQueue();
  app.addHook("onClose", async () => {
    await mediaQueue.close();
  });
  // Interrupted jobs cannot be resumed safely without a durable job transaction.
  for (const video of store.list("videos")) {
    if (["queued", "processing", "uploaded"].includes(video.status)) {
      store.save("videos", {
        ...video,
        status: "failed",
        error: "Processing interrupted; upload the file again",
      });
      await unlink(join(uploadDir, `${video.id}.upload`)).catch(() => {});
      await unlink(join(mediaDir, `${video.id}.mp4`)).catch(() => {});
    }
  }
  const acceptVideo = async (
    temporary: string,
    name: string,
    actor: string,
    ip: string,
  ) => {
    let inspection;
    try {
      inspection = await inspectMedia(config, temporary);
    } catch {
      throw problem(
        "Video could not be inspected. Check the file and FFprobe installation.",
      );
    }
    const videoId = randomUUID();
    const stableInput = join(uploadDir, `${videoId}.upload`);
    const size = (await stat(temporary)).size;
    const freeBytes = await availableDiskBytes();
    const reserved = store
      .list("videos")
      .filter((v) => ["queued", "processing"].includes(v.status))
      .reduce((n, v) => n + Number(v.size || 0) * 2, 0);
    if (freeBytes < reserved + size * 3 + 100 * 1024 * 1024)
      throw problem("Insufficient free disk space for processing", 507);
    let video: Entity;
    try {
      // Retain the resumable source until registration succeeds.
      await copyFile(temporary, stableInput, 1);
      video = store.save("videos", {
        id: videoId,
        name,
        ...inspection,
        size,
        status: "queued",
        createdAt: new Date().toISOString(),
      });
      store.event(actor, "video.upload", videoId, "", ip, "success", { size });
      store.event(
        actor,
        "video.processing.queued",
        videoId,
        "Video queued",
        ip,
      );
      app.log.info({ videoId }, "Video queued");
    } catch (error) {
      await unlink(stableInput).catch(() => {});
      store.delete("videos", videoId);
      throw error;
    }
    const alreadyBusy = mediaQueue.size() > 0;
    const result = mediaQueue.enqueue(async (signal) => {
      let release: (() => void) | undefined;
      try {
        if (signal.aborted) throw new Error("Interrupted");
        if (needsTranscode(inspection))
          release = await encoderSlot.acquire(signal);
        store.save("videos", { ...video, status: "processing" });
        store.event(
          actor,
          "video.processing.started",
          video.id,
          "Video processing started",
          ip,
        );
        app.log.info({ videoId: video.id }, "Video processing started");
        if (!needsTranscode(inspection)) {
          store.event(
            actor,
            "video.processing.skipped_transcoding",
            video.id,
            "Video skipped transcoding; remux only",
            ip,
          );
          app.log.info(
            { videoId: video.id },
            "Video skipped transcoding; remux only",
          );
        }
        const metadata = await normalizeMedia(
          config,
          stableInput,
          video.id,
          inspection,
          signal,
          (progress) => {
            const current = store.get("videos", video.id);
            if (
              current?.status === "processing" &&
              progress > (current.processingProgress ?? -1)
            )
              store.save("videos", {
                ...current,
                processingProgress: progress,
              });
          },
        );
        const size = (await stat(metadata.path)).size;
        const ready = store.save("videos", {
          ...video,
          ...metadata,
          size,
          status: "ready",
          processingProgress: 100,
        });
        store.event(
          actor,
          "video.processing.complete",
          video.id,
          "Video processing completed",
          ip,
          "success",
          { size, transcoded: metadata.transcoded },
        );
        app.log.info({ videoId: video.id }, "Video processing completed");
        return ready;
      } catch {
        const failed = store.save("videos", {
          ...video,
          status: "failed",
          error: "Processing failed or was interrupted; upload the file again",
        });
        store.event(
          actor,
          "video.processing.failed",
          video.id,
          "Video processing failed",
          ip,
          "failure",
        );
        app.log.warn({ videoId: video.id }, "Video processing failed");
        await unlink(join(mediaDir, `${video.id}.mp4`)).catch(() => {});
        return failed;
      } finally {
        release?.();
        await unlink(stableInput).catch(() => {});
      }
    });
    // Observe background failures even if an audit/database write itself fails.
    void result.catch(() => app.log.error({ videoId }, "Media job failed"));
    // Remux is inexpensive, but still uses the same bounded worker lane.
    return safe(
      "videos",
      alreadyBusy || needsTranscode(inspection) ? video : await result,
    );
  };
  registerUploads(app, store, config, acceptVideo, availableDiskBytes);
  app.post("/api/videos", async (req, reply) => {
    const temporary = join(uploadDir, `${randomUUID()}.incoming`);
    try {
      if ((await availableDiskBytes()) < config.MAX_UPLOAD_MB * 1024 * 1024 * 2)
        throw problem(
          "Insufficient free disk space for upload and processing",
          507,
        );
      const file = await req.file();
      if (!file) throw problem("Choose a video file");
      await pipeline(file.file, createWriteStream(temporary, { flags: "wx" }));
      if (file.file.truncated)
        throw problem(`Upload exceeds ${config.MAX_UPLOAD_MB} MB`, 413);
      const video = await acceptVideo(
        temporary,
        file.filename.replace(/[\\/]/g, "_").slice(0, 120),
        req.user!.email,
        req.ip,
      );
      return reply.code(201).send(video);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
  app.get<{ Params: { id: string } }>("/api/media/:id", async (req, reply) => {
    if (!store.get("videos", req.params.id))
      throw problem("Video not found", 404);
    const video = store.get("videos", req.params.id)!;
    if (video.status && video.status !== "ready")
      throw problem("Video is not ready", 409);
    return reply.sendFile(`${req.params.id}.mp4`);
  });
  const locks = new Set<string>();
  app.get<{ Params: { id: string; file: string } }>(
    "/api/preview/:id/:file",
    async (req, reply) => {
      const streamId = id.parse(req.params.id);
      if (
        !store.get("streams", streamId)?.livePreview ||
        !engine.outputs.has(streamId)
      )
        throw problem("Live preview unavailable", 404);
      if (!/^(live\.m3u8|live\d+\.ts)$/.test(req.params.file))
        throw problem("Preview not found", 404);
      const path = join(config.DATA_DIR, "preview", streamId, req.params.file);
      if (!existsSync(path)) throw problem("Preview is starting", 404);
      reply.header("Cache-Control", "no-store");
      reply.type(
        req.params.file.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp2t",
      );
      return reply.send(createReadStream(path));
    },
  );
  app.post<{ Params: { id: string; action: string } }>(
    "/api/streams/:id/:action",
    async (req) => {
      const { id: streamId, action } = req.params;
      if (!["start", "stop", "restart"].includes(action))
        throw problem("Unknown stream action", 404);
      if (!store.get("streams", streamId))
        throw problem("Stream not found", 404);
      if (locks.has(streamId))
        throw problem("A stream operation is already in progress", 409);
      locks.add(streamId);
      try {
        if (action !== "start") {
          // Manual intervention cancels schedule ownership so an old end time
          // cannot later stop a manually restarted stream.
          for (const schedule of store.list("schedules"))
            if (schedule.streamId === streamId && schedule.state === "running")
              store.save("schedules", { ...schedule, state: "cancelled" });
          await engine.stop(streamId, req.user!.email);
        }
        if (action !== "stop") {
          try {
            engine.start(streamId, req.user!.email);
          } catch (error) {
            throw problem((error as Error).message, 409);
          }
        }
        return { ok: true };
      } finally {
        locks.delete(streamId);
      }
    },
  );
  const eventQuery = z.object({
    actor: z.string().trim().max(120).optional(),
    action: z.string().trim().max(120).optional(),
    resource: z.string().trim().max(120).optional(),
    result: z.enum(["success", "failure"]).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(20000).optional(),
  });
  const getEvents = (query: unknown, limit = 200) => {
    const filters = eventQuery.parse(query);
    if (
      filters.from &&
      filters.to &&
      Date.parse(filters.from) > Date.parse(filters.to)
    )
      throw problem("Event start time must be before end time");
    return store.events({ ...filters, limit: filters.limit ?? limit });
  };
  app.get("/api/events", async (req) => getEvents(req.query));
  app.get("/api/events/integrity", async (req) => {
    if (req.user!.role !== "admin") throw problem("Admin access required", 403);
    return store.auditIntegrity();
  });
  app.get("/api/events.csv", async (req, reply) => {
    const events = getEvents(req.query, 20000);
    const cell = (input: unknown) => {
      let value = String(input ?? "");
      if (/^[\s]*[=+@\-\t\r]/.test(value)) value = `'${value}`;
      return `"${value.replaceAll('"', '""')}"`;
    };
    const columns = [
      "id",
      "time_utc",
      "actor",
      "action",
      "resource",
      "ip",
      "result",
      "message",
      "metadata_json",
      "previous_hash",
      "chain_hash",
    ];
    const rows = events.map((event) =>
      [
        event.id,
        event.time,
        event.actor,
        event.action,
        event.resource,
        event.ip,
        event.result,
        event.message,
        JSON.stringify(event.metadata),
        event.previousHash,
        event.hash,
      ]
        .map(cell)
        .join(","),
    );
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        'attachment; filename="streamax-audit.csv"',
      );
    return reply.send([columns.join(","), ...rows].join("\r\n") + "\r\n");
  });
  const reportQuery = z.object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  });
  app.get<{ Querystring: { from: string; to: string } }>(
    "/api/analytics",
    async (req) => {
      const range = reportQuery.parse(req.query);
      return report(store, range.from, range.to);
    },
  );
  app.get<{ Querystring: { from: string; to: string } }>(
    "/api/analytics.csv",
    async (req, reply) => {
      const range = reportQuery.parse(req.query);
      const result = report(store, range.from, range.to);
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="streamax-sessions-${range.from.slice(0, 10)}.csv"`,
        );
      return reply.send(reportCsv(result));
    },
  );
  let previousCpu = cpus().map((c) => c.times);
  let previousNetwork = readNetworkCounters();
  let previousNetworkAt = Date.now();
  app.get("/api/overview", async () => {
    const disk = await statfs(config.DATA_DIR);
    const currentCpu = cpus().map((c) => c.times);
    let idle = 0;
    let total = 0;
    currentCpu.forEach((c, i) => {
      const p = previousCpu[i] || c;
      idle += c.idle - p.idle;
      total +=
        Object.values(c).reduce((a, b) => a + b, 0) -
        Object.values(p).reduce((a, b) => a + b, 0);
    });
    previousCpu = currentCpu;
    const network = readNetworkCounters();
    const networkElapsed = (Date.now() - previousNetworkAt) / 1000;
    const networkRxBps =
      network && previousNetwork && networkElapsed > 0
        ? Math.max(
            0,
            Math.round(
              (network.received - previousNetwork.received) / networkElapsed,
            ),
          )
        : null;
    const networkTxBps =
      network && previousNetwork && networkElapsed > 0
        ? Math.max(
            0,
            Math.round((network.sent - previousNetwork.sent) / networkElapsed),
          )
        : null;
    if (network) previousNetwork = network;
    previousNetworkAt = Date.now();
    return {
      cpu: total ? Math.round((1 - idle / total) * 100) : 0,
      memoryUsed: totalmem() - freemem(),
      memoryTotal: totalmem(),
      diskUsed: (disk.blocks - disk.bfree) * disk.bsize,
      diskTotal: disk.blocks * disk.bsize,
      uptime: uptime(),
      appUptime: process.uptime(),
      load: loadavg(),
      networkRxBps,
      networkTxBps,
      temperatureC: readTemperatureC(),
      maxOutputs: config.MAX_OUTPUTS,
      retryAttempts: store.get("settings", "system")?.retryAttempts ?? 5,
      processing: mediaQueue.size() > 0,
      maxUploadMb: config.MAX_UPLOAD_MB,
    };
  });
  const dist = resolve("dist");
  if (existsSync(join(dist, "index.html"))) {
    await app.register(staticFiles, {
      root: dist,
      prefix: "/",
      decorateReply: false,
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") || req.url.split("?")[0].includes(".")
        ? reply.code(404).send({ error: "Route not found" })
        : reply.sendFile("index.html", dist),
    );
  }
  if (options.startEngine !== false) {
    await engine.boot();
    notifications.start();
    thresholds.start();
  }
  app.addHook("onClose", async () => {
    await thresholds.close();
    await engine.shutdown();
    await notifications.close();
    await webhooks.close();
    store.close();
  });
  return { app, store, engine };
}
