"use strict";

var PHOTOS = [
  "/assets/demo/photo-1.jpg",
  "/assets/demo/photo-2.jpg",
  "/assets/demo/photo-3.jpg",
  "/assets/demo/photo-4.jpg",
  "/assets/demo/photo-5.jpg",
  "/assets/demo/photo-6.jpg"
];

var ROOMS = [
  { id: "hall", time: "样片 01", chapter: "大厅", title: "入口大厅", subtitle: "真实 CC0 全景 · 环视与钉点测试", image: "/assets/panos/expo.jpg" },
  { id: "cafe", time: "样片 02", chapter: "咖啡馆", title: "舒适咖啡馆", subtitle: "真实 CC0 全景 · 室内尺度测试", image: "/assets/panos/yanxi.jpg" },
  { id: "chapel", time: "样片 03", chapter: "礼堂", title: "日间礼堂", subtitle: "真实 CC0 全景 · 空间边缘测试", image: "/assets/panos/expo.jpg" },
  { id: "ballroom", time: "样片 04", chapter: "宴会厅", title: "古典宴会厅", subtitle: "真实 CC0 全景 · 暗场渲染测试", image: "/assets/panos/s4-n1.jpg" }
];

var AI_SCENES = [
  { id: "n1", number: "01", title: "初见", place: "迎宾庭院", image: "/assets/ai-pano/n1.jpg" },
  { id: "n2", number: "02", title: "誓言", place: "林间仪式", image: "/assets/ai-pano/n2.jpg" },
  { id: "n3", number: "03", title: "共宴", place: "烛光长桌", image: "/assets/ai-pano/n3.jpg" },
  { id: "n4", number: "04", title: "尽兴", place: "星夜派对", image: "/assets/ai-pano/n4.jpg" }
];

var MODES = [
  { id: "journey", title: "婚礼旅程", meta: "地图与四个章节", copy: "沿接亲、出发、仪式和宴席重新走一遍。", icon: "⌁", image: "/assets/panos/yanxi.jpg" },
  { id: "timeline", title: "时光轴", meta: "按时间重温", copy: "同一时刻保留来自不同人的画面。", icon: "◷", image: PHOTOS[1] },
  { id: "album", title: "记忆相册", meta: "照片墙与灯箱", copy: "切回熟悉的相册，同时保留时刻与场景。", icon: "▦", image: PHOTOS[3] },
  { id: "machine", title: "机器回忆", meta: "方向与置信度", copy: "检查照片如何被 AI 归位，哪里仍待复核。", icon: "◎", image: PHOTOS[4] },
  { id: "film", title: "一键成片", meta: "六镜故事板", copy: "短片负责情绪，空间负责继续探索。", icon: "▶", image: PHOTOS[5] }
];

var PITCHES = [
  { id: "judge-story", eyebrow: "2026-07-25 · 原版", title: "六幕评委 Demo", copy: "最早完整跑通问题、归位、缺口和成品叙事。" },
  { id: "roadshow", eyebrow: "现场大屏版", title: "路演现场", copy: "用于活动现场投屏的极简入口和空间实时状态。" },
  { id: "workspace", eyebrow: "概念工作台", title: "空间工作台", copy: "历史上的主办者视角和场景模板概念页。" },
  { id: "pov-research", eyebrow: "研究原版", title: "回到 TA 的视角", copy: "世界锚定、覆盖判断和当时能力边界的原始说明。" },
  { id: "portal", eyebrow: "总入口原版", title: "产品 Showcase", copy: "早期把宾客、主办者和观众三种界面放在同一入口。" }
];

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    rooms: ROOMS,
    aiScenes: AI_SCENES,
    modes: MODES,
    pitches: PITCHES,
    photos: PHOTOS,
    activeMode: "journey",
    activeModeInfo: MODES[0],
    activeRoomIndex: 0,
    activeRoom: ROOMS[0],
    openGroup: "",
    previewVisible: false,
    panoScrollLeft: 0,
    panoDirection: "正前方"
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

  onRoom: function (event) {
    var index = Number(event.currentTarget.dataset.index) || 0;
    this.setData({ activeRoomIndex: index, activeRoom: ROOMS[index] || ROOMS[0], activeMode: "journey", activeModeInfo: MODES[0], openGroup: "reference", previewVisible: true, panoScrollLeft: 0, panoDirection: "正前方" }, this.scrollToPreview.bind(this));
  },

  onMode: function (event) {
    var id = event.currentTarget.dataset.mode || "journey";
    var item = MODES.filter(function (mode) { return mode.id === id; })[0] || MODES[0];
    this.setData({ activeMode: id, activeModeInfo: item, openGroup: "modes", previewVisible: true }, this.scrollToPreview.bind(this));
  },

  onPitch: function (event) {
    var index = Number(event.currentTarget.dataset.index) || 0;
    var item = PITCHES[index] || PITCHES[0];
    wx.navigateTo({ url: "/pages/demo-detail/demo-detail?id=" + encodeURIComponent(item.id) });
  },

  onGroup: function (event) {
    var group = event.currentTarget.dataset.group || "";
    this.setData({ openGroup: this.data.openGroup === group ? "" : group });
  },

  onAiPano: function () {
    wx.navigateTo({ url: "/pages/demo-ai-pano/demo-ai-pano" });
  },

  onDirection: function (event) {
    var index = Number(event.currentTarget.dataset.index) || 0;
    var names = ["正前方", "右侧", "后方", "左侧"];
    this.setData({ panoScrollLeft: index * 420, panoDirection: names[index] });
  },

  scrollToPreview: function () {
    wx.pageScrollTo({ selector: "#archivePreview", duration: 260 });
  },

  onVision: function () {
    wx.navigateTo({ url: "/pages/demo-vision/demo-vision" });
  },

  onStory: function () {
    wx.navigateTo({ url: "/pages/demo-story/demo-story" });
  }
});
