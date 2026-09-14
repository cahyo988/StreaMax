import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPngFixture, fixture, seed } from "./helpers.ts";

test("backup API lists and streams only named archives for administrators", async () => {
  const f = await fixture();
  const backupDir = await mkdtemp(join(tmpdir(), "streamax-backups-"));
  try {
    const filename = "streamax-20260914T120000Z-123.tar.gz";
    const archive = Buffer.from("protected test archive");
    f.config.BACKUP_DIR = backupDir;
    await writeFile(join(backupDir, filename), archive);
    await writeFile(join(backupDir, "unrelated.txt"), "ignore");
    const listing = await f.request("GET", "backups");
    assert.equal(listing.statusCode, 200);
    assert.equal(listing.json().configured, true);
    assert.deepEqual(
      listing.json().backups.map((item: any) => item.name),
      [filename],
    );
    const download = await f.request("GET", `backups/${filename}`);
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "application/gzip");
    assert.equal(
      download.headers["content-disposition"],
      `attachment; filename="${filename}"`,
    );
    assert.deepEqual(download.rawPayload, archive);
    assert.equal(
      (await f.request("GET", "backups/not-an-archive.tar.gz")).statusCode,
      404,
    );
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) AS count FROM events WHERE action='backup.downloaded'",
        )
        .get()!.count,
      1,
    );
  } finally {
    await f.cleanup();
    await rm(backupDir, { recursive: true, force: true });
  }
});

test("workspace logo accepts safe PNGs and serves/removes the branded asset", async () => {
  const f = await fixture();
  try {
    const boundary = "----streamax-logo-test";
    const upload = (image: Buffer) =>
      f.app.inject({
        method: "PUT",
        url: "/api/branding/logo",
        headers: {
          ...f.headers,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          image,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    const png = createPngFixture();
    const saved = await upload(png);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().logoAvailable, true);
    const health = await f.app.inject("/api/health");
    assert.equal(health.json().logoAvailable, true);
    assert.equal(health.json().logoVersion, saved.json().logoUpdatedAt);
    const asset = await f.app.inject("/api/branding/logo");
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers["content-type"], "image/png");
    assert.deepEqual(asset.rawPayload, png);
    assert.equal((await upload(Buffer.from("not a png"))).statusCode, 400);
    assert.equal((await f.request("DELETE", "branding/logo")).statusCode, 200);
    assert.equal((await f.app.inject("/api/branding/logo")).statusCode, 404);
  } finally {
    await f.cleanup();
  }
});

test("authentication requires session, exact origin and CSRF; sessions expire", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject("/api/streams")).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/playlists",
          headers: { ...f.headers, origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/playlists",
          headers: { cookie: f.headers.cookie, origin: f.headers.origin },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal((await f.request("GET", "me")).json().role, "admin");
    f.store.db.exec("UPDATE sessions SET expires=0");
    assert.equal((await f.request("GET", "me")).statusCode, 401);
  } finally {
    await f.cleanup();
  }
});

