// Existing-family HTTP verification of a configured on/off realtime release.
// Does not start a provider task, ask for a microphone, invoke a model or create content.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com';
const positional = [], options = new Map();
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--')) {
    const match = /^--realtime-enabled=(true|false)$/.exec(argument);
    assert.ok(match && !options.has('realtime'), 'Use --realtime-enabled=true or false once');
    options.set('realtime', match[1] === 'true');
  } else positional.push(argument);
}
assert.ok(positional.length >= 2 && positional.length <= 3, 'Pass the existing private account file, a result file and optional expected version');
const [accountPath, resultPath, version = '0.5.5'] = positional;
const expectedRealtimeEnabled = options.get('realtime') ?? false;
let privateContext;
try { privateContext = JSON.parse(await readFile(accountPath, 'utf8')); }
catch { throw Error('Cannot read the private account file.'); }
const accounts = privateContext.credentials || privateContext.accounts;
assert.equal(accounts?.length, 2, 'Use the existing two-account fixture');
if (privateContext.familyUrl) assert.equal(new URL(privateContext.familyUrl).origin, origin, 'Existing account destination');
const sessions = [];
const expectedVersion = version;
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, 'Expected release version');
const evidence = { checkedAt: new Date().toISOString(), origin, expectedVersion, expectedRealtimeEnabled,
  checks: [], staticFiles: [], newFamilies: 0, contentWrites: 0, modelCalls: 0, realtimeStarts: 0,
  browserClicks: false, microphoneSpeakerCameraVerified: false, realtimeTransportVerified: false, sessionsRevoked: 0 };
let stage = 'health';
const hash = data => createHash('sha256').update(data).digest('hex');
const allowed = new Set(['login', 'logout', 'state', 'aiCapabilities', 'aiRealtimeCapabilities', 'callCapabilities']);
async function api(action, data = {}, token, expectedStatus = 200) {
  assert.ok(allowed.has(action), 'Read-only verification action allowlist');
  const response = await fetch(origin + '/api', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ action, data }) });
  assert.equal(response.status, expectedStatus, 'API response status');
  return response.json();
}
const realtimeSources = ['https://*.rtc.qq.com', 'wss://*.rtc.qq.com', 'https://*.webrtc.qq.com', 'wss://*.webrtc.qq.com',
  'https://*.rtc.qcloud.com', 'wss://*.rtc.qcloud.com', 'https://*.cloud-rtc.com', 'wss://*.cloud-rtc.com',
  'https://*.cloud-rtc.net', 'wss://*.cloud-rtc.net', 'https://*.my-imcloud.com', 'wss://*.my-imcloud.com',
  'https://*.rtc-web.com', 'wss://*.rtc-web.com', 'https://*.rtc-web.io', 'wss://*.rtc-web.io',
  'https://yun.tim.qq.com', 'https://web.sdk.qcloud.com'];
