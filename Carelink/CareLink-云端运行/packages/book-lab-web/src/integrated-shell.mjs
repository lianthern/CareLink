import { BookLabIntegratedController } from "./integrated-controller.mjs";
import { ACTION_REQUESTS, BookLabIntegratedTransport } from "./integrated-transport.mjs";
import { PAGE_ACTIONS } from "./routes.mjs";

export class IntegratedBookLabShellError extends Error {
  constructor(code) {
    super(code);
    this.name = "IntegratedBookLabShellError";
    this.code = code;
  }
}

function fail(code) {
  throw new IntegratedBookLabShellError(code);
}

function required(value, code = "integrated_input_unavailable") {
  if (value === undefined || value === null || value === "") fail(code);
  return value;
}

export function escapeBookLabHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function actionText(catalog, actionId, phase = "initial") {
  return required(catalog?.actions?.[actionId]?.[phase], "integrated_catalog_unavailable");
}

function actionButton(catalog, actionId, { primary = false, danger = false, disabled = false, label = null } = {}) {
  const kind = primary ? "primary" : danger ? "danger" : "secondary";
  return `<button type="button" class="button ${kind}" data-book-action="${escapeBookLabHtml(actionId)}"${disabled ? " disabled" : ""}>${escapeBookLabHtml(label ?? actionText(catalog, actionId))}</button>`;
}

function pageHeader(kicker, title, note) {
  return `<header class="page-header"><p class="kicker">${escapeBookLabHtml(kicker)}</p><h1>${escapeBookLabHtml(title)}</h1><p>${escapeBookLabHtml(note)}</p></header>`;
}

function status(value) {
  return `<span class="status-pill success">${escapeBookLabHtml(value ?? "—")}</span>`;
}

function actions(catalog, entry, options = {}) {
  const disabled = new Set(options.disabled ?? []);
  return `<div class="action-row" aria-label="本页操作">${PAGE_ACTIONS[entry].map((actionId) =>
    actionButton(catalog, actionId, { primary: actionId === options.primary, danger: actionId.includes("WITHDRAW"),
      disabled: disabled.has(actionId) }))
    .join("")}</div>`;
}

function latestQuestion(body) {
  return [...(body.recoverableQuestionJobs ?? [])].reverse().find((job) => job.question)?.question ?? null;
}

function latestSubmission(body) {
  const memory = body.memory ?? {};
  return body.submissions?.find((item) => item.submissionId === memory.headSubmissionId) ?? body.submissions?.at(-1) ?? null;
}

function bl01QuestionState(view) {
  const body = view?.response?.body ?? {};
  const jobs = Array.isArray(body.recoverableQuestionJobs) ? body.recoverableQuestionJobs : [];
  const latestJob = jobs.at(-1);
  const pendingJob = [...jobs].reverse().find((job) => ["queued", "running"].includes(job?.status));
  const provider = view?.response?.unseenHeaders?.["x-unseen-question-provider"];
  const worker = view?.response?.unseenHeaders?.["x-unseen-private-ai-worker"];
  const workerCanQueue = ["online", "offline"].includes(worker);
  const startDisabled = provider !== "configured" || !workerCanQueue || body.eligibility !== "eligible" ||
    Boolean(pendingJob);
  const lastStableError = (pendingJob ?? latestJob)?.recovery?.lastStableError;
  const genericCopy = "暂时不能为这张照片生成问题；你仍可以跳过，照片不会受影响";
  const copy = provider === "unavailable"
    ? "AI 暂时离线，照片已保存，稍后再问"
    : provider !== "configured" || !workerCanQueue || body.eligibility !== "eligible" ? genericCopy
      : worker === "offline" || lastStableError === "model_unavailable"
        ? "AI 暂时离线，照片已保存，稍后再问"
        : pendingJob ? "AI 正在准备问题，照片已保存；稍后会自动出现。"
          : startDisabled ? genericCopy : null;
  const requestedDelay = pendingJob?.recovery?.nextPollAfterMs;
  const pollAfterMs = Number.isSafeInteger(requestedDelay) && requestedDelay >= 0
    ? Math.max(1_000, Math.min(30_000, requestedDelay)) : null;
  return { copy, pollAfterMs, startDisabled };
}

