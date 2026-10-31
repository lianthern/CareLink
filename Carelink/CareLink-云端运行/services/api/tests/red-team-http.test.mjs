import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request as nodeRequest } from "node:http";
import { createLocalHttpServer, listenLocalHttpServer } from "../src/http-server.mjs";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createAccountUpload, fixture, png } from "./fixture-factory.mjs";
import { sha256 } from "../src/util.mjs";
import { ApiError } from "../src/errors.mjs";

function noisyPanorama() {
  const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "nullsrc=s=1600x800,geq=random(1)*255:random(2)*255:random(3)*255", "-frames:v", "1",
    "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { maxBuffer: 10 * 1024 * 1024, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.ok(result.stdout.length > 1024 * 1024);
  return result.stdout;
}

function pngChunkTypes(bytes) {
  const types = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    types.push(bytes.toString("ascii", offset + 4, offset + 8));
    offset += 12 + length;
    if (types.at(-1) === "IEND") break;
  }
  return types;
}

class CookieJar {
  constructor() { this.values = new Map(); }
  capture(headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() :
      (headers.get("set-cookie") ? headers.get("set-cookie").split(/,\s*(?=__Host-)/) : []);
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index);
      if (/;\s*Max-Age=0(?:;|$)/i.test(value)) this.values.delete(name);
      else this.values.set(name, pair.slice(index + 1));
    }
  }
  header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join("; "); }
}

function originHeaders(origin) {
  return { origin, "sec-fetch-site": "same-origin" };
}

function rawUploadTicket(ticket) {
  return typeof ticket === "string" ? ticket : ticket?.headers?.["X-Upload-Ticket"];
}

async function request(origin, method, path, { body, headers = {}, jar = null, unsafeOrigin = true } = {}) {
  const merged = { ...headers };
  if (jar?.values.size) merged.cookie = jar.header();
  if (unsafeOrigin && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) Object.assign(merged, originHeaders(origin));
  let payload = body;
  if (body != null && !Buffer.isBuffer(body) && typeof body !== "string") {
    payload = JSON.stringify(body);
    merged["content-type"] ??= "application/json";
  }
  if (["POST", "PATCH", "DELETE"].includes(method)) merged["idempotency-key"] ??=
    `http-${crypto.randomUUID()}-abcdefgh`;
  const response = await fetch(`${origin}${path}`, { method, headers: merged, body: payload });
  if (jar) jar.capture(response.headers);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  let responseBody = bytes;
  if (contentType.includes("application/json")) responseBody = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
  return { status: response.status, headers: response.headers, body: responseBody };
}

async function start(f) {
  const server = createLocalHttpServer({ api: f.api });
  const { origin } = await listenLocalHttpServer(server, { host: "127.0.0.1", port: 0 });
  f.api.campaigns.publicOrigin = origin;
  return { origin, server, close: () => new Promise((resolve) => server.close(resolve)) };
}

function rawHost(origin, host) {
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    const request = nodeRequest({ hostname: target.hostname, port: target.port, path: "/healthz", method: "GET",
      headers: { host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function externalJar(http, campaign, nonce, jar = new CookieJar()) {
  const locator = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
  const challenge = await request(http.origin, "POST", "/v1/external-campaign-admission-challenges", {
    jar, body: { publicCampaignId: locator, clientNonce: `${nonce}-challenge-nonce` }
  });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  const admission = await request(http.origin, "POST", "/v1/external-campaign-admissions", {
    jar, body: { publicCampaignId: locator, clientNonce: `${nonce}-challenge-nonce` }
  });
  assert.equal(admission.status, 200, JSON.stringify(admission.body));
  const exchange = await request(http.origin, "POST", "/v1/external-invitation-exchanges", {
    jar, body: { secretFromClearedInviteBootstrap: admission.body.oneTimeSecret, clientNonce: `${nonce}-exchange` }
  });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
  return { jar, exchange: exchange.body };
}

async function createPanorama(f, owner, spaceId, bytes, suffix) {
  const space = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: `pano-${suffix}`
  }, { ...owner.headers, "if-match": String(space.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`, {
    clientRequestId: `pano-commit-${suffix}`
  }, { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  await f.ok("POST", `/v1/spaces/${spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(before.version) });
  return { ...ready, bytes };
}

test("real HTTP CookieJar supports combo view, upload, and case access without ambiguous self-lock", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const owner = await f.login("http-combo-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    // A: f.createSpace() now defaults auto_approve_uploads on, so the photo may already
    // be 'visible' — only approve if it still actually needs it.
    const approvalState = f.db.prepare("SELECT photo_content_state,version FROM photos WHERE id=?").get(photo.id);
    if (approvalState.photo_content_state === "pending") {
      await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
        to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null
      }, { ...owner.headers, "if-match": String(approvalState.version) });
    }
    const currentSpace = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "combo", entryTask: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 10
    }, { ...owner.headers, "if-match": String(currentSpace.version) });
    const visitor = await externalJar(http, campaign, "combo");
    assert.ok(visitor.jar.values.has("__Host-unseen_viewer"));
    assert.ok(visitor.jar.values.has("__Host-unseen_contributor"));

    assert.equal((await request(http.origin, "GET", `/v1/viewer/spaces/${space.spaceId}`, {
      jar: visitor.jar })).status, 200);
    const consent = await request(http.origin, "POST", "/v1/consent-events", { jar: visitor.jar, body: {
      ...f.mediaConsentBody()
    } });
    assert.equal(consent.status, 200, JSON.stringify(consent.body));
    const batch = await request(http.origin, "POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
      jar: visitor.jar, body: { clientBatchId: "combo-http", consentEventId: consent.body.consentEventId,
        declaredItemCount: 1 }
    });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const uploadBytes = Buffer.alloc(2 * 1024 * 1024, 0x31);
    const item = await request(http.origin, "POST", `/v1/contribution-batches/${batch.body.batchId}/items`, {
      jar: visitor.jar, headers: { "if-match": String(batch.body.version), "x-space-version": String(currentSpace.version) },
      body: { clientItemId: "combo-item", declaredMime: "image/png", declaredBytes: uploadBytes.length,
        fileNameHash: "opaque" }
    });
    assert.equal(item.status, 200, JSON.stringify(item.body));
    const upload = await request(http.origin, "POST",
      `/v1/contribution-batches/${batch.body.batchId}/items/${item.body.itemId}/upload-sessions`, {
        jar: visitor.jar, headers: { "if-match": String(item.body.version) }, body: {
          declaredMime: "image/png", declaredBytes: uploadBytes.length, clientUploadId: "combo-upload"
        }
      });
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    const put = await request(http.origin, "PUT", "/__local/media", { jar: visitor.jar,
      headers: { "x-upload-ticket": rawUploadTicket(upload.body.oneTimeUploadTicket), "content-type": "image/png" }, body: uploadBytes });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const reportBody = {
      targetRef: { photoId: photo.id }, category: "privacy", description: "combo report", clientRequestId: "combo-case"
    };
    const reportHeaders = { "idempotency-key": "combo-case-replay-abcdefgh",
      "notice-acknowledgement": JSON.stringify({ purpose: "object_report", version: 1,
        contentHash: "local-object_report-v1" }) };
    const report = await request(http.origin, "POST", "/v1/reports", { jar: visitor.jar,
      headers: reportHeaders, body: reportBody });
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.ok(visitor.jar.values.has("__Host-unseen_case"));
    const oldCaseCookie = visitor.jar.values.get("__Host-unseen_case");
    const reportReplay = await request(http.origin, "POST", "/v1/reports", { jar: visitor.jar,
      headers: reportHeaders, body: reportBody });
    assert.equal(reportReplay.status, 200);
    assert.equal(reportReplay.body.caseId, report.body.caseId);
    assert.notEqual(visitor.jar.values.get("__Host-unseen_case"), oldCaseCookie);
    assert.equal((await request(http.origin, "GET", `/v1/reports/${report.body.caseId}`, {
      headers: { "x-case-access-session": oldCaseCookie } })).status, 404);
    assert.equal((await request(http.origin, "GET", `/v1/reports/${report.body.caseId}`, {
      jar: visitor.jar })).status, 200);

    const other = await f.createSpace(owner, "Other scope");
    const crossScope = await request(http.origin, "GET", `/v1/spaces/${other.spaceId}/upload-context`, {
      jar: visitor.jar
    });
    assert.ok([403, 404].includes(crossScope.status));
  } finally { await http.close(); f.close(); }
});

