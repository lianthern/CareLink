"use strict";

var rules = require("../../utils/file-rules.js");
var store = require("../../utils/store.js");
var util = require("../../utils/util.js");

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    title: "",
    date: "",
    place: "",
    sceneOptions: ["婚礼", "旅行", "聚会", "日常"],
    sceneIndex: 0,
    panorama: null,
    panoramaError: "",
    panoramaChecking: false,
    submitting: false,
    submitStage: "",
    cloudError: ""
  },

  onLoad: function (options) {
    var nav = getApp().globalData.nav || {};
    var requestedScene = "";
    try { requestedScene = decodeURIComponent(options && options.scene || ""); } catch (e) {}
    var requestedIndex = this.data.sceneOptions.indexOf(requestedScene);
    this.setData({
      navBarTop: nav.barTop || 20,
      navBarHeight: nav.barHeight || 44,
      sceneIndex: requestedIndex >= 0 ? requestedIndex : this.data.sceneIndex
    });
  },

  onUnload: function () {
    this._destroyed = true;
    this._panoramaToken = (this._panoramaToken || 0) + 1;
    try { if (this._cloudUploadTask && this._cloudUploadTask.abort) this._cloudUploadTask.abort(); } catch (e) {}
  },

  onTitleInput: function (event) { this.setData({ title: event.detail.value, cloudError: "" }); },
  onDateChange: function (event) { this.setData({ date: event.detail.value, cloudError: "" }); },
  onPlaceInput: function (event) { this.setData({ place: event.detail.value, cloudError: "" }); },
  onSceneChange: function (event) { this.setData({ sceneIndex: Number(event.detail.value) || 0, cloudError: "" }); },

  onChoosePanorama: function () {
    if (this.data.submitting || this.data.panoramaChecking) return;
    var self = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album"],
      success: function (res) {
        if (self._destroyed) return;
        var file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        var token = (self._panoramaToken || 0) + 1;
        self._panoramaToken = token;
        self.setData({ panoramaError: "", panorama: null, panoramaChecking: true });
        rules.inspect(file, "panorama", function (result) {
          if (self._destroyed || token !== self._panoramaToken) return;
          if (!result.ok) {
            self.setData({ panorama: null, panoramaError: result.message, panoramaChecking: false });
            return;
          }
          self.setData({
            panorama: {
              tempFilePath: file.tempFilePath,
              width: result.width,
              height: result.height,
              size: result.size,
              format: result.format,
              sizeText: (result.size / 1024 / 1024).toFixed(1) + " MB"
            },
            panoramaChecking: false
          });
        });
      },
      fail: function (err) {
        if (self._destroyed) return;
        if (!/cancel/i.test(String(err && err.errMsg || ""))) {
          self.setData({ panoramaError: "无法打开相册，请检查微信相册权限" });
        }
      }
    });
  },

  onRemovePanorama: function () {
    if (!this.data.submitting && !this.data.panoramaChecking) {
      this._panoramaToken = (this._panoramaToken || 0) + 1;
      this.setData({ panorama: null, panoramaError: "" });
    }
  },

  validateForm: function () {
    var title = String(this.data.title || "").trim();
    if (!title) {
      wx.showToast({ title: "请先给空间起个名字", icon: "none" });
      return null;
    }
    if (this.data.panoramaChecking) {
      wx.showToast({ title: "全景图仍在校验，请稍候", icon: "none" });
      return null;
    }
    return {
      title: title,
      date: String(this.data.date || ""),
      place: String(this.data.place || "").trim(),
      scene: this.data.sceneOptions[this.data.sceneIndex] || "日常"
    };
  },

  onSubmit: function () {
    var form = this.validateForm();
    if (!form || this.data.submitting) return;
    var self = this;
    self.setData({ submitting: true, submitStage: "正在连接云端…", cloudError: "" });

    function fail(error) {
      if (self._destroyed) return;
      self._cloudUploadTask = null;
      self.setData({
        submitting: false,
        submitStage: "",
        cloudError: error && error.message || "云端创建没有完成，请检查网络后重试。表单和全景图仍保留。"
      });
    }

    function finishCreation(created) {
      if (self._destroyed) return;
      var sid = String(created && created.spaceId || "");
      if (!sid) {
        fail(new Error("微信云端没有返回空间编号，请重试"));
        return;
      }
      self._cloudSid = sid;

      function finalize(panoramaFileID) {
        if (self._destroyed) return;
        self.setData({ submitStage: "正在发布共享空间…" });
        util.apiAction("finalizeSpace", {
          spaceId: sid,
          panoramaFileID: panoramaFileID || ""
        }, { timeout: 45000 }, function (finalizeError, result) {
          if (self._destroyed) return;
          if (finalizeError || !result || !result.manifest) {
            fail(finalizeError || new Error("空间发布结果不完整，请重试"));
            return;
          }
          try {
            var remote = util.normalizeRemote(sid, result.manifest);
            remote.scene = form.scene;
            store.upsertRemoteSpace(remote);
          } catch (saveError) {
            fail(new Error("空间已在云端发布，但本机历史保存失败；请记下空间编号 " + sid));
            return;
          }
          self._cloudUploadTask = null;
          self.setData({ submitting: false, submitStage: "" });
          wx.redirectTo({ url: util.pageUrl("space", sid) });
        });
      }

      if (created.status === "published" && created.manifest) {
        try {
          var alreadyPublished = util.normalizeRemote(sid, created.manifest);
          alreadyPublished.scene = form.scene;
          store.upsertRemoteSpace(alreadyPublished);
          self.setData({ submitting: false, submitStage: "" });
          wx.redirectTo({ url: util.pageUrl("space", sid) });
        } catch (publishedError) {
          fail(new Error("空间已在云端发布，但本机历史保存失败；请记下空间编号 " + sid));
        }
        return;
      }
      if (!self.data.panorama) {
        finalize("");
        return;
      }
      var cloudPath = String(created.panoramaCloudPath || "");
      if (!cloudPath) {
        fail(new Error("微信云端没有返回全景图上传路径，请重试"));
        return;
      }
      self.setData({ submitStage: "正在上传成品全景…" });
      self._cloudUploadTask = util.uploadNativeFile(self.data.panorama.tempFilePath, cloudPath, {
        timeout: 180000
      }, function (uploadError, uploadResult) {
        self._cloudUploadTask = null;
        if (self._destroyed) return;
        if (uploadError || !uploadResult || !uploadResult.fileID) {
          fail(uploadError);
          return;
        }
        finalize(uploadResult.fileID);
      });
    }

    function createWithId(clientCreateId) {
      self._cloudClientCreateId = clientCreateId;
      util.apiAction("createSpace", {
        clientCreateId: clientCreateId,
        title: form.title,
        date: form.date,
        place: form.place,
        scene: form.scene,
        subtitle: "场景：" + form.scene,
        media: {
          panorama: !!self.data.panorama,
          panoramaFormat: self.data.panorama && self.data.panorama.format || ""
        }
      }, { timeout: 25000 }, function (createError, created) {
        if (self._destroyed) return;
        if (createError || !created) {
          fail(createError || new Error("云端创建没有完成，请重试"));
          return;
        }
        finishCreation(created);
      });
    }

    if (self._cloudClientCreateId) {
      createWithId(self._cloudClientCreateId);
      return;
    }
    store.makeClientId("create", function (idError, clientCreateId) {
      if (self._destroyed) return;
      if (idError || !clientCreateId) {
        fail(idError || new Error("无法生成安全的创建标识，请重试"));
        return;
      }
      createWithId(clientCreateId);
    });
  },

  onSaveLocal: function () {
    var form = this.validateForm();
    if (!form || this.data.submitting) return;
    var self = this;
    self.setData({ submitting: true, submitStage: "正在保存到本机…", cloudError: "" });

    function commit(panorama) {
      if (self._destroyed) return;
      try {
        var space = store.createSpace({
          title: form.title,
          date: form.date,
          place: form.place,
          scene: form.scene,
          panorama: panorama
        });
        self.setData({ submitting: false, submitStage: "" });
        wx.redirectTo({ url: util.pageUrl("space", space.id) });
      } catch (e) {
        self.setData({ submitting: false, submitStage: "" });
        wx.showToast({ title: e.message || "空间没有保存成功，请检查本机存储空间", icon: "none" });
      }
    }

    if (!self.data.panorama) {
      commit(null);
      return;
    }
    store.saveTempFile(self.data.panorama.tempFilePath, function (err, savedPath) {
      if (self._destroyed) return;
      if (err || !savedPath) {
        self.setData({ submitting: false, submitStage: "", panoramaError: "全景图没有保存成功，空间尚未创建" });
        return;
      }
      commit({
        src: savedPath,
        width: self.data.panorama.width,
        height: self.data.panorama.height,
        size: self.data.panorama.size,
        format: self.data.panorama.format
      });
    });
  },

  onBack: function () {
    if (this.data.submitting || this.data.panoramaChecking) {
      wx.showToast({ title: this.data.submitting ? "正在保存空间，请稍候" : "正在校验全景图，请稍候", icon: "none" });
      return;
    }
    wx.navigateBack();
  }
});
