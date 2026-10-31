// services/locator/src/match.mjs
//
// CLIP 定位的打分/阈值/拒绝逻辑 —— 纯函数，不碰网络、不碰模型，只吃 embedding 数组。
// 移植自 /Users/max/code/spatial-memory 的 server/space.py（_match_grid_peak + place_photos +
// CONF_MIN/MARGIN_MIN 判定块），算法上刻意保持三条旧仓库踩过坑之后定下的规矩：
//
//   1. 只取 30° 网格峰值，不做 tools/match.py 那种 ±30° 插值精修。旧仓库实测过插值会把
//      yaw 拖偏 15°、还反而把 confidence 报得更高（004.jpg 案例：正确答案 150，插值给
//      164.9，因为 CLIP 对同一房间不同朝向裁切的余弦相似度整条曲线都挤在 0.7~0.95，插值
//      权重 s1/(s0+s1) 恒等于 0.5 上下，结果永远滑向"峰值和次优邻居的中点"）。网格 30°
//      一格，yaw 精度诚实到 ±15°，不伪造小数位。
//   2. confidence = 全部裁切里最高的余弦相似度（embedding 已 L2 归一化，点积即 cosine sim）。
//   3. margin = 最佳相似度 - 全部裁切的平均相似度，是判定二里的冗余闸（旧仓库两轮标定发现
//      margin 有时挡不了外来照片、有时是唯一挡住的信号，场景一换就要重新看，不能默认它
//      "场景无关"）。

/** 网格峰值之外，再按分数排出最多 topK 个候选方向 —— 只是把 gridPeakMatch 已经算出的
 * 那条相似度曲线重新排序取前几名，不引入新的比对逻辑，也不影响 gridPeakMatch/classifyMatch
 * 的判定结果，纯粹给人工队列的"AI 候选方向"展示用。同一 yaw 只保留分数最高的一条
 * （matchAgainstBank 允许跨节点 yaw 重复，展示层不想让审核者看到两个一模一样的方向）。 */
function topPeakCandidates(sims, yaws, topK) {
  const bestByYaw = new Map();
  for (let i = 0; i < sims.length; i += 1) {
    const yaw = yaws[i];
    const confidence = Math.min(1, Math.max(0, sims[i]));
    if (!bestByYaw.has(yaw) || confidence > bestByYaw.get(yaw)) bestByYaw.set(yaw, confidence);
  }
  return [...bestByYaw.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([yaw, confidence]) => ({ yaw, confidence }));
}

/** 12 张裁切的相似度里取网格峰值。sims/yaws 必须等长且非空。
 * 附带返回 candidates：最多 topK 个候选方向(默认 3)，按置信度降序，供人工队列展示。 */
export function gridPeakMatch(sims, yaws, { topK = 3 } = {}) {
  if (!Array.isArray(sims) || !Array.isArray(yaws) || sims.length === 0 || sims.length !== yaws.length) {
    throw new Error("grid_peak_match_input_invalid");
  }
  let top = 0;
  for (let i = 1; i < sims.length; i += 1) if (sims[i] > sims[top]) top = i;
  const sim0 = sims[top];
  const mean = sims.reduce((sum, value) => sum + value, 0) / sims.length;
  return {
    yaw: yaws[top],
    sim0,
    confidence: Math.min(1, Math.max(0, sim0)),
    margin: sim0 - mean,
    candidates: topPeakCandidates(sims, yaws, topK)
  };
}

/** 归一化向量的余弦相似度 = 点积（sidecar 已经用 normalize_embeddings=True 保证这一点，
 * 这里仍显式除以模长，不悄悄假设调用方守规矩 —— 假设错了就该在这里炸出来，而不是在阈值
 * 判定那一步悄悄给出一个偏小/偏大的错误分数）。 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error("embedding_dim_mismatch");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** 把一张照片的 embedding 和整座空间的裁切库比对，返回网格峰值匹配结果(含 candidates)。
 * bank = { embeddings: number[][], yaws: number[] }，跨节点比对时 yaws 允许重复
 * （不同节点各自的 0/30/…°），调用方自己按需要携带 nodeId 分段。 */
export function matchAgainstBank(photoEmbedding, bank, options) {
  const sims = bank.embeddings.map((crop) => cosineSimilarity(photoEmbedding, crop));
  return gridPeakMatch(sims, bank.yaws, options);
}

