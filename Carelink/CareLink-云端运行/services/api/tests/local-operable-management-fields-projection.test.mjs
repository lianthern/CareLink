import { approveFixtureRegistrations } from './approve-fixture-registrations.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// Regression test for infra/integration/local-operable.mjs's managementProjection(): it builds
// its return object as `{ ...raw, isOwner: ..., space: {...}, reviewQueue: ..., ... }` — raw is
// spread first, so any field SpaceService#management() (services/api/src/space-service.mjs)
// returns and this function doesn't explicitly shadow with a same-named key survives into the
// real HTTP response for free. confirmedPlacementCount/missingDirections (host-panel worktree,
// "待你确认"/"缺口"方向格) are exactly such fields.
//
// This was raised as a suspected instance of the same "silent field drop" bug class that hit
// managementProjection() before (memberships/memberInvitations were once hardcoded to `[]` — see
// member-invitation-membership-management-projection.test.mjs) and photoProjection() before that
// (media_type — see local-operable-video-media-type-projection.test.mjs). Empirically checked
// against a live local-operable instance before writing this test (manual curl against a real
// boot, both the zero-photo case and after directly inserting a confirmed placement into the
// live sqlite file): the fields DO pass through correctly, because managementProjection() spreads
// `...raw` rather than hand-building every key the way photoProjection() does. This test pins that
// down as a permanent regression guard rather than relying on the one-off manual check.
//
// Spawns the real local-operable runtime end to end (HTTP only, matching the sibling
// local-operable-video-media-type-projection.test.mjs pattern), then inserts a confirmed photo
// directly into the runtime's own live sqlite file (same technique services/api/tests/
// direction-coverage.test.mjs uses to pin exact yaw-bucket boundaries — the real CLIP/locator
// pipeline never lets a caller choose an exact yaw) to prove a *non-default* value round-trips,
// not just the zero-photo defaults.

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
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "unseen-local-operable-management-fields-test-"));
  const dataRoot = path.join(temporaryRoot, "data");
  const evidenceRoot = path.join(temporaryRoot, "evidence");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["infra/integration/local-operable.mjs"], {
    cwd: repoRoot,
    env: { ...process.env, UNSEEN_LOCAL_PORT: String(port), UNSEEN_LOCAL_DATA_DIR: dataRoot,
      UNSEEN_LOCAL_EVIDENCE_DIR: evidenceRoot,
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

async function loginViaOtp(origin, email) {
  const challenge = await jsonRequest(origin, "POST", "/v1/auth/email-otp-challenges", {
    body: { email, purpose: "login", locale: "zh-CN" },
    headers: { "idempotency-key": `test-otp-challenge-${crypto.randomUUID()}` }
  });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  return challenge.body.challengeId;
}

// Same direct-insert technique as direction-coverage.test.mjs's insertConfirmedPhoto() (see that
// file for why: the real upload -> CLIP-placement pipeline never lets a caller pin an exact yaw),
// pointed at the *live* runtime's own sqlite file instead of an in-process fixture.
function insertConfirmedPhoto(db, { spaceId, ownerId, yaw }) {
  const now = new Date().toISOString();
  const suffix = `live-${Math.random().toString(36).slice(2, 10)}`;
  const assetId = `asset-${suffix}`, batchId = `batch-${suffix}`, itemId = `item-${suffix}`,
    photoId = `photo-${suffix}`, revisionId = `placement-${suffix}`;
  db.prepare(`INSERT INTO assets(id,space_id,kind,private_object_key,validation_state,version)
    VALUES(?,?,'photo',?,'validated',1)`).run(assetId, spaceId, `key-${suffix}`);
  db.prepare(`INSERT INTO contribution_batches(id,space_id,actor_kind,actor_id,status,item_count,committed_count,version,created_at)
    VALUES(?,?,'account',?,'finalized',1,1,1,?)`).run(batchId, spaceId, ownerId, now);
  db.prepare(`INSERT INTO contribution_batch_items(id,space_id,batch_id,asset_id,photo_id,status,version)
    VALUES(?,?,?,?,?,'committed',1)`).run(itemId, spaceId, batchId, assetId, photoId);
  db.prepare(`INSERT INTO photos(id,space_id,batch_id,batch_item_id,asset_id,viewer_safe_asset_id,photo_content_state,placement_state,confirmation_mode,current_placement_revision_id,version)
    VALUES(?,?,?,?,?,?,'visible','confirmed','auto',?,1)`).run(photoId, spaceId, batchId, itemId, assetId, assetId, revisionId);
  db.prepare(`INSERT INTO placement_revisions(id,space_id,photo_id,seq,placement_state,confirmation_mode,yaw,pitch,auth_kind,authorization_id,auth_snapshot_json,reason_code,request_id,created_at)
    VALUES(?,?,?,1,'confirmed','auto',?,0,'space_owner',?,'{}','manual_confirm',?,?)`)
    .run(revisionId, spaceId, photoId, yaw, spaceId, `req-${suffix}`, now);
}

test("local-operable's real GET /v1/spaces/{sid}/management response carries confirmedPlacementCount and missingDirections", async () => {
  const runtime = await startLocalOperable();
  try {
    const ownerEmail = `owner-management-fields-${Date.now()}@example.test`;
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
      body: { name: "Management Fields Projection Space" },
      headers: { "idempotency-key": `test-space-${crypto.randomUUID()}`, cookie, ...sameOriginHeaders }
    });
    assert.equal(space.status, 200, JSON.stringify(space.body));
    const spaceId = space.body.spaceId;

    // Fresh space, zero photos: both new fields must still be present (not merely truthy) —
    // confirmedPlacementCount===0 and all 12 buckets missing, matching
    // services/api/tests/direction-coverage.test.mjs's "zero confirmed photos" case.
    const empty = await jsonRequest(runtime.origin, "GET", `/v1/spaces/${spaceId}/management`, { headers: { cookie } });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.ok("confirmedPlacementCount" in empty.body,
      "confirmedPlacementCount must be projected through managementProjection(), not silently dropped");
    assert.ok("missingDirections" in empty.body,
      "missingDirections must be projected through managementProjection(), not silently dropped");
    assert.equal(empty.body.confirmedPlacementCount, 0);
    assert.deepEqual(empty.body.missingDirections, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    // Now insert a real confirmed placement directly into the runtime's own live sqlite file and
    // re-fetch — proves a *non-default* value actually flows through the projection, not just
    // whatever the zero-photo default happens to coincide with.
    const db = new DatabaseSync(path.join(runtime.dataRoot, "unseen.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    insertConfirmedPhoto(db, { spaceId, ownerId: verified.body.accountId, yaw: 195 });
    db.close();

    const withPhoto = await jsonRequest(runtime.origin, "GET", `/v1/spaces/${spaceId}/management`, { headers: { cookie } });
    assert.equal(withPhoto.status, 200, JSON.stringify(withPhoto.body));
    assert.equal(withPhoto.body.confirmedPlacementCount, 1);
    assert.ok(!withPhoto.body.missingDirections.includes(6),
      "yaw=195 falls in bucket 6 (180-210deg), which must now read as covered");
    assert.equal(withPhoto.body.missingDirections.length, 11);
  } finally {
    await runtime.stop();
  }
});
