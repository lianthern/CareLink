"use strict";

var TABS = [
  { id: "overview", label: "空间" },
  { id: "timeline", label: "时间线" },
  { id: "pano", label: "全景" },
  { id: "pov", label: "TA 视角" }
];

var TIMELINE = [
  { time: "17:42", title: "宾客陆续抵达", image: "/assets/demo/photo-1.jpg" },
  { time: "18:08", title: "交换戒指", image: "/assets/demo/photo-2.jpg" },
  { time: "18:09", title: "台下的笑声", image: "/assets/demo/photo-3.jpg" },
  { time: "18:21", title: "朋友们举杯", image: "/assets/demo/photo-4.jpg" },
  { time: "18:23", title: "花童跑过", image: "/assets/demo/photo-5.jpg" },
  { time: "19:06", title: "最后一张合影", image: "/assets/demo/photo-6.jpg" }
];

var POVS = [
  { label: "小明 · 正前方", name: "小明", image: "/assets/demo/photo-2.jpg", title: "交换戒指", copy: "18:08，他站在过道中央，正面看见这一刻。" },
  { label: "小红 · 右侧", name: "小红", image: "/assets/demo/photo-3.jpg", title: "父亲的笑", copy: "18:09，她从右侧桌边拍到了新人没看见的表情。" },
  { label: "阿伟 · 后方", name: "阿伟", image: "/assets/demo/photo-5.jpg", title: "朋友们举杯", copy: "18:21，他转向身后，留下整个朋友桌的欢呼。" },
  { label: "宾客 · 左侧", name: "宾客", image: "/assets/demo/photo-6.jpg", title: "花童跑过", copy: "18:23，这段只存在于左侧宾客的手机里。" }
];

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    tabs: TABS,
    activeTab: "overview",
    timeline: TIMELINE,
    povs: POVS,
    activePovIndex: 0,
    activePov: POVS[0],
    panoScrollLeft: 0,
    panoDirection: "正前方 · 宴会厅"
  },

  onLoad: function (options) {
    var app = getApp();
    var nav = app.globalData.nav || {};
    var requested = options && options.tab;
    var activeTab = TABS.some(function (item) { return item.id === requested; }) ? requested : "overview";
    this.setData({
      navBarTop: nav.barTop != null ? nav.barTop : 20,
      navBarHeight: nav.barHeight != null ? nav.barHeight : 44,
      activeTab: activeTab
    });
  },

  onBack: function () {
    var pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/demo/demo" });
  },

  onTab: function (event) {
    this.setData({ activeTab: event.currentTarget.dataset.tab || "overview" });
  },

  onPov: function (event) {
    var index = Number(event.currentTarget.dataset.index) || 0;
    this.setData({ activePovIndex: index, activePov: POVS[index] || POVS[0] });
  },

  onDirection: function (event) {
    var index = Number(event.currentTarget.dataset.index) || 0;
    var names = ["正前方", "右侧", "后方", "左侧"];
    this.setData({ panoScrollLeft: index * 420, panoDirection: names[index] + " · 宴会厅" });
  },

  onStory: function () {
    wx.navigateTo({ url: "/pages/demo-story/demo-story" });
  }
});
