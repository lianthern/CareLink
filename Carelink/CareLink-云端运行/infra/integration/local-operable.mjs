import { createLocalBookRenderWorker } from "./book-lab/local-render-worker.mjs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalApi } from "../../services/api/src/api.mjs";
import { loadLocalKeyring } from "../../services/api/src/crypto.mjs";
import { createLocalHttpServer } from "../../services/api/src/http-server.mjs";
import { FilesystemMediaStore } from "../../services/api/src/ports/media/filesystem-media-store.mjs";
import { smtpOtpDeliveryFromEnv } from "../../services/api/src/ports/otp/smtp-otp-delivery-port.mjs";
import { tencentSesApiOtpDeliveryFromEnv } from "../../services/api/src/ports/otp/tencent-ses-api-otp-delivery-port.mjs";
import { parseJson, stableJson as canonicalStableJson } from "../../services/api/src/util.mjs";
import {
  createDeterministicLocator,
  createLocalFixtureWorker,
  projectLocalFixtureSceneContext,
  readLocalOperableConfig
} from "./local-locator-fixture.mjs";
import { createPrivateAiComposition } from "./book-lab/private-ai-composition.mjs";
import { spawnClipSidecar } from "./clip-sidecar-process.mjs";
import { createClipLocatorWorker, waitForSidecarReady } from "./local-clip-locator-worker.mjs";
import { ClipLocatorPort } from "../../services/api/src/ports/locator/clip-locator-port.mjs";
import { ClipSidecarClient } from "../../services/locator/src/clip-sidecar-client.mjs";
import { CropBankCache } from "../../services/locator/src/crop-bank-cache.mjs";
import { clipThresholdsFromEnv } from "../../services/locator/src/match.mjs";
import { COLLECTION_NOTICE_CONTEXT_DISCLOSURE } from "../../services/book-lab/src/index.mjs";

process.umask(0o077);

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "../..");
const webRoot = path.join(repositoryRoot, "apps/web");
const viewerRoot = path.join(repositoryRoot, "packages/viewer");
// Mirrors viewerRoot for the book-lab-web package: apps/web/src/extensions/book-lab.js imports it at
// runtime via the /__book_lab_web__/ import-map entry (see apps/web/index.html), the same way the
// production viewer is bridged in. Serving these files is harmless regardless of bookLabEnabled below —
// only the frontend feature flag (and the real /v2-labs/* API mount) gates whether anything imports them.
const bookLabWebRoot = path.join(repositoryRoot, "packages/book-lab-web");
const bookLabCatalogPath = path.join(repositoryRoot, "packages/contracts/generated/book-lab/string-catalog.zh-CN.json");
const evidenceRoot = path.resolve(process.env.UNSEEN_LOCAL_EVIDENCE_DIR ??
  path.join(repositoryRoot, "release-evidence/local-operable"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const runtimeId = "unseen-stage-l-local-operable-v1";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function invariant(condition, message) {
  if (!condition) throw new Error(`local_operable_invalid:${message}`);
}

function jsonHeaders() {
  return { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
}

function webHeaders(contentType, nonce = "") {
  return {
    "cache-control": "no-store",
    // worker-src 'self': the /login "获取验证码" PoW solver runs in a same-origin Web Worker
    // (apps/web/src/otp-pow/worker.js) so it never blocks the main thread; script-src stays
    // 'self'-only (no change) since the worker script is served from this same origin, not a CDN.
    "content-security-policy": `default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'; manifest-src 'self'`,
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-unseen-local-operable": "true"
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function replaceJson(filename, value) {
  const target = path.join(evidenceRoot, filename);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, stableJson(value), { mode: 0o600 });
  await rename(temporary, target);
}

function safeRelative(root, pathname, prefix = "") {
  const decoded = decodeURIComponent(prefix ? pathname.slice(prefix.length) : pathname);
  invariant(!decoded.includes("\0"), "path_nul");
  const candidate = path.resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  invariant(candidate === root || candidate.startsWith(`${root}${path.sep}`), "path_escape");
  return candidate;
}

function redactedRoute(pathname) {
  return pathname.split("/").map((part) => /^(?:[a-z]+_)?[A-Za-z0-9_-]{16,}$/.test(part) ? ":id" : part).join("/");
}

function cookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter((parts) => parts.length === 2));
}

function versionToken(parts) {
  return `"${Object.entries(parts).filter(([, value]) => Number.isSafeInteger(Number(value)))
    .map(([name, value]) => `${name}:${Number(value)}`).join(";")}"`;
}

function parseVersionToken(value) {
  const normalized = String(value ?? "").replaceAll('"', "");
  const result = {};
  for (const part of normalized.split(";")) {
    const match = /^([a-z-]+):(\d+)$/.exec(part);
    if (match) result[match[1]] = Number(match[2]);
  }
  return result;
}

function mediaDescriptor(asset, url) {
  if (!asset || asset.validation_state !== "valid" || !/^[a-f0-9]{64}$/.test(asset.raw_sha256 ?? "") ||
    !Number.isSafeInteger(asset.observed_bytes) || asset.observed_bytes < 1 || !asset.observed_mime) return null;
  return { url, assetId: asset.id, assetVersion: asset.version, sha256: asset.raw_sha256,
    bytes: asset.observed_bytes, contentType: asset.observed_mime };
}

async function availableLoopbackPort(host, preferredPort) {
  const selected = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      if (error?.code !== "EADDRINUSE") { reject(error); return; }
      const fallback = createServer();
      fallback.unref();
      fallback.once("error", reject);
      fallback.listen(0, host, () => {
        const address = fallback.address();
        const port = typeof address === "object" && address ? address.port : null;
        fallback.close((closeError) => closeError ? reject(closeError) : resolve({ port, fallback: true }));
      });
    });
    probe.listen(preferredPort, host, () => {
      probe.close((error) => error ? reject(error) : resolve({ port: preferredPort, fallback: false }));
    });
  });
  invariant(Number.isSafeInteger(selected.port) && selected.port > 0, "available_port");
  return selected;
}

const { config, configPath, configSha256 } = await readLocalOperableConfig(repositoryRoot);
const host = process.env.UNSEEN_LOCAL_HOST ?? config.host;
const listenHost = host === "localhost" ? "127.0.0.1" : host;
const preferredPort = Number(process.env.UNSEEN_LOCAL_PORT ?? config.port);
invariant(["localhost", "127.0.0.1"].includes(host), "loopback_host_required");
invariant(Number.isSafeInteger(preferredPort) && preferredPort > 0 && preferredPort < 65536, "port");
const selectedPort = await availableLoopbackPort(listenHost, preferredPort);
const port = selectedPort.port;
const listenOrigin = `http://${listenHost}:${port}`;
const origin = String(process.env.UNSEEN_LOCAL_PUBLIC_ORIGIN ?? listenOrigin).replace(/\/$/u, "");
const publicUrl = new URL(origin);
const supervisedMode = process.env.UNSEEN_LOCAL_SUPERVISED_MODE ?? "local";
const localPublicOrigin = ["http:", "https:"].includes(publicUrl.protocol) &&
  ["localhost", "127.0.0.1"].includes(publicUrl.hostname);
const supervisedServerOrigin = supervisedMode === "server_staging" && publicUrl.protocol === "https:" &&
  !["localhost", "127.0.0.1"].includes(publicUrl.hostname) &&
  process.env.UNSEEN_LOCAL_EXTERNAL_ORIGIN_ACK === "access_controlled_tls_reverse_proxy";
invariant((supervisedMode === "local" ? localPublicOrigin : supervisedServerOrigin) &&
  publicUrl.pathname === "/" && !publicUrl.username && !publicUrl.password &&
  !publicUrl.search && !publicUrl.hash, "supervised_public_origin_required");
const dataRoot = path.resolve(process.env.UNSEEN_LOCAL_DATA_DIR ?? path.join(repositoryRoot,
  config.persistence.dataDirectory));
