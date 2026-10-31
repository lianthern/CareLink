// Existing-family AI smoke checks. Never confirms actions, contacts a person,
// creates a family, uploads media, or changes model/billing configuration.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com';
const expectedVersion = process.argv[4] || '0.4.4';
const textOnly = process.argv.includes('--text-only');
if (!process.argv[2]) throw new Error('Provide the existing private account file path.');
let credentials;
try { credentials = JSON.parse(await readFile(process.argv[2], 'utf8')); }
catch { throw new Error('Cannot read the private account file.'); }
assert.equal(new URL(credentials.familyUrl).origin, origin, 'Account destination');
assert.equal(credentials.accounts?.length, 2, 'Existing two-account fixture');

const allowed = new Set(['login', 'logout', 'state', 'history', 'aiCapabilities', 'aiChat', 'callCapabilities']);
const sessions = [], privateReplies = [];
const result = { timestamp: new Date().toISOString(), origin, expectedVersion,
  evidence: 'Cloud HTTP/static checks; actual model attempts recorded below; no browser or microphone interaction',
  newFamilies: 0, contentWrites: 0, confirmedActions: 0, contactRequests: 0,
  modelRequestsAttempted: 0, checks: [], staticFiles: [], testSessionsRevoked: 0,
  scope: textOnly ? 'text-and-message-candidates; vision unavailable pending provider decision' : 'text-and-vision',
  visionVerified: false,
  modelOutputHumanReviewed: false, browserVerified: false, realAudioCallVerified: false };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let stage = 'health', failed = false;
