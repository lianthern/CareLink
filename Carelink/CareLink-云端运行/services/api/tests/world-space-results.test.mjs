import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fixture, png, createAccountUpload } from './fixture-factory.mjs';
import { dispatchOne } from '../../jobs/dispatch/index.mjs';

const state = (f, sid) => f.db.prepare('SELECT s.*,c.version scene_version FROM spaces s JOIN scenes c ON c.id=s.scene_id WHERE s.id=?').get(sid);
const world = (wid = 'synthetic-world') => ({ id: wid, name: 'Synthetic AI completion', marbleUrl: `https://marble.worldlabs.ai/world/${wid}`,
  thumbnailUrl: `https://cdn.marble.worldlabs.ai/${wid}/thumbnail.png`, panoramaUrl: `https://cdn.marble.worldlabs.ai/${wid}/pano.png`,
  colliderUrl: null, splats: { preview: `https://cdn.marble.worldlabs.ai/${wid}/preview.spz`, standard: null, full: null },
  semantics: { metricScaleFactor: 1, groundPlaneOffset: 0 } });
function proof(f, signingKey, account, sid, requestId = 'synthetic-job', value = world(), overrides = {}) {
  const s = state(f, sid);
  const payload = { version: 1, accountId: account.accountId, spaceId: sid, requestId, world: value,
    spaceVersion: s.version, sceneVersion: s.scene_version, issuedAt: f.clock.iso(), ...overrides };
  return { payload, signature: createHmac('sha256', signingKey).update(JSON.stringify(payload)).digest('base64url') };
}
const headers = (account, p) => ({ ...account.headers, 'x-unseen-expected-account-id': account.accountId,
  'if-match': String(p.payload.spaceVersion), 'idempotency-key': `world-import-${p.payload.requestId}` });