const databasePath = path.join(dataRoot, config.persistence.database);
const mediaRoot = path.join(dataRoot, config.persistence.mediaDirectory);
const keysetPath = path.join(dataRoot, config.persistence.keyset);
const otpMailboxPath = path.join(dataRoot, config.persistence.otpMailbox);
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await chmod(dataRoot, 0o700);
await mkdir(evidenceRoot, { recursive: true });
const inputCommitsBytes = await readFile(path.join(repositoryRoot, "release-evidence/local-operable/INPUT-COMMITS.json"));
await writeFile(path.join(evidenceRoot, "INPUT-COMMITS.json"), inputCommitsBytes, { mode: 0o600 });

const keyring = loadLocalKeyring(keysetPath, { allowCreate: !existsSync(databasePath) });
const mediaStore = new FilesystemMediaStore(mediaRoot);

// Track M (2026-08): opt-in real CLIP locator, off by default. Setting UNSEEN_LOCATOR_MODE=clip
// swaps the deterministic fixture for a real clip-ViT-B-32 sidecar; every other env var / code
// path in this file is untouched when the flag is absent, so the existing fixture-mode behavior
// (and any other track's tests against it) cannot regress from this addition.
const locatorMode = process.env.UNSEEN_LOCATOR_MODE === "clip" ? "clip_local_sidecar_v1" : "deterministic_local_fixture";
const locatorFixture = locatorMode === "clip_local_sidecar_v1"
  ? new ClipLocatorPort({ enabled: true })
  : createDeterministicLocator(config, { candidateDirections: process.env.UNSEEN_LOCAL_FIXTURE_CANDIDATES === "true" });
let clipSidecarProcess = null;
let clipSidecarClient = null;
let cropBankCache = null;
// 2026-08-17: CONF_MIN/MARGIN_MIN 现在可以不重新部署、只改 env 就线上调参 —— 见
// services/locator/src/match.mjs 里 DEFAULT_THRESHOLDS 头顶那段真实照片标定注释和
// clipThresholdsFromEnv() 自己的注释。两个变量任一缺失都各自退回那组标定值，不用两个都填。
const clipLocatorThresholds = clipThresholdsFromEnv(process.env);
if (locatorMode === "clip_local_sidecar_v1") {
  const modelsDir = process.env.UNSEEN_CLIP_MODELS_DIR ?? path.join(homedir(), "code/unseen-assets/models");
  const sidecarPort = Number(process.env.UNSEEN_CLIP_SIDECAR_PORT ?? 8791);
  clipSidecarProcess = spawnClipSidecar({ repositoryRoot, port: sidecarPort, modelsDir });
  clipSidecarClient = new ClipSidecarClient({ baseUrl: clipSidecarProcess.baseUrl,
    timeoutMs: Number(process.env.UNSEEN_CLIP_SIDECAR_TIMEOUT_MS ?? 10_000) });
  await waitForSidecarReady(clipSidecarClient, { attempts: 120, intervalMs: 500 }); // model load ~10-25s cold
  cropBankCache = new CropBankCache({ sidecarClient: clipSidecarClient,
    cacheDir: path.join(dataRoot, "clip-crop-bank-cache") });
}
const otpDeliveryProvider = process.env.UNSEEN_OTP_DELIVERY_PROVIDER ?? "disabled";
invariant(["disabled", "smtp", "tencent_ses_api"].includes(otpDeliveryProvider), "otp_delivery_provider");
const otpDeliveryPort = otpDeliveryProvider === "smtp" ? smtpOtpDeliveryFromEnv(process.env) :
  otpDeliveryProvider === "tencent_ses_api" ? tencentSesApiOtpDeliveryFromEnv(process.env) : null;
// Human-verification gate in front of OTP issuance (2026-08-17: real SES sending just went live,
// so this defaults ON here -- unlike otpDeliveryProvider above, which defaults to "disabled"
// because sending real mail is an explicit opt-in per environment). "pow" (self-hosted proof of
// work) is the default: Cloudflare Turnstile/hCaptcha are unreliable for mainland-China visitors,
// and this needs zero third-party network dependency. "tencent_captcha" is a same-account,
// mainland-friendly fallback whose server-side port is only a skeleton today -- see
// services/api/src/ports/captcha/tencent-captcha-port.mjs's header for what's still needed
// (CaptchaAppId/AppSecretKey from the console, plus frontend widget wiring apps/web doesn't have
// yet) -- selecting it before that's done will fail closed at construction time, not silently
// no-op. "disabled" is the explicit escape hatch if the gate itself needs to come off.
const otpCaptchaProvider = process.env.UNSEEN_OTP_CAPTCHA_PROVIDER ?? "pow";
invariant(["pow", "tencent_captcha", "disabled"].includes(otpCaptchaProvider), "otp_captcha_provider");
const otpCaptchaConfig = {
  provider: otpCaptchaProvider,
  difficultyBits: process.env.UNSEEN_OTP_CAPTCHA_DIFFICULTY_BITS === undefined ?
    undefined : Number(process.env.UNSEEN_OTP_CAPTCHA_DIFFICULTY_BITS),
  challengeTtlMs: process.env.UNSEEN_OTP_CAPTCHA_CHALLENGE_TTL_MS === undefined ?
    undefined : Number(process.env.UNSEEN_OTP_CAPTCHA_CHALLENGE_TTL_MS),
  tencent: otpCaptchaProvider === "tencent_captcha" ? {
    secretId: process.env.UNSEEN_TENCENT_SES_SECRET_ID, secretKey: process.env.UNSEEN_TENCENT_SES_SECRET_KEY,
    captchaAppId: Number(process.env.UNSEEN_TENCENT_CAPTCHA_APP_ID),
    appSecretKey: process.env.UNSEEN_TENCENT_CAPTCHA_APP_SECRET_KEY,
    timeoutMs: Number(process.env.UNSEEN_TENCENT_CAPTCHA_TIMEOUT_MS ?? 5000)
  } : undefined
};
const otpRateLimits = {
  ipHourlyLimit: process.env.UNSEEN_OTP_RATE_IP_HOURLY_LIMIT === undefined ?
    undefined : Number(process.env.UNSEEN_OTP_RATE_IP_HOURLY_LIMIT),
  ipDailyLimit: process.env.UNSEEN_OTP_RATE_IP_DAILY_LIMIT === undefined ?
    undefined : Number(process.env.UNSEEN_OTP_RATE_IP_DAILY_LIMIT),
  dailyBudget: process.env.UNSEEN_OTP_DAILY_SEND_BUDGET === undefined ?
    undefined : Number(process.env.UNSEEN_OTP_DAILY_SEND_BUDGET)
};
const otpEvents = [];
const fixtureRecords = [];
const requestCounts = { total: 0, api: 0, web: 0, localStatus: 0, unexpected: 0 };
let fatalWorkerError = null;