function renderBL01(view, catalog) {
  const body = view.response.body ?? {};
  const provenance = body.provenance ?? {};
  const question = bl01QuestionState(view);
  return `<div class="page-shell integrated-book-shell">
    ${pageHeader("照片记忆", "回答这张照片的问题", "可以跳过，不影响照片主链。AI 只负责提问，不会替你填写回答。")}
    <div class="question-layout"><section class="task-card">
      <p class="privacy-note">${escapeBookLabHtml(body.collectionNotice?.plainLanguageCopy ?? "照片记忆仅由贡献者本人填写。")}</p>
      <dl class="integrated-facts"><div><dt>照片</dt><dd>${escapeBookLabHtml(body.photoId)}</dd></div><div><dt>位置版本</dt><dd>${escapeBookLabHtml(provenance.placementRevisionId)}</dd></div><div><dt>状态</dt><dd>${status(body.memory?.status ?? body.eligibility)}</dd></div></dl>
      ${latestQuestion(body) ? `<div class="question-sheet"><p class="ai-label">照片问题</p><h2>${escapeBookLabHtml(latestQuestion(body))}</h2></div>` : ""}
      ${question.copy ? `<p class="integrated-warning" role="status">${question.copy}</p>` : ""}
      ${actions(catalog, "BL01", { primary: "MEMORY.START_QUESTION",
        disabled: question.startDisabled ? ["MEMORY.START_QUESTION"] : [] })}
    </section></div></div>`;
}

// A follow-up job (MEMORY.REQUEST_FOLLOWUP) runs exactly like a BL01 initial question job — queued/running on
// the server, polled here — but recoverableQuestionJobs is the only place that shows up; nothing on this page
// used to read it, so a contributor who asked for a follow-up saw no waiting state and the page never
// refreshed itself once the next question (or a stable failure) landed. Mirrors bl01QuestionState: derive
// copy + a clamped poll delay from the latest job, and additionally report whether SAVE_ANSWER_DRAFT/
// REQUEST_FOLLOWUP should be disabled while a follow-up is in flight (the server itself also fails those
// closed via memory.interview_status, this just avoids a wasted tap and 409 while that's true).
// followupOrdinal (required on FollowupJobDTO, absent on the initial QuestionJobDTO — see
// contracts/source/l3-book-lab/ACTION-API-COVERAGE.book-lab.json) is what distinguishes the two DTO shapes;
// there is no separate top-level "kind" field on either.
function bl02QuestionState(view) {
  const body = view?.response?.body ?? {};
  const jobs = Array.isArray(body.recoverableQuestionJobs) ? body.recoverableQuestionJobs : [];
  const latestJob = jobs.at(-1);
  const isFollowup = (job) => Number.isInteger(job?.followupOrdinal);
  const pendingJob = isFollowup(latestJob) && ["queued", "running"].includes(latestJob.status) ? latestJob : null;
  const failedJob = !pendingJob && isFollowup(latestJob) && latestJob.status === "failed" ? latestJob : null;
  const copy = pendingJob ? "AI 正在看照片准备追问；这次回答已经保存，稍后会自动出现。"
    : failedJob ? "上一次追问没能生成；可以再试一次，也可以先确认这次的原话。" : null;
  const requestedDelay = pendingJob?.recovery?.nextPollAfterMs;
  const pollAfterMs = Number.isSafeInteger(requestedDelay) && requestedDelay >= 0
    ? Math.max(1_000, Math.min(30_000, requestedDelay)) : null;
  const followupLimit = Number.isInteger(body.followupLimit) && body.followupLimit >= 1 && body.followupLimit <= 3
    ? body.followupLimit : 3;
  const followupCount = jobs.filter((job) => isFollowup(job) && job.status === "ready")
    .reduce((maximum, job) => Math.max(maximum, job.followupOrdinal), 0);
  return { copy, pollAfterMs, pending: Boolean(pendingJob), followupCount,
    followupLimit, limitReached: followupCount >= followupLimit };
}

function questionThread(body) {
  const questions = (body.recoverableQuestionJobs ?? []).filter((job) => job.status === "ready" && job.question);
  if (questions.length <= 1) return "";
  return `<section class="photo-chat-thread" aria-label="已经聊过的问题"><div class="photo-chat-thread__head"><p class="ai-label">这张照片的对话</p><span>${escapeBookLabHtml(questions.length)} 个问题</span></div><ol>${questions.map((job, index) => `<li${index === questions.length - 1 ? ' aria-current="step"' : ""}><span>${escapeBookLabHtml(index + 1)}</span><p>${escapeBookLabHtml(job.question)}</p></li>`).join("")}</ol></section>`;
}

