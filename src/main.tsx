import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  dateTimeLocalToInstant,
  instantToDateTimeLocal,
} from "../shared/timezone.ts";
import "./style.css";
import { LivePreview } from "./LivePreview.tsx";

type Item = { id: string; name: string; [key: string]: any };
type User = { id: string; email: string; role: string; csrf: string };
type AuditFilters = {
  actor?: string;
  action?: string;
  resource?: string;
  result?: "success" | "failure";
  from?: string;
  to?: string;
};
const auditQuery = (filters: AuditFilters) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value) query.set(key, value);
  return query.toString();
};
const kinds = [
  "streams",
  "videos",
  "playlists",
  "profiles",
  "destinations",
  "schedules",
] as const;
type Kind = (typeof kinds)[number];
const empty: Record<Kind, Item[]> = {
  streams: [],
  videos: [],
  playlists: [],
  profiles: [],
  destinations: [],
  schedules: [],
};
const labels: Record<string, string> = {
  dashboard: "Overview",
  analytics: "Analytics",
  streams: "Live streams",
  schedules: "Schedules",
  videos: "Video library",
  playlists: "Playlists",
  profiles: "Encoding profiles",
  destinations: "Destinations",
  server: "Server health",
  events: "Activity log",
  backups: "Backup & recovery",
  settings: "Settings",
  users: "Team members",
};
type Language = "en" | "id";
type Translator = (text: string) => string;
const LocaleContext = createContext<Language>("en");
const indonesian: Record<string, string> = {
  "Sending output": "Mengirim output",
  "Live preview": "Preview langsung",
  "CPU / disk alerts": "Peringatan CPU / disk",
  "Platform status is not verified": "Status platform belum diverifikasi",
  "Now playing": "Sedang diputar",
  Next: "Berikutnya",
  Play: "Putaran",
  "Scheduled playlist": "Playlist terjadwal",
  "Use stream playlist": "Gunakan playlist stream",
  Repeat: "Ulangi",
  Once: "Sekali",
  Daily: "Harian",
  Weekly: "Mingguan",
  Occurrences: "Jumlah jadwal",
  "Overlay text": "Teks overlay",
  "Waiting for encoder": "Menunggu slot encoder",
  inspecting: "Memeriksa video",
  waiting_capacity: "Menunggu slot encoder",
  "Leave overlay empty and watermark off for automatic stream copy. Realtime overlays require CPU encoding; on STB, try 720p24 or 960x540p30 if output is below realtime.":
    "Kosongkan overlay dan matikan watermark untuk stream copy otomatis. Overlay realtime membutuhkan encoding CPU; pada STB, coba profil 720p24 atau 960x540p30 jika output terlalu lambat.",
  "Live preview shows the source without overlays, using stream copy. Preview timing depends on source keyframes.":
    "Preview menampilkan sumber tanpa overlay dengan stream copy. Jeda preview mengikuti keyframe sumber.",
  "Below realtime: disable overlay or select a 720p24 / 960x540p30 profile":
    "Output di bawah realtime: matikan overlay atau pilih profil 720p24 / 960x540p30",
  "Workspace logo watermark": "Watermark logo workspace",
  "Enable live preview": "Aktifkan preview langsung",
  "Overlay position": "Posisi overlay",
  Overview: "Ringkasan",
  Analytics: "Analitik",
  "Live streams": "Siaran langsung",
  Schedules: "Jadwal",
  "Video library": "Pustaka video",
  Playlists: "Daftar putar",
  "Encoding profiles": "Profil enkode",
  Destinations: "Tujuan siaran",
  "Server health": "Kesehatan server",
  "Activity log": "Log aktivitas",
  "Backup & recovery": "Cadangan & pemulihan",
  Settings: "Pengaturan",
  "Team members": "Anggota tim",
  Workspace: "Ruang kerja",
  "Updates every 4s": "Diperbarui setiap 4 detik",
  "YOUR STREAMING WORKSPACE": "RUANG KENDALI STREAMING ANDA",
  WORKSPACE: "RUANG KERJA",
  "MEDIA & OUTPUT": "MEDIA & TUJUAN SIARAN",
  SYSTEM: "SISTEM",
  "YOUR ALWAYS-ON CONTROL ROOM": "RUANG KENDALI ANDA, SIAP SETIAP SAAT",
  "Great content.": "Konten hebat.",
  "On repeat.": "Putar tanpa henti.",
  Everywhere: "Di mana saja.",
  "Bring your media, destinations, and live streams together. Your server handles the rest.":
    "Satukan media, tujuan siaran, dan streaming langsung Anda. Server akan menangani sisanya.",
  "Built for your server. Controlled from anywhere.":
    "Berjalan di server Anda. Dikendalikan dari mana saja.",
  "Sign in to your studio": "Masuk ke studio Anda",
  "Keep your next broadcast moving.":
    "Pastikan siaran Anda berikutnya tetap berjalan.",
  "Use the administrator credentials configured on your server.":
    "Gunakan kredensial administrator yang dikonfigurasi di server Anda.",
  "Keep me signed in for 30 days": "Biarkan saya tetap masuk selama 30 hari",
  "Signing in…": "Sedang masuk…",
  "WELCOME BACK": "SELAMAT DATANG KEMBALI",
  "Email address": "Alamat email",
  Password: "Kata sandi",
  "Remember me for 30 days": "Ingat saya selama 30 hari",
  "Sign in →": "Masuk →",
  "Loading your workspace…": "Memuat ruang kerja Anda…",
  "Everything in flow.": "Semua siaran terkendali.",
  "Your broadcasts, media, and server. All in one place.":
    "Siaran, media, dan server Anda dalam satu tempat.",
  "Launch, monitor, and manage your broadcasts.":
    "Mulai, pantau, dan kelola siaran Anda.",
  "The content behind your next great broadcast.":
    "Konten untuk siaran hebat Anda berikutnya.",
  "Connect your content to the platforms you call home.":
    "Hubungkan konten Anda ke platform pilihan.",
  "Fine-tune your streaming workspace.":
    "Sesuaikan ruang kerja streaming Anda.",
  "Upload video": "Unggah video",
  "Create stream": "Buat siaran",
  "Invite member": "Undang anggota",
  "Your account": "Akun Anda",
  Email: "Email",
  Role: "Peran",
  Timezone: "Zona waktu",
  Theme: "Tema",
  Language: "Bahasa",
  System: "Sistem",
  Light: "Terang",
  Dark: "Gelap",
  English: "Inggris",
  Indonesian: "Bahasa Indonesia",
  "Change password": "Ubah kata sandi",
  "Current password": "Kata sandi saat ini",
  "New password": "Kata sandi baru",
  "Update password": "Perbarui kata sandi",
  "Sign out": "Keluar",
  "At least 12 characters. Changing your password signs out all sessions.":
    "Minimal 12 karakter. Perubahan kata sandi akan mengeluarkan semua sesi.",
  "Backup archives": "Arsip cadangan",
  "Read-only access to offline workspace backups":
    "Akses baca-saja ke cadangan ruang kerja offline",
  "Refresh list": "Muat ulang daftar",
  "Backups must be created while StreaMax is stopped.":
    "Cadangan harus dibuat saat StreaMax dihentikan.",
  "Use the maintenance procedure in README.md. The app only lists and downloads completed archives; it never copies a live SQLite database or restores over this workspace.":
    "Gunakan prosedur pemeliharaan di README.md. Aplikasi hanya menampilkan dan mengunduh arsip yang selesai; aplikasi tidak menyalin database SQLite aktif atau memulihkan data menimpa ruang kerja ini.",
  "Archives include media, password hashes, sessions and encrypted destination settings. Keep the matching ENCRYPTION_KEY separate and protect downloaded files.":
    "Arsip berisi media, hash kata sandi, sesi, dan pengaturan tujuan terenkripsi. Simpan ENCRYPTION_KEY terkait secara terpisah dan lindungi berkas unduhan.",
  "Backup directory is not mounted": "Direktori cadangan belum dipasang",
  "Configure BACKUP_PATH in the Compose environment and mount the same protected directory read-only into the app.":
    "Atur BACKUP_PATH pada konfigurasi Compose dan pasang direktori terlindungi yang sama sebagai baca-saja ke aplikasi.",
  "No backup archives found": "Arsip cadangan tidak ditemukan",
  "Completed maintenance backups will appear here.":
    "Cadangan pemeliharaan yang selesai akan muncul di sini.",
  "Download archive": "Unduh arsip",
  "System settings": "Pengaturan sistem",
  "Single-server workspace preferences": "Preferensi ruang kerja satu server",
  "Workspace logo": "Logo ruang kerja",
  "PNG only, up to 1 MB; maximum dimensions 2048 × 1024.":
    "Hanya PNG, maksimal 1 MB; dimensi maksimum 2048 × 1024.",
  "Upload PNG logo": "Unggah logo PNG",
  "Remove logo": "Hapus logo",
  "Application name": "Nama aplikasi",
  "Default encoding profile": "Profil enkode bawaan",
  "Workspace timezone (IANA)": "Zona waktu ruang kerja (IANA)",
  "Default video bitrate (kbps)": "Bitrate video bawaan (kbps)",
  "Retry attempts per destination": "Percobaan ulang per tujuan",
  "Video retention (days; 0 disables automatic deletion)":
    "Retensi video (hari; 0 menonaktifkan penghapusan otomatis)",
  "Enable maintenance mode": "Aktifkan mode pemeliharaan",
  "Save system settings": "Simpan pengaturan sistem",
  "System settings saved": "Pengaturan sistem tersimpan",
  "Workspace logo updated": "Logo ruang kerja diperbarui",
  "Workspace logo removed": "Logo ruang kerja dihapus",
  "Remove the workspace logo?": "Hapus logo ruang kerja?",
  "Runs hourly. Expired videos still used by a playlist are preserved; deleted media is not recoverable from the workspace.":
    "Berjalan setiap jam. Video kedaluwarsa yang masih dipakai daftar putar akan dipertahankan; media yang dihapus tidak dapat dipulihkan.",
  "Pauses API edits by operators/viewers. Operators can still stop streams; administrators retain access, and scheduled broadcasts are not stopped.":
    "Menjeda perubahan API oleh operator/pemirsa. Operator tetap dapat menghentikan siaran; administrator tetap memiliki akses dan siaran terjadwal tidak dihentikan.",
  "Showing up to 100 newest archives. Restore remains an offline, administrator-operated procedure to prevent accidental overwrite.":
    "Menampilkan hingga 100 arsip terbaru. Pemulihan tetap dilakukan administrator secara offline untuk mencegah penimpaan yang tidak disengaja.",
  "Maintenance mode is on. Operator and viewer changes are paused; operators may still stop streams, and scheduled broadcasts continue.":
    "Mode pemeliharaan aktif. Perubahan oleh operator dan pemirsa dijeda; operator tetap dapat menghentikan siaran dan siaran terjadwal tetap berjalan.",
  "Upcoming schedules": "Jadwal mendatang",
  "Ready for their next moment": "Siap untuk siaran berikutnya",
  "Enabled broadcast destinations": "Tujuan siaran yang aktif",
  Streams: "Siaran",
  stream: "siaran",
  "View all streams": "Lihat semua siaran",
  "Live status reflects local FFmpeg progress. Check your platform to confirm reception.":
    "Status live menunjukkan progres FFmpeg lokal. Periksa platform Anda untuk memastikan siaran diterima.",
  "LOCAL SERVER": "SERVER LOKAL",
  "Recent activity": "Aktivitas terbaru",
  "View all": "Lihat semua",
  "All streams": "Semua siaran",
  "streams in your workspace": "siaran di ruang kerja Anda",
  "Search streams…": "Cari siaran…",
  "Drop a video to get started": "Taruh video untuk memulai",
  "Your broadcast library": "Pustaka siaran Anda",
  "Files are checked and normalized for smooth playlist playback.":
    "Berkas diperiksa dan dinormalisasi agar daftar putar berjalan lancar.",
  "One file at a time": "Satu berkas setiap kali",
  "Original files are not retained": "Berkas asli tidak disimpan",
  "Browse files": "Pilih berkas",
  "All videos": "Semua video",
  "Search your library…": "Cari di pustaka…",
  "Analytics reporting period": "Periode laporan analitik",
  "Alerts for broadcast and schedule events":
    "Peringatan untuk siaran dan jadwal",
  "Notification provider": "Penyedia notifikasi",
  "Stream and destination overlaps are checked when saved.":
    "Jadwal yang bertabrakan dengan siaran atau tujuan lain akan ditolak saat disimpan.",
  "Saving…": "Menyimpan…",
  "Stream and destination overlaps": "Jadwal siaran dan tujuan bertabrakan",
  "Saved securely · leave blank to keep current credential":
    "Tersimpan aman · kosongkan untuk memakai kredensial saat ini",
  "Search activity": "Cari aktivitas",
  "Delete stream": "Hapus siaran",
  "streaming sessions": "sesi streaming",
  "All playlists": "Semua daftar putar",
  "All profiles": "Semua profil",
  "All destinations": "Semua tujuan siaran",
  "All schedules": "Semua jadwal",
  Ready: "Siap",
  ready: "Siap",
  queued: "Mengantre",
  processing: "Diproses",
  failed: "Gagal",
  "Upload received; video is queued for processing":
    "Upload diterima; video mengantre untuk diproses",
  Delete: "Hapus",
  Edit: "Ubah",
  enabled: "aktif",
  disabled: "nonaktif",
  "Search…": "Cari…",
  "No playlists yet": "Belum ada daftar putar",
  "No profiles yet": "Belum ada profil",
  "No destinations yet": "Belum ada tujuan siaran",
  "No schedules yet": "Belum ada jadwal",
  "Add videos to your library, then arrange them into a playlist.":
    "Tambahkan video ke pustaka, lalu susun menjadi daftar putar.",
  "Create your first destination to connect a platform.":
    "Buat tujuan siaran pertama untuk menghubungkan platform.",
  "Create your first profile to choose your broadcast quality.":
    "Buat profil pertama untuk memilih kualitas siaran.",
  "Create your first schedule to plan a broadcast.":
    "Buat jadwal pertama untuk merencanakan siaran.",
  "Search a resource": "Cari sumber daya",
  "Your team": "Tim Anda",
  "Has not signed in": "Belum pernah masuk",
  Deactivate: "Nonaktifkan",
  Activate: "Aktifkan",
  "Member updated": "Anggota diperbarui",
  "Resource deleted": "Sumber daya dihapus",
  "Resource created": "Sumber daya dibuat",
  "Resource updated": "Sumber daya diperbarui",
  "Video processed and ready": "Video selesai diproses dan siap",
  "Upload failed. Check the connection and try again.":
    "Unggahan gagal. Periksa koneksi lalu coba lagi.",
  "Processing video into broadcast-ready H.264/AAC…":
    "Memproses video ke format H.264/AAC siap siar…",
  "Uploading video…": "Mengunggah video…",
  "Resource usage": "Penggunaan sumber daya",
  "Stream worker": "Worker siaran",
  "Output capacity": "Kapasitas output",
  "Application uptime": "Waktu aktif aplikasi",
  "Media processing": "Pemrosesan media",
  "Processing video": "Memproses video",
  Idle: "Tidak aktif",
  "Retry policy": "Kebijakan percobaan ulang",
  "attempts per output": "percobaan per output",
  "Progress timeout": "Batas waktu progres",
  "Streaming performance": "Performa streaming",
  "Calculated from persisted stream events and FFmpeg progress samples":
    "Dihitung dari peristiwa siaran tersimpan dan sampel progres FFmpeg",
  "Last 7 days": "7 hari terakhir",
  "Last 30 days": "30 hari terakhir",
  "Last 90 days": "90 hari terakhir",
  "Last 365 days": "365 hari terakhir",
  "Export CSV": "Ekspor CSV",
  "Streaming hours": "Jam streaming",
  "broadcast sessions": "sesi siaran",
  "Failed outputs": "Output gagal",
  "Destination retry budgets exhausted":
    "Batas percobaan ulang tujuan tercapai",
  Reconnections: "Koneksi ulang",
  "Automatic output recovery attempts": "Percobaan pemulihan output otomatis",
  "Schedule failures": "Jadwal gagal",
  "Missed or unstartable schedules": "Jadwal terlewat atau tidak dapat dimulai",
  "Broadcast sessions": "Sesi siaran",
  "Times shown in": "Waktu ditampilkan dalam",
  Stream: "Siaran",
  Started: "Dimulai",
  Stopped: "Dihentikan",
  Duration: "Durasi",
  Session: "Sesi",
  ended: "berakhir",
  running: "berjalan",
  "No broadcast history in this period":
    "Tidak ada riwayat siaran pada periode ini",
  "Started and stopped stream sessions will be summarized here.":
    "Ringkasan sesi siaran yang dimulai dan dihentikan akan tampil di sini.",
  "Destination performance": "Performa tujuan siaran",
  "Average values from 30-second worker samples":
    "Nilai rata-rata dari sampel worker 30 detik",
  Destination: "Tujuan",
  Uptime: "Waktu aktif",
  "Connected time": "Durasi terhubung",
  "Failed connections": "Koneksi gagal",
  "Average bitrate": "Bitrate rata-rata",
  "Average FPS": "FPS rata-rata",
  Samples: "Sampel",
  "No connection data": "Tidak ada data koneksi",
  "No samples": "Tidak ada sampel",
  "No destination activity has been recorded in this period. Worker samples are stored while a broadcast is running.":
    "Tidak ada aktivitas tujuan pada periode ini. Sampel worker disimpan saat siaran berlangsung.",
  "Reports use up to 20,000 retained audit events and 200,000 worker metric samples. Uptime measures locally observed FFmpeg output connections; duration and bitrate are not platform audience or reception metrics.":
    "Laporan menggunakan hingga 20.000 peristiwa audit dan 200.000 sampel metrik worker. Waktu aktif mengukur koneksi output FFmpeg lokal; durasi dan bitrate bukan metrik pemirsa atau penerimaan platform.",
  Notifications: "Notifikasi",
  "Loading notification settings…": "Memuat pengaturan notifikasi…",
  "Only an administrator can change the notification integration.":
    "Hanya administrator yang dapat mengubah integrasi notifikasi.",
  Provider: "Penyedia",
  "Discord webhook URL": "URL webhook Discord",
  "Telegram bot token": "Token bot Telegram",
  "Send alerts for": "Kirim peringatan untuk",
  "Stream started": "Siaran dimulai",
  "Stream failed": "Siaran gagal",
  "Destination retrying": "Tujuan mencoba ulang",
  "Schedule failed": "Jadwal gagal",
  "Enable notifications": "Aktifkan notifikasi",
  "Notification settings saved": "Pengaturan notifikasi tersimpan",
  "Test notification delivered": "Notifikasi uji berhasil dikirim",
  "Send test notification": "Kirim notifikasi uji",
  "Signed webhooks": "Webhook bertanda tangan",
  "Saved securely at": "Tersimpan aman di",
  "blank keeps current value": "kosongkan untuk mempertahankan nilai",
  "Saved securely · blank keeps current value":
    "Tersimpan aman · kosongkan untuk mempertahankan nilai",
  "Use a random secret of at least 16 characters":
    "Gunakan rahasia acak minimal 16 karakter",
  "HTTPS receiver URL": "URL penerima HTTPS",
  "HMAC signing secret": "Rahasia penandatangan HMAC",
  "Enable signed webhooks": "Aktifkan webhook bertanda tangan",
  "Webhook settings saved": "Pengaturan webhook tersimpan",
  "Test webhook delivered": "Webhook uji berhasil dikirim",
  "Send test webhook": "Kirim webhook uji",
  "Schedule started": "Jadwal dimulai",
  "Configure a public HTTPS endpoint and a strong signing secret. Deliveries are encrypted, signed and attempted at most three times. Pending deliveries retain their original settings. Private or local network addresses are blocked.":
    "Atur endpoint HTTPS publik dan rahasia penandatangan yang kuat. Pengiriman dienkripsi, ditandatangani, dan dicoba maksimal tiga kali. Antrean pengiriman mempertahankan pengaturan awalnya. Alamat jaringan privat atau lokal diblokir.",
  "Save settings": "Simpan pengaturan",
  "Messages contain the event, resource, UTC time, and safe diagnostic details. Provider credentials are encrypted and never displayed after saving.":
    "Pesan memuat peristiwa, sumber daya, waktu UTC, dan detail diagnostik aman. Kredensial penyedia dienkripsi dan tidak ditampilkan setelah disimpan.",
  "Saved successfully": "Berhasil disimpan",
  "Close dialog": "Tutup dialog",
  "team member": "anggota tim",
  video: "video",
  playlist: "daftar putar",
  profile: "profil",
  destination: "tujuan siaran",
  Name: "Nama",
  "Give this stream a name": "Beri nama untuk siaran ini",
  "Give this playlist a name": "Beri nama untuk daftar putar ini",
  "Give this profile a name": "Beri nama untuk profil ini",
  "Give this destination a name": "Beri nama untuk tujuan ini",
  "Give this schedule a name": "Beri nama untuk jadwal ini",
  "Add videos": "Tambahkan video",
  "Select a video…": "Pilih video…",
  "Move video up": "Pindahkan video ke atas",
  "Move video down": "Pindahkan video ke bawah",
  "Remove video from playlist": "Hapus video dari daftar putar",
  "Playback follows this order. You can add a video more than once.":
    "Pemutaran mengikuti urutan ini. Video yang sama dapat ditambahkan lebih dari sekali.",
  Width: "Lebar",
  Height: "Tinggi",
  "Frames per second": "Frame per detik",
  "Video bitrate (kbps)": "Bitrate video (kbps)",
  "Audio bitrate (kbps)": "Bitrate audio (kbps)",
  Platform: "Platform",
  "Ingest server URL": "URL server ingest",
  "Stream key": "Kunci siaran",
  "Leave blank to keep current key":
    "Kosongkan untuk mempertahankan kunci saat ini",
  "Paste your stream key": "Tempel kunci siaran Anda",
  "Use the ingest URL provided by your platform. Keys are encrypted and never returned to your browser.":
    "Gunakan URL ingest dari platform Anda. Kunci dienkripsi dan tidak pernah dikirim kembali ke browser.",
  "Enable this destination": "Aktifkan tujuan ini",
  "Enable destination": "Aktifkan tujuan",
  "Disable destination": "Nonaktifkan tujuan",
  "Destination enabled": "Tujuan siaran diaktifkan",
  "Destination disabled": "Tujuan siaran dinonaktifkan",
  "Test connection": "Uji koneksi",
  "Endpoint reachable; the stream key and platform ingest are not verified.":
    "Endpoint dapat dijangkau; kunci siaran dan ingest platform belum diverifikasi.",
  "Could not connect to the destination endpoint.":
    "Tidak dapat terhubung ke endpoint tujuan siaran.",
  Playlist: "Daftar putar",
  "Encoding profile": "Profil enkode",
  "Select a playlist": "Pilih daftar putar",
  "Select a profile": "Pilih profil",
  "Broadcast destinations": "Tujuan siaran",
  "Create a destination before creating a stream.":
    "Buat tujuan siaran sebelum membuat siaran.",
  "Loop playlist continuously": "Putar daftar putar berulang kali",
  "Playback mode": "Mode pemutaran",
  "Loop forever": "Ulangi tanpa batas",
  "Play once": "Putar satu kali",
  "Play a fixed number of times": "Putar beberapa kali",
  "Total plays": "Jumlah pemutaran",
  "Total plays includes the first playback.":
    "Jumlah pemutaran sudah termasuk pemutaran pertama.",
  "Each destination uses one worker output. Restarting begins the playlist again.":
    "Setiap tujuan menggunakan satu output worker. Memulai ulang akan mengulang daftar putar dari awal.",
  "Select a stream": "Pilih siaran",
  "Start time": "Waktu mulai",
  "End time": "Waktu selesai",
  "One-time schedule in": "Jadwal satu kali dalam",
  "Initial password": "Kata sandi awal",
  "Viewer — read only": "Pemirsa — hanya melihat",
  "Operator — manage broadcasts": "Operator — mengelola siaran",
  "Admin — manage team and broadcasts": "Admin — mengelola tim dan siaran",
  "Share credentials separately. This does not send an email invitation.":
    "Bagikan kredensial secara terpisah. Undangan email tidak dikirim.",
  Cancel: "Batal",
  "Save changes": "Simpan perubahan",
  Create: "Buat",
  "CPU usage": "Penggunaan CPU",
  Memory: "Memori",
  "Disk storage": "Penyimpanan disk",
  "Server uptime": "Waktu aktif server",
  "Load average (1 / 5 / 15 min)": "Rata-rata beban (1 / 5 / 15 menit)",
  "Network (receive / send)": "Jaringan (terima / kirim)",
  "CPU temperature": "Suhu CPU",
  Unavailable: "Tidak tersedia",
  "A fresh start": "Awal yang baru",
  "Your stream and account activity will appear here.":
    "Aktivitas siaran dan akun Anda akan muncul di sini.",
  "Stop stream": "Hentikan siaran",
  "Start stream": "Mulai siaran",
  "Stream stopped": "Siaran dihentikan",
  "Stream starting": "Siaran dimulai",
  "Restart stream": "Mulai ulang siaran",
  "Stream restarting": "Siaran dimulai ulang",
  Stop: "Hentikan",
  Start: "Mulai",
  "OUTPUT BITRATE": "BITRATE OUTPUT",
  "FRAME RATE": "FRAME RATE",
  live: "live",
  offline: "luring",
  degraded: "terganggu",
  retrying: "mencoba ulang",
  starting: "memulai",
  "Latest 200 matching events": "200 peristiwa terbaru yang cocok",
  "Actor contains": "Aktor memuat",
  "Action contains": "Aksi memuat",
  "Resource contains": "Sumber daya memuat",
  Result: "Hasil",
  "Any result": "Semua hasil",
  Success: "Berhasil",
  Failure: "Gagal",
  From: "Dari",
  To: "Sampai",
  "Apply filters": "Terapkan filter",
  Clear: "Hapus filter",
  "Enter valid filter dates": "Masukkan rentang tanggal yang valid",
  "Last login": "Terakhir masuk",
  "Delete this resource?": "Hapus sumber daya ini?",
  "Create your first playlist to plan a broadcast.":
    "Buat daftar putar pertama untuk merencanakan siaran.",
  "My workspace": "Ruang kerja saya",
  "Single-server studio": "Studio satu server",
  "Your content. Always on.": "Konten Anda. Selalu aktif.",
  "Single-server edition · v0.1": "Edisi satu server · v0.1",
  "Create playlist": "Buat daftar putar",
  "Create profile": "Buat profil",
  "Create destination": "Buat tujuan siaran",
  "Create schedule": "Buat jadwal",
  "of content": "konten",
  "Plan ahead. Times shown in": "Rencanakan. Waktu ditampilkan dalam",
  "Worker capacity": "Kapasitas worker",
  outputs: "output",
  viewer: "pemirsa",
  operator: "operator",
  admin: "admin",
  "Your first broadcast starts here": "Siaran pertama Anda dimulai di sini",
  "Upload a video, build a playlist, and connect a destination. Then bring it all together in a stream.":
    "Unggah video, susun daftar putar, dan hubungkan tujuan siaran. Lalu satukan semuanya dalam satu siaran.",
  "The stored video file will be permanently removed.":
    "Berkas video yang tersimpan akan dihapus permanen.",
  "This cannot be undone.": "Tindakan ini tidak dapat dibatalkan.",
  "Workspace logo PNG": "Logo ruang kerja PNG",
  "Close preview": "Tutup pratinjau",
  "Library file preview · This is not a live broadcast preview.":
    "Pratinjau berkas pustaka · Ini bukan pratinjau siaran langsung.",
  "Dismiss error": "Tutup pesan kesalahan",
  "Request failed": "Permintaan gagal",
};
const languagePreference = (): Language => {
  try {
    return localStorage.getItem("streamax.language") === "id" ? "id" : "en";
  } catch {
    return "en";
  }
};
const makeTranslator =
  (language: Language): Translator =>
  (text) =>
    language === "id" ? indonesian[text] || text : text;
