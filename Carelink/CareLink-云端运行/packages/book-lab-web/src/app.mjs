import { PAGE_ACTIONS, concreteRoute, resolveEntry } from "./routes.mjs";
import { resolvePagePresentation } from "./page-model.mjs";

const [fixtureResponse, catalogResponse] = await Promise.all([fetch("/__fixture"), fetch("/__catalog")]);
if (!fixtureResponse.ok || !catalogResponse.ok) throw new Error("fixture_or_catalog_unavailable");
const fixture = await fixtureResponse.json();
const catalog = await catalogResponse.json();

const phases = catalog.phaseOrder;
const journeyLabels = Object.freeze({
  BL01: "回答照片",
  BL02: "写下回忆",
  BL03: "同意入书",
  BL04: "查看纪念册",
  BL05: "编辑纪念册",
  BL06: "阅读定稿"
});
const phaseLabels = Object.freeze({
  initial: "默认提示",
  loading: "处理中",
  success: "完成",
  retry: "可重试",
  stable_error: "暂时失败",
  empty: "暂无内容",
  session_or_permission_loss: "权限变化",
  destructive_confirm: "操作确认",
  conflict: "内容已变化",
  return: "返回"
});
const main = document.querySelector("main");
const status = document.querySelector("#status");
const fixtureNav = document.querySelector(".fixture-nav");
const initialArtifactRoot = `/__artifacts/${fixture.manifest.manifestHash}`;

