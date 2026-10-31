import test from "node:test";
import assert from "node:assert/strict";
import { placementEditorPage } from "../src/ui/templates.js";

// CLIP 低置信照片转人工队列后，placementEditorPage 应该在有候选方向时渲染最多 3 个
// "AI 候选方向" chip（方向 + 置信度百分比），点击后由 app.js 把 yaw/pitch 填进既有的位置
// 输入控件；没有候选时页面必须跟现状完全一致（纯手动路径不受影响）。

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  globalThis.document = { title: "" };
  globalThis.location = { pathname: "/placements/photo-1/edit", search: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; globalThis.location = priorLocation; }
}

const baseState = { account: null, capabilities: {}, currentSpaceId: "space-1", debug: false };
const baseContext = { sceneContext: { scene: { panoramaRevisionId: "pano-1" } }, batchId: "batch-1", itemId: "item-1", photoId: "photo-1" };

test("有候选方向时渲染最多 3 个 AI 候选 chip，携带 yaw/pitch 供点击填入", () => {
  withStubbedDocument(() => {
    const target = {
      id: "photo-1", placementState: "needs_confirmation", canEdit: true,
      suggestionId: "psug_1",
      candidates: [
        { candidateId: "psug_1_c1", yaw: 30, pitch: null, confidence: 0.6821 },
        { candidateId: "psug_1_c2", yaw: 60, pitch: null, confidence: 0.5519 },
        { candidateId: "psug_1_c3", yaw: 0, pitch: null, confidence: 0.5011 },
        { candidateId: "psug_1_c4", yaw: 90, pitch: null, confidence: 0.4 } // 第 4 个必须被截掉，最多渲染 3 个
      ]
    };
    const html = placementEditorPage(baseState, target, baseContext);

    const chipMatches = [...html.matchAll(/class="candidate-chip"/g)];
    assert.equal(chipMatches.length, 3, "最多渲染 3 个候选 chip");
    assert.match(html, /data-yaw="30"/);
    assert.match(html, /data-yaw="60"/);
    assert.match(html, /data-yaw="0"/);
    assert.doesNotMatch(html, /data-yaw="90"/, "第 4 个候选(90°)不应该出现");
    assert.match(html, /30° 方向 · 置信 68%/);
    assert.match(html, /60° 方向 · 置信 55%/);
    assert.match(html, /class="ai-candidates"/);
  });
});

test("候选带 pitch 时一并携带在 data-pitch 上；候选没有 pitch 时留空", () => {
  withStubbedDocument(() => {
    const target = {
      id: "photo-1", placementState: "needs_confirmation", canEdit: true,
      candidates: [{ candidateId: "c1", yaw: 15, pitch: 5, confidence: 0.9 }]
    };
    const html = placementEditorPage(baseState, target, baseContext);
    assert.match(html, /data-yaw="15" data-pitch="5"/);
  });
});

test("没有候选方向时不渲染 AI 候选区，页面跟纯手动路径完全一致", () => {
  withStubbedDocument(() => {
    const targetWithoutCandidates = { id: "photo-1", placementState: "needs_confirmation", canEdit: true };
    const targetWithEmptyCandidates = { id: "photo-1", placementState: "needs_confirmation", canEdit: true, candidates: [] };
    const htmlA = placementEditorPage(baseState, targetWithoutCandidates, baseContext);
    const htmlB = placementEditorPage(baseState, targetWithEmptyCandidates, baseContext);

    for (const html of [htmlA, htmlB]) {
      assert.doesNotMatch(html, /data-ai-candidates/);
      assert.doesNotMatch(html, /data-ai-candidate\b/);
      assert.doesNotMatch(html, /AI 候选方向/);
    }
    assert.equal(htmlA, htmlB, "缺省 candidates 字段和空数组必须渲染出完全相同的页面");
  });
});

test("候选方向的 yaw/confidence 全部经过 Number() 转换再 esc()，恶意字符串不会造成属性逃逸", () => {
  withStubbedDocument(() => {
    const target = {
      id: "photo-1", placementState: "needs_confirmation", canEdit: true,
      candidates: [{ candidateId: "c1", yaw: '0" onmouseover="alert(1)', pitch: null, confidence: 0.5 }]
    };
    const html = placementEditorPage(baseState, target, baseContext);
    assert.doesNotMatch(html, /onmouseover="alert\(1\)"/, "非法 yaw 字符串不能造成属性逃逸");
    assert.match(html, /data-yaw="NaN"/, "非数字 yaw 经 Number() 转换后被安全渲染为 NaN");
  });
});

// 误导文案修复(2026-08-19)的界定测试: 相册贴片那边把 needs_confirmation 的「照片校验未通过」
// 换成了「待定位」文案(见 ai-placement-badge.test.mjs)，但位置编辑器这里刻意不跟着改——
// 这里的 target 走的是 editorSceneContext()/editorMedia() 这条不按 placement_state='confirmed'
// 过滤的permissive 路径(placement-service.mjs#editView() 的注释:"needs_confirmation/failed 正是
// 这个编辑器存在的理由")，needs_confirmation 在这个页面本来就该拿得到缩略图。所以这里如果
// target.asset/thumbnailUrl 仍然缺失，读作真的没有可用缩略图(数据问题)，不是"还没定位"，
// 保留原文案是对的，不属于这次改动范围。
test("placementEditorPage: needs_confirmation 但缩略图仍缺失时保持原有「照片校验未通过」文案(这个页面的语境跟相册贴片不同，不在这次文案修复范围内)", () => {
  withStubbedDocument(() => {
    const target = { id: "photo-1", placementState: "needs_confirmation", canEdit: true, asset: "", thumbnailUrl: "" };
    const html = placementEditorPage(baseState, target, baseContext);
    assert.match(html, /<span class="photo-unavailable">照片校验未通过<\/span>/);
  });
});
