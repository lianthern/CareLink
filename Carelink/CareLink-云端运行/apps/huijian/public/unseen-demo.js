import { normalizeContent, commitAnswer, contentSnapshot } from "/unseen-content.js";
import { openMemoryStore } from "/memory-store.js";
import { appendTranscript, createVoiceInput, mergeTranscriptIntoEditableText } from "/voice-input.js";
import { createTurnVoicePlayer } from "/turn-voice.js";
import { createDemoMemoryField } from "/spatial-memory-field.js";
import {
  OFFICIAL_GALLERY_AUTHOR,
  OFFICIAL_POSTS,
  getOfficialPost
} from "/official-gallery/v1/official-posts.js";

const app = document.querySelector("#app");
const overlayRoot = document.querySelector("#overlay-root");
const reviewRail = document.querySelector(".review-rail");
const photoInput = document.querySelector("#unseen-photo-input");
const cameraInput = document.querySelector("#unseen-camera-input");
const initialOfficialPost = getOfficialPost(new URLSearchParams(globalThis.location.search).get("case"));

const screens = [
  ["splash", "启动页"],
  ["home", "看看 · 官方案例"],
  ["capture", "照片舞台"],
  ["dialogue", "聊聊这张"],
  ["memory", "一页回忆"],
  ["event", "加入现场 · 示意"],
  ["space", "走进照片"],
  ["mine", "我的记忆"]
];

const state = {
  screen: initialOfficialPost ? "case" : "splash",
  history: initialOfficialPost ? ["home"] : [],
  overlay: null,
  photo: null,
  photos: [],
  pairs: [],
  originalMemory: null,
  activePairIndex: -1,
  pendingNewAnswer: false,
  createdAt: Date.now(),
  saving: false,
  resultShape: "memory-page",
  title: "",
  styleId: "evening-paper",
  source: "",
  question: "",
  questionStatus: "idle",
  questionModel: "",
  visibleFacts: [],
  focus: null,
  answerDraft: "",
  answer: "",
  answerMode: "text",
  memoryId: null,
  memoryOrigin: "",
  saved: false,
  memories: [],
  storeStatus: "loading",
  officialPostId: initialOfficialPost?.id ?? null,
  spaceMode: "instant",
  spatialActive: false,
  spatialStatus: "照片层保持不变；动态只是可关闭的观看方式。",
  voicePhase: "idle",
  voiceStatus: "",
  ttsState: { phase: "idle", code: null, canReplay: false },
  requestId: 0,
  toastTimer: null
};

let spatialRuntime = null;
let questionController = null;
let draftTimer = null;
function invalidateQuestion() { state.requestId += 1; questionController?.abort(); questionController = null; }
function persistDraft() {
  if(state.cloudRecord&&!state.memoryId)return;
  try{sessionStorage.setItem("unseen.demo.text-draft",JSON.stringify(Object.fromEntries(["createdAt","answerDraft","answer","question","pairs","activePairId","activePairIndex","pendingNewAnswer","title","styleId","saved"].map(key=>[key,state[key]]))));}catch{}
  clearTimeout(draftTimer);draftTimer=setTimeout(()=>{if(activePhoto())saveNavigationState().catch(()=>{state.draftFailed=true;});},0);
}
let voiceBaseText = "";
let overlayReturnFocus = null;
const memoryStorePromise = openMemoryStore();
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;

function e(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function imageMarkup(item, className = "", { loading = "eager" } = {}) {
  if (!item?.src) return "";
  const dimensions = Number(item.width) > 0 && Number(item.height) > 0
    ? ` width="${Number(item.width)}" height="${Number(item.height)}"`
    : "";
  return `<img class="${e(className)}" src="${e(item.src)}" alt="${e(item.alt || "一张待讲述的照片")}"${dimensions} loading="${e(loading)}" decoding="async">`;
}

function galleryImageMarkup(media, { thumbnail = false, loading = "lazy", className = "" } = {}) {
  const src = thumbnail ? media?.thumbnailSrc : media?.src;
  const width = thumbnail ? media?.thumbnailWidth : media?.width;
  const height = thumbnail ? media?.thumbnailHeight : media?.height;
  if (!src || !Number(width) || !Number(height)) return "";
  const priority = loading === "eager" ? ' fetchpriority="high"' : "";
  return `<img class="${e(className)}" src="${e(src)}" alt="${e(media.alt)}" width="${Number(width)}" height="${Number(height)}" loading="${e(loading)}" decoding="async"${priority}>`;
}

function isUserOwnedPhoto(item) {
  if (!item || String(item.id || "").startsWith("demo:") || item.file) return false;
  return item.ownership === "user" || typeof item.dataUrl === "string" ||
    String(item.id || "").startsWith("upload:") || String(item.src || "").startsWith("data:image/");
}

function isPersonalMemory(memory) {
  const items = Array.isArray(memory?.photos) ? memory.photos : [];
  return items.length > 0 && items.every((item) => !String(item?.id || "").startsWith("demo:"));
}

function activePhoto() {
  return isUserOwnedPhoto(state.photo) ? state.photo : null;
}

function apiPhoto(item) {
  if (!isUserOwnedPhoto(item)) return null;
  const dataUrl = item.dataUrl || (String(item.src || "").startsWith("data:image/") ? item.src : "");
  return dataUrl ? { dataUrl } : null;
}

function formatDate(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(timestamp));
}

function memoryTitle(memory) {
  const pairAnswer = Array.isArray(memory?.pairs) ? memory.pairs.at(-1)?.answer : "";
  const text = String(memory?.answer || pairAnswer || "").trim().replace(/\s+/gu, " ");
  return text ? `${[...text].slice(0, 15).join("")}${[...text].length > 15 ? "…" : ""}` : "一段留住的回忆";
}

function topbar(title, subtitle, { back = true, avatar = false, badge = "已接主链" } = {}) {
  return `<header class="topbar">
    ${back ? '<button class="round-button" type="button" data-action="back" aria-label="返回">‹</button>' : ""}
    ${avatar ? '<button class="avatar-button" type="button" data-screen="mine" aria-label="打开我的"></button>' : ""}
    <div class="topbar-copy"><h1>${e(title)}</h1><p>${e(subtitle)}</p></div>
    <button class="demo-pill demo-pill--live" type="button" data-overlay="map">${e(badge)}</button>
  </header>`;
}

function sectionHeading(kicker, title, action = "") {
  return `<div class="section-heading"><div><p>${e(kicker)}</p><h2>${e(title)}</h2></div>${action}</div>`;
}

function bottomNav(active) {
  return `<nav class="bottom-nav" aria-label="主导航">
    <button class="nav-item ${active === "home" ? "is-active" : ""}" type="button" data-screen="home"><span class="nav-icon" aria-hidden="true">◫</span><span>看看</span></button>
    <button class="nav-add" type="button" data-overlay="add" aria-label="添加一段新记忆">＋</button>
    <button class="nav-item ${active === "mine" ? "is-active" : ""}" type="button" data-screen="mine"><span class="nav-icon" aria-hidden="true">◉</span><span>我的</span></button>
  </nav>`;
}

function splashScreen() {
  return `<section class="splash-screen">
    <div class="splash-copy"><div class="splash-mark">忆</div><small>UNSEEN · MEMORY MOMENT</small><h1>回忆时刻</h1>
      <p>给它一张照片，<br>把没拍下来的那句话留住。</p>
      <button class="primary-button" type="button" data-screen="home">开始体验</button></div>
    <div class="splash-demo"><span class="live-dot"></span>照片对话与本机保存已接通</div>
  </section>`;
}

