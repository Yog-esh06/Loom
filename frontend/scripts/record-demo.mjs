import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "../..");
const assetsDir = resolve(projectRoot, "docs/assets");
const videoDir = resolve(projectRoot, ".loom/recording");
const screenshotPath = resolve(assetsDir, "workspace-preview.png");
const approvalScreenshotPath = resolve(assetsDir, "agent-approval.png");
const videoPath = resolve(assetsDir, "loom-demo.webm");
const webUrl = process.env.LOOM_WEB_URL ?? "http://127.0.0.1:5173";

await mkdir(assetsDir, { recursive: true });
await rm(videoDir, { recursive: true, force: true });
await mkdir(videoDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } },
});
const page = await context.newPage();

try {
  await page.goto(webUrl, { waitUntil: "networkidle" });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await page.getByLabel("Your name").fill("LOOM Demo");
  await page.getByLabel("Work email").fill(`loom-demo-${suffix}@example.test`);
  await page.getByLabel("Password").fill(`Demo-password-${suffix}`);
  await page.getByRole("button", { name: /Create your account/ }).click();
  await page.getByRole("heading", { name: "Start with a shared space." }).waitFor();

  await page.getByRole("button", { name: /Create a workspace/ }).click();
  await page.getByLabel("Name").fill("Fieldwork Studio");
  await page.getByRole("dialog").getByRole("button", { name: /^Create/ }).click();
  await page.getByRole("heading", { name: "Fieldwork Studio" }).waitFor();

  await page.getByRole("button", { name: /New project/ }).click();
  await page.getByLabel("Name").fill("Spring release");
  await page.getByRole("dialog").getByRole("button", { name: /^Create/ }).click();
  await page.getByRole("heading", { name: "Spring release" }).waitFor();

  await page.getByRole("button", { name: /New document/ }).click();
  await page.getByLabel("Document title").fill("Release planning");
  await page.getByRole("dialog").getByRole("button", { name: /^Create/ }).click();
  const editor = page.locator("textarea.document-input");
  await editor.waitFor();
  await editor.fill("Release planning\n\nAction: prepare release notes\nFollow-up: schedule a review");
  await page.waitForTimeout(900);

  await page.getByRole("button", { name: /Ask agents/ }).click();
  await page.getByLabel("What would you like a hand with?").fill("Extract tasks from these meeting notes");
  await page.getByRole("button", { name: /Plan a run/ }).click();
  await page.getByText("Action: prepare release notes", { exact: true }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: approvalScreenshotPath, fullPage: true });

  await page.getByRole("button", { name: /Approve tasks/ }).click();
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await page.getByRole("heading", { name: "Action: prepare release notes" }).waitFor();
  await page.waitForTimeout(700);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.waitForTimeout(1200);
} finally {
  await context.close();
  await browser.close();
}

const recordings = await readdir(videoDir);
if (recordings.length === 0) {
  throw new Error("Playwright did not produce a browser video recording.");
}
await rename(resolve(videoDir, recordings[0]), videoPath);
await rm(videoDir, { recursive: true, force: true });

console.log(`Saved verified screenshots:\n- ${screenshotPath}\n- ${approvalScreenshotPath}`);
console.log(`Saved browser-recorded demo video:\n- ${videoPath}`);
