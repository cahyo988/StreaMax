import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { hashPassword, redact } from "./security.ts";
import type { Config } from "./config.ts";

export type Entity = { id: string; name: string; [key: string]: any };
export type Kind =
  | "videos"
  | "playlists"
  | "profiles"
  | "destinations"
  | "streams"
  | "schedules"
  | "notifications"
  | "settings";
export class Store {
  db: DatabaseSync;
  private auditKey: string;
  onEvent?: (
    actor: string,
    action: string,
    resource: string,
    message: string,
  ) => void;
  constructor(directory: string, auditKey: string) {
    this.auditKey = auditKey;
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "streamax.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,last_login TEXT);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,permissions TEXT NOT NULL,created_at TEXT NOT NULL,expires_at INTEGER,revoked_at TEXT);
      CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);
      CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,message TEXT NOT NULL,ip TEXT NOT NULL DEFAULT '',result TEXT NOT NULL DEFAULT 'success',metadata TEXT NOT NULL DEFAULT '{}',prev_hash TEXT,hash TEXT);
      CREATE TABLE IF NOT EXISTS audit_state(id INTEGER PRIMARY KEY CHECK(id=1),head_id INTEGER NOT NULL,head_hash TEXT NOT NULL,first_id INTEGER,first_prev_hash TEXT NOT NULL,signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stream_metrics(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,stream_id TEXT NOT NULL,destination_id TEXT NOT NULL,fps REAL,bitrate_kbps REAL,media_time TEXT);
      CREATE INDEX IF NOT EXISTS stream_metrics_time ON stream_metrics(time);
    `);
    const eventColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(events)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!eventColumns.has("ip"))
      this.db.exec("ALTER TABLE events ADD COLUMN ip TEXT NOT NULL DEFAULT ''");
    if (!eventColumns.has("result"))
      this.db.exec(
        "ALTER TABLE events ADD COLUMN result TEXT NOT NULL DEFAULT 'success'",
      );
    if (!eventColumns.has("metadata"))
      this.db.exec(
        "ALTER TABLE events ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
      );
    if (!eventColumns.has("prev_hash"))
      this.db.exec("ALTER TABLE events ADD COLUMN prev_hash TEXT");
    if (!eventColumns.has("hash"))
      this.db.exec("ALTER TABLE events ADD COLUMN hash TEXT");
    this.initializeAuditIntegrity();
  }
  private digestAuditEvent(
    event: Record<string, unknown>,
    previousHash: string,
  ) {
    return createHmac("sha256", this.auditKey)
      .update(
        JSON.stringify([
          previousHash,
          event.id,
          event.time,
          event.actor,
          event.action,
          event.resource,
          event.message,
          event.ip,
          event.result,
          event.metadata,
        ]),
      )
      .digest("hex");
  }
  private signAuditState(state: {
    headId: number;
    headHash: string;
    firstId: number | null;
    firstPreviousHash: string;
  }) {
    return createHmac("sha256", this.auditKey)
      .update(
        JSON.stringify([
          state.headId,
          state.headHash,
          state.firstId,
          state.firstPreviousHash,
        ]),
      )
      .digest("hex");
  }
  private initializeAuditIntegrity() {
    if (this.db.prepare("SELECT id FROM audit_state WHERE id=1").get()) return;
    const events = this.db
      .prepare("SELECT * FROM events ORDER BY id ASC")
      .all() as Array<Record<string, any>>;
    // A checkpoint disappearing after a chain was established is tampering, not
    // a fresh migration. Keep the store visibly invalid instead of re-sealing it.
    if (events.some((event) => event.hash)) return;
    let previousHash = "";
    const update = this.db.prepare(
      "UPDATE events SET prev_hash=?,hash=? WHERE id=?",
    );
    for (const event of events) {
      const fields = { ...event, metadata: event.metadata || "{}" };
      const hash = this.digestAuditEvent(fields, previousHash);
      update.run(previousHash, hash, event.id);
      previousHash = hash;
    }
    const first = events[0];
    const last = events.at(-1);
    const state = {
      headId: Number(last?.id || 0),
      headHash: last ? previousHash : "",
      firstId: first ? Number(first.id) : null,
      firstPreviousHash: first ? "" : "",
    };
    if (first) {
      const row = this.db
        .prepare("SELECT prev_hash FROM events WHERE id=?")
        .get(first.id) as { prev_hash: string };
      state.firstPreviousHash = row.prev_hash;
    }
    this.db
      .prepare(
        "INSERT INTO audit_state(id,head_id,head_hash,first_id,first_prev_hash,signature) VALUES(1,?,?,?,?,?)",
      )
      .run(
        state.headId,
        state.headHash,
        state.firstId,
        state.firstPreviousHash,
        this.signAuditState(state),
      );
  }
  auditIntegrity() {
    const state = this.db
      .prepare("SELECT * FROM audit_state WHERE id=1")
      .get() as any;
    if (!state)
      return {
        valid: false,
        checked: 0,
        firstId: null,
        lastId: null,
        reason: "checkpoint_missing",
      };
    const normalizedState = {
      headId: Number(state.head_id),
      headHash: String(state.head_hash),
      firstId: state.first_id === null ? null : Number(state.first_id),
      firstPreviousHash: String(state.first_prev_hash),
    };
    const expectedSignature = this.signAuditState(normalizedState);
    const actualSignature = Buffer.from(state.signature, "hex");
    const expectedSignatureBytes = Buffer.from(expectedSignature, "hex");
    if (
      actualSignature.length !== expectedSignatureBytes.length ||
      !timingSafeEqual(actualSignature, expectedSignatureBytes)
    )
      return {
        valid: false,
        checked: 0,
        firstId: normalizedState.firstId,
        lastId: normalizedState.headId || null,
        reason: "checkpoint_signature_invalid",
      };
    const events = this.db
      .prepare("SELECT * FROM events ORDER BY id ASC")
      .all() as Array<Record<string, any>>;
    if ((events[0]?.id ?? null) !== normalizedState.firstId)
      return {
        valid: false,
        checked: 0,
        firstId: events[0]?.id ?? null,
        lastId: events.at(-1)?.id ?? null,
        reason: "retained_range_mismatch",
      };
    let previousHash = normalizedState.firstPreviousHash;
    for (const [index, event] of events.entries()) {
      if (event.prev_hash !== previousHash)
        return {
          valid: false,
          checked: index,
          firstId: normalizedState.firstId,
          lastId: events.at(-1)?.id ?? null,
          reason: "chain_link_mismatch",
        };
      const expectedHash = this.digestAuditEvent(event, previousHash);
      const actual = Buffer.from(String(event.hash || ""), "hex");
      const expected = Buffer.from(expectedHash, "hex");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return {
          valid: false,
          checked: index,
          firstId: normalizedState.firstId,
          lastId: events.at(-1)?.id ?? null,
          reason: "event_hash_mismatch",
        };
      previousHash = event.hash;
    }
    const last = events.at(-1);
    if (
      Number(last?.id || 0) !== normalizedState.headId ||
      (last?.hash || "") !== normalizedState.headHash
    )
      return {
        valid: false,
        checked: events.length,
        firstId: normalizedState.firstId,
        lastId: last?.id ?? null,
        reason: "checkpoint_head_mismatch",
      };
    return {
      valid: true,
      checked: events.length,
      firstId: normalizedState.firstId,
      lastId: last?.id ?? null,
      reason: null,
    };
  }
  async bootstrap(config: Config) {
    if (!this.db.prepare("SELECT id FROM users LIMIT 1").get()) {
      this.db
        .prepare("INSERT INTO users(id,email,password,role) VALUES(?,?,?,?)")
        .run(
          randomUUID(),
          config.ADMIN_EMAIL.toLowerCase(),
          await hashPassword(config.ADMIN_PASSWORD),
          "admin",
        );
    }
    if (!this.list("profiles").length) {
      this.save("profiles", {
        name: "720p · Balanced",
        width: 1280,
        height: 720,
        fps: 30,
        bitrate: 2500,
        audioBitrate: 128,
      });
      this.save("profiles", {
        name: "1080p · High quality",
        width: 1920,
        height: 1080,
        fps: 30,
        bitrate: 4500,
        audioBitrate: 192,
      });
    }
  }
  list(kind: Kind): Entity[] {
    return this.db
      .prepare("SELECT data FROM entities WHERE kind=? ORDER BY rowid DESC")
      .all(kind)
      .map((row) => JSON.parse(row.data as string));
  }
  get(kind: Kind, id: string): Entity | undefined {
    const row = this.db
      .prepare("SELECT data FROM entities WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  save(kind: Kind, value: Partial<Entity>): Entity {
    const entity = { ...value, id: value.id || randomUUID() } as Entity;
    this.db
      .prepare(
        "INSERT INTO entities(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE kind=excluded.kind",
      )
      .run(entity.id, kind, JSON.stringify(entity));
    return entity;
  }
  delete(kind: Kind, id: string) {
    this.db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id);
  }
  event(
    actor: string,
    action: string,
    resource: string,
    message = "",
    ip = "",
    result: "success" | "failure" = /failed|failure|error|crash/i.test(action)
      ? "failure"
      : "success",
    metadata: Record<string, unknown> = {},
  ) {
    const metadataJson = JSON.stringify(metadata, (key, value) =>
      /(^|[_-])key$|secret|token|password|credential|webhook|(?:api|encryption|stream)[_-]?key/i.test(
        key,
      )
        ? "[redacted]"
        : value,
    );
    const safeMetadata = redact(metadataJson);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.db
        .prepare("SELECT * FROM audit_state WHERE id=1")
        .get() as any;
      if (!state)
        throw new Error("Audit checkpoint is missing; refusing writes");
      const current = {
        time: new Date().toISOString(),
        actor,
        action,
        resource,
        message: redact(message).slice(0, 1200),
        ip: ip.slice(0, 64),
        result,
        metadata:
          safeMetadata.length > 4000
            ? JSON.stringify({ truncated: true })
            : safeMetadata,
      };
      const inserted = this.db
        .prepare(
          "INSERT INTO events(time,actor,action,resource,message,ip,result,metadata,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          current.time,
          current.actor,
          current.action,
          current.resource,
          current.message,
          current.ip,
          current.result,
          current.metadata,
          state.head_hash,
          "pending",
        );
      const id = Number(inserted.lastInsertRowid);
      const event = { id, ...current };
      const hash = this.digestAuditEvent(event, state.head_hash);
      this.db.prepare("UPDATE events SET hash=? WHERE id=?").run(hash, id);

      const maximum = Number(
        (this.db.prepare("SELECT MAX(id) AS id FROM events").get() as any).id,
      );
      const cutoff = maximum - 20000;
      let firstId = state.first_id === null ? null : Number(state.first_id);
      let firstPreviousHash = String(state.first_prev_hash);
      if (cutoff > 0) {
        const first = this.db
          .prepare(
            "SELECT id,prev_hash FROM events WHERE id>? ORDER BY id LIMIT 1",
          )
          .get(cutoff) as any;
        firstId = first ? Number(first.id) : null;
        firstPreviousHash = first?.prev_hash || "";
        this.db.prepare("DELETE FROM events WHERE id<=?").run(cutoff);
      } else if (firstId === null) {
        firstId = id;
        firstPreviousHash = String(state.head_hash);
      }
      const nextState = {
        headId: id,
        headHash: hash,
        firstId,
        firstPreviousHash,
      };
      this.db
        .prepare(
          "UPDATE audit_state SET head_id=?,head_hash=?,first_id=?,first_prev_hash=?,signature=? WHERE id=1",
        )
        .run(
          nextState.headId,
          nextState.headHash,
          nextState.firstId,
          nextState.firstPreviousHash,
          this.signAuditState(nextState),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.onEvent?.(actor, action, resource, redact(message).slice(0, 1200));
  }
  events(
    filters: {
      actor?: string;
      action?: string;
      resource?: string;
      result?: "success" | "failure";
      from?: string;
      to?: string;
      limit?: number;
    } = {},
  ): Array<{
    id: number;
    time: string;
    actor: string;
    action: string;
    resource: string;
    message: string;
    ip: string;
    result: "success" | "failure";
    metadata: Record<string, unknown>;
    previousHash: string;
    hash: string;
  }> {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    for (const [field, column] of [
      ["actor", "actor"],
      ["action", "action"],
      ["resource", "resource"],
    ] as const) {
      const value = filters[field]?.trim();
      if (value) {
        clauses.push(`instr(${column}, ?) > 0`);
        parameters.push(value);
      }
    }
    if (filters.result) {
      clauses.push("result = ?");
      parameters.push(filters.result);
    }
    if (filters.from) {
      clauses.push("time >= ?");
      parameters.push(filters.from);
    }
    if (filters.to) {
      clauses.push("time <= ?");
      parameters.push(filters.to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filters.limit ?? 200, 20000));
    const events = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`)
      .all(...parameters, limit) as Array<{
      id: number;
      time: string;
      actor: string;
      action: string;
      resource: string;
      message: string;
      ip: string;
      result: "success" | "failure";
      metadata: string;
      prev_hash: string | null;
      hash: string | null;
    }>;
    return events.map((event) => ({
      id: Number(event.id),
      time: String(event.time),
      actor: String(event.actor),
      action: String(event.action),
      resource: String(event.resource),
      message: String(event.message),
      ip: String(event.ip),
      result: event.result as "success" | "failure",
      previousHash: String(event.prev_hash || ""),
      hash: String(event.hash || ""),
      metadata: JSON.parse((event.metadata as string) || "{}"),
    }));
  }
  metric(
    streamId: string,
    destinationId: string,
    fps?: number,
    bitrate?: string,
    mediaTime?: string,
  ) {
    const bitrateKbps = bitrate ? Number.parseFloat(bitrate) : null;
    this.db
      .prepare(
        "INSERT INTO stream_metrics(time,stream_id,destination_id,fps,bitrate_kbps,media_time) VALUES(?,?,?,?,?,?)",
      )
      .run(
        new Date().toISOString(),
        streamId,
        destinationId,
        Number.isFinite(fps) ? (fps ?? null) : null,
        Number.isFinite(bitrateKbps) ? bitrateKbps : null,
        mediaTime || null,
      );
    this.db.exec(
      "DELETE FROM stream_metrics WHERE id <= (SELECT COALESCE(MAX(id),0)-200000 FROM stream_metrics)",
    );
  }
  close() {
    this.db.close();
  }
}
