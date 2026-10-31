import test from "node:test";
import assert from "node:assert/strict";
import { backfillViewerSafeImages } from "../../../tools/backfill-viewer-safe-images.mjs";
import { FfmpegDecoderRunner } from "../src/ports/media/ffmpeg-decoder-runner.mjs";
import { createAccountUpload, fixture, png } from "./fixture-factory.mjs";

test("viewer-safe backfill replaces legacy PNG display assets without deleting them", async () => {
  const f = fixture();
  try {
    const owner = await f.login("viewer-safe-backfill@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space, png(64, 32));
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const legacyId = "asset_legacy_viewer_safe";
    const legacyKey = `private/${space.spaceId}/viewer-safe/${legacyId}`;
    const legacyBody = png(64, 32);
    const stored = await f.api.mediaStore.putIfAbsent(legacyKey, legacyBody, { contentType: "image/png" });
    f.db.prepare(`INSERT INTO assets(
      id,space_id,kind,private_object_key,raw_sha256,observed_bytes,observed_mime,width,height,frame_count,
      orientation,color_profile,metadata_policy_result,validation_state,version
    ) VALUES(?,?,?,?,?,?,?,?,?,1,0,'unspecified','exif_gps_stripped','valid',1)`)
      .run(legacyId, space.spaceId, "photo_viewer_safe", legacyKey, stored.etag, stored.bytes, "image/png", 64, 32);
    f.db.prepare("UPDATE photos SET viewer_safe_asset_id=? WHERE id=?").run(legacyId, photo.id);

    const result = await backfillViewerSafeImages({ db: f.db, mediaStore: f.api.mediaStore,
      decoderRunner: new FfmpegDecoderRunner(), spaceId: space.spaceId });
    assert.equal(result.replaced, 1);
    const updated = f.db.prepare(`SELECT a.* FROM photos p JOIN assets a ON a.id=p.viewer_safe_asset_id
      WHERE p.id=?`).get(photo.id);
    assert.equal(updated.observed_mime, "image/jpeg");
    assert.equal(updated.width, 64);
    assert.equal(updated.height, 32);
    assert.equal((await f.api.mediaStore.head(legacyKey)).exists, true, "legacy asset remains recoverable");
  } finally { f.close(); }
});
