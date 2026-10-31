// Official read-only cases. Source: UNSEEN tools/demo-book/content.mjs @8d366ec.
// The historic demonstration questions and answers are fictional, not user memories.
const PHOTO_FILES = [
  {
    "photoId": "photo-cheers",
    "file": "photo1_cheers.jpg",
    "label": "干杯"
  },
  {
    "photoId": "photo-cake",
    "file": "photo2_cake.jpg",
    "label": "蛋糕"
  },
  {
    "photoId": "photo-group-back",
    "file": "photo3_group_back.jpg",
    "label": "长桌背影"
  },
  {
    "photoId": "photo-table-detail",
    "file": "photo4_table_detail.jpg",
    "label": "餐桌细节"
  },
  {
    "photoId": "photo-laughing",
    "file": "photo5_laughing.jpg",
    "label": "大笑"
  },
  {
    "photoId": "photo-dancing",
    "file": "photo6_dancing.jpg",
    "label": "跳舞"
  }
];
const BOOK_ENTRIES = [
  {
    "photoId": "photo-cheers",
    "time": "18:32",
    "question": "举杯的这一下，两只杯子里分别是什么？",
    "answer": "一杯是气泡水加了柠檬片，另一杯是很淡的莓子特调，后来谁也没说清自己喝的是哪杯。"
  },
  {
    "photoId": "photo-cheers",
    "time": "18:33",
    "question": "碰杯的这一声，是谁先碰响的？",
    "answer": "两只杯子几乎同时碰上，叮的一声，旁边立刻有人喊“别晃，要拍糊了”。"
  },
  {
    "photoId": "photo-table-detail",
    "time": "18:47",
    "question": "桌上这几盆带小白花的盆栽，是特意买的吗？",
    "answer": "不是，是院子角落原本就有的盆栽，摆桌子的时候顺手搬过来撑场面。"
  },
  {
    "photoId": "photo-table-detail",
    "time": "18:49",
    "question": "这套花纹碗碟，是为这顿饭新买的吗？",
    "answer": "不是，是家里现成的旧碗，洗干净就端上来了，倒挺配这顿饭的颜色。"
  },
  {
    "photoId": "photo-group-back",
    "time": "19:05",
    "question": "长桌最那头的小朋友，那会儿在忙什么？",
    "answer": "一直低头摆弄一个小玩具，没怎么抬头，倒是全场第一个吃完饭的人。"
  },
  {
    "photoId": "photo-group-back",
    "time": "19:07",
    "question": "烛光摇晃的这一刻，大家在聊什么？",
    "answer": "像是在讲一件很久以前的糗事，具体讲的是什么没录下来，但笑声比说话声还大。"
  },
  {
    "photoId": "photo-laughing",
    "time": "19:26",
    "question": "这一桌笑成这样，是谁的话把大家逗成这样的？",
    "answer": "中间那位讲到一半自己先绷不住笑场了，剩下的人是被他笑场的样子逗笑的，不是被内容逗笑的。"
  },
  {
    "photoId": "photo-laughing",
    "time": "19:28",
    "question": "这张圆桌旁一共坐了几个人？",
    "answer": "五个，后来又有人端着盘子挤过来加了张椅子，勉强也坐下了。"
  },
  {
    "photoId": "photo-cake",
    "time": "19:52",
    "question": "蛋糕上一共插了几根蜡烛？",
    "answer": "数了两次，一次十根一次十一根，最后大家决定不许再数了，够亮就行。"
  },
  {
    "photoId": "photo-cake",
    "time": "19:54",
    "question": "吹蜡烛前，大家唱了什么歌？",
    "answer": "唱了两遍生日歌，第二遍全跑调，跑调之后反而唱得更大声了。"
  },
  {
    "photoId": "photo-dancing",
    "time": "20:31",
    "question": "草地上跳起来的这两位，当时放的是什么歌？",
    "answer": "没人记得歌名，只记得副歌一响，两个人就同时从椅子上弹了起来。"
  },
  {
    "photoId": "photo-dancing",
    "time": "20:33",
    "question": "他们俩当时都光着脚，鞋去哪儿了？",
    "answer": "早就脱在长桌底下了，草地凉凉的，踩上去人反而更精神。"
  }
];

