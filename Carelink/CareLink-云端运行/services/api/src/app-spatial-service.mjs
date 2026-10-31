import { assert, ApiError } from './errors.mjs';
import { inspectMedia } from './media.mjs';
import { id, sha256, stableJson } from './util.mjs';
import { parseDepthImport } from '../../../packages/viewer/src/import.js';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const LIMIT = 12 * 1024 * 1024;
function readFile(value, depth = false) {
  assert(value && typeof value.name === 'string' && value.name.length <= 240 && !/[\\/]/.test(value.name), 'spatial_file_invalid', 422);
  assert((depth ? ['image/png'] : ['image/jpeg', 'image/png', 'image/webp']).includes(value.mimeType), 'spatial_file_type', 415);
  assert(typeof value.dataBase64 === 'string' && value.dataBase64.length <= Math.ceil(LIMIT / 3) * 4, 'spatial_file_too_large', 413);
  const bytes = Buffer.from(value.dataBase64, 'base64');
  assert(bytes.length && bytes.length <= LIMIT && bytes.toString('base64') === value.dataBase64, 'spatial_file_invalid', 422);
  return bytes;
}
export class AppSpatialService {
  constructor(api) { this.api = api; this.core = api.core; this.db = api.core.db; this.active = new Set(); }
  expected(ctx, account) { assert(ctx.headers['x-unseen-expected-account-id'] === account.accountId, 'account_changed', 409); }
  row(account, clientId) {
    assert(validId(clientId), 'spatial_id_invalid', 422);
    const row = this.core.one('SELECT * FROM app_spatial_imports WHERE account_id=? AND client_id=?', account.accountId, clientId);
    assert(row, 'spatial_unavailable', 404);
    this.core.accountSpace(account, row.space_id, { task: 'view' });
    return row;
  }
  currentImport(row, revisionId) {
    return this.core.one('SELECT * FROM app_spatial_imports WHERE space_id=? AND panorama_revision_id=? ORDER BY rowid DESC LIMIT 1', row.space_id, revisionId) || row;
  }
  get(account, clientId) {
    const row = this.row(account, clientId);
    const space = this.core.one('SELECT * FROM spaces WHERE id=?', row.space_id);
    const scene = this.core.one('SELECT * FROM scenes WHERE id=?', space.scene_id);
    const revision = this.core.one('SELECT * FROM panorama_revisions WHERE id=? AND space_id=?', space.current_panorama_revision_id, space.id);
    const pano = revision && this.core.one("SELECT * FROM assets WHERE id=? AND space_id=? AND validation_state='valid'", revision.asset_id, space.id);
    const current = this.currentImport(row, revision?.id || null);
    const metadata = current.depth_metadata_json ? JSON.parse(current.depth_metadata_json) : null;
    const hasDepth = pano && current.depth_asset_id && metadata?.sourcePanoramaRevisionId === revision.id &&
      this.core.one("SELECT id FROM assets WHERE id=? AND space_id=? AND validation_state='valid'", current.depth_asset_id, space.id);
    const base = `/v1/app-spaces/${clientId}`;
    return { accountId: account.accountId, space: { id: clientId, spaceId: space.id, title: space.name,
      status: hasDepth ? 'ready' : pano ? 'panorama' : 'unavailable', createdAt: row.created_at,
      spaceVersion: space.version, sceneVersion: scene.version, panoramaRevisionId: revision?.id || null,
      ...(pano ? { panorama: { url: `${base}/media/panorama`, name: current.panorama_name,
        width: pano.width, height: pano.height, sha256: pano.raw_sha256 } } : {}),
      ...(hasDepth ? { depth: { url: `${base}/media/depth`, metadata } } : {}) } };
  }
  list(account) {
    const rows = this.core.all(`SELECT i.client_id FROM app_spatial_imports i JOIN spaces s ON s.id=i.space_id
      WHERE i.account_id=? AND s.owner_account_id=? AND s.space_lifecycle='active' AND i.rowid=(
        SELECT MAX(j.rowid) FROM app_spatial_imports j WHERE j.space_id=i.space_id AND j.account_id=i.account_id)
      ORDER BY i.created_at DESC`, account.accountId, account.accountId);
    return { accountId: account.accountId, spaces: rows.map(row => this.get(account, row.client_id).space) };
  }
  async media(account, clientId, kind, ctx) {
    const alias = this.row(account, clientId);
    assert(['panorama', 'depth'].includes(kind), 'spatial_unavailable', 404);
    const revision = this.core.one('SELECT p.* FROM panorama_revisions p JOIN spaces s ON s.current_panorama_revision_id=p.id WHERE s.id=?', alias.space_id);
    assert(revision, 'spatial_unavailable', 404);
    const row = this.currentImport(alias, revision.id);
    if (kind === 'depth') assert(row.depth_metadata_json && JSON.parse(row.depth_metadata_json).sourcePanoramaRevisionId === revision.id, 'depth_revision_changed', 409);
    const asset = this.core.one('SELECT * FROM assets WHERE id=? AND space_id=? AND validation_state=?', kind === 'depth' ? row.depth_asset_id : revision.asset_id, row.space_id, 'valid');
    assert(asset, 'spatial_unavailable', 404);
    const stored = await this.api.mediaStore.get(asset.private_object_key, { maxBytes: LIMIT });
    assert(sha256(stored.body) === asset.raw_sha256, 'spatial_integrity_failed', 503);
    const currentAccount = this.core.account(ctx?.accountSession);
    assert(currentAccount.accountId === account.accountId, 'account_changed', 409);
    const currentAlias = this.row(currentAccount, clientId);
    const currentSpace = this.core.one('SELECT * FROM spaces WHERE id=?', currentAlias.space_id);
    const current = this.currentImport(currentAlias, currentSpace.current_panorama_revision_id);
    assert(current.space_id === row.space_id && currentSpace.current_panorama_revision_id === revision.id &&
      (kind !== 'depth' || current.depth_asset_id === asset.id && current.depth_metadata_json === row.depth_metadata_json), 'spatial_unavailable', 404);
    const currentAsset = this.core.one('SELECT * FROM assets WHERE id=? AND space_id=? AND validation_state=?', asset.id, current.space_id, 'valid');
    assert(currentAsset?.raw_sha256 === asset.raw_sha256 && currentAsset?.private_object_key === asset.private_object_key, 'spatial_unavailable', 404);
    return { _raw: stored.body, headers: { 'content-type': asset.observed_mime, 'cache-control': 'no-store, private',
      'content-length': String(stored.body.length), 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' } };
  }
  async save(ctx, account, clientId) {
    this.expected(ctx, account);
    assert(validId(clientId), 'spatial_id_invalid', 422);
    const b = ctx.body;
    assert(b?.consent === true && typeof b.title === 'string' && b.title.trim().length > 0 && b.title.length <= 120, 'spatial_input_invalid', 422);
    assert(!b.depth === !b.metadata, 'depth_pair_required', 422);
    assert(b.spaceId == null || validId(b.spaceId), 'spatial_id_invalid', 422);
    const requestHash = sha256(stableJson(b));
    const old = this.core.one('SELECT * FROM app_spatial_imports WHERE account_id=? AND client_id=?', account.accountId, clientId);
    if (old) { assert(old.request_hash === requestHash, 'spatial_import_conflict', 409); return this.get(account, clientId); }
    const target = b.spaceId ? this.core.accountSpace(account, b.spaceId, { ownerOnly: true }).space : null;
    if (target) {
      this.core.requireIfMatch(ctx, target);
      const scene = this.core.one('SELECT * FROM scenes WHERE id=?', target.scene_id);
      assert(Number(b.sceneIfMatchVersion) === scene.version, 'scene_version_conflict', 409);
    }
    assert(!this.active.has(account.accountId) && this.active.size < 2, 'spatial_import_busy', 429);
    assert(this.core.one('SELECT count(*) n FROM app_spatial_imports WHERE account_id=?', account.accountId).n < 100, 'spatial_storage_limit', 413);
    this.active.add(account.accountId);
    try {
      const panorama = readFile(b.panorama), depth = b.depth ? readFile(b.depth, true) : null;
      const info = await inspectMedia(panorama, { kind: 'panorama', declaredMime: b.panorama.mimeType, decoderRunner: this.api.decoderRunner });
      const depthInfo = depth ? await inspectMedia(depth, { declaredMime: 'image/png', decoderRunner: this.api.decoderRunner }) : null;
      let parsed = null;
      try { parsed = depth ? parseDepthImport(b.metadata, { panorama: info, depth: depthInfo, panoramaName: b.panorama.name,
        panoramaSha256: info.sha256, depthSha256: depthInfo.sha256 }) : null; }
      catch (error) { throw new ApiError(error.code || 'depth_metadata_invalid', 422); }
      const accountNow = this.core.account(ctx.accountSession); this.expected(ctx, accountNow);
      const spaceId = target?.id || id('space'), sceneId = target?.scene_id || id('scene'), panoId = id('asset'), depthId = depth ? id('asset') : null;
      const candidateId = id('pano_c'), revisionId = id('pano_r'), now = this.core.now();
      const key = kind => `private/${spaceId}/app-import/${revisionId}/${kind}`;
      await this.api.mediaStore.putIfAbsent(key('panorama'), panorama, { contentType: info.mime, maxBytes: LIMIT });
      if (depth) await this.api.mediaStore.putIfAbsent(key('depth'), depth, { contentType: 'image/png', maxBytes: LIMIT });
      this.expected(ctx, this.core.account(ctx.accountSession));
      const metadata = parsed ? { schemaVersion: 'unseen-depth-import/1', panoramaSha256: info.sha256, depthSha256: depthInfo.sha256,
        sourcePanoramaRevisionId: revisionId, metadata: parsed.metadata } : null;
      this.core.mutation({ ...ctx, body: { requestHash }, ifMatch: target ? ctx.ifMatch : '0' }, { endpoint: `/v1/app-spaces/${clientId}`, method: 'PUT', scope: account.accountId,
        reauthorize: () => { this.expected(ctx, this.core.account(ctx.accountSession)); if (target) this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true }); } }, () => {
        if (target) this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true });
        if (!target) {
          this.db.prepare(`INSERT INTO spaces(id,name,owner_account_id,space_lifecycle,collection_state,sharing_state,scene_id,version,created_at,updated_at)
            VALUES(?,?,?,'active','paused','private',?,1,?,?)`).run(spaceId, b.title.trim(), account.accountId, sceneId, now, now);
          this.db.prepare(`INSERT INTO scenes(id,space_id,scene_readiness,scene_mode,current_derived_asset_id,version,created_at,updated_at)
            VALUES(?,?,'ready','rotation360',?,1,?,?)`).run(sceneId, spaceId, panoId, now, now);
        }
        const asset = (assetId, kind, fileInfo, bytes) => this.db.prepare(`INSERT INTO assets(id,space_id,kind,private_object_key,raw_sha256,observed_bytes,observed_mime,width,height,validation_state,version)
          VALUES(?,?,?,?,?,?,?,?,?,'valid',1)`).run(assetId, spaceId, kind === 'panorama' ? 'panorama' : 'depth_map', key(kind), fileInfo.sha256, bytes.length, fileInfo.mime, fileInfo.width, fileInfo.height);
        asset(panoId, 'panorama', info, panorama); if (depth) asset(depthId, 'depth', depthInfo, depth);
        this.db.prepare(`INSERT INTO panorama_candidates(id,space_id,asset_id,panorama_revision_id,status,created_by,expires_at,committed_at,ready_at,version)
          VALUES(?,?,?,?,'ready',?,?,?,?,1)`).run(candidateId, spaceId, panoId, revisionId, account.session.id, now, now, now);
        this.db.prepare(`INSERT INTO panorama_revisions(id,space_id,candidate_id,asset_id,validation_report_json,created_by,ready_at,activated_at,version)
          VALUES(?,?,?,?,?,?,?,?,1)`).run(revisionId, spaceId, candidateId, panoId, JSON.stringify(info), account.session.id, now, target ? null : now);
        if (target) this.api.panoramas.activate(ctx, accountNow, spaceId, revisionId, b.sceneIfMatchVersion);
        else this.db.prepare('UPDATE spaces SET current_panorama_revision_id=? WHERE id=?').run(revisionId, spaceId);
        this.db.prepare(`INSERT INTO app_spatial_imports(account_id,client_id,space_id,request_hash,depth_asset_id,depth_metadata_json,panorama_name,created_at,panorama_revision_id)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(account.accountId, clientId, spaceId, requestHash, depthId, metadata ? JSON.stringify(metadata) : null, b.panorama.name, now, revisionId);
        if (parsed?.encoding === 'linear-red-v1') this.db.prepare(`INSERT INTO scene_depth_artifacts(id,space_id,scene_id,panorama_revision_id,depth_asset_id,artifact_id,near_meters,far_meters,valid_fraction,safety_envelope_json,created_at,updated_at,version)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(id('scene_depth'), spaceId, sceneId, revisionId, depthId, id('depth_artifact'), parsed.near, parsed.far, parsed.metadata.quality.validFraction, JSON.stringify(parsed.safetyEnvelope), now, now);
        this.core.audit({ spaceId, aggregateType: 'space', aggregateId: spaceId, eventType: 'private_spatial_imported', actorKind: 'account', authorizationId: account.session.id,
          detail: { panoramaRevisionId: revisionId, encoding: parsed?.encoding || 'rotation360', consent: true }, requestId: ctx.requestId });
        return { clientId };
      });
      return this.get(account, clientId);
    } finally { this.active.delete(account.accountId); }
  }
}
