import { assert } from "./errors.mjs";
import { parseJson, sha256 } from "./util.mjs";

const PANORAMA_LIMIT = 32 * 1024 * 1024;

function rangeFor(value, bytes) {
  if (value == null) return { start: 0, end: bytes - 1, partial: false };
  assert(typeof value === "string" && !value.includes(","), "range_not_satisfiable", 416);
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(value);
  assert(match, "range_not_satisfiable", 416);
  const suffix = match[3] == null ? null : Number(match[3]);
  const start = suffix == null ? Number(match[1]) : Math.max(0, bytes - suffix);
  const end = suffix == null ? (match[2] === "" ? bytes - 1 : Number(match[2])) : bytes - 1;
  assert(suffix == null || Number.isSafeInteger(suffix) && suffix > 0, "range_not_satisfiable", 416);
  assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end < bytes,
    "range_not_satisfiable", 416);
  return { start, end, partial: true };
}

function descriptor(asset, url) {
  assert(asset?.validation_state === "valid" && typeof asset.raw_sha256 === "string" &&
    Number.isSafeInteger(asset.observed_bytes) && asset.observed_bytes > 0 && asset.observed_mime,
  "media_unavailable", 404);
  return { url, assetId: asset.id, assetVersion: asset.version, sha256: asset.raw_sha256,
    bytes: asset.observed_bytes, contentType: asset.observed_mime };
}

// Shared wire-shape builder for sceneContext() and editorSceneContext() — the only difference
// between the two is how `placement` was looked up (confirmed-only vs. permissive), how
// `photoMediaUrl` resolves (see editorSceneContext()'s own comment on why it needs a dedicated
// route), and whether the caller was already authorized outside a viewer/account session; the
// rest of the DTO, and the same descriptor()/depth-artifact assembly, are identical either way.
function describeSceneContext({ spaceId, photoId, scene, revision, panoramaAsset, viewerSafeAsset,
  originalAsset, depthArtifact, depthImport, placement,
  photoMediaUrl = `/v1/viewer/spaces/${spaceId}/photos/${photoId}/media` }) {
  return {
    photoId,
    photoAssetId: originalAsset.id,
    photoAssetVersion: originalAsset.version,
    photoRawSha256: originalAsset.raw_sha256,
    sceneReadiness: "ready",
    sceneMode: depthArtifact || depthImport ? "depth_limited_parallax" : "rotation360",
    scene: { sceneId: scene.id, panoramaRevisionId: revision.id },
    panorama: { revisionId: revision.id, width: panoramaAsset.width, height: panoramaAsset.height, ...descriptor(panoramaAsset,
      `/v1/viewer/spaces/${spaceId}/panorama-revisions/${revision.id}/media`) },
    photoMedia: descriptor(viewerSafeAsset, photoMediaUrl),
    depthArtifact,
    depthImport,
    placement
  };
}

export class ViewerMediaService {
  constructor(core, mediaStore) {
    this.core = core;
    this.mediaStore = mediaStore;
  }

  authorize(ctx, spaceId) {
    if (ctx.accountSession) {
      const account = this.core.account(ctx.accountSession);
      const access = this.core.accountSpace(account, spaceId, { task: "view" });
      return { branch: "account", account, access, space: access.space };
    }
    const viewer = this.core.viewer(ctx.viewerSession);
    assert(viewer.space.id === spaceId, "resource_unavailable", 404);
    return { branch: "external", viewer, space: viewer.space };
  }

