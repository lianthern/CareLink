import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runOfflineAbstainWorker } from "../src/worker-contract.mjs";

const releasePath = new URL("../releases/synthetic-tooling-v0.json", import.meta.url);

test("offline worker rejects a request bound to a different release version", async () => {
  const release = JSON.parse(await readFile(releasePath));
  const request = {
    spaceId: "space-1",
    sceneId: "scene-1",
    panoramaRevisionId: "panorama-revision-1",
    photoId: "photo-1",
    mediaSha256: "a".repeat(64),
    policyReleaseId: release.releaseId,
    policyVersion: release.releaseVersion + 1
  };

  assert.throws(() => runOfflineAbstainWorker(request, release), {
    code: "locator_policy_release_unavailable"
  });
});
