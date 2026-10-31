const esc = (value) => String(value ?? "").replace(/[&<>"']/gu, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const statusNames = Object.freeze({
  submitting: "提交结果待确认", processing: "正在生成", unknown: "结果未知 · 需要核对",
  complete: "已完成", failed: "生成失败", rejected: "未受理"
});

function pendingRequestId(pending) {
  const value = typeof pending === "string" ? pending : pending?.clientRequestId ?? pending?.requestId ?? pending?.id;
  return typeof value === "string" ? value.trim() : "";
}

// The marker records an attempt, not proof that a paid request was rejected. A missing list entry,
// failed refresh or changed local hint must never authorize a second generation. Only a matching
// server job with a settled result or an actual accepted-operation receipt resolves the uncertainty.
export function worldPendingDecision(pending, jobs = []) {
  const requestId = pendingRequestId(pending);
  const present = pending !== null && pending !== undefined && pending !== "" && pending !== false;
  if (!present) return Object.freeze({ requestId: "", blocked: false, canClear: false, status: "none", operationId: null, reason: "no_pending_request" });
  const job = Array.isArray(jobs) ? jobs.find((item) => requestId && item?.id === requestId) : null;
  const operationId = typeof job?.operation?.id === "string" && job.operation.id.trim() ? job.operation.id : null;
  const hint = typeof pending === "object" && ["submitting", "unknown"].includes(pending?.status) ? pending.status : "submitting";
  const status = job?.status || hint;
  const settled = job && ["rejected", "failed", "complete"].includes(job.status);
  const receipted = job?.status === "processing" && Boolean(operationId);
  const canClear = Boolean(settled || receipted);
  return Object.freeze({
    requestId, blocked: !canClear, canClear, status, operationId,
    reason: canClear ? (settled ? "server_result_settled" : "accepted_operation_receipt")
      : !job ? "server_record_not_found" : operationId ? "receipt_needs_reconciliation" : "no_operation_receipt"
  });
}

export function isWorldPendingUnresolved(pending, jobs) { return worldPendingDecision(pending, jobs).blocked; }
export function canClearWorldPending(pending, jobs) { return worldPendingDecision(pending, jobs).canClear; }

// These are this server's pre-admission validation codes, not a generic HTTP-status heuristic.
// The caller must supply the ID captured by the request that produced this response: a late error
// from an older request must not remove a newer pending marker.
export function canClearWorldPendingAfterError(pending, error, submittedRequestId) {
  const requestId = pendingRequestId(pending);
  if (!requestId || requestId !== submittedRequestId) return false;
  const code = typeof error?.data?.error === "string" ? error.data.error : error?.data?.error?.code;
  const statuses = {
    worldlabs_not_configured: [503], world_session_required: [428], origin_not_allowed: [403], json_required: [415],
    bad_request: [400, 413], public_consent_required: [400], input_mode_invalid: [400],
    image_count_invalid: [400], image_unresolved: [400], image_size_invalid: [413],
    image_total_size_invalid: [413], request_id_invalid: [400]
  };
  return Object.hasOwn(statuses, code) && statuses[code].includes(error?.status);
}

function pendingNotice(decision) {
  if (!decision.blocked) return "";
  const detail = decision.reason === "server_record_not_found"
    ? "本机保留了提交记录，但尚未读到匹配的服务端结果。列表中暂时没有这条任务，不代表服务商没有受理。"
    : decision.operationId
      ? "已有供应商回执，但生成结果仍待核对。请在空间任务中查看原请求。"
      : "尚无可查询的供应商回执，无法确认这次生成是否已被受理。";
  return `<aside class="app-tools" data-world-pending role="status"><h2>先核对上一次提交</h2><p>${detail}</p>${decision.requestId ? `<p>原请求编号：<code>${esc(decision.requestId)}</code></p>` : "<p>本机提交记录缺少编号，请保留当前记录等待核对。</p>"}<p>现在不会再次提交或重新消耗生成额度。</p><button data-screen="jobs">查看空间任务并核对</button></aside>`;
}

