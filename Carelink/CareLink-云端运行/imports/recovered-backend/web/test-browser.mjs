import assert from "node:assert/strict";
import { DEFAULT_OSS_BASE, UNSEEN_API_URL } from "./unseen-core.mjs";

const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(playwrightModule);
const base = process.env.UNSEEN_TEST_BASE || "http://127.0.0.1:4173";
const expectedPolicy = process.env.UNSEEN_EXPECT_POLICY || "either";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
});
const errors = [];

try {
  for (const viewport of [
    { width: 320, height: 700 },
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error) => errors.push(`${viewport.width}: ${error.message}`));
    await page.goto(`${base}/web/index.html#/`, { waitUntil: "networkidle" });
    await page.locator(".hero").waitFor();
    const metrics = await page.evaluate(() => {
      const shell = document.querySelector(".app-shell").getBoundingClientRect();
      const hero = document.querySelector(".hero").getBoundingClientRect();
      const heroTitle = document.querySelector(".hero h1").getBoundingClientRect();
      const heroCopy = document.querySelector(".hero p:not(.eyebrow)").getBoundingClientRect();
      const heroBadge = document.querySelector(".hero-badge").getBoundingClientRect();
      const primary = document.querySelector(".button.primary").getBoundingClientRect();
      return {
        fontSize: getComputedStyle(document.documentElement).fontSize,
        shellWidth: shell.width,
        heroWidth: hero.width,
        heroHeight: hero.height,
        titleCopyGap: heroCopy.top - heroTitle.bottom,
        copyBadgeGap: heroBadge.top - heroCopy.bottom,
        badgeBottomSpace: hero.bottom - heroBadge.bottom,
        primaryHeight: primary.height,
        sceneColumns: getComputedStyle(document.querySelector(".scene-grid")).gridTemplateColumns.split(" ").length,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.equal(metrics.fontSize, "16px");
    assert.equal(metrics.overflow, false);
    const expectedShellWidth = viewport.width < 600 ? viewport.width : viewport.width < 960 ? Math.min(viewport.width, 760) : Math.min(viewport.width, 1120);
    assert.ok(Math.abs(metrics.shellWidth - expectedShellWidth) < 0.2, `${viewport.width}: shell width`);
    assert.ok(metrics.titleCopyGap >= 12, `${viewport.width}: title and copy overlap`);
    assert.ok(metrics.copyBadgeGap >= 13, `${viewport.width}: copy and badge overlap`);
    assert.ok(metrics.badgeBottomSpace >= 20, `${viewport.width}: badge escapes hero`);
    assert.ok(metrics.primaryHeight >= 54 && metrics.primaryHeight <= 62, `${viewport.width}: primary button height`);
    if (viewport.width === 320) assert.equal(metrics.sceneColumns, 1);
    if (viewport.width >= 375 && viewport.width < 600) assert.equal(metrics.sceneColumns, 2);
    if (viewport.width >= 600 && viewport.width < 960) assert.equal(metrics.sceneColumns, 4);
    if (viewport.width >= 960) assert.equal(metrics.sceneColumns, 2);

    for (const route of ["#/create", "#/join", "#/spaces", "#/"]) {
      await page.goto(`${base}/web/index.html${route}`, { waitUntil: "domcontentloaded" });
      await page.locator(".app-shell").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    }
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  page.on("pageerror", (error) => errors.push(`remote: ${error.message}`));
  await page.goto(`${base}/portal.html?s=s4`, { waitUntil: "networkidle" });
  await page.locator(".space-cover").waitFor({ timeout: 20000 });
  assert.match(page.url(), /\/web\/index\.html/);
  assert.match(page.url(), /s=s4/);
  assert.equal(new URL(page.url()).searchParams.get("v"), "20260802b");
  const blocked = page.locator("[data-upload-blocked]");
  const blockedCount = await blocked.count();
  if (expectedPolicy === "expired") assert.equal(blockedCount, 1);
  if (expectedPolicy === "open") assert.equal(blockedCount, 0);
  if (blockedCount) {
    assert.match(await blocked.getAttribute("data-upload-blocked"), /过期/);
    assert.match(await page.locator(".notice.error").textContent(), /过期/);
  } else {
    await page.getByRole("link", { name: "上传普通照片" }).waitFor();
    assert.match(await page.locator(".notice.success").textContent(), /可用/);
  }
  await page.close();

  const race = await browser.newPage({ viewport: { width: 390, height: 844 } });
  race.on("pageerror", (error) => errors.push(`selection-race: ${error.message}`));
  await race.addInitScript(() => {
    const original = window.createImageBitmap && window.createImageBitmap.bind(window);
    if (!original) return;
    window.createImageBitmap = (...args) => new Promise((resolve, reject) => {
      setTimeout(() => original(...args).then(resolve, reject), 800);
    });
  });
  await race.goto(`${base}/web/index.html#/create`, { waitUntil: "networkidle" });
  await race.locator('input[name="title"]').fill("异步校验竞态");
  await race.locator("#panoInput").setInputFiles(new URL("./demo-assets/pano.jpg", import.meta.url).pathname);
  assert.equal(await race.locator("#createSubmit").isDisabled(), true, "submit must lock while panorama metadata is being inspected");
  await race.locator("#panoResult img").waitFor({ timeout: 5000 });
  assert.equal(await race.locator("#createSubmit").isEnabled(), true);
  await race.close();

  const locked = await browser.newPage({ viewport: { width: 390, height: 844 } });
  locked.on("pageerror", (error) => errors.push(`upload-navigation-lock: ${error.message}`));
  await locked.addInitScript(() => {
    const original = window.createImageBitmap && window.createImageBitmap.bind(window);
    window.__holdUploadBitmap = false;
    window.__releaseUploadBitmap = null;
    if (!original) return;
    window.createImageBitmap = (...args) => {
      if (!window.__holdUploadBitmap) return original(...args);
      return new Promise((resolve, reject) => {
        window.__releaseUploadBitmap = () => original(...args).then(resolve, reject);
      });
    };
  });
  await locked.goto(`${base}/web/index.html#/create`, { waitUntil: "networkidle" });
  await locked.locator('input[name="title"]').fill("上传导航锁验收");
  await locked.locator("#createLocal").click();
  await locked.locator(".space-cover-text h1").waitFor();
  await locked.getByRole("link", { name: "上传普通照片" }).click();
  await locked.locator("#photoInput").setInputFiles(new URL("./demo-assets/ph_p2.jpg", import.meta.url).pathname);
  await locked.evaluate(() => { window.__holdUploadBitmap = true; });
  await locked.locator("#startUpload").click();
  await locked.locator(".status-pill").filter({ hasText: "处理中" }).waitFor();
  const lockedUrl = locked.url();
  const topBack = locked.getByRole("link", { name: "返回", exact: true });
  assert.equal(await topBack.getAttribute("aria-disabled"), "true");
  await topBack.evaluate((anchor) => anchor.click());
  assert.equal(locked.url(), lockedUrl, "top back changed URL during upload");
  await locked.evaluate(() => history.back());
  await locked.waitForFunction((url) => location.href === url, lockedUrl);
  assert.equal(await locked.locator(".page-heading h1").textContent(), "上传普通照片");
  await locked.evaluate(() => { location.hash = "#/spaces"; });
  await locked.waitForFunction((url) => location.href === url, lockedUrl);
  assert.equal(await locked.locator(".page-heading h1").textContent(), "上传普通照片");
  await locked.waitForFunction(() => typeof window.__releaseUploadBitmap === "function");
  await locked.evaluate(() => { window.__releaseUploadBitmap(); });
  await locked.locator(".status-pill.done").waitFor({ timeout: 15000 });
  assert.equal(await topBack.getAttribute("aria-disabled"), null);
  await locked.getByRole("link", { name: "完成并返回空间" }).click();
  await locked.locator(".space-cover-text h1").waitFor();
  assert.match(locked.url(), /#\/space\?draft=/);
  assert.equal(await locked.locator(".photo-grid img").count(), 1);
  await locked.close();

  const local = await browser.newPage({ viewport: { width: 430, height: 932 } });
  local.on("pageerror", (error) => errors.push(`local-flow: ${error.message}`));
  await local.goto(`${base}/web/index.html#/create`, { waitUntil: "networkidle" });
  await local.locator('input[name="title"]').fill("浏览器验收空间");
  await local.locator("#coverInput").setInputFiles(new URL("./demo-assets/ph_p1.jpg", import.meta.url).pathname);
  await local.locator("#panoInput").setInputFiles(new URL("./demo-assets/pano.jpg", import.meta.url).pathname);
  await local.locator("#panoResult img").waitFor();
  await local.locator("#createLocal").click();
  await local.locator(".space-cover-text h1").waitFor();
  assert.equal(await local.locator(".space-cover-text h1").textContent(), "浏览器验收空间");
  await local.getByRole("link", { name: "上传普通照片" }).click();
  await local.locator("#photoInput").setInputFiles(new URL("./demo-assets/ph_p2.jpg", import.meta.url).pathname);
  await local.locator("#startUpload").click();
  await local.locator(".status-pill.done").waitFor({ timeout: 15000 });
  await local.getByRole("link", { name: "完成并返回空间" }).click();
  await local.locator(".photo-grid img").waitFor();
  assert.equal(await local.locator(".photo-grid img").count(), 1);
  await local.getByRole("link", { name: "查看 2D 全景" }).click();
  await local.locator("#panoImage").waitFor();
  assert.match(await local.locator(".pano-help").textContent(), /默认 2D/);
  await local.close();

  const cloud = await browser.newPage({ viewport: { width: 430, height: 932 } });
  cloud.on("pageerror", (error) => errors.push(`mock-cloud-flow: ${error.message}`));
  await cloud.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { window.__sharedUrl = value; } },
    });
  });
  const cloudSid = `u${"1".repeat(24)}`;
  const hostKey = "h_creator-secret-never-share";
  const manifestUrl = `${DEFAULT_OSS_BASE}/spaces/${cloudSid}/space.json`;
  const apiBodies = [];
  const apiHeaders = [];
  const actionAttempts = new Map();
  const ossPosts = [];
  const exactPolicy = (key, maxSize) => ({
    host: DEFAULT_OSS_BASE,
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    maxSize,
    fields: {
      key,
      policy: `policy-${key}`,
      OSSAccessKeyId: "mock-access-key",
      Signature: `signature-${key}`,
      "x-oss-object-acl": "private",
      success_action_status: "200",
    },
  });
  let cloudManifest = {
    schema: "psm-space/1",
    id: cloudSid,
    title: "云端验收空间",
    date: "2026-08-02",
    place: "Brisbane",
    subtitle: "mock cloud",
    cover: "",
    collection: { status: "open" },
    capacity: { maxPhotos: 90, received: 0, remaining: 90, full: false },
    nodes: [{ id: "n1", panorama: null, panoMini: null }],
    photos: [],
    pending: [],
    upload: { enabled: true, mode: "ticket-v1", endpoint: UNSEEN_API_URL, maxSize: 20 * 1024 * 1024 },
  };
  await cloud.route(`${UNSEEN_API_URL}**`, async (route) => {
    const body = route.request().postDataJSON();
    apiBodies.push(body);
    apiHeaders.push(route.request().headers());
    const attempt = (actionAttempts.get(body.action) || 0) + 1;
    actionAttempts.set(body.action, attempt);
    if (["createSpace", "photoTicket", "commitPhoto"].includes(body.action) && attempt === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RETRY_ME", message: "云端短暂繁忙" } }) });
      return;
    }
    let data;
    if (body.action === "createSpace") {
      data = {
        spaceId: cloudSid,
        hostKey,
        status: "draft",
        manifestUrl,
        uploads: {
          cover: exactPolicy(`unseen-backend/v1/staging/${cloudSid}/cover.bin`, 20 * 1024 * 1024),
          panorama: exactPolicy(`unseen-backend/v1/staging/${cloudSid}/panorama.bin`, 50 * 1024 * 1024),
        },
      };
    } else if (body.action === "finalizeSpace") {
      data = { spaceId: cloudSid, status: "published", manifestUrl, manifest: cloudManifest };
    } else if (body.action === "photoTicket") {
      data = {
        spaceId: cloudSid,
        clientUploadId: body.clientUploadId,
        photoId: `p_${"2".repeat(24)}`,
        committed: false,
        upload: exactPolicy(`unseen-backend/v1/uploads/${cloudSid}/p_${"2".repeat(24)}.bin`, 20 * 1024 * 1024),
        commitToken: "mock-commit-token",
      };
    } else if (body.action === "commitPhoto") {
      const photo = {
        id: `p_${"2".repeat(24)}`,
        src: `${DEFAULT_OSS_BASE}/spaces/${cloudSid}/photos/mock.jpg`,
        thumb: `${DEFAULT_OSS_BASE}/spaces/${cloudSid}/photos/mock.jpg`,
        contributor: "匿名参与者",
        createdAt: new Date().toISOString(),
      };
      cloudManifest = {
        ...cloudManifest,
        photos: [photo],
        capacity: { maxPhotos: 90, received: 1, remaining: 89, full: false },
      };
      data = { spaceId: cloudSid, photo, manifestUrl, idempotent: false };
    } else {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "UNKNOWN_ACTION", message: "未知操作" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });
  await cloud.route(`${DEFAULT_OSS_BASE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      ossPosts.push(request.postData() || "");
      await route.fulfill({ status: 200, body: "" });
      return;
    }
    if (url.pathname === `/spaces/${cloudSid}/space.json`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cloudManifest) });
      return;
    }
    if (url.pathname.endsWith("/photos/mock.jpg")) {
      await route.fulfill({ status: 200, contentType: "image/jpeg", path: new URL("./demo-assets/ph_p2.jpg", import.meta.url).pathname });
      return;
    }
    await route.fulfill({ status: 404, body: "" });
  });
  await cloud.goto(`${base}/web/index.html#/create`, { waitUntil: "networkidle" });
  await cloud.locator('input[name="title"]').fill("云端验收空间");
  await cloud.locator('input[name="date"]').fill("2026-08-02");
  await cloud.locator('input[name="place"]').fill("Brisbane");
  await cloud.locator('input[name="subtitle"]').fill("mock cloud");
  await cloud.locator("#coverInput").setInputFiles(new URL("./demo-assets/ph_p1.jpg", import.meta.url).pathname);
  await cloud.locator("#panoInput").setInputFiles(new URL("./demo-assets/pano.jpg", import.meta.url).pathname);
  await cloud.locator("#panoResult img").waitFor();
  await cloud.locator("#createSubmit").click();
  await cloud.locator(".space-cover-text h1").waitFor({ timeout: 20000 });
  assert.match(cloud.url(), new RegExp(`#\\/space\\?s=${cloudSid}$`));
  assert.equal(cloud.url().includes(hostKey), false);
  const createBodies = apiBodies.filter((body) => body.action === "createSpace");
  assert.equal(createBodies.length, 2, "createSpace should retry one transient failure");
  assert.equal(createBodies[0].clientCreateId, createBodies[1].clientCreateId);
  assert.match(createBodies[0].clientCreateId, /^[A-Za-z0-9._:-]{16,128}$/);
  assert.deepEqual(createBodies[1].media, { cover: true, panorama: true });
  const finalizeIndex = apiBodies.findIndex((body) => body.action === "finalizeSpace");
  assert.equal(apiHeaders[finalizeIndex]["x-unseen-host-key"], hostKey);
  assert.equal(ossPosts.length, 2);
  assert.match(ossPosts[0], new RegExp(`unseen-backend/v1/staging/${cloudSid}/cover\\.bin`));
  assert.match(ossPosts[1], new RegExp(`unseen-backend/v1/staging/${cloudSid}/panorama\\.bin`));
  assert.ok(ossPosts.every((body) => body.includes('name="success_action_status"') && body.includes("200")));
  assert.equal((await cloud.locator("body").textContent()).includes(hostKey), false);
  await cloud.locator("#shareSpace").click();
  const sharedUrl = await cloud.evaluate(() => window.__sharedUrl);
  const shared = new URL(sharedUrl);
  assert.deepEqual([...shared.searchParams.keys()], ["s"]);
  assert.equal(shared.searchParams.get("s"), cloudSid);
  assert.equal(sharedUrl.includes(hostKey), false);

  await cloud.getByRole("link", { name: "上传普通照片" }).click();
  await cloud.locator("#photoInput").setInputFiles(new URL("./demo-assets/ph_p2.jpg", import.meta.url).pathname);
  await cloud.locator("#startUpload").click();
  await cloud.locator(".status-pill.done").waitFor({ timeout: 20000 });
  const ticketBodies = apiBodies.filter((body) => body.action === "photoTicket");
  assert.equal(ticketBodies.length, 2);
  assert.equal(ticketBodies[0].clientUploadId, ticketBodies[1].clientUploadId);
  const commitBodies = apiBodies.filter((body) => body.action === "commitPhoto");
  assert.equal(commitBodies.length, 2);
  assert.equal(commitBodies[0].commitToken, commitBodies[1].commitToken);
  assert.equal(ossPosts.length, 3);
  await cloud.getByRole("link", { name: "完成并返回空间" }).click();
  await cloud.locator(".photo-grid img").waitFor();
  await cloud.goto(`${base}/web/index.html#/spaces`, { waitUntil: "networkidle" });
  await cloud.getByText("云端验收空间", { exact: true }).waitFor();
  assert.match(await cloud.locator("body").textContent(), /共享空间.*创建者/s);
  await cloud.reload({ waitUntil: "networkidle" });
  await cloud.getByText("云端验收空间", { exact: true }).click();
  await cloud.locator(".space-cover-text h1").waitFor();
  assert.equal(cloud.url().includes(hostKey), false);
  await cloud.close();

  const cloudFailure = await browser.newPage({ viewport: { width: 390, height: 844 } });
  cloudFailure.on("pageerror", (error) => errors.push(`mock-cloud-failure: ${error.message}`));
  const failedCreateIds = [];
  await cloudFailure.route(`${UNSEEN_API_URL}**`, async (route) => {
    const body = route.request().postDataJSON();
    failedCreateIds.push(body.clientCreateId);
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "BACKEND_DOWN", message: "云端维护中，请稍后重试" } }) });
  });
  await cloudFailure.goto(`${base}/web/index.html#/create`, { waitUntil: "networkidle" });
  await cloudFailure.locator('input[name="title"]').fill("绝不能静默本机");
  await cloudFailure.locator("#createSubmit").click();
  await cloudFailure.locator("#createStatus.error").waitFor({ timeout: 10000 });
  assert.match(await cloudFailure.locator("#createStatus").textContent(), /云端维护中/);
  assert.match(cloudFailure.url(), /#\/create$/);
  assert.equal(failedCreateIds.length, 2);
  assert.equal(failedCreateIds[0], failedCreateIds[1]);
  await cloudFailure.goto(`${base}/web/index.html#/spaces`, { waitUntil: "networkidle" });
  assert.equal((await cloudFailure.locator("body").textContent()).includes("绝不能静默本机"), false);
  await cloudFailure.close();

  assert.deepEqual(errors, []);
  console.log("✓ 320 / 375 / 390 / 430 / 768 / 1024 / 1440 layouts have ordered type, non-overlapping hero copy, stable buttons, and no horizontal overflow");
  console.log("✓ home / create / join / spaces routes mount across all viewports");
  console.log("✓ portal preserves ?s=s4 and redirects to the upload-first entry");
  console.log("✓ production upload policy resolves to one explicit state without spinning");
  console.log("✓ panorama metadata inspection locks submit and cannot silently drop a selected file");
  console.log("✓ upload lock blocks top back, browser back, and direct hash changes without stranding the DOM");
  console.log("✓ local draft creates with a validated 2:1 panorama, stores an ordinary photo, and opens the 2D viewer");
  console.log("✓ mocked managed cloud flow creates, uploads exact media, finalizes, tickets, commits, shares safely, and reopens from history");
  console.log("✓ managed cloud failure retries the same idempotency key and never falls back to a local draft");
  console.log("\n9/9 browser checks passed");
} finally {
  await browser.close();
}