function otpSink(message) {
  const metadata = { challengeId: message.challengeId, purpose: message.purpose, expiresAt: message.expiresAt };
  otpEvents.push(metadata);
  writeFileSync(otpMailboxPath, stableJson({ schema: "unseen-local-otp-mailbox/1", ...metadata, code: message.code }),
    { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: "LOCAL_OTP", ...metadata, code: message.code })}\n`);
}

// Book Lab is off by default; this block only changes anything when UNSEEN_BOOK_LAB_ENABLED="true".
const bookLabEnabled = process.env.UNSEEN_BOOK_LAB_ENABLED === "true";
const bookRenderWorkerEnabled = process.env.UNSEEN_BOOK_RENDER_WORKER_ENABLED === "true" &&
  process.env.UNSEEN_BOOK_RENDER_GENERATION_ENABLED !== "false";
invariant(bookLabEnabled || !bookRenderWorkerEnabled, "book_render_book_lab_required");
const privateAiWorkerEnabled = process.env.UNSEEN_PRIVATE_AI_WORKER_ENABLED === "true";
invariant(bookLabEnabled || !privateAiWorkerEnabled, "private_ai_book_lab_required");
function bookLabLocalPlaceholder(seed) {
  return sha256(`unseen-local-operable-book-lab-placeholder/v1:${seed}`);
}
// services/api/src/extensions/book-lab.mjs reads these directly from process.env (via the extensionModuleLoader
// below). Local-operable fills in non-production placeholders so UNSEEN_BOOK_LAB_ENABLED=true is enough on its
// own to boot; any of these can still be overridden by setting the real env var before launch.
const bookLabLocalDefaults = {
  UNSEEN_BOOK_LAB_DB: path.join(dataRoot, "book-lab.sqlite"),
  UNSEEN_BOOK_LAB_ETAG_SECRET: bookLabLocalPlaceholder("etag-secret"),
  UNSEEN_BOOK_LAB_WORKER_SECRET: bookLabLocalPlaceholder("worker-secret"),
  UNSEEN_BOOK_LAB_CLEANUP_SECRET: bookLabLocalPlaceholder("cleanup-secret"),
  UNSEEN_BOOK_LAB_RENDER_WORKER_SECRET: bookLabLocalPlaceholder("render-worker-secret"),
  UNSEEN_BOOK_LAB_COLLECTION_NOTICE_VERSION: "local-operable-collection-notice-v1",
  UNSEEN_BOOK_LAB_COLLECTION_NOTICE_HASH: sha256(
    `本机可操作样本：Book Lab 收集须知（非生产文案，仅用于本地演示）。${COLLECTION_NOTICE_CONTEXT_DISCLOSURE}`),
  UNSEEN_BOOK_LAB_COLLECTION_NOTICE_COPY:
    `本机可操作样本：Book Lab 收集须知（非生产文案，仅用于本地演示）。${COLLECTION_NOTICE_CONTEXT_DISCLOSURE}`,
  UNSEEN_BOOK_LAB_GRANT_NOTICE_VERSION: "local-operable-grant-notice-v1",
  UNSEEN_BOOK_LAB_GRANT_NOTICE_HASH: sha256("local-operable-grant-notice-v1")
  // UNSEEN_BOOK_RENDERER_TRANSPORT is intentionally left unset so book-lab.mjs defaults to "inline" —
  // the dedicated renderer sandbox transport is out of scope here and must not be wired through this file.
};
const bookLabEnv = { ...bookLabLocalDefaults, ...process.env };
let bookRuntime = null;
const extensionModuleLoader = bookLabEnabled ? async () => {
  const module = await import("../../services/api/src/extensions/book-lab.mjs");
  return { registerBookLabExtension(input) {
    bookRuntime = module.registerBookLabExtension(input, { env: bookLabEnv });
    return bookRuntime;
  } };
} : undefined;

const api = new LocalApi({ database: databasePath, keyring, mediaStore, worldResults: { signingKey: process.env.WORLD_RESULT_SIGNING_KEY }, publicOrigin: origin,
  ...(otpDeliveryPort ? { otpDelivery: otpDeliveryPort } : { otpSink }), locatorFixture,
  featureFlags: { bookLab: bookLabEnabled, privateAiWorker: privateAiWorkerEnabled },
  privateAi: { tokenHashFile: process.env.UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE,
    promptHash: process.env.UNSEEN_PRIVATE_AI_PROMPT_HASH, policyHash: process.env.UNSEEN_PRIVATE_AI_POLICY_HASH,
    model: process.env.UNSEEN_PRIVATE_AI_MODEL, modelVersion: process.env.UNSEEN_PRIVATE_AI_MODEL_VERSION },
  otpCaptcha: otpCaptchaConfig, otpRateLimits,
  // /healthz's CLIP sidecar probe mirrors this file's own locatorMode switch above: only probes
  // the sidecar's /healthz when this process actually spawned one (locatorMode==="clip_local_sidecar_v1"),
  // reusing the same baseUrl clipSidecarClient itself talks to.
  health: { dataDir: dataRoot,
    clipSidecar: { enabled: locatorMode === "clip_local_sidecar_v1", baseUrl: clipSidecarProcess?.baseUrl,
      timeoutMs: Number(process.env.UNSEEN_CLIP_SIDECAR_HEALTHZ_TIMEOUT_MS ?? 1500) } },
  extensionModuleLoader });
await api.ready;
let privateAiComposition = null;
if (privateAiWorkerEnabled && bookRuntime) {
  privateAiComposition = createPrivateAiComposition({ api, bookRuntime });
  await privateAiComposition.runOnce();
  privateAiComposition.start();
}
const bookRenderWorker = bookRenderWorkerEnabled ? createLocalBookRenderWorker({ api, bookRuntime,
  onError: error => process.stderr.write(`${JSON.stringify({ status: "LOCAL_BOOK_RENDER_ERROR", code: error.code || "render_worker_failed" })}\n`) }) : null;
bookRenderWorker?.start();
await Promise.all([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
  .filter((filename) => existsSync(filename)).map((filename) => chmod(filename, 0o600)));
const canonicalApiHandle = api.handle.bind(api);
api.handle = (request) => {
  const pathname = new URL(request.path ?? request.url, origin).pathname;
  if (request.method === "POST" && /^\/v1\/photos\/[^/]+\/placement-revisions$/.test(pathname) &&
    request.body?.mode === "manual" && request.body.confirmationMode === undefined) {
    request = { ...request, body: { ...request.body, confirmationMode: "manual" } };
  }
  return canonicalApiHandle(request);
};
const apiServer = createLocalHttpServer({ api });
const apiRequestHandler = apiServer.listeners("request")[0];
invariant(typeof apiRequestHandler === "function", "api_handler");
const worker = locatorMode === "clip_local_sidecar_v1"
  ? createClipLocatorWorker({
      api,
      locatorPort: locatorFixture,
      sidecarClient: clipSidecarClient,
      cropBankCache,
      thresholds: clipLocatorThresholds,
      onDispatch(record) { fixtureRecords.push(record); },
      onError(error) {
        fatalWorkerError = { name: error?.name ?? "Error", message: error?.message ?? "clip locator worker failed" };
        process.stderr.write(`${JSON.stringify({ status: "LOCAL_CLIP_LOCATOR_WORKER_FAILED", ...fatalWorkerError })}\n`);
      }
    })
  : createLocalFixtureWorker({
      api,
      config,
      configSha256,
      locatorFixture,
      onDispatch(record) { fixtureRecords.push(record); },
      onError(error) {
        fatalWorkerError = { name: error?.name ?? "Error", message: error?.message ?? "fixture worker failed" };
        process.stderr.write(`${JSON.stringify({ status: "LOCAL_FIXTURE_WORKER_FAILED", ...fatalWorkerError })}\n`);
      }
    });

function accountContext(request) {
  const raw = cookies(request.headers.cookie)["__Host-unseen_account"];
  if (!raw) return null;
  try { return api.core.account(raw); } catch { return null; }
}

function photoProjection(photo, index, { privateMedia = false } = {}) {
  const item = api.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id);
  const original = api.db.prepare("SELECT * FROM assets WHERE id=?").get(photo.asset_id);
  const viewerSafe = api.db.prepare("SELECT * FROM assets WHERE id=?").get(photo.viewer_safe_asset_id);
  const mediaUrl = privateMedia
    ? `/__local-operable/private-media/${encodeURIComponent(photo.id)}`
    : `/v1/viewer/spaces/${encodeURIComponent(photo.space_id)}/photos/${encodeURIComponent(photo.id)}/media`;
  const photoMedia = mediaDescriptor(viewerSafe, mediaUrl);
  return {
    id: photo.id,
    photoId: photo.id,
    title: `照片 ${index + 1}`,
    fileName: `照片 ${index + 1}.jpg`,
    uploader: photo.contributor_principal_id ? "参与者" : "空间成员",
    uploadedAt: photo.uploaded_at,
    contentState: photo.photo_content_state,
    photoContentState: photo.photo_content_state,
    // Video-track follow-up regression fix: this function already re-queries `SELECT * FROM
    // photos ...` one call up (viewerSpaceProjection()), so photo.media_type is on every row
    // here -- it just was never projected into the returned DTO. apps/web's album-grid video
    // corner badge (templates.js albumPage(): `photo.mediaType === "video"`) and the photo
    // detail page's <video> switch both read this camelCase field; without it every real album
    // response silently carried mediaType===undefined regardless of what the photo actually was.
    mediaType: photo.media_type,
    placementState: photo.placement_state,
    confirmationMode: photo.confirmation_mode,
    currentPlacementRevisionId: photo.current_placement_revision_id,
    version: photo.version,
    ifMatch: versionToken({ photo: photo.version, item: item?.version,
      "placement-authorization": item?.placement_authorization_version }),
    itemId: item?.id,
    itemIfMatch: item ? versionToken({ item: item.version }) : undefined,
    receiptId: item ? api.db.prepare("SELECT id FROM batch_receipts WHERE batch_id=?").get(item.batch_id)?.id : undefined,
    uploaderCanEdit: Boolean(item?.uploader_placement_write_enabled),
    canEdit: Boolean(item?.uploader_placement_write_enabled),
    photoAssetId: original?.id,
    photoAssetVersion: original?.version,
    photoRawSha256: original?.raw_sha256,
    ...(photoMedia ? { photoMedia, media: photoMedia, assetUrl: photoMedia.url } : {})
  };
}

