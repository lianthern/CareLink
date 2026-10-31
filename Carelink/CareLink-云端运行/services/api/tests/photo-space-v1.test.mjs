import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, png, createAccountUpload, exchangeReceipt } from './fixture-factory.mjs';
import { dispatchOne } from '../../jobs/dispatch/index.mjs';
import { parseDepthImport } from '../../../packages/viewer/src/import.js';
import { sha256 } from '../src/util.mjs';

const origin = { origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787', 'sec-fetch-site': 'same-origin' };
const file = (name, bytes) => ({ name, mimeType: 'image/png', dataBase64: bytes.toString('base64') });
function input(encoding = 'legacy', color = '#335577') {
  const panorama = png(1600, 800, color), depth = png(32, 16);
  const result = { consent: true, title: 'Synthetic room', panorama: file('room.png', panorama) };
  if (encoding === 'none') return result;
  result.depth = file('depth.png', depth);
  result.metadata = encoding === 'legacy' ? { model: 'DAP', convention: 'near_small', min: .01, max: .19,
    width: 32, height: 16, source_image: 'room.png', source_resolution: [1600, 800] } : {
    schemaVersion: 'unseen-depth-artifact-precursor/1', encoding: 'linear-red-v1', width: 32, height: 16,
    nearMeters: .5, farMeters: 20, pngSha256: sha256(depth), sourcePanoramaSha256: sha256(panorama),
    quality: { validFraction: .99 }, safetyEnvelope: { schemaVersion: 'unseen-polar-safety-envelope/1',
      absoluteMaxRadiusMeters: .4, directions: Array.from({ length: 8 }, (_, i) => ({ yawDeg: i * 45, allowedRadiusMeters: .3 })) }
  };
  return result;
}
const expected = a => ({ ...a.headers, 'x-unseen-expected-account-id': a.accountId });
const state = (f, sid) => f.db.prepare('SELECT s.*,c.version scene_version FROM spaces s JOIN scenes c ON c.id=s.scene_id WHERE s.id=?').get(sid);
async function install(f, a, cid, body, sid = null) {
  const s = sid ? state(f, sid) : null;
  return f.ok('PUT', `/v1/app-spaces/${cid}`, { ...body, ...(s ? { spaceId: sid, sceneIfMatchVersion: s.scene_version } : {}) },
    { ...expected(a), ...(s ? { 'if-match': String(s.version) } : {}) });
}
async function invite(f, owner, sid, mode, visitor) {
  const s = state(f, sid);
  const campaign = await f.ok('POST', `/v1/spaces/${sid}/external-invitation-campaigns`, {
    taskMode: mode, expiresAt: '2026-08-14T00:00:00.000Z', maxSuccessfulUses: 10 }, { ...owner.headers, 'if-match': String(s.version) });
  const body = { publicCampaignId: new URL(campaign.publicCampaignUrl).pathname.split('/').at(-1), clientNonce: `${visitor}-nonce-1234567890` };
  const challenge = await f.ok('POST', '/v1/external-campaign-admission-challenges', body, origin);
  const admitted = await f.ok('POST', '/v1/external-campaign-admissions', body, { ...origin, 'x-campaign-challenge': challenge.challengeCookieSecret });
  const grant = await f.ok('POST', '/v1/external-invitation-exchanges', { secretFromClearedInviteBootstrap: admitted.oneTimeSecret });
  return { campaign, grant, headers: { ...(grant.viewerSessionSecret ? { 'x-viewer-session': grant.viewerSessionSecret } : {}),
    ...(grant.contributorSessionSecret ? { 'x-contributor-session': grant.contributorSessionSecret } : {}) } };
}
async function confirm(f, owner, sid, pid) {
  const edit = await f.ok('GET', `/v1/photos/${pid}/placement-edit?access=account`, {}, owner.headers);
  return f.ok('POST', `/v1/photos/${pid}/placement-revisions?access=account`, {
    mode: 'manual', confirmationMode: 'manual', panoramaRevisionId: edit.currentPanoramaRevisionId, yawDeg: 40, pitchDeg: 5
  }, { ...owner.headers, 'if-match': String(edit.photoVersion), 'x-item-version': String(edit.itemVersion),
    'x-placement-authorization-version': String(edit.placementAuthorizationVersion) });
}
function assertDepthEquivalent(privateSpace, shared) {
  const a = parseDepthImport(privateSpace.depth.metadata, { panorama: privateSpace.panorama,
    depth: shared.depthImport, panoramaName: shared.depthImport.panoramaName,
    panoramaSha256: privateSpace.panorama.sha256, depthSha256: shared.depthImport.sha256 });
  const b = parseDepthImport(shared.depthImport.metadata, { panorama: shared.panorama,
    depth: shared.depthImport, panoramaName: shared.depthImport.panoramaName,
    panoramaSha256: shared.panorama.sha256, depthSha256: shared.depthImport.sha256 });
  assert.deepEqual(b, a);
  assert.equal(shared.depthImport.metadata.sourcePanoramaRevisionId, shared.scene.panoramaRevisionId);
}

test('raw spaces expose current notice and scene; legacy + linear DAP are equivalent for owner and independent invited browser', async () => {
  const f = fixture();
  try {
    const owner = await f.login('v1-owner@example.test'), outsider = await f.login('v1-other@example.test');
    const notice = await f.ok('GET', '/v1/notices/current?purpose=space_create');
    assert.ok(notice.contentHash);
    const named = await f.ok('POST', '/v1/spaces', { name: 'First room' }, { ...owner.headers, 'notice-acknowledgement': JSON.stringify(notice) });
    assert.equal((await f.ok('GET', `/v1/viewer/spaces/${named.spaceId}`, {}, owner.headers)).sceneContext, null);
    for (const encoding of ['legacy', 'linear']) {
      const imported = await install(f, owner, `scene-${encoding}`, input(encoding), encoding === 'legacy' ? named.spaceId : null);
      const sid = imported.space.spaceId;
      assert.equal((await f.ok('GET', `/v1/spaces/${sid}/management`, {}, owner.headers)).sceneVersion, imported.space.sceneVersion);
      await f.openSpace(owner, { spaceId: sid, version: state(f, sid).version });
      const view = await invite(f, owner, sid, 'view', encoding);
      const mixed = { ...outsider.headers, ...view.headers };
      const shared = await f.ok('GET', `/v1/viewer/spaces/${sid}?access=invitation`, {}, mixed);
      assert.equal(shared.photos.length, 0);
      assertDepthEquivalent(imported.space, shared.sceneContext);
      assert.equal(shared.sceneContext.depthArtifact?.depthMap.encoding || null, encoding === 'linear' ? 'linear-red-v1' : null);
      assert.equal((await f.call('GET', `${shared.sceneContext.depthImport.url}?access=invitation`, {}, mixed)).status, 200);
      assert.equal((await f.call('GET', shared.sceneContext.depthImport.url, {}, outsider.headers)).status, 404);
      assert.equal((await f.call('GET', `/v1/spaces/${sid}/upload-context?access=invitation`, {}, mixed)).status, 401);
      assert.equal((await f.ok('GET', '/v1/me/spaces', {}, outsider.headers)).spaces.length, 0, 'link session never becomes a lasting membership');
    }
    assert.equal((await f.ok('GET', '/v1/me/spaces', {}, owner.headers)).spaces.length, 2);
  } finally { f.close(); }
});

test('upgrading an existing space keeps invitations/photos, invalidates old coordinates and depth, preserves old aliases and checks both versions', async () => {
  const f = fixture();
  try {
    const owner = await f.login('upgrade@example.test'), stranger = await f.login('upgrade-other@example.test');
    const imported = await install(f, owner, 'original', input('legacy'));
    const sid = imported.space.spaceId;
    await f.openSpace(owner, { spaceId: sid, version: state(f, sid).version });
    const guest = await invite(f, owner, sid, 'combo', 'upgrade');
    const flow = await createAccountUpload(f, owner, { spaceId: sid, version: state(f, sid).version });
    dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    const pid = flow.committed.photoId;
    await confirm(f, owner, sid, pid);
    const photo = f.db.prepare('SELECT * FROM photos WHERE id=?').get(pid);
    if (photo.photo_content_state === 'pending') await f.ok('POST', `/v1/photos/${pid}/content-transitions`, { to: 'visible', transitionReasonCode: 'manual_approved', decisionReasonCode: null }, { ...owner.headers, 'if-match': String(photo.version) });
    const previous = state(f, sid), before = await f.ok('GET', `/v1/photos/${pid}/placement-edit`, {}, owner.headers);
    const bad = { ...input('none'), spaceId: sid, sceneIfMatchVersion: previous.scene_version };
    assert.equal((await f.call('PUT', '/v1/app-spaces/forbidden', bad, { ...expected(stranger), 'if-match': String(previous.version) })).status, 403);
    assert.equal((await f.call('PUT', '/v1/app-spaces/stale-space', bad, { ...expected(owner), 'if-match': String(previous.version - 1) })).status, 409);
    assert.equal((await f.call('PUT', '/v1/app-spaces/stale-scene', { ...bad, sceneIfMatchVersion: previous.scene_version - 1 }, { ...expected(owner), 'if-match': String(previous.version) })).status, 409);
    const changed = await install(f, owner, 'replacement', input('none', '#773311'), sid);
    assert.equal(changed.space.spaceId, sid);
    assert.equal((await f.ok('GET', '/v1/app-spaces/original', {}, owner.headers)).space.panoramaRevisionId, changed.space.panoramaRevisionId);
    assert.equal((await f.ok('GET', '/v1/app-spaces', {}, owner.headers)).spaces.length, 1);
    const after = await f.ok('GET', `/v1/viewer/spaces/${sid}?access=invitation`, {}, guest.headers);
    assert.equal(after.photos.length, 1); assert.equal(after.photos[0].placementState, 'stale');
    assert.equal(after.sceneContext.depthImport, null); assert.equal(after.sceneContext.placements.length, 0);
    const detail = await f.ok('GET', `/v1/viewer/spaces/${sid}/photos/${pid}?access=invitation`, {}, guest.headers);
    assert.equal(detail.canReturnToScene, false);
    assert.equal((await f.call('GET', `${detail.photoMedia.url}?access=invitation`, {}, guest.headers)).status, 200, 'stale photo remains in album');
    assert.equal((await f.call('GET', `/v1/viewer/spaces/${sid}/photos/${pid}/scene-context?access=invitation`, {}, guest.headers)).status, 404);
    assert.equal((await f.call('GET', `/v1/viewer/spaces/${sid}/panorama-revisions/${previous.current_panorama_revision_id}/depth-map?access=invitation`, {}, guest.headers)).status, 404);
    const current = await f.ok('GET', `/v1/photos/${pid}/placement-edit`, {}, owner.headers);
    const staleWrite = await f.call('POST', `/v1/photos/${pid}/placement-revisions`, { mode: 'manual', confirmationMode: 'manual', yawDeg: 40,
      panoramaRevisionId: before.currentPanoramaRevisionId }, { ...owner.headers, 'if-match': String(current.photoVersion),
      'x-item-version': String(current.itemVersion), 'x-placement-authorization-version': String(current.placementAuthorizationVersion) });
    assert.equal(staleWrite.status, 409); assert.equal(staleWrite.body.error.code, 'stale_revision');
    assert.equal((await f.ok('GET', `/v1/spaces/${sid}/management`, {}, owner.headers)).campaigns[0].campaignId, guest.campaign.campaignId);
    await confirm(f, owner, sid, pid);
    const read = await f.ok('GET', `/v1/viewer/spaces/${sid}/photos/${pid}/scene-context`, {}, owner.headers);
    assert.equal(read.scene.panoramaRevisionId, changed.space.panoramaRevisionId);
  } finally { f.close(); }
});

test('invitation upload has explicit principal, independent contributors, current versions, real receipts, pause and revocation', async () => {
  const f = fixture();
  try {
    const owner = await f.login('contributors@example.test'), other = await f.login('contributors-other@example.test');
    const named = await f.createSpace(owner);
    const sid = named.spaceId;
    await f.openSpace(owner, named);
    const first = await invite(f, owner, sid, 'upload', 'first'), second = await invite(f, owner, sid, 'combo', 'second');
    const flows = [];
    for (const [i, visitor] of [first, second].entries()) {
      const headers = { ...other.headers, ...visitor.headers };
      const path = p => `${p}?access=invitation`;
      const context = await f.ok('GET', path(`/v1/spaces/${sid}/upload-context`), {}, headers);
      assert.equal(context.spaceVersion, state(f, sid).version);
      const facade = { ...f, ok: (method, url, body, passed = {}) => f.ok(method, path(url), body, { ...passed, ...headers }) };
      const flow = await createAccountUpload(facade, { headers }, { spaceId: sid, version: context.spaceVersion }, png(32, 16, i ? '#ff0000' : '#00ff00'));
      flows.push(flow);
      assert.equal(f.db.prepare('SELECT actor_id FROM contribution_batches WHERE id=?').get(flow.batch.batchId).actor_id, visitor.grant.contributorPrincipalId);
      const receipt = await exchangeReceipt(f, flow.finalized, `receipt-${i}-12345678`);
      assert.equal(receipt.status, 200);
      flow.receipt = receipt.body;
    }
    assert.notEqual(flows[0].committed.photoId, flows[1].committed.photoId);
    assert.equal((await f.call('GET', `/v1/viewer/spaces/${sid}?access=invitation`, {}, { ...owner.headers, ...first.headers })).status, 401, 'upload-only cannot borrow an account view');
    assert.equal((await f.call('GET', `/v1/contribution-batches/${flows[0].batch.batchId}/result?access=invitation`, {}, second.headers)).status, 404);
    const mixedOwner = { ...owner.headers, 'x-receipt-session': flows[0].receipt.receiptSessionSecret };
    assert.equal((await f.call('GET', `/v1/photos/${flows[1].committed.photoId}/placement-edit?access=account`, {}, mixedOwner)).status, 200);
    await f.transition(owner, sid, 'collection', 'paused', state(f, sid).version);
    assert.equal((await f.call('GET', `/v1/spaces/${sid}/upload-context?access=invitation`, {}, second.headers)).status, 401);
    assert.equal((await f.ok('GET', `/v1/viewer/spaces/${sid}?access=invitation`, {}, second.headers)).effectiveCanUpload, false);
    const campaign = f.db.prepare('SELECT version FROM external_invitation_campaigns WHERE id=?').get(second.campaign.campaignId);
    await f.ok('POST', `/v1/external-invitation-campaigns/${second.campaign.campaignId}/revocations`, { reasonClass: 'owner_requested' }, { ...owner.headers, 'if-match': String(campaign.version) });
    assert.equal((await f.call('GET', `/v1/viewer/spaces/${sid}?access=invitation`, {}, second.headers)).status, 401);
  } finally { f.close(); }
});

test('shared DAP read rechecks revocation after asynchronous object storage; membership rights remain independently revocable', async () => {
  const f = fixture();
  try {
    const owner = await f.login('read-race@example.test'), member = await f.login('read-member@example.test');
    const saved = await install(f, owner, 'race-room', input('legacy')), sid = saved.space.spaceId;
    await f.openSpace(owner, { spaceId: sid, version: state(f, sid).version });
    const memberInvite = await f.ok('POST', `/v1/spaces/${sid}/member-invitations`, { verifiedIdentifier: 'read-member@example.test', tasks: ['view'], managementScopes: [], expiresAt: '2026-08-14T00:00:00.000Z' }, { ...owner.headers, 'if-match': String(state(f, sid).version) });
    const membership = await f.ok('POST', '/v1/member-invitation-acceptances', { secretFromClearedInviteBootstrap: memberInvite.oneTimeSecret }, member.headers);
    assert.equal((await f.ok('GET', '/v1/me/spaces', {}, member.headers)).spaces[0].spaceId, sid);
    const guest = await invite(f, owner, sid, 'view', 'race');
    const scene = (await f.ok('GET', `/v1/viewer/spaces/${sid}?access=invitation`, {}, guest.headers)).sceneContext;
    const get = f.api.mediaStore.get.bind(f.api.mediaStore);
    f.api.mediaStore.get = async (...args) => {
      const object = await get(...args);
      f.db.prepare("UPDATE external_invitation_campaigns SET campaign_status='revoked',revoked_at=? WHERE id=?").run(f.clock.iso(), guest.campaign.campaignId);
      return object;
    };
    assert.equal((await f.call('GET', `${scene.depthImport.url}?access=invitation`, {}, guest.headers)).status, 401);
    f.api.mediaStore.get = get;
    assert.equal((await f.call('GET', scene.depthImport.url, {}, member.headers)).status, 200, 'campaign revocation does not silently remove independent membership');
    await f.ok('DELETE', `/v1/spaces/${sid}/memberships/${membership.membershipId}`, {}, { ...owner.headers, 'if-match': String(membership.version) });
    assert.equal((await f.call('GET', scene.depthImport.url, {}, member.headers)).status, 404);
    assert.equal((await f.ok('GET', '/v1/me/spaces', {}, member.headers)).spaces.length, 0);
  } finally { f.close(); }
});

test('selected private photo keeps stable private/shared references without publishing its conversation, audio, or other photo', async () => {
  const f = fixture();
  try {
    const owner = await f.login('selection@example.test'), other = await f.login('selection-other@example.test');
    const a = { ...owner, headers: expected(owner) }, timestamp = f.clock.iso();
    const bytes = png(32, 16, '#556677');
    for (const mediaId of ['selected-photo', 'unselected-photo']) await f.ok('PUT', `/v1/moment-media/${mediaId}`, {
      kind: 'photo', name: `${mediaId}.png`, mimeType: 'image/png', dataBase64: bytes.toString('base64') }, a.headers);
    const audio = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(60)]);
    await f.ok('PUT', '/v1/moment-media/private-audio', { kind: 'audio', name: 'private.wav', mimeType: 'audio/wav', dataBase64: audio.toString('base64') }, a.headers);
    const moment = { id: 'personal-story', title: 'Private notes', status: 'active', createdAt: timestamp, updatedAt: timestamp,
      photos: [{ id: 'stable-photo', mediaId: 'selected-photo' }, { id: 'second-photo', mediaId: 'unselected-photo' }],
      messages: [{ id: 'private-message', role: 'user', text: 'PRIVATE_CONVERSATION_SENTINEL', createdAt: timestamp,
        photoId: 'stable-photo', audio: { mediaId: 'private-audio', duration: 1, waveform: [] } }] };
    const saved = await f.ok('PUT', '/v1/moments/personal-story', { expectedVersion: 0, moment }, a.headers);
    const space = await f.createSpace(owner);
    await f.openSpace(owner, space);
    const visitor = await invite(f, owner, space.spaceId, 'view', 'selection');
    const selected = await f.call('GET', '/v1/moment-media/selected-photo', {}, a.headers);
    const flow = await createAccountUpload(f, owner, { spaceId: space.spaceId, version: state(f, space.spaceId).version }, selected.body);
    moment.photos[0].spaceLinks = [{ spaceId: space.spaceId, photoId: flow.committed.photoId }];
    await f.ok('PUT', '/v1/moments/personal-story', { expectedVersion: saved.version, moment }, a.headers);
    const secondSession = await f.login('selection@example.test');
    const reopened = await f.ok('GET', '/v1/moments/personal-story', {}, secondSession.headers);
    assert.deepEqual(reopened.moment.photos[0].spaceLinks, moment.photos[0].spaceLinks);
    assert.equal(reopened.moment.photos[0].mediaId, 'selected-photo');
    const shared = await f.ok('GET', `/v1/viewer/spaces/${space.spaceId}?access=invitation`, {}, visitor.headers);
    assert.equal(shared.photos.length, 1);
    assert.equal(shared.photos[0].id, flow.committed.photoId);
    assert.equal(JSON.stringify(shared).includes('PRIVATE_CONVERSATION_SENTINEL'), false);
    for (const url of ['/v1/moments/personal-story', '/v1/moment-media/private-audio', '/v1/moment-media/unselected-photo']) {
      assert.ok([401, 404].includes((await f.call('GET', url, {}, visitor.headers)).status));
      assert.equal((await f.call('GET', url, {}, other.headers)).status, 404);
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM photos WHERE space_id=?').get(space.spaceId).n, 1);
  } finally { f.close(); }
});

