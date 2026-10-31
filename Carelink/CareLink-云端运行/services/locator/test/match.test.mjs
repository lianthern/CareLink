import assert from "node:assert/strict";
import test from "node:test";
import { classifyMatch, clipThresholdsFromEnv, cosineSimilarity, DEFAULT_THRESHOLDS, gridPeakMatch,
  matchAgainstBank } from "../src/match.mjs";

// 固定夹具：不依赖模型权重，凭手写的余弦相似度数字就能把打分/阈值/拒绝逻辑测全 ——
// 和旧仓库 tools/test_yaw_peak.py 的思路一致：这条回归要证明"不做插值精修"这件事，
// 不需要真的跑一次 CLIP。

test("gridPeakMatch 只取网格峰值，不做 ±30° 插值精修", () => {
  // 峰值在 yaw150，邻居 yaw120/yaw180 都比它低但彼此接近 —— 老算法(tools/match.py 的
  // match_one)在这种曲线上会把结果往邻居方向拖，新算法必须原地返回 150，不许挪动。
  const yaws = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  const sims = [0.10, 0.12, 0.15, 0.20, 0.87, 0.9265, 0.9099, 0.30, 0.25, 0.18, 0.14, 0.11];
  const result = gridPeakMatch(sims, yaws);
  assert.equal(result.yaw, 150);
  assert.equal(result.sim0, 0.9265);
  assert.equal(result.confidence, 0.9265);
});

test("gridPeakMatch 拒绝长度不匹配或空输入", () => {
  assert.throws(() => gridPeakMatch([1, 2], [0]), /grid_peak_match_input_invalid/);
  assert.throws(() => gridPeakMatch([], []), /grid_peak_match_input_invalid/);
});

test("gridPeakMatch 附带最多 3 个候选方向，按置信度降序、不影响峰值判定本身", () => {
  const yaws = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  const sims = [0.10, 0.12, 0.15, 0.20, 0.87, 0.9265, 0.9099, 0.30, 0.25, 0.18, 0.14, 0.11];
  const result = gridPeakMatch(sims, yaws);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.candidates, [
    { yaw: 150, confidence: 0.9265 },
    { yaw: 180, confidence: 0.9099 },
    { yaw: 120, confidence: 0.87 }
  ]);
  // 峰值/margin 判定完全不受候选列表影响
  assert.equal(result.yaw, 150);
  assert.equal(result.confidence, 0.9265);
});

test("gridPeakMatch topK 可调；候选数不超过实际裁切数", () => {
  const yaws = [0, 30, 60];
  const sims = [0.5, 0.9, 0.3];
  const result = gridPeakMatch(sims, yaws, { topK: 5 });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].yaw, 30);
  const top1 = gridPeakMatch(sims, yaws, { topK: 1 });
  assert.deepEqual(top1.candidates, [{ yaw: 30, confidence: 0.9 }]);
});

test("gridPeakMatch 候选按 yaw 去重，只保留分数最高的一条（跨节点重复 yaw 场景）", () => {
  const yaws = [0, 0, 30];
  const sims = [0.6, 0.8, 0.5];
  const result = gridPeakMatch(sims, yaws);
  assert.deepEqual(result.candidates, [{ yaw: 0, confidence: 0.8 }, { yaw: 30, confidence: 0.5 }]);
});

test("cosineSimilarity 对归一化向量等价于点积；对非归一化向量会先除模长", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([2, 0], [3, 0]) - 1) < 1e-9); // 方向相同，模长不同也该是 1
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0); // 零向量不炸，只是给不出方向 -> 0
});

test("matchAgainstBank 端到端：从裁切库里选出相似度最高的 yaw 并算出 margin", () => {
  const bank = {
    embeddings: [
      [1, 0, 0], // yaw0
      [0.9, 0.1, 0], // yaw30, 接近 query
      [0, 1, 0], // yaw60
      [0, 0, 1] // yaw90
    ],
    yaws: [0, 30, 60, 90]
  };
  const query = [1, 0, 0];
  const result = matchAgainstBank(query, bank);
  assert.equal(result.yaw, 0);
  assert.equal(result.confidence, 1);
  assert.ok(result.margin > 0);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].yaw, 0);
});