function batchProjection(batchId) {
  const batch = api.db.prepare("SELECT * FROM contribution_batches WHERE id=?").get(batchId);
  if (!batch) return null;
  const rows = api.db.prepare("SELECT * FROM contribution_batch_items WHERE batch_id=? ORDER BY rowid").all(batchId);
  const itemsDigest = sha256(canonicalStableJson(rows.map((row) => ({
    itemId: row.id,
    status: row.status,
    version: row.version,
    failureCode: row.failure_code
  }))));
  return {
    id: batch.id,
    batchId: batch.id,
    spaceId: batch.space_id,
    status: batch.status,
    itemCount: batch.item_count,
    committedCount: batch.committed_count,
    failedCount: batch.failed_count,
    version: batch.version,
    ifMatch: versionToken({ batch: batch.version }),
    itemsDigest,
    items: rows.map((row, index) => {
      const photo = row.photo_id ? api.db.prepare("SELECT * FROM photos WHERE id=?").get(row.photo_id) : null;
      return {
        ...(photo ? photoProjection(photo, index, { privateMedia: true }) : {}),
        id: row.id,
        itemId: row.id,
        fileName: `照片 ${index + 1}.jpg`,
        status: row.status,
        failureCode: row.failure_code,
        failureVersion: row.version,
        version: row.version,
        ifMatch: versionToken({ item: row.version, batch: batch.version, space:
          api.db.prepare("SELECT version FROM spaces WHERE id=?").get(batch.space_id)?.version }),
        photoId: row.photo_id,
        contentState: photo?.photo_content_state,
        photoContentState: photo?.photo_content_state,
        placementState: photo?.placement_state,
        confirmationMode: photo?.confirmation_mode,
        uploaderCanEdit: Boolean(row.uploader_placement_write_enabled)
      };
    })
  };
}

function managementProjection(request, spaceId, raw) {
  const space = api.db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  const scene = api.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(spaceId);
  if (!space || !scene) return raw;
  const account = accountContext(request);
  const owner = Boolean(account && account.accountId === space.owner_account_id);
  const allPhotos = api.db.prepare("SELECT * FROM photos WHERE space_id=? AND deleted_at IS NULL ORDER BY rowid").all(spaceId);
  const projected = allPhotos.map((photo, index) => photoProjection(photo, index, { privateMedia: true }));
  const previous = api.db.prepare(`SELECT id FROM panorama_revisions WHERE space_id=? AND id<>?
    ORDER BY ready_at DESC LIMIT 1`).get(spaceId, space.current_panorama_revision_id);
  const campaigns = api.db.prepare("SELECT * FROM external_invitation_campaigns WHERE space_id=? ORDER BY rowid DESC").all(spaceId)
    .map((campaign) => {
      const publicCampaignUrl = `/open/${campaign.public_campaign_id}`;
      return { id: campaign.id, campaignId: campaign.id, publicCampaignUrl,
        qrPayload: publicCampaignUrl, taskMode: campaign.task_mode,
        entryTask: campaign.entry_task, campaignStatus: campaign.campaign_status,
        expiresAt: campaign.expires_at, successfulUseCount: campaign.successful_use_count,
        pendingAdmissionCount: campaign.pending_admission_count,
        maxSuccessfulUses: campaign.max_successful_uses, version: campaign.version,
        ifMatch: versionToken({ campaign: campaign.version }) };
    });
  const panoramaCandidates = api.db.prepare("SELECT * FROM panorama_candidates WHERE space_id=? ORDER BY rowid DESC").all(spaceId)
    .map((candidate, index) => ({ id: candidate.id, candidateId: candidate.id,
      panoramaRevisionId: candidate.panorama_revision_id, status: candidate.status,
      validationCode: candidate.validation_code, version: candidate.version,
      ifMatch: versionToken({ "panorama-candidate": candidate.version }), fileName: `现场 ${index + 1}.jpg` }));
  const memberships = api.db.prepare("SELECT * FROM space_memberships WHERE space_id=? ORDER BY rowid").all(spaceId)
    .map((membership) => {
      const alias = api.db.prepare(`SELECT a.display_mask FROM account_verified_identifiers v
        JOIN account_verified_identifier_aliases a ON a.identifier_equivalence_id=v.identifier_equivalence_id
        WHERE v.account_id=? AND v.status='active' AND a.status='current'`).get(membership.account_id);
      const emailMask = alias?.display_mask ?? "";
      return { id: membership.id, membershipId: membership.id, name: emailMask, emailMask,
        tasks: parseJson(membership.tasks_json, []), managementScopes: parseJson(membership.management_scopes_json, []),
        status: membership.status, version: membership.version,
        ifMatch: versionToken({ membership: membership.version }) };
    });
  const memberInvitations = api.db.prepare("SELECT * FROM member_invitations WHERE space_id=? ORDER BY rowid DESC").all(spaceId)
    .map((invitation) => {
      const alias = api.db.prepare(`SELECT display_mask FROM account_verified_identifier_aliases
        WHERE identifier_equivalence_id=? AND status='current'`).get(invitation.target_identifier_equivalence_id);
      const status = invitation.revoked_at ? "revoked" : invitation.accepted_at ? "accepted"
        : Date.parse(invitation.expires_at) <= api.core.nowMs() ? "expired" : "pending";
      return { id: invitation.id, invitationId: invitation.id, emailMask: alias?.display_mask ?? "",
        tasks: parseJson(invitation.tasks_json, []), managementScopes: parseJson(invitation.management_scopes_json, []),
        status, expiresAt: invitation.expires_at, version: invitation.version,
        ifMatch: versionToken({ "member-invitation": invitation.version }) };
    });
  return {
    ...raw,
    isOwner: owner,
    effectiveCanView: true,
    effectiveCanUpload: true,
    space: {
      id: space.id,
      spaceId: space.id,
      name: space.name,
      spaceLifecycle: space.space_lifecycle,
      collectionState: space.collection_state,
      sharingState: space.sharing_state,
      autoApproveUploads: Boolean(space.auto_approve_uploads),
      currentPanoramaRevisionId: space.current_panorama_revision_id,
      version: space.version,
      ifMatch: versionToken({ space: space.version }),
      scene: {
        id: scene.id,
        artifactReady: scene.scene_readiness === "ready" && Boolean(space.current_panorama_revision_id),
        readiness: scene.scene_readiness,
        mode: scene.scene_mode,
        version: scene.version,
        previousPanoramaRevisionId: previous?.id ?? ""
      }
    },
    // A v2: a confidently auto-placed photo (placement_state='confirmed') must take
    // zero manual touches, so reviewQueue stays exactly "still content-pending/hidden/
    // rejected" — no longer widened to include already-visible-but-unreviewed photos.
    // A photo whose CLIP placement wasn't confident enough ("疑似待复核") surfaces via
    // placementQueue instead, unchanged, whose primary action already opens the
    // placement editor — see managementContent()'s placementTab() in templates.js.
    reviewQueue: projected.filter((photo) => photo.contentState !== "visible"),
    placementQueue: projected.filter((photo) => ["needs_confirmation", "failed", "stale"].includes(photo.placementState)),
    panoramaCandidates,
    campaigns,
    memberships,
    memberInvitations,
    audit: [],
    panoramaNoticeAcknowledgement: { purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }
  };
}

