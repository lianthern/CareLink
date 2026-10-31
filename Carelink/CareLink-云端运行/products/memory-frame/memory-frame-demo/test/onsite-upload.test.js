'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server/server');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-onsite-test-'));
  const app = await createApp({ dataDir: dir, setupCode: 'test-code' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  async function call(action, data = {}, token, denied = false) {
    const response = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token || ''}` }, body: JSON.stringify({ action, data }) });
    const body = await response.json();
    if (denied) assert.ok(response.status >= 400 && response.status < 500, `${action}: ${response.status} ${JSON.stringify(body)}`);
    else assert.equal(response.status, 200, `${action}: ${JSON.stringify(body)}`);
    return body;
  }
  const owner = await call('register', { username: 'onsite001', password: 'test-password', mode: 'create', setupCode: 'test-code', name: '私密家庭', nickname: '主人' });
  const frameInvite = await call('invite', { role: 'frame' }, owner.token);
  const frame = await call('join', { invite: frameInvite.invite });
  return { ...app, call, owner, frame };
}
const upload = (f, guest, buffer = png) => f.call('upload', { base64: buffer.toString('base64') }, guest.token);
async function guest(f, options = {}) {
  const invitation = await f.call('uploadInvite', options, f.owner.token);
  const contributor = await f.call('uploadJoin', { invite: invitation.invite, visitor: randomUUID(), nickname: '现场小明' });
  return { invitation, contributor };
}

test('onsite: opaque upload invitation, minimal public response and stable per-invite visitor identity', async t => {
  const f = await fixture(t), before = Date.now();
  const invitation = await f.call('uploadInvite', { label: '给奶奶送照片' }, f.owner.token);
  assert.deepEqual(Object.keys(invitation).sort(), ['expires', 'id', 'invite', 'limit']);
  assert.match(invitation.invite, /^[a-f0-9]{48}$/); assert.equal(invitation.limit, 60);
  assert.ok(invitation.expires >= before + 86400000 && invitation.expires <= Date.now() + 86400000);
  assert.equal((await f.store.get(invitation.id)).kind, 'upload-invite');
  const info = await f.call('uploadInfo', { invite: invitation.invite });
  assert.deepEqual(info, { label: '给奶奶送照片', expires: invitation.expires, remaining: 60 });
  const visitor = randomUUID();
  const first = await f.call('uploadJoin', { invite: invitation.invite, visitor, nickname: '小明' });
  assert.deepEqual(Object.keys(first).sort(), ['name', 'role', 'room', 'token']);
  assert.equal(first.role, 'contributor'); assert.equal(first.room, f.owner.room);
  const again = await f.call('uploadJoin', { invite: invitation.invite, visitor, nickname: '不同名字' });
  assert.equal(again.token, first.token); assert.equal(again.name, first.name);
  const secondInvite = await f.call('uploadInvite', {}, f.owner.token);
  const second = await f.call('uploadJoin', { invite: secondInvite.invite, visitor });
  assert.notEqual(second.token, first.token); assert.equal(second.name, '现场访客');
  await f.call('uploadJoin', { invite: invitation.invite, visitor: 'invalid' }, undefined, true);
  await f.call('uploadInfo', { invite: '0'.repeat(48) }, undefined, true);
  await f.call('uploadJoin', { invite: '0'.repeat(48), visitor }, undefined, true);
  await f.call('join', { invite: invitation.invite }, undefined, true);
  await f.call('register', { username: 'intruder', password: 'test-password', mode: 'join', invite: invitation.invite }, undefined, true);
  const ordinary = await f.call('invite', {}, f.owner.token);
  await f.call('uploadJoin', { invite: ordinary.invite, visitor }, undefined, true);
  await f.call('uploadInvite', {}, f.frame.token, true);
});

test('onsite: guest photo reaches existing frame, status reflects receipt and discloses only own delivery', async t => {
  const f = await fixture(t), { contributor } = await guest(f);
  const photo = await upload(f, contributor);
  const sent = await f.call('send', { id: 'guest-photo', image: photo.id, text: '今天来看奶奶' }, contributor.token);
  assert.deepEqual(await f.call('send', { id: 'guest-photo', image: photo.id }, contributor.token), sent);
  const ownerMessage = await f.call('send', { id: 'private', text: '私密原有问答' }, f.owner.token);
  await f.call('uploadStatus', { ids: [sent.id, ownerMessage.id] }, contributor.token, true);
  const status = await f.call('uploadStatus', { ids: [sent.id] }, contributor.token);
  assert.deepEqual(Object.keys(status), ['items']); assert.equal(status.items.length, 1);
  assert.deepEqual(Object.keys(status.items[0]).sort(), ['deliveredAt', 'id', 'received']);
  assert.equal(status.items[0].id, sent.id); assert.equal(status.items[0].received, false);
  const state = await f.call('state', {}, f.frame.token);
  const message = state.messages.find(item => item._id === sent.id);
  assert.equal(message.name, '现场小明'); assert.equal(message.text, '今天来看奶奶'); assert.ok(message.imageURL);
  await f.call('receipt', { id: sent.id }, f.frame.token);
  const delivered = await f.call('uploadStatus', { ids: [sent.id] }, contributor.token);
  assert.equal(delivered.items[0].received, true); assert.ok(delivered.items[0].deliveredAt);
  assert.ok((await f.call('state', {}, f.owner.token)).messages.find(item => item._id === ownerMessage.id));
});

test('onsite: contributor cannot access family state, mutate private data or send non-photo content', async t => {
  const f = await fixture(t), { contributor } = await guest(f), own = await upload(f, contributor);
  const privateFile = await upload(f, f.owner);
  for (const action of ['state', 'history', 'invite', 'uploadInvite', 'revokeUploadInvite', 'edit', 'remove', 'person', 'revoke', 'process', 'receipt', 'spatialImport', 'spatialAsset', 'framePresence', 'aiChat', 'aiConversation', 'aiRealtime']) {
    await f.call(action, { id: 'private' }, contributor.token, true);
  }
  for (const data of [{ text: 'text only' }, { image: privateFile.id }, { image: own.id, audio: 'anything' }, { image: own.id, link: 'https://example.com' }, { image: own.id, parent: 'anything' }, { image: own.id, text: '长'.repeat(3001) }]) {
    await f.call('send', { id: randomUUID(), ...data }, contributor.token, true);
  }
  const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
  await f.call('upload', { base64: wav.toString('base64') }, contributor.token, true);
  const privateMessage = await f.call('send', { id: 'collision', text: 'secret' }, f.owner.token);
  await f.call('send', { id: 'collision', image: own.id }, contributor.token, true);
  assert.equal((await f.store.get(privateMessage.id)).text, 'secret');
  const other = await f.call('create', { setupCode: 'test-code' });
  const otherFile = await upload(f, other);
  const otherMessage = await f.call('send', { id: 'cross-room', image: otherFile.id }, other.token);
  await f.call('send', { id: 'stolen', image: otherFile.id }, contributor.token, true);
  await f.call('uploadStatus', { ids: [otherMessage.id] }, contributor.token, true);
  await f.call('logout', {}, contributor.token);
  await f.call('uploadStatus', { ids: [] }, contributor.token, true);
});

test('onsite: quota reserves abandoned uploads, deduplicates retries and is shared by all visitors', async t => {
  const f = await fixture(t), { invitation, contributor } = await guest(f, { limit: 1 });
  const files = await Promise.all([upload(f, contributor), upload(f, contributor), upload(f, contributor)]);
  assert.equal(new Set(files.map(file => file.id)).size, 1);
  assert.equal((await f.call('uploadInfo', { invite: invitation.invite })).remaining, 0);
  const another = await f.call('uploadJoin', { invite: invitation.invite, visitor: randomUUID() });
  await f.call('upload', { base64: png.toString('base64') }, another.token, true);
  const sent = await f.call('send', { id: 'reserved-upload', image: files[0].id }, contributor.token);
  assert.ok(sent.id);
  await f.call('send', { id: 'duplicate-delivery', image: files[0].id }, contributor.token, true);
  const tooLarge = await f.call('uploadInvite', { limit: 101 }, f.owner.token, true);
  assert.ok(tooLarge);
});

test('onsite: only owning room revokes grants and expiration fences existing guest sessions', async t => {
  const f = await fixture(t), { invitation, contributor } = await guest(f);
  const other = await f.call('create', { setupCode: 'test-code' });
  await f.call('revokeUploadInvite', { id: invitation.id }, other.token, true);
  await upload(f, contributor);
  await f.call('revokeUploadInvite', { id: invitation.id }, f.owner.token);
  await f.call('uploadInfo', { invite: invitation.invite }, undefined, true);
  await f.call('uploadJoin', { invite: invitation.invite, visitor: randomUUID() }, undefined, true);
  await f.call('uploadStatus', { ids: [] }, contributor.token, true);
  const expired = await guest(f);
  await f.store.mutate(expired.invitation.id, current => ({ ...current, expires: 1 }));
  await f.call('uploadInfo', { invite: expired.invitation.invite }, undefined, true);
  await f.call('upload', { base64: png.toString('base64') }, expired.contributor.token, true);
  await f.call('state', {}, f.owner.token);
});

test('onsite: concurrent distinct visitors cannot oversubscribe quota, including after app restart', async t => {
  const f = await fixture(t), { invitation, contributor } = await guest(f, { limit: 1 });
  const second = await f.call('uploadJoin', { invite: invitation.invite, visitor: 'a'.repeat(48) });
  const results = await Promise.allSettled([f.api('upload', { base64: png.toString('base64') }, contributor.token), f.api('upload', { base64: png.toString('base64') }, second.token)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected.reason.status >= 400 && rejected.reason.status < 500);
  assert.equal((await f.call('uploadInfo', { invite: invitation.invite })).remaining, 0);
  const restarted = await createApp({ store: f.store, setupCode: 'test-code' });
  const loser = results[0].status === 'rejected' ? contributor : second;
  await assert.rejects(restarted.api('upload', { base64: png.toString('base64') }, loser.token), error => error.status >= 400 && error.status < 500);
  assert.equal((await f.store.list('file', f.owner.room)).length, 1);
});
