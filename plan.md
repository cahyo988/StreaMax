# StreaMax — Development Plan

## Implementation baseline (2026-09-14)

This section supersedes conflicting release assignments below. The original module
catalog remains the long-term backlog, not a claim that every feature ships in v0.1.

### Decisions

- Product name: StreaMax. Target: one trusted operator team on one Linux VPS.
- First delivery: a working vertical slice, including security, tests, deployment,
  scheduling and recovery from day one. No simulated LIVE status or seeded media.
- TypeScript + Fastify API, React + Vite browser UI, FFmpeg/FFprobe media engine.
  A client-rendered control panel does not require Next.js server rendering.
- SQLite WAL persists configuration, sessions, schedules and audit events. One
  application process owns FFmpeg children; do not run multiple replicas. This
  deliberately replaces PostgreSQL/Redis/BullMQ for the single-server baseline.
- Store media on a persistent volume; encrypt stream keys with AES-256-GCM using
  an environment-provided key. Never return stored keys to the browser.
- Use a separate encoding process per destination for fault isolation initially.
  Shared encoding/fan-out is a later optimization with its own failure tests.
- Only uploaded, probed files are inputs. Normalize uploaded video/audio to a
  consistent H.264/AAC format before playlist playback. No arbitrary shell args.
- UTC timestamps for one-shot schedules; admins choose a workspace IANA timezone
  used for schedule entry and operational/reporting displays. Nonexistent DST wall
  times are rejected; ambiguous fall-back times resolve to the earlier instant.

### Release sequence and acceptance gates

1. Foundation: reproducible install/build; validated environment; SQLite schema;
   bootstrap admin, password hashing, expiring sessions, CSRF/origin protection,
   rate limiting, admin/operator/viewer roles and audit logging.
2. Media/control: streamed bounded uploads, FFprobe validation, normalized media,
   video preview, playlist ordering, profiles, masked destinations, stream CRUD.
3. Execution: real FFmpeg child processes, per-destination status/progress,
   idempotent start/stop, destination exclusivity, bounded exponential recovery,
   shutdown cleanup, restart reconciliation and persisted desired state.
4. Operations: one-shot start/end schedules, dashboard and polling updates,
   bounded redacted event logs, disk/memory/CPU metrics, Docker volume and HTTPS
   reverse-proxy instructions, backup/recovery procedure.
5. Verification: unit/API tests, real FFmpeg smoke test, browser build; external
   platform broadcast and long-running Linux soak tests remain deployment gates.

### Scope beyond the baseline

Password email recovery, custom permissions, smart playlists, hardware encoding,
provider OAuth/metadata APIs, email notifications, platform audience analytics,
multi-tenancy, billing, distributed workers and horizontal failover remain backlog.
M14 now supports configured Telegram and Discord alerts for stream starts/stops,
output retries/failures and schedule failures; threshold alerts and durable retries
are implemented. Email delivery remains future work. M15's baseline reporting is implemented; platform audience
metrics still require provider APIs, OAuth/application registration and operator
credentials.
The local HLS preview shows encoded output with a short delay; it does not confirm
platform reception. FFmpeg progress confirms local output activity, not audience
reach or platform health. RTMP pause is not supported; manual stop/start begins the
playlist again. Unexpected process recovery resumes from persisted checkpoints.

### Operational limits and failure policy

- Enforce upload size, concurrent stream and media-processing limits.
- Reject overlapping scheduled reservations for the same destination and block
  deletion of referenced media, profiles, playlists and destinations.
- A user stop cancels retries. An unexpected app restart reconciles desired-running
  streams. Repeated failures exhaust a retry budget and require operator restart.
- Deploy behind HTTPS; restrict RTMP egress to trusted ingest endpoints. This is
  a trusted-team control plane, not a public anonymous streaming relay.
- Back up database and media together during a stopped maintenance window, and
  preserve the encryption key separately. Test restore before production use.
- Never label the baseline enterprise-ready without a Linux soak test, actual
  provider ingest verification and backup/restore exercise.

### Evidence and implementation tracking

Implemented: React control panel, session authentication and team roles, SQLite
persistence, resumable upload/normalize, ordered playlists, profiles, encrypted
destinations, RTMP control, checkpoint recovery, recurring schedules, playback
status and branded HLS preview, threshold monitoring, durable Telegram/Discord
notifications, maintenance-window backup automation, activity logs and Docker/CI.

### Module completion notes

- M1–M13 Core, Media and Streaming — baseline complete: authentication/RBAC,
  dashboard, upload/storage, playlists, profiles, encrypted destinations, streams,
  FFmpeg execution/recovery, one-shot scheduling, monitoring and activity history.
  Stream playback supports unlimited looping (default), single playback, or a
  configured total of 2-1,000 plays for a one-video playlist. The total includes
  the initial playback; finite playback exits cleanly and marks the stream complete.
  Added: resumable per-user upload; checkpointed worker recovery; Now Playing/next
  video/loop count; authenticated HLS preview; PNG watermark and text overlay;
  daily/weekly schedules with a schedule-specific playlist and atomic overlap checks.
  Platform OAuth/metadata is explicitly excluded; provider ingest and Linux soak
  remain deployment gates.
