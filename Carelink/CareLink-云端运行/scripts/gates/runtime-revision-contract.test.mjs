import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeDocuments, runtimeRemediationFailures } from "./runtime-revision-contract.mjs";

const repoRoot = new URL("../..", import.meta.url).pathname;
const baseline = await loadRuntimeDocuments(repoRoot);

function mutated(change) {
  const copy = structuredClone(baseline);
  change(copy);
  return runtimeRemediationFailures(copy);
}

function action(documents, actionId) {
  return documents.coverage.actions.find((entry) => entry.actionId === actionId);
}

function operation(documents, operationId) {
  return [
    ...documents.coverage.technicalOperationCoverage,
    ...documents.coverage.internalOperationCoverage
  ].find((entry) => entry.operationId === operationId);
}

test("runtime A-D candidate validates", () => {
  assert.deepEqual(runtimeRemediationFailures(baseline), []);
});

test("A rejects stale scene placement or non-exclusive media authorization", () => {
  const stalePlacement = mutated((documents) => {
    action(documents, "PHOTO.RETURN_TO_SCENE").authorization = "one mutually exclusive account/external effective-view branch plus visible photo, placement=confirmed on any panorama and sceneReadiness=ready";
  });
  assert(stalePlacement.includes("RUNTIME_A_MEDIA_PREDICATES"));
  const ambiguousPanoramaRead = mutated((documents) => {
    operation(documents, "VIEWER.PANORAMA_MEDIA.READ").authorization = "account plus external sessions may both authorize; sceneReadiness=ready, sceneMode=rotation360, spaces.currentPanoramaRevisionId=rid and revision ready and non-retired";
  });
  assert(ambiguousPanoramaRead.includes("RUNTIME_A_MEDIA_PREDICATES"));
  const missingAsset = mutated((documents) => {
    action(documents, "PHOTO.RETURN_TO_SCENE").successDTO = "ViewerPhotoSceneContextDTO{panorama{sha256},photoMedia{sha256}}";
  });
  assert(missingAsset.includes("RUNTIME_A_SCENE_ASSET_IDENTITY"));
  const broadPhotoRead = mutated((documents) => {
    operation(documents, "VIEWER.PHOTO_MEDIA.READ").authorization = "any current session may read photo original";
  });
  assert(broadPhotoRead.includes("RUNTIME_A_MEDIA_PREDICATES"));
  const noLimit = mutated((documents) => {
    operation(documents, "VIEWER.PANORAMA_MEDIA.READ").ifMatchOrVersion = "exact assetId+assetVersion; response ETag must equal the DTO sha256";
  });
  assert(noLimit.includes("RUNTIME_A_MEDIA_PREDICATES"));
});

test("B rejects partial or non-exclusive identity migration", () => {
  const failures = mutated((documents) => {
    operation(documents, "IDENTITY.REKEY_EQUIVALENCES").ifMatchOrVersion = "increment one row after opportunistic login";
  });
  assert(failures.includes("RUNTIME_B_REKEY_TRANSACTION"));
  const missingEnvelope = mutated((documents) => {
    documents.canonical = documents.canonical
      .replaceAll("normalizedIdentifierCiphertext", "removedCiphertext")
      .replaceAll("normalizedIdentifierEnvelopeKeyId", "removedEnvelopeKey")
      .replaceAll("normalizedIdentifierEnvelopeFormat", "removedEnvelopeFormat");
  });
  assert(missingEnvelope.includes("RUNTIME_B_CROSS_DOCUMENT"));
});

test("C rejects audit or limiter writes before unsupported-field validation", () => {
  const failures = mutated((documents) => {
    action(documents, "SUPPORT.SUBMIT_SAFETY_LEAD").authorization = "write rate audit, then reject unknown fields";
  });
  assert(failures.includes("RUNTIME_C_ZERO_DURABLE_WRITE"));
});

test("D rejects account-principal deletion idempotency", () => {
  const failures = mutated((documents) => {
    action(documents, "ACCOUNT.DELETE_REQUEST").idempotency = "scope by current account principal";
  });
  assert(failures.includes("RUNTIME_D_REAUTH_FAMILY_SCOPE"));
  const missingCookie = mutated((documents) => {
    action(documents, "ACCOUNT.DELETE_REQUEST").successDTO = "DeletionRequestDTO{deletionId,status}";
  });
  assert(missingCookie.includes("RUNTIME_D_DELETE_STATUS_COOKIE"));
  const broadStatusRead = mutated((documents) => {
    action(documents, "DELETION.OPEN_STATUS").authorization = "any bearer or live account session";
  });
  assert(broadStatusRead.includes("RUNTIME_D_DELETE_STATUS_READ"));
});
