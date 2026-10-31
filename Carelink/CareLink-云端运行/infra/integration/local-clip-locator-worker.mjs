// infra/integration/local-clip-locator-worker.mjs
//
// 真实 CLIP 定位的本地 job worker —— infra/integration/local-locator-fixture.mjs 里
// createLocalFixtureWorker() 的姊妹实现，轮询同一张 jobs 表，但 photo_placement 这一支
// 换成真调用: 读照片字节 -> 调 sidecar 编码 -> 和全景裁切库比对 -> 阈值判定 -> dispatchOne。
//
// 设计上刻意不动 services/jobs/dispatch/index.mjs 一行：
//   - photo_validation / panorama_validation / export_generation 三种任务原样
//     dispatchOne(db, id, { now, locatorFixture, keyring: api.keyring })，让 ClipLocatorPort.decorate() 走它
//     已有的同步路径登记 algorithm_release。
//   - photo_placement 这一支的真实分类结果在事务外、异步算好，再作为显式 outcome 参数传给
//     dispatchOne(db, id, { now, outcome, keyring: api.keyring })（locatorFixture 留默认的 disabledLocatorFixture，
//     dispatch/index.mjs 的三元表达式就会用这个 outcome，不会去调 locatorFixture.outcome()）。
//     这是唯一让"CLIP 推理要 await、dispatchOne 内部事务必须同步"这两件事共存的办法。
//
// sidecar 连不上 / 超时 / 任何异常：一律归类为 "abstained"（模型放弃表态），
// 不归类成 "job_failed"。二者在 dispatch/index.mjs 里的落地天差地别：job_failed 会把
// placementState 打成 'failed'（一个新状态，UI 要专门处理）；abstained 走的是
// needs_confirmation 分支 —— 也就是【今天默认的人工定位路径】。sidecar 挂了应该优雅
// 退回"和没有真实定位时一模一样"的体验，而不是引入一个新的失败态。

import { dispatchOne } from "../../services/jobs/dispatch/index.mjs";
import { classifyMatch, matchAgainstBank } from "../../services/locator/src/match.mjs";

const JOB_TYPES = "'panorama_validation','photo_validation','photo_placement','export_generation'";

function assetBytesGetter(mediaStore, asset) {
  return async () => {
    const object = await mediaStore.get(asset.private_object_key, { maxBytes: asset.observed_bytes });
    return object.body;
  };
}

