import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OssV1Adapter } = require("../backend/lib/oss-v1.js");
const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(playwrightModule);

const base = process.env.UNSEEN_TEST_BASE ||
  "https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com";
const api = "https://unseen-d3gtp0sxh53bbef61-1316841054.ap-shanghai.app.tcloudbase.com/unseen-api";
const panoramaPath = new URL("./demo-assets/pano.jpg", import.meta.url).pathname;
const photoPath = new URL("./demo-assets/ph_p1.jpg", import.meta.url).pathname;
const credential = JSON.parse(fs.readFileSync("/Users/max/.config/psm/aliyun.json", "utf8"));
const endpoint = `oss-${String(credential.region).replace(/^oss-/, "")}.aliyuncs.com`;
const oss = new OssV1Adapter({
  bucket: credential.bucket,
  endpoint,
  accessKeyId: credential.accessKeyId,
  accessKeySecret: credential.accessKeySecret,
});

async function cleanup(sid) {
  const prefixes = [
    `spaces/${sid}/`,
    `unseen-backend/v1/spaces/${sid}/`,
    `unseen-backend/v1/staging/${sid}/`,
    `unseen-backend/v1/tickets/${sid}/`,
    `unseen-backend/v1/uploads/${sid}/`,
    `unseen-backend/v1/slots/${sid}/`,
    `unseen-backend/v1/commits/${sid}/`,
  ];
  let removed = 0;
  for (const prefix of prefixes) {
    let marker = "";
    do {
      const listed = await oss.list(prefix, { marker, maxKeys: 100 });
      for (const item of listed.objects) {
        await oss.delete(item.key);
        removed += 1;
      }
      marker = listed.truncated ? listed.nextMarker : "";
    } while (marker);
  }
  return removed;
}

async function runIteration(browser, iteration, withPanorama) {
  const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { window.__unseenSharedUrl = value; } },
    });
  });
  const page = await context.newPage();
  const errors = [];
  let sid = "";
  let removed = 0;
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("response", async (response) => {
    if (response.url() !== api || response.request().method() !== "POST") return;
    try {
      const request = response.request().postDataJSON();
      if (request.action !== "createSpace") return;
      const payload = await response.json();
      if (payload?.ok && /^u[a-f0-9]{24}$/.test(payload.data?.spaceId || "")) sid = payload.data.spaceId;
    } catch {}
  });
  try {
    await page.goto(`${base}/web/index.html#/create`, { waitUntil: "networkidle" });
    await page.locator('input[name="title"]').fill(`UNSEEN 浏览器线上回归 ${iteration}`);
    await page.locator('input[name="place"]').fill("Browser E2E");
    if (withPanorama) {
      await page.locator("#panoInput").setInputFiles(panoramaPath);
      await page.locator("#panoResult img").waitFor();
    }
    await page.locator("#createSubmit").click();
    try {
      await page.locator(".space-cover-text h1").waitFor({ timeout: 150_000 });
    } catch (error) {
      const status = await page.locator("#createStatus").textContent().catch(() => "");
      throw new Error(`云端创建 UI 未完成：${status || error.message}`);
    }
    assert.match(page.url(), /#\/space\?s=u[a-f0-9]{24}/);
    const urlSid = new URL(page.url()).hash.match(/[?&]s=(u[a-f0-9]{24})/)?.[1] || "";
    assert.ok(urlSid);
    sid ||= urlSid;
    assert.equal(urlSid, sid);
    assert.equal(page.url().includes("hostKey"), false);
    if (withPanorama) await page.getByRole("link", { name: "查看 2D 全景" }).waitFor();

    await page.getByRole("link", { name: "上传普通照片" }).click();
    await page.locator("#photoInput").setInputFiles(photoPath);
    await page.locator("#startUpload").click();
    try {
      await page.locator(".status-pill.done").waitFor({ timeout: 150_000 });
    } catch (error) {
      const detail = await page.locator(".queue-error").allTextContents().catch(() => []);
      throw new Error(`普通照片 UI 上传未完成：${detail.join(" | ") || error.message}`);
    }
    await page.getByRole("link", { name: "完成并返回空间" }).click();
    await page.locator(".photo-grid img").waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(".photo-grid img").count(), 1);

    await page.locator("#shareSpace").click();
    const shared = await page.evaluate(() => window.__unseenSharedUrl || "");
    assert.ok(shared);
    const sharedUrl = new URL(shared);
    assert.equal(sharedUrl.searchParams.get("s"), sid);
    assert.equal(sharedUrl.searchParams.size, 1);
    assert.equal(shared.includes("hostKey"), false);

    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const guest = await guestContext.newPage();
    const guestErrors = [];
    guest.on("pageerror", (error) => guestErrors.push(error.message));
    await guest.goto(shared, { waitUntil: "networkidle" });
    await guest.locator(".space-cover-text h1").waitFor({ timeout: 30_000 });
    assert.equal(await guest.locator(".photo-grid img").count(), 1);
    if (withPanorama) await guest.getByRole("link", { name: "查看 2D 全景" }).waitFor();
    assert.deepEqual(guestErrors, []);
    await guestContext.close();

    const manifest = await fetch(`https://${credential.bucket}.${endpoint}/spaces/${sid}/space.json?e2e=${Date.now()}`)
      .then((response) => response.json());
    assert.equal(manifest.id, sid);
    assert.equal(manifest.photos.length, 1);
    assert.equal(Boolean(manifest.nodes[0].panorama), withPanorama);
    assert.equal(manifest.upload.mode, "ticket-v1");
    assert.deepEqual(errors, []);
    return { iteration, withPanorama, checks: 12, sid };
  } finally {
    await context.close();
    if (sid) removed = await cleanup(sid);
    if (sid) {
      let remaining = 0;
      for (const prefix of [`spaces/${sid}/`, `unseen-backend/v1/spaces/${sid}/`]) {
        remaining += (await oss.list(prefix, { maxKeys: 10 })).objects.length;
      }
      assert.equal(remaining, 0);
    }
    if (sid) process.stdout.write(`${JSON.stringify({ cleanup: true, sid, removedObjects: removed })}\n`);
  }
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
});
try {
  const results = [];
  results.push(await runIteration(browser, 1, true));
  results.push(await runIteration(browser, 2, false));
  process.stdout.write(`${JSON.stringify({ ok: true, iterations: results })}\n`);
} finally {
  await browser.close();
}