test('lost successful PUT response can be reconciled from the authorized batch and committed without reuploading bytes', async () => {
  const f = fixture();
  try {
    const owner = await f.login('put-recovery@example.test'), unrelated = await f.login('put-other@example.test');
    const space = await f.createSpace(owner);
    await f.openSpace(owner, space);
    const sid = space.spaceId, bytes = png();
    const consent = await f.ok('POST', '/v1/consent-events', f.mediaConsentBody(), owner.headers);
    const batch = await f.ok('POST', `/v1/spaces/${sid}/contribution-batches`, { clientBatchId: 'put-recovery', consentEventId: consent.consentEventId, declaredItemCount: 1 }, owner.headers);
    const item = await f.ok('POST', `/v1/contribution-batches/${batch.batchId}/items`, { clientItemId: 'selected-photo', declaredMime: 'image/png', declaredBytes: bytes.length, fileNameHash: 'synthetic' }, { ...owner.headers, 'if-match': String(batch.version), 'x-space-version': String(state(f, sid).version) });
    const issued = await f.ok('POST', `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`, { declaredMime: 'image/png', declaredBytes: bytes.length, clientUploadId: 'put-recovery' }, { ...owner.headers, 'if-match': String(item.version) });
    // The client loses this response, so its only remaining version is issued.version.
    await f.api.putMedia({ ticket: issued.oneTimeUploadTicket, bytes, contentType: 'image/png' });
    const read = await f.ok('GET', `/v1/contribution-batches/${batch.batchId}/result`, {}, owner.headers);
    const current = read.items[0];
    assert.equal(current.uploadSessionId, issued.uploadSessionId);
    assert.equal(current.uploadSessionStatus, 'uploaded');
    assert.ok(current.uploadSessionVersion > issued.uploadSessionVersion);
    assert.equal(JSON.stringify(read).match(/oneTime|Ticket|ObjectKey|Secret/), null);
    assert.equal((await f.call('GET', `/v1/contribution-batches/${batch.batchId}/result`, {}, unrelated.headers)).status, 404);
    const committed = await f.ok('POST', `/v1/upload-sessions/${current.uploadSessionId}/commits`, { clientCommitId: 'after-reconciliation' }, {
      ...owner.headers, 'if-match': String(current.uploadSessionVersion), 'x-item-version': String(current.itemVersion) });
    assert.ok(committed.photoId);
    const final = await f.ok('GET', `/v1/contribution-batches/${batch.batchId}/result`, {}, owner.headers);
    assert.equal(final.items[0].uploadSessionStatus, 'committed');
    assert.equal(final.items[0].photoId, committed.photoId);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets WHERE kind=? AND space_id=?').get('photo', sid).n, 1);
  } finally { f.close(); }
});
