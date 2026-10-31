"use strict";

var util = require("./util.js");
var store = require("./store.js");
var rules = require("./file-rules.js");

var MAX_COUNT = 9;
var MAX_EDGE = 2560;
var JPEG_QUALITY = 82;
var STORE_KEY = "unseen_upload_queue_v2";
var queues = {};
var active = {};
var listeners = {};
var PERMANENT_ERROR_CODES = {
  SIZE_UNKNOWN: true,
  TOO_LARGE: true,
  HEIC: true,
  FORMAT: true,
  DIMENSIONS: true,
  JPEG_CONVERSION: true,
  UNTRUSTED_POLICY: true,
  COLLECTION_CLOSED: true,
  CAPACITY_FULL: true,
  SPACE_FULL: true,
  INVALID_SPACE_ID: true,
  INVALID_IDEMPOTENCY_KEY: true,
  INVALID_COMMIT_TOKEN: true,
  UNTRUSTED_FILE_ID: true,
  UNTRUSTED_CLOUD_PATH: true,
  UNSUPPORTED_IMAGE: true,
  INVALID_IMAGE: true,
  IMAGE_TOO_LARGE: true
};

function cloneItem(item) {
  return {
    sid: item.sid,
    clientUploadId: item.clientUploadId,
    tempFilePath: item.tempFilePath,
    retryFilePath: item.retryFilePath,
    savedPath: item.savedPath,
    key: item.key,
    inboxKey: item.inboxKey,
    status: item.status,
    error: item.error,
    width: item.width,
    height: item.height,
    size: item.size,
    format: item.format,
    createdAt: item.createdAt,
    remote: item.remote,
    note: item.note,
    name: item.name,
    fileType: item.fileType,
    uploadSize: item.uploadSize,
    errorCode: item.errorCode,
    retryable: item.retryable
  };
}

function restore() {
  var saved = [];
  try { saved = wx.getStorageSync(STORE_KEY) || []; } catch (e) { saved = []; }
  if (!Array.isArray(saved)) return;
  saved.forEach(function (raw) {
    if (!raw || !raw.sid || !raw.clientUploadId) return;
    if (!queues[raw.sid]) queues[raw.sid] = [];
    if (raw.status !== "done" && raw.status !== "error") {
      raw.status = "error";
      raw.error = raw.retryFilePath ? "上次没有完成，可以重试" : "上次没有完成，请重新选择图片";
      raw.errorCode = "INTERRUPTED";
      raw.retryable = !!raw.retryFilePath;
    } else if (raw.status === "error" && raw.retryable === undefined) {
      raw.retryable = !PERMANENT_ERROR_CODES[raw.errorCode] && !!raw.retryFilePath;
    }
    queues[raw.sid].push(raw);
  });
}

function persist() {
  var flat = [];
  Object.keys(queues).forEach(function (sid) {
    queues[sid].slice(0, MAX_COUNT).forEach(function (item) { flat.push(cloneItem(item)); });
  });
  try { wx.setStorageSync(STORE_KEY, flat); } catch (e) {
    console.warn("[UNSEEN] 上传队列无法写入本地存储", e);
  }
}

restore();

function makeError(message, code, retryable) {
  var error = new Error(message);
  error.code = code;
  error.retryable = retryable !== false && !PERMANENT_ERROR_CODES[code];
  return error;
}

function queueOf(sid) {
  if (!queues[sid]) queues[sid] = [];
  return queues[sid];
}

function snapshot(sid) {
  return queueOf(sid).map(function (item) { return cloneItem(item); });
}

function emit(sid) {
  persist();
  (listeners[sid] || []).slice().forEach(function (listener) {
    try { listener(snapshot(sid), !!active[sid]); } catch (e) { console.warn(e); }
  });
}

function subscribe(sid, listener) {
  if (!listeners[sid]) listeners[sid] = [];
  listeners[sid].push(listener);
  listener(snapshot(sid), !!active[sid]);
  return function () {
    listeners[sid] = (listeners[sid] || []).filter(function (item) { return item !== listener; });
  };
}

function statusLabel(item) {
  var labels = {
    pending: "等待处理",
    processing: "处理中",
    uploading: "上传中",
    saving: "保存中",
    done: "已完成",
    error: item.retryable === false ? "无法上传" : "上传失败"
  };
  return labels[item.status] || "等待处理";
}

