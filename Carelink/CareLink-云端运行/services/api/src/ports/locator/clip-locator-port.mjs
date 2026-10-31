import { assert } from "../../errors.mjs";
import { sha256 } from "../../util.mjs";

// algorithm_releases 里这条记录的固定身份：一次移植 = 一个 release id，版本号变了代表模型/
// 阈值策略变了(比如 CONF_MIN 重新标定)，跟 DeterministicLocatorFixture 的 release 记法一致，
// 好让 dispatch/index.mjs 的 stale 检查(policyReleaseId/policyVersion)照常工作，不用改它一行。
export const CLIP_LOCATOR_RELEASE_ID = "algorithm_release_clip_vit_b32_local_v1";
export const CLIP_LOCATOR_RELEASE_VERSION = 1;

// ⚠️ 许可证如实记录（2026-08-16 调研结论，供 Max 复核，测试期够用，正式生产前必须法务过一遍）：
//   - 代码：equirect->perspective 投影 + 网格峰值匹配，是 Max 自己在 spatial-memory 仓库写的，
//     这次原样移植，无第三方代码许可证问题。
//   - 模型结构 + 训练代码：OpenAI CLIP 开源仓库 (github.com/openai/CLIP)，MIT License。
//   - 模型权重：sentence-transformers 包装的 "clip-ViT-B-32"，底层是
//     huggingface.co/openai/clip-vit-base-patch32 —— 权重由 OpenAI 发布，随附的模型卡片
//     声明"研究用途优先，商用前需自行评估"（非 SPDX 标准许可证，是一份使用说明+免责声明）。
//     测试期内部验证可以用；如果要在正式生产环境对外提供服务，必须让 Max/法务确认这份权重的
//     使用范围覆盖"面向真实用户的自动照片定位"这个场景，必要时改用有明确商用许可证的权重
//     (比如 LAION 的 OpenCLIP 系列，Apache-2.0/MIT 更明确)。
const LICENSE_NOTE = "clip-ViT-B-32 (openai/clip-vit-base-patch32 权重): 代码 MIT，权重为 OpenAI" +
  " 模型卡片声明的研究导向许可，正式生产前需法务复核商用范围 —— 测试期内部验证范围内使用";

function fixedHash(seed) {
  return sha256(`unseen-clip-locator-v1:${seed}`);
}

const release = Object.freeze({
  id: CLIP_LOCATOR_RELEASE_ID,
  version: CLIP_LOCATOR_RELEASE_VERSION,
  codeHash: fixedHash("code:equirect-perspective+grid-peak-match:2026-08-16"),
  modelHash: fixedHash("model:clip-ViT-B-32:openai/clip-vit-base-patch32"),
  weightsHash: fixedHash("weights:openai/clip-vit-base-patch32:sentence-transformers-wrapper"),
  preprocessHash: fixedHash("preprocess:equirect-to-perspective:fov70:yaw30step:crop800x600"),
  calibratorHash: fixedHash("calibrator:none"),
  datasetHash: fixedHash("dataset:unseen-assets/ai-template-space:2026-08-16"),
  policyHash: fixedHash("policy:confMin+marginMin:v1")
});

/**
 * 真实 CLIP 定位的 locator port —— 和 DeterministicLocatorFixture 同一套接口形状
 * (decorate(db, refs, now))，好让 services/api/src/jobs.mjs 的 JobQueue.enqueue() 和
 * services/jobs/dispatch/index.mjs 的 photoValidation() 两条已有的调用路径原样复用，
 * 不用改动这两个文件。
 *
 * ⚠️ 这个类只负责 decorate()（同步、只登记 algorithm_release 元数据，不碰模型/网络）。
 * 真正跑 CLIP 推理是异步的（要读文件 + 调 sidecar HTTP），跟 dispatchOne() 内部同步事务的
 * 假设对不上，所以【不实现】DeterministicLocatorFixture 那种 outcome(refs, classification)
 * 同步接口 —— 真实分类结果由 infra/integration/local-clip-locator-worker.mjs 在事务外算好，
 * 再作为 dispatchOne(db, jobId, { outcome }) 的显式参数传入(locatorFixture 用默认的
 * disabledLocatorFixture，走 outcome 分支，不会误触发 locatorFixture.outcome())。
 */
export class ClipLocatorPort {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled === true;
    this.classification = "uncertain"; // 兼容字段：万一有代码路径读 .classification 兜底
  }

  decorate(db, refs, now) {
    if (!this.enabled) return refs;
    db.prepare(`INSERT OR IGNORE INTO algorithm_releases(
      id,code_hash,model_hash,weights_hash,preprocess_hash,calibrator_hash,dataset_hash,policy_hash,
      license_status,frozen_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(release.id, release.codeHash, release.modelHash,
    release.weightsHash, release.preprocessHash, release.calibratorHash, release.datasetHash,
    release.policyHash, LICENSE_NOTE, now, release.version);
    return { ...refs, policyReleaseId: release.id, policyVersion: release.version,
      locatorRuntimeMode: "clip_local_sidecar_v1" };
  }

  /** 供 worker 组装 outcome 时用：校验它准备贴的 algorithmReleaseId/policyVersion 和这里
   * decorate() 登记的是同一条，避免手滑对不上导致 dispatch/index.mjs 的 active_policy_unavailable。 */
  assertOwnRelease(policyReleaseId, policyVersion) {
    assert(policyReleaseId === release.id && policyVersion === release.version,
      "clip_locator_release_mismatch", 500);
  }
}

export const disabledClipLocator = Object.freeze(new ClipLocatorPort({ enabled: false }));