const useTranslator = () => makeTranslator(useContext(LocaleContext));
const glyphs: Record<string, string> = {
  analytics: "▥",
  dashboard: "◫",
  streams: "◉",
  schedules: "◷",
  videos: "▣",
  playlists: "≡",
  profiles: "⌁",
  destinations: "↗",
  server: "▤",
  events: "☷",
  settings: "⚙",
  users: "♧",
};
const bytes = (n = 0) =>
  n >= 1073741824
    ? `${(n / 1073741824).toFixed(1)} GB`
    : `${(n / 1048576).toFixed(1)} MB`;
const networkRate = (n: number | null) =>
  n === null
    ? "Unavailable"
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)} MB/s`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)} KB/s`
        : `${n} B/s`;
const duration = (n = 0) =>
  `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
const displayDate = (
  value: string,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) =>
  new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });

function Icon({ name }: { name: string }) {
  return (
    <span className="icon" aria-hidden="true">
      {glyphs[name] || "＋"}
    </span>
  );
}
type ThemeChoice = "light" | "dark" | "system";
function getThemeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem("streamax.theme");
    if (value === "light" || value === "dark" || value === "system")
      return value;
  } catch {}
  return "system";
}
function App() {
  const [theme, setTheme] = useState<ThemeChoice>(getThemeChoice);
  const [language, setLanguage] = useState<Language>(languagePreference);
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState("dashboard");
  const [data, setData] = useState(empty);
  const [overview, setOverview] = useState<any>({});
  const [events, setEvents] = useState<any[]>([]);
  const [backupState, setBackupState] = useState<{
    configured: boolean;
    backups: Array<{ name: string; size: number; modifiedAt: string }>;
  }>({ configured: false, backups: [] });
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>({});
  const [users, setUsers] = useState<any[]>([]);
  const [systemSettings, setSystemSettings] = useState({
    applicationName: "StreaMax",
    maintenanceMode: false,
    defaultProfileId: "",
    defaultBitrate: 2500,
    retryAttempts: 5,
    videoRetentionDays: 0,
    thresholdAlerts: false,
    cpuThreshold: 90,
    diskThreshold: 90,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    logoAvailable: false,
    logoUpdatedAt: "",
  });
  const [logoUrl, setLogoUrl] = useState("");
  const [analytics, setAnalytics] = useState<any>(null);
  const [reportDays, setReportDays] = useState(30);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<{
    kind: Kind | "users";
    item?: Item;
  } | null>(null);
  const [preview, setPreview] = useState<Item | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const currentUpload = useRef<AbortController | null>(null);
  const [pausedFile, setPausedFile] = useState<File | null>(null);
  const uploadSession = useRef<string | null>(null);
  const canEdit = user?.role !== "viewer";
  const t = makeTranslator(language);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.themeChoice = theme;
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "light" : "dark") : theme;
      try {
        localStorage.setItem("streamax.theme", theme);
      } catch {}
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    try {
      localStorage.setItem("streamax.language", language);
    } catch {}
    document.documentElement.lang = language;
  }, [language]);

  async function api(
    path: string,
    body?: any,
    method = body === undefined ? "GET" : "POST",
  ) {
    const multipart =
      typeof FormData !== "undefined" && body instanceof FormData;
    const response = await fetch(`/api/${path}`, {
      method,
      headers: {
        ...(body !== undefined && !multipart
          ? { "Content-Type": "application/json" }
          : {}),
        ...(user ? { "X-CSRF-Token": user.csrf } : {}),
      },
      body:
        body === undefined
          ? undefined
          : multipart
            ? body
            : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) setUser(null);
      throw new Error(result.error || "Request failed");
    }
    return result;
  }
  async function refresh() {
    const results = await Promise.all([
      ...kinds.map((k) => api(k)),
      api("overview"),
      api("events"),
    ]);
    setData(
      Object.fromEntries(kinds.map((k, i) => [k, results[i]])) as Record<
        Kind,
        Item[]
      >,
    );
    setOverview(results[6]);
    setEvents(results[7]);
    if (user?.role === "admin") {
      const [team, settings] = await Promise.all([
        api("users"),
        api("settings"),
      ]);
      setUsers(team);
      setSystemSettings(settings);
    }
  }
  useEffect(() => {
    void api("health")
      .then((health) => {
        if (health.applicationName)
          setSystemSettings((current) => ({
            ...current,
            applicationName: health.applicationName,
          }));
        setLogoUrl(
          health.logoAvailable
            ? `/api/branding/logo?v=${encodeURIComponent(health.logoVersion || "")}`
            : "",
        );
      })
      .catch(() => {});
    void api("me")
      .then(setUser)
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (page !== "backups" || user?.role !== "admin") return;
    void api("backups")
      .then(setBackupState)
      .catch((e) => setError((e as Error).message));
  }, [page, user]);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    let pending = false;
    const update = async () => {
      if (pending || !alive) return;
      pending = true;
      try {
        await refresh();
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [user]);
  useEffect(() => {
    if (!user || page !== "analytics") return;
    let alive = true;
    const load = () =>
      api(
        `analytics?from=${encodeURIComponent(new Date(Date.now() - reportDays * 86400000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`,
      )
        .then((value) => {
          if (alive) setAnalytics(value);
        })
        .catch((e) => {
          if (alive) setError((e as Error).message);
        });
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [user, page, reportDays]);
  useEffect(() => {
    if (!user || page !== "events") return;
    const query = auditQuery(auditFilters);
    api(`events${query ? `?${query}` : ""}`)
      .then(setAuditEvents)
      .catch((e) => setError((e as Error).message));
  }, [user, page, auditFilters]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setModal(null);
        setPreview(null);
      }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [busy]);

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      setNotice(success);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: string) {
    setPage(next);
    setSearch("");
    setError("");
  }
  async function remove(kind: Kind, item: Item) {
    if (
      !confirm(
        `Delete “${item.name}”? ${kind === "videos" ? "The stored video file will be permanently removed." : "This cannot be undone."}`,
      )
    )
      return;
    await act(
      () => api(`${kind}/${item.id}`, undefined, "DELETE"),
      "Resource deleted",
    );
  }
  async function uploadFile(file?: File) {
    if (!file || currentUpload.current) return;
    const controller = new AbortController();
    currentUpload.current = controller;
    setPausedFile(null);
    setUploadProgress(0);
    setError("");
    let registered = false;
    try {
      const sample = await new Blob([
        file.slice(0, 65536),
        file.slice(Math.max(0, file.size - 65536)),
        `${file.size}:${file.lastModified}`,
      ]).arrayBuffer();
      const fingerprint = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", sample)),
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const pending = await api("uploads");
      const session =
        pending.find(
          (value: any) =>
            value.fingerprint === fingerprint && value.size === file.size,
        ) ||
        (await api("uploads", {
          name: file.name.slice(0, 120),
          size: file.size,
          fingerprint,
        }));
      uploadSession.current = session.id;
      let offset = session.offset;
      while (offset < file.size) {
        controller.signal.throwIfAborted();
        const response = await fetch(`/api/uploads/${session.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-CSRF-Token": user!.csrf,
            "Upload-Offset": String(offset),
          },
          body: file.slice(offset, offset + 1024 * 1024),
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        offset = result.offset;
        setUploadProgress(Math.floor((offset / file.size) * 100));
      }
      controller.signal.throwIfAborted();
      const completed = await api(`uploads/${session.id}/complete`, {});
      registered = true;
      uploadSession.current = null;
      setNotice(
        completed.status === "ready"
          ? "Video processed and ready"
          : completed.status === "failed"
            ? "Video processing failed"
            : "Upload received; video is queued for processing",
      );
      await refresh();
    } catch (cause) {
      if (registered) {
        setError(
          `Upload received, but library refresh failed: ${(cause as Error).message}`,
        );
        return;
      }
      setPausedFile(file);
      setError(
        controller.signal.aborted
          ? "Upload paused. Resume when ready."
          : `${(cause as Error).message} Select the same file or Resume to continue.`,
      );
    } finally {
      setUploadProgress(null);
      currentUpload.current = null;
      if (upload.current) upload.current.value = "";
    }
  }
  const live = data.streams.filter((s) =>
    s.outputs?.some((o: any) => o.state === "live"),
  );
  const activeOutputs = data.streams.reduce(
    (count, stream) =>
      count +
      (stream.outputs || []).filter((output: any) =>
        ["live", "starting", "retrying"].includes(output.state),
      ).length +
      Number(Boolean(stream.livePreview && stream.desired === "running")),
    0,
  );
  const lookup = (kind: Kind, id: string) =>
    data[kind].find((v) => v.id === id)?.name || "Unavailable";
  const stateOf = (s: Item) =>
    s.desired !== "running"
      ? "offline"
      : s.outputs?.some((o: any) => o.state === "failed")
        ? "degraded"
        : s.outputs?.some((o: any) => o.state === "retrying")
          ? "retrying"
          : s.outputs?.some((o: any) => o.state === "live")
            ? "live"
            : "starting";

  if (checking)
    return (
      <LocaleContext.Provider value={language}>
        <div className="splash">
          ◈ <span>{t("Loading your workspace…")}</span>
        </div>
      </LocaleContext.Provider>
    );
  if (!user)
    return (
      <LocaleContext.Provider value={language}>
        <div className="login">
          <div className="login-story">
            <div className="brand">
              {logoUrl ? (
                <img
                  className="workspace-logo"
                  src={logoUrl}
                  alt={`${systemSettings.applicationName} logo`}
                />
              ) : (
                <b className="brand-mark">◈</b>
              )}{" "}
              {systemSettings.applicationName}
            </div>
            <div>
              <span className="eyebrow">
                {t("YOUR ALWAYS-ON CONTROL ROOM")}
              </span>
              <h1>
                {t("Great content.")}
                <br />
                {t("On repeat.")}
                <br />
                <em>{t("Everywhere")}</em>
              </h1>
              <p>
                {t(
                  "Bring your media, destinations, and live streams together. Your server handles the rest.",
                )}
              </p>
            </div>
            <small>
              {t("Built for your server. Controlled from anywhere.")}
            </small>
          </div>
          <form
            className="login-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy(true);
              setError("");
              try {
                setUser(
                  await api("login", {
                    email: f.get("email"),
                    password: f.get("password"),
                    remember: f.has("remember"),
                  }),
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <span className="eyebrow">{t("WELCOME BACK")}</span>
            <h2>{t("Sign in to your studio")}</h2>
            <p>{t("Keep your next broadcast moving.")}</p>
            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}
            <label>
              {t("Email address")}
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@example.com"
              />
            </label>
            <label>
              {t("Password")}
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label className="check">
              <input type="checkbox" name="remember" />{" "}
              {t("Keep me signed in for 30 days")}
            </label>
            <button className="primary" disabled={busy}>
              {busy ? t("Signing in…") : t("Sign in →")}
            </button>
            <small>
              {t(
                "Use the administrator credentials configured on your server.",
              )}
            </small>
          </form>
        </div>
      </LocaleContext.Provider>
    );

  function streamRows(streams: Item[]) {
    return streams.length ? (
      <div className="stream-list">
        {streams.map((stream) => (
          <article className="stream-row" key={stream.id}>
            <div
              className={`stream-art ${stateOf(stream) === "live" ? "broadcasting" : ""}`}
            >
              <Icon name="streams" />
            </div>
            <div className="stream-title">
              <h3>{stream.name}</h3>
              <span>
                {lookup("playlists", stream.playlistId)} <i>·</i>{" "}
                {lookup("profiles", stream.profileId)}
              </span>
              <div className="destination-chips">
                {stream.destinationIds.map((id: string) => (
                  <span key={id}>{lookup("destinations", id)}</span>
                ))}
              </div>
              {stream.outputs?.map(
                (output: any) =>
                  output.nowPlaying && (
                    <small key={output.destinationId}>
                      {lookup("destinations", output.destinationId)}:{" "}
                      {t("Now playing")} {output.nowPlaying.videoName} ·{" "}
                      {Math.floor(output.nowPlaying.videoSeconds)} /{" "}
                      {Math.round(output.nowPlaying.videoDuration)}s ·{" "}
                      {t("Play")} {output.nowPlaying.play}/
                      {output.nowPlaying.totalPlays || "∞"}
                      {output.nowPlaying.nextVideoId && (
                        <>
                          {" "}
                          · {t("Next")}:{" "}
                          {lookup("videos", output.nowPlaying.nextVideoId)}
                        </>
                      )}
                    </small>
                  ),
              )}
              {stream.desired === "running" && (
                <small>{t("Platform status is not verified")}</small>
              )}
              {stream.outputs?.map((output: any) => (
                <small key={`mode-${output.destinationId}`}>
                  {lookup("destinations", output.destinationId)}:{" "}
                  {output.mode?.toUpperCase() || output.state}
                  {output.state === "waiting_capacity" &&
                    ` · ${t("Waiting for encoder")}`}
                  {Number.isFinite(output.speed) &&
                    ` · ${output.speed.toFixed(2)}x`}
                  {output.warning && (
                    <span className="danger-text"> · {t(output.warning)}</span>
                  )}
                </small>
              ))}
              {stream.livePreview && stream.desired === "running" && (
                <LivePreview id={stream.id} />
              )}
              {stream.error && (
                <small className="danger-text">{stream.error}</small>
              )}
            </div>
            <div className="stream-metric">
              <strong>
                {stream.outputs?.find((o: any) => o.bitrate)?.bitrate || "—"}
              </strong>
              <small>{t("OUTPUT BITRATE")}</small>
            </div>
            <div className="stream-metric">
              <strong>
                {stream.outputs?.find((o: any) => o.fps)?.fps || "—"}{" "}
                <small>fps</small>
              </strong>
              <small>{t("FRAME RATE")}</small>
            </div>
            <span className={`badge ${stateOf(stream)}`}>
              {t(
                stateOf(stream) === "live" ? "Sending output" : stateOf(stream),
              )}
            </span>
            {canEdit && (
              <div className="row-actions">
                <button
                  disabled={busy}
                  className={stream.desired === "running" ? "" : "play"}
                  title={
                    stream.desired === "running"
                      ? t("Stop stream")
                      : t("Start stream")
                  }
                  onClick={() =>
                    void act(
                      () =>
                        api(
                          `streams/${stream.id}/${stream.desired === "running" ? "stop" : "start"}`,
                          {},
                        ),
                      stream.desired === "running"
                        ? t("Stream stopped")
                        : t("Stream starting"),
                    )
                  }
                >
                  {stream.desired === "running"
                    ? `■ ${t("Stop")}`
                    : `▶ ${t("Start")}`}
                </button>
                <button
                  disabled={busy}
                  title={t("Restart stream")}
                  onClick={() =>
                    void act(
                      () => api(`streams/${stream.id}/restart`, {}),
                      t("Stream restarting"),
                    )
                  }
                >
                  ↻
                </button>
                {page === "streams" && (
                  <>
                    <button
                      disabled={busy || stream.desired === "running"}
                      onClick={() =>
                        setModal({ kind: "streams", item: stream })
                      }
                    >
                      {t("Edit")}
                    </button>
                    <button
                      className="danger-text"
                      disabled={busy}
                      title={t("Delete stream")}
                      onClick={() => void remove("streams", stream)}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    ) : (
      <Empty
        title="Your first broadcast starts here"
        text="Upload a video, build a playlist, and connect a destination. Then bring it all together in a stream."
        action={
          canEdit ? (
            <button className="primary" onClick={() => navigate("videos")}>
              Add your first video ↗
            </button>
          ) : undefined
        }
      />
    );
  }
  function health() {
    return (
      <div className="health-content">
        {[
          ["CPU usage", overview.cpu || 0, `${overview.cpu || 0}%`],
          [
            "Memory",
            (overview.memoryUsed / overview.memoryTotal) * 100 || 0,
            `${bytes(overview.memoryUsed)} / ${bytes(overview.memoryTotal)}`,
          ],
          [
            "Disk storage",
            (overview.diskUsed / overview.diskTotal) * 100 || 0,
            `${bytes(overview.diskUsed)} / ${bytes(overview.diskTotal)}`,
          ],
        ].map(([label, percent, value]) => (
          <div className="health-line" key={String(label)}>
            <div>
              <span>{t(String(label))}</span>
              <strong>{value}</strong>
            </div>
            <div className="meter">
              <span
                style={{ width: `${Math.min(Number(percent), 100)}%` }}
                className={Number(percent) > 85 ? "warning" : ""}
              />
            </div>
          </div>
        ))}
        <div className="health-footer">
          <span className="dot" /> {t("Server uptime")}{" "}
          <strong>{duration(overview.uptime)}</strong>
        </div>
        <div className="health-footer">
          <span>{t("Load average (1 / 5 / 15 min)")}</span>{" "}
          <strong>
            {overview.load
              ?.map((value: number) => value.toFixed(2))
              .join(" / ") || "—"}
          </strong>
        </div>
        <div className="health-footer">
          <span>{t("Network (receive / send)")}</span>{" "}
          <strong>
            {networkRate(overview.networkRxBps)} /{" "}
            {networkRate(overview.networkTxBps)}
          </strong>
        </div>
        <div className="health-footer">
          <span>{t("CPU temperature")}</span>{" "}
          <strong>
            {overview.temperatureC === null ||
            overview.temperatureC === undefined
              ? t("Unavailable")
              : `${overview.temperatureC} °C`}
          </strong>
        </div>
      </div>
    );
  }
  function eventList(limit: number, source = events) {
    return source.length ? (
      <div className="event-list">
        {source.slice(0, limit).map((event) => (
          <div className="event" key={event.id}>
            <span
              className={`event-icon ${event.action.includes("failed") ? "failed" : ""}`}
            >
              {event.action.includes("start")
                ? "↗"
                : event.action.includes("failed")
                  ? "!"
                  : "✓"}
            </span>
            <div>
              <strong>
                {event.action.replaceAll(".", " · ").replaceAll("_", " ")}
              </strong>
              <small title={JSON.stringify(event.metadata || {})}>
                {event.actor} · {event.ip || "worker"} · {event.result} ·{" "}
                {event.resource || "—"}
                {event.message ? ` · ${event.message}` : ""}
              </small>
            </div>
            <time title={displayDate(event.time, systemSettings.timeZone)}>
              {new Date(event.time).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: systemSettings.timeZone,
              })}
            </time>
          </div>
        ))}
      </div>
    ) : (
      <Empty
        title="A fresh start"
        text="Your stream and account activity will appear here."
      />
    );
  }

  return (
    <LocaleContext.Provider value={language}>
      <div className="app-shell">
        <aside className="sidebar">
          <a
            className="brand"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              navigate("dashboard");
            }}
          >
            {logoUrl ? (
              <img
                className="workspace-logo"
                src={logoUrl}
                alt={`${systemSettings.applicationName} logo`}
              />
            ) : (
              <b className="brand-mark">◈</b>
            )}{" "}
            {systemSettings.applicationName}
            <span className="version">BETA</span>
          </a>
          <div className="workspace">
            <div className="workspace-avatar">
              {systemSettings.applicationName[0]?.toUpperCase() || "S"}
            </div>
            <div>
              <strong>{t("My workspace")}</strong>
              <small>{t("Single-server studio")}</small>
            </div>
            <span>⌄</span>
          </div>
          <nav>
            {[
              ["WORKSPACE", "dashboard", "streams", "schedules"],
              [
                "MEDIA & OUTPUT",
                "videos",
                "playlists",
                "destinations",
                "profiles",
              ],
              [
                "SYSTEM",
                "server",
                "analytics",
                "events",
                ...(user.role === "admin" ? ["users"] : []),
                ...(user.role === "admin" ? ["backups"] : []),
                "settings",
              ],
            ].map(([group, ...items]) => (
              <div className="nav-group" key={group}>
                <span className="nav-label">{t(group)}</span>
                {items.map((item) => (
                  <button
                    key={item}
                    className={page === item ? "selected" : ""}
                    onClick={() => navigate(item)}
                  >
                    <Icon name={item} />
                    {t(labels[item])}
                    {item === "streams" && live.length > 0 && (
                      <span className="nav-count">{live.length}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="capacity">
              <span>
                <i className="dot" /> {t("Worker capacity")}
              </span>
              <strong>
                {activeOutputs} / {overview.maxOutputs || "—"} {t("outputs")}
              </strong>
              <div className="meter">
                <span
                  style={{
                    width: `${(activeOutputs / (overview.maxOutputs || 1)) * 100}%`,
                  }}
                />
              </div>
            </div>
            <button className="user-card" onClick={() => navigate("settings")}>
              <span className="avatar">{user.email[0].toUpperCase()}</span>
              <span>
                <strong>{user.email.split("@")[0]}</strong>
                <small>{t(user.role)}</small>
              </span>
              <span>⋯</span>
            </button>
          </div>
        </aside>
        <main>
          <header className="topbar">
            <span>
              {t("Workspace")} <span className="muted">/</span>{" "}
              <strong>{t(labels[page])}</strong>
            </span>
            <div>
              <span className="connection">
                <i className="dot" /> {t("Updates every 4s")}
              </span>
              <span className="avatar small">
                {user.email[0].toUpperCase()}
              </span>
            </div>
          </header>
          <div className="page-content">
            <div className="page-heading">
              <div>
                <span className="eyebrow">{t("YOUR STREAMING WORKSPACE")}</span>
                <h1>
                  {page === "dashboard"
                    ? t("Everything in flow.")
                    : t(labels[page])}
                </h1>
                <p>
                  {page === "dashboard"
                    ? t("Your broadcasts, media, and server. All in one place.")
                    : page === "streams"
                      ? t("Launch, monitor, and manage your broadcasts.")
                      : page === "videos"
                        ? t("The content behind your next great broadcast.")
                        : page === "destinations"
                          ? t(
                              "Connect your content to the platforms you call home.",
                            )
                          : page === "schedules"
                            ? `${t("Plan ahead. Times shown in")} ${systemSettings.timeZone}.`
                            : t("Fine-tune your streaming workspace.")}
                </p>
              </div>
              {canEdit && (
                <div className="heading-actions">
                  {page === "dashboard" && (
                    <button onClick={() => navigate("videos")}>
                      ↑ {t("Upload video")}
                    </button>
                  )}
                  {page === "videos" ? (
                    <button
                      className="primary"
                      disabled={uploadProgress !== null}
                      onClick={() => upload.current?.click()}
                    >
                      ＋ {t("Upload video")}
                    </button>
                  ) : (
                    [...kinds, "dashboard", "users"].includes(page as any) && (
                      <button
                        className="primary"
                        onClick={() =>
                          setModal({
                            kind:
                              page === "dashboard"
                                ? "streams"
                                : (page as Kind | "users"),
                          })
                        }
                      >
                        ＋{" "}
                        {page === "dashboard" || page === "streams"
                          ? t("Create stream")
                          : page === "users"
                            ? t("Invite member")
                            : t(
                                `Create ${page === "playlists" ? "playlist" : page === "profiles" ? "profile" : page === "schedules" ? "schedule" : "destination"}`,
                              )}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
            {systemSettings.maintenanceMode && (
              <div className="maintenance-banner" role="status">
                {t(
                  "Maintenance mode is on. Operator and viewer changes are paused; operators may still stop streams, and scheduled broadcasts continue.",
                )}
              </div>
            )}
            {error && (
              <div className="alert" role="alert">
                {t(error)}
                <button
                  onClick={() => setError("")}
                  aria-label={t("Dismiss error")}
                >
                  ×
                </button>
              </div>
            )}
            {notice && (
              <div className="toast" role="status">
                ✓ {t(notice)}
              </div>
            )}
            <input
              ref={upload}
              type="file"
              accept="video/*,.mkv"
              hidden
              onChange={(e) => uploadFile(e.target.files?.[0])}
            />
            {uploadProgress !== null && (
              <div className="upload-status" role="status">
                <span>
                  {uploadProgress === 100
                    ? t("Processing video into broadcast-ready H.264/AAC…")
                    : `${t("Uploading video…")} ${uploadProgress}%`}
                </span>
                <div className="meter">
                  <span style={{ width: `${uploadProgress}%` }} />
                </div>
                {uploadProgress < 100 && (
                  <button onClick={() => currentUpload.current?.abort()}>
                    Pause / Jeda
                  </button>
                )}
              </div>
            )}
            {pausedFile && (
              <div className="upload-status">
                <span>{pausedFile.name}</span>
                <button onClick={() => void uploadFile(pausedFile)}>
                  Resume / Lanjutkan
                </button>
                <button
                  onClick={() =>
                    void act(async () => {
                      if (uploadSession.current)
                        await api(
                          `uploads/${uploadSession.current}`,
                          undefined,
                          "DELETE",
                        );
                      uploadSession.current = null;
                      setPausedFile(null);
                    }, "Upload cancelled")
                  }
                >
                  Cancel upload / Batalkan
                </button>
              </div>
            )}
            {page === "dashboard" && (
              <>
                <div className="stats">
                  <Stat
                    label="Live streams"
                    value={String(live.length).padStart(2, "0")}
                    note={`${data.streams.length} ${t("streams in your workspace")}`}
                    icon="streams"
                    accent
                  />
                  <Stat
                    label="Upcoming schedules"
                    value={String(
                      data.schedules.filter((s) => s.state === "pending")
                        .length,
                    ).padStart(2, "0")}
                    note="Ready for their next moment"
                    icon="schedules"
                  />
                  <Stat
                    label="Video library"
                    value={String(data.videos.length).padStart(2, "0")}
                    note={`${bytes(data.videos.reduce((n, v) => n + v.size, 0))} ${t("of content")}`}
                    icon="videos"
                  />
                  <Stat
                    label="Destinations"
                    value={String(
                      data.destinations.filter((d) => d.enabled).length,
                    ).padStart(2, "0")}
                    note="Enabled broadcast destinations"
                    icon="destinations"
                  />
                </div>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      {t("Streams")}{" "}
                      <span className="count">{data.streams.length}</span>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => navigate("streams")}
                    >
                      {t("View all streams")} ↗
                    </button>
                  </div>
                  {streamRows(data.streams.slice(0, 4))}
                  <div className="panel-footnote">
                    <span className="dot" />{" "}
                    {t(
                      "Live status reflects local FFmpeg progress. Check your platform to confirm reception.",
                    )}
                  </div>
                </section>
                <div className="bottom-grid">
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>{t("Server health")}</h2>
                      <span className="subtle-tag">{t("LOCAL SERVER")}</span>
                    </div>
                    {health()}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>{t("Recent activity")}</h2>
                      <button
                        className="text-button"
                        onClick={() => navigate("events")}
                      >
                        View all ↗
                      </button>
                    </div>
                    {eventList(4)}
                  </section>
                </div>
              </>
            )}
            {page === "streams" && (
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    {t("All streams")}{" "}
                    <span className="count">{data.streams.length}</span>
                  </h2>
                  <input
                    className="search"
                    aria-label={t("Search streams…")}
                    placeholder={t("Search streams…")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {streamRows(
                  data.streams.filter((s) =>
                    s.name.toLowerCase().includes(search.toLowerCase()),
                  ),
                )}
              </section>
            )}
            {page === "videos" && (
              <>
                <div
                  className="dropzone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (canEdit) uploadFile(e.dataTransfer.files[0]);
                  }}
                >
                  <span className="upload-icon">↑</span>
                  <h3>
                    {canEdit
                      ? t("Drop a video to get started")
                      : t("Your broadcast library")}
                  </h3>
                  <p>
                    {t(
                      "Files are checked and normalized for smooth playlist playback.",
                    )}
                    <br />
                    {t("One file at a time")} · Up to{" "}
                    {overview.maxUploadMb || 1024} MB ·{" "}
                    {t("Original files are not retained")}
                  </p>
                  {canEdit && (
                    <button
                      disabled={uploadProgress !== null}
                      onClick={() => upload.current?.click()}
                    >
                      {t("Browse files")}
                    </button>
                  )}
                </div>
                <div className="library-toolbar">
                  <h2>
                    {t("All videos")}{" "}
                    <span className="count">{data.videos.length}</span>
                  </h2>
                  <input
                    className="search"
                    aria-label={t("Search your library…")}
                    placeholder={t("Search your library…")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="media-grid">
                  {data.videos
                    .filter((v) =>
                      v.name.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((video) => (
                      <article className="media-card" key={video.id}>
                        <button
                          className="video-cover"
                          disabled={Boolean(
                            video.status && video.status !== "ready",
                          )}
                          onClick={() => setPreview(video)}
                          aria-label={`Preview ${video.name}`}
                        >
                          <span>▶</span>
                          <small>{duration(video.duration)}</small>
                        </button>
                        <div className="media-info">
                          <h3 title={video.name}>{video.name}</h3>
                          <p>
                            {video.width} × {video.height} <i>·</i>{" "}
                            {bytes(video.size)}
                          </p>
                          <div>
                            <span
                              className={`badge ${video.status === "failed" ? "failed" : video.status && video.status !== "ready" ? "offline" : "live"}`}
                            >
                              {t(video.status || "Ready")}
                              {video.status === "processing" &&
                                Number.isFinite(video.processingProgress) &&
                                ` ${video.processingProgress}%`}
                            </span>
                            {video.error && (
                              <small role="status">{video.error}</small>
                            )}
                            {canEdit && (
                              <button
                                className="text-button danger-text"
                                disabled={
                                  busy ||
                                  ["queued", "processing"].includes(
                                    video.status,
                                  )
                                }
                                onClick={() => void remove("videos", video)}
                              >
                                {t("Delete")}
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    ))}
                </div>
              </>
            )}
            {(
              ["playlists", "profiles", "destinations", "schedules"] as string[]
            ).includes(page) && (
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    {t(labels[page])}{" "}
                    <span className="count">{data[page as Kind].length}</span>
                  </h2>
                  <input
                    className="search"
                    aria-label={t("Search a resource")}
                    placeholder={t("Search…")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {data[page as Kind].length ? (
                  <div className="resource-list">
                    {data[page as Kind]
                      .filter((v) =>
                        v.name.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((item) => (
                        <article className="resource-row" key={item.id}>
                          <div className="resource-symbol">
                            <Icon name={page} />
                          </div>
                          <div className="resource-info">
                            <h3>{item.name}</h3>
                            <p>
                              {page === "playlists"
                                ? `${item.videoIds.length} videos · ${duration(item.videoIds.reduce((n: number, id: string) => n + (data.videos.find((v) => v.id === id)?.duration || 0), 0))}`
                                : page === "profiles"
                                  ? `${item.width} × ${item.height} · ${item.fps} fps · ${item.bitrate} kbps · AAC ${item.audioBitrate}k`
                                  : page === "destinations"
                                    ? `${item.platform} · ${item.url} · Key ••••••••`
                                    : `${displayDate(item.startAt, systemSettings.timeZone)} → ${displayDate(item.endAt, systemSettings.timeZone)} · ${lookup("streams", item.streamId)}`}
                            </p>
                          </div>
                          {page === "destinations" && (
                            <span
                              className={`badge ${item.enabled ? "live" : "offline"}`}
                            >
                              {t(item.enabled ? "enabled" : "disabled")}
                            </span>
                          )}
                          {page === "schedules" && (
                            <span className={`badge ${item.state}`}>
                              {t(item.state)}
                            </span>
                          )}
                          {canEdit && (
                            <div className="row-actions">
                              {page === "destinations" &&
                                user?.role === "admin" && (
                                  <button
                                    disabled={busy}
                                    onClick={() =>
                                      void act(async () => {
                                        const result = await api(
                                          `destinations/${item.id}/test`,
                                          {},
                                        );
                                        if (!result.ok)
                                          throw new Error(t(result.message));
                                        return result;
                                      }, t("Endpoint reachable; the stream key and platform ingest are not verified."))
                                    }
                                  >
                                    {t("Test connection")}
                                  </button>
                                )}
                              {page === "destinations" && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void act(
                                      () =>
                                        api(
                                          `destinations/${item.id}/enabled`,
                                          { enabled: !item.enabled },
                                          "PATCH",
                                        ),
                                      t(
                                        item.enabled
                                          ? "Destination disabled"
                                          : "Destination enabled",
                                      ),
                                    )
                                  }
                                >
                                  {t(
                                    item.enabled
                                      ? "Disable destination"
                                      : "Enable destination",
                                  )}
                                </button>
                              )}
                              <button
                                disabled={busy}
                                onClick={() =>
                                  setModal({ kind: page as Kind, item })
                                }
                              >
                                {t("Edit")}
                              </button>
                              <button
                                disabled={busy}
                                className="danger-text"
                                onClick={() => void remove(page as Kind, item)}
                              >
                                {t("Delete")}
                              </button>
                            </div>
                          )}
                        </article>
                      ))}
                  </div>
                ) : (
                  <Empty
                    title={t(`No ${page} yet`)}
                    text={
                      page === "playlists"
                        ? t(
                            "Add videos to your library, then arrange them into a playlist.",
                          )
                        : t(
                            `Create your first ${page === "destinations" ? "destination to connect a platform." : page === "profiles" ? "profile to choose your broadcast quality." : "schedule to plan a broadcast."}`,
                          )
                    }
                  />
                )}
              </section>
            )}
            {page === "server" && (
              <div className="bottom-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>{t("Resource usage")}</h2>
                  </div>
                  {health()}
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>{t("Stream worker")}</h2>
                  </div>
                  <div className="detail-list">
                    <p>
                      {t("Output capacity")}{" "}
                      <strong>
                        {activeOutputs} / {overview.maxOutputs}
                      </strong>
                    </p>
                    <p>
                      {t("Application uptime")}{" "}
                      <strong>{duration(overview.appUptime)}</strong>
                    </p>
                    <p>
                      {t("Media processing")}{" "}
                      <strong>
                        {t(overview.processing ? "Processing video" : "Idle")}
                      </strong>
                    </p>
                    <p>
                      {t("Retry policy")}{" "}
                      <strong>
                        {overview.retryAttempts ?? 5} {t("attempts per output")}
                      </strong>
                    </p>
                    <p>
                      {t("Progress timeout")} <strong>60 seconds</strong>
                    </p>
                  </div>
                </section>
              </div>
            )}
            {page === "analytics" && (
              <AnalyticsPage
                report={analytics}
                days={reportDays}
                setDays={setReportDays}
                timeZone={systemSettings.timeZone}
              />
            )}
            {page === "events" && (
              <section className="panel">
                <div className="panel-heading">
                  <h2>{t("Activity log")}</h2>
                  <span className="muted">
                    {t("Latest 200 matching events")}
                  </span>
                </div>
                <form
                  className="settings-form audit-filters"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    try {
                      setAuditFilters({
                        actor:
                          String(form.get("actor") || "").trim() || undefined,
                        action:
                          String(form.get("action") || "").trim() || undefined,
                        resource:
                          String(form.get("resource") || "").trim() ||
                          undefined,
                        result: (String(form.get("result") || "") ||
                          undefined) as "success" | "failure" | undefined,
                        from: form.get("from")
                          ? dateTimeLocalToInstant(
                              String(form.get("from")),
                              systemSettings.timeZone,
                            )
                          : undefined,
                        to: form.get("to")
                          ? dateTimeLocalToInstant(
                              String(form.get("to")),
                              systemSettings.timeZone,
                            )
                          : undefined,
                      });
                      setError("");
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Enter valid filter dates",
                      );
                    }
                  }}
                >
                  <label>
                    {t("Actor contains")}
                    <input name="actor" defaultValue={auditFilters.actor} />
                  </label>
                  <label>
                    {t("Action contains")}
                    <input name="action" defaultValue={auditFilters.action} />
                  </label>
                  <label>
                    {t("Resource contains")}
                    <input
                      name="resource"
                      defaultValue={auditFilters.resource}
                    />
                  </label>
                  <label>
                    {t("Result")}
                    <select
                      name="result"
                      defaultValue={auditFilters.result || ""}
                    >
                      <option value="">{t("Any result")}</option>
                      <option value="success">{t("Success")}</option>
                      <option value="failure">{t("Failure")}</option>
                    </select>
                  </label>
                  <label>
                    {t("From")} ({systemSettings.timeZone})
                    <input
                      name="from"
                      type="datetime-local"
                      defaultValue={
                        auditFilters.from
                          ? instantToDateTimeLocal(
                              auditFilters.from,
                              systemSettings.timeZone,
                            )
                          : ""
                      }
                    />
                  </label>
                  <label>
                    {t("To")} ({systemSettings.timeZone})
                    <input
                      name="to"
                      type="datetime-local"
                      defaultValue={
                        auditFilters.to
                          ? instantToDateTimeLocal(
                              auditFilters.to,
                              systemSettings.timeZone,
                            )
                          : ""
                      }
                    />
                  </label>
                  <div className="audit-actions">
                    <button className="primary">{t("Apply filters")}</button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.currentTarget.form?.reset();
                        setAuditFilters({});
                      }}
                    >
                      {t("Clear")}
                    </button>
                    <a
                      className="button-link"
                      href={`/api/events.csv${auditQuery(auditFilters) ? `?${auditQuery(auditFilters)}` : ""}`}
                    >
                      {t("Export CSV")}
                    </a>
                  </div>
                </form>
                {eventList(200, auditEvents)}
              </section>
            )}
            {page === "backups" && user.role === "admin" && (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>{t("Backup archives")}</h2>
                    <small>
                      {t("Read-only access to offline workspace backups")}
                    </small>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void api("backups")
                        .then(setBackupState)
                        .catch((e) => setError((e as Error).message))
                    }
                  >
                    {t("Refresh list")}
                  </button>
                </div>
                <div className="backup-notice">
                  <strong>
                    {t("Backups must be created while StreaMax is stopped.")}
                  </strong>
                  <p>
                    {t(
                      "Use the maintenance procedure in README.md. The app only lists and downloads completed archives; it never copies a live SQLite database or restores over this workspace.",
                    )}
                  </p>
                  <small>
                    {t(
                      "Archives include media, password hashes, sessions and encrypted destination settings. Keep the matching ENCRYPTION_KEY separate and protect downloaded files.",
                    )}
                  </small>
                </div>
                {!backupState.configured ? (
                  <div className="empty-state">
                    <h3>{t("Backup directory is not mounted")}</h3>
                    <p>
                      {t(
                        "Configure BACKUP_PATH in the Compose environment and mount the same protected directory read-only into the app.",
                      )}
                    </p>
                  </div>
                ) : backupState.backups.length ? (
                  <div className="backup-list">
                    {backupState.backups.map((backup) => (
                      <div className="resource-row" key={backup.name}>
                        <div className="resource-info">
                          <h3>{backup.name}</h3>
                          <p>
                            {bytes(backup.size)} ·{" "}
                            {displayDate(
                              backup.modifiedAt,
                              systemSettings.timeZone,
                            )}
                          </p>
                        </div>
                        <a
                          className="button-link"
                          href={`/api/backups/${encodeURIComponent(backup.name)}`}
                        >
                          {t("Download archive")}
                        </a>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <h3>{t("No backup archives found")}</h3>
                    <p>
                      {t("Completed maintenance backups will appear here.")}
                    </p>
                  </div>
                )}
                <small className="backup-footer">
                  {t(
                    "Showing up to 100 newest archives. Restore remains an offline, administrator-operated procedure to prevent accidental overwrite.",
                  )}
                </small>
              </section>
            )}
            {page === "users" && (
              <section className="panel">
                <div className="panel-heading">
                  <h2>{t("Your team")}</h2>
                </div>
                {users.map((member) => (
                  <div className="resource-row" key={member.id}>
                    <span className="avatar">
                      {member.email[0].toUpperCase()}
                    </span>
                    <div className="resource-info">
                      <h3>{member.email}</h3>
                      <p>
                        {member.role} ·{" "}
                        {member.last_login
                          ? `${t("Last login")} ${displayDate(member.last_login, systemSettings.timeZone)}`
                          : t("Has not signed in")}
                      </p>
                    </div>
                    <span
                      className={`badge ${member.active ? "live" : "offline"}`}
                    >
                      {t(member.active ? "active" : "inactive")}
                    </span>
                    <button
                      disabled={busy || member.id === user.id}
                      onClick={() =>
                        void act(
                          () =>
                            api(
                              `users/${member.id}`,
                              { active: !member.active },
                              "PATCH",
                            ),
                          t("Member updated"),
                        )
                      }
                    >
                      {t(member.active ? "Deactivate" : "Activate")}
                    </button>
                  </div>
                ))}
              </section>
            )}
            {page === "settings" && (
              <div className="bottom-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>{t("Your account")}</h2>
                  </div>
                  <div className="detail-list">
                    <p>
                      {t("Email")} <strong>{user.email}</strong>
                    </p>
                    <p>
                      {t("Role")} <strong>{user.role}</strong>
                    </p>
                    <p>
                      {t("Timezone")} <strong>{systemSettings.timeZone}</strong>
                    </p>
                    <label className="theme-setting" htmlFor="theme-choice">
                      {t("Theme")}
                      <select
                        id="theme-choice"
                        value={theme}
                        onChange={(event) =>
                          setTheme(event.target.value as ThemeChoice)
                        }
                      >
                        <option value="system">{t("System")}</option>
                        <option value="light">{t("Light")}</option>
                        <option value="dark">{t("Dark")}</option>
                      </select>
                    </label>
                    <label className="theme-setting" htmlFor="language-choice">
                      {t("Language")}
                      <select
                        id="language-choice"
                        aria-label={t("Language")}
                        value={language}
                        onChange={(event) =>
                          setLanguage(event.target.value as Language)
                        }
                      >
                        <option value="en">{t("English")}</option>
                        <option value="id">{t("Indonesian")}</option>
                      </select>
                    </label>
                    <button
                      onClick={async () => {
                        try {
                          await api("logout", {});
                          setUser(null);
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      {t("Sign out")}
                    </button>
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>{t("Change password")}</h2>
                  </div>
                  <form
                    className="settings-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      setBusy(true);
                      try {
                        await api("password", {
                          currentPassword: f.get("currentPassword"),
                          password: f.get("password"),
                        });
                        setUser(null);
                        setError("");
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <label>
                      {t("Current password")}
                      <input
                        name="currentPassword"
                        type="password"
                        autoComplete="current-password"
                        required
                      />
                    </label>
                    <label>
                      {t("New password")}
                      <input
                        name="password"
                        type="password"
                        minLength={12}
                        maxLength={256}
                        autoComplete="new-password"
                        required
                      />
                    </label>
                    <small>
                      {t(
                        "At least 12 characters. Changing your password signs out all sessions.",
                      )}
                    </small>
                    <button className="primary" disabled={busy}>
                      {t("Update password")}
                    </button>
                  </form>
                </section>
                {user.role === "admin" && (
                  <SystemSettingsCard
                    settings={systemSettings}
                    profiles={data.profiles}
                    api={api}
                    run={act}
                    t={t}
                    logoUrl={logoUrl}
                    onLogoChange={(logoUpdatedAt: string) => {
                      setLogoUrl(
                        logoUpdatedAt
                          ? `/api/branding/logo?v=${encodeURIComponent(logoUpdatedAt)}`
                          : "",
                      );
                      setSystemSettings((current) => ({
                        ...current,
                        logoAvailable: Boolean(logoUpdatedAt),
                        logoUpdatedAt,
                      }));
                    }}
                  />
                )}
                {user.role === "admin" && (
                  <NotificationsCard api={api} run={act} canEdit />
                )}
                {user.role === "admin" && (
                  <WebhooksCard api={api} run={act} canEdit />
                )}
              </div>
            )}
            <footer className="page-footer">
              <span>
                {systemSettings.applicationName}{" "}
                <span className="muted">/</span> {t("Your content. Always on.")}
              </span>
              <span>{t("Single-server edition · v0.1")}</span>
            </footer>
          </div>
        </main>
        {modal && (
          <ResourceModal
            kind={modal.kind}
            item={modal.item}
            data={data}
            defaultProfileId={systemSettings.defaultProfileId}
            defaultBitrate={systemSettings.defaultBitrate}
            timeZone={systemSettings.timeZone}
            busy={busy}
            error={error}
            reportError={setError}
            close={() => {
              setModal(null);
              setError("");
            }}
            save={async (body) => {
              const saved = await act(
                () =>
                  api(
                    `${modal.kind}${modal.item ? `/${modal.item.id}` : ""}`,
                    body,
                    modal.item ? "PUT" : "POST",
                  ),
                "Saved successfully",
              );
              if (saved) setModal(null);
            }}
          />
        )}
        {preview && (
          <div className="modal-backdrop">
            <section
              className="modal preview-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="preview-title"
            >
              <div className="panel-heading">
                <h2 id="preview-title">{preview.name}</h2>
                <button
                  autoFocus
                  onClick={() => setPreview(null)}
                  aria-label={t("Close preview")}
                >
                  ×
                </button>
              </div>
              <video src={`/api/media/${preview.id}`} controls autoPlay />
              <p className="muted">
                {t(
                  "Library file preview · This is not a live broadcast preview.",
                )}
              </p>
            </section>
          </div>
        )}
      </div>
    </LocaleContext.Provider>
  );
}
function AnalyticsPage({
  report,
  days,
  setDays,
  timeZone,
}: {
  report: any;
  days: number;
  setDays: (value: number) => void;
  timeZone: string;
}) {
  const t = useTranslator();
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const to = new Date().toISOString();
  const csv = `/api/analytics.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{t("Streaming performance")}</h2>
            <small>
              {t(
                "Calculated from persisted stream events and FFmpeg progress samples",
              )}
            </small>
          </div>
          <div className="heading-actions">
            <select
              aria-label={t("Analytics reporting period")}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={7}>{t("Last 7 days")}</option>
              <option value={30}>{t("Last 30 days")}</option>
              <option value={90}>{t("Last 90 days")}</option>
              <option value={365}>{t("Last 365 days")}</option>
            </select>
            <a className="primary analytics-export" href={csv}>
              ↓ Export CSV
            </a>
          </div>
        </div>
        <div className="stats analytics-stats">
          <Stat
            label="Streaming hours"
            value={String(report?.summary.streamingHours ?? "—")}
            note={`${report?.summary.sessions ?? 0} ${t("broadcast sessions")}`}
            icon="streams"
            accent
          />
          <Stat
            label="Failed outputs"
            value={String(report?.summary.failedOutputs ?? "—")}
            note="Destination retry budgets exhausted"
            icon="events"
          />
          <Stat
            label="Reconnections"
            value={String(report?.summary.reconnects ?? "—")}
            note="Automatic output recovery attempts"
            icon="server"
          />
          <Stat
            label="Schedule failures"
            value={String(report?.summary.failedSchedules ?? "—")}
            note="Missed or unstartable schedules"
            icon="schedules"
          />
        </div>
      </section>
      <section className="panel analytics-panel">
        <div className="panel-heading">
          <h2>
            {t("Broadcast sessions")}{" "}
            <span className="count">{report?.sessions.length ?? 0}</span>
          </h2>
          <span className="muted">
            {t("Times shown in")} {timeZone}
          </span>
        </div>
        {report?.sessions.length ? (
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>{t("Stream")}</th>
                  <th>{t("Started")}</th>
                  <th>{t("Stopped")}</th>
                  <th>{t("Duration")}</th>
                  <th>{t("Session")}</th>
                </tr>
              </thead>
              <tbody>
                {report.sessions.toReversed().map((row: any, index: number) => (
                  <tr key={`${row.streamId}-${row.startedAt}-${index}`}>
                    <td>
                      <strong>{row.stream}</strong>
                    </td>
                    <td>{displayDate(row.startedAt, timeZone)}</td>
                    <td>
                      {row.stoppedAt
                        ? displayDate(row.stoppedAt, timeZone)
                        : "—"}
                    </td>
                    <td>{duration(row.durationSeconds)}</td>
                    <td>
                      <span
                        className={`badge ${row.stoppedAt ? "offline" : "live"}`}
                      >
                        {t(row.stoppedAt ? "ended" : "running")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No broadcast history in this period"
            text="Started and stopped stream sessions will be summarized here."
          />
        )}
      </section>
      <section className="panel analytics-panel">
        <div className="panel-heading">
          <h2>{t("Destination performance")}</h2>
          <span className="muted">
            {t("Average values from 30-second worker samples")}
          </span>
        </div>
        {report?.destinations.length ? (
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>{t("Destination")}</th>
                  <th>{t("Uptime")}</th>
                  <th>{t("Connected time")}</th>
                  <th>{t("Failed connections")}</th>
                  <th>{t("Average bitrate")}</th>
                  <th>{t("Average FPS")}</th>
                  <th>{t("Samples")}</th>
                </tr>
              </thead>
              <tbody>
                {report.destinations.map((row: any) => (
                  <tr key={row.destinationId}>
                    <td>
                      <strong>{row.name}</strong>
                    </td>
                    <td>
                      {row.uptimePercent === null
                        ? t("No connection data")
                        : `${row.uptimePercent}%`}
                    </td>
                    <td>
                      {row.uptimeSeconds >= 3600
                        ? `${(row.uptimeSeconds / 3600).toFixed(1)} h`
                        : `${Math.round(row.uptimeSeconds / 60)} min`}
                      <span className="muted">
                        {` · ${row.connectionSessions} connection${row.connectionSessions === 1 ? "" : "s"}`}
                      </span>
                    </td>
                    <td>{row.failedConnections}</td>
                    <td>
                      {row.averageBitrateKbps === null
                        ? t("No samples")
                        : `${row.averageBitrateKbps.toLocaleString()} kbps`}
                    </td>
                    <td>{row.averageFps === null ? "—" : row.averageFps}</td>
                    <td>{row.samples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="analytics-note">
            {t(
              "No destination activity has been recorded in this period. Worker samples are stored while a broadcast is running.",
            )}
          </div>
        )}
      </section>
      <p className="analytics-note">
        {t(
          "Reports use up to 20,000 retained audit events and 200,000 worker metric samples. Uptime measures locally observed FFmpeg output connections; duration and bitrate are not platform audience or reception metrics.",
        )}
      </p>
    </>
  );
}

function Stat({
  label,
  value,
  note,
  icon,
  accent,
}: {
  label: string;
  value: string;
  note: string;
  icon: string;
  accent?: boolean;
}) {
  const t = useTranslator();
  const translatedNote = note.replace(
    /^(\d+) broadcast sessions$/,
    (_, count) => `${count} ${t("broadcast sessions")}`,
  );
  return (
    <div className={`stat ${accent ? "accent" : ""}`}>
      <div>
        <span>{t(label)}</span>
        <Icon name={icon} />
      </div>
      <strong>{value}</strong>
      <small>
        {accent && <i className="dot" />}
        {t(translatedNote)}
      </small>
    </div>
  );
}
function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  const t = useTranslator();
  return (
    <div className="empty">
      <span className="empty-symbol">◈</span>
      <h3>{t(title)}</h3>
      <p>{t(text)}</p>
      {action}
    </div>
  );
}

const notificationOptions = [
  ["system.threshold", "CPU / disk threshold"],
  ["stream.stalled", "Encoder stalled"],
  ["stream.started", "Stream started"],
  ["stream.stopped", "Stream stopped"],
  ["stream.failed", "Stream failed"],
  ["output.retrying", "Destination retrying"],
  ["schedule.failed", "Schedule failed"],
];
const webhookOptions = [
  ["stream.started", "Stream started"],
  ["stream.stopped", "Stream stopped"],
  ["stream.failed", "Stream failed"],
  ["schedule.started", "Schedule started"],
  ["schedule.failed", "Schedule failed"],
];

function SystemSettingsCard({
  settings,
  profiles,
  api,
  run,
  t,
  logoUrl,
  onLogoChange,
}: {
  settings: {
    applicationName: string;
    maintenanceMode: boolean;
    defaultProfileId: string;
    defaultBitrate: number;
    retryAttempts: number;
    videoRetentionDays: number;
    thresholdAlerts: boolean;
    cpuThreshold: number;
    diskThreshold: number;
    timeZone: string;
    logoAvailable?: boolean;
    logoUpdatedAt?: string;
  };
  profiles: Item[];
  api: (path: string, body?: any, method?: string) => Promise<any>;
  run: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
  t: Translator;
  logoUrl: string;
  onLogoChange: (logoUpdatedAt: string) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{t("System settings")}</h2>
          <small>{t("Single-server workspace preferences")}</small>
        </div>
      </div>
      <div className="logo-settings">
        <div>
          <strong>{t("Workspace logo")}</strong>
          <small>
            {t("PNG only, up to 1 MB; maximum dimensions 2048 × 1024.")}
          </small>
        </div>
        {logoUrl && (
          <img
            className="workspace-logo logo-preview"
            src={logoUrl}
            alt={`${settings.applicationName} logo preview`}
          />
        )}
        <label>
          {t("Upload PNG logo")}
          <input
            aria-label={t("Workspace logo PNG")}
            type="file"
            accept="image/png"
            onChange={async (event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              if (!file) return;
              const form = new FormData();
              form.append("file", file);
              let updated: any;
              const saved = await run(async () => {
                updated = await api("branding/logo", form, "PUT");
                return updated;
              }, t("Workspace logo updated"));
              if (saved) onLogoChange(updated.logoUpdatedAt);
              input.value = "";
            }}
          />
        </label>
        {settings.logoAvailable && (
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (!window.confirm(t("Remove the workspace logo?"))) return;
              const removed = await run(
                () => api("branding/logo", {}, "DELETE"),
                t("Workspace logo removed"),
              );
              if (removed) onLogoChange("");
            }}
          >
            {t("Remove logo")}
          </button>
        )}
      </div>
      <form
        key={`${settings.applicationName}:${settings.maintenanceMode}:${settings.defaultProfileId}:${settings.defaultBitrate}:${settings.retryAttempts}:${settings.videoRetentionDays}:${settings.timeZone}:${settings.thresholdAlerts}:${settings.cpuThreshold}:${settings.diskThreshold}`}
        className="settings-form notification-body"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const videoRetentionDays = Number(form.get("videoRetentionDays"));
          if (
            videoRetentionDays > 0 &&
            videoRetentionDays !== settings.videoRetentionDays &&
            !window.confirm(
              `Enable automatic deletion of unreferenced videos older than ${videoRetentionDays} days? Expired video files cannot be recovered from this action.`,
            )
          )
            return;
          await run(
            () =>
              api(
                "settings",
                {
                  applicationName: String(form.get("applicationName") || ""),
                  maintenanceMode: form.has("maintenanceMode"),
                  defaultProfileId: String(form.get("defaultProfileId") || ""),
                  defaultBitrate: Number(form.get("defaultBitrate")),
                  retryAttempts: Number(form.get("retryAttempts")),
                  videoRetentionDays,
                  thresholdAlerts: form.has("thresholdAlerts"),
                  cpuThreshold: Number(form.get("cpuThreshold")),
                  diskThreshold: Number(form.get("diskThreshold")),
                  timeZone: String(form.get("timeZone") || ""),
                },
                "PUT",
              ),
            t("System settings saved"),
          );
        }}
      >
        <label>
          {t("Application name")}
          <input
            name="applicationName"
            defaultValue={settings.applicationName}
            minLength={1}
            maxLength={120}
            required
          />
        </label>
        <label>
          {t("Default encoding profile")}
          <select
            name="defaultProfileId"
            defaultValue={settings.defaultProfileId}
            required
          >
            {profiles.map((profile) => (
              <option value={profile.id} key={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Workspace timezone (IANA)")}
          <input
            name="timeZone"
            defaultValue={settings.timeZone}
            maxLength={100}
            required
            placeholder="Asia/Jakarta"
          />
        </label>
        <label>
          {t("Default video bitrate (kbps)")}
          <input
            name="defaultBitrate"
            type="number"
            min={300}
            max={12000}
            step={100}
            defaultValue={settings.defaultBitrate}
            required
          />
        </label>
        <label>
          {t("Retry attempts per destination")}
          <input
            name="retryAttempts"
            type="number"
            min={0}
            max={10}
            defaultValue={settings.retryAttempts}
            required
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            name="thresholdAlerts"
            defaultChecked={settings.thresholdAlerts}
          />
          CPU / disk alerts
        </label>
        <label>
          CPU threshold (%)
          <input
            name="cpuThreshold"
            type="number"
            min="10"
            max="100"
            defaultValue={settings.cpuThreshold}
            required
          />
        </label>
        <label>
          Disk threshold (%)
          <input
            name="diskThreshold"
            type="number"
            min="10"
            max="100"
            defaultValue={settings.diskThreshold}
            required
          />
        </label>
        <small>
          Select CPU / disk threshold in notification events to receive alerts.
          Alerts rearm after usage falls 5 percentage points below the
          threshold.
        </small>
        <label>
          {t("Video retention (days; 0 disables automatic deletion)")}
          <input
            name="videoRetentionDays"
            type="number"
            min={0}
            max={3650}
            defaultValue={settings.videoRetentionDays}
            required
          />
        </label>
        <small>
          {t(
            "Runs hourly. Expired videos still used by a playlist are preserved; deleted media is not recoverable from the workspace.",
          )}
        </small>
        <label className="check">
          <input
            type="checkbox"
            name="maintenanceMode"
            defaultChecked={settings.maintenanceMode}
          />
          {t("Enable maintenance mode")}
        </label>
        <small>
          {t(
            "Pauses API edits by operators/viewers. Operators can still stop streams; administrators retain access, and scheduled broadcasts are not stopped.",
          )}
        </small>
        <button className="primary">{t("Save system settings")}</button>
      </form>
    </section>
  );
}

function NotificationsCard({
  api,
  run,
  canEdit,
}: {
  api: (path: string, body?: any, method?: string) => Promise<any>;
  run: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
  canEdit: boolean;
}) {
  const t = useTranslator();
  const [settings, setSettings] = useState<any>({
    configured: false,
    enabled: false,
    provider: "discord",
    target: "",
    events: [],
  });
  const [provider, setProvider] = useState("discord");
  const [failure, setFailure] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    void api("notifications")
      .then((value) => {
        if (alive) {
          setSettings(value);
          setProvider(value.provider || "discord");
        }
      })
      .catch((error) => {
        if (alive) setFailure(error.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{t("Notifications")}</h2>
          <small>{t("Alerts for broadcast and schedule events")}</small>
        </div>
        <span className={`badge ${settings.enabled ? "live" : "offline"}`}>
          {t(settings.enabled ? "enabled" : "disabled")}
        </span>
      </div>
      {loading ? (
        <p className="muted notification-body">
          {t("Loading notification settings…")}
        </p>
      ) : (
        <form
          className="settings-form notification-body"
          onSubmit={async (e) => {
            e.preventDefault();
            setFailure("");
            const data = new FormData(e.currentTarget);
            const body = {
              provider,
              target:
                provider === "telegram" ? String(data.get("target") || "") : "",
              secret: String(data.get("secret") || "") || undefined,
              enabled: data.has("enabled"),
              events: notificationOptions
                .filter(([key]) => data.has(`event:${key}`))
                .map(([key]) => key),
            };
            if (
              await run(
                () => api("notifications", body, "PUT"),
                t("Notification settings saved"),
              )
            ) {
              const next = await api("notifications");
              setSettings(next);
              setProvider(next.provider || provider);
            }
          }}
        >
          {!canEdit && (
            <small>
              {t(
                "Only an administrator can change the notification integration.",
              )}
            </small>
          )}
          <label>
            {t("Provider")}
            <select
              aria-label={t("Notification provider")}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              disabled={!canEdit}
            >
              <option value="discord">Discord webhook</option>
              <option value="telegram">Telegram bot</option>
            </select>
          </label>
          {provider === "telegram" && (
            <label>
              Telegram chat ID
              <input
                key={settings.provider + settings.target}
                name="target"
                defaultValue={
                  settings.provider === "telegram" ? settings.target : ""
                }
                disabled={!canEdit}
                placeholder="Chat ID or @channel"
              />
            </label>
          )}
          <label>
            {provider === "discord"
              ? t("Discord webhook URL")
              : t("Telegram bot token")}
            <input
              key={`${settings.provider}:${provider}`}
              name="secret"
              type="password"
              autoComplete="new-password"
              disabled={!canEdit}
              placeholder={
                settings.configured && settings.provider === provider
                  ? "Saved securely · leave blank to keep current credential"
                  : provider === "discord"
                    ? "https://discord.com/api/webhooks/…"
                    : "123456789:bot-token"
              }
              required={!settings.configured || settings.provider !== provider}
            />
          </label>
          <fieldset
            key={`${settings.events.join(",")}:${settings.enabled}`}
            className="notification-events"
            disabled={!canEdit}
          >
            <legend>{t("Send alerts for")}</legend>
            {notificationOptions.map(([key, label]) => (
              <label className="check" key={key}>
                <input
                  type="checkbox"
                  name={`event:${key}`}
                  defaultChecked={settings.events.includes(key)}
                />
                {t(label)}
              </label>
            ))}
          </fieldset>
          <label className="check">
            <input
              key={String(settings.enabled)}
              type="checkbox"
              name="enabled"
              defaultChecked={settings.enabled}
              disabled={!canEdit}
            />{" "}
            {t("Enable notifications")}
          </label>
          {failure && (
            <p className="danger-text" role="alert">
              {t(failure)}
            </p>
          )}
          <div className="notification-actions">
            {settings.configured && (
              <button
                type="button"
                disabled={!canEdit}
                onClick={() =>
                  void run(
                    () => api("notifications/test", {}),
                    t("Test notification delivered"),
                  )
                }
              >
                {t("Send test notification")}
              </button>
            )}
            {canEdit && (
              <button className="primary">{t("Save settings")}</button>
            )}
          </div>
          <small>
            {t(
              "Messages contain the event, resource, UTC time, and safe diagnostic details. Provider credentials are encrypted and never displayed after saving.",
            )}
          </small>
        </form>
      )}
    </section>
  );
}

function WebhooksCard({
  api,
  run,
  canEdit,
}: {
  api: (path: string, body?: any, method?: string) => Promise<any>;
  run: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
  canEdit: boolean;
}) {
  const t = useTranslator();
  const [settings, setSettings] = useState<any>({
    configured: false,
    endpointHost: "",
    enabled: false,
    events: [],
  });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let alive = true;
    void api("webhooks")
      .then((value) => {
        if (alive) setSettings(value);
      })
      .catch((error) => {
        if (alive) setFailure(error.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{t("Signed webhooks")}</h2>
          <small>{t("Send alerts for")}</small>
        </div>
        <span className={`badge ${settings.enabled ? "live" : "offline"}`}>
          {t(settings.enabled ? "enabled" : "disabled")}
        </span>
      </div>
      {loading ? (
        <p className="muted notification-body">
          {t("Loading notification settings…")}
        </p>
      ) : (
        <form
          className="settings-form notification-body"
          onSubmit={async (event) => {
            event.preventDefault();
            setFailure("");
            const data = new FormData(event.currentTarget);
            const form = event.currentTarget;
            const body = {
              endpoint: String(data.get("endpoint") || "").trim() || undefined,
              secret: String(data.get("secret") || "") || undefined,
              enabled: data.has("enabled"),
              events: webhookOptions
                .filter(([key]) => data.has(`event:${key}`))
                .map(([key]) => key),
            };
            if (
              await run(
                () => api("webhooks", body, "PUT"),
                t("Webhook settings saved"),
              )
            ) {
              setSettings(await api("webhooks"));
              form.reset();
            }
          }}
        >
          {!canEdit && (
            <small>
              {t(
                "Only an administrator can change the notification integration.",
              )}
            </small>
          )}
          <label>
            {t("HTTPS receiver URL")}
            <input
              key={String(settings.configured)}
              name="endpoint"
              type="url"
              autoComplete="url"
              disabled={!canEdit}
              required={!settings.configured}
              placeholder={
                settings.configured
                  ? `${t("Saved securely at")} ${settings.endpointHost} · ${t("blank keeps current value")}`
                  : "https://example.com/hooks/streamax"
              }
            />
          </label>
          <label>
            {t("HMAC signing secret")}
            <input
              key={`secret:${settings.configured}`}
              name="secret"
              type="password"
              minLength={16}
              maxLength={256}
              autoComplete="new-password"
              disabled={!canEdit}
              required={!settings.configured}
              placeholder={
                settings.configured
                  ? t("Saved securely · blank keeps current value")
                  : t("Use a random secret of at least 16 characters")
              }
            />
          </label>
          <fieldset
            key={`${settings.events.join(",")}:${settings.enabled}`}
            className="notification-events"
            disabled={!canEdit}
          >
            <legend>{t("Send alerts for")}</legend>
            {webhookOptions.map(([key, label]) => (
              <label className="check" key={key}>
                <input
                  type="checkbox"
                  name={`event:${key}`}
                  defaultChecked={settings.events.includes(key)}
                />
                {t(label)}
              </label>
            ))}
          </fieldset>
          <label className="check">
            <input
              key={String(settings.enabled)}
              type="checkbox"
              name="enabled"
              defaultChecked={settings.enabled}
              disabled={!canEdit}
            />{" "}
            {t("Enable signed webhooks")}
          </label>
          {failure && (
            <p className="danger-text" role="alert">
              {t(failure)}
            </p>
          )}
          <div className="notification-actions">
            {settings.configured && (
              <button
                type="button"
                disabled={!canEdit}
                onClick={() =>
                  void run(
                    () => api("webhooks/test", {}),
                    t("Test webhook delivered"),
                  )
                }
              >
                {t("Send test webhook")}
              </button>
            )}
            {canEdit && (
              <button className="primary">{t("Save settings")}</button>
            )}
          </div>
          <small>
            {t(
              "Configure a public HTTPS endpoint and a strong signing secret. Deliveries are encrypted, signed and attempted at most three times. Pending deliveries retain their original settings. Private or local network addresses are blocked.",
            )}
          </small>
        </form>
      )}
    </section>
  );
}

function ResourceModal({
  kind,
  item,
  data,
  defaultProfileId,
  defaultBitrate,
  timeZone,
  busy,
  error,
  reportError,
  close,
  save,
}: {
  kind: Kind | "users";
  item?: Item;
  data: Record<Kind, Item[]>;
  defaultProfileId: string;
  defaultBitrate: number;
  timeZone: string;
  busy: boolean;
  error: string;
  reportError: (message: string) => void;
  close: () => void;
  save: (body: any) => Promise<void>;
}) {
  const t = useTranslator();
  const [videos, setVideos] = useState<string[]>(item?.videoIds || []);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(
    item?.playlistId || "",
  );
  const [playbackMode, setPlaybackMode] = useState(
    item?.loop ? "unlimited" : item?.playCount ? "fixed" : "once",
  );
  const [playCount, setPlayCount] = useState(String(item?.playCount ?? 3));
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const container = dialog.current!;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = Array.from(
        container.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input,select",
        ),
      ).filter((e) => e.offsetParent !== null);
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    container.addEventListener("keydown", trap);
    return () => container.removeEventListener("keydown", trap);
  }, []);
  const options = (type: Kind) =>
    data[type].map((value) => (
      <option
        key={value.id}
        value={value.id}
        disabled={
          type === "videos" && Boolean(value.status && value.status !== "ready")
        }
      >
        {value.name}
      </option>
    ));
  const localDate = (date?: string) =>
    date ? instantToDateTimeLocal(date, timeZone) : "";
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{t("WORKSPACE")}</span>
            <h2 id="modal-title">
              {t(item ? "Edit" : "Create")}{" "}
              {t(
                kind === "users"
                  ? "team member"
                  : kind === "videos"
                    ? "video"
                    : kind.slice(0, -1),
              )}
            </h2>
          </div>
          <button
            disabled={busy}
            onClick={close}
            aria-label={t("Close dialog")}
          >
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            let body: any = Object.fromEntries(f);
            if (kind === "playlists") body.videoIds = videos;
            if (kind === "profiles")
              for (const key of [
                "width",
                "height",
                "fps",
                "bitrate",
                "audioBitrate",
              ])
                body[key] = Number(body[key]);
            if (kind === "destinations") {
              body.enabled = f.has("enabled");
              if (!body.key) delete body.key;
            }
            if (kind === "streams") {
              body.watermark = f.has("watermark");
              body.livePreview = f.has("livePreview");
              body.destinationIds = f.getAll("destinationIds");
              body.loop = playbackMode === "unlimited";
              if (playbackMode === "fixed")
                body.playCount = Number(f.get("playCount"));
              else delete body.playCount;
            }
            if (kind === "schedules") {
              body.occurrences = Number(body.occurrences || 1);
              if (!body.playlistId) delete body.playlistId;
              try {
                body.startAt = dateTimeLocalToInstant(body.startAt, timeZone);
                body.endAt = dateTimeLocalToInstant(body.endAt, timeZone);
              } catch (cause) {
                reportError(
                  cause instanceof Error
                    ? cause.message
                    : t("Enter valid schedule times"),
                );
                return;
              }
            }
            void save(body);
          }}
        >
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          {kind !== "users" && (
            <label>
              {t("Name")}
              <input
                name="name"
                defaultValue={item?.name}
                maxLength={120}
                autoFocus
                required
                placeholder={t(`Give this ${kind.slice(0, -1)} a name`)}
              />
            </label>
          )}
          {kind === "playlists" && (
            <>
              <label>
                {t("Add videos")}
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) setVideos([...videos, e.target.value]);
                    e.target.value = "";
                  }}
                >
                  <option value="">{t("Select a video…")}</option>
                  {options("videos")}
                </select>
              </label>
              <div className="playlist-editor">
                {videos.map((video, i) => (
                  <div key={`${video}-${i}`}>
                    <span className="muted">{i + 1}</span>
                    <strong>
                      {data.videos.find((v) => v.id === video)?.name}
                    </strong>
                    <button
                      type="button"
                      aria-label={t("Move video up")}
                      disabled={i === 0}
                      onClick={() => {
                        const copy = [...videos];
                        [copy[i - 1], copy[i]] = [copy[i], copy[i - 1]];
                        setVideos(copy);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={t("Move video down")}
                      disabled={i === videos.length - 1}
                      onClick={() => {
                        const copy = [...videos];
                        [copy[i + 1], copy[i]] = [copy[i], copy[i + 1]];
                        setVideos(copy);
                      }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={t("Remove video from playlist")}
                      onClick={() =>
                        setVideos(videos.filter((_, index) => index !== i))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <small>
                {t(
                  "Playback follows this order. You can add a video more than once.",
                )}
              </small>
            </>
          )}
          {kind === "profiles" && (
            <div className="form-grid">
              {[
                ["width", "Width", 1280, 320, 1920],
                ["height", "Height", 720, 240, 1080],
                ["fps", "Frames per second", 30, 15, 60],
                ["bitrate", "Video bitrate (kbps)", defaultBitrate, 300, 12000],
                ["audioBitrate", "Audio bitrate (kbps)", 128, 64, 320],
              ].map(([key, label, initial, min, max]) => (
                <label key={key}>
                  {t(String(label))}
                  <input
                    name={String(key)}
                    type="number"
                    min={min}
                    max={max}
                    step={key === "width" || key === "height" ? 2 : 1}
                    defaultValue={item?.[key] ?? initial}
                    required
                  />
                </label>
              ))}
            </div>
          )}
          {kind === "destinations" && (
            <>
              <label>
                {t("Platform")}
                <select
                  name="platform"
                  aria-label={t("Platform")}
                  defaultValue={item?.platform || "YouTube"}
                >
                  {["YouTube", "Facebook", "Twitch", "Custom"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("Ingest server URL")}
                <input
                  name="url"
                  defaultValue={item?.url}
                  placeholder="rtmps://your-ingest-server/app"
                  required
                />
              </label>
              <label>
                {t("Stream key")}
                <input
                  name="key"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    item
                      ? t("Leave blank to keep current key")
                      : t("Paste your stream key")
                  }
                  required={!item}
                />
              </label>
              <small>
                {t(
                  "Use the ingest URL provided by your platform. Keys are encrypted and never returned to your browser.",
                )}
              </small>
              <label className="check">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={item?.enabled ?? true}
                />{" "}
                {t("Enable this destination")}
              </label>
            </>
          )}
          {kind === "streams" && (
            <>
              <div className="form-grid">
                <label>
                  {t("Playlist")}
                  <select
                    name="playlistId"
                    aria-label={t("Playlist")}
                    value={selectedPlaylistId}
                    onChange={(event) => {
                      setSelectedPlaylistId(event.target.value);
                      if (
                        data.playlists.find(
                          (playlist) => playlist.id === event.target.value,
                        )?.videoIds?.length !== 1 &&
                        playbackMode === "fixed"
                      )
                        setPlaybackMode("unlimited");
                    }}
                    required
                  >
                    <option value="" disabled>
                      {t("Select a playlist")}
                    </option>
                    {options("playlists")}
                  </select>
                </label>
                <label>
                  {t("Encoding profile")}
                  <select
                    name="profileId"
                    aria-label={t("Encoding profile")}
                    defaultValue={item?.profileId || defaultProfileId}
                    required
                  >
                    <option value="" disabled>
                      {t("Select a profile")}
                    </option>
                    {options("profiles")}
                  </select>
                </label>
              </div>
              <label>{t("Broadcast destinations")}</label>
              <div className="destination-select">
                {data.destinations.length ? (
                  data.destinations.map((d) => (
                    <label className="check" key={d.id}>
                      <input
                        type="checkbox"
                        name="destinationIds"
                        value={d.id}
                        defaultChecked={item?.destinationIds.includes(d.id)}
                        disabled={!d.enabled}
                      />
                      <span>
                        {d.name}
                        <small>
                          {d.platform}
                          {!d.enabled && " · disabled"}
                        </small>
                      </span>
                    </label>
                  ))
                ) : (
                  <small>
                    {t("Create a destination before creating a stream.")}
                  </small>
                )}
              </div>
              <div className="form-grid">
                <label>
                  {t("Playback mode")}
                  <select
                    aria-label={t("Playback mode")}
                    value={playbackMode}
                    onChange={(event) => setPlaybackMode(event.target.value)}
                  >
                    <option value="unlimited">{t("Loop forever")}</option>
                    <option value="once">{t("Play once")}</option>
                    {data.playlists.find(
                      (playlist) => playlist.id === selectedPlaylistId,
                    )?.videoIds?.length === 1 && (
                      <option value="fixed">
                        {t("Play a fixed number of times")}
                      </option>
                    )}
                  </select>
                </label>
                {playbackMode === "fixed" && (
                  <label>
                    {t("Total plays")}
                    <input
                      name="playCount"
                      type="number"
                      min="2"
                      max="1000"
                      value={playCount}
                      onChange={(event) => setPlayCount(event.target.value)}
                      required
                    />
                  </label>
                )}
              </div>
              {playbackMode === "fixed" && (
                <small>{t("Total plays includes the first playback.")}</small>
              )}
              <label>
                {t("Overlay text")}
                <input
                  name="overlayText"
                  maxLength={200}
                  defaultValue={item?.overlayText || ""}
                />
              </label>
              <small>
                {t(
                  "Leave overlay empty and watermark off for automatic stream copy. Realtime overlays require CPU encoding; on STB, try 720p24 or 960x540p30 if output is below realtime.",
                )}
              </small>
              <label>
                {t("Overlay position")}
                <select
                  name="overlayPosition"
                  defaultValue={item?.overlayPosition || "top-left"}
                >
                  {["top-left", "top-right", "bottom-left", "bottom-right"].map(
                    (position) => (
                      <option key={position}>{position}</option>
                    ),
                  )}
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  name="watermark"
                  defaultChecked={item?.watermark}
                />
                {t("Workspace logo watermark")}
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  name="livePreview"
                  defaultChecked={item?.livePreview}
                />
                {t("Enable live preview")}
              </label>
              <small>
                {t(
                  "Live preview shows the source without overlays, using stream copy. Preview timing depends on source keyframes.",
                )}
              </small>
              <small>
                {t(
                  "Each destination uses one worker output. Restarting begins the playlist again.",
                )}
              </small>
            </>
          )}
          {kind === "schedules" && (
            <>
              <label>
                {t("Scheduled playlist")}
                <select name="playlistId" defaultValue={item?.playlistId || ""}>
                  <option value="">{t("Use stream playlist")}</option>
                  {options("playlists")}
                </select>
              </label>
              {!item && (
                <div className="form-grid">
                  <label>
                    {t("Repeat")}
                    <select name="recurrence">
                      <option value="none">{t("Once")}</option>
                      <option value="daily">{t("Daily")}</option>
                      <option value="weekly">{t("Weekly")}</option>
                    </select>
                  </label>
                  <label>
                    {t("Occurrences")}
                    <input
                      name="occurrences"
                      type="number"
                      min="1"
                      max="366"
                      defaultValue="1"
                      required
                    />
                  </label>
                </div>
              )}
              <label>
                {t("Stream")}
                <select
                  name="streamId"
                  aria-label={t("Stream")}
                  defaultValue={item?.streamId || ""}
                  required
                >
                  <option value="" disabled>
                    {t("Select a stream")}
                  </option>
                  {options("streams")}
                </select>
              </label>
              <div className="form-grid">
                <label>
                  {t("Start time")}
                  <input
                    name="startAt"
                    type="datetime-local"
                    defaultValue={localDate(item?.startAt)}
                    required
                  />
                </label>
                <label>
                  {t("End time")}
                  <input
                    name="endAt"
                    type="datetime-local"
                    defaultValue={localDate(item?.endAt)}
                    required
                  />
                </label>
              </div>
              <small>
                {t("One-time schedule in")} {timeZone}.{" "}
                {t("Stream and destination overlaps are checked when saved.")}
              </small>
            </>
          )}
          {kind === "users" && (
            <>
              <label>
                {t("Email")}
                <input name="email" type="email" autoFocus required />
              </label>
              <label>
                {t("Initial password")}
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={256}
                  required
                />
              </label>
              <label>
                {t("Role")}
                <select name="role">
                  <option value="viewer">{t("Viewer — read only")}</option>
                  <option value="operator">
                    {t("Operator — manage broadcasts")}
                  </option>
                  <option value="admin">
                    {t("Admin — manage team and broadcasts")}
                  </option>
                </select>
              </label>
              <small>
                {t(
                  "Share credentials separately. This does not send an email invitation.",
                )}
              </small>
            </>
          )}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={close}>
              {t("Cancel")}
            </button>
            <button
              className="primary"
              disabled={busy || (kind === "playlists" && !videos.length)}
            >
              {busy ? t("Saving…") : item ? t("Save changes") : t("Create")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
