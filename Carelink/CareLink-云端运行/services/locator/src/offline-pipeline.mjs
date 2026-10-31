import { createHash } from "node:crypto";

const SPLITS = new Set(["train", "calibration", "test"]);
const PREDICTIONS = new Set(["high", "uncertain", "ood", "ambiguous", "abstained", "failed", "timed_out"]);

export class LocatorOfflineError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = (code) => { throw new LocatorOfflineError(code); };
const check = (condition, code) => { if (!condition) fail(code); };
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export const stableJson = (value) => JSON.stringify(sortValue(value));
const stableHash = (value) => sha256(stableJson(value));
const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const bytewise = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const circularDistance = (left, right) => Math.abs((((left - right) % 360) + 540) % 360 - 180);

function validateProvenance(manifest) {
  check(manifest.schemaVersion === "unseen.locator.offline-manifest.v1", "manifest_schema_unsupported");
  check(manifest.classification === "synthetic_fixture" && manifest.releaseEligible === false,
    "offline_manifest_must_be_synthetic_nonrelease");
  check(manifest.license?.spdxId === "LicenseRef-UNSEEN-Synthetic-Fixture-Internal" &&
    manifest.license?.allowsCommercialUse === false && manifest.license?.allowsRedistribution === false &&
    manifest.license?.scope === "internal_offline_tooling_only" && typeof manifest.license?.evidence === "string",
  "fixture_license_incomplete");
  check(manifest.purpose?.allowedUses?.includes("offline_tooling_validation") &&
    manifest.purpose?.prohibitedUses?.includes("production_release") &&
    manifest.purpose?.prohibitedUses?.includes("model_training") &&
    manifest.purpose?.prohibitedUses?.includes("shadow_gate"), "fixture_purpose_incomplete");
  check(manifest.retention?.policy === "retain_with_repository" && manifest.retention?.expiresAt === null &&
    typeof manifest.retention?.deletionTrigger === "string", "fixture_retention_incomplete");
  check(manifest.source?.type === "authored_synthetic_bytes" &&
    manifest.source?.containsHistoricalPrivateMedia === false && manifest.source?.containsPersonalData === false &&
    typeof manifest.source?.createdBy === "string" && typeof manifest.source?.createdAt === "string",
  "fixture_source_incomplete");
}

function validateLabel(label, domain) {
  check(label && typeof label === "object", "annotation_label_missing");
  for (const key of ["sameScene", "evaluable", "ambiguous", "multiSolution"]) {
    check(typeof label[key] === "boolean", `annotation_${key}_invalid`);
  }
  check(label.yawDeg === null || (finite(label.yawDeg) && label.yawDeg >= -180 && label.yawDeg < 180),
    "annotation_yaw_invalid");
  if (domain === "ood") check(label.sameScene === false && label.yawDeg === null, "ood_annotation_invalid");
  if (label.sameScene && label.evaluable) check(finite(label.yawDeg), "evaluable_id_yaw_missing");
}

function sameLabel(left, right) {
  return left.sameScene === right.sameScene && left.evaluable === right.evaluable &&
    left.ambiguous === right.ambiguous && left.multiSolution === right.multiSolution &&
    (left.yawDeg === right.yawDeg || (finite(left.yawDeg) && finite(right.yawDeg) &&
      circularDistance(left.yawDeg, right.yawDeg) < 1e-9));
}

