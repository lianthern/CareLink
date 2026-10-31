import { ApiError } from "./client.js";

const uuid = () => crypto.randomUUID();
const jsonHeaders = (idempotencyKey = uuid(), extra = {}) => ({ Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, ...extra });
const pendingPanoramaStatuses = new Set(["created", "uploading", "validating"]);

function validFile(file) {
  return file && typeof file.arrayBuffer === "function" && Number.isFinite(file.size) && file.size >= 0 && typeof file.name === "string";
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortableWait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    const done = (value) => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); resolve(value); };
    const aborted = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function pollPanoramaCandidate({ spaceId, candidateId, readStatus, signal, isCurrent = () => true, maxAttempts = 20, intervalMs = 1_500, wait = abortableWait }) {
  if (!spaceId || !candidateId || typeof readStatus !== "function" || !Number.isInteger(maxAttempts) || maxAttempts < 1) throw new ApiError("panorama_poll_invalid", "无法继续检查现场文件。", 500);
  let candidate = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted || !isCurrent()) return { outcome: "cancelled" };
    if (attempt && !(await wait(intervalMs, signal))) return { outcome: "cancelled" };
    try { candidate = await readStatus({ spaceId, candidateId, signal }); }
    catch (error) {
      if (signal?.aborted || !isCurrent()) return { outcome: "cancelled" };
      throw error;
    }
    if (signal?.aborted || !isCurrent()) return { outcome: "cancelled" };
    if (candidate?.candidateId !== candidateId) throw new ApiError("panorama_status_mismatch", "现场文件状态无法确认。", 502);
    if (candidate.status === "ready") return { outcome: "ready", candidate };
    if (["failed", "expired"].includes(candidate.status) || ["failed", "timed_out"].includes(candidate.jobStatus)) return { outcome: "failed", candidate };
    if (!pendingPanoramaStatuses.has(candidate.status)) throw new ApiError("panorama_status_invalid", "现场文件返回了未知状态。", 502);
  }
  return { outcome: "timeout", candidate };
}

function ticketParts(ticketEnvelope) {
  const ticket = ticketEnvelope?.oneTimeUploadTicket || ticketEnvelope?.exactPrivateUploadTicketOnce;
  const url = ticket?.url || ticketEnvelope?.uploadUrl;
  const headers = ticket?.headers || ticketEnvelope?.providerHeaders || {};
  const exactKey = ticketEnvelope?.exactPrivateObjectKey || ticket?.exactPrivateObjectKey;
  if (!url || !exactKey || !headers || Array.isArray(headers)) throw new ApiError("upload_ticket_invalid", "上传票据不完整。", 502);
  const parsed = new URL(url, globalThis.location?.origin || "http://localhost");
  if (!decodeURIComponent(parsed.pathname).endsWith(exactKey)) throw new ApiError("upload_ticket_key_mismatch", "上传票据没有绑定精确对象。", 502);
  return { url: parsed.href, headers, exactKey };
}

async function parse(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(value.code || "upload_unavailable", value.message, response.status);
  return value;
}

export class UploadWorkflowClient {
  constructor({ apiAdapter, transport = globalThis.fetch, baseUrl = "" }) {
    this.api = apiAdapter;
    this.transport = (...args) => transport(...args);
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async uploadFiles({ spaceId, files, consentEventId, batchIfMatch, onProgress = () => {} }) {
    if (!spaceId || !consentEventId || !Array.isArray(files) || !files.length || files.some((file) => !validFile(file))) throw new ApiError("upload_selection_invalid", "请选择可读取的本机照片。", 400);
    const clientBatchId = uuid();
    const plan = await this.api.send({
      method: "POST",
      path: `/v1/spaces/${encodeURIComponent(spaceId)}/contribution-batches`,
      body: { clientBatchId, consentEventId, declaredItemCount: files.length },
      ifMatch: batchIfMatch
    });
    const batchId = plan.batchId || plan.id;
    if (!batchId) throw new ApiError("upload_plan_invalid", "服务端没有返回上传批次。", 502);
    const results = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      try {
        onProgress({ index, fileName: file.name, phase: "creating" });
        const item = await this.api.send({
          method: "POST",
          path: `/v1/contribution-batches/${encodeURIComponent(batchId)}/items`,
          body: { clientItemId: uuid(), declaredMime: file.type || "application/octet-stream", declaredBytes: file.size, fileNameHash: await sha256Text(file.name) },
          ifMatch: plan.ifMatch || plan.batchIfMatch
        });
        const itemId = item.itemId || item.id;
        const authorization = await this.api.send({
          method: "POST",
          path: `/v1/contribution-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/upload-sessions`,
          body: { declaredMime: file.type || "application/octet-stream", declaredBytes: file.size, clientUploadId: uuid() },
          ifMatch: item.ifMatch
        });
        onProgress({ index, fileName: file.name, phase: "uploading" });
        const ticket = ticketParts(authorization);
        const uploadResponse = await this.transport(ticket.url, { method: "PUT", headers: ticket.headers, body: file, credentials: "omit" });
        if (!uploadResponse.ok) throw new ApiError("upload_object_failed", "照片字节上传失败。", uploadResponse.status);
        const observedETag = uploadResponse.headers.get("etag") || undefined;
        const commitBody = { clientCommitId: uuid(), ...(observedETag ? { observedETag } : {}) };
        const committed = await this.api.send({
          method: "POST",
          path: `/v1/upload-sessions/${encodeURIComponent(authorization.uploadSessionId)}/commits`,
          body: commitBody,
          ifMatch: authorization.commitIfMatch || authorization.ifMatch
        });
        results.push({ fileName: file.name, itemId, status: committed.status || "validating", result: committed });
        onProgress({ index, fileName: file.name, phase: "committed" });
      } catch (error) {
        results.push({ fileName: file.name, status: "failed", errorCode: error.code || "upload_unavailable" });
        onProgress({ index, fileName: file.name, phase: "failed", errorCode: error.code || "upload_unavailable" });
      }
    }
    return { batchId, results, batchResult: await this.api.read("batchResult", { batchId }) };
  }