// 2026-08-17 重定阈值 —— 用 65 张 AdventureX 真实现场照片（iPhone 17 实拍，
// ~/code/unseen-assets/advx-photos/）+ 同场馆真实 360 全景（Insta360 X4，8000×4000）实测标定，
// 取代下面 2026-08-16 那组用 AI 生成素材标定的旧值。结论表（n=30 本场馆真实照片 vs 外来全景对照）：
//
//   判据      本场馆真实照片(n=30)              外来全景对照
//   conf      min 0.370 / 中位 0.584 / max 0.643   min 0.298 / 中位 0.465 / max 0.597
//   margin    中位 0.041                            中位 0.049（外来反而更高）
//
// 方向一致性：24/30 落在同一区域(210–240°，即舞台方向)，证明 CLIP 在真实照片上有真实的方向
// 判别力，问题不在模型，在旧阈值。
//
// ⚠️ 关键事实：旧值 CONF_MIN=0.72 / MARGIN_MIN=0.075 对真实照片完全不可达 —— 真实照片 conf
// 最高只到 0.643，没有一张能同时过双阈值。这是生产上"自动落位从未发生"（9 条 confirmation_mode
// 记录全是 manual）的直接原因。根源是 2026-08-16 那次标定用的是 AI 生成图（那批 conf 虚高
// 0.78~0.87，但方向全错，是"看起来自信、实际不认路"的典型案例）——AI 生成素材和真实手机照片
// 在 CLIP embedding 空间里的余弦相似度分布本身就不是同一条曲线，不能互相替代标定。
//
// 新值取舍：
//   confidenceMin: 0.72 → 0.50，real 照片 28/30 可通过；实测 conf≥0.50 时外来样本约 8/30
//     （~27%）会被一起放进来 —— 这是刻意接受的代价，宁可多收会错的、也要让自动落位这条路径
//     真正跑起来，错的可以在 badge 上一键改（见 dispatch/index.mjs classifyMatch 消费方的
//     "AI 定位 · 可修正" 标注），总比放着不用强。
//   marginMin: 0.075 → 0.02，实测这个判据对区分"是不是这个空间拍的"基本无效，外来样本的
//     margin 中位数（0.049）甚至比本场馆真实样本（0.041）更高，是反向信号。保留一个极低值
//     只当退化保护（挡掉 sim0 和均值几乎相等、模型对哪个方向都一样没把握的病态输入），不能
//     指望它筛掉外来照片。
//
// ⚠️ 和上一版同样的教训：这组数字只在这一批真实照片、这一个场馆上成立，样本量仍然不大（n=30
// 场内 + 65 张总样本），换到风格差异很大的场馆/相机必须重新标定，不能当成放之四海而皆准的常数。
//
// 可通过 env 覆盖，不用重新部署就能线上调参：UNSEEN_CLIP_CONF_MIN / UNSEEN_CLIP_MARGIN_MIN
// （见 infra/integration/local-operable.mjs 的 clipThresholdsFromEnv() 调用点）。
export const DEFAULT_THRESHOLDS = Object.freeze({
  confidenceMin: 0.50,
  marginMin: 0.02
});

// 2026-08-16 用 unseen-assets/ai-template-space（全景 + 6 张同场景照片 + 4 张外来图）单场景标定
// 出的上一版阈值，原样留作历史记录（上面 DEFAULT_THRESHOLDS 已经取代它，不再生效）：
// confidenceMin 0.72 / marginMin 0.075，场内 confidence 0.7833~0.8692、外来 0.5527~0.6105，
// margin 场内 0.0999~0.1471、外来 0.0477~0.0645。这组数字在 AI 生成素材上看起来很干净（场内外
// 有 ~0.17 的间隙），但对真实照片完全不可达 —— 见上面 2026-08-17 的重新标定说明。

// 供 infra/integration/local-operable.mjs 从 process.env 组装线上可调阈值：两个 env 变量任一
// 缺失/非法都各自退回 DEFAULT_THRESHOLDS 对应的值，不做"要么都填要么都不填"的捆绑校验 —— 运维
// 只想调一个数字时不该被逼着把另一个也抄一遍。非法值（非有限数字，或不在 [0,1] 内——两个判据
// 都是余弦相似度量纲，理论上界就是 1）视同未设置，不静默夹紧、也不让 NaN 混进 classifyMatch()
// 的比较运算里悄悄把所有照片都判成 uncertain。
function envThreshold(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
export function clipThresholdsFromEnv(env = process.env, defaults = DEFAULT_THRESHOLDS) {
  return Object.freeze({
    confidenceMin: envThreshold(env.UNSEEN_CLIP_CONF_MIN, defaults.confidenceMin),
    marginMin: envThreshold(env.UNSEEN_CLIP_MARGIN_MIN, defaults.marginMin)
  });
}

/** 判定二：两个判据都过线才 same_scene_high，否则 uncertain，并给出人话理由方便审核台展示。
 * 与旧仓库 server/space.py 的四分支判定逐条对齐（都过/都不过/差 margin/差 confidence）。 */
export function classifyMatch({ confidence, margin }, thresholds = DEFAULT_THRESHOLDS) {
  const { confidenceMin, marginMin } = thresholds;
  const confOk = confidence >= confidenceMin;
  const marginOk = margin >= marginMin;
  if (confOk && marginOk) {
    return { classification: "same_scene_high",
      reason: `匹配度 ${confidence.toFixed(4)}、辨识度 ${margin.toFixed(4)}，两项都达标，自动入选` };
  }
  if (!confOk && !marginOk) {
    return { classification: "uncertain",
      reason: `匹配度 ${confidence.toFixed(4)} 偏低(门槛 ${confidenceMin.toFixed(4)})，` +
        `辨识度 ${margin.toFixed(4)} 也偏低(门槛 ${marginMin.toFixed(4)})，这张很可能不是在这个空间拍的，请你看一眼` };
  }
  if (!marginOk) {
    return { classification: "uncertain",
      reason: `匹配度 ${confidence.toFixed(4)} 够高，但辨识度只有 ${margin.toFixed(4)}` +
        `(低于门槛 ${marginMin.toFixed(4)})：它跟这个空间哪个方向都差不多像，机器拿不准是不是这儿拍的` };
  }
  return { classification: "uncertain",
    reason: `辨识度 ${margin.toFixed(4)} 够，但匹配度只有 ${confidence.toFixed(4)}` +
      `(低于门槛 ${confidenceMin.toFixed(4)})，方位可能不准，请你看一眼` };
}
