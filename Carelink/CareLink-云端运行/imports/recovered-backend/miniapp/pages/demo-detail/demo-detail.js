"use strict";

var DETAILS = {
  "judge-story": {
    eyebrow: "2026-07-25 · ORIGINAL",
    title: "六幕评委 Demo",
    lead: "最早完整跑通 UNSEEN 叙事的一版：问题、共同归集、空间归位、缺口提示，再到可以重访的成品。",
    accent: "01—06",
    sections: [
      { title: "照片为什么不够", copy: "同一天散落在很多人的手机里，一个人的相册永远缺少别人看见的方向。" },
      { title: "共同空间如何成立", copy: "宾客用同一个入口补全照片，系统按时间、人物与方向把内容放回现场。" },
      { title: "最终成品", copy: "相册、时间线、全景和回到 TA 的视角，不再是四个产品，而是同一个记忆空间。" }
    ],
    action: "打开新版六幕故事",
    route: "/pages/demo-story/demo-story"
  },
  roadshow: {
    eyebrow: "LIVE ROADSHOW",
    title: "路演现场",
    lead: "为大屏讲解准备的极简版本。把产品价值压缩成一句话、一个空间编号和一条可现场演示的路径。",
    accent: "LIVE",
    sections: [
      { title: "一句话", copy: "把散落在每个人手机里的那一天，放回同一个可以再次进入的空间。" },
      { title: "现场路径", copy: "创建空间 → 宾客补全照片 → 查看时间线与全景 → 分享给下一位观众。" },
      { title: "当前结论", copy: "路演稿被保留为叙事档案；正式产品继续采用上传优先的轻流程。" }
    ],
    action: "查看理想成品",
    route: "/pages/demo-vision/demo-vision"
  },
  workspace: {
    eyebrow: "CONCEPT WORKSPACE",
    title: "空间工作台",
    lead: "历史上的主办者视角：用章节、人物和场景模板整理一整天，而不是逐张管理照片。",
    accent: "4×3",
    sections: [
      { title: "章节", copy: "接亲、出发、仪式与宴席形成一天的主线。" },
      { title: "人物", copy: "照片保留拍摄者与被拍摄者关系，让同一时刻可以切换视角。" },
      { title: "为什么归档", copy: "完整工作台对首版过重；它的结构保留，入口收回到更简单的空间创建流程。" }
    ],
    action: "体验上传优先流程",
    route: "/pages/create/create"
  },
  "pov-research": {
    eyebrow: "POV RESEARCH",
    title: "回到 TA 的视角",
    lead: "研究照片的方向、定位置信度和覆盖缺口，回答“那个人当时正看向哪里”。",
    accent: "360°",
    sections: [
      { title: "方向不是装饰", copy: "照片必须与拍摄者当时的朝向绑定，才能在空间里保持稳定。" },
      { title: "不确定要可见", copy: "低置信照片进入复核，不能为了填满画面制造错误归位。" },
      { title: "产品化结果", copy: "研究界面被收进理想成品的 TA 视角标签，不再单独占一个入口。" }
    ],
    action: "进入 TA 视角",
    route: "/pages/demo-vision/demo-vision?tab=pov"
  },
  portal: {
    eyebrow: "EARLY SHOWCASE",
    title: "产品 Showcase",
    lead: "早期把宾客、主办者和观看者三种界面放在同一入口；它最终演化成今天统一的演示中心。",
    accent: "3→1",
    sections: [
      { title: "宾客", copy: "用最少步骤加入空间并补全普通照片或现成全景图。" },
      { title: "主办者", copy: "创建、分享和管理共同空间。" },
      { title: "观看者", copy: "从时间线、全景与人物方向重新进入那一天。" }
    ],
    action: "返回演示中心",
    route: "/pages/demo/demo"
  }
};

Page({
  data: { navBarTop: 20, navBarHeight: 44, detail: DETAILS["judge-story"] },
  onLoad: function (options) {
    var app = getApp();
    var nav = app.globalData.nav || {};
    this.setData({
      navBarTop: nav.barTop != null ? nav.barTop : 20,
      navBarHeight: nav.barHeight != null ? nav.barHeight : 44,
      detail: DETAILS[options.id] || DETAILS["judge-story"]
    });
  },
  onBack: function () { wx.navigateBack({ fail: function () { wx.reLaunch({ url: "/pages/demo-archive/demo-archive" }); } }); },
  onAction: function () { wx.navigateTo({ url: this.data.detail.route }); }
});
