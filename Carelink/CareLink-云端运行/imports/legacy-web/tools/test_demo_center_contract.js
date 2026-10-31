#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const web = read("web/unseen.js");
const webCss = read("web/unseen.css");
const webIndex = read("web/index.html");
const demoHtml = read("web/demo.html");
const povHtml = read("web/pov.html");
const captureHtml = read("web/pano-capture.html");
const sweepHtml = read("web/pano-sweep.html");
const app = JSON.parse(read("miniapp/app.json"));
const miniIndex = read("miniapp/pages/index/index.wxml");
const miniDemo = read("miniapp/pages/demo/demo.wxml") + read("miniapp/pages/demo/demo.js");
const miniArchive = read("miniapp/pages/demo-archive/demo-archive.wxml") + read("miniapp/pages/demo-archive/demo-archive.js");
const miniAiPano = read("miniapp/pages/demo-ai-pano/demo-ai-pano.wxml") + read("miniapp/pages/demo-ai-pano/demo-ai-pano.js");
const miniDetail = read("miniapp/pages/demo-detail/demo-detail.wxml") + read("miniapp/pages/demo-detail/demo-detail.js");
const miniStory = read("miniapp/pages/demo-story/demo-story.wxml") + read("miniapp/pages/demo-story/demo-story.js");
const miniVision = read("miniapp/pages/demo-vision/demo-vision.wxml") + read("miniapp/pages/demo-vision/demo-vision.js");

assert.match(web, /class="topbar-demo" href="#\/demo"/,
  "Web 顶栏必须长期保留演示入口");
assert.match(web, /class="demo-banner" href="#\/demo"/,
  "Web 首页必须有独立演示中心卡");
assert.match(web, /case "\/demo": renderDemo\(\)/,
  "Web 路由必须注册演示中心");
assert.match(web, /case "\/demo-story": renderDemoStory\(route\.params\)/,
  "Web 路由必须注册完整六幕故事");
assert.match(web, /case "\/demo-vision": renderDemoVision\(route\.params\)/,
  "Web 路由必须注册理想成品演示");
assert.match(web, /case "\/demo-archive": renderDemoArchive\(\)/,
  "Web 路由必须注册 AI 演示档案馆");
assert.match(web, /case "\/demo-player": renderDemoPlayer\(route\.params\)/,
  "Web 路由必须注册历史演示播放器");
assert.match(web, /case "\/demo-mode": renderDemoMode\(route\.params\)/,
  "Web 路由必须注册历史观看形态");

const renderDemo = web.slice(web.indexOf("function renderDemo()"), web.indexOf("async function renderSpaces()"));
[
  "六幕产品故事", "上传优先流程", "AI 演示档案馆", "理想的共同记忆空间"
].forEach((title) => assert.ok(renderDemo.includes(title), `Web 演示中心缺少 ${title}`));
assert.doesNotMatch(renderDemo, /720° 球形全景|横向扫拍/,
  "Web 对外演示中心不应再混入拍摄实验");
