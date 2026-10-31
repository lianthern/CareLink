import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "../..");
const contractRevision = "00c918a7549cdeae37a8f6de81a6e4482bd5a8ee";

export const artifactPaths = Object.freeze({
  notices: "policy-inputs/notices.zh-CN.v1.json",
  security: "ops/security/security-controls.v1.json",
  operations: "ops/observability/release-operations.v1.json",
  incidents: "runbooks/drafts/incidents.v1.json",
  approvalPacket: "runbooks/drafts/NOTICE-APPROVAL-PACKET.zh-CN.v1.json",
  rfc: "runbooks/drafts/TRACK6A-RFC.md"
});

const sourcePaths = [
  "contracts/source/technical/CANONICAL-STATE-AND-API.md",
  "contracts/source/technical/RELEASE-READINESS-CONTRACT.md",
  "contracts/source/IMPLEMENTATION-ORCHESTRATION.md"
];

const requiredReviewIds = [
  "legal_basis_and_rights",
  "minors",
  "cross_border",
  "retention_and_deletion_promises",
  "ugc_sla_and_appeal_window",
  "illegal_content_evidence_preservation",
  "legal_notice_and_contact"
];

const requiredApprovalDecisionIds = [
  "legal_identity_and_contact",
  "legal_basis_rights_and_cross_border",
  "retention_deletion_and_backup",
  "minors",
  "ugc_appeal_and_preservation",
  "named_operators"
];

const requiredControlIds = [
  "campaign_public_locator",
  "campaign_challenge_cookie_origin_host",
  "campaign_admission_anti_enumeration_abuse",
  "bootstrap_fragment_sync_clear",
  "campaign_exchange_single_consume_dual_ttl",
  "campaign_cross_visitor_bola",
  "cross_space_composite_bola",
  "campaign_sweeper_idempotency_race",
  "session_cookie_csrf_origin_host",
  "otp_identity_anti_enumeration",
  "session_epoch_logout_all",
  "reauth_exact_purpose_target",
  "version_cas_dictionary",
  "idempotency_credential_replay",
  "upload_observed_bytes_mime_magic",
  "media_static_decode_limits",
  "media_orientation_metadata_minimization",
  "media_hash_provenance",
  "photo_deletion_revoke_first",
  "space_deletion_revoke_first",
  "account_deletion_revoke_first",
  "deletion_immutable_retry_ledger",
  "export_participant_projection",
  "report_actor_target_binding",
  "appeal_minimal_access",
  "support_no_object_bypass",
  "case_transition_cas_audit",
  "log_redaction_allowlist",
  "redaction_runtime_canary",
  "rate_abuse_dimensions",
  "audit_append_only_minimization"
];

const requiredSliTargets = Object.freeze({
  authorized_api_availability: "30d >= 99.9%; expected 4xx excluded; 5xx and timeout are failures",
  viewer_projection: ">= 99.9%; server p95 <= 1s; album does not require panorama",
  first_usable_web: "named 4G/25Mbps profile p75 <= 3s; Scene lazy load measured separately",
  batch_commit_finalize_durability: ">= 99.0%; no duplicate photo or receipt; partial count is exact",
  cross_device_revision_convergence: "p95 <= 5s",
  locator_job: "p95 <= 30s; abstain is not a system failure",
  authorization_leakage: "0",
  deletion_access_revoke: "p95 <= 5m"
});

const requiredSliIds = Object.keys(requiredSliTargets);

const requiredAlertIds = [
  "error_budget_burn",
  "api_5xx_timeout",
  "upload_checksum_count_mismatch",
  "viewer_authorization_anomaly",
  "cross_space_sentinel",
  "queue_age_retry_storm",
  "panorama_transaction_invariant",
  "item_lock_event_mismatch",
  "backup_lag",
  "restore_mismatch",
  "cdn_purge",
  "decoder_crash",
  "secret_redaction_canary"
];

const requiredKillSwitchIds = [
  "newInvitationExchange",
  "newUploads",
  "sharingReads",
  "autoPlacement",
  "placementWrites",
  "panoramaSwitch",
  "SceneNote",
  "bookLabQuestionJobs",
  "bookLabRendering",
  "depthScene",
  "walkableScene"
];

