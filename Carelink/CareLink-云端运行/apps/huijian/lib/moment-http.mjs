import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readBoundedJson } from './bounded-response.mjs';
import { MomentError, MOMENT_CONTEXT_LIMITS, momentHash, momentId, momentTurn, validateMomentRequest } from './moment-context.mjs';
import { MOMENT_AUDIO_LIMITS, normalizeMomentChatResult, validateMomentAudio } from './moment-provider.mjs';
import { createMomentGuest } from './moment-guest.mjs';
import { fallbackMomentSuggestions } from '../public/moment-suggestions.js';

// Node 22's fetch ignores a caller-supplied Host header. The canonical app deliberately
// validates its public Host even on a loopback hop, so use the same native transport as
// canonical-proxy here. Read the tiny account DTO fully under the request's deadline.
function fetchCanonicalAccount(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    let incoming, outgoing, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', aborted);
      if (error) { incoming?.destroy(); outgoing?.destroy(); reject(error); }
      else resolve(value);
    };
    const aborted = () => finish(signal.reason || new Error('account_request_aborted'));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    outgoing = transport(url, { method: 'GET', headers: { ...headers, 'accept-encoding': 'identity' } }, response => {
      incoming = response;
      response.once('error', error => finish(error));
      response.once('aborted', () => finish(new Error('account_response_incomplete')));
      const status = response.statusCode || 502;
      if (status !== 200) { finish(null, new Response(null, { status })); response.destroy(); return; }
      let bytes = 0; const chunks = [];
      if (Number(response.headers['content-length']) > 64 * 1024) { finish(new Error('account_response_too_large')); return; }
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) { finish(new Error('account_response_too_large')); return; }
        chunks.push(chunk);
      });
      response.once('end', () => finish(null, new Response(Buffer.concat(chunks, bytes), {
        status, headers: { 'content-type': 'application/json' }
      })));
    });
    outgoing.once('error', error => finish(error));
    outgoing.end();
  });
}