test("authenticated OpenAPI document describes live routes and write protections", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject("/api/openapi.json")).statusCode, 401);
    assert.equal((await f.app.inject("/api/docs/")).statusCode, 401);
    const response = await f.request("GET", "openapi.json");
    assert.equal(response.statusCode, 200);
    const document = response.json();
    assert.equal(document.openapi, "3.1.0");
    assert.equal(document.servers[0].url, "/api");
    assert.ok(document.paths["/streams/{id}/{action}"].post);
    assert.ok(document.paths["/events.csv"].get);
    assert.equal(
      document.paths["/settings"].get.security[0].sessionCookie.length,
      0,
    );
    assert.equal(
      document.paths["/settings"].put.requestBody.content["application/json"]
        .schema.$ref,
      "#/components/schemas/SettingsInput",
    );
    assert.equal(
      document.components.schemas.SettingsInput.properties.videoRetentionDays
        .maximum,
      3650,
    );

    for (const [path, pathItem] of Object.entries(document.paths) as Array<
      [string, Record<string, any>]
    >) {
      const expected = [...path.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1],
      );
      for (const [method, operation] of Object.entries(pathItem)) {
        if (
          !operation ||
          !["get", "post", "put", "patch", "delete"].includes(method)
        )
          continue;
        const actual =
          (operation as any).parameters
            ?.filter((parameter: any) => parameter.in === "path")
            .map((parameter: any) => parameter.name) || [];
        for (const name of expected)
          assert.ok(actual.includes(name), `${method} ${path} misses ${name}`);
        if (method !== "get" && path !== "/login") {
          const headers = (operation as any).parameters
            ?.filter((parameter: any) => parameter.in === "header")
            .map((parameter: any) => parameter.name.toLowerCase());
          assert.ok(
            headers?.includes("origin"),
            `${method} ${path} misses Origin`,
          );
          assert.ok(
            headers?.includes("x-csrf-token"),
            `${method} ${path} misses CSRF header`,
          );
          assert.ok((operation as any).security?.length);
        }
      }
    }
    const refs: string[] = [];
    const findRefs = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref") refs.push(String(child));
        else findRefs(child);
      }
    };
    findRefs(document);
    for (const reference of refs)
      assert.ok(
        reference.startsWith("#/components/schemas/") &&
          document.components.schemas[reference.split("/").at(-1)!],
        `unresolved OpenAPI reference: ${reference}`,
      );

    const docs = await f.request("GET", "docs/");
    assert.equal(docs.statusCode, 200);
    assert.match(docs.body, /swagger-ui/);
    const uiDocument = (await f.request("GET", "docs/json")).json();
    assert.equal(uiDocument.info.title, "StreaMax API");
    assert.equal(uiDocument.info["x-csrf-token"], f.headers["x-csrf-token"]);
    assert.equal(
      uiDocument.info.description.includes(
        "CSRF token from this protected document",
      ),
      true,
    );
    assert.deepEqual(uiDocument.paths["/settings"].put.security, []);
    const csrf = uiDocument.paths["/settings"].put.parameters.find(
      (parameter: any) => parameter.name === "X-CSRF-Token",
    );
    assert.equal(csrf.required, false);
    assert.equal(
      (await f.request("GET", "docs/static/swagger-ui-bundle.js")).statusCode,
      200,
    );
  } finally {
    await f.cleanup();
  }
});