function isBusy(sid) { return !!active[sid]; }

function update(sid, item, values) {
  Object.keys(values || {}).forEach(function (key) { item[key] = values[key]; });
  emit(sid);
}

function compress(path, width, height, format, localOnly, callback) {
  var longEdge = Math.max(width || 0, height || 0);
  var options = {
    src: path,
    quality: JPEG_QUALITY,
    success: function (res) { callback(null, res.tempFilePath || path); },
    fail: function () {
      if (localOnly || format === "jpeg") {
        callback(null, path);
        return;
      }
      callback(makeError("这张图片未能转换为 JPEG，请先导出为 JPEG 后再上传", "JPEG_CONVERSION", false));
    }
  };
  if (longEdge > MAX_EDGE && width && height) {
    var scale = MAX_EDGE / longEdge;
    options.compressedWidth = Math.round(width * scale);
    options.compressedHeight = Math.round(height * scale);
  }
  try {
    wx.compressImage(options);
  } catch (e) {
    options.fail(e);
  }
}

function keepRetryCopy(item, path) {
  if (!path || item.retryFilePath) return;
  store.saveTempFile(path, function (err, savedPath) {
    if (!err && savedPath) {
      item.retryFilePath = savedPath;
      persist();
    }
  });
}

function discardSavedFile(path) {
  if (!path) return;
  try {
    if (wx.removeSavedFile) {
      wx.removeSavedFile({ filePath: path, fail: function () {} });
    } else {
      var manager = wx.getFileSystemManager && wx.getFileSystemManager();
      if (manager && manager.unlink) manager.unlink({ filePath: path, fail: function () {} });
    }
  } catch (e) {}
}

function releaseRetryCopy(item, keepPath) {
  var path = item.retryFilePath;
  item.retryFilePath = null;
  if (path && path !== keepPath) discardSavedFile(path);
}

function markError(sid, item, message, retryPath, code, retryable) {
  var canRetry = retryable !== false && !PERMANENT_ERROR_CODES[code];
  item.status = "error";
  item.error = message || "处理失败，请重试";
  item.errorCode = code || "UNKNOWN";
  item.retryable = canRetry;
  if (canRetry && retryPath) keepRetryCopy(item, retryPath);
  if (!canRetry) releaseRetryCopy(item);
  emit(sid);
}

function inspectAndCompress(sid, item, localOnly, callback) {
  update(sid, item, { status: "processing", error: null, errorCode: null, retryable: true });
  rules.inspect({
    tempFilePath: item.retryFilePath || item.tempFilePath,
    size: item.size,
    name: item.name,
    fileType: item.fileType
  }, "photo", function (result) {
    if (!result.ok) {
      markError(sid, item, result.message, null, result.code, false);
      callback(makeError(result.message, result.code));
      return;
    }
    item.width = result.width;
    item.height = result.height;
    item.size = result.size;
    item.format = result.format;
    compress(item.retryFilePath || item.tempFilePath, result.width, result.height, result.format, localOnly, function (err, compressedPath) {
      if (err || !compressedPath) {
        var processError = err || makeError("照片处理失败", "PROCESS");
        markError(sid, item, processError.message, item.tempFilePath, processError.code, processError.retryable);
        callback(processError);
        return;
      }
      function withVerifiedFormat() {
        wx.getFileInfo({
          filePath: compressedPath,
          success: function (info) {
            item.uploadSize = Number(info.size) || item.size;
            callback(null, compressedPath);
          },
          fail: function () {
            item.uploadSize = item.size;
            callback(null, compressedPath);
          }
        });
      }
      if (localOnly) {
        withVerifiedFormat();
        return;
      }
      rules.readHeader(compressedPath, function (header) {
        if (!header || header.format !== "jpeg") {
          var formatError = makeError("这张图片未能转换为 JPEG，请先导出为 JPEG 后再上传", "JPEG_CONVERSION", false);
          markError(sid, item, formatError.message, null, formatError.code, false);
          callback(formatError);
          return;
        }
        withVerifiedFormat();
      });
    });
  });
}

