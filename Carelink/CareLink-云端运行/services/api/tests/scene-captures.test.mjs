import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture } from './fixture-factory.mjs';
import { LocalKeyring } from '../src/crypto.mjs';
import { FilesystemMediaStore } from '../src/ports/media/filesystem-media-store.mjs';
import { createLocalHttpServer, listenLocalHttpServer } from '../src/http-server.mjs';
import { dispatchOne } from '../../jobs/dispatch/index.mjs';
import { dispatchDeletion } from '../../jobs/dispatch/deletion-worker.mjs';
import { sha256, stableJson } from '../src/util.mjs';
import { DisabledSceneWorkerBridgeAdapter, captureBridgeEnvelope } from '../src/scene-worker-bridge-adapter.mjs';

const limits = { mode: 'local-only', storageNamespace: 'isolated-capture-tests', allowEphemeralTestStorage: true,
  chunkBytes: 64, maxCaptureBytes: 4096, maxAccountBytes: 8192, storageBudgetBytes: 16384, maxFiles: 4, maxVideoSeconds: 900 };
const expected = a => ({ ...a.headers, 'x-unseen-expected-account-id': a.accountId });
const payload = (bytes, mode = 'perspective_video') => ({ inputMode: mode, title: 'Synthetic private capture', sceneIfMatchVersion: 1,
  files: [{ clientFileId: 'selected-original', name: mode.endsWith('images') ? 'capture.png' : 'capture.mp4',
    mimeType: mode.endsWith('images') ? 'image/png' : 'video/mp4', bytes: bytes.length, sha256: sha256(bytes),
    width: 1600, height: 800, durationSeconds: mode.endsWith('images') ? null : 300 }] });
async function setup(extra = {}) {
  const f = fixture({ captures: { ...limits, ...extra } });
  const account = await f.login('capture-owner@example.test'), other = await f.login('capture-other@example.test'), space = await f.createSpace(account);
  return { f, account, other, space };
}
const make = (f, a, s, body) => f.ok('POST', `/v1/spaces/${s.spaceId}/captures`, body, { ...expected(a), 'if-match': String(s.version) });
const chunkPath = (c, file, index) => `/v1/captures/${c.captureId}/files/${file.fileId}/chunks/${index}`;
const chunkBody = bytes => ({ dataBase64: bytes.toString('base64'), sha256: sha256(bytes) });
async function uploadFile(f, account, capture, file, bytes) {
  for (let i = 0; i < file.chunkCount; i++) await f.ok('PUT', chunkPath(capture, file, i), chunkBody(bytes.subarray(i * capture.chunkBytes, (i + 1) * capture.chunkBytes)), expected(account));
  return f.ok('POST', `/v1/captures/${capture.captureId}/files/${file.fileId}/commits`, {}, expected(account));
}

test('capture capability defaults disabled; incomplete/nonlocal config cannot reserve input or queue work', async () => {
  for (const options of [{}, { captures: { mode: 'local-only' } }, { captures: { ...limits, maxFiles: 1 } },
    { captures: limits, publicOrigin: 'https://example.test' }, { captures: { ...limits, allowEphemeralTestStorage: false } }]) {
    const f = fixture(options);
    try {
      const account = await f.login(), space = await f.createSpace(account);
      const c = await f.ok('GET', '/v1/capture-capabilities');
      assert.equal(c.uploadAvailable, false); assert.equal(c.processingAvailable, false); assert.equal(c.registrationAvailable, false); assert.equal(c.limits, null);
      assert.deepEqual(c.supportedInputModes, ['perspective_video', 'equirectangular_video', 'equirectangular_images']);
      assert.equal((await f.call('POST', `/v1/spaces/${space.spaceId}/captures`, payload(randomBytes(150)), { ...expected(account), 'if-match': '1' })).status, 503);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scene_captures').get().n, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
    } finally { f.close(); }
  }
});

