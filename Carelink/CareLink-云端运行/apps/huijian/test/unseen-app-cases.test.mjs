import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { CASES, list, get, renderGallery, renderDetail, bind } from '../public/unseen-app-cases.js';

test('official cases are immutable and all displayed local assets exist', async () => {
  assert.equal(list().length, 6);
  for (const item of CASES) {
    assert.ok(Object.isFrozen(item));
    assert.ok(item.source && item.limitations.length);
    for (const src of new Set([item.cover, ...item.media.map(m => m.src), item.space?.src, item.space?.depth].filter(Boolean))) {
      await access(new URL(src.startsWith('/photos/') ? `..${src}` : `../public${src}`, import.meta.url));
    }
  }
  assert.throws(() => { get('summer-gathering').media.push({ src: 'private.jpg' }); });
});

test('case details remain native and label fictional content and World input illustrations', () => {
  const gallery = renderGallery();
  for (const item of CASES) {
    assert.ok(gallery.includes(`data-case-id="${item.id}"`));
    const detail = renderDetail(item.id);
    assert.ok(detail.includes('只读'));
    assert.doesNotMatch(detail, /<iframe|href="https?:|data-upload|data-save/);
  }
  assert.match(renderDetail('summer-book'), /手写虚构示例|虚构示例/);
  assert.match(renderDetail('world-single-multi'), /不是城堡生成结果/);
  assert.match(renderDetail('unknown'), /没有找到/);
});

test('book reader reaches every historic question and answer, clamps both ends, and cleans up listeners', async () => {
  let handler;
  const page = { innerHTML: '' };
  const position = { textContent: '' };
  const previous = { dataset: { bookStep: '-1' }, disabled: true };
  const next = { dataset: { bookStep: '1' }, disabled: false };
  const root = {
    contains: () => true,
    addEventListener: (type, fn) => { if (type === 'click') handler = fn; },
    removeEventListener: (type, fn) => { if (type === 'click') { assert.equal(fn, handler); handler = null; } },
    querySelector: selector => ({ '[data-case-detail]': { dataset: { caseDetail: 'summer-book' } }, '[data-case-book-page]': page, '[data-book-position]': position })[selector],
    querySelectorAll: selector => selector === '[data-book-step]' ? [previous, next] : []
  };
  const cleanup = bind(root);
  function click(step) {
    const button = { dataset: { bookStep: String(step) }, hasAttribute: name => name === 'data-book-step' };
    handler({ target: { closest: () => button } });
  }
  click(-1);
  assert.equal(position.textContent, '1 / 14');
  const pages = [];
  for (let i = 1; i < 14; i++) { click(1); pages.push(page.innerHTML); }
  assert.equal(position.textContent, '14 / 14');
  assert.equal(next.disabled, true);
  click(1);
  assert.equal(position.textContent, '14 / 14');
  assert.equal(pages.filter(html => html.includes('<blockquote>')).length, 12);
  assert.ok(pages.some(html => html.includes('一杯是气泡水加了柠檬片')));
  assert.ok(pages.some(html => html.includes('早就脱在长桌底下了')));
  assert.ok(pages.every(html => !html.includes('undefined')));
  cleanup(); assert.equal(handler, null);
  const script = await readFile(new URL('../public/unseen-app-cases.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /localStorage|indexedDB|fetch\(|XMLHttpRequest|\/api\//);
});

test('space callback carries read-only identity and local panorama without selecting personal assets', () => {
  let handler; let received;
  const root = { contains: () => true, addEventListener: (type, fn) => { if (type === 'click') handler = fn; }, removeEventListener: () => {}, querySelector: selector => selector === '[data-case-detail]' ? { dataset: { caseDetail: 'summer-gathering' } } : null };
  bind(root, { onOpenSpace: value => { received = value; } });
  handler({ target: { closest: () => ({ hasAttribute: key => key === 'data-case-space' }) } });
  assert.equal(received.readOnly, true);
  assert.equal(received.caseId, 'summer-gathering');
  assert.equal(received.panorama, '/unseen-app-cases-assets/summer-panorama.jpg');
});

test('both completed World canaries are separate read-only viewer actions, never paid submissions', () => {
  const item = get('world-single-multi');
  assert.deepEqual(item.worlds.map(world => world.worldId), ['a6755a78-656b-4e3e-b78b-7eca5b903864', '585ed6bd-7c49-4460-aac0-104f878af2f1']);
  let handler; const calls = [];
  const root = { contains: () => true, addEventListener: (type, fn) => { if (type === 'click') handler = fn; }, removeEventListener: () => {}, querySelector: selector => selector === '[data-case-detail]' ? { dataset: { caseDetail: item.id } } : null };
  bind(root, { onOpenSpace: value => calls.push(value) });
  for (const index of [0,1]) handler({ target: { closest: () => ({ dataset: { caseWorld: String(index) }, hasAttribute: key => key === 'data-case-world' }) } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(value => value.readOnly && value.kind === 'world'));
  assert.equal(calls[1].worldId, item.worlds[1].worldId);
  for (const value of calls) {
    assert.equal(value.world.id, value.worldId);
    assert.equal(value.world.panoramaUrl, undefined);
    assert.equal(value.world.semantics, undefined);
    for (const url of Object.values(value.world.splats)) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://cdn.marble.worldlabs.ai');
      assert.ok(parsed.pathname.startsWith(`/${value.worldId}/`));
      assert.equal(parsed.search, '');
    }
  }
});

test('official photo selection survives unmount without requiring browser storage', () => {
  let handler;
  const scroll = { scrollTop: 287, addEventListener() {}, removeEventListener() {} };
  const image = {}; const caption = {};
  const root = { contains: () => true, addEventListener: (type, fn) => { if (type === 'click') handler = fn; }, removeEventListener() {},
    querySelector: selector => ({ '[data-case-detail]': { dataset: { caseDetail: 'summer-gathering' } }, '.screen': scroll, '[data-case-main-image]': image, '[data-case-caption]': caption })[selector], querySelectorAll: () => [] };
  const cleanup = bind(root, { onOpenSpace() {} });
  handler({ target: { closest: () => ({ dataset: { casePhoto: '1' }, hasAttribute: key => key === 'data-case-photo' }) } });
  cleanup();
  const reopened = renderDetail('summer-gathering');
  assert.match(reopened, /data-case-main-image src="\/photos\/photo2_cake.jpg"/);
  assert.match(reopened, /data-case-photo="1"[^>]+aria-pressed="true"/);
  assert.equal(image.src, '/photos/photo2_cake.jpg');
});

test('denied sessionStorage falls back to in-memory official viewing state', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('storage denied'); } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; });
  const isolated = await import('../public/unseen-app-cases.js?denied-storage');
  assert.match(isolated.renderDetail('summer-book'), /1 \/ 14/);
  let handler;
  const page = { innerHTML:'' }; const position = { textContent:'' };
  const root = { contains:()=>true,addEventListener:(type,fn)=>{if(type==='click')handler=fn;},removeEventListener(){},
    querySelector:selector=>({'[data-case-detail]':{dataset:{caseDetail:'summer-book'}},'[data-case-book-page]':page,'[data-book-position]':position})[selector],querySelectorAll:()=>[] };
  const cleanup=isolated.bind(root);
  handler({target:{closest:()=>({dataset:{bookStep:'1'},hasAttribute:key=>key==='data-book-step'})}});
  cleanup();
  assert.match(isolated.renderDetail('summer-book'), /2 \/ 14/);
});

