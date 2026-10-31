#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_ZERO_WRITE_ROWS = "rate/dedupe/audit/idempotency/case/session/credential/actor";

function includesAll(value, fragments) {
  return typeof value === "string" && fragments.every((fragment) => value.includes(fragment));
}

function action(coverage, actionId) {
  return coverage.actions?.find((entry) => entry.actionId === actionId);
}

function operation(coverage, operationId) {
  return [
    ...(coverage.technicalOperationCoverage ?? []),
    ...(coverage.internalOperationCoverage ?? [])
  ].find((entry) => entry.operationId === operationId);
}

export function runtimeRemediationFailures({ coverage, canonical, coreFlow, release }) {
  const failures = [];
  const expect = (condition, code) => { if (!condition) failures.push(code); };

  // B — identity equivalence rotation is one exclusive, all-or-nothing full-table operation.
  const rekey = operation(coverage, "IDENTITY.REKEY_EQUIVALENCES") ?? {};
  expect(
    rekey.endpoint === "internal:identity-equivalence-rekey"
      && rekey.coverageKind === "internal_exclusive_transaction"
      && rekey.method === "INTERNAL_TRANSACTION"
      && rekey.replayClass === "completed_state",
    "RUNTIME_B_REKEY_SHAPE"
  );
  expect(
    rekey.requestSchema === "IdentityEquivalenceRekeyInput{fromCollisionKeyEpoch,toCollisionKeyEpoch,leaseId}"
      && includesAll(rekey.authorization, ["identity-namespace exclusive lease", "least-privilege KMS decrypt/encrypt role"])
      && includesAll(rekey.idempotency, ["decrypt every active normalized-identity envelope", "atomically switch all rows or write none"])
      && includesAll(rekey.ifMatchOrVersion, ["exclusive loaded-version full-table transaction", "rolls back every row"]),
    "RUNTIME_B_REKEY_TRANSACTION"
  );
  expect(
    includesAll(canonical, ["内部操作`IDENTITY.REKEY_EQUIVALENCES`", "identity namespace排他lease", "零部分写"])
      && includesAll(canonical, ["normalizedIdentifierCiphertext", "normalizedIdentifierEnvelopeKeyId", "normalizedIdentifierEnvelopeFormat", "独立`k_identity_envelope`", "AAD精确绑定"])
      && includesAll(coreFlow, ["旧`k_equivalence` collision-key epoch/material", "整表stage→计数/唯一性校验→原子swap"])
      && includesAll(release, ["旧`k_equivalence` collision-key epoch/material", "排他整表stage/verify/atomic-swap"]),
    "RUNTIME_B_CROSS_DOCUMENT"
  );

  // C — unsupported support fields are rejected before every kind of durable write.
  const support = action(coverage, "SUPPORT.SUBMIT_SAFETY_LEAD") ?? {};
  expect(
    support.requestSchema === "CreateSupportCaseRequest{category,description}; contact, targetObjectId, photoId, spaceId and every other unknown field are unsupported_field"
      && support.stableErrors?.includes("unsupported_field"),
    "RUNTIME_C_SUPPORT_SCHEMA"
  );
  expect(
    includesAll(support.authorization, ["before any durable write", REQUIRED_ZERO_WRITE_ROWS])
      && includesAll(support.ifMatchOrVersion, ["full database before/after snapshot", REQUIRED_ZERO_WRITE_ROWS, "any other durable row"]),
    "RUNTIME_C_ZERO_DURABLE_WRITE"
  );
  expect(
    includesAll(canonical, ["`POST /v1/support-cases`", "在任何idempotency/case/credential写之前", "其他任意未知字段统一`unsupported_field`且零写"])
      && includesAll(coreFlow, ["数据库前后快照", REQUIRED_ZERO_WRITE_ROWS, "全部零新增、零改变"])
      && includesAll(release, ["数据库前后快照", REQUIRED_ZERO_WRITE_ROWS, "全部零新增、零改变"]),
    "RUNTIME_C_CROSS_DOCUMENT"
  );

  // D — account deletion always scopes idempotency to the presented exact reauth family.
  const accountDelete = action(coverage, "ACCOUNT.DELETE_REQUEST") ?? {};
  expect(
    accountDelete.replayClass === "credential_reissue"
      && accountDelete.endpoint === "/v1/me/deletion-requests",
    "RUNTIME_D_DELETE_SHAPE"
  );
  expect(
    includesAll(accountDelete.authorization, ["presented reauth-grant credential family", "sole idempotency principal/scope", "never the Account or account-session principal"])
      && includesAll(accountDelete.authorization, ["Completed-replay-only branch: no live account authority is required", "original consumed reauth credential family", "idempotency_records.responseRef", "createdByIdempotencyRecordId"])
      && includesAll(accountDelete.idempotency, ["presented exact-purpose reauth-grant credential family", "never Account/account-session principal"])
      && includesAll(accountDelete.idempotency, ["same deletion_status_sessions.version", "without rerunning deletion"])
      && includesAll(accountDelete.ifMatchOrVersion, ["createdByIdempotencyRecordId", "zero deletion/account/business-state transition"]),
    "RUNTIME_D_REAUTH_FAMILY_SCOPE"
  );
  expect(
    includesAll(accountDelete.successDTO, ["__Host-unseen_deletion_status", "clears __Host-unseen_account", "raw credential never appears in body"]),
    "RUNTIME_D_DELETE_STATUS_COOKIE"
  );
  const deletionStatus = action(coverage, "DELETION.OPEN_STATUS") ?? {};
  expect(
    includesAll(deletionStatus.authorization, ["exact live __Host-unseen_deletion_status session", "bound to this deletionRequestId", "cross-request"])
      && includesAll(deletionStatus.ifMatchOrVersion, ["deletion_status_sessions.version", "no increment"]),
    "RUNTIME_D_DELETE_STATUS_READ"
  );
  expect(
    includesAll(canonical, ["唯一特例是`ACCOUNT.DELETE_REQUEST`", "presented reauth-grant credential family", "禁止首次按Account或account-session principal建记录"])
      && includesAll(coreFlow, ["原始已消费reauth credential family", "零删除/account重执行"])
      && includesAll(release, ["原始已消费reauth credential family", "禁止重跑删除或恢复account authority"]),
    "RUNTIME_D_CROSS_DOCUMENT"
  );

  // A — the scene DTO and both media reads bind exact immutable assets and live scene predicates.
  const scene = action(coverage, "PHOTO.RETURN_TO_SCENE") ?? {};
  const panoramaRead = operation(coverage, "VIEWER.PANORAMA_MEDIA.READ") ?? {};
  const photoRead = operation(coverage, "VIEWER.PHOTO_MEDIA.READ") ?? {};
  expect(
    includesAll(scene.successDTO, [
      "panorama{url=/v1/viewer/spaces/{sid}/panorama-revisions/{rid}/media,revisionId,assetId,assetVersion,sha256",
      "photoMedia{url=/v1/viewer/spaces/{sid}/photos/{pid}/media,assetId,assetVersion,sha256",
      "each media response ETag must equal its DTO sha256 before decode"
    ]),
    "RUNTIME_A_SCENE_ASSET_IDENTITY"
  );
  expect(
    includesAll(scene.authorization, ["one mutually exclusive account/external effective-view branch", "visible photo", "placement=confirmed on current panorama revision", "sceneReadiness=ready"])
      && includesAll(panoramaRead.authorization, ["exactly one current account or external effective-view session branch", "sceneReadiness=ready", "sceneMode=rotation360", "spaces.currentPanoramaRevisionId=rid", "ready and non-retired"])
      && includesAll(panoramaRead.ifMatchOrVersion, ["exact assetId+assetVersion", "response ETag must equal the DTO sha256", "observed bytes <= 33,554,432"])
      && includesAll(photoRead.authorization, ["exactly one current account or external effective-view session branch", "photos.viewerSafeAssetId", "same-Space", "bound to that photo", "EXIF/GPS-stripped", "confirmed placement on the current panorama"])
      && includesAll(photoRead.ifMatchOrVersion, ["exact viewer-safe assetId+assets.version", "response ETag must equal the DTO sha256"])
      && includesAll(panoramaRead.idempotency, ["side-effect free", "never create or consume"])
      && includesAll(photoRead.idempotency, ["side-effect free", "never create or consume"]),
    "RUNTIME_A_MEDIA_PREDICATES"
  );
  expect(
    includesAll(canonical, ["revisionId, assetId, assetVersion, sha256", "assetId, assetVersion, sha256", "sceneReadiness=ready", "revision ready且未retired"])
      && includesAll(coreFlow, ["viewer panorama/photo媒体只经同源session-auth", "v1 panorama上限固定32 MiB"])
      && includesAll(release, ["scene-context必须冻结panorama与viewer-safe photo derivative各自的`assetId + assetVersion + sha256", "客户端在解码前逐字比对响应ETag", "33,554,432 bytes", "33,554,433 bytes"]),
    "RUNTIME_A_CROSS_DOCUMENT"
  );

  return failures;
}

export async function loadRuntimeDocuments(repoRoot) {
  const source = path.join(repoRoot, "contracts/source/technical");
  return {
    coverage: JSON.parse(await readFile(path.join(source, "ACTION-API-COVERAGE.json"), "utf8")),
    canonical: await readFile(path.join(source, "CANONICAL-STATE-AND-API.md"), "utf8"),
    coreFlow: await readFile(path.join(source, "CORE-FLOW-CONTRACT.md"), "utf8"),
    release: await readFile(path.join(source, "RELEASE-READINESS-CONTRACT.md"), "utf8")
  };
}

async function main() {
  const repoRoot = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../.."));
  const failures = runtimeRemediationFailures(await loadRuntimeDocuments(repoRoot));
  process.stdout.write(`${JSON.stringify({ gate: "runtime-remediation-a-d", failures, errors: failures.length }, null, 2)}\n`);
  process.exitCode = failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
