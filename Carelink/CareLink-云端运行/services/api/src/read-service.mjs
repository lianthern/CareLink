import { assert } from "./errors.mjs";
import { parseJson } from "./util.mjs";

export class ReadService {
  constructor(core, viewerMedia) {
    this.core = core;
    this.viewerMedia = viewerMedia;
  }

  viewerAuth(ctx, spaceId) {
    if (ctx.accountSession) {
      const account = this.core.account(ctx.accountSession);
      const access = this.core.accountSpace(account, spaceId, { task: "view" });
      return { branch: "account", account, access, space: access.space };
    }
    const viewer = this.core.viewer(ctx.viewerSession);
    assert(viewer.space.id === spaceId, "resource_unavailable", 404);
    return { branch: "external", viewer, space: viewer.space };
  }

  viewerSpace(ctx, spaceId) {
    const auth = this.viewerAuth(ctx, spaceId);
    const scene = this.core.one("SELECT * FROM scenes WHERE space_id=?", spaceId);
    // Aliased to camelCase in the SQL (same `column alias` idiom as SpaceService#transfers() and
    // api.mjs's cases()): node:sqlite keys rows by the literal selected column name, so an
    // unaliased SELECT put snake_case on the wire while the rest of this DTO -- and
    // CANONICAL-STATE-AND-API.md's `photos` row -- is camelCase, leaving apps/web's
    // photo.placementState/confirmationMode/mediaType reads undefined. Easy to miss because only
    // production hits this: it boots infra/integration/book-lab/deployment-entrypoint.mjs, which
    // serves the projection raw, whereas local/stage goes through local-operable.mjs, which
    // discards this array and rebuilds it in viewerSpaceProjection().
    const photos = this.core.all(`SELECT id,photo_content_state photoContentState,
      placement_state placementState,confirmation_mode confirmationMode,media_type mediaType,version
      FROM photos WHERE space_id=? AND photo_content_state='visible' AND deleted_at IS NULL ORDER BY rowid`, spaceId);
    let effectiveCanUpload = false;
    if (auth.branch === "account") {
      effectiveCanUpload = auth.access.owner || parseJson(auth.access.membership?.tasks_json, []).includes("upload");
    } else effectiveCanUpload = parseJson(auth.viewer.grant.tasks_json).includes("upload");
    const sceneContext = this.viewerMedia.spaceSceneContext(ctx, spaceId);
    effectiveCanUpload = effectiveCanUpload && auth.space.collection_state === "open";
    return { sceneContext, version: auth.space.version, collectionState: auth.space.collection_state,
      sceneVersion: scene.version, authBranch: auth.branch, spaceId, name: auth.space.name, spaceLifecycle: auth.space.space_lifecycle,
      sharingState: auth.space.sharing_state, sceneReadiness: scene.scene_readiness, sceneMode: scene.scene_mode,
      currentPanoramaRevisionId: auth.space.current_panorama_revision_id, effectiveCanUpload, photos };
  }

  photo(ctx, spaceId, photoId) {
    return this.viewerMedia.photoDetail(ctx, spaceId, photoId);
  }

  sceneContext(ctx, spaceId, photoId) {
    return this.viewerMedia.sceneContext(ctx, spaceId, photoId);
  }
}
