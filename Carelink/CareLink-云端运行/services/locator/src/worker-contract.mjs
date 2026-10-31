import { LocatorOfflineError } from "./offline-pipeline.mjs";

const REQUIRED = ["spaceId", "sceneId", "panoramaRevisionId", "photoId", "mediaSha256",
  "policyReleaseId", "policyVersion"];
const fail = (code) => { throw new LocatorOfflineError(code); };

export function validateLocatorJobRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("locator_job_request_invalid");
  for (const key of REQUIRED) {
    if (key === "policyVersion") {
      if (!Number.isSafeInteger(request[key]) || request[key] < 1) fail(`locator_job_${key}_invalid`);
    } else if (typeof request[key] !== "string" || !request[key]) fail(`locator_job_${key}_invalid`);
  }
  if (!/^[a-f0-9]{64}$/.test(request.mediaSha256)) fail("locator_job_mediaSha256_invalid");
  return Object.freeze({ ...request });
}

export function runOfflineAbstainWorker(request, releaseMetadata) {
  const input = validateLocatorJobRequest(request);
  if (releaseMetadata?.releaseId !== input.policyReleaseId ||
    !Number.isSafeInteger(releaseMetadata?.releaseVersion) || releaseMetadata.releaseVersion < 1 ||
    releaseMetadata.releaseVersion !== input.policyVersion || releaseMetadata?.releaseEligible !== false ||
    releaseMetadata?.isProduction !== false) fail("locator_policy_release_unavailable");
  // ponytail: the offline checkpoint has no model; abstention is the only honest worker outcome.
  return Object.freeze({
    classification: "abstained",
    panoramaRevisionId: input.panoramaRevisionId,
    locatorProvenance: {
      mode: "offline_synthetic_tooling",
      isProduction: false,
      policyReleaseId: releaseMetadata.releaseId,
      policyVersion: releaseMetadata.releaseVersion
    }
  });
}