const state = {
  entry: resolveEntry(location.pathname),
  photoIndex: 0,
  answer: fixture.photos[0].answer,
  saved: true,
  followupCount: 0,
  confirmed: true,
  authorized: false,
  consentChecked: false,
  credit: fixture.photos[0].credit,
  title: fixture.manifest.title,
  pages: structuredClone(fixture.manifest.pages),
  currentPage: 0,
  previewReady: true,
  previewManifest: structuredClone(fixture.manifest),
  frozenManifest: structuredClone(fixture.manifest),
  artifactUrls: { html: `${initialArtifactRoot}/book.html`, pdf: `${initialArtifactRoot}/book.pdf`, receipt: `${initialArtifactRoot}/render-receipt.json` },
  localVersionId: fixture.book.currentVersion.versionId,
  localVersionRevision: fixture.book.currentVersion.ordinal,
  selectedEvidenceAction: null,
  selectedEvidencePhase: "initial",
  questionFailed: false,
  memoryWithdrawn: false,
  withdrawnPages: new Map()
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function actionText(actionId, phase = "initial") {
  const text = catalog.actions[actionId]?.[phase];
  if (!text) throw new Error(`missing_catalog_string:${actionId}:${phase}`);
  return text;
}

function currentPhoto() {
  return fixture.photos[state.photoIndex];
}

function currentMemoryText(photo = currentPhoto()) {
  return fixture.manifest.authorizedMemoryTexts.find((text) => text.sourceProvenance.photoId === photo.photoId);
}

function reindexPages() {
  state.pages.forEach((page, index) => { page.index = index + 1; });
  state.currentPage = Math.min(state.currentPage, state.pages.length - 1);
  state.previewReady = false;
  state.previewManifest = null;
}

function withdrawContribution(personalMemoryId) {
  const page = state.pages.find((item) => item.personalMemoryId === personalMemoryId);
  if (page) state.withdrawnPages.set(personalMemoryId, structuredClone(page));
  state.pages = state.pages.filter((item) => item.personalMemoryId !== personalMemoryId);
  reindexPages();
}

function restoreContribution(personalMemoryId) {
  const page = state.withdrawnPages.get(personalMemoryId);
  if (!page || state.pages.some((item) => item.personalMemoryId === personalMemoryId)) return;
  const order = fixture.manifest.pages.findIndex((item) => item.pageId === page.pageId);
  const next = state.pages.findIndex((item) => fixture.manifest.pages.findIndex((source) => source.pageId === item.pageId) > order);
  state.pages.splice(next < 0 ? state.pages.length : next, 0, page);
  state.withdrawnPages.delete(personalMemoryId);
  reindexPages();
}

function startNewVersion() {
  state.localVersionRevision += 1;
  state.localVersionId = `book-version-local-${String(state.localVersionRevision).padStart(2, "0")}`;
  state.pages = state.pages.filter((page) => !state.withdrawnPages.has(page.personalMemoryId));
  reindexPages();
  state.frozenManifest = null;
  state.artifactUrls = null;
  state.currentPage = 0;
  navigate("BL05");
}

function provenanceRibbon(photo = currentPhoto()) {
  const provenance = currentMemoryText(photo).sourceProvenance;
  return `<p class="provenance-ribbon" aria-label="来源：${esc(photo.time)}，${esc(photo.place)}，${esc(photo.direction)}，${esc(photo.credit)}">
    <span>${esc(photo.time)}</span><span>${esc(photo.place)}</span><span>${esc(photo.direction)}</span><span>${esc(photo.credit)}</span>
  </p>`;
}

function photoFigure(photo = currentPhoto(), className = "source-photo") {
  return `<figure class="${className}"><img src="${photo.dataUri}" alt="${esc(photo.visibleDetail)}"/>${provenanceRibbon(photo)}<figcaption>${esc(photo.visibleDetail)}</figcaption></figure>`;
}

function button(actionId, { kind = "secondary", disabled = false, phase = "initial", extra = "" } = {}) {
  return `<button type="button" class="button ${kind}" data-action="${esc(actionId)}" ${disabled ? "disabled" : ""} ${extra}>${esc(actionText(actionId, phase))}</button>`;
}

function pageHeader(kicker, title, note) {
  return `<header class="page-header"><nav class="book-journey" aria-label="当前位置"><a href="/">首页</a><a href="/s/space-gongguang/photos/photo-1">向晚照片样本</a><span aria-current="page">AdventureX · ${esc(journeyLabels[state.entry])}</span></nav><p class="fixture-context"><strong>本地确定性样本</strong> · 非真实 AI · 不代表正式发布</p><p class="kicker">${esc(kicker)}</p><h1>${esc(title)}</h1><p>${esc(note)}</p></header>`;
}

function renderEvidencePanel(entry) {
  const actions = PAGE_ACTIONS[entry];
  const selected = actions.includes(state.selectedEvidenceAction) ? state.selectedEvidenceAction : actions[0];
  state.selectedEvidenceAction = selected;
  return `<details class="evidence-panel"><summary>查看这一步的样本状态</summary><div class="evidence-controls">
    <label>操作<select data-evidence-action aria-label="选择本页操作">${actions.map((action) => `<option value="${esc(action)}" ${action === selected ? "selected" : ""}>${esc(actionText(action))}</option>`).join("")}</select></label>
    <label>状态<select data-evidence-phase aria-label="选择界面状态">${phases.map((phase) => `<option value="${esc(phase)}" ${phase === state.selectedEvidencePhase ? "selected" : ""}>${esc(phaseLabels[phase] ?? phase)}</option>`).join("")}</select></label>
  </div><p class="evidence-copy">${esc(actionText(selected, state.selectedEvidencePhase))}</p>
  <p class="microcopy">这里用本地样本展示界面反馈，不会调用真实 AI，也不会发布内容。</p></details>`;
}

function renderBL01() {
  const photo = currentPhoto();
  const actions = state.questionFailed
    ? `<div class="failure-example" data-question-state="failed" role="alert"><strong>${esc(actionText("MEMORY.START_QUESTION", "stable_error"))}</strong><div class="action-stack">${button("MEMORY.START_QUESTION", { kind: "primary", phase: "retry", extra: "data-question-retry" })}${button("MEMORY.SKIP", { kind: "text" })}</div></div>`
    : `<div class="action-stack">${button("MEMORY.START_QUESTION", { kind: "primary" })}${button("MEMORY.SKIP", { kind: "text" })}</div>`;
  return `<div class="page-shell">
    ${pageHeader("照片之后 · 可选", "这张照片想问你一句", "问题只依据照片里可见的内容。可以跳过，照片仍会留在原来的现场位置。")}
    <div class="question-layout">${photoFigure(photo)}
      <section class="task-card" aria-labelledby="question-heading"><p class="ai-label">本地确定性问题 · 非真实 AI</p>
        <h2 id="question-heading">${esc(photo.question)}</h2>
        <p class="privacy-note">只有你能看到未确认的回答；确认也不等于授权入书。</p>
        ${actions}
      </section>
    </div>${renderEvidencePanel("BL01")}</div>`;
}

function renderBL02() {
  const photo = currentPhoto();
  if (state.memoryWithdrawn) return `<div class="page-shell">
    ${pageHeader("我的回忆 · 已撤回", "这段回忆已不再显示", "你可以回到照片，之后重新开始一段回忆。")}
    <section class="task-card empty-state" data-memory-empty><h2>${esc(actionText("MEMORY.WITHDRAW", "empty"))}</h2><a class="button primary" href="${esc(concreteRoute("BL01", fixture))}" data-entry="BL01">${esc(actionText("MEMORY.WITHDRAW", "return"))}</a></section>
    ${renderEvidencePanel("BL02")}</div>`;
  const followupQuestions = [
    "那张名字卡后来被收在哪里？",
    "名字卡旁边的蓝色笔记本后来还在吗？",
    "再看到那张名字卡时，你最想补记哪件事？"
  ];
  const followup = followupQuestions.slice(0, state.followupCount)
    .map((question, index) => `<article class="question-sheet"><p class="ai-label">可选追问 · ${index + 1} / 3</p><h2>${esc(question)}</h2></article>`).join("");
  return `<div class="page-shell">
    ${pageHeader("我的回忆 · 仅本人可见", "写下你记得的版本", "AI 不生成、不润色，也不会替你署名。每次保存都会留下一个新的回答版本。")}
    <div class="memory-layout"><aside>${photoFigure(photo, "source-photo compact")}</aside><section class="answer-column">
      <article class="question-sheet"><p class="ai-label">照片问题 · 1 / 1</p><h2>${esc(photo.question)}</h2><p>依据：${esc(photo.visibleDetail)}</p></article>${followup}
      <label class="answer-field"><span>${esc(catalog.contextLabels.user_answer)}</span><textarea rows="7" maxlength="10000">${esc(state.answer)}</textarea></label>
      <p class="version-line">${esc(catalog.contextLabels.confirmed_submission)} · submission-01-02 · 原文未改写</p>
      <div class="action-row">${state.saved ? button("MEMORY.CONFIRM", { kind: "primary" }) : button("MEMORY.SAVE_ANSWER_DRAFT", { kind: "primary" })}${button("MEMORY.REQUEST_FOLLOWUP", { disabled: state.followupCount >= 3 })}${button("MEMORY.SAVE_ANSWER_DRAFT")}</div>
      <details class="danger-zone"><summary>${esc(actionText("MEMORY.WITHDRAW", "initial"))}</summary><p>${esc(actionText("MEMORY.WITHDRAW", "destructive_confirm"))}</p>${button("MEMORY.WITHDRAW", { kind: "danger" })}</details>
    </section></div>${renderEvidencePanel("BL02")}</div>`;
}

function renderBL03() {
  const photo = currentPhoto();
  const text = currentMemoryText();
  return `<div class="page-shell consent-page">
    ${pageHeader("单独授权", `只同意收入《${state.title}》`, "照片可见、回答已确认，都不会自动让这段原话进入书中。")}
    <div class="consent-layout">${photoFigure(photo, "source-photo compact")}
      <section class="consent-card"><div class="quote-proof"><p>${esc(catalog.contextLabels.confirmed_submission)} · ${esc(text.confirmedSubmissionId)}</p><blockquote dir="auto">${esc(state.answer)}</blockquote><p>提交时间 2026-05-19 09:18 · 版本已固定</p></div>
        <dl class="consent-facts"><div><dt>目标书</dt><dd>《${esc(state.title)}》· AdventureX 2026</dd></div><div><dt>${esc(catalog.contextLabels.author_viewpoint)}</dt><dd><label class="inline-field">署名<input data-credit maxlength="120" value="${esc(state.credit)}"/></label></dd></div><div><dt>读者</dt><dd>当前仍可查看这个空间的人</dd></div><div><dt>${esc(catalog.contextLabels.source_photo)}</dt><dd>${esc(photo.photoId)} · ${esc(photo.visibleDetail)}</dd></div></dl>
        <label class="explicit-consent"><input type="checkbox" data-consent ${state.consentChecked ? "checked" : ""}/><span>${esc(actionText("BOOK_MEMORY.AUTHORIZE", "destructive_confirm"))}</span></label>
        <div class="action-stack">${button("BOOK_MEMORY.AUTHORIZE", { kind: "primary", disabled: !state.consentChecked || !state.credit.trim() })}${state.authorized ? button("BOOK_MEMORY.WITHDRAW", { kind: "danger" }) : ""}</div>
        <p class="microcopy">同意框默认不勾选；这次选择只绑定当前回答版本、当前署名与眼前这一本书。</p>
      </section>
    </div>${renderEvidencePanel("BL03")}</div>`;
}

function renderBL04() {
  const activeMemoryCount = fixture.manifest.authorizedMemoryTexts.length - state.withdrawnPages.size;
  const withdrawalNote = state.withdrawnPages.size ? `<p class="withdrawal-note">已排除 ${state.withdrawnPages.size} 段撤回内容</p>` : "";
  const status = state.withdrawnPages.size ? '<p class="status-pill warning">旧版已停止提供 · 请制作新版</p>' : '<p class="status-pill success">当前数字版可查看</p>';
  return `<div class="page-shell">
    ${pageHeader("空间管理 · 纪念册", "记忆成书", "这里仅汇总已对这一本书单独授权的回忆。参与者的未授权内容不会出现。")}
    <div class="lab-overview"><section class="book-card"><div class="book-cover-mini"><span>AdventureX 2026</span><strong>${esc(state.title)}</strong><small>本地修订 ${String(state.localVersionRevision).padStart(2, "0")} · ${state.pages.length} 页</small></div>
      <div class="book-summary">${status}<h2>${esc(state.title)}</h2><p>${fixture.photos.length} 张来源照片 · ${fixture.contributors.length} 位署名参与者</p><p>上次生成：2026-05-19 10:12</p>${button("BOOK.OPEN_DRAFT")}</div></section>
      <aside class="material-summary"><p class="kicker">当前可用素材</p><strong data-active-memory-count>${activeMemoryCount}</strong><span>段已单独授权的原话</span>${withdrawalNote}<hr/><p>空间主人看不到参与者未授权的草稿。</p>${button("BOOK.CREATE", { kind: "primary" })}</aside>
    </div>${renderEvidencePanel("BL04")}</div>`;
}

function draftPageCard(page, title = state.title) {
  if (page.kind === "cover") return `<div class="draft-page cover-draft"><span>AdventureX 2026</span><strong>${esc(title)}</strong><small>四种署名视角</small></div>`;
  if (page.kind === "closing") return `<div class="draft-page closing-draft"><strong>记得不同，也可以一起留下。</strong><small>版本 02</small></div>`;
  const { text, sourcePhoto, displayPhoto } = resolvePagePresentation(fixture, page);
  return `<div class="draft-page"><img src="${displayPhoto.dataUri}" alt="${esc(displayPhoto.visibleDetail)}"/><blockquote dir="auto">${esc(text.originalUserText)}</blockquote><p>— ${esc(text.authorCredit)}</p>${provenanceRibbon(sourcePhoto)}</div>`;
}

function renderBL05() {
  const page = state.pages[state.currentPage];
  const withdrawalNote = state.withdrawnPages.size ? `<p class="withdrawal-note">已排除 ${state.withdrawnPages.size} 段撤回内容</p>` : "";
  return `<div class="page-shell draft-shell" data-local-version-id="${esc(state.localVersionId)}" data-local-version-revision="${state.localVersionRevision}">
    ${pageHeader(`书稿 · 本地修订 ${String(state.localVersionRevision).padStart(2, "0")}`, state.title, "可改标题、删页或更换这一页的展示照片。来源照片、原话和授权不会随展示图改变。")}
    <div class="draft-layout"><section class="page-workbench"><div class="page-stage">${draftPageCard(page)}</div>
      <div class="page-strip" aria-label="书页">${state.pages.map((item, index) => `<button class="page-thumb ${index === state.currentPage ? "active" : ""}" data-page-index="${index}" data-page-id="${esc(item.pageId)}" aria-label="第 ${index + 1} 页：${esc(item.pageId)}"><span>${index + 1}</span>${esc(item.kind)}</button>`).join("")}</div></section>
      <aside class="draft-controls"><label>纪念册标题<input data-title maxlength="120" value="${esc(state.title)}"/></label>${button("BOOK.EDIT_TITLE")}
        <div class="rule"></div><p><strong>当前页 ${page.index}</strong><br/>${esc(page.pageId)}</p>
        ${page.kind !== "cover" && page.kind !== "closing" ? `${button("BOOK.REPLACE_PAGE_PHOTO")}${button("BOOK.REMOVE_PAGE", { kind: "danger", disabled: state.pages.length <= 12 })}` : "<p class=\"microcopy\">封面与尾页不使用个人原话。</p>"}
        ${withdrawalNote}
        <div class="rule"></div><div class="affected-note"><span>${esc(catalog.contextLabels.needs_new_version)}</span><p>版本 01 因一段内容撤回，已停止预览和下载。</p>${button("BOOK.START_NEW_VERSION")}</div>
        <div class="primary-dock">${state.previewReady ? button("BOOK.FREEZE", { kind: "primary" }) : button("BOOK.GENERATE_PREVIEW", { kind: "primary" })}<p>${state.previewReady ? `${state.pages.length} 页预览已核对；确认后本版不再直接修改。` : esc(actionText("BOOK.GENERATE_PREVIEW", "destructive_confirm"))}</p></div>
      </aside></div>${renderEvidencePanel("BL05")}</div>`;
}

function renderBookSpread(page, manifest) {
  if (page.kind === "cover" || page.kind === "closing") return draftPageCard(page, manifest.title);
  const { text, sourcePhoto, displayPhoto } = resolvePagePresentation(fixture, page);
  return `<article class="reader-page" data-page-id="${esc(page.pageId)}"><img src="${displayPhoto.dataUri}" alt="${esc(displayPhoto.visibleDetail)}"/><div><p class="ai-label">照片问题</p><h2>${esc(text.questionProvenance[0].question)}</h2><blockquote dir="auto">${esc(text.originalUserText)}</blockquote><p class="credit">— ${esc(text.authorCredit)}</p>${provenanceRibbon(sourcePhoto)}<p class="source-code">来源照片已核对 · 现场位置记录已保留 · 更换展示图不会改变原始来源</p></div></article>`;
}

function renderBL06() {
  const manifest = state.frozenManifest;
  const page = manifest.pages[state.currentPage];
  return `<div class="page-shell reader-shell">
    ${pageHeader("纪念册 · 定稿版本 02", manifest.title, "纪念册文件与印刷版来自同一份定稿；原话、署名、来源与页序保持一致。")}
    <div class="reader-layout"><section><div class="reader-frame">${renderBookSpread(page, manifest)}</div><div class="reader-nav"><button data-page-step="-1" ${state.currentPage === 0 ? "disabled" : ""}>上一页</button><span>${state.currentPage + 1} / ${manifest.pages.length}</span><button data-page-step="1" ${state.currentPage === manifest.pages.length - 1 ? "disabled" : ""}>下一页</button></div></section>
      <aside class="reader-meta"><p class="status-pill success">版本 02 · 可查看</p><dl><div><dt>版本指纹</dt><dd>${esc(manifest.manifestHash.slice(0, 12))}…</dd></div><div><dt>页数</dt><dd>${manifest.pages.length}</dd></div><div><dt>来源照片</dt><dd>${fixture.photos.length}</dd></div></dl>
        ${button("BOOK.DOWNLOAD_PDF", { kind: "primary" })}<a class="button secondary" href="${esc(state.artifactUrls.html)}" target="_blank" rel="noopener">查看印刷版</a><a class="receipt-link" href="${esc(state.artifactUrls.receipt)}" target="_blank" rel="noopener">查看版本校验记录</a>
        <div class="affected-note"><span>${esc(catalog.contextLabels.withdrawn)} · 版本 01</span><p>${esc(catalog.validationMessages.withdrawal_affected)} 已经保存到个人设备的文件无法由系统召回。</p><button class="button secondary" type="button" data-action="BOOK.START_NEW_VERSION">返回编辑新版</button></div>
      </aside></div>${renderEvidencePanel("BL06")}</div>`;
}

const renderers = { BL01: renderBL01, BL02: renderBL02, BL03: renderBL03, BL04: renderBL04, BL05: renderBL05, BL06: renderBL06 };

function renderNav() {
  fixtureNav.innerHTML = `<div>${Object.keys(PAGE_ACTIONS).map((entry) => `<a href="${esc(concreteRoute(entry, fixture))}" data-entry="${entry}" ${entry === state.entry ? 'aria-current="page"' : ""}>${esc(journeyLabels[entry])}</a>`).join("")}</div>`;
}

function render() {
  document.body.dataset.entry = state.entry;
  renderNav();
  main.innerHTML = renderers[state.entry]();
  main.querySelector("textarea")?.addEventListener("input", (event) => { state.answer = event.target.value; state.saved = false; });
  main.querySelector("[data-consent]")?.addEventListener("change", (event) => { state.consentChecked = event.target.checked; render(); });
  main.querySelector("[data-credit]")?.addEventListener("input", (event) => { state.credit = event.target.value; });
  main.querySelector("[data-title]")?.addEventListener("input", (event) => { state.title = event.target.value; });
  main.querySelector("[data-evidence-action]")?.addEventListener("change", (event) => { state.selectedEvidenceAction = event.target.value; render(); });
  main.querySelector("[data-evidence-phase]")?.addEventListener("change", (event) => { state.selectedEvidencePhase = event.target.value; render(); });
}

function announce(message) {
  status.textContent = message;
}

async function renderCurrentDraft() {
  const response = await fetch("/__artifacts/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: state.title, pages: state.pages })
  });
  if (!response.ok) throw new Error("fixture_render_failed");
  return response.json();
}