  // Split out of currentScene() so editorSceneContext() below can reuse the exact same
  // "is there a ready, activated panorama revision with a valid asset" lookup without also
  // requiring a ctx-based authorize() call — its callers (PlacementService#editView(),
  // UploadService#receiptItem()) have already authorized the request themselves (manager
  // scope or a write-enabled receipt session) before ever reaching here. Returns null instead
  // of asserting so currentScene() can keep its existing "404 the whole request" behavior
  // while editorSceneContext() can instead just omit sceneContext from an otherwise-fine page.
  sceneRevisionFor(spaceId, revisionId) {
    const scene = this.core.one(`SELECT * FROM scenes WHERE space_id=? AND scene_readiness='ready'
      AND scene_mode='rotation360'`, spaceId);
    const revision = revisionId ? this.core.one(`SELECT * FROM panorama_revisions WHERE id=? AND space_id=?
      AND ready_at IS NOT NULL AND activated_at IS NOT NULL AND retired_at IS NULL`, revisionId, spaceId) : null;
    const panoramaAsset = revision ? this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=?
      AND validation_state='valid'`, revision.asset_id, spaceId) : null;
    if (!scene || !revision || !panoramaAsset || panoramaAsset.observed_bytes > PANORAMA_LIMIT) return null;
    return { scene, revision, panoramaAsset };
  }

  currentScene(ctx, spaceId) {
    const auth = this.authorize(ctx, spaceId);
    const state = this.sceneRevisionFor(spaceId, auth.space.current_panorama_revision_id);
    assert(state, "scene_unavailable", 404);
    return { auth, ...state };
  }

  photoState(ctx, spaceId, photoId) {
    const state = this.currentScene(ctx, spaceId);
    const photo = this.core.one(`SELECT * FROM photos WHERE id=? AND space_id=?
      AND photo_content_state='visible' AND placement_state='confirmed' AND deleted_at IS NULL`, photoId, spaceId);
    const placement = photo ? this.core.one(`SELECT * FROM placement_revisions WHERE id=? AND photo_id=?
      AND panorama_revision_id=? AND placement_state='confirmed'`, photo.current_placement_revision_id,
    photoId, state.revision.id) : null;
    const originalAsset = photo ? this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=?
      AND validation_state='valid'`, photo.asset_id, spaceId) : null;
    const viewerSafeAsset = photo ? this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=?
      AND kind='photo_viewer_safe' AND validation_state='valid' AND metadata_policy_result='exif_gps_stripped'`,
    photo.viewer_safe_asset_id, spaceId) : null;
    assert(photo && placement && originalAsset && viewerSafeAsset, "photo_scene_unavailable", 404);
    return { ...state, photo, placement, originalAsset, viewerSafeAsset };
  }

  // A scene has a depth artifact only when a valid scene_depth_artifacts row exists for the
  // space's *current* panorama revision (see migration 0011's header comment for why this is
  // computed here rather than stored on scenes.scene_mode). Any mismatch — no row, a revision
  // switch since the depth map was generated, or the underlying asset having failed/been
  // replaced — falls back to plain rotation360 with no depthArtifact, which is exactly today's
  // behavior for every scene that has never had a depth artifact attached.
  depthArtifactFor(spaceId, revisionId) {
    const row = this.core.one(`SELECT * FROM scene_depth_artifacts WHERE space_id=? AND panorama_revision_id=?`,
      spaceId, revisionId);
    if (!row) return null;
    const asset = this.core.one("SELECT * FROM assets WHERE id=? AND space_id=? AND validation_state='valid'",
      row.depth_asset_id, spaceId);
    if (!asset) return null;
    return {
      schemaVersion: "unseen-depth-artifact/1",
      artifactId: row.artifact_id,
      sourcePanoramaRevisionId: row.panorama_revision_id,
      depthMap: { ...descriptor(asset, `/v1/viewer/spaces/${spaceId}/panorama-revisions/${revisionId}/depth-map`),
        encoding: "linear-red-v1", width: asset.width, height: asset.height,
        nearMeters: row.near_meters, farMeters: row.far_meters },
      quality: { validFraction: row.valid_fraction },
      safetyEnvelope: parseJson(row.safety_envelope_json)
    };
  }

  // Imported DAP uses the exact same hash-bound descriptor in private and shared
  // App viewers. Legacy min/max remains explicitly legacy; no metric quality or
  // linear-red encoding is invented for a relative-depth source.
  depthImportFor(spaceId, revisionId) {
    const row = this.core.one(`SELECT * FROM app_spatial_imports WHERE space_id=? AND panorama_revision_id=?
      AND depth_asset_id IS NOT NULL ORDER BY rowid DESC LIMIT 1`, spaceId, revisionId);
    if (!row) return null;
    const metadata = parseJson(row.depth_metadata_json);
    if (metadata?.sourcePanoramaRevisionId !== revisionId) return null;
    const asset = this.core.one("SELECT * FROM assets WHERE id=? AND space_id=? AND validation_state='valid'", row.depth_asset_id, spaceId);
    const panorama = this.core.one(`SELECT a.* FROM panorama_revisions p JOIN assets a ON a.id=p.asset_id
      WHERE p.id=? AND p.space_id=? AND a.validation_state='valid'`, revisionId, spaceId);
    if (!asset || !panorama || metadata.depthSha256 !== asset.raw_sha256 || metadata.panoramaSha256 !== panorama.raw_sha256) return null;
    return { ...descriptor(asset, `/v1/viewer/spaces/${spaceId}/panorama-revisions/${revisionId}/depth-map`),
      width: asset.width, height: asset.height, panoramaName: row.panorama_name, metadata };
  }

  spaceSceneContext(ctx, spaceId) {
    const auth = this.authorize(ctx, spaceId);
    if (auth.space.current_world_result_id) return this.worldResults.sceneContext(spaceId);
    const state = this.sceneRevisionFor(spaceId, auth.space.current_panorama_revision_id);
    if (!state) return null;
    const { scene, revision, panoramaAsset } = state;
    const depthArtifact = this.depthArtifactFor(spaceId, revision.id), depthImport = this.depthImportFor(spaceId, revision.id);
    const placements = this.core.all(`SELECT p.id photoId,r.id revisionId,r.yaw yawDeg,r.pitch pitchDeg,r.fov fovDeg,
      r.placement_state status,r.confirmation_mode confirmationMode,p.version photoVersion
      FROM photos p JOIN placement_revisions r ON r.id=p.current_placement_revision_id
      WHERE p.space_id=? AND p.photo_content_state='visible' AND p.deleted_at IS NULL AND p.placement_state='confirmed'
      AND r.placement_state='confirmed' AND r.panorama_revision_id=?`, spaceId, revision.id);
    return { sceneReadiness: 'ready', sceneMode: depthArtifact || depthImport ? 'depth_limited_parallax' : 'rotation360',
      scene: { sceneId: scene.id, panoramaRevisionId: revision.id },
      panorama: { revisionId: revision.id, width: panoramaAsset.width, height: panoramaAsset.height,
        ...descriptor(panoramaAsset, `/v1/viewer/spaces/${spaceId}/panorama-revisions/${revision.id}/media`) },
      depthArtifact, depthImport, placements };
  }

  sceneContext(ctx, spaceId, photoId) {
    const state = this.photoState(ctx, spaceId, photoId);
    const depthArtifact = this.depthArtifactFor(spaceId, state.revision.id);
    return describeSceneContext({ spaceId, photoId, scene: state.scene, revision: state.revision,
      panoramaAsset: state.panoramaAsset, viewerSafeAsset: state.viewerSafeAsset,
      originalAsset: state.originalAsset, depthArtifact, depthImport: this.depthImportFor(spaceId, state.revision.id),
      placement: { revisionId: state.placement.id, status: "confirmed",
        confirmationMode: state.placement.confirmation_mode, yawDeg: state.placement.yaw,
        pitchDeg: state.placement.pitch, fovDeg: state.placement.fov, placementSeq: state.placement.seq,
        photoVersion: state.photo.version } });
  }

  // A v2 ("疑似待复核"编辑器): the placement editor's whole reason to exist is a photo whose
  // placement ISN'T confirmed yet (needs_confirmation/failed), so gating its 360 preview on
  // sceneContext()/photoState() above — which require placement_state='confirmed' — makes the
  // one screen meant to *produce* that confirmation unable to open until it already happened.
  // This is a deliberately separate method rather than a flag on sceneContext(): callers here
  // are pre-authorized by PlacementService#managerOrReceipt() (manager with canEditPlacement,
  // or a receipt session whose item has uploader_placement_write_enabled=1 — see editView() and
  // receiptItem(), the only two call sites), never a bare viewer/account "view" session. The
  // public GET /v1/viewer/spaces/{sid}/photos/{pid}/scene-context route (sceneContext() above)
  // is untouched, so a plain visitor still can't pull scene data for an unreviewed/unplaced
  // photo through it — that boundary is the whole safety point of keeping this method separate.
  // Returns null instead of throwing whenever there simply isn't a panorama/asset to show yet
  // (matches sceneContext()'s data-shape, just without the confirmed-placement requirement) so
  // an otherwise-fine editView()/receiptItem() response can omit sceneContext instead of 500ing.
  //
  // photoMedia points at PlacementService#editorMedia()'s own route (/v1/photos/{pid}/placement-
  // edit/media), NOT the general-purpose photo() route below — that route's own authorize() only
  // understands account/viewer "view" sessions (no receipt-session branch, no canEditPlacement/
  // uploader-write-enabled distinction) and photo() also requires the confirmed placement this
  // whole method exists to route around, so reusing it here would mean either leaking bytes to a
  // plain viewer or leaving a receipt-session uploader unable to fetch their own draft photo.
  editorSceneContext(spaceId, photoId) {
    const photo = this.core.one("SELECT * FROM photos WHERE id=? AND space_id=? AND deleted_at IS NULL",
      photoId, spaceId);
    if (!photo) return null;
    const space = this.core.one("SELECT current_panorama_revision_id FROM spaces WHERE id=?", spaceId);
    const state = this.sceneRevisionFor(spaceId, space?.current_panorama_revision_id);
    if (!state) return null;
    const originalAsset = this.core.one("SELECT * FROM assets WHERE id=? AND space_id=? AND validation_state='valid'",
      photo.asset_id, spaceId);
    const viewerSafeAsset = this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=?
      AND kind='photo_viewer_safe' AND validation_state='valid' AND metadata_policy_result='exif_gps_stripped'`,
    photo.viewer_safe_asset_id, spaceId);
    if (!originalAsset || !viewerSafeAsset) return null;
    // Unlike sceneContext()'s photoState(), this deliberately does NOT filter on
    // placement_state='confirmed' — a needs_confirmation/failed photo has no confirmed row to
    // find (dispatch/index.mjs's placement() only ever inserts one for same_scene_high), so the
    // lookup just comes back empty and `placement` below is null, exactly as documented above.
    // A photo that *was* confirmed under a since-retired panorama revision also correctly comes
    // back null here (panorama_revision_id won't match state.revision.id), which is right: an
    // old pose doesn't apply to a new panorama either.
    const placementRow = photo.current_placement_revision_id ? this.core.one(
      `SELECT * FROM placement_revisions WHERE id=? AND photo_id=? AND panorama_revision_id=? AND placement_state='confirmed'`,
      photo.current_placement_revision_id, photoId, state.revision.id) : null;
    const depthArtifact = this.depthArtifactFor(spaceId, state.revision.id);
    return describeSceneContext({ spaceId, photoId, scene: state.scene, revision: state.revision,
      panoramaAsset: state.panoramaAsset, viewerSafeAsset, depthArtifact, depthImport: this.depthImportFor(spaceId, state.revision.id), originalAsset,
      photoMediaUrl: `/v1/photos/${photoId}/placement-edit/media`,
      placement: placementRow ? { revisionId: placementRow.id, status: "confirmed",
        confirmationMode: placementRow.confirmation_mode, yawDeg: placementRow.yaw,
        pitchDeg: placementRow.pitch, fovDeg: placementRow.fov, placementSeq: placementRow.seq,
        photoVersion: photo.version } : null });
  }

  photoUploadInfo(photo) {
    const batch=this.core.one('SELECT actor_kind,actor_id,created_at FROM contribution_batches WHERE id=?',photo.batch_id);
    const author=batch?.actor_kind==='account'?this.core.one('SELECT display_name FROM account_administration WHERE account_id=?',batch.actor_id):null;
    return {authorCredit:author?.display_name||(batch?.actor_kind==='account'?'空间成员':'受邀同行者'),uploadedAt:photo.uploaded_at||null};
  }

  photoDetail(ctx, spaceId, photoId) {
    const auth = this.authorize(ctx, spaceId);
    const photo = this.core.one(`SELECT * FROM photos WHERE id=? AND space_id=?
      AND photo_content_state='visible' AND deleted_at IS NULL`, photoId, spaceId);
    const originalAsset = photo ? this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=?
      AND validation_state='valid'`, photo.asset_id, spaceId) : null;
    const viewerSafeAsset = photo ? this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=?
      AND kind='photo_viewer_safe' AND validation_state='valid' AND metadata_policy_result='exif_gps_stripped'`,
    photo.viewer_safe_asset_id, spaceId) : null;
    assert(photo && originalAsset && viewerSafeAsset, "resource_unavailable", 404);
    // Video upload v0: a video photo's photoMedia above still resolves to its poster PNG (the
    // same asset every other reader of viewer_safe_asset_id uses -- see migration 0017), so an
    // album grid or any caller that only reads photoMedia keeps working unmodified. The `video`
    // field is additive: only present for media_type='video', pointing at the transcoded,
    // metadata-stripped mp4 derivative served by video() below. apps/web's photo-detail page is
    // the one and only reader of this field today.
    const videoAsset = photo.media_type === "video" ? this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=?
      AND kind='video_viewer_safe' AND validation_state='valid' AND metadata_policy_result='exif_gps_stripped'`,
    photo.video_asset_id, spaceId) : null;
    const placement = this.core.one(`SELECT * FROM placement_revisions WHERE id=? AND photo_id=?
      AND panorama_revision_id=? AND placement_state='confirmed'`, photo.current_placement_revision_id,
    photo.id, auth.space.current_panorama_revision_id);
    const scene = this.core.one("SELECT * FROM scenes WHERE space_id=?", spaceId);
    const revision = this.core.one(`SELECT * FROM panorama_revisions WHERE id=? AND space_id=?
      AND ready_at IS NOT NULL AND activated_at IS NOT NULL AND retired_at IS NULL`,
    auth.space.current_panorama_revision_id, spaceId);
    const canReturnToScene = Boolean(placement && revision && scene?.scene_readiness === "ready" &&
      scene.scene_mode === "rotation360");
    return { authBranch: auth.branch, photoId: photo.id,upload:this.photoUploadInfo(photo),
      photoContentState: photo.photo_content_state, placementState: photo.placement_state,
      confirmationMode: photo.confirmation_mode, canReturnToScene, reportCapability: true,
      mediaType: photo.media_type,
      photoAssetId: originalAsset.id, photoAssetVersion: originalAsset.version,
      photoRawSha256: originalAsset.raw_sha256,
      photoMedia: descriptor(viewerSafeAsset, `/v1/viewer/spaces/${spaceId}/photos/${photoId}/album-media`),
      ...(videoAsset ? { video: descriptor(videoAsset, `/v1/viewer/spaces/${spaceId}/photos/${photoId}/video`) } : {}),
      version: photo.version };
  }

  // Video playback (v0). Deliberately gated the same way photoDetail() above is (visible,
  // not-deleted) rather than photoState()'s stricter "placement confirmed" requirement: a
  // freshly-uploaded video should be playable in the album/photo-detail page immediately, well
  // before (or even if never) it gets placed in the 360 scene. packages/viewer never reaches this
  // route -- the in-scene marker only ever shows the poster image via photo()/photoMedia above.
  videoState(ctx, spaceId, photoId) {
    const auth = this.authorize(ctx, spaceId);
    const photo = this.core.one(`SELECT * FROM photos WHERE id=? AND space_id=?
      AND photo_content_state='visible' AND deleted_at IS NULL AND media_type='video'`, photoId, spaceId);
    const videoAsset = photo ? this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=?
      AND kind='video_viewer_safe' AND validation_state='valid' AND metadata_policy_result='exif_gps_stripped'`,
    photo.video_asset_id, spaceId) : null;
    assert(photo && videoAsset, "resource_unavailable", 404);
    return { auth, photo, videoAsset };
  }

  video(ctx, spaceId, photoId) {
    const state = this.videoState(ctx, spaceId, photoId);
    return this.serve(ctx, { space: state.auth.space.version, photo: state.photo.version,
      asset: state.videoAsset.version }, state.videoAsset, () => {
        assert(this.videoState(ctx, spaceId, photoId).videoAsset.id === state.videoAsset.id, "media_unavailable", 404);
      });
  }

  async serve(ctx, state, asset, reauthorize = null) {
    const selected = rangeFor(ctx.range, asset.observed_bytes);
    const object = await this.mediaStore.get(asset.private_object_key, { maxBytes: asset.observed_bytes });
    assert(object.body.length === asset.observed_bytes && object.contentType === asset.observed_mime &&
      sha256(object.body) === asset.raw_sha256, "media_unavailable", 404);
    if (reauthorize) reauthorize();
    const currentAsset = this.core.one("SELECT * FROM assets WHERE id=? AND space_id=? AND validation_state='valid'", asset.id, asset.space_id);
    assert(currentAsset?.private_object_key === asset.private_object_key && currentAsset?.raw_sha256 === asset.raw_sha256, "media_unavailable", 404);
    const body = object.body.subarray(selected.start, selected.end + 1);
    return { _raw: body, status: selected.partial ? 206 : 200, headers: {
      "content-type": asset.observed_mime,
      "content-length": String(body.length),
      "cache-control": "private, no-store",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      etag: `"${asset.raw_sha256}"`,
      ...(selected.partial ? { "content-range": `bytes ${selected.start}-${selected.end}/${asset.observed_bytes}` } : {})
    }, stateVersions: state };
  }

  panorama(ctx, spaceId, revisionId) {
    const state = this.currentScene(ctx, spaceId);
    assert(state.revision.id === revisionId, "scene_unavailable", 404);
    return this.serve(ctx, { space: state.auth.space.version, scene: state.scene.version,
      revision: state.revision.version, asset: state.panoramaAsset.version }, state.panoramaAsset, () => {
        assert(this.currentScene(ctx, spaceId).revision.id === revisionId, "scene_unavailable", 404);
      });
  }

  depthMap(ctx, spaceId, revisionId) {
    const state = this.currentScene(ctx, spaceId);
    assert(state.revision.id === revisionId, "scene_unavailable", 404);
    const descriptor = this.depthImportFor(spaceId, revisionId) || this.depthArtifactFor(spaceId, revisionId)?.depthMap;
    const asset = descriptor ? this.core.one("SELECT * FROM assets WHERE id=? AND space_id=? AND validation_state='valid'", descriptor.assetId, spaceId) : null;
    assert(asset, "media_unavailable", 404);
    return this.serve(ctx, { space: state.auth.space.version, scene: state.scene.version,
      revision: state.revision.version, asset: asset.version }, asset, () => {
        assert(this.currentScene(ctx, spaceId).revision.id === revisionId, "scene_unavailable", 404);
        const current = this.depthImportFor(spaceId, revisionId) || this.depthArtifactFor(spaceId, revisionId)?.depthMap;
        assert(current?.assetId === asset.id, "media_unavailable", 404);
      });
  }

  photo(ctx, spaceId, photoId) {
    const state = this.photoState(ctx, spaceId, photoId);
    return this.serve(ctx, { space: state.auth.space.version, scene: state.scene.version,
      revision: state.revision.version, photo: state.photo.version, placement: state.placement.seq,
      asset: state.viewerSafeAsset.version }, state.viewerSafeAsset, () => {
        const current = this.photoState(ctx, spaceId, photoId);
        assert(current.revision.id === state.revision.id && current.viewerSafeAsset.id === state.viewerSafeAsset.id,
          "photo_scene_unavailable", 404);
      });
  }

  albumPhoto(ctx, spaceId, photoId) {
    // Album availability depends on visible content, not successful localization.
    // Scene-context keeps the stricter confirmed/current-revision boundary.
    const detail = this.photoDetail(ctx, spaceId, photoId);
    const asset = this.core.one("SELECT * FROM assets WHERE id=? AND space_id=?", detail.photoMedia.assetId, spaceId);
    return this.serve(ctx, { photo: detail.version, asset: asset.version }, asset, () => {
      assert(this.photoDetail(ctx, spaceId, photoId).photoMedia.assetId === asset.id, "media_unavailable", 404);
    });
  }
}