function saveLocal(sid, item, compressedPath, callback) {
  update(sid, item, { status: "saving" });
  store.saveTempFile(compressedPath, function (err, savedPath) {
    if (err || !savedPath) {
      markError(sid, item, "本机存储空间不足，照片没有保存", compressedPath, "SAVE", true);
      callback(err || makeError("保存失败", "SAVE"));
      return;
    }
    try {
      store.addPhoto(sid, {
        clientUploadId: item.clientUploadId,
        src: savedPath,
        width: item.width,
        height: item.height,
        size: item.size,
        capturedAt: item.createdAt
      });
      item.savedPath = savedPath;
      releaseRetryCopy(item, savedPath);
      update(sid, item, { status: "done", note: "已保存到本机时间轴" });
      callback(null);
    } catch (saveError) {
      markError(sid, item, "空间记录保存失败，请重试", savedPath, "STORE_RECORD", true);
      callback(saveError);
    }
  });
}

function extractPolicy(space, sid) {
  var up = space && (space.upload || (space.raw && (space.raw.upload || space.raw.post || space.raw.direct)));
  if (!up || up.enabled === false || !up.policy) return null;
  var expiresAt = Number(up.expiresAt) || 0;
  return {
    host: String(up.host || "").replace(/\/+$/, ""),
    accessKeyId: up.OSSAccessKeyId || up.accessKeyId || "",
    policy: up.policy || "",
    signature: up.Signature || up.signature || "",
    keyPrefix: up.keyPrefix || ("spaces/" + sid + "/inbox/"),
    expiresAt: expiresAt,
    maxSize: Number(up.maxSize) || rules.NORMAL_MAX_BYTES
  };
}

function fetchPolicy(sid, callback) {
  util.fetchRemote(sid, function (err, space) {
    if (err) {
      callback(makeError("云端空间暂时无法连接；可以返回首页新建本机空间继续体验", "NETWORK"));
      return;
    }
    var gate = util.uploadGate(space);
    if (!gate.ok) {
      callback(makeError(gate.message, gate.code, gate.retryable));
      return;
    }
    var remoteUpload = space && (space.upload || space.raw && space.raw.upload) || {};
    if (remoteUpload.enabled !== false && remoteUpload.mode === "native-cloud-v1") {
      if (remoteUpload.functionName && remoteUpload.functionName !== util.NATIVE_CLOUD_FUNCTION) {
        callback(makeError("微信云端上传协议无法识别，已停止上传", "UNTRUSTED_POLICY", false));
        return;
      }
      callback(null, {
        mode: "native-cloud-v1",
        remaining: gate.remaining,
        maxSize: Number(remoteUpload.maxSize) || rules.NORMAL_MAX_BYTES
      });
      return;
    }
    if (remoteUpload.enabled !== false && remoteUpload.mode === "ticket-v1") {
      if (remoteUpload.ticketAction && remoteUpload.ticketAction !== "photoTicket" ||
          remoteUpload.commitAction && remoteUpload.commitAction !== "commitPhoto") {
        callback(makeError("云端上传协议无法识别，已停止上传", "UNTRUSTED_POLICY", false));
        return;
      }
      callback(null, {
        mode: "ticket-v1",
        endpoint: util.API_BASE,
        remaining: gate.remaining,
        maxSize: Number(remoteUpload.maxSize) || rules.NORMAL_MAX_BYTES
      });
      return;
    }
    var policy = extractPolicy(space, sid);
    if (!policy || !policy.host || !policy.accessKeyId || !policy.signature) {
      callback(makeError("这个云端空间当前没有开放上传；可以新建本机空间继续体验", "NO_POLICY"));
      return;
    }
    if (policy.host !== util.OSS_BASE || policy.keyPrefix.indexOf("spaces/" + sid + "/inbox") !== 0 || policy.keyPrefix.indexOf("..") >= 0) {
      callback(makeError("云端上传地址与当前空间不一致，已为你阻止", "UNTRUSTED_POLICY", false));
      return;
    }
    if (policy.expiresAt && policy.expiresAt * 1000 <= Date.now()) {
      callback(makeError("云端上传通道已过期；可以返回首页新建本机空间继续体验", "POLICY_EXPIRED"));
      return;
    }
    policy.remaining = gate.remaining;
    policy.mode = "legacy-policy";
    callback(null, policy);
  });
}