function viewerSpaceProjection(raw) {
  const space = api.db.prepare("SELECT * FROM spaces WHERE id=?").get(raw.spaceId);
  const scene = api.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(raw.spaceId);
  const photoRows = api.db.prepare(`SELECT * FROM photos WHERE space_id=? AND photo_content_state='visible'
    AND deleted_at IS NULL ORDER BY rowid`).all(raw.spaceId);
  const photos = photoRows.map((photo, index) => photoProjection(photo, index));
  // C ("顺手查"): albumPage's "已回到现场 n · 待定位 m" stats row (apps/web/src/ui/templates.js's
  // spaceReturnStats()) reads space.photoCount/pendingPlacementCount off exactly this DTO — neither
  // field existed here before, so every real (non-fixture) album view always showed "0 · 0"
  // regardless of how many photos were actually placed. Counting from the same visible-photo rows
  // already fetched above so this never drifts from what `photos` itself shows.
  const pendingPlacementCount = photoRows.filter((photo) => photo.placement_state !== "confirmed").length;
  // dateLabel has no backing column in the real `spaces` table (services/api has no concept of
  // it yet) — this projection only exists to satisfy the frontend's shape. It must stay a neutral,
  // public-safe label: this is the eyebrow shown at the top of the album/scene pages to *any*
  // visitor who opens the space (including external campaign guests), so it must never leak an
  // internal/operator-only scope marker like "本机可操作样本" (F2 regression).
  return { ...raw, id: raw.spaceId, effectiveCanView: true,
    effectiveCanManage: raw.authBranch === "account", dateLabel: "共同空间",
    scene: { artifactReady: scene?.scene_readiness === "ready", readiness: scene?.scene_readiness,
      mode: scene?.scene_mode, currentPanoramaRevisionId: space?.current_panorama_revision_id },
    photos, photoCount: photoRows.length, pendingPlacementCount };
}

function ticketEnvelope(raw, exactKey, declaredMime, kind) {
  const encodedKey = exactKey.split("/").map(encodeURIComponent).join("/");
  return { url: `${origin}/__local/media/${encodedKey}`, exactPrivateObjectKey: exactKey,
    headers: { "x-upload-ticket": raw, "content-type": declaredMime, ...(kind === "panorama" ? { "x-media-kind": "panorama" } : {}) } };
}

