"use strict";

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44
  },

  onLoad: function () {
    var app = getApp();
    var nav = app.globalData.nav || {};
    this.setData({
      navBarTop: nav.barTop != null ? nav.barTop : 20,
      navBarHeight: nav.barHeight != null ? nav.barHeight : 44
    });
  },

  onBack: function () {
    var pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/index/index" });
  },

  onVision: function () {
    wx.navigateTo({ url: "/pages/demo-vision/demo-vision" });
  },

  onStory: function () {
    wx.navigateTo({ url: "/pages/demo-story/demo-story" });
  },

  onArchive: function () {
    wx.navigateTo({ url: "/pages/demo-archive/demo-archive" });
  },

  onFormalFlow: function () {
    wx.navigateTo({ url: "/pages/create/create" });
  },

  onCaptureDemo: function () {
    wx.navigateTo({ url: "/pages/capture/capture?source=demo" });
  },

  onSweepDemo: function () {
    wx.navigateTo({ url: "/pages/sweep/sweep?source=demo" });
  },

  onPov: function () {
    wx.navigateTo({ url: "/pages/demo-vision/demo-vision?tab=pov" });
  }
});
