import test from "node:test";
import assert from "node:assert/strict";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createLocalHttpServer, listenLocalHttpServer } from "../src/http-server.mjs";
import { attachDepthArtifact, pngDimensions, validateDepthPrecursor } from "../scripts/attach-depth-artifact.mjs";
import { createAccountUpload, fixture, png } from "./fixture-factory.mjs";

// Mirrors red-team-http.test.mjs's createPanorama(): upload a panorama candidate, commit it,
// dispatch its validation job, and switch the scene to make it the space's current revision.
async function createPanorama(f, owner, spaceId, bytes, suffix) {
  const space = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: `pano-${suffix}`
  }, { ...owner.headers, "if-match": String(space.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1, contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce, bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: `pano-commit-${suffix}` }, { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  await f.ok("POST", `/v1/spaces/${spaceId}/panorama-switches`,
    { mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version },
    { ...owner.headers, "if-match": String(before.version) });
  return { ...ready, bytes };
}

function depthPrecursor(overrides = {}) {
  return {
    schemaVersion: "unseen-depth-artifact-precursor/1",
    width: 1024,
    height: 512,
    nearMeters: 0.5,
    farMeters: 20,
    quality: { validFraction: 0.99 },
    safetyEnvelope: {
      schemaVersion: "unseen-polar-safety-envelope/1",
      absoluteMaxRadiusMeters: 0.42,
      directions: Array.from({ length: 8 }, (_, index) => ({ yawDeg: index * 45, allowedRadiusMeters: 0.3 }))
    },
    ...overrides
  };
}

async function request(origin, method, path, { body, headers = {}, jar = null } = {}) {
  const merged = { ...headers };
  if (jar?.size) merged.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  let payload = body;
  if (body != null && !Buffer.isBuffer(body) && typeof body !== "string") {
    payload = JSON.stringify(body);
    merged["content-type"] ??= "application/json";
  }
  const response = await fetch(`${origin}${path}`, { method, headers: merged, body: payload });
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  return { status: response.status, headers: response.headers,
    body: contentType.includes("application/json") ? (bytes.length ? JSON.parse(bytes.toString("utf8")) : {}) : bytes };
}

async function setUpScene(f) {
  const owner = await f.login("depth-owner@example.test");
  let space = await f.createSpace(owner);
  space = await f.openSpace(owner, space);
  const flow = await createAccountUpload(f, owner, space, png(64, 32));
  dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
  const firstPano = await createPanorama(f, owner, space.spaceId, png(1600, 800), "first");
  const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
  const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
  const placement = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`,
    { mode: "manual", confirmationMode: "manual", yawDeg: 10, pitchDeg: 0, reason: "scene-confirmed" },
    { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
  // A: f.createSpace() now defaults the space's auto_approve_uploads switch on, so the
  // photo may already be 'visible' by the time it gets here — only fall back to an
  // explicit manual approval if it actually still needs one, so this setup works the
  // same regardless of that default.
  const beforeApproval = f.db.prepare("SELECT photo_content_state,version FROM photos WHERE id=?").get(photo.id);
  if (beforeApproval.photo_content_state === "pending") {
    await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`,
      { to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null },
      { ...owner.headers, "if-match": String(beforeApproval.version) });
  }
  return { owner, space, photo, firstPano };
}

test("attachDepthArtifact rejects malformed inputs before touching the DB", () => {
  const png4x2 = png(4, 2);
  assert.throws(() => pngDimensions(Buffer.from("not a png")), /depth_png_invalid/);
  const dims = pngDimensions(png4x2);
  assert.deepEqual(dims, { width: 4, height: 2 });
  assert.throws(() => validateDepthPrecursor(depthPrecursor({ schemaVersion: "wrong" }), dims), /artifact_schema_unsupported/);
  assert.throws(() => validateDepthPrecursor(depthPrecursor({ width: 999 }), dims), /depth_png_dimensions_mismatch/);
  assert.throws(() => validateDepthPrecursor(depthPrecursor({ width: 4, height: 2, nearMeters: 0.01 }), dims), /depth_calibration_invalid/);
  assert.throws(() => validateDepthPrecursor(depthPrecursor({ width: 4, height: 2, farMeters: 200 }), dims), /depth_calibration_invalid/);
  assert.throws(() => validateDepthPrecursor(depthPrecursor({ width: 4, height: 2, safetyEnvelope: null }), dims), /safety_envelope_invalid/);
  assert.throws(() => validateDepthPrecursor(depthPrecursor({ width: 4, height: 2, quality: { validFraction: 0.5 } }), dims),
    /quality_valid_fraction_below_threshold/);
  validateDepthPrecursor(depthPrecursor({ width: 4, height: 2 }), dims); // does not throw
});

test("attachDepthArtifact requires an existing space with an activated panorama revision", async () => {
  const f = fixture();
  try {
    await assert.rejects(attachDepthArtifact(f.db, f.api.mediaStore,
      { spaceId: "space-missing", pngBytes: png(4, 2), meta: depthPrecursor({ width: 4, height: 2 }) }), /space not found/);
    const owner = await f.login("no-pano-owner@example.test");
    const space = await f.createSpace(owner);
    await assert.rejects(attachDepthArtifact(f.db, f.api.mediaStore,
      { spaceId: space.spaceId, pngBytes: png(4, 2), meta: depthPrecursor({ width: 4, height: 2 }) }),
      /no active panorama revision/);
  } finally { f.close(); }
});

