import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../server/config.ts";
import { buildApp } from "../server/app.ts";
import type { Entity } from "../server/store.ts";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { encrypt } from "../server/security.ts";

export function createPngFixture() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const typeBytes = Buffer.from(type, "ascii");
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    typeBytes.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(
      crc32(Buffer.concat([typeBytes, data])),
      8 + data.length,
    );
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([
    0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0, 255, 255,
  ]);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function fixture(
  options: {
    availableDiskBytes?: () => Promise<number>;
    mediaNormalizer?: typeof import("../server/media.ts").normalize;
    destinationProbe?: (
      address: string,
    ) => Promise<{ transport: "tcp" | "tls" }>;
    webhookRequest?: (
      url: URL,
      body: string,
      headers: Record<string, string>,
    ) => Promise<number>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "streamax-test-"));
  const config = configuration({
    DATA_DIR: directory,
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "test-password-long",
    ENCRYPTION_KEY: "ab".repeat(32),
    APP_ORIGIN: "http://localhost:5173",
    MAX_UPLOAD_MB: "2",
  });
  const notificationCalls: Array<{ url: string; body: any }> = [];
  const notificationFetch: typeof fetch = async (input, init) => {
    notificationCalls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return String(input).includes("api.telegram.org")
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : new Response("{}", { status: 200 });
  };
  const instance = await buildApp(config, {
    startEngine: false,
    notificationFetch,
    ...options,
  });
  await instance.app.ready();
  const login = await instance.app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: config.APP_ORIGIN },
    payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
  });
  const headers = {
    origin: config.APP_ORIGIN,
    cookie: `session=${login.cookies[0].value}`,
    "x-csrf-token": login.json().csrf,
  };
  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    path: string,
    payload?: any,
  ) => instance.app.inject({ method, url: `/api/${path}`, headers, payload });
  return {
    ...instance,
    config,
    directory,
    headers,
    request,
    notificationCalls,
    async cleanup() {
      await instance.app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const video = f.store.save("videos", {
    name: "Test media",
    id: randomUUID(),
    duration: 2,
    size: 100,
  });
  const playlist = f.store.save("playlists", {
    name: "Playlist",
    videoIds: [video.id],
  });
  const destination = f.store.save("destinations", {
    name: "Local ingest",
    platform: "Custom",
    url: "rtmp://127.0.0.1:1935/live",
    secret: encrypt("private-test-key", f.config.ENCRYPTION_KEY),
    enabled: true,
  });
  const profile = f.store.list("profiles")[0];
  const stream = f.store.save("streams", {
    name: "Stream",
    playlistId: playlist.id,
    profileId: profile.id,
    destinationIds: [destination.id],
    loop: true,
    desired: "stopped",
  });
  return { video, playlist, destination, profile, stream } satisfies Record<
    string,
    Entity
  >;
}
export async function until(check: () => boolean, timeout = 10000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
