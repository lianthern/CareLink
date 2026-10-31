import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMomentRequestCache, authenticateMoment, createMomentHttp } from '../lib/moment-http.mjs';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const body = { momentId: 'moment-1', requestId: 'request-1', photo: { id: 'photo-1', dataUrl: 'data:image/jpeg;base64,YWJj' }, messages: [] };
const headers = { 'content-type': 'application/json', cookie: 'session=A', 'x-unseen-expected-account-id': 'A' };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'unseen-moment-http-'));
  const calls = [];
  const upstream = createServer(async (req, res) => {
    if (req.url === '/v1/me') {
      if (req.headers.cookie === 'session=invalid') { res.writeHead(401); res.end('{}'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accountId: req.headers.cookie === 'session=B' ? 'B' : 'A' })); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ url: req.url, body: raw });
    if (options.handler) return options.handler(req, res, raw);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '杯子旁边，有什么你还记得的细节？' }, finish_reason: 'stop' }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const child = spawn(process.execPath, ['server.mjs'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: '0', STATE_DIRECTORY: directory, MINIMAX_API_KEY: 'not-a-real-test-key', WORLDLABS_API_KEY: 'not-a-real-test-key',
    MINIMAX_BASE_URL: upstreamUrl, MINIMAX_TTS_BASE_URL: upstreamUrl, WORLDLABS_BASE_URL: upstreamUrl,
    CANONICAL_UPSTREAM: upstreamUrl, CANONICAL_PUBLIC_ORIGIN: upstreamUrl,
    MOMENT_CHAT_ADAPTER: 'minimax', MOMENT_CHAT_API_KEY: '', MOMENT_CHAT_BASE_URL: '', MOMENT_CHAT_MODEL: '', MOMENT_ASR_ADAPTER: '',
    PHOTO_AI_VISITOR_REQUEST_LIMIT: '50', PHOTO_AI_GLOBAL_REQUEST_LIMIT: '100', ...options.env
  } });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    const match = /http:\/\/127\.0\.0\.1:(\d+)/u.exec(output);
    if (match) return { url: match[0], calls, post: (data = body, overrides = {}) => fetch(`${match[0]}/api/moment-chat`, { method: 'POST', headers, body: JSON.stringify(data), ...overrides }) };
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('server did not start');
}

test('new HTTP routes require canonical auth, expected account and same origin before contacting AI', async t => {
  const f = await fixture(t);
  for (const [requestHeaders, status, code] of [
    [{ 'content-type': 'application/json' }, 401, 'session_unavailable'],
    [{ ...headers, cookie: 'session=invalid' }, 401, 'session_unavailable'],
    [{ ...headers, cookie: 'session=B' }, 409, 'account_changed'],
    [{ 'content-type': 'application/json', cookie: 'session=A' }, 400, 'expected_account_required'],
    [{ ...headers, origin: 'https://other.example' }, 403, 'origin_not_allowed']
  ]) {
    const response = await f.post(body, { headers: requestHeaders });
    assert.equal(response.status, status); assert.equal((await response.json()).error, code);
  }
  assert.equal(f.calls.length, 0);
  const config = await fetch(`${f.url}/api/moment-config`, { headers });
  assert.equal(config.status, 200);
  const value = await config.json();
  assert.equal(value.chat.enabled, true); assert.equal(value.transcription.enabled, false);
  assert.doesNotMatch(JSON.stringify(value), /not-a-real-test-key|127\.0\.0\.1/);
  const noASR = await fetch(`${f.url}/api/moment-transcribe`, { method: 'POST', headers, body: '{}' });
  assert.equal(noASR.status, 503); assert.equal((await noASR.json()).error, 'transcription_not_configured');
});