test("viewer reads but cannot write; viewer can change own password and sign out", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.request("POST", "users", {
          email: "viewer@example.com",
          password: "viewer-password-long",
          role: "viewer",
        })
      ).statusCode,
      200,
    );
    const login = await f.app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: f.config.APP_ORIGIN },
      payload: {
        email: "viewer@example.com",
        password: "viewer-password-long",
      },
    });
    const headers = {
      origin: f.config.APP_ORIGIN,
      cookie: `session=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrf,
    };
    assert.equal(
      (await f.app.inject({ url: "/api/streams", headers })).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/playlists",
          headers,
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.app.inject({ url: "/api/users", headers })).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/logout",
          headers,
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ url: "/api/me", headers })).statusCode,
      401,
    );
  } finally {
    await f.cleanup();
  }
});

test("developer API keys are one-time, scoped, expiring and revocable", async () => {
  const f = await fixture();
  try {
    const readCreate = await f.request("POST", "developer-keys", {
      name: "Reporting client",
      permissions: ["read"],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(readCreate.statusCode, 200);
    const readKey = readCreate.json();
    assert.match(readKey.key, /^smx_[A-Za-z0-9_-]{43}$/);
    const storedHash = f.store.db
      .prepare("SELECT token_hash FROM api_keys WHERE id=?")
      .get(readKey.id)?.token_hash;
    assert.ok(typeof storedHash === "string");
    assert.match(storedHash, /^[a-f0-9]{64}$/);
    assert.notEqual(storedHash, readKey.key);
    const readHeaders = { authorization: `Bearer ${readKey.key}` };
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/settings",
          headers: readHeaders,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "PUT",
          url: "/api/settings",
          headers: readHeaders,
          payload: (await f.request("GET", "settings")).json(),
        })
      ).statusCode,
      403,
    );

    const writeCreate = await f.request("POST", "developer-keys", {
      name: "Deployment client",
      permissions: ["read", "write"],
    });
    const writeKey = writeCreate.json();
    assert.equal(writeCreate.statusCode, 200);
    assert.equal(
      (
        await f.app.inject({
          method: "PUT",
          url: "/api/settings",
          headers: { authorization: `Bearer ${writeKey.key}` },
          payload: (await f.request("GET", "settings")).json(),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/developer-keys",
          headers: { authorization: `Bearer ${writeKey.key}` },
          payload: { name: "Escalation", permissions: ["write"] },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/developer-keys",
          headers: f.headers,
          payload: {
            name: "Too long lived",
            permissions: ["read"],
            expiresAt: new Date(Date.now() + 366 * 86400000).toISOString(),
          },
        })
      ).statusCode,
      400,
    );
    const listed = await f.request("GET", "developer-keys");
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.includes(readKey.key), false);
    assert.equal(listed.body.includes(writeKey.key), false);
    assert.equal(
      (await f.request("DELETE", `developer-keys/${readKey.id}`)).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/settings",
          headers: readHeaders,
        })
      ).statusCode,
      401,
    );
  } finally {
    await f.cleanup();
  }
});

test("stream secrets are encrypted, omitted on reads and preserved on update", async () => {
  const f = await fixture();
  try {
    const body = {
      name: "YouTube",
      platform: "YouTube",
      url: "rtmps://ingest.example/live",
      key: "sensitive-stream-key",
      enabled: true,
    };
    const response = await f.request("POST", "destinations", body);
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes(body.key));
    assert.ok(!response.body.includes("secret"));
    const saved = f.store.get("destinations", response.json().id)!;
    assert.notEqual(saved.secret, body.key);
    const { key, ...withoutKey } = body;
    assert.equal(
      (
        await f.request("PUT", `destinations/${saved.id}`, {
          ...withoutKey,
          name: "Updated",
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.get("destinations", saved.id)!.secret, saved.secret);
    assert.ok(
      !(await f.request("GET", "destinations")).body.includes(body.key),
    );
    assert.equal(
      (
        await f.request("POST", "destinations", {
          ...body,
          url: "file:///etc/passwd",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.request("POST", "destinations", {
          ...body,
          url: "rtmp://user:pass@host/live",
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.cleanup();
  }
});

test("destination enable toggle preserves secrets and refuses destinations in use", async () => {
  const f = await fixture();
  try {
    const { destination, stream } = seed(f);
    const path = `destinations/${destination.id}/enabled`;
    const disabled = await f.request("PATCH", path, { enabled: false });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().enabled, false);
    assert.ok(!disabled.body.includes("private-test-key"));
    assert.ok(f.store.get("destinations", destination.id)!.secret);

    f.store.save("streams", { ...stream, desired: "running" });
    const blocked = await f.request("PATCH", path, { enabled: true });
    assert.equal(blocked.statusCode, 409);
    assert.equal(f.store.get("destinations", destination.id)!.enabled, false);

    f.store.save("streams", { ...stream, desired: "stopped" });
    const enabled = await f.request("PATCH", path, { enabled: true });
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.json().enabled, true);
    assert.ok(
      f.store
        .events({ action: "destination.update" })
        .some((event) => event.resource === destination.id),
    );
  } finally {
    await f.cleanup();
  }
});

test("destination probe reports TCP/TLS reachability without exposing keys", async () => {
  const probed: string[] = [];
  const f = await fixture({
    destinationProbe: async (address) => {
      probed.push(address);
      if (address.includes("offline")) throw new Error("private probe detail");
      return { transport: "tls" };
    },
  });
  try {
    const { destination } = seed(f);
    const result = await f.request(
      "POST",
      `destinations/${destination.id}/test`,
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().ok, true);
    assert.match(result.json().message, /stream key.*not verified/i);
    assert.deepEqual(probed, [destination.url]);
    assert.ok(!result.body.includes("private-test-key"));

    const offline = f.store.save("destinations", {
      ...destination,
      id: randomUUID(),
      name: "Offline endpoint",
      url: "rtmp://offline.example/live",
    });
    const failed = await f.request("POST", `destinations/${offline.id}/test`);
    assert.equal(failed.statusCode, 200);
    assert.equal(failed.json().ok, false);
    assert.ok(!failed.body.includes("private probe detail"));
    assert.equal(
      f.store.events({ action: "destination.test", resource: offline.id })[0]
        .result,
      "failure",
    );
  } finally {
    await f.cleanup();
  }
});

test("resource validation and reference deletion guards", async () => {
  const f = await fixture();
  try {
    const s = seed(f);
    assert.equal(
      (await f.request("DELETE", `videos/${s.video.id}`)).statusCode,
      409,
    );
    assert.equal(
      (await f.request("DELETE", `playlists/${s.playlist.id}`)).statusCode,
      409,
    );
    assert.equal(
      (
        await f.request("POST", "playlists", {
          name: "Missing",
          videoIds: [randomUUID()],
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.request("POST", "profiles", {
          name: "Bad",
          width: 1279,
          height: 720,
          fps: 30,
          bitrate: 2000,
          audioBitrate: 128,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await f.request("DELETE", `streams/${s.stream.id}`)).statusCode,
      200,
    );
    assert.equal(
      (await f.request("DELETE", `playlists/${s.playlist.id}`)).statusCode,
      200,
    );
    assert.equal(
      (await f.request("DELETE", `videos/${s.video.id}`)).statusCode,
      200,
    );
  } finally {
    await f.cleanup();
  }
});

test("single-video streams support unlimited, one-time and fixed-count playback", async () => {
  const f = await fixture();
  try {
    const { stream, video } = seed(f);
    const fixed = await f.request("POST", "streams", {
      name: "Three plays",
      playlistId: stream.playlistId,
      profileId: stream.profileId,
      destinationIds: stream.destinationIds,
      loop: false,
      playCount: 3,
    });
    assert.equal(fixed.statusCode, 200, fixed.body);
    assert.equal(fixed.json().playCount, 3);
    assert.equal(fixed.json().loop, false);

    const once = await f.request("POST", "streams", {
      name: "One play",
      playlistId: stream.playlistId,
      profileId: stream.profileId,
      destinationIds: stream.destinationIds,
      loop: false,
    });
    assert.equal(once.statusCode, 200, once.body);
    assert.equal(once.json().playCount, undefined);

    const manyPlaylist = f.store.save("playlists", {
      name: "Two videos",
      videoIds: [video.id, video.id],
    });
    const invalid = await f.request("POST", "streams", {
      name: "Invalid fixed count",
      playlistId: manyPlaylist.id,
      profileId: stream.profileId,
      destinationIds: stream.destinationIds,
      loop: false,
      playCount: 3,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(
      (
        await f.request("POST", "streams", {
          name: "Conflicting modes",
          playlistId: stream.playlistId,
          profileId: stream.profileId,
          destinationIds: stream.destinationIds,
          loop: true,
          playCount: 3,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.request("POST", "streams", {
          name: "Out of bounds",
          playlistId: stream.playlistId,
          profileId: stream.profileId,
          destinationIds: stream.destinationIds,
          loop: false,
          playCount: 1001,
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.cleanup();
  }
});

test("schedule reservations reject overlaps, allow adjacency and guard stream edits", async () => {
  const f = await fixture();
  try {
    const { stream } = seed(f);
    const start = Date.now() + 60_000;
    const body = {
      name: "Morning",
      streamId: stream.id,
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + 60_000).toISOString(),
    };
    assert.equal((await f.request("POST", "schedules", body)).statusCode, 200);
    assert.equal((await f.request("POST", "schedules", body)).statusCode, 409);
    assert.equal(
      (
        await f.request("POST", "schedules", {
          ...body,
          startAt: body.endAt,
          endAt: new Date(start + 120_000).toISOString(),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.request("PUT", `streams/${stream.id}`, stream)).statusCode,
      409,
    );
    assert.equal(
      (
        await f.request("POST", "schedules", {
          ...body,
          startAt: new Date(0).toISOString(),
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.cleanup();
  }
});

test("login is rate limited and bad credentials do not leak user existence", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 4; i++) {
      const response = await f.app.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin: f.config.APP_ORIGIN },
        payload: { email: "missing@example.com", password: "wrong" },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, "Invalid email or password");
    }
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/login",
          headers: { origin: f.config.APP_ORIGIN },
          payload: { email: "missing@example.com", password: "wrong" },
        })
      ).statusCode,
      429,
    );
  } finally {
    await f.cleanup();
  }
});

test("media routes cannot bypass authentication with encoded paths", async () => {
  const f = await fixture();
  try {
    const { video } = seed(f);
    for (const url of [
      `/api/media/${video.id}`,
      `/api%2fmedia/${video.id}`,
      `/api/media/..%2f..%2fstreamax.sqlite`,
    ]) {
      const response = await f.app.inject(url);
      assert.notEqual(response.headers["content-type"], "video/mp4");
      assert.ok(!response.body.includes("SQLite format"));
    }
    assert.equal((await f.request("GET", "media/../../.env")).statusCode, 404);
  } finally {
    await f.cleanup();
  }
});

test("audit events expose source, result and redacted structured metadata", async () => {
  const f = await fixture();
  try {
    f.store.event(
      "operator@example.com",
      "destination.update",
      "destination-1",
      "",
      "203.0.113.8",
      "success",
      { enabled: false, apiKey: "must-not-be-stored" },
    );
    const events = (await f.request("GET", "events")).json() as Array<any>;
    const audit = events.find((event) => event.action === "destination.update");
    assert.equal(audit.ip, "203.0.113.8");
    assert.equal(audit.result, "success");
    assert.equal(audit.metadata.enabled, false);
    assert.equal(audit.metadata.apiKey, "[redacted]");
    assert.ok(!JSON.stringify(audit).includes("must-not-be-stored"));
    assert.equal(
      (await f.request("GET", "events/integrity")).json().valid,
      true,
    );
    f.store.db
      .prepare("UPDATE events SET message='tampered' WHERE id=?")
      .run(audit.id);
    const integrity = await f.request("GET", "events/integrity");
    assert.equal(integrity.statusCode, 200);
    assert.equal(integrity.json().valid, false);
    assert.equal(integrity.json().reason, "event_hash_mismatch");
    assert.equal((await f.request("POST", "playlists", {})).statusCode, 400);
    const rejected = (await f.request("GET", "events"))
      .json()
      .find((event: any) => event.action === "request.failed");
    assert.equal(rejected.result, "failure");
    assert.equal(rejected.metadata.statusCode, 400);
  } finally {
    await f.cleanup();
  }
});

test("audit filters and CSV export cover retained events safely", async () => {
  const f = await fixture();
  try {
    f.store.event("operator@example.com", "stream.start", "stream-1");
    f.store.event(
      "=2+2@example.com",
      "request.failed",
      "resource-1",
      "invalid request",
      "203.0.113.9",
      "failure",
    );
    const filtered = await f.request(
      "GET",
      "events?actor=operator&action=stream&result=success",
    );
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().length, 1);
    assert.equal(filtered.json()[0].resource, "stream-1");
    assert.equal(
      (
        await f.request(
          "GET",
          "events?from=2026-02-02T00%3A00%3A00Z&to=2026-02-01T00%3A00%3A00Z",
        )
      ).statusCode,
      400,
    );
    const csv = await f.request("GET", "events.csv");
    assert.equal(csv.statusCode, 200);
    assert.ok(String(csv.headers["content-type"]).includes("text/csv"));
    assert.ok(csv.body.includes("'=2+2@example.com"));
    assert.ok(csv.body.startsWith("id,time_utc,"));
    assert.ok(csv.body.includes("previous_hash,chain_hash"));
  } finally {
    await f.cleanup();
  }
});

test("system settings brand the workspace and restrict writes in maintenance mode", async () => {
  const f = await fixture();
  try {
    const { video, stream } = seed(f);
    const currentProfile = f.store.list("profiles")[0];
    const unreferencedProfile = f.store.save("profiles", {
      ...currentProfile,
      id: randomUUID(),
      name: "Default only",
    });
    assert.equal(
      (
        await f.request("POST", "users", {
          email: "operator@example.com",
          password: "operator-password-long",
          role: "operator",
        })
      ).statusCode,
      200,
    );
    const login = await f.app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: f.config.APP_ORIGIN },
      payload: {
        email: "operator@example.com",
        password: "operator-password-long",
      },
    });
    const operatorHeaders = {
      origin: f.config.APP_ORIGIN,
      cookie: `session=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrf,
    };
    const enable = await f.request("PUT", "settings", {
      applicationName: "Night Studio",
      maintenanceMode: true,
      defaultProfileId: unreferencedProfile.id,
      defaultBitrate: 3200,
      retryAttempts: 2,
      videoRetentionDays: 14,
      timeZone: "Asia/Jakarta",
    });
    assert.equal(enable.statusCode, 200);
    const settings = (await f.request("GET", "settings")).json();
    assert.equal(settings.applicationName, "Night Studio");
    assert.equal(settings.defaultProfileId, unreferencedProfile.id);
    assert.equal(settings.defaultBitrate, 3200);
    assert.equal(settings.retryAttempts, 2);
    assert.equal(settings.videoRetentionDays, 14);
    assert.equal(settings.timeZone, "Asia/Jakarta");
    assert.equal(
      (await f.request("DELETE", `profiles/${unreferencedProfile.id}`))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.app.inject({ url: "/api/settings", headers: operatorHeaders }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/playlists",
          headers: operatorHeaders,
          payload: { name: "Paused", videoIds: [video.id] },
        })
      ).statusCode,
      503,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/streams/${stream.id}/stop`,
          headers: operatorHeaders,
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ url: "/api/streams", headers: operatorHeaders }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await f.request("POST", "playlists", {
          name: "Admin operation",
          videoIds: [video.id],
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.request("PUT", "settings", {
          applicationName: "Night Studio",
          maintenanceMode: false,
          defaultProfileId: unreferencedProfile.id,
          defaultBitrate: 3200,
          retryAttempts: 2,
          videoRetentionDays: 14,
          timeZone: "Asia/Jakarta",
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.cleanup();
  }
});