function renderBL02(view, catalog) {
  const body = view.response.body ?? {};
  const memory = body.memory ?? {};
  const submission = latestSubmission(body);
  const question = bl02QuestionState(view);
  const currentAnswer = memory.status === "followup_ready" ? null : submission;
  const confirmed = memory.status === "confirmed";
  const canContinue = Boolean(submission) && memory.status === "draft" && !question.pending &&
    !question.limitReached && !confirmed;
  const canConfirm = Boolean(submission) && !confirmed;
  const eligibleBooks = parseEligibleBooks(view);
  return `<div class="page-shell integrated-book-shell">
    ${pageHeader("你的原话", "和这张照片多聊一会", `每次追问只带上上一问和你上一答的前 500 字；最多继续 ${question.followupLimit} 轮，也可以随时聊够了。`)}
    <section class="answer-column"><p class="privacy-note photo-chat-disclosure"><strong>点“继续聊”会发送：</strong>上一问、AI 记录的 1–2 条可见事实和你上一答的前 500 字，会连同照片发送给当前配置的 AI 处理服务（该服务可能由第三方提供）来生成下一问。你也可以直接聊够了。</p>${questionThread(body)}<div class="question-sheet"><p class="ai-label">现在的问题 · ${escapeBookLabHtml(question.followupCount)} / ${escapeBookLabHtml(question.followupLimit)} 次追问</p><h2>${escapeBookLabHtml(latestQuestion(body) ?? "问题仍在准备中")}</h2></div>
      <label class="answer-field">你的回答<textarea data-book-field="userText" maxlength="10000" rows="7"${confirmed ? " disabled" : ""}>${escapeBookLabHtml(currentAnswer?.userText ?? "")}</textarea></label>
      <p class="version-line">${confirmed ? "这段原话已经确认" : "回答会先保存为草稿"} · 版本 ${escapeBookLabHtml(memory.interviewVersion)}</p>
      ${question.copy ? `<p class="integrated-warning" role="status">${question.copy}</p>` : ""}
      ${question.limitReached && !confirmed ? `<p class="microcopy">已经聊完 ${escapeBookLabHtml(question.followupLimit)} 轮追问。可以修改最后一段，或选择“聊够了，确认这段”。</p>` : ""}
      <div class="action-row" aria-label="本页操作">
        ${actionButton(catalog, "MEMORY.SAVE_ANSWER_DRAFT", { primary: !currentAnswer && !confirmed,
          disabled: question.pending || confirmed, label: currentAnswer ? "保存修改" : "保存这段原话" })}
        ${actionButton(catalog, "MEMORY.REQUEST_FOLLOWUP", { primary: canContinue,
          disabled: !canContinue, label: question.limitReached ? `已经聊完 ${question.followupLimit} 轮` : `继续聊 · ${question.followupCount + 1}/${question.followupLimit}` })}
        ${actionButton(catalog, "MEMORY.CONFIRM", { disabled: !canConfirm, label: "聊够了，确认这段" })}
        ${actionButton(catalog, "MEMORY.WITHDRAW", { danger: true, disabled: memory.status === "withdrawn" })}
      </div>
      ${confirmed && eligibleBooks.length ? `<div class="confirmed-next"><p class="ai-label">下一步</p><p>选择一本纪念册，单独决定是否把这段原话收入其中。</p>${eligibleBooks.map((book) => `<a class="button secondary" href="/labs/books/${encodeURIComponent(book.bookId)}/contributions/${encodeURIComponent(memory.personalMemoryId)}" data-nav>加入 ${escapeBookLabHtml(book.bookId)}</a>`).join("")}</div>` : ""}
    </section></div>`;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function parseJsonHeader(view, name, fallback) {
  try {
    const value = view.response.unseenHeaders?.[name];
    return value === undefined ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseAuthorizationEtags(view) {
  const parsed = parseJsonHeader(view, "x-unseen-book-authorization-etags", null);
  if (!plainObject(parsed) || Object.values(parsed).some((etag) => typeof etag !== "string" || !etag)) return {};
  return parsed;
}

function parseEligibleBooks(view) {
  const parsed = parseJsonHeader(view, "x-unseen-book-eligible-books", null);
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  for (const option of parsed) {
    if (!exactKeys(option, ["bookId", "audienceScope", "noticeVersion", "noticeHash", "eligible"]) ||
        [option.bookId, option.audienceScope, option.noticeVersion, option.noticeHash]
          .some((value) => typeof value !== "string" || !value) ||
        option.eligible !== true || seen.has(option.bookId)) return [];
    seen.add(option.bookId);
  }
  return parsed;
}

function parseWithdrawalEtags(view) {
  const parsed = parseJsonHeader(view, "x-unseen-book-withdrawal-etags", null);
  if (!plainObject(parsed)) return {};
  for (const [bookId, value] of Object.entries(parsed)) {
    if (!bookId || !exactKeys(value, ["grantId", "etag"]) ||
        typeof value.grantId !== "string" || !value.grantId || typeof value.etag !== "string" || !value.etag) return {};
  }
  return parsed;
}

function routeBookId(view) {
  return typeof view.route?.parameters?.bookId === "string" && view.route.parameters.bookId
    ? view.route.parameters.bookId : null;
}

function contributionMemoryId(view) {
  const routeMemoryId = view.route?.parameters?.memoryId;
  const bodyMemoryId = view.response.body?.memory?.personalMemoryId;
  return typeof routeMemoryId === "string" && routeMemoryId && routeMemoryId === bodyMemoryId
    ? routeMemoryId : null;
}

function withdrawalPrecondition(view) {
  const bookId = routeBookId(view);
  const projected = bookId ? parseWithdrawalEtags(view)[bookId] : null;
  const memoryId = contributionMemoryId(view);
  const receipt = view.response.body?.grantReceipts?.find((grant) =>
    grant?.grantId === projected?.grantId && grant.bookId === bookId && grant.personalMemoryId === memoryId && grant.status === "active");
  return memoryId && receipt ? projected : null;
}

function parseOwnerPreconditions(view) {
  try {
    const parsed = JSON.parse(view.response.unseenHeaders?.["x-unseen-book-owner-preconditions"] ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function completePrecondition(value, fields) {
  return value && typeof value === "object" && fields.every((field) =>
    typeof value[field] === "string" && value[field].length > 0);
}

const START_NEW_VERSION_ACCESS_CONTROL_STATUSES = new Set(["active", "affected", "revoked"]);

function validStartNewVersionPrecondition(view, ownerPreconditions) {
  const value = ownerPreconditions.startNewVersion;
  return view.response.body?.bookId === routeBookId(view) &&
    completePrecondition(value, ["fromVersionId", "accessControlStatus"]) &&
    Number.isSafeInteger(value.accessControlVersion) && value.accessControlVersion >= 1 &&
    START_NEW_VERSION_ACCESS_CONTROL_STATUSES.has(value.accessControlStatus);
}

function renderBL03(view, catalog) {
  const body = view.response.body ?? {};
  const memory = body.memory ?? {};
  const submission = latestSubmission(body);
  const bookId = routeBookId(view);
  const memoryId = contributionMemoryId(view);
  const option = parseEligibleBooks(view).find((candidate) => candidate.bookId === bookId);
  const authorizeUnavailable = !memoryId || !option || !parseAuthorizationEtags(view)[bookId];
  const withdrawUnavailable = !withdrawalPrecondition(view);
  return `<div class="page-shell integrated-book-shell">
    ${pageHeader("单独授权", "只同意收入眼前这一本书", "照片可见或回答已确认，都不会自动授权原话入书。")}
    <section class="consent-card"><div class="quote-proof"><p>已确认原文</p><blockquote dir="auto">${escapeBookLabHtml(submission?.userText ?? "")}</blockquote></div>
      <label class="inline-field">目标书<select data-book-field="bookId"${!option ? " disabled" : ""}>${option ? `<option value="${escapeBookLabHtml(option.bookId)}">${escapeBookLabHtml(option.bookId)}</option>` : ""}</select></label>
      <label class="inline-field">署名<input data-book-field="creditLabel" maxlength="120" autocomplete="name"></label>
      <label class="explicit-consent"><input type="checkbox" data-book-field="consent"><span>我确认只将当前回答版本和署名授权给所选书，读者限当前仍可查看此空间的人。</span></label>
      ${authorizeUnavailable ? '<p class="integrated-warning" role="status">服务端尚未返回当前目标书的完整告知与授权前提；当前已安全停用授权动作。</p>' : ""}
      ${withdrawUnavailable ? '<p class="integrated-warning" role="status">服务端尚未返回当前授权的撤销前提；当前已安全停用撤销动作。</p>' : ""}
      <div class="action-row">${actionButton(catalog, "BOOK_MEMORY.AUTHORIZE", { primary: true, disabled: authorizeUnavailable })}${actionButton(catalog, "BOOK_MEMORY.WITHDRAW", { danger: true, disabled: withdrawUnavailable })}</div>
      <p class="version-line">已确认回答 · 当前内容版本已固定</p>
    </section></div>`;
}

function renderBL04(view, catalog) {
  const body = view.response.body ?? {};
  const books = body.books ?? [];
  return `<div class="page-shell integrated-book-shell">
    ${pageHeader("空间管理 · 纪念册", "记忆成书", "这里只汇总已经逐条授权给某一本书的记忆。")}
    <div class="lab-overview"><section class="book-card"><h2>现有书稿</h2>${books.length ? books.map((book) => `<label class="integrated-book-choice"><input type="radio" name="bookId" data-book-field="bookId" value="${escapeBookLabHtml(book.bookId)}"${book === books[0] ? " checked" : ""}><span><strong>${escapeBookLabHtml(book.title)}</strong><small>${escapeBookLabHtml(book.status)} · ${escapeBookLabHtml(book.pages?.length ?? 0)} 页</small></span></label>`).join("") : '<p class="microcopy">还没有书稿。填写右侧信息后，选择“创建一本纪念册”即可开始。</p>'}
      ${actions(catalog, "BL04", { primary: "BOOK.CREATE" })}</section>
      <aside class="material-summary"><label class="inline-field">新书 ID<input data-book-field="newBookId" maxlength="200"></label><label class="inline-field">书名<input data-book-field="title" maxlength="120"></label><p class="microcopy">事件：<strong>当前记忆空间</strong></p></aside>
    </div></div>`;
}

function renderBL05(view, catalog) {
  const body = view.response.body ?? {};
  const pages = body.pages ?? [];
  const ownerPreconditions = parseOwnerPreconditions(view);
  const freezeReady = completePrecondition(ownerPreconditions.freeze,
    ["draftVersionId", "previewHash", "grantSetHash", "authorizationSnapshotHash"]);
  const newVersionReady = validStartNewVersionPrecondition(view, ownerPreconditions);
  return `<div class="page-shell integrated-book-shell">
    ${pageHeader("书稿", body.title ?? "未命名书稿", "编辑只影响当前草稿；来源照片、原话和逐条授权保持独立。")}
    <div class="draft-layout"><section class="page-workbench"><div class="page-stage"><div class="draft-page closing-draft"><strong>${escapeBookLabHtml(body.title)}</strong><small>${escapeBookLabHtml(body.status)} · ${escapeBookLabHtml(pages.length)} 页</small></div></div>
      <div class="page-strip" aria-label="书页">${pages.map((page) => `<label class="page-thumb"><input type="radio" name="pageId" data-book-field="pageId" value="${escapeBookLabHtml(page.pageId)}"${page === pages[0] ? " checked" : ""}><span>${escapeBookLabHtml(page.index)}</span>${escapeBookLabHtml(page.kind)}</label>`).join("")}</div></section>
      <aside class="draft-controls"><label>书名<input data-book-field="title" maxlength="120" value="${escapeBookLabHtml(body.title)}"></label><label>替换为照片 ID<input data-book-field="displayPhotoId" maxlength="200"></label>
        ${!freezeReady && body.status === "preview_ready" ? '<p class="integrated-warning" role="status">服务端未返回当前书稿的完整冻结前提；已安全停用冻结动作。</p>' : ""}
        ${body.status === "frozen" && !newVersionReady ? '<p class="integrated-warning" role="status">服务端未返回当前冻结版本与访问控制前提；已安全停用新版本动作。</p>' : ""}
        ${actions(catalog, "BL05", { primary: body.status === "preview_ready" ? "BOOK.FREEZE" : "BOOK.GENERATE_PREVIEW",
          disabled: [...(!freezeReady ? ["BOOK.FREEZE"] : []), ...(!newVersionReady ? ["BOOK.START_NEW_VERSION"] : []),
            ...(body.status === "frozen" ? ["BOOK.GENERATE_PREVIEW"] : [])] })}
      </aside></div></div>`;
}

function renderBL06(view, catalog) {
  const body = view.response.body ?? {};
  const version = body.bookVersion ?? {};
  const artifact = body.htmlArtifact ?? {};
  return `<div class="page-shell integrated-book-shell">
    ${pageHeader("纪念册 · 可查看版本", `版本 ${version.ordinal ?? "—"}`, "本页显示已核对的版本信息与纪念册下载；印刷版内容由服务端安全提供。")}
    <section class="reader-meta"><dl><div><dt>状态</dt><dd>${status(version.status)}</dd></div><div><dt>页数</dt><dd>${escapeBookLabHtml(version.pageCount)}</dd></div><div><dt>版本指纹</dt><dd><code>${escapeBookLabHtml(version.manifestHash)}</code></dd></div><div><dt>印刷版指纹</dt><dd><code>${escapeBookLabHtml(artifact.contentHash)}</code></dd></div></dl>
      ${actions(catalog, "BL06", { primary: "BOOK.DOWNLOAD_PDF" })}
    </section></div>`;
}

const RENDERERS = Object.freeze({ BL01: renderBL01, BL02: renderBL02, BL03: renderBL03, BL04: renderBL04,
  BL05: renderBL05, BL06: renderBL06 });

export function renderIntegratedBookLabPage(view, catalog) {
  const render = RENDERERS[view?.entry];
  if (!render) fail("integrated_route_unavailable");
  if (!view.response?.ok) {
    const code = view.response?.body?.error?.code ?? "book_lab_unavailable";
    const sessionLoss = [401, 403].includes(view.response?.status);
    return `<div class="page-shell integrated-book-shell"><section class="task-card" role="alert"><h1>${sessionLoss ? "会话或权限已变化" : "暂时无法打开"}</h1><p>${sessionLoss ? "请返回空间确认访问权限后再打开；已经撤回的内容不会继续显示。" : "请检查网络后重新尝试；如果仍然失败，可以先返回空间照片。"}</p><details class="microcopy"><summary>查看问题编号</summary><code>${escapeBookLabHtml(code)}</code></details><div class="action-row"><button type="button" class="button primary" data-book-retry>重新尝试</button><a class="button secondary" href="/">返回首页</a></div></section></div>`;
  }
  return render(view, catalog);
}

function requestBase(actionId, view, values, randomId) {
  const route = view.route;
  const body = view.response.body ?? {};
  const memory = body.memory ?? {};
  const parameters = { ...route.parameters };
  if (memory.personalMemoryId) parameters.personalMemoryId = memory.personalMemoryId;
  if (values.bookId) parameters.bookId = values.bookId;
  if (values.pageId) parameters.pageId = values.pageId;
  if (values.versionId) parameters.versionId = values.versionId;
  return { body, memory, parameters, response: view.response, randomId };
}

function creationSpaceId(view) {
  if (view.entry !== "BL04" || view.route?.entry !== "BL04" || view.response?.ok !== true ||
      !exactKeys(view.route.parameters, ["spaceId"])) return null;
  const spaceId = view.route.parameters.spaceId;
  if (typeof spaceId !== "string" || !spaceId) return null;
  const body = view.response.body;
  if (plainObject(body) && Object.hasOwn(body, "spaceId") && body.spaceId !== spaceId) return null;
  if (Array.isArray(body?.books) && body.books.some((book) => plainObject(book) &&
      Object.hasOwn(book, "spaceId") && book.spaceId !== spaceId)) return null;
  return spaceId;
}

export function buildIntegratedActionRequest(actionId, view, values = {}, randomId = () => crypto.randomUUID()) {
  const request = ACTION_REQUESTS[actionId];
  if (!request) fail("integrated_action_unavailable");
  const { body, memory, parameters, response } = requestBase(actionId, view, values, randomId);
  if (!request.mutation) return { parameters };
  const result = { parameters, idempotencyKey: randomId() };
  const submission = latestSubmission(body);
  const provenance = memory.provenance ?? body.provenance ?? {};
  const etags = parseAuthorizationEtags(view);
  const bookId = routeBookId(view);
  const contributionId = contributionMemoryId(view);
  const option = parseEligibleBooks(view).find((book) => book.bookId === bookId);
  const ownerPreconditions = parseOwnerPreconditions(view);
  switch (actionId) {
    case "MEMORY.START_QUESTION":
      return { ...result, dto: { noticeVersion: required(body.collectionNotice?.version), noticeHash: required(body.collectionNotice?.hash), photoContentHash: required(provenance.photoContentHash), placementSnapshotHash: required(provenance.placementSnapshotHash) }, etag: body.interviewPrecondition?.ifMatch ?? undefined, ifNoneMatch: body.interviewPrecondition?.ifNoneMatch ?? undefined };
    case "MEMORY.SKIP":
      return { ...result, dto: values.reason ? { reason: values.reason } : {}, etag: body.interviewPrecondition?.ifMatch ?? undefined, ifNoneMatch: body.interviewPrecondition?.ifNoneMatch ?? undefined };
    case "MEMORY.SAVE_ANSWER_DRAFT":
      return { ...result, dto: { clientSubmissionId: randomId(), userText: required(values.userText), previousSubmissionId: memory.headSubmissionId ?? null, interviewIfMatchVersion: required(memory.interviewVersion) }, etag: required(response.etag) };
    case "MEMORY.REQUEST_FOLLOWUP":
      return { ...result, dto: { submissionId: required(submission?.submissionId), submissionHash: required(submission?.submissionHash), photoContentHash: required(provenance.photoContentHash), interviewIfMatchVersion: required(memory.interviewVersion) }, etag: required(response.unseenHeaders?.["x-unseen-followup-etag"]) };
    case "MEMORY.CONFIRM":
      return { ...result, dto: { submissionId: required(submission?.submissionId), submissionHash: required(submission?.submissionHash), interviewIfMatchVersion: required(memory.interviewVersion) }, etag: required(response.etag) };
    case "MEMORY.WITHDRAW":
      return { ...result, dto: { interviewIfMatchVersion: required(memory.interviewVersion), ...(values.reason ? { reason: values.reason } : {}) }, etag: required(response.etag) };
    case "BOOK_MEMORY.AUTHORIZE":
      if (values.consent !== true) fail("integrated_explicit_consent_required");
      parameters.bookId = required(bookId);
      parameters.personalMemoryId = required(contributionId);
      return { ...result, parameters, dto: { personalMemoryId: contributionId, memoryRevisionId: required(memory.memoryRevisionId), confirmedSubmissionHash: required(memory.confirmedSubmissionHash), creditLabel: required(values.creditLabel), audienceScope: required(option?.audienceScope), noticeVersion: required(option?.noticeVersion), noticeHash: required(option?.noticeHash) }, etag: required(etags[bookId]), ifNoneMatch: "*" };
    case "BOOK_MEMORY.WITHDRAW":
      parameters.bookId = required(bookId);
      parameters.personalMemoryId = required(contributionId);
      return { ...result, parameters, dto: values.reason ? { reason: values.reason } : {}, etag: required(withdrawalPrecondition(view)?.etag) };
    case "BOOK.CREATE":
      return { ...result, parameters: { spaceId: required(creationSpaceId(view)), bookId: required(values.newBookId) },
        dto: { bookId: values.newBookId, title: required(values.title), eventId: view.route.parameters.spaceId },
        ifNoneMatch: "*" };
    case "BOOK.GENERATE_PREVIEW":
      return { ...result, dto: { renderJobId: randomId(), draftVersionId: required(body.draftVersionId), grantSetHash: required(body.grantSetHash), layoutProfile: "book-lab-v1" }, etag: required(response.etag), ifNoneMatch: "*" };
    case "BOOK.EDIT_TITLE":
      return { ...result, dto: { title: required(values.title) }, etag: required(response.etag) };
    case "BOOK.REMOVE_PAGE":
      return { ...result, dto: { pageVersion: required(body.draftVersionId) }, etag: required(response.etag) };
    case "BOOK.REPLACE_PAGE_PHOTO":
      return { ...result, dto: { displayPhotoId: required(values.displayPhotoId), pageVersion: required(body.draftVersionId) }, etag: required(response.etag) };
    case "BOOK.FREEZE":
      return { ...result, dto: { draftVersionId: required(ownerPreconditions.freeze?.draftVersionId),
        previewHash: required(ownerPreconditions.freeze?.previewHash),
        grantSetHash: required(ownerPreconditions.freeze?.grantSetHash),
        authorizationSnapshotHash: required(ownerPreconditions.freeze?.authorizationSnapshotHash) },
      etag: required(response.etag) };
    case "BOOK.START_NEW_VERSION":
      if (!validStartNewVersionPrecondition(view, ownerPreconditions)) fail("integrated_input_unavailable");
      return { ...result, dto: { draftVersionId: randomId(),
        fromVersionId: required(ownerPreconditions.startNewVersion?.fromVersionId), excludeWithdrawn: true },
      etag: required(response.etag), ifNoneMatch: "*" };
    default:
      fail("integrated_action_unavailable");
  }
}

function fieldValues(root) {
  const values = {};
  for (const field of root.querySelectorAll("[data-book-field]")) {
    if ((field.type === "radio" || field.type === "checkbox") && !field.checked) continue;
    values[field.dataset.bookField] = field.type === "checkbox" ? true : field.value;
  }
  return values;
}

function navigationAfter(actionId, view, response, values) {
  if (!response?.ok) return null;
  const spaceId = view.route?.parameters?.spaceId;
  if (actionId === "MEMORY.START_QUESTION" && response.body?.personalMemoryId) {
    return `/labs/memories/${encodeURIComponent(response.body.personalMemoryId)}`;
  }
  if (actionId === "BOOK.CREATE" && spaceId && response.body?.bookId) {
    return `/manage/${encodeURIComponent(spaceId)}/book-lab/${encodeURIComponent(response.body.bookId)}/draft`;
  }
  if (actionId === "BOOK.OPEN_DRAFT" && spaceId && values.bookId) {
    return `/manage/${encodeURIComponent(spaceId)}/book-lab/${encodeURIComponent(values.bookId)}/draft`;
  }
  if (actionId === "BOOK.FREEZE" && spaceId && view.route?.parameters?.bookId && response.body?.versionId) {
    return `/s/${encodeURIComponent(spaceId)}/books/${encodeURIComponent(view.route.parameters.bookId)}/versions/${encodeURIComponent(response.body.versionId)}`;
  }
  return null;
}

export class BookLabIntegratedVisualShell {
  constructor({ controller, catalog, randomId = () => crypto.randomUUID(), onPdf = null,
    navigate = null, setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
    if (!controller || typeof controller.readRoute !== "function" || typeof setTimeoutImpl !== "function" ||
      typeof clearTimeoutImpl !== "function") fail("integrated_controller_unavailable");
    this.controller = controller;
    this.catalog = catalog;
    this.randomId = randomId;
    this.onPdf = onPdf;
    this.navigate = navigate;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.root = null;
    this.view = null;
    this.pollTimer = null;
    this.readGeneration = 0;
    this.destroyed = false;
    this.boundClick = (event) => { void this.handleClick(event); };
  }

  async mount(root, pathname = globalThis.location?.pathname) {
    if (!root || typeof root.addEventListener !== "function") fail("integrated_mount_unavailable");
    this.root?.removeEventListener("click", this.boundClick);
    this.root = root;
    this.destroyed = false;
    this.root.addEventListener("click", this.boundClick);
    return this.read(pathname);
  }

  async read(pathname) {
    this.clearPoll();
    const generation = ++this.readGeneration;
    const view = await this.controller.readRoute(pathname);
    if (generation !== this.readGeneration) return view;
    this.view = view;
    this.paint();
    return this.view;
  }

  async reread() {
    this.clearPoll();
    const generation = this.readGeneration;
    const view = await this.controller.rereadRoute();
    if (generation !== this.readGeneration) return view;
    this.view = view;
    this.paint();
    return this.view;
  }

  paint() {
    if (!this.root) return;
    this.root.innerHTML = renderIntegratedBookLabPage(this.view, this.catalog);
    this.schedulePoll();
  }

  clearPoll() {
    if (this.pollTimer !== null) this.clearTimeoutImpl(this.pollTimer);
    this.pollTimer = null;
  }

  schedulePoll() {
    const delay = this.view?.entry === "BL01" ? bl01QuestionState(this.view).pollAfterMs
      : this.view?.entry === "BL02" ? bl02QuestionState(this.view).pollAfterMs : null;
    if (delay === null) return;
    const generation = this.readGeneration;
    this.pollTimer = this.setTimeoutImpl(() => {
      this.pollTimer = null;
      if (!this.root || generation !== this.readGeneration) return Promise.resolve();
      return this.reread().catch(() => {
        if (this.root && generation === this.readGeneration) this.schedulePoll();
      });
    }, delay);
  }

  async dispatch(actionId, request = {}, { refresh = false } = {}) {
    if (this.destroyed) fail("integrated_action_unavailable");
    const generation = this.readGeneration;
    const contract = ACTION_REQUESTS[actionId];
    if (!contract) fail("integrated_action_unavailable");
    const response = contract.mutation
      ? await this.controller.mutate(actionId, request)
      : await this.controller.readAction(actionId, request);
    if (this.destroyed || generation !== this.readGeneration) return response;
    if (actionId === "BOOK.DOWNLOAD_PDF" && response.ok && this.onPdf) await this.onPdf(response);
    if (refresh && actionId !== "BOOK.DOWNLOAD_PDF") await this.reread();
    return response;
  }

  async handleClick(event) {
    const retry = event.target.closest?.("[data-book-retry]");
    if (retry) { await this.reread(); return; }
    const trigger = event.target.closest?.("[data-book-action]");
    if (!trigger || !this.root?.contains(trigger)) return;
    const generation = this.readGeneration;
    const root = this.root;
    const actionId = trigger.dataset.bookAction;
    trigger.disabled = true;
    this.root.setAttribute("aria-busy", "true");
    try {
      const values = fieldValues(this.root);
      const request = buildIntegratedActionRequest(actionId, this.view, values, this.randomId);
      const response = await this.dispatch(actionId, request);
      if (this.destroyed || generation !== this.readGeneration || root !== this.root) return;
      const destination = navigationAfter(actionId, this.view, response, values);
      if (destination && typeof this.navigate === "function") await this.navigate(destination);
      else if (response.ok && actionId !== "BOOK.DOWNLOAD_PDF") await this.reread();
      if (!response.ok) {
        this.view = { ...this.view, response };
        this.paint();
      }
    } catch (error) {
      if (this.destroyed || generation !== this.readGeneration || root !== this.root) return;
      const code = error?.code ?? "book_lab_unavailable";
      this.view = { ...this.view, response: { ok: false, status: 409, body: { error: { code } } } };
      this.paint();
    } finally {
      if (!this.destroyed && generation === this.readGeneration && root === this.root) {
        root.removeAttribute("aria-busy");
        if (root.contains(trigger)) trigger.disabled = false;
      }
    }
  }

  destroy() {
    this.destroyed = true;
    this.clearPoll();
    this.readGeneration += 1;
    this.root?.removeEventListener("click", this.boundClick);
    this.root = null;
  }
}

export async function downloadIntegratedBookLabPdf(response, {
  documentImpl = globalThis.document,
  urlImpl = globalThis.URL
} = {}) {
  if (!(response?.body instanceof Uint8Array) || !response.contentDisposition ||
      typeof documentImpl?.createElement !== "function" || typeof urlImpl?.createObjectURL !== "function") {
    fail("integrated_pdf_presenter_unavailable");
  }
  const filename = response.contentDisposition.match(/filename=(?:"([^"]+)"|([^;]+))$/iu)?.slice(1).find(Boolean);
  if (!filename) fail("integrated_pdf_presenter_unavailable");
  const url = urlImpl.createObjectURL(new Blob([response.body], { type: "application/pdf" }));
  try {
    const anchor = documentImpl.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    documentImpl.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    urlImpl.revokeObjectURL(url);
  }
}

export function createIntegratedBookLabVisualShell({ origin, fetchImpl, catalog, controller, randomId, onPdf,
  navigate } = {}) {
  const resolved = controller ?? new BookLabIntegratedController({
    transport: new BookLabIntegratedTransport({ origin, fetchImpl })
  });
  return new BookLabIntegratedVisualShell({ controller: resolved, catalog, randomId, navigate,
    onPdf: onPdf ?? downloadIntegratedBookLabPdf });
}