// Authentication reuses the canonical account server. No parallel account/session store is created here.
export async function authenticateMoment(req, { upstream = process.env.CANONICAL_UPSTREAM,
  publicOrigin = process.env.CANONICAL_PUBLIC_ORIGIN, fetchImpl = fetchCanonicalAccount, signal } = {}) {
  if (!upstream) throw new MomentError('account_service_unavailable', 503);
  if (!req.headers.cookie && !req.headers.authorization) throw new MomentError('session_unavailable', 401);
  const expected = req.headers['x-unseen-expected-account-id'];
  if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(expected)) throw new MomentError('expected_account_required', 400);
  let base, origin;
  try {
    base = new URL(upstream); origin = new URL(publicOrigin || upstream);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error();
  } catch { throw new MomentError('account_service_unavailable', 503); }
  try {
    const response = await fetchImpl(new URL('/v1/me', base), { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      headers: { accept: 'application/json', host: origin.host, origin: origin.origin, 'sec-fetch-site': 'same-origin',
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MomentError([401, 403].includes(response.status) ? 'session_unavailable' : 'account_service_unavailable', [401, 403].includes(response.status) ? 401 : 503);
    }
    const account = await readBoundedJson(response, 64 * 1024, { signal });
    if (!account || typeof account.accountId !== 'string' || !account.accountId) throw new MomentError('session_unavailable', 401);
    if (expected !== account.accountId) throw new MomentError('account_changed', 409);
    return { accountId: account.accountId };
  } catch (error) {
    if (error instanceof MomentError) throw error;
    if (signal?.aborted) throw new MomentError('request_aborted', 499);
    throw new MomentError('account_service_unavailable', 503);
  }
}

// Short-lived idempotency cache only; replies contain a bounded context view, never raw photos/audio.
// No conversation history is written to disk here; account persistence remains the source of truth.
// Concurrent retries receive 409 and can retry the same ID; completed retries reuse the exact reply.
export function createMomentRequestCache({ now = Date.now, ttlMs = 5 * 60 * 1000, maxEntries = 100 } = {}) {
  const entries = new Map();
  return {
    begin(key, fingerprint) {
      for (const [id, item] of entries) if (item.expiresAt <= now()) entries.delete(id);
      const old = entries.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new MomentError('request_id_conflict', 409);
        if (!old.response) throw new MomentError('request_in_progress', 409);
        return { response: old.response };
      }
      if (entries.size >= maxEntries) throw new MomentError('request_cache_busy', 429);
      const item = { fingerprint, expiresAt: now() + ttlMs, response: null };
      entries.set(key, item);
      return { complete(response) { item.response = response; }, fail() { if (entries.get(key) === item) entries.delete(key); } };
    }
  };
}
function requestLifetime(req, res, timeoutMs) {
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', abort); res.once('close', abort);
  const timer = setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, close() { clearTimeout(timer); req.off('aborted', abort); res.off('close', abort); } };
}
function send(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
  res.end(text);
}
function requestAllowed(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new MomentError('origin_not_allowed', 403);
  if (req.headers.origin) {
    let origin; try { origin = new URL(req.headers.origin); } catch { throw new MomentError('origin_not_allowed', 403); }
    if (origin.host !== req.headers.host) throw new MomentError('origin_not_allowed', 403);
  }
  if (req.method === 'POST' && !/^application\/json(?:;|$)/iu.test(req.headers['content-type'] || '')) throw new MomentError('json_required', 415);
}
async function boundedBody(req, maximum, signal) {
  if (Number(req.headers['content-length']) > maximum) throw new MomentError('request_too_large', 413);
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0, finished = false;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted);
      signal.removeEventListener('abort', aborted);
    };
    const fail = error => {
      if (finished) return;
      finished = true; cleanup(); req.pause(); reject(error);
    };
    const aborted = () => fail(new MomentError(signal.reason?.name === 'TimeoutError' ? 'request_timeout' : 'request_aborted', signal.reason?.name === 'TimeoutError' ? 408 : 499));
    const data = chunk => {
      length += chunk.length;
      if (length > maximum) return fail(new MomentError('request_too_large', 413));
      chunks.push(chunk);
    };
    const end = () => {
      if (finished) return;
      let value;
      try { value = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
      catch { fail(new MomentError('bad_request')); return; }
      finished = true; cleanup(); resolve(value);
    };
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export function createMomentHttp({ providers, gate, identity, authenticate = authenticateMoment,
  timeoutMs = 70000, cache = createMomentRequestCache(), guest = createMomentGuest() } = {}) {
  const config = () => ({ chat: { enabled: Boolean(providers.chat), provider: providers.chat?.id || null,
    model: providers.chat?.model || null, capabilities: providers.chat?.capabilities || null },
    transcription: { enabled: Boolean(providers.transcription), provider: providers.transcription?.id || null,
      model: providers.transcription?.model || null, ...MOMENT_AUDIO_LIMITS, ...providers.transcription?.clientConfig }, context: MOMENT_CONTEXT_LIMITS });
  return async function handleMoment(req, res, pathname) {
    if (!['/api/moment-guest', '/api/moment-config', '/api/moment-chat', '/api/moment-transcribe'].includes(pathname)) return false;
    if (req.method !== (pathname === '/api/moment-config' ? 'GET' : 'POST')) { send(res, 405, { error: 'method_not_allowed' }); return true; }
    const lifetime = requestLifetime(req, res, timeoutMs);
    let reservation, cacheEntry;
    try {
      requestAllowed(req);
      if (pathname === '/api/moment-guest') {
        await boundedBody(req, 1024, lifetime.signal);
        send(res, 200, { guest: true }, { 'set-cookie': guest.issue(req) }); return true;
      }
      const account = req.headers['x-unseen-moment-guest'] === '1'
        ? guest.authenticate(req) : await authenticate(req, { signal: lifetime.signal });
      lifetime.signal.throwIfAborted();
      if (pathname === '/api/moment-config') { send(res, 200, config()); return true; }
      const chat = pathname === '/api/moment-chat';
      const provider = chat ? providers.chat : providers.transcription;
      if (!provider) throw new MomentError(chat ? 'chat_not_configured' : 'transcription_not_configured', 503);
      const body = await boundedBody(req, chat ? 18 * 1024 * 1024 : 12 * 1024 * 1024, lifetime.signal);
      const request = chat ? validateMomentRequest(body) : { requestId: momentId(body?.requestId, 'request_id'), audio: validateMomentAudio(body) };
      const fingerprint = momentHash(chat ? { provider: provider.id, model: provider.model, ...request } :
        { provider: provider.id, model: provider.model, audio: momentHash(request.audio.bytes), mime: request.audio.mimeType, language: request.audio.language });
      const key = momentHash([account.accountId, pathname, chat ? request.momentId : '', request.requestId]);
      cacheEntry = cache.begin(key, fingerprint);
      if (cacheEntry.response) { send(res, 200, cacheEntry.response); return true; }
      lifetime.signal.throwIfAborted();
      reservation = await gate.reserve(identity(req));
      if (!reservation.ok) throw Object.assign(new MomentError(reservation.reason, reservation.reason === 'photo_ai_state_unavailable' ? 503 : 429), { retryAfterSeconds: reservation.retryAfterSeconds, scope: reservation.scope });
      lifetime.signal.throwIfAborted();
      let response;
      if (chat) {
        const turn = momentTurn(request);
        const rawResult = await provider.complete({ ...turn, signal: lifetime.signal });
        const result = normalizeMomentChatResult(rawResult, request.messages);
        const suggestions = result.suggestions.length ? result.suggestions : fallbackMomentSuggestions(result.text, request.messages);
        response = { message: { id: `assistant-${randomUUID()}`, role: 'assistant', text: result.text,
          photoId: request.photo.id, createdAt: new Date().toISOString() }, suggestions, context: turn.context,
          provider: rawResult?.provider || provider.id, model: rawResult?.model || provider.model };
      } else response = await provider.transcribe({ ...request.audio, signal: lifetime.signal });
      lifetime.signal.throwIfAborted();
      cacheEntry.complete(response);
      send(res, 200, response);
    } catch (error) {
      cacheEntry?.fail?.();
      const status = lifetime.signal.aborted && lifetime.signal.reason?.name === 'TimeoutError' ? 504 : error instanceof MomentError ? error.status : 502;
      const code = status === 504 ? 'provider_timeout' : error instanceof MomentError ? error.code : 'provider_unavailable';
      const headers = [429, 409].includes(status) ? { 'retry-after': String(error.retryAfterSeconds || (code === 'request_in_progress' ? 2 : 30)) } : {};
      if (!req.complete) {
        headers.connection = 'close';
        res.once('finish', () => req.destroy());
      }
      send(res, status, { error: code, ...(error.scope ? { scope: error.scope } : {}) }, headers);
    } finally { reservation?.release?.(); lifetime.close(); }
    return true;
  };
}
