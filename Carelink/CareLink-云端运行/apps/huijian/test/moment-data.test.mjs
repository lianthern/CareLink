import test from 'node:test';
import assert from 'node:assert/strict';
import { newMoment, appendMessage, mergeMoment, messageTextHistory, safeMediaUrl, MomentApi, openMomentCache } from '../public/moment-data.js';

const message = (id, text, createdAt = '2026-09-05T01:00:00.000Z') => ({ id, role: 'user', text, createdAt, photoId: 'photo-1' });
function baseline() {
  return { id: 'memory-1', title: '那次旅行', status: 'active', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    preferences: { photoMode: 'reveal' }, photos: [{ id: 'photo-1', url: '/v1/moment-media/photo-1', caption: '湖边' }],
    messages: [message('message-1', '那天刚好下过雨')], context: { summary: '过期摘要', throughId: 'message-1' } };
}

test('new accounts begin with empty, independently identified memories', () => {
  const first = newMoment({ photoMode: 'clear' });
  const second = newMoment();
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.photos, []);
  assert.deepEqual(first.messages, []);
  assert.equal(first.preferences.photoMode, 'clear');
  assert.equal(second.preferences.photoMode, 'reveal');
});

test('retrying an append preserves one message and does not mutate the cached base', () => {
  const base = baseline();
  const nextMessage = message('message-2', '后来出了太阳');
  const next = appendMessage(base, nextMessage);
  assert.equal(base.messages.length, 1);
  assert.equal(next.messages.length, 2);
  assert.equal(appendMessage(next, structuredClone(nextMessage)), next);
});

test('two devices can append independently while an existing message edit is retained', () => {
  const base = baseline(), local = structuredClone(base), remote = structuredClone(base);
  local.messages[0].text = '那天下了一点小雨';
  local.messages.push(message('message-c', '我们在湖边吃饭', '2026-09-05T02:00:00.000Z'));
  remote.messages.push(message('message-b', '远处还有山', '2026-09-05T01:30:00.000Z'));
  remote.photos[0].caption = '下雨后的湖边';
  const originals = JSON.stringify({ base, local, remote });
  const merged = mergeMoment(base, local, remote);
  assert.deepEqual(merged.messages.map(item => item.id), ['message-1', 'message-b', 'message-c']);
  assert.equal(merged.messages[0].text, '那天下了一点小雨');
  assert.equal(merged.photos[0].caption, '下雨后的湖边');
  assert.deepEqual(merged.context, {}, 'a merged transcript must not keep a stale context summary');
  assert.equal(JSON.stringify({ base, local, remote }), originals, 'input snapshots remain recoverable');
});

test('unrelated metadata edits merge while conflicting edits require explicit recovery', () => {
  const base = baseline(), local = structuredClone(base), remote = structuredClone(base);
  local.title = '湖边的午饭';
  remote.preferences.photoMode = 'clear';
  let merged = mergeMoment(base, local, remote);
  assert.equal(merged.title, '湖边的午饭');
  assert.equal(merged.preferences.photoMode, 'clear');
  remote.title = '和家人的旅行';
  assert.equal(mergeMoment(base, local, remote), null);
  remote.title = local.title;
  merged = mergeMoment(base, local, remote);
  assert.equal(merged.title, '湖边的午饭');
});

test('conflicting message edits and same-ID divergent uploads cannot silently overwrite', () => {
  const base = baseline(), local = structuredClone(base), remote = structuredClone(base);
  local.messages[0].text = '六月去的'; remote.messages[0].text = '七月去的';
  assert.equal(mergeMoment(base, local, remote), null);
  local.messages = structuredClone(base.messages); remote.messages = structuredClone(base.messages);
  local.photos.push({ id: 'photo-2', url: '/v1/moment-media/a' });
  remote.photos.push({ id: 'photo-2', url: '/v1/moment-media/b' });
  assert.equal(mergeMoment(base, local, remote), null);
});

test('same appended message on both devices is deduplicated and tied timestamps sort stably', () => {
  const base = baseline(), local = structuredClone(base), remote = structuredClone(base);
  const shared = message('message-2', '是的', '2026-09-05T02:00:00.000Z');
  local.messages.push(shared, message('message-a', '也有朋友', shared.createdAt));
  remote.messages.push(structuredClone(shared), message('message-b', '还有家人', shared.createdAt));
  const merged = mergeMoment(base, local, remote);
  assert.deepEqual(merged.messages.map(item => item.id), ['message-1', 'message-2', 'message-a', 'message-b']);
});

