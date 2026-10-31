import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { ApiError, assert } from "./errors.mjs";
import { transaction } from "./database.mjs";
import { json, sha256, stableJson } from "./util.mjs";

export const PRIVATE_AI_PROTOCOL = "unseen-private-ai-pull/1";
export const PRIVATE_AI_TASK = "photo_visible_facts_question_v1";
export const PRIVATE_AI_IMAGE_LIMIT = 20 * 1024 * 1024;
export const PRIVATE_AI_PIXEL_LIMIT = 16_777_216;
export const PRIVATE_AI_CONTEXT_RETENTION_MS = 24 * 60 * 60 * 1_000;

const HASH = /^[a-f0-9]{64}$/u;
const JOB_ID = /^paij_[a-f0-9]{32}$/u;
const LEASE_ID = /^pail_[a-f0-9]{32}$/u;
const OUTBOX_ID = /^paio_[a-f0-9]{32}$/u;
const MEDIA_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const RETRYABLE_FAILURES = new Set([
  "model_unavailable", "model_quota_exhausted", "model_timeout", "worker_aborted", "worker_internal_failure"
]);
const TERMINAL_FAILURES = new Set(["image_invalid", "image_unsupported", "result_policy_rejected"]);
const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f-\u009f\r\n]/u;
const UNSAFE_CONTEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const REDACTED_QUESTION_CONTEXT = '{"kind":"redacted"}';

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function nowMs(clock) { return Number(clock.now()); }
function nowIso(clock) { return new Date(nowMs(clock)).toISOString(); }
function randomId(prefix) { return `${prefix}_${randomBytes(16).toString("hex")}`; }
function canonicalIso(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function privateAiError(code, status) { throw new ApiError(code, status); }

function checkedCompositionRequest(request) {
  if (!exact(request, ["jobId", "jobVersion", "kind", "inputHash", "attempt"]) ||
    typeof request.jobId !== "string" || request.jobId.length < 1 || request.jobId.length > 200 ||
    CONTROL_OR_NEWLINE.test(request.jobId) || !Number.isSafeInteger(request.jobVersion) || request.jobVersion < 1 ||
    !["initial_question", "followup_question"].includes(request.kind) || !HASH.test(request.inputHash ?? "") ||
    !Number.isSafeInteger(request.attempt) || request.attempt < 1) {
    privateAiError("private_ai_request_invalid", 400);
  }
  return Object.freeze({ jobId: request.jobId, jobVersion: request.jobVersion, kind: request.kind,
    inputHash: request.inputHash, attempt: request.attempt });
}

function checkedQuestionContext(context, kind) {
  if (kind === "initial_question") {
    if (!exact(context, ["kind"]) || context.kind !== kind) {
      privateAiError("private_ai_request_invalid", 400);
    }
    return Object.freeze({ kind });
  }
  const expected = ["kind", "followupOrdinal", "followupLimit", "priorVisibleFacts", "priorQuestion",
    "userAnswerText"];
  if (!exact(context, expected) || context.kind !== "followup_question" ||
    !Number.isSafeInteger(context.followupOrdinal) || context.followupOrdinal < 1 ||
    !Number.isSafeInteger(context.followupLimit) || context.followupLimit < 1 || context.followupLimit > 3 ||
    context.followupOrdinal > context.followupLimit || !Array.isArray(context.priorVisibleFacts) ||
    context.priorVisibleFacts.length < 1 || context.priorVisibleFacts.length > 2 ||
    new Set(context.priorVisibleFacts).size !== context.priorVisibleFacts.length ||
    context.priorVisibleFacts.some((fact) => typeof fact !== "string" || fact.length < 2 || fact.length > 160 ||
      CONTROL_OR_NEWLINE.test(fact)) || typeof context.priorQuestion !== "string" ||
    context.priorQuestion.length < 2 || context.priorQuestion.length > 300 ||
    CONTROL_OR_NEWLINE.test(context.priorQuestion) || typeof context.userAnswerText !== "string" ||
    context.userAnswerText.length < 1 || context.userAnswerText.length > 500 ||
    UNSAFE_CONTEXT_CONTROL.test(context.userAnswerText)) {
    privateAiError("private_ai_request_invalid", 400);
  }
  return Object.freeze({ ...context, priorVisibleFacts: Object.freeze([...context.priorVisibleFacts]) });
}

export function loadPrivateAiWorkerTokenHash(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    privateAiError("private_ai_worker_configuration_invalid", 503);
  }
  let descriptor;
  try {
    const before = lstatSync(file);
    const euid = typeof process.geteuid === "function" ? process.geteuid() : before.uid;
    const mode = before.mode & 0o777;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      ![0, euid].includes(before.uid) || ![0o400, 0o600].includes(mode)) {
      privateAiError("private_ai_worker_configuration_invalid", 503);
    }
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== before.uid ||
      (opened.mode & 0o777) !== mode || opened.size < 64 || opened.size > 65) {
      privateAiError("private_ai_worker_configuration_invalid", 503);
    }
    const value = readFileSync(descriptor, "utf8").trim();
    if (!HASH.test(value)) privateAiError("private_ai_worker_configuration_invalid", 503);
    return Buffer.from(value, "hex");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    privateAiError("private_ai_worker_configuration_invalid", 503);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sourceBinding(current) {
  const row = current?.row;
  const provenance = current?.provenance;
  const width = Number(row?.render_width);
  const height = Number(row?.render_height);
  if (!row || !provenance || !HASH.test(provenance.photoContentHash ?? "") ||
    !HASH.test(provenance.placementSnapshotHash ?? "") || !HASH.test(row.render_hash ?? "") ||
    !Number.isSafeInteger(row.render_bytes) || row.render_bytes < 1 ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
    !Number.isSafeInteger(row.render_asset_version) || row.render_asset_version < 1 ||
    !Number.isSafeInteger(row.photo_version) || row.photo_version < 1 ||
    !Number.isSafeInteger(row.placement_revision_seq) || row.placement_revision_seq < 1) return null;
  if (!MEDIA_MIMES.has(row.render_mime)) privateAiError("private_ai_image_type_unsupported", 415);
  if (row.render_bytes > PRIVATE_AI_IMAGE_LIMIT || width * height > PRIVATE_AI_PIXEL_LIMIT) {
    privateAiError("private_ai_image_too_large", 413);
  }
  return Object.freeze({
    spaceId: row.space_id, photoId: row.photo_id, photoContentHash: provenance.photoContentHash,
    mediaAssetId: row.render_asset_id, mediaAssetVersion: row.render_asset_version,
    mediaSha256: row.render_hash, mediaBytes: row.render_bytes, mediaMime: row.render_mime,
    mediaWidth: width, mediaHeight: height, mediaObjectKey: row.render_object_key,
    photoVersion: row.photo_version, placementRevisionId: row.placement_revision_id,
    placementRevisionSeq: row.placement_revision_seq, placementSnapshotHash: provenance.placementSnapshotHash
  });
}

