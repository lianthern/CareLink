// Existing-family content reads only; no create/register/send/upload/import actions.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { downloadSpatialAsset } from '../server/public/spatial-download.mjs';

const origin = 'https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com';
const [privateContext, output] = process.argv.slice(2);
if (!privateContext || !output) throw new Error('Provide the private acceptance-context path and a sanitized report output path.');
const context = JSON.parse(await readFile(privateContext, 'utf8'));
assert.equal(context.credentials?.length, 2, 'Expected two existing accounts');
const allowed = new Set(['login', 'logout', 'state', 'spatialAsset']);
const sessions = [], result = { timestamp: new Date().toISOString(), origin, evidence: 'cloud HTTP and actual viewer download module; no cloud browser or GPU test', newFamilies: 0, contentWrites: 0, accounts: [], testSessionsRevoked: 0 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let phase = 'health';
async function request(action, data = {}, token, expected = 200) {
  assert.ok(allowed.has(action));
  const response = await fetch(origin + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ action, data }), signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, expected, action + ' status');
  return response.json();
}
const contentDigest = state => hash(JSON.stringify(state.messages.map(m => ({ id: m._id, type: m.type, text: m.text, image: m.image, audio: m.audio, link: m.link, editedText: m.editedText, updatedAt: m.updatedAt, spatialDigest: m.spatial?.digest })).sort((a, b) => a.id.localeCompare(b.id))));
try {
  const health = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(30000) });
  assert.equal(health.status, 200); result.version = (await health.json()).version;
  let room, firstContent;
  for (const credential of context.credentials) {
    phase = 'login';
    const session = await request('login', { username: credential.username, password: credential.password }); sessions.push(session);
    room ??= session.room; assert.equal(session.room, room, 'Same existing family');
    phase = 'state'; const before = await request('state', {}, session.token);
    const snapshot = contentDigest(before); firstContent ??= snapshot; assert.equal(snapshot, firstContent, 'Both accounts see identical content');
    const message = before.messages.find(m => m.spatial?.status === 'ready');
    assert.ok(message, 'Existing ready model required; never create a replacement');
    phase = 'asset'; const asset = await request('spatialAsset', { id: message._id }, session.token);
    assert.equal(asset.chunkBytes, 4194304);
    phase = 'download'; const downloaded = await downloadSpatialAsset(asset, { baseURL: origin, signal: AbortSignal.timeout(90000), refreshAsset: () => request('spatialAsset', { id: message._id }, session.token) });
    assert.equal(downloaded.buffer.byteLength, asset.bytes); assert.equal(hash(Buffer.from(downloaded.buffer)), asset.digest);
    phase = 'content-check'; const after = await request('state', {}, session.token); assert.equal(contentDigest(after), snapshot, 'Content unchanged');
    result.accounts.push({ role: session.role, messages: before.messages.length, bytes: asset.bytes, digest: asset.digest, segments: Math.ceil(asset.bytes / asset.chunkBytes), contentUnchanged: true });
  }
  result.passed = true;
} catch {
  result.passed = false; result.failedPhase = phase; process.exitCode = 1;
} finally {
  for (const session of sessions) {
    try { await request('logout', {}, session.token); await request('state', {}, session.token, 401); result.testSessionsRevoked++; }
    catch { result.passed = false; result.cleanupFailed = true; process.exitCode = 1; }
  }
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
