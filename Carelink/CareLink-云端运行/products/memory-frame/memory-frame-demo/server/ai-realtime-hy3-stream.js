'use strict';

const https = require('node:https');
const { TextDecoder } = require('node:util');

const MAX_TOKENS = 256;
const MAX_DURATION_MS = 45000;
const MAX_AUTH_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 256 * 1024;
const MAX_EVENT_CHARS = 16 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const TOKEN_PATH = '/auth/v1/token/clientCredential';
const MODEL_PATH = '/v1/ai/cloudbase/chat/completions';

function failure(code) {
  const error = new Error(code === 'HY3_ABORTED' ? '实时回答已取消' : '实时回答暂不可用');
  error.code = code;
  if (code === 'HY3_ABORTED') error.name = 'AbortError';
  return error;
}

// These are audited, locked SDK internals, used only for its existing runtime
// identity/signing. The SDK's network adapter loses abortSignal, so it is never
// called here. Refuse a dependency upgrade until this boundary is re-audited.
function sdkSigning() {
  if (require('@cloudbase/node-sdk/package.json').version !== '3.18.3') throw failure('HY3_CONFIG');
  const { TcbOpenApiHttpCommonRequester } = require('@cloudbase/node-sdk/dist/utils/tcbopenapicommonrequester');
  const { prepareCredentials } = require('@cloudbase/node-sdk/dist/utils/tcbapirequester');
  const { buildCommonOpenApiUrlWithPath } = require('@cloudbase/node-sdk/dist/utils/tcbopenapiendpoint');
  if (typeof TcbOpenApiHttpCommonRequester !== 'function' || typeof prepareCredentials !== 'function' ||
      typeof buildCommonOpenApiUrlWithPath !== 'function') throw failure('HY3_CONFIG');
  return { TcbOpenApiHttpCommonRequester, prepareCredentials, buildCommonOpenApiUrlWithPath };
}

function checkedInput(input) {
  if (!input || Object.keys(input).some(key => !['messages', 'signal', 'maxTokens'].includes(key))) throw failure('HY3_INPUT');
  const { messages, signal, maxTokens = MAX_TOKENS } = input;
  if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' ||
      !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS ||
      !Array.isArray(messages) || !messages.length || messages.length > 16) throw failure('HY3_INPUT');
  let chars = 0;
  const copy = messages.map((message, index) => {
    if (!message || Object.keys(message).some(key => !['role', 'content'].includes(key)) ||
        !['system', 'user', 'assistant'].includes(message.role) || (message.role === 'system' && index !== 0) ||
        typeof message.content !== 'string' || !message.content.trim() || message.content.length > 8192) throw failure('HY3_INPUT');
    chars += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (chars > 16384) throw failure('HY3_INPUT');
  return { messages: copy, signal, maxTokens };
}

function checkedConfig(app) {
  const config = app?.config;
  // Current CloudStore explicitly supplies its own env. Do not fall back to
  // arbitrary URLs, API keys, cross-account callbacks or proxy configuration.
  if (!config || typeof config.envName !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(config.envName) ||
      config.serviceUrl || config.proxy || config.accessKey || config.getCrossAccountInfo ||
      (config.region && !/^[a-z]{2}-[a-z]+(?:-[a-z]+)?$/.test(config.region))) throw failure('HY3_CONFIG');
  return { envName: config.envName, region: config.region, secretId: config.secretId,
    secretKey: config.secretKey, sessionToken: config.sessionToken };
}

function tokenFromBody(buffer) {
  let result;
  try { result = JSON.parse(buffer.toString('utf8')); } catch { throw failure('HY3_UPSTREAM'); }
  const token = result?.access_token;
  if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/.test(token)) throw failure('HY3_UPSTREAM');
  return token;
}

