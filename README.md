# StreaMax

A single-server streaming control panel. Upload videos, arrange playlists, connect
RTMP/RTMPS destinations, and start or schedule real FFmpeg broadcasts from a browser.
This is the first implementation of the revised [development plan](plan.md), not the
complete 30-module product roadmap.

## Run locally

Requires Node.js 22.13+ and FFmpeg/FFprobe on PATH (with libx264 and AAC support).
Node 22 currently emits an experimental warning for its built-in SQLite module.

1. Run `npm ci` (`npm.cmd ci` in PowerShell if script execution is restricted).
2. Copy `.env.example` to `.env`.
3. Set `ADMIN_EMAIL`, a unique `ADMIN_PASSWORD` of at least 12 characters, and
   `ENCRYPTION_KEY`. Generate the key with:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. Run `npm run dev` and open **http://localhost:5173**.
5. Sign in with the bootstrap administrator credentials.

Run `npm run doctor` to check FFmpeg/FFprobe, storage permissions and free space,
browser origin, and whether the configured API port is already occupied. The same
checks run before the server accepts requests and never print credential values.

`APP_ORIGIN` must exactly match the browser's origin. The backend binds to loopback
on port 3000 and Vite proxies `/api`. No default password or sample streams ship.
Environment credentials bootstrap an empty database; changing them later does not
reset an existing account. Use Settings to change your password.

For a built local app, run `npm run build`, set `APP_ORIGIN=http://localhost:3000`,
then run `npm start` and open that address. The server serves `dist/` when present.

## First broadcast

1. **Video library → Upload video.** One upload/normalization at a time; the browser
   shows upload progress followed by processing status. Inputs are normalized to
   720p30 H.264/AAC stereo. Silent videos receive an audio track. Original uploads
   are removed after processing; the stored video is the normalized rendition.
2. **Playlists → Create playlist.** Add library videos and reorder using arrows.
   Repeated items are supported. All items must use the managed library.
3. **Destinations → Create destination.** Paste the provider's ingest server URL
   and stream key into separate fields. Keys are encrypted at rest and omitted
   from API responses. RTMP URLs containing usernames, passwords, queries or
   fragments are rejected. Credentials belong in the stream-key field.
4. **Create stream.** Choose a playlist, encoding profile and one or more enabled
   destinations. For a one-video playlist, choose continuous looping, one playback,
   or a fixed total of 2-1,000 plays (including the first playback). Multi-video
   playlists can play once or loop continuously. Each destination consumes one
   worker output and its own encoder. Preview uses one extra slot.
5. Optionally choose a PNG workspace logo watermark, a text overlay, or local HLS
   preview. The preview is private to signed-in users and may lag behind RTMP.
6. Start the stream and check reception in your platform's studio. **Sending output
   means FFmpeg is making local frame progress**, not that viewers can watch. The
   dashboard reports that distinction and does not invent platform telemetry.
7. Now Playing reports the video, position, next item and loop number. Unexpected
   recovery resumes from a per-destination checkpoint; manual stop/start begins at
   the first playlist item.

Schedules support one-time, daily or weekly runs up to 366 occurrences, with an
optional schedule-specific playlist. Admins configure the workspace IANA timezone
in Settings; schedule entry and operational/reporting timestamps use that
timezone and are stored as UTC. Nonexistent local times during a daylight-saving
transition are rejected; repeated times choose the earlier occurrence. Overlapping
stream/destination reservations are rejected. Pending schedules
lock stream configuration. A busy destination or exhausted worker capacity causes
the scheduled start to fail with an activity event. Missed windows are not replayed.
Manual stop/restart cancels a running schedule's ownership; its old end time will
not stop a subsequent manual broadcast. Delete a pending schedule to cancel it.
Every occurrence becomes an individually visible and cancellable reservation;
the full series is checked for conflicts before any are saved.

## Safety and operating model

- One process, one local SQLite database, one worker. **Do not run replicas against
  the same data directory.** SQLite WAL persists configuration, sessions, schedules
  and the last 20,000 activity events; the API displays the latest 200.
