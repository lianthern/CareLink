"use strict";

var util = require("../../utils/util.js");

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    sid: "",
    title: "成品全景",
    panorama: null,
    loading: true,
    loadError: "",
    imageLoaded: false,
    usingFallback: false
  },

  onLoad: function (options) {
    var nav = getApp().globalData.nav || {};
    this.setData({
      sid: util.resolveSid(options),
      navBarTop: nav.barTop || 20,
      navBarHeight: nav.barHeight || 44
    });
    this.loadSpace();
  },

  onUnload: function () {
    this._destroyed = true;
    this._loadToken = (this._loadToken || 0) + 1;
  },

  loadSpace: function () {
    var self = this;
    var token = (self._loadToken || 0) + 1;
    self._loadToken = token;
    self.setData({ loading: true, loadError: "", imageLoaded: false, usingFallback: false });
    util.loadSpace(self.data.sid, function (err, space) {
      if (self._destroyed || token !== self._loadToken) return;
      if (err || !space) {
        self.setData({ loading: false, loadError: (err && err.message) || "空间暂时打不开" });
        return;
      }
      if (!space.panorama || !space.panorama.src) {
        self.setData({ loading: false, title: space.title || "成品全景", loadError: "这个空间没有上传成品全景" });
        return;
      }
      self.setData({ loading: false, title: space.title || "成品全景", panorama: space.panorama });
    });
  },

  onImageLoad: function () {
    if (!this._destroyed) this.setData({ imageLoaded: true });
  },
  onImageError: function () {
    if (this._destroyed) return;
    var panorama = this.data.panorama || {};
    if (!this.data.usingFallback && panorama.fallbackSrc && panorama.fallbackSrc !== panorama.src) {
      var fallback = {};
      Object.keys(panorama).forEach(function (key) { fallback[key] = panorama[key]; });
      fallback.src = panorama.fallbackSrc;
      this.setData({ panorama: fallback, imageLoaded: false, usingFallback: true, loadError: "" });
      return;
    }
    this.setData({ imageLoaded: false, loadError: "全景图片加载失败，请返回后重试" });
  },
  onRetry: function () { this.loadSpace(); },
  onBack: function () { wx.navigateBack(); }
});