function publishedLabel(value) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function officialPostCard(post, index) {
  const cover = post.media[0];
  return `<li class="official-case official-case--${index === 0 ? "feature" : "compact"}">
    <span class="gallery-spine" aria-hidden="true"><i></i><small>${String(index + 1).padStart(2, "0")}</small></span>
    <button class="official-case-card" type="button" data-official-post-id="${e(post.id)}" aria-label="打开官方案例：${e(post.title)}">
      <span class="official-case-media">${galleryImageMarkup(cover, { thumbnail: true, loading: index === 0 ? "eager" : "lazy" })}<i class="case-sheen" aria-hidden="true"></i></span>
      <span class="official-case-copy">
        <span class="case-meta"><span>${e(post.capability.statusLabel)}</span><time datetime="${e(post.publishedAt)}">${e(publishedLabel(post.publishedAt))}</time></span>
        <b>${e(post.title)}</b><span>${e(post.dek)}</span>
        <small>${e(post.capability.label)} · 查看能力与边界 <i aria-hidden="true">↗</i></small>
      </span>
    </button>
  </li>`;
}

function homeScreen() {
  return `<section class="screen"><div class="screen-content screen-content--gallery">
    ${topbar("看看", "UNSEEN 官方案例馆", { back: false, avatar: true, badge: "官方展陈" })}
    <header class="gallery-intro">
      <p>UNSEEN · OFFICIAL EDITIONS</p>
      <h1>先看见能力，<br>也看见它的边界。</h1>
      <span>这里不是公开社区。三件官方案例只负责展示：它们不会进入你的照片、记忆或生成任务。</span>
    </header>
    <div class="official-author"><span class="official-author-mark" aria-hidden="true">U</span><span><b>${e(OFFICIAL_GALLERY_AUTHOR.name)}</b><small>当前唯一发布者 · 版本控制内容源</small></span><i>OFFICIAL</i></div>
    <ol class="official-case-list" aria-label="UNSEEN 官方案例">${OFFICIAL_POSTS.map(officialPostCard).join("")}</ol>
    <aside class="gallery-boundary"><span>仍在进行</span><b>自有 3DGS 还没有成品展出</b><p>更多现场体验正在准备，完成验证后再开放。</p></aside>
  </div>${bottomNav("home")}</section>`;
}

function caseMediaFigure(media, index) {
  return `<figure class="case-detail-media ${index > 0 ? "case-detail-media--supporting" : ""}">
    ${galleryImageMarkup(media, { loading: index === 0 ? "eager" : "lazy" })}
    <figcaption><span>${e(media.sourceLabel)}</span><small>${e(media.credit)}${media.license ? ` · ${e(media.license)}` : ""}</small></figcaption>
  </figure>`;
}

function officialCaseScreen() {
  const post = getOfficialPost(state.officialPostId);
  if (!post) {
    return `<section class="screen"><div class="screen-content">${topbar("官方案例", "没有找到这件展品", { badge: "只读展陈" })}<div class="capture-empty"><span>空</span><h2>这件案例暂时不在展厅</h2><p>返回“看看”，可继续浏览当前发布的官方案例。</p><button class="primary-button" type="button" data-screen="home">回到案例馆</button></div></div>${bottomNav("home")}</section>`;
  }
  return `<section class="screen"><div class="screen-content screen-content--case">
    ${topbar("官方案例", "只读展陈 · 不写入“我的”", { badge: post.capability.statusLabel })}
    <article class="case-detail">
      <header class="case-detail-head">
        <div class="case-detail-author"><span class="official-author-mark" aria-hidden="true">U</span><span><b>${e(OFFICIAL_GALLERY_AUTHOR.name)}</b><small><time datetime="${e(post.publishedAt)}">${e(formatDate(post.publishedAt))}</time> · 官方发布</small></span></div>
        <p>${e(post.capability.label)}</p><h1>${e(post.title)}</h1><span>${e(post.dek)}</span>
      </header>
      ${caseMediaFigure(post.media[0], 0)}
      <div class="read-only-notice"><i aria-hidden="true">◇</i><p><b>只用于观看与理解</b><span>不会成为你的照片、回忆或 World Labs 任务，也没有“套用同款”。</span></p></div>
      <div class="case-prose">${post.body.map((paragraph) => `<p>${e(paragraph)}</p>`).join("")}</div>
      <section class="capability-plaque" aria-labelledby="capability-plaque-title"><div><small>REAL CAPABILITY</small><span>${e(post.capability.statusLabel)}</span></div><h2 id="capability-plaque-title">${e(post.capability.label)}</h2><p>${e(post.capability.summary)}</p></section>
      <dl class="case-facts">${post.facts.map((fact) => `<div><dt>${e(fact.label)}</dt><dd>${e(fact.value)}</dd></div>`).join("")}</dl>
      ${post.media.slice(1).map((media, index) => caseMediaFigure(media, index + 1)).join("")}
      <section class="case-limits"><p>这件案例没有承诺什么</p><ul>${post.limitations.map((item) => `<li>${e(item)}</li>`).join("")}</ul></section>
      ${post.viewer ? `<a class="case-viewer-link" href="${e(post.viewer.href)}" data-official-viewer="${e(post.id)}"><span><small>READ-ONLY VIEW</small><b>${e(post.viewer.label)}</b></span><i aria-hidden="true">↗</i></a>` : ""}
      <footer class="case-source-note"><span>来源与许可随内容清单版本保存</span><small>案例 ID · ${e(post.id)}</small></footer>
    </article>
  </div>${bottomNav("home")}</section>`;
}

function noPhotoStage() {
  return `<div class="capture-empty"><span>一</span><h2>先让一张照片出现</h2><p>只有照片出现后，才会给出“聊聊”“加入现场”或“走进照片”的下一步。</p><button class="primary-button" type="button" data-overlay="add">选择照片</button></div>`;
}

function captureScreen() {
  if (!state.photo) {
    return `<section class="screen"><div class="screen-content">${topbar("照片舞台", "入口会在照片出现后展开")}${noPhotoStage()}</div></section>`;
  }
  return `<section class="screen"><div class="screen-content">
    ${topbar("先看看这张照片", `${state.source} · 已在本机准备好`)}
    <div class="hero-intro"><small>ONE INPUT · CONTEXTUAL NEXT STEP</small><h1>先看见，<br>再决定它去哪里。</h1><p>只有进入“聊聊这张”时，这张预览副本才会发送给看图服务。</p></div>
    <section class="media-stage media-stage--single" aria-label="已选择的一张照片"><div class="media-main">${imageMarkup(state.photo)}</div><div class="media-stage-foot"><div class="media-meta"><b>${e(state.photo.name || state.photo.title || "这一张照片")}</b><span>照片内容保持不变 · 仅在当前流程使用</span></div><button class="text-button" type="button" data-overlay="add">换一张</button></div></section>
    ${sectionHeading("WHAT NEXT", "这张照片想变成什么")}
    <div class="route-list">
      <button class="route-card route-card--primary" type="button" data-action="start-dialogue"><span class="route-icon" aria-hidden="true">✦</span><span class="route-copy"><b>聊聊这张 <small class="route-live">已接通</small></b><span>看图后只问一句，你的原话不会被改写</span></span><span class="route-next">›</span></button>
      <button class="route-card" type="button" data-screen="event"><span class="route-icon" aria-hidden="true">◫</span><span class="route-copy"><b>加入现场 <small>功能示意</small></b><span>共同空间、邀请和账号尚未接入</span></span><span class="route-next">›</span></button>
      <button class="route-card" type="button" data-screen="space"><span class="route-icon" aria-hidden="true">◎</span><span class="route-copy"><b>走进照片 <small class="route-live">3 种方式可用</small></b><span>本机即时效果、DAP 全景范例与 World Labs 生成</span></span><span class="route-next">›</span></button>
    </div>
    <p class="privacy-note">真实范围：本机选图、看图提问、单轮文字/语音转写、一页回忆、本机保存、即时粒子、DAP 全景范例与 World Labs 生成。</p>
  </div></section>`;
}