- Resumable uploads accept authenticated sequential 1 MiB chunks, bind sessions to
  their owner, reserve bounded disk capacity and remove abandoned session data after
  24 hours. Browser state can rediscover a same-file session after a reload.
- M14 Notification — baseline complete: encrypted Telegram/Discord configuration,
  selectable stream/schedule events, test delivery, and alerts for worker retries
  and exhausted output retries. Added CPU/disk threshold alerts with hysteresis and
  durable encrypted delivery queue with three attempts/restart recovery. Remaining:
  email and per-user routing.
- M15 Analytics — baseline complete: stream session/duration summaries, output
  failures, reconnects, failed schedules, destination-local FFmpeg bitrate/FPS,
  connection uptime/failures/durations, date-range reports and CSV export.
  Remaining: platform views/likes/comments/watch time (requires provider OAuth/API).
  Reports cap ranges at 366 days, and use at most 20,000 audit events and 200,000
  metric samples; metrics sample every 30 seconds while output is active.
- M16 System Monitoring — single-server baseline complete: host CPU, memory, disk,
  load average, app/host uptime, upload status and FFmpeg output capacity are shown.
  Linux network throughput and thermal sensors are shown when the OS exposes them.
  Added opt-in CPU/disk threshold notifications with hysteresis. Remaining: Docker resource/restart/log telemetry, per-stream CPU accounting and
  Prometheus/Grafana alerting.
- M17 Stream Queue & Worker — single-process baseline complete by design: the
  scheduler and in-process controller manage isolated FFmpeg children, enforce
  output capacity and recover failures. There is no durable external job queue,
  priority allocation or worker assignment; horizontal workers are out of scope.
- M18 API — browser/session API baseline complete. Cookie sessions replace refresh
  tokens. Destination enable/disable now has a focused API/UI action, preserves
  encrypted keys, records audit events, and refuses changes while streams or
  pending schedules use that destination. Admins can probe TCP/RTMPS-TLS
  reachability without sending a stream key; the UI explicitly says this does not
  verify the key or platform ingest. Signed outbound stream/schedule webhooks now
  have admin configuration, event selection, a delivery test, encrypted durable
  retries and public-HTTPS egress checks. Remaining: a separately versioned public
  API contract and a deployment smoke test against a real webhook receiver.
- M19 Backup & Recovery — manual backup/restore helpers, Compose maintenance
  profile, separate-volume restore overlay, and opt-in `BACKUP_KEEP` retention are
  implemented. Temporary-directory round-trip tests cover backup, rotation, absent
  and empty-volume restore, and overwrite refusal. Admins can now list and download
  completed offline archives from a read-only mount; downloads are audited and
  archives remain protected. Added daily systemd maintenance-window backup,
  retention and optional verified rclone offsite copy. Remaining: enable/test the
  timer and verify a real Docker-volume/VPS restore.
- M20 System Settings — application name, logo upload/removal, maintenance mode, workspace timezone,
  default encoding profile/bitrate and retry budget are persisted and editable.
  The timezone consistently controls schedule entry plus activity, history,
  analytics and member timestamps; DST gaps are rejected and folds choose the
  earlier instant. Defaults apply to new profiles/streams, and retry changes apply
  to active worker sessions. Maintenance mode preserves operator stops and scheduled
  execution. Opt-in media retention is configurable in days (0 disables it); the
  hourly worker removes only expired videos not referenced by any playlist and
  records each removal in the audit log. Logo upload/removal is implemented with
  PNG chunk/checksum validation, bounded size/dimensions, atomic replacement,
  public read-only delivery, admin-only mutation, audit entries and UI previews.
  A browser-local Indonesian/English preference now persists across reloads and
  translates login, navigation, account, core settings, dashboard/media/list/detail
  views, resource CRUD dialogs, notifications, audit and analytics panels, and
  backup views. Generic backend/validation errors and some tertiary microcopy may
  still be English. Startup diagnostics check FFmpeg, storage, origin and port.
  Remaining: finish locale review, custom storage and temporary
  paths, and proxy/interface/bandwidth/runtime logging
  controls (host-level settings stay environment-managed).
