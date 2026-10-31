import { normalizeContent, commitAnswer, contentSnapshot } from "/unseen-content.js";
import { worldScreen, jobsScreen, fetchWorldJson, worldPendingDecision, canClearWorldPendingAfterError } from "/unseen-app-world.js";
import { createAccountSurface } from "/unseen-app-account.js";
import { mountAppSpatial } from "/unseen-app-spatial.js";
import { UnseenAccountApi } from "/unseen-account-api.js";
import { libraryControls, memoryControls, syncScreen, cloudScreen } from "/unseen-app-library.js";
import * as appCases from "/unseen-app-cases.js";
import { photoStrip, creationTools, mountCreation, exportCreation } from "/unseen-app-create.js";
import { openMemoryStore } from "/memory-store.js";
import { appendTranscript, createVoiceInput, mergeTranscriptIntoEditableText } from "/voice-input.js";
import { createTurnVoicePlayer } from "/turn-voice.js";
import { createDemoMemoryField } from "/spatial-memory-field.js";
import {
  OFFICIAL_GALLERY_AUTHOR,
  OFFICIAL_POSTS,
  getOfficialPost
} from "/official-gallery/v1/official-posts.js";

const isApp = location.pathname === "/app" || location.pathname.startsWith("/app/");
const entryPath = isApp ? "/app" : "/unseen-demo";
const app = document.querySelector("#app");
const overlayRoot = document.querySelector("#overlay-root");
const reviewRail = document.querySelector(".review-rail");
const photoInput = document.querySelector("#unseen-photo-input");
const cameraInput = document.querySelector("#unseen-camera-input");
const initialOfficialPost = appCases.get(new URLSearchParams(location.search).get("case") || decodeURIComponent(location.pathname.split("/")[3] || ""));

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
  screen: initialOfficialPost ? "case" : "home",
  history: initialOfficialPost ? ["home"] : [],
  overlay: null,
  photo: null,
  photos: [],
  pairs: [],
  originalMemory: null,
  createdAt: Date.now(),
  saving: false,
  activePairIndex: -1,
  pendingNewAnswer: false,
  resultShape: "memory-page",
  pageAspect: "",
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
let creationCleanup = null;
let caseCleanup = null;
let viewerCleanup = null;
function invalidateQuestion() { state.requestId += 1; questionController?.abort(); questionController = null; }
function persistDraft() {
  if(state.cloudRecord&&!state.memoryId)return;
  try{sessionStorage.setItem("unseen.app.text-draft",JSON.stringify(Object.fromEntries(["createdAt","answerDraft","answer","question","pairs","activePairId","activePairIndex","pendingNewAnswer","title","styleId","pageAspect","saved"].map(key=>[key,state[key]]))));}catch{}
  clearTimeout(draftTimer);draftTimer=setTimeout(()=>{if(activePhoto())saveNavigationState().catch(()=>{state.draftFailed=true;});},0);
}
let voiceBaseText = "";
let overlayReturnFocus = null;
const memoryStorePromise = openMemoryStore();
const accountApi = new UnseenAccountApi();
let cloudEpoch=0;
let cloudSyncOperation=null;
let cloudListController=null;
function invalidateCloudRequests(){cloudListController?.abort();cloudListController=null;cloudSyncOperation?.controller.abort();cloudSyncOperation=null;state.syncIdentity=null;state.syncIdentityLoading=false;state.syncIdentityError="";return ++cloudEpoch;}
async function loadCloudMemories(){
 const epoch=invalidateCloudRequests();
 const controller=new AbortController();cloudListController=controller;
 state.cloudLoadEpoch=epoch;state.cloudLoading=true;state.cloudMemories=[];state.cloudStatus='正在读取账号作品…';render();
 try{
  const result=await accountApi.memories({signal:controller.signal});if(epoch!==cloudEpoch)return;
  state.cloudMemories=result.memories||[];state.cloudStatus=state.cloudMemories.length?'':'还没有归入账号的作品。';
 }catch(error){
  if(epoch!==cloudEpoch)return;
  if(error.status===401){clearCloudAccess();state.cloudLoadEpoch=cloudEpoch;state.cloudLoading=false;state.cloudStatus='请先登录账号，再查看你归入的作品。';if(state.screen==='cloud')render();return;}
  state.cloudMemories=[];state.cloudStatus='账号作品暂时读不到，请重试；本机作品仍保留。';
 }finally{if(epoch===cloudEpoch){state.cloudLoading=false;cloudListController=null;if(state.screen==='cloud')render();}}
}
async function prepareSyncIdentity(){
 const epoch=cloudEpoch;state.syncIdentityLoading=true;
 try{const me=await accountApi.me();if(epoch!==cloudEpoch||state.screen!=='sync')return;
  if(!me.accountId)throw new Error('account_identity_missing');
  state.syncIdentity={accountId:me.accountId,label:me.identifiers?.[0]?.display_mask||me.accountSettingsView?.emailMask||'当前已登录账号'};
 }catch{if(epoch!==cloudEpoch||state.screen!=='sync')return;state.syncIdentityError='请先登录账号，再返回确认这份作品的上传范围。';}
 if(epoch===cloudEpoch&&state.screen==='sync')render();
}
function clearCloudAccess(){invalidateCloudRequests();state.cloudMemories=[];if(state.cloudRecord){state.photo=null;resetMemoryFlow();}state.viewerSpec=null;}
const accountSurface = createAccountSurface({api:accountApi,onSessionChange:()=>clearCloudAccess(),onNavigate:target=>openAccount(target),onBook:spec=>{state.accountTarget={...state.accountTarget,route:"book",...spec};syncAppUrl(true);},onViewer:spec=>{state.viewerSpec={kind:'360',panoramaSrc:spec.panoramaUrl,...spec};navigate('viewer');},onStatus:message=>{
 if(message==='已退出账号'){clearCloudAccess();state.cloudStatus='已退出账号';state.history=[];}
}});
let accountGeneration=0;
function disposeAccountSurface(){accountGeneration++;accountSurface.destroy();}
async function openAccount(target={route:'spaces'},{remember=true}={}){
 if(target.route==='case-return'){state.officialPostId=target.caseId;return navigate('case',{remember:false});}
 const generation=++accountGeneration;
 if(state.screen==='account'&&remember)state.history.push({screen:'account',accountTarget:{...state.accountTarget}});
 state.accountTarget={...target};state.accountHtml='<p role="status">正在打开账号与现场…</p>';
 if(state.screen==='account')syncAppUrl(!remember);else navigate('account',{remember});
 render();
 const html=await accountSurface.render(target);
 if(generation!==accountGeneration||state.screen!=='account')return;
 state.accountHtml=html;render();
}
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
  if (memory.title) return memory.title;
  const pairAnswer = Array.isArray(memory?.pairs) ? memory.pairs.at(-1)?.answer : "";
  const text = String(memory?.answer || pairAnswer || "").trim().replace(/\s+/gu, " ");
  return text ? `${[...text].slice(0, 15).join("")}${[...text].length > 15 ? "…" : ""}` : "一段留住的回忆";
}

