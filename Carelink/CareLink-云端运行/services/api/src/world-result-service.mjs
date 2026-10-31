import { createHmac, timingSafeEqual } from 'node:crypto';
import { assert, ApiError } from './errors.mjs';
import { id, sha256, stableJson } from './util.mjs';
import { transaction } from './database.mjs';
import { inspectMedia } from './media.mjs';

const MAX_PROOF_AGE = 10 * 60_000;
const ASSET_HOST = 'cdn.marble.worldlabs.ai';
const fields = Object.freeze({ thumbnail: ['thumbnailUrl', 8 * 1024 ** 2], panorama: ['panoramaUrl', 32 * 1024 ** 2],
  'collider.glb': ['colliderUrl', 48 * 1024 ** 2], 'preview.spz': ['preview', 48 * 1024 ** 2],
  'standard.spz': ['standard', 48 * 1024 ** 2], 'full.spz': ['full', 48 * 1024 ** 2] });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function remoteUrl(value, worldId, marble = false) {
  if (value == null) return null;
  assert(typeof value === 'string' && value.length <= 2048, 'world_result_invalid', 422);
  let url; try { url = new URL(value); } catch { throw new ApiError('world_result_invalid', 422); }
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !url.search &&
    url.hostname === (marble ? 'marble.worldlabs.ai' : ASSET_HOST) &&
    (marble ? url.pathname === `/world/${worldId}` : url.pathname.startsWith(`/${worldId}/`)), 'world_asset_source_invalid', 422);
  return url.href;
}
function cleanWorld(value) {
  assert(plain(value) && identifier(value.id) && typeof value.name === 'string' && value.name.length <= 500 && plain(value.splats), 'world_result_invalid', 422);
  const world = { id: value.id, name: value.name, marbleUrl: remoteUrl(value.marbleUrl, value.id, true),
    thumbnailUrl: remoteUrl(value.thumbnailUrl, value.id), panoramaUrl: remoteUrl(value.panoramaUrl, value.id),
    colliderUrl: remoteUrl(value.colliderUrl, value.id), splats: {}, semantics: {} };
  for (const key of ['preview', 'standard', 'full']) world.splats[key] = remoteUrl(value.splats[key], value.id);
  assert(Object.values(world.splats).some(Boolean), 'world_splat_missing', 422);
  for (const key of ['metricScaleFactor', 'groundPlaneOffset']) {
    const v = value.semantics?.[key];
    assert(v == null || typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 10000 && (key !== 'metricScaleFactor' || v > 0), 'world_result_invalid', 422);
    world.semantics[key] = v ?? null;
  }
  return world;
}