  async finalize({ batchId, itemsDigest, ifMatch }) {
    return this.api.send({ method: "POST", path: `/v1/contribution-batches/${encodeURIComponent(batchId)}/finalizations`, body: { itemsDigest, clientRequestId: uuid() }, ifMatch });
  }

  async retryItem({ batchId, itemId, failureVersion, file }) {
    if (!batchId || !itemId || !Number.isFinite(Number(failureVersion)) || !validFile(file)) throw new ApiError("upload_retry_invalid", "请重新选择这张本机照片。", 400);
    const authorization = await this.api.send({
      method: "POST",
      path: `/v1/contribution-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/retries`,
      body: { failureVersion: Number(failureVersion) }
    });
    const ticket = ticketParts(authorization);
    const uploadResponse = await this.transport(ticket.url, { method: "PUT", headers: ticket.headers, body: file, credentials: "omit" });
    if (!uploadResponse.ok) throw new ApiError("upload_object_failed", "照片字节上传失败。", uploadResponse.status);
    const observedETag = uploadResponse.headers.get("etag") || undefined;
    const committed = await this.api.send({
      method: "POST",
      path: `/v1/upload-sessions/${encodeURIComponent(authorization.uploadSessionId)}/commits`,
      body: { clientCommitId: uuid(), ...(observedETag ? { observedETag } : {}) },
      ifMatch: authorization.commitIfMatch || authorization.ifMatch
    });
    return { committed, batchResult: await this.api.read("batchResult", { batchId }) };
  }

  recover({ batchId }) {
    if (!batchId) throw new ApiError("batch_unavailable", "缺少上传批次。", 400);
    return this.api.read("batchResult", { batchId });
  }
}

export class PanoramaUploadWorkflowClient {
  constructor({ apiAdapter, transport = globalThis.fetch }) {
    this.api = apiAdapter;
    this.transport = (...args) => transport(...args);
  }

  async uploadCandidate({ spaceId, file, clientAssetId = uuid(), noticeAcknowledgement, ifMatch }) {
    if (!spaceId || !validFile(file)) throw new ApiError("panorama_selection_invalid", "请选择可读取的现场文件。", 400);
    const created = await this.api.send({
      method: "POST",
      path: `/v1/spaces/${encodeURIComponent(spaceId)}/panorama-candidates`,
      body: { declaredMime: file.type || "application/octet-stream", declaredBytes: file.size, clientAssetId, noticeAcknowledgement },
      ifMatch
    });
    const ticket = ticketParts(created);
    const uploadResponse = await this.transport(ticket.url, { method: "PUT", headers: ticket.headers, body: file, credentials: "omit" });
    if (!uploadResponse.ok) throw new ApiError("panorama_upload_unavailable", "现场文件上传失败。", uploadResponse.status);
    await this.api.send({
      method: "POST",
      path: `/v1/panorama-upload-sessions/${encodeURIComponent(created.uploadSessionId)}/commits`,
      body: { clientRequestId: uuid() },
      ifMatch: created.uploadSessionIfMatch || created.ifMatch
    });
    return this.status({ spaceId, candidateId: created.candidateId });
  }

  status({ spaceId, candidateId, signal }) {
    return this.api.send({ method: "GET", path: `/v1/spaces/${encodeURIComponent(spaceId)}/panorama-candidates/${encodeURIComponent(candidateId)}`, signal });
  }

  async reissueTicket({ spaceId, candidateId, ifMatch }) {
    return this.api.send({ method: "POST", path: `/v1/spaces/${encodeURIComponent(spaceId)}/panorama-candidates/${encodeURIComponent(candidateId)}/upload-sessions`, body: { clientRequestId: uuid() }, ifMatch });
  }

  async retryValidation({ spaceId, candidateId, ifMatch }) {
    return this.api.send({ method: "POST", path: `/v1/spaces/${encodeURIComponent(spaceId)}/panorama-candidates/${encodeURIComponent(candidateId)}/retries`, body: { clientRequestId: uuid() }, ifMatch });
  }
}
