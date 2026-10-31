"use strict";

const crypto = require("crypto");
const cloud = require("wx-server-sdk");

class AppError extends Error {
  constructor(code, message, statusCode = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function invariant(condition, code, message, statusCode = 400, details = undefined) {
  if (!condition) throw new AppError(code, message, statusCode, details);
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

function parsePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  invariant(buffer.readUInt32BE(8) === 13 && buffer.toString("ascii", 12, 16) === "IHDR",
    "INVALID_IMAGE", "PNG 文件头不完整或已损坏", 422);
  return {
    format: "png", mime: "image/png", extension: "png",
    width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), animated: false
  };
}

function parseJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    invariant(offset + 2 <= buffer.length, "INVALID_IMAGE", "JPEG 文件头不完整或已损坏", 422);
    const length = buffer.readUInt16BE(offset);
    invariant(length >= 2 && offset + length <= buffer.length,
      "INVALID_IMAGE", "JPEG 文件段长度无效", 422);
    if (JPEG_SOF_MARKERS.has(marker)) {
      invariant(length >= 8, "INVALID_IMAGE", "JPEG 尺寸信息无效", 422);
      return {
        format: "jpeg", mime: "image/jpeg", extension: "jpg",
        width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3), animated: false
      };
    }
    offset += length;
  }
  throw new AppError("INVALID_IMAGE", "无法读取 JPEG 尺寸", 422);
}

function parseWebp(buffer) {
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const declared = buffer.readUInt32LE(4) + 8;
  invariant(declared <= buffer.length && declared >= 20,
    "INVALID_IMAGE", "WebP 文件长度无效", 422);
  let offset = 12;
  while (offset + 8 <= declared) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    invariant(data + size <= declared, "INVALID_IMAGE", "WebP 文件块不完整", 422);
    if (type === "VP8X") {
      invariant(size >= 10, "INVALID_IMAGE", "WebP VP8X 文件头无效", 422);
      const flags = buffer[data];
      const width = 1 + buffer[data + 4] + (buffer[data + 5] << 8) + (buffer[data + 6] << 16);
      const height = 1 + buffer[data + 7] + (buffer[data + 8] << 8) + (buffer[data + 9] << 16);
      return { format: "webp", mime: "image/webp", extension: "webp", width, height,
        animated: Boolean(flags & 0x02) };
    }
    if (type === "VP8 ") {
      invariant(size >= 10 && buffer[data + 3] === 0x9d && buffer[data + 4] === 0x01 && buffer[data + 5] === 0x2a,
        "INVALID_IMAGE", "WebP VP8 文件头无效", 422);
      return {
        format: "webp", mime: "image/webp", extension: "webp",
        width: buffer.readUInt16LE(data + 6) & 0x3fff,
        height: buffer.readUInt16LE(data + 8) & 0x3fff,
        animated: false
      };
    }
    if (type === "VP8L") {
      invariant(size >= 5 && buffer[data] === 0x2f,
        "INVALID_IMAGE", "WebP VP8L 文件头无效", 422);
      const b1 = buffer[data + 1];
      const b2 = buffer[data + 2];
      const b3 = buffer[data + 3];
      const b4 = buffer[data + 4];
      return {
        format: "webp", mime: "image/webp", extension: "webp",
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
        animated: false
      };
    }
    offset = data + size + (size % 2);
  }
  throw new AppError("INVALID_IMAGE", "无法读取 WebP 尺寸", 422);
}

