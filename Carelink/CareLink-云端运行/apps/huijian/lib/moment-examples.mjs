import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const idPattern = /^[A-Za-z0-9_-]{1,96}$/;
const mediaTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg']);
const fail = status => Object.assign(new Error('example_unavailable'), { status });

// The publication bundle is exported from a dedicated account by an operator.
// It contains only explicitly selected public examples, never login credentials.
export function validateExampleCatalog(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.examples) || value.examples.length > 30) throw fail(503);
  const seen = new Set();
  for (const example of value.examples) {
    if (!idPattern.test(example.id) || seen.has(example.id) || typeof example.title !== 'string' ||
        typeof example.notice !== 'string' || !Array.isArray(example.photos) || !Array.isArray(example.messages)) throw fail(503);
    seen.add(example.id);
    const media = [...example.photos, ...example.messages.map(m => m.audio).filter(Boolean)];
    for (const item of media) if (!idPattern.test(item.mediaId) || !mediaTypes.has(item.mimeType)) throw fail(503);
  }
  return value;
}

export function publicExample(example) {
  const media = item => ({ mediaId: item.mediaId, mimeType: item.mimeType,
    url: `/api/moment-examples/${example.id}/media/${item.mediaId}` });
  return { id: example.id, title: example.title, notice: example.notice,
    author: { name: 'UNSEEN 示例', username: 'unseen_demo' },
    photos: example.photos.map(p => ({ ...media(p), id: p.id, name: p.name })),
    messages: example.messages.map(m => ({ id: m.id, role: m.role, text: m.text, photoId: m.photoId,
      ...(m.audio ? { audio: { ...media(m.audio), duration: m.audio.duration } } : {}) })) };
}

export function createMomentExamplesHttp({ directory = process.env.MOMENT_EXAMPLES_DIRECTORY, presentation } = {}) {
  return async (req, res, pathname) => {
    if (pathname !== '/api/moment-examples' && !pathname.startsWith('/api/moment-examples/')) return false;
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') { json(405, { error: 'method_not_allowed' }); return true; }
    if (!directory) { json(pathname === '/api/moment-examples' ? 200 : 404, pathname === '/api/moment-examples' ? { examples: [] } : { error: 'example_unavailable' }); return true; }
    try {
      if ((await stat(join(directory, 'catalog.json'))).size > 2 * 1024 * 1024) throw fail(503);
      const catalog = validateExampleCatalog(JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8')));
      if (pathname === '/api/moment-examples') {
        const visible=presentation?await presentation.examples(catalog.examples):catalog.examples;
        json(200, { examples: visible.map(source => { const e = publicExample(source); return {
          id: e.id, title: e.title, notice: e.notice, author: e.author, photoCount: e.photos.length,
          coverPhotoUrl: e.photos[0]?.url, preview: e.messages.find(m => m.role === 'user')?.text || '',featured:!!source.featured,sortRank:source.sortRank||0
        }; }) }); return true;
      }
      const match = pathname.match(/^\/api\/moment-examples\/([A-Za-z0-9_-]{1,96})(?:\/media\/([A-Za-z0-9_-]{1,96}))?$/);
      const example = match && catalog.examples.find(e => e.id === match[1]);
      if (!example) throw fail(404);
      if (presentation&&!await presentation.exampleVisible(example.id)) throw fail(404);
      if (!match[2]) { json(200, { example: publicExample(example) }); return true; }
      const media = [...example.photos, ...example.messages.map(m => m.audio).filter(Boolean)].find(m => m.mediaId === match[2]);
      if (!media) throw fail(404);
      const path = join(directory, 'media', media.mediaId);
      if ((await stat(path)).size > 12 * 1024 * 1024) throw fail(503);
      const bytes = await readFile(path);
      if (presentation&&!await presentation.exampleVisible(example.id)) throw fail(404);
      res.writeHead(200, { 'content-type': media.mimeType, 'content-length': bytes.length, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "default-src 'none'; sandbox" });
      res.end(bytes);
    } catch (error) { json(error.status || 503, { error: 'example_unavailable' }); }
    return true;
  };
}