test("revoked invitation HTTP reads preserve the same browser's valid owner account cookie", async () => {
  const f = fixture(), http = await start(f);
  try {
    const owner = await f.login('owner-invitation-cookie@example.test'), jar = new CookieJar();
    jar.values.set('__Host-unseen_account', owner.token);
    const space = await f.openSpace(owner, await f.createSpace(owner));
    const campaign = await f.ok('POST', `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: 'combo', entryTask: 'view', expiresAt: '2026-08-14T00:00:00.000Z', maxSuccessfulUses: 10
    }, { ...owner.headers, 'if-match': String(space.version) });
    await externalJar(http, campaign, 'owner-same-browser-invitation', jar);
    assert.equal(jar.values.get('__Host-unseen_account'), owner.token);
    assert.ok(jar.values.get('__Host-unseen_viewer')); assert.ok(jar.values.get('__Host-unseen_contributor'));
    const viewerPath = `/v1/viewer/spaces/${space.spaceId}?access=invitation`;
    assert.equal((await request(http.origin, 'GET', viewerPath, { jar })).status, 200);
    const campaignVersion = f.db.prepare('SELECT version FROM external_invitation_campaigns WHERE id=?').get(campaign.campaignId).version;
    const revoked = await request(http.origin, 'POST', `/v1/external-invitation-campaigns/${campaign.campaignId}/revocations`, {
      jar, headers: { 'if-match': String(campaignVersion) }, body: { reasonClass: 'owner_revoked' }
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    for (const pathname of [viewerPath,
      `/v1/viewer/spaces/${space.spaceId}/photos/not-a-photo/media?access=invitation`,
      `/v1/spaces/${space.spaceId}/upload-context?access=invitation`]) {
      const denied = await request(http.origin, 'GET', pathname, { jar });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('set-cookie'), null);
      assert.equal(jar.values.get('__Host-unseen_account'), owner.token);
      assert.equal((await request(http.origin, 'GET', '/v1/profile', { jar })).status, 200);
    }
    assert.equal((await request(http.origin, 'GET', viewerPath, { jar })).body.error.code, 'session_unavailable');
    // Account access is still valid, and an actually stale account retains the original clearing behavior.
    await f.ok('POST', '/v1/auth/logout', {}, owner.headers);
    const accountFailure = await request(http.origin, 'GET', '/v1/profile?access=invitation', { jar });
    assert.equal(accountFailure.status, 401); assert.equal(accountFailure.body.error.code, 'session_unavailable');
    assert.match(accountFailure.headers.get('set-cookie'), /__Host-unseen_account=;.*Max-Age=0/);
    assert.equal(jar.values.has('__Host-unseen_account'), false);
  } finally { await http.close(); f.close(); }
});

test("HTTP catch-path session failures use the request access scope before clearing an account cookie", async () => {
  const f = fixture(), http = await start(f);
  try {
    const owner = await f.login('catch-scope-cookie@example.test'), jar = new CookieJar();
    jar.values.set('__Host-unseen_account', owner.token);
    const handle = f.api.handle.bind(f.api);
    // Force the outer HTTP error boundary, rather than LocalApi.handle's normal error DTO.
    f.api.handle = async () => { throw new ApiError('session_unavailable', 401); };
    const invitationFailure = await request(http.origin, 'GET', '/v1/viewer/spaces/synthetic?access=invitation', { jar });
    assert.equal(invitationFailure.status, 401); assert.equal(invitationFailure.body.error.code, 'session_unavailable');
    assert.equal(invitationFailure.headers.get('set-cookie'), null);
    assert.equal(jar.values.get('__Host-unseen_account'), owner.token);
    f.api.handle = handle;
    assert.equal((await request(http.origin, 'GET', '/v1/profile', { jar })).status, 200);
    await f.ok('POST', '/v1/auth/logout', {}, owner.headers);
    // Moment upload pre-authentication throws into the outer catch before admitting its larger body.
    const accountFailure = await request(http.origin, 'PUT', '/v1/moments/synthetic?access=invitation', { jar, body: {} });
    assert.equal(accountFailure.status, 401); assert.equal(accountFailure.body.error.code, 'session_unavailable');
    assert.match(accountFailure.headers.get('set-cookie'), /__Host-unseen_account=;.*Max-Age=0/);
    assert.equal(jar.values.has('__Host-unseen_account'), false);
  } finally { await http.close(); f.close(); }
});

test("real HTTP logout clears only account authority before same-browser external admission", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const unrelated401 = await request(http.origin, "GET", "/v1/me");
    assert.equal(unrelated401.status, 401);
    assert.equal(unrelated401.body.error.code, "session_unavailable");
    assert.equal(unrelated401.headers.get("set-cookie"), null);

    const jar = new CookieJar();
    const loginChallenge = await request(http.origin, "POST", "/v1/auth/email-otp-challenges", {
      jar, body: { email: "logout-cookie-http@example.test", purpose: "login" }
    });
    const loginCode = f.otp.findLast((entry) => entry.challengeId === loginChallenge.body.challengeId).code;
    const login = await request(http.origin, "POST", "/v1/auth/email-otp-verifications", {
      jar, body: { challengeId: loginChallenge.body.challengeId, otp: loginCode, purpose: "login" }
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const firstAccountCookie = jar.values.get("__Host-unseen_account");
    assert.ok(firstAccountCookie);

    const created = await request(http.origin, "POST", "/v1/spaces", { jar,
      headers: { "notice-acknowledgement": JSON.stringify({ purpose: "space_create", version: 1,
        contentHash: "local-space_create-v1" }) }, body: { name: "Logout external handoff" } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const collection = await request(http.origin, "POST", `/v1/spaces/${created.body.spaceId}/collection-transitions`, {
      jar, headers: { "if-match": String(created.body.version) }, body: { to: "open" }
    });
    assert.equal(collection.status, 200, JSON.stringify(collection.body));
    const sharing = await request(http.origin, "POST", `/v1/spaces/${created.body.spaceId}/sharing-transitions`, {
      jar, headers: { "if-match": String(collection.body.version) }, body: { to: "shared" }
    });
    assert.equal(sharing.status, 200, JSON.stringify(sharing.body));
    const comboCampaign = await request(http.origin, "POST",
      `/v1/spaces/${created.body.spaceId}/external-invitation-campaigns`, {
        jar, headers: { "if-match": String(sharing.body.version) }, body: {
          taskMode: "combo", entryTask: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 10
        }
      });
    assert.equal(comboCampaign.status, 200, JSON.stringify(comboCampaign.body));
    const spaceAfterCombo = f.db.prepare("SELECT version FROM spaces WHERE id=?").get(created.body.spaceId);
    const viewCampaign = await request(http.origin, "POST",
      `/v1/spaces/${created.body.spaceId}/external-invitation-campaigns`, {
        jar, headers: { "if-match": String(spaceAfterCombo.version) }, body: {
          taskMode: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 10
        }
      });
    assert.equal(viewCampaign.status, 200, JSON.stringify(viewCampaign.body));

    const logoutHeaders = { "idempotency-key": "logout-lost-response-abcdefgh", cookie: jar.header() };
    const logout = await request(http.origin, "POST", "/v1/auth/logout", { headers: logoutHeaders, body: {} });
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
    assert.deepEqual(logout.body, { revoked: true, sessionId: login.body.accountSessionId });
    assert.equal(logout.headers.get("set-cookie"),
      "__Host-unseen_account=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    assert.equal(logout.headers.get("set-cookie").includes("Domain="), false);
    assert.equal(jar.values.get("__Host-unseen_account"), firstAccountCookie);
    const logoutReplay = await request(http.origin, "POST", "/v1/auth/logout", { jar,
      headers: { "idempotency-key": logoutHeaders["idempotency-key"] }, body: {} });
    assert.equal(logoutReplay.status, 401);
    assert.equal(logoutReplay.body.error.code, "session_unavailable");
    assert.equal(logoutReplay.headers.get("set-cookie"),
      "__Host-unseen_account=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    assert.equal(jar.values.has("__Host-unseen_account"), false);

    const visitor = await externalJar(http, comboCampaign.body, "same-browser-logout", jar);
    assert.deepEqual(visitor.exchange.tasks, ["view", "upload"]);
    assert.ok(jar.values.get("__Host-unseen_viewer"));
    assert.ok(jar.values.get("__Host-unseen_contributor"));
    assert.equal((await request(http.origin, "GET", `/v1/viewer/spaces/${created.body.spaceId}`, { jar })).status, 200);
    assert.equal((await request(http.origin, "GET", `/v1/spaces/${created.body.spaceId}/upload-context`, { jar })).status, 200);

    jar.values.set("__Host-unseen_account", firstAccountCookie);
    const staleAccount = await request(http.origin, "GET", `/v1/viewer/spaces/${created.body.spaceId}`, { jar });
    assert.equal(staleAccount.status, 401);
    assert.equal(staleAccount.body.error.code, "session_unavailable");
    assert.equal(staleAccount.headers.get("set-cookie"),
      "__Host-unseen_account=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    assert.equal(jar.values.has("__Host-unseen_account"), false);
    assert.equal((await request(http.origin, "GET", `/v1/spaces/${created.body.spaceId}/upload-context`, { jar })).status, 200);

    const reloginChallenge = await request(http.origin, "POST", "/v1/auth/email-otp-challenges", {
      jar, body: { email: "logout-cookie-http@example.test", purpose: "login" }
    });
    const reloginCode = f.otp.findLast((entry) => entry.challengeId === reloginChallenge.body.challengeId).code;
    const relogin = await request(http.origin, "POST", "/v1/auth/email-otp-verifications", {
      jar, body: { challengeId: reloginChallenge.body.challengeId, otp: reloginCode, purpose: "login" }
    });
    assert.equal(relogin.status, 200, JSON.stringify(relogin.body));
    const secondAccountCookie = jar.values.get("__Host-unseen_account");
    const viewerCookie = jar.values.get("__Host-unseen_viewer");
    const contributorCookie = jar.values.get("__Host-unseen_contributor");
    const reauthChallenge = await request(http.origin, "POST", "/v1/auth/reauth-challenges", { jar,
      body: { actionId: "AUTH.LOGOUT_ALL", purpose: "logout_all" } });
    const reauthCode = f.otp.findLast((entry) => entry.challengeId === reauthChallenge.body.challengeId).code;
    const reauth = await request(http.origin, "POST", "/v1/auth/reauth-verifications", { jar, body: {
      challengeId: reauthChallenge.body.challengeId, otp: reauthCode, actionId: "AUTH.LOGOUT_ALL", purpose: "logout_all"
    } });
    const logoutAllBody = { reauthGrant: reauth.body.reauthGrantSecret, confirmation: true };
    const logoutAllHeaders = { "idempotency-key": "logout-all-lost-response-abcdefgh", cookie: jar.header() };
    const logoutAll = await request(http.origin, "POST", "/v1/auth/logout-all", {
      headers: logoutAllHeaders, body: logoutAllBody });
    assert.equal(logoutAll.status, 200, JSON.stringify(logoutAll.body));
    assert.deepEqual(Object.keys(logoutAll.body).sort(), ["revokedAt", "sessionEpoch"]);
    assert.equal(logoutAll.headers.get("set-cookie"),
      "__Host-unseen_account=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    assert.equal(jar.values.get("__Host-unseen_account"), secondAccountCookie);
    const logoutAllReplay = await request(http.origin, "POST", "/v1/auth/logout-all", { jar,
      headers: { "idempotency-key": logoutAllHeaders["idempotency-key"] }, body: logoutAllBody });
    assert.equal(logoutAllReplay.status, 401);
    assert.equal(logoutAllReplay.body.error.code, "session_unavailable");
    assert.equal(logoutAllReplay.headers.get("set-cookie"),
      "__Host-unseen_account=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    assert.equal(jar.values.has("__Host-unseen_account"), false);
    assert.equal(jar.values.get("__Host-unseen_viewer"), viewerCookie);
    assert.equal(jar.values.get("__Host-unseen_contributor"), contributorCookie);
    assert.equal((await request(http.origin, "GET", `/v1/viewer/spaces/${created.body.spaceId}`, { jar })).status, 200);
    assert.equal((await request(http.origin, "GET", `/v1/spaces/${created.body.spaceId}/upload-context`, { jar })).status, 200);

    jar.values.set("__Host-unseen_account", secondAccountCookie);
    assert.equal((await request(http.origin, "GET", `/v1/viewer/spaces/${created.body.spaceId}`, { jar })).status, 401);
    assert.equal(jar.values.has("__Host-unseen_account"), false);

    const viewOnly = await externalJar(http, viewCampaign.body, "fresh-view-only");
    assert.deepEqual(viewOnly.exchange.tasks, ["view"]);
    assert.equal((await request(http.origin, "GET", `/v1/viewer/spaces/${created.body.spaceId}`, {
      jar: viewOnly.jar })).status, 200);
    assert.equal((await request(http.origin, "GET", `/v1/spaces/${created.body.spaceId}/upload-context`, {
      jar: viewOnly.jar })).status, 401);

    const ownerJar = new CookieJar();
    const ownerChallenge = await request(http.origin, "POST", "/v1/auth/email-otp-challenges", {
      jar: ownerJar, body: { email: "logout-cookie-http@example.test", purpose: "login" }
    });
    const ownerCode = f.otp.findLast((entry) => entry.challengeId === ownerChallenge.body.challengeId).code;
    await request(http.origin, "POST", "/v1/auth/email-otp-verifications", { jar: ownerJar,
      body: { challengeId: ownerChallenge.body.challengeId, otp: ownerCode, purpose: "login" } });
    const comboBeforeRevoke = f.db.prepare("SELECT version FROM external_invitation_campaigns WHERE id=?")
      .get(comboCampaign.body.campaignId);
    const revoked = await request(http.origin, "POST",
      `/v1/external-invitation-campaigns/${comboCampaign.body.campaignId}/revocations`, {
        jar: ownerJar, headers: { "if-match": String(comboBeforeRevoke.version) }, body: { reasonClass: "owner_revoked" }
      });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const revokedView = await request(http.origin, "GET", `/v1/viewer/spaces/${created.body.spaceId}`, { jar });
    assert.equal(revokedView.status, 401);
    assert.equal(revokedView.headers.get("set-cookie"), null);
    assert.equal((await request(http.origin, "GET", `/v1/spaces/${created.body.spaceId}/upload-context`, { jar })).status, 401);
  } finally { await http.close(); f.close(); }
});

test("real HTTP direct object PUT is exact-bound, observed by 1A, and committed with session/item CAS", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const owner = await f.login("http-direct-upload-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const consent = await request(http.origin, "POST", "/v1/consent-events", { headers: owner.headers, body: {
      ...f.mediaConsentBody()
    } });
    assert.equal(consent.status, 200, JSON.stringify(consent.body));
    let ordinal = 0;
    const issue = async (bytes, label, { replay = false } = {}) => {
      ordinal += 1;
      const batch = await request(http.origin, "POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
        headers: owner.headers, body: { clientBatchId: `direct-${label}-${ordinal}`,
          consentEventId: consent.body.consentEventId, declaredItemCount: 1 }
      });
      assert.equal(batch.status, 200, JSON.stringify(batch.body));
      const item = await request(http.origin, "POST", `/v1/contribution-batches/${batch.body.batchId}/items`, {
        headers: { ...owner.headers, "if-match": String(batch.body.version), "x-space-version": String(space.version) },
        body: { clientItemId: `direct-${label}`, declaredMime: "image/png", declaredBytes: bytes.length,
          fileNameHash: "opaque" }
      });
      assert.equal(item.status, 200, JSON.stringify(item.body));
      const path = `/v1/contribution-batches/${batch.body.batchId}/items/${item.body.itemId}/upload-sessions`;
      const uploadBody = { declaredMime: "image/png", declaredBytes: bytes.length,
        clientUploadId: `direct-${label}-upload` };
      const uploadHeaders = { ...owner.headers, "if-match": String(item.body.version),
        "idempotency-key": `direct-${label}-authorize-abcdefgh` };
      const upload = await request(http.origin, "POST", path, { headers: uploadHeaders, body: uploadBody });
      assert.equal(upload.status, 200, JSON.stringify(upload.body));
      if (replay) {
        const replayed = await request(http.origin, "POST", path, { headers: uploadHeaders, body: uploadBody });
        assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
        assert.equal(replayed.body.replayed, true);
        assert.deepEqual(replayed.body.oneTimeUploadTicket, upload.body.oneTimeUploadTicket);
        assert.equal(f.db.prepare("SELECT COUNT(*) count FROM upload_sessions WHERE item_id=?")
          .get(item.body.itemId).count, 1);
      }
      return { bytes, batch: batch.body, item: item.body, upload: upload.body,
        authorizationRequest: { path, headers: uploadHeaders, body: uploadBody } };
    };
    const directPut = (flow, ticket = flow.upload.oneTimeUploadTicket, url = ticket.url) =>
      fetch(new URL(url, http.origin), { method: "PUT", headers: ticket.headers, body: flow.bytes });

    const bytes = png(80, 40);
    const flow = await issue(bytes, "happy", { replay: true });
    const ticket = flow.upload.oneTimeUploadTicket;
    assert.deepEqual(Object.keys(ticket).sort(), ["headers", "url"]);
    const uploadUrl = new URL(ticket.url, http.origin);
    assert.equal(uploadUrl.origin, http.origin);
    assert.equal(uploadUrl.username, "");
    assert.equal(uploadUrl.password, "");
    assert.equal(uploadUrl.search, "");
    assert.equal(uploadUrl.hash, "");
    assert.ok(decodeURIComponent(uploadUrl.pathname).endsWith(flow.upload.exactPrivateObjectKey));
    assert.equal(ticket.headers["X-Unseen-Upload-Session"], flow.upload.uploadSessionId);
    assert.equal(ticket.headers["X-Unseen-Upload-Session-Version"], "1");
    assert.equal(ticket.headers["X-Unseen-Upload-Item"], flow.item.itemId);
    assert.equal(ticket.headers["X-Unseen-Upload-Asset"], flow.upload.assetId);
    assert.equal(ticket.headers["X-Unseen-Upload-Bytes"], String(bytes.length));
    assert.equal(ticket.headers["Content-Type"], "image/png");
    assert.equal(ticket.headers["If-None-Match"], "*");
    assert.equal(flow.upload.commitIfMatch, `"upload:1;item:${flow.upload.itemVersion}"`);
    assert.equal("oneTimeSecret" in flow.upload, false);
    f.clock.advance(120_001);
    const expiredReplay = await request(http.origin, "POST", flow.authorizationRequest.path, {
      headers: flow.authorizationRequest.headers, body: flow.authorizationRequest.body
    });
    assert.equal(expiredReplay.status, 200, JSON.stringify(expiredReplay.body));
    assert.equal(expiredReplay.body.secretUnavailable, true);
    assert.equal("oneTimeUploadTicket" in expiredReplay.body, false);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM upload_sessions WHERE item_id=?")
      .get(flow.item.itemId).count, 1);

    const put = await directPut(flow);
    assert.equal(put.status, 200, await put.text());
    const providerETag = put.headers.get("etag");
    const afterPut = f.db.prepare("SELECT * FROM upload_sessions WHERE id=?").get(flow.upload.uploadSessionId);
    assert.equal(afterPut.status, "issued");
    assert.equal(afterPut.version, 1);
    assert.equal(f.db.prepare("SELECT photo_id FROM contribution_batch_items WHERE id=?").get(flow.item.itemId).photo_id, null);
    assert.equal((await f.api.mediaStore.head(flow.upload.exactPrivateObjectKey)).exists, true);

    const commitHeaders = { ...owner.headers, "if-match": flow.upload.commitIfMatch,
      "idempotency-key": "direct-happy-commit-abcdefgh" };
    const commitBody = { clientCommitId: "direct-happy-commit", observedETag: providerETag };
    const committed = await request(http.origin, "POST", `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`, {
      headers: commitHeaders, body: commitBody
    });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.ok(committed.body.photoId);
    const committedSession = f.db.prepare("SELECT * FROM upload_sessions WHERE id=?").get(flow.upload.uploadSessionId);
    assert.equal(committedSession.status, "committed");
    assert.equal(committedSession.ticket_mac, null);
    assert.equal(committedSession.observed_upload_sha256, sha256(bytes));
    assert.equal(committedSession.observed_upload_bytes, bytes.length);
    assert.equal(committedSession.observed_upload_mime, "image/png");
    const asset = f.db.prepare("SELECT * FROM assets WHERE id=?").get(flow.upload.assetId);
    assert.equal(asset.raw_sha256, sha256(bytes));
    assert.equal(f.db.prepare("SELECT asset_id FROM photos WHERE id=?").get(committed.body.photoId).asset_id,
      flow.upload.assetId);

    const commitReplay = await request(http.origin, "POST", `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`, {
      headers: commitHeaders, body: commitBody
    });
    assert.equal(commitReplay.status, 200, JSON.stringify(commitReplay.body));
    assert.equal(commitReplay.body.photoId, committed.body.photoId);
    assert.equal(commitReplay.body.replayed, true);
    assert.equal((await directPut(flow)).status, 404);

    const crossA = await issue(png(40, 20, "#112233"), "cross-a");
    const crossB = await issue(png(40, 20, "#334455"), "cross-b");
    const crossPut = await directPut(crossA, crossA.upload.oneTimeUploadTicket,
      crossB.upload.oneTimeUploadTicket.url);
    assert.equal(crossPut.status, 409);
    assert.equal((await f.api.mediaStore.head(crossA.upload.exactPrivateObjectKey)).exists, false);
    assert.equal((await f.api.mediaStore.head(crossB.upload.exactPrivateObjectKey)).exists, false);
    assert.equal((await directPut(crossA)).status, 200);
    assert.equal((await directPut(crossA)).status, 404);
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?").get(crossA.upload.uploadSessionId).status,
      "issued");

    const replaced = await issue(png(44, 22, "#445566"), "replace");
    assert.equal((await directPut(replaced)).status, 200);
    f.clock.advance(120_001);
    const unavailableReplay = await request(http.origin, "POST", replaced.authorizationRequest.path, {
      headers: replaced.authorizationRequest.headers, body: replaced.authorizationRequest.body
    });
    assert.equal(unavailableReplay.status, 200);
    assert.equal(unavailableReplay.body.secretUnavailable, true);
    const replacement = await request(http.origin, "POST", replaced.authorizationRequest.path, {
      headers: { ...owner.headers, "if-match": String(replaced.upload.itemVersion),
        "idempotency-key": "direct-replacement-new-abcdefgh" },
      body: { ...replaced.authorizationRequest.body, clientUploadId: "direct-replacement-new" }
    });
    assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
    assert.notEqual(replacement.body.uploadSessionId, replaced.upload.uploadSessionId);
    assert.equal((await directPut(replaced)).status, 404);
    assert.equal((await f.api.mediaStore.head(replaced.upload.exactPrivateObjectKey)).exists, false);
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?")
      .get(replaced.upload.uploadSessionId).status, "revoked");
    assert.equal(f.db.prepare("SELECT validation_state FROM assets WHERE id=?").get(replaced.upload.assetId).validation_state,
      "failed");
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM upload_sessions
      WHERE item_id=? AND status IN ('issued','committing','uploaded','validating')`).get(replaced.item.itemId).count, 1);

    const replacementRace = await issue(png(44, 22, "#667788"), "replace-race");
    f.clock.advance(120_001);
    const raceHeaders = { ...owner.headers, "if-match": String(replacementRace.upload.itemVersion) };
    const [replacementLeft, replacementRight] = await Promise.all([
      request(http.origin, "POST", replacementRace.authorizationRequest.path, {
        headers: { ...raceHeaders, "idempotency-key": "direct-replacement-race-left-abcdefgh" },
        body: { ...replacementRace.authorizationRequest.body, clientUploadId: "replacement-race-left" }
      }),
      request(http.origin, "POST", replacementRace.authorizationRequest.path, {
        headers: { ...raceHeaders, "idempotency-key": "direct-replacement-race-right-abcdefgh" },
        body: { ...replacementRace.authorizationRequest.body, clientUploadId: "replacement-race-right" }
      })
    ]);
    assert.deepEqual([replacementLeft.status, replacementRight.status].sort(), [200, 409]);
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM upload_sessions
      WHERE item_id=? AND status IN ('issued','committing','uploaded','validating')`).get(replacementRace.item.itemId).count, 1);

    const stale = await issue(png(48, 24, "#556677"), "stale");
    assert.equal((await directPut(stale)).status, 200);
    const staleCommit = await request(http.origin, "POST", `/v1/upload-sessions/${stale.upload.uploadSessionId}/commits`, {
      headers: { ...owner.headers, "if-match": "999:999" }, body: { clientCommitId: "stale-commit" }
    });
    assert.equal(staleCommit.status, 409);
    assert.equal(staleCommit.body.error.code, "version_conflict");
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?").get(stale.upload.uploadSessionId).status,
      "issued");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM photos WHERE batch_item_id=?").get(stale.item.itemId).count, 0);

    const missing = await issue(png(32, 16, "#778899"), "missing");
    const recordsBefore = f.db.prepare("SELECT COUNT(*) count FROM idempotency_records").get().count;
    const missingCommit = await request(http.origin, "POST", `/v1/upload-sessions/${missing.upload.uploadSessionId}/commits`, {
      headers: { ...owner.headers, "if-match": missing.upload.commitIfMatch },
      body: { clientCommitId: "missing-commit" }
    });
    assert.equal(missingCommit.status, 409);
    assert.equal(missingCommit.body.error.code, "object_missing");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM idempotency_records").get().count, recordsBefore);
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?").get(missing.upload.uploadSessionId).status,
      "issued");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM photos WHERE batch_item_id=?").get(missing.item.itemId).count, 0);

    const mismatch = await issue(png(32, 16, "#991122"), "mismatch");
    await f.api.mediaStore.putIfAbsent(mismatch.upload.exactPrivateObjectKey,
      Buffer.concat([mismatch.bytes, Buffer.alloc(1)]), { contentType: "image/png" });
    const mismatchCommit = await request(http.origin, "POST",
      `/v1/upload-sessions/${mismatch.upload.uploadSessionId}/commits`, {
        headers: { ...owner.headers, "if-match": mismatch.upload.commitIfMatch },
        body: { clientCommitId: "mismatch-commit" }
      });
    assert.equal(mismatchCommit.status, 409);
    assert.equal(mismatchCommit.body.error.code, "object_mismatch");
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?").get(mismatch.upload.uploadSessionId).status,
      "issued");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM photos WHERE batch_item_id=?").get(mismatch.item.itemId).count, 0);

    const expired = await issue(png(32, 16, "#224466"), "expired");
    f.clock.advance(15 * 60_000 + 1);
    assert.equal((await directPut(expired)).status, 404);
    const expiredCommit = await request(http.origin, "POST", `/v1/upload-sessions/${expired.upload.uploadSessionId}/commits`, {
      headers: { ...owner.headers, "if-match": expired.upload.commitIfMatch },
      body: { clientCommitId: "expired-commit" }
    });
    assert.equal(expiredCommit.status, 404);
    assert.equal(expiredCommit.body.error.code, "upload_session_unavailable");
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?").get(expired.upload.uploadSessionId).status,
      "issued");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM photos WHERE batch_item_id=?").get(expired.item.itemId).count, 0);
  } finally { await http.close(); f.close(); }
});

test("real HTTP scene-context uses repeatable session-cookie media with immutable asset identity and live drift checks", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const owner = await f.login("http-media-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space, png(64, 32));
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    assert.equal(validation.status, "succeeded");
    const firstPano = await createPanorama(f, owner, space.spaceId, png(1600, 800), "first");
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    const placement = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 33, pitchDeg: 1, reason: "scene-confirmed"
    }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    // A: f.createSpace() now defaults auto_approve_uploads on, so the photo may already
    // be 'visible' — only approve if it still actually needs it.
    const approvalState = f.db.prepare("SELECT photo_content_state,version FROM photos WHERE id=?").get(photo.id);
    if (approvalState.photo_content_state === "pending") {
      await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
        to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null
      }, { ...owner.headers, "if-match": String(approvalState.version) });
    }
    const currentSpace = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 10
    }, { ...owner.headers, "if-match": String(currentSpace.version) });
    const firstVisitor = await externalJar(http, campaign, "media-first");
    const secondVisitor = await externalJar(http, campaign, "media-second");

    const context = await request(http.origin, "GET",
      `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}/scene-context`, { jar: firstVisitor.jar });
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.panorama.revisionId, firstPano.panoramaRevisionId);
    assert.equal(context.body.placement.yawDeg, 33);
    assert.equal(context.body.placement.status, "confirmed");
    assert.equal(context.body.photoAssetId, flow.committed.assetId);
    assert.equal(context.body.photoAssetVersion, 2);
    assert.equal(context.body.photoRawSha256, sha256(flow.bytes));
    assert.equal(context.body.panorama.url,
      `/v1/viewer/spaces/${space.spaceId}/panorama-revisions/${firstPano.panoramaRevisionId}/media`);
    assert.equal(context.body.photoMedia.url, `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}/media`);
    assert.equal(JSON.stringify(context.body).match(/capability|secret|oneTime|authorizationHeader|nodeId|privateObjectKey/), null);
    assert.equal(JSON.stringify(context.body).includes("private/"), false);

    // An unrelated signed-in account must not shadow an explicitly selected, valid
    // invitation grant. Default account precedence and cookie-only media remain unchanged.
    const unrelated = await f.login('invited-signed-in@example.test');
    const mixed = new CookieJar(); mixed.values = new Map(firstVisitor.jar.values);
    mixed.values.set('__Host-unseen_account', unrelated.accountSessionSecret);
    const viewPath = `/v1/viewer/spaces/${space.spaceId}`;
    assert.equal((await request(http.origin, 'GET', viewPath, {jar:mixed})).status, 404);
    assert.equal((await request(http.origin, 'GET', viewPath+'?access=invitation', {jar:mixed})).status, 200);
    const mixedMedia = await request(http.origin, 'GET', context.body.panorama.url+'?access=invitation', {jar:mixed});
    assert.equal(mixedMedia.status, 200); assert.deepEqual(mixedMedia.body, firstPano.bytes);
    const noGrant = new CookieJar(); noGrant.values.set('__Host-unseen_account', unrelated.accountSessionSecret);
    assert.equal((await request(http.origin, 'GET', viewPath+'?access=invitation', {jar:noGrant})).status, 401);
    const unrelatedPrivate = await f.createSpace(unrelated, 'Private account space');
    assert.equal((await request(http.origin, 'GET', `/v1/viewer/spaces/${unrelatedPrivate.spaceId}?access=invitation`, {jar:mixed})).status, 404);

    const panoMedia = context.body.panorama;
    assert.equal((await request(http.origin, "GET", panoMedia.url,
      { headers: { authorization: `Bearer ${owner.accountSessionSecret}` } })).status, 401);
    assert.equal((await request(http.origin, "GET", panoMedia.url,
      { headers: { "x-viewer-session": firstVisitor.jar.values.get("__Host-unseen_viewer") } })).status, 401);
    const sameSpacePrincipal = await request(http.origin, "GET", panoMedia.url,
      { jar: secondVisitor.jar, headers: { range: "bytes=0-1023" } });
    assert.equal(sameSpacePrincipal.status, 206);
    const media = await request(http.origin, "GET", panoMedia.url,
      { jar: firstVisitor.jar, headers: { range: "bytes=0-1023" } });
    assert.equal(media.status, 206);
    assert.deepEqual(media.body, firstPano.bytes.subarray(0, 1024));
    assert.equal(media.headers.get("etag"), `"${panoMedia.sha256}"`);
    assert.equal(media.headers.get("cache-control"), "private, no-store");
    assert.equal(media.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(media.headers.get("x-content-type-options"), "nosniff");
    const repeated = await request(http.origin, "GET", panoMedia.url, { jar: firstVisitor.jar });
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body, firstPano.bytes);
    const suffix = await request(http.origin, "GET", panoMedia.url,
      { jar: firstVisitor.jar, headers: { range: "bytes=-16" } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(suffix.body, firstPano.bytes.subarray(firstPano.bytes.length - 16));
    assert.equal((await request(http.origin, "GET", panoMedia.url, { jar: firstVisitor.jar,
      headers: { range: "bytes=0-1,3-4" } })).body.error.code, "range_not_satisfiable");

    const photoMedia = await request(http.origin, "GET", context.body.photoMedia.url, { jar: firstVisitor.jar });
    assert.equal(photoMedia.status, 200);
    assert.equal(sha256(photoMedia.body), context.body.photoMedia.sha256);
    assert.equal(photoMedia.headers.get("etag"), `"${context.body.photoMedia.sha256}"`);
    assert.equal(pngChunkTypes(photoMedia.body).some((type) => ["eXIf", "tEXt", "zTXt", "iTXt"].includes(type)),
      false);

    const beforeSwitch = await request(http.origin, "GET",
      `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}/scene-context`, { jar: firstVisitor.jar });
    assert.equal(beforeSwitch.status, 200);
    await createPanorama(f, owner, space.spaceId, png(1800, 900), "second");
    assert.equal((await request(http.origin, "GET", beforeSwitch.body.panorama.url,
      { jar: firstVisitor.jar })).status, 404);
    assert.equal((await request(http.origin, "GET", beforeSwitch.body.photoMedia.url,
      { jar: firstVisitor.jar })).status, 404);

    f.db.prepare("UPDATE viewer_sessions SET revoked_at=?,version=version+1 WHERE id=?")
      .run(f.clock.iso(), firstVisitor.exchange.viewerSessionId);
    assert.equal((await request(http.origin, 'GET', viewPath+'?access=invitation', {jar:mixed})).status, 401);
    assert.equal((await request(http.origin, "GET",
      `/v1/viewer/spaces/${space.spaceId}/panorama-revisions/${firstPano.panoramaRevisionId}/media`,
    { jar: firstVisitor.jar })).status, 401);
  } finally { await http.close(); f.close(); }
});

test("real HTTP keeps JSON at 1MiB while photo/panorama streams enforce exact 20/32MiB boundaries with no partial object", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const owner = await f.login("http-limit-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const consent = await f.ok("POST", "/v1/consent-events", {
      ...f.mediaConsentBody()
    }, owner.headers);
    const issuePhoto = async (bytes, suffix) => {
      const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
        clientBatchId: `limit-${suffix}`, consentEventId: consent.consentEventId, declaredItemCount: 1
      }, owner.headers);
      const item = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`, {
        clientItemId: `limit-${suffix}`, declaredMime: "image/png", declaredBytes: bytes,
        fileNameHash: "opaque"
      }, { ...owner.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
      return f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`, {
        declaredMime: "image/png", declaredBytes: bytes, clientUploadId: `limit-${suffix}`
      }, { ...owner.headers, "if-match": String(item.version) });
    };
    const twoMiB = await issuePhoto(2 * 1024 * 1024, "2m");
    assert.equal((await request(http.origin, "PUT", "/__local/media", { unsafeOrigin: false,
      headers: { "x-upload-ticket": rawUploadTicket(twoMiB.oneTimeUploadTicket), "content-type": "image/png" },
      body: Buffer.alloc(2 * 1024 * 1024, 1) })).status, 200);
    const photoMax = await issuePhoto(20 * 1024 * 1024, "20m");
    assert.equal((await request(http.origin, "PUT", "/__local/media", { unsafeOrigin: false,
      headers: { "x-upload-ticket": rawUploadTicket(photoMax.oneTimeUploadTicket), "content-type": "image/png" },
      body: Buffer.alloc(20 * 1024 * 1024, 2) })).status, 200);
    const photoUnder = await issuePhoto(20 * 1024 * 1024 - 1, "20m-under");
    assert.equal((await request(http.origin, "PUT", "/__local/media", { unsafeOrigin: false,
      headers: { "x-upload-ticket": rawUploadTicket(photoUnder.oneTimeUploadTicket), "content-type": "image/png" },
      body: Buffer.alloc(20 * 1024 * 1024 - 1, 7) })).status, 200);
    const photoOver = await issuePhoto(20 * 1024 * 1024, "20m-over");
    const photoOverResult = await request(http.origin, "PUT", "/__local/media", { unsafeOrigin: false,
      headers: { "x-upload-ticket": rawUploadTicket(photoOver.oneTimeUploadTicket), "content-type": "image/png" },
      body: Buffer.alloc(20 * 1024 * 1024 + 1, 3) });
    assert.equal(photoOverResult.status, 413);
    assert.equal((await f.api.mediaStore.head(photoOver.exactPrivateObjectKey)).exists, false);
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?").get(photoOver.uploadSessionId).status, "issued");

    const issuePano = async (bytes, suffix) => f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
      declaredMime: "image/png", declaredBytes: bytes, clientAssetId: `limit-pano-${suffix}`
    }, { ...owner.headers, "if-match": String(space.version),
      "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
        contentHash: "local-panorama_upload-v1" }) });
    const panoTwo = await issuePano(2 * 1024 * 1024, "2m");
    assert.equal((await request(http.origin, "PUT", "/__local/media", { unsafeOrigin: false,
      headers: { "x-upload-ticket": panoTwo.exactPrivateUploadTicketOnce, "x-media-kind": "panorama",
        "content-type": "image/png" }, body: Buffer.alloc(2 * 1024 * 1024, 4) })).status, 200);
    const validPanoBytes = noisyPanorama();
    const validPano = await issuePano(validPanoBytes.length, "valid-over-1m");
    const validPanoPut = await request(http.origin, "PUT", "/__local/media", { unsafeOrigin: false,
      headers: { "x-upload-ticket": validPano.exactPrivateUploadTicketOnce, "x-media-kind": "panorama",
        "content-type": "image/png" }, body: validPanoBytes });
    assert.equal(validPanoPut.status, 200);
    const validCommit = await f.ok("POST", `/v1/panorama-upload-sessions/${validPano.uploadSessionId}/commits`, {
      clientRequestId: "valid-large-pano-commit"
    }, { ...owner.headers, "if-match": String(validPanoPut.body.uploadSessionVersion) });
    assert.equal(dispatchOne(f.db, validCommit.jobId, { now: f.clock.iso() }).status, "succeeded");
    const panoMax = await issuePano(32 * 1024 * 1024, "32m");
    assert.equal((await request(http.origin, "PUT", "/__local/media", { unsafeOrigin: false,
      headers: { "x-upload-ticket": panoMax.exactPrivateUploadTicketOnce, "x-media-kind": "panorama",
        "content-type": "image/png" }, body: Buffer.alloc(32 * 1024 * 1024, 5) })).status, 200);
    const panoUnder = await issuePano(32 * 1024 * 1024 - 1, "32m-under");
    assert.equal((await request(http.origin, "PUT", "/__local/media", { unsafeOrigin: false,
      headers: { "x-upload-ticket": panoUnder.exactPrivateUploadTicketOnce, "x-media-kind": "panorama",
        "content-type": "image/png" }, body: Buffer.alloc(32 * 1024 * 1024 - 1, 8) })).status, 200);
    const panoOver = await issuePano(32 * 1024 * 1024, "32m-over");
    const panoOverResult = await request(http.origin, "PUT", "/__local/media", { unsafeOrigin: false,
      headers: { "x-upload-ticket": panoOver.exactPrivateUploadTicketOnce, "x-media-kind": "panorama",
        "content-type": "image/png" }, body: Buffer.alloc(32 * 1024 * 1024 + 1, 6) });
    assert.equal(panoOverResult.status, 413);
    assert.equal((await f.api.mediaStore.head(panoOver.exactPrivateObjectKey)).exists, false);
    assert.equal(f.db.prepare("SELECT status FROM panorama_upload_sessions WHERE id=?")
      .get(panoOver.uploadSessionId).status, "issued");
    const tooLargeDeclaration = await f.call("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
      declaredMime: "image/png", declaredBytes: 32 * 1024 * 1024 + 1, clientAssetId: "pano-32m-plus-one"
    }, { ...owner.headers, "if-match": String(space.version),
      "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
        contentHash: "local-panorama_upload-v1" }) });
    assert.equal(tooLargeDeclaration.status, 422);

    const oversizedJson = await request(http.origin, "POST", "/v1/auth/email-otp-challenges", {
      body: `{"padding":"${"x".repeat(1024 * 1024)}"}`,
      headers: { "content-type": "application/json" }
    });
    assert.equal(oversizedJson.status, 413);
  } finally { await http.close(); f.close(); }
});

test("account deletion HTTP atomically clears account authority, rotates exact status cookie on lost-response replay, and keeps status readable", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const jar = new CookieJar();
    const challenge = await request(http.origin, "POST", "/v1/auth/email-otp-challenges", {
      jar, body: { email: "deletion-status-http@example.test", purpose: "login" }
    });
    const loginCode = f.otp.findLast((entry) => entry.challengeId === challenge.body.challengeId).code;
    const login = await request(http.origin, "POST", "/v1/auth/email-otp-verifications", {
      jar, body: { challengeId: challenge.body.challengeId, otp: loginCode, purpose: "login" }
    });
    const accountId = login.body.accountId;
    const reauthChallenge = await request(http.origin, "POST", "/v1/auth/reauth-challenges", {
      jar, body: { actionId: "ACCOUNT.DELETE_REQUEST", purpose: "account_delete",
        targetType: "account", targetId: accountId }
    });
    const reauthCode = f.otp.findLast((entry) => entry.challengeId === reauthChallenge.body.challengeId).code;
    const reauth = await request(http.origin, "POST", "/v1/auth/reauth-verifications", {
      jar, body: { challengeId: reauthChallenge.body.challengeId, otp: reauthCode,
        actionId: "ACCOUNT.DELETE_REQUEST", purpose: "account_delete", targetType: "account", targetId: accountId }
    });
    const account = f.db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    const headers = { "idempotency-key": "account-deletion-http-replay-abcdefgh", "if-match": String(account.version) };
    const body = { reauthGrant: reauth.body.reauthGrantSecret, confirmation: true };
    const first = await request(http.origin, "POST", "/v1/me/deletion-requests", { jar, headers, body });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(Object.keys(first.body).sort(), ["deletionId", "requestedAt", "status"]);
    assert.ok(jar.values.get("__Host-unseen_deletion_status"));
    assert.equal(jar.values.has("__Host-unseen_account"), false);
    const originalStatusCredential = jar.values.get("__Host-unseen_deletion_status");
    assert.equal((await request(http.origin, "GET", `/v1/deletion-requests/${first.body.deletionId}`, { jar })).status, 200);
    assert.equal((await request(http.origin, "GET", "/v1/me", { jar })).status, 401);
    const accountAfterFirst = f.db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    const replay = await request(http.origin, "POST", "/v1/me/deletion-requests", { jar, headers, body });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.deletionId, first.body.deletionId);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM deletion_requests WHERE scope_type='account' AND scope_id=?")
      .get(accountId).count, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM deletion_status_sessions").get().count, 1);
    assert.equal(f.db.prepare("SELECT version FROM accounts WHERE id=?").get(accountId).version, accountAfterFirst.version);
    assert.notEqual(jar.values.get("__Host-unseen_deletion_status"), originalStatusCredential);
    assert.equal((await request(http.origin, "GET", `/v1/deletion-requests/${first.body.deletionId}`, {
      headers: { "x-deletion-status-session": originalStatusCredential }
    })).status, 404);
    assert.equal((await request(http.origin, "GET", "/v1/deletion-requests/not-this-deletion", { jar })).status, 404);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM pragma_table_info('deletion_status_sessions') WHERE name='account_id'")
      .get().count, 0);

    const jobId = f.db.prepare(`SELECT id FROM jobs WHERE type='deletion_execution'
      AND json_extract(input_refs_json,'$.deletionId')=?`).get(first.body.deletionId).id;
    const { dispatchDeletion } = await import("../../jobs/dispatch/deletion-worker.mjs");
    assert.equal((await dispatchDeletion(f.db, f.api.mediaStore, jobId, { now: f.clock.iso() })).status, "succeeded");
    const completed = await request(http.origin, "GET", `/v1/deletion-requests/${first.body.deletionId}`, { jar });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, "completed");
  } finally { await http.close(); f.close(); }
});

test("every unsafe cookie mutation requires exact Origin, Host, and Fetch-Metadata", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const jar = new CookieJar();
    const challenge = await request(http.origin, "POST", "/v1/auth/email-otp-challenges", {
      jar, body: { email: "csrf@example.test", purpose: "login" }
    });
    const otp = f.otp.findLast((entry) => entry.challengeId === challenge.body.challengeId).code;
    const verified = await request(http.origin, "POST", "/v1/auth/email-otp-verifications", {
      jar, body: { challengeId: challenge.body.challengeId, otp, purpose: "login" }
    });
    assert.equal(verified.status, 200);
    assert.ok(jar.values.has("__Host-unseen_account"));
    const missing = await request(http.origin, "POST", "/v1/spaces", {
      jar, unsafeOrigin: false, body: { name: "CSRF blocked" },
      headers: { "notice-acknowledgement": JSON.stringify({ purpose: "space_create", version: 1,
        contentHash: "local-space_create-v1" }) }
    });
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error.code, "request_origin_invalid");
    const accepted = await request(http.origin, "POST", "/v1/spaces", {
      jar, body: { name: "CSRF accepted" }, headers: {
        "notice-acknowledgement": JSON.stringify({ purpose: "space_create", version: 1,
          contentHash: "local-space_create-v1" })
      }
    });
    assert.equal(accepted.status, 200);
  } finally { await http.close(); f.close(); }
});

test("campaign public errors and rate exhaustion are non-enumerable and forged x-risk-scope is ignored", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const owner = await f.login("campaign-rate-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 100
    }, { ...owner.headers, "if-match": String(space.version) });
    const locator = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
    for (let index = 0; index < 20; index += 1) {
      const response = await request(http.origin, "POST", "/v1/external-campaign-admission-challenges", {
        headers: { "x-risk-scope": `forged-${index}` },
        body: { publicCampaignId: locator, clientNonce: `rate-nonce-${index}-abcdefgh` }
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
    const limited = await request(http.origin, "POST", "/v1/external-campaign-admission-challenges", {
      headers: { "x-risk-scope": "forged-bypass" },
      body: { publicCampaignId: locator, clientNonce: "rate-nonce-limited-abcdefgh" }
    });
    const unknown = await request(http.origin, "POST", "/v1/external-campaign-admission-challenges", {
      headers: { "x-risk-scope": "forged-unknown" },
      body: { publicCampaignId: "unknown-public-campaign-locator", clientNonce: "unknown-nonce-abcdefgh" }
    });
    assert.equal(limited.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(limited.body.error.code, "campaign_unavailable");
    assert.equal(unknown.body.error.code, "campaign_unavailable");
  } finally { await http.close(); f.close(); }
});

test("malformed Host is a stable 4xx and cannot poison the next health request", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const malformed = await rawHost(http.origin, "[");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "request_host_invalid");
    const health = await request(http.origin, "GET", "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");
  } finally { await http.close(); f.close(); }
});

test("cookieless client with declared origin passes sec-fetch-site same-site rewrite; cookie or foreign origin still blocked", async () => {
  const f = fixture();
  const http = await start(f);
  try {
    const owner = await f.login("wechat-secfetch-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 10
    }, { ...owner.headers, "if-match": String(space.version) });
    const locator = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
    // 微信 wx.request 无条件把 sec-fetch-site 从 same-origin 改写成 same-site(真机实测)。
    // 无 cookie + origin 已声明本站 ⇒ 服务端规范化后放行:真 campaign 拿到 challenge。
    const rewritten = await request(http.origin, "POST", "/v1/external-campaign-admission-challenges", {
      unsafeOrigin: false,
      headers: { origin: http.origin, "sec-fetch-site": "same-site" },
      body: { publicCampaignId: locator, clientNonce: "wechat-nonce-real-abcdefgh" }
    });
    assert.equal(rewritten.status, 200, JSON.stringify(rewritten.body));
    assert.ok(rewritten.body.challengeId);
    // 假 campaign 也过 origin 门,死在资源查找(404 campaign_unavailable 而非 request_origin_invalid),
    // 证明规范化只放宽了 sec-fetch-site 一维。
    const unknown = await request(http.origin, "POST", "/v1/external-campaign-admission-challenges", {
      unsafeOrigin: false,
      headers: { origin: http.origin, "sec-fetch-site": "same-site" },
      body: { publicCampaignId: "unknown-public-campaign-locator", clientNonce: "wechat-nonce-fake-abcdefgh" }
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "campaign_unavailable");
    // 伪造 origin 的无 cookie 请求不享受规范化,仍被 origin 门拦下。
    const forged = await request(http.origin, "POST", "/v1/external-campaign-admission-challenges", {
      unsafeOrigin: false,
      headers: { origin: "https://evil.example", "sec-fetch-site": "same-site" },
      body: { publicCampaignId: locator, clientNonce: "wechat-nonce-forged-abcdefgh" }
    });
    assert.equal(forged.status, 403);
    assert.equal(forged.body.error.code, "request_origin_invalid");
    // 带浏览器 cookie 的请求(web 端)行为不变:same-site 依旧不被视为 same-origin。
    const jar = new CookieJar();
    const challenge = await request(http.origin, "POST", "/v1/auth/email-otp-challenges", {
      jar, body: { email: "wechat-secfetch-web@example.test", purpose: "login" }
    });
    const otp = f.otp.findLast((entry) => entry.challengeId === challenge.body.challengeId).code;
    const verified = await request(http.origin, "POST", "/v1/auth/email-otp-verifications", {
      jar, body: { challengeId: challenge.body.challengeId, otp, purpose: "login" }
    });
    assert.equal(verified.status, 200);
    assert.ok(jar.values.has("__Host-unseen_account"));
    const webRewritten = await request(http.origin, "POST", "/v1/external-campaign-admission-challenges", {
      jar, unsafeOrigin: false,
      headers: { origin: http.origin, "sec-fetch-site": "same-site" },
      body: { publicCampaignId: locator, clientNonce: "wechat-nonce-cookie-abcdefgh" }
    });
    assert.equal(webRewritten.status, 403);
    assert.equal(webRewritten.body.error.code, "request_origin_invalid");
  } finally { await http.close(); f.close(); }
});
