import { designShell, designScene, designTitle } from './moment-design.js';
import { esc, submissionMedia } from './moment-moderation.js';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const publicPhoto = value => /^\/v1\/public\/moments\//.test(value || '') ? submissionMedia(value) : '';

export function communityMoments(data) {
  return (Array.isArray(data?.moments) ? data.moments : []).filter(item => validId(item?.id)).map(item => ({
    id: item.id,
    title: String(item.title || '一段回忆'),
    authorName: String(item.authorName || '社区成员'),
    authorId: validId(item.authorId) ? item.authorId : '',
    coverPhotoUrl: publicPhoto(item.coverPhotoUrl),
    createdAt: item.createdAt,
    featured: item.featured === true,
  }));
}

export function communityAuthorCredit(item) {
  const words = `<span class="community-author-mark" aria-hidden="true">${esc(Array.from(item.authorName || '忆')[0])}</span><span>${esc(item.authorName || '社区成员')}</span>`;
  return item.authorId ? `<button class="community-credit" data-community-author="${esc(item.authorId)}" aria-label="查看${esc(item.authorName)}的公开作品">${words}<span aria-hidden="true">›</span></button>` : `<span class="community-credit">${words}</span>`;
}

export function communityMomentCards(items, date = () => '') {
  return `<div class="community-grid">${items.map(item => `<article class="community-card glass">
    <button class="community-card-open" data-public-id="${esc(item.id)}" aria-label="打开回忆：${esc(item.title)}">
      ${item.coverPhotoUrl ? `<span class="community-card-photo"><img src="${esc(item.coverPhotoUrl)}" alt="" loading="lazy" decoding="async"></span>` : '<span class="community-card-photo community-no-photo" aria-hidden="true">忆</span>'}
      <strong>${esc(item.title)}</strong>
    </button>
    <div class="community-card-byline">${communityAuthorCredit(item)}<time>${esc(date(item.createdAt))}</time></div>
  </article>`).join('')}</div>`;
}

export function communityHome({ avatar = '', data, loading = false, error = '', date = () => '', page = 1 } = {}) {
  const items = communityMoments(data), featured = items.find(item => item.featured) || items[0];
  const hero = featured ? `<section class="community-feature">
    <button class="frame-gold community-feature-open" data-public-id="${esc(featured.id)}" aria-label="打开${esc(featured.title)}">
      <span class="community-feature-image">${featured.coverPhotoUrl ? `<img src="${esc(featured.coverPhotoUrl)}" alt="" fetchpriority="high" decoding="async">` : designScene()}</span>
      <span class="community-feature-caption"><small>${featured.featured ? '社区精选' : '最新回忆'}</small><strong>${esc(featured.title)}</strong><span>打开这段回忆 <b aria-hidden="true">↗</b></span></span>
    </button>
    <div class="community-feature-byline">${communityAuthorCredit(featured)}<time>${esc(date(featured.createdAt))}</time></div>
  </section>` : `<section class="frame-gold community-welcome" aria-label="回忆时刻社区"><div class="mini-scene">${designScene()}</div><div class="community-welcome-caption"><small>MEMORY MOMENT</small><h2>回忆时刻</h2><p>大家的照片与故事</p></div></section>`;
  return designShell(`<header class="nav community-header">${avatar}<h1>回忆时刻<small>大家的照片与故事</small></h1><div class="grow"></div><button class="ib" data-action="community-refresh" aria-label="刷新社区">↻</button></header>
    ${hero}
    <div class="design-entry-row community-create"><button class="glass gilt card-corner design-entry" data-action="capture"><span class="entry-icon rose">✦</span><strong>留下一段回忆</strong><small>从一张照片开始<br>说说它背后的故事</small></button><button class="glass card-corner design-entry" data-spatial-route="new-space"><span class="entry-icon gold">◫</span><strong>创建回忆空间</strong><small>邀请同行的人<br>一起补上那一天</small></button></div>
    <button class="glass gilt card-corner ff-home-entry" data-action="family-frame"><span class="entry-icon blue">▣</span><span><strong>打开家庭相框</strong><small>查看同一个空间里的照片与留言</small></span><b aria-hidden="true">›</b></button>
    ${designTitle('OUR MEMORIES', '最近分享的回忆')}
    <section aria-label="社区回忆" aria-busy="${loading}">${loading ? '<div class="glass community-empty community-loading" role="status"><span class="community-empty-mark" aria-hidden="true">✦</span><h3>正在打开大家的回忆</h3><p>照片与故事，马上相见</p></div>' : error ? `<div class="glass community-empty" role="status"><p>${esc(error)}</p><button class="btn ghost" data-action="community-refresh">重新加载</button></div>` : items.length ? communityMomentCards(items, date) : '<div class="glass community-empty"><span class="community-empty-mark" aria-hidden="true">✦</span><h3>第一段分享，从你开始</h3><p>从一张照片，留住那一天。<br>保存后，再决定是否分享给大家。</p><button class="btn rose" data-action="capture">留下我的回忆</button></div>'}</section>
    ${!loading&&!error&&(page>1||page*20<(data?.total||0))?`<nav class="community-pagination" aria-label="社区分页">${page>1?`<button class="btn ghost" data-community-page="${page-1}">上一页</button>`:''}<span>第 ${page} 页</span>${page*20<data.total?`<button class="btn ghost" data-community-page="${page+1}">更多回忆</button>`:''}</nav>`:''}
    <div class="community-library-link"><button data-action="open-library">回到我的回忆库 <span aria-hidden="true">›</span></button><button data-spatial-route="my-spaces">我的空间 <span aria-hidden="true">›</span></button></div>
    <p class="community-totals" aria-label="空间与照片统计暂未提供">已有 <b>—</b> 个回忆空间 · <b>—</b> 张照片被留下</p>`, { selected: 'home', className: 'design-home community-home' });
}
