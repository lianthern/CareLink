import { registerCommunityCaseRoutes } from './community-case-service.mjs';
import { registerCommunitySpaceRoutes } from './community-space-service.mjs';
import { registerPhotoStoryRoutes } from './photo-story-service.mjs';
import { registerSpacePhotoNoteRoutes } from './space-photo-note-service.mjs';
import { SceneCaptureService, registerSceneCaptureRoutes } from './scene-capture-service.mjs';
import { WorldResultService } from './world-result-service.mjs';
import { AdminService } from './admin-service.mjs';
import { AppSpatialService } from './app-spatial-service.mjs';
import { PersonalMemoryService } from "./personal-memory-service.mjs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { ApiError, assert, errorBody } from "./errors.mjs";
import { openDatabase, transaction } from "./database.mjs";
import { LocalKeyring } from "./crypto.mjs";
import { assertMediaStorePort } from "./ports/media/media-store-port.mjs";
import { MemoryMediaStore } from "./ports/media/memory-media-store.mjs";
import { assertUploadAuthorizationPort, LocalUploadAuthorizationPort } from "./ports/media/upload-authorization-port.mjs";
import { assertDecoderRunnerPort, FfmpegDecoderRunner } from "./ports/media/ffmpeg-decoder-runner.mjs";
import { assertVideoRunnerPort, FfmpegVideoRunner } from "./ports/media/ffmpeg-video-runner.mjs";
import { assertOtpDeliveryPort, otpSinkDeliveryPort } from "./ports/otp/otp-delivery-port.mjs";
import { createOtpCaptchaGate } from "./ports/captcha/index.mjs";
import { OtpDeliveryOutbox } from "./otp-delivery-outbox.mjs";
import { Core } from "./core.mjs";
import { IdentityService } from "./identity-service.mjs";
import { PasswordAccountService } from "./password-account-service.mjs";
import { PasswordRecoveryService } from "./password-recovery-service.mjs";
import { MomentService } from "./moment-service.mjs";
import { IdentityRekeyService } from "./identity-rekey-service.mjs";
import { SpaceService } from "./space-service.mjs";
import { CampaignService } from "./campaign-service.mjs";
import { JobQueue } from "./jobs.mjs";
import { UploadService } from "./upload-service.mjs";
import { PlacementService } from "./placement-service.mjs";
import { PanoramaService } from "./panorama-service.mjs";
import { ReadService } from "./read-service.mjs";
import { CaseService } from "./case-service.mjs";
import { LifecycleService } from "./lifecycle-service.mjs";
import { BindingService } from "./binding-service.mjs";
import { ViewerMediaService } from "./viewer-media-service.mjs";
import { PublicListingService } from "./public-listing-service.mjs";
import { id, json, parseJson, redact, sha256, stableJson } from "./util.mjs";
import { object } from "./schemas.mjs";
import { registerBookLabExtension } from "./extensions/index.mjs";
import { MEDIA_NOTICE_V2_NOTICE } from "./media-notice.mjs";
import { PrivateAiJobQueue } from "./private-ai-job-queue.mjs";
import { aggregateHealthStatus, cachedHealthCheck, checkClipSidecar, checkDatabaseWritable,
  checkDiskSpace } from "./health-checks.mjs";

const require = createRequire(import.meta.url);
const bookLabCoverage = require("../../../packages/contracts/generated/book-lab/action-api-coverage.json");
const BOOK_ROUTE_KEYS = new Set([...bookLabCoverage.actions.map((entry) => `${entry.method} ${entry.endpoint}`),
  "GET /v2-labs/memories/{memoryId}",
  "GET /v2-labs/live/spaces/{spaceId}/books/{bookId}/versions/{versionId}/html",
  "GET /v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/sources",
  "POST /v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/assembly",]);
const BOOK_JOB_ENDPOINTS = new Set(bookLabCoverage.internalOperationCoverage.map((entry) => entry.endpoint));

const sessionFields = ["accountSession", "viewerSession", "contributorSession", "receiptSession", "caseAccessSession",
  "deletionStatusSession"];

function selectSession(ctx, priority) {
  const selected = priority.find((field) => ctx[field]);
  for (const field of sessionFields) if (field !== selected) ctx[field] = null;
  ctx.selectedPrincipalKind = selected ?? null;
  return ctx;
}

function projectRoutePrincipal(ctx, route) {
  const template = route.template;
  if (template.startsWith('/v1/auth/password-reset-') || template === '/v1/auth/recovery-contact-challenges' || template === '/v1/auth/recovery-requests') return selectSession(ctx, []);
  if (template.startsWith("/v2-labs/live/")) return selectSession(ctx, ["accountSession", "viewerSession"]);
  if (template.startsWith("/v2-labs/owner/")) return selectSession(ctx, ["accountSession"]);
  if (template.startsWith("/v2-labs/memories/") || template.startsWith("/v2-labs/books/")) {
    return selectSession(ctx, ["receiptSession", "accountSession"]);
  }
  if (["/v1/external-campaign-admission-challenges", "/v1/external-campaign-admissions",
    "/v1/external-invitation-exchanges", "/v1/external-invitation-campaigns/{token}/preview",
    "/v1/batch-receipt-exchanges"].includes(template)) {
    return selectSession(ctx, []);
  }
  if (template === "/v1/consent-events") return selectSession(ctx,
    ctx.invitationAccess ? ["contributorSession"] : ["accountSession", "contributorSession", "viewerSession", "receiptSession"]);
  if (template === "/v1/reports") return selectSession(ctx, ["accountSession", "viewerSession", "receiptSession"]);
  if (["/v1/reports/{caseId}", "/v1/appeals", "/v1/appeals/{caseId}", "/v1/support-cases/{caseId}"].includes(template)) {
    return selectSession(ctx, ["caseAccessSession", "accountSession", "receiptSession", "viewerSession"]);
  }
  if (template === "/v1/support-cases") return selectSession(ctx, ["accountSession"]);
  if (template === "/v1/deletion-requests/{did}") {
    ctx.selectedPrincipalKind = "deletionStatusByResource";
    return ctx;
  }
  if (template.startsWith("/v1/viewer/")) {
    return selectSession(ctx, ctx.invitationViewer ? ["viewerSession"] : ["accountSession", "viewerSession"]);
  }
  if (template.startsWith("/v1/me/batch-receipt")) return selectSession(ctx, ["accountSession"]);
  if (template.startsWith("/v1/batch-receipt")) return selectSession(ctx, ["receiptSession", "accountSession"]);
  if (template.startsWith("/v1/photos/") && (template.includes("placement") || template.endsWith("/deletion-requests"))) {
    return selectSession(ctx, ctx.accountAccess ? ["accountSession"] : ["receiptSession", "accountSession"]);
  }
  if (template.startsWith('/v1/spaces/{sid}/photos/{pid}/notes') || template === '/v1/spaces/{sid}/photos/{pid}/note-media') {
    return selectSession(ctx,ctx.invitationAccess?['contributorSession']:['accountSession']);
  }
  if (template === "/v1/spaces/{sid}/upload-context" || template.includes("contribution-batches") ||
    template.includes("upload-sessions/{uid}")) {
    return selectSession(ctx, ctx.invitationAccess ? ["contributorSession"] : ["accountSession", "contributorSession"]);
  }
  if (template === "/v1/jobs/{jid}") return selectSession(ctx, ctx.invitationAccess ? ["contributorSession", "receiptSession"] : ["accountSession", "contributorSession", "receiptSession"]);
  return selectSession(ctx, ["accountSession"]);
}

function compile(method, template, handler, { mutation = false, extension = false } = {}) {
  const names = [];
  const source = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{([^}]+)\\\}/g, (_, name) => {
    names.push(name);
    return "([^/]+)";
  });
  return { method, template, mutation, regex: new RegExp(`^${source}$`), names, handler, extension };
}

const BOOK_JSON_HEADERS = new Set(["cache-control", "content-type", "etag"]);
const BOOK_PDF_HEADERS = new Set(["cache-control", "content-disposition", "content-length", "content-type",
  "etag", "x-content-type-options"]);
const BOOK_JSON_ETAG = /^(?:"[a-f0-9]{64}"|"bl1\.[A-Za-z0-9_-]{43}")$/u;

