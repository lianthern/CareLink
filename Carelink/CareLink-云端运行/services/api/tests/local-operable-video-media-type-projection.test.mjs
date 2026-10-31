import { approveFixtureRegistrations } from './approve-fixture-registrations.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mp4 } from "./fixture-factory.mjs";

// Regression test for infra/integration/local-operable.mjs's photoProjection(): it re-queries
// `SELECT * FROM photos ...` (so `photo.media_type` is present on every row it handles) but its
// hand-built return object never included a `mediaType` field. Every real GET
// /v1/viewer/spaces/{sid} response therefore had `photos[i].mediaType === undefined`, video or
// not -- apps/web's album-grid video corner badge (`photo.mediaType === "video"`, see
// apps/web/src/ui/templates.js's albumPage()) could never fire against the real server even
// though services/api/src/read-service.mjs's own viewerSpace() SQL selects the column.
// (This test pins the local-operable projection specifically. It used to note that
// read-service.mjs's viewerSpace() returned snake_case but that its raw output "never reaches the
// wire" because adaptJsonBody()/viewerSpaceProjection() rebuilds the DTO -- true here, but only
// here: production boots infra/integration/book-lab/deployment-entrypoint.mjs, which serves
// LocalApi through createLocalHttpServer() with no adapter, so viewerSpace()'s own projection is
// exactly what production returns. That second path had the same mediaType gap plus
// placementState/confirmationMode, and is now aliased in the SQL and pinned by
// viewer-space-camelcase-projection.test.mjs.)
//
// This spawns the real local-operable runtime end to end (HTTP only, matching the sibling
// member-invitation-membership-management-projection.test.mjs pattern) and drives a full real
// video upload (consent -> batch -> item -> upload-session -> PUT bytes -> commit, with a real
// ffmpeg transcode happening synchronously inside the commit call) so the assertion below is
// against the actual production response shape, not a hand-built fixture.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function poll(run, label, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await run();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout:${label}:${lastError?.message ?? lastError ?? ""}`);
}

async function startLocalOperable() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "unseen-local-operable-video-test-"));
  const dataRoot = path.join(temporaryRoot, "data");
  const evidenceRoot = path.join(temporaryRoot, "evidence");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["infra/integration/local-operable.mjs"], {
    cwd: repoRoot,
    env: { ...process.env, UNSEEN_LOCAL_PORT: String(port), UNSEEN_LOCAL_DATA_DIR: dataRoot,
      UNSEEN_LOCAL_EVIDENCE_DIR: evidenceRoot,
      // This test drives /v1/auth/email-otp-challenges directly over HTTP without solving a PoW
      // challenge first; local-operable.mjs defaults UNSEEN_OTP_CAPTCHA_PROVIDER to "pow" for a
      // real boot, so this login flow needs to opt out explicitly (same as the sibling
      // member-invitation-membership-management-projection.test.mjs).
      UNSEEN_OTP_CAPTCHA_PROVIDER: "disabled" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderrOutput = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (bytes) => { stderrOutput += bytes; });
  const startup = await poll(async () => JSON.parse(await readFile(path.join(evidenceRoot, "LOCAL-STARTUP.json"), "utf8")),
    "startup").catch((error) => { throw new Error(`${error.message}\nstderr:${stderrOutput}`); });
  await poll(async () => (await fetch(`${startup.origin}/healthz`)).ok, "health");
  approveFixtureRegistrations(dataRoot);
  return {
    origin: startup.origin,
    dataRoot,
    async stop() {
      if (child.exitCode !== null) { await rm(temporaryRoot, { recursive: true, force: true }); return; }
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };
}

function extractCookie(response, name) {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return null;
}

async function jsonRequest(origin, method, pathname, { body, headers = {} } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, headers: response.headers, body: value };
}

// Binary counterpart of jsonRequest(), used only for the raw media PUT below -- the body is the
// video's actual bytes, not a JSON-encoded object.
async function binaryRequest(origin, method, pathname, { body, headers = {} } = {}) {
  const response = await fetch(`${origin}${pathname}`, { method, headers, body });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, headers: response.headers, body: value };
}