- M21 Audit Log — baseline complete: authenticated view records actor, action,
  resource, timestamp, source IP, result and redacted structured metadata, with a
  migration for existing databases. Activity supports actor/action/resource/result
  and workspace-time filters plus CSV export of matching retained events (up to
  20,000, with formula-safe CSV and previous/current HMAC values. Retained events use an
  HMAC-SHA256 chain and signed head/range checkpoint keyed from `ENCRYPTION_KEY`;
  admin verification detects row edits, chain breaks, checkpoint loss and ordinary
  truncation, and legacy rows are sealed during migration. Remaining: offsite
  archival beyond the retention cap and external anchoring (whole-database plus key
  deletion/compromise cannot be proven by a local verifier).
- M22 Multi-Tenant — not implemented by design; this release serves one trusted
  team. Organization isolation, quotas and billing require a separate data model.
- M23 UI/UX — baseline complete: responsive layouts, loading/empty/error states,
  upload progress, confirmations, live status polling and a persisted Light/Dark/System
  theme selector, workspace branding, persistent Indonesian/English coverage of
  primary navigation and operational screens, and admin backup archive
  navigation/list/download.
  Desktop, 390px mobile and 768px tablet browser views are exercised. Backup creation
  and restore remain offline maintenance operations to protect database consistency.
  Live preview, upload pause/resume and Now Playing are available in stream/media views.
- M24 Deployment — Dockerfile/Compose, env configuration, persistent volume,
  resource limits, health checks, graceful shutdown and CI are present. Release
  image runs Node's built-in TypeScript stripping (so production does not need
  devDependency `tsx`); Compose defaults are bounded for a 2 GiB host. Remaining:
  automated TLS/proxy provisioning, real Docker image build/architecture validation,
  and a real VPS deployment; the local Docker daemon was unavailable for a container build.
- M25 Performance & Scalability — advanced scaling intentionally not implemented:
  no hardware encoder, multi-worker pool, Redis/PostgreSQL, cache or horizontal
  application replicas. The supported topology is one bounded server process.
- M26 Advanced Streaming — normalized uploaded MP4 to RTMP/RTMPS outputs is supported.
  Text overlays, PNG workspace-logo watermark, and authenticated local HLS preview
  are implemented and exercised through FFmpeg integration tests. Remaining:
  network/HLS/RTSP/SRT inputs, SRT output, stream-copy mode and hardware encoding.
- M27 Advanced Automation — one-time/daily/weekly schedules up to 366 occurrences,
  per-occurrence conflict validation and schedule-specific playlists are implemented.
  Remaining: conditional rules,
  cross-VPS failover and priority-based resource management.
- M28 Developer Tools — an authenticated OpenAPI 3.1 document describes implemented
  session, resource, media, broadcast, settings, audit and analytics endpoints;
  domain request constraints and cookie/CSRF/origin security are included. The
  authenticated in-app Swagger UI is available at `/api/docs/`; browser sessions
  are enforced and Try it out adds CSRF for mutations.
  M28.1 through M28.3 complete: admin-managed, one-time API key secrets stored only as
  hashes, read/write scopes, optional expiry (maximum 365 days), plus a Node CLI for
  common stream operations. M28.4 baseline is now complete: one configurable signed
  webhook, HMAC-SHA256, encrypted endpoint/secret and durable SQLite envelopes,
  event selection, three total attempts, ten concurrent sends, and restart recovery.
  HTTPS delivery pins validated public DNS addresses, verifies TLS and rejects
  redirects. A maximum 1,000 pending items is enforced and terminal envelopes are
  erased. Remaining deployment gate: real public receiver/TLS smoke test. Delivery
  is best-effort with bounded retries; receivers deduplicate IDs, and audit-to-queue
  insertion is not atomic (a crash in that gap can lose an event).
- M29 Testing — baseline complete: unit/API/security/scheduler/worker tests,
  upload/retry/DST/preview/watermark integration, real FFmpeg/RTMP integration,
  Linux backup scripts and desktop/mobile browser flows. Remaining:
  provider ingest, Linux soak, packet-loss, disk-full and CPU-overload testing.
- M30 Production Hardening — security/recovery foundations are implemented, not
  production-certified. Remaining: VPS firewall/TLS exercise, backup restore drill,
  distributed tracing, formal migrations/rollback and long-duration reliability.

Verification: TypeScript and production UI build; 59 passing API/security/worker,
OpenAPI contract, retention, audit-filter/export, recurring schedule, resumable upload,
threshold/notification retry and timezone/DST tests; real FFmpeg upload-to-local-RTMP,
authenticated HLS preview and text/logo overlay integration; database migration tests;
Linux backup/retention/restore round trip;
desktop, mobile and tablet Chrome workflows (2 passing browser tests, including
theme and language persistence, logo upload/login preview, fixed-count single-video
playback, backup archive
navigation, destination probe and enable/disable, webhook configuration/test,
audit CSV download and
authenticated API docs). Compose
maintenance/restore configuration is validated. A container build was not run
because the local Docker daemon was unavailable. External provider and Linux soak
gates remain open.

