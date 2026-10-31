import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatCompletionsAdapter, createMomentProviders, createTranscriptionAdapter, normalizeMomentChatResult, validateMomentAudio } from '../lib/moment-provider.mjs';
import { momentTurn } from '../lib/moment-context.mjs';
const input = momentTurn({ photo: { id: 'p1', dataUrl: 'data:image/jpeg;base64,YWJj' }, messages: [{ id: 'u1', role: 'user', text: '这是杭州。', photoId: 'p1' }] });
const completion = (content, rest = {}) => Response.json({ choices: [{ message: { content }, ...rest }] });

test('vendor interchange retains the same app contract and keeps the uploaded clear image unchanged', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, ...options, body: JSON.parse(options.body) }); return completion('杭州那次，你最想留下什么？'); };
  const mini = createMomentProviders({ env: { MINIMAX_BASE_URL: 'http://127.0.0.1:4000' }, minimaxKey: 'secret-fixture', fetchImpl }).chat;
  const replacement = createMomentProviders({ env: { MOMENT_CHAT_ADAPTER: 'openai-compatible', MOMENT_CHAT_BASE_URL: 'https://vendor.example/v1', MOMENT_CHAT_API_KEY: 'not-a-real-vendor-fixture', MOMENT_CHAT_MODEL: 'vision-model', MOMENT_CHAT_TOKEN_PARAMETER: 'max_tokens' }, fetchImpl }).chat;
  assert.deepEqual(Object.keys(await mini.complete(input)), Object.keys(await replacement.complete(input)));
  assert.equal(calls[0].body.thinking.type, 'disabled');
  assert.equal(calls[1].body.thinking, undefined);
  assert.equal(calls[1].body.max_tokens, 900);
  assert.equal(calls[1].body.max_completion_tokens, undefined);
  for (const call of calls) {
    assert.equal(call.body.messages.at(-1).content.at(-1).image_url.url, input.photo.dataUrl);
    assert.equal(call.redirect, 'error');
    assert.doesNotMatch(JSON.stringify(call.body), /secret-fixture|not-a-real-vendor-fixture/);
    assert.ok(call.body.messages.some(m => m.role === 'user' && m.content.includes?.('杭州')));
  }
});

test('MiniMax thinking is removed, incomplete replies and reasoning-only responses fail visibly', async () => {
  const make = fetchImpl => createChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'https://vendor.example/v1', model: 'vision', fetchImpl });
  assert.equal((await make(async () => completion('<think>Internal analysis</think>那天的雨，你还记得吗？')).complete(input)).text, '那天的雨，你还记得吗？');
  await assert.rejects(make(async () => completion('<think>unfinished')).complete(input), { code: 'provider_reply_invalid' });
  await assert.rejects(make(async () => completion('unfinished', { finish_reason: 'length' })).complete(input), { code: 'provider_reply_incomplete' });
  await assert.rejects(make(async () => completion('x'.repeat(300000))).complete(input), { code: 'provider_unavailable' });
  await assert.rejects(make(async () => new Response('secret vendor body', { status: 429 })).complete(input), { code: 'provider_rate_limited', status: 429 });
});

test('caller abort closes chat and timeout maps to a retryable failure', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const adapter = createChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'https://vendor.example/v1', model: 'vision', timeoutMs: 30, fetchImpl });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(adapter.complete(input), { code: 'provider_timeout', status: 504 });
    await assert.rejects(adapter.complete({ ...input, signal: AbortSignal.abort() }), { code: 'request_aborted' });
  } finally { clearTimeout(keepAlive); }
});

test('ASR is opt-in and unsupported adapter/configuration never masquerades as available', () => {
  assert.equal(createMomentProviders({ env: {}, minimaxKey: 'test' }).transcription, null);
  assert.equal(createMomentProviders({ env: { MOMENT_CHAT_ADAPTER: 'anthropic', MOMENT_CHAT_API_KEY: 'test' } }).chat, null);
  assert.equal(createMomentProviders({ env: { MOMENT_CHAT_ADAPTER: 'openai-compatible', MOMENT_CHAT_API_KEY: 'test', MOMENT_CHAT_BASE_URL: 'http://external.example/v1', MOMENT_CHAT_MODEL: 'vision' } }).chat, null);
});