const requiredIncidentIds = [
  "authorization_leak",
  "checksum_mismatch",
  "panorama_invariant",
  "locator_storm",
  "deletion_cdn",
  "restore_mismatch",
  "decoder_crash",
  "secret_redaction"
];

const recognizedCredentialShapes = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bLTAI[A-Za-z0-9]{12,24}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/,
  /\bsk-[A-Za-z0-9_-]{20,255}\b/,
  /\bAIza[0-9A-Za-z_-]{30,50}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /https?:\/\/[^\s/:@]{1,80}:[^\s/@]{6,160}@/
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function assertExactSet(actual, expected, label) {
  invariant(Array.isArray(actual), `${label} must be an array`);
  invariant(new Set(actual).size === actual.length, `${label} contains duplicate values`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  invariant(JSON.stringify(left) === JSON.stringify(right), `${label} closed set mismatch`);
}

function assertExactList(actual, expected, label) {
  invariant(Array.isArray(actual), `${label} must be an array`);
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `${label} sequence mismatch`);
}

function assertNonEmptyStrings(value, label) {
  invariant(Array.isArray(value) && value.length > 0, `${label} must be a non-empty array`);
  invariant(value.every((entry) => typeof entry === "string" && entry.trim()), `${label} contains an empty value`);
}

function visitStrings(value, callback, currentPath = []) {
  if (typeof value === "string") return callback(value, currentPath);
  if (Array.isArray(value)) return value.forEach((entry, index) => visitStrings(entry, callback, [...currentPath, index]));
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) visitStrings(entry, callback, [...currentPath, key]);
  }
}