test('capture byte upload resumes after lost responses, stable chunks and full raw SHA bind manifest without queueing', async () => {
  const { f, account, space } = await setup();
  try {
    const bytes = randomBytes(150), body = payload(bytes), createHeaders = { ...expected(account), 'if-match': '1', 'idempotency-key': 'capture-create-lost-response' };
    const capture = await f.ok('POST', `/v1/spaces/${space.spaceId}/captures`, body, createHeaders), file = capture.files[0];
    assert.equal(capture.status, 'uploading'); assert.equal(capture.processingAvailable, false); assert.equal(file.chunkCount, 3);
    const first = bytes.subarray(0, 64);
    await f.ok('PUT', chunkPath(capture, file, 0), chunkBody(first), expected(account));
    const reloaded = await f.ok('GET', `/v1/captures/${capture.captureId}`, {}, account.headers);
    assert.deepEqual(reloaded.files[0].receivedChunks, [{ index: 0, bytes: 64, sha256: sha256(first) }]);
    await f.ok('PUT', chunkPath(capture, file, 0), chunkBody(first), expected(account));
    assert.equal(f.api.mediaStore.objects.size, 1);
    assert.equal((await f.call('PUT', chunkPath(capture, file, 0), chunkBody(randomBytes(64)), expected(account))).status, 409);
    assert.equal((await f.call('POST', `/v1/captures/${capture.captureId}/files/${file.fileId}/commits`, {}, expected(account))).status, 409);
    await uploadFile(f, account, capture, file, bytes);
    const complete = await f.ok('POST', `/v1/captures/${capture.captureId}/commits`, {}, expected(account));
    assert.equal(complete.status, 'uploaded'); assert.equal(complete.processingAvailable, false);
    const manifest = await f.ok('GET', `/v1/captures/${capture.captureId}/manifest`, {}, account.headers);
    assert.equal(sha256(stableJson(manifest.manifest)), manifest.sha256); assert.equal(manifest.manifest.files[0].sha256, sha256(bytes));
    assert.equal(manifest.manifest.accountId, account.accountId); assert.equal(manifest.manifest.spaceId, space.spaceId);
    assert.equal(manifest.manifest.sceneRevisionId, capture.sceneRevisionId); assert.equal(manifest.manifest.jobId, capture.jobId);
    assert.equal(manifest.manifest.processingStatus, 'not_registered'); assert.match(manifest.manifest.inputValidation, /metadata_unverified/);
    assert.equal((await f.call('POST', `/v1/captures/${capture.captureId}/registrations`, {}, expected(account))).status, 503);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
    await f.transition(account, space.spaceId, 'collection', 'open', 1);
    const replay = await f.ok('POST', `/v1/spaces/${space.spaceId}/captures`, body, createHeaders);
    assert.equal(replay.captureId, capture.captureId); assert.equal(replay.targetCurrent, false); assert.equal(replay.status, 'uploaded');
    assert.equal((await f.call('POST', `/v1/captures/${capture.captureId}/registrations`, {}, expected(account))).body.error.code, 'capture_target_stale');
  } finally { f.close(); }
});

test('capture modes remain distinct, dimensions and explicit capture budgets apply independently of album limits', async () => {
  const { f, account, space } = await setup();
  try {
    for (const mode of ['perspective_video', 'equirectangular_video', 'equirectangular_images']) {
      const bytes = randomBytes(90), body = payload(bytes, mode);
      if (mode === 'perspective_video') { body.files[0].width = 1920; body.files[0].height = 1080; }
      if (mode === 'equirectangular_images') body.files.push({ ...body.files[0], clientFileId: 'second-panorama', name: 'second.png' });
      const capture = await make(f, account, space, body);
      for (const file of capture.files) await uploadFile(f, account, capture, file, bytes);
      await f.ok('POST', `/v1/captures/${capture.captureId}/commits`, {}, expected(account));
      assert.equal((await f.ok('GET', `/v1/captures/${capture.captureId}/manifest`, {}, account.headers)).manifest.inputMode, mode);
    }
    const invalids = [payload(randomBytes(10), 'equirectangular_images'), payload(randomBytes(10), 'equirectangular_video'), payload(randomBytes(10))];
    invalids[0].files[0].mimeType = 'video/mp4'; invalids[1].files[0].width = 1920; invalids[2].files[0].durationSeconds = 901;
    for (const body of invalids) assert.equal((await f.call('POST', `/v1/spaces/${space.spaceId}/captures`, body, { ...expected(account), 'if-match': '1' })).status, 422);
    assert.equal((await f.call('POST', `/v1/spaces/${space.spaceId}/captures`, payload(randomBytes(4097)), { ...expected(account), 'if-match': '1' })).status, 413);
    const capability = await f.ok('GET', '/v1/capture-capabilities'); assert.equal(capability.limits.maxVideoSeconds, 900);
  } finally { f.close(); }
});