function inspectImage(buffer, kind) {
  invariant(Buffer.isBuffer(buffer) && buffer.length > 0, "EMPTY_IMAGE", "图片为空", 422);
  const maxBytes = kind === "panorama" ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
  invariant(buffer.length <= maxBytes, "IMAGE_TOO_LARGE",
    kind === "panorama" ? "全景图不能超过 50 MB" : "照片不能超过 20 MB", 413);
  const parsed = parsePng(buffer) || parseJpeg(buffer) || parseWebp(buffer);
  invariant(parsed, "UNSUPPORTED_IMAGE", "仅支持 JPEG、PNG 或 WebP 图片", 422);
  invariant(!parsed.animated, "ANIMATED_IMAGE_UNSUPPORTED", "不支持动态 WebP", 422);
  invariant(Number.isSafeInteger(parsed.width) && Number.isSafeInteger(parsed.height) &&
    parsed.width > 0 && parsed.height > 0, "INVALID_IMAGE", "图片尺寸无效", 422);
  if (kind === "panorama") {
    const ratio = parsed.width / parsed.height;
    invariant(parsed.width >= 1600 && parsed.height >= 800,
      "PANORAMA_TOO_SMALL", "全景图至少需要 1600 × 800 像素", 422);
    invariant(parsed.width <= 8192 && parsed.height <= 4096,
      "PANORAMA_DIMENSIONS_TOO_LARGE", "全景图不能超过 8192 × 4096 像素", 422);
    invariant(ratio >= 1.9 && ratio <= 2.1,
      "PANORAMA_RATIO_INVALID", "全景图宽高比需要接近 2:1", 422);
  } else {
    invariant(parsed.width <= 8192 && parsed.height <= 8192,
      "IMAGE_DIMENSIONS_TOO_LARGE", "照片任一边不能超过 8192 像素", 422);
  }
  return { ...parsed, size: buffer.length };
}

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const SPACES = "unseen_spaces";
const CREATES = "unseen_creates";
const UPLOADS = "unseen_uploads";
const SLOTS = "unseen_slots";
const COLLECTIONS = [SPACES, CREATES, UPLOADS, SLOTS];
const MAX_PHOTOS = 90;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
let collectionBootstrap = null;

function digest(value, length = 40) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function randomId(prefix) {
  return String(prefix || "") + crypto.randomBytes(12).toString("hex");
}

function cleanText(value, maxLength, fallback = "") {
  const text = String(value == null ? "" : value).trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  return (text || fallback).slice(0, maxLength);
}

function nowIso() { return new Date().toISOString(); }

function isNotFound(error) {
  const message = String(error && (error.errMsg || error.message) || error || "");
  return /not exist|not found|DATABASE_COLLECTION_NOT_EXIST|DATABASE_DOCUMENT_NOT_EXIST|-502005|-502002/i.test(message);
}

function isAlreadyExists(error) {
  const message = String(error && (error.errMsg || error.message) || error || "");
  return /already exist|duplicate|DUPLICATE|-502001|-501001/i.test(message);
}

async function ensureCollections() {
  if (!collectionBootstrap) {
    collectionBootstrap = Promise.all(COLLECTIONS.map(async (name) => {
      try { await db.createCollection(name); } catch (error) {
        try {
          await db.collection(name).limit(1).get();
        } catch (_) {
          throw error;
        }
      }
    })).catch((error) => {
      collectionBootstrap = null;
      throw error;
    });
  }
  await collectionBootstrap;
}

