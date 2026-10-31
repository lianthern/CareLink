import { createHash } from 'node:crypto';
import { assert } from './errors.mjs';
import { id, sha256, stableJson } from './util.mjs';
import { transaction } from './database.mjs';
import { DisabledSceneWorkerBridgeAdapter } from './scene-worker-bridge-adapter.mjs';

export const CAPTURE_INPUT_MODES = Object.freeze(['perspective_video', 'equirectangular_video', 'equirectangular_images']);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export class SceneCaptureService {
  constructor(api, options = {}) {
    this.api = api; this.core = api.core; this.db = api.db;
    // Deliberately no environment switch: deployed entrypoints never enable this adapter.
    // A local harness must name its storage and all budgets; tests can explicitly use memory storage.
    const keys = ['chunkBytes', 'maxCaptureBytes', 'maxAccountBytes', 'storageBudgetBytes', 'maxFiles', 'maxVideoSeconds'];
    const origin = new URL(api.campaigns.publicOrigin);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
    this.enabled = options.mode === 'local-only' && local &&
      typeof options.storageNamespace === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(options.storageNamespace) &&
      keys.every(key => positive(options[key])) && options.chunkBytes <= 512 * 1024 &&
      options.maxCaptureBytes <= options.maxAccountBytes && options.maxAccountBytes <= options.storageBudgetBytes &&
      options.maxFiles >= 2 && options.maxFiles <= 256 && options.maxVideoSeconds <= 3600 &&
      (api.mediaStore.durable === true || options.allowEphemeralTestStorage === true);
    this.limits = this.enabled ? Object.fromEntries(keys.map(key => [key, options[key]])) : null;
    this.namespace = this.enabled ? options.storageNamespace : null;
    this.pending = new Map();
    this.bridge = new DisabledSceneWorkerBridgeAdapter();
  }
  capability() {
    return { schema: 'unseen-capture-capabilities/1', mode: this.enabled ? 'local-only' : 'disabled',
      uploadAvailable: this.enabled, processingAvailable: false, registrationAvailable: false,
      reason: 'scene_worker_contract_pending', supportedInputModes: CAPTURE_INPUT_MODES, limits: this.limits };
  }
  available() { assert(this.enabled, 'capture_upload_not_configured', 503); }
  owner(ctx, spaceId, write = false) {
    const account = this.core.account(ctx.accountSession);
    if (write) assert(ctx.headers['x-unseen-expected-account-id'] === account.accountId, 'account_changed', 409);
    return { account, ...this.core.accountSpace(account, spaceId, { ownerOnly: true }) };
  }
  ownCapture(ctx, captureId, write = false) {
    const account = this.core.account(ctx.accountSession);
    if (write) assert(ctx.headers['x-unseen-expected-account-id'] === account.accountId, 'account_changed', 409);
    const capture = this.core.one('SELECT * FROM scene_captures WHERE id=? AND account_id=?', captureId, account.accountId);
    assert(capture, 'capture_unavailable', 404);
    return { account, capture };
  }
  access(ctx, captureId, { write = false, current = false } = {}) {
    const { capture } = this.ownCapture(ctx, captureId, write);
    const state = this.owner(ctx, capture.space_id, write);
    const scene = this.core.one('SELECT * FROM scenes WHERE id=?', state.space.scene_id);
    const targetCurrent = state.space.version === capture.source_space_version && scene.version === capture.source_scene_version;
    if (current) {
      assert(capture.status !== 'cancelled', 'capture_cancelled', 409);
      assert(Date.parse(capture.expires_at) > this.core.nowMs(), 'capture_expired', 409);
      assert(targetCurrent, 'capture_target_stale', 409);
    }
    return { ...state, capture, scene, targetCurrent };
  }
  files(captureId) { return this.core.all('SELECT * FROM scene_capture_files WHERE capture_id=? ORDER BY ordinal', captureId); }
  chunks(fileId) { return this.core.all(`SELECT c.*,a.private_object_key FROM scene_capture_chunks c JOIN assets a ON a.id=c.asset_id
    WHERE c.file_id=? ORDER BY c.chunk_index`, fileId); }
  fileDto(file) {
    return { fileId: file.id, clientFileId: file.client_file_id, name: file.name, mimeType: file.mime_type,
      bytes: file.declared_bytes, sha256: file.raw_sha256, width: file.width, height: file.height,
      durationSeconds: file.duration_seconds, status: file.status, chunkCount: file.chunk_count,
      receivedChunks: this.chunks(file.id).filter(c => c.status === 'stored').map(c => ({ index: c.chunk_index, bytes: c.bytes, sha256: c.sha256 })) };
  }
  view(ctx, captureId) {
    return this.captureDto(this.access(ctx, captureId));
  }
  withdrawalView(ctx, captureId) {
    const { capture: current } = this.ownCapture(ctx, captureId);
    const space = this.core.one('SELECT * FROM spaces WHERE id=?', current.space_id);
    const scene = this.core.one('SELECT * FROM scenes WHERE id=?', current.scene_id);
    return this.captureDto({ capture: current, targetCurrent: space?.space_lifecycle === 'active' &&
      space.owner_account_id === current.account_id && space.version === current.source_space_version && scene?.version === current.source_scene_version });
  }
  captureDto({ capture: c, targetCurrent }) {
    return { schema: 'unseen-capture/1', captureId: c.id, accountId: c.account_id, spaceId: c.space_id,
      sceneRevisionId: c.scene_revision_id, jobId: c.job_id, inputMode: c.input_mode, title: c.title,
      status: c.status, spaceVersion: c.source_space_version, sceneVersion: c.source_scene_version,
      chunkBytes: c.chunk_bytes, expiresAt: c.expires_at, targetCurrent, processingAvailable: false,
      registrationAvailable: false, manifestSha256: c.manifest_sha256, files: this.files(c.id).map(f => this.fileDto(f)) };
  }
  list(ctx, spaceId) {
    const { account } = this.owner(ctx, spaceId);
    return { captures: this.core.all('SELECT id FROM scene_captures WHERE space_id=? AND account_id=? ORDER BY created_at DESC LIMIT 100', spaceId, account.accountId).map(c => this.view(ctx, c.id)) };
  }
  listMine(ctx) {
    const account = this.core.account(ctx.accountSession);
    // The same 100 unpurged-capture reservation limit bounds this recovery list without hiding a pending withdrawal.
    return { captures: this.core.all('SELECT id FROM scene_captures WHERE account_id=? AND purged_at IS NULL ORDER BY created_at DESC LIMIT 100',
      account.accountId).map(c => this.withdrawalView(ctx, c.id)) };
  }
  validateInput(body) {
    assert(plain(body) && CAPTURE_INPUT_MODES.includes(body.inputMode) && typeof body.title === 'string' &&
      body.title.trim().length > 0 && body.title.length <= 200 && positive(body.sceneIfMatchVersion), 'capture_input_invalid', 422);
    const images = body.inputMode === 'equirectangular_images';
    assert(Array.isArray(body.files) && body.files.length >= (images ? 2 : 1) && body.files.length <= this.limits.maxFiles &&
      (images || body.files.length === 1), 'capture_files_invalid', 422);
    const ids = new Set(); let total = 0;
    for (const file of body.files) {
      assert(plain(file) && typeof file.clientFileId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(file.clientFileId) &&
        !ids.has(file.clientFileId) && typeof file.name === 'string' && file.name.length > 0 && file.name.length <= 200 &&
        !/[\u0000-\u001f\u007f]/.test(file.name) && positive(file.bytes) && hash(file.sha256) &&
        positive(file.width) && positive(file.height) && file.width <= 32768 && file.height <= 32768, 'capture_file_invalid', 422);
      ids.add(file.clientFileId); total += file.bytes;
      assert(Number.isSafeInteger(total) && total <= this.limits.maxCaptureBytes, 'capture_too_large', 413);
      assert((images ? ['image/jpeg', 'image/png'] : ['video/mp4', 'video/quicktime', 'video/webm']).includes(file.mimeType), 'capture_mode_mismatch', 422);
      assert(body.inputMode === 'perspective_video' || file.width === 2 * file.height, 'capture_projection_invalid', 422);
      assert(images ? file.durationSeconds == null : typeof file.durationSeconds === 'number' &&
        Number.isFinite(file.durationSeconds) && file.durationSeconds > 0 && file.durationSeconds <= this.limits.maxVideoSeconds,
      'capture_duration_invalid', 422);
    }
    return total;
  }
  create(ctx, spaceId) {
    this.available();
    const { account } = this.owner(ctx, spaceId, true), total = this.validateInput(ctx.body);
    // CAS is inside first creation so an acknowledged-late retry can recover its original receipt.
    const result = this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/captures`, scope: account.accountId,
      reauthorize: () => this.owner(ctx, spaceId, true) }, () => {
      const { space } = this.owner(ctx, spaceId, true);
      this.core.requireIfMatch(ctx, space);
      const scene = this.core.one('SELECT * FROM scenes WHERE id=?', space.scene_id);
      assert(scene.version === ctx.body.sceneIfMatchVersion, 'scene_version_conflict', 409);
      const accountBytes = this.core.one('SELECT COALESCE(SUM(declared_bytes),0) bytes,COUNT(*) count FROM scene_captures WHERE account_id=? AND purged_at IS NULL', account.accountId);
      const globalBytes = this.core.one('SELECT COALESCE(SUM(declared_bytes),0) bytes FROM scene_captures WHERE purged_at IS NULL').bytes;
      assert(accountBytes.bytes + total <= this.limits.maxAccountBytes && globalBytes + total <= this.limits.storageBudgetBytes && accountBytes.count < 100,
        'capture_budget_exhausted', 429);
      const cid = id('capture'), now = this.core.now();
      this.db.prepare(`INSERT INTO scene_captures(id,account_id,space_id,scene_id,scene_revision_id,job_id,input_mode,title,
        source_space_version,source_scene_version,declared_bytes,chunk_bytes,status,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'uploading',?,?)`).run(cid, account.accountId, spaceId, scene.id, id('capture_revision'), id('capture_job'),
        ctx.body.inputMode, ctx.body.title.trim(), space.version, scene.version, total, this.limits.chunkBytes, now,
        new Date(this.core.nowMs() + 48 * 3600_000).toISOString());
      for (const [ordinal, f] of ctx.body.files.entries()) this.db.prepare(`INSERT INTO scene_capture_files(id,capture_id,ordinal,client_file_id,name,mime_type,
        declared_bytes,raw_sha256,width,height,duration_seconds,chunk_count,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'uploading')`)
        .run(id('capture_file'), cid, ordinal, f.clientFileId, f.name, f.mimeType, f.bytes, f.sha256, f.width, f.height, f.durationSeconds ?? null, Math.ceil(f.bytes / this.limits.chunkBytes));
      this.core.audit({ spaceId, aggregateType: 'scene', aggregateId: scene.id, eventType: 'capture_upload_created', actorKind: 'account',
        authorizationId: account.session.id, detail: { captureId: cid, bytes: total, processingAvailable: false }, requestId: ctx.requestId });
      return { captureId: cid };
    });
    return this.view(ctx, result.captureId);
  }
  file(captureId, fileId) {
    const file = this.core.one('SELECT * FROM scene_capture_files WHERE id=? AND capture_id=?', fileId, captureId);
    assert(file, 'capture_file_unavailable', 404); return file;
  }
  async putChunk(ctx, captureId, fileId, indexText) {
    this.available();
    const { capture } = this.access(ctx, captureId, { write: true, current: true }), file = this.file(captureId, fileId);
    assert(/^(0|[1-9][0-9]{0,8})$/.test(indexText), 'capture_chunk_invalid', 422);
    const index = Number(indexText), expectedBytes = Math.min(capture.chunk_bytes, file.declared_bytes - index * capture.chunk_bytes);
    assert(index < file.chunk_count && plain(ctx.body) && hash(ctx.body.sha256) && typeof ctx.body.dataBase64 === 'string' &&
      ctx.body.dataBase64.length === 4 * Math.ceil(expectedBytes / 3) && /^[A-Za-z0-9+/]*={0,2}$/.test(ctx.body.dataBase64), 'capture_chunk_invalid', 422);
    const bytes = Buffer.from(ctx.body.dataBase64, 'base64');
    assert(bytes.length === expectedBytes && bytes.toString('base64') === ctx.body.dataBase64 && sha256(bytes) === ctx.body.sha256, 'capture_chunk_hash_mismatch', 422);
    const reservation = transaction(this.db, () => {
      this.access(ctx, captureId, { write: true, current: true });
      const old = this.core.one('SELECT * FROM scene_capture_chunks WHERE file_id=? AND chunk_index=?', fileId, index);
      if (old) { assert(old.sha256 === ctx.body.sha256 && old.bytes === bytes.length, 'capture_chunk_conflict', 409); return old; }
      assert(this.file(captureId, fileId).status === 'uploading', 'capture_already_uploaded', 409);
      const assetId = id('capture_asset'), objectKey = `private/${capture.space_id}/captures/${this.namespace}/${captureId}/${fileId}/${index}-${ctx.body.sha256}`;
      this.db.prepare(`INSERT INTO assets(id,space_id,kind,private_object_key,raw_sha256,observed_bytes,observed_mime,validation_state)
        VALUES(?,?,'capture_chunk',?,?,?,'application/octet-stream','pending')`).run(assetId, capture.space_id, objectKey, ctx.body.sha256, bytes.length);
      this.db.prepare("INSERT INTO scene_capture_chunks(file_id,chunk_index,bytes,sha256,asset_id,status) VALUES(?,?,?,?,?,'reserved')").run(fileId, index, bytes.length, ctx.body.sha256, assetId);
      return this.core.one('SELECT * FROM scene_capture_chunks WHERE file_id=? AND chunk_index=?', fileId, index);
    });
    const asset = this.core.one('SELECT * FROM assets WHERE id=?', reservation.asset_id);
    const workKey = `${fileId}:${index}`;
    if (!this.pending.has(workKey)) {
      assert(this.pending.size < 4, 'capture_upload_busy', 429);
      const work = this.api.mediaStore.putIfAbsent(asset.private_object_key, bytes,
        { contentType: 'application/octet-stream', maxBytes: capture.chunk_bytes }).finally(() => this.pending.delete(workKey));
      this.pending.set(workKey, work);
    }
    const stored = await this.pending.get(workKey);
    try {
      this.access(ctx, captureId, { write: true, current: true });
      assert(stored.bytes === bytes.length && stored.etag === ctx.body.sha256, 'capture_storage_mismatch', 409);
      this.db.prepare("UPDATE scene_capture_chunks SET status='stored' WHERE file_id=? AND chunk_index=? AND status<>'purged'").run(fileId, index);
      this.db.prepare("UPDATE assets SET validation_state='valid',version=version+1 WHERE id=? AND validation_state<>'valid'").run(asset.id);
    } catch (error) {
      // A cancellation concurrent with I/O must not leave a late private object behind.
      if (this.core.one('SELECT status FROM scene_captures WHERE id=?', captureId)?.status === 'cancelled') await this.api.mediaStore.delete(asset.private_object_key);
      throw error;
    }
    return this.fileDto(this.file(captureId, fileId));
  }
  async commitFile(ctx, captureId, fileId) {
    this.available();
    this.access(ctx, captureId, { write: true, current: true });
    const file = this.file(captureId, fileId);
    if (file.status === 'uploaded') return this.fileDto(file);
    const chunks = this.chunks(fileId), digest = createHash('sha256'); let total = 0;
    assert(chunks.length === file.chunk_count && chunks.every((c, i) => c.chunk_index === i && c.status === 'stored'), 'capture_chunks_missing', 409);
    for (const chunk of chunks) {
      const object = await this.api.mediaStore.get(chunk.private_object_key, { maxBytes: chunk.bytes });
      this.access(ctx, captureId, { write: true, current: true });
      assert(object.body.length === chunk.bytes && sha256(object.body) === chunk.sha256, 'capture_storage_mismatch', 409);
      digest.update(object.body); total += object.body.length;
    }
    assert(total === file.declared_bytes && digest.digest('hex') === file.raw_sha256, 'capture_file_hash_mismatch', 422);
    this.db.prepare("UPDATE scene_capture_files SET status='uploaded' WHERE id=?").run(fileId);
    return this.fileDto(this.file(captureId, fileId));
  }
  manifest(capture) {
    return { schema: 'unseen-capture-manifest/1', adapterRevision: '89cd244', accountId: capture.account_id,
      spaceId: capture.space_id, sceneId: capture.scene_id, sceneRevisionId: capture.scene_revision_id, jobId: capture.job_id,
      sourceSpaceVersion: capture.source_space_version, sourceSceneVersion: capture.source_scene_version, inputMode: capture.input_mode,
      inputValidation: 'raw_bytes_sha256_verified_metadata_unverified', processingStatus: 'not_registered',
      files: this.files(capture.id).map(f => ({ fileId: f.id, clientFileId: f.client_file_id, name: f.name, mimeType: f.mime_type,
        bytes: f.declared_bytes, sha256: f.raw_sha256, width: f.width, height: f.height, durationSeconds: f.duration_seconds,
        chunks: this.chunks(f.id).map(c => ({ index: c.chunk_index, bytes: c.bytes, sha256: c.sha256 })) })) };
  }
  commit(ctx, captureId) {
    this.available();
    const { capture } = this.access(ctx, captureId, { write: true, current: true });
    if (capture.status === 'uploaded') return this.view(ctx, captureId);
    assert(this.files(captureId).every(f => f.status === 'uploaded'), 'capture_files_incomplete', 409);
    const serialized = stableJson(this.manifest(capture));
    this.db.prepare("UPDATE scene_captures SET status='uploaded',manifest_json=?,manifest_sha256=? WHERE id=?").run(serialized, sha256(serialized), captureId);
    return this.view(ctx, captureId);
  }
  readManifest(ctx, captureId) {
    const { capture } = this.access(ctx, captureId);
    assert(capture.status === 'uploaded' && capture.manifest_json && sha256(capture.manifest_json) === capture.manifest_sha256, 'capture_manifest_unavailable', 409);
    return { manifest: JSON.parse(capture.manifest_json), sha256: capture.manifest_sha256 };
  }
  async cancel(ctx, captureId) {
    // The original uploader retains withdrawal rights after space transfer/archive.
    // Continuing an upload and normal reads still require current space ownership.
    const { capture } = this.ownCapture(ctx, captureId, true);
    this.db.prepare("UPDATE scene_captures SET status='cancelled',cancelled_at=COALESCE(cancelled_at,?),manifest_json=NULL,manifest_sha256=NULL WHERE id=?").run(this.core.now(), captureId);
    // Await in-flight writes before release of reserved budget. Failed deletion is retryable and retains the reservation.
    const fileIds = new Set(this.files(captureId).map(f => f.id));
    await Promise.allSettled([...this.pending].filter(([key]) => fileIds.has(key.split(':')[0])).map(([, promise]) => promise));
    for (const file of this.files(captureId)) for (const chunk of this.chunks(file.id)) {
      await this.api.mediaStore.delete(chunk.private_object_key);
      this.db.prepare("UPDATE scene_capture_chunks SET status='purged' WHERE file_id=? AND chunk_index=?").run(file.id, chunk.chunk_index);
      this.db.prepare("UPDATE assets SET validation_state='deleted',version=version+1 WHERE id=? AND validation_state<>'deleted'").run(chunk.asset_id);
    }
    this.db.prepare('UPDATE scene_captures SET purged_at=COALESCE(purged_at,?) WHERE id=?').run(this.core.now(), capture.id);
    return this.withdrawalView(ctx, captureId);
  }
  register(ctx, captureId) {
    const { capture, scene, space } = this.access(ctx, captureId, { write: true, current: true });
    const { manifest, sha256: manifestSha256 } = this.readManifest(ctx, captureId);
    return this.bridge.registration(manifest, manifestSha256, { accountId: capture.account_id, spaceId: capture.space_id,
      jobId: capture.job_id, sceneRevisionId: capture.scene_revision_id, spaceVersion: space.version, sceneVersion: scene.version });
  }
}

export function registerSceneCaptureRoutes(api, add) {
  add('GET', '/v1/capture-capabilities', () => api.captures.capability());
  add('GET', '/v1/me/captures', c => api.captures.listMine(c));
  add('GET', '/v1/spaces/{sid}/captures', (c, p) => api.captures.list(c, p.sid));
  add('POST', '/v1/spaces/{sid}/captures', (c, p) => api.captures.create(c, p.sid));
  add('GET', '/v1/captures/{cid}', (c, p) => api.captures.view(c, p.cid));
  add('PUT', '/v1/captures/{cid}/files/{fid}/chunks/{index}', (c, p) => api.captures.putChunk(c, p.cid, p.fid, p.index));
  add('POST', '/v1/captures/{cid}/files/{fid}/commits', (c, p) => api.captures.commitFile(c, p.cid, p.fid));
  add('POST', '/v1/captures/{cid}/commits', (c, p) => api.captures.commit(c, p.cid));
  add('GET', '/v1/captures/{cid}/manifest', (c, p) => api.captures.readManifest(c, p.cid));
  add('POST', '/v1/captures/{cid}/cancellations', (c, p) => api.captures.cancel(c, p.cid));
  add('POST', '/v1/captures/{cid}/registrations', (c, p) => api.captures.register(c, p.cid));
}
