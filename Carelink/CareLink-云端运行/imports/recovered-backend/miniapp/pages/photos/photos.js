"use strict";

var util = require("../../utils/util.js");
var upload = require("../../utils/upload.js");

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    sid: "",
    title: "照片时间轴",
    localOnly: false,
    loading: true,
    loadError: "",
    timeline: [],
    queue: [],
    busy: false,
    canAdd: true,
    retryCount: 0,
    doneCount: 0
  },

  onLoad: function (options) {
    var nav = getApp().globalData.nav || {};
    var sid = util.resolveSid(options);
    this._autoOpen = String(options && options.upload || "") === "1";
    this._skipNextShow = true;
    this.setData({ sid: sid, navBarTop: nav.barTop || 20, navBarHeight: nav.barHeight || 44 });
    this.bindQueue();
    this.loadSpace();
  },

  onShow: function () {
    if (this._skipNextShow) {
      this._skipNextShow = false;
      return;
    }
    if (this.data.sid) this.loadSpace();
  },

  onUnload: function () {
    this._destroyed = true;
    this._loadToken = (this._loadToken || 0) + 1;
    if (this._unsubscribe) this._unsubscribe();
    if (this._leaveAlertOn && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
  },

  bindQueue: function () {
    var self = this;
    this._unsubscribe = upload.subscribe(this.data.sid, function (items, busy) {
      if (self._destroyed) return;
      var view = items.map(function (item) {
        return {
          clientUploadId: item.clientUploadId,
          status: item.status,
          statusText: upload.statusLabel(item),
          error: item.error,
          name: item.name || "未命名图片",
          retryable: item.retryable !== false,
          removable: !busy && (item.status === "error" || item.status === "done")
        };
      });
      self.setData({
        queue: view,
        busy: busy,
        canAdd: !busy && items.length < upload.MAX_COUNT,
        retryCount: items.filter(function (item) { return item.status === "error" && item.retryable !== false; }).length,
        doneCount: items.filter(function (item) { return item.status === "done"; }).length
      });
      if (busy && !self._leaveAlertOn && wx.enableAlertBeforeUnload) {
        self._leaveAlertOn = true;
        wx.enableAlertBeforeUnload({ message: "照片仍在处理中，确定要离开吗？" });
      } else if (!busy && self._leaveAlertOn && wx.disableAlertBeforeUnload) {
        self._leaveAlertOn = false;
        wx.disableAlertBeforeUnload();
      }
      if (!busy && self._wasBusy) self.loadSpace();
      self._wasBusy = busy;
    });
  },

  loadSpace: function () {
    var self = this;
    var token = (self._loadToken || 0) + 1;
    self._loadToken = token;
    self.setData({ loading: true, loadError: "" });
    util.loadSpace(self.data.sid, function (err, space) {
      if (self._destroyed || token !== self._loadToken) return;
      if (err || !space) {
        self.setData({ loading: false, loadError: (err && err.message) || "时间轴暂时打不开" });
        return;
      }
      var timeline = (space.photos || []).slice().sort(function (a, b) {
        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      }).map(function (photo) {
        return {
          id: photo.id || photo.clientUploadId || photo.src,
          src: photo.src || photo.thumb,
          originalSrc: photo.originalSrc || photo.src,
          day: util.formatDay(photo.createdAt || photo.capturedAt),
          contributor: photo.contributor || (space.localOnly ? "本机上传" : "空间参与者")
        };
      });
      self.setData({
        loading: false,
        loadError: "",
        title: space.title || "照片时间轴",
        localOnly: !!space.localOnly,
        timeline: timeline
      });
      if (self._autoOpen) {
        self._autoOpen = false;
        setTimeout(function () { if (!self._destroyed) self.onUpload(); }, 120);
      }
    }, true);
  },

  onUpload: function () {
    var self = this;
    if (!this.data.canAdd) return;
    upload.startUpload(this.data.sid, function (err) {
      if (self._destroyed) return;
      if (!err || err.code === "CANCELLED") return;
      wx.showToast({ title: err.message || "没有开始上传", icon: "none", duration: 2800 });
    });
  },

  onRetryUploads: function () {
    if (this.data.busy) return;
    var self = this;
    upload.retryFailed(this.data.sid, function (count, err) {
      if (self._destroyed) return;
      if (err) wx.showToast({ title: err.message, icon: "none" });
      else if (!count) wx.showToast({ title: "没有可重试的照片", icon: "none" });
    });
  },

  onRemoveQueueItem: function (event) {
    if (this.data.busy) return;
    upload.removeItem(this.data.sid, event.currentTarget.dataset.id);
  },

  onFinish: function () {
    if (this.data.busy) return;
    upload.finishQueue(this.data.sid);
    this.loadSpace();
    if (this.data.retryCount) wx.showToast({ title: "失败项仍保留，可继续重试", icon: "none" });
  },

  onPreview: function (event) {
    var current = event.currentTarget.dataset.src;
    var urls = this.data.timeline.map(function (photo) { return photo.originalSrc || photo.src; });
    if (current) wx.previewImage({ current: current, urls: urls });
  },

  onRetryLoad: function () { this.loadSpace(); },
  onBack: function () {
    if (this.data.busy) {
      wx.showToast({ title: "照片仍在处理中，请稍候", icon: "none" });
      return;
    }
    wx.navigateBack();
  }
});
