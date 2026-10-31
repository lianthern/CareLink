import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// B (2026-08-17, editor-mobile): 375-767px 触摸模拟下位置编辑器的两个坍缩 bug 与其修复。
// 同 v4-parallax-controls.test.mjs 的技术：这里没有真实排版引擎跑计算样式，只能对样式表
// 源码做正则/文本断言（真实浏览器截图证据见 design/evidence-editor-mobile/）。
//
// ① 黑色空白：packages/viewer 的 .unseen-viewer 是 height:100%（frozen，见
//    packages/viewer/src/styles.js），只有当它的直接父级 .viewer-render-host（本仓库
//    自己的包装 div，见 apps/web/src/adapters/viewer/index.js#mount）有*确定*的
//    height 时百分比才能生效——过去 .viewer-render-host 只有 min-height，没有 height，
//    CSS2.1 §10.5 下这条百分比退化成 auto，.unseen-viewer 每次都只有它自己的
//    min-height:240px 兜底，多出来的预留空间就露出 .viewer-wrap 的纯黑
//    --viewer-canvas 背景。经真实浏览器 getBoundingClientRect 探测确认：这个 bug 在
//    375px 和 1280px 都能复现，不是移动端专属——所以修复同时覆盖基础规则与窄视口规则。
// ② 方向/平移控制按钮坍缩为 (0,0)：packages/viewer 自己的样式表在
//    `(hover:none) and (pointer:coarse)` 下无条件把 .unseen-viewer__directions 设成
//    display:none（无深度现场时又没有摇杆兜底），真机触摸下用户完全看不到旋转按钮。
//    placement-viewer 本页原有的设计意图就是方向控制"始终可见"（见 styles.css 现有注释），
//    这里用更高优先级选择器覆盖，不改 packages/viewer 源码。
// ③ AI 候选 chip 触达面积：min-height 36px 低于本页其它控件统一使用的 44px 触达面积，
//    仅在窄视口内提到 44px，桌面 36px 保持不变。

async function loadCss() {
  const raw = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  // Strip /* ... */ comments first — several of this file's rule comments are long
  // enough to themselves contain selector-shaped substrings (e.g. this very fix's
  // own comment mentions "[data-viewer-root]" in prose), which would otherwise get
  // swept into the "selector" capture below and produce false rule matches.
  return raw.replace(/\/\*[\s\S]*?\*\//g, "");
}

function ruleBodies(css, selectorPattern) {
  const bodies = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (selectorPattern.test(selector)) bodies.push(body);
  }
  return bodies;
}

test(".viewer-render-host gets an explicit height (not just min-height) in the base rule, so packages/viewer's height:100% .unseen-viewer can resolve against it", async () => {
  const css = await loadCss();
  const bodies = ruleBodies(css, /(^|[\s,])\.viewer-render-host(?![\w-])/);
  assert.ok(bodies.some((body) => /(^|;)\s*height:\s*520px/.test(body)),
    ".viewer-render-host must carry a definite `height: 520px` somewhere outside any media query");
});

test(".viewer-render-host's narrow-viewport height stays in sync with its min-height (min(58dvh, 520px))", async () => {
  const css = await loadCss();
  const narrowBlockMatch = css.match(/@media \(max-width: 1247px\) \{([\s\S]*?)\n\}/);
  assert.ok(narrowBlockMatch, "expected a @media (max-width: 1247px) block");
  const narrowBlock = narrowBlockMatch[1];
  assert.match(narrowBlock, /\.viewer-render-host\s*\{\s*height:\s*min\(58dvh,\s*520px\);?\s*\}/,
    "narrow-viewport .viewer-render-host height must mirror the min-height formula used for the same selector group");
});

test("[data-viewer-root] itself keeps min-height only (no forced height) outside .scene-immersive, so the normal-flow .viewer-photo-list filmstrip below .viewer-render-host cannot be clipped by .viewer-wrap's overflow:hidden — .scene-immersive's own edge-to-edge height:100% override for [data-viewer-root] is a separate, unrelated full-bleed context and is intentionally excluded here", async () => {
  const css = await loadCss();
  const nonImmersiveBodies = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (/\[data-viewer-root\]/.test(selector) && !/scene-immersive/.test(selector)) nonImmersiveBodies.push(body);
  }
  assert.ok(nonImmersiveBodies.length > 0, "expected at least one non-.scene-immersive rule targeting [data-viewer-root]");
  for (const body of nonImmersiveBodies) {
    assert.doesNotMatch(body, /(^|;)\s*height:\s*\d/,
      "[data-viewer-root] must stay auto-height (min-height only) outside .scene-immersive — a fixed height risks clipping .viewer-photo-list");
  }
});

test("placement editor keeps the direction pad visible under touch (hover:none, pointer:coarse) instead of inheriting packages/viewer's own display:none for that case", async () => {
  const css = await loadCss();
  const coarseBlockMatch = css.match(/@media \(hover: none\) and \(pointer: coarse\) \{([\s\S]*?)\n\}/);
  assert.ok(coarseBlockMatch, "expected a @media (hover: none) and (pointer: coarse) block");
  assert.match(coarseBlockMatch[1], /\.placement-viewer\s+\.unseen-viewer__directions\s*\{\s*display:\s*grid;?\s*\}/,
    "must re-enable display:grid for .placement-viewer .unseen-viewer__directions under touch");
});

test("the touch override for .unseen-viewer__directions is scoped to .placement-viewer, not applied sitewide (leaves .scene-immersive's own compass-toggle behavior untouched)", async () => {
  const css = await loadCss();
  const coarseBlockMatch = css.match(/@media \(hover: none\) and \(pointer: coarse\) \{([\s\S]*?)\n\}/);
  const body = coarseBlockMatch[1];
  const directionsRules = [...body.matchAll(/([^{}]+)\{\s*display:\s*grid;?\s*\}/g)].map((m) => m[1].trim());
  for (const selector of directionsRules) {
    if (selector.includes("unseen-viewer__directions")) {
      assert.match(selector, /^\.placement-viewer\b/, `unexpected unscoped/mis-scoped selector: ${selector}`);
    }
  }
});

test("AI-candidate chips reach the 44px touch target in the narrow-viewport bucket, desktop's 36px base rule is untouched", async () => {
  const css = await loadCss();
  const baseBodies = ruleBodies(css, /(^|[\s,])\.candidate-chip(?![\w-])/).filter((_, index) => index === 0);
  assert.match(baseBodies[0] ?? "", /min-height:\s*36px/, "base/desktop .candidate-chip must keep its existing 36px min-height");

  const narrowBlockMatch = css.match(/@media \(max-width: 1247px\) \{([\s\S]*?)\n\}/);
  assert.match(narrowBlockMatch[1], /\.candidate-chip\s*\{\s*min-height:\s*44px;?\s*\}/,
    "narrow-viewport .candidate-chip must be bumped to the 44px touch target used by this page's other controls");
});

test("regression guard: [data-viewer-root]/.viewer-render-host/.viewer-fixture still carry their original min-height floors (520px base, min(58dvh,520px) narrow) — this fix only adds height, it does not remove the min-height safety net", async () => {
  const css = await loadCss();
  assert.match(css, /\.viewer-fixture, \[data-viewer-root\], \.viewer-render-host \{ position: relative; min-height: 520px; \}/);
  const narrowBlockMatch = css.match(/@media \(max-width: 1247px\) \{([\s\S]*?)\n\}/);
  assert.match(narrowBlockMatch[1], /\.viewer-fixture, \.viewer-stage, \[data-viewer-root\], \.viewer-render-host \{ min-height: min\(58dvh, 520px\); \}/);
});