async function getDoc(collection, id) {
  try {
    const result = await db.collection(collection).doc(id).get();
    return result && result.data || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function requireOpenId(event) {
  const context = cloud.getWXContext ? cloud.getWXContext() : {};
  const openid = cleanText(context && context.OPENID || event && event.userInfo && event.userInfo.openId, 128);
  invariant(openid, "AUTH_REQUIRED", "微信身份校验失败，请重新打开小程序", 401);
  return openid;
}

function validateSid(value) {
  const sid = cleanText(value, 32);
  invariant(/^u[a-f0-9]{24}$/.test(sid), "INVALID_SPACE_ID", "空间编号无效");
  return sid;
}

function validateClientId(value, kind) {
  const clientId = cleanText(value, 128);
  invariant(/^[A-Za-z0-9._:-]{16,128}$/.test(clientId), "INVALID_IDEMPOTENCY_KEY",
    kind === "create" ? "创建标识无效" : "上传标识无效");
  return clientId;
}

function extensionFor(format) {
  const normalized = cleanText(format, 12).toLowerCase();
  if (normalized === "jpeg" || normalized === "jpg") return "jpg";
  if (normalized === "png") return "png";
  if (normalized === "webp") return "webp";
  throw new AppError("UNSUPPORTED_IMAGE", "仅支持 JPEG、PNG 或 WebP 图片", 422);
}

function fileCloudPath(fileID) {
  const match = String(fileID || "").match(/^cloud:\/\/[^/]+\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function assertExactFile(fileID, expectedPath) {
  invariant(fileCloudPath(fileID) === expectedPath, "UNTRUSTED_FILE_ID", "云端文件与当前上传任务不一致", 403);
}

async function deleteFiles(fileIDs) {
  const values = (fileIDs || []).filter((value) => /^cloud:\/\//.test(String(value || "")));
  if (!values.length) return;
  try { await cloud.deleteFile({ fileList: values }); } catch (_) {}
}

async function inspectCloudFile(fileID, kind) {
  const downloaded = await cloud.downloadFile({ fileID });
  const content = downloaded && downloaded.fileContent;
  invariant(Buffer.isBuffer(content), "FILE_DOWNLOAD_FAILED", "云端图片读取失败，请重试", 502);
  return inspectImage(content, kind);
}

async function tempUrlMap(fileIDs) {
  const unique = [...new Set((fileIDs || []).filter(Boolean))];
  if (!unique.length) return new Map();
  const result = await cloud.getTempFileURL({ fileList: unique });
  const map = new Map();
  for (const item of result && result.fileList || []) {
    if (item && item.fileID) map.set(item.fileID, item.tempFileURL || item.fileID);
  }
  return map;
}

async function publicSpace(space) {
  const panorama = space.panorama || null;
  const photos = Array.isArray(space.photos) ? space.photos : [];
  const urlMap = await tempUrlMap([
    panorama && panorama.fileID,
    ...photos.map((photo) => photo.fileID)
  ]);
  const panoramaUrl = panorama ? (urlMap.get(panorama.fileID) || panorama.fileID) : null;
  return {
    schema: "unseen-native/1",
    id: space._id,
    title: space.title,
    date: space.date || "",
    place: space.place || "",
    scene: space.scene || "",
    subtitle: space.subtitle || "",
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
    collection: { status: space.collectionStatus || "open", open: space.collectionStatus !== "closed" },
    capacity: {
      maxPhotos: MAX_PHOTOS,
      received: photos.length,
      remaining: Math.max(0, MAX_PHOTOS - photos.length),
      full: photos.length >= MAX_PHOTOS
    },
    nodes: [{
      id: "n1",
      panorama: panoramaUrl,
      panoMini: panoramaUrl,
      panoramaFileID: panorama && panorama.fileID || null,
      panoramaWidth: panorama && panorama.width || 0,
      panoramaHeight: panorama && panorama.height || 0
    }],
    photos: photos.map((photo) => {
      const src = urlMap.get(photo.fileID) || photo.fileID;
      return {
        id: photo.id,
        src,
        thumb: src,
        fileID: photo.fileID,
        width: photo.width || 0,
        height: photo.height || 0,
        size: photo.size || 0,
        contributor: photo.contributor || "微信参与者",
        createdAt: photo.createdAt
      };
    }),
    pending: [],
    upload: {
      enabled: space.collectionStatus !== "closed" && photos.length < MAX_PHOTOS,
      mode: "native-cloud-v1",
      functionName: "unseenNative",
      maxSize: 20 * 1024 * 1024
    }
  };
}

async function createSpace(event, openid) {
  const clientCreateId = validateClientId(event.clientCreateId, "create");
  const createId = digest("create|" + openid + "|" + clientCreateId);
  let record = await getDoc(CREATES, createId);
  if (!record) {
    const sid = randomId("u");
    const requestedPanorama = Boolean(event.media && event.media.panorama);
    const panoramaExtension = requestedPanorama
      ? extensionFor(event.media && event.media.panoramaFormat || "jpeg") : "";
    const stamp = nowIso();
    const space = {
      createRecordId: createId,
      ownerOpenid: openid,
      clientCreateId,
      title: cleanText(event.title, 32, "未命名空间"),
      date: cleanText(event.date, 32),
      place: cleanText(event.place, 80),
      scene: cleanText(event.scene, 24),
      subtitle: cleanText(event.subtitle, 120),
      status: "draft",
      collectionStatus: "open",
      requestedPanorama,
      panoramaCloudPath: requestedPanorama
        ? "unseen/v1/staging/" + sid + "/panorama." + panoramaExtension : "",
      photos: [],
      createdAt: stamp,
      updatedAt: stamp
    };
    const candidate = { _id: createId, sid, ownerOpenid: openid, space, createdAt: stamp };
    try {
      await db.collection(CREATES).add({ data: candidate });
      record = candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      record = await getDoc(CREATES, createId);
    }
  }
  invariant(record && record.sid && record.space, "CREATE_RETRY_FAILED", "创建重试状态不完整，请稍后重试", 500);
  let space = await getDoc(SPACES, record.sid);
  if (!space) {
    const spaceData = { ...record.space };
    delete spaceData._id;
    await db.collection(SPACES).doc(record.sid).set({ data: spaceData });
    space = { ...spaceData, _id: record.sid };
  }
  invariant(space.ownerOpenid === openid, "AUTH_FAILED", "创建身份不一致", 403);
  return {
    spaceId: space._id,
    status: space.status,
    panoramaCloudPath: space.requestedPanorama ? space.panoramaCloudPath : "",
    manifest: space.status === "published" ? await publicSpace(space) : null
  };
}

async function finalizeSpace(event, openid) {
  const sid = validateSid(event.spaceId);
  const space = await getDoc(SPACES, sid);
  invariant(space, "SPACE_NOT_FOUND", "没有找到这个空间", 404);
  invariant(space.ownerOpenid === openid, "HOST_AUTH_FAILED", "只有创建者可以发布空间", 403);
  if (space.status === "published") return { spaceId: sid, status: "published", manifest: await publicSpace(space) };
  let panorama = null;
  const fileID = cleanText(event.panoramaFileID, 1024);
  if (space.requestedPanorama) {
    invariant(fileID, "PANORAMA_REQUIRED", "全景图尚未上传，空间没有发布", 422);
    assertExactFile(fileID, space.panoramaCloudPath);
    try {
      const inspected = await inspectCloudFile(fileID, "panorama");
      panorama = { fileID, width: inspected.width, height: inspected.height,
        size: inspected.size, format: inspected.format };
    } catch (error) {
      await deleteFiles([fileID]);
      throw error;
    }
  } else {
    invariant(!fileID, "MEDIA_NOT_REQUESTED", "这个空间没有申请上传全景图", 422);
  }
  const stamp = nowIso();
  await db.collection(SPACES).doc(sid).update({ data: {
    status: "published", panorama: db.command.set(panorama), updatedAt: stamp
  } });
  const published = { ...space, status: "published", panorama, updatedAt: stamp };
  return { spaceId: sid, status: "published", manifest: await publicSpace(published) };
}

async function getSpace(event) {
  const sid = validateSid(event.spaceId);
  const space = await getDoc(SPACES, sid);
  invariant(space && space.status === "published", "SPACE_NOT_FOUND", "没有找到这个空间", 404);
  return { manifest: await publicSpace(space) };
}

async function cleanupStaleReservations(sid) {
  const result = await db.collection(SLOTS).where({ sid }).limit(MAX_PHOTOS).get();
  const now = Date.now();
  for (const slot of result && result.data || []) {
    if (slot.status === "pending" && Number(slot.expiresAt) <= now) {
      const upload = slot.uploadId ? await getDoc(UPLOADS, slot.uploadId) : null;
      await deleteFiles([upload && upload.fileID]);
      if (slot.uploadId) await db.collection(UPLOADS).doc(slot.uploadId).remove().catch(() => {});
      await db.collection(SLOTS).doc(slot._id).remove().catch(() => {});
    }
  }
}

async function preparePhoto(event, openid) {
  const sid = validateSid(event.spaceId);
  const clientUploadId = validateClientId(event.clientUploadId, "upload");
  const uploadId = digest("upload|" + sid + "|" + openid + "|" + clientUploadId);
  let upload = await getDoc(UPLOADS, uploadId);
  if (upload) {
    return {
      spaceId: sid, clientUploadId, photoId: upload.photoId,
      cloudPath: upload.cloudPath, committed: upload.status === "committed",
      photo: upload.status === "committed" ? upload.photo : null
    };
  }
  const space = await getDoc(SPACES, sid);
  invariant(space && space.status === "published", "SPACE_NOT_FOUND", "没有找到这个空间", 404);
  invariant(space.collectionStatus !== "closed", "COLLECTION_CLOSED", "这个空间已停止收集照片", 409);
  await cleanupStaleReservations(sid);

  const photoId = "p_" + digest(uploadId, 24);
  const cloudPath = "unseen/v1/uploads/" + sid + "/" + photoId + ".jpg";
  let slotId = "";
  for (let index = 0; index < MAX_PHOTOS; index += 1) {
    const candidate = sid + "_" + String(index).padStart(2, "0");
    try {
      await db.collection(SLOTS).add({ data: {
        _id: candidate, sid, index, uploadId, uploaderOpenid: openid,
        status: "pending", expiresAt: Date.now() + UPLOAD_TTL_MS, createdAt: nowIso()
      } });
      slotId = candidate;
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  invariant(slotId, "CAPACITY_FULL", "这个空间的照片名额已满", 409);
  const candidateUpload = {
    _id: uploadId, sid, slotId, clientUploadId, uploaderOpenid: openid,
    photoId, cloudPath, contributor: cleanText(event.contributor, 40, "微信参与者"),
    caption: cleanText(event.caption, 160), status: "pending",
    expiresAt: Date.now() + UPLOAD_TTL_MS, createdAt: nowIso(), updatedAt: nowIso()
  };
  try {
    await db.collection(UPLOADS).add({ data: candidateUpload });
    upload = candidateUpload;
  } catch (error) {
    await db.collection(SLOTS).doc(slotId).remove().catch(() => {});
    if (!isAlreadyExists(error)) throw error;
    upload = await getDoc(UPLOADS, uploadId);
  }
  invariant(upload, "UPLOAD_PREPARE_FAILED", "上传任务创建失败，请重试", 500);
  return { spaceId: sid, clientUploadId, photoId: upload.photoId,
    cloudPath: upload.cloudPath, committed: upload.status === "committed",
    photo: upload.status === "committed" ? upload.photo : null };
}

async function commitPhoto(event, openid) {
  const sid = validateSid(event.spaceId);
  const clientUploadId = validateClientId(event.clientUploadId, "upload");
  const uploadId = digest("upload|" + sid + "|" + openid + "|" + clientUploadId);
  let upload = await getDoc(UPLOADS, uploadId);
  invariant(upload, "UPLOAD_NOT_PREPARED", "上传任务不存在或已过期，请重试", 404);
  if (upload.status === "committed") return { spaceId: sid, photo: upload.photo, idempotent: true };
  invariant(Number(upload.expiresAt) > Date.now(), "UPLOAD_EXPIRED", "上传任务已过期，请重试", 410);
  const fileID = cleanText(event.fileID, 1024);
  invariant(fileID, "FILE_REQUIRED", "照片尚未上传", 422);
  assertExactFile(fileID, upload.cloudPath);
  let inspected;
  try {
    inspected = await inspectCloudFile(fileID, "photo");
  } catch (error) {
    await deleteFiles([fileID]);
    await db.collection(UPLOADS).doc(uploadId).remove().catch(() => {});
    await db.collection(SLOTS).doc(upload.slotId).remove().catch(() => {});
    throw error;
  }
  const photo = {
    id: upload.photoId, fileID, width: inspected.width, height: inspected.height,
    size: inspected.size, format: inspected.format, contributor: upload.contributor,
    caption: upload.caption, createdAt: nowIso()
  };
  const transactionResult = await db.runTransaction(async (transaction) => {
    const currentUploadResult = await transaction.collection(UPLOADS).doc(uploadId).get();
    const currentUpload = currentUploadResult && currentUploadResult.data;
    invariant(currentUpload, "UPLOAD_NOT_PREPARED", "上传任务不存在或已过期，请重试", 404);
    if (currentUpload.status === "committed") return { photo: currentUpload.photo, idempotent: true };
    const currentSpaceResult = await transaction.collection(SPACES).doc(sid).get();
    const currentSpace = currentSpaceResult && currentSpaceResult.data;
    invariant(currentSpace && currentSpace.status === "published", "SPACE_NOT_FOUND", "没有找到这个空间", 404);
    const photos = Array.isArray(currentSpace.photos) ? currentSpace.photos.slice() : [];
    if (!photos.some((item) => item.id === photo.id)) photos.push(photo);
    invariant(photos.length <= MAX_PHOTOS, "CAPACITY_FULL", "这个空间的照片名额已满", 409);
    await transaction.collection(SPACES).doc(sid).update({ data: { photos, updatedAt: nowIso() } });
    await transaction.collection(UPLOADS).doc(uploadId).update({ data: {
      status: "committed", fileID, photo, updatedAt: nowIso()
    } });
    await transaction.collection(SLOTS).doc(currentUpload.slotId).update({ data: {
      status: "committed", fileID, updatedAt: nowIso()
    } });
    return { photo, idempotent: false };
  });
  const committed = transactionResult && transactionResult.result !== undefined
    ? transactionResult.result : transactionResult;
  return { spaceId: sid, photo: committed.photo, idempotent: Boolean(committed.idempotent) };
}

async function listMySpaces(openid) {
  const result = await db.collection(SPACES).where({ ownerOpenid: openid }).limit(30).get();
  const spaces = (result && result.data || []).filter((space) => space.status === "published")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const manifests = [];
  for (const space of spaces) manifests.push(await publicSpace(space));
  return { spaces: manifests };
}

async function deleteOwnedSpace(event, openid) {
  const sid = validateSid(event.spaceId);
  const space = await getDoc(SPACES, sid);
  if (!space) return { spaceId: sid, deleted: true, idempotent: true };
  invariant(space.ownerOpenid === openid, "HOST_AUTH_FAILED", "只有创建者可以删除空间", 403);
  const uploadsResult = await db.collection(UPLOADS).where({ sid }).limit(MAX_PHOTOS).get();
  const slotsResult = await db.collection(SLOTS).where({ sid }).limit(MAX_PHOTOS).get();
  const uploads = uploadsResult && uploadsResult.data || [];
  const slots = slotsResult && slotsResult.data || [];
  await deleteFiles([
    space.panorama && space.panorama.fileID,
    ...(Array.isArray(space.photos) ? space.photos.map((photo) => photo.fileID) : []),
    ...uploads.map((upload) => upload.fileID)
  ]);
  await Promise.all(uploads.map((upload) => db.collection(UPLOADS).doc(upload._id).remove().catch(() => {})));
  await Promise.all(slots.map((slot) => db.collection(SLOTS).doc(slot._id).remove().catch(() => {})));
  if (space.createRecordId) {
    await db.collection(CREATES).doc(space.createRecordId).remove().catch(() => {});
  }
  await db.collection(SPACES).doc(sid).remove();
  return { spaceId: sid, deleted: true, idempotent: false };
}

async function route(event, openid) {
  switch (cleanText(event && event.action, 40)) {
    case "health": return { service: "unseen-native-cloud", version: 1, environment: "native" };
    case "createSpace": return createSpace(event, openid);
    case "finalizeSpace": return finalizeSpace(event, openid);
    case "getSpace": return getSpace(event);
    case "preparePhoto": return preparePhoto(event, openid);
    case "commitPhoto": return commitPhoto(event, openid);
    case "listMySpaces": return listMySpaces(openid);
    case "deleteOwnedSpace": return deleteOwnedSpace(event, openid);
    default: throw new AppError("UNKNOWN_ACTION", "无法识别的操作", 404);
  }
}

exports.main = async (event) => {
  try {
    await ensureCollections();
    const openid = requireOpenId(event);
    return { ok: true, data: await route(event || {}, openid) };
  } catch (error) {
    const known = error instanceof AppError;
    if (!known) console.error("[UNSEEN_NATIVE] unexpected", {
      name: cleanText(error && error.name, 80),
      message: cleanText(error && (error.errMsg || error.message), 240)
    });
    return {
      ok: false,
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "云端服务暂时不可用，请稍后重试",
        retryable: known ? error.statusCode >= 500 || [409, 410, 429].includes(error.statusCode) : true
      }
    };
  }
};

exports._test = {
  digest, extensionFor, fileCloudPath, validateClientId, validateSid,
  inspectImage
};