function ensureRemoteKey(item, policy) {
  if (!item.inboxKey) item.inboxKey = item.clientUploadId.replace(/^upload-/, "");
  item.key = policy.keyPrefix + item.inboxKey + "__miniapp__free.jpg";
}

function postRemote(sid, item, compressedPath, policy, callback) {
  if (item.uploadSize && policy.maxSize && item.uploadSize > policy.maxSize) {
    markError(sid, item, "照片超过这个空间的上传大小限制", null, "TOO_LARGE", false);
    callback(makeError("文件过大", "TOO_LARGE"));
    return;
  }
  ensureRemoteKey(item, policy);
  update(sid, item, { status: "uploading", remote: true });
  var settled = false;
  var task = null;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    try { if (task && task.abort) task.abort(); } catch (e) {}
    markError(sid, item, "上传超过 70 秒仍未完成，已停止；可以重试", compressedPath, "TIMEOUT", true);
    callback(makeError("上传超时", "TIMEOUT"));
  }, 70000);

  function settle(work) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    work();
  }

  task = wx.uploadFile({
    url: policy.host,
    filePath: compressedPath,
    name: "file",
    formData: {
      key: item.key,
      OSSAccessKeyId: policy.accessKeyId,
      policy: policy.policy,
      Signature: policy.signature,
      "x-oss-object-acl": "private",
      success_action_status: "201"
    },
    success: function (res) {
      settle(function () {
        if (res.statusCode >= 200 && res.statusCode < 300 || res.statusCode === 409) {
          releaseRetryCopy(item);
          update(sid, item, { status: "saving" });
          update(sid, item, { status: "done", note: "已提交，云端时间轴会在处理后刷新" });
          callback(null);
          return;
        }
        var body = String(res.data || "");
        var expired = res.statusCode === 403 || /expir|policy/i.test(body);
        markError(sid, item,
          expired ? "云端上传通道已过期；可以新建本机空间继续体验" : "云端上传失败（HTTP " + res.statusCode + "）",
          compressedPath, expired ? "POLICY_EXPIRED" : "HTTP", true);
        callback(makeError("上传失败", expired ? "POLICY_EXPIRED" : "HTTP"));
      });
    },
    fail: function (err) {
      settle(function () {
        var networkError = util.networkErrorFromWx(err, "网络中断，照片没有上传；可以重试");
        markError(sid, item, networkError.message, compressedPath, networkError.code, networkError.retryable);
        callback(networkError);
      });
    }
  });
}

function postTicketRemote(sid, item, compressedPath, plan, callback) {
  if (item.uploadSize && plan.maxSize && item.uploadSize > plan.maxSize) {
    markError(sid, item, "照片超过这个空间的上传大小限制", null, "TOO_LARGE", false);
    callback(makeError("文件过大", "TOO_LARGE", false));
    return;
  }
  update(sid, item, { status: "uploading", remote: true, note: "正在申请单张上传凭证" });
  util.apiAction("photoTicket", {
    spaceId: sid,
    clientUploadId: item.clientUploadId,
    contributor: "微信参与者",
    caption: ""
  }, { timeout: 20000 }, function (ticketError, ticket) {
    if (ticketError) {
      markError(sid, item, ticketError.message, compressedPath, ticketError.code, ticketError.retryable);
      callback(ticketError);
      return;
    }
    if (ticket && ticket.committed === true) {
      releaseRetryCopy(item);
      update(sid, item, { status: "done", note: "已同步到云端时间轴", error: null, errorCode: null });
      callback(null);
      return;
    }
    if (!ticket || !ticket.upload || !ticket.commitToken) {
      var incomplete = makeError("云端没有返回完整的单张上传凭证，请重试", "TICKET_INCOMPLETE", true);
      markError(sid, item, incomplete.message, compressedPath, incomplete.code, incomplete.retryable);
      callback(incomplete);
      return;
    }
    update(sid, item, { status: "uploading", note: "正在上传到云端" });
    util.uploadExactPolicy(compressedPath, ticket.upload, {
      fileSize: item.uploadSize,
      timeout: 120000,
      expectedPrefix: "unseen-backend/v1/uploads/" + sid + "/"
    }, function (uploadError) {
      if (uploadError) {
        markError(sid, item, uploadError.message, compressedPath, uploadError.code, uploadError.retryable);
        callback(uploadError);
        return;
      }
      update(sid, item, { status: "saving", note: "正在登记到云端时间轴" });
      util.apiAction("commitPhoto", { commitToken: ticket.commitToken }, { timeout: 30000 }, function (commitError, result) {
        if (commitError) {
          markError(sid, item, commitError.message, compressedPath, commitError.code, commitError.retryable);
          callback(commitError);
          return;
        }
        if (!result || !result.photo) {
          var incompleteCommit = makeError("云端登记结果不完整，请重试", "COMMIT_INCOMPLETE", true);
          markError(sid, item, incompleteCommit.message, compressedPath,
            incompleteCommit.code, incompleteCommit.retryable);
          callback(incompleteCommit);
          return;
        }
        releaseRetryCopy(item);
        update(sid, item, {
          status: "done",
          note: "已同步到云端时间轴",
          error: null,
          errorCode: null,
          remotePhotoId: result.photo.id || ""
        });
        callback(null);
      });
    });
  });
}