function adaptJsonBody(request, pathname, body) {
  if (!body || typeof body !== "object" || Buffer.isBuffer(body)) return body;
  if (body.error?.code) return { ...body, code: body.error.code };
  const method = request.method;
  let match;
  if (method === "GET" && pathname === "/v1/me/spaces" && Array.isArray(body.spaces)) {
    // C ("顺手查", extended): the home page's continueCard() teaser ring reads
    // this same photoCount/pendingPlacementCount pair (templates.js's
    // spaceReturnStats(), shared with the album page's stats row fixed in
    // viewerSpaceProjection() above — its own comment documents the two are
    // meant to never drift apart). Neither field existed on this list
    // endpoint either, so the teaser ring was silently always "0/0" too.
    return { ...body, spaces: body.spaces.map((space) => {
      const counts = api.db.prepare(`SELECT COUNT(*) total,
        COALESCE(SUM(CASE WHEN placement_state!='confirmed' THEN 1 ELSE 0 END),0) pending
        FROM photos WHERE space_id=? AND photo_content_state='visible' AND deleted_at IS NULL`).get(space.spaceId);
      return { ...space, id: space.spaceId, ifMatch: versionToken({ space: space.version }), isOwner: space.owner,
        photoCount: counts.total, pendingPlacementCount: counts.pending };
    }) };
  }
  if (method === "GET" && (match = /^\/v1\/spaces\/([^/]+)\/upload-context$/.exec(pathname))) {
    const space = api.db.prepare("SELECT version FROM spaces WHERE id=?").get(decodeURIComponent(match[1]));
    return { ...body, effectiveCanUpload: true, acceptedFormats: body.formats,
      maxFiles: body.limits?.batchItems, maxBytesPerFile: body.limits?.photoBytes,
      ifMatch: versionToken({ space: space?.version }) };
  }
  if (method === "GET" && (match = /^\/v1\/spaces\/([^/]+)\/management$/.exec(pathname))) {
    return managementProjection(request, decodeURIComponent(match[1]), body);
  }
  if (method === "GET" && /^\/v1\/viewer\/spaces\/[^/]+$/.test(pathname)) return viewerSpaceProjection(body);
  if (method === "GET" && /^\/v1\/viewer\/spaces\/[^/]+\/photos\/[^/]+$/.test(pathname)) {
    return { ...body, id: body.photoId, title: "照片", uploader: "空间参与者",
      contentState: body.photoContentState, ifMatch: versionToken({ photo: body.version }) };
  }
  if (method === "GET" && /^\/v1\/viewer\/spaces\/[^/]+\/photos\/[^/]+\/scene-context$/.test(pathname) &&
    body.placement) {
    return projectLocalFixtureSceneContext(body);
  }
  if (method === "POST" && /^\/v1\/spaces\/[^/]+\/contribution-batches$/.test(pathname) && body.batchId) {
    const batch = api.db.prepare("SELECT * FROM contribution_batches WHERE id=?").get(body.batchId);
    const space = batch ? api.db.prepare("SELECT version FROM spaces WHERE id=?").get(batch.space_id) : null;
    return { ...body, id: body.batchId, ifMatch: versionToken({ space: space?.version, batch: batch?.version }) };
  }
  if (method === "POST" && /^\/v1\/contribution-batches\/[^/]+\/items$/.test(pathname) && body.itemId) {
    return { ...body, id: body.itemId, ifMatch: versionToken({ item: body.version }) };
  }
  if (method === "POST" && body.uploadSessionId && body.exactPrivateObjectKey &&
    (Object.hasOwn(body, "oneTimeUploadTicket") || Object.hasOwn(body, "exactPrivateUploadTicketOnce"))) {
    const photo = Object.hasOwn(body, "oneTimeUploadTicket");
    const raw = photo ? body.oneTimeUploadTicket : body.exactPrivateUploadTicketOnce;
    if (photo && raw && typeof raw === "object" && typeof raw.url === "string" && raw.headers) {
      const result = { ...body };
      delete result.oneTimeSecret;
      return result;
    }
    const table = photo ? "upload_sessions" : "panorama_upload_sessions";
    const session = api.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(body.uploadSessionId);
    const declared = JSON.parse(session?.declared_metadata_json ?? "{}");
    const envelope = ticketEnvelope(raw, body.exactPrivateObjectKey, declared.mime, photo ? "photo" : "panorama");
    const result = { ...body, ...(photo ? { oneTimeUploadTicket: envelope,
      commitIfMatch: versionToken({ upload: 3, item: body.itemVersion }) } : {
      exactPrivateUploadTicketOnce: envelope, uploadSessionIfMatch: versionToken({ "pano-upload": 3 }) }) };
    delete result.oneTimeSecret;
    return result;
  }
  if (method === "GET" && (match = /^\/v1\/contribution-batches\/([^/]+)\/result$/.exec(pathname))) {
    return batchProjection(decodeURIComponent(match[1])) ?? body;
  }
  if (method === "GET" && pathname === "/v1/batch-receipt") {
    const projected = batchProjection(body.batchId) ?? body;
    const receipt = api.db.prepare("SELECT * FROM batch_receipts WHERE batch_id=?").get(body.batchId);
    const space = api.db.prepare("SELECT version FROM spaces WHERE id=?").get(body.spaceId);
    return { ...body, ...projected, receiptId: receipt?.id, ifMatch: versionToken({ receipt: body.receiptVersion,
      space: space?.version }), bindingNoticeAcknowledgement: JSON.stringify({ purpose: "receipt_account_binding",
      version: 1, contentHash: "local-receipt_account_binding-v1" }) };
  }
  if (method === "GET" && /^\/v1\/batch-receipt\/items\/[^/]+(?:\/placement-edit)?$/.test(pathname)) {
    const photo = body.photoId ? api.db.prepare("SELECT * FROM photos WHERE id=?").get(body.photoId) : null;
    const receipt = photo ? api.db.prepare("SELECT id FROM batch_receipts WHERE batch_id=?").get(photo.batch_id) : null;
    const jar = cookies(request.headers.cookie);
    // A v2 (待复核编辑器的 360 预览缺口修复): UploadService#receiptItem() now returns its own
    // accurate, target-photo-specific sceneContext directly (via ViewerMediaService#
    // editorSceneContext()) — see that method's own comment. `body.sceneContext` is always
    // preferred; the "anchor on the space's first confirmed+visible photo" fallback below only
    // still fires for a response from an *older* build of the real API that doesn't send its
    // own sceneContext yet. Before this preference existed, the anchor lookup ran unconditionally
    // and silently clobbered a correct-but-freshly-added real sceneContext with a *different*
    // photo's borrowed one whenever any other confirmed photo existed in the space — exactly the
    // kind of false "it already works" signal that made this bug hard to pin down originally.
    let sceneContext = body.sceneContext ?? null;
    if (!sceneContext) {
      const anchor = photo ? api.db.prepare(`SELECT * FROM photos WHERE space_id=? AND photo_content_state='visible'
        AND placement_state='confirmed' AND deleted_at IS NULL ORDER BY rowid LIMIT 1`).get(photo.space_id) : null;
      if (anchor) {
        try { sceneContext = api.reads.sceneContext({ accountSession: jar["__Host-unseen_account"],
          viewerSession: jar["__Host-unseen_viewer"] }, anchor.space_id, anchor.id); } catch {}
      }
    }
    sceneContext = projectLocalFixtureSceneContext(sceneContext);
    return { ...(photo ? photoProjection(photo, 0, { privateMedia: true }) : {}), ...body, id: body.itemId,
      batchId: photo?.batch_id, receiptId: receipt?.id, spaceId: photo?.space_id,
      contentState: body.photoContentState,
      uploaderCanEdit: body.canEditPlacement, ifMatch: versionToken({ photo: body.photoVersion,
        item: body.itemVersion, "placement-authorization": body.placementAuthorizationVersion }),
      failureVersion: body.photoVersion, ...(sceneContext ? { sceneContext } : {}) };
  }
  // A v2 fix: GET /v1/photos/{pid}/placement-edit (the *manager's* own direct entry into
  // the editor — services/api/src/placement-service.mjs's editView(), distinct from the
  // uploader-facing /v1/batch-receipt/items/{iid}/placement-edit handled just above) had
  // no projection at all until now, so placementTab()'s "打开位置编辑器" link (the primary
  // action A v2 asks every placement-queue row to have) rendered a broken editor for any
  // manager who isn't also the original uploader — placementEditorPage() needs id/ifMatch/
  // asset/uploaderCanEdit/currentPlacementRevisionId/contentState, none of which editView()
  // returns on its own. Same wrap-with-photoProjection-then-override technique as the
  // uploader-facing handler above.
  if (method === "GET" && /^\/v1\/photos\/[^/]+\/placement-edit$/.test(pathname)) {
    const photo = body.photoId ? api.db.prepare("SELECT * FROM photos WHERE id=?").get(body.photoId) : null;
    const item = photo ? api.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id) : null;
    const receipt = item ? api.db.prepare("SELECT id FROM batch_receipts WHERE batch_id=?").get(item.batch_id) : null;
    const jar = cookies(request.headers.cookie);
    // A v2 (待复核编辑器的 360 预览缺口修复): PlacementService#editView() now returns its own
    // accurate, target-photo-specific sceneContext directly (via ViewerMediaService#
    // editorSceneContext()) — see that method's own comment, and the identical note on the
    // uploader-facing handler above for why `body.sceneContext` must win over the "anchor on the
    // space's first confirmed+visible photo" fallback (kept only for an older API build that
    // doesn't send its own sceneContext yet) rather than being unconditionally overwritten by it.
    let sceneContext = body.sceneContext ?? null;
    if (!sceneContext) {
      const anchor = photo ? api.db.prepare(`SELECT * FROM photos WHERE space_id=? AND photo_content_state='visible'
        AND placement_state='confirmed' AND deleted_at IS NULL ORDER BY rowid LIMIT 1`).get(photo.space_id) : null;
      if (anchor) {
        try { sceneContext = api.reads.sceneContext({ accountSession: jar["__Host-unseen_account"],
          viewerSession: jar["__Host-unseen_viewer"] }, anchor.space_id, anchor.id); } catch {}
      }
    }
    sceneContext = projectLocalFixtureSceneContext(sceneContext);
    return { ...(photo ? photoProjection(photo, 0, { privateMedia: true }) : {}), ...body,
      localFixture: locatorMode === "deterministic_local_fixture",
      id: body.photoId, spaceId: photo?.space_id, batchId: item?.batch_id, itemId: item?.id, receiptId: receipt?.id,
      contentState: photo?.photo_content_state,
      currentPlacementRevisionId: photo?.current_placement_revision_id,
      uploaderCanEdit: Boolean(item?.uploader_placement_write_enabled),
      ifMatch: versionToken({ photo: body.photoVersion, item: body.itemVersion,
        "placement-authorization": body.placementAuthorizationVersion }),
      itemIfMatch: versionToken({ item: body.itemVersion }),
      ...(sceneContext ? { sceneContext } : {}) };
  }
  if (method === "POST" && pathname === "/v1/external-campaign-admissions" && body.invitationBootstrapUrlOnce) {
    const result = { ...body, bootstrapUrl: body.invitationBootstrapUrlOnce };
    delete result.oneTimeSecret;
    return result;
  }
  if (method === "POST" && /^\/v1\/spaces\/[^/]+\/member-invitations$/.test(pathname) && body.invitationBootstrapUrlOnce) {
    const result = { ...body, inviteUrl: body.invitationBootstrapUrlOnce };
    delete result.oneTimeSecret;
    return result;
  }
  if (method === "POST" && /^\/v1\/spaces\/[^/]+\/external-invitation-campaigns$/.test(pathname) && body.campaignId) {
    return { ...body, id: body.campaignId, publicCampaignUrl: new URL(body.publicCampaignUrl).pathname,
      ifMatch: versionToken({ campaign: body.version }) };
  }
  return body;
}

function adaptJsonResponse(request, response, pathname) {
  const originalWriteHead = response.writeHead;
  const originalEnd = response.end;
  let pendingHead = null;
  response.writeHead = function writeHead(statusCode, statusMessage, headers) {
    let message = statusMessage;
    let values = headers;
    if (message && typeof message === "object") { values = message; message = undefined; }
    pendingHead = { statusCode, message, headers: { ...(values ?? {}) } };
    response.statusCode = statusCode;
    return response;
  };
  response.end = function end(chunk, encoding, callback) {
    let output = chunk;
    const text = output == null ? "" : Buffer.from(output).toString("utf8");
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (request.method === "POST" && /^\/v1\/contribution-batches\/[^/]+\/finalizations$/.test(pathname) &&
          parsed.receiptId && parsed.oneTimeSecret) {
          const issued = api.uploads.exchangeReceipt({
            body: { receiptSecretFromClearedBootstrap: parsed.oneTimeSecret, clientNonce: `local-auto-${parsed.receiptId}` },
            idempotencyKey: `local-auto-receipt-${parsed.receiptId}`,
            requestId: `local-auto-receipt-${parsed.receiptId}`,
            selectedPrincipalKind: null
          });
          pendingHead ??= { statusCode: response.statusCode || 200, message: undefined, headers: {} };
          pendingHead.headers["set-cookie"] = [`__Host-unseen_receipt=${issued.receiptSessionSecret}; Path=/; HttpOnly; Secure; SameSite=Strict`];
          parsed.batchResult = batchProjection(parsed.batchResult?.batchId);
          parsed.receiptSessionReady = true;
          delete parsed.oneTimeSecret;
          delete parsed.receiptBootstrapUrlOnce;
        }
        output = JSON.stringify(adaptJsonBody(request, pathname, parsed));
      }
      catch (error) { process.stderr.write(`${JSON.stringify({ status: "LOCAL_ADAPTER_FAILED", route: redactedRoute(pathname), message: error?.message })}\n`); }
    }
    if (pendingHead) {
      const { statusCode, message, headers } = pendingHead;
      if (message === undefined) originalWriteHead.call(response, statusCode, headers);
      else originalWriteHead.call(response, statusCode, message, headers);
    }
    return originalEnd.call(this, output, encoding, callback);
  };
}