test('deletions and foreign memory IDs remain recoverable conflicts', () => {
  const base = baseline(), local = structuredClone(base), remote = structuredClone(base);
  local.messages = [];
  assert.equal(mergeMoment(base, local, remote), null);
  local.messages = structuredClone(base.messages);
  remote.id = 'another-memory';
  assert.equal(mergeMoment(base, local, remote), null);
  assert.equal(mergeMoment(null, local, remote), null);
});

test('context history includes only spoken conversation text, without original audio or arbitrary metadata', () => {
  const moment = baseline();
  moment.messages.push({ ...message('a', '我看到了湖'), role: 'assistant', privateField: 'omit', audio: { blob: 'omit' } },
    { ...message('s', 'do not use this'), role: 'system' }, message('empty', '   '));
  const history = messageTextHistory(moment);
  assert.equal(history.length, 2);
  assert.deepEqual(Object.keys(history[1]).sort(), ['createdAt', 'id', 'photoId', 'role', 'text']);
});

test('private media references accept only the exact same-origin media route', () => {
  for (const valid of ['/v1/moment-media/asset_1-A', '/v1/moment-media/asset_1-A/preview']) assert.equal(safeMediaUrl(valid), valid);
  for (const value of [null, 42, {}, '', 'https://evil.example/v1/moment-media/a', '//evil.example/a',
    'javascript:alert(1)', 'data:image/png;base64,abc', 'blob:private', '/v1/moment-media/../account',
    '/v1/moment-media/%2e%2e', '/v1/moment-media/a?token=secret', '/v1/moment-media/a#fragment',
    '/v1/moment-media/a/preview/extra', '/v1/moment-media/a\n', '/v1/moment-media/a\u0000']) {
    assert.equal(safeMediaUrl(value), '', `reject ${String(value)}`);
  }
});

async function withFetch(mock, run) {
  const old = globalThis.fetch; globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = old; }
}

test('API scopes cookies, expected account and mutation retry IDs to the caller', async () => {
  let request;
  await withFetch(async (path, init) => { request = { path, ...init }; return { ok: true, json: async () => ({ version: 2 }) }; }, async () => {
    const api = new MomentApi(); api.setAccount('account-a');
    assert.deepEqual(await api.request('/v1/moments/memory-1', { method: 'PUT', body: { title: '湖边' }, key: 'stable-retry-id' }), { version: 2 });
    assert.equal(request.credentials, 'same-origin');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.headers['X-Unseen-Expected-Account-Id'], 'account-a');
    assert.equal(request.headers['Idempotency-Key'], 'stable-retry-id');
    assert.deepEqual(JSON.parse(request.body), { title: '湖边' });
  });
});

test('space concurrency and consent headers cannot replace account identity or retry identity', async () => {
  let captured;
  await withFetch(async (_path, init) => {captured=init;return {ok:true,json:async()=>({version:3})};},async()=>{
    const api=new MomentApi();api.setAccount('account-a');
    const notice={purpose:'space_create',version:1,contentHash:'current-notice'};
    await api.request('/v1/spaces',{method:'POST',body:{name:'现场'},key:'one-create',version:2,notice,
      headers:{'X-Space-Version':'2','X-Item-Version':'1','X-Unseen-Expected-Account-Id':'account-b','Idempotency-Key':'replacement','Authorization':'fake'}});
    assert.equal(captured.headers['If-Match'],'2');assert.equal(captured.headers['X-Item-Version'],'1');
    assert.deepEqual(JSON.parse(captured.headers['Notice-Acknowledgement']),notice);
    assert.equal(captured.headers['X-Unseen-Expected-Account-Id'],'account-a');
    assert.equal(captured.headers['Idempotency-Key'],'one-create');assert.equal(captured.headers.Authorization,undefined);
  });
});

test('a buffered account-A body resolving after switching to account B cannot return as success', async () => {
  let release;
  await withFetch(async () => ({ ok: true, json: () => new Promise(resolve => { release = resolve; }) }), async () => {
    const api = new MomentApi(); api.setAccount('account-a');
    const pending = api.request('/v1/moments');
    await Promise.resolve();
    api.setAccount('account-b');
    release({ documents: [{ accountId: 'account-a', secret: 'private' }] });
    await assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'account_changed');
  });
});