test('capture owner/account/target scope never follows invitation cookies and rechecks after async reads and writes', async () => {
  const { f, account, other, space } = await setup();
  try {
    const bytes = randomBytes(64), capture = await make(f, account, space, payload(bytes)), file = capture.files[0];
    for (const url of [`/v1/captures/${capture.captureId}`, `/v1/spaces/${space.spaceId}/captures`, `/v1/captures/${capture.captureId}/manifest`]) {
      assert.equal((await f.call('GET', url, {}, other.headers)).status, url.includes('/spaces/') ? 403 : 404);
      assert.equal((await f.call('GET', url + '?access=invitation', {}, { 'x-viewer-session': randomBytes(32).toString('base64url') })).status, 401);
    }
    assert.equal((await f.call('PUT', chunkPath(capture, file, 0), chunkBody(bytes), { ...expected(account), 'x-unseen-expected-account-id': other.accountId })).status, 409);
    assert.equal((await f.call('PUT', chunkPath(capture, file, 0), chunkBody(bytes), expected(other))).status, 404);
    const put = f.api.mediaStore.putIfAbsent.bind(f.api.mediaStore);
    f.api.mediaStore.putIfAbsent = async (...args) => {
      const value = await put(...args); f.db.prepare('UPDATE scenes SET version=version+1 WHERE space_id=?').run(space.spaceId); return value;
    };
    assert.equal((await f.call('PUT', chunkPath(capture, file, 0), chunkBody(bytes), expected(account))).body.error.code, 'capture_target_stale');
    assert.deepEqual((await f.ok('GET', `/v1/captures/${capture.captureId}`, {}, account.headers)).files[0].receivedChunks, []);
    assert.equal((await f.call('POST', `/v1/captures/${capture.captureId}/commits`, {}, expected(account))).status, 409);
    const cancelled = await f.ok('POST', `/v1/captures/${capture.captureId}/cancellations`, {}, expected(account));
    assert.equal(cancelled.status, 'cancelled'); assert.equal(f.api.mediaStore.objects.size, 0);
  } finally { f.close(); }
});

test('capture detects altered whole-file SHA; I/O failure retains resumable chunk; cancellation is idempotent and releases quota only after deletion', async () => {
  const { f, account, space } = await setup({ maxCaptureBytes: 150, maxAccountBytes: 150, storageBudgetBytes: 150 });
  try {
    const bytes = randomBytes(150), badHashBody = payload(bytes); badHashBody.files[0].sha256 = sha256(randomBytes(150));
    const capture = await make(f, account, space, badHashBody), file = capture.files[0];
    assert.equal((await f.call('POST', `/v1/spaces/${space.spaceId}/captures`, payload(bytes), { ...expected(account), 'if-match': '1' })).status, 429);
    const put = f.api.mediaStore.putIfAbsent.bind(f.api.mediaStore); let fail = true;
    f.api.mediaStore.putIfAbsent = async (...args) => { if (fail) { fail = false; throw new Error('isolated synthetic outage'); } return put(...args); };
    assert.equal((await f.call('PUT', chunkPath(capture, file, 0), chunkBody(bytes.subarray(0, 64)), expected(account))).status, 500);
    assert.deepEqual((await f.ok('GET', `/v1/captures/${capture.captureId}`, {}, account.headers)).files[0].receivedChunks, []);
    for (let i = 0; i < file.chunkCount; i++) await f.ok('PUT', chunkPath(capture, file, i), chunkBody(bytes.subarray(i * 64, (i + 1) * 64)), expected(account));
    assert.equal((await f.call('POST', `/v1/captures/${capture.captureId}/files/${file.fileId}/commits`, {}, expected(account))).body.error.code, 'capture_file_hash_mismatch');
    const remove = f.api.mediaStore.delete.bind(f.api.mediaStore); f.api.mediaStore.delete = async () => { throw new Error('synthetic deletion outage'); };
    assert.equal((await f.call('POST', `/v1/captures/${capture.captureId}/cancellations`, {}, expected(account))).status, 500);
    assert.equal(f.db.prepare('SELECT purged_at FROM scene_captures WHERE id=?').get(capture.captureId).purged_at, null);
    assert.equal((await f.call('POST', `/v1/spaces/${space.spaceId}/captures`, payload(bytes), { ...expected(account), 'if-match': '1' })).status, 429);
    f.api.mediaStore.delete = remove;
    for (let i = 0; i < 2; i++) assert.equal((await f.ok('POST', `/v1/captures/${capture.captureId}/cancellations`, {}, expected(account))).status, 'cancelled');
    assert.equal(f.api.mediaStore.objects.size, 0);
    assert.equal((await make(f, account, space, payload(bytes))).status, 'uploading');
  } finally { f.close(); }
});