function adaptIncomingRequest(request, pathname) {
  const supplied = parseVersionToken(request.headers["if-match"]);
  let match;
  if ((match = /^\/v1\/contribution-batches\/([^/]+)\/items$/.exec(pathname))) {
    const batch = api.db.prepare("SELECT version,space_id FROM contribution_batches WHERE id=?").get(decodeURIComponent(match[1]));
    if (batch) {
      request.headers["if-match"] = String(batch.version);
      request.headers["x-space-version"] = String(supplied.space ??
        api.db.prepare("SELECT version FROM spaces WHERE id=?").get(batch.space_id)?.version);
    }
  } else if (/\/items\/[^/]+\/(?:upload-sessions|retries)$/.test(pathname)) {
    if (supplied.item) request.headers["if-match"] = String(supplied.item);
  } else if (/^\/v1\/upload-sessions\/[^/]+\/commits$/.test(pathname)) {
    if (supplied.upload) request.headers["if-match"] = String(supplied.upload);
    if (supplied.item) request.headers["x-item-version"] = String(supplied.item);
  } else if (/^\/v1\/panorama-upload-sessions\/[^/]+\/commits$/.test(pathname)) {
    if (supplied["pano-upload"]) request.headers["if-match"] = String(supplied["pano-upload"]);
  } else if (/^\/v1\/photos\/[^/]+\/(?:placement-revisions|placement-actions)$/.test(pathname)) {
    const photoId = decodeURIComponent(pathname.split("/")[3]);
    const current = api.db.prepare(`SELECT p.version photo_version,i.version item_version,
      i.placement_authorization_version FROM photos p JOIN contribution_batch_items i ON i.id=p.batch_item_id
      WHERE p.id=?`).get(photoId);
    if (current) {
      request.headers["if-match"] = String(supplied.photo ?? current.photo_version);
      request.headers["x-item-version"] = String(supplied.item ?? current.item_version);
      request.headers["x-placement-authorization-version"] = String(supplied["placement-authorization"] ??
        supplied.placement ?? current.placement_authorization_version);
    }
  } else if (/^\/v1\/photos\/[^/]+\/content-transitions$/.test(pathname)) {
    const photoId = decodeURIComponent(pathname.split("/")[3]);
    const current = api.db.prepare("SELECT version FROM photos WHERE id=?").get(photoId);
    if (current) request.headers["if-match"] = String(supplied.photo ?? current.version);
  } else {
    const first = supplied.space ?? supplied.batch ?? supplied.photo ?? supplied.campaign ?? supplied["panorama-candidate"] ??
      supplied.membership ?? supplied["member-invitation"];
    if (first) request.headers["if-match"] = String(first);
  }
  if (request.method === "POST" && pathname === "/v1/spaces" && !request.headers["notice-acknowledgement"]) {
    request.headers["notice-acknowledgement"] = JSON.stringify({ purpose: "space_create", version: 1,
      contentHash: "local-space_create-v1" });
  }
  if (request.method === "POST" && /\/panorama-candidates$/.test(pathname) && !request.headers["notice-acknowledgement"]) {
    request.headers["notice-acknowledgement"] = JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" });
  }
}

await writeFile(path.join(evidenceRoot, "REQUESTS.ndjson"), "", { mode: 0o600 });
await replaceJson("FIXTURE-MANIFEST.json", {
  schema: "unseen-local-fixture-manifest/1",
  generatedAt: new Date().toISOString(),
  mode: config.fixture.mode,
  isProduction: false,
  releaseId: config.fixture.releaseId,
  configPath: path.relative(repositoryRoot, configPath),
  configSha256,
  visibleLabel: config.fixture.visibleLabel,
  assets: config.fixture.assets,
  panorama: config.panorama
});
await replaceJson("LOCAL-STARTUP.json", {
  schema: "unseen-local-startup/1",
  startedAt: new Date().toISOString(),
  productLabel: config.productLabel,
  status: "starting",
  origin,
  internalListener: origin === listenOrigin ? undefined : "supervised_loopback_child",
  listener: "loopback_only",
  deploymentMode: supervisedMode,
  runtimeId,
  preferredPort,
  portFallback: selectedPort.fallback,
  node: process.version,
  inputs: config.inputs,
  inputCommitsFileSha256: sha256(inputCommitsBytes),
  persistence: { database: path.relative(repositoryRoot, databasePath), media: path.relative(repositoryRoot, mediaRoot),
    keyset: "present_mode_0600", otpMailbox: "local_untracked_mode_0600" },
  apiAdapter: "createLocalHttpServer",
  locatorMode,
  cloudWrites: 0
});

async function serveWeb(pathname, response) {
  let root = webRoot;
  let filename;
  if (pathname === "/__book_lab_web__/catalog.json") {
    root = null;
    filename = bookLabCatalogPath;
    response.setHeader("x-unseen-book-render-generation", process.env.UNSEEN_BOOK_RENDER_GENERATION_ENABLED === "false" ? "paused" : "enabled");
  } else if (pathname.startsWith("/__book_lab_web__/")) {
    root = bookLabWebRoot;
    filename = safeRelative(root, pathname, "/__book_lab_web__");
  } else if (pathname.startsWith("/__viewer__/")) {
    root = viewerRoot;
    filename = safeRelative(root, pathname, "/__viewer__");
  } else {
    filename = safeRelative(root, pathname === "/" ? "/index.html" : pathname);
    try {
      if (!(await stat(filename)).isFile()) filename = path.join(webRoot, "index.html");
    } catch {
      filename = path.join(webRoot, "index.html");
    }
  }
  try {
    let body = await readFile(filename);
    const extension = path.extname(filename);
    const nonce = extension === ".html" ? randomBytes(18).toString("base64") : "";
    if (nonce) {
      const safeConfig = JSON.stringify({ apiBaseUrl: "", localDeterministicLocator: true,
        localOperable: true, featureFlags: { bookLab: bookLabEnabled } }).replaceAll("<", "\\u003c");
      // User-visible copy is intentionally distinct from config.fixture.visibleLabel: that
      // raw label (e.g. "本地定位 fixture：high / 需要确认 / failed") stays exact in
      // FIXTURE-MANIFEST.json, LOCAL-STARTUP.json and /__local-operable/status for ops/evidence
      // use, but the public-facing banner needs plain language while still disclosing the same
      // fact — placement is not a real automated locator.
      const fixtureBannerCopy = locatorMode === "clip_local_sidecar_v1"
        ? "照片方位由 CLIP 自动定位，置信度不够会转人工确认（测试期）"
        : "照片方位由人工确认，非真实定位";
      const fixtureBanner = `<aside class="local-locator-banner" data-local-operable-fixture aria-label="测试版说明"><div class="local-locator-banner-inner"><strong>测试版</strong><span>${fixtureBannerCopy}</span></div></aside>`;
      const html = body.toString("utf8").replaceAll("{{NONCE}}", nonce)
        .replace("</head>", `<script nonce="${nonce}">globalThis.__UNSEEN_CONFIG__=${safeConfig};</script></head>`)
        .replace("<body>", `<body>${fixtureBanner}`);
      body = Buffer.from(html);
    }
    response.writeHead(200, webHeaders(contentTypes[path.extname(filename)] ?? "application/octet-stream", nonce));
    response.end(body);
  } catch {
    response.writeHead(404, webHeaders("text/plain; charset=utf-8"));
    response.end("Not found");
  }
}

