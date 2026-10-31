'use strict';
const crypto = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createBridgeAuth, LIMITS } = require('./ai-realtime-bridge-auth');
const { POLICY } = require('./ai-realtime-trtc');
const ROUTE = '/internal/ai-realtime/chat/completions';
const fail = (status, message = '实时语音请求格式无效') => { throw Object.assign(Error(message), { status }); };
function input(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400);
  const keys = ['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'enable_thinking', 'stream_options'];
  if (Object.keys(body).some(k => !keys.includes(k)) || body.model !== 'hy3' || body.stream !== true) fail(400);
  if (body.max_tokens != null && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 256)) fail(400);
  for (const key of ['temperature', 'top_p']) if (body[key] != null && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > 1)) fail(400);
  if (body.enable_thinking != null && body.enable_thinking !== false) fail(400);
  if (body.stream_options != null && (typeof body.stream_options !== 'object' || Array.isArray(body.stream_options) ||
    Object.keys(body.stream_options).some(k => k !== 'include_usage') || typeof body.stream_options.include_usage !== 'boolean')) fail(400);
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 14) fail(400);
  const messages = []; let chars = 0;
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some(k => !['role', 'content'].includes(k)) ||
      typeof m.content !== 'string' || !m.content.trim() || m.content.length > 4000) fail(400);
    if (m.role === 'system') { if (i !== 0 || m.content !== POLICY) fail(400); continue; }
    if (!['user', 'assistant'].includes(m.role)) fail(400);
    chars += m.content.length; if (chars > 16000) fail(413);
    messages.push({ role: m.role, content: m.content });
  }
  if (!messages.length || messages.at(-1).role !== 'user') fail(400);
  return { messages: [{ role: 'system', content: POLICY }, ...messages], chars };
}
function createBridge(store, { enabled = () => false, allowed, stream, clock = Date.now, pollMs = 1000, claimWaitMs = 2000 } = {}) {
  if (!Number.isInteger(claimWaitMs) || claimWaitMs < 0 || claimWaitMs > 2000 || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw Error('Invalid bridge limits');
  const auth = createBridgeAuth(store, { allowed, clock }), running = new Set();
  async function handle(req, res) {
    if (!enabled()) fail(404, '接口不存在');
    if (req.method !== 'POST') fail(405);
    if (new URL(req.url, 'http://localhost').search || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) fail(400);
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    const grant = await auth.authorize(token);
    const requestId = req.headers['x-rquest-id'] || req.headers['x-request-id'];
    if (req.headers['x-rquest-id'] && req.headers['x-request-id'] && req.headers['x-rquest-id'] !== req.headers['x-request-id']) fail(400);
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestId || '')) fail(400);
    if (Number(req.headers['content-length']) > 32768) fail(413);
    const controller = new AbortController(); running.add(controller);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    let timer = setTimeout(() => { controller.abort(); req.destroy(); }, 10000), pollTimer, claim, outputChars = 0;
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { controller.signal.throwIfAborted(); bytes += chunk.length; if (bytes > 32768) fail(413); chunks.push(chunk); }
      controller.signal.throwIfAborted();
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400); }
      const validated = input(body), entry = await auth.check(grant);
      // Header names match the documented provider spelling (X-Rquest-Id).
      // They are supplementary checks; only the short-lived Bearer authorizes.
      if ((req.headers['x-room-id'] && req.headers['x-room-id'] !== entry.rtcRoom) ||
        (req.headers['x-room-id-type'] && req.headers['x-room-id-type'] !== '1') ||
        (req.headers['x-task-id'] && entry.taskId && req.headers['x-task-id'] !== entry.taskId)) fail(401);
      if (typeof stream !== 'function') fail(503, '实时语音模型连接尚未配置');
      const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'), waitUntil = Date.now() + claimWaitMs;
      // An interruption may arrive just before the aborted stream releases its
      // durable claim. Wait briefly for confirmed release, without stealing the
      // claim or overlapping a still-running generation. Duplicate IDs never wait.
      while (!claim) {
        controller.signal.throwIfAborted();
        try { claim = await auth.claim(grant, requestId, validated.chars, bodyHash); }
        catch (error) {
          if (error.code !== 'BRIDGE_BUSY' || Date.now() >= waitUntil) throw error;
          await delay(Math.min(50, waitUntil - Date.now()), undefined, { signal: controller.signal });
        }
      }
      controller.signal.throwIfAborted();
      clearTimeout(timer); timer = setTimeout(() => controller.abort(), LIMITS.turnMs);
      const poll = async () => {
        try { if (!enabled()) throw Error('disabled'); await auth.validate(claim); }
        catch { controller.abort(); }
        if (!controller.signal.aborted) pollTimer = setTimeout(poll, pollMs);
      };
      pollTimer = setTimeout(poll, pollMs);
      const id = 'chatcmpl-' + crypto.randomUUID(), created = Math.floor(clock() / 1000);
      async function write(data) {
        controller.signal.throwIfAborted();
        if (!res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)) await once(res, 'drain', { signal: controller.signal });
      }
      const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model: 'hy3', choices: [{ index: 0, delta, finish_reason }] });
      await auth.validate(claim); controller.signal.throwIfAborted();
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      await write(chunk({ role: 'assistant', content: '' }));
      for await (const text of stream({ messages: validated.messages, signal: controller.signal, maxTokens: 256 })) {
        controller.signal.throwIfAborted();
        if (typeof text !== 'string') throw Error('invalid stream');
        outputChars += text.length;
        if (outputChars > Math.min(2400, claim.outputRemaining)) throw Error('output limit');
        if (text) await write(chunk({ content: text }));
      }
      await auth.validate(claim); controller.signal.throwIfAborted();
      if (!outputChars) throw Error('empty stream');
      await write(chunk({}, 'stop')); await write('[DONE]'); res.end();
    } catch (error) {
      if (!res.headersSent) throw error;
      if (!res.destroyed && !res.writableEnded) res.end('data: {"error":{"code":"REALTIME_STREAM_ENDED","message":"本次语音回复已结束，请重试"}}\n\n');
    } finally {
      controller.abort(); clearTimeout(timer); clearTimeout(pollTimer); running.delete(controller);
      res.removeListener('close', disconnected);
      if (claim) { try { await auth.release(claim, outputChars); } catch { /* Retain claim; never allow a duplicate paid generation. */ } }
    }
  }
  return { handle, close() { for (const controller of running) controller.abort(); } };
}
module.exports = { createBridge, input, ROUTE };
