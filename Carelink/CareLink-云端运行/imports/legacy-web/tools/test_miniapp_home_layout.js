#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const automator = require("/opt/homebrew/lib/node_modules/miniprogram-automator");

const cliPath = process.env.WECHAT_DEVTOOLS_CLI ||
  "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const projectPath = path.resolve(__dirname, "../miniapp");
const automationPort = Math.max(1024, Number(process.env.WECHAT_AUTOMATION_PORT) || 9458);
const artifactDir = path.resolve(__dirname, "../artifacts");
const topScreenshot = path.join(artifactDir, "miniapp-home-unified-top-20260802.png");
const openScreenshot = path.join(artifactDir, "miniapp-home-unified-open-20260802.png");
const demoScreenshot = path.join(artifactDir, "miniapp-demo-center-20260802.png");
const storyScreenshot = path.join(artifactDir, "miniapp-demo-story-20260802.png");
const visionScreenshot = path.join(artifactDir, "miniapp-demo-vision-20260802.png");
const povScreenshot = path.join(artifactDir, "miniapp-demo-pov-20260802.png");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message, detail) {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

function right(box) {
  return box.left + box.width;
}

function bottom(box) {
  return box.top + box.height;
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

async function queryLayout(miniProgram, selectors) {
  return miniProgram.evaluate(function (items) {
    return new Promise(function (resolve) {
      var pages = getCurrentPages();
      var page = pages[pages.length - 1];
      var query = wx.createSelectorQuery().in(page);
      items.forEach(function (item) {
        query.selectAll(item.selector).boundingClientRect();
      });
      query.exec(function (results) {
        var output = {};
        items.forEach(function (item, index) {
          output[item.key] = (results[index] || []).map(function (rect, rectIndex) {
            return {
              name: item.key + (results[index].length > 1 ? "[" + rectIndex + "]" : ""),
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height
            };
          });
        });
        resolve(output);
      });
    });
  }, selectors);
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  process.stdout.write("[layout] launch developer tools\n");
  const miniProgram = await automator.launch({
    cliPath,
    projectPath,
    port: automationPort,
    timeout: 60000,
    trustProject: true
  });
  const exceptions = [];
  miniProgram.on("exception", (entry) => exceptions.push(entry));
  miniProgram.on("console", (entry) => {
    if (entry && /(?:error|failed|exception)/i.test(String(entry.message || ""))) exceptions.push(entry);
  });

  try {
    process.stdout.write("[layout] clear fixtures\n");
    await miniProgram.evaluate(function () {
      wx.removeStorageSync("unseen_local_spaces_v2");
      wx.removeStorageSync("unseen_upload_queue_v2");
      return true;
    });
    process.stdout.write("[layout] relaunch home\n");
    await miniProgram.reLaunch("/pages/index/index");
    await delay(1600);

    process.stdout.write("[layout] inspect viewport\n");
    const page = await miniProgram.currentPage();
    const systemInfo = await miniProgram.systemInfo();
    process.stdout.write("[layout] system info ready\n");
    const viewport = {
      width: systemInfo.windowWidth || systemInfo.screenWidth,
      height: systemInfo.windowHeight || systemInfo.screenHeight
    };
    process.stdout.write("[layout] query component rectangles\n");
    const measured = await queryLayout(miniProgram, [
      { key: "home", selector: ".home" },
      { key: "appBar", selector: ".app-bar" },
      { key: "appDemo", selector: ".app-demo" },
      { key: "main", selector: ".home-main" },
      { key: "hero", selector: ".hero" },
      { key: "sceneGrid", selector: ".scene-grid" },
      { key: "sceneCards", selector: ".scene-card" },
      { key: "primary", selector: ".primary-button" },
      { key: "secondary", selector: ".secondary-button" },
      { key: "demoBanner", selector: ".demo-banner" },
      { key: "notice", selector: ".notice" },
      { key: "openCard", selector: ".open-card" },
      { key: "input", selector: ".code-input" },
      { key: "openButton", selector: ".open-button" },
      { key: "bottomNav", selector: ".bottom-nav" }
    ]);
    Object.keys(measured).forEach((key) => {
      assert(measured[key].length > 0, `找不到 ${key}`, measured);
    });
    const boxes = {
      home: measured.home[0],
      appBar: measured.appBar[0],
      appDemo: measured.appDemo[0],
      main: measured.main[0],
      hero: measured.hero[0],
      sceneGrid: measured.sceneGrid[0],
      sceneCards: measured.sceneCards,
      primary: measured.primary[0],
      secondary: measured.secondary[0],
      demoBanner: measured.demoBanner[0],
      notice: measured.notice[0],
      openCard: measured.openCard[0],
      input: measured.input[0],
      openButton: measured.openButton[0],
      bottomNav: measured.bottomNav[0]
    };

    const tolerance = 2;
    const mustFit = [
      boxes.appBar, boxes.appDemo, boxes.main, boxes.hero, boxes.sceneGrid,
      ...boxes.sceneCards, boxes.primary, boxes.secondary, boxes.demoBanner, boxes.notice,
      boxes.openCard, boxes.input, boxes.openButton, boxes.bottomNav
    ];
    mustFit.forEach((box) => {
      assert(box.left >= -tolerance, `${box.name} 左侧越界`, { box, viewport });
      assert(right(box) <= viewport.width + tolerance, `${box.name} 右侧越界`, { box, viewport });
      assert(box.width > 0 && box.height > 0, `${box.name} 尺寸无效`, box);
    });

    assert(boxes.sceneCards.length === 4, "场景卡数量不是四张", boxes.sceneCards);
    assert(boxes.appDemo.width >= 54 && boxes.appDemo.width <= 64,
      "首页演示入口宽度不稳定", boxes.appDemo);
    assert(near(boxes.sceneCards[0].left, boxes.sceneCards[2].left, tolerance),
      "场景卡左列没有对齐", boxes.sceneCards);
    assert(near(boxes.sceneCards[1].left, boxes.sceneCards[3].left, tolerance),
      "场景卡右列没有对齐", boxes.sceneCards);
    assert(near(boxes.sceneCards[0].top, boxes.sceneCards[1].top, tolerance),
      "场景卡第一行没有对齐", boxes.sceneCards);
    assert(near(boxes.sceneCards[2].top, boxes.sceneCards[3].top, tolerance),
      "场景卡第二行没有对齐", boxes.sceneCards);
    assert(near(boxes.sceneCards[0].width, boxes.sceneCards[1].width, tolerance),
      "场景卡两列宽度不一致", boxes.sceneCards);

    const sharedLeft = boxes.hero.left;
    const sharedRight = right(boxes.hero);
    [boxes.sceneGrid, boxes.primary, boxes.secondary, boxes.demoBanner, boxes.notice, boxes.openCard].forEach((box) => {
      assert(near(box.left, sharedLeft, tolerance), `${box.name} 左边线没有与首屏统一`, { box, hero: boxes.hero });
      assert(near(right(box), sharedRight, tolerance), `${box.name} 右边线没有与首屏统一`, { box, hero: boxes.hero });
    });

    assert(boxes.input.left >= boxes.openCard.left - tolerance, "输入框跑出打开卡片左侧", boxes);
    assert(right(boxes.openButton) <= right(boxes.openCard) + tolerance, "打开按钮跑出卡片右侧", boxes);
    assert(right(boxes.input) < boxes.openButton.left, "输入框和打开按钮发生重叠", boxes);
    assert(boxes.openButton.width >= 60 && boxes.openButton.width <= 72,
      "打开按钮宽度不稳定", boxes.openButton);
    assert(near(boxes.bottomNav.left, 0, tolerance), "底部导航没有贴齐左边", boxes.bottomNav);
    assert(near(boxes.bottomNav.width, viewport.width, tolerance), "底部导航没有铺满屏幕", { nav: boxes.bottomNav, viewport });
    assert(boxes.bottomNav.top < viewport.height && bottom(boxes.bottomNav) <= viewport.height + tolerance,
      "底部导航没有固定在可视区域", { nav: boxes.bottomNav, viewport });

    await miniProgram.screenshot({ path: topScreenshot });
    await miniProgram.pageScrollTo(Math.max(0, boxes.openCard.top - 110));
    await delay(500);
    await miniProgram.screenshot({ path: openScreenshot });

    process.stdout.write("[layout] inspect demo center\n");
    await miniProgram.navigateTo("/pages/demo/demo");
    await delay(800);
    const demoPage = await miniProgram.currentPage();
    assert(demoPage.path === "pages/demo/demo", "演示中心路由没有打开", demoPage.path);
    const demoMeasured = await queryLayout(miniProgram, [
      { key: "demoBack", selector: ".nav-back" },
      { key: "demoMain", selector: ".demo-main" },
      { key: "demoHero", selector: ".demo-hero" },
      { key: "demoSteps", selector: ".demo-steps" },
      { key: "demoCards", selector: ".demo-card" },
      { key: "demoSafety", selector: ".demo-safety" }
    ]);
    Object.keys(demoMeasured).forEach((key) => {
      assert(demoMeasured[key].length > 0, `演示中心找不到 ${key}`, demoMeasured);
    });
    assert(demoMeasured.demoCards.length === 6, "演示中心卡片没有统一收齐六项", demoMeasured.demoCards);
    assert(demoMeasured.demoBack[0].width >= 34 && demoMeasured.demoBack[0].width <= 40,
      "演示中心返回按钮宽度不稳定", demoMeasured.demoBack[0]);
    const demoLeft = demoMeasured.demoHero[0].left;
    const demoRight = right(demoMeasured.demoHero[0]);
    [demoMeasured.demoSteps[0], ...demoMeasured.demoCards, demoMeasured.demoSafety[0]].forEach((box) => {
      assert(box.left >= -tolerance && right(box) <= viewport.width + tolerance,
        `${box.name} 在演示中心横向越界`, { box, viewport });
      assert(near(box.left, demoLeft, tolerance) && near(right(box), demoRight, tolerance),
        `${box.name} 没有与演示中心共用边线`, { box, hero: demoMeasured.demoHero[0] });
    });
    await miniProgram.screenshot({ path: demoScreenshot });
    await miniProgram.navigateTo("/pages/demo-story/demo-story");
    await delay(700);
    const storyPage = await miniProgram.currentPage();
    assert(storyPage.path === "pages/demo-story/demo-story", "六幕产品故事没有进入完整页面", storyPage.path);
    const storyData = await storyPage.data();
    assert(storyData.slides.length === 6, "六幕产品故事内容不完整", storyData.slides);
    const storyMeasured = await queryLayout(miniProgram, [
      { key: "storyArt", selector: ".story-art" },
      { key: "storyTitle", selector: ".story-title" },
      { key: "storyActions", selector: ".story-actions" }
    ]);
    Object.keys(storyMeasured).forEach((key) => assert(storyMeasured[key].length > 0,
      `六幕产品故事找不到 ${key}`, storyMeasured));
    [storyMeasured.storyArt[0], storyMeasured.storyTitle[0], storyMeasured.storyActions[0]].forEach((box) => {
      assert(box.left >= -tolerance && right(box) <= viewport.width + tolerance,
        `${box.name} 在六幕故事里横向越界`, { box, viewport });
    });
    await miniProgram.screenshot({ path: storyScreenshot });

    await miniProgram.navigateTo("/pages/demo-vision/demo-vision");
    await delay(700);
    const visionPage = await miniProgram.currentPage();
    assert(visionPage.path === "pages/demo-vision/demo-vision", "理想成品没有进入完整页面", visionPage.path);
    const visionMeasured = await queryLayout(miniProgram, [
      { key: "visionCover", selector: ".vision-cover" },
      { key: "visionTabs", selector: ".vision-tabs" },
      { key: "visionPanel", selector: ".vision-panel" },
      { key: "visionStats", selector: ".vision-stats" },
      { key: "visionNext", selector: ".vision-next" }
    ]);
    Object.keys(visionMeasured).forEach((key) => assert(visionMeasured[key].length > 0,
      `理想成品找不到 ${key}`, visionMeasured));
    [visionMeasured.visionCover[0], visionMeasured.visionTabs[0], visionMeasured.visionPanel[0], visionMeasured.visionStats[0], visionMeasured.visionNext[0]].forEach((box) => {
      assert(box.left >= -tolerance && right(box) <= viewport.width + tolerance,
        `${box.name} 在理想成品里横向越界`, { box, viewport });
    });
    await miniProgram.screenshot({ path: visionScreenshot });
    await miniProgram.evaluate(function () {
      var pages = getCurrentPages();
      pages[pages.length - 1].setData({ activeTab: "pov" });
      return true;
    });
    await delay(300);
    const povMeasured = await queryLayout(miniProgram, [
      { key: "povStage", selector: ".pov-stage" },
      { key: "povButtons", selector: ".direction-row button" },
      { key: "povCopy", selector: ".pov-copy" }
    ]);
    assert(povMeasured.povStage.length === 1 && povMeasured.povButtons.length === 4 && povMeasured.povCopy.length === 1,
      "TA 视角不是完整可操作页面", povMeasured);
    await miniProgram.screenshot({ path: povScreenshot });

    await miniProgram.navigateBack();
    await miniProgram.navigateBack();
    assert((await miniProgram.currentPage()).path === "pages/demo/demo", "没有返回演示中心");

    await miniProgram.navigateTo("/pages/capture/capture?source=demo");
    assert((await miniProgram.currentPage()).path === "pages/capture/capture", "球形拍摄演示路由不可达");
    await miniProgram.navigateBack();
    await miniProgram.navigateTo("/pages/sweep/sweep?source=demo");
    assert((await miniProgram.currentPage()).path === "pages/sweep/sweep", "横向扫拍演示路由不可达");
    await miniProgram.navigateBack();

    const result = {
      ok: true,
      route: page.path,
      viewport,
      system: {
        brand: systemInfo.brand,
        model: systemInfo.model,
        platform: systemInfo.platform,
        pixelRatio: systemInfo.pixelRatio,
        screenWidth: systemInfo.screenWidth,
        screenHeight: systemInfo.screenHeight
      },
      sharedGutter: sharedLeft,
      openRow: {
        cardRight: right(boxes.openCard),
        inputRight: right(boxes.input),
        buttonLeft: boxes.openButton.left,
        buttonRight: right(boxes.openButton)
      },
      sceneCards: boxes.sceneCards,
      bottomNav: boxes.bottomNav,
      demoCenter: {
        route: demoPage.path,
        cards: demoMeasured.demoCards.length,
        storyRoute: storyPage.path,
        visionRoute: visionPage.path,
        povButtons: povMeasured.povButtons.length,
        sharedGutter: demoLeft,
        storyFullPage: true,
        captureRoute: true,
        sweepRoute: true
      },
      screenshots: [topScreenshot, openScreenshot, demoScreenshot, storyScreenshot, visionScreenshot, povScreenshot],
      exceptions: exceptions.length
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    assert(exceptions.length === 0, "开发者工具捕获到异常", exceptions);
  } finally {
    await miniProgram.close();
  }
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + "\n");
  if (error && error.detail) process.stderr.write(JSON.stringify(error.detail, null, 2) + "\n");
  process.exitCode = 1;
});