- Passwords use salted scrypt. Cookies are HTTP-only and SameSite Strict. Every
  mutation requires the configured Origin and, after login, a session CSRF token.
  Sessions expire after 12 hours or 30 days with Remember me. Password changes
  invalidate all user sessions. Login has a per-IP rate limit.
- Activity records include actor, action/resource, timestamp, source IP, result and
  bounded redacted metadata. The event API returns only the latest 200 of up to
  20,000 retained events; proxy forwarding headers are not trusted for client IP.
- Admins manage team accounts, operators manage media and broadcasts, viewers can
  only read operational data and manage their own password/session. All three
  roles belong to the same trusted workspace and can preview its media.
- Admin-configured maintenance mode blocks operator/viewer mutations while keeping
  stream-stop, sign-out and password-change actions available; scheduled broadcasts
  are not paused. Admins retain access to turn the mode off.
- Admin system settings choose the workspace name/timezone, default profile for new
  streams, default bitrate for new profiles, retry attempts (0–10) per destination,
  and optional video retention.
  Video retention is disabled by default; when enabled, an hourly worker removes
  videos older than the configured age only if no playlist references them. The
  admin is warned before saving an enabled policy; every automatic removal is
  recorded in the activity log. Removed media cannot be recovered by the app.
  FFmpeg paths, storage/temp paths, network interfaces and log verbosity remain
  environment-managed and require a controlled restart to change.
- Uploaded files are probed and decoded with local-file protocols only. Filenames
  on disk use generated UUIDs. No remote input URLs or custom FFmpeg arguments.
- Stream keys use AES-256-GCM. Preserve `ENCRYPTION_KEY` for restore; there is no
  automatic key-rotation migration. Keys also exist in FFmpeg process arguments;
  restrict OS access and do not give untrusted users shell access to the host.
- RTMP destinations are trusted-operator configuration. Restrict outbound network
  access at the host/firewall if operators must not reach internal services.
- Each output retries independently, up to the configured retry attempts (default
  five: 2, 4, 8, 16, 30 seconds).
  A 60-second frame-progress stall kills the process and triggers recovery. The
  retry budget is per session, not reset by brief progress. Exhausted outputs stay
  failed until the operator restarts. Other destinations continue independently.
- Graceful shutdown kills child encoders and retains desired-running state. On
  restart, unexpired streams resume from the beginning. Run under Docker or a
  systemd service with `KillMode=control-group` so abrupt app failure also reaps
  FFmpeg children. Bare `kill -9` of Node can leave orphan children on the host.
- Raw FFmpeg stderr is drained but not exposed: it may contain credentials outside
  an RTMP URL. Activity logs report controlled lifecycle and retry messages. FPS,
  bitrate and media time come from FFmpeg's separate progress pipe.
- Referenced media/configuration cannot be deleted. Active or scheduled resources
  cannot be edited. Upload size and output capacity are configurable; normalization
  has a one-hour timeout. Budget disk space for normalized output, which can be
  larger than the input. Application limits are not a substitute for volume quotas.
- Current storage metrics describe the filesystem, not a user quota. CPU/memory
  metrics use OS counters and may show host totals when containerized. Network
  throughput uses Linux `/proc/net/dev`; temperature is shown only when the host
  exposes thermal-zone sensors. Unsupported counters display as unavailable.

## Deploy on a Linux VPS

Set `.env` with `APP_ORIGIN=https://stream.example.com`, `COOKIE_SECURE=true`, and
strong bootstrap secrets. Run `docker compose up -d --build`. The image includes
FFmpeg, runs as the unprivileged `node` user, and uses `tini` for process reaping.
SQLite and media live in the persistent `streamax-data` volume. Port 3000 is bound
only to host loopback; it is intended for an HTTPS reverse proxy on the host.

Example Caddy configuration (install Caddy on the host and point DNS at the VPS):