function questionStatus() {
  if (state.questionStatus === "loading") return `<div class="observation live-observation is-loading"><b>正在看清晰预览</b><span>通常需要几秒，请不要离开这一页。</span></div>`;
  if (state.questionStatus === "ready") {
    const facts = state.visibleFacts.length ? `阿见看见：${state.visibleFacts.map(e).join("；")}` : "下面的问题来自这张清晰预览。";
    return `<div class="observation live-observation is-ready"><b>看图完成</b><span>${facts}</span></div>`;
  }
  if (state.questionStatus === "degraded") return `<div class="observation live-observation is-degraded"><b>看图服务暂时不可用</b><span>下面是备用开放问题，不表示系统已经看懂照片；仍可继续完成并保存。</span></div>`;
  if (state.questionStatus === "restored") return `<div class="observation live-observation is-degraded"><b>从旧记忆恢复</b><span>保留了当时的问题，但旧记录没有保存看图来源，因此不把它标成“来自清晰预览”。</span></div>`;
  return "";
}

function voiceStatusText() {
  if (state.voiceStatus) return state.voiceStatus;
  return voiceInput.isSupported() ? "点“说”开始；说完后明确点“停”，转写文字还能修改。" : "这个浏览器暂不支持语音转文字，可以继续打字。";
}

function ttsLabel() {
  if (state.ttsState.phase === "loading") return "正在生成声音…";
  if (state.ttsState.phase === "speaking") return "停止朗读";
  if (state.ttsState.canReplay) return "再听一遍";
  return "听阿见读";
}

function dialogueScreen() {
  const item = activePhoto();
  if (!item) {
    return `<section class="screen"><div class="screen-content">${topbar("聊聊这张", "先选择你自己的照片")}${noPhotoStage()}</div></section>`;
  }
  const ready = Boolean(state.question) && state.questionStatus !== "loading";
  return `<section class="screen"><div class="screen-content screen-content--action">
    ${topbar("聊聊这张", state.answer ? "已经留下这一句原话" : "看图后，只问一次")}
    <div class="dialogue-photo">${imageMarkup(item)}<span class="photo-caption">${e(state.source || item.source || "本机照片")}</span></div>
    ${questionStatus()}
    <div class="message-stack">
      ${ready ? `<article class="message message--ai"><small>${state.questionStatus === "ready" ? "阿见 · 来自清晰预览" : state.questionStatus === "restored" ? "已保存的问题" : "备用开放问题"}</small>${e(state.question)}</article>
        <button class="read-question" type="button" data-action="read-question" ${state.questionStatus !== "ready" ? "" : ""}>${e(ttsLabel())}</button>` : ""}
      ${state.answer ? `<article class="message message--me"><small>我的原话 · ${state.answerMode === "voice" ? "语音转写后确认" : "文字输入"}</small>${e(state.answer)}</article><p class="preserved-note">这句话会原样进入回忆页，不做润色。</p>` : ""}
    </div>
  </div>
  ${state.answer ? `<div class="action-dock"><div class="button-row"><button class="secondary-button" type="button" data-action="edit-answer">修改原话</button><button class="primary-button" type="button" data-screen="memory">生成一页回忆</button></div></div>` : ready ? `
    <form class="composer composer--turn" data-action="dialogue-form">
      <button class="mode-button ${state.voicePhase === "listening" ? "is-listening" : ""}" type="button" data-action="voice-turn" aria-pressed="${state.voicePhase === "listening"}" aria-label="${state.voicePhase === "listening" ? "停止语音转写" : "开始语音转写"}">${state.voicePhase === "listening" ? "停" : "说"}</button>
      <label class="composer-field"><span id="voice-status">${e(voiceStatusText())}</span><textarea id="dialogue-input" rows="2" maxlength="500" placeholder="写下你记得的原话…" ${state.voicePhase !== "idle" ? "disabled" : ""}>${e(state.answerDraft)}</textarea></label>
      <button class="send-button" type="submit" aria-label="确认这句回答" ${state.voicePhase !== "idle" ? "disabled" : ""}>↑</button>
    </form>` : ""}
  </section>`;
}

function memoryScreen() {
  const item = activePhoto();
  if (!item) {
    return `<section class="screen"><div class="screen-content">${topbar("一页回忆", "先选择你自己的照片")}${noPhotoStage()}</div></section>`;
  }
  if (!state.answer) {
    return `<section class="screen"><div class="screen-content">${topbar("一页回忆", "还差一句你的原话")}<div class="capture-empty"><h2>先回答照片的问题</h2><p>一页回忆只使用真实照片和你确认过的文字。</p><button class="primary-button" type="button" data-action="start-dialogue">去聊聊这张</button></div></div></section>`;
  }
  return `<section class="screen"><div class="screen-content screen-content--action">
    ${topbar("这一页已经形成", state.saved ? "已保存在这台浏览器" : "照片与原话均来自刚才的输入")}
    <article class="result-paper result-paper--live"><p class="result-kicker">ONE MEMORY · 原话保留</p><div class="result-photo">${imageMarkup(item)}</div><h2>这一页，留给你的原话</h2><blockquote>“${e(state.answer)}”</blockquote><div class="result-question"><span>阿见问</span>${e(state.question)}</div><div class="result-meta"><span>${e(formatDate(state.createdAt))}</span><span>·</span><span>${e(state.source || "本机照片")}</span><span>·</span><span>${state.saved ? "本机已保存" : "尚未保存"}</span></div></article>
  </div><div class="action-dock"><div class="button-row"><button class="secondary-button" type="button" data-screen="space">走进照片</button><button class="primary-button" type="button" data-action="save-memory" ${state.saved || state.saving ? "disabled" : ""}>${state.saved ? "已保存到我的" : "保存这段回忆"}</button></div>${state.saved ? '<button class="dock-link" type="button" data-screen="mine">打开“我的 → 记忆”</button>' : ""}</div></section>`;
}

function eventScreen() {
  return `<section class="screen"><div class="screen-content screen-content--action">${topbar("加入共同现场", "功能示意 · 尚未接入")}
    <section class="event-hero event-hero--abstract"><div class="event-orbit" aria-hidden="true"><i></i><i></i><i></i></div><div class="event-hero-copy"><small>INTERACTION PREVIEW · NOT LIVE</small><b>把大家拍到的放回同一晚</b><span>以下内容仅用于评审入口与层级</span></div></section>
    <div class="honesty-card"><span>未接入</span><h2>这版不会假装上传成功</h2><p>邀请、多人共建、账号和云同步需要另一阶段的数据与权限设计。目前点击不会创建活动，也不会保存任何共同空间。</p></div>
    ${sectionHeading("PLANNED FLOW", "计划中的入口")}
    <div class="task-list"><button class="task-card" type="button" data-action="not-connected" data-message="邀请与扫码尚未接入"><span class="task-icon">⌁</span><span class="task-copy"><b>邀请同行的人</b><span>功能示意 · 不会生成邀请</span></span><span class="story-arrow">›</span></button><button class="task-card" type="button" data-action="not-connected" data-message="共同相册尚未接入"><span class="task-icon">◫</span><span class="task-copy"><b>共同留下照片</b><span>功能示意 · 不会上传</span></span><span class="story-arrow">›</span></button></div>
  </div><div class="action-dock"><button class="primary-button" type="button" disabled>共同现场 · 尚未接入</button></div></section>`;
}

