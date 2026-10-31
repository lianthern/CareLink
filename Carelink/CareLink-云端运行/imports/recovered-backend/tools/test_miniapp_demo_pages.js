#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const automator = require("/opt/homebrew/lib/node_modules/miniprogram-automator");

const cliPath = process.env.WECHAT_DEVTOOLS_CLI || "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const projectPath = path.resolve(__dirname, "../miniapp");
const port = Math.max(1024, Number(process.env.WECHAT_AUTOMATION_PORT) || 9464);
const idePort = Math.max(1024, Number(process.env.WECHAT_IDE_PORT) || 0);
const artifactDir = path.resolve(__dirname, "../artifacts");

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message, detail) {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

async function rects(miniProgram, selectors) {
  return miniProgram.evaluate(function (items) {
    return new Promise(function (resolve) {
      var pages = getCurrentPages();
      var page = pages[pages.length - 1];
      var query = wx.createSelectorQuery().in(page);
      items.forEach(function (selector) { query.selectAll(selector).boundingClientRect(); });
      query.exec(resolve);
    });
  }, selectors);
}

async function inspect(miniProgram, route, selectors, screenshot) {
  process.stdout.write("[demo] " + route + "\n");
  await miniProgram.evaluate(function (url) {
    setTimeout(function () { wx.reLaunch({ url: url }); }, 30);
    return true;
  }, route);
  await delay(1100);
  const current = await miniProgram.currentPage();
  assert(current.path === route.replace(/^\//, "").split("?")[0], "路由没有打开", { route, path: current.path });
  const system = await miniProgram.systemInfo();
  const measured = await rects(miniProgram, selectors);
  const flat = measured.flat();
  assert(flat.length >= selectors.length, "页面缺少关键结构", { route, selectors, measured });
  flat.forEach((rect) => {
    assert(rect && rect.width > 0 && rect.height > 0, "组件尺寸无效", { route, rect });
    assert(rect.left >= -2 && rect.left + rect.width <= system.windowWidth + 2,
      "组件横向越界", { route, rect, viewport: system.windowWidth });
  });
  await miniProgram.screenshot({ path: path.join(artifactDir, screenshot) });
  return { route: current.path, data: await current.data(), measured };
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const miniProgram = process.env.WECHAT_AUTOMATION_ATTACH === "1"
    ? await automator.connect({ wsEndpoint: "ws://127.0.0.1:" + port })
    : await automator.launch({ cliPath, projectPath, port, timeout: 60000, trustProject: true,
      args: idePort ? ["--port", String(idePort)] : [] });
  const exceptions = [];
  miniProgram.on("exception", (entry) => exceptions.push(entry));
  miniProgram.on("console", (entry) => {
    if (entry && /(?:error|failed|exception)/i.test(String(entry.message || ""))) exceptions.push(entry);
  });
  try {
    const center = await inspect(miniProgram, "/pages/demo/demo",
      [".demo-hero", ".demo-steps", ".demo-card--featured", ".demo-safety"],
      "miniapp-demo-center-real-20260802.png");
    assert(center.data.storyOpen == null, "演示中心仍保留伪展开状态", center.data);

    const archive = await inspect(miniProgram, "/pages/demo-archive/demo-archive",
      [".archive-hero", ".ai-feature", ".archive-current", ".archive-group"],
      "miniapp-demo-archive-real-20260803.png");
    assert(archive.data.aiScenes.length === 4, "纯 AI 婚礼全景数量不完整", archive.data.aiScenes);
    assert(archive.data.rooms.length === 4, "真实技术样片数量不完整", archive.data.rooms);
    assert(archive.data.modes.length === 5, "历史观看形态数量不完整", archive.data.modes);
    assert(archive.data.pitches.length === 5, "历史演示原稿数量不完整", archive.data.pitches);

    const detail = await inspect(miniProgram, "/pages/demo-detail/demo-detail?id=roadshow",
      [".detail-hero", ".detail-accent", ".detail-section", ".detail-action"],
      "miniapp-demo-detail-real-20260804.png");
    assert(detail.data.detail.title === "路演现场", "历史原稿没有进入对应详情页", detail.data);

    const aiPano = await inspect(miniProgram, "/pages/demo-ai-pano/demo-ai-pano",
      [".ai-pano-hero", ".scene-tabs", ".ai-panorama", ".ai-directions", ".ai-disclosure"],
      "miniapp-ai-wedding-pano-real-20260803.png");
    assert(aiPano.data.scenes.length === 4, "纯 AI 婚礼四幕不完整", aiPano.data.scenes);

    const story = await inspect(miniProgram, "/pages/demo-story/demo-story",
      [".story-art", ".story-title", ".story-quote", ".story-actions"],
      "miniapp-demo-story-real-20260802.png");
    assert(story.data.slides.length === 6, "六幕故事数量不完整", story.data.slides);

    const vision = await inspect(miniProgram, "/pages/demo-vision/demo-vision",
      [".vision-cover", ".vision-tabs", ".vision-panel", ".vision-stats", ".vision-next"],
      "miniapp-demo-vision-real-20260802.png");
    assert(vision.data.tabs.length === 4, "理想成品视图数量不完整", vision.data.tabs);

    const pov = await inspect(miniProgram, "/pages/demo-vision/demo-vision?tab=pov",
      [".vision-cover", ".vision-tabs", ".pov-stage", ".direction-row", ".pov-copy", ".vision-note"],
      "miniapp-demo-pov-real-20260802.png");
    assert(pov.data.activeTab === "pov" && pov.data.povs.length === 4,
      "TA 视角没有从深链正确打开", pov.data);

    const pano = await inspect(miniProgram, "/pages/demo-vision/demo-vision?tab=pano",
      [".vision-cover", ".vision-tabs", ".pano-scroll", ".direction-row", ".vision-note"],
      "miniapp-demo-pano-real-20260802.png");
    assert(pano.data.activeTab === "pano", "全景视图没有从深链正确打开", pano.data);

    assert(exceptions.length === 0, "开发者工具捕获到异常", exceptions);
    process.stdout.write(JSON.stringify({
      ok: true,
      pages: [center.route, archive.route, detail.route, aiPano.route, story.route, vision.route, pov.route, pano.route],
      aiScenes: aiPano.data.scenes.length,
      archiveRooms: archive.data.rooms.length,
      archiveModes: archive.data.modes.length,
      archivePitches: archive.data.pitches.length,
      storySlides: story.data.slides.length,
      visionTabs: vision.data.tabs.length,
      povDirections: pov.data.povs.length,
      exceptions: exceptions.length
    }, null, 2) + "\n");
  } finally {
    await miniProgram.close();
  }
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + "\n");
  if (error && error.detail) process.stderr.write(JSON.stringify(error.detail, null, 2) + "\n");
  process.exitCode = 1;
});