function topbar(title, subtitle, { back = true, avatar = false, badge = "体验说明" } = {}) {
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
    <button class="nav-item ${active === "home" ? "is-active" : ""}" type="button" data-screen="home" ${active === "home" ? 'aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">◫</span><span>看看</span></button>
    <button class="nav-add" type="button" data-overlay="add" aria-label="添加一段新记忆">＋</button>
    <button class="nav-item ${active === "mine" ? "is-active" : ""}" type="button" data-screen="mine" ${active === "mine" ? 'aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">◉</span><span>我的</span></button>
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
  if(isApp)return `<section class="screen"><div class="screen-content screen-content--gallery">${topbar("看看","UNSEEN · 照片、原话、现场",{back:false,avatar:true})}${appCases.renderGallery()}</div>${bottomNav("home")}</section>`;
  return `<section class="screen"><div class="screen-content screen-content--gallery">
    ${topbar("看看", "UNSEEN 官方案例馆", { back: false, avatar: true, badge: "体验说明" })}
    <header class="gallery-intro">
      <p>UNSEEN · OFFICIAL EDITIONS</p>
      <h1>照片里的一刻，<br>还可以继续。</h1>
      <span>聊一张照片，留下一句原话，或重新走进一个现场。先看看 UNSEEN 的三件官方作品。</span>
    </header>
    <div class="official-author"><span class="official-author-mark" aria-hidden="true">U</span><span><b>${e(OFFICIAL_GALLERY_AUTHOR.name)}</b><small>精选案例 · 点击作品了解更多</small></span><i>OFFICIAL</i></div>
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
  if(isApp)return `<section class="screen"><div class="screen-content screen-content--case">${topbar("官方收藏","只读 · 不进入个人作品")}${appCases.renderDetail(state.officialPostId)}</div>${bottomNav("home")}</section>`;
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
    <div class="hero-intro"><small>从照片开始</small><h1>先看见，<br>再决定它去哪里。</h1><p>只有进入“聊聊这张”时，当前主照片的预览副本才会发送给看图服务；其余照片用于本机排版。</p></div>
    <section class="media-stage media-stage--single" aria-label="已选择的一张照片"><div class="media-main">${imageMarkup(state.photo)}</div><div class="media-stage-foot"><div class="media-meta"><b>${e(state.photo.name || state.photo.title || "这一张照片")}</b><span>照片内容保持不变 · 仅在当前流程使用</span></div><button class="text-button" type="button" data-overlay="add">换一张</button></div></section>
    ${isApp ? photoStrip(state) + '<button class="secondary-button" data-action="write-first">直接留下原话</button>' : ""}
    ${sectionHeading("接下来", "这张照片想变成什么")}
    <div class="route-list">
      <button class="route-card route-card--primary" type="button" data-action="start-dialogue"><span class="route-icon" aria-hidden="true">✦</span><span class="route-copy"><b>聊聊这张 <small class="route-live">主照片</small></b><span>看图后只问一句，你的原话不会被改写</span></span><span class="route-next">›</span></button>
      <button class="route-card" type="button" data-screen="event"><span class="route-icon" aria-hidden="true">◫</span><span class="route-copy"><b>加入现场</b><span>选择共同空间，上传经过你确认的照片</span></span><span class="route-next">›</span></button>
      <button class="route-card" type="button" data-screen="space"><span class="route-icon" aria-hidden="true">◎</span><span class="route-copy"><b>走进照片 <small class="route-live">选择方式</small></b><span>本机即时效果、DAP 全景范例与 World Labs 生成</span></span><span class="route-next">›</span></button>
    </div>
    <p class="privacy-note">真实范围：本机选图、看图提问、多轮原话、文字/语音转写、一页、海报和小书、本机保存、即时粒子、DAP 全景范例与 World Labs 生成。</p>
  </div></section>`;
}

function questionStatus() {
  if(state.questionStatus === "manual") return `<div class="observation"><b>直接留下原话</b><span>没有调用看图服务，下面是开放提示。</span></div>`;
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
    ${state.questionStatus === "loading" ? '<button class="secondary-button" data-action="write-first">先写一句，停止等待</button>' : ""}
    <div class="message-stack">
      ${ready ? `<article class="message message--ai"><small>${state.questionStatus === "ready" ? "阿见 · 来自清晰预览" : state.questionStatus === "restored" ? "已保存的问题" : state.questionStatus === "manual" ? "普通提示" : "备用开放问题"}</small>${e(state.question)}</article>
        <button class="read-question" type="button" data-action="read-question" ${state.questionStatus !== "ready" ? "" : ""}>${e(ttsLabel())}</button>` : ""}
      ${state.answer ? `<article class="message message--me"><small>我的原话 · ${state.answerMode === "voice" ? "语音转写后确认" : "文字输入"}</small>${e(state.answer)}</article><p class="preserved-note">这句话会原样进入回忆页，不做润色。</p>` : ""}
    </div>
  </div>
  ${state.answer ? `<div class="action-dock"><div class="button-row"><button class="secondary-button" type="button" data-action="edit-answer">修改原话</button><button class="secondary-button" type="button" data-action="next-question">继续聊一句</button><button class="primary-button" type="button" data-screen="memory">制作成品</button></div></div>` : ready ? `
    <form class="composer composer--turn" data-action="dialogue-form">
      <button class="mode-button ${state.voicePhase === "listening" ? "is-listening" : ""}" type="button" data-action="voice-turn" aria-pressed="${state.voicePhase === "listening"}" aria-label="${state.voicePhase === "listening" ? "停止语音转写" : "开始语音转写"}">${state.voicePhase === "listening" ? "停" : "说"}</button>
      <label class="composer-field"><span id="voice-status" role="status">${e(voiceStatusText())}</span><textarea aria-label="你的原话" aria-describedby="voice-status" id="dialogue-input" rows="2" maxlength="500" placeholder="写下你记得的原话…" ${state.voicePhase !== "idle" ? "disabled" : ""}>${e(state.answerDraft)}</textarea></label>
      <button class="send-button" type="submit" aria-label="确认这句回答" ${state.voicePhase !== "idle" ? "disabled" : ""}>↑</button>
    </form>` : ""}
  </section>`;
}

function memoryScreen(){
 if(!activePhoto())return `<section class="screen"><div class="screen-content">${topbar("留住这一刻","先选择照片")}${noPhotoStage()}</div></section>`;
 if(!state.pairs.length)return `<section class="screen"><div class="screen-content">${topbar("再留下一句原话","照片已经准备好")}<button class="primary-button" data-action="write-first">写下你想留下的</button></div></section>`;
 const label={zine:'这本小书',poster:'这张海报','memory-page':'这一页'}[state.resultShape]||'作品';
 return `<section class="screen"><div class="screen-content screen-content--action">${topbar(label,state.saved?'已保存在这台浏览器':'原话保留 · 选择你想带走的样子')}${creationTools(state)}<details class="app-tools"><summary>编辑 ${state.pairs.length} 段原话</summary>${state.pairs.map((pair,index)=>`<div class="app-memory-extra"><p>${e(pair.question)}</p><blockquote>${e(pair.answer)}</blockquote><button data-app-edit-pair="${index}">修改这段原话</button></div>`).join('')}</details>${memoryControls(state)}</div><div class="action-dock"><div class="button-row"><button class="secondary-button" data-screen="space">走进照片</button><button class="primary-button" data-action="save-memory" ${state.saved||state.saving?'disabled':''}>${state.saving?'正在保存…':state.saved?'已保存到我的':state.cloudRecord&&!state.memoryId?'保存本机副本并编辑':'保存这段回忆'}</button></div><button class="dock-link" data-screen="mine">打开“我的 → 记忆”</button></div></section>`;
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
  return `<section class="screen"><div class="screen-content screen-content--action">${topbar("走进照片", "选择本机效果、全景或 AI 生成")}
    <div class="hero-intro"><small>${hero[0]}</small><h1>${e(hero[1]).replace("\n", "<br>")}</h1><p>${hero[2]}</p></div>
    <div class="truth-legend"><span><i></i>本机即时</span><span><i></i>DAP 全景</span><span><i></i>World Labs</span><span><i></i>3DGS 等待中</span></div>
    ${stage}
    <div class="mode-list">
      <button class="mode-card ${instant ? "is-selected" : ""}" type="button" data-space-mode="instant"><span class="mode-preview mode-preview--glyph" aria-hidden="true"><i>✦</i></span><span class="mode-copy"><b>让这张照片立起来 <small class="route-live">已接通</small></b><span>当前设备即时生成 · 可关闭 · 不上传</span><small class="truth-tag">本机效果</small></span></button>
      <button class="mode-card ${mode === "dap" ? "is-selected" : ""}" type="button" data-space-mode="dap"><span class="mode-preview mode-preview--glyph mode-preview--dap" aria-hidden="true"><i>◎</i></span><span class="mode-copy"><b>进入全景深度范例 <small class="route-live">已接通</small></b><span>360° 环视 · 约 0.42 米受限视差</span><small class="truth-tag truth-tag--reconstructed">DAP 全景</small></span></button>
      <button class="mode-card ${mode === "world" ? "is-selected" : ""}" type="button" data-space-mode="world"><span class="mode-preview mode-preview--glyph mode-preview--world" aria-hidden="true"><i>◇</i></span><span class="mode-copy"><b>生成可探索的 3D 世界 <small class="route-live">需服务额度</small></b><span>当前单图补全，或 2–8 张同场景照片重建</span><small class="truth-tag truth-tag--extrapolated">World Labs Marble</small></span></button>
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
    <section class="profile-card"><div class="profile-avatar">本</div><div class="profile-copy"><b>这台浏览器</b><span>${state.memories.length} 段本机记忆 · 账号作品另行查看</span></div><span class="local-only">仅本机</span></section>
    ${sectionHeading("LOCAL MEMORIES", "保存在这台浏览器里")}${mineContent()}
    <p class="privacy-note">作品保存在这台浏览器；只有你主动确认后才会归入账号。清除浏览器网站数据会一并清除这些记忆。</p>
  </div>${bottomNav("mine")}</section>`;
}

function mineContent() {
  return (isApp ? libraryControls(state) : "") + (state.showTrash ? "" : realMemoryList());
}

async function mountViewer(){
 const container=document.querySelector('#app-spatial-viewer'),status=document.querySelector('#app-viewer-status');const spec=state.viewerSpec||{};
 if(!container)return;
 let world=spec.world;
 try{
  if(spec.kind==='world'&&!world){const response=await fetch(`/api/worldlabs/worlds/${encodeURIComponent(spec.worldId)}`);if(!response.ok)throw new Error('world_unavailable');world=(await response.json()).world;}
  if(state.screen!=='viewer'||!container.isConnected)return;
  status.hidden=true;
  viewerCleanup=mountAppSpatial({...spec,world,container,onExit:()=>goBack(),onStatus:message=>{if(status.isConnected)status.textContent=message;},onError:()=>{if(status.isConnected){status.hidden=false;status.textContent='查看器暂不可用，返回后仍可查看原图。';}}});
 }catch{status.textContent='当前空间结果暂时无法载入；原图仍保留，可稍后重试。';}
}
function viewerScreen(){return `<section class="screen"><div class="screen-content">${topbar("回到现场","原图始终保留 · 拖动画面环视")}<div id="app-spatial-viewer" style="height:60dvh"></div><p id="app-viewer-status" role="status">正在准备查看器…</p></div></section>`;}
function accountScreen(){return `<section class="screen"><div class="screen-content">${topbar("共同现场","账号、活动与相册")}<div id="app-account">${state.accountHtml||"正在准备…"}</div></div>${bottomNav("mine")}</section>`;}
const screenRenderers = {world:()=>worldScreen(state),jobs:()=>jobsScreen(state),account:accountScreen,sync:()=>syncScreen(state),cloud:()=>cloudScreen(state.cloudLoadEpoch===cloudEpoch?state:{...state,cloudMemories:[],cloudLoading:true,cloudStatus:'正在读取账号作品…'}),viewer:viewerScreen, splash: splashScreen, home: homeScreen, case: officialCaseScreen, capture: captureScreen, dialogue: dialogueScreen, memory: memoryScreen, event: eventScreen, space: spaceScreen, mine: mineScreen };

function renderRail() {
  if (!reviewRail) return;
  reviewRail.innerHTML = `<p class="rail-kicker">UNSEEN 3.0 · OFFICIAL GALLERY</p><h1>官方案例归“看看”，<br>个人创作归“＋”。</h1><p>案例馆只读；拍照或选图才会进入个人照片状态。本机记忆继续留在“我的”，3DGS 仍明确等待。</p><div class="rail-rule"></div><div class="screen-menu" aria-label="跳转到体验画面">${screens.map(([key, label]) => `<button class="${state.screen === key ? "is-active" : ""}" type="button" data-screen="${key}">${e(label)}</button>`).join("")}</div><div class="rail-note"><i class="live-dot"></i><p><b>能力与内容分开。</b><br>DAP、World Labs 与照片提问都有真实边界，官方案例不会成为个人素材。</p></div><p class="rail-shortcuts">← → 切换画面 · Esc 关闭抽屉</p>`;
}

function addSheet() {
  return `<div class="overlay" data-action="close-overlay"><section class="sheet sheet--photo-only" role="dialog" aria-modal="true" aria-labelledby="add-title" data-sheet><div class="sheet-handle"></div><header class="sheet-head"><div><h2 id="add-title">选择你自己的照片</h2><p>拍一张，或从这台设备选择</p></div><button class="sheet-close" type="button" data-action="close-overlay" aria-label="关闭">×</button></header><div class="sheet-grid sheet-grid--two"><button class="sheet-option" type="button" data-action="choose-camera"><span class="sheet-icon">◉</span><b>拍一张照片</b><span>使用设备相机</span></button><button class="sheet-option" type="button" data-action="choose-library"><span class="sheet-icon">▧</span><b>从相册选择</b><span>支持 JPEG、PNG、WebP</span></button></div><p class="sheet-disclaimer">图片会先在本机生成适合体验的预览副本；只有进入“聊聊这张”才发送给看图服务。这里不会预填任何展示素材。</p></section></div>`;
}

function mapSheet() {
  return `<div class="overlay" data-action="close-overlay"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="map-title" data-sheet><div class="sheet-handle"></div><header class="sheet-head"><div><h2 id="map-title">体验范围</h2><p>真实能力、只读案例与个人内容各归其位</p></div><button class="sheet-close" type="button" data-action="close-overlay" aria-label="关闭">×</button></header><div class="capability-map"><p><b>已经接通</b><span>本机选图 · 看图一问 · 文字/语音转写 · 一页回忆 · 本机保存、合集与恢复 · 账号与共同现场 · 主动归入账号 · 即时粒子 · DAP 全景范例 · World Labs 单图/多图生成</span></p><p><b>官方案例</b><span>版本控制清单 · 唯一官方作者 · 只读详情 · 不进入个人创作或任务</span></p><p><b>尚未提供</b><span>自有 3DGS · 支付</span></p></div></section></div>`;
}

function worldConsentSheet() {
  return `<div class="overlay" data-action="close-overlay"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="world-consent-title" data-sheet><div class="sheet-handle"></div><header class="sheet-head"><div><h2 id="world-consent-title">进入 World Labs 前</h2><p>这一步会离开本机即时效果</p></div><button class="sheet-close" type="button" data-action="close-overlay" aria-label="关闭">×</button></header><div class="world-consent-copy"><p><b>照片会交给 World Labs 处理</b><span>生成的 3D 世界可通过公开链接访问；输入可能按其服务条款用于改进模型。</span></p><p><b>照片入口不是精确空间锚点</b><span>Marble 当前不会返回每张输入照片的精确相机位姿。</span></p><p><b>生成会消耗公共体验额度</b><span>最终提交前还会要求你明确勾选照片使用权与公开生成方式。</span></p></div><div class="world-consent-actions"><button class="secondary-button" type="button" data-action="open-world-multi">另选 2–8 张同场景照片</button><button class="primary-button" type="button" data-action="open-world-current">用当前这张开始</button></div><p class="sheet-disclaimer">空间生成由 World Labs Marble 完成；回忆时刻负责入口、额度控制与站内查看。</p></section></div>`;
}

function renderOverlay() {
  overlayRoot.innerHTML = state.overlay === "add" ? addSheet()
    : state.overlay === "map" ? mapSheet()
      : state.overlay === "world-consent" ? worldConsentSheet() : "";
  app.inert = Boolean(state.overlay);
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

let renderedRouteKey;
function currentRouteKey(){
 return JSON.stringify([state.screen,state.screen==='case'?state.officialPostId:null,state.screen==='account'?state.accountTarget:null]);
}
function rememberRenderFocus(){
 const el=document.activeElement;if(!app.contains(el))return null;
 const selector=el.id?`#${CSS.escape(el.id)}`:el.getAttribute("aria-label")?`[aria-label="${CSS.escape(el.getAttribute("aria-label"))}"]`:[...el.attributes].filter(a=>a.name.startsWith('data-')).map(a=>`[${a.name}="${CSS.escape(a.value)}"]`).join('');
 return {selector,start:el.selectionStart,end:el.selectionEnd};
}
function restoreRenderFocus(previous,routeChanged){
 if(state.overlay)return;
 const matched=!routeChanged&&previous?.selector&&app.querySelector(previous.selector);
 const target=(matched&&!matched.disabled&&matched)||((routeChanged||previous)&&(app.querySelector('.ua-head h1')||app.querySelector('h1')));
 if(!target)return;
 if(target.tagName==='H1'){target.tabIndex=-1;target.dataset.routeHeading='true';}
 target.focus({preventScroll:target===matched});
 if(!routeChanged&&previous?.start!=null&&target.setSelectionRange){try{target.setSelectionRange(previous.start,previous.end);}catch{}}
}
function render() {
  const previousFocus=rememberRenderFocus(),routeKey=currentRouteKey(),routeChanged=routeKey!==renderedRouteKey,previousScroll=app.querySelector(".screen")?.scrollTop||0;
  renderedRouteKey=routeKey;
  creationCleanup?.(); creationCleanup = null;
  caseCleanup?.(); caseCleanup = null;
  viewerCleanup?.(); viewerCleanup = null;
  teardownSpatial();
  app.innerHTML = screenRenderers[state.screen]();
  if(isApp)caseCleanup=appCases.bind(app,{onOpenAccount:target=>openAccount(target),onOpenCase:id=>{state.officialPostId=id;if(state.screen==="case"){syncAppUrl();render();}else navigate("case");},onBack:()=>navigate("home"),onOpenSpace:spec=>{state.viewerSpec=spec;navigate("viewer");}});
  renderOverlay();
  renderRail();
  if(state.screen === "viewer") void mountViewer();
  if(state.screen === "account") accountSurface.bind(document.querySelector("#app-account"));
  if (isApp && state.screen === "memory" && state.pairs.length) creationCleanup = mountCreation(state, app);
  app.querySelector(".screen")?.scrollTo({ top: routeChanged?0:previousScroll });
  restoreRenderFocus(previousFocus,routeChanged);
  if (state.screen === "space" && state.spatialActive) requestAnimationFrame(mountSpatial);
  if(state.screen==='sync'&&!state.syncIdentityLoading&&!state.syncIdentity)void prepareSyncIdentity();
  if(state.screen==='cloud'&&state.cloudLoadEpoch!==cloudEpoch)void loadCloudMemories();
}

function navigate(screen, { remember = true } = {}) {
  if(screen!==state.screen)invalidateCloudRequests();
  if(state.screen === "account" && screen !== "account"){disposeAccountSurface();}
  if (state.screen === "dialogue" && screen !== "dialogue") invalidateQuestion();
  if (!screenRenderers[screen] || screen === state.screen) {
    state.overlay = null;
    renderOverlay();
    return;
  }
  const leavingOfficialCase = state.screen === "case" && screen !== "case";
  voiceInput.cancel();
  turnVoice.stop();
  if (remember) state.history.push({screen:state.screen,officialPostId:state.officialPostId,viewerSpec:state.viewerSpec,accountTarget:state.accountTarget});
  state.screen = screen;
  state.overlay = null;
  syncAppUrl();
  persistDraft();
  render();
}

function officialPostFromLocation() {
  return getOfficialPost(new URLSearchParams(globalThis.location.search).get("case"));
}

function officialPostUrl(id) {
  const url = new URL(entryPath, globalThis.location.origin);
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

function syncAppUrl(replace=false){
 const path=state.screen==='home'?'/app':state.screen==='case'?`/app/case/${encodeURIComponent(state.officialPostId||'')}`:`/app/${state.screen}`;
 const route={unseenApp:true,screen:state.screen,officialPostId:state.officialPostId,accountTarget:state.accountTarget,viewerSpec:state.viewerSpec};
 history[replace?'replaceState':'pushState'](route,'',path);
}
function goBack(){
 if(state.screen==='account')disposeAccountSurface();
 invalidateCloudRequests();
 invalidateQuestion();voiceInput.cancel();turnVoice.stop();
 const previous=state.history.pop()||'home';
 if(typeof previous==='string')state.screen=previous;else Object.assign(state,previous);
 state.overlay=null;syncAppUrl(true);persistDraft();
 if(state.screen==='account'){void openAccount(state.accountTarget,{remember:false});return;}render();
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
  else if(state.screen==='memory'){
    const select=app.querySelector('#app-memory-collection');
    if(select)select.innerHTML=(state.collections||[]).map(c=>`<option value="${e(c.id)}" ${state.originalMemory?.collectionId===c.id?'selected':''}>${e(c.name)}</option>`).join('');
  }
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

async function clearAppDraft(){
 clearTimeout(draftTimer);try{sessionStorage.removeItem('unseen.app.text-draft');}catch{}
 const db=await openNavigationDb();try{await new Promise((resolve,reject)=>{const tx=db.transaction('navigation','readwrite');tx.objectStore('navigation').delete('app-draft');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}

async function saveNavigationState() {
  const photo = activePhoto();
  if (!isUserOwnedPhoto(photo)) throw new Error("user_photo_required");
  if (state.cloudRecord && !state.memoryId) return;
  // Capture one local draft before opening storage; account/navigation state may change while it awaits.
  const record = structuredClone({
    id: "app-draft", photo,
    draft: Object.fromEntries(["photos", "pairs", "activePairIndex", "activePairId", "pendingNewAnswer", "title", "styleId", "pageAspect", "originalMemory", "createdAt", "resultShape", "question", "questionStatus", "questionModel", "visibleFacts", "answer", "answerDraft", "answerMode", "memoryId", "memoryOrigin", "saved", "screen", "history"].map(key => [key, state[key]])),
    source: state.source || "刚才选择的照片", spaceMode: state.spaceMode, savedAt: Date.now()
  });
  const db = await openNavigationDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("navigation", "readwrite");
      transaction.objectStore("navigation").put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("indexeddb_write_failed"));
    });
  } finally { db.close(); }
}

async function takeNavigationState() {
  const db = await openNavigationDb();
  try {
    return await new Promise((resolve, reject) => {
      let record = null;
      const transaction = db.transaction("navigation", "readwrite");
      const store = transaction.objectStore("navigation");
      const request = store.get("app-draft");
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
  try{const recent=JSON.parse(sessionStorage.getItem("unseen.app.text-draft")||"null");if(recent?.createdAt===state.createdAt)Object.assign(state,recent);}catch{}
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
  const sample=appCases.get("dap-ballroom");
  state.viewerSpec=sample?.space || {kind:"dap",panoramaSrc:"/unseen-dap/v1/assets/ballroom.jpg",depthSrc:"/unseen-dap/v1/assets/ballroom-depth.png"};
  navigate("viewer");
}

async function openWorldLabs(mode) {
 const photo=activePhoto();if(!isUserOwnedPhoto(photo)){openOverlay('add');return;}
 await saveNavigationState().catch(()=>{});state.worldMode=mode;closeOverlay();navigate('world');
}

async function handleFile(file, source) {
  state.overlay = null;
  renderOverlay();
  showToast("正在本机准备照片…");
  try {
    const files = Array.isArray(file) ? file : [file];
    if (files.length > 24) throw new Error("photo_limit");
    invalidateQuestion();
    const uploadSession = state.requestId;
    const prepared = [];
    for (const item of files) prepared.push(await prepareUpload(item));
    if (uploadSession !== state.requestId) return;
    state.photo = prepared[0];
    resetMemoryFlow();
    state.photos = prepared.map((p,i)=>({...p,id:`upload:${state.createdAt}:${i}`}));
    state.photo = state.photos[0];
    state.title="";state.styleId="evening-paper";state.activePairIndex=-1;
    state.resultShape = prepared.length>1 ? "zine" : "memory-page";
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
  state.title = "";state.styleId="evening-paper";state.activePairId=null;state.activePairIndex=-1;
  state.pairs = [];
  state.photos = state.photo ? [state.photo] : [];
  state.createdAt = Date.now();
  state.resultShape = "memory-page";
  state.pageAspect = "";
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
  const cloudImport=state.cloudRecord&&!state.memoryId?state.cloudRecord:null;
  const importEpoch=cloudEpoch;
  if(cloudImport){input.id=cloudImport.id;input.syncBases={[cloudImport.accountId]:cloudImport.version};}
  render();
  try {
    const store = await memoryStorePromise;
    if (!store.available) throw new Error("storage_unavailable");
    if(cloudImport){
      if(!cloudImport.accountId)throw new Error('cloud_identity_unavailable');
      const existing=await store.getMemory(cloudImport.id);
      if(importEpoch!==cloudEpoch)return;
      if(existing)throw new Error('local_copy_exists');
    }
    const memory = await store.saveMemory(input,{createOnly:Boolean(cloudImport)});
    if(cloudImport&&importEpoch!==cloudEpoch)return;
    if (session !== state.requestId) return;
    const currentInput=currentMemoryInput();
    if(cloudImport){currentInput.id=input.id;currentInput.syncBases=input.syncBases;}
    const unchanged = JSON.stringify(currentInput) === JSON.stringify(input);
    if(cloudImport)state.cloudRecord=null;
    state.memoryId = memory.id;
    state.memoryOrigin = memory.origin;
    state.originalMemory = memory;
    state.createdAt = memory.createdAt;
    state.saved = unchanged;
    await saveNavigationState();
    await refreshMemories();
    showToast("已真实保存到“我的 → 记忆”");
  } catch(error) {
    showToast(error.message==='local_copy_exists'?'这台浏览器已有同一作品。本机内容没有被覆盖，请从“我的”打开原副本。':error.message==='cloud_identity_unavailable'?'请重新打开账号作品，再保存本机副本。':"这次没有保存成功；原话仍在，稍后重试或先下载成品");
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
  state.pageAspect = memory.pageAspect || "";
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

try{state.worldPending=localStorage.getItem('unseen.app.world.pending');}catch{}
function reconcileWorldPending(){if(worldPendingDecision(state.worldPending,state.worldJobs).canClear){state.worldPending=null;try{localStorage.removeItem('unseen.app.world.pending');}catch{}}}

document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-app-world],[data-app-world-open],[data-app-world-poll]');if(!button)return;
 try{
 if(button.dataset.appWorld==='generate'){
  if(state.worldBusy||worldPendingDecision(state.worldPending,state.worldJobs).blocked){showToast('请先到空间任务核对原请求');return;}
  if(!document.querySelector('#app-world-consent')?.checked){showToast('请先确认照片使用和公开生成方式');return;}
  const selected=state.worldMode==='multi'?state.photos:[state.photo];
  if(selected.some(p=>!isUserOwnedPhoto(p))||!selected.length||selected.length>8){showToast('请选择1张或2–8张同场景照片');return;}
  const clientRequestId=crypto.randomUUID();
  const displayName=document.querySelector('#app-world-name').value,prompt=document.querySelector('#app-world-prompt').value;
  state.worldBusy=true;state.worldStatus='正在准备预览副本…';render();
  try{
   state.worldJobs=(await fetchWorldJson('/api/worldlabs/jobs',{signal:AbortSignal.timeout(15000)})).jobs;reconcileWorldPending();
   const images=[];for(const photo of selected)images.push((await prepareWorldHandoff(photo)).dataUrl);
   localStorage.setItem('unseen.app.world.pending',clientRequestId);state.worldPending=clientRequestId;
   const result=await fetchWorldJson('/api/worldlabs/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:state.worldMode,images,publicConsent:true,clientRequestId,displayName,prompt}),signal:AbortSignal.timeout(65000)});
   state.worldStatus='已受理，可在空间任务里继续查看。';state.worldJobs=(await fetchWorldJson('/api/worldlabs/jobs')).jobs;reconcileWorldPending();
  }catch(error){
   if(canClearWorldPendingAfterError(state.worldPending,error,clientRequestId)){state.worldPending=null;try{localStorage.removeItem('unseen.app.world.pending');}catch{}}
   else {try{state.worldJobs=(await fetchWorldJson('/api/worldlabs/jobs')).jobs;reconcileWorldPending();}catch{}}
   state.worldStatus=error.data?.status==='unknown'||error.name==='TimeoutError'?'提交结果尚未确定。请到空间任务核对原请求，不要重新生成。':`没有完成提交：${error.data?.error||'网络暂不可用'}。请查看空间任务确认。`;}
  finally{state.worldBusy=false;render();}
 }
 if(button.dataset.appWorld==='refresh'){state.worldJobs=(await fetchWorldJson('/api/worldlabs/jobs')).jobs;reconcileWorldPending();state.jobsStatus='已读取服务器保存的任务回执。';render();}
 if(button.dataset.appWorldPoll){const {job}=await fetchWorldJson(`/api/worldlabs/jobs/${encodeURIComponent(button.dataset.appWorldPoll)}`);state.worldJobs=(state.worldJobs||[]).map(j=>j.id===job.id?job:j);reconcileWorldPending();render();}
 if(button.dataset.appWorldOpen){const job=state.worldJobs.find(j=>j.id===button.dataset.appWorldOpen);state.viewerSpec={kind:'world',world:job.operation.world};navigate('viewer');}
 }catch(error){state.jobsStatus='任务状态暂时无法读取；原任务不会重新提交。';if(state.screen==='jobs')render();else showToast(state.jobsStatus);}
});

document.addEventListener("click",async event=>{
 const b=event.target.closest("[data-app-library],[data-app-restore],[data-app-cloud],[data-app-cloud-trash],[data-app-cloud-restore]");if(!b)return;
 let requestEpoch=cloudEpoch;
 try{
 const store=await memoryStorePromise;
 if(requestEpoch!==cloudEpoch)return;
 if(b.dataset.appRestore){const m=await store.getMemory(b.dataset.appRestore);await store.saveMemory({...m,deletedAt:null});await refreshMemories();return;}
 if(b.dataset.appCloud){
  const epoch=invalidateCloudRequests();requestEpoch=epoch;
  const result=await accountApi.memory(b.dataset.appCloud);const record=result.memory||result;if(epoch!==cloudEpoch)return;const m=record.document?normalizeContent(record.document):null;
  if(!m)throw new Error('cloud_record_invalid');
  invalidateQuestion();state.cloudRecord=record;state.originalMemory=structuredClone(m);state.memoryId=null;state.photos=structuredClone(m.photos);const main=state.photos.find(p=>p.id===m.mainPhotoId)||state.photos[0];state.photo={...main,ownership:'user',dataUrl:main.src};state.pairs=m.pairs||[];state.pendingNewAnswer=false;state.activePairId=m.activePairId;state.activePairIndex=state.pairs.findIndex(p=>p.id===m.activePairId);state.pageAspect=m.pageAspect||'';state.question=m.question||state.pairs.at(-1)?.question||'';state.answer=state.answerDraft=m.answer||state.pairs.at(-1)?.answer||'';state.createdAt=m.createdAt;state.title=m.title;state.styleId=m.styleId;state.resultShape=m.resultShape;state.questionStatus='restored';state.source='账号作品 · 当前会话';state.saved=false;navigate('memory');return;
 }
 if(b.dataset.appCloudTrash||b.dataset.appCloudRestore){
  const id=b.dataset.appCloudTrash||b.dataset.appCloudRestore,record=state.cloudMemories.find(m=>m.id===id);if(!record)return;
  const epoch=invalidateCloudRequests();requestEpoch=epoch;b.disabled=true;
  try{await accountApi[b.dataset.appCloudTrash?'trashMemory':'restoreMemory'](id,record.version);const result=await accountApi.memories();if(epoch!==cloudEpoch)return;state.cloudMemories=result.memories||[];state.cloudLoadEpoch=epoch;state.cloudLoading=false;state.cloudStatus=b.dataset.appCloudTrash?'账号作品已移到最近删除，可在这里恢复。':'账号作品已恢复。';render();}finally{b.disabled=false;}
  return;
 }
 const action=b.dataset.appLibrary;
 if(action==='trash'){state.showTrash=!state.showTrash;render();}
 if(action==='trash-current'){const m=await store.getMemory(state.memoryId);await store.saveMemory({...m,deletedAt:Date.now()});state.photo=null;resetMemoryFlow();await clearAppDraft();await refreshMemories();navigate('mine');}
 if(action==='edit'){navigate('capture');}
 if(action==='cloud-refresh'){await loadCloudMemories();return;}
 if(action==='sync-current'){
  if(!document.querySelector('#app-sync-consent')?.checked){showToast('请先确认这份作品的上传范围');return;}
  const identity=state.syncIdentity;if(!identity){showToast('请先登录并确认当前账号');return;}
  const epoch=invalidateCloudRequests();requestEpoch=epoch;state.syncIdentity=identity;state.syncIdentityLoading=true;
  const operation={epoch,accountId:identity.accountId,memoryId:state.memoryId,controller:new AbortController()};cloudSyncOperation=operation;
  const current=()=>cloudSyncOperation===operation&&cloudEpoch===epoch&&state.memoryId===operation.memoryId;
  const options={signal:operation.controller.signal};
  b.disabled=true;const status=document.querySelector('#app-sync-status');status.textContent='正在同步这份作品…';state.syncConflict=false;
  try{
   const m=await store.getMemory(operation.memoryId);if(!current())return;if(!m)throw new Error('save_first');
   const me=await accountApi.me(options);if(!current())return;
   const accountId=me.accountId || me.account?.id;if(!accountId)throw new Error('account_identity_missing');if(accountId!==operation.accountId)throw {status:409,code:'account_changed'};
   const version=m.syncBases?.[accountId] ?? 0;
   // Never adopt a freshly fetched remote version for an older local document.
   const {syncBases,...document}=m;
   const result=await accountApi.syncMemory(m.id,document,{...options,consent:true,version,expectedAccountId:accountId});if(!current())return;
   const receipt=result.memory||result;
   const saved=await store.markMemorySynced(m.id,accountId,receipt.version,m);if(!current())return;
   if(saved)state.originalMemory=saved;
   status.textContent=saved?'已同步到当前账号；可在另一台设备登录读取。':'这次提交已收到回执；本机另有修改，下一次同步会核对版本。';
  }finally{if(current())cloudSyncOperation=null;b.disabled=false;}
 }
 }catch(error){if(requestEpoch!==cloudEpoch)return;if(error.status===401)clearCloudAccess();state.cloudStatus=error.status===401?'请先登录同一个账号。':error.status===409?'账号或作品版本已变化，未覆盖远端；本机作品仍保留。请查看账号作品后决定保留哪份。':'账号服务暂时无法完成操作；本机内容仍保留。';const status=document.querySelector('#app-sync-status');if(status)status.textContent=state.cloudStatus;else if(state.screen==='cloud')render();else showToast(state.cloudStatus);}
});
document.addEventListener('submit',async event=>{
 if(!event.target.matches('[data-app-create-collection]'))return;event.preventDefault();
 try{const store=await memoryStorePromise;await store.createCollection({name:new FormData(event.target).get('name')});await refreshMemories();}catch{showToast('合集没有创建成功，请重试');}
});
document.addEventListener('change',async event=>{
 if(event.target.id==='app-collection-filter'){state.collectionFilter=event.target.value;await refreshMemories();}
 if(event.target.id==='app-memory-collection'){try{const store=await memoryStorePromise;const m=await store.getMemory(state.memoryId);state.originalMemory=await store.saveMemory({...m,collectionId:event.target.value});await refreshMemories();showToast('已移入合集');}catch{showToast('移动未成功，原记录仍保留');}}
});

document.addEventListener('click',event=>{
 const button=event.target.closest('[data-app-edit-pair]');if(!button)return;
 const index=Number(button.dataset.appEditPair),pair=state.pairs[index];if(!pair)return;
 invalidateQuestion();state.pendingNewAnswer=false;state.activePairIndex=index;state.activePairId=pair.id;state.photo=state.photos.find(photo=>photo.id===pair.photoId)||state.photos[0];
 state.question=pair.question;state.answerDraft=pair.answer;state.answer='';state.questionStatus='restored';navigate('dialogue');
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-app-shape],[data-app-export],[data-app-photo],[data-app-move],[data-app-remove]");
  if (!button) return;
  if (button.dataset.appExport) { void exportCreation(state, button.dataset.appExport, app); return; }
  if (button.dataset.appShape) state.resultShape = button.dataset.appShape;
  if (button.dataset.appPhoto !== undefined) { invalidateQuestion(); state.photo = state.photos[Number(button.dataset.appPhoto)];
    const i=state.pairs.findLastIndex(p=>p.photoId===state.photo.id);state.activePairIndex=i;state.pendingNewAnswer=false;
    state.activePairId=i>=0?state.pairs[i].id:null;
    state.question=i>=0?state.pairs[i].question:"";state.answer=state.answerDraft=i>=0?state.pairs[i].answer:"";
    state.questionStatus=i>=0?"restored":"idle";
  }
  if (button.dataset.appRemove !== undefined && state.photos.length>1) { state.photos.splice(Number(button.dataset.appRemove),1); state.photo=state.photos[0]; if(state.photos.length<2)state.resultShape="memory-page"; }
  if (button.dataset.appMove !== undefined) { const i=Number(button.dataset.appMove),j=i+Number(button.dataset.direction); if(j>=0&&j<state.photos.length)[state.photos[i],state.photos[j]]=[state.photos[j],state.photos[i]]; }
  state.saved=false;persistDraft();render();
});
document.addEventListener("change", event=> {
  if(event.target.id==="app-memory-style")state.styleId=event.target.value;
  else if(event.target.id==="app-page-aspect")state.pageAspect=event.target.value;
  else if(event.target.id==="app-memory-title")state.title=event.target.value;
  else return;
  state.saved=false;persistDraft();render();
});

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
  if (action === "next-question") { startDialogue(true); return; }
  if (action === "write-first") { invalidateQuestion(); state.question="这张照片之外，还有什么是你想留下的？";state.questionStatus="manual";state.answer="";state.answerDraft="";state.activePairIndex=-1;state.activePairId=null;state.pendingNewAnswer=true;navigate("dialogue");render();return; }
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
    if(next === "account" || next === "event"){void openAccount();return;}
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
  if(event.target.id === 'app-memory-title'){
    state.title=event.target.value;state.saved=false;persistDraft();
    const save=app.querySelector('[data-action="save-memory"]');if(save&&!state.saving){save.disabled=false;save.textContent='保存这段回忆';}
    const coverTitle=app.querySelector('#app-book-preview h2');if(coverTitle)coverTitle.textContent=state.title||'留住的这一刻';
    return;
  }
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
    void handleFile(isApp ? Array.from(input.files) : file, source).finally(() => { input.value = ""; });
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
  if (!document.body.classList.contains("ui-review") || state.screen === "case" || ["INPUT", "TEXTAREA"].includes(event.target.tagName) || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const index = Math.max(0, screens.findIndex(([key]) => key === state.screen));
  const direction = event.key === "ArrowRight" ? 1 : -1;
  navigate(screens[(index + direction + screens.length) % screens.length][0]);
});

window.addEventListener("pagehide",()=>{if(state.screen==='account')disposeAccountSurface();invalidateCloudRequests();persistDraft();});
window.addEventListener("pageshow",event=>{if(!event.persisted)return;if(state.screen==='account')void openAccount(state.accountTarget,{remember:false});else if(['sync','cloud'].includes(state.screen))render();});
window.addEventListener("beforeunload", () => { persistDraft(); voiceInput.cancel(); turnVoice.clear(); teardownSpatial(); });
window.addEventListener("popstate",event=>{
 if(state.screen==='account')disposeAccountSurface();
 invalidateCloudRequests();
 invalidateQuestion();voiceInput.cancel();turnVoice.stop();
 if(event.state?.unseenApp)Object.assign(state,event.state);
 else {const post=appCases.get(new URLSearchParams(location.search).get('case')||decodeURIComponent(location.pathname.split('/')[3]||''));state.screen=post?'case':'home';state.officialPostId=post?.id;}
 state.overlay=null;if(state.screen==='account')void openAccount(state.accountTarget,{remember:false});else render();
});

render();
const navigationRestorePromise = initialOfficialPost ? Promise.resolve(false) : restoreNavigationState();
navigationRestorePromise
  .then(async (restored) => {
    const params=new URLSearchParams(location.search);const route=location.pathname.split('/')[2];
    if(params.get('account')==='invite')await openAccount({route:'invite',inviteToken:params.get('invite')});
    else if(route==='account')await openAccount(history.state?.accountTarget||{route:'spaces'},{remember:false});
    else if(route&&screenRenderers[route]&&route!=='case'){state.screen=route;render();}
    else if(restored&&state.screen==='account')await openAccount(history.state?.accountTarget||{route:'spaces'},{remember:false});
    else if(restored)render();
    return refreshMemories();
  })
  .catch(() => {
    state.storeStatus = "unavailable";
    if (state.screen === "home" || state.screen === "mine") render();
  });