const assets = '/unseen-app-cases-assets/';
const photo = (file, alt) => ({ src: `/photos/${file}`, alt, credit: 'UNSEEN 内置 AI 模板图 · 非真人照片' });
const summerPhotos = PHOTO_FILES.map(item => photo(item.file, item.label));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const CASES = freeze([
  {
    id: 'summer-gathering', title: '夏日聚会', label: '旧现场 · AI 模板', cover: `${assets}summer-gathering-cover.jpg`,
    intro: '花园、长桌和六个瞬间。先翻看照片，再转身看看它们所在的地方。',
    source: '来自 UNSEEN 既有「夏日聚会」公开模板空间，复用同一组花园全景与六张例图。',
    limitations: ['全景与照片均为 AI 模板，不是一次真实聚会的纪录。', '此处只读观看；照片不会加入你的素材库。'],
    media: summerPhotos, relatedCaseId: 'summer-book',
    space: { kind: '360', panorama: `${assets}summer-panorama.jpg`, src: `${assets}summer-panorama.jpg`, label: '环视花园', authenticity: 'AI 模板全景 · 360 环视', initialYaw: 180 }
  },
  {
    id: 'summer-book', title: '夏夜长桌', label: '旧作品 · 虚构样书', cover: '/photos/photo4_table_detail.jpg',
    intro: '六张照片，十二段问答，一本可以从头翻到尾的小书。',
    source: '来自 UNSEEN 既有演示纪念册《夏夜长桌》，保留全部原始问答及页序，在这里重新排版。',
    limitations: ['照片为 AI 模板，问答为手写虚构示例，署名“朋友们”也是演示用语。', '这本演示书未经过真人访谈或活动授权流程；不作为个人作品保存。'],
    media: summerPhotos, book: true, relatedCaseId: 'summer-gathering'
  },
  {
    id: 'huijian-dialogue', title: '从碰杯的那一刻聊起', label: '原回见 · 例图与对话', cover: '/photos/photo1_cheers.jpg',
    intro: '看一张照片，问一个问题。再把想说的话慢慢说完整。',
    source: '来自回见原有六张例图与三轮照片对话，保留原先的备用问题。',
    limitations: ['这里展示的是现有备用问题，不是刚刚调用模型获得的看图结果。', '没有真实用户回答可公开，因此不编造对话记录。'],
    media: summerPhotos,
    questions: ['照片里哪个细节最容易让你开口讲故事？', '刚才那个细节之外，画面里还有什么让你想继续说下去？', '如果把这张照片讲给别人听，你还想补充哪句话？']
  },
  {
    id: 'adventurex', title: 'AdventureX', label: '旧活动 · 相册与现场', cover: `${assets}adventurex-cover.jpg`,
    intro: '六张活动照片，五张已回到 360 现场。沿着当时的视角，再走近一点。',
    source: '来自 UNSEEN 既有 AdventureX 2026 现场。通过原活动的公开访客入口，在授权范围内查看照片与 360 现场。',
    limitations: ['2026 年 9 月 5 日核验：六张照片，五张已定位、一张待定位；实际状态以活动相册为准。', '活动内容沿用原有访客授权，只读观看。纪念册工作台是创作入口，不代表这场活动已经有一本完成的书。'],
    account: { route: 'invite', inviteToken: 'not-a-real-public-demo-invitation' },
    media: [{ src: `${assets}adventurex-cover.jpg`, alt: 'AdventureX 官方活动封面', credit: 'UNSEEN 既有公开活动封面' }]
  },
  {
    id: 'dap-ballroom', title: '宴会厅，轻轻探身', label: '固定样例 · 有限视差', cover: '/official-gallery/v1/media/dap-ballroom-cover.webp',
    intro: '环顾白色钢琴与长厅，也可以在有限距离内换一个角度。',
    source: '全景：Sergej Majboroda / Poly Haven，CC0；深度：DAP © Insta360 Research，CC BY-NC 4.0。',
    limitations: ['约 0.42 米受限移动，不是可自由穿行的完整 3D。', '单目深度的遮挡边缘可能有误差；DAP 非商业授权边界继续适用。'],
    media: [{ src: '/unseen-dap/v1/assets/ballroom.jpg', alt: '宴会厅原始全景', credit: 'Sergej Majboroda / Poly Haven · CC0' }],
    space: { kind: 'dap', src: '/unseen-dap/v1/assets/ballroom.jpg', panorama: '/unseen-dap/v1/assets/ballroom.jpg', depth: '/unseen-dap/v1/assets/ballroom-depth.png', label: '进入宴会厅', authenticity: '固定 DAP 范例 · 受限视差' }
  },
  {
    id: 'world-single-multi', title: '照片之外的世界', label: 'World · 历史公开生成样例', cover: '/official-gallery/v1/media/world-multi-cover.webp',
    intro: '一张照片向画外展开；多张同场景照片，一起提供更多线索。',
    source: '来自 2026 年 9 月 3 日已完成并公开的城堡单图、多图生成体验。查看器直接读取已有公开结果，不会重新生成。以下配图是 UNSEEN AI 模板输入示意。',
    worlds: [
      { kind: 'world', worldId: 'a6755a78-656b-4e3e-b78b-7eca5b903864', world: {"id": "a6755a78-656b-4e3e-b78b-7eca5b903864", "marbleUrl": "https://marble.worldlabs.ai/world/a6755a78-656b-4e3e-b78b-7eca5b903864", "splats": {"preview": "https://cdn.marble.worldlabs.ai/a6755a78-656b-4e3e-b78b-7eca5b903864/85d35e8c-731f-4030-9940-1da1519a7f37_sand_100k.spz", "standard": "https://cdn.marble.worldlabs.ai/a6755a78-656b-4e3e-b78b-7eca5b903864/6efcaad5-0186-4541-8004-646eecccb5a6_sand_500k.spz", "full": "https://cdn.marble.worldlabs.ai/a6755a78-656b-4e3e-b78b-7eca5b903864/3bbdb0ba-6762-4632-94bf-e4d27caf40b5_sand.spz"}}, label: '进入单图城堡世界', authenticity: 'World Labs 单图 AI 补全 · 已有完成品' },
      { kind: 'world', worldId: '585ed6bd-7c49-4460-aac0-104f878af2f1', world: {"id": "585ed6bd-7c49-4460-aac0-104f878af2f1", "marbleUrl": "https://marble.worldlabs.ai/world/585ed6bd-7c49-4460-aac0-104f878af2f1", "splats": {"preview": "https://cdn.marble.worldlabs.ai/585ed6bd-7c49-4460-aac0-104f878af2f1/df16e4b7-64cf-44e6-a3bd-a8c7e23926af_sand_100k.spz", "standard": "https://cdn.marble.worldlabs.ai/585ed6bd-7c49-4460-aac0-104f878af2f1/f308a552-6c02-4b4b-9c16-a40f14a032a3_sand_500k.spz", "full": "https://cdn.marble.worldlabs.ai/585ed6bd-7c49-4460-aac0-104f878af2f1/14499667-eb13-42a2-b4bc-b42d1727e188_sand.spz"}}, label: '进入多图城堡世界', authenticity: 'World Labs 八图 Auto Layout · 已有完成品' }
    ],
    limitations: ['以下图片仅说明输入方式，不是城堡生成结果。已完成城堡样例通过独立按钮载入真实结果。', '单图含 AI 想象；多图也不是精确现场复原。历史回执未包含真实尺度与地面偏移，查看器使用默认显示设置，不用于测量。'],
    media: [
      { src: '/official-gallery/v1/media/world-single-cover.webp', alt: '单图输入方式示意，不是生成结果', credit: 'UNSEEN AI 模板图 · 输入示意' },
      { src: '/official-gallery/v1/media/world-multi-cover.webp', alt: '多图输入方式示意，不是生成结果', credit: 'UNSEEN AI 模板图 · 输入示意' }
    ]
  }
]);

