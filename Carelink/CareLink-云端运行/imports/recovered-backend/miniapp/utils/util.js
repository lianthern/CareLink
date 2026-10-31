"use strict";

var store = require("./store.js");
var OSS_BASE = "https://psm-advx-2026.oss-cn-hangzhou.aliyuncs.com";
var API_BASE = "https://unseen-d3gtp0sxh53bbef61-1316841054.ap-shanghai.app.tcloudbase.com/unseen-api";
var NATIVE_CLOUD_ENV = "cloudbase-d0gowqdov1065e179";
var NATIVE_CLOUD_FUNCTION = "unseenNative";
var DEFAULT_SPACE_ID = "s4";
var cache = {};
var NON_RETRYABLE_API_CODES = {
  INVALID_DATE: true,
  INVALID_IDEMPOTENCY_KEY: true,
  INVALID_SPACE_ID: true,
  HOST_AUTH_FAILED: true,
  MEDIA_NOT_REQUESTED: true,
  SPACE_FULL: true,
  COLLECTION_CLOSED: true,
  CAPACITY_FULL: true,
  INVALID_COMMIT_TOKEN: true
};

function makeError(message, code, retryable) {
  var error = new Error(message || "操作失败，请稍后重试");
  error.code = code || "UNKNOWN";
  error.retryable = retryable !== false && !NON_RETRYABLE_API_CODES[error.code];
  return error;
}

function networkErrorFromWx(error, fallbackMessage) {
  var raw = String(error && error.errMsg || error && error.message || error || "");
  if (/url[^\n]*not[^\n]*domain|not in domain list|合法域名|domain list/i.test(raw)) {
    return makeError("小程序服务器域名尚未配置，云端功能暂不可用；请联系管理员，或先使用“仅保存在本机”", "DOMAIN_NOT_CONFIGURED", true);
  }
  if (/timeout/i.test(raw)) {
    return makeError("连接云端超时，请检查网络后重试", "TIMEOUT", true);
  }
  return makeError(fallbackMessage || "网络不可用，尚未完成云端操作", "NETWORK", true);
}

function parseResponseData(value) {
  if (!value || typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch (e) { return null; }
}

function apiAction(action, body, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};
  callback = typeof callback === "function" ? callback : function () {};
  var payload = {};
  Object.keys(body || {}).forEach(function (key) { payload[key] = body[key]; });
  payload.action = action;
  var settled = false;
  var timeoutMs = Number(options.timeout) || 20000;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    callback(makeError("连接微信云开发超时，请检查网络后重试", "TIMEOUT", true));
  }, timeoutMs);

  function settle(error, result) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error, result);
  }
  try {
    if (!wx.cloud || !wx.cloud.callFunction) {
      settle(makeError("当前微信版本不支持云开发，请升级微信后重试", "CLOUD_UNAVAILABLE", false));
      return null;
    }
    return wx.cloud.callFunction({
      name: NATIVE_CLOUD_FUNCTION,
      data: payload,
      config: { env: NATIVE_CLOUD_ENV },
      success: function (res) {
        var response = parseResponseData(res && res.result);
        if (response && response.ok === true) {
          settle(null, response.data || {});
          return;
        }
        var apiError = response && response.error || {};
        var code = String(apiError.code || "CLOUD_RESPONSE_INVALID");
        settle(makeError(apiError.message || "微信云端返回结果不完整，请稍后重试", code,
          apiError.retryable !== false));
      },
      fail: function (err) {
        settle(networkErrorFromWx(err, "微信云开发暂时不可用，尚未完成云端操作"));
      }
    });
  } catch (error) {
    settle(makeError("无法连接微信云开发，请稍后重试", "REQUEST_FAILED", true));
    return null;
  }
}