test('user-visible case provenance uses readable source names while historical book text remains exact', async () => {
  const internalLocator = /tools\/demo-book|content\.mjs|server\.mjs|featured-spaces\.js|assets\/brand|ai-template-space/;
  for (const item of CASES) {
    assert.doesNotMatch(item.source, internalLocator, item.id);
    // Only visible prose is checked: img src paths remain required for real media.
    const rendered = renderDetail(item.id).replace(/<[^>]*>/g, '');
    assert.doesNotMatch(rendered, internalLocator, item.id);
  }
  assert.match(get('summer-gathering').limitations.join(' '), /全景与照片均为 AI 模板，不是一次真实聚会的纪录/);
  const { createHash } = await import('node:crypto');
  const source = await readFile(new URL('../public/unseen-app-cases.js', import.meta.url), 'utf8');
  const entries = JSON.parse(source.match(/const BOOK_ENTRIES = ([\s\S]*?);\n/)[1]);
  assert.equal(entries.length, 12);
  // Snapshot verified against UNSEEN @8d366ec tools/demo-book/content.mjs MEMORY_ENTRIES.
  assert.equal(createHash('sha256').update(JSON.stringify(entries)).digest('hex'), '9d97d7d88ade260b8ed5c770c3347135a77846cc21e9bde18640795dd661a1d0');
});

test('AdventureX enters the canonical read-only campaign, never a synthetic photo fixture', () => {
  let handler; const calls = [];
  const root = { contains: () => true, addEventListener: (type, fn) => { if (type === 'click') handler = fn; }, removeEventListener() {}, querySelector: selector => selector === '[data-case-detail]' ? { dataset: { caseDetail: 'adventurex' } } : null, querySelectorAll: () => [] };
  const cleanup = bind(root, { onOpenAccount: value => calls.push(value) });
  handler({ target: { closest: () => ({ dataset: {}, hasAttribute: key => key === 'data-case-account' }) } });
  assert.deepEqual(calls, [{ route: 'invite', inviteToken: 'not-a-real-public-demo-invitation', caseId: 'adventurex', readOnly: true }]);
  assert.match(renderDetail('adventurex'), /打开活动相册与现场/);
  cleanup();
});
