"use strict";

const crypto = require("node:crypto");
const { AppError, invariant } = require("./errors.js");
const { hmac, randomId, secureEqual, sha256, signToken, verifyToken } = require("./crypto.js");
const { inspectImage } = require("./image.js");

const NS = "unseen-backend/v1";
const MAX_PHOTOS = 90;
const PHOTO_MAX_BYTES = 20 * 1024 * 1024;
const PANO_MAX_BYTES = 50 * 1024 * 1024;
const JSON_MAX_BYTES = 256 * 1024;

function stateKey(sid) { return `${NS}/spaces/${sid}/state.json`; }
function stageKey(sid, purpose) { return `${NS}/staging/${sid}/${purpose}.bin`; }
function receiptKey(sid, pid) { return `${NS}/tickets/${sid}/${pid}.json`; }
function uploadKey(sid, pid) { return `${NS}/uploads/${sid}/${pid}.bin`; }
function slotKey(sid, slot) { return `${NS}/slots/${sid}/${String(slot).padStart(2, "0")}.json`; }
function commitKey(sid, pid) { return `${NS}/commits/${sid}/${pid}.json`; }
function manifestKey(sid) { return `spaces/${sid}/space.json`; }

function sanitizeText(value, max, fallback = "") {
  let text = String(value === undefined || value === null ? "" : value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/[<>&]/g, "")
    .replace(/\s+/g, " ").trim();
  if (!text) text = fallback;
  return Array.from(text).slice(0, max).join("");
}

function sanitizeDate(value) {
  const date = String(value || "").trim();
  if (!date) return "";
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const stamp = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  const roundTrip = Number.isNaN(stamp) ? "" : new Date(stamp).toISOString().slice(0, 10);
  invariant(match && roundTrip === date, "INVALID_DATE", "日期格式需要为有效的 YYYY-MM-DD", 400);
  return date;
}

function validateClientId(value, field) {
  const id = String(value || "");
  invariant(/^[A-Za-z0-9._:-]{16,128}$/.test(id), "INVALID_IDEMPOTENCY_KEY",
    `${field} 需要是 16–128 位随机标识`, 400);
  return id;
}