test('an abort during response body parsing is never swallowed into a null success', async () => {
  let rejectBody;
  await withFetch(async () => ({ ok: true, json: () => new Promise((resolve, reject) => { rejectBody = reject; }) }), async () => {
    const api = new MomentApi(); api.setAccount('account-a');
    const pending = api.request('/v1/moments');
    await Promise.resolve();
    api.setAccount('account-b');
    rejectBody(new DOMException('Aborted', 'AbortError'));
    await assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'account_changed');
  });
});

test('a different account returned after another tab changed the shared cookie is rejected', async () => {
  for (const body of [{ accountId: 'account-b', moments: [] }, { user: { id: 'account-b' } }]) {
    await withFetch(async () => ({ ok: true, json: async () => body }), async () => {
      const api = new MomentApi(); api.setAccount('account-a');
      await assert.rejects(api.request('/v1/profile'), error => error.code === 'account_changed');
    });
  }
});

// Minimal asynchronous IDB storage contract: structured clones, keyPath stores,
// request success before transaction completion. This tests account scoping, not
// browser durability/quota behavior (which requires actual IndexedDB acceptance).
function memoryIndexedDB() {
  const stores = new Map();
  const db = {
    createObjectStore(name) { stores.set(name, new Map()); },
    transaction(name) {
      const values = stores.get(name);
      const tx = { objectStore() {
        const run = action => {
          const request = {};
          queueMicrotask(() => {
            request.result = action(); request.onsuccess?.();
            queueMicrotask(() => tx.oncomplete?.());
          });
          return request;
        };
        return {
          put: value => run(() => { values.set(value.key, structuredClone(value)); return value.key; }),
          get: key => run(() => structuredClone(values.get(key))),
          getAll: () => run(() => structuredClone([...values.values()])),
          delete: key => run(() => { values.delete(key); })
        };
      } };
      return tx;
    }
  };
  return { open() {
    const request = {};
    queueMicrotask(() => { request.result = db; request.onupgradeneeded?.(); request.onsuccess?.(); });
    return request;
  } };
}

test('offline documents with identical IDs remain isolated to their owning accounts', async () => {
  const cache = openMomentCache(memoryIndexedDB());
  const first = { moment: baseline(), pending: true, accountId: 'attempted-owner-override', key: 'attempted-key-override' };
  const second = structuredClone(first); second.moment.title = '另一位用户的回忆';
  await cache.put('account-a', first); await cache.put('account-b', second);
  first.moment.title = 'mutation after write';
  assert.equal((await cache.get('account-a', 'memory-1')).moment.title, '那次旅行');
  assert.equal((await cache.get('account-b', 'memory-1')).moment.title, '另一位用户的回忆');
  assert.equal((await cache.get('account-a', 'memory-1')).accountId, 'account-a');
  assert.equal((await cache.list('account-a')).length, 1);
  assert.equal((await cache.list('account-b')).length, 1);
  assert.deepEqual(await cache.list('account-c'), []);
  assert.equal(await cache.get('account-c', 'memory-1'), undefined);
});

test('audio drafts and removal are account-scoped and preserve original Blob bytes', async () => {
  const cache = openMomentCache(memoryIndexedDB());
  await cache.putMedia('account-a', 'voice-1', new Blob(['original-a'], { type: 'audio/webm' }), { accountId: 'account-b', id: 'other-id' });
  await cache.putMedia('account-b', 'voice-1', new Blob(['original-b'], { type: 'audio/mp4' }));
  const first = await cache.getMedia('account-a', 'voice-1');
  assert.equal(first.accountId, 'account-a'); assert.equal(first.id, 'voice-1');
  assert.equal(await first.blob.text(), 'original-a'); assert.equal(first.blob.type, 'audio/webm');
  await cache.removeMedia('account-a', 'voice-1');
  assert.equal(await cache.getMedia('account-a', 'voice-1'), undefined);
  assert.equal(await (await cache.getMedia('account-b', 'voice-1')).blob.text(), 'original-b');
});

test('unavailable offline storage reports a failure instead of claiming a saved draft', async () => {
  const cache = openMomentCache(null);
  await assert.rejects(cache.put('account-a', { moment: baseline() }), /cache_unavailable/);
});
