import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalApi } from "../src/api.mjs";
import { sha256, stableJson } from "../src/util.mjs";

export class TestClock {
  constructor(value = "2026-08-13T00:00:00.000Z") { this.value = Date.parse(value); }
  now = () => this.value;
  advance(ms) { this.value += ms; }
  iso() { return new Date(this.value).toISOString(); }
}

export function fixture(options = {}) {
  const clock = new TestClock();
  const otp = [];
  // Tests seed already-approved users unless explicitly exercising registration admission.
  const api = new LocalApi({ database: ":memory:", autoApproveRegistrations: true, clock, otpSink: (message) => otp.push(message),
    publicOrigin: "http://127.0.0.1:8787", ...options });
  let sequence = 0;
  async function call(method, path, body = {}, headers = {}) {
    const result = await api.handle({ method, path, body, headers: {
      ...(method === "GET" ? {} : { "idempotency-key": `test-idempotency-${++sequence}-abcdefgh` }),
      ...headers
    } });
    return result;
  }
  async function ok(method, path, body = {}, headers = {}) {
    const result = await call(method, path, body, headers);
    assert.ok(result.status >= 200 && result.status < 300,
      `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  }
  async function login(email = `person-${sequence}@example.test`) {
    const requested = await ok("POST", "/v1/auth/email-otp-challenges", { email, purpose: "login" });
    const message = otp.findLast((item) => item.challengeId === requested.challengeId);
    const verified = await ok("POST", "/v1/auth/email-otp-verifications",
      { challengeId: requested.challengeId, otp: message.code, purpose: "login" });
    return { ...verified, token: verified.accountSessionSecret, headers: { authorization: `Bearer ${verified.accountSessionSecret}` } };
  }
  async function reauth(account, actionId, purpose, targetType = null, targetId = null) {
    const requested = await ok("POST", "/v1/auth/reauth-challenges",
      { actionId, purpose, ...(targetType ? { targetType, targetId } : {}) }, account.headers);
    const message = otp.findLast((item) => item.challengeId === requested.challengeId);
    return ok("POST", "/v1/auth/reauth-verifications",
      { challengeId: requested.challengeId, otp: message.code, actionId, purpose,
        ...(targetType ? { targetType, targetId } : {}) }, account.headers);
  }
  async function createSpace(account, name = "Contract space") {
    return ok("POST", "/v1/spaces", { name }, { ...account.headers,
      "notice-acknowledgement": JSON.stringify({ purpose: "space_create", version: 1, contentHash: "local-space_create-v1" }) });
  }
  async function transition(account, spaceId, kind, to, version) {
    return ok("POST", `/v1/spaces/${spaceId}/${kind}-transitions`, { to }, { ...account.headers, "if-match": String(version) });
  }
  async function openSpace(account, space) {
    const collection = await transition(account, space.spaceId, "collection", "open", space.version);
    const sharing = await transition(account, space.spaceId, "sharing", "shared", collection.version);
    return { ...space, version: sharing.version, collectionState: "open", sharingState: "shared" };
  }
  const mediaConsentBody = () => {
    const notice = api.db.prepare(`SELECT version,content_hash FROM media_notices
      WHERE locale='zh-CN' ORDER BY version DESC LIMIT 1`).get();
    return { purpose: "photo_upload", noticeVersion: notice.version, noticeHash: notice.content_hash };
  };
  return { api, db: api.db, clock, otp, call, ok, login, reauth, createSpace, transition, openSpace, mediaConsentBody,
    close: () => api.close() };
}

export function png(width = 32, height = 16, color = "#335577") {
  const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    `color=c=${color}:s=${width}x${height}:d=0.04`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
  { maxBuffer: 60 * 1024 * 1024, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

// A real, ffmpeg-encoded mp4 -- deliberately *without* -movflags +faststart, matching an
// un-post-processed phone recording (moov atom at the end of the file). The mov/mp4 muxer
// refuses non-seekable output altogether ("muxer does not support non seekable output") even
// without faststart, so -- exactly like FfmpegVideoRunner's own transcode() -- this writes to a
// real temp file and reads it back rather than piping through stdout. Kept tiny (a couple of
// frames) so the test suite stays fast; video.mjs's own duration/resolution tests build their own
// longer/larger fixtures where the limit itself is what's under test.
export function mp4(width = 320, height = 240, durationSeconds = 1, fps = 5) {
  const file = path.join(os.tmpdir(), `unseen-test-fixture-${randomBytes(8).toString("hex")}.mp4`);
  try {
    const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
      `testsrc=size=${width}x${height}:duration=${durationSeconds}:rate=${fps}`,
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-f", "mp4", "-y", file],
    { maxBuffer: 100 * 1024 * 1024, timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr.toString());
    return readFileSync(file);
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

// Same shape as mp4() above but with a real (sine tone) audio track muxed in -- used by tests
// that need to exercise FfmpegVideoRunner.transcode()'s audio-preserving path end to end. The
// source track is encoded as AAC too: transcode() re-encodes whatever audio codec it's handed,
// so the fixture's own codec choice is irrelevant to what's under test, and AAC-in-mp4 is a
// container/codec pairing every ffmpeg build here supports without extra fuss.
export function mp4WithAudio(width = 320, height = 240, durationSeconds = 1, fps = 5) {
  const file = path.join(os.tmpdir(), `unseen-test-fixture-audio-${randomBytes(8).toString("hex")}.mp4`);
  try {
    const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
      `testsrc=size=${width}x${height}:duration=${durationSeconds}:rate=${fps}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSeconds}`,
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-f", "mp4", "-y", file],
    { maxBuffer: 100 * 1024 * 1024, timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr.toString());
    return readFileSync(file);
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

// A second, distinguishable (different tone) audio track muxed in alongside the first -- used to
// prove transcode()'s "-map 0:a:0?" keeps only the *first* audio stream when a source carries
// several (multi-track uploads from some cameras/editing apps).
export function mp4WithTwoAudioTracks(width = 320, height = 240, durationSeconds = 1, fps = 5) {
  const file = path.join(os.tmpdir(), `unseen-test-fixture-audio2-${randomBytes(8).toString("hex")}.mp4`);
  try {
    const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
      `testsrc=size=${width}x${height}:duration=${durationSeconds}:rate=${fps}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSeconds}`,
      "-f", "lavfi", "-i", `sine=frequency=880:duration=${durationSeconds}`,
      "-map", "0:v", "-map", "1:a", "-map", "2:a",
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-f", "mp4", "-y", file],
    { maxBuffer: 100 * 1024 * 1024, timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr.toString());
    return readFileSync(file);
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

export async function createAccountUpload(f, account, space, bytes = png(), mime = "image/png") {
  const consent = await f.ok("POST", "/v1/consent-events", {
    ...f.mediaConsentBody()
  }, account.headers);
  const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`,
    { clientBatchId: `client-${Date.now()}`, consentEventId: consent.consentEventId, declaredItemCount: 1 }, account.headers);
  const item = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`,
    { clientItemId: "item-1", declaredMime: mime, declaredBytes: bytes.length, fileNameHash: "not-a-name" },
    { ...account.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
  const upload = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`,
    { declaredMime: mime, declaredBytes: bytes.length, clientUploadId: "upload-1" },
    { ...account.headers, "if-match": String(item.version) });
  const put = await f.api.putMedia({ ticket: upload.oneTimeUploadTicket, bytes, contentType: mime });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const committed = await f.ok("POST", `/v1/upload-sessions/${upload.uploadSessionId}/commits`,
    { clientCommitId: "commit-1" }, { ...account.headers, "if-match": String(put.body.uploadSessionVersion),
      "x-item-version": String(upload.itemVersion) });
  const batchRow = f.db.prepare("SELECT * FROM contribution_batches WHERE id=?").get(batch.batchId);
  const itemRows = f.db.prepare("SELECT id,status,version,failure_code failureCode FROM contribution_batch_items WHERE batch_id=? ORDER BY rowid")
    .all(batch.batchId).map(({ id: itemId, status, version, failureCode }) => ({ itemId, status, version, failureCode }));
  const digest = sha256(stableJson(itemRows));
  const finalized = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/finalizations`,
    { itemsDigest: digest, clientRequestId: "finalize-1" }, { ...account.headers, "if-match": String(batchRow.version) });
  return { consent, batch, item, upload, committed, finalized, bytes };
}

export async function exchangeReceipt(f, finalized, idempotency = "receipt-exchange-abcdefgh") {
  const secret = finalized.oneTimeSecret;
  const result = await f.call("POST", "/v1/batch-receipt-exchanges",
    { receiptSecretFromClearedBootstrap: secret, clientNonce: "receipt-client" }, { "idempotency-key": idempotency });
  return result;
}