export function worldScreen(state = {}) {
  const photos = Array.isArray(state.photos) ? state.photos : [];
  const count = state.worldMode === "multi" ? photos.length : 1;
  const selected = state.worldMode === "multi" ? photos : [state.photo];
  const decision = worldPendingDecision(state.worldPending, state.worldJobs);
  const disabled = state.worldBusy || decision.blocked || !state.photo || (state.worldMode === "multi" && (count < 2 || count > 8));
  return `<section class="screen"><div class="screen-content"><button class="round-button" data-action="back" aria-label="返回">‹</button><h1>让照片之外，也能看见</h1><p>${state.worldMode === "multi" ? "2–8 张同场景照片共同提供线索" : "从当前主照片向画面外延展"}。生成包含 AI 补全，不是精确现场记录。</p>${pendingNotice(decision)}<div class="app-photo-strip">${selected.filter(Boolean).map((photo) => `<img style="height:100px;max-width:180px;object-fit:contain" src="${esc(photo.src)}" alt="待提交的照片">`).join("")}</div><label>世界名称<input id="app-world-name" maxlength="80" value="${esc(state.title || "留住的这一刻")}"></label><label>补充描述<textarea id="app-world-prompt" maxlength="2000" placeholder="可留空"></textarea></label><p>照片将交给 World Labs 处理，生成结果有公开链接；输入可能依其条款用于改进模型。提交消耗公共体验额度。</p><label><input type="checkbox" id="app-world-consent">我有这些照片的使用权，并同意第三方处理和公开生成结果</label><button class="primary-button" data-app-world="generate" ${disabled ? "disabled" : ""}>${state.worldBusy ? "正在提交…" : decision.blocked ? "先核对已有任务" : `确认提交 ${count} 张照片`}</button><p id="app-world-status" role="status">${esc(state.worldStatus || (decision.blocked ? "上一次提交结果尚未核定" : "尚未提交"))}</p><button data-screen="jobs">查看已有空间任务</button></div></section>`;
}

function jobActions(job) {
  if (job.status === "complete" && job.operation?.world?.id) return `<button data-app-world-open="${esc(job.id)}">重开完成品</button>`;
  if (job.operation?.id && !job.operation.done && !["failed", "rejected"].includes(job.status)) return `<button data-app-world-poll="${esc(job.id)}">核对生成进度</button>`;
  if (job.status === "rejected") return "<p>已确认这次请求未被受理。原任务记录会保留。</p>";
  if (job.status === "failed") return "<p>供应商已返回生成失败。原任务记录会保留，不会自动重新提交。</p>";
  if (job.status === "complete") return "<p>任务标记为完成，但尚未取得可重开的完整结果。请保留编号核对。</p>";
  return "<p>尚无可查询的供应商回执。当前无法确认是否已受理或扣费，请保留此编号等待核对；这里不会重新提交。</p>";
}

function jobErrorText(job) {
  const code = job.error || job.operation?.error?.code;
  if (!code) return "";
  const messages = {
    "WL-204": "生成暂时不可用（错误码：WL-204）。请稍后再试。", provider_auth_failed: "生成服务暂时无法验证请求。",
    provider_rate_limited: "生成服务暂时繁忙。", daily_limit: "今天的公共体验额度已用完。",
    visitor_daily_limit: "这个访客今天的体验额度已用完。", provider_invalid_response: "服务商返回的结果暂时无法读取。",
    provider_timeout: "等待服务商响应超时。", provider_unavailable: "暂时无法取得服务商响应。"
  };
  return `<p>${messages[code] || "这次生成未返回完整结果，请结合任务状态核对。"}</p>`;
}

export function jobsScreen(state = {}) {
  const jobs = Array.isArray(state.worldJobs) ? state.worldJobs.filter((job) => job && typeof job === "object") : [];
  const decision = worldPendingDecision(state.worldPending, jobs);
  return `<section class="screen"><div class="screen-content"><button class="round-button" data-action="back" aria-label="返回">‹</button><h1>空间任务</h1><p>显示这个浏览器发起的任务。结果未知时先核对原请求，不会自动重提。</p>${pendingNotice(decision)}<button data-app-world="refresh">刷新任务</button><p role="status">${esc(state.jobsStatus || "")}</p>${jobs.map((job) => {
    const date = new Date(job.createdAt);
    return `<article class="app-tools"><h2>${esc(statusNames[job.status] || "任务状态待核对")}</h2><p>${esc(Number.isNaN(date.getTime()) ? "提交时间待核对" : date.toLocaleString("zh-CN"))}</p><small>${esc(job.id)}</small>${jobErrorText(job)}${jobActions(job)}</article>`;
  }).join("") || `<p>${decision.blocked ? "服务端列表暂未显示这次提交，请保留本机记录继续核对。" : "还没有已记录的空间任务。"}</p>`}</div></section>`;
}

export async function fetchWorldJson(path, options) {
  const response = await fetch(path, { ...options, credentials: "same-origin", cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "world_unavailable"), { data, status: response.status });
  return data;
}
