// Explicit operator publication: create missing demo records, then export only
// these selected IDs from the authenticated server. Existing edits stay intact.
// Usage: node tools/publish-moment-examples.mjs ORIGIN CREDENTIAL_FILE OUTPUT_DIR
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { validateExampleCatalog } from '../lib/moment-examples.mjs';
const [origin, credentialPath, output] = process.argv.slice(2);
assert(origin && credentialPath && output, 'ORIGIN CREDENTIAL_FILE OUTPUT_DIR required');
const credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
assert.equal(credentials.username, 'unseen_demo', 'publication requires the dedicated demo account');
const source = await readFile(new URL('../public/unseen-app-cases.js', import.meta.url), 'utf8');
const photos = JSON.parse(source.match(/const PHOTO_FILES = (\[[\s\S]*?\n\]);/)[1]);
const entries = JSON.parse(source.match(/const BOOK_ENTRIES = (\[[\s\S]*?\n\]);/)[1]);
const specs = [
  { id: 'demo-summer-toast', title: '夏夜，碰杯以后', photoIds: ['photo-cheers', 'photo-table-detail'] },
  { id: 'demo-birthday-candles', title: '蜡烛亮起来的时候', photoIds: ['photo-cake', 'photo-laughing'] },
  { id: 'demo-one-more-dance', title: '散场前，再跳一支', photoIds: ['photo-group-back', 'photo-dancing'] }
];
const cookies = new Map();let accountId;
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(45000),
    headers: { origin, 'content-type': 'application/json', 'idempotency-key': randomUUID(),
      cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...(accountId ? { 'x-unseen-expected-account-id': accountId } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  for (const line of response.headers.getSetCookie()) { const [name, ...value] = line.split(';')[0].split('=');cookies.set(name, value.join('=')); }
  return response;
}
async function json(path, method, body) {
  const response = await request(path, method, body);const data = await response.json();
  assert.equal(response.status, 200, `${path}: ${response.status} ${JSON.stringify(data.error)}`);return data;
}
const login = await json('/v1/auth/password-login', 'POST', { username: credentials.username, password: credentials.password });
accountId = login.accountId;
if (credentials.accountId) assert.equal(accountId, credentials.accountId);
await mkdir(join(output, 'media'), { recursive: true });
try {
  const catalog = { schemaVersion: 1, publishedAt: new Date().toISOString(), examples: [] }, receipt = [];
  for (const spec of specs) {
    let response = await request(`/v1/moments/${spec.id}`);let created = false;
    if (response.status === 404) {
      const date = '2026-07-18T10:32:00.000Z', moment = { id: spec.id, title: spec.title, createdAt: date, updatedAt: date,
        status: 'complete', preferences: { photoMode: 'clear' }, context: {}, photos: [], messages: [] };
      for (const photoId of spec.photoIds) {
        const p = photos.find(p => p.photoId === photoId), bytes = await readFile(new URL(`../photos/${p.file}`, import.meta.url));
        const mediaId = 'demo-' + photoId;
        await json(`/v1/moment-media/${mediaId}`, 'PUT', { kind: 'photo', name: p.label, mimeType: 'image/jpeg', dataBase64: bytes.toString('base64') });
        moment.photos.push({ id: photoId, mediaId, originalMediaId: mediaId, url: `/v1/moment-media/${mediaId}`, name: p.label });
        for (const [i, entry] of entries.filter(e => e.photoId === photoId).entries()) {
          for (const role of ['assistant', 'user']) moment.messages.push({ id: `${photoId}-${i}-${role}`, role,
            text: role === 'assistant' ? entry.question : entry.answer, photoId, createdAt: `2026-07-18T${entry.time}:00+08:00` });
        }
      }
      await json(`/v1/moments/${spec.id}`, 'PUT', { expectedVersion: 0, moment });created = true;
    } else assert.equal(response.status, 200, 'existing demo must be readable');
    // Export a fresh server read, not the seed object; account edits are preserved.
    const { moment, version } = await json(`/v1/moments/${spec.id}`);
    const example = { id: moment.id, title: moment.title, notice: 'AI 示例图片与虚构对话，用来展示一段回忆如何留下。',
      photos: [], messages: moment.messages.map(({ id, role, text, photoId, audio }) => ({ id, role, text, photoId, ...(audio ? { audio: { mediaId: audio.mediaId, duration: audio.duration } } : {}) })) };
    const hashes = {};
    async function exportMedia(id) {
      assert.match(id, /^[A-Za-z0-9_-]{1,96}$/);
      const r = await request(`/v1/moment-media/${id}`);assert.equal(r.status, 200);
      const bytes = Buffer.from(await r.arrayBuffer());await writeFile(join(output, 'media', id), bytes);
      hashes[id] = createHash('sha256').update(bytes).digest('hex');return r.headers.get('content-type').split(';')[0];
    }
    for (const p of moment.photos) example.photos.push({ id: p.id, mediaId: p.mediaId, name: p.name, mimeType: await exportMedia(p.mediaId) });
    for (const m of example.messages) if (m.audio) m.audio.mimeType = await exportMedia(m.audio.mediaId);
    catalog.examples.push(example);receipt.push({ id: spec.id, version, created, photos: example.photos.length, messages: example.messages.length, mediaSha256: hashes });
  }
  validateExampleCatalog(catalog);
  await writeFile(join(output, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  const result = { at: catalog.publishedAt, account: credentials.username, accountId, examples: receipt, source: 'public/unseen-app-cases.js historic fictional demonstration', exportedFromServerRead: true };
  await writeFile(join(output, 'publication-receipt.json'), JSON.stringify(result, null, 2) + '\n');console.log(JSON.stringify(result));
} finally { await json('/v1/auth/logout', 'POST', {}); }
