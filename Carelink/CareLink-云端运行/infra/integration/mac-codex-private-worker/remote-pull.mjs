import { PrivateWorkerTransportError, withPrivateDownloadedImage } from "./https-transport.mjs";

export const PRIVATE_AI_BASE = "/__internal/private-ai/v1";
export const PRIVATE_AI_PROTOCOL = "unseen-private-ai-pull/1";
const PROTOCOL_HEADERS = Object.freeze({ "x-unseen-protocol": PRIVATE_AI_PROTOCOL });
const HASH = /^[a-f0-9]{64}$/u;
const JOB_ID = /^paij_[a-f0-9]{32}$/u;
const LEASE_ID = /^pail_[a-f0-9]{32}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const SAFE_CONTEXT_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+$/u;
const FAILURE_CODES = new Set(["model_unavailable", "model_quota_exhausted", "model_timeout", "worker_aborted",
  "worker_internal_failure", "image_invalid", "image_unsupported", "result_policy_rejected"]);

export class PrivateAiProtocolError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "PrivateAiProtocolError";
    this.code = code;
    this.retryable = retryable;
  }
}

function keys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function exactIso(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function protocolResponse(response) {
  if (response.headers["x-unseen-protocol"] !== PRIVATE_AI_PROTOCOL) {
    throw new PrivateAiProtocolError("protocol_header_rejected");
  }
  const cacheControl = String(response.headers["cache-control"] ?? "").toLowerCase();
  if (!cacheControl.includes("no-store") || !cacheControl.includes("private")) {
    throw new PrivateAiProtocolError("protocol_cache_policy_rejected");
  }
  return response;
}

function checkedQuestionContext(context) {
  if (keys(context, ["kind"]) && context.kind === "initial_question") {
    return Object.freeze({ kind: context.kind });
  }
  const expected = ["kind", "followupOrdinal", "followupLimit", "priorVisibleFacts", "priorQuestion",
    "userAnswerText"];
  if (!keys(context, expected) || context.kind !== "followup_question" ||
    !integer(context.followupOrdinal, 1, 3) || !integer(context.followupLimit, context.followupOrdinal, 3) ||
    !Array.isArray(context.priorVisibleFacts) || !integer(context.priorVisibleFacts.length, 1, 2) ||
    new Set(context.priorVisibleFacts).size !== context.priorVisibleFacts.length ||
    !context.priorVisibleFacts.every((fact) => typeof fact === "string" && integer(fact.length, 2, 160) &&
      SAFE_TEXT.test(fact)) || typeof context.priorQuestion !== "string" ||
    !integer(context.priorQuestion.length, 2, 300) || !SAFE_TEXT.test(context.priorQuestion) ||
    typeof context.userAnswerText !== "string" || !integer(context.userAnswerText.length, 1, 500) ||
    !SAFE_CONTEXT_TEXT.test(context.userAnswerText)) {
    throw new PrivateAiProtocolError("lease_job_rejected");
  }
  return Object.freeze({ ...context, priorVisibleFacts: Object.freeze([...context.priorVisibleFacts]) });
}

function checkedJob(job, { promptHash, policyHash }) {
  const base = ["schema", "jobId", "leaseId", "taskType", "attempt", "maxAttempts", "leaseExpiresAt",
    "inputHash", "mediaSha256", "mediaBytes", "mediaMime", "promptHash", "policyHash", "imagePath"];
  const legacy = job?.schema === "unseen-private-ai-job/1" && keys(job, base);
  const contextual = job?.schema === "unseen-private-ai-job/2" && keys(job, [...base, "questionContext"]);
  if (!legacy && !contextual || !JOB_ID.test(job.jobId) ||
    !LEASE_ID.test(job.leaseId) || job.taskType !== "photo_visible_facts_question_v1" ||
    !integer(job.attempt, 1, 10) || !integer(job.maxAttempts, job.attempt, 10) ||
    !exactIso(job.leaseExpiresAt) || !HASH.test(job.inputHash) || !HASH.test(job.mediaSha256) ||
    !integer(job.mediaBytes, 1, 20 * 1024 * 1024) ||
    !["image/jpeg", "image/png", "image/webp"].includes(job.mediaMime) ||
    job.promptHash !== promptHash || job.policyHash !== policyHash ||
    job.imagePath !== `${PRIVATE_AI_BASE}/jobs/${encodeURIComponent(job.jobId)}/image`) {
    throw new PrivateAiProtocolError("lease_job_rejected");
  }
  return Object.freeze({ ...job, ...(contextual ? { questionContext: checkedQuestionContext(job.questionContext) } : {}) });
}

export function checkedAnalysisResult(result, { model, modelVersion }) {
  const expected = ["modelVisibleFacts", "question", "questionIntent", "model", "modelVersion", "latencyMs"];
  if (!keys(result, expected) || !Array.isArray(result.modelVisibleFacts) ||
    result.modelVisibleFacts.length < 1 || result.modelVisibleFacts.length > 2 ||
    !result.modelVisibleFacts.every((fact) => typeof fact === "string" && fact.length >= 2 && fact.length <= 160 &&
      SAFE_TEXT.test(fact)) || new Set(result.modelVisibleFacts).size !== result.modelVisibleFacts.length ||
    typeof result.question !== "string" || result.question.length < 2 || result.question.length > 300 ||
    !SAFE_TEXT.test(result.question) || !/[?？]$/u.test(result.question) ||
    (result.question.match(/[?？]/gu) ?? []).length !== 1 || result.questionIntent !== "photo_context" ||
    result.model !== model || result.modelVersion !== modelVersion ||
    !integer(result.latencyMs, 0, 300_000)) throw new PrivateAiProtocolError("result_policy_rejected");
  return Object.freeze({ ...result, modelVisibleFacts: Object.freeze([...result.modelVisibleFacts]) });
}

function checkedTerminal(value) {
  const expected = ["schema", "status", "replayed", "retryAfterMs"];
  if (!keys(value, expected) || value.schema !== "unseen-private-ai-terminal-response/1" ||
    !["completed", "retry", "failed"].includes(value.status) || typeof value.replayed !== "boolean" ||
    value.status === "retry" && !integer(value.retryAfterMs, 1_000, 300_000) ||
    value.status !== "retry" && value.retryAfterMs !== null) {
    throw new PrivateAiProtocolError("terminal_response_rejected");
  }
  return Object.freeze({ ...value });
}

export class PrivateAiPullProtocol {
  constructor({ client, promptHash, policyHash, model, modelVersion, maximumPixels = 16_777_216 } = {}) {
    if (!client || typeof client.request !== "function" || typeof client.requestJson !== "function" ||
      !HASH.test(promptHash) || !HASH.test(policyHash) || typeof model !== "string" || model.length < 1 ||
      model.length > 80 || !SAFE_TEXT.test(model) || typeof modelVersion !== "string" || modelVersion.length < 1 ||
      modelVersion.length > 80 || !SAFE_TEXT.test(modelVersion) || !integer(maximumPixels, 1, 16_777_216)) {
      throw new PrivateAiProtocolError("protocol_configuration_invalid");
    }
    this.client = client;
    this.promptHash = promptHash;
    this.policyHash = policyHash;
    this.model = model;
    this.modelVersion = modelVersion;
    this.maximumPixels = maximumPixels;
  }

  async lease(signal) {
    const raw = await this.client.request(`${PRIVATE_AI_BASE}/jobs/lease`, { method: "POST",
      headers: PROTOCOL_HEADERS, body: { schema: "unseen-private-ai-lease-request/1" }, signal });
    protocolResponse(raw);
    const contentType = String(raw.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") throw new PrivateAiProtocolError("protocol_content_type_rejected");
    let value;
    try { value = JSON.parse(raw.bytes.toString("utf8")); }
    catch { throw new PrivateAiProtocolError("lease_response_rejected"); }
    if (!keys(value, ["schema", "job", "retryAfterMs"]) ||
      value.schema !== "unseen-private-ai-lease-response/1" || !integer(value.retryAfterMs, 1_000, 300_000) ||
      value.job !== null && (!value.job || typeof value.job !== "object" || Array.isArray(value.job))) {
      throw new PrivateAiProtocolError("lease_response_rejected");
    }
    return Object.freeze({ retryAfterMs: value.retryAfterMs,
      job: value.job === null ? null : checkedJob(value.job, this) });
  }

  async withImage(job, signal, operation) {
    if (!["image/jpeg", "image/png"].includes(job.mediaMime)) {
      throw new PrivateAiProtocolError("image_unsupported");
    }
    let response;
    try {
      response = await this.client.request(job.imagePath, { signal, maximumBytes: job.mediaBytes,
        accept: "image/jpeg, image/png", headers: { ...PROTOCOL_HEADERS, "x-unseen-ai-lease": job.leaseId } });
    } catch (error) {
      if (["transport_response_too_large", "transport_content_type_rejected"].includes(error?.code)) {
        throw new PrivateAiProtocolError("image_invalid");
      }
      throw error;
    }
    protocolResponse(response);
    const contentType = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    const length = Number(response.headers["content-length"] ?? 0);
    if (contentType !== job.mediaMime || length !== job.mediaBytes || response.bytes.length !== job.mediaBytes ||
      response.headers["x-unseen-content-sha256"] !== job.mediaSha256 ||
      response.headers.etag !== `"${job.mediaSha256}"`) throw new PrivateAiProtocolError("image_invalid");
    try {
      return await withPrivateDownloadedImage({ bytes: response.bytes, contentType, expectedSha256: job.mediaSha256,
        maximumBytes: job.mediaBytes, maximumPixels: this.maximumPixels }, operation);
    } catch (error) {
      if (error?.code === "transport_image_invalid") throw new PrivateAiProtocolError("image_invalid");
      throw error;
    }
  }

  async complete(job, result, signal) {
    const checked = checkedAnalysisResult(result, this);
    const response = await this.client.requestJson(`${PRIVATE_AI_BASE}/jobs/${encodeURIComponent(job.jobId)}/complete`,
      { method: "POST", headers: PROTOCOL_HEADERS, signal, body: {
        schema: "unseen-private-ai-complete-request/1", leaseId: job.leaseId, inputHash: job.inputHash,
        result: checked
      } });
    protocolResponse(response);
    if (response.status !== 200) throw new PrivateAiProtocolError("terminal_response_rejected");
    return checkedTerminal(response.value);
  }

  async fail(job, failureCode, signal) {
    if (!FAILURE_CODES.has(failureCode)) throw new PrivateAiProtocolError("failure_code_rejected");
    const response = await this.client.requestJson(`${PRIVATE_AI_BASE}/jobs/${encodeURIComponent(job.jobId)}/fail`,
      { method: "POST", headers: PROTOCOL_HEADERS, signal, body: {
        schema: "unseen-private-ai-fail-request/1", leaseId: job.leaseId, inputHash: job.inputHash, failureCode
      } });
    protocolResponse(response);
    if (response.status !== 200) throw new PrivateAiProtocolError("terminal_response_rejected");
    return checkedTerminal(response.value);
  }
}

function failureCode(error) {
  if (["image_unsupported", "image_invalid"].includes(error?.code)) return error.code;
  if (error?.code === "result_policy_rejected") return "result_policy_rejected";
  if (error?.code === "codex_timeout" || error?.code === "model_timeout") return "model_timeout";
  if (error?.code === "model_quota_exhausted") return "model_quota_exhausted";
  if (error?.code === "codex_unavailable" || error?.code === "codex_preflight_failed" ||
    error?.code === "model_unavailable") return "model_unavailable";
  if (error?.code === "codex_aborted" || error?.code === "transport_aborted" ||
    error?.code === "worker_aborted") return "worker_aborted";
  return "worker_internal_failure";
}

export class RemotePrivateAiPullWorker {
  #active = false;

  constructor({ protocol, preflight, analyze, minimumLeaseRemainingMs, cleanupBudgetMs = 5_000,
    clock = () => Date.now(), onDiagnostic = () => {} } = {}) {
    if (!(protocol instanceof PrivateAiPullProtocol) || typeof preflight !== "function" ||
      typeof analyze !== "function" || !integer(minimumLeaseRemainingMs, 10_000, 300_000) ||
      !integer(cleanupBudgetMs, 1_000, 30_000) || cleanupBudgetMs >= minimumLeaseRemainingMs ||
      typeof clock !== "function" || typeof onDiagnostic !== "function") {
      throw new PrivateAiProtocolError("worker_configuration_invalid");
    }
    this.protocol = protocol;
    this.preflight = preflight;
    this.analyze = analyze;
    this.minimumLeaseRemainingMs = minimumLeaseRemainingMs;
    this.cleanupBudgetMs = cleanupBudgetMs;
    this.clock = clock;
    this.onDiagnostic = onDiagnostic;
  }

  async runOnce(signal = new AbortController().signal) {
    if (this.#active) return Object.freeze({ status: "busy", retryAfterMs: 1_000 });
    this.#active = true;
    let job;
    try {
      await this.preflight(signal);
      const leased = await this.protocol.lease(signal);
      if (!leased.job) return Object.freeze({ status: "idle", retryAfterMs: leased.retryAfterMs });
      job = leased.job;
      const remaining = Date.parse(job.leaseExpiresAt) - this.clock();
      if (remaining <= this.minimumLeaseRemainingMs) throw new PrivateAiProtocolError("worker_aborted");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      // unref is safe here (unlike the idle-loop timer in runPullLoop below): this only runs while
      // withImage()/analyze() has real ref'd I/O in flight (an HTTPS request or a spawned subprocess), so
      // that work — not this watchdog — is what should keep the process alive. If the watchdog is the only
      // thing left when it fires, the operation already has nothing left to abort.
      const timer = setTimeout(() => controller.abort(), remaining - this.cleanupBudgetMs);
      timer.unref();
      try {
        const result = await this.protocol.withImage(job, controller.signal,
          ({ imagePath }) => this.analyze(Object.freeze({ job, imagePath, signal: controller.signal })));
        const terminal = await this.protocol.complete(job, result, signal);
        this.onDiagnostic(Object.freeze({ event: "completed", replayed: terminal.replayed }));
        return Object.freeze({ status: terminal.status, retryAfterMs: terminal.retryAfterMs });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    } catch (error) {
      if (!job || error instanceof PrivateWorkerTransportError || error?.code === "transport_lease_conflict") {
        return Object.freeze({ status: "offline", retryAfterMs: 5_000, errorCode: error?.code ?? "unknown" });
      }
      const code = failureCode(error);
      try {
        const terminal = await this.protocol.fail(job, code, signal);
        this.onDiagnostic(Object.freeze({ event: "failed", failureCode: code, replayed: terminal.replayed }));
        return Object.freeze({ status: terminal.status, retryAfterMs: terminal.retryAfterMs, errorCode: code });
      } catch (terminalError) {
        return Object.freeze({ status: "offline", retryAfterMs: 5_000,
          errorCode: terminalError?.code ?? "terminal_unavailable" });
      }
    } finally { this.#active = false; }
  }
}

export async function runPullLoop(worker, { signal = new AbortController().signal,
  random = Math.random, sleep } = {}) {
  if (!(worker instanceof RemotePrivateAiPullWorker) || typeof random !== "function" ||
    sleep !== undefined && typeof sleep !== "function") {
    throw new PrivateAiProtocolError("worker_configuration_invalid");
  }
  let consecutiveOffline = 0;
  while (!signal.aborted) {
    const result = await worker.runOnce(signal);
    const base = result.status === "offline" ? Math.min(300_000, 5_000 * 2 ** consecutiveOffline) :
      integer(result.retryAfterMs, 1_000, 300_000) ? result.retryAfterMs : 5_000;
    consecutiveOffline = result.status === "offline" ? Math.min(consecutiveOffline + 1, 6) : 0;
    const jittered = Math.max(1_000, Math.min(300_000, Math.round(base * (0.8 + random() * 0.4))));
    if (!signal.aborted && sleep) await sleep(jittered);
    else if (!signal.aborted) await new Promise((resolve) => {
      // 不要 unref 这个定时器：这是空闲轮询间隙唯一的活句柄（没有监听 HTTP，没有其他 I/O）。unref 会让事件循环
      // 清零，daemon 在两次轮询之间静默 exit 0、systemd 表现为秒退且不留任何日志——这正是 minimax-private-worker/
      // worker.mjs 的 sleepUntilStop() 2026-08-17 生产实测踩过、并写明「绝不能 unref」的同一个坑，这里当时漏改。
      const timer = setTimeout(done, jittered);
      const abort = () => done();
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      }
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) done();
    });
  }
}