const importResult = (f, account, sid, p) => f.call('POST', `/v1/spaces/${sid}/world-results`, { sceneIfMatchVersion: p.payload.sceneVersion, worldProof: p }, headers(account, p));
async function setup(options = {}) {
  const signingKey = randomBytes(32).toString('hex');
  let fetched = 0;
  const f = fixture({ worldResults: { signingKey, fetchImpl: async url => {
    fetched++;
    return new Response(url.endsWith('.png') ? png(1600, 800) : gzipSync(Buffer.from('NGSP synthetic media access test')));
  }, ...options } });
  const account = await f.login('world-owner@example.test'), other = await f.login('world-other@example.test');
  const space = await f.createSpace(account);
  return { f, signingKey, account, other, space, fetched: () => fetched };
}
async function openGuest(f, account, space) {
  await f.openSpace(account, { spaceId: space.spaceId, version: state(f, space.spaceId).version });
  const campaign = await f.ok('POST', `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, { taskMode: 'view', expiresAt: '2026-08-14T00:00:00.000Z', maxSuccessfulUses: 10 }, { ...account.headers, 'if-match': String(state(f, space.spaceId).version) });
  const origin = { origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787', 'sec-fetch-site': 'same-origin' };
  const b = { publicCampaignId: new URL(campaign.publicCampaignUrl).pathname.split('/').at(-1), clientNonce: 'world-browser-nonce-123456789' };
  const challenge = await f.ok('POST', '/v1/external-campaign-admission-challenges', b, origin);
  const admitted = await f.ok('POST', '/v1/external-campaign-admissions', b, { ...origin, 'x-campaign-challenge': challenge.challengeCookieSecret });
  const grant = await f.ok('POST', '/v1/external-invitation-exchanges', { secretFromClearedInviteBootstrap: admitted.oneTimeSecret });
  return { campaign, headers: { 'x-viewer-session': grant.viewerSessionSecret } };
}

test('World proof validates signer/account/space/versions/age/source before any write or network', async () => {
  const { f, signingKey, account, other, space, fetched } = await setup();
  try {
    const sid = space.spaceId, target2 = await f.createSpace(other);
    const p = proof(f, signingKey, account, sid);
    assert.equal((await importResult(f, account, sid, { ...p, signature: randomBytes(32).toString('base64url') })).status, 422);
    assert.equal((await importResult(f, other, target2.spaceId, p)).status, 422);
    assert.equal((await importResult(f, account, sid, proof(f, signingKey, account, sid, 'wrong-account', world(), { accountId: other.accountId }))).status, 422);
    for (const [requestId, overrides] of [['expired', { issuedAt: '2026-08-12T23:00:00.000Z' }], ['future', { issuedAt: '2026-08-14T00:00:00.000Z' }], ['wrong-version', { spaceVersion: 17 }], ['wrong-scene', { sceneVersion: 17 }]]) {
      assert.equal((await importResult(f, account, sid, proof(f, signingKey, account, sid, requestId, world(), overrides))).status, 409);
    }
    for (const [i, url] of ['https://127.0.0.1/internal', 'https://cdn.marble.worldlabs.ai.evil.test/synthetic-world/x', 'https://user:pass@cdn.marble.worldlabs.ai/synthetic-world/x', 'https://cdn.marble.worldlabs.ai/other-world/x', 'https://cdn.marble.worldlabs.ai/synthetic-world/x?token=example'].entries()) {
      const w = world(); w.splats.preview = url;
      assert.equal((await importResult(f, account, sid, proof(f, signingKey, account, sid, `bad-url-${i}`, w))).status, 422);
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scene_world_results').get().n, 0);
    assert.equal(state(f, sid).version, space.version); assert.equal(fetched(), 0);
    f.api.worldResults.key = null;
    assert.equal((await importResult(f, account, sid, p)).status, 503);
  } finally { f.close(); }
});

test('World import persists one account-bound result; refreshed proof and old versions reconcile without repeating activation', async () => {
  const { f, signingKey, account, space } = await setup();
  try {
    const sid = space.spaceId, p = proof(f, signingKey, account, sid);
    const first = await importResult(f, account, sid, p);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.active, true); assert.equal(first.body.spaceVersion, 2); assert.equal(first.body.sceneVersion, 2);
    f.clock.advance(11 * 60_000);
    const refreshed = proof(f, signingKey, account, sid, p.payload.requestId, world(), { spaceVersion: 1, sceneVersion: 1 });
    const retry = await importResult(f, account, sid, refreshed);
    assert.equal(retry.status, 200); assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.worldResultId, first.body.worldResultId); assert.equal(state(f, sid).version, 2);
    const secondSession = await f.login('world-owner@example.test');
    const visible = await f.ok('GET', `/v1/viewer/spaces/${sid}`, {}, secondSession.headers);
    assert.equal(visible.sceneContext.world.aiGenerated, true);
    assert.equal(visible.sceneContext.scene.worldResultId, first.body.worldResultId);
    const otherSpace = await f.createSpace(account);
    const reused = proof(f, signingKey, account, otherSpace.spaceId, p.payload.requestId);
    assert.equal((await importResult(f, account, otherSpace.spaceId, reused)).status, 409);
    const changedWorld = world('new-provider-result');
    assert.equal((await importResult(f, account, sid, proof(f, signingKey, account, sid, p.payload.requestId, changedWorld))).status, 409);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scene_world_results').get().n, 1);
  } finally { f.close(); }
});

test('failed old version creates no idempotency tombstone; an explicit newly reviewed version of the same job succeeds', async () => {
  const { f, signingKey, account, space } = await setup();
  try {
    const sid = space.spaceId, stale = proof(f, signingKey, account, sid);
    await f.transition(account, sid, 'collection', 'open', space.version);
    assert.equal((await importResult(f, account, sid, stale)).status, 409);
    const reviewed = proof(f, signingKey, account, sid);
    assert.equal((await importResult(f, account, sid, reviewed)).status, 200);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scene_world_results').get().n, 1);
  } finally { f.close(); }
});

test('World replaces pano/DAP without losing content/invites or applying old photo positions; panorama can replace World again', async () => {
  const { f, signingKey, account, space } = await setup();
  try {
    const sid = space.spaceId;
    const input = { consent: true, title: 'Scene', spaceId: sid, sceneIfMatchVersion: 1,
      panorama: { name: 'scene.png', mimeType: 'image/png', dataBase64: png(1600, 800).toString('base64') } };
    await f.ok('PUT', '/v1/app-spaces/world-prior', input, { ...account.headers, 'x-unseen-expected-account-id': account.accountId, 'if-match': '1' });
    const before = state(f, sid), guest = await openGuest(f, account, space);
    const flow = await createAccountUpload(f, account, { spaceId: sid, version: state(f, sid).version });
    dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    const pid = flow.committed.photoId, edit = await f.ok('GET', `/v1/photos/${pid}/placement-edit`, {}, account.headers);
    await f.ok('POST', `/v1/photos/${pid}/placement-revisions`, { mode: 'manual', confirmationMode: 'manual', yawDeg: 25, panoramaRevisionId: edit.currentPanoramaRevisionId }, {
      ...account.headers, 'if-match': String(edit.photoVersion), 'x-item-version': String(edit.itemVersion), 'x-placement-authorization-version': String(edit.placementAuthorizationVersion) });
    const result = await importResult(f, account, sid, proof(f, signingKey, account, sid));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const view = await f.ok('GET', `/v1/viewer/spaces/${sid}?access=invitation`, {}, guest.headers);
    assert.equal(view.photos.length, 1); assert.equal(view.photos[0].placementState, 'stale');
    assert.equal(view.sceneContext.world.id, result.body.worldResultId); assert.equal(view.sceneContext.depthImport, null);
    assert.equal((await f.call('GET', `/v1/viewer/spaces/${sid}/panorama-revisions/${before.current_panorama_revision_id}/media?access=invitation`, {}, guest.headers)).status, 404);
    const context = await f.ok('GET', `/v1/viewer/spaces/${sid}/photos/${pid}`, {}, account.headers);
    assert.equal(context.canReturnToScene, false);
    assert.equal((await f.call('GET', context.photoMedia.url, {}, account.headers)).status, 200);
    const afterWorld = state(f, sid);
    await f.ok('PUT', '/v1/app-spaces/after-world', { ...input, sceneIfMatchVersion: afterWorld.scene_version }, {
      ...account.headers, 'x-unseen-expected-account-id': account.accountId, 'if-match': String(afterWorld.version) });
    const panoAgain = await f.ok('GET', `/v1/viewer/spaces/${sid}?access=invitation`, {}, guest.headers);
    assert.equal(panoAgain.sceneContext.world, undefined); assert.ok(panoAgain.sceneContext.panorama.url);
    assert.equal((await f.call('GET', view.sceneContext.world.splats.preview + '?access=invitation', {}, guest.headers)).status, 404);
    const oldReplay = await importResult(f, account, sid, proof(f, signingKey, account, sid));
    assert.equal(oldReplay.status, 200); assert.equal(oldReplay.body.active, false, 'old task receipt never silently reactivates retired World');
  } finally { f.close(); }
});

test('World assets use same-origin auth, private repeatable cache, range, and live revocation, never public provider URLs', async () => {
  const { f, signingKey, account, other, space, fetched } = await setup();
  try {
    const sid = space.spaceId;
    assert.equal((await importResult(f, account, sid, proof(f, signingKey, account, sid))).status, 200);
    const guest = await openGuest(f, account, space);
    const view = await f.ok('GET', `/v1/viewer/spaces/${sid}?access=invitation`, {}, guest.headers);
    assert.equal(JSON.stringify(view.sceneContext).includes('worldlabs.ai'), false);
    assert.equal(view.sceneContext.world.marbleUrl, null);
    assert.equal(view.sceneContext.world.providerExposure, 'provider_may_be_public');
    const url = view.sceneContext.world.splats.preview;
    assert.equal((await f.call('GET', url, {}, other.headers)).status, 404);
    assert.equal(fetched(), 0);
    const first = await f.call('GET', url + '?access=invitation', {}, guest.headers);
    assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(fetched(), 1);
    const second = await f.call('GET', url, {}, account.headers);
    assert.equal(second.status, 200); assert.deepEqual(first.body, second.body); assert.equal(fetched(), 1);
    const range = await f.call('GET', url, {}, { ...account.headers, range: 'bytes=0-3' });
    assert.equal(range.status, 206); assert.equal(range.body.length, 4);
    for (const kind of ['panoramaUrl', 'thumbnailUrl']) {
      const media = await f.call('GET', view.sceneContext.world[kind], {}, account.headers);
      assert.equal(media.status, 200, JSON.stringify(media.body)); assert.equal(media.headers['content-type'], 'image/png');
    }
    assert.equal(fetched(), 3, 'both image derivatives are decoded and cached independently');
    const get = f.api.mediaStore.get.bind(f.api.mediaStore);
    f.api.mediaStore.get = async (...args) => {
      const value = await get(...args);
      f.db.prepare("UPDATE external_invitation_campaigns SET campaign_status='revoked',revoked_at=? WHERE id=?").run(f.clock.iso(), guest.campaign.campaignId);
      return value;
    };
    assert.equal((await f.call('GET', url + '?access=invitation', {}, guest.headers)).status, 401);
    f.api.mediaStore.get = get;
    assert.equal((await f.call('GET', url, {}, account.headers)).status, 200);
  } finally { f.close(); }
});

test('World proxy refuses redirects, oversized and malformed media without caching; source failure does not undo a completed task', async () => {
  const { f, signingKey, account, space } = await setup();
  try {
    const sid = space.spaceId;
    await importResult(f, account, sid, proof(f, signingKey, account, sid));
    const view = await f.ok('GET', `/v1/viewer/spaces/${sid}`, {}, account.headers), url = view.sceneContext.world.splats.preview;
    const responses = [new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
      new Response('oversized', { headers: { 'content-length': String(49 * 1024 ** 2) } }), new Response('<html>bad media</html>')];
    for (const [i, response] of responses.entries()) {
      let calls = 0; f.api.worldResults.fetch = async () => { calls++; return response; };
      assert.equal((await f.call('GET', url, {}, account.headers)).status, [502, 413, 422][i]); assert.equal(calls, 1);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM world_result_assets').get().n, 0);
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scene_world_results').get().n, 1);
  } finally { f.close(); }
});