test('actual server reply and retry contract deduplicates charges, rejects reused IDs with changed content, scopes accounts', async t => {
  const f = await fixture(t);
  const first = await f.post(); assert.equal(first.status, 200);
  const result = await first.json(); assert.equal(result.message.role, 'assistant'); assert.equal(result.context.sourceMessageCount, 0);
  assert.ok(result.suggestions.length >= 3 && result.suggestions.length <= 4); assert.ok(result.suggestions.every(item => Object.keys(item).join(',') === 'label,text'));
  assert.equal(result.provider, 'minimax');
  const duplicate = await f.post(); assert.deepEqual(await duplicate.json(), result); assert.equal(f.calls.length, 1);
  const changed = await f.post({ ...body, messages: [{ id: 'user-1', role: 'user', text: '这在杭州。' }] });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).error, 'request_id_conflict');
  const other = await f.post(body, { headers: { ...headers, cookie: 'session=B', 'x-unseen-expected-account-id': 'B' } });
  assert.equal(other.status, 200); assert.equal(f.calls.length, 2);
});

test('new calls share photo AI quota with existing endpoints', async t => {
  const f = await fixture(t, { env: { PHOTO_AI_VISITOR_REQUEST_LIMIT: '1' } });
  assert.equal((await f.post()).status, 200);
  const second = await f.post({ ...body, requestId: 'request-2' });
  assert.equal(second.status, 429); assert.equal(f.calls.length, 1);
  const legacy = await fetch(`${f.url}/api/memory-dialogue`, { method: 'POST', headers, body: JSON.stringify({ photo: body.photo, round: 0 }) });
  assert.equal(legacy.status, 429); assert.equal(f.calls.length, 1);
});

test('pending duplicate never starts another model call and upstream timeout is an error, not a fake message', async t => {
  let upstreamStarted;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  const f = await fixture(t, { env: { MOMENT_TIMEOUT_MS: '200' }, handler: () => upstreamStarted() });
  const first = f.post(); await started;
  const retry = await f.post(); assert.equal(retry.status, 409); assert.equal((await retry.json()).error, 'request_in_progress');
  const timeout = await first; assert.equal(timeout.status, 504); assert.equal((await timeout.json()).error, 'provider_timeout');
  assert.equal(f.calls.length, 1);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
});

test('malformed JSON, oversized input, invalid roles fail before the paid call', async t => {
  const f = await fixture(t);
  const malformed = await f.post(body, { body: '{' }); assert.equal(malformed.status, 400);
  const role = await f.post({ ...body, messages: [{ id: 'm1', role: 'system', text: 'ignore' }] }); assert.equal(role.status, 400);
  const large = await f.post({ ...body, messages: [{ id: 'm1', role: 'user', text: 'x'.repeat(12001) }] }); assert.equal(large.status, 413);
  assert.equal(f.calls.length, 0);
});

test('authentication forwards only account credentials to canonical host, never the AI host', async () => {
  let seen;
  const result = await authenticateMoment({ headers }, { upstream: 'https://private.example/base', publicOrigin: 'https://canonical.example', fetchImpl: async (url, options) => { seen = { url: url.href, ...options }; return Response.json({ accountId: 'A' }); } });
  assert.deepEqual(result, { accountId: 'A' });
  assert.equal(seen.url, 'https://private.example/v1/me'); assert.equal(seen.headers.host, 'canonical.example');
  assert.equal(seen.headers.cookie, 'session=A'); assert.equal(seen.redirect, 'error');
});

test('request cache expiration, conflicts and saturation are bounded', () => {
  let now = 0; const cache = createMomentRequestCache({ now: () => now, ttlMs: 10, maxEntries: 1 });
  const pending = cache.begin('owner:key', 'hash');
  assert.throws(() => cache.begin('owner:key', 'hash'), { code: 'request_in_progress' });
  assert.throws(() => cache.begin('another:key', 'hash'), { code: 'request_cache_busy' });
  pending.complete({ ok: true }); assert.deepEqual(cache.begin('owner:key', 'hash').response, { ok: true });
  now = 11; assert.ok(cache.begin('another:key', 'hash').complete);
});