function resolveAnnotation(sample) {
  const annotations = sample.annotations;
  check(annotations && Array.isArray(annotations.independent) && annotations.independent.length === 2,
    "two_independent_annotations_required");
  const [left, right] = annotations.independent;
  check(left.annotatorId && right.annotatorId && left.annotatorId !== right.annotatorId,
    "independent_annotators_must_differ");
  check(left.blindedToModel === true && right.blindedToModel === true, "annotation_blinding_required");
  validateLabel(left.label, sample.domain);
  validateLabel(right.label, sample.domain);
  const fields = ["sameScene", "evaluable", "ambiguous", "multiSolution"]
    .filter((key) => left.label[key] !== right.label[key]);
  if (left.label.yawDeg !== right.label.yawDeg) fields.push("yawDeg");
  const declared = annotations.disagreement;
  check(declared?.present === (fields.length > 0), "disagreement_flag_mismatch");
  check(stableJson([...(declared?.fields ?? [])].sort()) === stableJson([...fields].sort()),
    "disagreement_fields_mismatch");
  if (fields.length) {
    check(annotations.adjudication?.status === "resolved" && annotations.adjudication?.adjudicatorId &&
      ![left.annotatorId, right.annotatorId].includes(annotations.adjudication.adjudicatorId) &&
      typeof annotations.adjudication.ruleId === "string", "adjudication_required");
    validateLabel(annotations.adjudication.label, sample.domain);
    return annotations.adjudication.label;
  }
  check(annotations.adjudication?.status === "not_required" && sameLabel(left.label, right.label),
    "agreement_adjudication_invalid");
  return left.label;
}

function validateMedia(sample) {
  check(sample.media?.encoding === "base64" && typeof sample.media.payloadBase64 === "string",
    "media_payload_invalid");
  const bytes = Buffer.from(sample.media.payloadBase64, "base64");
  check(bytes.toString("base64") === sample.media.payloadBase64, "media_base64_noncanonical");
  check(Number.isSafeInteger(sample.media.bytes) && sample.media.bytes === bytes.length, "media_bytes_mismatch");
  check(isSha256(sample.media.sha256) && sample.media.sha256 === sha256(bytes), "media_sha256_mismatch");
}

function assignSpaces(samples, policy) {
  check(policy?.unit === "space" && policy?.stratifyBy === "spaceStratum" &&
    policy?.assignment === "sha256_sorted_round_robin_v1" && typeof policy?.seed === "string",
  "split_policy_invalid");
  check(Array.isArray(policy.splitOrder) && policy.splitOrder.length === 3 &&
    policy.splitOrder.every((split) => SPLITS.has(split)) && new Set(policy.splitOrder).size === 3,
  "split_order_invalid");
  const strata = new Map();
  const spaceStrata = new Map();
  for (const sample of samples) {
    check(typeof sample.spaceStratum === "string" && sample.spaceStratum, "space_stratum_missing");
    if (spaceStrata.has(sample.spaceId)) check(spaceStrata.get(sample.spaceId) === sample.spaceStratum,
      "space_stratum_conflict");
    spaceStrata.set(sample.spaceId, sample.spaceStratum);
  }
  for (const [spaceId, stratum] of spaceStrata) {
    const list = strata.get(stratum) ?? [];
    list.push(spaceId);
    strata.set(stratum, list);
  }
  const assignments = new Map();
  for (const spaces of strata.values()) {
    check(spaces.length >= policy.splitOrder.length, "stratum_too_small_for_split");
    spaces.sort((left, right) => bytewise(sha256(`${policy.seed}\0${left}`), sha256(`${policy.seed}\0${right}`)));
    spaces.forEach((spaceId, index) => assignments.set(spaceId, policy.splitOrder[index % policy.splitOrder.length]));
  }
  return assignments;
}

export function assertNoLeakage(samples) {
  for (const [key, field] of [["spaceId", "space"], ["panoramaId", "panorama"],
    ["clusterId", "cluster"], ["contentSha256", "content_hash"]]) {
    const splits = new Map();
    for (const sample of samples) {
      const seen = splits.get(sample[key]) ?? new Set();
      seen.add(sample.split);
      splits.set(sample[key], seen);
    }
    for (const seen of splits.values()) check(seen.size === 1, `${field}_split_leakage`);
  }
}