function normalizeViewerEtag(response) {
  const original = response.writeHead;
  response.writeHead = function writeHead(statusCode, statusMessage, headers) {
    let message = statusMessage;
    let values = headers;
    if (message && typeof message === "object") { values = message; message = undefined; }
    if (values) {
      values = { ...values };
      for (const key of ["etag", "ETag"]) {
        const value = values[key];
        if (typeof value === "string" && /^"[a-f0-9]{64}"$/i.test(value)) values[key] = value.slice(1, -1);
      }
    }
    return message === undefined ? original.call(this, statusCode, values) : original.call(this, statusCode, message, values);
  };
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  let pathname = "/";
  let routeClass = "unexpected";
  response.once("finish", () => {
    const record = { at: new Date().toISOString(), method: request.method, route: redactedRoute(pathname),
      routeClass, status: response.statusCode, durationMs: Date.now() - startedAt };
    void appendFile(path.join(evidenceRoot, "REQUESTS.ndjson"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
  try {
    const requestUrl = new URL(request.url, origin);
    pathname = requestUrl.pathname;
    response.setHeader("x-unseen-local-operable", "true");
    response.setHeader("x-unseen-runtime-id", runtimeId);
    const expectedHost = new URL(origin).host;
    if (request.headers.host !== expectedHost) {
      response.writeHead(400, jsonHeaders());
      response.end(JSON.stringify({ error: { code: "request_host_invalid" } }));
      return;
    }
    if (request.method === "GET" && ["/__local-operable/status", "/__local/status"].includes(pathname)) {
      routeClass = "localStatus";
      response.writeHead(200, jsonHeaders());
      response.end(JSON.stringify({
        schema: "unseen-local-operable-status/1",
        runtimeId,
        ready: !fatalWorkerError,
        productLabel: config.productLabel,
        origin,
        inputs: config.inputs,
        persistence: { database: existsSync(databasePath), media: existsSync(mediaRoot), keyset: existsSync(keysetPath) },
        otpChallenges: otpEvents,
        otpCaptcha: api.otpCaptcha.provider,
        fixtureRecords,
        fixture: { mode: config.fixture.mode, releaseId: config.fixture.releaseId,
          configSha256, visibleLabel: config.fixture.visibleLabel },
        workerError: fatalWorkerError,
        requestCounts,
        cloudWrites: 0,
        bookLab: { enabled: bookLabEnabled, privateAiWorker: privateAiWorkerEnabled, renderWorker: bookRenderWorkerEnabled, mounted: Boolean(bookRuntime) }
      }));
      return;
    }
    const privateMedia = /^\/__local-operable\/private-media\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && privateMedia) {
      routeClass = "api";
      const photoId = decodeURIComponent(privateMedia[1]);
      const jar = cookies(request.headers.cookie);
      const account = accountContext(request);
      const photo = api.db.prepare("SELECT * FROM photos WHERE id=? AND deleted_at IS NULL").get(photoId);
      invariant(photo, "private_media_unavailable");
      let authorized = false;
      if (account) {
        try { api.core.anyManagement(account, photo.space_id); authorized = true; } catch {}
      }
      if (!authorized && jar["__Host-unseen_contributor"]) {
        try {
          const contributor = api.core.contributor(jar["__Host-unseen_contributor"]);
          authorized = contributor.space.id === photo.space_id && contributor.principal.id === photo.contributor_principal_id;
        } catch {}
      }
      if (!authorized && jar["__Host-unseen_receipt"]) {
        try {
          const receipt = api.core.receipt(jar["__Host-unseen_receipt"]);
          authorized = receipt.batch.id === photo.batch_id;
        } catch {}
      }
      invariant(authorized, "private_media_unavailable");
      const asset = api.db.prepare("SELECT * FROM assets WHERE id=? AND validation_state='valid'").get(photo.viewer_safe_asset_id);
      invariant(asset, "private_media_unavailable");
      const object = await mediaStore.get(asset.private_object_key, { maxBytes: asset.observed_bytes });
      invariant(object.body.length === asset.observed_bytes && object.contentType === asset.observed_mime &&
        sha256(object.body) === asset.raw_sha256, "management_media_integrity");
      response.writeHead(200, { "cache-control": "private, no-store", "content-length": String(object.body.length),
        "content-type": asset.observed_mime, etag: asset.raw_sha256, "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff" });
      response.end(object.body);
      return;
    }
    const bookLabRoute = bookLabEnabled &&
      (pathname.startsWith("/v2-labs/") || pathname.startsWith("/__internal/private-ai/"));
    // These additive contracts are consumed directly by the memory app. The
    // legacy viewer adapter rewrites JSON-shaped response bytes, which would
    // corrupt an arbitrary audio byte range beginning with "{" or "[".
    const momentRoute = /^\/v1\/(?:app-spaces(?:\/|$)|moments(?:\/|$)|moment-media\/|profile$|auth\/password-(?:login|change)$)/.test(pathname);
    const apiRoute = pathname === "/healthz" || pathname.startsWith("/v1/") ||
      pathname === "/__local/media" || pathname.startsWith("/__local/media/") || bookLabRoute;
    if (apiRoute) {
      routeClass = "api";
      if (bookLabRoute && pathname.startsWith("/v2-labs/")) {
        const worker = api.privateAi.observe();
        response.setHeader("x-unseen-private-ai-worker", !worker.enabled ? "disabled" : worker.workerOnline ? "online" : "offline");
      }
      if (!bookLabRoute && !momentRoute) {
        adaptIncomingRequest(request, pathname);
        adaptJsonResponse(request, response, pathname);
        normalizeViewerEtag(response);
      }
      if (pathname.startsWith("/__local/media/") && !pathname.startsWith("/__local/media/direct/")) {
        request.url = "/__local/media";
      }
      await apiRequestHandler(request, response);
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      routeClass = "web";
      await serveWeb(pathname, response);
      return;
    }
    response.writeHead(404, jsonHeaders());
    response.end(JSON.stringify({ error: { code: "route_unavailable" } }));
  } catch (error) {
    response.writeHead(500, jsonHeaders());
    response.end(JSON.stringify({ error: { code: "local_operable_failure" } }));
    process.stderr.write(`${JSON.stringify({ status: "LOCAL_REQUEST_FAILED", message: error?.message })}\n`);
  } finally {
    requestCounts.total += 1;
    requestCounts[routeClass] = (requestCounts[routeClass] ?? 0) + 1;
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, listenHost, () => { server.off("error", reject); resolve(); });
});
worker.start();
await replaceJson("LOCAL-STARTUP.json", {
  ...JSON.parse(await readFile(path.join(evidenceRoot, "LOCAL-STARTUP.json"), "utf8")),
  status: "ready",
  readyAt: new Date().toISOString()
});
process.stdout.write(`${JSON.stringify({ status: "LOCAL_OPERABLE_READY", origin,
  listenOrigin: origin === listenOrigin ? undefined : listenOrigin,
  label: config.fixture.visibleLabel, dataDirectory: dataRoot,
  otpDelivery: otpDeliveryPort ? otpDeliveryPort.name : "local_sink",
  otpCaptcha: api.otpCaptcha.provider,
  bookLab: { enabled: bookLabEnabled, privateAiWorker: privateAiWorkerEnabled, renderWorker: bookRenderWorkerEnabled, mounted: Boolean(bookRuntime) } })}\n`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const started = Date.now();
  await worker.stop();
  if (clipSidecarProcess) await clipSidecarProcess.stop();
  if (privateAiComposition) await privateAiComposition.close();
  if (bookRenderWorker) await bookRenderWorker.close();
  await new Promise((resolve) => server.close(resolve));
  if (bookRuntime) await bookRuntime.close();
  api.close();
  await replaceJson("SHUTDOWN.json", {
    schema: "unseen-local-shutdown/1",
    stoppedAt: new Date().toISOString(),
    signal,
    clean: true,
    durationMs: Date.now() - started,
    fixtureDispatches: fixtureRecords.length,
    requests: requestCounts.total,
    cloudWrites: 0
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  void shutdown(signal).then(() => process.exit(0), (error) => {
    process.stderr.write(`${JSON.stringify({ status: "LOCAL_OPERABLE_SHUTDOWN_FAILED", message: error?.message })}\n`);
    process.exit(1);
  });
});
