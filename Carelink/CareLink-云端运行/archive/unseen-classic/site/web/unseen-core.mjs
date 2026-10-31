export const DEFAULT_OSS_BASE = "https://psm-advx-2026.oss-cn-hangzhou.aliyuncs.com";
// The managed API lives in one place so deployments never require scattered replacements.
export const UNSEEN_API_URL = "https://unseen-d3gtp0sxh53bbef61-1316841054.ap-shanghai.app.tcloudbase.com/unseen-api";
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const MAX_PANORAMA_BYTES = 50 * 1024 * 1024;
export const MAX_PANORAMA_PIXELS = 8192 * 4096;
export const MAX_BATCH_ITEMS = 9;

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);

function extensionOf(name = "") {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

function ascii(bytes, start, length) {
  if (!bytes || start < 0 || start + length > bytes.length) return "";
  let out = "";
  for (let i = start; i < start + length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

export function looksLikeHeic({ name = "", type = "", bytes = null } = {}) {
  const ext = extensionOf(name);
  const mime = String(type).toLowerCase();
  if (ext === "heic" || ext === "heif" || mime.includes("heic") || mime.includes("heif")) return true;
  if (!bytes || bytes.length < 12 || ascii(bytes, 4, 4) !== "ftyp") return false;

  const brands = [ascii(bytes, 8, 4)];
  for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
    brands.push(ascii(bytes, offset, 4));
  }
  return brands.some((brand) => HEIF_BRANDS.has(brand));
}

export function validatePhotoDescriptor({ name = "", type = "", size = 0, bytes = null } = {}) {
  if (!Number.isFinite(size) || size <= 0) return { ok: false, code: "empty", message: "图片文件为空或已损坏" };
  if (size > MAX_PHOTO_BYTES) return { ok: false, code: "too_large", message: "单张照片不能超过 20 MB" };
  if (looksLikeHeic({ name, type, bytes })) {
    return { ok: false, code: "heic", message: "暂不支持 HEIC/HEIF，请先在相册中导出为 JPEG" };
  }

  const ext = extensionOf(name);
  const mime = String(type).toLowerCase();
  if (!PHOTO_EXTENSIONS.has(ext) && !PHOTO_MIME_TYPES.has(mime)) {
    return { ok: false, code: "unsupported", message: "仅支持 JPEG、PNG 或 WebP 图片" };
  }
  return { ok: true };
}

export function validatePanoramaDescriptor(
  { name = "", type = "", size = 0, bytes = null, width = 0, height = 0 } = {},
) {
  if (!Number.isFinite(size) || size <= 0) return { ok: false, code: "empty", message: "图片文件为空或已损坏" };
  if (size > MAX_PANORAMA_BYTES) {
    return { ok: false, code: "too_large", message: "成品全景图不能超过 50 MB" };
  }
  if (looksLikeHeic({ name, type, bytes })) {
    return { ok: false, code: "heic", message: "暂不支持 HEIC/HEIF，请先在相册中导出为 JPEG" };
  }
  const ext = extensionOf(name);
  const mime = String(type).toLowerCase();
  if (!PHOTO_EXTENSIONS.has(ext) && !PHOTO_MIME_TYPES.has(mime)) {
    return { ok: false, code: "unsupported", message: "仅支持 JPEG、PNG 或 WebP 图片" };
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, code: "dimensions", message: "无法读取图片尺寸，请重新导出后再试" };
  }
  if (width < 1600 || height < 800) {
    return { ok: false, code: "too_small", message: "成品全景图至少需要 1600×800 像素" };
  }
  if (width * height > MAX_PANORAMA_PIXELS) {
    return { ok: false, code: "too_many_pixels", message: "成品全景图像素过高，请导出为不超过 8192×4096 的版本" };
  }
  const ratio = width / height;
  if (ratio < 1.9 || ratio > 2.1) {
    return { ok: false, code: "ratio", message: `这张图的宽高比为 ${ratio.toFixed(2)}，需要接近 2:1` };
  }
  return { ok: true, ratio };
}

export function uploadPolicyStatus(space, nowMs = Date.now()) {
  if (!space || typeof space !== "object") return { ok: false, code: "missing_space", message: "空间数据不可用" };
  if (space.collection?.status === "closed") {
    return { ok: false, code: "closed", message: "这个空间已停止接收照片" };
  }
  const remainingValue = space.capacity?.remaining;
  const hasNoRemaining = remainingValue !== null
    && remainingValue !== undefined
    && remainingValue !== ""
    && Number.isFinite(Number(remainingValue))
    && Number(remainingValue) <= 0;
  if (space.capacity?.full === true || hasNoRemaining) {
    return { ok: false, code: "capacity_full", message: "这个空间的照片容量已满" };
  }
  const upload = space.upload || space.post || space.direct;
  if (!upload || upload.enabled === false) {
    return { ok: false, code: "missing", message: "这个空间还没有配置上传通道" };
  }
  if (upload.mode === "ticket-v1") {
    const endpoint = String(upload.endpoint || "").replace(/\/+$/, "");
    if (endpoint !== UNSEEN_API_URL.replace(/\/+$/, "")) {
      return { ok: false, code: "untrusted_api", message: "空间上传接口不是 UNSEEN 正式服务，已为你阻止" };
    }
    return {
      ok: true,
      mode: "ticket-v1",
      ticket: {
        endpoint,
        maxSize: Number(upload.maxSize) || MAX_PHOTO_BYTES,
      },
    };
  }
  if (!upload.policy) {
    return { ok: false, code: "missing", message: "这个空间还没有配置上传通道" };
  }
  const expiresAtSeconds = Number(upload.expiresAt || space.expiresAt || 0);
  if (expiresAtSeconds && expiresAtSeconds * 1000 <= nowMs) {
    return {
      ok: false,
      code: "expired",
      expiresAt: expiresAtSeconds * 1000,
      message: "上传通道已经过期，请联系空间创建者重新发布",
    };
  }
  const accessKeyId = upload.OSSAccessKeyId || upload.accessKeyId || upload.ossAccessKeyId || "";
  const signature = upload.Signature || upload.signature || "";
  const host = String(upload.host || DEFAULT_OSS_BASE).replace(/\/+$/, "");
  const keyPrefix = upload.keyPrefix || `spaces/${space.id}/inbox/`;
  if (host !== DEFAULT_OSS_BASE) {
    return { ok: false, code: "untrusted_host", message: "上传地址不是 UNSEEN 官方存储，已为你阻止" };
  }
  const expectedPrefix = `spaces/${space.id}/inbox`;
  if (!String(keyPrefix).startsWith(expectedPrefix) || String(keyPrefix).includes("..")) {
    return { ok: false, code: "untrusted_prefix", message: "上传目录与当前空间不一致，已为你阻止" };
  }
  if (!accessKeyId || !signature || !host || !keyPrefix) {
    return { ok: false, code: "incomplete", message: "上传通道配置不完整，请联系空间创建者" };
  }
  return {
    ok: true,
    policy: {
      host,
      accessKeyId,
      signature,
      policy: upload.policy,
      keyPrefix,
      expiresAt: expiresAtSeconds,
      maxSize: Number(upload.maxSize) || 12 * 1024 * 1024,
    },
  };
}

export function exactUploadPolicyStatus(ticket, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  if (!ticket || typeof ticket !== "object") {
    return { ok: false, code: "missing", message: "上传票据缺失，请重试" };
  }
  const host = String(ticket.host || "").replace(/\/+$/, "");
  if (host !== DEFAULT_OSS_BASE) {
    return { ok: false, code: "untrusted_host", message: "上传地址不是 UNSEEN 官方存储，已为你阻止" };
  }
  const expiresAt = Number(ticket.expiresAt || 0);
  if (expiresAt && expiresAt * 1000 <= nowMs) {
    return { ok: false, code: "expired", message: "上传票据已经过期，请重试" };
  }
  const fields = ticket.fields && typeof ticket.fields === "object" ? { ...ticket.fields } : null;
  const key = String(fields?.key || "");
  if (!fields || !key || key.includes("..") || !key.startsWith("unseen-backend/v1/")) {
    return { ok: false, code: "untrusted_key", message: "上传票据的对象路径无效，已为你阻止" };
  }
  if (options.expectedKey && key !== options.expectedKey) {
    return { ok: false, code: "unexpected_key", message: "上传票据与当前素材不一致，已为你阻止" };
  }
  if (options.expectedPrefix && !key.startsWith(options.expectedPrefix)) {
    return { ok: false, code: "unexpected_key", message: "上传票据与当前空间不一致，已为你阻止" };
  }
  for (const name of ["policy", "OSSAccessKeyId", "Signature", "x-oss-object-acl", "success_action_status"]) {
    if (!String(fields[name] || "")) {
      return { ok: false, code: "incomplete", message: "上传票据字段不完整，请重试" };
    }
  }
  if (fields["x-oss-object-acl"] !== "private" || String(fields.success_action_status) !== "200") {
    return { ok: false, code: "untrusted_fields", message: "上传票据的安全字段无效，已为你阻止" };
  }
  return {
    ok: true,
    policy: {
      host,
      expiresAt,
      maxSize: Number(ticket.maxSize) || MAX_PHOTO_BYTES,
      fields,
    },
  };
}

export function parseSpaceTarget(input, fallbackBase = DEFAULT_OSS_BASE) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, message: "请输入空间编号或邀请链接" };
  let sid = raw;
  let base = fallbackBase;

  try {
    const url = new URL(raw);
    sid = url.searchParams.get("s") || url.searchParams.get("space") || "";
    base = url.searchParams.get("b") || fallbackBase;
    if (!sid && url.hash.includes("?")) {
      const hashParams = new URLSearchParams(url.hash.split("?")[1]);
      sid = hashParams.get("s") || hashParams.get("space") || "";
      base = hashParams.get("b") || base;
    }
  } catch {
    // Plain space IDs intentionally fall through.
  }

  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sid)) {
    return { ok: false, message: "空间编号格式不正确" };
  }
  try {
    const baseUrl = new URL(base);
    base = baseUrl.href.replace(/\/+$/, "");
    const localTest = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base);
    if (base !== DEFAULT_OSS_BASE && !localTest) {
      return { ok: false, message: "当前正式版只允许打开 UNSEEN 官方空间" };
    }
  } catch {
    return { ok: false, message: "空间地址格式不正确" };
  }
  return { ok: true, sid, base };
}