test("classifyMatch: 两项都过线 -> same_scene_high", () => {
  const { classification, reason } = classifyMatch({ confidence: 0.90, margin: 0.12 });
  assert.equal(classification, "same_scene_high");
  assert.match(reason, /两项都达标/);
});

test("classifyMatch: 两项都不过线 -> uncertain，理由提到两项都偏低", () => {
  // 数字相对 2026-08-17 真实照片阈值(confidenceMin 0.50 / marginMin 0.02)取，两个都故意
  // 压在门槛以下，不能沿用老阈值时代的 0.60/0.03(那两个数现在都过线了)。
  const { classification, reason } = classifyMatch({ confidence: 0.35, margin: 0.01 });
  assert.equal(classification, "uncertain");
  assert.match(reason, /匹配度.*偏低/);
  assert.match(reason, /辨识度.*也偏低/);
});

test("classifyMatch: confidence 达标但 margin 不够 -> uncertain，理由指名 margin", () => {
  const { classification, reason } = classifyMatch({ confidence: 0.90, margin: 0.01 });
  assert.equal(classification, "uncertain");
  assert.match(reason, /匹配度.*够高/);
  assert.match(reason, /辨识度只有/);
});

test("classifyMatch: margin 达标但 confidence 不够 -> uncertain，理由指名 confidence", () => {
  const { classification, reason } = classifyMatch({ confidence: 0.35, margin: 0.12 });
  assert.equal(classification, "uncertain");
  assert.match(reason, /辨识度.*够/);
  assert.match(reason, /但匹配度只有/);
});

test("classifyMatch: 边界值恰好等于门槛也算达标（>=，不是 >）", () => {
  const { confidenceMin, marginMin } = DEFAULT_THRESHOLDS;
  const { classification } = classifyMatch({ confidence: confidenceMin, margin: marginMin });
  assert.equal(classification, "same_scene_high");
});

test("classifyMatch: 支持自定义阈值(每场景重新标定，不写死默认值)", () => {
  const custom = { confidenceMin: 0.5, marginMin: 0.01 };
  const { classification } = classifyMatch({ confidence: 0.55, margin: 0.02 }, custom);
  assert.equal(classification, "same_scene_high");
  const { classification: rejected } = classifyMatch({ confidence: 0.45, margin: 0.02 }, custom);
  assert.equal(rejected, "uncertain");
});

test("历史标定数据回归(2026-08-16 ai-template-space，AI 生成素材)：钉在当时的显式阈值上，" +
  "不再随 DEFAULT_THRESHOLDS 变化 —— 这组阈值 2026-08-17 已被真实照片标定取代，" +
  "见 match.mjs 里 DEFAULT_THRESHOLDS 头顶的说明。这里只是保留历史数据本身的回归价值" +
  "(证明这批 AI 生成素材在它自己的阈值下确实场内全过、外来全拒)，不再断言它是当前默认行为。", () => {
  const legacyThresholds = { confidenceMin: 0.72, marginMin: 0.075 };
  const inScene = [
    { confidence: 0.7833, margin: 0.0999 },
    { confidence: 0.8008, margin: 0.1367 },
    { confidence: 0.8151, margin: 0.1359 },
    { confidence: 0.8346, margin: 0.1324 },
    { confidence: 0.8632, margin: 0.1434 },
    { confidence: 0.8692, margin: 0.1471 }
  ];
  const foreign = [
    { confidence: 0.5740, margin: 0.0645 },
    { confidence: 0.5527, margin: 0.0629 },
    { confidence: 0.6105, margin: 0.0578 },
    { confidence: 0.6100, margin: 0.0477 }
  ];
  for (const sample of inScene) assert.equal(classifyMatch(sample, legacyThresholds).classification, "same_scene_high");
  for (const sample of foreign) assert.equal(classifyMatch(sample, legacyThresholds).classification, "uncertain");
});