async function request(action, data = {}, token, status = 200) {
  assert.ok(allowed.has(action), 'Verification action allowlist');
  if (action === 'aiChat') {
    assert.ok(result.modelRequestsAttempted < 5, 'At most five model requests');
    result.modelRequestsAttempted++;
  }
  const response = await fetch(origin + '/api', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ action, data }), signal: AbortSignal.timeout(70000) });
  if (response.status !== status) {
    // Keep provider/application error bodies out of shared evidence and console.
    privateReplies.push({ stage, status: response.status, errorBody: (await response.text()).slice(0, 16000) });
    throw Object.assign(new Error('Unexpected HTTP status'), { httpStatus: response.status });
  }
  return response.json();
}
async function chat(label, data, token, expectedImages) {
  stage = label;
  const response = await request('aiChat', data, token);
  privateReplies.push({ stage, response });
  assert.equal(typeof response.answer, 'string', 'Structured answer');
  assert.ok(response.answer.trim(), 'Nonempty answer');
  assert.equal(response.source, 'ai', 'Model response source');
  assert.equal(response.confirmed, false, 'Model never authorizes an action');
  assert.equal(response.imageCount, expectedImages, 'Actual image input count');
  assert.equal(response.imageUsed, expectedImages > 0, 'Image input flag');
  result.checks.push({ check: label, imageCount: response.imageCount,
    answerCharacters: response.answer.length, answerSha256: digest(response.answer), actionKind: response.action?.kind || null });
  return response;
}
async function staticFile(file) {
  const response = await fetch(origin + (file === 'index.html' ? '/family' : '/' + file), { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, 'Static resource status');
  const remote = Buffer.from(await response.arrayBuffer()), local = await readFile(path.join(root, 'server/public', file));
  assert.equal(digest(remote), digest(local), 'Static resource bytes');
  if (file.endsWith('.woff2')) assert.match(response.headers.get('content-type') || '', /font\/woff2/, 'Font MIME');
  result.staticFiles.push({ file, bytes: local.length, sha256: digest(local) });
}
try {
  const healthResponse = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(30000) });
  assert.equal(healthResponse.status, 200, 'Health status');
  result.version = (await healthResponse.json()).version;
  assert.equal(result.version, expectedVersion, 'Deployed version');
  stage = 'static-files';
  const fontDir = 'assets/fonts/unseen-sans/';
  const manifest = JSON.parse(await readFile(path.join(root, 'server/public', fontDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.assets.length > 0 && manifest.assets.length <= 100, 'Bounded font manifest');
  const files = ['index.html', 'style.css', 'app.js', 'family-experience.js', 'account-auth.js',
    'ai-conversation.js', 'ai-conversation.css', 'ai-action-ui.js', 'ai-voice.js', 'family-contact.js', 'family-contact.css',
    'family-call.js', 'family-call.css',
    ...['fonts.css', 'LICENSE.txt', 'manifest.json', ...manifest.assets.map(asset => asset.file)].map(file => fontDir + file)];
  for (let i = 0; i < files.length; i += 4) await Promise.all(files.slice(i, i + 4).map(staticFile));
  const entry = await readFile(path.join(root, 'server/public/index.html'), 'utf8');
  assert.doesNotMatch(entry, /(?:src|href)="\/family-call\./, 'Real-time call entry stays deferred');
  stage = 'authorization';
  await request('aiCapabilities', {}, undefined, 401);
  await request('callCapabilities', {}, undefined, 401);
  for (const account of credentials.accounts) {
    const session = await request('login', { username: account.username, password: account.password });
    assert.ok(session.token, 'Login session'); sessions.push(session);
    assert.equal(session.room, sessions[0].room, 'Existing shared family');
  }
  const token = sessions[0].token;
  const caps = await request('aiCapabilities', {}, token);
  assert.equal(caps.verification, 'configuration-only', 'Capability evidence label');
  result.capabilities = { text: Boolean(caps.text), vision: Boolean(caps.vision), asr: Boolean(caps.asr), speechOutput: caps.speechOutput };
  assert.equal(caps.text, true, 'Text configured');
  assert.equal(caps.vision, !textOnly, textOnly ? 'Unavailable vision stays disabled' : 'Vision configured');
  const callCaps = await request('callCapabilities', {}, token);
  assert.equal(callCaps.audioCall, false, 'Real calls stay disabled without reviewed controlled TURN configuration');
  assert.equal(callCaps.enabled, false, 'No call service enabled by the deployment');
  result.callCapabilities = { enabled: callCaps.enabled, audioCall: callCaps.audioCall, reason: callCaps.reason };
  const before = await request('state', {}, token), beforeTotal = before.messagePage.total;
  const firstText = '今天想聊做饭。请记住这个话题，简单回一句，不要提出行动。';
  const first = await chat('ordinary-chat', { text: firstText }, token, 0);
  assert.equal(first.action, null, 'Ordinary conversation has no action');
  const followup = await chat('multi-turn-chat', { text: '我刚才说想聊什么？请只回答话题，不要提出行动。',
    history: [{ role: 'user', content: firstText }, { role: 'assistant', content: first.answer }] }, token, 0);
  assert.match(followup.answer, /做饭/, 'Prior conversation context');
  assert.equal(followup.action, null, 'Follow-up has no action');
  const intent = await chat('message-candidate-only', { text: '请给家人留一句话：“我晚上六点回家”。请准备待确认留言，尚不要发送。' }, token, 0);
  assert.equal(intent.action?.kind, 'message', 'Message intent candidate');
  assert.ok(intent.action.text.includes('我晚上六点回家'), 'User-provided message content');
  if (!textOnly) {
    const photos = before.messages.filter(message => message.image).slice(0, 2);
    assert.equal(photos.length, 2, 'Existing two-photo fixture; never upload or create fixtures');
    await chat('single-photo', { text: '请描述图片中实际能看清的内容；看不清就说明，不猜人物身份、关系或经历。',
      messageIds: [photos[0]._id], readPhoto: true }, token, 1);
    await chat('multiple-photos', { text: '请分别简述这两张图片中能看清的内容和可见差别；无法辨认就说明，不猜身份或经历。',
      messageIds: photos.map(message => message._id), readPhoto: true }, token, 2);
    result.visionVerified = true;
  }
  stage = 'read-only-outcome';
  const after = await request('state', {}, sessions[1].token);
  assert.equal(after.messagePage.total, beforeTotal, 'No message was published by the verification');
  result.checks.push({ check: stage, sharedRecordsBefore: beforeTotal, sharedRecordsAfter: after.messagePage.total });
} catch (error) {
  failed = true;
  result.failure = { stage, ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
    reason: error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Network or verification operation failed' };
} finally {
  for (const session of sessions) {
    try { await request('logout', {}, session.token); await request('aiCapabilities', {}, session.token, 401); result.testSessionsRevoked++; }
    catch { failed = true; result.sessionCleanupFailed = true; }
  }
}
await mkdir(path.join(root, '.tools'), { recursive: true });
await writeFile(path.join(root, '.tools/ai-model-verification-private.json'), JSON.stringify(privateReplies, null, 2) + '\n');
result.passed = !failed;
result.staticFiles.sort((a, b) => a.file.localeCompare(b.file));
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv[3]) await writeFile(process.argv[3], output);
process.stdout.write(output);
process.exitCode = failed ? 1 : 0;
