'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, getEventListeners } = require('node:events');
const { createHy3Stream } = require('../server/ai-realtime-hy3-stream');

const AUTH = '/auth/v1/token/clientCredential';
const MODEL = '/v1/ai/cloudbase/chat/completions';
const messages = [{ role: 'system', content: '请简短回答。' }, { role: 'user', content: '你好' }];
const app = () => ({ config: { envName: 'offline-stream-test', region: 'ap-shanghai',
  secretId: 'synthetic-test-id', secretKey: 'synthetic-test-secret', sessionToken: 'synthetic-session' } });
const event = text => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
const done = 'data: [DONE]\n\n';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const collect = async iterable => { const chunks = []; for await (const text of iterable) chunks.push(text); return chunks; };
const immediate = () => new Promise(resolve => setImmediate(resolve));
const code = expected => error => {
  assert.equal(error.code, expected);
  assert.doesNotMatch(JSON.stringify({ message: error.message, stack: error.stack }),
    /synthetic-|offline-stream-test|raw-provider-secret|upstream-body|Bearer|Authorization/);
  return true;
};

// Only loopback HTTP is used. The production URL is captured, asserted and
// rewritten by a trusted transport function; no CloudBase endpoint is contacted.
async function fixture(t, handleModel, { handleAuth, timeoutMs } = {}) {
  const records = [], wire = [], sockets = new Set();
  const responseReceived = new Map([[AUTH, deferred()], [MODEL, deferred()]]);
  const responsePaths = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString());
      records.push({ path: req.url, data, headers: req.headers });
      if (req.url === AUTH) {
        if (handleAuth) return handleAuth(req, res, data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'synthetic-bearer-token' }));
      } else if (req.url === MODEL) {
        await handleModel(req, res, data);
      } else {
        res.writeHead(404); res.end();
      }
    } catch (error) { res.destroy(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const request = (url, options, callback) => {
    const upstream = new URL(url);
    assert.equal(upstream.origin, 'https://offline-stream-test.api.tcloudbasegateway.com');
    assert.ok([AUTH, MODEL].includes(upstream.pathname));
    const req = http.request(`http://127.0.0.1:${server.address().port}${upstream.pathname}`, options, response => {
      responsePaths.push(upstream.pathname);
      callback(response);
      responseReceived.get(upstream.pathname).resolve();
    });
    wire.push(req);
    return req;
  };
  return { records, wire, sockets, request, responseReceived, responsePaths,
    adapter: createHy3Stream({ app: app() }, { request, ...(timeoutMs === undefined ? {} : { timeoutMs }) }) };
}

test('fixed SDK identity, model and short request stream incremental UTF-8 text without credential exposure', async t => {
  const firstSeen = deferred(), proceed = deferred();
  const originalApp = app(), originalConfig = structuredClone(originalApp.config);
  const f = await fixture(t, async (_req, res, data) => {
    assert.deepEqual(data, { model: 'hy3', stream: true, messages, max_tokens: 256,
      temperature: 0.2, enable_thinking: false });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const encoded = Buffer.from(event('你好'));
    const split = encoded.indexOf(Buffer.from('你')) + 1;
    res.write(encoded.subarray(0, split)); await immediate(); res.write(encoded.subarray(split));
    await proceed.promise;
    // Exercise a CRLF boundary split over writes and a usage-only event.
    res.write(event('，很高兴见到你。').replace(/\n/g, '\r\n').slice(0, -1)); await immediate();
    res.end('\n' + 'data: {"choices":[],"usage":{"completion_tokens":8}}\n\n' + done);
  });
  const adapter = createHy3Stream({ app: originalApp }, { request: f.request });
  const output = [];
  const run = (async () => {
    for await (const text of adapter.stream({ messages, signal: new AbortController().signal })) {
      output.push(text); firstSeen.resolve();
    }
  })();
  await firstSeen.promise;
  assert.deepEqual(output, ['你好']);
  proceed.resolve(); await run;
  assert.equal(output.join(''), '你好，很高兴见到你。');
  assert.deepEqual(originalApp.config, originalConfig);
  assert.deepEqual(f.records.map(record => record.path), [AUTH, MODEL]);
  assert.deepEqual(f.records[0].data, { grant_type: 'client_credentials' });
  assert.match(f.records[0].headers.authorization, /synthetic-test-id/);
  assert.doesNotMatch(f.records[0].headers.authorization, /synthetic-test-secret/);
  assert.equal(f.records[1].headers.authorization, 'Bearer synthetic-bearer-token');
  assert.equal(f.records[1].headers.accept, 'text/event-stream');
  assert.ok(f.wire.every(req => req.destroyed));
});

for (const stage of ['auth', 'model']) {
  for (const headers of [false, true]) {
    test(`abort destroys actual ${stage} socket ${headers ? 'after' : 'before'} response headers`, async t => {
      const arrived = deferred(), closed = deferred();
      const hold = (_req, res) => {
        res.once('close', () => closed.resolve({ finished: res.writableFinished }));
        if (headers) {
          res.writeHead(200, { 'Content-Type': stage === 'auth' ? 'application/json' : 'text/event-stream' });
          res.write(stage === 'auth' ? '{"access_token":"' : ': keepalive\n\n');
        }
        arrived.resolve();
      };
      const f = await fixture(t, stage === 'model' ? hold : () => assert.fail('model must never start'),
        stage === 'auth' ? { handleAuth: hold } : {});
      const controller = new AbortController();
      const run = collect(f.adapter.stream({ messages, signal: controller.signal }));
      const rejected = assert.rejects(run, code('HY3_ABORTED'));
      await arrived.promise;
      const stagePath = stage === 'auth' ? AUTH : MODEL;
      // Prove the client received headers; a server write alone is insufficient.
      if (headers) await f.responseReceived.get(stagePath).promise;
      else assert.equal(f.responsePaths.includes(stagePath), false);
      controller.abort(new Error('raw-provider-secret'));
      await rejected;
      assert.deepEqual(await closed.promise, { finished: false });
      assert.equal(f.wire.length, stage === 'auth' ? 1 : 2);
      assert.ok(f.wire.every(req => req.destroyed));
    });
  }
}

test('pre-aborted signal performs no SDK credential or network call', async () => {
  const controller = new AbortController(); controller.abort();
  const adapter = createHy3Stream({ app: { get config() { assert.fail('config must not be read'); } } },
    { request: () => assert.fail('request must not run') });
  await assert.rejects(collect(adapter.stream({ messages, signal: controller.signal })), code('HY3_ABORTED'));
});

test('abort while consumer is paused destroys upstream without another next()', async t => {
  const closed = deferred();
  const f = await fixture(t, (_req, res) => {
    res.once('close', () => closed.resolve(res.writableFinished));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(event('第一段'));
  });
  const controller = new AbortController();
  const iterator = f.adapter.stream({ messages, signal: controller.signal });
  assert.deepEqual(await iterator.next(), { value: '第一段', done: false });
  controller.abort();
  assert.equal(await closed.promise, false);
  assert.equal(f.wire.at(-1).destroyed, true);
  await assert.rejects(iterator.next(), code('HY3_ABORTED'));
});

test('consumer break closes stream and socket without waiting for provider EOF', async t => {
  const closed = deferred();
  const f = await fixture(t, (_req, res) => {
    res.once('close', () => closed.resolve(res.writableFinished));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(event('一句'));
  });
  for await (const text of f.adapter.stream({ messages, signal: new AbortController().signal })) {
    assert.equal(text, '一句'); break;
  }
  assert.equal(await closed.promise, false);
  assert.equal(f.wire.at(-1).destroyed, true);
});

test('total deadline destroys a stalled request before response headers', async t => {
  const closed = deferred();
  const f = await fixture(t, (_req, res) => { res.once('close', () => closed.resolve(res.writableFinished)); }, { timeoutMs: 100 });
  await assert.rejects(collect(f.adapter.stream({ messages, signal: new AbortController().signal })), code('HY3_TIMEOUT'));
  assert.equal(await closed.promise, false);
  assert.ok(f.wire.every(req => req.destroyed));
});

test('deadline destroys a body stream even while consumer is paused at yield', async t => {
  const closed = deferred();
  const f = await fixture(t, (_req, res) => {
    res.once('close', () => closed.resolve(res.writableFinished));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(event('一句'));
  }, { timeoutMs: 100 });
  const controller = new AbortController();
  const iterator = f.adapter.stream({ messages, signal: controller.signal });
  assert.equal((await iterator.next()).value, '一句');
  assert.equal(await closed.promise, false);
  await assert.rejects(iterator.next(), code('HY3_TIMEOUT'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('[DONE] closes a provider that leaves its socket open, and removes abort listeners', async t => {
  const closed = deferred();
  const f = await fixture(t, (_req, res) => {
    res.once('close', () => closed.resolve(res.writableFinished));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(event('完成') + done);
  });
  const controller = new AbortController();
  assert.deepEqual(await collect(f.adapter.stream({ messages, signal: controller.signal })), ['完成']);
  assert.equal(await closed.promise, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.ok(f.wire.every(req => req.destroyed));
});

test('unsupported app identity and arbitrary request fields are rejected before I/O', async () => {
  const request = () => assert.fail('network must not run');
  for (const config of [{ envName: 'invalid/host' }, { ...app().config, serviceUrl: 'evil.example' },
    { ...app().config, proxy: 'http://proxy.example' }, { ...app().config, accessKey: 'synthetic-api-key' },
    { ...app().config, getCrossAccountInfo: () => assert.fail('callback must not run') }]) {
    await assert.rejects(collect(createHy3Stream({ app: { config } }, { request }).stream({ messages,
      signal: new AbortController().signal })), code('HY3_CONFIG'));
  }
  const adapter = createHy3Stream({ app: app() }, { request });
  for (const extra of [{ maxTokens: 257 }, { model: 'other' }, { enable_thinking: true }, { url: 'http://evil.example' },
    { apiKey: 'synthetic-key' }, { tools: [] }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    { messages: [{ role: 'user', content: 'x', tool_calls: [] }] }, { messages: Array(17).fill(messages[1]) },
    { messages: [{ role: 'user', content: 'x'.repeat(8193) }] }, { messages: [messages[1], messages[0]] }]) {
    await assert.rejects(collect(adapter.stream({ messages, signal: new AbortController().signal, ...extra })), code('HY3_INPUT'));
  }
});

for (const scenario of [
  { title: 'redirect', status: 302, headers: { Location: 'http://evil.example' }, body: 'raw-provider-secret', error: 'HY3_UPSTREAM' },
  { title: 'provider error', status: 429, body: 'raw-provider-secret', error: 'HY3_UPSTREAM' },
  { title: 'wrong content type', type: 'application/json', body: '{}', error: 'HY3_PROTOCOL' },
  { title: 'JSON error event', body: 'data: {"error":{"message":"raw-provider-secret"}}\n\n', error: 'HY3_UPSTREAM' },
  { title: 'malformed JSON', body: 'data: {raw-provider-secret\n\n', error: 'HY3_PROTOCOL' },
  { title: 'tool call', body: 'data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n', error: 'HY3_PROTOCOL' },
  { title: 'unannounced EOF', body: event('不完整'), error: 'HY3_PROTOCOL' },
  { title: 'oversized event', body: 'data: ' + 'x'.repeat(17 * 1024), error: 'HY3_LIMIT' },
  { title: 'oversized text across events', body: event('x'.repeat(9000)) + event('x'.repeat(9000)) + done, error: 'HY3_LIMIT' },
  { title: 'excessive framing', body: ': ' + 'x'.repeat(260 * 1024) + '\n\n', error: 'HY3_LIMIT' },
  { title: 'malformed UTF-8', body: Buffer.from([0xff, 0xfe]), error: 'HY3_UPSTREAM' }
]) {
  test(`${scenario.title} fails closed, sanitizes error and closes transport`, async t => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(scenario.status || 200, { 'Content-Type': scenario.type || 'text/event-stream', ...scenario.headers });
      res.end(scenario.body);
    });
    await assert.rejects(collect(f.adapter.stream({ messages, signal: new AbortController().signal })), code(scenario.error));
    assert.equal(f.records.length, 2);
    assert.ok(f.wire.every(req => req.destroyed));
  });
}

test('credential response is bounded and an invalid token never reaches the model', async t => {
  for (const payload of [{ access_token: 'invalid\r\nheader' }, { error: 'raw-provider-secret' }, { access_token: 'x'.repeat(70 * 1024) }]) {
    const f = await fixture(t, () => assert.fail('model must not run'), { handleAuth: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload));
    } });
    await assert.rejects(collect(f.adapter.stream({ messages, signal: new AbortController().signal })),
      code(payload.access_token?.length > 70_000 ? 'HY3_LIMIT' : 'HY3_UPSTREAM'));
    assert.equal(f.records.length, 1); assert.ok(f.wire.every(req => req.destroyed));
  }
});

test('one cancelled call does not affect another concurrent call', async t => {
  const arrived = deferred(), closed = deferred();
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (++calls === 1) {
      res.once('close', () => closed.resolve()); res.write(': wait\n\n'); arrived.resolve();
    } else res.end(event('另一会话正常') + done);
  });
  const controller = new AbortController();
  const first = collect(f.adapter.stream({ messages, signal: controller.signal }));
  const rejected = assert.rejects(first, code('HY3_ABORTED'));
  await arrived.promise;
  const second = collect(f.adapter.stream({ messages, signal: new AbortController().signal, maxTokens: 64 }));
  controller.abort(); await rejected; await closed.promise;
  assert.deepEqual(await second, ['另一会话正常']);
  assert.equal(f.records.filter(record => record.path === MODEL).at(-1).data.max_tokens, 64);
});