function spaceScreen() {
  const item = activePhoto();
  if (!item) {
    return `<section class="screen"><div class="screen-content">${topbar("走进照片", "先选择你自己的照片")}${noPhotoStage()}</div></section>`;
  }
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const mode = state.spaceMode;
  const instant = mode === "instant";
  const hero = mode === "dap"
    ? ["DEPTH-LIMITED PANORAMA", "在全景里，轻轻探身。", "这是一套真实跑通的 DAP 全景范例：可 360° 环视，并在约 0.42 米范围内感受有限视差；不是自由行走的完整 3D。"]
    : mode === "world"
      ? ["WORLD LABS MARBLE", "让照片背后，展开一个世界。", "当前照片可直接进入单图补全；也可以另选 2–8 张同一场景照片，重建一个可探索的共同空间。"]
      : ["LOCAL INSTANT VIEW", "照片没有被替换，\n只是多了一层呼吸。", "即时模式在当前设备生成轻透视与粒子。关闭后立即回到照片层。"];
  const stage = mode === "dap"
    ? `<div class="capability-stage"><img src="/unseen-dap/v1/assets/ballroom-preview.jpg" alt="宴会厅 DAP 全景深度漫游范例" width="1280" height="800" loading="eager" decoding="async"><span class="instant-badge">真实 DAP 范例</span><div class="capability-stage-copy"><b>宴会厅 · 深度受限全景</b><span>拖动环视 · WASD / 手机摇杆小范围探身</span></div></div>`
    : mode === "world"
      ? `<div class="capability-stage capability-stage--world">${imageMarkup(item)}<span class="instant-badge">将发送给 World Labs</span><div class="capability-stage-copy"><b>从当前照片开始</b><span>进入前先查看公开生成与数据处理说明</span></div></div>`
      : `<div id="instant-stage" class="instant-stage ${state.spatialActive ? "is-active" : ""}">${imageMarkup(item, "instant-image")}<canvas id="instant-canvas" hidden aria-label="根据当前照片生成的即时粒子效果"></canvas><span class="instant-badge">实拍照片 + 本机效果</span></div><p id="spatial-status" class="spatial-status" role="status">${e(reduced ? "已按系统的“减少动态效果”设置显示原照片。" : state.spatialStatus)}</p>`;
  const dock = mode === "dap"
    ? '<button class="primary-button" type="button" data-action="open-dap">进入 DAP 全景范例</button>'
    : mode === "world"
      ? '<button class="primary-button" type="button" data-overlay="world-consent">查看说明，进入 World Labs</button>'
      : `<button class="primary-button" type="button" data-action="toggle-spatial" ${reduced ? "disabled" : ""}>${reduced ? "系统已减少动态" : state.spatialActive ? "关闭动态，回到照片" : "预览即时立体"}</button>`;
  return `<section class="screen"><div class="screen-content screen-content--action">${topbar("走进照片", "三种方式已接通 · 3DGS 等待中")}
    <div class="hero-intro"><small>${hero[0]}</small><h1>${e(hero[1]).replace("\n", "<br>")}</h1><p>${hero[2]}</p></div>
    <div class="truth-legend"><span><i></i>本机即时</span><span><i></i>DAP 全景</span><span><i></i>World Labs</span><span><i></i>3DGS 等待中</span></div>
    ${stage}
    <div class="mode-list">
      <button class="mode-card ${instant ? "is-selected" : ""}" type="button" data-space-mode="instant"><span class="mode-preview mode-preview--glyph" aria-hidden="true"><i>✦</i></span><span class="mode-copy"><b>让这张照片立起来 <small class="route-live">已接通</small></b><span>当前设备即时生成 · 可关闭 · 不上传</span><small class="truth-tag">本机效果</small></span></button>
      <button class="mode-card ${mode === "dap" ? "is-selected" : ""}" type="button" data-space-mode="dap"><span class="mode-preview mode-preview--glyph mode-preview--dap" aria-hidden="true"><i>◎</i></span><span class="mode-copy"><b>进入全景深度范例 <small class="route-live">已接通</small></b><span>360° 环视 · 约 0.42 米受限视差</span><small class="truth-tag truth-tag--reconstructed">DAP 全景</small></span></button>
      <button class="mode-card ${mode === "world" ? "is-selected" : ""}" type="button" data-space-mode="world"><span class="mode-preview mode-preview--glyph mode-preview--world" aria-hidden="true"><i>◇</i></span><span class="mode-copy"><b>生成可探索的 3D 世界 <small class="route-live">已接通</small></b><span>当前单图补全，或 2–8 张同场景照片重建</span><small class="truth-tag truth-tag--extrapolated">World Labs Marble</small></span></button>
      <button class="mode-card mode-card--waiting" type="button" disabled><span class="mode-preview mode-preview--glyph mode-preview--waiting" aria-hidden="true"><i>·</i></span><span class="mode-copy"><b>自有 3DGS 重建 <small>等待中</small></b><span>尚未完成整体验证，暂不开放</span><small class="truth-tag truth-tag--generated">尚未开放</small></span></button>
    </div>
    <p class="dap-license-note">DAP 深度模型为 CC BY-NC 4.0；正式商用可能需要另行授权或替换模型。</p>
  </div><div class="action-dock">${dock}</div></section>`;
}

function realMemoryList() {
  if (state.storeStatus === "loading") return `<div class="list-status">正在读取这台浏览器里的记忆…</div>`;
  if (state.storeStatus === "unavailable") return `<div class="list-status is-error">当前浏览器无法使用本机存储。仍可完成回忆页，但关闭后不会保留。</div>`;
  if (!state.memories.length) return `<button class="empty-memory empty-memory--mine" type="button" data-overlay="add"><span>＋</span><b>还没有保存的记忆</b><small>选一张照片，留下第一句</small></button>`;
  return `<div class="asset-list">${state.memories.map((memory) => `<button class="asset-card" type="button" data-memory-id="${e(memory.id)}"><span class="asset-thumb">${imageMarkup(memory.photos[0], "", { loading: "lazy" })}</span><span class="asset-copy"><b>${e(memoryTitle(memory))}</b><span>本机保存 · ${e(formatDate(memory.updatedAt))}</span></span><span class="story-arrow">›</span></button>`).join("")}</div>`;
}

function mineScreen() {
  return `<section class="screen"><div class="screen-content">${topbar("我的", "只看这台设备里的个人内容", { back: false, badge: "仅本机" })}
    <section class="profile-card"><div class="profile-avatar">本</div><div class="profile-copy"><b>这台浏览器</b><span>${state.memories.length} 段个人记忆 · 未登录 · 未同步</span></div><span class="local-only">仅本机</span></section>
    ${sectionHeading("LOCAL MEMORIES", "保存在这台浏览器里")}${mineContent()}
    <p class="privacy-note">本机保存使用 IndexedDB；不会自动进入账号或云端。清除浏览器网站数据会一并清除这些记忆。</p>
  </div>${bottomNav("mine")}</section>`;
}

function mineContent() {
  return realMemoryList();
}

const screenRenderers = { splash: splashScreen, home: homeScreen, case: officialCaseScreen, capture: captureScreen, dialogue: dialogueScreen, memory: memoryScreen, event: eventScreen, space: spaceScreen, mine: mineScreen };

function renderRail() {
  reviewRail.innerHTML = `<p class="rail-kicker">UNSEEN 3.0 · OFFICIAL GALLERY</p><h1>官方案例归“看看”，<br>个人创作归“＋”。</h1><p>案例馆只读；拍照或选图才会进入个人照片状态。本机记忆继续留在“我的”，3DGS 仍明确等待。</p><div class="rail-rule"></div><div class="screen-menu" aria-label="跳转到体验画面">${screens.map(([key, label]) => `<button class="${state.screen === key ? "is-active" : ""}" type="button" data-screen="${key}">${e(label)}</button>`).join("")}</div><div class="rail-note"><i class="live-dot"></i><p><b>能力与内容分开。</b><br>DAP、World Labs 与照片提问都有真实边界，官方案例不会成为个人素材。</p></div><p class="rail-shortcuts">← → 切换画面 · Esc 关闭抽屉</p>`;
}