function parseEvent(event) {
  const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return {};
  if (data === '[DONE]') return { done: true };
  let value;
  try { value = JSON.parse(data); } catch { throw failure('HY3_PROTOCOL'); }
  if (!value || value.error) throw failure('HY3_UPSTREAM');
  if (!Array.isArray(value.choices)) throw failure('HY3_PROTOCOL');
  // A final usage-only event is allowed; neither usage nor reasoning is emitted.
  if (!value.choices.length) return {};
  if (value.choices.length !== 1) throw failure('HY3_PROTOCOL');
  const choice = value.choices[0];
  const delta = choice?.delta;
  if (!delta || typeof delta !== 'object' || Array.isArray(delta) ||
      (choice.index !== undefined && choice.index !== 0) || delta.tool_calls || delta.function_call ||
      (delta.role !== undefined && delta.role !== 'assistant') ||
      (choice.finish_reason && !['stop', 'length'].includes(choice.finish_reason)) ||
      (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string')) throw failure('HY3_PROTOCOL');
  return { text: delta.content || '' };
}

/**
 * createHy3Stream({ app }).stream({ messages, signal, maxTokens: 256 })
 * -> AsyncIterable<string>. The caller owns policy, authorization and concurrency.
 * Importing/constructing is inert; the first next() starts I/O. No retries.
 * The second argument is trusted, in-process transport injection for local tests;
 * it must never be populated from HTTP input or environment configuration.
 */
function createHy3Stream({ app } = {}, { request = https.request, timeoutMs = MAX_DURATION_MS } = {}) {
  if (typeof request !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DURATION_MS) throw failure('HY3_CONFIG');
  return { async *stream(input) {
    const { messages, signal, maxTokens } = checkedInput(input);
    if (signal.aborted) throw failure('HY3_ABORTED');
    const config = checkedConfig(app);
    let activeRequest, activeResponse, stopped;
    const stop = code => {
      if (stopped) return;
      stopped = failure(code);
      // Destroy the actual socket/stream even while the consumer is paused at
      // yield; cancelling only a Promise or one SDK tee branch is insufficient.
      activeResponse?.destroy(stopped);
      activeRequest?.destroy(stopped);
    };
    const onAbort = () => stop('HY3_ABORTED');
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('HY3_TIMEOUT'), timeoutMs);
    timer.unref?.();
    const check = () => { if (stopped) throw stopped; if (signal.aborted) { stop('HY3_ABORTED'); throw stopped; } };
    const cleanupRequest = () => {
      activeResponse?.destroy();
      activeRequest?.destroy();
      activeResponse = activeRequest = undefined;
    };
    const post = async (url, headers, data) => {
      check();
      const body = JSON.stringify(data);
      return new Promise((resolve, reject) => {
        activeRequest = request(url, { method: 'POST', agent: false, headers: { ...headers,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
          activeResponse = response;
          // A cancellation between headers and iterator attachment must not
          // surface an unhandled stream error containing request details.
          response.on('error', () => {});
          if (stopped) { response.destroy(stopped); reject(stopped); return; }
          if (response.statusCode !== 200) {
            response.destroy(); reject(failure('HY3_UPSTREAM')); return;
          }
          resolve(response);
        });
        activeRequest.on('error', () => reject(stopped || failure('HY3_UPSTREAM')));
        if (stopped || signal.aborted) { stop('HY3_ABORTED'); activeRequest.destroy(stopped); reject(stopped); return; }
        activeRequest.end(body);
      });
    };

    try {
      const sdk = sdkSigning();
      const urlFor = path => sdk.buildCommonOpenApiUrlWithPath({ envId: config.envName, region: config.region, path });
      // Match the SDK's SCF source tag without its optional metadata HTTP probe.
      const runEnvTag = process.env.TENCENTCLOUD_RUNENV === 'SCF' ? 'scf' : 'unknown';
      const tokenURL = urlFor(TOKEN_PATH);
      const tokenData = { grant_type: 'client_credentials' };
      const signer = new sdk.TcbOpenApiHttpCommonRequester({ config, method: 'POST', url: tokenURL,
        data: tokenData, headers: { 'Content-Type': 'application/json' }, opts: { runEnvTag } });
      // Reuses the SDK's on-demand SCF identity; its preparation is local because
      // cross-account callbacks are rejected above. No getClientCredential()
      // network call is left running in the stock, non-cancellable adapter.
      await sdk.prepareCredentials.call(signer);
      check();
      const authResponse = await post(tokenURL, signer.buildHeaders('POST', tokenURL), tokenData);
      const authChunks = [];
      let authBytes = 0;
      for await (const chunk of authResponse) {
        check(); authBytes += chunk.length;
        if (authBytes > MAX_AUTH_BYTES) throw failure('HY3_LIMIT');
        authChunks.push(chunk);
      }
      check();
      const token = tokenFromBody(Buffer.concat(authChunks));
      cleanupRequest();
      const modelURL = urlFor(MODEL_PATH);
      const modelData = { model: 'hy3', stream: true, messages, max_tokens: maxTokens,
        temperature: 0.2, enable_thinking: false };
      const modelSigner = new sdk.TcbOpenApiHttpCommonRequester({ config: signer.config, method: 'POST', url: modelURL,
        data: modelData, token, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        opts: { runEnvTag } });
      const response = await post(modelURL, modelSigner.buildHeaders('POST', modelURL), modelData);
      if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers['content-type'] || '') ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) throw failure('HY3_PROTOCOL');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '', bytes = 0, textBytes = 0;
      for await (const chunk of response) {
        check(); bytes += chunk.length;
        if (bytes > MAX_STREAM_BYTES) throw failure('HY3_LIMIT');
        pending += decoder.decode(chunk, { stream: true });
        // Normalize CRLF only when the LF has arrived (including split chunks).
        pending = pending.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          check();
          if (boundary > MAX_EVENT_CHARS) throw failure('HY3_LIMIT');
          const result = parseEvent(pending.slice(0, boundary));
          pending = pending.slice(boundary + 2);
          if (result.done) return;
          if (result.text) {
            textBytes += Buffer.byteLength(result.text);
            if (textBytes > MAX_TEXT_BYTES) throw failure('HY3_LIMIT');
            yield result.text;
          }
        }
        if (pending.length > MAX_EVENT_CHARS) throw failure('HY3_LIMIT');
      }
      check(); decoder.decode();
      // An EOF without [DONE] is incomplete, even if some text was delivered.
      throw failure('HY3_PROTOCOL');
    } catch (error) {
      if (stopped) throw stopped;
      if (typeof error?.code === 'string' && /^HY3_(CONFIG|INPUT|UPSTREAM|PROTOCOL|LIMIT)$/.test(error.code)) throw error;
      // Never expose a provider response, SDK signing error, URL or credential.
      throw failure('HY3_UPSTREAM');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      cleanupRequest();
    }
  } };
}

module.exports = { createHy3Stream };