function uploadNativeFile(filePath, cloudPath, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};
  callback = typeof callback === "function" ? callback : function () {};
  if (!filePath || !/^unseen\/v1\/(staging|uploads)\//.test(String(cloudPath || "")) ||
      String(cloudPath).indexOf("..") >= 0) {
    callback(makeError("云端上传路径无效，已停止上传", "UNTRUSTED_CLOUD_PATH", false));
    return null;
  }
  if (!wx.cloud || !wx.cloud.uploadFile) {
    callback(makeError("当前微信版本不支持云存储，请升级微信后重试", "CLOUD_UNAVAILABLE", false));
    return null;
  }
  var settled = false;
  var task = null;
  var timeoutMs = Number(options.timeout) || 120000;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    try { if (task && task.abort) task.abort(); } catch (e) {}
    callback(makeError("上传超过 " + Math.round(timeoutMs / 1000) + " 秒仍未完成，已停止；请重试", "TIMEOUT", true));
  }, timeoutMs);

  function settle(error, result) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error, result);
  }

  try {
    task = wx.cloud.uploadFile({
      cloudPath: String(cloudPath),
      filePath: filePath,
      config: { env: NATIVE_CLOUD_ENV },
      success: function (res) {
        if (!res || !res.fileID) {
          settle(makeError("微信云存储没有返回文件编号，请重试", "UPLOAD_RESPONSE_INVALID", true));
          return;
        }
        settle(null, { fileID: String(res.fileID), cloudPath: String(cloudPath) });
      },
      fail: function (err) {
        var aborted = /abort/i.test(String(err && err.errMsg || ""));
        settle(aborted
          ? makeError("图片上传已停止，请重试", "ABORTED", true)
          : networkErrorFromWx(err, "网络中断，图片尚未上传；请重试"));
      }
    });
  } catch (error) {
    settle(makeError("无法开始微信云存储上传，请重试", "UPLOAD_FAILED", true));
  }
  return task;
}

function exactUploadPolicy(raw, options) {
  options = options || {};
  if (!raw || typeof raw !== "object" || !raw.fields || typeof raw.fields !== "object") return null;
  var host = String(raw.host || "").replace(/\/+$/, "");
  var fields = {};
  Object.keys(raw.fields).forEach(function (key) { fields[key] = String(raw.fields[key]); });
  var key = String(fields.key || "");
  if (host !== OSS_BASE || key.indexOf("unseen-backend/v1/") !== 0 || key.indexOf("..") >= 0 ||
      !fields.policy || !fields.OSSAccessKeyId || !fields.Signature ||
      fields["x-oss-object-acl"] !== "private" || fields.success_action_status !== "200" ||
      options.expectedKey && key !== options.expectedKey ||
      options.expectedPrefix && key.indexOf(options.expectedPrefix) !== 0) return null;
  return {
    host: host,
    fields: fields,
    key: key,
    expiresAt: Number(raw.expiresAt) || 0,
    maxSize: Number(raw.maxSize) || 0
  };
}

function uploadExactPolicy(filePath, rawPolicy, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};
  callback = typeof callback === "function" ? callback : function () {};
  var policy = exactUploadPolicy(rawPolicy, options);
  if (!policy) {
    callback(makeError("云端返回的上传凭证不完整，已停止上传", "UNTRUSTED_POLICY", false));
    return null;
  }
  if (policy.expiresAt && policy.expiresAt * 1000 <= Date.now()) {
    callback(makeError("云端上传凭证已过期，请重试", "POLICY_EXPIRED", true));
    return null;
  }
  if (options.fileSize && policy.maxSize && Number(options.fileSize) > policy.maxSize) {
    callback(makeError("图片超过云端允许的大小", "TOO_LARGE", false));
    return null;
  }
  var settled = false;
  var task = null;
  var timeoutMs = Number(options.timeout) || 120000;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    try { if (task && task.abort) task.abort(); } catch (e) {}
    callback(makeError("上传超过 " + Math.round(timeoutMs / 1000) + " 秒仍未完成，已停止；请重试", "TIMEOUT", true));
  }, timeoutMs);

  function settle(error, result) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error, result);
  }

  try {
    task = wx.uploadFile({
      url: policy.host,
      filePath: filePath,
      name: "file",
      formData: policy.fields,
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          settle(null, { key: policy.key, statusCode: res.statusCode });
          return;
        }
        var body = String(res.data || "");
        var expired = res.statusCode === 403 || /expir|policy/i.test(body);
        settle(makeError(expired ? "云端上传凭证已过期，请重试" : "图片上传失败（HTTP " + res.statusCode + "）",
          expired ? "POLICY_EXPIRED" : "UPLOAD_HTTP", true));
      },
      fail: function (err) {
        var aborted = /abort/i.test(String(err && err.errMsg || ""));
        settle(aborted
          ? makeError("图片上传已停止，请重试", "ABORTED", true)
          : networkErrorFromWx(err, "网络中断，图片尚未上传；请重试"));
      }
    });
  } catch (error) {
    settle(makeError("无法开始图片上传，请重试", "UPLOAD_FAILED", true));
  }
  return task;
}