function boundToJob(source, job) {
  return Boolean(source && source.spaceId === job.space_id && source.photoId === job.photo_id &&
    source.photoContentHash === job.photo_content_hash && source.mediaAssetId === job.media_asset_id &&
    source.mediaAssetVersion === job.media_asset_version && source.mediaSha256 === job.media_sha256 &&
    source.mediaBytes === job.media_bytes && source.mediaMime === job.media_mime &&
    source.mediaWidth === job.media_width && source.mediaHeight === job.media_height &&
    source.photoVersion === job.photo_version && source.placementRevisionId === job.placement_revision_id &&
    source.placementRevisionSeq === job.placement_revision_seq &&
    source.placementSnapshotHash === job.placement_snapshot_hash);
}

function authorizationBindingHash(source) {
  return sha256(stableJson(source));
}

function checkedResult(result, expectedModel, expectedModelVersion) {
  const keys = ["latencyMs", "model", "modelVersion", "modelVisibleFacts", "question", "questionIntent"];
  if (!exact(result, keys) || !Array.isArray(result.modelVisibleFacts) ||
    result.modelVisibleFacts.length < 1 || result.modelVisibleFacts.length > 2 ||
    new Set(result.modelVisibleFacts).size !== result.modelVisibleFacts.length ||
    result.modelVisibleFacts.some((fact) => typeof fact !== "string" || fact.length < 2 || fact.length > 160 ||
      CONTROL_OR_NEWLINE.test(fact)) || typeof result.question !== "string" || result.question.length < 2 ||
    result.question.length > 300 || CONTROL_OR_NEWLINE.test(result.question) ||
    (result.question.match(/[?？]/gu) ?? []).length !== 1 || !/[?？]$/u.test(result.question) ||
    result.questionIntent !== "photo_context" || result.model !== expectedModel ||
    result.modelVersion !== expectedModelVersion || !Number.isSafeInteger(result.latencyMs) ||
    result.latencyMs < 0 || result.latencyMs > 300_000) {
    privateAiError("private_ai_result_invalid", 400);
  }
  return Object.freeze({
    modelVisibleFacts: Object.freeze([...result.modelVisibleFacts]), question: result.question,
    questionIntent: result.questionIntent, model: result.model, modelVersion: result.modelVersion,
    latencyMs: result.latencyMs
  });
}

export class PrivateAiJobQueue {
  constructor({ core, mediaStore, readPhotoContext, enabled = false, tokenHashFile, clock = Date,
    promptHash, policyHash, model, modelVersion, leaseMs = 180_000, maxAttempts = 5,
    idleRetryAfterMs = 5_000, maxRequestsPerMinute = 60, tokenHashLoader = loadPrivateAiWorkerTokenHash } = {}) {
    assert(core?.db && mediaStore && typeof readPhotoContext === "function", "private_ai_worker_configuration_invalid", 503);
    this.core = core;
    this.db = core.db;
    this.mediaStore = mediaStore;
    this.readPhotoContext = readPhotoContext;
    this.enabled = enabled === true;
    this.clock = clock;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this.idleRetryAfterMs = idleRetryAfterMs;
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.rateWindowStartedAt = 0;
    this.rateCount = 0;
    this.promptHash = promptHash;
    this.policyHash = policyHash;
    this.model = model;
    this.modelVersion = modelVersion;
    this.tokenHash = null;
    if (!this.enabled) return;
    if (!HASH.test(promptHash ?? "") || !HASH.test(policyHash ?? "") ||
      typeof model !== "string" || model.length < 1 || model.length > 80 || CONTROL_OR_NEWLINE.test(model) ||
      typeof modelVersion !== "string" || modelVersion.length < 1 || modelVersion.length > 80 ||
      CONTROL_OR_NEWLINE.test(modelVersion) || !Number.isSafeInteger(leaseMs) || leaseMs < 30_000 ||
      leaseMs > 300_000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 ||
      !Number.isSafeInteger(idleRetryAfterMs) || idleRetryAfterMs < 1_000 || idleRetryAfterMs > 300_000 ||
      !Number.isSafeInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 4 || maxRequestsPerMinute > 600) {
      privateAiError("private_ai_worker_configuration_invalid", 503);
    }
    this.tokenHash = tokenHashLoader(tokenHashFile);
  }

  health() {
    return Object.freeze({ enabled: this.enabled, configured: this.enabled && Buffer.isBuffer(this.tokenHash),
      taskType: PRIVATE_AI_TASK, deployed: false, releaseClaim: "NO_GO_DEFAULT_OFF" });
  }

  ensureEnabled() {
    if (!this.enabled) privateAiError("private_ai_worker_disabled", 503);
  }