// Only public case IDs and viewing positions persist; no media or personal content.
const viewPositions = new Map();
const VIEW_STATE_KEY = 'unseen-app-official-view-state-v1';
let positionsLoaded = false;
function viewPosition(id) {
  if (!positionsLoaded) {
    positionsLoaded = true;
    try {
      const saved = JSON.parse(globalThis.sessionStorage?.getItem(VIEW_STATE_KEY) || '{}');
      for (const item of CASES) {
        const value = saved[item.id];
        if (value && typeof value === 'object') viewPositions.set(item.id, {
          photo: Math.max(0, Math.min(item.media.length - 1, Number.isInteger(value.photo) ? value.photo : 0)),
          page: Math.max(0, Math.min(BOOK_ENTRIES.length + 1, Number.isInteger(value.page) ? value.page : 0)),
          scroll: Number.isFinite(value.scroll) ? Math.max(0, Math.min(100000, value.scroll)) : 0
        });
      }
    } catch { /* Storage denied or malformed: viewing remains available in memory. */ }
  }
  if (!viewPositions.has(id)) viewPositions.set(id, { photo: 0, page: 0, scroll: 0 });
  return viewPositions.get(id);
}
function saveViewPosition(id, patch) {
  Object.assign(viewPosition(id), patch);
  try { globalThis.sessionStorage?.setItem(VIEW_STATE_KEY, JSON.stringify(Object.fromEntries(viewPositions))); } catch { /* Memory fallback. */ }
}

