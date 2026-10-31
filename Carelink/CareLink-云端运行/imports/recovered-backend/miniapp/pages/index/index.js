"use strict";

var store = require("../../utils/store.js");
var util = require("../../utils/util.js");
var upload = require("../../utils/upload.js");

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    navKeepoutRight: 100,
    spaces: [],
    scenes: [
      { name: "婚礼", icon: "♡", sub: "同一天的多重视角" },
      { name: "旅行", icon: "⌁", sub: "把沿途收进一个空间" },
      { name: "聚会", icon: "✦", sub: "朋友们共同补全现场" },
      { name: "日常", icon: "○", sub: "留住普通但重要的片刻" }
    ],
    selectedSceneIndex: 0,
    openCode: "",
    opening: false,
    openError: "",
    deletingSid: ""
  },

  onLoad: function () {
    var app = getApp();
    var nav = app.globalData.nav || {};
    this.setData({
      navBarTop: nav.barTop != null ? nav.barTop : 20,
      navBarHeight: nav.barHeight != null ? nav.barHeight : 44,
      navKeepoutRight: nav.keepoutRight != null ? nav.keepoutRight : 100
    });
  },

  onShow: function () { this.refreshSpaces(); },

  onUnload: function () { this._destroyed = true; },

  refreshSpaces: function () {
    var spaces = store.listSpaces().map(function (space) {
      return {
        id: space.id,
        title: space.title,
        date: space.date || util.formatDay(space.createdAt),
        count: (space.photos || []).length,
        cover: space.panorama && (space.panorama.thumbSrc || space.panorama.src),
        localOnly: !!space.localOnly,
        storageLabel: space.localOnly ? "本机" : "云端"
      };
    });
    this.setData({ spaces: spaces });
  },

  onCreate: function () {
    var selected = this.data.scenes[this.data.selectedSceneIndex] || this.data.scenes[0];
    wx.navigateTo({ url: "/pages/create/create?scene=" + encodeURIComponent(selected.name) });
  },

  onDemo: function () {
    wx.navigateTo({ url: "/pages/demo/demo" });
  },

  onSelectScene: function (event) {
    var index = Number(event.currentTarget.dataset.index);
    if (isFinite(index) && index >= 0 && index < this.data.scenes.length) {
      this.setData({ selectedSceneIndex: index });
    }
  },

  onOpenShortcut: function () {
    if (wx.pageScrollTo) wx.pageScrollTo({ selector: "#openSection", duration: 240 });
  },

  onMySpaces: function () {
    if (wx.pageScrollTo) wx.pageScrollTo({ selector: "#spacesSection", duration: 240 });
  },

  onCodeInput: function (event) {
    this.setData({ openCode: event.detail.value, openError: "" });
  },

  onOpenCode: function () {
    var sid = String(this.data.openCode || "").trim();
    if (!sid || this.data.opening) {
      if (!sid) this.setData({ openError: "请输入空间编号" });
      return;
    }
    var self = this;
    self.setData({ opening: true, openError: "" });
    util.loadSpace(sid, function (err, space) {
      if (self._destroyed) return;
      self.setData({ opening: false });
      if (err || !space) {
        self.setData({ openError: (err && err.message) || "没有找到这个空间" });
        return;
      }
      wx.navigateTo({ url: util.pageUrl("space", sid) });
    }, true);
  },

  onOpenLocal: function (event) {
    var sid = event.currentTarget.dataset.sid;
    if (sid && sid !== this.data.deletingSid) wx.navigateTo({ url: util.pageUrl("space", sid) });
  },

  onDeleteLocal: function (event) {
    var sid = event.currentTarget.dataset.sid;
    var title = event.currentTarget.dataset.title || "这个空间";
    if (!sid || this.data.deletingSid) return;
    if (upload.isBusy(sid)) {
      wx.showToast({ title: "照片仍在处理中", icon: "none" });
      return;
    }
    var target = store.getSpace(sid);
    var localOnly = !!(target && target.localOnly);
    var self = this;
    wx.showModal({
      title: localOnly ? "删除本机空间？" : "移除本机记录？",
      content: localOnly
        ? "“" + title + "”中的成品全景和照片会从本机移除，删除后无法恢复。"
        : "只移除“" + title + "”在这台手机上的历史记录和主办方凭证；云端空间与已分享内容不会删除。",
      confirmText: localOnly ? "确认删除" : "确认移除",
      confirmColor: "#B6465D",
      success: function (res) {
        if (!res.confirm || self._destroyed) return;
        self.setData({ deletingSid: sid });
        var started = store.deleteSpace(sid, function (err, result) {
          if (self._destroyed) return;
          self.setData({ deletingSid: "" });
          if (err) {
            wx.showToast({ title: err.message || "删除失败", icon: "none" });
            return;
          }
          self.refreshSpaces();
          if (result && result.failedFiles) console.warn("[UNSEEN] 个别本机文件未能清理", result.failedFiles);
          wx.showToast({ title: localOnly ? "空间已删除" : "记录已移除", icon: "success" });
        });
        if (started) upload.clearSpace(sid);
      }
    });
  }
});
