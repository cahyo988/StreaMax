import { test, expect } from "@playwright/test";
import { fixture } from "../helpers.ts";
import { normalize, run } from "../../server/media.ts";
import { join } from "node:path";

test("library distinguishes queued processing from resumable upload and accepts another video", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    mediaNormalizer: async (...args) => {
      args[5]?.(37);
      await gate;
      return normalize(...args);
    },
  });
  try {
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    f.config.APP_ORIGIN = address;
    await page.goto(address);
    await page.getByLabel("Email address").fill(f.config.ADMIN_EMAIL);
    await page
      .getByLabel("Password", { exact: true })
      .fill(f.config.ADMIN_PASSWORD);
    await page.getByRole("button", { name: /Sign in/ }).click();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Video library" })
      .click();
    const first = join(f.directory, "first.mp4");
    const second = join(f.directory, "second.mp4");
    for (const path of [first, second]) {
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-t",
        path === first ? "1" : "2",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        path,
      ]);
    }
    await page.locator("input[type=file]").setInputFiles(first);
    const firstCard = page
      .locator(".media-card")
      .filter({ hasText: "first.mp4" });
    await expect(firstCard.locator(".badge")).toHaveText("processing 37%");
    await expect(
      page.getByRole("button", { name: /Upload video/ }),
    ).toBeEnabled();
    await expect(page.getByRole("button", { name: /Resume/ })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Preview first.mp4" }),
    ).toBeDisabled();
    await page.locator("input[type=file]").setInputFiles(second);
    const secondCard = page
      .locator(".media-card")
      .filter({ hasText: "second.mp4" });
    await expect(secondCard.locator(".badge")).toHaveText("queued");
    await expect(page.getByRole("button", { name: /Resume/ })).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain(
      "Another video is being processed",
    );
    expect((await f.request("GET", "uploads")).json()).toEqual([]);
    release();
    await expect(firstCard.locator(".badge")).toHaveText("ready", {
      timeout: 20000,
    });
    await expect(secondCard.locator(".badge")).toHaveText("ready", {
      timeout: 20000,
    });
    await expect(
      page.getByRole("button", { name: "Preview second.mp4" }),
    ).toBeEnabled();
  } finally {
    release();
    await f.cleanup();
  }
});