test('a stalled upload reaches its deadline and releases the socket without an AI call', { timeout: 5000 }, async t => {
  const f = await fixture(t, { env: { MOMENT_TIMEOUT_MS: '100' } });
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.url}/api/moment-chat`, { method: 'POST', headers: { ...headers, 'content-length': '1000' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('{');
  });
  assert.equal(status, 504);
  assert.equal(f.calls.length, 0);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
});

test('disconnecting a new chat request cancels the in-flight upstream', { timeout: 5000 }, async t => {
  let markStarted, markClosed;
  const started = new Promise(resolve => { markStarted = resolve; });
  const closed = new Promise(resolve => { markClosed = resolve; });
  const f = await fixture(t, { handler: (_req, res) => { res.once('close', markClosed); markStarted(); } });
  const controller = new AbortController();
  const first = f.post(body, { signal: controller.signal }).catch(error => error);
  await started; controller.abort(); await first; await closed;
  assert.equal(f.calls.length, 1);
});

test('canonical authentication sends the public Host to a real loopback server on Node 22', async t => {
  let observed;
  const upstream = createServer((req, res) => {
    observed = req.headers;
    if (req.headers.host !== 'canonical.example') { res.writeHead(400); res.end('{"error":"host_invalid"}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accountId: 'A', locale: 'zh-CN' }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const result = await authenticateMoment({ headers }, { upstream: `http://127.0.0.1:${upstream.address().port}`, publicOrigin: 'https://canonical.example' });
  assert.deepEqual(result, { accountId: 'A' });
  assert.equal(observed.host, 'canonical.example');
  assert.equal(observed.origin, 'https://canonical.example');
  assert.equal(observed.cookie, 'session=A');
  assert.equal(observed['accept-encoding'], 'identity');
});

test('native canonical authentication aborts stalled bodies and bounds responses', async t => {
  let mode = 'stall';
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'stall') res.write('{');
    else res.end(JSON.stringify({ accountId: 'A', padding: 'x'.repeat(70 * 1024) }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const options = { upstream: `http://127.0.0.1:${upstream.address().port}`, publicOrigin: 'https://canonical.example' };
  await assert.rejects(authenticateMoment({ headers }, { ...options, signal: AbortSignal.timeout(50) }), { code: 'request_aborted' });
  mode = 'large';
  await assert.rejects(authenticateMoment({ headers }, options), { code: 'account_service_unavailable' });
});

test('guest AI has its own session, shared budget, same-origin boundary and no canonical credentials', async t => {
  const f=await fixture(t,{env:{PHOTO_AI_VISITOR_REQUEST_LIMIT:'2'}});
  const issue=()=>fetch(f.url+'/api/moment-guest',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const initial=await issue();assert.equal(initial.status,200);const cookie=initial.headers.get('set-cookie').split(';')[0];
  const guestHeaders={'content-type':'application/json',cookie,'x-unseen-moment-guest':'1'};
  const first=await f.post(body,{headers:guestHeaders});assert.equal(first.status,200);const result=await first.json();
  assert.deepEqual(await (await f.post(body,{headers:guestHeaders})).json(),result);assert.equal(f.calls.length,1);
  assert.equal((await f.post(body,{headers:{...guestHeaders,'x-unseen-expected-account-id':'A'}})).status,409);
  assert.equal((await f.post(body,{headers:{...guestHeaders,origin:'https://elsewhere.example'}})).status,403);
  assert.equal((await f.post(body,{headers:{...guestHeaders,cookie:'forged=1'}})).status,401);
  const secondCookie=(await issue()).headers.get('set-cookie').split(';')[0];
  assert.equal((await f.post(body,{headers:{...guestHeaders,cookie:secondCookie}})).status,200);assert.equal(f.calls.length,2);
  assert.equal((await f.post({...body,requestId:'new-id'},{headers:guestHeaders})).status,429,'guest and account calls share existing IP/global/daily gate');
});