test("sceneContext, media serving, and revision-binding for an attached depth artifact", async () => {
  const f = fixture();
  const server = createLocalHttpServer({ api: f.api });
  const { origin } = await listenLocalHttpServer(server, { host: "127.0.0.1", port: 0 });
  f.api.campaigns.publicOrigin = origin; // fixture() hardcodes :8787; the real listener uses an ephemeral port.
  try {
    const { owner, space, photo, firstPano } = await setUpScene(f);
    // The space owner's own account session is enough to exercise viewer routes (see
    // ViewerMediaService.authorize()'s "account" branch) — the external viewer-session/campaign
    // admission flow is a separate, already-covered concern (red-team-http.test.mjs) and adds
    // nothing to what this test is verifying (depth-artifact wiring), so it's kept out here.
    const authHeaders = owner.headers;

    const before = await request(origin, "GET", `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}/scene-context`, { headers: authHeaders });
    assert.equal(before.status, 200);
    assert.equal(before.body.sceneMode, "rotation360");
    assert.equal(before.body.depthArtifact, null);

    const depthPng = png(1024, 512, "#224466");
    const attached = await attachDepthArtifact(f.db, f.api.mediaStore,
      { spaceId: space.spaceId, pngBytes: depthPng, meta: depthPrecursor() });
    assert.equal(attached.panoramaRevisionId, firstPano.panoramaRevisionId);

    const after = await request(origin, "GET", `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}/scene-context`, { headers: authHeaders });
    assert.equal(after.status, 200);
    assert.equal(after.body.sceneMode, "depth_limited_parallax");
    const depthArtifact = after.body.depthArtifact;
    assert.equal(depthArtifact.schemaVersion, "unseen-depth-artifact/1");
    assert.equal(depthArtifact.sourcePanoramaRevisionId, firstPano.panoramaRevisionId);
    assert.equal(depthArtifact.artifactId, attached.artifactId);
    assert.equal(depthArtifact.depthMap.url,
      `/v1/viewer/spaces/${space.spaceId}/panorama-revisions/${firstPano.panoramaRevisionId}/depth-map`);
    assert.equal(depthArtifact.depthMap.sha256, attached.sha256);
    assert.equal(depthArtifact.depthMap.width, 1024);
    assert.equal(depthArtifact.depthMap.height, 512);
    assert.equal(depthArtifact.depthMap.encoding, "linear-red-v1");
    assert.equal(depthArtifact.depthMap.nearMeters, 0.5);
    assert.equal(depthArtifact.depthMap.farMeters, 20);
    assert.equal(depthArtifact.quality.validFraction, 0.99);
    assert.equal(depthArtifact.safetyEnvelope.directions.length, 8);
    // No private/internal fields leak into the wire DTO.
    assert.equal(JSON.stringify(depthArtifact).match(/capability|secret|oneTime|authorizationHeader|nodeId|privateObjectKey/), null);

    const unauthenticated = await request(origin, "GET", depthArtifact.depthMap.url);
    assert.equal(unauthenticated.status, 401);
    const served = await request(origin, "GET", depthArtifact.depthMap.url, { headers: authHeaders });
    assert.equal(served.status, 200);
    assert.deepEqual(served.body, depthPng);
    assert.equal(served.headers.get("etag"), `"${depthArtifact.depthMap.sha256}"`);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("cache-control"), "private, no-store");

    // Switching to a new panorama revision un-arms the depth artifact bound to the old one — no
    // scene_depth_artifacts row exists yet for the new revision, so depthArtifactFor() (the
    // exact lookup sceneContext() uses) returns null and the scene would report plain
    // rotation360, matching a scene that never had a depth artifact attached at all — no
    // separate invalidation step required. (Switching also stales the photo's placement on the
    // old revision, which is an orthogonal, already-covered concern — see red-team-http.test.mjs
    // — so this checks the depth-artifact lookup directly rather than through scene-context for
    // this specific photo.)
    const second = await createPanorama(f, owner, space.spaceId, png(1800, 900), "second");
    assert.notEqual(second.panoramaRevisionId, firstPano.panoramaRevisionId);
    assert.equal(f.api.viewerMedia.depthArtifactFor(space.spaceId, second.panoramaRevisionId), null);
    // The old depth-map media route now serves a revision that is no longer current, exactly
    // like the old panorama/media route already does for a retired revision.
    assert.equal((await request(origin, "GET", depthArtifact.depthMap.url, { headers: authHeaders })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    f.close();
  }
});

test("re-attaching for the same revision replaces the prior depth artifact (idempotent upsert)", async () => {
  const f = fixture();
  try {
    const { space, firstPano } = await setUpScene(f);
    const first = await attachDepthArtifact(f.db, f.api.mediaStore,
      { spaceId: space.spaceId, pngBytes: png(1024, 512, "#111111"), meta: depthPrecursor() });
    const second = await attachDepthArtifact(f.db, f.api.mediaStore,
      { spaceId: space.spaceId, pngBytes: png(1024, 512, "#eeeeee"), meta: depthPrecursor({ nearMeters: 0.7 }) });
    assert.notEqual(first.depthAssetId, second.depthAssetId);
    assert.notEqual(first.sha256, second.sha256);
    const rows = f.db.prepare("SELECT * FROM scene_depth_artifacts WHERE space_id=? AND panorama_revision_id=?")
      .all(space.spaceId, firstPano.panoramaRevisionId);
    assert.equal(rows.length, 1, "one row per (space, revision) — upsert, not a duplicate");
    assert.equal(rows[0].depth_asset_id, second.depthAssetId);
    assert.equal(rows[0].near_meters, 0.7);
    assert.equal(rows[0].version, 2);
  } finally { f.close(); }
});