export function createClipLocatorWorker({
  api, locatorPort, sidecarClient, cropBankCache, thresholds,
  onDispatch = () => {}, onError = () => {}, onPlacementScored = () => {}, pollMs = 150
}) {
  let timer = null;
  let draining = false;
  let stopped = false;

  async function computePlacementOutcome(job, refs) {
    const provenanceBase = { mode: "clip_local_sidecar_v1", isProduction: false,
      policyReleaseId: refs.policyReleaseId ?? null, policyVersion: refs.policyVersion ?? null };
    if (!refs.policyReleaseId || !refs.panoramaRevisionId) {
      // 没有登记到 policy release（比如 locatorFixture 在 decorate 时被跳过），或者这个空间
      // 还没有可用全景 —— 两种都老实交回"没有可用策略"，落地到 needs_confirmation。
      return { classification: "no_active_policy", locatorProvenance: provenanceBase };
    }
    try {
      const photo = api.db.prepare("SELECT * FROM photos WHERE id=?").get(refs.photoId);
      if (!photo) return { classification: "abstained",
        locatorProvenance: { ...provenanceBase, error: "photo_unavailable" } };
      const photoAsset = api.db.prepare("SELECT * FROM assets WHERE id=?").get(photo.viewer_safe_asset_id);
      if (!photoAsset) return { classification: "abstained",
        locatorProvenance: { ...provenanceBase, error: "photo_asset_unavailable" } };
      const panoramaRevision = api.db.prepare("SELECT * FROM panorama_revisions WHERE id=?")
        .get(refs.panoramaRevisionId);
      if (!panoramaRevision) return { classification: "abstained",
        locatorProvenance: { ...provenanceBase, error: "panorama_revision_unavailable" } };
      const panoramaAsset = api.db.prepare("SELECT * FROM assets WHERE id=?").get(panoramaRevision.asset_id);
      if (!panoramaAsset) return { classification: "abstained",
        locatorProvenance: { ...provenanceBase, error: "panorama_asset_unavailable" } };

      const bank = await cropBankCache.get(refs.panoramaRevisionId,
        assetBytesGetter(api.mediaStore, panoramaAsset));
      const photoBytes = await assetBytesGetter(api.mediaStore, photoAsset)();
      const { embedding } = await sidecarClient.embedPhoto(photoBytes);
      const match = matchAgainstBank(embedding, bank);
      const { classification, reason } = classifyMatch(match, thresholds);
      const locatorProvenance = { ...provenanceBase, confidence: Number(match.confidence.toFixed(4)),
        margin: Number(match.margin.toFixed(4)), reason };
      onPlacementScored({ photoId: refs.photoId, yaw: match.yaw, confidence: match.confidence,
        margin: match.margin, classification });
      if (classification === "same_scene_high") {
        return { classification, algorithmReleaseId: refs.policyReleaseId,
          panoramaRevisionId: refs.panoramaRevisionId, yaw: match.yaw, locatorProvenance };
      }
      // 低置信转人工：把 gridPeakMatch 顺带算好的候选方向(最多 3 个，按置信度降序)一并交回去，
      // 好让 dispatch/index.mjs 的 placement() 落一条 placement_suggestions，供人工队列展示
      // "AI 候选方向"。candidates 始终来自这次真实算出来的相似度曲线，不是伪造的默认值。
      const candidates = (match.candidates ?? []).map((candidate) => ({
        yaw: candidate.yaw, confidence: Number(candidate.confidence.toFixed(4)) }));
      return { classification: "uncertain", locatorProvenance, candidates };
    } catch (error) {
      return { classification: "abstained",
        locatorProvenance: { ...provenanceBase, error: error?.code ?? "clip_locator_worker_error",
          message: error?.message } };
    }
  }

  async function drain() {
    if (draining || stopped) return [];
    draining = true;
    const dispatched = [];
    try {
      for (let count = 0; count < 100; count += 1) {
        const job = api.db.prepare(`SELECT * FROM jobs WHERE status='queued' AND type IN (${JOB_TYPES})
          ORDER BY created_at,id LIMIT 1`).get();
        if (!job) break;
        const now = new Date().toISOString();
        let result;
        let scored = null;
        if (job.type === "photo_placement") {
          const refs = JSON.parse(job.input_refs_json);
          scored = await computePlacementOutcome(job, refs);
          result = dispatchOne(api.db, job.id, { now, outcome: scored, keyring: api.keyring });
        } else {
          result = dispatchOne(api.db, job.id, { now, locatorFixture: locatorPort, keyring: api.keyring });
        }
        const record = { dispatchedAt: now, requestId: job.id, jobId: job.id, jobType: job.type,
          status: result.status, locatorMode: "clip_local_sidecar_v1", isProduction: false,
          ...(scored ? { placementClassification: scored.classification,
            outputState: result.placementState ?? null } : {}) };
        dispatched.push(record);
        onDispatch(record);
      }
      return dispatched;
    } catch (error) {
      stopped = true;
      onError(error);
      throw error;
    } finally {
      draining = false;
    }
  }

  return {
    drain,
    start() {
      if (timer) throw new Error("clip_locator_worker_already_started");
      stopped = false;
      timer = setInterval(() => { void drain().catch(() => {}); }, pollMs);
      timer.unref?.();
      void drain().catch(() => {});
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      while (draining) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
}

export async function readAssetBytes(mediaStore, asset) {
  return assetBytesGetter(mediaStore, asset)();
}

// 供启动脚本判断 sidecar 是否已经就绪，不属于 worker 本身逻辑但放在一起方便调用方 import 一处。
export async function waitForSidecarReady(sidecarClient, { attempts = 60, intervalMs = 500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const health = await sidecarClient.healthz();
      if (health?.ok) return health;
    } catch { /* 还没起来，继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("clip_sidecar_not_ready");
}
