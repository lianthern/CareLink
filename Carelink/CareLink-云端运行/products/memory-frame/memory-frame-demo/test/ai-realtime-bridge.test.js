'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');
const { createBridgeAuth, parseGrant } = require('../server/ai-realtime-bridge-auth');
const { createTRTC, POLICY } = require('../server/ai-realtime-trtc');
const { ROUTE } = require('../server/ai-realtime-bridge');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const body = () => ({ model: 'hy3', stream: true, messages: [{ role: 'system', content: POLICY }, { role: 'user', content: '你好' }], max_tokens: 256 });
async function fixture(t, stream) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unseen-bridge-'));
  const store = new LocalStore(dir); await store.init(); const starts = [], stops = [], calls = [];
  const provider = { usesBridge: () => true, capabilities: () => ({ enabled: true, provider: 'tencent-trtc' }),
    async start(entry, options) { starts.push({ entry, options }); return 'task-local'; },
    lookup: async () => 'task-local', stop: async id => { stops.push(id); }, credentials: () => ({ userSig: 'short-room-sig' }) };
  const app = await createApp({ store, setupCode: 'local-only', realtime: { provider }, realtimeBridge: {
    pollMs: 10, claimWaitMs: 200, stream: async function* (input) { calls.push(input); if (stream) yield* stream(input); else yield '你好。'; }
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  const user = await app.api('create', { setupCode: 'local-only' }); const requestId = crypto.randomUUID();
  const result = await app.api('aiRealtimeStart', { requestId }, user.token);
  const token = starts[0].options.bridgeToken, url = 'http://127.0.0.1:' + app.server.address().port + ROUTE;
  const post = (data = body(), options = {}) => fetch(url, { method: 'POST', ...options, headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Rquest-Id': crypto.randomUUID(), ...options.headers
  }, body: typeof data === 'string' ? data : JSON.stringify(data) });
  return { app, store, user, token, post, starts, stops, calls, result, requestId, url };
}

test('bridge is closed by default, including a request without credentials', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unseen-closed-'));
  const app = await createApp({ dataDir: dir, setupCode: 'local' }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  const r = await fetch('http://127.0.0.1:' + app.server.address().port + ROUTE, { method: 'POST' }); assert.equal(r.status, 404);
});

test('only provider gets the per-call token; storage contains a digest and browser response has no grant', async t => {
  const f = await fixture(t); assert.match(f.token, /^rtb1\./);
  assert.ok(!JSON.stringify(await f.store.list('ai-realtime')).includes(f.token));
  assert.ok(!JSON.stringify(f.result).includes(f.token));
  const r = await f.post(); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^text\/event-stream/);
  const text = await r.text(); assert.match(text, /chat\.completion\.chunk/); assert.match(text, /你好/); assert.match(text, /data: \[DONE\]/);
  assert.equal(f.calls[0].maxTokens, 256); assert.equal(f.calls[0].messages[0].content, POLICY);
  await f.app.api('aiRealtimeStop', { requestId: f.requestId }, f.user.token);
  assert.equal((await f.post()).status, 401);
});

