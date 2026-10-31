import {
  DEFAULT_OSS_BASE,
  MAX_BATCH_ITEMS,
  UNSEEN_API_URL,
  buildOssObjectKey,
  createClientUploadId,
  exactUploadPolicyStatus,
  formatBytes,
  normaliseSpace,
  parseSpaceTarget,
  uploadPolicyStatus,
  validatePanoramaDescriptor,
  validatePhotoDescriptor,
} from "./unseen-core.mjs";

const app = document.querySelector("#app");
const state = {
  current: null,
  queue: [],
  uploadLock: false,
  uploadHash: "",
  createLock: false,
  activeUrls: new Set(),
  renderToken: 0,
  toastTimer: 0,
  lastRoutePath: "",
};

const DB_NAME = "unseen-upload-first";
const DB_VERSION = 2;
const DRAFT_STORE = "drafts";
const REMOTE_STORE = "remoteSpaces";
const API_TIMEOUT_MS = 15000;
const OSS_TIMEOUT_MS = 90000;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function safeAssetUrl(value, base = DEFAULT_OSS_BASE, sid = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^blob:/i.test(raw)) return raw;
  try {
    const url = new URL(raw, `${base.replace(/\/+$/, "")}/spaces/${encodeURIComponent(sid)}/`);
    return url.protocol === "https:" || /^http:\/\/(localhost|127\.0\.0\.1)/i.test(url.href) ? url.href : "";
  } catch {
    return "";
  }
}

function makeObjectUrl(blob) {
  if (!blob) return "";
  const url = URL.createObjectURL(blob);
  state.activeUrls.add(url);
  return url;
}

function releaseObjectUrls() {
  for (const url of state.activeUrls) URL.revokeObjectURL(url);
  state.activeUrls.clear();
}

function toast(message) {
  let element = document.querySelector(".toast");
  if (!element) {
    element = document.createElement("div");
    element.className = "toast";
    element.setAttribute("role", "status");
    document.body.append(element);
  }
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => element.classList.remove("show"), 2600);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("当前浏览器不支持本机草稿存储"));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(REMOTE_STORE)) db.createObjectStore(REMOTE_STORE, { keyPath: "sid" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本机草稿存储"));
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try {
        result = callback(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result?.result ?? result);
      tx.onerror = () => reject(tx.error || new Error("本机草稿操作失败"));
      tx.onabort = () => reject(tx.error || new Error("本机草稿操作已取消"));
    });
  } finally {
    db.close();
  }
}

function withDraftStore(mode, callback) {
  return withStore(DRAFT_STORE, mode, callback);
}

function getDraft(id) {
  return withDraftStore("readonly", (store) => store.get(id));
}