assert.doesNotMatch(renderDemo, /\bfetch\s*\(|apiRequest\s*\(|uploadFile\s*\(/,
  "Web 演示中心自身不得写入后端或上传");
assert.match(renderDemo, /不依赖后端/,
  "Web 演示中心必须说明上传边界");
assert.match(webCss, /\.demo-card--experiment/);
assert.match(webCss, /grid-template-columns:\s*48px minmax\(0, 1fr\) auto/);
assert.match(webIndex, /20260804a/,
  "Web 演示版本必须使用新的缓存键");
[
  "六幕评委 Demo", "纯 AI 婚礼全景", "婚礼旅程", "时光轴", "记忆相册", "机器回忆", "一键成片", "路演现场", "空间工作台"
].forEach((title) => assert.ok(web.includes(title), `Web AI 演示档案馆缺少 ${title}`));
assert.match(web, /AI_WEDDING_SCENES/);
assert.match(web, /s900001/);
assert.match(web, /一场未曾拍摄的(?:<br>)?婚礼/);
assert.match(web, /Poly Haven/);
assert.match(web, /<details class="archive-group">/);
assert.match(web, /walk-\$\{chapter\.id\}/,
  "Web AI 空间卡必须进入实际播放器");
assert.match(webCss, /\.archive-player-frame/,
  "Web 历史演示必须由统一播放器承载");

[demoHtml, povHtml, captureHtml, sweepHtml].forEach((source) => {
  assert.match(source, /index\.html#\/demo/,
    "旧演示页必须统一返回演示中心");
});
assert.doesNotMatch(demoHtml, /href="show\.html"/,
  "六幕档案页不得再链接到缺少空间参数的 show.html");

[
  "pages/demo/demo", "pages/demo-archive/demo-archive", "pages/demo-ai-pano/demo-ai-pano", "pages/demo-detail/demo-detail", "pages/demo-story/demo-story", "pages/demo-vision/demo-vision",
  "pages/capture/capture", "pages/sweep/sweep"
].forEach((route) => assert.ok(app.pages.includes(route), `小程序预览包缺少 ${route}`));
assert.match(miniIndex, /演示中心/);
assert.match(miniIndex, /bindtap="onDemo"/);
[
  "六幕产品故事", "上传优先流程", "AI 演示档案馆", "理想的共同记忆空间"
].forEach((title) => assert.ok(miniDemo.includes(title), `小程序演示中心缺少 ${title}`));
assert.doesNotMatch(miniDemo, /720° 球形全景|横向扫拍/,
  "小程序对外演示中心不应再混入拍摄实验");
assert.match(miniDemo, /不依赖后端/);
assert.match(miniDemo, /onVision/);
assert.match(miniDemo, /onStory/);
assert.match(miniDemo, /onArchive/);
assert.match(miniArchive, /AI 演示档案馆/);
assert.match(miniArchive, /activeMode/);
assert.match(miniArchive, /onRoom/);
assert.match(miniArchive, /onDirection/);
assert.match(miniArchive, /onAiPano/);
assert.match(miniArchive, /onGroup/);
assert.match(miniArchive, /openGroup/);
assert.match(miniArchive, /一场未曾拍摄的婚礼/);
assert.match(miniArchive, /真实 CC0 全景/);
["婚礼旅程", "时光轴", "记忆相册", "机器回忆", "一键成片"].forEach((title) =>
  assert.ok(miniArchive.includes(title), `小程序 AI 演示档案馆缺少 ${title}`));
["六幕评委 Demo", "路演现场", "空间工作台", "回到 TA 的视角", "产品 Showcase"].forEach((title) =>
  assert.ok(miniArchive.includes(title), `小程序历史演示原稿缺少 ${title}`));
assert.match(miniArchive, /pitches:\s*PITCHES/);
assert.match(miniArchive, /onPitch/);
assert.match(miniArchive, /pages\/demo-detail\/demo-detail\?id=/,
  "小程序历史原稿必须进入独立详情页");
assert.match(miniDetail, /静态演示档案/);
assert.match(miniDetail, /六幕评委 Demo/);
assert.match(miniDetail, /路演现场/);
assert.match(miniDetail, /产品 Showcase/);
assert.doesNotMatch(miniDemo, /storyOpen|onToggleStory|wx\.showModal/,
  "小程序演示中心不得再用原地展开或弹窗冒充完整 Demo");
assert.match(miniStory, /slides:\s*SLIDES/);
assert.match(miniStory, /onNext/);
assert.match(miniVision, /activeTab/);
assert.match(miniVision, /onPov/);
assert.match(miniVision, /pano-scroll/);
assert.match(miniAiPano, /scenes:\s*SCENES/);
assert.match(miniAiPano, /AI GENERATED DEMO/);
assert.match(miniAiPano, /生成内容说明/);
assert.match(miniAiPano, /不对应真实人物或真实婚礼记录/);
assert.doesNotMatch(miniDemo, /wx\.cloud|uploadFile|callFunction/,
  "小程序演示中心自身不得写入云端或上传");

console.log("✅ Web/小程序演示中心入口、分组、返回路径与零自动上传边界通过");