async function readJson(root, relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

async function validateSourceAnchors(repoRoot, artifact, requiredPaths, label) {
  const anchors = artifact.sourceAnchors ?? [];
  assertExactSet(anchors.map((entry) => entry.path), requiredPaths, `${label} source anchors`);
  for (const anchor of anchors) {
    invariant(/^[a-f0-9]{64}$/.test(anchor.sha256), `${label} malformed source anchor: ${anchor.path}`);
    const actual = sha256(await readFile(path.join(repoRoot, anchor.path)));
    invariant(actual === anchor.sha256, `${label} source anchor hash mismatch: ${anchor.path}`);
  }
}

function rejectCredentialShapes(artifacts) {
  for (const [name, artifact] of Object.entries(artifacts)) {
    visitStrings(artifact, (value, valuePath) => {
      for (const shape of recognizedCredentialShapes) {
        invariant(!shape.test(value), `${name} recognized credential shape at ${valuePath.join(".")}`);
      }
    });
  }
}

function validateNotices(notices, coverage) {
  invariant(notices.schemaVersion === "unseen-policy-notices/1", "notice schema mismatch");
  invariant(notices.status === "module_candidate_drafts_not_approved", "notice artifact falsely closed");
  invariant(notices.releaseClaim === "NO_GO", "notice artifact release claim must remain NO_GO");
  const purposes = notices.notices.map((notice) => notice.purpose);
  assertExactSet(purposes, coverage.canonicalEnums.noticePurpose, "notice purposes");
  assertExactSet(notices.reviewRegister.map((entry) => entry.id), requiredReviewIds, "notice review register");

  const reviewById = new Map(notices.reviewRegister.map((entry) => [entry.id, entry]));
  for (const entry of notices.reviewRegister) {
    invariant(entry.approvalState === "needs_review", `review register falsely closed: ${entry.id}`);
    invariant(entry.releaseBlocker === true, `review register must block release: ${entry.id}`);
    invariant(typeof entry.owner === "string" && entry.owner, `review register owner missing: ${entry.id}`);
    invariant(typeof entry.requiredEvidence === "string" && entry.requiredEvidence, `review evidence missing: ${entry.id}`);
  }

  for (const notice of notices.notices) {
    invariant(notice.version.startsWith(`${notice.purpose}.zh-CN.`), `notice version mismatch: ${notice.purpose}`);
    const copyHash = sha256(JSON.stringify(canonicalize(notice.copy)));
    invariant(copyHash === notice.contentHash, `notice copy hash mismatch: ${notice.purpose}`);
    invariant(notice.approvalState === "needs_review", `notice falsely approved: ${notice.purpose}`);
    invariant(notice.approvalEvidence === null, `unapproved notice has evidence: ${notice.purpose}`);
    invariant(notice.webConsumable === false, `unapproved notice is Web-consumable: ${notice.purpose}`);
    assertNonEmptyStrings(notice.releaseBlockers, `notice blockers: ${notice.purpose}`);
    for (const blocker of notice.releaseBlockers) {
      invariant(reviewById.get(blocker)?.releaseBlocker === true, `notice blocker is unresolved incorrectly: ${notice.purpose}/${blocker}`);
    }
  }

  const byPurpose = new Map(notices.notices.map((notice) => [notice.purpose, notice]));
  const photoUpload = byPurpose.get("photo_upload");
  invariant(photoUpload.version === "photo_upload.zh-CN.2", "photo upload notice version drift");
  invariant(photoUpload.contentHash === "fe33ba9d5e927dffa281706d6e826d4dd06b26d3ccfca19b3eaba97f340287b0",
    "photo upload notice copy drift");
  const memory = byPurpose.get("memory_interview_l3");
  const contribution = byPurpose.get("book_contribution_l3");
  for (const notice of [memory, contribution]) {
    invariant(notice.releaseLane === "L3", `L3 notice lane mismatch: ${notice.purpose}`);
    invariant(notice.defaultEnabled === false, `L3 notice default must be off: ${notice.purpose}`);
    invariant(notice.separateConsentRequired === true, `L3 notice must be separate: ${notice.purpose}`);
  }
  invariant(memory.killSwitch === "bookLabQuestionJobs", "memory interview kill switch mismatch");
  invariant(contribution.killSwitch === "bookLabRendering", "book contribution kill switch mismatch");
  assertExactSet(contribution.grantBinding, [
    "bookId",
    "personalMemoryId",
    "memoryRevisionId",
    "confirmedSubmissionHash",
    "creditLabel",
    "audienceScope",
    "noticeVersion",
    "noticeHash"
  ], "book contribution grant binding");
  invariant(memory.contentHash !== contribution.contentHash, "L3 notices must not share a copy hash");
}

function validateApprovalPacket(packet, notices, noticesSha256) {
  invariant(packet.schemaVersion === "unseen-notice-approval-packet/1", "approval packet schema mismatch");
  invariant(packet.locale === notices.locale, "approval packet locale mismatch");
  invariant(packet.status === "human_review_required", "approval packet falsely closed");
  invariant(packet.releaseClaim === "NO_GO", "approval packet release claim must remain NO_GO");
  invariant(packet.sourceArtifact?.path === artifactPaths.notices, "approval packet source path mismatch");
  invariant(packet.sourceArtifact?.sha256 === noticesSha256, "approval packet source hash mismatch");
  assertExactList(packet.reviewInstructions?.approvalBinding, [
    "purpose",
    "version",
    "contentHash",
    "datedHumanRecord"
  ], "approval packet binding");

  const expectedCandidates = notices.notices.map((notice) => ({
    purpose: notice.purpose,
    version: notice.version,
    contentHash: notice.contentHash,
    title: notice.copy.title,
    approvalOwner: notice.approvalOwner,
    approvalState: notice.approvalState,
    approvalEvidence: notice.approvalEvidence,
    webConsumable: notice.webConsumable,
    releaseBlockers: notice.releaseBlockers
  }));
  invariant(JSON.stringify(packet.reviewCandidates) === JSON.stringify(expectedCandidates),
    "approval packet notice manifest mismatch");

  assertExactSet(packet.unresolvedDecisionInputs?.map((entry) => entry.id), requiredApprovalDecisionIds,
    "approval packet decision inputs");
  const coveredReviewIds = new Set();
  for (const entry of packet.unresolvedDecisionInputs) {
    assertNonEmptyStrings(entry.owners, `approval packet owners: ${entry.id}`);
    assertNonEmptyStrings(entry.requiredInputs, `approval packet required inputs: ${entry.id}`);
    assertNonEmptyStrings(entry.blocksReviewRegister, `approval packet review links: ${entry.id}`);
    for (const id of entry.blocksReviewRegister) {
      invariant(requiredReviewIds.includes(id), `approval packet links unknown review item: ${entry.id}/${id}`);
      coveredReviewIds.add(id);
    }
  }
  assertExactSet([...coveredReviewIds], requiredReviewIds, "approval packet review coverage");
  invariant(Array.isArray(packet.recordedHumanApprovals) && packet.recordedHumanApprovals.length === 0,
    "approval packet must not record human approvals");
}

function validateSecurity(security) {
  invariant(security.schemaVersion === "unseen-security-controls/1", "security schema mismatch");
  invariant(security.status === "module_contract_defined_not_executed", "security artifact falsely closed");
  invariant(security.releaseClaim === "NO_GO", "security release claim must remain NO_GO");
  assertExactSet(security.controls.map((control) => control.id), requiredControlIds, "security controls");

  for (const control of security.controls) {
    invariant(["Module", "Integration", "Release"].includes(control.stage), `control stage invalid: ${control.id}`);
    invariant(["automated", "hybrid"].includes(control.automation), `control automation invalid: ${control.id}`);
    invariant(typeof control.positive === "string" && control.positive, `control positive case missing: ${control.id}`);
    invariant(typeof control.negative === "string" && control.negative, `control negative case missing: ${control.id}`);
    assertNonEmptyStrings(control.evidence?.requiredFields, `control evidence fields: ${control.id}`);
  }

  const local = security.evidenceLanes.localModule;
  const server = security.evidenceLanes.fixedRcOrServer;
  const human = security.evidenceLanes.humanApproval;
  invariant(local.evidenceState === "artifact_validation_only", "local evidence lane claim mismatch");
  invariant(server.evidenceState === "not_executed", "server evidence lane falsely closed");
  invariant(human.evidenceState === "unresolved_release_blocker", "human evidence lane falsely closed");
  assertExactSet(local.controlIds, security.controls.filter((control) => control.stage === "Module").map((control) => control.id), "local control lane");
  assertExactSet(server.controlIds, security.controls.filter((control) => control.stage !== "Module").map((control) => control.id), "server control lane");
  invariant(new Set([...local.controlIds, ...server.controlIds]).size === security.controls.length, "control evidence lanes overlap or omit a control");

  for (const scope of security.deletionContract.scopes) invariant(scope.revokeFirst === true, `deletion is not revoke-first: ${scope.scope}`);
  invariant(security.licenseEvidenceMatrix.approvalState === "needs_review", "license evidence falsely approved");
  invariant(security.licenseEvidenceMatrix.releaseBlocker === true, "unresolved license evidence must block release");
  for (const row of security.licenseEvidenceMatrix.rows) {
    invariant(row.commercialEligibility === "blocked_pending_human_approval", `license row falsely eligible: ${row.category}`);
  }
  for (const row of security.licenseEvidenceMatrix.commerciallyProhibitedArtifacts) {
    invariant(row.commercialEligibility === "prohibited", `prohibited artifact falsely eligible: ${row.id}`);
  }
  invariant(security.loggingPolicy.prohibitedFields.includes("raw_ip_address"), "raw IP must remain prohibited");
  invariant(security.loggingPolicy.prohibitedFields.includes("credential_or_bootstrap_value"), "credential values must remain prohibited");
}

function validateOperations(operations) {
  invariant(operations.schemaVersion === "unseen-release-operations/1", "operations schema mismatch");
  invariant(operations.status === "targets_defined_not_measured", "operations artifact falsely closed");
  invariant(operations.releaseClaim === "NO_GO", "operations release claim must remain NO_GO");
  invariant(operations.evidenceSeparation.localExecutable.status === "artifact_validation_available", "local validation lane mismatch");
  invariant(operations.evidenceSeparation.fixedRcOrServer.status === "not_executed", "server operations falsely closed");
  invariant(operations.evidenceSeparation.humanApproval.status === "needs_review", "human operations falsely closed");

  assertExactSet(operations.serviceLevelTargets.map((entry) => entry.id), requiredSliIds, "SLI targets");
  for (const target of operations.serviceLevelTargets) {
    invariant(target.targetOnly === true && target.measured === false && target.evidence === null, `SLI falsely measured: ${target.id}`);
    invariant(target.target === requiredSliTargets[target.id], `SLI target drift: ${target.id}`);
  }

  assertExactSet(operations.killSwitches.map((entry) => entry.id), requiredKillSwitchIds, "kill switches");
  const switchIds = new Set(requiredKillSwitchIds);
  for (const item of operations.killSwitches) {
    invariant(item.wiringState === "not_executed", `kill switch falsely wired: ${item.id}`);
    invariant(typeof item.owner === "string" && item.owner, `kill switch owner missing: ${item.id}`);
  }

  assertExactSet(operations.alerts.map((entry) => entry.id), requiredAlertIds, "alerts");
  for (const alert of operations.alerts) {
    invariant(alert.executionState === "not_executed", `alert falsely closed: ${alert.id}`);
    for (const field of ["owner", "severity", "condition", "recovery", "reconciliation", "escalation", "postmortemTemplate", "runbookId"]) {
      invariant(typeof alert[field] === "string" && alert[field], `alert field missing: ${alert.id}/${field}`);
    }
    assertNonEmptyStrings(alert.readOnlyDiagnosis, `alert diagnosis: ${alert.id}`);
    assertNonEmptyStrings(alert.killSwitches, `alert kill switches: ${alert.id}`);
    for (const id of alert.killSwitches) invariant(switchIds.has(id), `alert has unknown kill switch: ${alert.id}/${id}`);
  }

  invariant(operations.recovery.metadataRpoTarget === "<= 1h", "metadata RPO target drift");
  invariant(operations.recovery.metadataRtoTarget === "<= 4h", "metadata RTO target drift");
  invariant(operations.recovery.targetOnly === true && operations.recovery.exerciseState === "not_executed", "recovery falsely exercised");
  assertExactList(operations.changeDelivery.migrationPhases, ["expand", "backfill", "verify", "switch_read", "switch_write", "contract"], "migration phases");
  assertExactList(operations.changeDelivery.canaryStages, ["fixture", "test_space", "1_percent", "5_percent", "25_percent", "100_percent"], "canary stages");
  invariant(operations.changeDelivery.executionState === "not_executed", "change delivery falsely executed");
}

function validateIncidents(incidents, operations) {
  invariant(incidents.schemaVersion === "unseen-incident-runbooks/1", "incident schema mismatch");
  invariant(incidents.status === "drafts_not_exercised", "incident artifact falsely closed");
  invariant(incidents.releaseClaim === "NO_GO", "incident release claim must remain NO_GO");
  assertExactSet(incidents.incidents.map((entry) => entry.id), requiredIncidentIds, "incident runbooks");
  const alertIds = new Set(operations.alerts.map((entry) => entry.id));
  const switchIds = new Set(operations.killSwitches.map((entry) => entry.id));
  const runbookIds = new Set(incidents.incidents.map((entry) => entry.id));
  const expectedAlertsByRunbook = new Map(incidents.incidents.map((entry) => [entry.id, []]));
  const coveredAlerts = new Set();

  for (const alert of operations.alerts) {
    invariant(runbookIds.has(alert.runbookId), `alert links unknown runbook: ${alert.id}/${alert.runbookId}`);
    expectedAlertsByRunbook.get(alert.runbookId).push(alert.id);
  }

  for (const incident of incidents.incidents) {
    invariant(incident.drillStatus === "not_executed" && incident.executionEvidence === null, `incident falsely exercised: ${incident.id}`);
    for (const field of ["title", "severity", "detect", "escalation"]) {
      invariant(typeof incident[field] === "string" && incident[field], `incident field missing: ${incident.id}/${field}`);
    }
    for (const field of ["linkedAlertIds", "immediateKillSwitches", "readOnlyDiagnosis", "containment", "recovery", "reconciliation"]) {
      assertNonEmptyStrings(incident[field], `incident field: ${incident.id}/${field}`);
    }
    for (const id of incident.linkedAlertIds) {
      invariant(alertIds.has(id), `incident links unknown alert: ${incident.id}/${id}`);
      coveredAlerts.add(id);
    }
    assertExactSet(incident.linkedAlertIds, expectedAlertsByRunbook.get(incident.id), `incident alert linkage: ${incident.id}`);
    for (const id of incident.immediateKillSwitches) invariant(switchIds.has(id), `incident links unknown switch: ${incident.id}/${id}`);
  }
  assertExactSet([...coveredAlerts], [...alertIds], "incident alert coverage");
}

export async function validateArtifacts({ repoRoot = defaultRepoRoot, artifactRoot = repoRoot } = {}) {
  const [notices, security, operations, incidents, approvalPacket, coverage, rfc] = await Promise.all([
    readJson(artifactRoot, artifactPaths.notices),
    readJson(artifactRoot, artifactPaths.security),
    readJson(artifactRoot, artifactPaths.operations),
    readJson(artifactRoot, artifactPaths.incidents),
    readJson(artifactRoot, artifactPaths.approvalPacket),
    readJson(repoRoot, "contracts/source/technical/ACTION-API-COVERAGE.json"),
    readFile(path.join(artifactRoot, artifactPaths.rfc), "utf8")
  ]);

  await validateSourceAnchors(repoRoot, notices, sourcePaths.slice(0, 2), "notices");
  for (const [label, artifact] of [["security", security], ["operations", operations], ["incidents", incidents]]) {
    await validateSourceAnchors(repoRoot, artifact, sourcePaths, label);
  }
  validateNotices(notices, coverage);
  validateApprovalPacket(approvalPacket, notices,
    sha256(await readFile(path.join(artifactRoot, artifactPaths.notices))));
  validateSecurity(security);
  validateOperations(operations);
  validateIncidents(incidents, operations);
  rejectCredentialShapes({ notices, security, operations, incidents, approvalPacket, rfc });

  invariant(rfc.includes(contractRevision), "RFC contract revision mismatch");
  invariant(rfc.includes("Status: `NO_GO`"), "RFC release claim missing");
  invariant(rfc.includes("node --test tests/security-contract/validate.test.mjs"), "RFC local command missing");
  for (const relative of sourcePaths) {
    const digest = sha256(await readFile(path.join(repoRoot, relative)));
    invariant(rfc.includes(digest), `RFC source hash missing: ${relative}`);
  }

  const artifactSha256 = {};
  for (const [name, relative] of Object.entries(artifactPaths)) artifactSha256[name] = sha256(await readFile(path.join(artifactRoot, relative)));
  return {
    status: "TRACK6A_LOCAL_ARTIFACT_VALID",
    claim: "artifact_integrity_only",
    contractRevision,
    releaseClaim: "NO_GO",
    counts: {
      noticePurposes: notices.notices.length,
      securityControls: security.controls.length,
      localArtifactControls: security.evidenceLanes.localModule.controlIds.length,
      fixedRcOrServerControlsNotExecuted: security.evidenceLanes.fixedRcOrServer.controlIds.length,
      serviceLevelTargetsNotMeasured: operations.serviceLevelTargets.length,
      alertsNotExecuted: operations.alerts.length,
      incidentDrillsNotExecuted: incidents.incidents.length,
      humanApprovalsRecorded: approvalPacket.recordedHumanApprovals.length
    },
    artifactSha256
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    invariant(flag === "--repo-root" || flag === "--artifact-root", `unknown argument: ${flag}`);
    invariant(argv[index + 1], `missing value for ${flag}`);
    options[flag === "--repo-root" ? "repoRoot" : "artifactRoot"] = path.resolve(argv[index + 1]);
    index += 1;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.stdout.write(`${JSON.stringify(await validateArtifacts(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "TRACK6A_LOCAL_ARTIFACT_INVALID", error: error.message })}\n`);
    process.exitCode = 1;
  }
}
