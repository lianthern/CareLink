import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { projectLocalFixtureSceneContext } from "../../infra/integration/local-locator-fixture.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromePath = process.env.UNSEEN_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const stageTimeout = 20_000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const nullPitchSource = { placement: { pitchDeg: null } };
invariant(projectLocalFixtureSceneContext(nullPitchSource).placement.pitchDeg === 0 &&
  nullPitchSource.placement.pitchDeg === null &&
  projectLocalFixtureSceneContext({ placement: { pitchDeg: 12.5 } }).placement.pitchDeg === 12.5,
"local_fixture_pitch_projection");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function invariant(condition, message) {
  if (!condition) throw new Error(`stage_l_e2e_failed:${message}`);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function publicReference(value) {
  return sha256(String(value)).slice(0, 16);
}

function routeOnly(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.split("/").map((part) =>
      /^(?:[a-z]+_)?[A-Za-z0-9_-]{16,}$/.test(part) ? ":id" : part).join("/")}`;
  } catch { return "unparseable"; }
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, stageTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  once(method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((item) => item !== listener));
        resolve(params);
      };
      this.on(method, listener);
    });
  }

  close() { this.socket.close(); }
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(run, label, timeout = stageTimeout) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await run();
    if (last) return last;
    await delay(75);
  }
  throw new Error(`stage_l_e2e_timeout:${label}:${JSON.stringify(last)}`);
}

async function evaluate(page, expression) {
  const result = await page.cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function go(page, pathname) {
  const loaded = page.cdp.once("Page.loadEventFired");
  await page.cdp.send("Page.navigate", { url: `${baseUrl}${pathname}` });
  await Promise.race([loaded, delay(stageTimeout).then(() => { throw new Error(`page_load_timeout:${pathname}`); })]);
  await poll(() => evaluate(page, "document.readyState==='complete'&&Boolean(document.querySelector('#main'))"),
    `app ready ${pathname}`);
}

async function waitApp(page) {
  await poll(() => evaluate(page, "Boolean(document.querySelector('#main'))&&!document.querySelector('[data-phase=loading]')"),
    "application render");
}

async function waitText(page, text) {
  await poll(() => evaluate(page, `document.body.innerText.includes(${JSON.stringify(text)})`), `text ${text}`);
}

async function click(page, selector) {
  const clicked = await evaluate(page, `(()=>{const element=document.querySelector(${JSON.stringify(selector)});
    if(!element||element.disabled)return false;element.focus();element.click();return true})()`);
  invariant(clicked, `click_missing:${selector}`);
}

async function screenshot(page, filename) {
  const result = await page.cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  await writeFile(path.join(screenshotRoot, filename), Buffer.from(result.data, "base64"));
  trace.screenshots.push(`screenshots/${filename}`);
}

async function browserRequest(page, method, pathname, body = undefined, headers = {}) {
  const request = { method, pathname, body, headers };
  const result = await evaluate(page, `(async()=>{
    const request=${JSON.stringify(request)};
    const mutation=!['GET','HEAD'].includes(request.method);
    const response=await fetch(request.pathname,{
      method:request.method,
      credentials:'include',
      cache:'no-store',
      headers:{Accept:'application/json',...(mutation?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{}),...request.headers},
      body:mutation?JSON.stringify(request.body??{}):undefined
    });
    const value=await response.json().catch(()=>({}));
    return {status:response.status,ok:response.ok,value,etag:response.headers.get('etag')};
  })()`);
  if (!result.ok) throw new Error(`request_failed:${method}:${pathname}:${result.status}:${JSON.stringify(result.value)}`);
  return result.value;
}

async function uploadLocalAsset(page, ticket, assetPath) {
  const result = await evaluate(page, `(async()=>{
    const ticket=${JSON.stringify(ticket)};
    const source=await fetch(${JSON.stringify(assetPath)},{cache:'no-store'});
    if(!source.ok)return {ok:false,status:source.status,phase:'source'};
    const response=await fetch(ticket.url,{method:'PUT',credentials:'omit',headers:ticket.headers,body:await source.blob()});
    return {ok:response.ok,status:response.status,value:await response.json().catch(()=>({}))};
  })()`);
  invariant(result.ok, `asset_upload:${assetPath}:${result.status}:${JSON.stringify(result.value)}`);
  return result.value;
}

async function verifyBrowserMedia(page, descriptor) {
  return evaluate(page, `(async()=>{
    const descriptor=${JSON.stringify(descriptor)};
    const response=await fetch(descriptor.url,{credentials:'include',cache:'no-store'});
    const bytes=await response.arrayBuffer();
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
      .map((value)=>value.toString(16).padStart(2,'0')).join('');
    return {status:response.status,etag:response.headers.get('etag'),bytes:bytes.byteLength,digest};
  })()`);
}

async function waitOtp(challengeId) {
  return poll(async () => {
    try {
      const value = JSON.parse(await readFile(otpMailboxPath, "utf8"));
      return value.challengeId === challengeId && /^\d{6}$/.test(value.code) ? value.code : null;
    } catch { return null; }
  }, "OTP mailbox");
}

async function createPage(browser, debugPort, browserContextId, label) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
  const target = await poll(async () => {
    const values = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return values.find((item) => item.id === targetId);
  }, `target ${label}`);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Log.enable"),
    cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1280,
      screenHeight: 900
    })
  ]);
  const page = { cdp, targetId, browserContextId, label, requests: new Map() };
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (["error", "assert"].includes(params.type)) diagnostics.consoleErrors.push({ role: label,
      text: params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 500) });
  });
  cdp.on("Runtime.exceptionThrown", (params) => diagnostics.exceptions.push({ role: label,
    text: (params.exceptionDetails.exception?.description ?? params.exceptionDetails.text).slice(0, 500) }));
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => page.requests.set(requestId, request.url));
  cdp.on("Network.responseReceived", ({ response }) => {
    const url = new URL(response.url);
    const networkOrigin = url.protocol === "blob:" ? new URL(url.pathname).origin : url.origin;
    if (networkOrigin !== baseUrl) diagnostics.externalRequests.push({ role: label, url: routeOnly(response.url) });
    if (response.status >= 400) diagnostics.httpErrors.push({ role: label, status: response.status,
      url: routeOnly(response.url) });
  });
  cdp.on("Network.loadingFailed", (params) => {
    if (!params.canceled && params.errorText !== "net::ERR_ABORTED") diagnostics.failedRequests.push({ role: label,
      errorText: params.errorText, url: routeOnly(page.requests.get(params.requestId) ?? "") });
  });
  return page;
}

async function approvePhoto(ownerPage, photoId) {
  const selector = `[data-queue-item="${photoId}"] [data-action="CONTENT.APPROVE"]`;
  await click(ownerPage, selector);
  await poll(() => evaluate(ownerPage, `!document.querySelector(${JSON.stringify(`[data-queue-item="${photoId}"]`)})`),
    `owner approval ${publicReference(photoId)}`);
}

async function correctPlacement(participantPage, batchId, itemId, photoId) {
  await go(participantPage, `/placements/${encodeURIComponent(photoId)}/edit?batch=${encodeURIComponent(batchId)}&item=${encodeURIComponent(itemId)}`);
  await waitApp(participantPage);
  try {
    await poll(() => evaluate(participantPage,
      "document.querySelector('[data-placement-form]')?.dataset.poseReady==='true'&&!document.querySelector('[data-placement-form] button[type=submit]')?.disabled"),
    `placement pose ${publicReference(photoId)}`, 6000);
  } catch (error) {
    const state = await evaluate(participantPage, `(()=>({
      hasForm:Boolean(document.querySelector('[data-placement-form]')),
      poseReady:document.querySelector('[data-placement-form]')?.dataset.poseReady||null,
      hasViewerRoot:Boolean(document.querySelector('[data-viewer-root]')),
      viewerMode:document.querySelector('.unseen-viewer')?.dataset.renderMode||null,
      viewerStatus:document.querySelector('.unseen-viewer [role=status]')?.textContent||null,
      unavailable:document.querySelector('.viewer-unavailable')?.innerText||null
    }))()`);
    throw new Error(`${error.message}:dom=${JSON.stringify(state)}`);
  }
  const submitted = await evaluate(participantPage, `(()=>{const form=document.querySelector('[data-placement-form]');
    if(!form)return false;form.requestSubmit();return true})()`);
  invariant(submitted, `placement_submit:${publicReference(photoId)}`);
  await poll(async () => {
    const value = await browserRequest(participantPage, "GET", `/v1/batch-receipt/items/${encodeURIComponent(itemId)}`);
    return value.placementState === "confirmed" ? value : null;
  }, `placement confirmed ${publicReference(photoId)}`);
}

async function recursiveFiles(root) {
  const values = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) values.push(absolute);
    }
  }
  if (existsSync(root)) await visit(root);
  return values.sort();
}

async function checksumEvidence(dataRoot) {
  const databasePath = path.join(dataRoot, "unseen.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const tables = ["spaces", "scenes", "panorama_revisions", "external_invitation_campaigns",
    "contribution_batches", "contribution_batch_items", "assets", "photos", "placement_revisions", "batch_receipts"];
  const counts = Object.fromEntries(tables.map((table) => [table,
    Number(database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count)]));
  database.close();
  const files = await recursiveFiles(path.join(dataRoot, "media"));
  const objects = [];
  for (const filename of files) {
    const bytes = await readFile(filename);
    objects.push({ pathSha256: sha256(path.relative(path.join(dataRoot, "media"), filename)),
      bytes: bytes.length, sha256: sha256(bytes) });
  }
  const sqliteFiles = [];
  for (const filename of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(filename)) continue;
    const bytes = await readFile(filename);
    sqliteFiles.push({ name: path.basename(filename), bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { schema: "unseen-stage-l-db-object-checksums/1", generatedAt: new Date().toISOString(),
    logicalTableCounts: counts, sqliteFiles, mediaObjects: objects,
    mediaAggregateSha256: sha256(stableJson(objects)), secretMaterialIncluded: false };
}

async function terminate(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(1500)]);
  if (child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
}

const startupPath = path.resolve(argument("--startup",
  path.join(repositoryRoot, "release-evidence/local-operable/LOCAL-STARTUP.json")));
const startup = JSON.parse(await readFile(startupPath, "utf8"));
const baseUrl = String(argument("--base-url", startup.origin)).replace(/\/$/, "");
const evidenceRoot = path.resolve(argument("--evidence", path.join(repositoryRoot, "release-evidence/local-operable")));
const screenshotRoot = path.join(evidenceRoot, "screenshots");
const dataRoot = path.dirname(path.resolve(repositoryRoot, startup.persistence.database));
const otpMailboxPath = path.join(dataRoot, ".otp-mailbox.json");
const profile = await mkdtemp(path.join(tmpdir(), "unseen-stage-l-chrome-"));
await mkdir(screenshotRoot, { recursive: true });
invariant(existsSync(chromePath), "chrome_missing");

const diagnostics = { schema: "unseen-stage-l-console-network/1", generatedAt: new Date().toISOString(),
  consoleErrors: [], exceptions: [], httpErrors: [], failedRequests: [], externalRequests: [] };
const trace = { schema: "unseen-stage-l-browser-trace/1", generatedAt: new Date().toISOString(),
  baseOrigin: baseUrl, runtimeId: "unseen-stage-l-local-operable-v1", browserContexts: [], steps: [], screenshots: [] };
let chrome = null;
let browser = null;
let ownerPage = null;
let participantPage = null;
let reopenPage = null;
let ownerContextId = null;
let participantContextId = null;
let reopenContextId = null;
let result = null;

try {
  const health = await fetch(`${baseUrl}/healthz`);
  invariant(health.ok && health.headers.get("x-unseen-runtime-id") === trace.runtimeId &&
    health.headers.get("x-unseen-local-operable") === "true", "runtime_identity_health");
  const localStatusResponse = await fetch(`${baseUrl}/__local/status`);
  const localStatus = await localStatusResponse.json();
  invariant(localStatusResponse.ok && localStatus.runtimeId === trace.runtimeId && localStatus.origin === baseUrl &&
    localStatus.cloudWrites === 0, "runtime_identity_status");

  chrome = spawn(chromePath, ["--headless=new", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const devtools = await poll(async () => {
    try { return (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"); }
    catch { return null; }
  }, "Chrome DevTools port");
  const debugPort = Number(devtools[0]);
  const browserInfo = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browser = new Cdp(browserInfo.webSocketDebuggerUrl);
  await browser.ready;
  ownerContextId = (await browser.send("Target.createBrowserContext")).browserContextId;
  participantContextId = (await browser.send("Target.createBrowserContext")).browserContextId;
  trace.browserContexts.push({ role: "owner", isolated: true }, { role: "participant", isolated: true });
  ownerPage = await createPage(browser, debugPort, ownerContextId, "owner");
  participantPage = await createPage(browser, debugPort, participantContextId, "participant");
  await Promise.all([go(ownerPage, "/"), go(participantPage, "/")]);

  const otpChallenge = await browserRequest(ownerPage, "POST", "/v1/auth/email-otp-challenges", {
    email: "stage-l-owner@example.test", purpose: "login", locale: "zh-CN"
  });
  const otp = await waitOtp(otpChallenge.challengeId);
  const ownerSession = await browserRequest(ownerPage, "POST", "/v1/auth/email-otp-verifications", {
    challengeId: otpChallenge.challengeId, otp, purpose: "login"
  });
  invariant(ownerSession.accountId, "owner_session");
  const space = await browserRequest(ownerPage, "POST", "/v1/spaces", { name: "Stage L 共同现场" });
  await browserRequest(ownerPage, "POST", `/v1/spaces/${space.spaceId}/collection-transitions`,
    { to: "open" }, { "If-Match": '"space:1"' });
  await browserRequest(ownerPage, "POST", `/v1/spaces/${space.spaceId}/sharing-transitions`,
    { to: "shared" }, { "If-Match": '"space:2"' });

  const panoramaSource = await browserRequest(ownerPage, "GET", "/__local-operable/status");
  invariant(panoramaSource.fixture.mode === "deterministic_local_fixture", "fixture_mode");
  const panoramaBytes = (await stat(path.join(repositoryRoot, "apps/web/assets/panorama/pano.jpg"))).size;
  const panorama = await browserRequest(ownerPage, "POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/jpeg", declaredBytes: panoramaBytes, clientAssetId: "stage-l-panorama",
    noticeAcknowledgement: { purpose: "panorama_upload", version: 1, contentHash: "local-panorama_upload-v1" }
  }, { "If-Match": '"space:3"' });
  await uploadLocalAsset(ownerPage, panorama.exactPrivateUploadTicketOnce, "/assets/panorama/pano.jpg");
  await browserRequest(ownerPage, "POST", `/v1/panorama-upload-sessions/${panorama.uploadSessionId}/commits`,
    { clientRequestId: "stage-l-panorama-commit" }, { "If-Match": panorama.uploadSessionIfMatch });
  const readyPanorama = await poll(async () => {
    const value = await browserRequest(ownerPage, "GET",
      `/v1/spaces/${space.spaceId}/panorama-candidates/${panorama.candidateId}`);
    return value.status === "ready" ? value : null;
  }, "panorama ready");
  await browserRequest(ownerPage, "POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: readyPanorama.panoramaRevisionId, sceneIfMatchVersion: 1
  }, { "If-Match": '"space:3"' });
  const campaign = await browserRequest(ownerPage, "POST",
    `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "combo", entryTask: "view",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(), maxSuccessfulUses: 100
    }, { "If-Match": '"space:4"' });
  trace.steps.push({ step: "owner_setup", pass: true, spaceRef: publicReference(space.spaceId),
    panoramaRef: publicReference(readyPanorama.panoramaRevisionId), campaignCreated: true });

  const publicCampaignId = campaign.publicCampaignUrl.split("/").at(-1);
  const admissionNonce = `stage-l-${crypto.randomUUID()}`;
  await browserRequest(participantPage, "POST", "/v1/external-campaign-admission-challenges",
    { publicCampaignId, clientNonce: admissionNonce });
  const admission = await browserRequest(participantPage, "POST", "/v1/external-campaign-admissions",
    { publicCampaignId, clientNonce: admissionNonce });
  const inviteSecret = new URL(admission.bootstrapUrl, baseUrl).hash.replace(/^#invite=/, "");
  invariant(/^[A-Za-z0-9_-]{43}$/.test(inviteSecret), "invite_bootstrap");
  const exchange = await browserRequest(participantPage, "POST", "/v1/external-invitation-exchanges",
    { secretFromClearedInviteBootstrap: inviteSecret, clientNonce: admissionNonce });
  invariant(exchange.taskMode === "combo" && exchange.destinationRoute.includes(space.spaceId), "participant_exchange");
  const uploadContext = await browserRequest(participantPage, "GET", `/v1/spaces/${space.spaceId}/upload-context`);
  const consent = await browserRequest(participantPage, "POST", "/v1/consent-events", {
    purpose: "photo_upload", noticeVersion: uploadContext.noticeVersion, noticeHash: uploadContext.noticeHash,
    mediaPolicyVersion: uploadContext.mediaPolicyVersion, choices: uploadContext.choices
  });
  const batch = await browserRequest(participantPage, "POST",
    `/v1/spaces/${space.spaceId}/contribution-batches`, {
      clientBatchId: `stage-l-${crypto.randomUUID()}`, consentEventId: consent.consentEventId, declaredItemCount: 3
    }, { "If-Match": uploadContext.ifMatch });

  const uploaded = [];
  for (const number of [1, 2, 3]) {
    const relativeAsset = `apps/web/assets/photos/photo-${number}.jpg`;
    const declaredBytes = (await stat(path.join(repositoryRoot, relativeAsset))).size;
    const item = await browserRequest(participantPage, "POST", `/v1/contribution-batches/${batch.batchId}/items`, {
      clientItemId: `stage-l-photo-${number}-${crypto.randomUUID()}`, declaredMime: "image/jpeg",
      declaredBytes, fileNameHash: sha256(`photo-${number}.jpg`)
    }, { "If-Match": batch.ifMatch });
    const authorization = await browserRequest(participantPage, "POST",
      `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`, {
        declaredMime: "image/jpeg", declaredBytes, clientUploadId: `stage-l-upload-${number}-${crypto.randomUUID()}`
      }, { "If-Match": item.ifMatch });
    const ticketUrl = new URL(authorization.oneTimeUploadTicket.url, baseUrl);
    const ticketHeaders = Object.fromEntries(Object.entries(authorization.oneTimeUploadTicket.headers)
      .map(([name, value]) => [name.toLowerCase(), value]));
    invariant(ticketUrl.origin === new URL(baseUrl).origin &&
      ticketUrl.pathname.startsWith("/__local/media/direct/") && !ticketUrl.search && !ticketUrl.hash &&
      !ticketUrl.username && !ticketUrl.password && ticketHeaders["if-none-match"] === "*" &&
      ticketHeaders["x-unseen-upload-session"] === authorization.uploadSessionId &&
      ticketHeaders["x-unseen-upload-item"] === item.itemId &&
      ticketHeaders["x-unseen-upload-asset"] === authorization.assetId &&
      ticketHeaders["x-unseen-upload-bytes"] === String(declaredBytes), "direct_upload_authorization");
    await uploadLocalAsset(participantPage, authorization.oneTimeUploadTicket, `/assets/photos/photo-${number}.jpg`);
    const committed = await browserRequest(participantPage, "POST",
      `/v1/upload-sessions/${authorization.uploadSessionId}/commits`, {
        clientCommitId: `stage-l-commit-${number}-${crypto.randomUUID()}`
      }, { "If-Match": authorization.commitIfMatch });
    uploaded.push({ number, itemId: item.itemId, photoId: committed.photoId });
  }
  const batchResult = await poll(async () => {
    const value = await browserRequest(participantPage, "GET", `/v1/contribution-batches/${batch.batchId}/result`);
    return value.items.length === 3 && value.items.every((item) =>
      ["confirmed", "needs_confirmation", "failed"].includes(item.placementState)) ? value : null;
  }, "three fixture placements");
  invariant(JSON.stringify(batchResult.items.map((item) => item.placementState)) ===
    JSON.stringify(["confirmed", "needs_confirmation", "failed"]), "fixture_states");
  const finalized = await browserRequest(participantPage, "POST",
    `/v1/contribution-batches/${batch.batchId}/finalizations`, {
      itemsDigest: batchResult.itemsDigest, clientRequestId: `stage-l-finalize-${crypto.randomUUID()}`
    }, { "If-Match": batchResult.ifMatch });
  invariant(finalized.receiptSessionReady === true, "receipt_auto_exchange");
  const receipt = await browserRequest(participantPage, "GET", "/v1/batch-receipt");
  invariant(receipt.batchId === batch.batchId && receipt.items.length === 3, "receipt_view");

  await go(participantPage, `/uploads/${batch.batchId}`);
  await waitApp(participantPage);
  await waitText(participantPage, "本次上传结果");
  invariant(await evaluate(participantPage,
    `document.body.innerText.includes(${JSON.stringify("测试版")})&&document.body.innerText.includes(${JSON.stringify("照片方位由人工确认，非真实定位")})&&globalThis.__UNSEEN_TEST__===undefined`),
  "participant_fixture_disclosure");
  await screenshot(participantPage, "02-fixture-results.png");

  await go(ownerPage, `/manage/${space.spaceId}?tab=review`);
  await waitApp(ownerPage);
  await waitText(ownerPage, "照片审核");
  invariant(await evaluate(ownerPage, "document.querySelectorAll('[data-queue-item]').length===3"), "owner_review_count");
  await screenshot(ownerPage, "01-owner-space.png");

  const high = batchResult.items.find((item) => item.placementState === "confirmed");
  const uncertain = batchResult.items.find((item) => item.placementState === "needs_confirmation");
  const failed = batchResult.items.find((item) => item.placementState === "failed");
  await approvePhoto(ownerPage, high.photoId);

  await go(participantPage, `/uploads/${batch.batchId}/items/${failed.itemId}`);
  await waitApp(participantPage);
  await waitText(participantPage, "定位失败");
  const beforeRetryStatus = await browserRequest(participantPage, "GET", "/__local-operable/status");
  const beforeRetryDispatches = beforeRetryStatus.fixtureRecords.filter((record) =>
    record.jobType === "photo_placement" && record.photoId === failed.photoId).length;
  await click(participantPage, '[data-action="PLACEMENT.RETRY"]');
  await poll(async () => {
    const status = await browserRequest(participantPage, "GET", "/__local-operable/status");
    return status.fixtureRecords.filter((record) => record.jobType === "photo_placement" &&
      record.photoId === failed.photoId).length > beforeRetryDispatches;
  }, "failed fixture retry dispatch");
  const retryResult = await poll(async () => {
    const value = await browserRequest(participantPage, "GET", `/v1/batch-receipt/items/${failed.itemId}`);
    return value.placementState === "failed" ? value : null;
  }, "failed fixture retry");
  invariant(retryResult.placementState === "failed", "failed_retry_state");
  await correctPlacement(participantPage, batch.batchId, uncertain.itemId, uncertain.photoId);
  await correctPlacement(participantPage, batch.batchId, failed.itemId, failed.photoId);
  trace.steps.push({ step: "participant_upload_and_correction", pass: true,
    fixtureStates: ["confirmed", "needs_confirmation", "failed"], failedRetry: "failed",
    manualCorrections: 2, receiptSession: "real_exchange" });

  await go(ownerPage, `/manage/${space.spaceId}?tab=review`);
  await waitApp(ownerPage);
  await approvePhoto(ownerPage, uncertain.photoId);
  await approvePhoto(ownerPage, failed.photoId);
  invariant(await evaluate(ownerPage, "document.querySelectorAll('[data-queue-item]').length===0"), "owner_review_empty");
  trace.steps.push({ step: "owner_review", pass: true, approved: 3 });

  await go(participantPage, `/s/${space.spaceId}/scene?photo=${high.photoId}`);
  await waitApp(participantPage);
  await poll(() => evaluate(participantPage,
    "Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback'))&&Boolean(document.querySelector('.viewer-photo-button'))"),
  "accepted Viewer mount");
  await click(participantPage, `.viewer-photo-button[data-photo-id="${high.photoId}"]`);
  await click(participantPage, 'a.button[href$="/album"]');
  await poll(() => evaluate(participantPage, `location.pathname===${JSON.stringify(`/s/${space.spaceId}/album`)}`),
    "Viewer return to album");
  await poll(() => evaluate(participantPage,
    `Boolean(document.querySelector('[data-photo-card="${high.photoId}"]'))`), "Viewer returned photo present");
  const beforeReopen = await browserRequest(participantPage, "GET",
    `/v1/viewer/spaces/${space.spaceId}/photos/${high.photoId}/scene-context`);
  const sourceDatabase = new DatabaseSync(path.join(dataRoot, "unseen.sqlite"), { readOnly: true });
  const sourcePlacement = sourceDatabase.prepare("SELECT pitch FROM placement_revisions WHERE id=?")
    .get(beforeReopen.placement.revisionId);
  sourceDatabase.close();
  invariant(beforeReopen.placement.pitchDeg === 0 && sourcePlacement?.pitch === null,
    "local_fixture_pitch_projection_boundary");
  const panoramaIntegrity = await verifyBrowserMedia(participantPage, beforeReopen.panorama);
  const photoIntegrity = await verifyBrowserMedia(participantPage, beforeReopen.photoMedia);
  invariant(panoramaIntegrity.status === 200 && panoramaIntegrity.etag === beforeReopen.panorama.sha256 &&
    panoramaIntegrity.bytes === beforeReopen.panorama.bytes &&
    panoramaIntegrity.digest === beforeReopen.panorama.sha256, "panorama_media_integrity");
  invariant(photoIntegrity.status === 200 && photoIntegrity.etag === beforeReopen.photoMedia.sha256 &&
    photoIntegrity.bytes === beforeReopen.photoMedia.bytes &&
    photoIntegrity.digest === beforeReopen.photoMedia.sha256, "photo_media_integrity");

  await participantPage.cdp.send("Storage.clearDataForOrigin", { origin: baseUrl, storageTypes: "all" });
  participantPage.cdp.close();
  participantPage = null;
  await browser.send("Target.disposeBrowserContext", { browserContextId: participantContextId });
  participantContextId = null;
  reopenContextId = (await browser.send("Target.createBrowserContext")).browserContextId;
  reopenPage = await createPage(browser, debugPort, reopenContextId, "participant-reopen");
  trace.browserContexts.push({ role: "participant-reopen", isolated: true, priorSiteDataCleared: true });
  await go(reopenPage, "/");
  const reopenNonce = `stage-l-reopen-${crypto.randomUUID()}`;
  await browserRequest(reopenPage, "POST", "/v1/external-campaign-admission-challenges",
    { publicCampaignId, clientNonce: reopenNonce });
  const reopenAdmission = await browserRequest(reopenPage, "POST", "/v1/external-campaign-admissions",
    { publicCampaignId, clientNonce: reopenNonce });
  const reopenSecret = new URL(reopenAdmission.bootstrapUrl, baseUrl).hash.replace(/^#invite=/, "");
  await browserRequest(reopenPage, "POST", "/v1/external-invitation-exchanges",
    { secretFromClearedInviteBootstrap: reopenSecret, clientNonce: reopenNonce });
  const afterReopen = await browserRequest(reopenPage, "GET",
    `/v1/viewer/spaces/${space.spaceId}/photos/${high.photoId}/scene-context`);
  invariant(afterReopen.photoId === beforeReopen.photoId &&
    afterReopen.photoAssetId === beforeReopen.photoAssetId &&
    afterReopen.photoRawSha256 === beforeReopen.photoRawSha256 &&
    afterReopen.panorama.revisionId === beforeReopen.panorama.revisionId &&
    afterReopen.panorama.sha256 === beforeReopen.panorama.sha256, "cache_reopen_identity");
  await go(reopenPage, `/s/${space.spaceId}/scene?photo=${high.photoId}`);
  await waitApp(reopenPage);
  await poll(() => evaluate(reopenPage,
    "Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback'))&&Boolean(document.querySelector('.viewer-photo-button'))"),
  "reopened Viewer mount");
  await screenshot(reopenPage, "03-viewer-reopen.png");
  trace.steps.push({ step: "viewer_focus_return_and_reopen", pass: true, viewerInput: "accepted Track 4 public entry",
    returnedToAlbum: true, cacheCleared: true, photoIdentityStable: true, panoramaIdentityStable: true,
    panoramaMediaIntegrity: true, photoMediaIntegrity: true });

  diagnostics.summary = { consoleErrors: diagnostics.consoleErrors.length, exceptions: diagnostics.exceptions.length,
    httpErrors: diagnostics.httpErrors.length, failedRequests: diagnostics.failedRequests.length,
    externalRequests: diagnostics.externalRequests.length };
  invariant(Object.values(diagnostics.summary).every((count) => count === 0),
    `browser_diagnostics:${JSON.stringify(diagnostics.summary)}`);
  trace.summary = { steps: trace.steps.length, screenshots: trace.screenshots.length,
    productionHttpAdapter: true, fixtureAdapter: false, twoRoleContexts: true, pass: true };
  const cacheReopen = { schema: "unseen-stage-l-cache-reopen/1", generatedAt: new Date().toISOString(),
    siteDataCleared: true, newIsolatedBrowserContext: true, samePhotoId: true, samePhotoAssetId: true,
    samePhotoRawSha256: true, samePanoramaRevisionId: true, samePanoramaSha256: true,
    photoRef: publicReference(high.photoId), panoramaRef: publicReference(afterReopen.panorama.revisionId), pass: true };
  const checksums = await checksumEvidence(dataRoot);
  result = {
    schema: "unseen-stage-l-result/1",
    generatedAt: new Date().toISOString(),
    productLabel: "Core Local Operable = PASS",
    status: "PASS",
    runtimeIdentity: { runtimeId: trace.runtimeId, origin: baseUrl, responseHeadersVerified: true,
      preferredPort: startup.preferredPort, portFallback: startup.portFallback },
    inputs: {
      effectiveRevision: "00c918a7549cdeae37a8f6de81a6e4482bd5a8ee",
      track1A: "ba11df7634c60398d3e9ef8a0ba7a3ea3e5d7790",
      track2: "13b9f9b04edc1122242fa9a0e264f471dbd5c3ad",
      track4: "5e068e3d04263adc2f480ac9db5a3bc1f18157d7",
      track3A: "52cfbb5182261c335521b78e2265771acc80304d",
      track6A: "52e5393ff3068ba2e3f2c8d001a86cf222e36578"
    },
    assertions: {
      productionHttpAdapter: true,
      fixtureAdapter: false,
      persistentSQLite: true,
      filesystemMediaStore: true,
      oneOriginSessionMedia: true,
      viewerEtagEqualsDtoSha256: true,
      viewerBytesSha256EqualsDtoSha256: true,
      localFixtureNullPitchProjectedToZero: true,
      sourcePlacementPitchRemainsNull: true,
      visiblyLabelledFixtureStates: ["high", "需要确认", "failed"],
      participantFailedRetry: true,
      participantManualCorrection: true,
      ownerReview: true,
      viewerFocusAndReturn: true,
      cacheAndSiteDataReopen: true,
      consoleErrors: 0,
      unexpectedNetworkErrors: 0,
      cloudWrites: 0
    },
    evidence: {
      browserTrace: "BROWSER-TRACE.json", cacheReopen: "CACHE-REOPEN.json",
      consoleNetwork: "CONSOLE-NETWORK.json", dbObjectChecksums: "DB-OBJECT-CHECKSUMS.json",
      screenshots: trace.screenshots
    }
  };
  await Promise.all([
    writeJson(path.join(evidenceRoot, "BROWSER-TRACE.json"), trace),
    writeJson(path.join(evidenceRoot, "CACHE-REOPEN.json"), cacheReopen),
    writeJson(path.join(evidenceRoot, "CONSOLE-NETWORK.json"), diagnostics),
    writeJson(path.join(evidenceRoot, "DB-OBJECT-CHECKSUMS.json"), checksums),
    writeJson(path.join(evidenceRoot, "STAGE-L-RESULT.json"), result)
  ]);
  process.stdout.write(`${JSON.stringify({ status: result.status, productLabel: result.productLabel,
    origin: baseUrl, screenshots: trace.screenshots.length, diagnostics: diagnostics.summary })}\n`);
} catch (error) {
  trace.failure = error.stack ?? String(error);
  diagnostics.summary = { consoleErrors: diagnostics.consoleErrors.length, exceptions: diagnostics.exceptions.length,
    httpErrors: diagnostics.httpErrors.length, failedRequests: diagnostics.failedRequests.length,
    externalRequests: diagnostics.externalRequests.length };
  await Promise.all([
    writeJson(path.join(evidenceRoot, "BROWSER-TRACE.json"), trace),
    writeJson(path.join(evidenceRoot, "CONSOLE-NETWORK.json"), diagnostics),
    writeJson(path.join(evidenceRoot, "STAGE-L-RESULT.json"), {
      schema: "unseen-stage-l-result/1", generatedAt: new Date().toISOString(),
      productLabel: "Core Local Operable = FAIL", status: "FAIL", failure: String(error.message ?? error),
      cloudWrites: 0
    })
  ]);
  throw error;
} finally {
  ownerPage?.cdp.close();
  participantPage?.cdp.close();
  reopenPage?.cdp.close();
  if (browser) {
    for (const browserContextId of [ownerContextId, participantContextId, reopenContextId].filter(Boolean)) {
      await browser.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    }
    browser.close();
  }
  await terminate(chrome);
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