test('ASR encodes real audio multipart and does not fabricate a transcript for empty recognition', async () => {
  const audio = validateMomentAudio({ audio: { dataUrl: 'data:audio/webm;codecs=opus;base64,YWJj', durationMs: 2200 }, language: 'zh' });
  let sent;
  const adapter = createTranscriptionAdapter({ apiKey: 'test', baseUrl: 'https://asr.example/v1', model: 'transcribe-model', fetchImpl: async (url, options) => { sent = { url, ...options }; return Response.json({ text: '那天是一个雨天。' }); } });
  assert.equal((await adapter.transcribe(audio)).text, '那天是一个雨天。');
  assert.equal(sent.url, 'https://asr.example/v1/audio/transcriptions');
  assert.equal(sent.body.get('model'), 'transcribe-model');
  assert.equal(sent.body.get('language'), 'zh');
  assert.equal(sent.body.get('file').name, 'voice.webm');
  assert.deepEqual(Buffer.from(await sent.body.get('file').arrayBuffer()), Buffer.from('abc'));
  const empty = createTranscriptionAdapter({ apiKey: 'test', baseUrl: 'https://asr.example/v1', model: 'transcribe-model', fetchImpl: async () => Response.json({ text: '' }) });
  await assert.rejects(empty.transcribe(audio), { code: 'speech_not_recognized', status: 422 });
  assert.throws(() => validateMomentAudio({ audio: { dataUrl: 'data:image/png;base64,YWJj' } }), { code: 'audio_format_unsupported' });
});

test('real canary regression: initial dinner premise fails, provider text envelopes never become UI JSON', async () => {
  const make = text => createChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'https://vendor.example/v1', model: 'vision', fetchImpl: async () => completion(text) });
  await assert.rejects(make('像是专门为某顿晚饭摆好的。这顿饭是什么时候、和谁一起吃的呀？').complete({ ...input, initial: true }), { code: 'provider_reply_unsupported' });
  const envelope = JSON.stringify({ sourceMessageId: 'a2', photoId: 'photo-1', text: '记下你的更正了。那盆花后来怎么样？' });
  assert.equal((await make(envelope).complete(input)).text, '记下你的更正了。那盆花后来怎么样？');
  assert.equal((await make('{"text":"okay"}').complete(input)).text, 'okay');
  await assert.rejects(make('{"sourceMessageId":"a2"}').complete(input), { code: 'provider_reply_invalid' });
});

test('one model response yields visible reply plus bounded suggestions and tolerates a broken suggestions envelope', async () => {
  const structured = JSON.stringify({ text: '你还记得照片里的人吗？', suggestions: [
    { label: '聊聊人物', text: '我可以说说我记得的人。' },
    { label: '关系不确定', text: '我不太确定人物关系。' },
    { label: '换个方向', text: '我想先聊当时发生了什么。' }
  ] });
  const adapter = createChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'https://vendor.example/v1', model: 'vision', fetchImpl: async () => completion(`\`\`\`json\n${structured}\n\`\`\``) });
  const result = await adapter.complete(input);
  assert.equal(result.text, '你还记得照片里的人吗？');
  assert.equal(result.suggestions.length, 3);
  assert.doesNotMatch(result.text, /suggestions|```|\{"text"/u);

  const malformed = '{"text":"你想从哪里讲起？","suggestions":[broken json';
  assert.deepEqual(normalizeMomentChatResult(malformed), { text: '你想从哪里讲起？', suggestions: [] });
  assert.deepEqual(normalizeMomentChatResult(`结果：${malformed}`), { text: '你想从哪里讲起？', suggestions: [] });
  assert.deepEqual(normalizeMomentChatResult('旧 provider 的纯文本回复。'), { text: '旧 provider 的纯文本回复。', suggestions: [] });
});

test('the visible reply limit is independent from structured envelope overhead', () => {
  const text = '回'.repeat(1400);
  const suggestions = [
    { label: '继续细节', text: '我想从另一个细节说起。' },
    { label: '讲讲经过', text: '我可以先讲我记得的经过。' },
    { label: '记忆模糊', text: '我现在只记得一些片段。' },
    { label: '说说感受', text: '我可以说说当时的感受。' }
  ];
  const envelope = JSON.stringify({ text, suggestions });
  assert.ok(envelope.length > 1500);
  const result = normalizeMomentChatResult(envelope);
  assert.equal(result.text, text); assert.equal(result.suggestions.length, 4);
});