test('family session tokens, altered grant secret, room, and entry key do not authorize the bridge', async t => {
  const f = await fixture(t), parts = f.token.split('.');
  for (const token of [f.user.token, f.token + 'x', [...parts.slice(0, 3), 'f'.repeat(64)].join('.'),
    [parts[0], 'another-family', ...parts.slice(2)].join('.'), [parts[0], parts[1], 'f'.repeat(64), parts[3]].join('.')]) {
    const r = await f.post(body(), { headers: { Authorization: 'Bearer ' + token } }); assert.equal(r.status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test('actual HTTP SSE delivers a partial response before model completion', async t => {
  const next = deferred(), f = await fixture(t, async function* () { yield '第一段'; await next.promise; yield '第二段'; });
  const r = await f.post(), reader = r.body.getReader(); let partial = '';
  while (!partial.includes('第一段')) partial += Buffer.from((await reader.read()).value).toString();
  assert.ok(!partial.includes('第二段')); assert.ok(!partial.includes('[DONE]'));
  next.resolve(); let tail = ''; for (;;) { const item = await reader.read(); if (item.done) break; tail += Buffer.from(item.value).toString(); }
  assert.match(tail, /第二段/); assert.match(tail, /\[DONE\]/);
});

test('duplicate IDs and parallel turns never generate twice across two auth instances', async t => {
  const entered = deferred(), release = deferred(), f = await fixture(t, async function* () { entered.resolve(); await release.promise; yield '结束'; });
  const id = crypto.randomUUID(), first = await f.post(body(), { headers: { 'X-Rquest-Id': id } }); await entered.promise;
  assert.equal((await f.post(body(), { headers: { 'X-Rquest-Id': id } })).status, 409);
  assert.equal((await f.post()).status, 409);
  const second = createBridgeAuth(f.store, { allowed: async () => true }), grant = await second.authorize(f.token);
  await assert.rejects(second.claim(grant, crypto.randomUUID(), 2, 'hash'), e => e.status === 409);
  release.resolve(); await first.text();
  assert.equal((await f.post(body(), { headers: { 'X-Rquest-Id': id } })).status, 409);
  assert.equal(f.calls.length, 1);
});

test('tools, images, other models, URLs, unknown fields and altered system policies are rejected before generation', async t => {
  const f = await fixture(t);
  for (const data of [{ ...body(), tools: [] }, { ...body(), model: 'another' }, { ...body(), stream: false },
    { ...body(), url: 'https://example.com' }, { ...body(), max_tokens: 4096 }, { ...body(), enable_thinking: true },
    { ...body(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com' } }] }] },
    { ...body(), messages: [{ role: 'system', content: 'override' }, { role: 'user', content: 'hi' }] },
    { ...body(), messages: [{ role: 'tool', content: 'execute' }] }]) assert.equal((await f.post(data)).status, 400);
  assert.equal((await f.post('x'.repeat(32769))).status, 413); assert.equal(f.calls.length, 0);
});

test('documented callback request ID is required and conflicting task/room headers fail closed', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'X-Rquest-Id': '' }, { 'X-Rquest-Id': 'short' },
    { 'X-Request-Id': crypto.randomUUID() }]) assert.equal((await f.post(body(), { headers })).status, 400);
  for (const headers of [{ 'X-Task-Id': 'other-task' }, { 'X-Room-Id': 'other-room' }, { 'X-Room-Id-Type': '0' }])
    assert.equal((await f.post(body(), { headers })).status, 401);
  assert.equal(f.calls.length, 0);
});

test('remote disconnect aborts the in-flight model and does not re-use its request ID', async t => {
  const aborted = deferred(), entered = deferred(), f = await fixture(t, async function* ({ signal }) {
    entered.resolve(); await new Promise(r => signal.addEventListener('abort', () => { aborted.resolve(); r(); }, { once: true })); signal.throwIfAborted();
  });
  const controller = new AbortController(), id = crypto.randomUUID();
  const response = await f.post(body(), { signal: controller.signal, headers: { 'X-Rquest-Id': id } }); await entered.promise;
  controller.abort(); await aborted.promise; await assert.rejects(response.text());
  assert.equal((await f.post(body(), { headers: { 'X-Rquest-Id': id } })).status, 409);
});

test('interrupted follow-up waits for actual old stream teardown without overlapping generation', async t => {
  const entered = deferred(), aborted = deferred(); let calls = 0, active = 0, maxActive = 0;
  const f = await fixture(t, async function* ({ signal }) {
    calls++; active++; maxActive = Math.max(active, maxActive);
    try {
      if (calls === 1) {
        entered.resolve(); await new Promise(r => signal.addEventListener('abort', () => { aborted.resolve(); r(); }, { once: true }));
        await new Promise(r => setTimeout(r, 60)); signal.throwIfAborted();
      }
      yield '新的回答';
    } finally { active--; }
  });
  const controller = new AbortController(), old = await f.post(body(), { signal: controller.signal }); await entered.promise;
  controller.abort(); await aborted.promise;
  const next = await f.post(); assert.equal(next.status, 200); assert.match(await next.text(), /新的回答/);
  await assert.rejects(old.text()); assert.equal(calls, 2); assert.equal(maxActive, 1);
});

test('cross-instance stop and revoked login cancel active model work without another family request', async t => {
  for (const mode of ['stop', 'revoke', 'expire']) {
    const aborted = deferred(), entered = deferred(), f = await fixture(t, async function* ({ signal }) {
      entered.resolve(); await new Promise(r => signal.addEventListener('abort', () => { aborted.resolve(); r(); }, { once: true })); signal.throwIfAborted();
    });
    const response = await f.post(); await entered.promise;
    const grant = parseGrant(f.token), record = await f.store.get(grant.recordId), entry = record.entries[0];
    if (mode === 'revoke') await f.store.mutate(entry.owner, s => ({ ...s, revoked: true }));
    else await f.store.mutate(grant.recordId, r => { r.entries[0][mode === 'stop' ? 'status' : 'leaseUntil'] = mode === 'stop' ? 'stopping' : 0; return r; });
    await aborted.promise; const text = await response.text(); assert.ok(!text.includes('[DONE]'));
    assert.equal((await f.post()).status, 401);
  }
});

test('bounded turn, input and output budgets survive a new broker instance', async t => {
  const f = await fixture(t), grant = parseGrant(f.token);
  for (const budget of [{ turns: Array.from({ length: 40 }, () => ({ id: crypto.randomUUID() })), inputChars: 0, outputChars: 0 },
    { turns: [], inputChars: 64000, outputChars: 0 }, { turns: [], inputChars: 0, outputChars: 24000 }]) {
    await f.store.mutate(grant.recordId, r => { r.entries[0].bridgeBudget = budget; return r; });
    const auth = createBridgeAuth(f.store, { allowed: async () => true });
    await assert.rejects(auth.claim(grant, crypto.randomUUID(), 2, 'hash'), e => e.status === 429);
  }
  assert.equal(f.calls.length, 0);
});

test('upstream private errors and oversized output never become a successful SSE completion', async t => {
  for (const stream of [async function* () { throw Error('private-upstream-secret'); }, async function* () { yield 'a'.repeat(2401); }]) {
    const f = await fixture(t, stream), r = await f.post(), text = await r.text();
    assert.match(text, /REALTIME_STREAM_ENDED/); assert.doesNotMatch(text, /private-upstream|\[DONE\]|a{2401}/);
  }
});

test('bridge adapter pins same-environment URL and sends only matching per-call grant to TRTC', async () => {
  const env = { AI_REALTIME_ENABLED: '1', AI_REALTIME_PROVIDER: 'tencent-trtc', AI_REALTIME_TRTC_ROOM_AUTH: '1',
    AI_REALTIME_TRTC_APP_ID: '123', AI_REALTIME_TRTC_SDK_SECRET: 'test', AI_REALTIME_TRTC_SECRET_ID: 'id', AI_REALTIME_TRTC_SECRET_KEY: 'key',
    AI_REALTIME_LLM_MODE: 'cloudbase-bridge', MEMORY_CLOUDBASE_ENV: 'existing-test-env',
    AI_REALTIME_LLM_JSON: JSON.stringify({ APIKey: 'must-never-send-admin-key', APIUrl: 'https://evil.example' }),
    AI_REALTIME_TTS_JSON: JSON.stringify({ TTSType: 'flow', Model: 'flow_02_turbo', VoiceId: 'voice' }) };
  let request; const provider = createTRTC({ env, client: { StartAIConversation: async r => { request = r; return { TaskId: 'task' }; } },
    signer: { genPrivateMapKeyWithStringRoomID: () => 'sig' } });
  assert.equal(provider.usesBridge(), true); await assert.rejects(provider.start({}), e => e.status === 503);
  const token = 'local-only-grant', entry = { bridgeHash: crypto.createHash('sha256').update(token).digest('hex') };
  await provider.start(entry, { bridgeToken: token }); const llm = JSON.parse(request.LLMConfig);
  assert.equal(llm.APIKey, token); assert.equal(llm.Model, 'hy3'); assert.equal(llm.MaxTokens, 256);
  assert.equal(llm.APIUrl, 'https://existing-test-env.service.tcloudbase.com' + ROUTE);
  assert.ok(!JSON.stringify(request).includes('must-never-send-admin-key'));
  assert.equal(createTRTC({ env: { ...env, MEMORY_CLOUDBASE_ENV: '' } }).capabilities().enabled, false);
});