export function base64UrlUtf8(value) {
  const text = String(value || "匿名参与者");
  const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text) : null;
  let binary = "";
  if (bytes) {
    for (const byte of bytes) binary += String.fromCharCode(byte);
  } else {
    binary = unescape(encodeURIComponent(text));
  }
  const encoded = typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildOssObjectKey(policy, item, nickname = "匿名参与者") {
  const selectedAt = Number(item.selectedAt) || Date.now();
  const uploadId = String(item.clientUploadId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!uploadId) throw new Error("缺少稳定的上传编号");
  return `${policy.keyPrefix}${selectedAt}_${uploadId}__${base64UrlUtf8(nickname)}__free.jpg`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function createClientUploadId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normaliseSpace(space, sid = "") {
  const nodes = Array.isArray(space?.nodes) ? space.nodes : [];
  const photos = Array.isArray(space?.photos) ? space.photos : [];
  const pending = Array.isArray(space?.pending) ? space.pending : [];
  const firstNode = nodes[0] || {};
  return {
    ...space,
    id: space?.id || sid,
    title: space?.title || space?.couple || "共同记忆空间",
    cover: space?.cover || firstNode.panoMini || firstNode.panorama || "",
    panorama: space?.panorama || firstNode.panorama || "",
    photos,
    pending,
    nodes,
  };
}