function validateSid(value) {
  const sid = String(value || "");
  invariant(/^u[a-f0-9]{24}$/.test(sid), "INVALID_SPACE_ID", "空间编号无效", 400);
  return sid;
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

async function getJson(oss, key, allow404 = false) {
  const object = await oss.get(key, { allow404, maxBytes: JSON_MAX_BYTES });
  if (!object) return null;
  try {
    return { value: JSON.parse(object.body.toString("utf8")), etag: object.etag };
  } catch (_) {
    throw new AppError("CORRUPT_BACKEND_STATE", "后端状态损坏", 500);
  }
}

async function putJson(oss, key, value, options = {}) {
  return oss.put(key, jsonBuffer(value), {
    contentType: "application/json; charset=utf-8",
    acl: options.acl || "private",
    cacheControl: options.cacheControl,
    ifNoneMatch: options.ifNoneMatch
  });
}

function publicUrl(config, key) {
  return `${config.ossPublicBase}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function postPolicy(config, key, maxBytes, nowMs) {
  invariant(key.startsWith(`${NS}/`) && !key.includes(".."),
    "UNSAFE_OBJECT_KEY", "拒绝生成不安全的对象键", 500);
  const expiresAt = nowMs + config.policyTtlSeconds * 1000;
  const policyObject = {
    expiration: new Date(expiresAt).toISOString(),
    conditions: [
      { bucket: config.bucket },
      ["eq", "$key", key],
      ["content-length-range", 1, maxBytes],
      ["eq", "$x-oss-object-acl", "private"],
      ["eq", "$success_action_status", "200"]
    ]
  };
  const policy = Buffer.from(JSON.stringify(policyObject), "utf8").toString("base64");
  const signature = crypto.createHmac("sha1", config.accessKeySecret)
    .update(policy, "utf8").digest("base64");
  return {
    host: config.ossPublicBase,
    expiresAt: Math.floor(expiresAt / 1000),
    maxSize: maxBytes,
    fields: {
      key,
      policy,
      OSSAccessKeyId: config.accessKeyId,
      Signature: signature,
      "x-oss-object-acl": "private",
      success_action_status: "200"
    }
  };
}

function makeService(options) {
  const { oss, config } = options;
  const now = options.now || (() => Date.now());
  const makeRandomId = options.randomId || randomId;

  function deriveSid(clientCreateId) {
    return `u${hmac(config.spaceIdSecret, `space:v1:${clientCreateId}`, "hex").slice(0, 24)}`;
  }

  function deriveHostKey(clientCreateId) {
    return `h_${hmac(config.hostKeySecret, `host:v1:${clientCreateId}`)}`;
  }

  function derivePhotoId(sid, clientUploadId) {
    return `p_${hmac(config.tokenSecret, `photo:v1:${sid}:${clientUploadId}`, "hex").slice(0, 24)}`;
  }

  async function loadState(sid) {
    const item = await getJson(oss, stateKey(sid), true);
    invariant(item && item.value && item.value.schema === "unseen-managed-state/1" && item.value.sid === sid,
      "SPACE_NOT_FOUND", "没有找到这个空间", 404);
    return item.value;
  }

  function verifyHost(state, candidate) {
    invariant(typeof candidate === "string" && candidate.length <= 256 &&
      secureEqual(sha256(candidate), state.hostKeyVerifier),
      "HOST_AUTH_FAILED", "主办方凭证无效", 401);
  }

  async function enforceRate(action, scope, requestId, limit, windowMs) {
    const bucket = Math.floor(now() / windowMs);
    const scopeHash = hmac(config.rateLimitSecret, `scope:${scope}`, "hex").slice(0, 24);
    const requestHash = hmac(config.rateLimitSecret, `request:${requestId}`, "hex").slice(0, 24);
    const prefix = `${NS}/rate/${action}/${bucket}/${scopeHash}/`;
    const key = `${prefix}${requestHash}.json`;
    try {
      await putJson(oss, key, { createdAt: now(), action }, { ifNoneMatch: true });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "OSS_PRECONDITION") throw error;
    }
    const listed = await oss.list(prefix, { maxKeys: limit + 1 });
    if (listed.objects.length > limit) {
      throw new AppError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429,
        { retryAfterSeconds: Math.ceil(windowMs / 1000) });
    }
  }

  async function inspectStoredImage(key, kind) {
    const max = kind === "panorama" ? PANO_MAX_BYTES : PHOTO_MAX_BYTES;
    const object = await oss.get(key, { allow404: true, maxBytes: max });
    invariant(object, "UPLOAD_NOT_FOUND", "还没有收到对应图片，请先完成上传", 409);
    const info = inspectImage(object.body, kind);
    return { ...info, etag: object.etag, digest: sha256(object.body) };
  }

  async function copyValidated(sourceKey, destinationKey, info) {
    try {
      await oss.copy(sourceKey, destinationKey, {
        sourceEtag: info.etag,
        contentType: info.mime,
        acl: "public-read",
        cacheControl: "public, max-age=31536000, immutable",
        ifNoneMatch: true
      });
      return;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "OSS_PRECONDITION") throw error;
    }
    const existing = await oss.get(destinationKey, { allow404: true,
      maxBytes: info.size });
    invariant(existing && sha256(existing.body) === info.digest,
      "PUBLIC_OBJECT_COLLISION", "公开对象键发生冲突，已停止写入", 409);
  }

  function creationResponse(state, clientCreateId) {
    const response = {
      spaceId: state.sid,
      hostKey: deriveHostKey(clientCreateId),
      status: state.status,
      manifestUrl: publicUrl(config, manifestKey(state.sid)),
      uploads: {}
    };
    if (state.status === "draft") {
      if (state.requested.cover) {
        response.uploads.cover = postPolicy(config, state.media.cover.stagingKey,
          PHOTO_MAX_BYTES, now());
      }
      if (state.requested.panorama) {
        response.uploads.panorama = postPolicy(config, state.media.panorama.stagingKey,
          PANO_MAX_BYTES, now());
      }
    }
    return response;
  }

  async function createSpace(body, request) {
    const clientCreateId = validateClientId(body.clientCreateId, "clientCreateId");
    const sid = deriveSid(clientCreateId);
    const existing = await getJson(oss, stateKey(sid), true);
    if (existing) {
      invariant(existing.value.clientCreateHash === sha256(clientCreateId),
        "SPACE_ID_COLLISION", "空间标识发生冲突", 409);
      return creationResponse(existing.value, clientCreateId);
    }

    await enforceRate("create", request.ip || "unknown", clientCreateId,
      config.createRatePerHour, 60 * 60 * 1000);
    invariant(!(await oss.head(manifestKey(sid))).exists,
      "SPACE_ID_COLLISION", "空间编号已被占用", 409);

    const requested = {
      cover: Boolean(body.media && body.media.cover),
      panorama: Boolean(body.media && body.media.panorama)
    };
    const createdAt = now();
    const state = {
      schema: "unseen-managed-state/1",
      version: 1,
      sid,
      status: "draft",
      creationTag: makeRandomId(12),
      clientCreateHash: sha256(clientCreateId),
      hostKeyVerifier: sha256(deriveHostKey(clientCreateId)),
      metadata: {
        title: sanitizeText(body.title, 80, "未命名空间"),
        date: sanitizeDate(body.date),
        place: sanitizeText(body.place, 80),
        subtitle: sanitizeText(body.subtitle, 120)
      },
      requested,
      media: {
        cover: { stagingKey: stageKey(sid, "cover"), publicKey: null },
        panorama: { stagingKey: stageKey(sid, "panorama"), publicKey: null }
      },
      createdAt,
      updatedAt: createdAt
    };
    try {
      await putJson(oss, stateKey(sid), state, { ifNoneMatch: true });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "OSS_PRECONDITION") throw error;
      const raced = await loadState(sid);
      invariant(raced.clientCreateHash === sha256(clientCreateId),
        "SPACE_ID_COLLISION", "空间标识发生冲突", 409);
      return creationResponse(raced, clientCreateId);
    }
    return creationResponse(state, clientCreateId);
  }

  async function listCommitRecords(sid) {
    const prefix = `${NS}/commits/${sid}/`;
    const listed = await oss.list(prefix, { maxKeys: MAX_PHOTOS + 1 });
    invariant(!listed.truncated && listed.objects.length <= MAX_PHOTOS,
      "PHOTO_CAPACITY_CORRUPT", "空间照片索引超过安全上限", 500);
    const records = [];
    for (const item of listed.objects) {
      const parsed = await getJson(oss, item.key);
      const record = parsed.value;
      invariant(record && record.schema === "unseen-photo-commit/1" && record.sid === sid,
        "CORRUPT_BACKEND_STATE", "照片提交记录损坏", 500);
      records.push(record);
    }
    return records.sort((a, b) => a.slot - b.slot || a.photoId.localeCompare(b.photoId));
  }

  function buildManifest(state, records) {
    const photos = records.map((record) => ({
      id: record.photoId,
      src: publicUrl(config, record.publicKey),
      thumb: publicUrl(config, record.publicKey),
      nodeId: "n1",
      contributor: record.contributor,
      caption: record.caption,
      width: record.width,
      height: record.height,
      createdAt: new Date(record.createdAt).toISOString()
    }));
    const contributorCounts = new Map();
    photos.forEach((photo) => contributorCounts.set(photo.contributor,
      (contributorCounts.get(photo.contributor) || 0) + 1));
    const full = photos.length >= MAX_PHOTOS;
    const panorama = state.media.panorama.publicKey ? publicUrl(config, state.media.panorama.publicKey) : null;
    const publishedAt = state.publishedAt || now();
    return {
      schema: "psm-space/1",
      id: state.sid,
      title: state.metadata.title,
      date: state.metadata.date,
      place: state.metadata.place,
      subtitle: state.metadata.subtitle,
      cover: state.media.cover.publicKey ? publicUrl(config, state.media.cover.publicKey) : "",
      createdAt: state.createdAt / 1000,
      published: true,
      publishedAt: publishedAt / 1000,
      managed: { schema: "unseen-cloudbase/1", creationTag: state.creationTag },
      collection: { status: full ? "closed" : "open", updatedAt: now() / 1000 },
      capacity: { maxPhotos: MAX_PHOTOS, received: photos.length,
        remaining: Math.max(0, MAX_PHOTOS - photos.length), full },
      nodes: [{ id: "n1", name: state.metadata.title, panorama, panoMini: panorama }],
      tasks: [],
      photos,
      pending: [],
      contributors: Array.from(contributorCounts, ([name, count]) => ({ name, photos: count })),
      upload: {
        enabled: !full,
        mode: "ticket-v1",
        endpoint: config.publicApiUrl,
        ticketAction: "photoTicket",
        commitAction: "commitPhoto",
        maxSize: PHOTO_MAX_BYTES,
        maxPhotos: MAX_PHOTOS
      },
      revision: photos.length,
      updatedAt: now() / 1000
    };
  }

  async function reconcileManifest(state) {
    let latest;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const records = await listCommitRecords(state.sid);
      latest = buildManifest(state, records);
      await putJson(oss, manifestKey(state.sid), latest, {
        acl: "public-read", cacheControl: "no-cache, no-store, must-revalidate"
      });
      const after = await listCommitRecords(state.sid);
      if (after.length === records.length && after.every((item, index) => item.photoId === records[index].photoId)) {
        return latest;
      }
    }
    throw new AppError("MANIFEST_BUSY", "空间正在接收其他照片，请重试", 409);
  }

  async function finalizeSpace(body, request) {
    const sid = validateSid(body.spaceId);
    const state = await loadState(sid);
    verifyHost(state, request.hostKey || body.hostKey);
    if (state.status === "published") {
      const current = await getJson(oss, manifestKey(sid), true);
      if (current) return { spaceId: sid, status: "published",
        manifestUrl: publicUrl(config, manifestKey(sid)), manifest: current.value };
    }
    invariant(state.status === "draft", "SPACE_STATE_INVALID", "空间状态不允许发布", 409);

    const useCover = body.useCover === undefined ? state.requested.cover : Boolean(body.useCover);
    const usePanorama = body.usePanorama === undefined ? state.requested.panorama : Boolean(body.usePanorama);
    invariant(!useCover || state.requested.cover, "MEDIA_NOT_REQUESTED", "创建空间时没有申请封面上传", 400);
    invariant(!usePanorama || state.requested.panorama, "MEDIA_NOT_REQUESTED", "创建空间时没有申请全景上传", 400);

    const next = JSON.parse(JSON.stringify(state));
    if (useCover) {
      const info = await inspectStoredImage(state.media.cover.stagingKey, "cover");
      const key = `spaces/${sid}/cover.${info.extension}`;
      await copyValidated(state.media.cover.stagingKey, key, info);
      next.media.cover.publicKey = key;
      next.media.cover.info = { width: info.width, height: info.height, size: info.size, format: info.format };
    }
    if (usePanorama) {
      const info = await inspectStoredImage(state.media.panorama.stagingKey, "panorama");
      const key = `spaces/${sid}/nodes/n1/pano.${info.extension}`;
      await copyValidated(state.media.panorama.stagingKey, key, info);
      next.media.panorama.publicKey = key;
      next.media.panorama.info = { width: info.width, height: info.height, size: info.size, format: info.format };
    }
    next.status = "published";
    next.publishedAt = now();
    next.updatedAt = now();

    const existing = await getJson(oss, manifestKey(sid), true);
    invariant(!existing || existing.value.managed && existing.value.managed.creationTag === state.creationTag,
      "PUBLIC_MANIFEST_COLLISION", "公开空间路径已被其他内容占用", 409);
    const manifest = await reconcileManifest(next);
    await putJson(oss, stateKey(sid), next);
    return { spaceId: sid, status: "published",
      manifestUrl: publicUrl(config, manifestKey(sid)), manifest };
  }

  async function reserveSlot(sid, photoId) {
    const start = parseInt(photoId.slice(-8), 16) % MAX_PHOTOS;
    for (let probe = 0; probe < MAX_PHOTOS; probe += 1) {
      const slot = (start + probe) % MAX_PHOTOS;
      const key = slotKey(sid, slot);
      try {
        await putJson(oss, key, { schema: "unseen-photo-slot/1", sid, photoId,
          slot, createdAt: now() }, { ifNoneMatch: true });
        return slot;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "OSS_PRECONDITION") throw error;
        const current = await getJson(oss, key, true);
        if (current && current.value.photoId === photoId) return slot;
      }
    }
    throw new AppError("SPACE_FULL", "这个空间已经收满 90 张照片", 409);
  }

  function ticketResponse(receipt) {
    if (receipt.status === "committed") {
      return { spaceId: receipt.sid, clientUploadId: receipt.clientUploadId,
        photoId: receipt.photoId, committed: true,
        photoUrl: publicUrl(config, receipt.publicKey) };
    }
    const expires = Math.floor((now() + config.commitTtlSeconds * 1000) / 1000);
    const token = signToken({ v: 1, a: "commitPhoto", sid: receipt.sid,
      pid: receipt.photoId, key: receipt.uploadKey, rid: receiptKey(receipt.sid, receipt.photoId), exp: expires },
    config.tokenSecret);
    return {
      spaceId: receipt.sid,
      clientUploadId: receipt.clientUploadId,
      photoId: receipt.photoId,
      committed: false,
      upload: postPolicy(config, receipt.uploadKey, PHOTO_MAX_BYTES, now()),
      commitToken: token,
      commitExpiresAt: expires
    };
  }

  async function photoTicket(body, request) {
    const sid = validateSid(body.spaceId);
    const clientUploadId = validateClientId(body.clientUploadId, "clientUploadId");
    const photoId = derivePhotoId(sid, clientUploadId);
    const old = await getJson(oss, receiptKey(sid, photoId), true);
    if (old) {
      invariant(old.value.clientUploadId === clientUploadId,
        "UPLOAD_ID_COLLISION", "上传标识发生冲突", 409);
      return ticketResponse(old.value);
    }

    const state = await loadState(sid);
    invariant(state.status === "published", "SPACE_NOT_PUBLISHED", "空间尚未发布", 409);
    const manifest = await getJson(oss, manifestKey(sid));
    invariant(manifest.value.collection && manifest.value.collection.status === "open" &&
      (manifest.value.photos || []).length < MAX_PHOTOS,
    "SPACE_FULL", "这个空间已经停止收集照片", 409);

    await enforceRate("ticket-ip", request.ip || "unknown", `${sid}:${clientUploadId}`,
      config.ticketRatePerIp10m, 10 * 60 * 1000);
    await enforceRate("ticket-space", sid, clientUploadId,
      config.ticketRatePerSpace10m, 10 * 60 * 1000);
    const slot = await reserveSlot(sid, photoId);
    const receipt = {
      schema: "unseen-photo-ticket/1", sid, photoId, clientUploadId, slot,
      uploadKey: uploadKey(sid, photoId), status: "issued",
      contributor: sanitizeText(body.contributor, 40, "空间参与者"),
      caption: sanitizeText(body.caption, 160),
      createdAt: now(), updatedAt: now()
    };
    try {
      await putJson(oss, receiptKey(sid, photoId), receipt, { ifNoneMatch: true });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "OSS_PRECONDITION") throw error;
      const raced = await getJson(oss, receiptKey(sid, photoId));
      return ticketResponse(raced.value);
    }
    return ticketResponse(receipt);
  }

  async function commitPhoto(body) {
    const payload = verifyToken(body.commitToken, config.tokenSecret, now());
    const sid = validateSid(payload.sid);
    invariant(/^p_[a-f0-9]{24}$/.test(payload.pid) && payload.key === uploadKey(sid, payload.pid) &&
      payload.rid === receiptKey(sid, payload.pid),
    "INVALID_COMMIT_TOKEN", "提交凭证无效", 401);
    const receiptItem = await getJson(oss, payload.rid, true);
    invariant(receiptItem && receiptItem.value.photoId === payload.pid &&
      receiptItem.value.uploadKey === payload.key,
    "INVALID_COMMIT_TOKEN", "提交凭证无效", 401);
    const receipt = receiptItem.value;
    const state = await loadState(sid);
    invariant(state.status === "published", "SPACE_NOT_PUBLISHED", "空间尚未发布", 409);

    const existingCommit = await getJson(oss, commitKey(sid, payload.pid), true);
    if (existingCommit) {
      const manifest = await reconcileManifest(state);
      return { spaceId: sid, photo: manifest.photos.find((photo) => photo.id === payload.pid),
        manifestUrl: publicUrl(config, manifestKey(sid)), idempotent: true };
    }

    const info = await inspectStoredImage(payload.key, "photo");
    const publicKey = `spaces/${sid}/photos/${payload.pid}.${info.extension}`;
    await copyValidated(payload.key, publicKey, info);
    const record = {
      schema: "unseen-photo-commit/1", sid, photoId: payload.pid,
      slot: receipt.slot, publicKey,
      contributor: receipt.contributor, caption: receipt.caption,
      width: info.width, height: info.height, size: info.size, format: info.format,
      digest: info.digest, createdAt: now()
    };
    try {
      await putJson(oss, commitKey(sid, payload.pid), record, { ifNoneMatch: true });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "OSS_PRECONDITION") throw error;
    }
    const manifest = await reconcileManifest(state);
    const doneReceipt = { ...receipt, status: "committed", publicKey,
      committedAt: now(), updatedAt: now() };
    await putJson(oss, payload.rid, doneReceipt);
    await oss.delete(payload.key);
    return { spaceId: sid, photo: manifest.photos.find((photo) => photo.id === payload.pid),
      manifestUrl: publicUrl(config, manifestKey(sid)), idempotent: false };
  }

  async function maintenance() {
    const result = { scannedSpaces: 0, reconciledSpaces: 0, expiredDrafts: 0,
      expiredUploads: 0, expiredTickets: 0, expiredRateMarkers: 0, truncated: false };
    const stateList = await oss.list(`${NS}/spaces/`, { maxKeys: config.maintenanceMaxObjects });
    result.truncated = stateList.truncated;
    for (const item of stateList.objects.filter((entry) => entry.key.endsWith("/state.json"))) {
      const parsed = await getJson(oss, item.key, true);
      if (!parsed) continue;
      const state = parsed.value;
      result.scannedSpaces += 1;
      if (state.status === "draft" && now() - state.createdAt > config.draftTtlSeconds * 1000) {
        await oss.delete(state.media.cover.stagingKey);
        await oss.delete(state.media.panorama.stagingKey);
        await oss.delete(item.key);
        result.expiredDrafts += 1;
      } else if (state.status === "published") {
        await reconcileManifest(state);
        result.reconciledSpaces += 1;
      }
    }

    const uploadList = await oss.list(`${NS}/uploads/`, { maxKeys: config.maintenanceMaxObjects });
    result.truncated = result.truncated || uploadList.truncated;
    for (const item of uploadList.objects) {
      const age = now() - Date.parse(item.lastModified || 0);
      if (!(age > config.uploadTtlSeconds * 1000)) continue;
      const match = item.key.match(new RegExp(`^${NS}/uploads/(u[a-f0-9]{24})/(p_[a-f0-9]{24})\\.bin$`));
      if (!match) continue;
      const [, sid, pid] = match;
      const committed = await getJson(oss, commitKey(sid, pid), true);
      if (committed) { await oss.delete(item.key); continue; }
      const receipt = await getJson(oss, receiptKey(sid, pid), true);
      if (receipt && receipt.value.status === "committed") { await oss.delete(item.key); continue; }
      await oss.delete(item.key);
      if (receipt) {
        const slot = await getJson(oss, slotKey(sid, receipt.value.slot), true);
        if (slot && slot.value.photoId === pid) await oss.delete(slotKey(sid, receipt.value.slot));
        await oss.delete(receiptKey(sid, pid));
      }
      result.expiredUploads += 1;
    }

    const ticketList = await oss.list(`${NS}/tickets/`, { maxKeys: config.maintenanceMaxObjects });
    result.truncated = result.truncated || ticketList.truncated;
    for (const item of ticketList.objects) {
      const age = now() - Date.parse(item.lastModified || 0);
      if (!(age > config.uploadTtlSeconds * 1000)) continue;
      const receipt = await getJson(oss, item.key, true);
      if (!receipt || receipt.value.status === "committed") continue;
      const { sid, photoId: pid, slot } = receipt.value;
      if (!/^u[a-f0-9]{24}$/.test(sid) || !/^p_[a-f0-9]{24}$/.test(pid) ||
          !Number.isInteger(slot) || slot < 0 || slot >= MAX_PHOTOS) continue;
      if (await getJson(oss, commitKey(sid, pid), true)) continue;
      const reserved = await getJson(oss, slotKey(sid, slot), true);
      if (reserved && reserved.value.photoId === pid) await oss.delete(slotKey(sid, slot));
      await oss.delete(uploadKey(sid, pid));
      await oss.delete(item.key);
      result.expiredTickets += 1;
    }

    const rateList = await oss.list(`${NS}/rate/`, { maxKeys: config.maintenanceMaxObjects });
    result.truncated = result.truncated || rateList.truncated;
    for (const item of rateList.objects) {
      if (now() - Date.parse(item.lastModified || 0) > 48 * 60 * 60 * 1000) {
        await oss.delete(item.key);
        result.expiredRateMarkers += 1;
      }
    }
    return result;
  }

  async function handle(action, body, request = {}) {
    switch (action) {
      case "health": return { ok: true, service: "unseen-cloudbase-backend", version: 1,
        time: new Date(now()).toISOString() };
      case "createSpace": return createSpace(body, request);
      case "finalizeSpace": return finalizeSpace(body, request);
      case "photoTicket": return photoTicket(body, request);
      case "commitPhoto": return commitPhoto(body, request);
      case "maintenance": return maintenance();
      default: throw new AppError("UNKNOWN_ACTION", "未知操作", 404);
    }
  }

  return { handle, createSpace, finalizeSpace, photoTicket, commitPhoto, maintenance,
    _internals: { buildManifest, derivePhotoId, deriveSid, postPolicy, sanitizeText } };
}

module.exports = { makeService, constants: { NS, MAX_PHOTOS, PHOTO_MAX_BYTES, PANO_MAX_BYTES } };