export function prepareDataset(manifest, { manifestBytesSha256 = stableHash(manifest) } = {}) {
  validateProvenance(manifest);
  check(isSha256(manifestBytesSha256), "manifest_bytes_sha256_invalid");
  check(Array.isArray(manifest.samples) && manifest.samples.length > 0, "manifest_samples_missing");
  const ids = new Set();
  const panoramaSpaces = new Map();
  const clusterSpaces = new Map();
  for (const sample of manifest.samples) {
    check(typeof sample.sampleId === "string" && sample.sampleId && !ids.has(sample.sampleId), "sample_id_invalid");
    ids.add(sample.sampleId);
    check(typeof sample.spaceId === "string" && typeof sample.panoramaId === "string" &&
      typeof sample.clusterId === "string" && ["id", "ood"].includes(sample.domain), "sample_group_invalid");
    validateMedia(sample);
    for (const [map, key, code] of [[panoramaSpaces, sample.panoramaId, "panorama_cross_space"],
      [clusterSpaces, sample.clusterId, "cluster_cross_space"]]) {
      if (map.has(key)) check(map.get(key) === sample.spaceId, code);
      map.set(key, sample.spaceId);
    }
  }

  const byHash = new Map();
  for (const sample of manifest.samples) {
    const group = byHash.get(sample.media.sha256) ?? [];
    group.push(sample);
    byHash.set(sample.media.sha256, group);
  }
  const canonical = [];
  const aliases = [];
  for (const [contentSha256, duplicates] of byHash) {
    const spaceIds = new Set(duplicates.map((sample) => sample.spaceId));
    check(spaceIds.size === 1, "content_hash_cross_space");
    for (const key of ["panoramaId", "clusterId", "domain"]) {
      check(new Set(duplicates.map((sample) => sample[key])).size === 1, `content_hash_${key}_conflict`);
    }
    duplicates.sort((left, right) => bytewise(left.sampleId, right.sampleId));
    const first = duplicates[0];
    const truth = resolveAnnotation(first);
    canonical.push({ ...first, contentSha256, truth });
    for (const duplicate of duplicates.slice(1)) {
      const duplicateTruth = resolveAnnotation(duplicate);
      check(sameLabel(truth, duplicateTruth), "duplicate_annotation_conflict");
      aliases.push({ sampleId: duplicate.sampleId, canonicalSampleId: first.sampleId, contentSha256 });
    }
  }

  const assignments = assignSpaces(canonical, manifest.splitPolicy);
  const preparedSamples = canonical.map((sample) => ({ ...sample, split: assignments.get(sample.spaceId) }));
  assertNoLeakage(preparedSamples);
  const splitCounts = Object.fromEntries([...SPLITS].sort().map((split) => [split,
    preparedSamples.filter((sample) => sample.split === split).length]));
  return {
    schemaVersion: "unseen.locator.prepared-dataset.v1",
    datasetId: manifest.datasetId,
    datasetVersion: manifest.datasetVersion,
    manifestBytesSha256,
    datasetContentSha256: stableHash(preparedSamples.map((sample) => ({
      sampleId: sample.sampleId,
      contentSha256: sample.contentSha256,
      spaceId: sample.spaceId,
      panoramaId: sample.panoramaId,
      clusterId: sample.clusterId,
      domain: sample.domain,
      truth: sample.truth,
      split: sample.split
    }))),
    inputSampleCount: manifest.samples.length,
    canonicalSampleCount: preparedSamples.length,
    exactDuplicatesRemoved: aliases.length,
    splitCounts,
    aliases,
    samples: preparedSamples
  };
}

function binomialRangeProbability(from, to, n, probability) {
  if (from > to) return 0;
  if (probability === 0) return from === 0 ? 1 : 0;
  if (probability === 1) return to === n ? 1 : 0;
  let logTerm = n * Math.log1p(-probability);
  const logs = [];
  for (let successes = 0; successes <= n; successes += 1) {
    if (successes >= from && successes <= to) logs.push(logTerm);
    if (successes < n) {
      logTerm += Math.log(n - successes) - Math.log(successes + 1) +
        Math.log(probability) - Math.log1p(-probability);
    }
  }
  const maximum = Math.max(...logs);
  return Math.exp(maximum) * logs.reduce((sum, value) => sum + Math.exp(value - maximum), 0);
}