function pageUrl(page, sid, extra) {
  var url = "/pages/" + page + "/" + page;
  var query = [];
  if (sid) query.push("sid=" + encodeURIComponent(sid));
  Object.keys(extra || {}).forEach(function (key) {
    if (extra[key] !== undefined && extra[key] !== null && extra[key] !== "") {
      query.push(encodeURIComponent(key) + "=" + encodeURIComponent(extra[key]));
    }
  });
  return url + (query.length ? "?" + query.join("&") : "");
}

function resolveSid(query) {
  return String((query && query.sid) || "").trim();
}

function spaceJsonUrl(sid) {
  return OSS_BASE + "/spaces/" + encodeURIComponent(sid) + "/space.json";
}

function normalizeRemote(sid, raw) {
  var nodes = (raw && raw.nodes) || [];
  var first = nodes[0] || {};
  var originalPanorama = first.panorama || first.pano || first.src || null;
  var miniPanorama = first.panoMini || null;
  var panorama = originalPanorama || miniPanorama;
  var subtitle = (raw && raw.subtitle) || "";
  var sceneMatch = String(subtitle).match(/^场景[:：]\s*(.+)$/);
  return {
    id: sid,
    localOnly: false,
    remoteRecord: true,
    title: (raw && raw.title) || "共享空间",
    date: (raw && raw.date) || "",
    place: (raw && raw.place) || "",
    scene: (raw && raw.scene) || (sceneMatch ? sceneMatch[1] : ""),
    subtitle: subtitle,
    createdAt: raw && raw.createdAt || "",
    updatedAt: raw && raw.updatedAt || "",
    panorama: panorama ? {
      src: panorama,
      fallbackSrc: originalPanorama && miniPanorama && originalPanorama !== miniPanorama ? miniPanorama : "",
      thumbSrc: miniPanorama || panorama,
      width: Number(first.panoramaWidth) || 0,
      height: Number(first.panoramaHeight) || 0
    } : null,
    photos: ((raw && raw.photos) || []).map(function (photo) {
      return {
        id: photo.id || photo.inboxKey || photo.src,
        src: photo.thumb || photo.src,
        originalSrc: photo.src,
        createdAt: photo.createdAt || photo.time || "",
        contributor: photo.contributor || "空间参与者"
      };
    }),
    pending: Array.isArray(raw && raw.pending) ? raw.pending.slice() : [],
    collection: raw && raw.collection || null,
    capacity: raw && raw.capacity || null,
    upload: raw && (raw.upload || raw.post || raw.direct) || null,
    raw: raw
  };
}

function uploadGate(space) {
  var raw = space && (space.raw || space) || {};
  var collection = space && space.collection || raw.collection || {};
  var capacity = space && space.capacity || raw.capacity || {};
  var status = String(collection.status || "").toLowerCase();
  if (collection.closed === true || collection.open === false || status === "closed" || status === "ended") {
    return { ok: false, code: "COLLECTION_CLOSED", message: "这个空间已停止收集照片", retryable: false };
  }
  var hasRemaining = capacity.remaining !== null && capacity.remaining !== undefined && capacity.remaining !== "";
  var remaining = hasRemaining ? Number(capacity.remaining) : null;
  var hasMaximum = capacity.maxPhotos !== null && capacity.maxPhotos !== undefined && capacity.maxPhotos !== "";
  if (!hasRemaining && hasMaximum) {
    remaining = Number(capacity.maxPhotos) - (Number(capacity.received) || 0);
    hasRemaining = true;
  }
  if (capacity.full === true || hasRemaining && (!isFinite(remaining) || remaining <= 0)) {
    return { ok: false, code: "CAPACITY_FULL", message: "这个空间的照片名额已满", retryable: false, remaining: 0 };
  }
  return {
    ok: true,
    remaining: hasRemaining && isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : null
  };
}