const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function list() { return CASES; }
export function get(id) { return CASES.find(item => item.id === id) || null; }

export function renderGallery() {
  return `<section class="uc-gallery" aria-label="官方新旧案例"><header class="uc-gallery-heading"><p class="uc-kicker">UNSEEN · 官方收藏</p><h1>那些留下来的瞬间</h1><p>旧现场，新作品。打开一个，慢慢看。</p></header><div class="uc-cards">${CASES.map(item => `<button type="button" class="uc-card" data-case-id="${item.id}"><img src="${item.cover}" alt="${esc(item.title)}" loading="lazy" decoding="async"><span class="uc-card-copy"><span class="uc-kicker">${esc(item.label)}</span><strong>${esc(item.title)}</strong><span>${esc(item.intro)}</span><span class="uc-card-action">打开看看 <span aria-hidden="true">↗</span></span></span></button>`).join('')}</div><p class="uc-gallery-foot">官方案例只供观看。想留下自己的回忆，从「＋」选择自己的照片。</p></section>`;
}

function renderBookPage(index) {
  const total = BOOK_ENTRIES.length + 2;
  if (index === 0) return `<div class="uc-book-page uc-book-cover"><p class="uc-kicker">虚构示例 · 一场夏日聚会</p><h2>夏夜长桌</h2><img src="/photos/photo1_cheers.jpg" alt="夏夜长桌样书封面，AI 模板碰杯画面"><p>六张照片 · 十二段手写问答</p><p class="uc-fine">演示内容，不是真人回忆</p></div>`;
  if (index === total - 1) return `<div class="uc-book-page uc-book-closing"><p class="uc-kicker">演示版 · 尾页</p><h2>每一页，都是这晚<br>被记住的一部分。</h2><p>这本小书保留了历史样书的全部十二段问答。它们是围绕模板照片写下的虚构示例，用来展示照片与文字怎样一起成书。</p><p class="uc-fine">真实创作时，只留下用户确认的话。</p></div>`;
  const entry = BOOK_ENTRIES[index - 1];
  const source = PHOTO_FILES.find(item => item.photoId === entry.photoId);
  return `<div class="uc-book-page"><p class="uc-kicker">${esc(source.label)} · ${esc(entry.time)}（虚构时间）</p><img src="/photos/${source.file}" alt="${esc(source.label)}，AI 模板图"><p class="uc-book-question">${esc(entry.question)}</p><blockquote>${esc(entry.answer)}</blockquote><p class="uc-fine">朋友们 · 手写虚构示例</p></div>`;
}

