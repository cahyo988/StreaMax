import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.ts";

test("audit metadata migration preserves the existing event table", () => {
  const directory = mkdtempSync(join(tmpdir(), "streamax-audit-migration-"));
  let store: Store | undefined;
  try {
    const legacy = new DatabaseSync(join(directory, "streamax.sqlite"));
    legacy.exec(
      "CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,message TEXT NOT NULL)",
    );
    legacy
      .prepare(
        "INSERT INTO events(time,actor,action,resource,message) VALUES(?,?,?,?,?)",
      )
      .run("2026-01-01T00:00:00.000Z", "admin", "stream.start", "stream-1", "");
    legacy.close();

    store = new Store(directory, "cd".repeat(32));
    const event = store.events()[0] as any;
    assert.equal(event.action, "stream.start");
    assert.equal(event.ip, "");
    assert.equal(event.result, "success");
    assert.deepEqual(event.metadata, {});
    assert.equal(store.auditIntegrity().valid, true);
    store.event(
      "admin",
      "stream.stop",
      "stream-1",
      "",
      "127.0.0.1",
      "success",
      {
        encryptionKey: "do-not-persist",
      },
    );
    const migrated = store.events()[0] as any;
    assert.equal(migrated.ip, "127.0.0.1");
    assert.equal(migrated.metadata.encryptionKey, "[redacted]");
    assert.equal(store.auditIntegrity().valid, true);
    store.db
      .prepare("UPDATE events SET message='tampered' WHERE id=?")
      .run(migrated.id);
    assert.equal(store.auditIntegrity().valid, false);
    store.close();
    store = undefined;
    const altered = new DatabaseSync(join(directory, "streamax.sqlite"));
    altered.exec("DELETE FROM audit_state WHERE id=1");
    altered.close();
    store = new Store(directory, "cd".repeat(32));
    assert.equal(store.auditIntegrity().reason, "checkpoint_missing");
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit checkpoint detects deleted tail rows and a changed HMAC key", () => {
  const directory = mkdtempSync(join(tmpdir(), "streamax-audit-integrity-"));
  let store: Store | undefined;
  try {
    store = new Store(directory, "ef".repeat(32));
    store.event("admin", "settings.update", "system");
    store.event("admin", "user.create", "user-1");
    assert.equal(store.auditIntegrity().valid, true);
    const tail = store.db.prepare("SELECT MAX(id) AS id FROM events").get() as {
      id: number;
    };
    store.db.prepare("DELETE FROM events WHERE id=?").run(tail.id);
    assert.equal(store.auditIntegrity().reason, "checkpoint_head_mismatch");
    store.close();
    store = new Store(directory, "fa".repeat(32));
    assert.equal(store.auditIntegrity().reason, "checkpoint_signature_invalid");
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
