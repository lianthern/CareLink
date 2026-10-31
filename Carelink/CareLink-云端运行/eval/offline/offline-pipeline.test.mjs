import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertNoLeakage, evaluateOffline, prepareDataset, sha256 } from
  "../../services/locator/src/offline-pipeline.mjs";
import { runOfflineAbstainWorker, validateLocatorJobRequest } from
  "../../services/locator/src/worker-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function json(relative) {
  return JSON.parse(await readFile(path.join(repoRoot, relative)));
}

async function inputs() {
  const [manifestBytes, predictions, preregistration, releaseMetadata] = await Promise.all([
    readFile(path.join(repoRoot, "datasets/manifests/offline/synthetic-tooling-v0.json")),
    json("eval/offline/predictions.synthetic-tooling-v0.json"),
    json("eval/offline/preregistration.v1.json"),
    json("services/locator/releases/synthetic-tooling-v0.json")
  ]);
  return { manifest: JSON.parse(manifestBytes), manifestBytes, predictions, preregistration, releaseMetadata };
}

test("synthetic manifest dedupes, splits by stratified Space, and truthfully remains no-go", async () => {
  const value = await inputs();
  const prepared = prepareDataset(value.manifest, { manifestBytesSha256: sha256(value.manifestBytes) });
  assert.equal(prepared.inputSampleCount, 13);
  assert.equal(prepared.canonicalSampleCount, 12);
  assert.equal(prepared.exactDuplicatesRemoved, 1);
  assert.deepEqual(prepared.splitCounts, { calibration: 4, test: 4, train: 4 });
  assert.deepEqual(new Set(prepared.samples.filter((sample) => sample.split === "test")
    .map((sample) => sample.spaceId)), new Set(["syn-space-i3", "syn-space-o3"]));
  const report = evaluateOffline({ prepared, predictionsDocument: value.predictions,
    preregistration: value.preregistration, releaseMetadata: value.releaseMetadata });
  assert.equal(report.decision, "NO_GO_SYNTHETIC_FIXTURE");
  assert.equal(report.jointGatePassed, false);
  assert.equal(report.productionClaimsAllowed, false);
  assert.equal(report.sampleGate.testSpaces.actual, 2);
  assert.equal(report.sampleGate.evaluableIdClusters.actual, 2);
  assert.equal(report.sampleGate.oodClusters.actual, 2);
  assert.equal(report.endpoints.highConfirmedCorrectness.point, 1);
  assert.equal(report.endpoints.catastrophicDirection.point, 0);
  assert.equal(report.endpoints.oodHighFalseConfirm.point, 0);
  assert.equal(report.endpoints.highCoverage.point, 1);
  assert.ok(Math.abs(report.endpoints.highConfirmedCorrectness.bound - Math.sqrt(0.0125)) < 1e-12);
  assert.ok(Math.abs(report.endpoints.catastrophicDirection.bound - (1 - Math.sqrt(0.0125))) < 1e-12);
  assert.ok(Object.values(report.hashes).every((hash) => /^[a-f0-9]{64}$/.test(hash)));
});

test("byte drift, cross-Space content reuse, cluster crossing, and missing adjudication fail closed", async () => {
  const value = await inputs();
  const tampered = structuredClone(value.manifest);
  const bytes = Buffer.from(tampered.samples[0].media.payloadBase64, "base64");
  bytes[0] ^= 1;
  tampered.samples[0].media.payloadBase64 = bytes.toString("base64");
  assert.throws(() => prepareDataset(tampered), { code: "media_sha256_mismatch" });

  const crossSpaceHash = structuredClone(value.manifest);
  const source = crossSpaceHash.samples.find((sample) => sample.sampleId === "syn-space-i1-id");
  const target = crossSpaceHash.samples.find((sample) => sample.sampleId === "syn-space-i2-id");
  target.media = structuredClone(source.media);
  assert.throws(() => prepareDataset(crossSpaceHash), { code: "content_hash_cross_space" });

  const crossSpaceCluster = structuredClone(value.manifest);
  crossSpaceCluster.samples.find((sample) => sample.sampleId === "syn-space-i2-id").clusterId =
    "syn-cluster-i1-id";
  assert.throws(() => prepareDataset(crossSpaceCluster), { code: "cluster_cross_space" });

  const unadjudicated = structuredClone(value.manifest);
  unadjudicated.samples.find((sample) => sample.sampleId === "syn-space-i2-id").annotations.adjudication =
    { status: "not_required" };
  assert.throws(() => prepareDataset(unadjudicated), { code: "adjudication_required" });
});

test("leakage validator rejects Space, panorama, cluster, and content split drift", () => {
  const base = [
    { spaceId: "s1", panoramaId: "p1", clusterId: "c1", contentSha256: "a", split: "train" },
    { spaceId: "s1", panoramaId: "p2", clusterId: "c2", contentSha256: "b", split: "test" }
  ];
  assert.throws(() => assertNoLeakage(base), { code: "space_split_leakage" });
  for (const [key, code] of [["panoramaId", "panorama_split_leakage"],
    ["clusterId", "cluster_split_leakage"], ["contentSha256", "content_hash_split_leakage"]]) {
    const rows = structuredClone(base);
    rows[1].spaceId = "s2";
    rows[1][key] = rows[0][key];
    assert.throws(() => assertNoLeakage(rows), { code });
  }
});

test("offline worker requires the frozen seam and can only abstain without mutating input", async () => {
  const release = await json("services/locator/releases/synthetic-tooling-v0.json");
  const request = {
    spaceId: "space-1",
    sceneId: "scene-1",
    panoramaRevisionId: "panorama-revision-1",
    photoId: "photo-1",
    mediaSha256: "a".repeat(64),
    policyReleaseId: release.releaseId,
    policyVersion: 1
  };
  const before = structuredClone(request);
  const result = runOfflineAbstainWorker(request, release);
  assert.deepEqual(request, before);
  assert.equal(result.classification, "abstained");
  assert.equal(result.locatorProvenance.isProduction, false);
  for (const key of ["spaceId", "sceneId", "panoramaRevisionId", "photoId", "mediaSha256"]) {
    const incomplete = structuredClone(request);
    delete incomplete[key];
    assert.throws(() => validateLocatorJobRequest(incomplete), { code: `locator_job_${key}_invalid` });
  }
});

test("missing or foreign predictions cannot silently leave the registered denominator", async () => {
  const value = await inputs();
  const prepared = prepareDataset(value.manifest, { manifestBytesSha256: sha256(value.manifestBytes) });
  const missing = structuredClone(value.predictions);
  missing.predictions = missing.predictions.filter((prediction) => prediction.sampleId !== "syn-space-i3-id");
  assert.throws(() => evaluateOffline({ prepared, predictionsDocument: missing,
    preregistration: value.preregistration, releaseMetadata: value.releaseMetadata }),
  { code: "prediction_missing" });
  const foreign = structuredClone(value.predictions);
  foreign.predictions.push({ sampleId: "foreign-private-photo", classification: "abstained" });
  assert.throws(() => evaluateOffline({ prepared, predictionsDocument: foreign,
    preregistration: value.preregistration, releaseMetadata: value.releaseMetadata }),
  { code: "prediction_unknown_sample" });
});