  authorize({ authorization, forwardedProto, remoteAddress }) {
    this.ensureEnabled();
    if (forwardedProto !== "https" || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) {
      privateAiError("private_ai_https_required", 426);
    }
    const prefix = "Bearer ";
    const supplied = typeof authorization === "string" && authorization.startsWith(prefix) &&
      authorization.length <= prefix.length + 256 ? authorization.slice(prefix.length) : "";
    const candidate = createHash("sha256").update(supplied).digest();
    if (!this.tokenHash || !timingSafeEqual(candidate, this.tokenHash)) {
      privateAiError("private_ai_worker_unauthorized", 401);
    }
    const now = nowMs(this.clock);
    if (now - this.rateWindowStartedAt >= 60_000) {
      this.rateWindowStartedAt = now;
      this.rateCount = 0;
    }
    this.rateCount += 1;
    if (this.rateCount > this.maxRequestsPerMinute) privateAiError("private_ai_rate_limited", 429);
  }

  enqueuePhoto({ photoId, authorizationSnapshotHash, questionProcessorRequest, questionContext } = {}) {
    this.ensureEnabled();
    if (typeof photoId !== "string" || !photoId || !HASH.test(authorizationSnapshotHash ?? "")) {
      privateAiError("private_ai_request_invalid", 400);
    }
    const compositionRequest = checkedCompositionRequest(questionProcessorRequest);
    const context = checkedQuestionContext(questionContext ?? { kind: compositionRequest.kind },
      compositionRequest.kind);
    const compositionRequestJson = stableJson(compositionRequest);
    const compositionRequestHash = sha256(compositionRequestJson);
    const questionContextJson = stableJson(context);
    const questionContextHash = sha256(questionContextJson);
    return transaction(this.db, () => {
      const source = sourceBinding(this.readPhotoContext(photoId));
      if (!source) privateAiError("private_ai_source_stale", 409);
      const authorization = this.db.prepare("SELECT * FROM private_ai_authorizations WHERE snapshot_hash=?")
        .get(authorizationSnapshotHash);
      if (!authorization || authorization.photo_id !== photoId || authorization.active !== 1 ||
        authorization.source_binding_hash !== authorizationBindingHash(source)) {
        privateAiError("private_ai_source_stale", 409);
      }
      const now = nowIso(this.clock);
      const inputHash = sha256(stableJson({
        authorizationSnapshotHash, mediaAssetVersion: source.mediaAssetVersion,
        mediaSha256: source.mediaSha256, photoContentHash: source.photoContentHash,
        photoId: source.photoId, photoVersion: source.photoVersion,
        placementRevisionId: source.placementRevisionId, placementRevisionSeq: source.placementRevisionSeq,
        placementSnapshotHash: source.placementSnapshotHash, policyHash: this.policyHash,
        promptHash: this.promptHash, taskType: PRIVATE_AI_TASK, compositionRequestHash, questionContextHash
      }));
      const existing = this.db.prepare("SELECT * FROM private_ai_jobs WHERE input_hash=?").get(inputHash);
      if (existing) return Object.freeze({ jobId: existing.id, status: existing.status, inputHash, replayed: true });
      this.db.prepare(`UPDATE private_ai_jobs SET status='failed',stable_error='source_superseded',lease_id=NULL,
        lease_expires_at=NULL,question_context_json=?,updated_at=?,version=version+1 WHERE photo_id=? AND task_type=?
        AND status IN ('queued','leased','retry')`).run(
        REDACTED_QUESTION_CONTEXT, now, photoId, PRIVATE_AI_TASK);
      const jobId = randomId("paij");
      this.db.prepare(`INSERT INTO private_ai_jobs(
        id,task_type,space_id,photo_id,photo_content_hash,media_asset_id,media_asset_version,media_sha256,
        media_bytes,media_mime,media_width,media_height,photo_version,placement_revision_id,
        placement_revision_seq,placement_snapshot_hash,authorization_snapshot_hash,prompt_hash,policy_hash,
        expected_model,expected_model_version,composition_request_json,composition_request_hash,
        question_context_json,input_hash,status,
        attempts,max_attempts,available_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',0,?,?,?,?)`).run(
        jobId, PRIVATE_AI_TASK, source.spaceId, source.photoId, source.photoContentHash, source.mediaAssetId,
        source.mediaAssetVersion, source.mediaSha256, source.mediaBytes, source.mediaMime, source.mediaWidth,
        source.mediaHeight, source.photoVersion, source.placementRevisionId, source.placementRevisionSeq,
        source.placementSnapshotHash, authorizationSnapshotHash, this.promptHash, this.policyHash,
        this.model, this.modelVersion, compositionRequestJson, compositionRequestHash, questionContextJson, inputHash,
        this.maxAttempts, now, now, now);
      return Object.freeze({ jobId, status: "queued", inputHash, replayed: false });
    });
  }

  authorizePhoto({ photoId, authorizationSnapshotHash } = {}) {
    this.ensureEnabled();
    if (typeof photoId !== "string" || !photoId || !HASH.test(authorizationSnapshotHash ?? "")) {
      privateAiError("private_ai_request_invalid", 400);
    }
    return transaction(this.db, () => {
      const source = sourceBinding(this.readPhotoContext(photoId));
      if (!source) privateAiError("private_ai_source_stale", 409);
      const existing = this.db.prepare("SELECT * FROM private_ai_authorizations WHERE snapshot_hash=?")
        .get(authorizationSnapshotHash);
      if (existing && existing.photo_id !== photoId) privateAiError("private_ai_source_stale", 409);
      const sourceBindingHash = authorizationBindingHash(source);
      if (existing?.active === 1 && existing.source_binding_hash === sourceBindingHash) {
        return Object.freeze({ authorized: true, authorizationSnapshotHash, sourceBindingHash });
      }
      const now = nowIso(this.clock);
      this.db.prepare(`INSERT INTO private_ai_authorizations(
        snapshot_hash,photo_id,active,source_binding_hash,created_at,updated_at) VALUES(?,?,1,?,?,?)
        ON CONFLICT(snapshot_hash) DO UPDATE SET active=1,source_binding_hash=excluded.source_binding_hash,
        updated_at=excluded.updated_at WHERE private_ai_authorizations.photo_id=excluded.photo_id`).run(
        authorizationSnapshotHash, photoId, sourceBindingHash, now, now);
      return Object.freeze({ authorized: true, authorizationSnapshotHash, sourceBindingHash });
    });
  }

