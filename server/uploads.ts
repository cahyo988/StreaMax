import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { appendFile, stat, unlink, writeFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "./store.ts";
import type { Config } from "./config.ts";

const problem = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
export function registerUploads(
  app: FastifyInstance,
  store: Store,
  config: Config,
  complete: (
    path: string,
    name: string,
    owner: string,
    ip: string,
  ) => Promise<unknown>,
) {
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,fingerprint TEXT NOT NULL,expires INTEGER NOT NULL)",
  );
  const locks = new Set<string>();
  const path = (id: string) => join(config.DATA_DIR, "uploads", `${id}.part`);
  const offset = async (id: string) =>
    (await stat(path(id)).catch(() => ({ size: 0 }))).size;
  const expire = async () => {
    for (const row of store.db
      .prepare("SELECT id FROM uploads WHERE expires<?")
      .all(Date.now())) {
      const id = String(row.id);
      if (locks.has(id)) continue;
      await unlink(path(id)).catch(() => {});
      store.db.prepare("DELETE FROM uploads WHERE id=?").run(id);
    }
  };
  const expirationTimer = setInterval(() => {
    void expire().catch(() => {});
  }, 60_000);
  expirationTimer.unref();
  app.addHook("onClose", async () => clearInterval(expirationTimer));
  const owned = (id: string, owner: string) => {
    z.uuid().parse(id);
    const row = store.db
      .prepare("SELECT * FROM uploads WHERE id=? AND owner=? AND expires>?")
      .get(id, owner, Date.now()) as any;
    if (!row) throw problem("Upload not found or expired", 404);
    return row;
  };
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.get("/api/uploads", async (req) => {
    await expire();
    const rows = store.db
      .prepare(
        "SELECT id,name,size,fingerprint,expires FROM uploads WHERE owner=?",
      )
      .all(req.user!.id);
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        offset: await offset(String(row.id)),
      })),
    );
  });
  app.post("/api/uploads", async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(120),
        size: z
          .number()
          .int()
          .min(1)
          .max(config.MAX_UPLOAD_MB * 1024 * 1024),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(req.body);
    await expire();
    // Reserve synchronously before filesystem awaits so parallel creates cannot exceed the cap.
    if (
      Number(store.db.prepare("SELECT COUNT(*) AS n FROM uploads").get()!.n) >=
      16
    )
      throw problem("Too many unfinished uploads; cancel one first", 409);
    const id = randomUUID();
    store.db
      .prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?)")
      .run(
        id,
        req.user!.id,
        body.name.replace(/[\\/]/g, "_"),
        body.size,
        body.fingerprint,
        Date.now() + 86400000,
      );
    try {
      const disk = await statfs(config.DATA_DIR);
      const reserved = Number(
        store.db
          .prepare("SELECT COALESCE(SUM(size),0) AS n FROM uploads")
          .get()!.n,
      );
      if (disk.bavail * disk.bsize < reserved + 100 * 1024 * 1024)
        throw problem("Not enough disk space for pending uploads", 507);
      await writeFile(path(id), Buffer.alloc(0), { flag: "wx" });
      return reply.code(201).send({ id, offset: 0 });
    } catch (error) {
      store.db.prepare("DELETE FROM uploads WHERE id=?").run(id);
      throw error;
    }
  });
  app.patch<{ Params: { id: string } }>(
    "/api/uploads/:id",
    {
      bodyLimit: 1024 * 1024,
      config: { rateLimit: { max: 3000, timeWindow: "1 minute" } },
    },
    async (req) => {
      const row = owned(req.params.id, req.user!.id);
      if (locks.has(row.id)) throw problem("Upload is busy", 409);
      locks.add(row.id);
      try {
        const expected = z.coerce
          .number()
          .int()
          .min(0)
          .parse(req.headers["upload-offset"]);
        const actual = await offset(row.id);
        if (expected !== actual)
          throw problem(
            "Upload offset changed; resume from the server offset",
            409,
          );
        if (
          !Buffer.isBuffer(req.body) ||
          !req.body.length ||
          actual + req.body.length > row.size
        )
          throw problem("Invalid upload chunk");
        await appendFile(path(row.id), req.body);
        store.db
          .prepare("UPDATE uploads SET expires=? WHERE id=?")
          .run(Date.now() + 86400000, row.id);
        return { id: row.id, offset: actual + req.body.length };
      } finally {
        locks.delete(row.id);
      }
    },
  );
  app.delete<{ Params: { id: string } }>("/api/uploads/:id", async (req) => {
    const row = owned(req.params.id, req.user!.id);
    if (locks.has(row.id)) throw problem("Upload is busy", 409);
    locks.add(row.id);
    try {
      await unlink(path(row.id)).catch(() => {});
      store.db.prepare("DELETE FROM uploads WHERE id=?").run(row.id);
      return { ok: true };
    } finally {
      locks.delete(row.id);
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/uploads/:id/complete",
    async (req, reply) => {
      const row = owned(req.params.id, req.user!.id);
      if (locks.has(row.id)) throw problem("Upload is busy", 409);
      locks.add(row.id);
      try {
        if ((await offset(row.id)) !== row.size)
          throw problem("Upload is incomplete", 409);
        const result = await complete(
          path(row.id),
          row.name,
          req.user!.email,
          req.ip,
        );
        store.db.prepare("DELETE FROM uploads WHERE id=?").run(row.id);
        await unlink(path(row.id)).catch(() => {});
        return reply.code(201).send(result);
      } finally {
        locks.delete(row.id);
      }
    },
  );
}