function postNativeRemote(sid, item, compressedPath, plan, callback) {
  if (item.uploadSize && plan.maxSize && item.uploadSize > plan.maxSize) {
    markError(sid, item, "照片超过这个空间的上传大小限制", null, "TOO_LARGE", false);
    callback(makeError("文件过大", "TOO_LARGE", false));
    return;
  }
  update(sid, item, { status: "uploading", remote: true, note: "正在准备微信云存储" });
  util.apiAction("preparePhoto", {
    spaceId: sid,
    clientUploadId: item.clientUploadId,
    contributor: "微信参与者",
    caption: ""
  }, { timeout: 25000 }, function (prepareError, prepared) {
    if (prepareError) {
      markError(sid, item, prepareError.message, compressedPath, prepareError.code, prepareError.retryable);
      callback(prepareError);
      return;
    }
    if (prepared && prepared.committed === true && prepared.photo) {
      releaseRetryCopy(item);
      update(sid, item, {
        status: "done",
        note: "已同步到微信云端时间轴",
        error: null,
        errorCode: null,
        remotePhotoId: prepared.photo.id || prepared.photoId || ""
      });
      callback(null);
      return;
    }
    if (!prepared || !prepared.cloudPath || !prepared.photoId) {
      var incomplete = makeError("微信云端没有返回完整的上传任务，请重试", "TICKET_INCOMPLETE", true);
      markError(sid, item, incomplete.message, compressedPath, incomplete.code, incomplete.retryable);
      callback(incomplete);
      return;
    }
    update(sid, item, { status: "uploading", note: "正在上传到微信云存储" });
    util.uploadNativeFile(compressedPath, prepared.cloudPath, { timeout: 120000 }, function (uploadError, uploaded) {
      if (uploadError || !uploaded || !uploaded.fileID) {
        var cloudUploadError = uploadError || makeError("微信云存储没有返回文件编号，请重试", "UPLOAD_RESPONSE_INVALID", true);
        markError(sid, item, cloudUploadError.message, compressedPath,
          cloudUploadError.code, cloudUploadError.retryable);
        callback(cloudUploadError);
        return;
      }
      update(sid, item, { status: "saving", note: "正在登记到云端时间轴" });
      util.apiAction("commitPhoto", {
        spaceId: sid,
        clientUploadId: item.clientUploadId,
        fileID: uploaded.fileID
      }, { timeout: 45000 }, function (commitError, result) {
        if (commitError) {
          markError(sid, item, commitError.message, compressedPath, commitError.code, commitError.retryable);
          callback(commitError);
          return;
        }
        if (!result || !result.photo) {
          var incompleteCommit = makeError("微信云端登记结果不完整，请重试", "COMMIT_INCOMPLETE", true);
          markError(sid, item, incompleteCommit.message, compressedPath,
            incompleteCommit.code, incompleteCommit.retryable);
          callback(incompleteCommit);
          return;
        }
        releaseRetryCopy(item);
        update(sid, item, {
          status: "done",
          note: "已同步到微信云端时间轴",
          error: null,
          errorCode: null,
          remotePhotoId: result.photo.id || ""
        });
        callback(null);
      });
    });
  });
}

