import { previewImage } from './app-thumbnails.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const publicMedia = value => /^\/api\/moment-examples\/[A-Za-z0-9_-]{1,96}\/media\/[A-Za-z0-9_-]{1,96}$/.test(value || '') ? value : '';

export async function fetchExamples(id) {
  const response = await fetch('/api/moment-examples' + (id ? `/${encodeURIComponent(id)}` : ''),
    { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('example_unavailable');
  return response.json();
}

export function examplesGallery(examples, error = false, loading = false) {
  return `<section class="examples-section" aria-label="回忆示例"><div class="section-title"><h2>先看一段回忆</h2><span class="example-byline">UNSEEN 示例</span></div><p class="examples-intro">照片之外的故事，可以这样留下。</p>${loading ? '<p class="empty-note" role="status">正在打开示例…</p>' : error ? '<p class="empty-note" role="status">示例暂时没打开。<button class="text-button" data-action="retry-examples">再试一次</button></p>' : `<div class="examples-grid">${examples.map(e => `<button class="example-card" data-example="${esc(e.id)}"><img ${previewImage(publicMedia(e.coverPhotoUrl))} decoding="async" alt="${esc(e.title)}" loading="lazy"><span class="example-card-copy"><small>回忆示例 · ${e.photoCount} 张照片</small><strong>${esc(e.title)}</strong><span>${esc(e.preview)}</span><em>打开看看 ↗</em></span></button>`).join('')}</div>`}</section>`;
}

export function exampleScreen(example, index, { back, plus, loading }) {
  if (!example) return `<div class="app-shell"><div class="example-top">${back}</div><p class="empty-note" role="status">${loading ? '正在打开这段回忆…' : '这段示例暂时没打开。<button class="text-button" data-action="retry-example">再试一次</button>'}</p></div>`;
  const selected = example.photos[index] || example.photos[0];
  const messages = example.messages.filter(m => !m.photoId || m.photoId === selected?.id);
  return `<div class="app-shell example-shell"><header class="example-top">${back}<span>UNSEEN 示例 · 只读</span><button class="secondary" data-action="new">${plus} 留下我的回忆</button></header><div class="example-heading"><span class="eyebrow">MEMORY MOMENT</span><h1>${esc(example.title)}</h1><p>${esc(example.notice)}</p></div><div class="example-body"><section class="example-photos" aria-label="示例照片">${selected ? `<img class="example-main-photo" src="${esc(publicMedia(selected.url))}" alt="${esc(selected.name || example.title)}">` : ''}<div class="photo-thumbs">${example.photos.map((p, i) => `<button class="photo-thumb ${i === index ? 'active' : ''}" data-example-photo="${i}" aria-label="第 ${i + 1} 张示例照片" aria-pressed="${i === index}"><img src="${esc(publicMedia(p.url))}" alt=""></button>`).join('')}</div></section><section class="example-conversation" aria-label="示例对话">${messages.map(m => `<article class="message ${m.role === 'user' ? 'user' : 'assistant'}"><div class="message-meta">${m.role === 'user' ? '示例讲述者' : '回忆时刻'}</div><div class="message-bubble">${esc(m.text)}${m.audio ? `<audio controls preload="none" src="${esc(publicMedia(m.audio.url))}" aria-label="示例语音"></audio>` : ''}</div></article>`).join('')}<p class="example-end">每一张照片，都可以慢慢聊。</p></section></div><div class="example-footer"><button class="primary warm" data-action="new">${plus} 选一张我的照片</button></div></div>`;
}