test('capture rejects expiry; Bridge validator rejects foreign/stale results and never enables even fully matching JSON', async () => {
  const { f, account, space } = await setup();
  try {
    const bytes = randomBytes(64), capture = await make(f, account, space, payload(bytes)), file = capture.files[0];
    await uploadFile(f, account, capture, file, bytes);
    await f.ok('POST', `/v1/captures/${capture.captureId}/commits`, {}, expected(account));
    const { manifest, sha256: digest } = await f.ok('GET', `/v1/captures/${capture.captureId}/manifest`, {}, account.headers);
    const current = { accountId: account.accountId, spaceId: space.spaceId, jobId: capture.jobId, sceneRevisionId: capture.sceneRevisionId, spaceVersion: 1, sceneVersion: 1 };
    assert.equal(captureBridgeEnvelope(manifest, digest, current).status, 'contract_pending');
    const bridge = new DisabledSceneWorkerBridgeAdapter();
    assert.throws(() => bridge.acceptResult(manifest, digest, { ...current, sceneVersion: 2 }, {}), e => e.code === 'capture_target_stale');
    assert.throws(() => bridge.acceptResult(manifest, digest, current, { schemaVersion: '1.0', status: 'ready', sceneRevisionId: 'scene-123456abcdef-r001', inputSha256: file.sha256 }), e => e.code === 'scene_worker_result_binding_invalid');
    const matching = { ...current, manifestSha256: digest, inputFiles: manifest.files.map(f => ({ fileId: f.fileId, sha256: f.sha256 })) };
    assert.throws(() => bridge.acceptResult(manifest, digest, current, matching), e => e.code === 'scene_worker_contract_pending');
    f.clock.advance(49 * 3600_000);
    assert.equal((await f.call('POST', `/v1/captures/${capture.captureId}/registrations`, {}, expected(account))).body.error.code, 'capture_expired');
  } finally { f.close(); }
});

test('capture final hashing rechecks session revocation and cancellation waits for an in-flight original write', async () => {
  const { f, account, space } = await setup();
  try {
    const bytes = randomBytes(64), capture = await make(f, account, space, payload(bytes)), file = capture.files[0];
    await f.ok('PUT', chunkPath(capture, file, 0), chunkBody(bytes), expected(account));
    const get = f.api.mediaStore.get.bind(f.api.mediaStore);
    f.api.mediaStore.get = async (...args) => {
      const object = await get(...args);
      f.db.prepare('UPDATE account_sessions SET revoked_at=? WHERE account_id=?').run(f.clock.iso(), account.accountId);
      return object;
    };
    assert.equal((await f.call('POST', `/v1/captures/${capture.captureId}/files/${file.fileId}/commits`, {}, expected(account))).status, 401);
    assert.equal(f.db.prepare('SELECT status FROM scene_capture_files WHERE id=?').get(file.fileId).status, 'uploading');
    f.api.mediaStore.get = get;
    const renewed = await f.login('capture-owner@example.test');
    const second = await make(f, renewed, space, payload(bytes));
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const put = f.api.mediaStore.putIfAbsent.bind(f.api.mediaStore);
    f.api.mediaStore.putIfAbsent = async (...args) => { entered(); await gate; return put(...args); };
    const pendingPut = f.call('PUT', chunkPath(second, second.files[0], 0), chunkBody(bytes), expected(renewed));
    await started;
    const cancellation = f.call('POST', `/v1/captures/${second.captureId}/cancellations`, {}, expected(renewed));
    release();
    const [putResult, cancelResult] = await Promise.all([pendingPut, cancellation]);
    assert.equal(putResult.status, 409); assert.equal(cancelResult.status, 200);
    assert.equal(cancelResult.body.status, 'cancelled');
    assert.equal(f.api.mediaStore.objects.size, 1, 'only first independent capture remains');
    assert.ok(f.db.prepare('SELECT purged_at FROM scene_captures WHERE id=?').get(second.captureId).purged_at);
  } finally { f.close(); }
});