function addSheet() {
  return `<div class="overlay" data-action="close-overlay"><section class="sheet sheet--photo-only" role="dialog" aria-modal="true" aria-labelledby="add-title" data-sheet><div class="sheet-handle"></div><header class="sheet-head"><div><h2 id="add-title">选择你自己的照片</h2><p>拍一张，或从这台设备选择</p></div><button class="sheet-close" type="button" data-action="close-overlay" aria-label="关闭">×</button></header><div class="sheet-grid sheet-grid--two"><button class="sheet-option" type="button" data-action="choose-camera"><span class="sheet-icon">◉</span><b>拍一张照片</b><span>使用设备相机</span></button><button class="sheet-option" type="button" data-action="choose-library"><span class="sheet-icon">▧</span><b>从相册选择</b><span>支持 JPEG、PNG、WebP</span></button></div><p class="sheet-disclaimer">图片会先在本机生成适合体验的预览副本；只有进入“聊聊这张”才发送给看图服务。这里不会预填任何展示素材。</p></section></div>`;
}

function mapSheet() {
  return `<div class="overlay" data-action="close-overlay"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="map-title" data-sheet><div class="sheet-handle"></div><header class="sheet-head"><div><h2 id="map-title">体验范围</h2><p>真实能力、只读案例与个人内容各归其位</p></div><button class="sheet-close" type="button" data-action="close-overlay" aria-label="关闭">×</button></header><div class="capability-map"><p><b>已经接通</b><span>本机选图 · 看图一问 · 文字/语音转写 · 一页回忆 · IndexedDB 保存与重开 · 即时粒子 · DAP 全景范例 · World Labs 单图/多图生成</span></p><p><b>官方案例</b><span>版本控制清单 · 唯一官方作者 · 只读详情 · 不进入个人创作或任务</span></p><p><b>仍在等待</b><span>自有 3DGS · 活动共创 · 账号 · 云同步 · 支付</span></p></div></section></div>`;
}

function worldConsentSheet() {
  return `<div class="overlay" data-action="close-overlay"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="world-consent-title" data-sheet><div class="sheet-handle"></div><header class="sheet-head"><div><h2 id="world-consent-title">进入 World Labs 前</h2><p>这一步会离开本机即时效果</p></div><button class="sheet-close" type="button" data-action="close-overlay" aria-label="关闭">×</button></header><div class="world-consent-copy"><p><b>照片会交给 World Labs 处理</b><span>生成的 3D 世界可通过公开链接访问；输入可能按其服务条款用于改进模型。</span></p><p><b>照片入口不是精确空间锚点</b><span>Marble 当前不会返回每张输入照片的精确相机位姿。</span></p><p><b>生成会消耗公共体验额度</b><span>最终提交前还会要求你明确勾选照片使用权与公开生成方式。</span></p></div><div class="world-consent-actions"><button class="secondary-button" type="button" data-action="open-world-multi">另选 2–8 张同场景照片</button><button class="primary-button" type="button" data-action="open-world-current">用当前这张开始</button></div><p class="sheet-disclaimer">空间生成由 World Labs Marble 完成；回忆时刻负责入口、额度控制与站内查看。</p></section></div>`;
}

function renderOverlay() {
  overlayRoot.innerHTML = state.overlay === "add" ? addSheet()
    : state.overlay === "map" ? mapSheet()
      : state.overlay === "world-consent" ? worldConsentSheet() : "";
  if (state.overlay) requestAnimationFrame(() => overlayRoot.querySelector(".sheet-close")?.focus());
}

function openOverlay(name, trigger = document.activeElement) {
  overlayReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  state.overlay = name;
  renderOverlay();
}

function closeOverlay() {
  state.overlay = null;
  renderOverlay();
  const target = overlayReturnFocus;
  overlayReturnFocus = null;
  requestAnimationFrame(() => target?.isConnected && target.focus());
}

function teardownSpatial() {
  spatialRuntime?.destroy();
  spatialRuntime = null;
}

function mountSpatial() {
  if (state.screen !== "space" || !state.spatialActive) return;
  const stage = document.querySelector("#instant-stage");
  const image = stage?.querySelector(".instant-image");
  const canvas = document.querySelector("#instant-canvas");
  if (!stage || !image || !canvas) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const field = createDemoMemoryField({
    host: stage,
    image,
    canvas,
    reducedMotion,
    onSettled: () => setSpatialStatus("粒子已经聚成照片，仍在轻轻流动。"),
    onSupportChange: (available) => {
      if (!available) setSpatialStatus("当前设备无法运行即时粒子，已保持原照片。", "error");
    }
  });
  const move = (event) => { if (event.pointerType !== "touch") field.setPointer(event.clientX, event.clientY, true); };
  const leave = () => field.clearPointer();
  const resize = () => field.resize();
  const visibility = () => document.hidden ? field.stop({ keepWanted: true }) : field.start();
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerleave", leave);
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", visibility);
  const start = () => {
    const started = field.start({ forceRebuild: true });
    setSpatialStatus(started ? "正在从这张照片生成即时粒子…" : "当前设备会保持原照片。", started ? "" : "error");
  };
  if (image.complete) start(); else image.addEventListener("load", start, { once: true });
  spatialRuntime = {
    destroy() {
      image.removeEventListener("load", start);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerleave", leave);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
      field.destroy();
    }
  };
}

function setSpatialStatus(message, tone = "") {
  state.spatialStatus = message;
  const element = document.querySelector("#spatial-status");
  if (element) { element.textContent = message; element.dataset.tone = tone; }
}

function render() {
  teardownSpatial();
  app.innerHTML = screenRenderers[state.screen]();
  renderOverlay();
  renderRail();
  app.querySelector(".screen")?.scrollTo({ top: 0 });
  if (state.screen === "space" && state.spatialActive) requestAnimationFrame(mountSpatial);
}

function navigate(screen, { remember = true } = {}) {
  if(state.screen === "dialogue" && screen !== "dialogue") invalidateQuestion();
  if (!screenRenderers[screen] || screen === state.screen) {
    state.overlay = null;
    renderOverlay();
    return;
  }
  const leavingOfficialCase = state.screen === "case" && screen !== "case";
  voiceInput.cancel();
  turnVoice.stop();
  if (remember) state.history.push(leavingOfficialCase ? "home" : state.screen);
  state.screen = screen;
  if (leavingOfficialCase) {
    state.officialPostId = null;
    const url = new URL(globalThis.location.href);
    url.searchParams.delete("case");
    globalThis.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  state.overlay = null;
  persistDraft();
  render();
}

function officialPostFromLocation() {
  return getOfficialPost(new URLSearchParams(globalThis.location.search).get("case"));
}

function officialPostUrl(id) {
  const url = new URL("/unseen-demo", globalThis.location.origin);
  url.searchParams.set("case", id);
  return `${url.pathname}${url.search}`;
}

function focusOfficialPost(id) {
  if (!id || state.screen !== "home") return;
  requestAnimationFrame(() => {
    app.querySelector(`[data-official-post-id="${CSS.escape(id)}"]`)?.focus();
  });
}

function openOfficialPost(id) {
  const post = getOfficialPost(id);
  if (!post) return;
  state.history.push(state.screen);
  state.officialPostId = post.id;
  state.screen = "case";
  state.overlay = null;
  globalThis.history.pushState(
    { unseenScreen: "case", officialPostId: post.id },
    "",
    officialPostUrl(post.id)
  );
  render();
}

function goBack() {
  invalidateQuestion();
  persistDraft();
  const officialReturnFocusId = state.screen === "case" ? state.officialPostId : null;
  voiceInput.cancel();
  turnVoice.stop();
  if (officialReturnFocusId && globalThis.history.state?.unseenScreen === "case") {
    globalThis.history.back();
    return;
  }
  state.screen = state.history.pop() || "home";
  state.officialPostId = null;
  state.overlay = null;
  if (officialReturnFocusId) {
    globalThis.history.replaceState(null, "", "/unseen-demo");
  }
  render();
  focusOfficialPost(officialReturnFocusId);
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.querySelector(".phone-screen").append(toast);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.remove(), 3000);
}