export function renderDetail(id) {
  const item = get(id);
  if (!item) return `<section class="uc-detail"><h1>没有找到这份案例</h1><button class="uc-button" data-case-back type="button">回到看看</button></section>`;
  const position = viewPosition(item.id);
  const selectedMedia = item.media[position.photo];
  return `<article class="uc-detail" data-case-detail="${item.id}"><button class="uc-back" type="button" data-case-back>← 回到看看</button><header><p class="uc-kicker">${esc(item.label)} · 只读</p><h1>${esc(item.title)}</h1><p class="uc-intro">${esc(item.intro)}</p></header>${item.book ? `<section class="uc-book" aria-label="夏夜长桌演示书"><div data-case-book-page>${renderBookPage(position.page)}</div><div class="uc-book-controls"><button type="button" class="uc-button" data-book-step="-1" ${position.page === 0 ? 'disabled' : ''} aria-label="上一页">← 上一页</button><output data-book-position aria-live="polite">${position.page + 1} / 14</output><button type="button" class="uc-button" data-book-step="1" ${position.page === 13 ? 'disabled' : ''} aria-label="下一页">下一页 →</button></div></section>` : `<figure class="uc-stage"><img data-case-main-image src="${selectedMedia.src}" alt="${esc(selectedMedia.alt)}" decoding="async"><figcaption data-case-caption>${esc(selectedMedia.credit)}</figcaption></figure>${item.media.length > 1 ? `<div class="uc-thumbnails" aria-label="案例相册">${item.media.map((media, index) => `<button type="button" data-case-photo="${index}" aria-label="查看${esc(media.alt)}" aria-pressed="${index === position.photo}"><img src="${media.src}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}`}${item.questions ? `<section class="uc-dialogue" aria-label="原回见三轮备用问题"><h2>照片对话，怎样继续</h2><p class="uc-fine">现有备用问题示例 · 未调用模型</p>${item.questions.map((question, i) => `<div><span>第 ${i + 1} 轮</span><p>${esc(question)}</p></div>`).join('')}</section>` : ''}${item.space ? `<button type="button" class="uc-button uc-space-action" data-case-space="${item.id}">${esc(item.space.label)} <span aria-hidden="true">↗</span></button>` : ''}${item.account ? `<button type="button" class="uc-button uc-space-action" data-case-account>打开活动相册与现场 <span aria-hidden="true">↗</span></button>` : ''}${item.worlds ? item.worlds.map((world, index) => `<button type="button" class="uc-button uc-space-action" data-case-world="${index}">${esc(world.label)} <span aria-hidden="true">↗</span></button>`).join('') : ''}${item.book ? `<p class="uc-fine"><a href="/app-spatial/v1/summer-book.html" download>下载已有 HTML</a> · <a href="/app-spatial/v1/summer-book.pdf" download>下载已有 PDF</a></p>` : ''}${item.relatedCaseId ? `<button type="button" class="uc-related" data-case-id="${item.relatedCaseId}">${item.book ? '看看这本书里的现场' : '翻开这场聚会的小书'} →</button>` : ''}<aside class="uc-provenance"><h2>关于这份案例</h2><p>${esc(item.source)}</p><ul>${item.limitations.map(limit => `<li>${esc(limit)}</li>`).join('')}</ul></aside></article>`;
}

export function bind(root, { onOpenCase = () => {}, onBack = () => {}, onOpenSpace, onOpenAccount } = {}) {
  const currentCaseId = root.querySelector('[data-case-detail]')?.dataset.caseDetail;
  let page = currentCaseId ? viewPosition(currentCaseId).page : 0;
  const scrollElement = root.querySelector('.screen') || root;
  let scrollTimer; let restoreFrame;
  const saveScroll = () => { if (currentCaseId && Number.isFinite(scrollElement.scrollTop)) saveViewPosition(currentCaseId, { scroll: scrollElement.scrollTop }); };
  const onScroll = () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(saveScroll, 120); };
  if (currentCaseId) {
    scrollElement.addEventListener('scroll', onScroll, { passive: true });
    if (typeof requestAnimationFrame === 'function') restoreFrame = requestAnimationFrame(() => { scrollElement.scrollTop = viewPosition(currentCaseId).scroll; });
  }
  const handler = event => {
    const target = event.target.closest?.('button');
    if (!target || !root.contains(target)) return;
    if (target.hasAttribute('data-case-id')) return onOpenCase(target.dataset.caseId);
    if (target.hasAttribute('data-case-back')) return onBack();
    const item = get(root.querySelector('[data-case-detail]')?.dataset.caseDetail);
    if (target.hasAttribute('data-case-account') && item?.account) {
      if (onOpenAccount) onOpenAccount({ ...item.account, caseId: item.id, readOnly: true });
      return;
    }
    if (target.hasAttribute('data-case-world') && item?.worlds) {
      const world = item.worlds[Number(target.dataset.caseWorld)];
      if (world && onOpenSpace) onOpenSpace({ ...world, caseId: item.id, readOnly: true });
      return;
    }
    if (target.hasAttribute('data-case-space') && item?.space) {
      if (onOpenSpace) onOpenSpace({ ...item.space, caseId: item.id, readOnly: true });
      return;
    }
    if (target.hasAttribute('data-case-photo') && item) {
      const media = item.media[Number(target.dataset.casePhoto)];
      if (!media) return;
      const image = root.querySelector('[data-case-main-image]');
      image.src = media.src; image.alt = media.alt;
      saveViewPosition(item.id, { photo: Number(target.dataset.casePhoto) });
      root.querySelector('[data-case-caption]').textContent = media.credit;
      root.querySelectorAll('[data-case-photo]').forEach(button => button.setAttribute('aria-pressed', String(button === target)));
    }
    if (target.hasAttribute('data-book-step') && item?.book) {
      page = Math.min(BOOK_ENTRIES.length + 1, Math.max(0, page + Number(target.dataset.bookStep)));
      const pageContainer = root.querySelector('[data-case-book-page]');
      pageContainer.innerHTML = renderBookPage(page);
      saveViewPosition(item.id, { page });
      pageContainer.scrollIntoView?.({ block: 'start', behavior: 'auto' });
      root.querySelector('[data-book-position]').textContent = `${page + 1} / ${BOOK_ENTRIES.length + 2}`;
      root.querySelectorAll('[data-book-step]').forEach(button => { button.disabled = Number(button.dataset.bookStep) < 0 ? page === 0 : page === BOOK_ENTRIES.length + 1; });
    }
  };
  root.addEventListener('click', handler);
  if (!onOpenSpace) root.querySelectorAll('[data-case-space], [data-case-world]').forEach(button => { button.disabled = true; button.textContent = '空间查看器暂未连接'; });
  if (!onOpenAccount) root.querySelectorAll?.('[data-case-account]').forEach(button => { button.disabled = true; button.textContent = '活动相册暂未连接'; });
  return () => {
    clearTimeout(scrollTimer);
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
    saveScroll();
    if (currentCaseId) scrollElement.removeEventListener('scroll', onScroll);
    root.removeEventListener('click', handler);
  };
}

if (typeof window !== 'undefined') window.UnseenAppCases = { list, get, renderGallery, renderDetail, bind };
