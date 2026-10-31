import { assert } from "./errors.mjs";
import { id, json, sha256, stableJson } from "./util.mjs";
import { disabledLocatorFixture } from "./ports/locator/deterministic-locator-fixture.mjs";

export class JobQueue {
  constructor(core, locatorFixture = disabledLocatorFixture) {
    this.core = core;
    this.db = core.db;
    this.locatorFixture = locatorFixture;
  }

  enqueue(type, spaceId, refs) {
    const jobId = id("job");
    if (type === "photo_placement") {
      refs = this.locatorFixture.decorate(this.db, refs, this.core.now());
      assert(refs.spaceId === spaceId && typeof refs.sceneId === "string" &&
        typeof refs.mediaSha256 === "string" && /^[a-f0-9]{64}$/.test(refs.mediaSha256) &&
        ((refs.policyReleaseId == null && refs.policyVersion == null) ||
          (typeof refs.policyReleaseId === "string" && Number.isSafeInteger(refs.policyVersion))),
      "job_input_unavailable", 409);
    }
    const inputHash = sha256(stableJson(refs));
    const now = this.core.now();
    this.db.prepare(`INSERT INTO jobs(
      id,space_id,type,input_refs_json,input_hash,status,attempts,algorithm_release_id,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,'queued',0,?,?,?,1)`).run(jobId, spaceId, type, json(refs), inputHash,
    type === "photo_placement" ? refs.policyReleaseId : null, now, now);
    return { jobId, status: "queued", inputHash, version: 1 };
  }

  get(jobId) {
    const job = this.core.one("SELECT * FROM jobs WHERE id=?", jobId);
    assert(job, "job_unavailable", 404);
    return { jobId: job.id, spaceId: job.space_id, type: job.type, status: job.status,
      attempts: job.attempts, stableError: job.stable_error, result: job.result_json ? JSON.parse(job.result_json) : null,
      version: job.version, createdAt: job.created_at, updatedAt: job.updated_at };
  }
}
