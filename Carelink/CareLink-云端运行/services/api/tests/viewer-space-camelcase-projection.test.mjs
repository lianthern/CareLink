import test from "node:test";
import assert from "node:assert/strict";
import { createLocalHttpServer, listenLocalHttpServer } from "../src/http-server.mjs";
import { createAccountUpload, fixture, png } from "./fixture-factory.mjs";

// Regression test for services/api/src/read-service.mjs's viewerSpace(): its `photos` SELECT had
// no column aliases, and node:sqlite keys every row by the literal selected column name, so the
// array reached the wire as raw snake_case (photo_content_state/placement_state/confirmation_mode/
// media_type) while every other field of the same DTO -- and CANONICAL-STATE-AND-API.md's own
// `photos` row -- is camelCase. apps/web reads photo.placementState (app.js's "open the first
// confirmed photo" default), photo.placementState/confirmationMode (templates.js's
// photoGridBadge()) and photo.mediaType (the album-grid video corner badge) straight off this
// array, so all three silently read undefined in production: every album photo rendered the
// fall-through "待定位" badge no matter what state it was actually in.
//
// Nothing caught it because both layers that had tests bypassed this code path -- apps/web's
// tests and its FixtureAdapter hand-author camelCase photo records, and
// infra/integration/local-operable.mjs (the local/stage runtime the sibling
// local-operable-video-media-type-projection.test.mjs drives) discards this array entirely and
// rebuilds a camelCase one in viewerSpaceProjection(). Production does NOT go through that
// adapter: ops/release/unseen.service.example and the private-beta unit both boot
// infra/integration/book-lab/deployment-entrypoint.mjs, which serves LocalApi through
// createLocalHttpServer() with no projection in between. So this test drives that exact,
// unadapted production stack over real HTTP rather than calling the service object directly.
test("GET /v1/viewer/spaces/{sid} returns camelCase photo fields over real HTTP", async () => {
  const f = fixture();
  const server = createLocalHttpServer({ api: f.api });
  const { origin } = await listenLocalHttpServer(server, { host: "127.0.0.1", port: 0 });
  f.api.campaigns.publicOrigin = origin; // fixture() hardcodes :8787; the real listener uses an ephemeral port.
  try {
    const owner = await f.login("album-projection-owner@example.test");
    const space = await f.openSpace(owner, await f.createSpace(owner, "相册字段投影"));
    // New spaces default auto_approve_uploads=on (migration 0015), so the committed upload lands
    // photo_content_state='visible' on its own -- no hand-written state fixup here, which is the
    // whole point: the row under assertion is one the real upload path produced.
    await createAccountUpload(f, owner, space, png(), "image/png");

    const response = await fetch(`${origin}/v1/viewer/spaces/${space.spaceId}`, {
      headers: { authorization: `Bearer ${owner.token}` }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.photos.length, 1);
    const [photo] = body.photos;

    assert.equal(photo.photoContentState, "visible");
    assert.equal(photo.placementState, "processing");
    assert.equal(photo.confirmationMode, null);
    assert.equal(photo.mediaType, "photo");

    // The positive assertions above would still pass if a future change re-added the snake_case
    // keys alongside the camelCase ones; the contract is camelCase-only over the wire, and a
    // duplicated pair is exactly how this drifts back.
    assert.deepEqual(Object.keys(photo).filter((key) => key.includes("_")), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    f.close();
  }
});