  revokePhotoAuthorization({ photoId, authorizationSnapshotHash } = {}) {
    this.ensureEnabled();
    if (typeof photoId !== "string" || !photoId || !HASH.test(authorizationSnapshotHash ?? "")) {
      privateAiError("private_ai_request_invalid", 400);
    }
    return transaction(this.db, () => {
      const now = nowIso(this.clock);
      const existing = this.db.prepare("SELECT * FROM private_ai_authorizations WHERE snapshot_hash=?")
        .get(authorizationSnapshotHash);
      if (existing && existing.photo_id !== photoId) privateAiError("private_ai_source_stale", 409);
      const wasActive = existing?.active === 1;
      if (existing?.active === 0) return Object.freeze({ revoked: false, tombstoned: true });
      this.db.prepare(`INSERT INTO private_ai_authorizations(
        snapshot_hash,photo_id,active,source_binding_hash,created_at,updated_at) VALUES(?,?,0,NULL,?,?)
        ON CONFLICT(snapshot_hash) DO UPDATE SET active=0,source_binding_hash=NULL,updated_at=excluded.updated_at
        WHERE private_ai_authorizations.photo_id=excluded.photo_id`).run(
        authorizationSnapshotHash, photoId, now, now);
      this.db.prepare(`UPDATE private_ai_jobs SET status='failed',stable_error='authorization_withdrawn',
        lease_id=NULL,lease_expires_at=NULL,question_context_json=?,updated_at=?,version=version+1
        WHERE authorization_snapshot_hash=? AND photo_id=? AND status IN ('queued','leased','retry')`).run(
        REDACTED_QUESTION_CONTEXT, now, authorizationSnapshotHash, photoId);
      this.db.prepare(`UPDATE private_ai_composition_outbox SET status='cancelled',
        last_error='authorization_withdrawn',lease_id=NULL,lease_expires_at=NULL,updated_at=?,version=version+1
        WHERE ai_job_id IN (SELECT id FROM private_ai_jobs WHERE authorization_snapshot_hash=? AND photo_id=?)
        AND status IN ('pending','leased','retry')`).run(now, authorizationSnapshotHash, photoId);
      return Object.freeze({ revoked: wasActive, tombstoned: true });
    });
  }

  reconcileAuthorizations() {
    this.ensureEnabled();
    return transaction(this.db, () => {
      this.expireQuestionContexts();
      const active = this.db.prepare(`SELECT * FROM private_ai_authorizations
        WHERE active=1 ORDER BY created_at,snapshot_hash`).all();
      let revokedCount = 0;
      let failedJobCount = 0;
      let cancelledEventCount = 0;
      const revocations = [];
      for (const authorization of active) {
        let source = null;
        try { source = sourceBinding(this.readPhotoContext(authorization.photo_id)); } catch { /* stale */ }
        if (source && authorization.source_binding_hash === authorizationBindingHash(source)) continue;
        const now = nowIso(this.clock);
        const revoked = this.db.prepare(`UPDATE private_ai_authorizations SET active=0,source_binding_hash=NULL,
          updated_at=? WHERE snapshot_hash=? AND photo_id=? AND active=1`).run(
          now, authorization.snapshot_hash, authorization.photo_id);
        if (revoked.changes !== 1) continue;
        revokedCount += 1;
        revocations.push(Object.freeze({ photoId: authorization.photo_id,
          authorizationSnapshotHash: authorization.snapshot_hash }));
        failedJobCount += this.db.prepare(`UPDATE private_ai_jobs SET status='failed',stable_error='source_stale',
          lease_id=NULL,lease_expires_at=NULL,question_context_json=?,updated_at=?,version=version+1
          WHERE authorization_snapshot_hash=? AND photo_id=? AND status IN ('queued','leased','retry')`).run(
          REDACTED_QUESTION_CONTEXT, now, authorization.snapshot_hash, authorization.photo_id).changes;
        cancelledEventCount += this.db.prepare(`UPDATE private_ai_composition_outbox SET status='cancelled',
          last_error='source_stale',lease_id=NULL,lease_expires_at=NULL,updated_at=?,version=version+1
          WHERE ai_job_id IN (SELECT id FROM private_ai_jobs WHERE authorization_snapshot_hash=? AND photo_id=?)
          AND status IN ('pending','leased','retry')`).run(
          now, authorization.snapshot_hash, authorization.photo_id).changes;
      }
      return Object.freeze({ scannedCount: active.length, revokedCount, failedJobCount, cancelledEventCount,
        revocations: Object.freeze(revocations) });
    });
  }

  backoffMs(attempts) { return Math.min(300_000, 5_000 * (2 ** Math.max(0, attempts - 1))); }

  expireQuestionContexts() {
    const now = nowIso(this.clock);
    const cutoff = new Date(nowMs(this.clock) - PRIVATE_AI_CONTEXT_RETENTION_MS).toISOString();
    const rows = this.db.prepare(`SELECT * FROM private_ai_jobs WHERE status IN ('queued','leased','retry')
      AND question_context_json IS NOT NULL AND question_context_json!=? AND created_at<=?
      ORDER BY created_at,id`).all(REDACTED_QUESTION_CONTEXT, cutoff);
    for (const row of rows) {
      const changed = this.db.prepare(`UPDATE private_ai_jobs SET status='failed',stable_error='context_expired',
        lease_id=NULL,lease_expires_at=NULL,question_context_json=?,updated_at=?,version=version+1
        WHERE id=? AND version=? AND status IN ('queued','leased','retry')`).run(
        REDACTED_QUESTION_CONTEXT, now, row.id, row.version);
      if (changed.changes === 1) this.queueCompositionEvent({ ...row, attempts: Math.max(1, row.attempts) },
        "provider_unavailable");
    }
  }