function bookExtensionResponse(response) {
  const invalid = () => { throw new ApiError("book_lab_extension_unavailable", 503); };
  if (!response || typeof response !== "object" || Array.isArray(response) ||
    Object.keys(response).sort().join("\0") !== "body\0headers\0status" ||
    !Number.isSafeInteger(response.status) ||
    !(response.status === 200 || (response.status >= 400 && response.status <= 599)) ||
    !response.headers || typeof response.headers !== "object" || Array.isArray(response.headers)) invalid();
  const headers = { ...response.headers };
  for (const [name, value] of Object.entries(headers)) {
    if (name !== name.toLowerCase() || typeof value !== "string" || value.length > 8192 ||
      /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  }
  const contentType = headers["content-type"];
  const pdf = contentType === "application/pdf";
  const html = contentType === "text/html; charset=utf-8";
  const allowed = pdf ? BOOK_PDF_HEADERS : html ? new Set([...BOOK_JSON_HEADERS, "content-security-policy", "content-length", "x-content-type-options"]) : BOOK_JSON_HEADERS;
  if (Object.keys(headers).some((name) => !allowed.has(name) && !/^x-unseen-[a-z0-9-]+$/u.test(name)) ||
    !["no-store", "no-store, private"].includes(headers["cache-control"])) invalid();
  if (pdf) {
    if (response.status !== 200 || !Buffer.isBuffer(response.body) ||
      headers["x-content-type-options"] !== "nosniff" ||
      headers["content-length"] !== String(response.body.length) ||
      !/^attachment; filename=(?:unseen-book-version-[0-9]{2}\.pdf|"unseen-book-version-[0-9]{2}\.pdf")$/u.test(headers["content-disposition"] ?? "") ||
      !/^"[a-f0-9]{64}"$/u.test(headers.etag ?? "") ||
      !response.body.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
      sha256(response.body) !== headers.etag.slice(1, -1)) invalid();
  } else if (html) {
    if (response.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > 16 * 1024 * 1024 ||
      headers["x-content-type-options"] !== "nosniff" || headers["content-length"] !== String(response.body.length) ||
      headers["content-security-policy"] !== "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'none'" ||
      !/^"[a-f0-9]{64}"$/u.test(headers.etag ?? "") || sha256(response.body) !== headers.etag.slice(1, -1)) invalid();
  } else {
    if (contentType !== "application/json" || Buffer.isBuffer(response.body) || response.body === undefined ||
      (headers.etag !== undefined && !BOOK_JSON_ETAG.test(headers.etag))) invalid();
    try { JSON.stringify(response.body); } catch { invalid(); }
  }
  return { status: response.status, headers: Object.freeze(headers), body: response.body };
}

export const CONTRACT_ROUTES = [
  ["POST", "/v1/auth/otp-verification-challenges"],
  ["POST", "/v1/auth/email-otp-challenges"], ["POST", "/v1/auth/email-otp-verifications"],
  ["GET", "/v1/me"], ["POST", "/v1/auth/reauth-challenges"], ["POST", "/v1/auth/reauth-verifications"],
  ["POST", "/v1/auth/logout"], ["POST", "/v1/auth/logout-all"], ["GET", "/v1/me/spaces"], ["POST", "/v1/spaces"],
  ["POST", "/v1/me/personal-space"],
  ["GET", "/v1/spaces/{sid}/management"], ["POST", "/v1/spaces/{sid}/collection-transitions"],
  ["POST", "/v1/spaces/{sid}/sharing-transitions"], ["POST", "/v1/spaces/{sid}/auto-approve-uploads-transitions"],
  ["PATCH", "/v1/spaces/{sid}/wishes"], ["POST", "/v1/spaces/{sid}/archive"],
  ["POST", "/v1/spaces/{sid}/unarchive"], ["POST", "/v1/spaces/{sid}/member-invitations"],
  ["POST", "/v1/member-invitation-acceptances"], ["POST", "/v1/member-invitations/{iid}/revocations"],
  ["PATCH", "/v1/spaces/{sid}/memberships/{mid}"], ["DELETE", "/v1/spaces/{sid}/memberships/{mid}"],
  ["GET", "/v1/me/owner-transfers"], ["POST", "/v1/spaces/{sid}/owner-transfers"],
  ["POST", "/v1/owner-transfer-acceptances"], ["POST", "/v1/owner-transfers/{tid}/revocations"],
  ["POST", "/v1/spaces/{sid}/external-invitation-campaigns"],
  ["GET", "/v1/spaces/{sid}/external-invitation-campaigns/{cid}"],
  ["POST", "/v1/external-campaign-admission-challenges"], ["POST", "/v1/external-campaign-admissions"],
  ["POST", "/v1/external-invitation-exchanges"], ["GET", "/v1/external-invitation-campaigns/{token}/preview"],
  ["POST", "/v1/external-invitation-campaigns/{cid}/revocations"],
  ["GET", "/v1/viewer/spaces/{sid}"], ["GET", "/v1/viewer/spaces/{sid}/photos/{pid}"],
  ["GET", "/v1/viewer/spaces/{sid}/photos/{pid}/scene-context"],
  ["GET", "/v1/viewer/spaces/{sid}/panorama-revisions/{rid}/media"],
  ["GET", "/v1/viewer/spaces/{sid}/panorama-revisions/{rid}/depth-map"],
  ["GET", "/v1/viewer/spaces/{sid}/photos/{pid}/media"], ["GET", "/v1/viewer/spaces/{sid}/photos/{pid}/video"],
  ["GET", "/v1/spaces/{sid}/upload-context"],
  ["POST", "/v1/spaces/{sid}/contribution-batches"], ["POST", "/v1/contribution-batches/{bid}/items"],
  ["DELETE", "/v1/contribution-batches/{bid}/items/{iid}"], ["POST", "/v1/contribution-batches/{bid}/items/{iid}/upload-sessions"],
  ["POST", "/v1/upload-sessions/{uid}/commits"], ["POST", "/v1/contribution-batches/{bid}/items/{iid}/retries"],
  ["POST", "/v1/contribution-batches/{bid}/finalizations"], ["GET", "/v1/contribution-batches/{bid}/result"],
  ["POST", "/v1/batch-receipt-exchanges"], ["GET", "/v1/batch-receipt"], ["GET", "/v1/batch-receipt/items/{iid}"],
  ["GET", "/v1/batch-receipt/items/{iid}/placement-edit"], ["POST", "/v1/batch-receipt/account-binding-otp-challenges"],
  ["POST", "/v1/batch-receipt/account-bindings"], ["GET", "/v1/me/batch-receipt-bindings"],
  ["POST", "/v1/me/batch-receipt-recoveries"], ["POST", "/v1/batch-receipt/revocations"],
  ["POST", "/v1/batch-receipt/items/{iid}/revocations"], ["POST", "/v1/batch-receipts/{rid}/items/{iid}/placement-reopens"],
  ["POST", "/v1/photos/{pid}/deletion-requests"], ["POST", "/v1/photos/{pid}/content-transitions"],
  ["GET", "/v1/spaces/{sid}/public-listing"], ["POST", "/v1/spaces/{sid}/public-listing-requests"],
  ["GET", "/v1/discover/spaces"],
  ["POST", "/v1/photos/{pid}/placement-revisions"], ["POST", "/v1/photos/{pid}/placement-actions"],
  ["GET", "/v1/photos/{pid}/placement-revisions"], ["GET", "/v1/photos/{pid}/placement-edit"],
  ["GET", "/v1/photos/{pid}/placement-edit/media"],
  ["GET", "/v1/spaces/{sid}/placement-queue"], ["GET", "/v1/spaces/{sid}/review-queue"],
  ["GET", "/v1/spaces/{sid}/management/next-target"], ["POST", "/v1/spaces/{sid}/panorama-candidates"],
  ["POST", "/v1/panorama-upload-sessions/{uid}/commits"], ["GET", "/v1/spaces/{sid}/panorama-candidates/{cid}"],
  ["POST", "/v1/spaces/{sid}/panorama-candidates/{cid}/upload-sessions"],
  ["POST", "/v1/spaces/{sid}/panorama-candidates/{cid}/retries"], ["POST", "/v1/spaces/{sid}/panorama-switches"],
  ["GET", "/v1/spaces/{sid}/panorama-history"], ["GET", "/v1/jobs/{jid}"],
  ["GET", "/v1/notices/current"], ["POST", "/v1/consent-events"], ["POST", "/v1/reports"],
  ["GET", "/v1/reports/{caseId}"], ["POST", "/v1/appeals"], ["GET", "/v1/appeals/{caseId}"],
  ["POST", "/v1/support-cases"], ["GET", "/v1/support-cases/{caseId}"],
  ["POST", "/v1/spaces/{sid}/deletion-requests"], ["POST", "/v1/me/deletion-requests"],
  ["GET", "/v1/deletion-requests/{did}"], ["POST", "/v1/exports"], ["GET", "/v1/exports/{eid}"],
  ["POST", "/v1/exports/{eid}/download-authorizations"], ["GET", "/v1/spaces/{sid}/content-cases"],
  ["GET", "/v1/spaces/{sid}/content-cases/{caseId}"], ["POST", "/v1/spaces/{sid}/content-cases/{caseId}/transitions"],
  ["POST", "/v2-experiments/batch-receipt/items/{iid}/scene-note-jobs"],
  ["POST", "/v2-experiments/batch-receipt/items/{iid}/scene-note-confirmations"],
  ["POST", "/v2-experiments/batch-receipt/items/{iid}/scene-note-withdrawals"]
];

export class LocalApi {
  constructor(options = {}) {
    const database = options.database ?? ":memory:";
    const persistent = database !== ":memory:" || Boolean(options.db);
    assert(!persistent || options.keyring?.persistent === true, "keyset_required", 503);
    assert(!persistent || options.mediaStore?.durable === true, "durable_media_store_required", 503);
    this.keyring = options.keyring ?? new LocalKeyring();
    this.db = options.db ?? openDatabase(database);
    if (persistent) {
      const epochs = [this.keyring.current, ...this.keyring.previous].map((entry) => entry.keyId);
      const placeholders = epochs.map(() => "?").join(",");
      const unreadableMemory = this.db.prepare(`SELECT envelope_key_id FROM personal_memories
        WHERE envelope_key_id NOT IN (${placeholders}) LIMIT 1`).get(...epochs);
      if (unreadableMemory) {
        if (!options.db) this.db.close();
        throw new ApiError("personal_memory_key_retirement_incomplete", 503,
          { action: "Restore the referenced previous keyset, then run identity rekey before retiring it.",
            keyId: unreadableMemory.envelope_key_id });
      }
      const unreadableRecovery = this.db.prepare(`SELECT envelope_key_id FROM password_recovery_requests WHERE envelope_key_id NOT IN (${placeholders}) LIMIT 1`).get(...epochs);
      if (unreadableRecovery) {
        if (!options.db) this.db.close();
        throw new ApiError('password_recovery_key_retirement_incomplete',503);
      }
      const residual = this.db.prepare(`SELECT collision_key_epoch FROM identifier_equivalences
        WHERE status='active' AND collision_key_epoch NOT IN (${placeholders}) LIMIT 1`).get(...epochs);
      assert(!residual, "identity_key_retirement_incomplete", 503);
      const pendingOtp = this.db.prepare(`SELECT payload_key_id FROM otp_delivery_outbox
        WHERE status IN ('queued','running') AND payload_key_id NOT IN (${placeholders}) LIMIT 1`).get(...epochs);
      assert(!pendingOtp, "otp_delivery_key_unavailable", 503);
    }
    this.mediaStore = assertMediaStorePort(options.mediaStore ?? new MemoryMediaStore());
    this.uploadAuthorization = assertUploadAuthorizationPort(options.uploadAuthorization ?? new LocalUploadAuthorizationPort());
    this.decoderRunner = assertDecoderRunnerPort(options.decoderRunner ?? new FfmpegDecoderRunner(options.decoderOptions));
    this.videoDecoderRunner = assertVideoRunnerPort(options.videoDecoderRunner ?? new FfmpegVideoRunner(options.videoDecoderOptions));
    this.clock = options.clock ?? Date;
    this.otpMessages = [];
    // /healthz config (see health-checks.mjs for the tri-state contract). `dataDir` defaults to
    // the sqlite file's own directory -- the disk that actually needs to stay writable -- and
    // falls back to cwd for `:memory:` construction (test fixtures) so every existing call site
    // that never heard of `options.health` keeps getting a real, working disk check for free.
    // clipSidecar defaults to disabled: entrypoints (index.mjs, book-lab deployment-entrypoint.mjs,
    // local-operable.mjs) are the ones reading UNSEEN_LOCATOR_MODE from the environment and opt
    // this in, matching how every other env-derived option already flows into this constructor.
    const health = options.health ?? {};
    this._healthConfig = Object.freeze({
      dataDir: health.dataDir ?? (database !== ":memory:" ? path.dirname(path.resolve(database)) : process.cwd()),
      diskThresholds: Object.freeze({ ...health.diskThresholds }),
      clipSidecar: Object.freeze({ enabled: false, ...health.clipSidecar })
    });
    this._healthCache = cachedHealthCheck(() => this._computeHealth(), { ttlMs: health.cacheTtlMs ?? 10_000 });
    assert(!(options.otpDelivery && options.otpSink), "otp_delivery_provider_ambiguous", 503);
    const otpDelivery = options.otpDelivery ? assertOtpDeliveryPort(options.otpDelivery) :
      options.otpSink ? otpSinkDeliveryPort(options.otpSink) :
      !persistent ? otpSinkDeliveryPort((message) => this.otpMessages.push(message)) : null;
    this.core = new Core({ db: this.db, keyring: this.keyring, clock: this.clock });
    this.otpOutbox = new OtpDeliveryOutbox(this.core, otpDelivery, options.otpRateLimits);
    this.otpCaptcha = createOtpCaptchaGate(this.core, options.otpCaptcha);
    this.identity = new IdentityService(this.core, { otpOutbox: this.otpOutbox, otpCaptcha: this.otpCaptcha });
    this.identityRekey = new IdentityRekeyService(this.core);
    this.spaces = new SpaceService(this.core, this.identity);
    this.personalMemories = new PersonalMemoryService(this.core);
    this.moments = new MomentService(this.core, this.decoderRunner);
    this.appSpatial = new AppSpatialService(this);
    this.passwordAccounts = new PasswordAccountService(this.core, this.identity, this.moments);
    this.adminConsole = new AdminService(this.core, this.passwordAccounts, this.moments);
    this.passwordRecovery = new PasswordRecoveryService(this);
    this.adminConsole.operations.appSpatial = this.appSpatial;
    this.campaigns = new CampaignService(this.core, { publicOrigin: options.publicOrigin });
    this.jobs = new JobQueue(this.core, options.locatorFixture);
    // Constructed ahead of uploads/placements (rather than in its previous, later slot) so both
    // can take it as a dependency for the placement editor's own scene-context projection — see
    // ViewerMediaService#editorSceneContext()'s comment for why that needs to be called from
    // inside an already-authorized read (PlacementService#editView(), UploadService#receiptItem())
    // instead of being reachable through this service's own ctx-authorized public methods.
    this.viewerMedia = new ViewerMediaService(this.core, this.mediaStore);
    this.uploads = new UploadService(this.core, this.mediaStore, this.jobs, this.decoderRunner, this.uploadAuthorization,
      this.viewerMedia, this.videoDecoderRunner);
    this.placements = new PlacementService(this.core, this.jobs, this.viewerMedia);
    this.panoramas = new PanoramaService(this.core, this.mediaStore, this.jobs, this.spaces, this.decoderRunner);
    this.worldResults = new WorldResultService(this, options.worldResults);
    this.viewerMedia.worldResults = this.worldResults;
    this.captures = new SceneCaptureService(this, options.captures);
    this.reads = new ReadService(this.core, this.viewerMedia);
    this.cases = new CaseService(this.core);
    this.lifecycle = new LifecycleService(this.core, this.identity, this.spaces, this.jobs);
    this.bindings = new BindingService(this.core, this.identity, this.spaces);
    this.publicListings = new PublicListingService(this.core);
    this.featureFlags = Object.freeze({ bookLab: options.featureFlags?.bookLab === true,
      privateAiWorker: options.featureFlags?.privateAiWorker === true });
    const privateAi = options.privateAi ?? {};
    this.privateAi = new PrivateAiJobQueue({ core: this.core, mediaStore: this.mediaStore, clock: this.clock,
      readPhotoContext: (photoId) => this.currentBookLabPhoto(photoId), enabled: this.featureFlags.privateAiWorker,
      tokenHashFile: privateAi.tokenHashFile, promptHash: privateAi.promptHash, policyHash: privateAi.policyHash,
      model: privateAi.model, modelVersion: privateAi.modelVersion, leaseMs: privateAi.leaseMs,
      maxAttempts: privateAi.maxAttempts, idleRetryAfterMs: privateAi.idleRetryAfterMs,
      maxRequestsPerMinute: privateAi.maxRequestsPerMinute, tokenHashLoader: privateAi.tokenHashLoader });
    this.extensionModuleLoader = options.extensionModuleLoader;
    this.internalJobs = new Map();
    this.routes = [];
    this.registerRoutes();
    this.seedNotices();
    this.ready = this.mountExtensions();
  }

  seedNotices() {
    transaction(this.db, () => {
      const now = this.core.now();
      const notices = ["space_create", "panorama_upload", "receipt_account_binding", "object_report", "appeal"];
      for (const purpose of notices) this.db.prepare(`INSERT OR IGNORE INTO consent_notices(
        id,purpose,locale,version,content_hash,effective_at
      ) VALUES(?,?, 'zh-CN',1,?,?)`).run(`notice_${purpose}`, purpose, `local-${purpose}-v1`, now);
      this.db.prepare(`INSERT OR IGNORE INTO media_notices(
        id,locale,version,content_hash,policy_json,effective_at
      ) VALUES('media_photo_upload','zh-CN',1,'local-photo-upload-v1',?,?)`).run(json({
        acceptedFormats: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
        maxBytes: 20 * 1024 * 1024, metadataPolicy: "strip-sensitive"
      }), now);
      const captureTimePolicy = {
        acceptedFormats: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
        maxBytes: 20 * 1024 * 1024,
        metadataPolicy: "strip-sensitive-retain-trusted-capture-time",
        retainedMetadata: ["timezone-qualified-original-capture-time"],
        retainedPurposes: ["photo_time", "memory_provenance", "book_provenance"],
        discardedMetadata: ["gps", "device_serial"],
        releaseBlockers: ["legal_approval_capture_time_retention"]
      };
      const captureTimePolicyJson = json(captureTimePolicy);
      this.db.prepare(`INSERT OR IGNORE INTO media_notices(
        id,locale,version,content_hash,policy_json,effective_at
      ) VALUES(?,?,?,?,?,?)`).run(MEDIA_NOTICE_V2_NOTICE.id, MEDIA_NOTICE_V2_NOTICE.locale,
        MEDIA_NOTICE_V2_NOTICE.version, MEDIA_NOTICE_V2_NOTICE.contentHash, captureTimePolicyJson, now);
      this.db.prepare(`UPDATE media_notices SET content_hash=?
        WHERE id=? AND locale=? AND version=? AND content_hash=? AND policy_json=?`).run(
        MEDIA_NOTICE_V2_NOTICE.contentHash, MEDIA_NOTICE_V2_NOTICE.id, MEDIA_NOTICE_V2_NOTICE.locale,
        MEDIA_NOTICE_V2_NOTICE.version, MEDIA_NOTICE_V2_NOTICE.legacyPolicyHash, captureTimePolicyJson);
      const current = this.db.prepare("SELECT * FROM media_notices WHERE locale=? AND version=?").get(
        MEDIA_NOTICE_V2_NOTICE.locale, MEDIA_NOTICE_V2_NOTICE.version);
      assert(current?.id === MEDIA_NOTICE_V2_NOTICE.id &&
        current.content_hash === MEDIA_NOTICE_V2_NOTICE.contentHash && current.policy_json === captureTimePolicyJson,
      "notice_seed_conflict", 503);
    });
  }

  add(method, template, handler) { this.routes.push(compile(method, template, handler, { mutation: method !== "GET" })); }
  account(ctx) { return this.core.account(ctx.accountSession); }

  mountExtensions() {
    if (this.extensionMount) return this.extensionMount;
    const pendingRoutes = [];
    const pendingJobs = [];
    const participants = new WeakSet();
    const owners = new WeakSet();
    const viewers = new WeakSet();
    let active = false;
    let sealed = false;
    const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).sort().join("\0") === keys.join("\0");
    const unavailable = () => { throw new ApiError("book_lab_extension_unavailable", 503); };
    const remember = (set, value) => {
      if (value && typeof value === "object") set.add(value);
      return value;
    };
    const authorized = (set, value) => active && value && typeof value === "object" && set.has(value);
    const input = {
      registerRoutes: (route) => {
        assert(!sealed && exact(route, ["handler", "method", "template"]) && typeof route.handler === "function" &&
          BOOK_ROUTE_KEYS.has(`${route.method} ${route.template}`) &&
          !pendingRoutes.some((entry) => entry.method === route.method && entry.template === route.template) &&
          !this.routes.some((entry) => entry.method === route.method && entry.template === route.template),
        "book_lab_extension_unavailable", 503);
        pendingRoutes.push(route);
      },
      registerInternalJobs: (job) => {
        assert(!sealed && exact(job, ["endpoint", "handler"]) && typeof job.handler === "function" &&
          BOOK_JOB_ENDPOINTS.has(job.endpoint) && !pendingJobs.some((entry) => entry.endpoint === job.endpoint) &&
          !this.internalJobs.has(job.endpoint), "book_lab_extension_unavailable", 503);
        pendingJobs.push(job);
      },
      readCorePhotoContext: (ctx, photoId) => active ? this.readCorePhotoContext(ctx, photoId) : unavailable(),
      authorizeCorePhotoParticipant: (ctx, photoId) => active ?
        this.authorizeCorePhotoParticipant(ctx, photoId) : unavailable(),
      authenticateBookLabParticipant: (ctx) => active ?
        remember(participants, this.authenticateBookLabParticipant(ctx)) : unavailable(),
      readBookLabParticipantPhoto: (principal, photoId) => authorized(participants, principal) ?
        this.readBookLabParticipantPhoto(principal, photoId) : unavailable(),
      listBookLabEligibleBooks: (principal, spaceId) => authorized(participants, principal) ?
        this.listBookLabEligibleBooks(principal, spaceId) : unavailable(),
      readCurrentBookLabOwner: (ctx, spaceId) => active ?
        remember(owners, this.readCurrentBookLabOwner(ctx, spaceId)) : unavailable(),
      revalidateCurrentBookLabOwner: (owner) => authorized(owners, owner) ||
        (owner?.kind === "owner" && authorized(viewers, owner)) ?
        this.revalidateCurrentBookLabOwner(owner) : false,
      readCurrentBookLabViewer: (ctx, spaceId) => active ?
        remember(viewers, this.readCurrentBookLabViewer(ctx, spaceId)) : unavailable(),
      revalidateCurrentBookLabViewer: (viewer) => authorized(viewers, viewer) ?
        this.revalidateCurrentBookLabViewer(viewer) : false,
      readBookLabOwnerSnapshot: (spaceId) => active ?
        remember(owners, this.readBookLabOwnerSnapshot(spaceId)) : unavailable(),
      readBookLabEventForOwner: (owner, eventId) => authorized(owners, owner) ?
        this.readBookLabEventForOwner(owner, eventId) : unavailable(),
      readBookLabDisplayPhoto: (viewer, photoId) => authorized(owners, viewer) || authorized(viewers, viewer) ?
        this.readBookLabDisplayPhoto(viewer, photoId) : unavailable(),
      readBookLabRenderDerivative: (viewer, photoId) => authorized(owners, viewer) || authorized(viewers, viewer) ?
        this.readBookLabRenderDerivative(viewer, photoId) : unavailable(),
      readQuestionSourceForWorker: (query) => active && exact(query, ["contributorId", "photoId"]) ?
        this.readBookLabQuestionSourceForWorker(query) : unavailable(),
      appendAudit: (event) => active ? this.appendBookLabAudit(event) : unavailable(),
      featureFlags: this.featureFlags
    };
    this.extensionMount = Promise.resolve(registerBookLabExtension(input,
      { moduleLoader: this.extensionModuleLoader })).then((result) => {
      if (result.enabled === false) return result;
      sealed = true;
      assert(pendingRoutes.length === BOOK_ROUTE_KEYS.size && pendingJobs.length === BOOK_JOB_ENDPOINTS.size,
        "book_lab_extension_unavailable", 503);
      const routes = pendingRoutes.map((route) => compile(route.method, route.template, route.handler,
        { mutation: route.method !== "GET", extension: true }));
      active = true;
      this.routes.push(...routes);
      for (const job of pendingJobs) this.internalJobs.set(job.endpoint, job.handler);
      return Object.freeze({ enabled: true, mountedRoutes: routes.length, registeredJobs: pendingJobs.length,
        businessWrites: 0, businessBundleImported: true });
    });
    return this.extensionMount;
  }

  dispatchInternalJob(endpoint, input) {
    const handler = this.internalJobs.get(endpoint);
    assert(handler, "book_lab_extension_unavailable", 503);
    return handler(input);
  }

  bookLabAuthInputs(ctx = {}) {
    const headers = ctx.headers ?? {};
    const bearer = typeof headers.authorization === "string" && headers.authorization.startsWith("Bearer ") ?
      headers.authorization.slice(7) : null;
    // A field left `undefined` on ctx means the caller never resolved sessions at all (e.g. a direct,
    // non-HTTP invocation) and headers are the only source of truth. A field explicitly set to `null`
    // means projectRoutePrincipal() already scoped this request to a different session kind for this
    // route; that decision must stand rather than being silently overridden by an unrelated cookie the
    // browser still happens to carry in headers.
    const resolve = (ctxValue, headerValue) => ctxValue !== undefined ? ctxValue : (headerValue ?? null);
    return {
      account: resolve(ctx.accountSession, bearer ?? headers["x-account-session"]),
      receipt: resolve(ctx.receiptSession, headers["x-receipt-session"]),
      viewer: resolve(ctx.viewerSession, headers["x-viewer-session"] ?? headers["x-external-view-session"]),
      contributor: resolve(ctx.contributorSession, headers["x-contributor-session"])
    };
  }

  authenticateBookLabParticipant(ctx) {
    // Identity priority, not existence-based rejection: a photo-contributor/memory-contributor proves
    // ownership "经账号或绑定该照片的 receipt session" (contract §4). A caller may simultaneously carry an
    // unrelated viewer session (came in via an invite link) and/or contributor session (mid-upload) —
    // those identity kinds are not part of this predicate and must not veto an otherwise-valid account
    // or receipt session; the guest flow (viewer + contributor + receipt all present at once) is the
    // normal shape of a real visit, not an attack. account is preferred over receipt when both are
    // present: it is the more durable, revalidatable identity, and projectRoutePrincipal() already
    // prefers receipt for `/v2-labs/memories|books/**` at the routing layer for real HTTP traffic, so
    // this order only matters for direct/non-HTTP callers. Either order is equally safe — the actual
    // authorization boundary is the contributorId match enforced downstream in
    // readBookLabParticipantPhoto()/readBookLabQuestionSourceForWorker(), so picking the "wrong" one of
    // two simultaneously-valid identities only yields a false-negative 404 on that specific photo, never
    // access to someone else's.
    const auth = this.bookLabAuthInputs(ctx);
    try {
      if (auth.account) {
        const account = this.core.account(auth.account);
        return Object.freeze({ kind: "account", authorizationId: account.session.id,
          contributorId: account.accountId, allowedPhotoIds: null, guard: Object.freeze({
            accountId: account.accountId, accountVersion: account.account.version,
            accountSessionId: account.session.id, accountSessionVersion: account.session.version,
            familyId: account.family.id, familyVersion: account.family.version,
            sessionEpoch: account.account.session_epoch
          }) });
      }
      if (auth.receipt) {
        const receipt = this.core.receipt(auth.receipt);
        const contributorId = receipt.batch.contributor_principal_id ?? receipt.batch.actor_id;
        const photoIds = this.core.all(`SELECT p.id FROM photos p JOIN contribution_batch_items i
          ON i.id=p.batch_item_id AND i.batch_id=p.batch_id AND i.space_id=p.space_id
          WHERE p.batch_id=? AND p.space_id=? AND p.deleted_at IS NULL AND i.status='committed'
          AND i.revoked_at IS NULL AND i.deleted_at IS NULL ORDER BY p.id`, receipt.batch.id, receipt.space.id)
          .map((row) => row.id);
        return Object.freeze({ kind: "receipt", authorizationId: receipt.session.id, contributorId,
          allowedPhotoIds: Object.freeze(photoIds), guard: Object.freeze({
            receiptSessionId: receipt.session.id, receiptSessionVersion: receipt.session.version,
            receiptId: receipt.receipt.id, receiptVersion: receipt.receipt.version,
            batchId: receipt.batch.id, batchVersion: receipt.batch.version,
            spaceId: receipt.space.id, spaceVersion: receipt.space.version
          }) });
      }
      return null;
    } catch { return null; }
  }

  currentBookLabParticipant(principal) {
    if (!principal?.guard || !["account", "receipt"].includes(principal.kind)) return false;
    const guard = principal.guard;
    if (principal.kind === "account") {
      const row = this.core.one(`SELECT s.id session_id,s.version session_version,s.issued_session_epoch,s.expires_at,
        s.revoked_at session_revoked_at,f.id family_id,f.version family_version,f.issued_session_epoch family_epoch,
        f.revoked_at family_revoked_at,a.id account_id,a.version account_version,a.session_epoch,a.status
        FROM account_sessions s JOIN account_session_families f ON f.id=s.family_id
        JOIN accounts a ON a.id=s.account_id WHERE s.id=?`, guard.accountSessionId);
      return Boolean(row && row.account_id === guard.accountId && row.account_id === principal.contributorId &&
        row.account_version === guard.accountVersion && row.session_version === guard.accountSessionVersion &&
        row.family_id === guard.familyId && row.family_version === guard.familyVersion &&
        row.session_epoch === guard.sessionEpoch && row.issued_session_epoch === row.session_epoch &&
        row.family_epoch === row.session_epoch && row.status === "active" && !row.session_revoked_at &&
        !row.family_revoked_at && Date.parse(row.expires_at) > this.core.nowMs());
    }
    const row = this.core.one(`SELECT s.id session_id,s.version session_version,s.access_expires_at,
      s.revoked_at session_revoked_at,r.id receipt_id,r.version receipt_version,r.access_expires_at receipt_expires_at,
      r.revoked_at receipt_revoked_at,b.id batch_id,b.version batch_version,b.actor_id,b.contributor_principal_id,
      sp.id space_id,sp.version space_version,sp.space_lifecycle
      FROM receipt_sessions s JOIN batch_receipts r ON r.id=s.batch_receipt_id AND r.batch_id=s.batch_id
      AND r.space_id=s.space_id JOIN contribution_batches b ON b.id=s.batch_id AND b.space_id=s.space_id
      JOIN spaces sp ON sp.id=s.space_id WHERE s.id=?`, guard.receiptSessionId);
    return Boolean(row && row.receipt_id === guard.receiptId && row.receipt_version === guard.receiptVersion &&
      row.batch_id === guard.batchId && row.batch_version === guard.batchVersion && row.space_id === guard.spaceId &&
      row.space_version === guard.spaceVersion && row.session_version === guard.receiptSessionVersion &&
      (row.contributor_principal_id ?? row.actor_id) === principal.contributorId && !row.session_revoked_at &&
      !row.receipt_revoked_at && row.space_lifecycle === "active" &&
      Date.parse(row.access_expires_at) > this.core.nowMs() && Date.parse(row.receipt_expires_at) > this.core.nowMs());
  }

  currentBookLabPhoto(photoId, spaceId = null) {
    const row = this.core.one(`SELECT p.id photo_id,p.space_id,p.asset_id,p.viewer_safe_asset_id,
      p.photo_content_state,p.placement_state,p.confirmation_mode,p.current_placement_revision_id,
      p.version photo_version,p.captured_at,p.deleted_at,i.asset_id item_asset_id,i.status item_status,
      i.revoked_at item_revoked_at,i.deleted_at item_deleted_at,b.actor_id,b.contributor_principal_id,
      a.raw_sha256,a.validation_state,s.scene_id,s.current_panorama_revision_id,s.space_lifecycle,
      sc.scene_readiness,sc.scene_mode,pr.id placement_revision_id,pr.panorama_revision_id,
      pr.placement_state revision_state,pr.confirmation_mode revision_confirmation_mode,
      pr.seq placement_revision_seq,
      pr.yaw,pr.pitch,pr.fov,pr.region,pan.version panorama_version,
      va.id render_asset_id,va.version render_asset_version,va.private_object_key render_object_key,
      va.raw_sha256 render_hash,va.observed_bytes render_bytes,va.observed_mime render_mime,
      va.width render_width,va.height render_height,
      va.validation_state render_validation_state,va.metadata_policy_result render_metadata_policy
      FROM photos p JOIN contribution_batch_items i ON i.id=p.batch_item_id AND i.batch_id=p.batch_id
      JOIN contribution_batches b ON b.id=p.batch_id AND b.space_id=p.space_id
      JOIN assets a ON a.id=p.asset_id AND a.space_id=p.space_id
      JOIN assets va ON va.id=p.viewer_safe_asset_id AND va.space_id=p.space_id AND va.kind='photo_viewer_safe'
      JOIN spaces s ON s.id=p.space_id JOIN scenes sc ON sc.id=s.scene_id AND sc.space_id=s.id
      LEFT JOIN placement_revisions pr ON pr.id=p.current_placement_revision_id AND pr.photo_id=p.id
      LEFT JOIN panorama_revisions pan ON pan.id=pr.panorama_revision_id AND pan.space_id=p.space_id
        AND pan.ready_at IS NOT NULL AND pan.activated_at IS NOT NULL AND pan.retired_at IS NULL
      WHERE p.id=?`, photoId);
    const yaw = Number(row?.yaw);
    const capturedAt = Number.isFinite(Date.parse(row?.captured_at)) &&
      new Date(Date.parse(row.captured_at)).toISOString() === row.captured_at ? row.captured_at : null;
    if (!(row && (!spaceId || row.space_id === spaceId) && !row.deleted_at && !row.item_revoked_at &&
      !row.item_deleted_at && row.item_status === "committed" && row.item_asset_id === row.asset_id &&
      row.validation_state === "valid" && /^[a-f0-9]{64}$/.test(row.raw_sha256 ?? "") &&
      row.space_lifecycle === "active" && row.scene_readiness === "ready" && row.scene_mode === "rotation360" &&
      row.photo_content_state === "visible" && row.placement_state === "confirmed" && row.confirmation_mode !== null &&
      row.current_placement_revision_id === row.placement_revision_id && row.revision_state === "confirmed" &&
      row.revision_confirmation_mode !== null && row.current_panorama_revision_id === row.panorama_revision_id &&
      Number.isSafeInteger(row.panorama_version) && capturedAt && Number.isSafeInteger(row.photo_version) &&
      row.photo_version > 0 && Number.isFinite(yaw) && yaw >= 0 && yaw < 360 &&
      row.render_asset_id === row.viewer_safe_asset_id && row.render_validation_state === "valid" &&
      row.render_metadata_policy === "exif_gps_stripped" && /^[a-f0-9]{64}$/.test(row.render_hash ?? "") &&
      Number.isSafeInteger(row.render_bytes) && row.render_bytes > 0)) return null;
    const provenance = Object.freeze({ spaceId: row.space_id, photoId: row.photo_id, sceneId: row.scene_id,
      panoramaRevisionId: row.panorama_revision_id, placementRevisionId: row.placement_revision_id, nodeId: null,
      sourcePhotosVersion: row.photo_version, yawDegrees: yaw, capturedAt,
      authorId: row.contributor_principal_id ?? row.actor_id, photoContentHash: row.raw_sha256,
      placementSnapshotHash: sha256(stableJson({ confirmationMode: row.revision_confirmation_mode,
        fovDegrees: row.fov, nodeId: null, panoramaRevisionId: row.panorama_revision_id,
        photoId: row.photo_id, pitchDegrees: row.pitch, placementRevisionId: row.placement_revision_id,
        regionId: row.region, yawDegrees: yaw })) });
    return { row, provenance };
  }

  bookLabPhotoDto(current) {
    if (!current) return null;
    return Object.freeze({ photoId: current.row.photo_id,
      contributorId: current.row.contributor_principal_id ?? current.row.actor_id,
      completed: true, deleted: false, withdrawn: false,
      // The exact Book notice binds per-photo L3 authorization; this flag only exposes the accepted private seam.
      l3Enabled: this.featureFlags.privateAiWorker, photoContentState: "visible", deletedAt: null,
      visibleFacts: Object.freeze([]), provenance: current.provenance });
  }

  readBookLabQuestionSourceForWorker({ photoId, contributorId } = {}) {
    if (typeof photoId !== "string" || !photoId || typeof contributorId !== "string" || !contributorId) return null;
    const source = this.bookLabPhotoDto(this.currentBookLabPhoto(photoId));
    return source?.contributorId === contributorId ? source : null;
  }

  readBookLabParticipantPhoto(principal, photoId) {
    if (!this.currentBookLabParticipant(principal) ||
      principal.allowedPhotoIds && !principal.allowedPhotoIds.includes(photoId)) return null;
    const current = this.currentBookLabPhoto(photoId, principal.kind === "receipt" ? principal.guard.spaceId : null);
    const dto = this.bookLabPhotoDto(current);
    return dto?.contributorId === principal.contributorId ? dto : null;
  }

  listBookLabEligibleBooks(principal, spaceId) {
    if (!this.currentBookLabParticipant(principal) ||
      principal.kind === "receipt" && principal.guard.spaceId !== spaceId) return Object.freeze([]);
    // Book records live in the isolated Book store; Core cannot truthfully synthesize them.
    return Object.freeze([]);
  }

  readCurrentBookLabOwner(ctx, spaceId) {
    // space-owner is exclusively account-based (contract §4: currentCoreOwnerBranch); an unrelated
    // receipt/viewer/contributor session the caller also happens to carry (e.g. the owner previously
    // opened their own invite link) is irrelevant to this predicate and must not veto a valid account
    // session — see authenticateBookLabParticipant() above for the identical reasoning.
    const auth = this.bookLabAuthInputs(ctx);
    if (!auth.account) return null;
    try {
      const account = this.core.account(auth.account);
      const access = this.core.accountSpace(account, spaceId, { ownerOnly: true });
      return Object.freeze({ kind: "owner", authorizationId: account.session.id, accountId: account.accountId,
        spaceId, accountSessionId: account.session.id, familyId: account.family.id, guard: Object.freeze({
          accountVersion: account.account.version, accountSessionVersion: account.session.version,
          familyVersion: account.family.version, sessionEpoch: account.account.session_epoch,
          spaceVersion: access.space.version
        }) });
    } catch { return null; }
  }

  revalidateCurrentBookLabOwner(owner) {
    if (owner?.kind !== "owner" || !owner.guard) return false;
    const row = this.core.one(`SELECT sp.id space_id,sp.owner_account_id,sp.space_lifecycle,sp.version space_version,
      a.id account_id,a.status,a.version account_version,a.session_epoch,
      s.id session_id,s.version session_version,s.issued_session_epoch,s.expires_at,s.revoked_at session_revoked_at,
      f.id family_id,f.version family_version,f.issued_session_epoch family_epoch,f.revoked_at family_revoked_at
      FROM spaces sp JOIN accounts a ON a.id=sp.owner_account_id
      LEFT JOIN account_sessions s ON s.id=? AND s.account_id=a.id
      LEFT JOIN account_session_families f ON f.id=s.family_id WHERE sp.id=?`, owner.accountSessionId, owner.spaceId);
    const snapshot = owner.accountSessionId == null;
    return Boolean(row && row.owner_account_id === owner.accountId && row.account_id === owner.accountId &&
      row.status === "active" && row.space_lifecycle === "active" && row.space_version === owner.guard.spaceVersion &&
      row.account_version === owner.guard.accountVersion && row.session_epoch === owner.guard.sessionEpoch &&
      (snapshot || row.session_id === owner.accountSessionId && row.session_version === owner.guard.accountSessionVersion &&
        row.family_id === owner.familyId && row.family_version === owner.guard.familyVersion &&
        row.issued_session_epoch === row.session_epoch && row.family_epoch === row.session_epoch &&
        !row.session_revoked_at && !row.family_revoked_at && Date.parse(row.expires_at) > this.core.nowMs()));
  }

  readCurrentBookLabViewer(ctx, spaceId) {
    // owner-or-current-live-viewer (contract §4) is `(currentCoreOwnerBranch OR ... Account view predicate
    // OR ... external view predicate)` — an OR, not an XOR, and the contract never conditions it on the
    // absence of an unrelated receipt/contributor session. account is preferred over the external viewer
    // session when both are present (e.g. the owner also opened their own invite link): it is the
    // stronger, more specific identity, and the account branch below still enforces its own
    // owner-or-member access check, so preferring it cannot grant anything the caller wasn't already
    // entitled to.
    const auth = this.bookLabAuthInputs(ctx);
    try {
      if (auth.account) {
        const account = this.core.account(auth.account);
        const access = this.core.accountSpace(account, spaceId, { task: "view" });
        if (access.owner) return Object.freeze({ kind: "owner", authorizationId: account.session.id,
          accountId: account.accountId, spaceId, accountSessionId: account.session.id, familyId: account.family.id,
          guard: Object.freeze({ accountVersion: account.account.version,
            accountSessionVersion: account.session.version, familyVersion: account.family.version,
            sessionEpoch: account.account.session_epoch, spaceVersion: access.space.version }) });
        return Object.freeze({ kind: "account_viewer", authorizationId: account.session.id,
          accountId: account.accountId, spaceId, accountSessionId: account.session.id, familyId: account.family.id,
          membershipId: access.membership.id, guard: Object.freeze({ accountVersion: account.account.version,
            accountSessionVersion: account.session.version, familyVersion: account.family.version,
            membershipVersion: access.membership.version, sessionEpoch: account.account.session_epoch,
            spaceVersion: access.space.version }) });
      }
      if (auth.viewer) {
        const viewer = this.core.viewer(auth.viewer);
        if (viewer.space.id !== spaceId) return null;
        return Object.freeze({ kind: "external_viewer", authorizationId: viewer.session.id, spaceId,
          viewerPrincipalId: viewer.principal.id, grantId: viewer.grant.id, campaignId: viewer.campaign.id,
          guard: Object.freeze({ sessionVersion: viewer.session.version, principalVersion: viewer.principal.version,
            grantVersion: viewer.grant.version, campaignVersion: viewer.campaign.version,
            spaceVersion: viewer.space.version }) });
      }
      return null;
    } catch { return null; }
  }

  revalidateCurrentBookLabViewer(viewer) {
    if (viewer?.kind === "owner") return this.revalidateCurrentBookLabOwner(viewer);
    if (!viewer?.guard) return false;
    if (viewer.kind === "account_viewer") {
      const row = this.core.one(`SELECT sp.id space_id,sp.space_lifecycle,sp.version space_version,
        a.id account_id,a.status,a.version account_version,a.session_epoch,
        s.id session_id,s.version session_version,s.issued_session_epoch,s.expires_at,s.revoked_at session_revoked_at,
        f.id family_id,f.version family_version,f.issued_session_epoch family_epoch,f.revoked_at family_revoked_at,
        m.id membership_id,m.version membership_version,m.status membership_status,m.tasks_json
        FROM spaces sp JOIN accounts a ON a.id=? JOIN account_sessions s ON s.id=? AND s.account_id=a.id
        JOIN account_session_families f ON f.id=s.family_id JOIN space_memberships m
        ON m.id=? AND m.space_id=sp.id AND m.account_id=a.id WHERE sp.id=?`, viewer.accountId,
      viewer.accountSessionId, viewer.membershipId, viewer.spaceId);
      return Boolean(row && row.space_lifecycle === "active" && row.status === "active" &&
        row.membership_status === "active" && parseJson(row.tasks_json, []).includes("view") &&
        row.space_version === viewer.guard.spaceVersion && row.account_version === viewer.guard.accountVersion &&
        row.session_version === viewer.guard.accountSessionVersion && row.family_id === viewer.familyId &&
        row.family_version === viewer.guard.familyVersion && row.membership_version === viewer.guard.membershipVersion &&
        row.session_epoch === viewer.guard.sessionEpoch && row.issued_session_epoch === row.session_epoch &&
        row.family_epoch === row.session_epoch && !row.session_revoked_at && !row.family_revoked_at &&
        Date.parse(row.expires_at) > this.core.nowMs());
    }
    if (viewer.kind !== "external_viewer") return false;
    const row = this.core.one(`SELECT s.id session_id,s.version session_version,s.access_expires_at,
      s.revoked_at session_revoked_at,s.campaign_use_ordinal session_ordinal,s.tasks_json session_tasks,
      p.id principal_id,p.version principal_version,p.revoked_at principal_revoked_at,
      p.campaign_use_ordinal principal_ordinal,g.id grant_id,g.version grant_version,g.revoked_at grant_revoked_at,
      g.access_expires_at grant_expires_at,g.campaign_use_ordinal grant_ordinal,g.tasks_json grant_tasks,
      c.id campaign_id,c.version campaign_version,c.campaign_status,c.expires_at campaign_expires_at,
      c.revoked_at campaign_revoked_at,sp.id space_id,sp.version space_version,sp.space_lifecycle,sp.sharing_state
      FROM viewer_sessions s JOIN viewer_principals p ON p.id=s.viewer_principal_id
      JOIN external_invitation_grants g ON g.id=s.grant_id JOIN external_invitation_campaigns c ON c.id=s.campaign_id
      JOIN spaces sp ON sp.id=s.space_id WHERE s.id=?`, viewer.authorizationId);
    return Boolean(row && row.principal_id === viewer.viewerPrincipalId && row.grant_id === viewer.grantId &&
      row.campaign_id === viewer.campaignId && row.space_id === viewer.spaceId &&
      row.session_version === viewer.guard.sessionVersion && row.principal_version === viewer.guard.principalVersion &&
      row.grant_version === viewer.guard.grantVersion && row.campaign_version === viewer.guard.campaignVersion &&
      row.space_version === viewer.guard.spaceVersion && !row.session_revoked_at && !row.principal_revoked_at &&
      !row.grant_revoked_at && !row.campaign_revoked_at && Date.parse(row.access_expires_at) > this.core.nowMs() &&
      Date.parse(row.grant_expires_at) > this.core.nowMs() && Date.parse(row.campaign_expires_at) > this.core.nowMs() &&
      row.space_lifecycle === "active" && row.sharing_state === "shared" &&
      ["active", "exhausted"].includes(row.campaign_status) && row.session_ordinal === row.principal_ordinal &&
      row.principal_ordinal === row.grant_ordinal && parseJson(row.session_tasks, []).includes("view") &&
      parseJson(row.grant_tasks, []).includes("view"));
  }

  readBookLabOwnerSnapshot(spaceId) {
    const row = this.core.one(`SELECT sp.id space_id,sp.owner_account_id,sp.space_lifecycle,sp.version space_version,
      a.status,a.version account_version,a.session_epoch FROM spaces sp JOIN accounts a
      ON a.id=sp.owner_account_id WHERE sp.id=?`, spaceId);
    if (!row || row.space_lifecycle !== "active" || row.status !== "active") return null;
    return Object.freeze({ kind: "owner", authorizationId: row.space_id, accountId: row.owner_account_id,
      spaceId: row.space_id, accountSessionId: null, familyId: null, guard: Object.freeze({
        accountVersion: row.account_version, accountSessionVersion: null, familyVersion: null,
        sessionEpoch: row.session_epoch, spaceVersion: row.space_version
      }) });
  }

  readBookLabEventForOwner(owner, eventId) {
    if (eventId !== owner?.spaceId || !this.revalidateCurrentBookLabOwner(owner)) return null;
    const space = this.core.one(`SELECT id,name,owner_account_id,space_lifecycle,version
      FROM spaces WHERE id=?`, eventId);
    if (!space || space.id !== owner.spaceId || space.owner_account_id !== owner.accountId ||
      space.space_lifecycle !== "active" || space.version !== owner.guard.spaceVersion) return null;
    return Object.freeze({ active: true, eventId: space.id, spaceId: space.id,
      title: space.name, version: space.version });
  }

  async readBookLabDisplayPhoto(viewer, photoId) {
    const currentViewer = viewer?.kind === "owner" ? this.revalidateCurrentBookLabOwner(viewer) :
      this.revalidateCurrentBookLabViewer(viewer);
    if (!currentViewer) return null;
    const photo = this.bookLabPhotoDto(this.currentBookLabPhoto(photoId, viewer.spaceId));
    const renderAsset = photo && await this.readBookLabRenderDerivative(viewer, photoId);
    if (!renderAsset) return null;
    const current = this.bookLabPhotoDto(this.currentBookLabPhoto(photoId, viewer.spaceId));
    if (!current || stableJson(current.provenance) !== stableJson(photo.provenance)) return null;
    return Object.freeze({ ...current, renderAsset });
  }

  async readBookLabRenderDerivative(viewer, photoId) {
    const currentViewer = viewer?.kind === "owner" ? this.revalidateCurrentBookLabOwner(viewer) :
      this.revalidateCurrentBookLabViewer(viewer);
    if (!currentViewer) return null;
    const before = this.currentBookLabPhoto(photoId, viewer.spaceId);
    if (!before || !["image/jpeg", "image/png", "image/webp"].includes(before.row.render_mime) ||
      before.row.render_bytes > 256 * 1024) return null;
    let object;
    try { object = await this.mediaStore.get(before.row.render_object_key, { maxBytes: 256 * 1024 }); }
    catch { return null; }
    const stillCurrent = viewer?.kind === "owner" ? this.revalidateCurrentBookLabOwner(viewer) :
      this.revalidateCurrentBookLabViewer(viewer);
    const after = stillCurrent ? this.currentBookLabPhoto(photoId, viewer.spaceId) : null;
    if (!after || before.row.photo_version !== after.row.photo_version ||
      before.row.render_asset_version !== after.row.render_asset_version || before.row.render_hash !== after.row.render_hash ||
      object.contentType !== before.row.render_mime || object.body.length !== before.row.render_bytes ||
      sha256(object.body) !== before.row.render_hash) return null;
    return Object.freeze({ mimeType: before.row.render_mime, bytesBase64: object.body.toString("base64"),
      contentHash: before.row.render_hash, sourcePhotoContentHash: before.provenance.photoContentHash,
      sourcePhotosVersion: before.provenance.sourcePhotosVersion });
  }

  authorizeCorePhotoParticipant(ctx, photoId) {
    assert(Boolean(ctx.accountSession) !== Boolean(ctx.receiptSession), "photo_unavailable", 404);
    const row = this.core.one(`SELECT p.id photo_id,p.space_id,p.batch_id,p.batch_item_id,p.deleted_at photo_deleted_at,
      p.contributor_principal_id,i.asset_id,i.revoked_at item_revoked_at,i.deleted_at item_deleted_at,
      b.actor_kind,b.actor_id,b.contributor_principal_id batch_contributor_principal_id
      FROM photos p JOIN contribution_batch_items i ON i.id=p.batch_item_id AND i.batch_id=p.batch_id
      JOIN contribution_batches b ON b.id=p.batch_id AND b.space_id=p.space_id WHERE p.id=?`, photoId);
    assert(row, "photo_unavailable", 404);
    let authorization;
    if (ctx.accountSession) {
      const account = this.core.account(ctx.accountSession);
      const bound = row.actor_kind === "account" && row.actor_id === account.accountId ||
        this.core.one(`SELECT 1 FROM receipt_account_bindings rb JOIN batch_receipts r
          ON r.id=rb.batch_receipt_id AND r.batch_id=? AND r.space_id=?
          WHERE rb.account_id=? AND rb.revoked_at IS NULL AND r.revoked_at IS NULL`,
        row.batch_id, row.space_id, account.accountId);
      assert(bound, "photo_unavailable", 404);
      authorization = { kind: "account", authorizationId: account.session.id, accountId: account.accountId };
    } else {
      const receipt = this.core.receipt(ctx.receiptSession);
      assert(receipt.batch.id === row.batch_id && receipt.space.id === row.space_id,
        "photo_unavailable", 404);
      authorization = { kind: "receipt", authorizationId: receipt.session.id, receiptId: receipt.receipt.id };
    }
    assert(!row.photo_deleted_at && !row.item_revoked_at && !row.item_deleted_at, "photo_unavailable", 404);
    return Object.freeze({ ...authorization, photoId: row.photo_id, spaceId: row.space_id,
      contributorId: row.batch_contributor_principal_id ?? row.actor_id });
  }

  readCorePhotoContext(ctx, photoId) {
    const participant = this.authorizeCorePhotoParticipant(ctx, photoId);
    const row = this.core.one(`SELECT p.id photo_id,p.space_id,p.asset_id,p.photo_content_state,p.placement_state,
      p.confirmation_mode,p.current_placement_revision_id,p.version photo_version,p.captured_at,p.deleted_at,
      i.asset_id item_asset_id,i.status item_status,i.revoked_at item_revoked_at,i.deleted_at item_deleted_at,
      a.raw_sha256,a.validation_state,s.scene_id,s.current_panorama_revision_id,s.space_lifecycle,
      sc.scene_readiness,pr.id placement_revision_id,pr.panorama_revision_id,pr.placement_state revision_state,
      pr.confirmation_mode revision_confirmation_mode,pr.yaw,pr.pitch,pr.fov,pr.region
      FROM photos p JOIN contribution_batch_items i ON i.id=p.batch_item_id AND i.batch_id=p.batch_id
      JOIN assets a ON a.id=p.asset_id AND a.space_id=p.space_id
      JOIN spaces s ON s.id=p.space_id JOIN scenes sc ON sc.id=s.scene_id AND sc.space_id=s.id
      LEFT JOIN placement_revisions pr ON pr.id=p.current_placement_revision_id AND pr.photo_id=p.id
      WHERE p.id=?`, photoId);
    const yaw = Number(row?.yaw);
    const capturedAt = Number.isFinite(Date.parse(row?.captured_at)) &&
      new Date(Date.parse(row.captured_at)).toISOString() === row.captured_at ? row.captured_at : null;
    assert(row && participant.spaceId === row.space_id && !row.deleted_at && !row.item_revoked_at &&
      !row.item_deleted_at && row.item_status === "committed" && row.item_asset_id === row.asset_id &&
      row.validation_state === "valid" && /^[a-f0-9]{64}$/.test(row.raw_sha256 ?? "") &&
      row.space_lifecycle === "active" && row.scene_readiness === "ready" &&
      row.photo_content_state === "visible" && row.placement_state === "confirmed" &&
      row.confirmation_mode !== null && row.current_placement_revision_id === row.placement_revision_id &&
      row.revision_state === "confirmed" && row.revision_confirmation_mode !== null &&
      typeof row.current_panorama_revision_id === "string" && row.current_panorama_revision_id.length > 0 &&
      row.current_panorama_revision_id === row.panorama_revision_id && capturedAt &&
      Number.isSafeInteger(row.photo_version) && row.photo_version > 0 && Number.isFinite(yaw) && yaw >= 0 && yaw < 360,
    "photo_unavailable", 404);
    return Object.freeze({
      spaceId: row.space_id,
      photoId: row.photo_id,
      sceneId: row.scene_id,
      panoramaRevisionId: row.panorama_revision_id,
      placementRevisionId: row.placement_revision_id,
      nodeId: null,
      sourcePhotosVersion: row.photo_version,
      yawDegrees: yaw,
      capturedAt,
      authorId: participant.contributorId,
      photoContentHash: row.raw_sha256,
      placementSnapshotHash: sha256(stableJson({ confirmationMode: row.revision_confirmation_mode,
        fovDegrees: row.fov, nodeId: null, panoramaRevisionId: row.panorama_revision_id,
        photoId: row.photo_id, pitchDegrees: row.pitch, placementRevisionId: row.placement_revision_id,
        regionId: row.region, yawDegrees: yaw }))
    });
  }

  appendBookLabAudit(event) {
    const keys = ["actorKind", "aggregateId", "aggregateType", "authorizationId", "detail", "eventType",
      "requestId", "spaceId"];
    assert(event && typeof event === "object" && !Array.isArray(event) &&
      Object.keys(event).sort().join("\0") === keys.sort().join("\0") &&
      /^book_lab(?:_[a-z0-9_]+)?$/.test(event.aggregateType) &&
      /^book_lab_[a-z0-9_]+$/.test(event.eventType) && event.detail &&
      typeof event.detail === "object" && !Array.isArray(event.detail) &&
      Object.entries(event.detail).every(([name, value]) =>
        /(?:Id|Hash|At|Version|Status|Scope|ReasonCode|Count)$/.test(name) &&
        (value === null || ["string", "number", "boolean"].includes(typeof value))),
    "book_lab_extension_unavailable", 503);
    this.core.audit(event);
    return Object.freeze({ appended: true });
  }

  registerRoutes() {
    const add = (m, p, h) => this.add(m, p, h);
    registerCommunityCaseRoutes(this, add);
    registerCommunitySpaceRoutes(this, add);
    registerPhotoStoryRoutes(this, add);
    registerSpacePhotoNoteRoutes(this, add);
    registerSceneCaptureRoutes(this, add);
    add("POST", "/v1/auth/register", c => this.passwordAccounts.register(c));
    add('POST','/v1/auth/password-reset-challenges',c=>this.passwordRecovery.requestChallenge(c));
    add('POST','/v1/auth/password-reset-completions',c=>this.passwordRecovery.complete(c));
    add('POST','/v1/auth/recovery-contact-challenges',c=>this.passwordRecovery.requestChallenge(c,true));
    add('POST','/v1/auth/recovery-requests',c=>this.passwordRecovery.submit(c));
    add('GET','/v1/admin/recovery-requests',c=>this.passwordRecovery.list(c));
    add('POST','/v1/admin/recovery-requests/{id}/review',(c,p)=>this.passwordRecovery.review(c,p.id));
    add("GET", "/v1/admin/overview", c => this.adminConsole.overview(c));
    add("GET", "/v1/admin/accounts", c => this.adminConsole.accounts(c));
    add("GET", "/v1/admin/accounts/{id}", (c,p) => this.adminConsole.inspectAccount(c,p.id));
    add("GET", "/v1/admin/accounts/{id}/moments", (c,p) => this.adminConsole.privateMoments(c,p.id));
    add("GET", "/v1/admin/accounts/{id}/moments/{mid}", (c,p) => this.adminConsole.privateMoment(c,p.id,p.mid));
    add("GET", "/v1/admin/accounts/{id}/moments/{mid}/media/{mediaId}", (c,p) => this.adminConsole.privateMedia(c,p.id,p.mid,p.mediaId,false));
    add("GET", "/v1/admin/accounts/{id}/moments/{mid}/media/{mediaId}/preview", (c,p) => this.adminConsole.privateMedia(c,p.id,p.mid,p.mediaId,true));
    add("GET", "/v1/admin/accounts/{id}/avatar", (c,p) => this.adminConsole.operations.avatar(c,p.id,false));
    add("GET", "/v1/admin/accounts/{id}/avatar/preview", (c,p) => this.adminConsole.operations.avatar(c,p.id,true));
    add("GET", "/v1/admin/accounts/{id}/spaces", (c,p) => this.adminConsole.operations.spaces(c,p.id));
    add("GET", "/v1/admin/accounts/{id}/spaces/{sid}/photos", (c,p) => this.adminConsole.operations.photos(c,p.id,p.sid));
    add("GET", "/v1/admin/accounts/{id}/spaces/{sid}/photos/{pid}/media", (c,p) => this.adminConsole.operations.photoMedia(c,p.id,p.sid,p.pid,"preview"));
    add("GET", "/v1/admin/accounts/{id}/spaces/{sid}/photos/{pid}/video", (c,p) => this.adminConsole.operations.photoMedia(c,p.id,p.sid,p.pid,"video"));
    add("GET", "/v1/admin/accounts/{id}/spaces/{sid}", (c,p) => this.adminConsole.operations.space(c,p.id,p.sid));
    add("GET", "/v1/admin/accounts/{id}/spaces/{sid}/media/{kind}", (c,p) => this.adminConsole.operations.spaceMedia(c,p.id,p.sid,p.kind));
    add("POST", "/v1/admin/accounts/{id}/role", (c,p) => this.adminConsole.operations.role(c,p.id));
    add("GET", "/v1/admin/accounts/{id}/sessions", (c,p) => this.adminConsole.operations.sessions(c,p.id));
    add("POST", "/v1/admin/accounts/{id}/sessions/revoke", (c,p) => this.adminConsole.operations.revokeSessions(c,p.id));
    add("GET", "/v1/admin/accounts/{id}/submissions", (c,p) => this.adminConsole.operations.submissions(c,p.id));
    add("POST", "/v1/admin/accounts/{id}/status", (c,p) => this.adminConsole.status(c,p.id));
    add("GET", "/v1/admin/audit", c => this.adminConsole.actions(c));
    add("POST", "/v1/moments/{id}/submissions", (c,p) => this.adminConsole.submit(c,this.account(c),p.id));
    add("GET", "/v1/me/submissions", c => this.adminConsole.mine(this.account(c)));
    add("POST", "/v1/me/submissions/{id}/withdraw", (c,p) => this.adminConsole.withdraw(c,this.account(c),p.id));
    add("GET", "/v1/admin/submissions", c => this.adminConsole.submissions(c));
    add("GET", "/v1/admin/submissions/{id}", (c,p) => this.adminConsole.detail(c,p.id));
    add("POST", "/v1/admin/submissions/{id}/review", (c,p) => this.adminConsole.review(c,p.id));
    add("POST", "/v1/admin/submissions/{id}/presentation", (c,p) => this.adminConsole.presentation(c,p.id));
    add("GET", "/v1/public/moments", c => this.adminConsole.publicList(c));
    add("GET", "/v1/public/moments/{id}", (c,p) => this.adminConsole.detail(c,p.id,true));
    for (const [prefix, publicRead] of [["/v1/admin/submissions",false],["/v1/public/moments",true]]) {
      add("GET", `${prefix}/{id}/media/{mid}`, (c,p) => this.adminConsole.media(c,p.id,p.mid,false,publicRead));
      add("GET", `${prefix}/{id}/media/{mid}/preview`, (c,p) => this.adminConsole.media(c,p.id,p.mid,true,publicRead));
    }
    add("POST", "/v1/auth/password-login", (c) => this.passwordAccounts.login(c));
    add("POST", "/v1/auth/password-change", (c) => this.passwordAccounts.changePassword(c, this.account(c)));
    add("GET", "/v1/profile", (c) => this.passwordAccounts.profile(this.account(c)));
    add("PATCH", "/v1/profile", (c) => this.passwordAccounts.updateProfile(c, this.account(c)));
    add("GET", "/v1/app-spaces", c => this.appSpatial.list(this.account(c)));
    add("GET", "/v1/app-spaces/{id}", (c, p) => this.appSpatial.get(this.account(c), p.id));
    add("PUT", "/v1/app-spaces/{id}", (c, p) => this.appSpatial.save(c, this.account(c), p.id));
    add("GET", "/v1/app-spaces/{id}/media/{kind}", (c, p) => this.appSpatial.media(this.account(c), p.id, p.kind, c));
    add("GET", "/v1/moments", (c) => this.moments.list(this.account(c)));
    add("GET", "/v1/moments/{id}", (c, p) => this.moments.get(this.account(c), p.id));
    add("PUT", "/v1/moments/{id}", (c, p) => this.moments.save(c, this.account(c), p.id));
    add("PUT", "/v1/moment-media/{id}", (c, p) => this.moments.uploadMedia(c, this.account(c), p.id));
    add("GET", "/v1/moment-media/{id}", (c, p) => this.moments.getMedia(this.account(c), p.id, false, c.headers.range));
    add("GET", "/v1/moment-media/{id}/preview", (c, p) => this.moments.getMedia(this.account(c), p.id, true, c.headers.range));
    add("GET", "/v1/me/memories", (c) => this.personalMemories.list(this.account(c)));
    add("GET", "/v1/me/memories/{id}", (c, p) => this.personalMemories.get(this.account(c), p.id));
    add("POST", "/v1/me/memories/{id}", (c, p) => this.personalMemories.save(c, this.account(c), p.id));
    for (const action of ["trash", "restore"]) {
      add("POST", `/v1/me/memories/{id}/${action}`, (c, p) => this.personalMemories.transition(c, this.account(c), p.id, action));
    }
    // Human-verification front door for requestOtp() below -- not part of the frozen Track 1A
    // action registry (contracts/source/technical/ACTION-API-COVERAGE.json), the same "bespoke,
    // additive endpoint the web client calls directly" shape as POST /v1/me/personal-space just
    // above ensurePersonal() (see that route's own comment): apps/web/src/api/http-adapter.js
    // calls it straight from a UnseenApiClient method, never through the generic action() dispatch.
    add("POST", "/v1/auth/otp-verification-challenges", (c) => this.identity.requestVerificationChallenge(c));
    add("POST", "/v1/auth/email-otp-challenges", (c) => this.identity.requestOtp(c));
    add("POST", "/v1/auth/email-otp-verifications", (c) => this.identity.verifyOtp(c));
    add("GET", "/v1/me", (c) => this.identity.me(this.account(c)));
    add("POST", "/v1/auth/reauth-challenges", (c) => this.identity.requestReauth(c, this.account(c)));
    add("POST", "/v1/auth/reauth-verifications", (c) => this.identity.verifyReauth(c, this.account(c)));
    add("POST", "/v1/auth/logout", (c) => this.identity.logout(c, this.account(c)));
    add("POST", "/v1/auth/logout-all", (c) => this.identity.logoutAll(c, this.account(c)));
    add("POST", "/v1/spaces/{sid}/world-results", (c, p) => this.worldResults.save(c, this.account(c), p.sid));
    add("GET", "/v1/viewer/spaces/{sid}/world-results/{rid}/media/{kind}", (c, p) => this.worldResults.media(c, p.sid, p.rid, p.kind));
    add("GET", "/v1/me/spaces", (c) => this.spaces.list(this.account(c), c.query.lifecycle));
    add("POST", "/v1/spaces", (c) => this.spaces.create(c, this.account(c)));
    // v3.1 "传到我的空间": not part of the frozen SPACE.CREATE action contract —
    // a bespoke, additive endpoint the web client calls directly (see
    // apps/web/src/api/http-adapter.js ensurePersonalSpace()) to lazily
    // provision/find the caller's one personal default space.
    add("POST", "/v1/me/personal-space", (c) => this.spaces.ensurePersonal(c, this.account(c)));
    add("GET", "/v1/spaces/{sid}/management", (c, p) => {
      const result = this.spaces.management(this.account(c), p.sid);
      result.worldImportConfigured = Boolean(this.worldResults.key);
      if (result.scopes.includes("canInvite")) result.campaigns = this.core.all(
        "SELECT * FROM external_invitation_campaigns WHERE space_id=? ORDER BY rowid DESC", p.sid).map(row => this.campaigns.shareRow(row));
      return result;
    });
    add("GET", "/v1/spaces/{sid}/management/next-target", (c, p) => this.spaces.nextTarget(this.account(c), p.sid, c.query));
    add("POST", "/v1/spaces/{sid}/collection-transitions", (c, p) => this.spaces.transitionCollection(c, this.account(c), p.sid));
    add("POST", "/v1/spaces/{sid}/sharing-transitions", (c, p) => this.spaces.transitionSharing(c, this.account(c), p.sid));
    add("POST", "/v1/spaces/{sid}/auto-approve-uploads-transitions", (c, p) => this.spaces.transitionAutoApproveUploads(c, this.account(c), p.sid));
    add("PATCH", "/v1/spaces/{sid}/wishes", (c, p) => this.spaces.updateWishes(c, this.account(c), p.sid));
    add("POST", "/v1/spaces/{sid}/archive", (c, p) => this.spaces.archive(c, this.account(c), p.sid));
    add("POST", "/v1/spaces/{sid}/unarchive", (c, p) => this.spaces.unarchive(c, this.account(c), p.sid));
    add("POST", "/v1/spaces/{sid}/member-invitations", (c, p) => this.spaces.createMemberInvitation(c, this.account(c), p.sid));
    add("POST", "/v1/member-invitation-acceptances", (c) => this.spaces.acceptMemberInvitation(c, this.account(c)));
    add("POST", "/v1/member-invitations/{iid}/revocations", (c, p) => this.spaces.revokeMemberInvitation(c, this.account(c), p.iid));
    add("PATCH", "/v1/spaces/{sid}/memberships/{mid}", (c, p) => this.spaces.updateMembership(c, this.account(c), p.sid, p.mid));
    add("DELETE", "/v1/spaces/{sid}/memberships/{mid}", (c, p) => this.spaces.revokeMembership(c, this.account(c), p.sid, p.mid));
    add("GET", "/v1/me/owner-transfers", (c) => this.spaces.listOwnerTransfers(this.account(c)));
    add("POST", "/v1/spaces/{sid}/owner-transfers", (c, p) => this.spaces.createOwnerTransfer(c, this.account(c), p.sid));
    add("POST", "/v1/owner-transfer-acceptances", (c) => this.spaces.acceptOwnerTransfer(c, this.account(c)));
    add("POST", "/v1/owner-transfers/{tid}/revocations", (c, p) => this.spaces.revokeOwnerTransfer(c, this.account(c), p.tid));
    add("POST", "/v1/spaces/{sid}/external-invitation-campaigns", (c, p) => this.campaigns.create(c, this.account(c), p.sid));
    add("GET", "/v1/spaces/{sid}/external-invitation-campaigns/{cid}", (c, p) => this.campaigns.get(this.account(c), p.sid, p.cid));
    add("POST", "/v1/external-campaign-admission-challenges", (c) => this.campaigns.challenge(c));
    add("POST", "/v1/external-campaign-admissions", (c) => this.campaigns.admission(c));
    add("POST", "/v1/external-invitation-exchanges", (c) => this.campaigns.exchange(c));
    add("GET", "/v1/external-invitation-campaigns/{token}/preview", (c, p) => this.campaigns.preview(c, p.token));
    add("POST", "/v1/external-invitation-campaigns/{cid}/revocations", (c, p) => this.campaigns.revoke(c, this.account(c), p.cid));
    add("GET", "/v1/viewer/spaces/{sid}", (c, p) => this.reads.viewerSpace(c, p.sid));
    add("GET", "/v1/viewer/spaces/{sid}/photos/{pid}", (c, p) => this.reads.photo(c, p.sid, p.pid));
    add("GET", "/v1/viewer/spaces/{sid}/photos/{pid}/scene-context", (c, p) => this.reads.sceneContext(c, p.sid, p.pid));
    add("GET", "/v1/viewer/spaces/{sid}/panorama-revisions/{rid}/media",
      (c, p) => this.viewerMedia.panorama(c, p.sid, p.rid));
    add("GET", "/v1/viewer/spaces/{sid}/panorama-revisions/{rid}/depth-map",
      (c, p) => this.viewerMedia.depthMap(c, p.sid, p.rid));
    add("GET", "/v1/viewer/spaces/{sid}/photos/{pid}/media", (c, p) => this.viewerMedia.photo(c, p.sid, p.pid));
    add("GET", "/v1/viewer/spaces/{sid}/photos/{pid}/album-media", (c, p) => this.viewerMedia.albumPhoto(c, p.sid, p.pid));
    add("GET", "/v1/viewer/spaces/{sid}/photos/{pid}/video", (c, p) => this.viewerMedia.video(c, p.sid, p.pid));
    add("GET", "/v1/spaces/{sid}/upload-context", (c, p) => this.uploads.uploadContext(c, p.sid));
    add("POST", "/v1/consent-events", (c) => this.uploads.consent(c));
    add("POST", "/v1/spaces/{sid}/contribution-batches", (c, p) => this.uploads.createBatch(c, p.sid));
    add("POST", "/v1/contribution-batches/{bid}/items", (c, p) => this.uploads.addItem(c, p.bid));
    add("DELETE", "/v1/contribution-batches/{bid}/items/{iid}", (c, p) => this.uploads.removeItem(c, p.bid, p.iid));
    add("POST", "/v1/contribution-batches/{bid}/items/{iid}/upload-sessions", (c, p) => this.uploads.authorizeUpload(c, p.bid, p.iid));
    add("POST", "/v1/upload-sessions/{uid}/commits", (c, p) => this.uploads.commit(c, p.uid));
    add("POST", "/v1/contribution-batches/{bid}/items/{iid}/retries", (c, p) => this.uploads.retryItem(c, p.bid, p.iid));
    add("POST", "/v1/contribution-batches/{bid}/finalizations", (c, p) => this.uploads.finalize(c, p.bid));
    add("GET", "/v1/contribution-batches/{bid}/result", (c, p) => this.uploads.result(c, p.bid));
    add("POST", "/v1/batch-receipt-exchanges", (c) => this.uploads.exchangeReceipt(c));
    add("GET", "/v1/batch-receipt", (c) => this.uploads.receiptView(c));
    add("GET", "/v1/batch-receipt/items/{iid}", (c, p) => this.uploads.receiptItem(c, p.iid));
    add("GET", "/v1/batch-receipt/items/{iid}/placement-edit", (c, p) => this.uploads.receiptItem(c, p.iid));
    add("POST", "/v1/batch-receipt/account-binding-otp-challenges", (c) => this.bindings.request(c));
    add("POST", "/v1/batch-receipt/account-bindings", (c) => this.bindings.confirm(c));
    add("GET", "/v1/me/batch-receipt-bindings", (c) => this.bindings.list(this.account(c)));
    add("POST", "/v1/me/batch-receipt-recoveries", (c) => this.bindings.recover(c, this.account(c)));
    add("POST", "/v1/batch-receipt/revocations", (c) => this.uploads.revokeReceipt(c));
    add("POST", "/v1/batch-receipt/items/{iid}/revocations", (c, p) => this.uploads.revokeItem(c, p.iid));
    add("POST", "/v1/batch-receipts/{rid}/items/{iid}/placement-reopens", (c, p) => this.placements.reopen(c, this.account(c), p.rid, p.iid));
    add("GET", "/v1/photos/{pid}/placement-edit", (c, p) => this.placements.editView(c, p.pid));
    add("GET", "/v1/photos/{pid}/placement-edit/media", (c, p) => this.placements.editorMedia(c, p.pid));
    add("GET", "/v1/photos/{pid}/placement-revisions", (c, p) => this.placements.history(c, p.pid));
    add("POST", "/v1/photos/{pid}/placement-revisions", (c, p) => this.placements.revision(c, p.pid));
    add("POST", "/v1/photos/{pid}/placement-actions", (c, p) => this.placements.action(c, p.pid));
    add("POST", "/v1/photos/{pid}/content-transitions", (c, p) => this.placements.content(c, this.account(c), p.pid));
    add("GET", "/v1/spaces/{sid}/placement-queue", (c, p) => ({ items: this.spaces.management(this.account(c), p.sid).queues.placement ?? [] }));
    add("GET", "/v1/spaces/{sid}/review-queue", (c, p) => ({ items: this.spaces.management(this.account(c), p.sid).queues.review ?? [] }));
    add("POST", "/v1/spaces/{sid}/panorama-candidates", (c, p) => this.panoramas.create(c, this.account(c), p.sid));
    add("POST", "/v1/panorama-upload-sessions/{uid}/commits", (c, p) => this.panoramas.commit(c, this.account(c), p.uid));
    add("GET", "/v1/spaces/{sid}/panorama-candidates/{cid}", (c, p) => this.panoramas.status(this.account(c), p.sid, p.cid));
    add("POST", "/v1/spaces/{sid}/panorama-candidates/{cid}/upload-sessions", (c, p) => this.panoramas.reissue(c, this.account(c), p.sid, p.cid));
    add("POST", "/v1/spaces/{sid}/panorama-candidates/{cid}/retries", (c, p) => this.panoramas.retry(c, this.account(c), p.sid, p.cid));
    add("POST", "/v1/spaces/{sid}/panorama-switches", (c, p) => this.panoramas.switch(c, this.account(c), p.sid));
    add("GET", "/v1/spaces/{sid}/panorama-history", (c, p) => this.panoramas.history(this.account(c), p.sid));
    add("GET", "/v1/jobs/{jid}", (c, p) => this.jobStatus(c, p.jid));
    add("GET", "/v1/notices/current", (c) => this.notice(c));
    add("POST", "/v1/reports", (c) => this.cases.report(c));
    add("GET", "/v1/reports/{caseId}", (c, p) => this.cases.status(c, p.caseId, "report"));
    add("POST", "/v1/appeals", (c) => this.cases.appeal(c));
    add("GET", "/v1/appeals/{caseId}", (c, p) => this.cases.status(c, p.caseId, "appeal"));
    add("POST", "/v1/support-cases", (c) => this.cases.support(c));
    add("GET", "/v1/support-cases/{caseId}", (c, p) => this.cases.status(c, p.caseId, "support"));
    add("GET", "/v1/spaces/{sid}/content-cases", (c, p) => this.caseList(c, p.sid));
    add("GET", "/v1/spaces/{sid}/content-cases/{caseId}", (c, p) => this.caseDetail(c, p.sid, p.caseId));
    add("POST", "/v1/spaces/{sid}/content-cases/{caseId}/transitions", (c, p) => this.cases.transition(c, this.account(c), p.sid, p.caseId));
    add("POST", "/v1/exports", (c) => this.lifecycle.createExport(c, this.account(c)));
    add("GET", "/v1/exports/{eid}", (c, p) => this.lifecycle.exportStatus(this.account(c), p.eid));
    add("POST", "/v1/exports/{eid}/download-authorizations", (c, p) => this.lifecycle.download(c, this.account(c), p.eid));
    add("GET", "/v1/exports/{eid}/downloads", (c, p) =>
      this.lifecycle.downloadArtifact(c, this.account(c), p.eid, c.exportDownload));
    add("POST", "/v1/spaces/{sid}/deletion-requests", (c, p) => this.lifecycle.deleteSpace(c, this.account(c), p.sid));
    add("POST", "/v1/me/deletion-requests", (c) => this.lifecycle.deleteAccount(c));
    add("GET", "/v1/deletion-requests/{did}", (c, p) => this.lifecycle.deletionStatus(c, p.did));
    add("POST", "/v1/photos/{pid}/deletion-requests", (c, p) => this.photoDeletion(c, p.pid));
    add("GET", "/v1/spaces/{sid}/public-listing", (c, p) => this.publicListings.status(this.account(c), p.sid));
    add("POST", "/v1/spaces/{sid}/public-listing-requests", (c, p) => this.publicListings.request(c, this.account(c), p.sid));
    add("GET", "/v1/discover/spaces", () => this.publicListings.discover());
    for (const endpoint of ["scene-note-jobs", "scene-note-confirmations", "scene-note-withdrawals"]) {
      add("POST", `/v2-experiments/batch-receipt/items/{iid}/${endpoint}`, () => { throw new ApiError("experiment_unavailable", 503); });
    }
  }

  notice(ctx) {
    if (["space_create", "panorama_upload"].includes(ctx.query.purpose)) {
      const notice = this.core.one("SELECT * FROM consent_notices WHERE purpose=? AND locale='zh-CN' AND retired_at IS NULL ORDER BY version DESC LIMIT 1", ctx.query.purpose);
      assert(notice, "notice_unavailable", 404);
      return { purpose: notice.purpose, locale: notice.locale, version: notice.version,
        contentHash: notice.content_hash, hash: notice.content_hash, effectiveAt: notice.effective_at };
    }
    assert(ctx.query.purpose === "photo_upload", "notice_unavailable", 404);
    const notice = this.core.one("SELECT * FROM media_notices WHERE locale='zh-CN' ORDER BY version DESC LIMIT 1");
    assert(notice?.id === MEDIA_NOTICE_V2_NOTICE.id && notice.version === MEDIA_NOTICE_V2_NOTICE.version &&
      notice.content_hash === MEDIA_NOTICE_V2_NOTICE.contentHash, "notice_unavailable", 503);
    return { purpose: "photo_upload", locale: notice.locale, version: notice.version, hash: notice.content_hash,
      effectiveAt: notice.effective_at, ...JSON.parse(notice.policy_json) };
  }

  jobStatus(ctx, jobId) {
    const row = this.core.one("SELECT * FROM jobs WHERE id=?", jobId);
    assert(row, "job_unavailable", 404);
    if (ctx.accountSession) {
      const account = this.account(ctx);
      if (row.type === "export_generation") {
        const refs = JSON.parse(row.input_refs_json);
        assert(refs.accountId === account.accountId, "job_unavailable", 404);
        if (refs.spaceId) this.core.accountSpace(account, refs.spaceId, { ownerOnly: true, allowArchived: true });
      } else this.core.accountSpace(account, row.space_id);
    }
    else if (ctx.contributorSession) {
      const contributor = this.core.contributor(ctx.contributorSession);
      assert(contributor.space.id === row.space_id, "job_unavailable", 404);
    } else if (ctx.receiptSession) {
      const receipt = this.core.receipt(ctx.receiptSession);
      assert(receipt.space.id === row.space_id, "job_unavailable", 404);
    } else throw new ApiError("job_unavailable", 404);
    return this.jobs.get(jobId);
  }

  caseList(ctx, spaceId) {
    this.core.accountSpace(this.account(ctx), spaceId, { scope: "canReview" });
    return { cases: this.core.all("SELECT id caseId,case_type caseType,target_type targetType,status,category,version FROM content_cases WHERE space_id=? ORDER BY created_at", spaceId) };
  }

  caseDetail(ctx, spaceId, caseId) {
    this.core.accountSpace(this.account(ctx), spaceId, { scope: "canReview" });
    const row = this.core.one("SELECT id caseId,case_type caseType,target_type targetType,status,category,decision_reason_code decisionReasonCode,version FROM content_cases WHERE id=? AND space_id=?", caseId, spaceId);
    assert(row, "case_unavailable", 404);
    return row;
  }

  photoDeletion(ctx, photoId) {
    const body = object(ctx.body, ["reason", "reauthGrant"], ["reason"]);
    const photo = this.core.one("SELECT * FROM photos WHERE id=? AND deleted_at IS NULL", photoId);
    assert(photo, "photo_unavailable", 404);
    let account = null;
    let receipt = null;
    if (ctx.accountSession) account = this.account(ctx);
    else {
      receipt = this.core.receipt(ctx.receiptSession);
      const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=? AND batch_id=? AND space_id=?",
        photo.batch_item_id, photo.batch_id, photo.space_id);
      assert(receipt.batch.id === photo.batch_id && receipt.space.id === photo.space_id && item &&
        item.photo_id === photo.id && item.contributor_principal_id === photo.contributor_principal_id,
      "photo_unavailable", 404);
    }
    return this.core.mutation(ctx, { endpoint: `/v1/photos/${photoId}/deletion-requests`, scope: account?.session.id ?? receipt.session.id,
      replayClass: "completed_state", reauthorize: () => {
        const currentPhoto = this.core.one("SELECT * FROM photos WHERE id=?", photoId);
        assert(currentPhoto && currentPhoto.space_id === photo.space_id, "photo_unavailable", 404);
        return account ? this.core.accountSpace(this.core.account(ctx.accountSession), currentPhoto.space_id,
          { ownerOnly: true }) : this.core.receipt(ctx.receiptSession);
      } }, () => {
      this.core.requireIfMatch(ctx, photo);
      this.lifecycle.deletePhoto(ctx, account, photo, body.reauthGrant);
      const result = this.lifecycle.recordDeletion(ctx, { scopeType: "photo", scopeId: photo.id,
        requester: { accountId: account?.accountId ?? null, receiptSessionId: receipt?.session.id ?? null } });
      this.core.audit({ spaceId: photo.space_id, aggregateType: "photo", aggregateId: photo.id,
        eventType: "photo_deletion_requested", actorKind: account ? "account" : "receipt_session",
        authorizationId: account?.session.id ?? receipt.session.id, detail: { deletionId: result.deletionId }, requestId: ctx.requestId });
      return result;
    });
  }

  context(request, url) {
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const authorization = headers.authorization?.startsWith("Bearer ") ? headers.authorization.slice(7) : null;
    return {
      body: request.body ?? {}, headers, requestId: headers["x-request-id"] ?? randomUUID(),
      idempotencyKey: headers["idempotency-key"], ifMatch: headers["if-match"]?.replaceAll('"', ""),
      itemVersion: headers["x-item-version"], batchVersion: headers["x-batch-version"],
      spaceVersion: headers["x-space-version"], placementAuthorizationVersion: headers["x-placement-authorization-version"],
      accountSession: authorization ?? headers["x-account-session"], viewerSession: headers["x-viewer-session"],
      contributorSession: headers["x-contributor-session"], receiptSession: headers["x-receipt-session"],
      caseAccessSession: headers["x-case-access-session"], challengeSecret: headers["x-campaign-challenge"],
      deletionStatusSession: headers["x-deletion-status-session"],
      // Explicit browser intent selects an existing authority without signing the
      // account out. Only the scoped viewer/upload/placement routes honor it.
      accountAccess: url.searchParams.get('access') === 'account',
      invitationAccess: url.searchParams.get('access') === 'invitation',
      invitationViewer: request.method === 'GET' && url.pathname.startsWith('/v1/viewer/') && url.searchParams.get('access') === 'invitation',
      range: headers.range,
      exportDownload: headers["x-export-download"],
      notice: headers["notice-acknowledgement"] ? JSON.parse(headers["notice-acknowledgement"]) : request.notice,
      sameOrigin: headers.origin === (headers["x-public-origin"] ?? "http://127.0.0.1:8787") &&
        headers["sec-fetch-site"] === "same-origin" && headers.host === (headers["x-public-host"] ?? "127.0.0.1:8787"),
      riskScope: request.observedRiskScope ?? "local-test-adapter", query: Object.fromEntries(url.searchParams),
      scope: headers["x-idempotency-scope"], authorizationId: headers["x-authorization-id"]
    };
  }

  requestPrincipalKind(request) {
    const method = String(request.method ?? "GET").toUpperCase();
    const url = new URL(request.path ?? request.url, "http://local");
    const route = this.routes.find(candidate => candidate.method === method && candidate.regex.test(url.pathname));
    if (!route) return null;
    return projectRoutePrincipal(this.context({ ...request, method }, url), route).selectedPrincipalKind ?? null;
  }

  async handle(request) {
    const method = String(request.method ?? "GET").toUpperCase();
    const url = new URL(request.path ?? request.url, "http://local");
    let ctx = { requestId: randomUUID() };
    try {
      await this.ready;
      const route = this.routes.find((candidate) => candidate.method === method && candidate.regex.test(url.pathname));
      if (!route) return { status: 404, headers: { "cache-control": "no-store" }, body: { error: { code: "route_unavailable" } } };
      const match = url.pathname.match(route.regex);
      const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
      ctx = this.context(request, url);
      ctx.routeTemplate = route.template;
      ctx.routeParams = params;
      projectRoutePrincipal(ctx, route);
      const body = await route.handler(ctx, params);
      await this.dispatchOtpDeliveries();
      if (route.extension) return bookExtensionResponse(body);
      if (body?._raw) return { status: body.status ?? 200, headers: body.headers ?? { "content-type": body.contentType,
        "content-disposition": `attachment; filename="${body.fileName}"`, "cache-control": "no-store, private" }, body: body._raw };
      const credential = JSON.stringify(body).match(/Secret|Ticket|sameOriginUrl/);
      // GET /v1/discover/spaces is the one unauthenticated, no-session read in this API: it carries
      // no per-visitor state, so unlike every other route here it's safe to let a client/CDN cache
      // briefly instead of forcing no-store.
      const publicDiscover = route.template === "/v1/discover/spaces" && !credential;
      return { status: method === "POST" ? 200 : 200, headers: { "content-type": "application/json",
        "cache-control": credential || route.template.startsWith("/v1/admin/") ? "no-store, private" : publicDiscover ? "public, max-age=60" : "no-store" }, body };
    } catch (error) {
      if (process.env.UNSEEN_DEBUG_ERRORS && !(error instanceof ApiError)) console.error(error);
      const response = errorBody(error, ctx.requestId);
      return { ...response, headers: { "content-type": "application/json", "cache-control": "no-store, private" } };
    }
  }

  async putMedia({ ticket, bytes, contentType, kind = "photo" }) {
    try {
      if (ticket && typeof ticket === "object") ticket = ticket.headers?.["X-Upload-Ticket"] ??
        ticket.headers?.["x-upload-ticket"];
      const body = kind === "panorama" ? await this.panoramas.uploadByTicket(ticket, bytes, contentType) :
        await this.uploads.uploadByTicket(ticket, bytes, contentType);
      return { status: 200, body };
    } catch (error) {
      return errorBody(error, randomUUID());
    }
  }

  async putDirectMedia({ ticket, exactPrivateObjectKey, bytes, contentType, headers = {} }) {
    try {
      const info = this.uploads.ticketInfo(ticket);
      const { session, declared } = info;
      const body = Buffer.from(bytes);
      assert(session.status === "issued" && exactPrivateObjectKey === session.exact_private_object_key &&
        headers["if-none-match"] === "*" && contentType === declared.mime && body.length === Number(declared.bytes) &&
        headers["x-unseen-upload-session"] === session.id &&
        headers["x-unseen-upload-session-version"] === String(session.version) &&
        headers["x-unseen-upload-item"] === session.item_id &&
        headers["x-unseen-upload-asset"] === session.asset_id &&
        headers["x-unseen-upload-bytes"] === String(declared.bytes) &&
        headers["x-unseen-upload-expires-at"] === session.expires_at,
      "object_mismatch", 409);
      const stored = await this.mediaStore.putIfAbsent(session.exact_private_object_key, body,
        { contentType, maxBytes: info.hardLimitBytes });
      assert(stored.created, "upload_session_unavailable", 404);
      return { status: 200, headers: { etag: `"${stored.etag}"` },
        body: { uploaded: true, businessCommitted: false } };
    } catch (error) {
      return errorBody(error, randomUUID());
    }
  }

  mediaTicketInfo({ ticket, kind = "photo" }) {
    if (ticket && typeof ticket === "object") ticket = ticket.headers?.["X-Upload-Ticket"] ??
      ticket.headers?.["x-upload-ticket"];
    return kind === "panorama" ? this.panoramas.ticketInfo(ticket) : this.uploads.ticketInfo(ticket);
  }

  // Real health check (2026-08-18, see health-checks.mjs header for the incident this responds
  // to). `otpDelivery` keeps its exact pre-existing shape (backward compatible for any existing
  // caller/test); `db`, `disk` and `clipSidecar` are new. `status` is the aggregate tri-state
  // decided by aggregateHealthStatus() -- http-server.mjs answers /healthz with HTTP 200 for
  // both "ok" and "degraded", and only a non-200 (503) for "down". Wrapped in a short TTL cache
  // (see the constructor) so a monitoring timer hitting this every minute/two minutes doesn't
  // re-run the DB/disk/sidecar probes on every single call. Async because the CLIP sidecar probe
  // is a real network round-trip; every caller (http-server.mjs, index.mjs, deployment-entrypoint.mjs)
  // now awaits this.
  async health() {
    return this._healthCache();
  }

  async _computeHealth() {
    const otpDelivery = this.otpOutbox.health();
    const db = checkDatabaseWritable(this.db);
    const disk = checkDiskSpace(this._healthConfig.dataDir, this._healthConfig.diskThresholds);
    const clipSidecar = await checkClipSidecar(this._healthConfig.clipSidecar);
    const status = aggregateHealthStatus({ otpDelivery, db, disk, clipSidecar });
    return { status, otpDelivery, db, disk, clipSidecar, checkedAt: new Date().toISOString() };
  }

  dispatchOtpDeliveries(options) { return this.otpOutbox.dispatchAvailable(options); }

  enqueuePrivateAiPhoto(input) { return this.privateAi.enqueuePhoto(input); }
  authorizePrivateAiPhoto(input) { return this.privateAi.authorizePhoto(input); }
  revokePrivateAiPhotoAuthorization(input) { return this.privateAi.revokePhotoAuthorization(input); }
  reconcilePrivateAiPhotoAuthorizations() { return this.privateAi.reconcileAuthorizations(); }
  privateAiObservation(options) { return this.privateAi.observe(options); }
  claimPrivateAiCompositionEvent(options) { return this.privateAi.claimCompositionEvent(options); }
  markPrivateAiCompositionEventDelivered(input) { return this.privateAi.markCompositionEventDelivered(input); }
  retryPrivateAiCompositionEvent(input) { return this.privateAi.retryCompositionEvent(input); }

  close() { this.db.close(); }
}
