"use strict";

var util = require("../../utils/util.js");

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    sid: "",
    loading: true,
    loadError: "",
    space: null,
    photoCount: 0,
    pendingCount: 0,
    localOnly: false,
    canShare: false,
    offline: false,
    metaLine: ""
  },

  onLoad: function (options) {
    var nav = getApp().globalData.nav || {};
    var sid = util.resolveSid(options);
    this._skipNextShow = true;
    this.setData({
      sid: sid,
      navBarTop: nav.barTop || 20,
      navBarHeight: nav.barHeight || 44
    });
    if (wx.hideShareMenu) wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
    this.loadSpace();
  },

  onShow: function () {
    if (this._skipNextShow) {
      this._skipNextShow = false;
      return;
    }
    if (this.data.sid && this.data.space) this.loadSpace();
  },

  onUnload: function () {
    this._destroyed = true;
    this._loadToken = (this._loadToken || 0) + 1;
  },

  loadSpace: function () {
    var self = this;
    var token = (self._loadToken || 0) + 1;
    self._loadToken = token;
    self.setData({ loading: true, loadError: "" });
    util.loadSpace(self.data.sid, function (err, space) {
      if (self._destroyed || token !== self._loadToken) return;
      if (err || !space) {
        self.setData({ loading: false, loadError: (err && err.message) || "空间暂时打不开" });
        return;
      }
      self.setData({
        loading: false,
        loadError: "",
        space: space,
        photoCount: (space.photos || []).length,
        pendingCount: (space.pending || []).length,
        localOnly: !!space.localOnly,
        canShare: !space.localOnly,
        offline: !!space.offline,
        metaLine: [space.date, space.place, space.scene].filter(function (value) { return !!value; }).join(" · ")
      });
      if (space.localOnly) {
        if (wx.hideShareMenu) wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
      } else if (wx.showShareMenu) {
        wx.showShareMenu({ menus: ["shareAppMessage"] });
      }
    }, !!self.data.space);
  },

  onUploadPhotos: function () {
    wx.navigateTo({ url: util.pageUrl("photos", this.data.sid, { upload: 1 }) });
  },

  onTimeline: function () {
    wx.navigateTo({ url: util.pageUrl("photos", this.data.sid) });
  },

  onPanorama: function () {
    if (this.data.space && this.data.space.panorama) {
      wx.navigateTo({ url: util.pageUrl("pano", this.data.sid) });
    }
  },

  onRetry: function () { this.loadSpace(); },

  onShareAppMessage: function () {
    if (!this.data.canShare || !this.data.sid) {
      return { title: "UNSEEN 共同记忆空间", path: "/pages/index/index" };
    }
    return {
      title: (this.data.space && this.data.space.title || "共同记忆空间") + " · 邀请你补充照片",
      path: util.pageUrl("space", this.data.sid)
    };
  },

  onBack: function () {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/index/index" });
  }
});