```caddyfile
stream.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

With Traefik, place the proxy and app on a private Docker network and route the
HTTPS hostname to port 3000. Keep the configured APP_ORIGIN identical to that
hostname and avoid proxy timeouts shorter than video normalization. Do not expose
the Vite development server publicly. The app does not trust forwarded IP headers;
behind a proxy, login rate limits apply to the proxy address collectively.

The default Compose limits are 4 CPUs, 4 GiB RAM and 512 PIDs. Tune output capacity
and encoding profiles to the VPS; two 1080p outputs can be substantially more
expensive than two 720p outputs. Encoding a 720p normalized source at 1080p does not
recover source detail. Full-resolution ingestion is future work.

## Backup and restore

Use a maintenance window. Stop streams in the UI and cancel schedules that must
not run during maintenance. The helper uses a one-off container and requires the
application service to be stopped so SQLite WAL and media are captured together.
Create a protected host directory writable by container UID 1000, then run:

```sh
sudo install -d -o 1000 -g 1000 /srv/streamax/backups
printf '\nBACKUP_PATH=/srv/streamax/backups\n' >> .env
docker compose stop streamax
docker compose --profile maintenance run --rm streamax-maintenance
docker compose start streamax
```

The running app mounts this directory read-only and admin users can list/download
archives from the Backup page. Creating archives remains an offline maintenance
operation; the app will not copy a live SQLite database.

To opt into keeping only the newest 14 helper archives, add
`-e BACKUP_KEEP=14` to the `docker compose run` command. The default is no
deletion. Archives contain the full SQLite database and media. Back up `.env`
and `ENCRYPTION_KEY` separately to secure storage; archives are not encrypted.
Backups contain password hashes, encrypted destinations and session records.

To restore without overwriting the current named volume, stop the app and use the
restore overlay to create a separate volume. Substitute the actual archive name:

```sh
docker compose stop streamax
docker compose -f compose.yaml -f compose.restore.yaml --profile maintenance run --rm -e ARCHIVE=/backups/streamax-YYYYMMDDTHHMMSSZ-PID.tar.gz -e RESTORE_DIR=/data streamax-maintenance scripts/restore.sh
docker compose -f compose.yaml -f compose.restore.yaml up -d streamax
```

The restore helper validates paths and file types, stages extraction, and only
accepts a new or empty target; the original volume remains available for rollback.
Restore the original `.env`/encryption key before starting and verify login, media
preview, destinations and schedules before broadcasting. For direct Linux data
directories, run `sh scripts/backup.sh` / `sh scripts/restore.sh` with the documented
`DATA_DIR`, `BACKUP_DIR`, `ARCHIVE` and `RESTORE_DIR` variables.

Daily scheduled backup is available using the included systemd timer. Copy
`deploy/backup.env.example` to `/etc/streamax-backup.env`, set the absolute project
and external backup paths, install `deploy/streamax-backup.service` and
`deploy/streamax-backup.timer` in `/etc/systemd/system`, then enable the timer with
`systemctl enable --now streamax-backup.timer`. The job stops the app for a
consistent SQLite/media archive and restarts it afterward. It defaults to retaining
7 archives (`BACKUP_KEEP` can be changed). Set up a protected rclone remote and
`BACKUP_REMOTE=remote:path` to copy the completed archive and verify it offsite.
Store `.env` and `ENCRYPTION_KEY` separately; they are never uploaded by this job.
Test the service in a VPS maintenance window before relying on unattended backups.

## Verify

```sh
npm run check
npm run test:backup
npx playwright install chromium
npm run test:browser
```

`check` type-checks the server/UI/tests, builds the UI and runs unit/API tests plus
a real local FFmpeg/RTMP integration test. The media test reports a skip when
FFmpeg/FFprobe are unavailable; CI installs them. Tests use isolated temporary
directories and never use your configured application database or destinations.
`test:backup` verifies a temporary backup/retention/restore round trip and refuses
to overwrite non-empty data.
Browser tests cover login, resource creation, schedule/settings timezone, workspace
logo upload and login preview, destination reachability testing and enable/disable,
audit filters/CSV export, logout, mobile and tablet layout, plus
English/Indonesian selection persistence. The destination probe checks only TCP or
TLS reachability; it never sends the stream key and cannot verify platform ingest.
Indonesian covers the
primary navigation and operational views, including dashboard/media, resource
dialogs, notifications, audit and analytics, as well as account/settings and
backup. Generic backend/validation errors and some secondary microcopy may remain
English. Set
`PLAYWRIGHT_CHROME_CHANNEL=chrome` to use an installed Chrome instead of downloading
Chromium. `npm run format` formats source and configuration.

Deployment gates still required: an actual YouTube/Facebook/Twitch ingest test,
a 24-hour Linux soak test, network interruption/load tests and a backup/restore
exercise. Local integration evidence does not establish production uptime.

## API

All routes use `/api`. Browser login returns a CSRF token and sets a session cookie.
Use both cookie and `X-CSRF-Token`, plus the configured `Origin`, for mutations.

| Route                                                                          | Behavior                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `POST /login`, `GET /me`, `POST /logout`                                       | Sessions                                                                                           |
| `POST /password`                                                               | Change own password and invalidate sessions                                                        |
| `GET /notifications`, `PUT /notifications`, `POST /notifications/test`         | Admin-configured Telegram or Discord event alerts with durable retries                             |
| `GET/PUT /settings`                                                            | Admin workspace name, timezone, defaults, media retention and maintenance mode                     |
| `GET /branding/logo`, `PUT/DELETE /branding/logo`                              | Public PNG branding asset; admin upload/removal (1 MB, 2048 × 1024 max)                            |
| `GET /backups`, `GET /backups/:name`                                           | Admin list/download of completed archives from configured read-only `BACKUP_DIR`                   |
| `GET /analytics?from=<ISO>&to=<ISO>`, `GET /analytics.csv?...`                 | Stream/destination reports and session CSV (up to 366 days)                                        |
| `GET /users`, `POST /users`, `PATCH /users/:id`                                | Admin list/create/activate/deactivate                                                              |
| `GET /videos`, `POST /videos`, `DELETE /videos/:id`                            | Library and multipart upload (`file`)                                                              |
| `GET/POST /uploads`, `PATCH/DELETE /uploads/:id`, `POST /uploads/:id/complete` | Owned, resumable 1 MiB chunk uploads                                                               |
| `GET /diagnostics`, `GET /preview/:id/:file`                                   | Runtime preflight checks and authenticated local HLS encoder preview                               |
| `GET /media/:id`                                                               | Authenticated normalized video preview; range requests supported                                   |
| `GET/POST /playlists`, `/profiles`, `/destinations`, `/streams`, `/schedules`  | List/create                                                                                        |
| `PUT/DELETE /<resource>/:id`                                                   | Replace/delete configuration                                                                       |
| `POST /streams/:id/start`, `/stop`, `/restart`                                 | Stream control                                                                                     |
| `GET /overview`, `/events`, `/health`                                          | Metrics, audit events, public liveness                                                             |
| `GET /events.csv`                                                              | Filterable audit export with chain hashes (latest 20,000 retained events)                          |
| `GET /events/integrity`                                                        | Admin verification of retained HMAC chain and signed checkpoint                                    |
| `GET /openapi.json`                                                            | Authenticated OpenAPI 3.1 document for the browser/session API                                     |
| `GET /docs/`                                                                   | Authenticated interactive Swagger UI; browser session is automatic and CSRF is added for mutations |
| `GET/POST /developer-keys`, `DELETE /developer-keys/:id`                       | Admin session manages bearer keys with read/write permissions and optional expiry                  |

The authenticated `/api/openapi.json` response can be imported into compatible
Swagger tools to browse or generate clients. The in-app `/api/docs/` provides the
same API interactively; keep the signed-in session active, and its Try it out
requests use the browser session and automatically obtain the CSRF token for
mutations. Admins can also create/revoke developer API keys through the documented
`/api/developer-keys` endpoints. Each key is shown only once, stored as a hash, and
can be limited to read or write access with optional expiry. The Node CLI supports
`streams list|start|stop|restart`:

```sh
STREAMAX_API_URL=https://studio.example/api STREAMAX_API_KEY=smx_... npm run cli -- streams list
```

Use an HTTPS API URL except for local development.

Administrators configure one signed outbound webhook in Settings, select stream
start/stop/failure and schedule start/failure events, and send a manual test.
Endpoint URLs and signing secrets are encrypted and never returned after saving
(only the endpoint host is displayed). Blank inputs preserve saved credentials.
The receiver must use public HTTPS without URL credentials, query or fragment.
DNS answers are checked on every attempt and the selected address is pinned to
the TLS connection; local/private addresses and redirects are rejected.

Each JSON delivery includes `schema_version: 1`, `id`, `event`, `occurred_at`,
`actor`, `resource: { id, name }`, and `details`. `stream.started` means the worker
accepted a broadcast start, not confirmation from a provider. `schedule.started`
identifies the schedule, separately from its stream-start event. A manual test
uses `webhook.test` and does not start a broadcast.

Verify `X-StreaMax-Signature` as `sha256=<hex HMAC-SHA256>` using your signing secret
over the exact UTF-8 bytes of `X-StreaMax-Timestamp + "." + rawRequestBody`.
Validate the timestamp as Unix seconds within a replay window (for example five
minutes), compare signatures in constant time, and deduplicate the signed JSON
`id` before applying side effects. Require `X-StreaMax-Delivery` to match that ID.
The event name is also available as `X-StreaMax-Event`; receivers should use the
signed JSON event, since these convenience headers are not signed separately.
Return a 2xx status when the event has been accepted.

Deliveries are persisted as encrypted SQLite envelopes before sending and resume
after restart. There are at most three total attempts, including an interrupted
attempt; retries keep the same ID/body and refresh the signature timestamp.
Up to ten requests execute concurrently, with a maximum 1,000 pending deliveries.
Completed envelopes are erased; up to 1,000 terminal records plus ordinary audit
events remain. A full queue or exhausted delivery creates a generic failure event.
Settings changes apply to future events; queued envelopes retain their original
endpoint and signing secret. Receivers must tolerate duplicate delivery after a
crash. Audit insertion and enqueue are separate commits, so a crash between them
can lose an event; this is not an exactly-once transactional outbox. An actual
public receiver/TLS smoke test remains a deployment gate.

Activity records are HMAC-SHA256 chained and the signed checkpoint uses
`ENCRYPTION_KEY`; admins can inspect retained-chain integrity at
`/api/events/integrity`. Keep that key in protected backup storage. This local
verification detects retained-row changes but cannot prove that both the database
and key were not removed or compromised; external archival/anchoring remains open.

Administrators can configure one Telegram bot/chat or Discord webhook, select
stream and schedule events, and send a test notification from Settings. Tokens and
webhook URLs are encrypted at rest and masked in responses. Delivery uses fixed
HTTPS provider hosts, does not follow redirects, and suppresses Discord mentions.
Failed deliveries create a generic activity event; provider response bodies and
credentials are never logged. Configure only a private webhook or a bot/chat your
team controls. Notifications cover stream start/stop, destination retry/failure,
schedule failure, CPU/disk thresholds, and stalled encoders. Failed messages persist
in an encrypted queue and retry up to three times, including after an app restart.
There is no email transport or per-user routing.

Analytics reports summarize recorded stream sessions, output failures/retries,
failed schedules and locally observed destination uptime, connection failures,
bitrate and FPS. CSV export contains stream session history. Reports use up to
20,000 retained activity events and 200,000 worker samples (sampled every 30
seconds); short broadcasts may have no performance sample. These are local
FFmpeg observations, not provider audience or ingest-health analytics. Provider
views, likes, comments and watch time require OAuth/API integrations and are not
included.

The delivered features include resumable uploads, authenticated local HLS previews,
daily/weekly scheduling, checkpointed recovery, Now Playing, logo/text overlays,
threshold alerts and daily/offsite backup automation. This version excludes official
provider OAuth/metadata APIs (including YouTube), email password recovery and
notifications, hardware encoding, platform audience analytics, multi-tenancy and
distributed workers. Remaining roadmap and deployment gates are in `plan.md`.

Framework references: [Fastify v5](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/),
[Node SQLite](https://nodejs.org/api/sqlite.html), and
[static-file plugin compatibility](https://github.com/fastify/fastify-static#compatibility).
Provider references: [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)
and [Discord Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook).