function lowerExact(successes, total, alpha) {
  if (total === 0 || successes === 0) return total === 0 ? null : 0;
  let low = 0;
  let high = successes / total;
  for (let step = 0; step < 80; step += 1) {
    const middle = (low + high) / 2;
    if (binomialRangeProbability(successes, total, total, middle) < alpha) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function upperExact(successes, total, alpha) {
  if (total === 0 || successes === total) return total === 0 ? null : 1;
  let low = successes / total;
  let high = 1;
  for (let step = 0; step < 80; step += 1) {
    const middle = (low + high) / 2;
    if (binomialRangeProbability(0, successes, total, middle) > alpha) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function aggregateClusters(samples, predictions) {
  const clusters = new Map();
  for (const sample of samples.filter((entry) => entry.split === "test")) {
    const prediction = predictions.get(sample.sampleId);
    check(prediction, "prediction_missing");
    const list = clusters.get(sample.clusterId) ?? [];
    list.push({ sample, prediction });
    clusters.set(sample.clusterId, list);
  }
  return [...clusters.entries()].map(([clusterId, entries]) => {
    check(new Set(entries.map(({ sample }) => sample.domain)).size === 1, "cluster_domain_conflict");
    const high = entries.filter(({ prediction }) => prediction.classification === "high");
    const evaluable = entries.every(({ sample }) => sample.truth.evaluable);
    const correct = high.length > 0 && high.every(({ sample, prediction }) =>
      prediction.predictedSameScene === sample.truth.sameScene && prediction.predictedSameScene === true &&
      circularDistance(prediction.yawDeg, sample.truth.yawDeg) <= 45);
    const catastrophic = high.some(({ sample, prediction }) => prediction.predictedSameScene !== true ||
      circularDistance(prediction.yawDeg, sample.truth.yawDeg) > 90);
    return { clusterId, spaceId: entries[0].sample.spaceId, domain: entries[0].sample.domain,
      evaluable, high: high.length > 0, correct, catastrophic, sampleCount: entries.length };
  });
}

function endpoint(numerator, denominator, direction, threshold, alpha) {
  const point = denominator === 0 ? null : numerator / denominator;
  const bound = direction === "lower" ? lowerExact(numerator, denominator, alpha) :
    upperExact(numerator, denominator, alpha);
  const passed = bound !== null && (direction === "lower" ? bound >= threshold : bound <= threshold);
  return { numerator, denominator, point, boundType: direction, adjustedOneSidedAlpha: alpha, bound, threshold, passed };
}

function metricCounts(rows) {
  const id = rows.filter((row) => row.domain === "id" && row.evaluable);
  const high = id.filter((row) => row.high);
  const ood = rows.filter((row) => row.domain === "ood");
  return { id, high, ood };
}

function metricsFor(rows, thresholds, alpha) {
  const { id, high, ood } = metricCounts(rows);
  return {
    highConfirmedCorrectness: endpoint(high.filter((row) => row.correct).length, high.length,
      "lower", thresholds.highConfirmedCorrectness, alpha),
    catastrophicDirection: endpoint(high.filter((row) => row.catastrophic).length, high.length,
      "upper", thresholds.catastrophicDirection, alpha),
    oodHighFalseConfirm: endpoint(ood.filter((row) => row.high).length, ood.length,
      "upper", thresholds.oodHighFalseConfirm, alpha),
    highCoverage: endpoint(high.length, id.length, "lower", thresholds.highCoverage, alpha)
  };
}

function perSpace(clusters, thresholds, alpha) {
  const grouped = new Map();
  for (const cluster of clusters) {
    const list = grouped.get(cluster.spaceId) ?? [];
    list.push(cluster);
    grouped.set(cluster.spaceId, list);
  }
  return [...grouped.entries()].sort(([left], [right]) => bytewise(left, right)).map(([spaceId, rows]) => {
    const { id, ood } = metricCounts(rows);
    return { spaceId, evaluableIdClusters: id.length, oodClusters: ood.length,
      endpoints: metricsFor(rows, thresholds, alpha) };
  });
}

function worstSpace(spaces, endpointKey, direction) {
  const eligible = spaces.filter((space) => space.endpoints[endpointKey].point !== null);
  if (!eligible.length) return null;
  const compare = direction === "lower" ? (left, right) => left.endpoints[endpointKey].point -
    right.endpoints[endpointKey].point : (left, right) => right.endpoints[endpointKey].point -
      left.endpoints[endpointKey].point;
  const selected = [...eligible].sort(compare)[0];
  return { spaceId: selected.spaceId, ...selected.endpoints[endpointKey] };
}

export function evaluateOffline({ prepared, predictionsDocument, preregistration, releaseMetadata,
  hashes = {} }) {
  check(predictionsDocument.schemaVersion === "unseen.locator.predictions.v1" &&
    Array.isArray(predictionsDocument.predictions), "predictions_schema_invalid");
  check(releaseMetadata.schemaVersion === "unseen.locator.release-metadata.v1" &&
    releaseMetadata.releaseEligible === false && releaseMetadata.isProduction === false,
  "offline_release_metadata_invalid");
  check(predictionsDocument.releaseId === releaseMetadata.releaseId, "prediction_release_mismatch");
  check(preregistration.schemaVersion === "unseen.locator.preregistration.v1" &&
    preregistration.statisticalMethod === "bonferroni_clopper_pearson_exact" &&
    preregistration.familyWiseOneSidedAlpha === 0.05 && preregistration.perEndpointOneSidedAlpha === 0.0125,
  "preregistration_invalid");
  check(stableJson(releaseMetadata.thresholdPolicy) === stableJson(preregistration.thresholds),
    "threshold_policy_mismatch");

  const predictions = new Map();
  for (const prediction of predictionsDocument.predictions) {
    check(typeof prediction.sampleId === "string" && !predictions.has(prediction.sampleId) &&
      PREDICTIONS.has(prediction.classification), "prediction_invalid");
    if (prediction.classification === "high") {
      check(typeof prediction.predictedSameScene === "boolean", "high_same_scene_missing");
      check(prediction.predictedSameScene === false || (finite(prediction.yawDeg) &&
        prediction.yawDeg >= -180 && prediction.yawDeg < 180), "high_yaw_missing");
    }
    predictions.set(prediction.sampleId, prediction);
  }
  const canonicalIds = new Set(prepared.samples.map((sample) => sample.sampleId));
  for (const sampleId of predictions.keys()) check(canonicalIds.has(sampleId), "prediction_unknown_sample");
  const clusters = aggregateClusters(prepared.samples, predictions);
  const id = clusters.filter((cluster) => cluster.domain === "id" && cluster.evaluable);
  const ood = clusters.filter((cluster) => cluster.domain === "ood");
  const alpha = preregistration.perEndpointOneSidedAlpha;
  const endpoints = metricsFor(clusters, preregistration.thresholds, alpha);
  const spaces = new Set(clusters.map((cluster) => cluster.spaceId));
  const idBySpace = Object.fromEntries([...spaces].sort().map((spaceId) => [spaceId,
    id.filter((cluster) => cluster.spaceId === spaceId).length]));
  const minimums = preregistration.minimums;
  const sampleGate = {
    testSpaces: { actual: spaces.size, required: minimums.testSpaces, passed: spaces.size >= minimums.testSpaces },
    evaluableIdClusters: { actual: id.length, required: minimums.evaluableIdClusters,
      passed: id.length >= minimums.evaluableIdClusters },
    oodClusters: { actual: ood.length, required: minimums.oodClusters, passed: ood.length >= minimums.oodClusters },
    idClustersPerSpace: { actual: idBySpace, required: minimums.idClustersPerSpace,
      passed: spaces.size > 0 && Object.values(idBySpace).every((count) => count >= minimums.idClustersPerSpace) }
  };
  const sampleGatePassed = Object.values(sampleGate).every((gate) => gate.passed);
  const endpointGatePassed = Object.values(endpoints).every((metric) => metric.passed);
  const spacesReport = perSpace(clusters, preregistration.thresholds, alpha);
  const endpointKeys = Object.keys(endpoints);
  const macro = Object.fromEntries(endpointKeys.map((key) => {
    const values = spacesReport.map((space) => space.endpoints[key].point).filter((value) => value !== null);
    return [key, values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null];
  }));
  const worst = {
    highConfirmedCorrectness: worstSpace(spacesReport, "highConfirmedCorrectness", "lower"),
    catastrophicDirection: worstSpace(spacesReport, "catastrophicDirection", "upper"),
    oodHighFalseConfirm: worstSpace(spacesReport, "oodHighFalseConfirm", "upper"),
    highCoverage: worstSpace(spacesReport, "highCoverage", "lower")
  };
  const sampleRows = prepared.samples.filter((sample) => sample.split === "test").map((sample) => {
    const prediction = predictions.get(sample.sampleId);
    const high = prediction.classification === "high";
    return { domain: sample.domain, evaluable: sample.truth.evaluable, high,
      correct: high && prediction.predictedSameScene === sample.truth.sameScene &&
        prediction.predictedSameScene === true && circularDistance(prediction.yawDeg, sample.truth.yawDeg) <= 45,
      catastrophic: high && (prediction.predictedSameScene !== true ||
        circularDistance(prediction.yawDeg, sample.truth.yawDeg) > 90) };
  });
  return {
    schemaVersion: "unseen.locator.offline-evidence.v1",
    status: "EVALUATED_NO_GO",
    decision: "NO_GO_SYNTHETIC_FIXTURE",
    releaseId: releaseMetadata.releaseId,
    productionClaimsAllowed: false,
    thresholdPassClaimAllowed: false,
    reasons: [
      ...(!sampleGatePassed ? ["minimum_sample_gate_not_met"] : []),
      ...(!endpointGatePassed ? ["joint_adjusted_bounds_not_met"] : []),
      "synthetic_fixture_not_release_eligible",
      "real_model_not_present",
      "authorized_shadow_data_not_present"
    ],
    hashes: {
      manifestBytesSha256: prepared.manifestBytesSha256,
      datasetContentSha256: prepared.datasetContentSha256,
      releaseMetadataSha256: stableHash(releaseMetadata),
      modelSha256: stableHash(releaseMetadata.model),
      preprocessSha256: stableHash(releaseMetadata.preprocess),
      thresholdPolicySha256: stableHash(releaseMetadata.thresholdPolicy),
      preregistrationSha256: stableHash(preregistration),
      predictionsSha256: stableHash(predictionsDocument),
      ...hashes
    },
    dataset: {
      inputSampleCount: prepared.inputSampleCount,
      canonicalSampleCount: prepared.canonicalSampleCount,
      exactDuplicatesRemoved: prepared.exactDuplicatesRemoved,
      splitCounts: prepared.splitCounts,
      testPrimaryClusters: clusters.length
    },
    primaryUnit: "burst_or_near_duplicate_cluster",
    clusterAggregation: preregistration.clusterAggregation,
    sampleGate,
    endpoints,
    spaceStratified: spacesReport,
    macro,
    worstSpace: worst,
    clusterAwareSensitivity: {
      primaryClusterEndpoints: endpoints,
      canonicalSampleEndpoints: metricsFor(sampleRows, preregistration.thresholds, alpha),
      note: "The cluster result is authoritative; canonical-sample results are sensitivity only and cannot increase n."
    },
    jointGatePassed: sampleGatePassed && endpointGatePassed && releaseMetadata.releaseEligible === true,
    nextGate: "Track 3B requires written authorization, at least 10 test Spaces, 300 evaluable ID clusters, 300 OOD clusters, and all four adjusted one-sided bounds."
  };
}