  queueCompositionEvent(job, eventType, completionResult = null) {
    const now = nowIso(this.clock);
    const eventHash = sha256(stableJson({ aiJobId: job.id, attempt: job.attempts, eventType,
      inputHash: job.input_hash, completionResult }));
    this.db.prepare(`INSERT OR IGNORE INTO private_ai_composition_outbox(
      id,ai_job_id,event_type,event_hash,job_attempt,composition_request_json,completion_result_json,status,
      attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?)`).run(
      randomId("paio"), job.id, eventType, eventHash, job.attempts, job.composition_request_json,
      completionResult === null ? null : json(completionResult), now, now, now);
  }

  recoverExpired() {
    const now = nowIso(this.clock);
    for (const row of this.db.prepare(`SELECT id,attempts,max_attempts FROM private_ai_jobs
      WHERE status='leased' AND lease_expires_at<=? ORDER BY created_at,id`).all(now)) {
      const terminal = row.attempts >= row.max_attempts;
      const delay = terminal ? null : this.backoffMs(row.attempts);
      const available = terminal ? now : new Date(nowMs(this.clock) + delay).toISOString();
      this.db.prepare(`UPDATE private_ai_jobs SET status=?,available_at=?,stable_error=?,lease_id=NULL,
        lease_expires_at=NULL,question_context_json=CASE WHEN ?=1 THEN ? ELSE question_context_json END,
        updated_at=?,version=version+1 WHERE id=? AND status='leased' AND lease_expires_at<=?`)
        .run(terminal ? "failed" : "retry", available, terminal ? "attempts_exhausted" : "lease_expired",
          terminal ? 1 : 0, REDACTED_QUESTION_CONTEXT, now, row.id, now);
      if (!terminal) {
        const job = this.db.prepare("SELECT * FROM private_ai_jobs WHERE id=?").get(row.id);
        this.queueCompositionEvent(job, "provider_unavailable");
      }
    }
  }

  markStale(job) {
    const now = nowIso(this.clock);
    this.db.prepare(`UPDATE private_ai_jobs SET status='failed',stable_error='source_stale',lease_id=NULL,
      lease_expires_at=NULL,question_context_json=?,updated_at=?,version=version+1 WHERE id=? AND version=?`).run(
      REDACTED_QUESTION_CONTEXT, now, job.id, job.version);
  }

  currentSource(job) {
    const authorization = this.db.prepare(`SELECT source_binding_hash FROM private_ai_authorizations
      WHERE snapshot_hash=? AND photo_id=? AND active=1`).get(job.authorization_snapshot_hash, job.photo_id);
    if (!authorization) return null;
    const source = sourceBinding(this.readPhotoContext(job.photo_id));
    return boundToJob(source, job) && authorization.source_binding_hash === authorizationBindingHash(source) ?
      source : null;
  }

  observe({ workerOnlineWindowMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(workerOnlineWindowMs) || workerOnlineWindowMs < 1_000 ||
      workerOnlineWindowMs > 300_000) privateAiError("private_ai_request_invalid", 400);
    if (!this.enabled) return Object.freeze({ enabled: false, workerOnline: false, lastSeenAt: null,
      queuedRetryCount: 0, leasedCount: 0, failedCount: 0, completedCount: 0, oldestQueuedRetryAgeMs: null });
    const worker = this.db.prepare("SELECT last_seen_at FROM private_ai_worker_state WHERE singleton=1").get();
    const counts = Object.fromEntries(this.db.prepare(`SELECT status,COUNT(*) count FROM private_ai_jobs
      GROUP BY status`).all().map((row) => [row.status, row.count]));
    const oldest = this.db.prepare(`SELECT MIN(created_at) created_at FROM private_ai_jobs
      WHERE status IN ('queued','retry')`).get()?.created_at ?? null;
    return Object.freeze({ enabled: true,
      workerOnline: Boolean(worker && nowMs(this.clock) - Date.parse(worker.last_seen_at) <= workerOnlineWindowMs),
      lastSeenAt: worker?.last_seen_at ?? null, queuedRetryCount: (counts.queued ?? 0) + (counts.retry ?? 0),
      leasedCount: counts.leased ?? 0, failedCount: counts.failed ?? 0, completedCount: counts.completed ?? 0,
      oldestQueuedRetryAgeMs: oldest ? Math.max(0, nowMs(this.clock) - Date.parse(oldest)) : null });
  }