function processItem(sid, item, localOnly, runState, callback) {
  inspectAndCompress(sid, item, localOnly, function (err, compressedPath) {
    if (err) { callback(); return; }
    if (localOnly) {
      saveLocal(sid, item, compressedPath, function () { callback(); });
      return;
    }
    if (runState.policy) {
      if (runState.policy.mode === "native-cloud-v1") {
        postNativeRemote(sid, item, compressedPath, runState.policy, function () { callback(); });
      } else if (runState.policy.mode === "ticket-v1") {
        postTicketRemote(sid, item, compressedPath, runState.policy, function () { callback(); });
      } else {
        postRemote(sid, item, compressedPath, runState.policy, function () { callback(); });
      }
      return;
    }
    if (runState.policyError) {
      markError(sid, item, runState.policyError.message, compressedPath, runState.policyError.code, runState.policyError.retryable);
      callback();
      return;
    }
    fetchPolicy(sid, function (policyError, policy) {
      if (policyError) {
        runState.policyError = policyError;
        markError(sid, item, policyError.message, compressedPath, policyError.code, policyError.retryable);
        callback();
        return;
      }
      runState.policy = policy;
      if (policy.mode === "native-cloud-v1") {
        postNativeRemote(sid, item, compressedPath, policy, function () { callback(); });
      } else if (policy.mode === "ticket-v1") {
        postTicketRemote(sid, item, compressedPath, policy, function () { callback(); });
      } else {
        postRemote(sid, item, compressedPath, policy, function () { callback(); });
      }
    });
  });
}

function run(sid, items, localOnly, initialState) {
  var index = 0;
  var runState = initialState || {};
  (function next() {
    if (index >= items.length) {
      active[sid] = false;
      emit(sid);
      return;
    }
    processItem(sid, items[index++], localOnly, runState, next);
  })();
}