See README.md for commands, supported behavior, API routes and deployment gates.
Tests belong to every release; M29/M30 below are ongoing work, not postponed gates.
Architecture references: [Fastify v5](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/)
and [Node SQLite](https://nodejs.org/api/sqlite.html).

---

## 1. Project Overview

StreamHub adalah platform live streaming berbasis web yang powerful dan mudah digunakan untuk mengelola streaming 24/7 dari VPS/Linux server.

Tujuan utama:

- Streaming ke YouTube, Facebook, Twitch, dan platform RTMP/RTMPS lainnya secara bersamaan.
- Mengelola video dan playlist melalui web.
- Menjadwalkan live streaming.
- Mengontrol stream dari browser laptop/PC tanpa perlu SSH untuk operasional harian.
- Monitoring stream dan server secara real-time.
- Auto reconnect dan auto recovery untuk streaming 24/7.
- Mendukung multiple stream dan multiple destination.
- Memiliki API dan arsitektur yang siap dikembangkan/scaling.

---

# M1 — Authentication & User Management

## M1.1 — Authentication

- Login
- Logout
- Session management
- Remember session
- Password hashing
- Password change
- Forgot password
- Reset password

## M1.2 — User Management

- Create user
- Edit user
- Delete user
- Activate/deactivate user
- User profile
- Last login
- Login history

## M1.3 — Role & Permission

- Admin
- Operator
- Viewer
- Custom permission
- Permission per module
- Permission per stream
- Permission per destination

## M1.4 — Security

- Login rate limiting
- Brute-force protection
- Session expiration
- CSRF protection
- Secure cookies
- IP logging
- Audit trail

---

# M2 — Dashboard

## M2.1 — Overview Dashboard

- Total streams
- Active streams
- Scheduled streams
- Total videos
- Total playlists
- Total destinations
- Server uptime

## M2.2 — Server Monitoring

- CPU usage
- RAM usage
- Disk usage
- Network upload
- Network download
- Load average
- FFmpeg process count

## M2.3 — Stream Overview

- LIVE/OFFLINE status
- Duration
- Resolution
- FPS
- Bitrate
- Dropped frames
- Reconnect count
- Stream health

## M2.4 — Quick Actions

- Start stream
- Stop stream
- Restart stream
- View logs
- View preview
- Edit stream

---

# M3 — Video Management

## M3.1 — Video Library

- Video listing
- Search
- Filter
- Sort
- Pagination
- Grid/list view

## M3.2 — Upload

- Single upload
- Multiple upload
- Drag & drop
- Upload progress
- Pause/resume upload
- Upload cancellation
- Large-file upload

## M3.3 — Video Metadata

- Filename
- Title
- Description
- Duration
- Resolution
- FPS
- Codec
- Audio codec
- Bitrate
- File size
- Thumbnail

## M3.4 — Video Operations

- Rename
- Delete
- Move
- Duplicate
- Download
- Preview
- Replace file

## M3.5 — Video Validation

- Unsupported format detection
- Corrupted file detection
- Codec detection
- Audio detection
- Resolution detection
- FFprobe integration

---

# M4 — Storage Management

## M4.1 — Storage

- Local storage
- Storage statistics
- Disk usage
- Free space
- Storage per video
- Storage warnings

## M4.2 — File Management

- Video directories
- Temporary files
- Logs
- Cache
- Automatic cleanup

## M4.3 — Retention

- Delete files after X days
- Delete unused videos
- Maximum storage limit
- Automatic cleanup threshold

## M4.4 — Future Storage

- S3
- MinIO
- Google Drive
- Object storage
- Remote storage

---

# M5 — Playlist Management

## M5.1 — Playlist CRUD

- Create playlist
- Edit playlist
- Delete playlist
- Duplicate playlist

## M5.2 — Playlist Items

- Add video
- Remove video
- Reorder video
- Drag & drop ordering
- Bulk add

## M5.3 — Playback Mode

- Sequential
- Loop
- Shuffle
- Random
- Repeat single video

## M5.4 — Playlist Metadata

- Name
- Description
- Thumbnail
- Duration
- Number of videos

## M5.5 — Smart Playlist

- Automatic playlist
- Tags
- Categories
- Rules-based playlist

---

# M6 — Streaming Profile

## M6.1 — Video Encoding

- Resolution
- FPS
- Video codec
- Bitrate
- CRF
- Preset
- Profile
- Level
- GOP
- Keyframe interval

## M6.2 — Audio Encoding

- AAC
- Bitrate
- Sample rate
- Channels
- Volume

## M6.3 — Presets

- 1080p30
- 1080p60
- 720p30
- 720p60
- 480p30

## M6.4 — Hardware Encoding

- NVIDIA NVENC
- Intel QSV/VAAPI
- AMD AMF
- Software x264

## M6.5 — Custom FFmpeg

- Custom arguments
- Encoder options
- Advanced parameters

---

# M7 — Destination Management

## M7.1 — Destination CRUD

- Create destination
- Edit destination
- Delete destination
- Enable/disable destination
- Test connection

## M7.2 — YouTube

- YouTube destination
- RTMP/RTMPS
- Stream key
- Account name
- Channel information
- OAuth integration

## M7.3 — Facebook

- Facebook destination
- RTMP
- Stream key
- Page/account

## M7.4 — Twitch

- Twitch destination
- Stream key
- Channel

## M7.5 — Custom RTMP

- Destination name
- RTMP URL
- Stream key
- Username/password if required

## M7.6 — Multiple Accounts

- Multiple YouTube accounts
- Multiple Facebook accounts
- Multiple Twitch accounts
- Multiple RTMP destinations

## M7.7 — Credential Security

- Encrypt credentials
- Mask stream keys
- Never expose keys in logs
- Credential rotation

---

# M8 — Stream Management

## M8.1 — Create Stream

- Stream name
- Video/playlist
- Encoding profile
- Destination
- Metadata

## M8.2 — Stream Control

- Start
- Stop
- Restart
- Pause where supported
- Force terminate

## M8.3 — Stream Configuration

- Title
- Description
- Category
- Tags
- Privacy
- Thumbnail

## M8.4 — Multi-Destination

- One stream to multiple destinations
- YouTube
- Facebook
- Twitch
- Custom RTMP

## M8.5 — Stream Copy

- Same encoded stream to multiple destinations
- Reduce CPU usage

## M8.6 — Independent Encoding

- Different resolution per destination
- Different bitrate per destination
- Different FPS per destination

---

# M9 — 24/7 Streaming

## M9.1 — Continuous Streaming

- 24/7 mode
- Infinite playlist
- Infinite loop (implemented; default playback mode)
- Finite one-video repeat count (implemented; 2-1,000 total plays)
- Automatic video transition

## M9.2 — Auto Recovery

- FFmpeg crash detection
- Automatic restart
- Exponential retry
- Connection recovery

## M9.3 — Platform Recovery

- YouTube reconnect
- Facebook reconnect
- Twitch reconnect
- RTMP reconnect
- Destination-specific retry

## M9.4 — Failover

- Primary destination
- Backup destination
- Backup stream profile
- Backup server

## M9.5 — Health Check

- FFmpeg alive
- RTMP connection alive
- Bitrate check
- Frame check
- Audio check

---

# M10 — Scheduler

## M10.1 — Schedule CRUD

- Create
- Edit
- Delete
- Enable/disable

## M10.2 — Schedule Configuration

- Start time
- End time
- Duration
- Video
- Playlist
- Profile
- Destination

## M10.3 — Recurrence

- Once
- Daily
- Weekly
- Custom

## M10.4 — Timezone

- Workspace IANA timezone: implemented through M20 settings (defaults to host zone).
- One-shot schedule wall-time conversion: implemented; DST gaps are rejected and
  repeated fall-back times choose the earlier instant.
- Per-user timezone preference: not implemented; all workspace users share the
  configured display timezone.

## M10.5 — Schedule Queue

- Upcoming schedules
- Running schedules
- Completed schedules
- Failed schedules

## M10.6 — Conflict Detection

- Overlapping schedules
- Same destination conflict
- Resource conflict

---

# M11 — Real-Time Monitoring

## M11.1 — Stream Metrics

- FPS
- Bitrate
- Resolution
- Dropped frames
- Encoding speed
- Duration

## M11.2 — Network

- Upload speed
- Packet loss
- Connection status
- Reconnects
- Latency

## M11.3 — FFmpeg

- Process status
- PID
- CPU usage
- Memory
- Logs
- Exit code

## M11.4 — Destination Health

- YouTube connected/disconnected
- Facebook connected/disconnected
- Twitch connected/disconnected
- RTMP connected/disconnected

## M11.5 — Real-Time Updates

- WebSocket
- Server-Sent Events
- Live dashboard updates

---

# M12 — Live Preview

## M12.1 — Preview Player

- HLS player
- Video.js
- Fullscreen
- Volume
- Playback controls

## M12.2 — Stream Preview

- Current stream
- Current playlist item
- Current duration
- Next video

## M12.3 — Preview Quality

- Low-quality preview
- Standard preview
- High-quality preview

---

# M13 — Logs

## M13.1 — Stream Logs

- Start
- Stop
- Restart
- Connection
- Error
- Reconnect

## M13.2 — FFmpeg Logs

- stdout
- stderr
- Encoder errors
- Network errors

## M13.3 — System Logs

- Application
- Worker
- Scheduler
- Database
- Authentication

## M13.4 — Log Management

- Search
- Filter
- Date range
- Download
- Auto cleanup

---

# M14 — Notification

## M14.1 — Event System

Events:

- Stream started
- Stream stopped
- Stream crashed
- Stream disconnected
- Reconnected
- Schedule started
- Schedule failed
- Disk full
- High CPU

## M14.2 — Telegram

- Bot
- Chat ID
- Notifications

## M14.3 — Discord

- Webhook
- Channel

## M14.4 — Email

- SMTP
- Notification templates

## M14.5 — Notification Rules

Example:

- If stream offline > 60 seconds
- Send Telegram alert

---

# M15 — Analytics

## M15.1 — Stream Analytics

- Total streaming time
- Sessions
- Failed sessions
- Reconnects
- Average bitrate

## M15.2 — Destination Analytics

- Destination uptime
- Failed connections
- Connection duration

## M15.3 — Platform Analytics

When platform APIs support it:

- Views
- Likes
- Comments
- Concurrent viewers
- Watch time

## M15.4 — Reports

- Daily
- Weekly
- Monthly
- CSV export

---

# M16 — System Monitoring

## M16.1 — Server

- CPU
- RAM
- Disk
- Network
- Load average
- Temperature when available

## M16.2 — Docker

- Container status
- Restart count
- CPU
- RAM
- Logs

## M16.3 — FFmpeg Workers

- Active workers
- Worker capacity
- Stream count
- CPU per stream

## M16.4 — Monitoring Stack

- Prometheus
- Grafana
- Alert rules

---

# M17 — Stream Queue & Worker

## M17.1 — Job Queue

- Start stream job
- Stop stream job
- Restart job
- Schedule job

## M17.2 — Worker

- FFmpeg worker
- Worker health
- Worker capacity

## M17.3 — Concurrency

- Multiple streams per worker
- Worker assignment
- Worker status

## M17.4 — Resource Allocation

- Maximum CPU
- Maximum streams
- Priority
- Worker assignment

---

# M18 — API

## M18.1 — Authentication API

- Login
- Logout
- Refresh token

## M18.2 — Video API

- GET /videos
- POST /videos
- DELETE /videos/:id

## M18.3 — Stream API

- GET /streams
- POST /streams
- POST /streams/:id/start
- POST /streams/:id/stop
- POST /streams/:id/restart

## M18.4 — Schedule API

- GET /schedules
- POST /schedules
- PUT /schedules/:id
- DELETE /schedules/:id

## M18.5 — Destination API

- [x] CRUD with encrypted stream keys and secret-free API responses.
- [x] Test connection — admin-only, rate-limited TCP/TLS reachability probe;
      sends no stream key, logs a redacted audit event, and does not claim to verify
      platform ingest acceptance.
- [x] Enable/disable via focused API/UI action; blocked while active or reserved.

## M18.6 — Webhooks

- [x] Stream started (worker start accepted, not provider reception confirmation).
- [x] Stream stopped.
- [x] Stream failed (output retry exhaustion or recovery failure).
- [x] Schedule started, with the schedule ID and name.
- [x] Schedule failed.

---

# M19 — Backup & Recovery

## M19.1 — Database Backup

- Automatic backup
- Manual backup
- Backup retention

## M19.2 — Configuration Backup

- Stream profiles
- Destinations
- Schedules
- System settings

## M19.3 — Restore

- Database restore
- Configuration restore

## M19.4 — Disaster Recovery

- VPS replacement
- Docker redeployment
- Restore configuration
- Restore database

---

# M20 — System Settings

## M20.1 — General

- Application name
- [x] Logo upload/removal and login/sidebar/settings previews (PNG, max 1 MB)
- Timezone
- Language — partial: browser-local English/Indonesian selection persists across
  reloads; login, navigation, dashboard/media views, resource CRUD dialogs,
  account/settings, notifications, audit, analytics and backup screens are
  translated. Generic backend/validation errors and some tertiary microcopy still
  need review and translation.

## M20.2 — Streaming

- Default profile
- Default retry
- Default bitrate
- FFmpeg path

## M20.3 — Storage

- Custom storage directory — remains environment-managed.
- Temporary directory — remains environment-managed.
- Managed video retention — implemented in Settings; 0 disables it, expired
  unreferenced media is removed hourly and audited.

## M20.4 — Network

- Proxy
- Interface
- Bandwidth limits

## M20.5 — System

- Maintenance mode
- Log level
- Debug mode

---

# M21 — Audit Log

Record all important actions:

- User
- Action
- Resource
- Timestamp
- IP
- Result
- Metadata

Examples:

- Login
- Logout
- Start stream
- Stop stream
- Delete video
- Create destination
- Change settings

---

# M22 — Multi-Tenant

For future SaaS/productization.

## M22.1 — Organization

- Organization
- Workspace
- Members

## M22.2 — Resource Isolation

- Videos
- Playlists
- Streams
- Destinations
- Schedules

## M22.3 — Quota

- Maximum streams
- Maximum storage
- Maximum destinations

## M22.4 — Billing-ready

- Plan
- Usage
- Limits
- Subscription status

---

# M23 — UI/UX

## M23.1 — Responsive

- [x] Desktop/laptop and 390px mobile layouts remain usable.
- [x] 768px tablet layout fits viewport and navigation remains usable.

## M23.2 — Theme

- [x] Light, dark and system preference modes.
- [x] User choice persists across reload; system mode follows OS changes.

## M23.3 — Navigation

Dashboard

Streaming

- Live Streams
- Schedules
- Profiles
- Destinations

Media

- Videos
- Playlists

Monitoring

- Server
- Logs
- Analytics

System

- Users
- Notifications
- [x] Backup: admin archive list/download from read-only mount; creates/restores offline.
- Settings

## M23.4 — UX

- Toast notification
- Confirmation dialog
- Loading state
- Empty state
- Error state
- Progress indicator
- Real-time status

---

# M24 — Deployment

## M24.1 — Docker

- Dockerfile
- Docker Compose
- Environment variables
- Persistent volumes

## M24.2 — Reverse Proxy

- Traefik
- HTTPS
- Let's Encrypt
- Domain routing

## M24.3 — Production

- Resource limits
- Health checks
- Restart policies
- Graceful shutdown

## M24.4 — CI/CD

- GitHub Actions
- Build
- Test
- Docker image
- Deployment

---

# M25 — Performance & Scalability

## M25.1 — FFmpeg Optimization

- Hardware encoding
- Stream copy
- Preset optimization
- Bitrate optimization

## M25.2 — Worker Scaling

- Multiple workers
- Worker pool
- Stream distribution

## M25.3 — Database Optimization

- Index
- Connection pool
- Query optimization

## M25.4 — Cache

- Redis
- Session cache
- Metrics cache

## M25.5 — Horizontal Scaling

Architecture:

- Load balancer
- Multiple application instances
- Shared PostgreSQL
- Shared Redis
- Multiple FFmpeg workers

---

# M26 — Advanced Streaming

## M26.1 — Input Sources

- MP4
- HLS
- RTMP
- RTSP
- SRT
- YouTube URL
- Network stream

## M26.2 — Output

- YouTube
- Facebook
- Twitch
- RTMP
- RTMPS
- SRT

## M26.3 — Transcoding

- Resolution conversion
- FPS conversion
- Bitrate conversion
- Audio conversion

## M26.4 — Watermark

- Image watermark
- Position
- Opacity
- Size

## M26.5 — Overlay

- Logo
- Text
- Clock
- Custom graphics layer

---

# M27 — Advanced Automation

## M27.1 — Playlist Automation

Example:

- 00:00 → Playlist A
- 06:00 → Playlist B
- 12:00 → Playlist C
- 18:00 → Playlist D

## M27.2 — Conditional Streaming

Example:

- If YouTube disconnects
- Keep Facebook alive
- Retry YouTube

## M27.3 — Failover

- Primary VPS
- Backup VPS
- Automatic failover

## M27.4 — Automatic Resource Management

- Stop low-priority stream
- Worker reassignment
- Queue management

---

# M28 — Developer Tools

## M28.1 — API Documentation

- [x] OpenAPI 3.1 JSON contract for implemented session, resource, media, broadcast,
      settings, audit and analytics routes.
- [x] Authenticated in-app Swagger UI at `/api/docs/`; Try it out uses the browser
      session and fills CSRF on mutations.

## M28.2 — Developer API Keys

- [x] Admin-only generation and revocation; show the secret only once and store
      only its SHA-256 hash.
- [x] Read/write scopes enforced by the API authentication hook.
- [x] Optional expiration, limited to 365 days.

## M28.3 — CLI

- [x] Node CLI lists streams and starts, stops or restarts a stream using an API key.
- [x] Reads `STREAMAX_API_URL` and `STREAMAX_API_KEY`; supports `npm run cli -- ...`.
      Examples:
- `npm run cli -- streams start <id>`
- `npm run cli -- streams stop <id>`
- `npm run cli -- streams list`

## M28.4 — Webhook Management

- [x] Admin API/Settings for one HTTPS endpoint; endpoint path is encrypted and masked.
- [x] Encrypted signing secret; timestamped HMAC-SHA256 over the raw JSON body.
- [x] Stream/schedule event selection and signed manual delivery test.
- [x] Encrypted durable SQLite queue and three total attempts with stable delivery IDs;
      restart recovery is exercised by reopening the application with a pending envelope.
- [x] HTTPS, DNS/IP pinning, private-address and redirect rejection; five-second
      transport deadline and ten concurrent sends. Queue cap: 1,000 pending items.
- [x] Success/failure audit events and terminal-envelope cleanup; up to 1,000
      terminal queue records retained.
- Remaining gate: exercise a real public HTTPS receiver and verify its HMAC/replay
  handling. Unit/API tests use an injected receiver; a live loopback listener test
  proves the production transport rejects local destinations before connecting.
- Limits: queued items retain their original endpoint/secret when settings change;
  duplicates are possible after interruption. Audit insertion and enqueue are
  separate commits, so exactly-once delivery is not guaranteed.

---

# M29 — Testing

## M29.1 — Unit Test

- Backend
- Scheduler
- FFmpeg command builder
- Authentication

## M29.2 — Integration Test

- Database
- Redis
- Worker
- FFmpeg

## M29.3 — E2E Test

Flow:

1. Login
2. Upload video
3. Create playlist
4. Create destination
5. Create stream
6. Start
7. Monitor
8. Stop

## M29.4 — Failure Testing

- YouTube disconnect
- FFmpeg crash
- Network loss
- Disk full
- CPU overload
- Worker failure

---

# M30 — Production Hardening

## M30.1 — Security

- HTTPS
- Firewall
- Secrets encryption
- Rate limiting
- RBAC

## M30.2 — Reliability

- Health checks
- Auto restart
- Backup
- Recovery

## M30.3 — Observability

- Logs
- Metrics
- Alerts
- Tracing

## M30.4 — Maintenance

- Database migration
- Versioning
- Rollback
- Update mechanism

---

# Original Release Grouping (superseded by the baseline above)

## V0.1 — Core MVP

Modules:

- M1 Authentication
- M2 Dashboard
- M3 Video Management
- M4 Storage
- M5 Playlist
- M6 Streaming Profile
- M7 Destination
- M8 Stream Management

Goal:

Upload video → Create playlist → Add destination → Create stream → Start stream → Multi-platform live.

---

## V0.2 — 24/7 Streaming

Modules:

- M9 24/7 Streaming
- M10 Scheduler
- M11 Real-Time Monitoring
- M12 Live Preview
- M13 Logs

Goal:

Run continuous 24/7 streams with scheduling, monitoring, reconnect, and recovery.

---

## V0.3 — Production

Modules:

- M14 Notification
- M15 Analytics
- M16 System Monitoring
- M17 Worker/Queue
- M18 API
- M19 Backup
- M20 Settings
- M21 Audit Log

Goal:

Production-ready single-server platform.

---

## V0.4 — Advanced

Modules:

- M22 Multi-Tenant
- M23 UI/UX
- M24 Deployment
- M25 Scalability
- M26 Advanced Streaming
- M27 Advanced Automation
- M28 Developer Tools

Goal:

Scalable platform that can evolve into a SaaS/product.

---

## V1.0 — Production/Enterprise

Modules:

- M29 Testing
- M30 Production Hardening

Goal:

Reliable, secure, tested, observable, recoverable production platform.

---

# Future Distributed Architecture (backlog)

## Frontend

- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui

## Backend

- Node.js
- TypeScript
- NestJS or Fastify

## Database

- PostgreSQL

## Queue

- Redis
- BullMQ

## Streaming Engine

- FFmpeg

## Preview

- HLS
- Video.js

## Reverse Proxy

- Traefik

## Monitoring

- Prometheus
- Grafana

## Deployment

- Docker
- Docker Compose

---

# Future Distributed Deployment

Internet
|
v
Traefik HTTPS
|
+-------------------+
| |
v v
Next.js UI REST API
|
+-------------+-------------+
| | |
v v v
PostgreSQL Redis Storage
|
v
Stream Worker
|
+-----------+-----------+
| | |
v v v
FFmpeg FFmpeg FFmpeg
| | |
v v v
YouTube Facebook RTMP

---

# Primary User Workflow

1. Login
2. Upload video
3. Create playlist
4. Create streaming profile
5. Add YouTube/Facebook/RTMP destination
6. Create stream
7. Select video/playlist
8. Configure title and metadata
9. Start immediately or schedule
10. FFmpeg worker starts
11. Stream is sent to all configured destinations
12. Dashboard monitors the stream in real time
13. If connection fails, worker automatically reconnects
14. If FFmpeg crashes, worker automatically restarts
15. Stream continues 24/7
16. Logs and analytics are recorded

---

# Original Target Criteria (spans multiple staged releases)

The MVP is considered successful when it can:

- Run on Linux VPS
- Be accessed entirely through a web browser
- Upload and manage videos
- Create playlists
- Configure YouTube destination
- Configure Facebook destination
- Configure custom RTMP destination
- Stream to multiple destinations
- Loop video/playlist 24/7
- Start/stop/restart stream
- Schedule streams
- Monitor CPU/RAM/network
- Monitor stream bitrate/FPS/status
- Display FFmpeg logs
- Automatically reconnect
- Automatically restart crashed FFmpeg process
- Securely store stream credentials
- Work without requiring SSH for normal daily operations

---

# Production Target

Final platform should provide:

Web Dashboard
|
+-- Media Management
+-- Playlist Management
+-- Stream Management
+-- Scheduler
+-- Destination Management
+-- Live Monitoring
+-- Preview
+-- Analytics
+-- Notifications
+-- Logs
+-- Server Monitoring
+-- Users/Roles
+-- Backup
+-- API
+-- Automation
+-- Security
+-- Scalability

Core principle:

The laptop is only the control interface.

All streaming, encoding, scheduling, monitoring, recovery, and automation run on the Linux VPS.
