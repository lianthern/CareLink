import { assert } from "../../errors.mjs";
import { sha256 } from "../../util.mjs";

export const LOCAL_LOCATOR_FIXTURE_RELEASE_ID = "algorithm_release_local_locator_fixture_v1";

const release = Object.freeze({
  id: LOCAL_LOCATOR_FIXTURE_RELEASE_ID,
  codeHash: sha256("unseen-local-deterministic-locator-code-v1"),
  modelHash: sha256("unseen-local-deterministic-locator-no-model-v1"),
  weightsHash: sha256("unseen-local-deterministic-locator-no-weights-v1"),
  preprocessHash: sha256("unseen-local-deterministic-locator-preprocess-v1"),
  calibratorHash: sha256("unseen-local-deterministic-locator-calibrator-v1"),
  datasetHash: sha256("unseen-local-deterministic-synthetic-fixture-v1"),
  policyHash: sha256("unseen-local-deterministic-locator-policy-v1")
});

export class DeterministicLocatorFixture {
  constructor({ enabled = false, classification = "uncertain" } = {}) {
    assert(["same_scene_high", "uncertain", "failed"].includes(classification),
      "locator_fixture_unavailable", 503);
    this.enabled = enabled === true;
    this.classification = classification;
  }

  decorate(db, refs, now) {
    if (!this.enabled) return refs;
    db.prepare(`INSERT OR IGNORE INTO algorithm_releases(
      id,code_hash,model_hash,weights_hash,preprocess_hash,calibrator_hash,dataset_hash,policy_hash,
      license_status,frozen_at,version
    ) VALUES(?,?,?,?,?,?,?,?, 'local_fixture_only',?,1)`).run(release.id, release.codeHash, release.modelHash,
    release.weightsHash, release.preprocessHash, release.calibratorHash, release.datasetHash, release.policyHash, now);
    return { ...refs, policyReleaseId: release.id, policyVersion: 1,
      locatorRuntimeMode: "deterministic_local_fixture" };
  }

  outcome(refs, classification = this.classification) {
    if (!this.enabled) return null;
    assert(["same_scene_high", "uncertain", "failed"].includes(classification),
      "locator_fixture_unavailable", 503);
    const locatorProvenance = { mode: "deterministic_local_fixture", isProduction: false,
      policyReleaseId: release.id, policyVersion: 1 };
    if (classification === "same_scene_high") {
      const yawSeed = Number.parseInt(sha256(refs.photoId).slice(0, 8), 16);
      return { classification, algorithmReleaseId: release.id, panoramaRevisionId: refs.panoramaRevisionId,
        yaw: (yawSeed % 36000) / 100 - 180, locatorProvenance };
    }
    if (classification === "failed") return { classification: "job_failed", locatorProvenance };
    return { classification: "uncertain", locatorProvenance };
  }
}

export const disabledLocatorFixture = Object.freeze(new DeterministicLocatorFixture());