async function refreshMemories() {
  const store = await memoryStorePromise;
  if (!store.available) {
    state.storeStatus = "unavailable";
    state.memories = [];
  } else {
    state.collections = await store.listCollections();
    const all = (await Promise.all(state.collections.map(c => store.listMemories(c.id)))).flat().filter(isPersonalMemory).sort((a,b)=>b.updatedAt-a.updatedAt);
    state.trash = all.filter(m=>m.deletedAt);
    state.memories = all.filter(m=>!m.deletedAt && (!state.collectionFilter || m.collectionId===state.collectionFilter));
    state.storeStatus = "ready";
  }
  if (state.screen === "home" || state.screen === "mine") render();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image_decode_failed"));
    image.src = src;
  });
}

async function prepareUpload(file) {
  const declaredType = String(file?.type || "").toLowerCase();
  const hasSupportedImageName = /\.(?:jpe?g|png|webp)$/iu.test(String(file?.name || ""));
  if (!declaredType.startsWith("image/") && !hasSupportedImageName) throw new Error("image_required");
  if (file.size > 24 * 1024 * 1024) throw new Error("image_too_large");
  const originalUrl = await readFileAsDataUrl(file);
  const image = await loadImage(originalUrl);
  const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
  if (dataUrl.length > 7_500_000) throw new Error("image_too_large");
  return {
    dataUrl,
    src: dataUrl,
    alt: file.name || "刚选择的照片",
    name: file.name || "刚选择的照片",
    capturedAt: file.lastModified || Date.now(),
    width,
    height,
    ownership: "user",
    sourceKind: "local-photo"
  };
}

function openWorldHandoffDb() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("indexeddb_unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("huijian-world-lab", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("source-sets")) {
        request.result.createObjectStore("source-sets", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
  });
}

async function prepareWorldHandoff(item) {
  const image = await loadImage(item.dataUrl || item.src);
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .88));
  if (!blob || blob.size > 6 * 1024 * 1024) throw new Error("world_handoff_too_large");
  return {
    dataUrl: await readFileAsDataUrl(blob),
    width: canvas.width,
    height: canvas.height,
    bytes: blob.size,
    ownership: "user",
    sourceKind: "local-photo-derived"
  };
}

async function saveWorldHandoff(photo) {
  if (!isUserOwnedPhoto(photo)) throw new Error("user_photo_required");
  const db = await openWorldHandoffDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("source-sets", "readwrite");
      transaction.objectStore("source-sets").put({
        id: "unseen-handoff",
        mode: "single",
        images: [photo],
        savedAt: Date.now()
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("indexeddb_write_failed"));
    });
  } finally {
    db.close();
  }
}

function openNavigationDb() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("indexeddb_unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("huijian-unseen-demo-flow", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("navigation", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
  });
}

async function saveNavigationState() {
  const photo = activePhoto();
  if (!isUserOwnedPhoto(photo)) throw new Error("user_photo_required");
  if (state.cloudRecord && !state.memoryId) return;
  const db = await openNavigationDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("navigation", "readwrite");
      transaction.objectStore("navigation").put({
        id: "spatial-return",
        photo,
        draft: Object.fromEntries(["photos", "pairs", "activePairIndex", "activePairId", "pendingNewAnswer", "title", "styleId", "originalMemory", "createdAt", "resultShape", "question", "questionStatus", "questionModel", "visibleFacts", "answer", "answerDraft", "answerMode", "memoryId", "memoryOrigin", "saved", "screen", "history"].map(key => [key, structuredClone(state[key])])),
        source: state.source || "刚才选择的照片",
        spaceMode: state.spaceMode,
        savedAt: Date.now()
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("indexeddb_write_failed"));
    });
  } finally {
    db.close();
  }
}

async function takeNavigationState() {
  const db = await openNavigationDb();
  try {
    return await new Promise((resolve, reject) => {
      let record = null;
      const transaction = db.transaction("navigation", "readwrite");
      const store = transaction.objectStore("navigation");
      const request = store.get("spatial-return");
      request.onsuccess = () => {
        record = request.result || null;
        // Keep the draft available across repeated refreshes and spatial visits.
      };
      request.onerror = () => reject(request.error || new Error("indexeddb_read_failed"));
      transaction.oncomplete = () => resolve(record);
      transaction.onerror = () => reject(transaction.error || new Error("indexeddb_transaction_failed"));
    });
  } finally {
    db.close();
  }
}

async function restoreNavigationState() {
  const record = await takeNavigationState();
  const fresh = Boolean(record);
  if (!fresh || !isUserOwnedPhoto(record.photo)) return false;
  invalidateQuestion();
  if (record.draft) Object.assign(state, record.draft);
  state.pendingNewAnswer=record.draft?.pendingNewAnswer ?? (record.draft?.activePairIndex===-1&&!record.draft?.answer);
  try{const recent=JSON.parse(sessionStorage.getItem("unseen.demo.text-draft")||"null");if(recent?.createdAt===state.createdAt)Object.assign(state,recent);}catch{}
  if (state.questionStatus === "loading") { state.questionStatus = "degraded"; state.question ||= "这张照片之外，还有什么是你想留下的？"; }
  const normalized=normalizeContent({photos:state.photos?.length?state.photos:[record.photo],pairs:state.pairs||[],question:state.question,answer:state.answer,mainPhotoId:record.photo.id,activePairId:state.activePairId});
  state.photos=normalized.photos;state.pairs=normalized.pairs;state.activePairId=state.pendingNewAnswer?null:normalized.activePairId;state.activePairIndex=state.pendingNewAnswer?-1:state.pairs.findIndex(pair=>pair.id===state.activePairId);
  state.photo = { ...record.photo, ownership: "user" };
  state.source = record.source || "刚才选择的照片";
  state.spaceMode = ["instant", "dap", "world"].includes(record.spaceMode) ? record.spaceMode : "instant";
  state.spatialActive = false;
  state.screen = record.draft?.screen || "space";
  state.history = record.draft?.history || ["home"];
  return true;
}

async function openDap() {
  if (!activePhoto()) {
    openOverlay("add");
    return;
  }
  await saveNavigationState().catch(() => {});
  globalThis.location.assign("/unseen-dap?back=unseen-demo");
}

async function openWorldLabs(mode) {
  const photo = activePhoto();
  if (!isUserOwnedPhoto(photo)) {
    openOverlay("add");
    return;
  }
  closeOverlay();
  await saveNavigationState().catch(() => {});
  if (mode === "multi") {
    globalThis.location.assign("/world?source=unseen-demo&mode=multi");
    return;
  }
  showToast("正在把当前照片带到 World Labs…");
  try {
    await saveWorldHandoff(await prepareWorldHandoff(photo));
    globalThis.location.assign("/world?source=unseen-demo&mode=single");
  } catch {
    showToast("当前照片没有带过去；请进入后重新选择");
    setTimeout(() => globalThis.location.assign("/world?source=unseen-demo&mode=single"), 900);
  }
}

