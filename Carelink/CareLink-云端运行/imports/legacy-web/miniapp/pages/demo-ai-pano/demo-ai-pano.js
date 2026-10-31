"use strict";

var SCENES = [
  { id: "n1", number: "01", title: "初见", place: "迎宾庭院", eyebrow: "序章 · 宾客抵达", copy: "柔和的黄昏里，第一批宾客穿过花园。这个场景、空间与人物均由 AI 生成。", image: "/assets/ai-pano/n1.jpg" },
  { id: "n2", number: "02", title: "誓言", place: "林间仪式", eyebrow: "第二幕 · 交换誓言", copy: "树影和花拱门围住仪式中心，演示全景如何承载同一时刻的不同视角。", image: "/assets/ai-pano/n2.jpg" },
  { id: "n3", number: "03", title: "共宴", place: "烛光长桌", eyebrow: "第三幕 · 共宴", copy: "长桌、烛光与远处的朋友构成可环看的晚宴空间。", image: "/assets/ai-pano/n3.jpg" },
  { id: "n4", number: "04", title: "尽兴", place: "星夜派对", eyebrow: "终章 · 星夜派对", copy: "灯串亮起以后，最后一幕把婚礼带到夜色与舞池。", image: "/assets/ai-pano/n4.jpg" }
];

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    scenes: SCENES,
    activeIndex: 0,
    activeScene: SCENES[0],
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
    else wx.reLaunch({ url: "/pages/demo-archive/demo-archive" });
  },

  onScene: function (event) {
    var index = Number(event.currentTarget.dataset.index) || 0;
    this.setData({ activeIndex: index, activeScene: SCENES[index] || SCENES[0], panoScrollLeft: 0, panoDirection: "正前方" });
  },

  onDirection: function (event) {
    var index = Number(event.currentTarget.dataset.index) || 0;
    var names = ["正前方", "右侧", "后方", "左侧"];
    this.setData({ panoScrollLeft: index * 285, panoDirection: names[index] });
  }
});
