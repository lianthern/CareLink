"use strict";

var STORE_KEY = "unseen_local_spaces_v2";
var HOST_KEYS_KEY = "unseen_host_credentials_v1";
var MAX_SPACES = 30;

function nowIso() { return new Date().toISOString(); }

function makeId(prefix) {
  return (prefix || "local") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function makeClientId(prefix, callback) {
  var done = typeof callback === "function" ? callback : function () {};
  if (!wx.getRandomValues) {
    done(new Error("当前微信版本不支持安全随机数，请升级微信后重试"));
    return;
  }
  try {
    wx.getRandomValues({
      length: 18,
      success: function (res) {
        var bytes = new Uint8Array(res.randomValues || new ArrayBuffer(0));
        if (bytes.length !== 18) {
          done(new Error("安全随机标识生成失败，请重试"));
          return;
        }
        var hex = "";
        for (var index = 0; index < bytes.length; index += 1) hex += (bytes[index] + 256).toString(16).slice(-2);
        done(null, String(prefix || "client") + "-" + hex);
      },
      fail: function () { done(new Error("安全随机标识生成失败，请重试")); }
    });
  } catch (error) {
    done(new Error("安全随机标识生成失败，请重试"));
  }
}

function readAll() {
  try {
    var value = wx.getStorageSync(STORE_KEY);
    return Array.isArray(value) ? value : [];
  } catch (e) {
    return [];
  }
}

function writeAll(spaces) {
  wx.setStorageSync(STORE_KEY, spaces.slice(0, MAX_SPACES));
}

function listSpaces() {
  return readAll().slice().sort(function (a, b) {
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

function getSpace(sid) {
  return readAll().filter(function (space) { return space.id === sid; })[0] || null;
}

function remoteSnapshot(space) {
  return {
    id: String(space.id || ""),
    localOnly: false,
    remoteRecord: true,
    title: String(space.title || "共享空间"),
    date: String(space.date || ""),
    place: String(space.place || ""),
    scene: String(space.scene || ""),
    subtitle: String(space.subtitle || ""),
    createdAt: space.createdAt || nowIso(),
    updatedAt: space.updatedAt || nowIso(),
    panorama: space.panorama ? {
      src: space.panorama.src || "",
      fallbackSrc: space.panorama.fallbackSrc || "",
      thumbSrc: space.panorama.thumbSrc || space.panorama.src || "",
      width: Number(space.panorama.width) || 0,
      height: Number(space.panorama.height) || 0
    } : null,
    photos: (space.photos || []).map(function (photo) {
      return {
        id: photo.id || photo.clientUploadId || photo.src,
        src: photo.src || photo.thumb || "",
        originalSrc: photo.originalSrc || photo.src || "",
        createdAt: photo.createdAt || photo.capturedAt || "",
        contributor: photo.contributor || "空间参与者"
      };
    }),
    pending: Array.isArray(space.pending) ? space.pending.slice() : [],
    collection: space.collection || null,
    capacity: space.capacity || null
  };
}

function upsertRemoteSpace(space) {
  var safe = remoteSnapshot(space || {});
  if (!/^u[a-f0-9]{24}$/.test(safe.id) && !/^[A-Za-z0-9._:-]{1,128}$/.test(safe.id)) {
    throw new Error("云端空间编号无效");
  }
  var spaces = readAll();
  var previous = spaces.filter(function (item) { return item.id === safe.id; })[0];
  if (previous && previous.localOnly) throw new Error("本机空间编号冲突");
  spaces = spaces.filter(function (item) { return item.id !== safe.id; });
  safe.createdAt = safe.createdAt || previous && previous.createdAt || nowIso();
  safe.updatedAt = nowIso();
  spaces.unshift(safe);
  writeAll(spaces);
  return safe;
}

function readHostKeys() {
  try {
    var value = wx.getStorageSync(HOST_KEYS_KEY);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (e) {
    return {};
  }
}

function setHostKey(sid, hostKey) {
  sid = String(sid || "");
  hostKey = String(hostKey || "");
  if (!/^u[a-f0-9]{24}$/.test(sid) || !/^h_[A-Za-z0-9_-]{16,254}$/.test(hostKey)) {
    throw new Error("主办方凭证格式无效");
  }
  var values = readHostKeys();
  values[sid] = hostKey;
  wx.setStorageSync(HOST_KEYS_KEY, values);
}

function getHostKey(sid) {
  return String(readHostKeys()[String(sid || "")] || "");
}

function removeHostKey(sid) {
  var values = readHostKeys();
  if (!Object.prototype.hasOwnProperty.call(values, sid)) return;
  delete values[sid];
  wx.setStorageSync(HOST_KEYS_KEY, values);
}

function createSpace(input) {
  var spaces = readAll();
  if (spaces.length >= MAX_SPACES) {
    throw new Error("本机最多保存 30 个空间，请先清理旧空间后再创建");
  }
  var stamp = nowIso();
  var space = {
    id: makeId("space"),
    localOnly: true,
    title: String((input && input.title) || "未命名空间").trim() || "未命名空间",
    date: String((input && input.date) || ""),
    place: String((input && input.place) || ""),
    scene: String((input && input.scene) || ""),
    createdAt: stamp,
    updatedAt: stamp,
    panorama: (input && input.panorama) || null,
    photos: []
  };
  spaces.unshift(space);
  writeAll(spaces);
  return space;
}

function addPhoto(sid, photo) {
  var spaces = readAll();
  var hit = null;
  spaces.forEach(function (space) {
    if (space.id !== sid) return;
    var photos = Array.isArray(space.photos) ? space.photos : [];
    var existing = photos.filter(function (item) {
      return item.clientUploadId === photo.clientUploadId;
    })[0];
    if (existing) {
      hit = existing;
      return;
    }
    hit = {
      id: photo.clientUploadId || makeId("photo"),
      clientUploadId: photo.clientUploadId || makeId("upload"),
      src: photo.src,
      width: photo.width || 0,
      height: photo.height || 0,
      size: photo.size || 0,
      capturedAt: photo.capturedAt || nowIso(),
      createdAt: nowIso()
    };
    photos.unshift(hit);
    space.photos = photos;
    space.updatedAt = nowIso();
  });
  if (!hit) throw new Error("空间不存在");
  writeAll(spaces);
  return hit;
}

function setPanorama(sid, panorama) {
  var spaces = readAll();
  var found = false;
  spaces.forEach(function (space) {
    if (space.id === sid) {
      space.panorama = panorama || null;
      space.updatedAt = nowIso();
      found = true;
    }
  });
  if (!found) throw new Error("空间不存在");
  writeAll(spaces);
}

function removableFilePaths(space) {
  var paths = [];
  function add(path) {
    path = String(path || "");
    if (!path || /^(https?:|data:|cloud:)/i.test(path) || paths.indexOf(path) >= 0) return;
    paths.push(path);
  }
  var panorama = space && space.panorama;
  if (panorama) {
    add(panorama.src);
    add(panorama.fallbackSrc);
    add(panorama.thumbSrc);
  }
  ((space && space.photos) || []).forEach(function (photo) {
    add(photo && photo.src);
    add(photo && photo.originalSrc);
    add(photo && photo.thumb);
  });
  return paths;
}

function removeSavedFile(filePath, callback) {
  var done = typeof callback === "function" ? callback : function () {};
  try {
    if (wx.removeSavedFile) {
      wx.removeSavedFile({
        filePath: filePath,
        success: function () { done(null); },
        fail: function (err) { done(err || new Error("文件清理失败")); }
      });
      return;
    }
    var manager = wx.getFileSystemManager && wx.getFileSystemManager();
    if (manager && manager.unlink) {
      manager.unlink({
        filePath: filePath,
        success: function () { done(null); },
        fail: function (err) { done(err || new Error("文件清理失败")); }
      });
      return;
    }
  } catch (e) {
    done(e);
    return;
  }
  done(new Error("当前微信版本不支持清理本机文件"));
}

function deleteSpace(sid, callback) {
  var done = typeof callback === "function" ? callback : function () {};
  var spaces = readAll();
  var target = spaces.filter(function (space) { return space.id === sid; })[0];
  if (!target) {
    done(new Error("空间不存在"));
    return false;
  }
  try {
    writeAll(spaces.filter(function (space) { return space.id !== sid; }));
    if (!target.localOnly) removeHostKey(sid);
  } catch (e) {
    done(e);
    return false;
  }

  if (!target.localOnly) {
    done(null, { deleted: true, remoteOnly: true, removedFiles: 0, failedFiles: 0 });
    return true;
  }

  var paths = removableFilePaths(target);
  if (!paths.length) {
    done(null, { deleted: true, removedFiles: 0, failedFiles: 0 });
    return true;
  }
  var remaining = paths.length;
  var removed = 0;
  var failed = 0;
  paths.forEach(function (filePath) {
    removeSavedFile(filePath, function (err) {
      if (err) failed += 1;
      else removed += 1;
      remaining -= 1;
      if (!remaining) done(null, { deleted: true, removedFiles: removed, failedFiles: failed });
    });
  });
  return true;
}

function saveTempFile(tempFilePath, callback) {
  if (!tempFilePath) {
    callback(new Error("没有找到临时文件"));
    return;
  }
  var userRoot = wx.env && wx.env.USER_DATA_PATH;
  if (userRoot && tempFilePath.indexOf(userRoot) === 0) {
    callback(null, tempFilePath);
    return;
  }
  try {
    wx.getFileSystemManager().saveFile({
      tempFilePath: tempFilePath,
      success: function (res) { callback(null, res.savedFilePath); },
      fail: function (err) { callback(err || new Error("保存文件失败")); }
    });
  } catch (e) {
    callback(e);
  }
}

module.exports = {
  STORE_KEY: STORE_KEY,
  HOST_KEYS_KEY: HOST_KEYS_KEY,
  makeId: makeId,
  makeClientId: makeClientId,
  listSpaces: listSpaces,
  getSpace: getSpace,
  createSpace: createSpace,
  upsertRemoteSpace: upsertRemoteSpace,
  addPhoto: addPhoto,
  setPanorama: setPanorama,
  setHostKey: setHostKey,
  getHostKey: getHostKey,
  deleteSpace: deleteSpace,
  saveTempFile: saveTempFile,
  _removableFilePaths: removableFilePaths,
  _readAll: readAll,
  _readHostKeys: readHostKeys,
  _removeHostKey: removeHostKey
};
