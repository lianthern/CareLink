"use strict";

var SLIDES = [
  { kicker: "第一幕 · 散落", title: "那一天，被留在了很多人的手机里。", copy: "婚礼结束后，新人只拿到了自己看见的那一小部分。朋友们拍下的笑声、拥抱和错过的五分钟，还散在各自的相册里。", quote: "一个人的相册，装不下所有人的同一天。", image: "/assets/demo/photo-1.jpg", tone: "pink", tags: ["我的相册", "朋友的相册"] },
  { kicker: "第二幕 · 归集", title: "不用下载 App，也能把照片放回一起。", copy: "宾客打开同一个空间，上传普通照片或已经拍好的 2:1 全景图。照片属于这一天，而不是某一台手机。", quote: "一个入口，一起补全。", image: "/assets/demo/photo-2.jpg", tone: "gold", tags: ["普通照片", "成品全景"] },
  { kicker: "第三幕 · 空间", title: "不只看见照片，还能重新走进现场。", copy: "时间线回答“发生了什么”，全景回答“当时我在哪里”。两种观看方式放在同一个记忆空间里。", quote: "从相册，变成可以重访的地方。", image: "/assets/panos/s4-n1.jpg", tone: "dark", tags: ["时间线", "全景"] },
  { kicker: "第四幕 · 多视角", title: "同一时刻，每个人都看见了不同的方向。", copy: "UNSEEN 把来自不同人的画面按时间与方向组织起来。点一位拍摄者，就回到 TA 当时朝着的位置。", quote: "你错过的，有人替你留住了。", image: "/assets/demo/photo-3.jpg", tone: "pink", tags: ["小明 · 正前", "小红 · 右侧"] },
  { kicker: "第五幕 · 共同补全", title: "哪里还空着，大家一眼就知道。", copy: "缺少的时刻、空白的方向和等待上传的照片都被整理成清楚的线索，主办者不再逐个私聊收图。", quote: "整理不再是一个人的收尾工作。", image: "/assets/demo/photo-5.jpg", tone: "gold", tags: ["86 张照片", "12 位朋友"] },
  { kicker: "第六幕 · 成片", title: "最后留下的，是一群人的共同记忆。", copy: "照片、全景、时间线和每个人的视角，共同构成一个可以分享、可以重看的空间。", quote: "一台相机记录画面，一群人补全记忆。", image: "/assets/panos/s4-n1.jpg", tone: "dark", tags: ["我们的婚礼", "共同记忆"] }
];

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    slides: SLIDES,
    current: 0,
    nextLabel: "下一幕"
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
    else wx.reLaunch({ url: "/pages/demo/demo" });
  },

  onChange: function (event) {
    var current = event.detail.current || 0;
    this.setData({ current: current, nextLabel: current === SLIDES.length - 1 ? "进入理想成品" : "下一幕" });
  },

  onDot: function (event) {
    this.setData({ current: Number(event.currentTarget.dataset.index) || 0 });
  },

  onPrev: function () {
    if (this.data.current > 0) this.setData({ current: this.data.current - 1, nextLabel: "下一幕" });
  },

  onNext: function () {
    if (this.data.current >= SLIDES.length - 1) {
      wx.navigateTo({ url: "/pages/demo-vision/demo-vision" });
      return;
    }
    var current = this.data.current + 1;
    this.setData({ current: current, nextLabel: current === SLIDES.length - 1 ? "进入理想成品" : "下一幕" });
  }
});
