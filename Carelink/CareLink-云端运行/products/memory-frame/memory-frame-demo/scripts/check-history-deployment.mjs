// Read-only content verification against the existing test family. Never registers,
// creates a family, uploads, edits, imports a model, or prints authentication data.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = 'https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentialsPath = process.argv[2];
if (!credentialsPath) throw new Error('Provide the local private account file path.');
const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
assert.equal(new URL(credentials.familyUrl).origin, origin, 'Unexpected account destination');
assert.equal(credentials.accounts.length, 2, 'Expected the existing two test accounts');
const sessions = [];
const result = { timestamp: new Date().toISOString(), origin, evidence: 'HTTP and downloaded static bytes; no browser, microphone or GPU interaction', accounts: [], staticFiles: [], newFamilies: 0, contentWrites: 0 };

async function request(action, data = {}, token, status = 200) {
  const response = await fetch(origin + '/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ action, data }), signal: AbortSignal.timeout(45000)
  });
  assert.equal(response.status, status, action + ' status');
  return response.json();
}
const compare = (a, b) => a.createdAt - b.createdAt || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let failed = false;
try {
  const healthResponse = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(30000) });
  assert.equal(healthResponse.status, 200, 'Health status');
  const health = await healthResponse.json();
  assert.equal(health.version, '0.4.2', 'Deployed history version');
  result.version = health.version;
  await request('history', {}, undefined, 401);
  let room, firstIds;
  for (const account of credentials.accounts) {
    const session = await request('login', { username: account.username, password: account.password });
    assert.ok(session.token, 'Login session');
    sessions.push(session);
    room ??= session.room;
    assert.equal(session.room, room, 'Both accounts reuse the same family');
    const state = await request('state', {}, session.token);
    assert.ok(state.messagePage, 'Pagination metadata');
    assert.ok(state.messages.length <= 150, 'Legacy window remains bounded');
    const all = [], cursors = new Set();
    let cursor, pages = 0;
    do {
      const page = await request('history', { ...(cursor ? { cursor } : {}), limit: 2 }, session.token);
      assert.ok(page.messages.length <= 2, 'Page limit');
      assert.equal(page.total, state.messagePage.total, 'Stable live content total');
      assert.deepEqual(page.messages.map(m => m._id), [...page.messages].sort(compare).map(m => m._id), 'Ascending page presentation');
      all.push(...page.messages);
      pages++;
      assert.ok(pages <= 151, 'Traversal terminates within the demo capacity');
      assert.equal(page.hasMore, Boolean(page.nextCursor), 'Cursor termination');
      if (page.nextCursor) {
        assert.ok(!cursors.has(page.nextCursor), 'Cursor advances');
        cursors.add(page.nextCursor);
      }
      cursor = page.nextCursor;
    } while (cursor);
    const ids = all.sort(compare).map(m => m._id);
    assert.equal(new Set(ids).size, ids.length, 'No duplicate history records');
    assert.equal(ids.length, state.messagePage.total, 'All visible records traversed');
    assert.deepEqual(state.messages.map(m => m._id), ids.slice(-150), 'Legacy window matches full history');
    if (firstIds) assert.deepEqual(ids, firstIds, 'Both accounts see the same history');
    firstIds ??= ids;
    const refreshed = await request('state', { historyIds: ids }, session.token);
    const merged = [...refreshed.messages, ...refreshed.historyMessages].sort(compare).map(m => m._id);
    assert.deepEqual(merged, ids, 'Loaded history refresh is complete and deduplicated');
    await request('history', { cursor: 'invalid-cursor' }, session.token, 400);
    await request('history', { limit: 151 }, session.token, 400);
    result.accounts.push({ role: session.role, records: ids.length, pages, historyRefreshed: true, invalidCursorRejected: true });
  }
  for (const file of ['index.html', 'app.js', 'family-experience.js', 'account-auth.js', 'style.css', 'spatial-viewer.js', 'spatial-viewer.css', 'spatial-download.mjs', 'spatial-viewer-navigation.mjs']) {
    const route = file === 'index.html' ? '/family' : '/' + file;
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, 'Static resource status');
    const remote = Buffer.from(await response.arrayBuffer());
    const local = await readFile(path.join(root, 'server/public', file));
    assert.equal(digest(remote), digest(local), 'Static bytes: ' + file);
    result.staticFiles.push({ file, sha256: digest(local), bytes: local.length });
  }
} catch (error) {
  failed = true;
  // Assertions use descriptive labels only; omit actual/expected values and
  // response bodies because those can contain record ids, media URLs or tokens.
  result.failure = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Network or verification operation failed';
} finally {
  result.testSessionsRevoked = 0;
  for (const session of sessions) {
    try {
      await request('logout', {}, session.token);
      await request('history', {}, session.token, 401);
      result.testSessionsRevoked++;
    } catch { failed = true; result.sessionCleanupFailed = true; }
  }
}
result.passed = !failed;
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv[3]) await writeFile(process.argv[3], output);
process.stdout.write(output);
process.exitCode = failed ? 1 : 0;