function fetchLegacyRemote(sid, callback) {
  wx.request({
    url: spaceJsonUrl(sid) + "?t=" + Date.now(),
    timeout: 12000,
    success: function (res) {
      if (res.statusCode === 200 && res.data && typeof res.data === "object") {
        var space = normalizeRemote(sid, res.data);
        cache[sid] = space;
        try { store.upsertRemoteSpace(space); } catch (e) {}
        callback(null, space);
      } else {
        callback(new Error("没有找到这个空间"));
      }
    },
    fail: function (err) { callback(networkErrorFromWx(err, "网络不可用，无法打开云端空间")); }
  });
}

function fetchRemote(sid, callback) {
  if (!/^u[a-f0-9]{24}$/.test(String(sid || ""))) {
    fetchLegacyRemote(sid, callback);
    return;
  }
  apiAction("getSpace", { spaceId: sid }, { timeout: 20000 }, function (error, result) {
    if (!error && result && result.manifest) {
      var space = normalizeRemote(sid, result.manifest);
      cache[sid] = space;
      try { store.upsertRemoteSpace(space); } catch (e) {}
      callback(null, space);
      return;
    }
    if (error && error.code === "SPACE_NOT_FOUND") {
      fetchLegacyRemote(sid, callback);
      return;
    }
    callback(error || makeError("微信云端空间结果不完整", "CLOUD_RESPONSE_INVALID", true));
  });
}

function loadSpace(sid, callback, force) {
  var local = store.getSpace(sid);
  if (local && local.localOnly) {
    callback(null, local);
    return;
  }
  if (!force && cache[sid]) {
    callback(null, cache[sid]);
    return;
  }
  if (!sid) {
    callback(new Error("空间编号为空"));
    return;
  }
  fetchRemote(sid, function (err, space) {
    if (err && local && !local.localOnly) {
      var fallback = {};
      Object.keys(local).forEach(function (key) { fallback[key] = local[key]; });
      fallback.offline = true;
      callback(null, fallback);
      return;
    }
    callback(err, space);
  });
}

function formatDay(value) {
  var numeric = Number(value);
  if (value !== "" && isFinite(numeric) && numeric > 0 && numeric < 1000000000000) value = numeric * 1000;
  var date = value ? new Date(value) : new Date();
  if (isNaN(date.getTime())) date = new Date();
  return date.getFullYear() + "." + pad2(date.getMonth() + 1) + "." + pad2(date.getDate());
}

function pad2(value) { return value < 10 ? "0" + value : String(value); }

module.exports = {
  OSS_BASE: OSS_BASE,
  API_BASE: API_BASE,
  NATIVE_CLOUD_ENV: NATIVE_CLOUD_ENV,
  NATIVE_CLOUD_FUNCTION: NATIVE_CLOUD_FUNCTION,
  DEFAULT_SPACE_ID: DEFAULT_SPACE_ID,
  pageUrl: pageUrl,
  resolveSid: resolveSid,
  spaceJsonUrl: spaceJsonUrl,
  loadSpace: loadSpace,
  fetchRemote: fetchRemote,
  normalizeRemote: normalizeRemote,
  uploadGate: uploadGate,
  formatDay: formatDay,
  apiAction: apiAction,
  exactUploadPolicy: exactUploadPolicy,
  uploadExactPolicy: uploadExactPolicy,
  uploadNativeFile: uploadNativeFile,
  makeError: makeError,
  networkErrorFromWx: networkErrorFromWx,
  _parseResponseData: parseResponseData
};