async function handleFile(file, source) {
  state.overlay = null;
  renderOverlay();
  showToast("正在本机准备照片…");
  try {
    state.photo = await prepareUpload(file);
    resetMemoryFlow();
    state.source = source;
    navigate("capture");
  } catch (error) {
    showToast(error?.message === "image_too_large" ? "图片太大，请选择 24MB 以下的照片" : "没有读到可用照片，请换一张重试");
  }
}

function resetMemoryFlow() {
  // Invalidate an in-flight look at the previous photo before the new photo can
  // inherit its late response. The server stays stateless; the browser owns cancellation semantics.
  invalidateQuestion();
  state.originalMemory = null;
  state.pendingNewAnswer = false;
  state.cloudRecord = null;
  state.pairs = [];
  state.photos = state.photo ? [state.photo] : [];
  state.createdAt = Date.now();
  state.resultShape = "memory-page";
  state.question = "";
  state.questionStatus = "idle";
  state.questionModel = "";
  state.visibleFacts = [];
  state.focus = null;
  state.answerDraft = "";
  state.answer = "";
  state.answerMode = "text";
  state.memoryId = null;
  state.memoryOrigin = "";
  state.saved = false;
  state.spatialActive = false;
  state.spaceMode = "instant";
  state.spatialStatus = "照片层保持不变；动态只是可关闭的观看方式。";
  turnVoice.clear();
}

async function startDialogue(followup = false) {
  const photo = activePhoto();
  const requestPhoto = apiPhoto(photo);
  if (!isUserOwnedPhoto(photo) || !requestPhoto) {
    openOverlay("add");
    return;
  }
  invalidateQuestion();
  const requestId = state.requestId;
  const controller = questionController = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const previousAnswer = state.answer;
  state.activePairIndex = -1;
  state.activePairId = null;state.pendingNewAnswer = true;
  state.question = "";
  state.questionStatus = "loading";
  state.answer = "";
  state.answerDraft = "";
  state.memoryOrigin = "";
  navigate("dialogue");persistDraft();render();
  try {
    const response = await fetch("/api/question", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ photo: requestPhoto, kind: followup ? "followup_question" : "initial_question", userText: followup ? previousAnswer : undefined })
    });
    if (!response.ok) throw new Error("dialogue_http_error");
    const outcome = await response.json();
    if (requestId !== state.requestId) return;
    if (outcome.degraded || typeof outcome.question !== "string" || !outcome.question.trim()) {
      state.question = "这张照片之外，还有什么是你想留下的？";
      state.visibleFacts = [];
      state.focus = null;
      state.questionStatus = "degraded";
    } else {
      state.question = outcome.question.trim();
      state.visibleFacts = Array.isArray(outcome.facts) ? outcome.facts.filter((item) => typeof item === "string") : [];
      state.focus = null;
      state.questionModel = outcome.model ?? "";
      state.questionStatus = "ready";
    }
  } catch {
    if (requestId !== state.requestId) return;
    state.question = "这张照片之外，还有什么是你想留下的？";
    state.focus = null;
    state.visibleFacts = [];
    state.questionStatus = "degraded";
  }
  finally { clearTimeout(timeout); }
  persistDraft();
  render();
  document.querySelector("#dialogue-input")?.focus();
}

function renderVoiceChrome() {
  const button = document.querySelector('[data-action="voice-turn"]');
  const input = document.querySelector("#dialogue-input");
  const send = document.querySelector(".send-button");
  const status = document.querySelector("#voice-status");
  if (button) {
    const listening = state.voicePhase === "listening";
    button.textContent = listening ? "停" : "说";
    button.classList.toggle("is-listening", listening);
    button.setAttribute("aria-pressed", String(listening));
    button.setAttribute("aria-label", listening ? "停止语音转写" : "开始语音转写");
  }
  const busy = state.voicePhase !== "idle";
  if (input) input.disabled = busy;
  if (send) send.disabled = busy;
  if (status) status.textContent = voiceStatusText();
}

const voiceInput = createVoiceInput({
  Recognition,
  continuous: true,
  onTranscript: ({ final, interim }) => {
    const transcript = appendTranscript(final, interim);
    state.answerDraft = mergeTranscriptIntoEditableText(voiceBaseText, transcript);
    persistDraft();
    const input = document.querySelector("#dialogue-input");
    if (input) input.value = state.answerDraft;
    if (transcript) state.voiceStatus = interim ? "正在听，也正在转成文字…" : "已经听到这句；说完后点“停”。";
    renderVoiceChrome();
  },
  onComplete: () => {
    state.answerMode = "voice";
    state.voiceStatus = "已转成文字，可以修改；确认无误后点发送。";
  },
  onState: (phase) => {
    state.voicePhase = phase === "complete" ? "processing" : phase;
    if (phase === "listening") state.voiceStatus = "正在听。说完后点“停”。";
    if (phase === "processing") state.voiceStatus = "正在整理刚才的话…";
    if (phase === "idle" && !state.voiceStatus) state.voiceStatus = voiceStatusText();
    if (phase === "idle" && state.answerDraft) state.answerMode = "voice";
    renderVoiceChrome();
    if (phase === "idle") document.querySelector("#dialogue-input")?.focus({ preventScroll: true });
  },
  onError: (code) => {
    const messages = {
      unsupported: "这个浏览器暂不支持语音转文字，可以继续打字。",
      "not-allowed": "没有麦克风权限，仍可以继续打字。",
      "service-not-allowed": "浏览器没有开放语音服务，仍可以继续打字。",
      "audio-capture": "没有找到可用麦克风，仍可以继续打字。",
      "no-speech": "没有听到完整语句，可以重试或继续打字。",
      network: "语音识别服务暂时不可用，可以继续打字。"
    };
    state.voiceStatus = messages[code] ?? "没有完成语音转写，可以继续打字。";
    renderVoiceChrome();
  }
});

const turnVoice = createTurnVoicePlayer({
  onState: (nextState) => {
    state.ttsState = nextState;
    const button = document.querySelector('[data-action="read-question"]');
    if (button) button.textContent = ttsLabel();
    if (nextState.phase === "error") {
      const message = nextState.code === "unavailable" ? "朗读服务未配置，问题文字仍可正常使用" : nextState.code === "rate-limited" ? "朗读次数暂时用完，问题文字仍可正常使用" : "这次没有读出声音，问题文字仍可正常使用";
      showToast(message);
    }
  }
});

function currentMemoryInput() { return contentSnapshot(state); }

async function saveMemory() {
  const photo = activePhoto();
  if (state.saving || !isUserOwnedPhoto(photo) || !state.question || !state.answer) return;
  state.saving = true;
  const session = state.requestId;
  const input = currentMemoryInput();
  render();
  try {
    const store = await memoryStorePromise;
    if (!store.available) throw new Error("storage_unavailable");
    const memory = await store.saveMemory(input);
    if (session !== state.requestId) return;
    const unchanged = JSON.stringify(currentMemoryInput()) === JSON.stringify(input);
    state.memoryId = memory.id;
    state.memoryOrigin = memory.origin;
    state.originalMemory = memory;
    state.createdAt = memory.createdAt;
    state.saved = unchanged;
    await saveNavigationState();
    await refreshMemories();
    showToast("已真实保存到“我的 → 记忆”");
  } catch {
    showToast("这次没有保存成功；原话仍在，稍后重试或先下载成品");
  } finally { state.saving = false; render(); }
}