function navigate(entry) {
  state.entry = entry;
  state.selectedEvidenceAction = null;
  history.pushState({}, "", concreteRoute(entry, fixture));
  render();
  main.focus();
}

async function perform(actionId) {
  switch (actionId) {
    case "MEMORY.START_QUESTION":
      if (!state.questionFailed) {
        state.questionFailed = true;
        render();
        announce(actionText(actionId, "stable_error"));
        main.querySelector("[data-question-retry]")?.focus();
        break;
      }
      state.questionFailed = false;
      state.memoryWithdrawn = false;
      navigate("BL02");
      break;
    case "MEMORY.SKIP":
      state.questionFailed = false;
      render();
      announce(actionText(actionId, "success"));
      break;
    case "MEMORY.SAVE_ANSWER_DRAFT": state.saved = state.answer.trim().length > 0; announce(actionText(actionId, state.saved ? "success" : "empty")); render(); break;
    case "MEMORY.REQUEST_FOLLOWUP": state.followupCount = Math.min(3, state.followupCount + 1); announce(actionText(actionId, "success")); render(); break;
    case "MEMORY.CONFIRM": state.confirmed = true; announce(actionText(actionId, "success")); navigate("BL03"); break;
    case "MEMORY.WITHDRAW": if (confirm(actionText(actionId, "destructive_confirm"))) {
      state.memoryWithdrawn = true; state.answer = ""; state.saved = false; state.followupCount = 0; state.confirmed = false;
      state.authorized = false; state.consentChecked = false; withdrawContribution(currentMemoryText().personalMemoryId);
      announce(actionText(actionId, "success")); render();
    } break;
    case "BOOK_MEMORY.AUTHORIZE": if (state.consentChecked) {
      state.authorized = true; restoreContribution(currentMemoryText().personalMemoryId); announce(actionText(actionId, "success")); render();
    } break;
    case "BOOK_MEMORY.WITHDRAW": if (confirm(actionText(actionId, "destructive_confirm"))) {
      state.authorized = false; state.consentChecked = false; withdrawContribution(currentMemoryText().personalMemoryId);
      announce(actionText(actionId, "success")); render();
    } break;
    case "BOOK.CREATE": navigate("BL05"); break;
    case "BOOK.OPEN_DRAFT": navigate("BL05"); break;
    case "BOOK.EDIT_TITLE": state.previewReady = false; state.previewManifest = null; announce(actionText(actionId, "success")); render(); break;
    case "BOOK.REMOVE_PAGE": if (state.pages.length > 12 && confirm(actionText(actionId, "destructive_confirm"))) { state.pages.splice(state.currentPage, 1); state.pages.forEach((page, index) => { page.index = index + 1; }); state.currentPage = Math.min(state.currentPage, state.pages.length - 1); state.previewReady = false; state.previewManifest = null; announce(actionText(actionId, "success")); render(); } break;
    case "BOOK.REPLACE_PAGE_PHOTO": {
      const page = state.pages[state.currentPage];
      const current = fixture.photos.findIndex((photo) => photo.photoId === page.displayPhotoId);
      page.displayPhotoId = fixture.photos[(current + 1) % fixture.photos.length].photoId;
      state.previewReady = false;
      state.previewManifest = null;
      announce(actionText(actionId, "success")); render(); break;
    }
    case "BOOK.GENERATE_PREVIEW": {
      announce(actionText(actionId, "loading"));
      try {
        const rendered = await renderCurrentDraft();
        state.pages = structuredClone(rendered.manifest.pages);
        state.previewManifest = rendered.manifest;
        state.previewReady = true;
        announce(actionText(actionId, "success")); render();
      } catch { announce(actionText(actionId, "stable_error")); }
      break;
    }
    case "BOOK.FREEZE": {
      announce(actionText(actionId, "loading"));
      try {
        const rendered = await renderCurrentDraft();
        state.frozenManifest = rendered.manifest;
        state.artifactUrls = rendered.urls;
        state.title = rendered.manifest.title;
        state.pages = structuredClone(rendered.manifest.pages);
        state.currentPage = 0;
        announce(actionText(actionId, "success"));
        navigate("BL06");
      } catch { announce(actionText(actionId, "stable_error")); }
      break;
    }
    case "BOOK.START_NEW_VERSION": announce(actionText(actionId, "loading")); startNewVersion(); announce(actionText(actionId, "success")); break;
    case "BOOK.DOWNLOAD_PDF": announce(actionText(actionId, "loading")); location.href = state.artifactUrls.pdf; break;
    default: announce(actionText(actionId, "success"));
  }
}

document.addEventListener("click", (event) => {
  const routeLink = event.target.closest("a[data-entry]");
  if (routeLink) { event.preventDefault(); navigate(routeLink.dataset.entry); return; }
  const action = event.target.closest("[data-action]");
  if (action) { perform(action.dataset.action); return; }
  const pageIndex = event.target.closest("[data-page-index]")?.dataset.pageIndex;
  if (pageIndex !== undefined) { state.currentPage = Number(pageIndex); render(); return; }
  const step = event.target.closest("[data-page-step]")?.dataset.pageStep;
  if (step) { state.currentPage = Math.max(0, Math.min(state.pages.length - 1, state.currentPage + Number(step))); render(); }
});

addEventListener("popstate", () => { state.entry = resolveEntry(location.pathname); render(); });
render();