async function listDrafts() {
  const drafts = await withDraftStore("readonly", (store) => store.getAll());
  return (drafts || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function putDraft(draft) {
  return withDraftStore("readwrite", (store) => store.put(draft));
}

function deleteDraft(id) {
  return withDraftStore("readwrite", (store) => store.delete(id));
}

function getRemoteRecord(sid) {
  return withStore(REMOTE_STORE, "readonly", (store) => store.get(sid));
}

async function listRemoteRecords() {
  const records = await withStore(REMOTE_STORE, "readonly", (store) => store.getAll());
  return (records || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function putRemoteRecord(record) {
  return withStore(REMOTE_STORE, "readwrite", (store) => store.put(record));
}

async function rememberRemoteSpace(input) {
  const old = await getRemoteRecord(input.sid).catch(() => null);
  const record = {
    sid: input.sid,
    title: input.title || old?.title || "共同记忆空间",
    date: input.date || old?.date || "",
    manifestUrl: input.manifestUrl || old?.manifestUrl || `${DEFAULT_OSS_BASE}/spaces/${encodeURIComponent(input.sid)}/space.json`,
    hostKey: input.hostKey || old?.hostKey || "",
    createdAt: old?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await putRemoteRecord(record);
  return record;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function callManagedApi(action, payload, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 2);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), options.timeoutMs || API_TIMEOUT_MS);
    try {
      const headers = { "Content-Type": "application/json" };
      if (options.hostKey) headers["X-Unseen-Host-Key"] = options.hostKey;
      const response = await fetch(UNSEEN_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ action, ...payload }),
        cache: "no-store",
        signal: controller.signal,
      });
      let result;
      try {
        result = await response.json();
      } catch {
        const error = new Error("云端返回了无法识别的数据，请稍后重试");
        error.status = response.status;
        throw error;
      }
      if (!response.ok || !result?.ok) {
        const error = new Error(result?.error?.message || `云端请求失败（HTTP ${response.status}）`);
        error.status = response.status;
        error.code = result?.error?.code || "API_ERROR";
        throw error;
      }
      return result.data;
    } catch (error) {
      const normalized = error.name === "AbortError"
        ? Object.assign(new Error("连接云端超过 15 秒，已停止；请检查网络后重试"), { code: "API_TIMEOUT" })
        : error;
      lastError = normalized;
      const retryable = !normalized.status || normalized.status === 408 || normalized.status >= 500;
      if (!retryable || attempt === attempts - 1) break;
      await wait(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("云端暂时不可用，请稍后重试");
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  return { path: path || "/", params: new URLSearchParams(query) };
}

function href(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  return `#${path}${query.size ? `?${query}` : ""}`;
}

function currentParams() {
  if (!state.current) return {};
  if (state.current.kind === "local") return { draft: state.current.id };
  return { s: state.current.sid };
}

function syncUploadNavigationLock() {
  const back = document.querySelector(".topbar .icon-button[href]");
  if (!back) return;
  if (state.uploadLock) {
    back.setAttribute("aria-disabled", "true");
    back.setAttribute("data-upload-navigation-locked", "");
  } else {
    back.removeAttribute("aria-disabled");
    back.removeAttribute("data-upload-navigation-locked");
  }
}

function restoreUploadRoute() {
  if (!state.uploadLock || !state.uploadHash || location.hash === state.uploadHash) return false;
  history.replaceState(history.state, "", `${location.pathname}${location.search}${state.uploadHash}`);
  return true;
}

function shell(content, { title = "UNSEEN", back = "", active = "", flush = false, nav = true } = {}) {
  const topbar = back
    ? `<header class="topbar"><a class="icon-button" href="${back}" aria-label="返回">‹</a><strong class="topbar-title">${escapeHtml(title)}</strong></header>`
    : `<header class="topbar"><a class="brand" href="#/"><span class="brand-mark">U</span><span>UNSEEN</span></a><a class="topbar-demo" href="#/demo"><span aria-hidden="true">◇</span> 演示</a></header>`;
  const bottom = nav
    ? `<nav class="bottom-nav" aria-label="主导航">
        <a class="nav-item ${active === "home" ? "active" : ""}" href="#/"><span>⌂</span><span>首页</span></a>
        <a class="nav-item ${active === "spaces" ? "active" : ""}" href="#/spaces"><span>▦</span><span>空间</span></a>
        <a class="nav-item ${active === "create" ? "active" : ""}" href="#/create"><span>＋</span><span>创建</span></a>
      </nav>`
    : "";
  return `<div class="app-shell">${topbar}<main class="app-main${flush ? " flush" : ""}">${content}</main>${bottom}</div>`;
}

function loadingPage(message = "正在读取空间…") {
  app.innerHTML = shell(`<div class="loading"><span class="spinner"></span><span>${escapeHtml(message)}</span></div>`, { nav: false });
}

function errorPage(title, message, retryHref = "#/join") {
  app.innerHTML = shell(
    `<div class="page-heading"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>
     <div class="notice error">${escapeHtml(message)}</div>
     <div class="action-stack"><a class="button secondary" href="${retryHref}">返回重试</a></div>`,
    { title, back: "#/", nav: false },
  );
}

function manifestUrlFor(sid, base = DEFAULT_OSS_BASE, rememberedUrl = "") {
  const fallback = `${base.replace(/\/+$/, "")}/spaces/${encodeURIComponent(sid)}/space.json`;
  if (!rememberedUrl) return fallback;
  try {
    const candidate = new URL(rememberedUrl);
    const allowed = new URL(base);
    const expectedPath = `${allowed.pathname.replace(/\/+$/, "")}/spaces/${encodeURIComponent(sid)}/space.json`.replace(/^\/\//, "/");
    if (candidate.origin === allowed.origin && candidate.pathname === expectedPath) return candidate.href;
  } catch {
    // Invalid remembered URLs fall back to the official deterministic path.
  }
  return fallback;
}

async function fetchRemoteSpace(sid, base, rememberedUrl = "") {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  const manifestUrl = manifestUrlFor(sid, base, rememberedUrl);
  const url = new URL(manifestUrl);
  url.searchParams.set("t", String(Date.now()));
  try {
    const response = await fetch(url.href, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 404 ? "没有找到这个空间" : `读取空间失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (!data || (data.id && data.id !== sid)) throw new Error("空间数据与编号不一致");
    return normaliseSpace(data, sid);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("网络较慢，15 秒内没有读到空间数据");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSpace(params, { force = false } = {}) {
  const draftId = params.get("draft");
  if (draftId) {
    if (!force && state.current?.kind === "local" && state.current.id === draftId) return state.current;
    const draft = await getDraft(draftId);
    if (!draft) throw new Error("这份本机草稿不存在，可能已被清理");
    state.current = { kind: "local", id: draftId, draft };
    return state.current;
  }

  const target = parseSpaceTarget(params.get("s") || "", params.get("b") || DEFAULT_OSS_BASE);
  if (!target.ok) throw new Error(target.message);
  if (!force && state.current?.kind === "remote" && state.current.sid === target.sid && state.current.base === target.base) return state.current;
  const remembered = target.base === DEFAULT_OSS_BASE ? await getRemoteRecord(target.sid).catch(() => null) : null;
  const manifestUrl = manifestUrlFor(target.sid, target.base, remembered?.manifestUrl);
  const space = await fetchRemoteSpace(target.sid, target.base, manifestUrl);
  const record = await rememberRemoteSpace({
    sid: target.sid,
    title: space.title,
    date: space.date,
    manifestUrl,
    hostKey: remembered?.hostKey || "",
  }).catch(() => remembered);
  state.current = { kind: "remote", sid: target.sid, base: target.base, manifestUrl, record, space };
  return state.current;
}

async function renderHome() {
  const token = ++state.renderToken;
  releaseObjectUrls();
  let drafts = [];
  let remoteRecords = [];
  try {
    [drafts, remoteRecords] = await Promise.all([listDrafts(), listRemoteRecords()]);
  } catch {
    drafts = [];
    remoteRecords = [];
  }
  if (token !== state.renderToken) return;
  const draftRows = drafts.slice(0, 3).map((draft) => {
    const source = draft.coverBlob || draft.panoramaBlob || draft.photos?.[0]?.blob;
    const thumb = source ? makeObjectUrl(source) : "";
    return `<a class="card draft-row" href="${href("/space", { draft: draft.id })}">
      ${thumb ? `<img class="draft-thumb" src="${thumb}" alt="">` : `<span class="draft-thumb scene-icon">✦</span>`}
      <span class="draft-meta"><b>${escapeHtml(draft.title)}</b><small>本机草稿 · ${draft.photos?.length || 0} 张照片${draft.panoramaBlob ? " · 已有全景" : ""}</small></span>
      <span aria-hidden="true">›</span>
    </a>`;
  }).join("");
  const remoteRows = remoteRecords.slice(0, 3).map((record) => `
    <a class="card draft-row" href="${href("/space", { s: record.sid })}">
      <span class="draft-thumb scene-icon">☁</span>
      <span class="draft-meta"><b>${escapeHtml(record.title)}</b><small>共享空间 · ${escapeHtml(record.date || record.sid)}${record.hostKey ? " · 创建者" : ""}</small></span>
      <span aria-hidden="true">›</span>
    </a>`).join("");

  app.innerHTML = shell(
    `<div class="home-layout">
       <section class="hero">
         <p class="eyebrow">Shared memory space</p>
         <h1>把散落在每个人手机里的那一天，放回一起。</h1>
         <p>创建或加入空间，上传普通照片与已经制作完成的 2:1 全景图。</p>
         <span class="hero-badge">上传优先 MVP</span>
       </section>
       <div class="home-start">
         <div class="section-title"><div><h2>从哪个场景开始？</h2><p>选择只用于预填创建表单</p></div></div>
         <div class="scene-grid" id="homeScenes">
           ${[["婚礼","♡","同一天的多重视角"],["旅行","⌁","把沿途收进一个空间"],["聚会","✦","朋友们共同补全现场"],["日常","○","留住普通但重要的片刻"]].map(([name, icon, sub], index) => `<button class="scene-card${index === 0 ? " active" : ""}" data-scene="${name}"><span class="scene-icon">${icon}</span><span><b>${name}</b><small>${sub}</small></span></button>`).join("")}
         </div>
         <div class="action-stack">
           <a class="button primary" id="homeCreate" href="${href("/create", { scene: "婚礼" })}">创建一个记忆空间 <span>→</span></a>
           <a class="button secondary" href="#/join">通过邀请链接加入</a>
         </div>
         <a class="demo-banner" href="#/demo">
           <span class="demo-banner-icon">◇</span>
           <span><b>演示中心</b><small>产品故事、全景实验与研究说明都收在这里</small></span>
           <span aria-hidden="true">›</span>
         </a>
       </div>
     </div>
     ${remoteRows ? `<div class="section-title"><div><h2>最近共享空间</h2><p>可从这台设备重新打开</p></div><a href="#/spaces">查看全部</a></div><div class="draft-list">${remoteRows}</div>` : ""}
     ${draftRows ? `<div class="section-title"><div><h2>本机草稿</h2><p>只保存在这台设备</p></div><a href="#/spaces">查看全部</a></div><div class="draft-list">${draftRows}</div>` : ""}`,
    { active: "home" },
  );

  const create = document.querySelector("#homeCreate");
  document.querySelectorAll("[data-scene]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-scene]").forEach((item) => item.classList.toggle("active", item === button));
      create.href = href("/create", { scene: button.dataset.scene });
    });
  });
}

function renderDemo() {
  app.innerHTML = shell(
    `<section class="demo-hero">
       <p class="eyebrow">Demo lab</p>
       <h1>从理想成品开始看。</h1>
       <p>三端统一从产品成品、AI 档案馆与六幕故事进入。每一张卡都会进入完整页面，不再用文字展开或弹窗代替演示。</p>
       <div class="demo-legend" aria-label="演示类型">
         <span><i class="legend-dot product"></i>产品演示</span>
         <span><i class="legend-dot experiment"></i>AI 档案</span>
         <span><i class="legend-dot research"></i>正式流程</span>
       </div>
     </section>

     <section class="demo-path" aria-label="建议体验顺序">
       <div class="section-title"><div><h2>建议这样看</h2><p>先理解成品，再翻完整档案</p></div></div>
       <div class="demo-steps">
         <span><b>01</b>看理想成品</span><i></i><span><b>02</b>看六幕故事</span><i></i><span><b>03</b>翻 AI 档案</span>
       </div>
     </section>

     <a class="demo-archive-callout" href="#/demo-archive">
       <span class="demo-archive-mark">15</span>
       <span><b>打开 AI 演示档案馆</b><small>找回以前的全景空间、婚礼旅程、时光轴、相册、机器回忆墙、路演版等历史版本。</small></span>
       <i aria-hidden="true">→</i>
     </a>

     <div class="section-title"><div><h2>产品演示</h2><p>完整页面；不调用相机，不写入正式空间</p></div></div>
     <div class="demo-grid">
       <a class="demo-card demo-card--featured" href="#/demo-vision">
         <span class="demo-card-preview"><img src="./demo-assets/pano.jpg" alt="宴会厅全景示例"></span>
         <span class="demo-card-copy"><span class="demo-card-meta">推荐先看 · 可操作成品</span><b>理想的共同记忆空间</b><small>空间首页、照片时间线、全景漫游和“回到 TA 的视角”收进一个完整 Demo。</small></span>
         <span class="demo-card-go">进入 ›</span>
       </a>
       <a class="demo-card demo-card--product" href="#/demo-story">
         <span class="demo-card-icon">✦</span>
         <span class="demo-card-copy"><span class="demo-card-meta">产品演示 · 约 3 分钟</span><b>六幕产品故事</b><small>从“照片散在每个人手机里”到共同补全同一天。</small></span>
         <span class="demo-card-go">开始 ›</span>
       </a>
       <a class="demo-card demo-card--product" href="#/create">
         <span class="demo-card-icon">＋</span>
         <span class="demo-card-copy"><span class="demo-card-meta">正式流程 · 可随时返回</span><b>上传优先流程</b><small>查看创建空间、上传普通照片和外部 2:1 全景图的正式路径。</small></span>
         <span class="demo-card-go">体验 ›</span>
       </a>
     </div>

     <div class="notice demo-safety"><b>演示边界</b>：本页与档案馆均为静态演示，不调用相机、不依赖后端、不会自动上传，也不写入正式空间。全景拍摄仍作为内部技术实验保留，不再混进对外演示入口。</div>`,
    { title: "演示中心", back: "#/", nav: false },
  );
}

const ARCHIVE_CHAPTERS = [
  { id: "hall", slug: "entrance_hall", time: "样片 01", chapter: "大厅", title: "入口大厅", copy: "真实 CC0 全景，用来验证环视、照片钉点和低端设备渲染。" },
  { id: "cafe", slug: "comfy_cafe", time: "样片 02", chapter: "咖啡馆", title: "舒适咖啡馆", copy: "真实 CC0 全景，用来验证室内尺度与方向切换。" },
  { id: "chapel", slug: "chapel_day", time: "样片 03", chapter: "礼堂", title: "日间礼堂", copy: "真实 CC0 全景，用来验证高亮区域和空间边缘。" },
  { id: "ballroom", slug: "ballroom", time: "样片 04", chapter: "宴会厅", title: "古典宴会厅", copy: "真实 CC0 全景，用来验证暗场、照片钉点和可漫游表现。" },
];

const AI_WEDDING_SCENES = [
  { id: "n1", number: "01", title: "初见", place: "迎宾庭院", src: "./demo-assets/ai-pano/n1.jpg" },
  { id: "n2", number: "02", title: "誓言", place: "林间仪式", src: "./demo-assets/ai-pano/n2.jpg" },
  { id: "n3", number: "03", title: "共宴", place: "烛光长桌", src: "./demo-assets/ai-pano/n3.jpg" },
  { id: "n4", number: "04", title: "尽兴", place: "星夜派对", src: "./demo-assets/ai-pano/n4.jpg" },
];

const LEGACY_DEMO_PAGES = {
  "judge-story": { title: "六幕评委 Demo · 原版", src: "./demo.html" },
  "ai-exhibition": { title: "纯 AI 婚礼全景 · 四幕成品", src: "./show.html?s=s900001" },
  "walk-hall": { title: "技术样片 · 入口大厅", src: "../viewer/walk.html?scene=entrance_hall" },
  "walk-cafe": { title: "技术样片 · 舒适咖啡馆", src: "../viewer/walk.html?scene=comfy_cafe" },
  "walk-chapel": { title: "技术样片 · 日间礼堂", src: "../viewer/walk.html?scene=chapel_day" },
  "walk-ballroom": { title: "技术样片 · 古典宴会厅", src: "../viewer/walk.html?scene=ballroom" },
  roadshow: { title: "路演现场", src: "../roadshow.html" },
  workspace: { title: "空间工作台 · 历史概念版", src: "../workspace.html" },
  "pov-research": { title: "回到 TA 的视角 · 研究原版", src: "./pov.html" },
  portal: { title: "UNSEEN 产品总入口 · 历史版", src: "../portal.html#showcase" },
};

const ARCHIVE_MODES = [
  ["journey", "婚礼旅程"],
  ["timeline", "时光轴"],
  ["album", "记忆相册"],
  ["machine", "机器回忆"],
  ["film", "一键成片"],
];

function archiveImage(slug, index = 1) {
  return `../assets/walkdemo/${slug}_j${index}.jpg`;
}

function archiveCard({ href: target, preview, meta, title, copy, tone = "memory" }) {
  return `<a class="archive-card archive-card--${tone}" data-archive-entry href="${target}">
    <span class="archive-card-preview"><img src="${preview}" alt="" loading="lazy"></span>
    <span class="archive-card-copy"><span>${meta}</span><b>${title}</b><small>${copy}</small></span>
    <i aria-hidden="true">↗</i>
  </a>`;
}

function renderDemoArchive() {
  const roomCards = ARCHIVE_CHAPTERS.map((chapter) => archiveCard({
    href: href("/demo-player", { id: `walk-${chapter.id}` }),
    preview: `../assets/walkdemo/${chapter.slug}.jpg`,
    meta: `真实全景技术对照 · ${chapter.time}`,
    title: chapter.title,
    copy: "来自 Poly Haven 的 CC0 真实全景，可拖动环视并检查渲染与照片钉点。",
    tone: "space",
  })).join("");
  const modeCards = ARCHIVE_MODES.map(([mode, label], index) => archiveCard({
    href: href("/demo-mode", { mode }),
    preview: archiveImage(ARCHIVE_CHAPTERS[index % ARCHIVE_CHAPTERS.length].slug, (index % 3) + 1),
    meta: "历史观看形态 · 已恢复",
    title: label,
    copy: [
      "沿接亲、出发、仪式和宴席重新走一遍那一天。",
      "把同一天按时间摊开，查看每个时刻的多重视角。",
      "把空间内容切回熟悉的照片墙与灯箱观看。",
      "从 AI 的定位与置信度视角检查照片如何归位。",
      "用短片先建立情绪，再进入可以走动的记忆空间。",
    ][index],
    tone: "mode",
  })).join("");
  const pitchCards = [
    { id: "judge-story", preview: "./demo-assets/ph_p1.jpg", meta: "2026-07-25 · 原版", title: "六幕评委 Demo", copy: "最早完整跑通的问题、识别、归位、缺口和成品叙事。" },
    { id: "roadshow", preview: "./demo-assets/ph_p9.jpg", meta: "现场大屏版", title: "路演现场", copy: "用于活动现场投屏的极简入口和空间实时状态。" },
    { id: "workspace", preview: "./demo-assets/ph_p11.jpg", meta: "概念工作台", title: "空间工作台", copy: "历史上的主办者视角和场景模板概念页。" },
    { id: "pov-research", preview: "../assets/walkdemo/pov-desktop.jpg", meta: "研究原版", title: "回到 TA 的视角", copy: "世界锚定、覆盖判断和当时能力边界的原始说明。" },
    { id: "portal", preview: "../assets/walkdemo/pov-step2-cover.jpg", meta: "总入口原版", title: "产品 Showcase", copy: "早期把宾客、主办者和观众三种界面放在同一入口。" },
  ].map((item) => archiveCard({
    href: href("/demo-player", { id: item.id }),
    preview: item.preview,
    meta: item.meta,
    title: item.title,
    copy: item.copy,
    tone: "pitch",
  })).join("");

  const aiWeddingScenes = AI_WEDDING_SCENES.map((scene) => `<figure><img src="${scene.src}" alt="纯 AI 婚礼全景 · ${scene.title}" loading="eager"><figcaption><b>${scene.number} · ${scene.title}</b><span>${scene.place}</span></figcaption></figure>`).join("");

  app.innerHTML = shell(
    `<section class="archive-hero">
       <p class="eyebrow">AI demo archive</p>
       <h1>先看主作品，再翻历史。</h1>
       <p>纯 AI 婚礼全景是主作品；技术样片、观看模式和旧路演稿分别归档。内容没有减少，但不再把不同性质的页面铺成一地。</p>
       <div class="archive-counts"><span><b>1</b>件主作品</span><span><b>4</b>幕 AI 全景</span><span><b>3</b>类归档</span></div>
     </section>

     <a class="archive-ai-feature" data-archive-entry href="${href("/demo-player", { id: "ai-exhibition" })}">
       <div class="archive-ai-collage">${aiWeddingScenes}</div>
       <div class="archive-ai-copy"><span class="archive-ai-badge">历史找回 · 纯 AI 生成</span><small>AI WEDDING PANORAMA · s900001</small><b>一场未曾拍摄的<br>婚礼</b><em>4 张 2:1 AI 全景与 8 张 AI 照片组成完整四幕：初见、誓言、共宴、尽兴。这里才是你记得的那套“纯 AI 全景图”。</em><i>进入完整 AI 全景展览 →</i></div>
     </a>

     <section class="archive-current">
       <div><p class="eyebrow">Current direction</p><h2>先看现在的理想答案</h2><p>当前版本把空间、时间线、全景与 TA 视角合成一套产品，不需要在多个旧页面之间跳转。</p></div>
       <div><a class="button primary" href="#/demo-vision">进入理想成品</a><a class="button secondary" href="#/demo-story">看新版六幕故事</a></div>
     </section>

     <div class="archive-groups">
       <details class="archive-group">
         <summary><span><small>技术对照</small><b>真实全景可漫游样片</b><em>用于检查环视、景深、照片钉点，不是 AI 生成。</em></span><i>4</i></summary>
         <div class="archive-group-body"><div class="archive-grid archive-grid--rooms">${roomCards}</div></div>
       </details>
       <details class="archive-group">
         <summary><span><small>交互形态</small><b>同一段记忆的五种看法</b><em>旅程、时光轴、相册、机器回忆和一键成片。</em></span><i>5</i></summary>
         <div class="archive-group-body"><div class="archive-grid">${modeCards}</div></div>
       </details>
       <details class="archive-group">
         <summary><span><small>历史原稿</small><b>叙事、路演与研究页面</b><em>保留当时版本原貌，统一装进带返回入口的播放器。</em></span><i>5</i></summary>
         <div class="archive-group-body"><div class="archive-grid">${pitchCards}</div></div>
       </details>
     </div>

     <div class="notice demo-safety"><b>档案说明</b>：纯 AI 婚礼作品明确标注为生成内容；技术对照使用 Poly Haven CC0 真实全景；“理想成品”代表当前产品方向。三者不再混写。</div>`,
    { title: "AI 演示档案馆", back: "#/demo", nav: false },
  );
}

function renderDemoPlayer(params) {
  const item = LEGACY_DEMO_PAGES[params.get("id") || ""];
  if (!item) {
    errorPage("演示没有找到", "这个历史演示编号不存在或已经被收编。", "#/demo-archive");
    return;
  }
  app.innerHTML = `<div class="archive-player-shell">
    <header class="archive-player-bar">
      <a href="#/demo-archive" aria-label="返回 AI 演示档案馆">‹</a>
      <span><b>${escapeHtml(item.title)}</b><small>历史演示 · 已装入统一播放器</small></span>
      <a class="archive-player-open" href="${escapeHtml(item.src)}" target="_blank" rel="noopener">全屏 ↗</a>
    </header>
    <iframe class="archive-player-frame" src="${escapeHtml(item.src)}" title="${escapeHtml(item.title)}" allow="accelerometer; camera; gyroscope; fullscreen" allowfullscreen></iframe>
  </div>`;
}

function archiveModeTabs(active) {
  return `<nav class="archive-mode-tabs" aria-label="历史观看形态">${ARCHIVE_MODES.map(([id, label]) => `<a class="${id === active ? "active" : ""}" href="${href("/demo-mode", { mode: id })}">${label}</a>`).join("")}</nav>`;
}

function archiveTimeline() {
  return `<div class="archive-timeline">${ARCHIVE_CHAPTERS.map((chapter, chapterIndex) => `<article>
    <div class="archive-time"><b>${chapter.time}</b><span>${chapter.chapter}</span></div>
    <div class="archive-time-copy"><h3>${chapter.title}</h3><p>${chapter.copy}</p><div>${[1, 2, 3].map((n) => `<button data-archive-image="${archiveImage(chapter.slug, n)}" aria-label="放大${chapter.title}照片 ${n}"><img src="${archiveImage(chapter.slug, n)}" alt="${chapter.title}照片 ${n}" loading="lazy"></button>`).join("")}</div></div>
  </article>`).join("")}</div>`;
}

function archiveAlbum(machine = false) {
  const photos = ARCHIVE_CHAPTERS.flatMap((chapter, chapterIndex) => [1, 2, 3].map((n) => ({ chapter, chapterIndex, n, src: archiveImage(chapter.slug, n) })));
  return `<div class="${machine ? "archive-machine" : "archive-album"}">${photos.map((item, index) => `<button data-archive-image="${item.src}" aria-label="放大${item.chapter.title}照片 ${item.n}">
    <img src="${item.src}" alt="${item.chapter.title}照片 ${item.n}" loading="lazy">
    ${machine ? `<span><b>${String(82 + ((index * 7) % 16))}%</b><small>${["自动归位", "方向确认", "低置信复核"][index % 3]}</small><em>${String((index * 37) % 360).padStart(3, "0")}°</em></span>` : `<span><b>${item.chapter.time}</b><small>${item.chapter.chapter} · 视角 ${item.n}</small></span>`}
  </button>`).join("")}</div>`;
}

function archiveJourney(params) {
  const requested = params.get("scene") || ARCHIVE_CHAPTERS[0].id;
  const active = ARCHIVE_CHAPTERS.find((item) => item.id === requested) || ARCHIVE_CHAPTERS[0];
  return `<div class="archive-journey">
    <div class="archive-journey-route">${ARCHIVE_CHAPTERS.map((chapter, index) => `<a class="${chapter.id === active.id ? "active" : ""}" href="${href("/demo-mode", { mode: "journey", scene: chapter.id })}"><b>${chapter.time}</b><span>${chapter.chapter}</span></a>${index < ARCHIVE_CHAPTERS.length - 1 ? "<i></i>" : ""}`).join("")}</div>
    <div class="archive-journey-stage"><img src="../assets/walkdemo/${active.slug}.jpg" alt="${active.title}"><div><p>${active.time} · ${active.chapter}</p><h2>${active.title}</h2><span>${active.copy}</span></div></div>
    <div class="archive-journey-photos">${[1, 2, 3].map((n) => `<button data-archive-image="${archiveImage(active.slug, n)}"><img src="${archiveImage(active.slug, n)}" alt="${active.title}照片 ${n}"><span>视角 ${n}</span></button>`).join("")}</div>
    <a class="button primary archive-walk-cta" href="${href("/demo-player", { id: `walk-${active.id}` })}">走进这个技术样片 <span>→</span></a>
  </div>`;
}

function renderDemoMode(params) {
  const requested = params.get("mode") || "journey";
  const mode = ARCHIVE_MODES.some(([id]) => id === requested) ? requested : "journey";
  const labels = Object.fromEntries(ARCHIVE_MODES);
  let content = "";
  if (mode === "journey") content = archiveJourney(params);
  if (mode === "timeline") content = `<header class="archive-mode-heading"><p class="eyebrow">Timeline</p><h1>这一天，按时间重新发生。</h1><p>同一时刻不再只剩一张精选，而是保留来自不同方向的画面。</p></header>${archiveTimeline()}`;
  if (mode === "album") content = `<header class="archive-mode-heading"><p class="eyebrow">Memory album</p><h1>那一天，摊开来看。</h1><p>这是最接近传统相册的一版，但仍然保留每张照片所属的时刻与场景。</p></header>${archiveAlbum(false)}`;
  if (mode === "machine") content = `<header class="archive-mode-heading"><p class="eyebrow">Machine recall</p><h1>看看机器是怎么记住现场的。</h1><p>照片、方向和置信度被摊成一面可检查的工作墙；不确定项明确进入复核。</p></header>${archiveAlbum(true)}`;
  if (mode === "film") content = `<header class="archive-mode-heading"><p class="eyebrow">One-click film</p><h1>先看一段片子，再走进去。</h1><p>这是最早的双层叙事：短片负责情绪，空间负责让观众自己探索。</p></header><div class="archive-film"><video controls playsinline preload="metadata" poster="../assets/walkdemo/ballroom.jpg"><source src="../assets/videodemo/walkthrough_demo.mp4" type="video/mp4"></video><div><b>空间记忆 · 演示短片</b><span>播放结束后，可继续进入宴会厅技术样片自由查看。</span><a class="button primary" href="${href("/demo-player", { id: "walk-ballroom" })}">走进影片里的空间</a></div></div>`;

  app.innerHTML = shell(
    `<section class="archive-mode-page">${archiveModeTabs(mode)}${content}<footer class="archive-mode-footer"><a href="#/demo-archive">返回 AI 演示档案馆</a><span>·</span><a href="#/demo-vision">查看当前理想成品</a></footer></section>`,
    { title: labels[mode], back: "#/demo-archive", nav: false, flush: true },
  );

  document.querySelectorAll("[data-archive-image]").forEach((button) => {
    button.addEventListener("click", () => {
      const lightbox = document.createElement("div");
      lightbox.className = "archive-lightbox";
      lightbox.innerHTML = `<button aria-label="关闭">×</button><img src="${escapeHtml(button.dataset.archiveImage)}" alt="放大的演示照片">`;
      lightbox.addEventListener("click", () => lightbox.remove());
      document.body.append(lightbox);
    });
  });
}

const DEMO_STORY = [
  {
    kicker: "第一幕 · 散落",
    title: "那一天，被留在了很多人的手机里。",
    copy: "婚礼结束后，新人只拿到了自己看见的那一小部分。朋友们拍下的笑声、拥抱和错过的五分钟，还散在各自的相册里。",
    caption: "一个人的相册，装不下所有人的同一天。",
    visual: "scatter",
  },
  {
    kicker: "第二幕 · 归集",
    title: "不用下载 App，也能把照片放回一起。",
    copy: "宾客打开同一个空间，上传普通照片或已经拍好的 2:1 全景图。照片属于这一天，而不是某一台手机。",
    caption: "一个链接，一起补全。",
    visual: "upload",
  },
  {
    kicker: "第三幕 · 空间",
    title: "不只看见照片，还能重新走进现场。",
    copy: "时间线回答“发生了什么”，全景回答“当时我在哪里”。两种观看方式放在同一个记忆空间里。",
    caption: "从相册，变成可以重访的地方。",
    visual: "space",
  },
  {
    kicker: "第四幕 · 多视角",
    title: "同一时刻，每个人都看见了不同的方向。",
    copy: "UNSEEN 把来自不同人的画面按时间与方向组织起来。点一位拍摄者，就回到 TA 当时朝着的位置。",
    caption: "你错过的，有人替你留住了。",
    visual: "angles",
  },
  {
    kicker: "第五幕 · 共同补全",
    title: "哪里还空着，大家一眼就知道。",
    copy: "缺少的时刻、空白的方向和等待上传的照片都被整理成清楚的线索，主办者不再逐个私聊收图。",
    caption: "整理不再是一个人的收尾工作。",
    visual: "organize",
  },
  {
    kicker: "第六幕 · 成片",
    title: "最后留下的，是一群人的共同记忆。",
    copy: "照片、全景、时间线和每个人的视角，共同构成一个可以分享、可以重看的空间。",
    caption: "一台相机记录画面，一群人补全记忆。",
    visual: "finish",
  },
];

function storyVisual(kind) {
  if (kind === "scatter") return `<div class="story-scatter">
    ${[1, 4, 8, 11].map((n, index) => `<img class="story-photo p${index + 1}" src="./demo-assets/ph_p${n}.jpg" alt="宾客照片 ${index + 1}">`).join("")}
    <span class="story-phone">我的相册</span><span class="story-phone second">朋友的相册</span>
  </div>`;
  if (kind === "upload") return `<div class="story-upload-card"><span class="story-upload-icon">＋</span><b>上传今天的照片</b><small>普通照片 · 成品全景 · 原图保留</small><i><span style="width:72%"></span></i><em>已有 8 位朋友加入</em></div>`;
  if (kind === "space") return `<div class="story-pano"><img src="./demo-assets/pano.jpg" alt="宴会厅全景"><span>拖动回到现场</span><i class="hotspot h1"></i><i class="hotspot h2"></i><i class="hotspot h3"></i></div>`;
  if (kind === "angles") return `<div class="story-angles">${[[2,"小明 · 正前方"],[6,"小红 · 左侧"],[10,"阿伟 · 右侧"]].map(([n, label]) => `<figure><img src="./demo-assets/ph_p${n}.jpg" alt="${label}"><figcaption>${label}</figcaption></figure>`).join("")}</div>`;
  if (kind === "organize") return `<div class="story-board"><div><b>11</b><span>张照片</span></div><div><b>7</b><span>已归位</span></div><div><b>4</b><span>待确认</span></div><p><i></i> 右侧舞台还缺一段视角</p><p><i></i> 18:20 合影正在等待补全</p></div>`;
  return `<div class="story-finish"><img src="./demo-assets/pano.jpg" alt="完成后的共同记忆空间"><div><span>十月六日</span><b>我们的婚礼</b><small>12 位朋友 · 86 张照片 · 3 个全景</small></div></div>`;
}

function renderDemoStory(params) {
  const requested = Number(params.get("scene") || 1);
  const index = Math.max(0, Math.min(DEMO_STORY.length - 1, Number.isFinite(requested) ? requested - 1 : 0));
  const scene = DEMO_STORY[index];
  const prev = href("/demo-story", { scene: Math.max(1, index) });
  const next = index === DEMO_STORY.length - 1 ? "#/demo-vision" : href("/demo-story", { scene: index + 2 });
  app.innerHTML = shell(
    `<section class="story-page">
       <div class="story-progress" aria-label="第 ${index + 1} 幕，共 ${DEMO_STORY.length} 幕"><i style="width:${((index + 1) / DEMO_STORY.length) * 100}%"></i></div>
       <div class="story-count">${String(index + 1).padStart(2, "0")} / ${String(DEMO_STORY.length).padStart(2, "0")}</div>
       <div class="story-stage">${storyVisual(scene.visual)}</div>
       <div class="story-copy-block"><p class="eyebrow">${scene.kicker}</p><h1>${scene.title}</h1><p>${scene.copy}</p><blockquote>${scene.caption}</blockquote></div>
       <div class="story-dots">${DEMO_STORY.map((_, i) => `<a class="${i === index ? "active" : ""}" href="${href("/demo-story", { scene: i + 1 })}" aria-label="第 ${i + 1} 幕"></a>`).join("")}</div>
       <div class="story-actions"><a class="button secondary ${index === 0 ? "disabled" : ""}" ${index === 0 ? "aria-disabled=\"true\"" : `href="${prev}"`}>上一幕</a><a class="button primary" href="${next}">${index === DEMO_STORY.length - 1 ? "进入理想成品" : "下一幕"} <span>→</span></a></div>
     </section>`,
    { title: "六幕产品故事", back: "#/demo", nav: false },
  );
}

const VISION_TABS = [
  ["overview", "空间"],
  ["timeline", "时间线"],
  ["pano", "全景"],
  ["pov", "TA 视角"],
];

const VISION_POV = [
  { label: "小明 · 正前方", src: "./demo-assets/ph_p2.jpg", title: "交换戒指", copy: "18:08，他站在过道中央，正面看见这一刻。" },
  { label: "小红 · 右侧", src: "./demo-assets/ph_p4.jpg", title: "父亲的笑", copy: "18:09，她从右侧桌边拍到了新人没看见的表情。" },
  { label: "阿伟 · 后方", src: "./demo-assets/ph_p8.jpg", title: "朋友们举杯", copy: "18:21，他转向身后，留下整个朋友桌的欢呼。" },
  { label: "匿名宾客 · 左侧", src: "./demo-assets/ph_p11.jpg", title: "花童跑过", copy: "18:23，这段只存在于左侧宾客的手机里。" },
];

function visionPanel(tab) {
  if (tab === "timeline") return `<section class="vision-panel"><div class="vision-panel-head"><div><p class="eyebrow">Timeline</p><h2>这一天，按时间重新发生。</h2></div><span>86 张照片</span></div>
    <div class="vision-timeline">
      ${[[1,"17:42","宾客陆续抵达"],[2,"18:08","交换戒指"],[4,"18:09","台下的笑声"],[6,"18:21","朋友们举杯"],[8,"18:23","花童跑过"],[11,"19:06","最后一张合影"]].map(([n,time,title]) => `<figure><img src="./demo-assets/ph_p${n}.jpg" alt="${title}"><figcaption><b>${time}</b><span>${title}</span></figcaption></figure>`).join("")}
    </div></section>`;
  if (tab === "pano") return `<section class="vision-panel"><div class="vision-panel-head"><div><p class="eyebrow">Panorama</p><h2>拖动方向，回到宴会厅中央。</h2></div><span>2:1 全景</span></div>
    <div class="vision-pano" id="visionPano"><img id="visionPanoImage" src="./demo-assets/pano.jpg" alt="宴会厅 360 度全景"><div class="vision-pano-hint" id="visionPanoLabel">正前方 · 舞台</div><i class="vision-pano-pin p1"></i><i class="vision-pano-pin p2"></i></div>
    <div class="vision-direction" aria-label="选择全景方向">${[[0,"正前"],[-22,"右侧"],[-45,"后方"],[-68,"左侧"]].map(([x,label], i) => `<button class="${i === 0 ? "active" : ""}" data-pano-x="${x}" data-pano-label="${label}">${label}</button>`).join("")}</div>
    <div class="vision-note"><b>理想交互</b><p>平面 2D 全景始终可见；支持 WebGL 时再由用户主动进入沉浸模式，失败也会自动回到这里。</p></div></section>`;
  if (tab === "pov") return `<section class="vision-panel"><div class="vision-panel-head"><div><p class="eyebrow">Point of view</p><h2>回到 TA 当时朝着的方向。</h2></div><span>4 个视角</span></div>
    <div class="vision-pov-stage"><img id="visionPovImage" src="${VISION_POV[0].src}" alt="${VISION_POV[0].label}"><div class="vision-pov-radar"><i></i><i></i><i></i><i></i><b>你</b></div><span id="visionPovLabel">${VISION_POV[0].label}</span></div>
    <div class="vision-direction vision-direction--pov">${VISION_POV.map((item, index) => `<button class="${index === 0 ? "active" : ""}" data-pov-index="${index}">${item.label.split(" · ")[0]}</button>`).join("")}</div>
    <div class="vision-pov-copy"><b id="visionPovTitle">${VISION_POV[0].title}</b><p id="visionPovCopy">${VISION_POV[0].copy}</p></div>
    <div class="vision-note"><b>能力边界</b><p>这个 Demo 表达目标体验。正式能力仍需可靠的相机位姿与图像配准，不能把粗略方向分类冒充真实拍摄位置。</p></div></section>`;
  return `<section class="vision-panel"><div class="vision-panel-head"><div><p class="eyebrow">Shared memory</p><h2>一个可以共同补全的地方。</h2></div><span>演示数据</span></div>
    <div class="vision-stats"><div><b>12</b><span>位朋友</span></div><div><b>86</b><span>张照片</span></div><div><b>3</b><span>个全景</span></div></div>
    <div class="vision-live"><span class="vision-avatar">明</span><span class="vision-avatar">红</span><span class="vision-avatar">伟</span><div><b>刚刚又补进 6 张照片</b><small>这个空间仍在长大</small></div></div>
    <div class="vision-memories"><article><img src="./demo-assets/ph_p1.jpg" alt="入场"><span><b>17:42 · 入场</b><small>从三个人的镜头重新看见</small></span></article><article><img src="./demo-assets/ph_p6.jpg" alt="举杯"><span><b>18:21 · 举杯</b><small>还有右后方的视角等待补全</small></span></article></div>
    <a class="vision-next" href="#/demo-vision?tab=timeline"><span><b>沿时间线重新走一遍</b><small>从抵达到最后一张合影</small></span><i>→</i></a></section>`;
}

function renderDemoVision(params) {
  const requested = params.get("tab") || "overview";
  const tab = VISION_TABS.some(([id]) => id === requested) ? requested : "overview";
  app.innerHTML = shell(
    `<section class="vision-page">
       <div class="vision-cover"><img src="./demo-assets/pano.jpg" alt="宴会厅全景"><div class="vision-cover-shade"></div><span class="vision-demo-badge">IDEAL PRODUCT DEMO</span><div><p>2026.10.06 · Brisbane</p><h1>我们的婚礼</h1><small>由 12 位朋友一起补全</small></div></div>
       <nav class="vision-tabs" aria-label="成品演示视图">${VISION_TABS.map(([id,label]) => `<a class="${id === tab ? "active" : ""}" href="${href("/demo-vision", { tab: id })}">${label}</a>`).join("")}</nav>
       ${visionPanel(tab)}
       <div class="vision-footer"><a href="#/demo-story">看六幕产品故事</a><span>·</span><a href="#/demo">返回全部演示</a></div>
     </section>`,
    { title: "理想成品", back: "#/demo", nav: false, flush: true },
  );

  document.querySelectorAll("[data-pano-x]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-pano-x]").forEach((item) => item.classList.toggle("active", item === button));
      const image = document.querySelector("#visionPanoImage");
      const label = document.querySelector("#visionPanoLabel");
      if (image) image.style.transform = `translateX(${button.dataset.panoX}%)`;
      if (label) label.textContent = `${button.dataset.panoLabel} · 宴会厅`;
    });
  });
  document.querySelectorAll("[data-pov-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = VISION_POV[Number(button.dataset.povIndex)] || VISION_POV[0];
      document.querySelectorAll("[data-pov-index]").forEach((node) => node.classList.toggle("active", node === button));
      const image = document.querySelector("#visionPovImage");
      if (image) { image.src = item.src; image.alt = item.label; }
      const label = document.querySelector("#visionPovLabel");
      const title = document.querySelector("#visionPovTitle");
      const copy = document.querySelector("#visionPovCopy");
      if (label) label.textContent = item.label;
      if (title) title.textContent = item.title;
      if (copy) copy.textContent = item.copy;
    });
  });
}

async function renderSpaces() {
  const token = ++state.renderToken;
  releaseObjectUrls();
  let drafts = [];
  let remoteRecords = [];
  let storageError = "";
  try {
    [drafts, remoteRecords] = await Promise.all([listDrafts(), listRemoteRecords()]);
  } catch (error) {
    storageError = error.message;
  }
  if (token !== state.renderToken) return;
  const rows = drafts.map((draft) => {
    const source = draft.coverBlob || draft.panoramaBlob || draft.photos?.[0]?.blob;
    const thumb = source ? makeObjectUrl(source) : "";
    return `<div class="card draft-row">
      <a href="${href("/space", { draft: draft.id })}">${thumb ? `<img class="draft-thumb" src="${thumb}" alt="">` : `<span class="draft-thumb scene-icon">✦</span>`}</a>
      <a class="draft-meta" href="${href("/space", { draft: draft.id })}"><b>${escapeHtml(draft.title)}</b><small>本机草稿 · ${draft.photos?.length || 0} 张照片</small></a>
      <button class="icon-button" data-delete-draft="${escapeHtml(draft.id)}" aria-label="删除草稿">×</button>
    </div>`;
  }).join("");
  const remoteRows = remoteRecords.map((record) => `
    <a class="card draft-row" href="${href("/space", { s: record.sid })}">
      <span class="draft-thumb scene-icon">☁</span>
      <span class="draft-meta"><b>${escapeHtml(record.title)}</b><small>共享空间 · ${escapeHtml(record.date || record.sid)}${record.hostKey ? " · 创建者" : ""}</small></span>
      <span aria-hidden="true">›</span>
    </a>`).join("");
  app.innerHTML = shell(
    `<div class="page-heading"><h1>我的空间</h1><p>重新打开共享空间，或继续本机草稿</p></div>
     ${storageError ? `<div class="notice error">${escapeHtml(storageError)}</div>` : ""}
     <div class="action-stack"><a class="button primary" href="#/create">创建共享空间</a><a class="button secondary" href="#/join">打开已有空间</a></div>
     <div class="section-title"><div><h2>共享空间</h2><p>历史保存在本机，不含于分享链接</p></div></div>
     <div class="draft-list">${remoteRows || `<div class="card empty-state"><b>还没有共享空间记录</b><p>创建或打开后会出现在这里。</p></div>`}</div>
     <div class="section-title"><div><h2>本机草稿</h2></div></div>
     <div class="draft-list">${rows || `<div class="card empty-state"><b>还没有本机草稿</b><p>创建后可以在这台设备继续补照片。</p></div>`}</div>`,
    { active: "spaces" },
  );
  document.querySelectorAll("[data-delete-draft]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (state.uploadLock || !confirm("删除这份本机草稿及其中保存的照片？")) return;
      await deleteDraft(button.dataset.deleteDraft);
      renderSpaces();
    });
  });
}

function readFileHeader(file, count = 64) {
  return file.slice(0, count).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function readImageDimensions(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file).then((bitmap) => {
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法解码这张图片"));
    };
    image.src = url;
  });
}

async function renderCreate(params) {
  releaseObjectUrls();
  const scene = params.get("scene") || "婚礼";
  app.innerHTML = shell(
    `<div class="page-heading"><h1>创建记忆空间</h1><p>默认创建可分享的云端空间；也可以明确选择仅保存在本机</p></div>
     <div class="notice">UNSEEN 当前不提供全景拍摄或拼接。全景请上传外部相机或第三方软件已经制作完成的 2:1 图片。</div>
     <form class="form-grid" id="createForm" novalidate>
       <label class="field"><span>空间名称</span><input class="input" name="title" maxlength="60" required placeholder="例如：小林和阿哲的婚礼"></label>
       <label class="field"><span>场景</span><select class="select" name="scene">${["婚礼","旅行","聚会","日常"].map((value) => `<option${value === scene ? " selected" : ""}>${value}</option>`).join("")}</select></label>
       <label class="field"><span>日期（可选）</span><input class="input" name="date" type="date"></label>
       <label class="field"><span>地点（可选）</span><input class="input" name="place" maxlength="80" placeholder="例如：布里斯班河畔"></label>
       <label class="field"><span>一句话说明（可选）</span><input class="input" name="subtitle" maxlength="120" placeholder="例如：把大家手机里的那一天放回一起"></label>
       <label class="field"><span>封面（可选）</span><span class="file-drop"><span><b>选择一张封面</b><small>JPEG / PNG / WebP，最大 20 MB</small></span><input id="coverInput" type="file" accept="image/jpeg,image/png,image/webp"></span><span id="coverResult"></span></label>
       <label class="field"><span>成品 2:1 全景（可选）</span><span class="file-drop"><span><b>选择外部完成的全景图</b><small>原文件保存，不压缩；至少 1600×800，最大 50 MB</small></span><input id="panoInput" type="file" accept="image/jpeg,image/png,image/webp"></span><span id="panoResult"></span></label>
       <div id="createStatus" class="notice" role="status" hidden></div>
       <div class="action-stack create-actions">
         <button class="button primary" id="createSubmit" type="submit">创建共享空间</button>
         <button class="button secondary" id="createLocal" type="button">仅保存在本机</button>
       </div>
     </form>`,
    { title: "创建空间", back: "#/", active: "create" },
  );

  const form = document.querySelector("#createForm");
  const submit = document.querySelector("#createSubmit");
  const localSubmit = document.querySelector("#createLocal");
  const status = document.querySelector("#createStatus");
  const clientCreateId = createClientUploadId();
  let coverFile = null;
  let panoramaFile = null;
  let coverChecking = false;
  let panoramaChecking = false;
  let coverCheckId = 0;
  let panoramaCheckId = 0;
  let createStage = "";

  function setCreateStatus(message, error = false) {
    status.hidden = !message;
    status.textContent = message || "";
    status.classList.toggle("error", error);
  }

  function syncCreateButton() {
    const checking = coverChecking || panoramaChecking;
    submit.disabled = state.createLock || checking;
    localSubmit.disabled = state.createLock || checking;
    submit.textContent = state.createLock ? (createStage || "正在创建共享空间…") : checking ? "正在校验图片…" : "创建共享空间";
    localSubmit.textContent = state.createLock && createStage === "正在保存到本机…" ? createStage : "仅保存在本机";
  }

  document.querySelector("#coverInput").addEventListener("change", async (event) => {
    const checkId = ++coverCheckId;
    const file = event.target.files?.[0] || null;
    const result = document.querySelector("#coverResult");
    coverFile = null;
    result.innerHTML = "";
    if (!file) { coverChecking = false; syncCreateButton(); return; }
    coverChecking = true;
    syncCreateButton();
    try {
      const bytes = await readFileHeader(file);
      const verdict = validatePhotoDescriptor({ name: file.name, type: file.type, size: file.size, bytes });
      if (!verdict.ok) throw new Error(verdict.message);
      await readImageDimensions(file);
      if (checkId !== coverCheckId) return;
      coverFile = file;
      const url = makeObjectUrl(file);
      result.innerHTML = `<div class="preview-frame"><img src="${url}" alt="封面预览"></div><small>${escapeHtml(file.name)} · ${formatBytes(file.size)}</small>`;
    } catch (error) {
      if (checkId !== coverCheckId) return;
      event.target.value = "";
      result.innerHTML = `<span class="notice error">${escapeHtml(error.message)}</span>`;
    } finally {
      if (checkId === coverCheckId) {
        coverChecking = false;
        syncCreateButton();
      }
    }
  });

  document.querySelector("#panoInput").addEventListener("change", async (event) => {
    const checkId = ++panoramaCheckId;
    const file = event.target.files?.[0] || null;
    const result = document.querySelector("#panoResult");
    panoramaFile = null;
    result.innerHTML = "";
    if (!file) { panoramaChecking = false; syncCreateButton(); return; }
    panoramaChecking = true;
    syncCreateButton();
    try {
      const [bytes, dimensions] = await Promise.all([readFileHeader(file), readImageDimensions(file)]);
      if (checkId !== panoramaCheckId) return;
      const verdict = validatePanoramaDescriptor({ name: file.name, type: file.type, size: file.size, bytes, ...dimensions });
      if (!verdict.ok) throw new Error(verdict.message);
      panoramaFile = file;
      const url = makeObjectUrl(file);
      result.innerHTML = `<div class="preview-frame"><img src="${url}" alt="2:1 全景预览"></div><small>${dimensions.width}×${dimensions.height} · ${formatBytes(file.size)} · 原文件</small>`;
    } catch (error) {
      if (checkId !== panoramaCheckId) return;
      event.target.value = "";
      result.innerHTML = `<span class="notice error">${escapeHtml(error.message || "无法读取全景图")}</span>`;
    } finally {
      if (checkId === panoramaCheckId) {
        panoramaChecking = false;
        syncCreateButton();
      }
    }
  });

  function formValues() {
    const data = new FormData(form);
    return {
      title: String(data.get("title") || "").trim(),
      scene: String(data.get("scene") || ""),
      date: String(data.get("date") || ""),
      place: String(data.get("place") || "").trim(),
      subtitle: String(data.get("subtitle") || "").trim(),
    };
  }

  function validateCreate(values) {
    if (coverChecking || panoramaChecking) {
      toast("图片仍在校验，请稍候");
      return false;
    }
    if (values.title) return true;
    form.elements.title.focus();
    toast("请先填写空间名称");
    return false;
  }

  async function saveLocal(values) {
    const id = `local-${Date.now().toString(36)}-${createClientUploadId().slice(0, 6)}`;
    const now = Date.now();
    await putDraft({
      id,
      title: values.title,
      scene: values.scene,
      date: values.date,
      place: values.place,
      subtitle: values.subtitle,
      coverBlob: coverFile,
      coverName: coverFile?.name || "",
      panoramaBlob: panoramaFile,
      panoramaName: panoramaFile?.name || "",
      photos: [],
      createdAt: now,
      updatedAt: now,
      localOnly: true,
    });
    state.current = null;
    location.hash = href("/space", { draft: id }).slice(1);
  }

  async function createShared(values) {
    createStage = "正在创建共享空间…";
    setCreateStatus("正在向云端申请空间…");
    syncCreateButton();
    const created = await callManagedApi("createSpace", {
      clientCreateId,
      title: values.title,
      date: values.date,
      place: values.place,
      subtitle: values.subtitle,
      media: { cover: Boolean(coverFile), panorama: Boolean(panoramaFile) },
    });
    const sid = String(created?.spaceId || "");
    const hostKey = String(created?.hostKey || "");
    if (!/^u[a-f0-9]{24}$/.test(sid) || !hostKey) throw new Error("云端没有返回完整的空间凭证，请重试");

    if (created.status !== "published") {
      for (const [purpose, file] of [["cover", coverFile], ["panorama", panoramaFile]]) {
        if (!file) continue;
        createStage = purpose === "cover" ? "正在上传封面…" : "正在上传成品全景…";
        setCreateStatus(`${createStage}（失败后可安全重试，不会重复创建空间）`);
        syncCreateButton();
        const verdict = exactUploadPolicyStatus(created.uploads?.[purpose], {
          expectedKey: `unseen-backend/v1/staging/${sid}/${purpose}.bin`,
        });
        if (!verdict.ok) throw new Error(verdict.message);
        if (file.size > verdict.policy.maxSize) throw new Error(`${purpose === "cover" ? "封面" : "成品全景"}超过云端允许的大小`);
        await exactUploadWithRetry(verdict.policy, file, () => {});
      }
    }

    createStage = "正在发布共享空间…";
    setCreateStatus("素材已上传，正在发布空间…");
    syncCreateButton();
    const finalized = await callManagedApi("finalizeSpace", {
      spaceId: sid,
      useCover: Boolean(coverFile),
      usePanorama: Boolean(panoramaFile),
    }, { hostKey });
    if (finalized?.status !== "published") throw new Error("云端尚未确认空间发布，请重试");
    const manifestUrl = String(finalized.manifestUrl || created.manifestUrl || "");
    await rememberRemoteSpace({
      sid,
      title: finalized.manifest?.title || values.title,
      date: finalized.manifest?.date || values.date,
      manifestUrl,
      hostKey,
    });
    state.current = null;
    location.hash = href("/space", { s: sid }).slice(1);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.createLock) return;
    const values = formValues();
    if (!validateCreate(values)) return;
    state.createLock = true;
    setCreateStatus("");
    syncCreateButton();
    try {
      await createShared(values);
    } catch (error) {
      setCreateStatus(error.message || "共享空间创建失败，请重试", true);
      toast(error.message || "共享空间创建失败，请重试");
    } finally {
      state.createLock = false;
      createStage = "";
      if (submit.isConnected) syncCreateButton();
    }
  });

  localSubmit.addEventListener("click", async () => {
    if (state.createLock) return;
    const values = formValues();
    if (!validateCreate(values)) return;
    state.createLock = true;
    createStage = "正在保存到本机…";
    setCreateStatus("正在保存本机草稿；不会创建或上传云端空间。");
    syncCreateButton();
    try {
      await saveLocal(values);
    } catch (error) {
      setCreateStatus(error.message || "本机草稿保存失败", true);
      toast(error.message || "本机草稿保存失败");
    } finally {
      state.createLock = false;
      createStage = "";
      if (submit.isConnected) syncCreateButton();
    }
  });
}

function renderJoin() {
  releaseObjectUrls();
  app.innerHTML = shell(
    `<div class="page-heading"><h1>加入记忆空间</h1><p>粘贴邀请链接，或直接输入空间编号</p></div>
     <form class="form-grid" id="joinForm">
       <label class="field"><span>空间链接 / 编号</span><input class="input" name="target" autocomplete="off" required placeholder="例如：s4 或完整邀请链接"></label>
       <button class="button primary" type="submit">打开空间</button>
     </form>
     <div class="notice">这是 bearer-link MVP：拿到链接的人可以查看空间；正式版只连接 UNSEEN 官方存储，不会把照片发送到邀请链接指定的第三方地址。</div>`,
    { title: "加入空间", back: "#/", nav: false },
  );
  const form = document.querySelector("#joinForm");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const target = parseSpaceTarget(data.get("target"), DEFAULT_OSS_BASE);
    if (!target.ok) {
      toast(target.message);
      return;
    }
    state.current = null;
    location.hash = href("/space", { s: target.sid }).slice(1);
  });
}

function remotePhotoUrl(photo, current) {
  return safeAssetUrl(photo.thumb || photo.src, current.base, current.sid);
}

async function renderSpace(params) {
  releaseObjectUrls();
  loadingPage();
  try {
    const current = await resolveSpace(params);
    const local = current.kind === "local";
    const space = local ? current.draft : current.space;
    const photos = local ? (space.photos || []) : space.photos;
    const pending = local ? [] : (space.pending || []);
    const cover = local
      ? makeObjectUrl(space.coverBlob || space.panoramaBlob || photos[0]?.blob)
      : safeAssetUrl(space.cover || space.panorama, current.base, current.sid);
    const panorama = local ? (space.panoramaBlob ? true : false) : Boolean(space.panorama);
    const policy = local ? { ok: true } : uploadPolicyStatus(space);
    const uploadNotice = local
      ? "本机草稿：照片只保存在这台设备，不会同步给其他人。"
      : policy.ok
        ? "上传通道可用；照片将直传空间存储。"
        : policy.message;
    const photoGrid = photos.slice().reverse().map((photo) => {
      const src = local ? makeObjectUrl(photo.blob) : remotePhotoUrl(photo, current);
      return src ? `<img src="${src}" alt="${escapeHtml(photo.contributor ? `${photo.contributor} 上传的照片` : "空间照片")}" loading="lazy">` : "";
    }).join("");
    const people = local ? 1 : new Set(photos.map((photo) => photo.contributor).filter(Boolean)).size;
    const panoUrl = href("/panorama", currentParams());
    const uploadUrl = href("/upload", currentParams());

    app.innerHTML = shell(
      `<section class="space-cover">${cover ? `<img src="${cover}" alt="${escapeHtml(space.title)} 封面">` : ""}<div class="space-cover-text"><h1>${escapeHtml(space.title)}</h1><p>${escapeHtml([space.date, space.place].filter(Boolean).join(" · ") || (local ? "本机草稿" : "共同记忆空间"))}</p></div></section>
       <div class="space-body">
         <div class="notice ${!local && !policy.ok ? "error" : local ? "" : "success"}">${escapeHtml(uploadNotice)}</div>
         ${pending.length ? `<div class="notice">还有 ${pending.length} 份投稿等待主办方确认；待确认不代表照片丢失。</div>` : ""}
         <div class="stat-grid"><div class="stat"><b>${photos.length}</b><span>照片</span></div><div class="stat"><b>${people}</b><span>贡献者</span></div><div class="stat"><b>${panorama ? 1 : 0}</b><span>成品全景</span></div></div>
         <div class="action-stack">
           <a class="button primary${!local && !policy.ok ? " disabled" : ""}" ${!local && !policy.ok ? `aria-disabled="true" data-upload-blocked="${escapeHtml(policy.message)}"` : `href="${uploadUrl}"`}>上传普通照片</a>
           ${panorama ? `<a class="button secondary" href="${panoUrl}">查看 2D 全景</a>` : ""}
           ${local ? `<button class="button secondary compact" id="exportDraft">导出发布配置</button>` : `<button class="button secondary compact" id="shareSpace">复制邀请链接</button>`}
         </div>
         <div class="section-title"><div><h2>照片时间轴</h2><p>${local ? "本机保存" : "来自空间公开数据"}</p></div></div>
         <div class="photo-grid">${photoGrid}</div>
         ${photoGrid ? "" : `<div class="card empty-state"><b>空间里还没有照片</b><p>上传后会从这里开始共同补全。</p></div>`}
       </div>`,
      { title: space.title, back: "#/spaces", flush: true, nav: false },
    );

    document.querySelector("[data-upload-blocked]")?.addEventListener("click", (event) => {
      event.preventDefault();
      toast(event.currentTarget.dataset.uploadBlocked);
    });
    document.querySelector("#shareSpace")?.addEventListener("click", async () => {
      const shareUrl = new URL("./index.html", location.href);
      shareUrl.search = new URLSearchParams({ s: current.sid }).toString();
      shareUrl.hash = "";
      try {
        await navigator.clipboard.writeText(shareUrl.href);
        toast("邀请链接已复制");
      } catch {
        prompt("复制这个邀请链接", shareUrl.href);
      }
    });
    document.querySelector("#exportDraft")?.addEventListener("click", () => {
      const manifest = {
        schema: "unseen-local-draft/1",
        id: space.id,
        title: space.title,
        scene: space.scene,
        date: space.date,
        place: space.place,
        coverFile: space.coverName || "",
        panoramaFile: space.panoramaName || "",
        photoFiles: (space.photos || []).map((photo) => photo.name),
        note: "媒体原文件保存在浏览器 IndexedDB 中；发布工具需要重新选择或导入这些文件。",
      };
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${space.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  } catch (error) {
    errorPage("打不开这个空间", error.message);
  }
}

function queueStatus(item) {
  const labels = {
    pending: "待处理",
    processing: "处理中",
    uploading: `上传 ${Math.round(item.progress || 0)}%`,
    saving: "保存中",
    done: item.local ? "已存本机" : "已上传",
    error: "失败",
  };
  return labels[item.status] || item.status;
}

function queueRows() {
  return state.queue.map((item) => {
    return `<div class="card queue-row" data-item-id="${item.clientUploadId}">
      <span class="queue-thumb queue-file-icon" aria-hidden="true">IMG</span>
      <div class="queue-meta"><b>${escapeHtml(item.file.name)}</b><small class="queue-detail">${escapeHtml(item.error || `${formatBytes(item.file.size)} · ${queueStatus(item)}`)}</small><div class="progress"><i style="width:${item.status === "done" ? 100 : item.progress || 0}%"></i></div></div>
      <span class="status-pill ${item.status === "done" ? "done" : item.status === "error" ? "error" : ""}">${escapeHtml(queueStatus(item))}</span>
      <button class="icon-button" data-remove="${item.clientUploadId}" aria-label="移除 ${escapeHtml(item.file.name)}" ${state.uploadLock ? "disabled" : ""}>×</button>
    </div>`;
  }).join("");
}

function renderUploadControls(current, policy) {
  const actionable = state.queue.filter((item) => item.status === "pending" || (item.status === "error" && item.retryable));
  const failed = state.queue.some((item) => item.status === "error" && item.retryable);
  const allDone = state.queue.length > 0 && state.queue.every((item) => item.status === "done" || (item.status === "error" && !item.retryable));
  const blocked = current.kind === "remote" && !policy.ok;
  return `<label class="file-drop"><span><b>选择普通照片</b><small>JPEG / PNG / WebP，单张最大 20 MB，一批最多 9 张</small></span><input id="photoInput" type="file" accept="image/jpeg,image/png,image/webp" multiple ${state.uploadLock || state.queue.length >= MAX_BATCH_ITEMS ? "disabled" : ""}></label>
    <div class="photo-queue" id="photoQueue">${queueRows()}</div>
    ${blocked ? `<div class="notice error">${escapeHtml(policy.message)}</div><button class="button secondary compact" id="refreshUploadPolicy">重新检查上传通道</button>` : ""}
    <div class="action-stack">
      <button class="button primary" id="startUpload" ${state.uploadLock || !actionable.length || blocked ? "disabled" : ""}>${state.uploadLock ? "正在处理…" : failed ? "只重试失败项" : `开始处理 ${actionable.length || ""} 张`}</button>
      ${allDone ? `<a class="button secondary" href="${href("/space", currentParams())}">完成并返回空间</a>` : `<a class="button secondary" href="${href("/space", currentParams())}" ${state.uploadLock ? "aria-disabled=\"true\" data-leave-blocked" : ""}>返回空间</a>`}
    </div>`;
}

async function renderUpload(params) {
  releaseObjectUrls();
  loadingPage("正在准备照片上传…");
  try {
    const current = await resolveSpace(params);
    const space = current.kind === "local" ? current.draft : current.space;
    const policy = current.kind === "local" ? { ok: true } : uploadPolicyStatus(space);
    app.innerHTML = shell(
      `<div class="page-heading"><h1>上传普通照片</h1><p>${current.kind === "local" ? "照片将压缩后保存到本机草稿" : "照片将压缩后直传空间存储"}</p></div>
       <div class="notice">大图会在本机压缩到最大边约 2560px、质量约 0.82；HEIC/HEIF 会在上传前阻断。</div>
       <section id="uploadControls">${renderUploadControls(current, policy)}</section>`,
      { title: "上传照片", back: href("/space", currentParams()), nav: false },
    );
    bindUploadControls(current, policy);
  } catch (error) {
    errorPage("无法准备上传", error.message);
  }
}

function refreshUploadControls(current, policy) {
  releaseObjectUrls();
  const controls = document.querySelector("#uploadControls");
  if (!controls) return;
  controls.innerHTML = renderUploadControls(current, policy);
  bindUploadControls(current, policy);
}

function bindUploadControls(current, policy) {
  document.querySelector("#refreshUploadPolicy")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "正在检查…";
    try {
      const fresh = await fetchRemoteSpace(current.sid, current.base);
      current.space = fresh;
      const refreshed = uploadPolicyStatus(fresh);
      refreshUploadControls(current, refreshed);
      if (refreshed.ok) toast("上传通道已恢复，可以继续处理队列");
    } catch (error) {
      button.disabled = false;
      button.textContent = "重新检查上传通道";
      toast(error.message || "暂时无法检查上传通道");
    }
  });
  document.querySelector("#photoInput")?.addEventListener("change", async (event) => {
    if (state.uploadLock) return;
    const remaining = Math.max(0, MAX_BATCH_ITEMS - state.queue.length);
    const selected = Array.from(event.target.files || []);
    if (selected.length > remaining) toast(`一批最多 9 张，本次只加入前 ${remaining} 张`);
    for (const file of selected.slice(0, remaining)) {
      const bytes = await readFileHeader(file);
      const verdict = validatePhotoDescriptor({ name: file.name, type: file.type, size: file.size, bytes });
      state.queue.push({
        clientUploadId: createClientUploadId(),
        selectedAt: Date.now(),
        file,
        status: verdict.ok ? "pending" : "error",
        progress: 0,
        error: verdict.ok ? "" : verdict.message,
        retryable: false,
        local: current.kind === "local",
      });
    }
    refreshUploadControls(current, policy);
  });
  document.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.uploadLock) return;
      state.queue = state.queue.filter((item) => item.clientUploadId !== button.dataset.remove);
      refreshUploadControls(current, policy);
    });
  });
  document.querySelector("#startUpload")?.addEventListener("click", () => startUpload(current, policy));
  document.querySelector("[data-leave-blocked]")?.addEventListener("click", (event) => {
    event.preventDefault();
    toast("请等待当前上传完成");
  });
}

function updateQueueRow(item) {
  const row = document.querySelector(`[data-item-id="${item.clientUploadId}"]`);
  if (!row) return;
  row.querySelector(".queue-detail").textContent = item.error || `${formatBytes(item.file.size)} · ${queueStatus(item)}`;
  const pill = row.querySelector(".status-pill");
  pill.textContent = queueStatus(item);
  pill.className = `status-pill ${item.status === "done" ? "done" : item.status === "error" ? "error" : ""}`;
  row.querySelector(".progress i").style.width = `${item.status === "done" ? 100 : item.progress || 0}%`;
}

async function compressPhoto(file) {
  let bitmap;
  let image;
  let revoke = () => {};
  try {
    if (window.createImageBitmap) bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    else {
      const url = URL.createObjectURL(file);
      revoke = () => URL.revokeObjectURL(url);
      image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("无法解码这张图片"));
        img.src = url;
      });
    }
    const source = bitmap || image;
    const sourceWidth = source.width || source.naturalWidth;
    const sourceHeight = source.height || source.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new Error("无法读取图片尺寸");
    const scale = Math.min(1, 2560 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片压缩失败")), "image/jpeg", 0.82));
    canvas.width = 0;
    canvas.height = 0;
    return { blob, width, height };
  } finally {
    bitmap?.close();
    revoke();
  }
}

function postToOss(policy, key, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("key", key);
    form.append("OSSAccessKeyId", policy.accessKeyId);
    form.append("policy", policy.policy);
    form.append("Signature", policy.signature);
    form.append("x-oss-object-acl", "private");
    form.append("file", blob, "photo.jpg");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", policy.host, true);
    xhr.timeout = 60000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 409) resolve(xhr.status);
      else {
        const error = new Error(xhr.status === 403 ? "上传策略已过期或无权写入" : `上传失败（HTTP ${xhr.status}）`);
        error.status = xhr.status;
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error("网络中断，照片没有上传"));
    xhr.ontimeout = () => reject(new Error("上传超时，请检查网络后重试"));
    xhr.send(form);
  });
}

function postExactToOss(policy, blob, fileName, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(policy.fields)) form.append(name, String(value));
    form.append("file", blob, fileName || "upload.bin");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", policy.host, true);
    xhr.timeout = OSS_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 409) resolve(xhr.status);
      else {
        const error = new Error(xhr.status === 403 ? "上传票据已过期或无权写入，请重试" : `素材上传失败（HTTP ${xhr.status}）`);
        error.status = xhr.status;
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error("网络中断，素材没有上传；可以安全重试"));
    xhr.ontimeout = () => reject(new Error("素材上传超过 90 秒，已停止；请检查网络后重试"));
    xhr.send(form);
  });
}

async function exactUploadWithRetry(policy, blob, onProgress) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await postExactToOss(policy, blob, blob.name || "upload.bin", onProgress);
    } catch (error) {
      lastError = error;
      const retryable = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 2) break;
      await wait(700 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function saveLocalPhoto(current, item, output) {
  const draft = await getDraft(current.id);
  if (!draft) throw new Error("本机草稿已不存在");
  const photos = Array.isArray(draft.photos) ? draft.photos.slice() : [];
  if (!photos.some((photo) => photo.clientUploadId === item.clientUploadId)) {
    photos.push({
      id: item.clientUploadId,
      clientUploadId: item.clientUploadId,
      name: item.file.name,
      blob: output.blob,
      width: output.width,
      height: output.height,
      addedAt: Date.now(),
    });
  }
  draft.photos = photos;
  draft.updatedAt = Date.now();
  await putDraft(draft);
  current.draft = draft;
}

async function uploadWithRetry(policy, key, blob, onProgress) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await postToOss(policy, key, blob, onProgress);
    } catch (error) {
      lastError = error;
      const retryable = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 700 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function uploadManagedPhoto(current, item, output, managedPolicy) {
  if (output.blob.size > managedPolicy.ticket.maxSize) {
    throw new Error(`压缩后仍有 ${formatBytes(output.blob.size)}，超过该空间的上传限制`);
  }
  const ticket = await callManagedApi("photoTicket", {
    spaceId: current.sid,
    clientUploadId: item.clientUploadId,
    contributor: "匿名参与者",
    caption: "",
  });
  if (ticket?.committed) {
    current.space = await fetchRemoteSpace(current.sid, current.base, current.manifestUrl);
    return;
  }
  if (!ticket?.commitToken) throw new Error("云端没有返回完整的照片提交凭证，请重试");
  const verdict = exactUploadPolicyStatus(ticket.upload, {
    expectedPrefix: `unseen-backend/v1/uploads/${current.sid}/`,
  });
  if (!verdict.ok) throw new Error(verdict.message);
  if (output.blob.size > verdict.policy.maxSize) throw new Error("压缩后的照片超过票据允许大小");
  item.objectKey = verdict.policy.fields.key;
  item.status = "uploading";
  item.progress = 12;
  updateQueueRow(item);
  await exactUploadWithRetry(verdict.policy, output.blob, (fraction) => {
    item.progress = 12 + Math.round(fraction * 80);
    updateQueueRow(item);
  });
  item.status = "saving";
  item.progress = 96;
  updateQueueRow(item);
  const committed = await callManagedApi("commitPhoto", { commitToken: ticket.commitToken });
  if (!committed?.photo?.id) throw new Error("云端没有确认照片入库，请重试");
  const photos = Array.isArray(current.space.photos) ? current.space.photos : [];
  if (!photos.some((photo) => photo.id === committed.photo.id)) photos.push(committed.photo);
  current.space.photos = photos;
}

async function startUpload(current, initialPolicy) {
  if (state.uploadLock) return;
  const items = state.queue.filter((item) => item.status === "pending" || (item.status === "error" && item.retryable));
  if (!items.length) return;
  state.uploadHash = location.hash;
  state.uploadLock = true;
  syncUploadNavigationLock();
  let policy = initialPolicy;
  try {
    if (current.kind === "remote") {
      const fresh = await fetchRemoteSpace(current.sid, current.base);
      current.space = fresh;
      policy = uploadPolicyStatus(fresh);
      if (!policy.ok) throw new Error(policy.message);
    }
    refreshUploadControls(current, policy);
    for (const item of items) {
      item.error = "";
      item.retryable = false;
      item.status = "processing";
      item.progress = 8;
      updateQueueRow(item);
      try {
        const output = await compressPhoto(item.file);
        if (current.kind === "local") {
          item.status = "saving";
          item.progress = 82;
          updateQueueRow(item);
          await saveLocalPhoto(current, item, output);
        } else if (policy.mode === "ticket-v1") {
          await uploadManagedPhoto(current, item, output, policy);
        } else {
          if (output.blob.size > policy.policy.maxSize) throw new Error(`压缩后仍有 ${formatBytes(output.blob.size)}，超过该空间的上传限制`);
          item.status = "uploading";
          item.progress = 12;
          updateQueueRow(item);
          const key = buildOssObjectKey(policy.policy, item, "匿名参与者");
          item.objectKey = key;
          await uploadWithRetry(policy.policy, key, output.blob, (fraction) => {
            item.progress = 12 + Math.round(fraction * 84);
            updateQueueRow(item);
          });
          item.status = "saving";
          item.progress = 98;
          updateQueueRow(item);
        }
        item.status = "done";
        item.progress = 100;
        updateQueueRow(item);
      } catch (error) {
        item.status = "error";
        item.error = error.message || "这张照片处理失败";
        item.retryable = current.kind === "remote" && !/格式|HEIC|超过|尺寸|像素/.test(item.error);
        item.progress = 0;
        updateQueueRow(item);
      }
    }
  } catch (error) {
    for (const item of items) {
      if (item.status === "pending" || item.status === "processing") {
        item.status = "error";
        item.error = error.message;
        item.retryable = current.kind === "remote" && !/地址不是|目录与当前空间不一致/.test(item.error);
      }
    }
    toast(error.message || "上传无法开始");
  } finally {
    state.uploadLock = false;
    state.uploadHash = "";
    syncUploadNavigationLock();
    refreshUploadControls(current, policy);
  }
}

async function renderPanorama(params) {
  releaseObjectUrls();
  loadingPage("正在打开 2D 全景…");
  try {
    const current = await resolveSpace(params);
    const space = current.kind === "local" ? current.draft : current.space;
    const url = current.kind === "local" ? makeObjectUrl(space.panoramaBlob) : safeAssetUrl(space.panorama, current.base, current.sid);
    if (!url) throw new Error("这个空间还没有成品全景图");
    app.innerHTML = `<div class="app-shell"><header class="topbar"><a class="icon-button" href="${href("/space", currentParams())}" aria-label="返回">‹</a><strong class="topbar-title">2D 全景 · ${escapeHtml(space.title)}</strong></header><main class="pano-stage"><div class="pano-canvas" id="panoCanvas"><img id="panoImage" src="${url}" alt="${escapeHtml(space.title)} 的 2:1 全景图" draggable="false"><span class="pano-help">拖动查看细节 · 默认 2D，不启用 WebGL</span></div><div class="pano-controls"><label>缩放 <input id="panoZoom" type="range" min="1" max="3" step="0.05" value="1"><span id="panoZoomValue">100%</span></label></div></main></div>`;
    bindPanoramaViewer();
  } catch (error) {
    errorPage("无法查看全景", error.message, href("/space", currentParams()));
  }
}

function bindPanoramaViewer() {
  const canvas = document.querySelector("#panoCanvas");
  const image = document.querySelector("#panoImage");
  const slider = document.querySelector("#panoZoom");
  const value = document.querySelector("#panoZoomValue");
  let scale = 1;
  let x = 0;
  let y = 0;
  let activePointer = null;
  let startX = 0;
  let startY = 0;
  function clamp() {
    const maxX = Math.max(0, (image.offsetWidth * scale - canvas.clientWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * scale - canvas.clientHeight) / 2);
    x = Math.max(-maxX, Math.min(maxX, x));
    y = Math.max(-maxY, Math.min(maxY, y));
  }
  function draw() {
    clamp();
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    slider.value = String(scale);
    value.textContent = `${Math.round(scale * 100)}%`;
  }
  slider.addEventListener("input", () => {
    scale = Number(slider.value);
    if (scale === 1) x = y = 0;
    draw();
  });
  canvas.addEventListener("pointerdown", (event) => {
    activePointer = event.pointerId;
    startX = event.clientX - x;
    startY = event.clientY - y;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerId !== activePointer || scale <= 1) return;
    x = event.clientX - startX;
    y = event.clientY - startY;
    draw();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (event.pointerId === activePointer) activePointer = null;
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    scale = Math.max(1, Math.min(3, scale + (event.deltaY < 0 ? 0.1 : -0.1)));
    if (scale === 1) x = y = 0;
    draw();
  }, { passive: false });
  image.addEventListener("error", () => errorPage("全景加载失败", "2D 图片无法读取，请检查原文件或网络", href("/space", currentParams())));
}

async function render() {
  if (state.uploadLock) {
    restoreUploadRoute();
    toast("请等待当前上传完成");
    return;
  }
  const route = parseRoute();
  const shouldResetScroll = state.lastRoutePath !== route.path || route.path === "/demo-story";
  state.lastRoutePath = route.path;
  if (shouldResetScroll) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  if (route.path !== "/upload") state.queue = [];
  switch (route.path) {
    case "/": await renderHome(); break;
    case "/demo": renderDemo(); break;
    case "/demo-archive": renderDemoArchive(); break;
    case "/demo-player": renderDemoPlayer(route.params); break;
    case "/demo-mode": renderDemoMode(route.params); break;
    case "/demo-story": renderDemoStory(route.params); break;
    case "/demo-vision": renderDemoVision(route.params); break;
    case "/spaces": await renderSpaces(); break;
    case "/create": await renderCreate(route.params); break;
    case "/join": renderJoin(); break;
    case "/space": await renderSpace(route.params); break;
    case "/upload": await renderUpload(route.params); break;
    case "/panorama": await renderPanorama(route.params); break;
    default:
      history.replaceState(null, "", `${location.pathname}${location.search}#/`);
      await renderHome();
  }
}

document.addEventListener("click", (event) => {
  if (!state.uploadLock) return;
  const anchor = event.target.closest?.("a[href]");
  if (!anchor) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  restoreUploadRoute();
  toast("请等待当前上传完成");
}, true);

window.addEventListener("hashchange", render);
window.addEventListener("beforeunload", (event) => {
  if (!state.uploadLock) return;
  event.preventDefault();
  event.returnValue = "照片正在上传";
});

const initial = new URLSearchParams(location.search);
const initialSpace = initial.get("s") || initial.get("space");
if (initialSpace && !location.hash) {
  const target = parseSpaceTarget(initialSpace, initial.get("b") || DEFAULT_OSS_BASE);
  if (target.ok) location.hash = href("/space", { s: target.sid }).slice(1);
}
render();
