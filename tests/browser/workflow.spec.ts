import { test, expect } from "@playwright/test";
import { createPngFixture, fixture } from "../helpers.ts";
import { run } from "../../server/media.ts";
import { join } from "node:path";

let f: Awaited<ReturnType<typeof fixture>>;
let address: string;
test.beforeAll(async () => {
  f = await fixture({
    destinationProbe: async () => ({ transport: "tcp" }),
    webhookRequest: async () => 204,
  });
  address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  f.config.APP_ORIGIN = address;
});
test.afterAll(async () => {
  await f.cleanup();
});

test("browser login, upload, playlist, destination, stream and schedule workflow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      errors.push(message.text());
  });
  await page.goto(address);
  await page.getByLabel("Email address").fill(f.config.ADMIN_EMAIL);
  await page
    .getByLabel("Password", { exact: true })
    .fill(f.config.ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in →" }).click();
  await expect(
    page.getByRole("heading", { name: "Everything in flow." }),
  ).toBeVisible();
  await page.goto(`${address}/api/docs/`);
  const swaggerSpecStatus = await page.evaluate(
    async () => (await fetch("/api/docs/json")).status,
  );
  expect(swaggerSpecStatus).toBe(200);
  const docsTitle = await page.locator(".info .title").textContent();
  expect(docsTitle).toContain("StreaMax API");
  await expect(page.locator(".info .title")).toContainText("StreaMax API");
  await expect(page.locator(".opblock").first()).toBeVisible();
  await page.goto(address);
  await expect(
    page.getByRole("heading", { name: "Everything in flow." }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("dashboard-desktop.png"),
    fullPage: true,
  });

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Video library" })
    .click();
  const videoFile = join(f.directory, "browser-test.mp4");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    videoFile,
  ]);
  await page.locator("input[type=file]").setInputFiles(videoFile);
  await expect(
    page.getByRole("heading", { name: "browser-test.mp4" }),
  ).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Preview browser-test.mp4" }).click();
  await expect(page.locator("video")).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Playlists", exact: true })
    .click();
  await page.getByRole("button", { name: "Create playlist" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Evening rotation");
  await page
    .getByLabel("Add videos")
    .selectOption({ label: "browser-test.mp4" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Evening rotation" }),
  ).toBeVisible();

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Destinations", exact: true })
    .click();
  await page.getByRole("button", { name: "Create destination" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Studio output");
  await page.getByLabel("Platform", { exact: true }).selectOption("Custom");
  await page.getByLabel("Ingest server URL").fill("rtmp://127.0.0.1:1/live");
  await page
    .getByLabel("Stream key", { exact: true })
    .fill("browser-private-key");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Studio output" }),
  ).toBeVisible();
  expect(await page.content()).not.toContain("browser-private-key");
  const destinationRow = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Studio output" }) });
  await destinationRow.getByRole("button", { name: "Test connection" }).click();
  await expect(
    page.getByText(
      "Endpoint reachable; the stream key and platform ingest are not verified.",
    ),
  ).toBeVisible();
  await destinationRow
    .getByRole("button", { name: "Disable destination" })
    .click();
  await expect(
    destinationRow.getByText("disabled", { exact: true }),
  ).toBeVisible();
  await destinationRow
    .getByRole("button", { name: "Enable destination" })
    .click();
  await expect(
    destinationRow.getByText("enabled", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Live streams" })
    .click();
  await page.getByRole("button", { name: "Create stream" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Evening broadcast");
  await page
    .getByLabel("Playlist", { exact: true })
    .selectOption({ label: "Evening rotation" });
  await page
    .getByLabel("Encoding profile", { exact: true })
    .selectOption({ label: "720p · Balanced" });
  await page
    .getByLabel("Playback mode")
    .selectOption({ label: "Play a fixed number of times" });
  await page.getByLabel("Total plays").fill("3");
  await page.getByLabel("Studio output").check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Evening broadcast" }),
  ).toBeVisible();
  expect(
    f.store
      .list("streams")
      .find((stream) => stream.name === "Evening broadcast")?.playCount,
  ).toBe(3);
  await expect(page.getByText("offline", { exact: true })).toBeVisible();
  const createdStream = f.store
    .list("streams")
    .find((stream) => stream.name === "Evening broadcast")!;
  // The closed test ingest may retry, but mode must still reflect real file inspection.
  f.engine.start(createdStream.id);
  await expect(
    page.locator(".stream-row").filter({ hasText: "Evening broadcast" }),
  ).toContainText("COPY");
  await f.engine.stop(createdStream.id);

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Schedules", exact: true })
    .click();
  await page.getByRole("button", { name: "Create schedule" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Tomorrow evening");
  await page
    .getByLabel("Stream", { exact: true })
    .selectOption({ label: "Evening broadcast" });
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await page.getByLabel("Start time").fill(`${future}T18:00`);
  await page.getByLabel("End time").fill(`${future}T19:00`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Tomorrow evening" }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await page.screenshot({
    path: test.info().outputPath("dashboard-configured.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Backup & recovery" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Backup archives" }),
  ).toBeVisible();
  await expect(page.getByText("Backup directory is not mounted")).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByLabel("Application name").fill("Browser Studio");
  await page.getByLabel("Default video bitrate (kbps)").fill("3600");
  await page.getByLabel("Retry attempts per destination").fill("3");
  await page.getByLabel("Workspace timezone (IANA)").fill("Asia/Jakarta");
  await page.getByLabel("Workspace logo PNG").setInputFiles({
    name: "workspace.png",
    mimeType: "image/png",
    buffer: createPngFixture(),
  });
  await expect(page.locator(".logo-preview")).toBeVisible();
  await page.getByRole("button", { name: "Save system settings" }).click();
  await expect(page.getByText("System settings saved")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Browser Studio/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Notifications" }),
  ).toBeVisible();
  await page.getByLabel("Notification provider").selectOption("telegram");
  await page.getByLabel("Telegram chat ID").fill("123456789");
  const botToken = "777777:abcdefghijklmnopqrstuvwxyz123456";
  await page.getByLabel("Telegram bot token").fill(botToken);
  const notificationsPanel = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "Notifications", exact: true }),
  });
  await notificationsPanel
    .getByLabel("Stream started", { exact: true })
    .check();
  await page.getByLabel("Enable notifications", { exact: true }).check();
  await notificationsPanel
    .getByRole("button", { name: "Save settings" })
    .click();
  await expect(page.getByText("Notification settings saved")).toBeVisible();
  expect(await page.content()).not.toContain(botToken);
  await page.getByRole("button", { name: "Send test notification" }).click();
  await expect(page.getByText("Test notification delivered")).toBeVisible();
  expect(f.notificationCalls).toHaveLength(1);
  const webhookPanel = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "Signed webhooks", exact: true }),
  });
  await webhookPanel
    .getByLabel("HTTPS receiver URL")
    .fill("https://hooks.example.com/events");
  await webhookPanel
    .getByLabel("HMAC signing secret")
    .fill("browser-webhook-secret-long-enough");
  await webhookPanel.getByLabel("Stream started", { exact: true }).check();
  await webhookPanel.getByLabel("Enable signed webhooks").check();
  await webhookPanel.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Webhook settings saved")).toBeVisible();
  await expect(webhookPanel.getByLabel("HMAC signing secret")).toHaveValue("");
  await webhookPanel.getByRole("button", { name: "Send test webhook" }).click();
  await expect(page.getByText("Test webhook delivered")).toBeVisible();
  expect(f.notificationCalls[0].url).toBe(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Activity log" })
    .click();
  await page.getByLabel("Action contains").fill("system.settings_updated");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("system · settings updated")).toBeVisible();
  const auditDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export CSV" }).click();
  expect((await auditDownload).suggestedFilename()).toBe("streamax-audit.csv");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings" })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to your studio" }),
  ).toBeVisible();
  await expect(page.getByAltText("Browser Studio logo")).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile dashboard stays within viewport and navigation remains usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(address);
  await page.getByLabel("Email address").fill(f.config.ADMIN_EMAIL);
  await page
    .getByLabel("Password", { exact: true })
    .fill(f.config.ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in →" }).click();
  await expect(
    page.getByRole("heading", { name: "Everything in flow." }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: test.info().outputPath("dashboard-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Schedules", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Schedules", exact: true }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 768, height: 1024 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(768);
  await page.screenshot({
    path: test.info().outputPath("dashboard-tablet.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings" })
    .click();
  const theme = page.getByLabel("Theme");
  await page.emulateMedia({ colorScheme: "light" });
  await theme.selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() => localStorage.getItem("streamax.theme")),
  ).toBe("light");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Everything in flow." }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings" })
    .click();
  await expect(page.getByLabel("Theme")).toHaveValue("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const language = page.getByLabel("Language");
  await language.selectOption("id");
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Ringkasan", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Semua siaran terkendali." }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Semua siaran terkendali." }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Pengaturan", exact: true })
    .click();
  await expect(page.getByLabel("Bahasa")).toHaveValue("id");
  await expect(page.getByRole("heading", { name: "Notifikasi" })).toBeVisible();
  await expect(page.getByLabel("Penyedia notifikasi")).toBeVisible();
  await expect(page.getByLabel("Nama aplikasi")).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Analitik", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Performa streaming" }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Log aktivitas", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Log aktivitas", level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Siaran langsung", exact: true })
    .click();
  await page.getByRole("button", { name: /Buat siaran/ }).click();
  const streamDialog = page.getByRole("dialog");
  await expect(
    streamDialog.getByRole("heading", { name: "Buat siaran" }),
  ).toBeVisible();
  await expect(streamDialog.getByLabel("Nama")).toBeVisible();
  await expect(
    streamDialog.getByLabel("Daftar putar", { exact: true }),
  ).toBeVisible();
  await streamDialog.getByRole("button", { name: "Tutup dialog" }).click();
});