function displayFileName(file) {
  var raw = String(file && (file.name || file.tempFilePath || file.path) || "");
  var clean = raw.split(/[?#]/)[0];
  var parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || "未命名图片";
}

function chooseAndRun(sid, queue, remaining, localSpace, policy, callback) {
  wx.chooseMedia({
    count: remaining,
    mediaType: ["image"],
    sourceType: ["album"],
    success: function (res) {
      var files = (res && res.tempFiles) || [];
      if (!files.length) {
        active[sid] = false;
        emit(sid);
        callback(makeError("没有选到照片", "CANCELLED"), null);
        return;
      }
      files = files.slice(0, remaining);

      function makeItem(file, clientUploadId) {
        return {
          sid: sid,
          clientUploadId: clientUploadId,
          tempFilePath: file.tempFilePath,
          name: displayFileName(file),
          fileType: file.fileType || file.type || "",
          size: Number(file.size) || 0,
          status: "pending",
          error: null,
          errorCode: null,
          retryable: true,
          createdAt: new Date().toISOString(),
          remote: !localSpace
        };
      }

      function begin(items) {
        items.forEach(function (item) { queue.push(item); });
        emit(sid);
        callback(null, snapshot(sid));
        run(sid, items, !!localSpace, policy ? { policy: policy } : {});
      }

      if (localSpace) {
        begin(files.map(function (file) { return makeItem(file, store.makeId("upload")); }));
        return;
      }
      var items = [];
      var cursor = 0;
      (function nextId() {
        if (cursor >= files.length) {
          begin(items);
          return;
        }
        var file = files[cursor++];
        store.makeClientId("upload", function (idError, clientUploadId) {
          if (idError || !clientUploadId) {
            active[sid] = false;
            emit(sid);
            callback(makeError(idError && idError.message || "无法生成安全的上传标识，请重试", "RANDOM_ID", false), null);
            return;
          }
          items.push(makeItem(file, clientUploadId));
          nextId();
        });
      })();
    },
    fail: function (err) {
      active[sid] = false;
      emit(sid);
      var cancelled = /cancel/i.test(String(err && err.errMsg || ""));
      callback(makeError(cancelled ? "已取消选择" : "无法打开相册，请检查微信相册权限", cancelled ? "CANCELLED" : "CHOOSE_FAILED"), null);
    }
  });
}

function startUpload(sid, callback) {
  if (active[sid]) {
    callback(makeError("照片正在处理中，请不要重复点击", "BUSY"), null);
    return;
  }
  var queue = queueOf(sid);
  var remaining = MAX_COUNT - queue.length;
  if (remaining <= 0) {
    callback(makeError("本轮最多选择 9 张；请先完成或移除队列中的照片", "QUEUE_FULL"), null);
    return;
  }
  active[sid] = true;
  emit(sid);
  var storedSpace = store.getSpace(sid);
  var localSpace = storedSpace && storedSpace.localOnly ? storedSpace : null;
  if (localSpace) {
    chooseAndRun(sid, queue, remaining, localSpace, null, callback);
    return;
  }
  fetchPolicy(sid, function (policyError, policy) {
    if (policyError) {
      active[sid] = false;
      emit(sid);
      callback(policyError, null);
      return;
    }
    var serverRemaining = policy.remaining;
    var allowed = serverRemaining === null || serverRemaining === undefined ? remaining : Math.min(remaining, serverRemaining);
    if (allowed <= 0) {
      active[sid] = false;
      emit(sid);
      callback(makeError("这个空间的照片名额已满", "CAPACITY_FULL", false), null);
      return;
    }
    chooseAndRun(sid, queue, allowed, null, policy, callback);
  });
}

function retryFailed(sid, callback) {
  if (active[sid]) {
    callback(0, makeError("照片正在处理中，请稍候", "BUSY"));
    return;
  }
  var items = queueOf(sid).filter(function (item) {
    return item.status === "error" && item.retryable !== false && !!(item.retryFilePath || item.tempFilePath);
  });
  if (!items.length) { callback(0, null); return; }
  active[sid] = true;
  emit(sid);
  var storedSpace = store.getSpace(sid);
  var localSpace = storedSpace && storedSpace.localOnly ? storedSpace : null;
  function start(itemsToRun, policy) {
    itemsToRun.forEach(function (item) {
      item.error = null;
      item.errorCode = null;
      item.retryable = true;
      item.status = "pending";
    });
    emit(sid);
    run(sid, itemsToRun, !!localSpace, policy ? { policy: policy } : {});
    callback(itemsToRun.length, null);
  }
  if (localSpace) {
    start(items, null);
    return;
  }
  fetchPolicy(sid, function (policyError, policy) {
    if (policyError) {
      items.forEach(function (item) {
        markError(sid, item, policyError.message, item.retryFilePath || item.tempFilePath,
          policyError.code, policyError.retryable);
      });
      active[sid] = false;
      emit(sid);
      callback(0, policyError);
      return;
    }
    var allowed = policy.remaining === null || policy.remaining === undefined ? items.length : Math.min(items.length, policy.remaining);
    start(items.slice(0, allowed), policy);
  });
}

function removeItem(sid, clientUploadId) {
  if (active[sid]) return false;
  queues[sid] = queueOf(sid).filter(function (item) {
    if (item.clientUploadId !== clientUploadId) return true;
    releaseRetryCopy(item, item.savedPath);
    return false;
  });
  emit(sid);
  return true;
}

function finishQueue(sid) {
  if (active[sid]) return false;
  queues[sid] = queueOf(sid).filter(function (item) { return item.status === "error"; });
  emit(sid);
  return true;
}

function clearSpace(sid) {
  if (active[sid]) return false;
  queueOf(sid).forEach(function (item) { releaseRetryCopy(item); });
  queues[sid] = [];
  emit(sid);
  return true;
}

function getMyUploads(sid) { return snapshot(sid); }
function retryQueue(sid) {
  return queueOf(sid).filter(function (item) { return item.status === "error" && item.retryable !== false; });
}

module.exports = {
  MAX_COUNT: MAX_COUNT,
  MAX_EDGE: MAX_EDGE,
  JPEG_QUALITY: JPEG_QUALITY,
  STORE_KEY: STORE_KEY,
  startUpload: startUpload,
  retryFailed: retryFailed,
  retryQueue: retryQueue,
  removeItem: removeItem,
  finishQueue: finishQueue,
  clearSpace: clearSpace,
  getMyUploads: getMyUploads,
  statusLabel: statusLabel,
  isBusy: isBusy,
  subscribe: subscribe,
  extractPolicy: extractPolicy,
  _fetchPolicy: fetchPolicy,
  _displayFileName: displayFileName,
  _ensureRemoteKey: ensureRemoteKey,
  _releaseRetryCopy: releaseRetryCopy,
  _resetForTests: function () { queues = {}; active = {}; listeners = {}; persist(); }
};