  lease() {
    this.ensureEnabled();
    return transaction(this.db, () => {
      const heartbeat = nowIso(this.clock);
      this.db.prepare(`INSERT INTO private_ai_worker_state(singleton,last_seen_at) VALUES(1,?)
        ON CONFLICT(singleton) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(heartbeat);
      this.recoverExpired();
      this.expireQuestionContexts();
      const active = this.db.prepare("SELECT 1 FROM private_ai_jobs WHERE status='leased' LIMIT 1").get();
      if (active) return Object.freeze({ schema: "unseen-private-ai-lease-response/1", job: null,
        retryAfterMs: this.idleRetryAfterMs });
      for (;;) {
        const now = nowIso(this.clock);
        const row = this.db.prepare(`SELECT * FROM private_ai_jobs WHERE status IN ('queued','retry')
          AND available_at<=? AND attempts<max_attempts AND NOT EXISTS(
            SELECT 1 FROM private_ai_composition_outbox o WHERE o.ai_job_id=private_ai_jobs.id
            AND o.event_type='provider_unavailable' AND o.status='leased'
          ) ORDER BY available_at,created_at,id LIMIT 1`).get(now);
        if (!row) return Object.freeze({ schema: "unseen-private-ai-lease-response/1", job: null,
          retryAfterMs: this.idleRetryAfterMs });
        const source = this.currentSource(row);
        if (!source) { this.markStale(row); continue; }
        const leaseId = randomId("pail");
        const leaseExpiresAt = new Date(nowMs(this.clock) + this.leaseMs).toISOString();
        const updated = this.db.prepare(`UPDATE private_ai_jobs SET status='leased',attempts=attempts+1,
          lease_id=?,lease_expires_at=?,stable_error=NULL,updated_at=?,version=version+1
          WHERE id=? AND version=? AND status IN ('queued','retry') AND available_at<=?`).run(
          leaseId, leaseExpiresAt, now, row.id, row.version, now);
        if (updated.changes !== 1) continue;
        this.db.prepare(`UPDATE private_ai_composition_outbox SET status='cancelled',
          last_error='worker_retry_started',updated_at=?,version=version+1 WHERE ai_job_id=?
          AND event_type='provider_unavailable' AND status IN ('pending','retry')`).run(now, row.id);
        const attempt = row.attempts + 1;
        const imagePath = `/__internal/private-ai/v1/jobs/${encodeURIComponent(row.id)}/image`;
        const baseJob = { jobId: row.id, leaseId, taskType: PRIVATE_AI_TASK, attempt,
          maxAttempts: row.max_attempts, leaseExpiresAt, inputHash: row.input_hash,
          mediaSha256: row.media_sha256, mediaBytes: row.media_bytes, mediaMime: row.media_mime,
          promptHash: row.prompt_hash, policyHash: row.policy_hash, imagePath };
        const job = row.question_context_json === null
          ? { schema: "unseen-private-ai-job/1", ...baseJob }
          : { schema: "unseen-private-ai-job/2", ...baseJob,
            questionContext: checkedQuestionContext(JSON.parse(row.question_context_json),
              JSON.parse(row.composition_request_json).kind) };
        return Object.freeze({ schema: "unseen-private-ai-lease-response/1", retryAfterMs: this.idleRetryAfterMs,
          job: Object.freeze(job) });
      }
    });
  }

  leased(jobId, leaseId, inputHash = null) {
    if (!JOB_ID.test(jobId ?? "") || !LEASE_ID.test(leaseId ?? "") || inputHash !== null && !HASH.test(inputHash)) {
      privateAiError("private_ai_request_invalid", 400);
    }
    const job = this.db.prepare("SELECT * FROM private_ai_jobs WHERE id=?").get(jobId);
    if (!job) privateAiError("private_ai_job_unavailable", 404);
    if (inputHash !== null && job.input_hash !== inputHash) privateAiError("private_ai_input_changed", 409);
    if (job.status !== "leased" || job.lease_id !== leaseId || !canonicalIso(job.lease_expires_at) ||
      Date.parse(job.lease_expires_at) <= nowMs(this.clock)) privateAiError("private_ai_lease_unavailable", 409);
    return job;
  }

  async image(jobId, leaseId) {
    this.ensureEnabled();
    const before = this.leased(jobId, leaseId);
    const source = this.currentSource(before);
    if (!source) { transaction(this.db, () => this.markStale(before)); privateAiError("private_ai_source_stale", 409); }
    if (!MEDIA_MIMES.has(source.mediaMime)) privateAiError("private_ai_image_type_unsupported", 415);
    if (source.mediaBytes > PRIVATE_AI_IMAGE_LIMIT) privateAiError("private_ai_image_too_large", 413);
    let object;
    try { object = await this.mediaStore.get(source.mediaObjectKey, { maxBytes: PRIVATE_AI_IMAGE_LIMIT }); }
    catch (error) {
      if (error?.code === "object_too_large") privateAiError("private_ai_image_too_large", 413);
      privateAiError("private_ai_source_stale", 409);
    }
    const body = Buffer.from(object.body);
    const after = this.leased(jobId, leaseId);
    const current = this.currentSource(after);
    if (!current || !boundToJob(current, before)) privateAiError("private_ai_source_stale", 409);
    if (body.length !== before.media_bytes || object.contentType !== before.media_mime ||
      sha256(body) !== before.media_sha256) privateAiError("private_ai_source_stale", 409);
    return Object.freeze({ body, contentType: before.media_mime, sha256: before.media_sha256 });
  }

  callbackReplay(job, leaseId, callbackHash) {
    if (job.last_callback_lease_id !== leaseId) return null;
    if (job.last_callback_hash !== callbackHash) privateAiError("private_ai_input_changed", 409);
    return Object.freeze({ schema: "unseen-private-ai-terminal-response/1", status: job.last_callback_status,
      replayed: true, retryAfterMs: job.last_callback_retry_after_ms ?? null });
  }

  complete(jobId, body) {
    this.ensureEnabled();
    if (!exact(body, ["schema", "leaseId", "inputHash", "result"]) ||
      body.schema !== "unseen-private-ai-complete-request/1") privateAiError("private_ai_request_invalid", 400);
    const response = transaction(this.db, () => {
      const candidate = this.db.prepare("SELECT * FROM private_ai_jobs WHERE id=?").get(jobId);
      if (!candidate) privateAiError("private_ai_job_unavailable", 404);
      const result = checkedResult(body.result, candidate.expected_model, candidate.expected_model_version);
      const callbackHash = sha256(stableJson({ inputHash: body.inputHash, result }));
      const replay = this.callbackReplay(candidate, body.leaseId, callbackHash);
      if (replay) return replay;
      const job = this.leased(jobId, body.leaseId, body.inputHash);
      if (!this.currentSource(job)) { this.markStale(job); return { privateAiError: "private_ai_source_stale" }; }
      const now = nowIso(this.clock);
      const resultHash = sha256(stableJson(result));
      const updated = this.db.prepare(`UPDATE private_ai_jobs SET status='completed',result_json=?,result_hash=?,
        stable_error=NULL,completed_at=?,updated_at=?,last_callback_lease_id=?,last_callback_hash=?,
        last_callback_status='completed',last_callback_retry_after_ms=NULL,question_context_json=?,version=version+1
        WHERE id=? AND version=? AND status='leased' AND lease_id=?`).run(
          json(result), resultHash, now, now, body.leaseId, callbackHash, REDACTED_QUESTION_CONTEXT,
          job.id, job.version, body.leaseId);
      if (updated.changes !== 1) privateAiError("private_ai_lease_unavailable", 409);
      this.queueCompositionEvent({ ...job, attempts: job.attempts }, "completed", result);
      return Object.freeze({ schema: "unseen-private-ai-terminal-response/1", status: "completed",
        replayed: false, retryAfterMs: null });
    });
    if (response.privateAiError) privateAiError(response.privateAiError, 409);
    return response;
  }

  fail(jobId, body) {
    this.ensureEnabled();
    if (!exact(body, ["schema", "leaseId", "inputHash", "failureCode"]) ||
      body.schema !== "unseen-private-ai-fail-request/1") privateAiError("private_ai_request_invalid", 400);
    if (!RETRYABLE_FAILURES.has(body.failureCode) && !TERMINAL_FAILURES.has(body.failureCode)) {
      privateAiError("private_ai_failure_code_invalid", 400);
    }
    const response = transaction(this.db, () => {
      const candidate = this.db.prepare("SELECT * FROM private_ai_jobs WHERE id=?").get(jobId);
      if (!candidate) privateAiError("private_ai_job_unavailable", 404);
      const callbackHash = sha256(stableJson({ failureCode: body.failureCode, inputHash: body.inputHash }));
      const replay = this.callbackReplay(candidate, body.leaseId, callbackHash);
      if (replay) return replay;
      const job = this.leased(jobId, body.leaseId, body.inputHash);
      if (!this.currentSource(job)) { this.markStale(job); return { privateAiError: "private_ai_source_stale" }; }
      const retry = RETRYABLE_FAILURES.has(body.failureCode) && job.attempts < job.max_attempts;
      const retryAfterMs = retry ? this.backoffMs(job.attempts) : null;
      const now = nowIso(this.clock);
      const availableAt = retry ? new Date(nowMs(this.clock) + retryAfterMs).toISOString() : now;
      const status = retry ? "retry" : "failed";
      const updated = this.db.prepare(`UPDATE private_ai_jobs SET status=?,available_at=?,stable_error=?,
        lease_id=NULL,lease_expires_at=NULL,updated_at=?,last_callback_lease_id=?,last_callback_hash=?,
        last_callback_status=?,last_callback_retry_after_ms=?,
        question_context_json=CASE WHEN ?=1 THEN question_context_json ELSE ? END,version=version+1
        WHERE id=? AND version=? AND status='leased' AND lease_id=?`).run(status, availableAt, body.failureCode,
        now, body.leaseId, callbackHash, status, retryAfterMs, retry ? 1 : 0, REDACTED_QUESTION_CONTEXT,
        job.id, job.version, body.leaseId);
      if (updated.changes !== 1) privateAiError("private_ai_lease_unavailable", 409);
      if (retry) this.queueCompositionEvent(job, "provider_unavailable");
      return Object.freeze({ schema: "unseen-private-ai-terminal-response/1", status,
        replayed: false, retryAfterMs });
    });
    if (response.privateAiError) privateAiError(response.privateAiError, 409);
    return response;
  }

  recoverCompositionEvents() {
    const now = nowIso(this.clock);
    for (const row of this.db.prepare(`SELECT * FROM private_ai_composition_outbox
      WHERE status='leased' AND lease_expires_at<=? ORDER BY created_at,id`).all(now)) {
      const delay = this.backoffMs(row.attempts);
      const availableAt = new Date(nowMs(this.clock) + delay).toISOString();
      this.db.prepare(`UPDATE private_ai_composition_outbox SET status='retry',available_at=?,lease_id=NULL,
        lease_expires_at=NULL,last_error='delivery_lease_expired',updated_at=?,version=version+1
        WHERE id=? AND version=? AND status='leased' AND lease_expires_at<=?`)
        .run(availableAt, now, row.id, row.version, now);
    }
  }

  validatedCompositionPayload(row, job) {
    if (!job || !Number.isSafeInteger(row.job_attempt) || row.job_attempt < 1 ||
      row.job_attempt > job.max_attempts) privateAiError("private_ai_composition_payload_invalid", 409);
    const jobRequest = checkedCompositionRequest(JSON.parse(job.composition_request_json));
    const rowRequest = checkedCompositionRequest(JSON.parse(row.composition_request_json));
    const requestJson = stableJson(jobRequest);
    if (sha256(requestJson) !== job.composition_request_hash || stableJson(rowRequest) !== requestJson) {
      privateAiError("private_ai_composition_payload_invalid", 409);
    }
    let completionResult = null;
    if (row.event_type === "completed") {
      if (job.status !== "completed" || row.completion_result_json === null || job.result_json === null) {
        privateAiError("private_ai_composition_payload_invalid", 409);
      }
      completionResult = checkedResult(JSON.parse(row.completion_result_json),
        job.expected_model, job.expected_model_version);
      const jobResult = checkedResult(JSON.parse(job.result_json), job.expected_model, job.expected_model_version);
      if (stableJson(completionResult) !== stableJson(jobResult) ||
        sha256(stableJson(jobResult)) !== job.result_hash) {
        privateAiError("private_ai_composition_payload_invalid", 409);
      }
    } else if (row.event_type !== "provider_unavailable" || row.completion_result_json !== null) {
      privateAiError("private_ai_composition_payload_invalid", 409);
    }
    const eventHash = sha256(stableJson({ aiJobId: job.id, attempt: row.job_attempt,
      eventType: row.event_type, inputHash: job.input_hash, completionResult }));
    if (eventHash !== row.event_hash) privateAiError("private_ai_composition_payload_invalid", 409);
    return Object.freeze({ questionProcessorRequest: rowRequest,
      completionDto: completionResult === null ? null : completionResult });
  }

  claimCompositionEvent({ leaseMs = 60_000 } = {}) {
    this.ensureEnabled();
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 300_000) {
      privateAiError("private_ai_request_invalid", 400);
    }
    return transaction(this.db, () => {
      this.recoverCompositionEvents();
      if (this.db.prepare("SELECT 1 FROM private_ai_composition_outbox WHERE status='leased' LIMIT 1").get()) {
        return null;
      }
      for (;;) {
        const now = nowIso(this.clock);
        const row = this.db.prepare(`SELECT * FROM private_ai_composition_outbox
          WHERE status IN ('pending','retry') AND available_at<=? ORDER BY available_at,created_at,id LIMIT 1`)
          .get(now);
        if (!row) return null;
        const job = this.db.prepare("SELECT * FROM private_ai_jobs WHERE id=?").get(row.ai_job_id);
        let payload;
        try { payload = this.validatedCompositionPayload(row, job); }
        catch (error) {
          if (!(error instanceof SyntaxError) && !["private_ai_request_invalid", "private_ai_result_invalid",
            "private_ai_composition_payload_invalid"].includes(error?.code)) throw error;
          this.db.prepare(`UPDATE private_ai_composition_outbox SET status='quarantined',
            composition_request_json='{}',completion_result_json=CASE WHEN event_type='completed' THEN '{}'
            ELSE NULL END,lease_id=NULL,lease_expires_at=NULL,last_error='composition_payload_invalid',updated_at=?,
            version=version+1 WHERE id=? AND version=? AND status IN ('pending','retry')`).run(
            now, row.id, row.version);
          continue;
        }
        if (row.event_type === "completed" && !this.currentSource(job)) {
          this.db.prepare(`UPDATE private_ai_composition_outbox SET status='cancelled',last_error='source_stale',
            updated_at=?,version=version+1 WHERE id=? AND version=?`).run(now, row.id, row.version);
          continue;
        }
        const leaseId = randomId("pail");
        const leaseExpiresAt = new Date(nowMs(this.clock) + leaseMs).toISOString();
        const changed = this.db.prepare(`UPDATE private_ai_composition_outbox SET status='leased',
          attempts=attempts+1,lease_id=?,lease_expires_at=?,last_error=NULL,updated_at=?,version=version+1
          WHERE id=? AND version=? AND status IN ('pending','retry') AND available_at<=?`).run(
          leaseId, leaseExpiresAt, now, row.id, row.version, now);
        if (changed.changes !== 1) continue;
        return Object.freeze({ eventId: row.id, eventType: row.event_type, deliveryLeaseId: leaseId,
          deliveryLeaseExpiresAt: leaseExpiresAt, attempt: row.attempts + 1, eventHash: row.event_hash,
          questionProcessorRequest: payload.questionProcessorRequest, completionDto: payload.completionDto });
      }
    });
  }

  compositionEvent(eventId, deliveryLeaseId) {
    if (!OUTBOX_ID.test(eventId ?? "") || !LEASE_ID.test(deliveryLeaseId ?? "")) {
      privateAiError("private_ai_request_invalid", 400);
    }
    const row = this.db.prepare("SELECT * FROM private_ai_composition_outbox WHERE id=?").get(eventId);
    if (!row) privateAiError("private_ai_job_unavailable", 404);
    if (row.status === "delivered" && row.delivered_lease_id === deliveryLeaseId) return { row, replayed: true };
    if (row.status !== "leased" || row.lease_id !== deliveryLeaseId ||
      Date.parse(row.lease_expires_at) <= nowMs(this.clock)) privateAiError("private_ai_lease_unavailable", 409);
    return { row, replayed: false };
  }

  markCompositionEventDelivered({ eventId, deliveryLeaseId } = {}) {
    this.ensureEnabled();
    return transaction(this.db, () => {
      const selected = this.compositionEvent(eventId, deliveryLeaseId);
      if (selected.replayed) return Object.freeze({ delivered: true, replayed: true });
      const now = nowIso(this.clock);
      const changed = this.db.prepare(`UPDATE private_ai_composition_outbox SET status='delivered',
        delivered_at=?,delivered_lease_id=?,lease_id=NULL,lease_expires_at=NULL,last_error=NULL,
        updated_at=?,version=version+1 WHERE id=? AND version=? AND status='leased' AND lease_id=?`).run(
        now, deliveryLeaseId, now, selected.row.id, selected.row.version, deliveryLeaseId);
      if (changed.changes !== 1) privateAiError("private_ai_lease_unavailable", 409);
      if (selected.row.event_type === "provider_unavailable") {
        this.db.prepare(`UPDATE private_ai_jobs SET status='failed',stable_error='composition_requeued',
          lease_id=NULL,lease_expires_at=NULL,question_context_json=?,updated_at=?,version=version+1 WHERE id=?
          AND status IN ('queued','leased','retry')`).run(
          REDACTED_QUESTION_CONTEXT, now, selected.row.ai_job_id);
      }
      return Object.freeze({ delivered: true, replayed: false });
    });
  }

  retryCompositionEvent({ eventId, deliveryLeaseId, failureCode } = {}) {
    this.ensureEnabled();
    if (!["consumer_unavailable", "consumer_conflict", "consumer_internal_failure"].includes(failureCode)) {
      privateAiError("private_ai_failure_code_invalid", 400);
    }
    return transaction(this.db, () => {
      const selected = this.compositionEvent(eventId, deliveryLeaseId);
      if (selected.replayed) privateAiError("private_ai_input_changed", 409);
      const retryAfterMs = this.backoffMs(selected.row.attempts);
      const now = nowIso(this.clock);
      const availableAt = new Date(nowMs(this.clock) + retryAfterMs).toISOString();
      const changed = this.db.prepare(`UPDATE private_ai_composition_outbox SET status='retry',available_at=?,
        lease_id=NULL,lease_expires_at=NULL,last_error=?,updated_at=?,version=version+1
        WHERE id=? AND version=? AND status='leased' AND lease_id=?`).run(availableAt, failureCode, now,
        selected.row.id, selected.row.version, deliveryLeaseId);
      if (changed.changes !== 1) privateAiError("private_ai_lease_unavailable", 409);
      return Object.freeze({ status: "retry", retryAfterMs });
    });
  }
}