async function restoreMemory(id) {
  invalidateQuestion();
  const session = state.requestId;
  const store = await memoryStorePromise;
  if (!store.available) return;
  const storedMemory = await store.getMemory(id);
  const memory = storedMemory ? normalizeContent(storedMemory) : null;
  if (session !== state.requestId || !memory?.photos?.[0] || !isPersonalMemory(memory)) return;
  state.cloudRecord = null;
  state.originalMemory = structuredClone(memory);
  state.photos = structuredClone(memory.photos);
  state.pairs = structuredClone(memory.pairs || []);
  state.pendingNewAnswer=false;
  state.activePairId = memory.activePairId;
  state.activePairIndex = state.pairs.findIndex(pair=>pair.id===memory.activePairId);
  state.createdAt = memory.createdAt;
  state.resultShape = memory.resultShape;
  state.title = memory.title || "";
  state.styleId = memory.styleId;
  voiceInput.cancel();
  turnVoice.clear();
  const storedPhoto = memory.photos.find(photo=>photo.id===memory.mainPhotoId) || memory.photos[0];
  const recentPair = Array.isArray(memory.pairs) ? memory.pairs.at(-1) : null;
  const restoredQuestion = memory.question || recentPair?.question || "这张照片之外，还有什么是你想留下的？";
  const restoredAnswer = memory.answer || recentPair?.answer || "";
  state.photo = { ...storedPhoto, src: storedPhoto.src, dataUrl: storedPhoto.dataUrl || storedPhoto.src, alt: "保存的回忆照片", name: "保存的照片", ownership: "user" };
  state.source = "本机记忆";
  state.question = restoredQuestion;
  state.questionStatus = memory.origin === "unseen-demo-live:model" ? "ready"
    : memory.origin === "unseen-demo-live:degraded" ? "degraded" : "restored";
  state.visibleFacts = Array.isArray(memory.facts) ? memory.facts : [];
  state.focus = null;
  state.answerDraft = restoredAnswer;
  state.answer = restoredAnswer;
  state.memoryId = memory.id;
  state.memoryOrigin = memory.origin || "";
  state.saved = true;
  navigate("memory");
}

document.addEventListener("click", (event) => {
  const sheet = event.target.closest("[data-sheet]");
  const closeTarget = event.target.closest('[data-action="close-overlay"]');
  if (closeTarget && (!sheet || closeTarget.matches(".sheet-close"))) {
    closeOverlay();
    return;
  }
  const memoryTarget = event.target.closest("[data-memory-id]");
  if (memoryTarget) { restoreMemory(memoryTarget.dataset.memoryId); return; }
  const officialPostTarget = event.target.closest("[data-official-post-id]");
  if (officialPostTarget) { openOfficialPost(officialPostTarget.dataset.officialPostId); return; }
  const actionTarget = event.target.closest("[data-action]");
  const action = actionTarget?.dataset.action;
  if (action === "back") { goBack(); return; }
  if (action === "choose-library") { closeOverlay(); photoInput.click(); return; }
  if (action === "choose-camera") { closeOverlay(); cameraInput.click(); return; }
  if (action === "start-dialogue") { startDialogue(); return; }
  if (action === "voice-turn") {
    if (voiceInput.isActive()) { turnVoice.prepare(); voiceInput.stop(); }
    else { voiceBaseText = document.querySelector("#dialogue-input")?.value ?? state.answerDraft; state.answerDraft = voiceBaseText; state.voiceStatus = ""; voiceInput.start(); }
    return;
  }
  if (action === "read-question") {
    if (state.ttsState.phase === "speaking" || state.ttsState.phase === "loading") turnVoice.stop();
    else if (state.ttsState.canReplay) turnVoice.replay();
    else { turnVoice.prepare(); turnVoice.speak(state.question); }
    return;
  }
  if (action === "edit-answer") { state.pendingNewAnswer=false;state.answer = ""; state.answerDraft = state.answerDraft || state.answer; state.saved = false; render(); document.querySelector("#dialogue-input")?.focus(); return; }
  if (action === "save-memory") { saveMemory(); return; }
  if (action === "open-dap") { void openDap(); return; }
  if (action === "open-world-current") { void openWorldLabs("single"); return; }
  if (action === "open-world-multi") { void openWorldLabs("multi"); return; }
  if (action === "toggle-spatial") {
    state.spatialActive = !state.spatialActive;
    state.spatialStatus = state.spatialActive
      ? "正在从这张照片生成即时粒子…"
      : "动态已关闭，已经回到原照片。";
    render();
    return;
  }
  if (action === "not-connected") { showToast(actionTarget.dataset.message || "这个能力尚未接入"); return; }
  const screenTarget = event.target.closest("[data-screen]");
  if (screenTarget) {
    const next = screenTarget.dataset.screen;
    if (next === "dialogue" && !state.question) startDialogue(); else navigate(next);
    return;
  }
  const overlayTarget = event.target.closest("[data-overlay]");
  if (overlayTarget) { openOverlay(overlayTarget.dataset.overlay, overlayTarget); return; }
  const modeTarget = event.target.closest("[data-space-mode]");
  if (modeTarget) {
    state.spaceMode = modeTarget.dataset.spaceMode;
    if (state.spaceMode !== "instant") state.spatialActive = false;
    render();
    return;
  }
});

document.addEventListener("input", (event) => {
  if (!event.target.matches("#dialogue-input")) return;
  state.answerDraft = event.target.value;
  state.saved = false;
  persistDraft();
  if (state.answerMode !== "voice") state.answerMode = "text";
});

document.addEventListener("submit", (event) => {
  if (!event.target.matches('[data-action="dialogue-form"]')) return;
  event.preventDefault();
  const answer = document.querySelector("#dialogue-input")?.value.trim() ?? "";
  if (!answer) { showToast("先写下或说出一句想留下的话"); return; }
  voiceInput.cancel();
  turnVoice.stop();
  state.answerDraft = answer;
  state.answer = answer;
  commitAnswer(state,answer);
  state.saved = false;
  persistDraft();
  render();
});

for (const [input, source] of [[photoInput, "从相册选择"], [cameraInput, "相机拍摄"]]) {
  input.addEventListener("change", () => {
    const [file] = input.files ?? [];
    if (!file) {
      input.value = "";
      return;
    }
    void handleFile(file, source).finally(() => { input.value = ""; });
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.overlay) { closeOverlay(); return; }
  if (event.key === "Tab" && state.overlay) {
    const focusable = [...overlayRoot.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (focusable.length) {
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && event.target.matches("#dialogue-input")) {
    event.target.form?.requestSubmit();
    return;
  }
  if (state.screen === "case" || ["INPUT", "TEXTAREA"].includes(event.target.tagName) || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const index = Math.max(0, screens.findIndex(([key]) => key === state.screen));
  const direction = event.key === "ArrowRight" ? 1 : -1;
  navigate(screens[(index + direction + screens.length) % screens.length][0]);
});

window.addEventListener("pagehide",()=>{persistDraft();});
window.addEventListener("beforeunload", () => { persistDraft(); voiceInput.cancel(); turnVoice.clear(); teardownSpatial(); });
window.addEventListener("popstate", () => {
  const post = officialPostFromLocation();
  if (post) {
    if (state.screen !== "case") state.history.push(state.screen);
    state.screen = "case";
    state.officialPostId = post.id;
    state.overlay = null;
    render();
    return;
  }
  if (state.screen !== "case") return;
  const officialReturnFocusId = state.officialPostId;
  state.screen = state.history.pop() || "home";
  state.officialPostId = null;
  state.overlay = null;
  render();
  focusOfficialPost(officialReturnFocusId);
});

render();
const navigationRestorePromise = initialOfficialPost ? Promise.resolve(false) : restoreNavigationState();
navigationRestorePromise
  .then((restored) => { if (restored) render(); return refreshMemories(); })
  .catch(() => {
    state.storeStatus = "unavailable";
    if (state.screen === "home" || state.screen === "mine") render();
  });