function directive(header, name) {
  const matches = header.split(';').map(value => value.trim().split(/\s+/)).filter(tokens => tokens[0] === name);
  assert.equal(matches.length, 1, 'Exactly one required CSP directive');
  return matches[0].slice(1).sort();
}
async function checkFile(name, route = '/' + name, pinned = null) {
  const response = await fetch(origin + route, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, 'Static resource status');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), hash(await readFile(path.join(root, 'server/public', name))), 'Static resource digest');
  if (pinned) { assert.equal(bytes.length, pinned.bytes, 'Pinned camera asset size'); assert.equal(hash(bytes), pinned.sha256, 'Pinned camera asset digest'); }
  if (/\.(js|mjs)$/.test(name)) assert.match(response.headers.get('content-type'), /javascript/);
  if (name === 'index.html') {
    const cacheDirectives = (response.headers.get('cache-control') || '').toLowerCase().split(',').map(value => value.trim());
    assert.ok(cacheDirectives.includes('no-store'), 'HTML must forbid storage; the cloud gateway may append stricter directives');
    assert.match(bytes.toString(), /src="\/frame-camera\.js(?:[?"])/, 'Camera opt-in module is deployed');
    assert.match(bytes.toString(), /src="\/frame-presentation\.js(?:[?"])/, 'Manual frame navigation module is deployed');
    const policy = new Map((response.headers.get('permissions-policy') || '').split(',').map(value => {
      const match = /^\s*([a-z-]+)\s*=\s*\(([^)]*)\)\s*$/.exec(value);
      assert.ok(match, 'Valid permissions policy'); return [match[1], match[2].trim()];
    }));
    assert.equal(policy.get('microphone'), 'self');
    assert.equal(policy.get('camera'), route === '/frame' ? 'self' : '', 'Camera is scoped to the explicit frame page');
    const csp = response.headers.get('content-security-policy') || '';
    assert.deepEqual(directive(csp, 'connect-src'), ["'self'", 'blob:', ...(expectedRealtimeEnabled ? realtimeSources : [])].sort(), 'CSP matches expected realtime state');
    assert.deepEqual(directive(csp, 'script-src'), ["'self'", "'wasm-unsafe-eval'"].sort(), 'Camera WASM is allowed without unsafe scripts');
    assert.deepEqual(directive(csp, 'worker-src'), ["'self'", 'blob:'].sort(), 'Camera worker remains local');
    evidence.checks.push({ check: 'document-policy', route, cameraAllowed: route === '/frame', realtimeConnectionsAllowed: expectedRealtimeEnabled });
  }
  evidence.staticFiles.push({ file: name, route, bytes: bytes.length, sha256: hash(bytes) });
}
try {
  const response = await fetch(origin + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200); const health = await response.json();
  assert.equal(health.version, evidence.expectedVersion); assert.equal(health.storage, 'cloudbase');
  evidence.version = health.version; evidence.checks.push('health-version');
  stage = 'static-resources';
  const entry = await readFile(path.join(root, 'server/public/index.html'), 'utf8');
  const linked = [...entry.matchAll(/(?:src|href)="(\/[^"?#]+)(?:[?#][^"]*)?"/g)].map(match => match[1].slice(1)).filter(name => /\.(?:js|mjs|css)$/.test(name));
  const cameraRoot = 'assets/mediapipe-face/1.0.1/';
  const manifest = JSON.parse(await readFile(path.join(root, 'server/public', cameraRoot, 'manifest.json'), 'utf8'));
  const assets = Object.entries(manifest);
  assert.ok(assets.length >= 4 && assets.length <= 12, 'Bounded pinned local camera assets');
  for (const [name, metadata] of assets) {
    assert.match(name, /^[a-zA-Z0-9_.-]+$/, 'Local camera asset filename');
    assert.ok(Number.isSafeInteger(metadata.bytes) && metadata.bytes > 0 && /^[a-f0-9]{64}$/.test(metadata.sha256), 'Pinned camera asset metadata');
  }
  await Promise.all(['/family', '/frame'].map(route => checkFile('index.html', route)));
  const files = [...new Set([...linked, 'app.js', 'frame-presentation.js', 'frame-presentation.css', 'frame-camera.js',
    'camera-presence.mjs', 'camera-adapters.mjs', 'camera-face-detector.mjs', 'camera-face-worker.js', 'presence-invitation.js',
    cameraRoot + 'manifest.json', 'vendor/trtc-5.19.2.mjs'])];
  for (let i = 0; i < files.length; i += 4) await Promise.all(files.slice(i, i + 4).map(name => checkFile(name)));
  for (const [name, metadata] of assets) await checkFile(cameraRoot + name, '/' + cameraRoot + name, metadata);
  stage = 'authentication-and-capabilities';
  await api('aiRealtimeCapabilities', {}, undefined, 401);
  for (const account of accounts) {
    const session = await api('login', { username: account.username, password: account.password });
    assert.ok(session.token); sessions.push(session); assert.equal(session.room, sessions[0].room);
    const [realtime, conversation, familyCall, state] = await Promise.all([
      api('aiRealtimeCapabilities', {}, session.token), api('aiCapabilities', {}, session.token),
      api('callCapabilities', {}, session.token), api('state', {}, session.token)
    ]);
    assert.equal(realtime.enabled, expectedRealtimeEnabled); assert.equal(realtime.provider, 'tencent-trtc');
    assert.equal(conversation.text, true); assert.equal(conversation.vision, true);
    assert.equal(familyCall.enabled, false); assert.equal(familyCall.audioCall, false);
    evidence.checks.push({ check: 'existing-family-capabilities', role: session.role,
      realtimeEnabled: realtime.enabled, text: conversation.text, vision: conversation.vision,
      messageCount: state.messagePage.total });
  }
  const states = evidence.checks.filter(check => check?.check === 'existing-family-capabilities');
  assert.equal(states[0].messageCount, states[1].messageCount);
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.failure = { stage, reason: error instanceof assert.AssertionError ? 'Assertion did not match expected release behavior' : 'Network or verification failure' };
} finally {
  for (const session of sessions) {
    try { await api('logout', {}, session.token); await api('aiRealtimeCapabilities', {}, session.token, 401); evidence.sessionsRevoked++; }
    catch { evidence.passed = false; evidence.sessionCleanupFailed = true; }
  }
}
evidence.staticFiles.sort((a, b) => a.file.localeCompare(b.file) || a.route.localeCompare(b.route));
const report = JSON.stringify(evidence, null, 2) + '\n';
await writeFile(resultPath, report); process.stdout.write(report);
process.exitCode = evidence.passed ? 0 : 1;