test("真实标定数据回归(2026-08-17，65 张 AdventureX 真实现场照片 + 真实场馆全景，" +
  "对 DEFAULT_THRESHOLDS 生效)：中位数样本自动落位，明显偏低的样本仍进人工", () => {
  // 数字来自报告里的实测汇总表(本场馆真实照片 n=30 / 外来全景对照)，不是逐张样本，
  // margin 用该组的实测中位数代替 —— 汇总统计本身就是这次标定的证据，不是编出来的。
  // in-venue 中位数：conf 0.584 / margin 0.041，两项都过新阈值(0.50 / 0.02) -> 自动落位。
  assert.equal(classifyMatch({ confidence: 0.584, margin: 0.041 }).classification, "same_scene_high");
  // 明显偏低的输入（比如 conf 0.30，低于 in-venue 实测最小值 0.370，模拟"这张八成不是这儿拍的"
  // 的情形）应该老实进人工，而不是被新的低阈值捞进去。
  assert.equal(classifyMatch({ confidence: 0.30, margin: 0.01 }).classification, "uncertain");
});

test("真实标定数据回归：in-venue 实测最小值(conf 0.370)低于新 CONF_MIN，" +
  "这批真实照片里确实有过不了自动落位的(28/30 能过，不是 30/30)", () => {
  assert.equal(classifyMatch({ confidence: 0.370, margin: 0.041 }).classification, "uncertain");
});

test("已知代价(需要写进报告告诉 Max)：外来全景对照组的实测最大值(conf 0.597)超过新 CONF_MIN，" +
  "会被误判为 same_scene_high —— 这是刻意接受的代价（约 8/30 ≈ 27% 的外来样本会被这样收进来)，" +
  "不是这次改动引入的 bug，换回旧阈值不成立(真实照片够不到旧阈值)才是真正的生产问题。", () => {
  assert.equal(classifyMatch({ confidence: 0.597, margin: 0.049 }).classification, "same_scene_high");
});

test("clipThresholdsFromEnv: 两个 env 变量都没设置 -> 原样退回 DEFAULT_THRESHOLDS", () => {
  assert.deepEqual(clipThresholdsFromEnv({}), DEFAULT_THRESHOLDS);
});

test("clipThresholdsFromEnv: 支持只覆盖一个变量，另一个照样退回默认值（不用两个都填）", () => {
  const result = clipThresholdsFromEnv({ UNSEEN_CLIP_CONF_MIN: "0.55" });
  assert.equal(result.confidenceMin, 0.55);
  assert.equal(result.marginMin, DEFAULT_THRESHOLDS.marginMin);
});

test("clipThresholdsFromEnv: 两个变量都覆盖，线上调参不用重新部署", () => {
  const result = clipThresholdsFromEnv({ UNSEEN_CLIP_CONF_MIN: "0.6", UNSEEN_CLIP_MARGIN_MIN: "0.05" });
  assert.deepEqual(result, { confidenceMin: 0.6, marginMin: 0.05 });
});

test("clipThresholdsFromEnv: 非法值(非数字、超出 [0,1] 范围)老实退回默认值，不静默夹紧、不产出 NaN", () => {
  assert.equal(clipThresholdsFromEnv({ UNSEEN_CLIP_CONF_MIN: "not-a-number" }).confidenceMin, DEFAULT_THRESHOLDS.confidenceMin);
  assert.equal(clipThresholdsFromEnv({ UNSEEN_CLIP_CONF_MIN: "1.5" }).confidenceMin, DEFAULT_THRESHOLDS.confidenceMin);
  assert.equal(clipThresholdsFromEnv({ UNSEEN_CLIP_MARGIN_MIN: "-0.1" }).marginMin, DEFAULT_THRESHOLDS.marginMin);
  assert.equal(clipThresholdsFromEnv({ UNSEEN_CLIP_CONF_MIN: "" }).confidenceMin, DEFAULT_THRESHOLDS.confidenceMin);
});

test("clipThresholdsFromEnv: 支持自定义 defaults 参数，方便单测/调用方不依赖全局 DEFAULT_THRESHOLDS", () => {
  const customDefaults = { confidenceMin: 0.42, marginMin: 0.03 };
  assert.deepEqual(clipThresholdsFromEnv({}, customDefaults), customDefaults);
});