test('capture original chunks survive disk/API restart and 512 KiB JSON uploads use the real HTTP route with cookie CSRF checks', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'unseen-capture-restart-')), keyring = new LocalKeyring({ persistent: true });
  const captures = { ...limits, chunkBytes: 512 * 1024, maxCaptureBytes: 2 * 1024 ** 2, maxAccountBytes: 4 * 1024 ** 2,
    storageBudgetBytes: 8 * 1024 ** 2, allowEphemeralTestStorage: false };
  const open = () => fixture({ captures, database: path.join(directory, 'local.sqlite'), keyring,
    mediaStore: new FilesystemMediaStore(path.join(directory, 'media')) });
  let f = open(), server;
  try {
    const account = await f.login('capture-disk@example.test'), space = await f.createSpace(account), bytes = randomBytes(512 * 1024 + 23);
    const capture = await make(f, account, space, payload(bytes)), file = capture.files[0];
    await f.ok('PUT', chunkPath(capture, file, 0), chunkBody(bytes.subarray(0, capture.chunkBytes)), expected(account));
    f.close(); f = open();
    const resumed = await f.ok('GET', `/v1/captures/${capture.captureId}`, {}, account.headers);
    assert.equal(resumed.files[0].receivedChunks.length, 1); assert.equal(resumed.files[0].receivedChunks[0].sha256, sha256(bytes.subarray(0, capture.chunkBytes)));
    server = createLocalHttpServer({ api: f.api });
    const { origin } = await listenLocalHttpServer(server, { host: '127.0.0.1', port: 0 }); f.api.campaigns.publicOrigin = origin;
    const headers = { ...expected(account), 'content-type': 'application/json' };
    const fullChunk = await fetch(origin + chunkPath(capture, file, 0), { method: 'PUT', headers,
      body: JSON.stringify(chunkBody(bytes.subarray(0, capture.chunkBytes))) });
    assert.equal(fullChunk.status, 200); await fullChunk.arrayBuffer();
    const csrf = await fetch(origin + chunkPath(capture, file, 1), { method: 'PUT', headers: { ...headers,
      cookie: `__Host-unseen_account=${account.token}`, origin: 'https://foreign.example.test', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify(chunkBody(bytes.subarray(capture.chunkBytes))) });
    assert.equal(csrf.status, 403); await csrf.arrayBuffer();
    const finalChunk = await fetch(origin + chunkPath(capture, file, 1), { method: 'PUT', headers,
      body: JSON.stringify(chunkBody(bytes.subarray(capture.chunkBytes))) });
    assert.equal(finalChunk.status, 200); await finalChunk.arrayBuffer();
    await f.ok('POST', `/v1/captures/${capture.captureId}/files/${file.fileId}/commits`, {}, expected(account));
    const result = await f.ok('POST', `/v1/captures/${capture.captureId}/commits`, {}, expected(account));
    assert.equal(result.status, 'uploaded'); assert.equal(result.files[0].sha256, sha256(bytes));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    f.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('capture export is account-scoped and account deletion purges originals after the space has another owner', async () => {
  const { f, account, other, space } = await setup();
  try {
    const bytes = randomBytes(64), capture = await make(f, account, space, payload(bytes)), file = capture.files[0];
    await uploadFile(f, account, capture, file, bytes);
    await f.ok('POST', `/v1/captures/${capture.captureId}/commits`, {}, expected(account));
    for (const actor of [account, other]) {
      const request = await f.ok('POST', '/v1/exports', { scope: 'account', format: 'json' }, actor.headers);
      dispatchOne(f.db, request.jobId, { now: f.clock.iso(), keyring: f.api.keyring });
      const content = JSON.parse(Buffer.from(f.db.prepare('SELECT content FROM export_artifacts WHERE export_id=?').get(request.exportId).content));
      assert.equal(content.sceneCaptures.length, actor === account ? 1 : 0);
      if (actor === account) assert.equal(content.sceneCaptures[0].files[0].raw_sha256, sha256(bytes));
      assert.equal(JSON.stringify(content.sceneCaptures).includes('private_object_key'), false);
    }
    // Seed only the completed transfer state; exercise the real subsequent deletion request/worker.
    f.db.prepare('UPDATE spaces SET owner_account_id=?,version=version+1 WHERE id=?').run(other.accountId, space.spaceId);
    const nextDevice = await f.login('capture-owner@example.test');
    const personal = await f.ok('GET', '/v1/me/captures', {}, nextDevice.headers);
    assert.equal(personal.captures.length, 1); assert.equal(personal.captures.every(c => c.targetCurrent === false), true);
    assert.equal(JSON.stringify(personal).includes('private_object_key'), false);
    assert.deepEqual((await f.ok('GET', '/v1/me/captures', {}, other.headers)).captures, []);
    const grant = await f.reauth(account, 'ACCOUNT.DELETE_REQUEST', 'account_delete', 'account', account.accountId);
    const version = f.db.prepare('SELECT version FROM accounts WHERE id=?').get(account.accountId).version;
    const deletion = await f.ok('POST', '/v1/me/deletion-requests', { reauthGrant: grant.reauthGrantSecret, confirmation: true },
      { ...account.headers, 'if-match': String(version) });
    const job = f.db.prepare("SELECT id FROM jobs WHERE type='deletion_execution' AND json_extract(input_refs_json,'$.deletionId')=?").get(deletion.deletionId);
    assert.equal((await dispatchDeletion(f.db, f.api.mediaStore, job.id, { now: f.clock.iso() })).status, 'succeeded');
    assert.equal(f.api.mediaStore.objects.size, 0);
    assert.equal(f.db.prepare('SELECT name FROM scene_capture_files WHERE id=?').get(file.fileId).name, 'deleted');
    const after = f.db.prepare('SELECT * FROM scene_captures WHERE id=?').get(capture.captureId);
    assert.equal(after.status, 'cancelled'); assert.equal(after.manifest_json, null); assert.ok(after.purged_at);
    assert.equal(f.db.prepare('SELECT space_lifecycle FROM spaces WHERE id=?').get(space.spaceId).space_lifecycle, 'active');
  } finally { f.close(); }
});

test('capture author can withdraw originals after space transfer or archive without exposing them to the new owner', async () => {
  const { f, account, other, space } = await setup();
  try {
    const bytes = randomBytes(64), first = await make(f, account, space, payload(bytes)), second = await make(f, account, space, payload(bytes));
    await uploadFile(f, account, first, first.files[0], bytes); await uploadFile(f, account, second, second.files[0], bytes);
    f.db.prepare('UPDATE spaces SET owner_account_id=?,version=version+1 WHERE id=?').run(other.accountId, space.spaceId);
    assert.equal((await f.call('GET', `/v1/captures/${first.captureId}`, {}, account.headers)).status, 403);
    assert.equal((await f.call('POST', `/v1/captures/${first.captureId}/cancellations`, {}, expected(other))).status, 404);
    const cancelled = await f.ok('POST', `/v1/captures/${first.captureId}/cancellations`, {}, expected(account));
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.targetCurrent, false); assert.equal(f.api.mediaStore.objects.size, 1);
    f.db.prepare("UPDATE spaces SET space_lifecycle='archived',version=version+1 WHERE id=?").run(space.spaceId);
    const archivedReceipts = await f.ok('GET', '/v1/me/captures', {}, account.headers);
    assert.equal(archivedReceipts.captures.length, 1); assert.equal(archivedReceipts.captures[0].captureId, second.captureId);
    assert.equal(archivedReceipts.captures[0].targetCurrent, false);
    assert.equal((await f.ok('POST', `/v1/captures/${second.captureId}/cancellations`, {}, expected(account))).status, 'cancelled');
    assert.equal(f.api.mediaStore.objects.size, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scene_captures WHERE purged_at IS NULL').get().n, 0);
    assert.deepEqual((await f.ok('GET', '/v1/me/captures', {}, account.headers)).captures, []);
  } finally { f.close(); }
});