async function loginViaOtp(origin, email) {
  const challenge = await jsonRequest(origin, "POST", "/v1/auth/email-otp-challenges", {
    body: { email, purpose: "login", locale: "zh-CN" },
    headers: { "idempotency-key": `test-otp-challenge-${crypto.randomUUID()}` }
  });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  return challenge.body.challengeId;
}

// A ticket may come back as a bare string (account uploads) or an envelope carrying the real
// header value under .headers["X-Upload-Ticket"] -- same extraction rule
// services/api/tests/red-team-http.test.mjs's rawUploadTicket() already uses for this endpoint.
function rawUploadTicket(ticket) {
  return typeof ticket === "string" ? ticket : ticket?.headers?.["X-Upload-Ticket"];
}

test("local-operable's real GET /v1/viewer/spaces/{sid} response includes photos[].mediaType==='video' for a committed video upload", async () => {
  const runtime = await startLocalOperable();
  try {
    const ownerEmail = `owner-video-media-type-${Date.now()}@example.test`;
    const challengeId = await loginViaOtp(runtime.origin, ownerEmail);
    const mailboxPath = path.join(runtime.dataRoot, ".otp-mailbox.json");
    const mailbox = await poll(async () => {
      const value = JSON.parse(await readFile(mailboxPath, "utf8"));
      return value.challengeId === challengeId ? value : null;
    }, "otp mailbox");
    const verified = await jsonRequest(runtime.origin, "POST", "/v1/auth/email-otp-verifications", {
      body: { challengeId, otp: mailbox.code, purpose: "login" },
      headers: { "idempotency-key": `test-otp-verify-${crypto.randomUUID()}` }
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const accountSecret = extractCookie(verified, "__Host-unseen_account");
    assert.ok(accountSecret, "expected __Host-unseen_account session cookie");
    const cookie = `__Host-unseen_account=${accountSecret}`;
    const sameOriginHeaders = { origin: runtime.origin, "sec-fetch-site": "same-origin" };

    const space = await jsonRequest(runtime.origin, "POST", "/v1/spaces", {
      body: { name: "Video Media Type Projection Space" },
      headers: { "idempotency-key": `test-space-${crypto.randomUUID()}`, cookie, ...sameOriginHeaders }
    });
    assert.equal(space.status, 200, JSON.stringify(space.body));
    const spaceId = space.body.spaceId;

    // A fresh space rejects uploads until collection is "open" (services/api/src/upload-service.mjs's
    // createBatch(): `assert(access.space.collection_state === "open", "upload_unavailable", 403)`)
    // -- mirrors fixture-factory.mjs's openSpace() helper used by every in-process upload test.
    const collectionOpen = await jsonRequest(runtime.origin, "POST", `/v1/spaces/${spaceId}/collection-transitions`, {
      body: { to: "open" },
      headers: { "idempotency-key": `test-collection-open-${crypto.randomUUID()}`, cookie,
        "if-match": String(space.body.version), ...sameOriginHeaders }
    });
    assert.equal(collectionOpen.status, 200, JSON.stringify(collectionOpen.body));
    const sharingShared = await jsonRequest(runtime.origin, "POST", `/v1/spaces/${spaceId}/sharing-transitions`, {
      body: { to: "shared" },
      headers: { "idempotency-key": `test-sharing-shared-${crypto.randomUUID()}`, cookie,
        "if-match": String(collectionOpen.body.version), ...sameOriginHeaders }
    });
    assert.equal(sharingShared.status, 200, JSON.stringify(sharingShared.body));

    // LocalApi seeds media_notices at construction (services/api/src/api.mjs) -- there is no HTTP
    // route that hands out this notice hash, so read it straight off this boot's own sqlite file
    // the same way tests/e2e/local-operable.e2e.mjs already does for other read-only lookups.
    const database = new DatabaseSync(path.join(runtime.dataRoot, "unseen.sqlite"), { readOnly: true });
    const notice = database.prepare(
      "SELECT version,content_hash FROM media_notices WHERE locale='zh-CN' ORDER BY version DESC LIMIT 1").get();
    database.close();
    assert.ok(notice, "expected a seeded zh-CN media notice");

    const consent = await jsonRequest(runtime.origin, "POST", "/v1/consent-events", {
      body: { purpose: "photo_upload", noticeVersion: notice.version, noticeHash: notice.content_hash },
      headers: { "idempotency-key": `test-consent-${crypto.randomUUID()}`, cookie, ...sameOriginHeaders }
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.body));

    const batch = await jsonRequest(runtime.origin, "POST", `/v1/spaces/${spaceId}/contribution-batches`, {
      body: { clientBatchId: "video-media-type-batch", consentEventId: consent.body.consentEventId, declaredItemCount: 1 },
      headers: { "idempotency-key": `test-batch-${crypto.randomUUID()}`, cookie, ...sameOriginHeaders }
    });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));

    // A real, tiny, ffmpeg-encoded mp4 -- same fixture the rest of the video-v0 test suite uses
    // (services/api/tests/video-inspect.test.mjs etc.), so this exercises the real synchronous
    // probe/poster/transcode pipeline inside the commit call below, not a stub.
    const videoBytes = mp4(320, 240, 1, 5);

    const item = await jsonRequest(runtime.origin, "POST", `/v1/contribution-batches/${batch.body.batchId}/items`, {
      body: { clientItemId: "video-item-1", declaredMime: "video/mp4", declaredBytes: videoBytes.length, fileNameHash: "not-a-name" },
      headers: { "idempotency-key": `test-item-${crypto.randomUUID()}`, cookie,
        "if-match": String(batch.body.version), "x-space-version": String(sharingShared.body.version), ...sameOriginHeaders }
    });
    assert.equal(item.status, 200, JSON.stringify(item.body));

    const upload = await jsonRequest(runtime.origin, "POST",
      `/v1/contribution-batches/${batch.body.batchId}/items/${item.body.itemId}/upload-sessions`, {
        body: { declaredMime: "video/mp4", declaredBytes: videoBytes.length, clientUploadId: "video-upload-1" },
        headers: { "idempotency-key": `test-upload-${crypto.randomUUID()}`, cookie,
          "if-match": String(item.body.version), ...sameOriginHeaders }
      });
    assert.equal(upload.status, 200, JSON.stringify(upload.body));

    const put = await binaryRequest(runtime.origin, "PUT", "/__local/media", {
      body: videoBytes,
      headers: { "x-upload-ticket": rawUploadTicket(upload.body.oneTimeUploadTicket), "content-type": "video/mp4",
        cookie, ...sameOriginHeaders }
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const committed = await jsonRequest(runtime.origin, "POST", `/v1/upload-sessions/${upload.body.uploadSessionId}/commits`, {
      body: { clientCommitId: "video-commit-1" },
      headers: { "idempotency-key": `test-commit-${crypto.randomUUID()}`, cookie,
        "if-match": String(put.body.uploadSessionVersion), "x-item-version": String(upload.body.itemVersion), ...sameOriginHeaders }
    });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));

    const viewerSpace = await jsonRequest(runtime.origin, "GET", `/v1/viewer/spaces/${spaceId}`, { headers: { cookie } });
    assert.equal(viewerSpace.status, 200, JSON.stringify(viewerSpace.body));
    assert.ok(Array.isArray(viewerSpace.body.photos) && viewerSpace.body.photos.length === 1,
      `expected exactly one photo in the album, got ${JSON.stringify(viewerSpace.body.photos)}`);
    assert.equal(viewerSpace.body.photos[0].mediaType, "video",
      "the real album response must carry mediaType so apps/web's video corner badge can fire");
  } finally {
    await runtime.stop();
  }
});