export class WorldResultService {
  constructor(api, options = {}) {
    this.api = api; this.core = api.core; this.db = api.db;
    this.key = typeof options.signingKey === 'string' && Buffer.byteLength(options.signingKey) >= 32 ? options.signingKey : null;
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pending = new Map();
  }
  verify(proof, accountId, spaceId, ctx) {
    assert(this.key, 'world_result_not_configured', 503);
    assert(plain(proof) && plain(proof.payload) && typeof proof.signature === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof.signature), 'world_proof_invalid', 422);
    const serialized = JSON.stringify(proof.payload);
    assert(Buffer.byteLength(serialized) <= 32 * 1024, 'world_proof_invalid', 422);
    const expected = createHmac('sha256', this.key).update(serialized).digest();
    const signature = Buffer.from(proof.signature, 'base64url');
    assert(signature.length === expected.length && timingSafeEqual(signature, expected), 'world_proof_invalid', 422);
    const p = proof.payload;
    assert(p.version === 1 && p.accountId === accountId && p.spaceId === spaceId && identifier(p.requestId) &&
      Number.isSafeInteger(p.spaceVersion) && Number.isSafeInteger(p.sceneVersion) &&
      typeof p.issuedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p.issuedAt) && Number.isFinite(Date.parse(p.issuedAt)), 'world_proof_invalid', 422);
    const world = cleanWorld(p.world);
    return { payload: p, world, resultHash: sha256(stableJson(world)) };
  }
  imported(row, replayed = false) {
    const space = this.core.one('SELECT * FROM spaces WHERE id=?', row.space_id);
    const scene = this.core.one('SELECT * FROM scenes WHERE id=?', row.scene_id);
    return { spaceId: row.space_id, worldResultId: row.id, sceneRevisionId: row.id, worldId: row.world_id,
      spaceVersion: space.version, sceneVersion: scene.version, sceneMode: scene.scene_mode,
      active: space.current_world_result_id === row.id, ...(replayed ? { replayed: true } : {}) };
  }
  save(ctx, account, spaceId) {
    assert(ctx.headers['x-unseen-expected-account-id'] === account.accountId, 'account_changed', 409);
    const access = this.core.accountSpace(account, spaceId, { ownerOnly: true });
    const { payload: p, world, resultHash } = this.verify(ctx.body?.worldProof, account.accountId, spaceId, ctx);
    const old = this.core.one('SELECT * FROM scene_world_results WHERE account_id=? AND request_id=?', account.accountId, p.requestId);
    if (old) {
      assert(old.space_id === spaceId && old.result_hash === resultHash, 'world_result_conflict', 409);
      return this.imported(old, true);
    }
    const age = this.core.nowMs() - Date.parse(p.issuedAt);
    assert(age >= -30_000 && age <= MAX_PROOF_AGE, 'world_proof_expired', 409);
    assert(Number(ctx.ifMatch) === p.spaceVersion && Number(ctx.body.sceneIfMatchVersion) === p.sceneVersion, 'world_proof_version_mismatch', 409);
    this.core.requireIfMatch(ctx, access.space);
    const scene = this.core.one('SELECT * FROM scenes WHERE id=?', access.space.scene_id);
    assert(scene.version === p.sceneVersion, 'scene_version_conflict', 409);
    // Fingerprint the durable task/result, never the fresh proof timestamp/signature.
    return this.core.mutation({ ...ctx, body: { requestId: p.requestId, resultHash } }, {
      endpoint: `/v1/spaces/${spaceId}/world-results`, scope: account.accountId,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true })
    }, () => {
      const current = this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true });
      this.core.requireIfMatch(ctx, current.space);
      const currentScene = this.core.one('SELECT * FROM scenes WHERE id=?', current.space.scene_id);
      assert(currentScene.version === p.sceneVersion, 'scene_version_conflict', 409);
      const resultId = id('world_result'), now = this.core.now();
      this.db.prepare(`INSERT INTO scene_world_results(id,account_id,space_id,scene_id,request_id,world_id,result_hash,world_json,
        source_space_version,source_scene_version,activated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(resultId, account.accountId, spaceId, scene.id, p.requestId, world.id, resultHash, JSON.stringify(world), p.spaceVersion, p.sceneVersion, now);
      const previous = current.space.current_panorama_revision_id;
      if (previous) {
        this.db.prepare('UPDATE panorama_revisions SET retired_at=?,version=version+1 WHERE id=? AND retired_at IS NULL').run(now, previous);
        this.api.panoramas.invalidatePlacements(ctx, account, current, currentScene, previous);
      }
      if (current.space.current_world_result_id) this.db.prepare('UPDATE scene_world_results SET retired_at=? WHERE id=? AND retired_at IS NULL').run(now, current.space.current_world_result_id);
      this.db.prepare('UPDATE spaces SET current_world_result_id=?,current_panorama_revision_id=NULL,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(resultId, now, spaceId, current.space.version);
      this.db.prepare("UPDATE scenes SET scene_mode='walkable3d',scene_readiness='ready',current_derived_asset_id=NULL,version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(now, scene.id, currentScene.version);
      this.core.audit({ spaceId, aggregateType: 'scene', aggregateId: scene.id, eventType: 'world_result_activated', actorKind: 'account', authorizationId: account.session.id,
        detail: { worldResultId: resultId, requestId: p.requestId, resultHash, source: 'World Labs', aiGenerated: true }, requestId: ctx.requestId });
      return this.imported(this.core.one('SELECT * FROM scene_world_results WHERE id=?', resultId));
    });
  }
  current(spaceId, resultId) {
    const space = this.core.one("SELECT * FROM spaces WHERE id=? AND space_lifecycle='active'", spaceId);
    const row = space?.current_world_result_id ? this.core.one('SELECT * FROM scene_world_results WHERE id=? AND space_id=? AND retired_at IS NULL', space.current_world_result_id, spaceId) : null;
    assert(row && (!resultId || row.id === resultId), 'world_scene_unavailable', 404);
    return { space, row, world: JSON.parse(row.world_json) };
  }
  sceneContext(spaceId) {
    const { space, row, world } = this.current(spaceId);
    const base = `/v1/viewer/spaces/${spaceId}/world-results/${row.id}/media/`;
    const dto = { id: row.id, name: world.name, marbleUrl: null, provider: 'World Labs', aiGenerated: true,
      providerExposure: 'provider_may_be_public', semantics: world.semantics, splats: {} };
    for (const [kind, [field]] of Object.entries(fields)) {
      const source = kind.endsWith('.spz') ? world.splats[field] : world[field];
      if (kind.endsWith('.spz')) dto.splats[field] = source ? base + kind : null;
      else dto[field] = source ? base + kind : null;
    }
    return { sceneReadiness: 'ready', sceneMode: 'walkable3d', scene: { sceneId: space.scene_id,
      sceneRevisionId: row.id, worldResultId: row.id, panoramaRevisionId: null }, world: dto,
      panorama: null, depthArtifact: null, depthImport: null, placements: [] };
  }
  authorize(ctx, spaceId, resultId) {
    this.api.viewerMedia.authorize(ctx, spaceId);
    return this.current(spaceId, resultId);
  }
  async fetchAsset(ctx, spaceId, resultId, kind) {
    const { world } = this.authorize(ctx, spaceId, resultId);
    const [field, limit] = fields[kind];
    const url = kind.endsWith('.spz') ? world.splats[field] : world[field];
    assert(url, 'world_media_unavailable', 404);
    // The exact provider host/path was signed, checked at import, and rechecked at use.
    remoteUrl(url, world.id);
    let response, bytes;
    try {
      response = await this.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: '*/*' } });
      assert(response.ok && !response.redirected && (response.url === '' || response.url === url), 'world_media_unavailable', 502);
      const declared = response.headers.get('content-length');
      assert(!declared || /^\d+$/.test(declared) && Number(declared) <= limit, 'world_media_too_large', 413);
      assert(response.body, 'world_media_unavailable', 502);
      const chunks = []; let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length; assert(total <= limit, 'world_media_too_large', 413); chunks.push(Buffer.from(chunk));
      }
      assert(total > 0, 'world_media_unavailable', 502);
      bytes = Buffer.concat(chunks);
    } catch (error) {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      if (error instanceof ApiError) throw error;
      throw new ApiError('world_media_unavailable', 502);
    }
    let info = { mime: 'application/octet-stream', sha256: sha256(bytes) };
    if (kind === 'panorama' || kind === 'thumbnail') {
      try { info = await inspectMedia(bytes, { ...(kind === 'panorama' ? { kind: 'panorama' } : {}), decoderRunner: this.api.decoderRunner }); }
      catch { throw new ApiError('world_media_invalid', 422); }
    } else if (kind === 'collider.glb') assert(bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'glTF', 'world_media_invalid', 422);
    else assert(bytes.length >= 4 && (bytes[0] === 0x1f && bytes[1] === 0x8b || bytes.subarray(0, 4).toString() === 'NGSP'), 'world_media_invalid', 422);
    this.authorize(ctx, spaceId, resultId);
    const objectKey = `private/${spaceId}/world-results/${resultId}/${kind}/${info.sha256}`;
    await this.api.mediaStore.putIfAbsent(objectKey, bytes, { contentType: info.mime, maxBytes: limit });
    this.authorize(ctx, spaceId, resultId);
    return transaction(this.db, () => {
      const existing = this.core.one('SELECT asset_id FROM world_result_assets WHERE world_result_id=? AND kind=?', resultId, kind);
      if (existing) return this.core.one('SELECT * FROM assets WHERE id=?', existing.asset_id);
      const assetId = id('world_asset');
      this.db.prepare(`INSERT INTO assets(id,space_id,kind,private_object_key,raw_sha256,observed_bytes,observed_mime,width,height,validation_state,version)
        VALUES(?,?,?,?,?,?,?,?,?,'valid',1)`).run(assetId, spaceId, `world_${kind}`, objectKey, info.sha256, bytes.length, info.mime, info.width ?? null, info.height ?? null);
      this.db.prepare('INSERT INTO world_result_assets(world_result_id,kind,asset_id) VALUES(?,?,?)').run(resultId, kind, assetId);
      return this.core.one('SELECT * FROM assets WHERE id=?', assetId);
    });
  }
  async media(ctx, spaceId, resultId, kind) {
    assert(Object.hasOwn(fields, kind), 'world_media_unavailable', 404);
    this.authorize(ctx, spaceId, resultId);
    let asset = this.core.one(`SELECT a.* FROM world_result_assets m JOIN assets a ON a.id=m.asset_id
      WHERE m.world_result_id=? AND m.kind=? AND a.space_id=? AND a.validation_state='valid'`, resultId, kind, spaceId);
    if (!asset) {
      const key = `${resultId}:${kind}`;
      if (!this.pending.has(key)) {
        assert(this.pending.size < 2, 'world_media_busy', 429);
        const work = this.fetchAsset(ctx, spaceId, resultId, kind).finally(() => this.pending.delete(key));
        this.pending.set(key, work);
      }
      asset = await this.pending.get(key);
    }
    this.authorize(ctx, spaceId, resultId);
    return this.api.viewerMedia.serve(ctx, {}, asset, () => this.authorize(ctx, spaceId, resultId));
  }
}
