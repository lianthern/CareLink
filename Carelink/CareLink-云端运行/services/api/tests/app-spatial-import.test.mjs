import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, png } from './fixture-factory.mjs';

const upload = (name, bytes) => ({ name, mimeType: 'image/png', dataBase64: bytes.toString('base64') });
const body = () => ({ consent: true, title: '教堂导入', panorama: upload('chapel.png', png(1600, 800)), depth: upload('depth.png', png(32, 16)),
  metadata: { model: 'DAP', convention: 'near_small', min: .01, max: .19, width: 32, height: 16, source_image: 'chapel.png', source_resolution: [1600,800] } });
test('private DAP import persists actual canonical space/revision/assets, reopens in a second session and isolates accounts', async () => {
  const f = fixture();
  try {
    const a = await f.login('space-owner@example.test'), b = await f.login('space-other@example.test');
    const headers = { ...a.headers, 'x-unseen-expected-account-id': a.accountId };
    const input = body();
    const saved = await f.ok('PUT', '/v1/app-spaces/import-chapel', input, headers);
    assert.equal(saved.space.status, 'ready');
    assert.equal(saved.space.depth.metadata.metadata.source_image, 'chapel.png');
    assert.equal((await f.ok('GET', '/v1/me/spaces', {}, a.headers)).spaces.some(s => s.spaceId === saved.space.spaceId && s.sharingState === 'private'), true);
    assert.equal((await f.ok('PUT', '/v1/app-spaces/import-chapel', input, headers)).space.spaceId, saved.space.spaceId);
    const second = await f.login('space-owner@example.test');
    assert.equal((await f.ok('GET', '/v1/app-spaces/import-chapel', {}, second.headers)).space.panoramaRevisionId, saved.space.panoramaRevisionId);
    const media = await f.call('GET', saved.space.panorama.url, {}, second.headers);
    assert.equal(media.status, 200); assert.deepEqual(media.body, png(1600,800));
    for (const h of [{}, b.headers]) for (const url of ['/v1/app-spaces/import-chapel', saved.space.panorama.url, saved.space.depth.url]) {
      assert.ok([401,404].includes((await f.call('GET', url, {}, h)).status));
    }
    assert.equal((await f.ok('GET', '/v1/app-spaces', {}, b.headers)).spaces.length, 0);
    assert.equal((await f.call('PUT', '/v1/app-spaces/import-chapel', {...input,title:'different'}, headers)).status, 409);
    // Simulate the canonical management path replacing the active revision. Old depth must
    // never be advertised or served against that replacement, including a cached media URL.
    f.db.prepare(`UPDATE app_spatial_imports SET depth_metadata_json=json_set(depth_metadata_json,'$.sourcePanoramaRevisionId','previous-revision') WHERE client_id=?`).run('import-chapel');
    const changed = await f.ok('GET', '/v1/app-spaces/import-chapel', {}, second.headers);
    assert.equal(changed.space.status, 'panorama');
    assert.equal(changed.space.depth, undefined);
    assert.equal((await f.call('GET', saved.space.depth.url, {}, second.headers)).status, 409);
  } finally { f.close(); }
});
test('wrong pair, corrupt bytes, missing metadata and wrong account never create a ready space', async () => {
  const f = fixture();
  try {
    const a = await f.login('bad-input@example.test');
    const headers = { ...a.headers, 'x-unseen-expected-account-id': a.accountId };
    const input = body();
    const variants = [{...input, metadata: {...input.metadata, source_image:'ballroom.png'}}, {...input, depth:upload('d.png',Buffer.from('broken'))},
      {...input,metadata:null}, {...input,metadata:{...input.metadata,convention:'near_large'}}, {...input,metadata:{...input.metadata,width:64}}];
    for (const [i,b] of variants.entries()) assert.equal((await f.call('PUT', `/v1/app-spaces/bad-${i}`, b, headers)).status, 422);
    assert.equal((await f.call('PUT','/v1/app-spaces/wrong-account',input,{...headers,'x-unseen-expected-account-id':'another'})).status,409);
    assert.equal((await f.ok('GET','/v1/app-spaces',{},a.headers)).spaces.length,0);
  } finally { f.close(); }
});
