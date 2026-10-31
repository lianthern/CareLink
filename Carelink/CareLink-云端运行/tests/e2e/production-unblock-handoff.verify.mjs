import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const indexPath = path.join(repositoryRoot, "release-evidence/r0/PRODUCTION-UNBLOCK-HANDOFF.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const candidateCommit = "b3145804b4356b1e823783d3f0e9d0b0399bf0ee";
const candidateTree = "6a9be92b1615605aca40ec1848bb357bd10760ec";
const blockers = [
  "core_visible_facts_and_question_provider_not_authorized",
  "legal_privacy_notice_approvals_missing",
  "final_candidate_deployment_secret_decoder_operator_and_provider_acceptance_missing"
];

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}:object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label}:keys`);
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", ...options }).trim();
}

async function regularFile(filename, label) {
  const info = await lstat(filename);
  assert.equal(info.isFile(), true, `${label}:regular`);
  assert.equal(info.isSymbolicLink(), false, `${label}:symlink`);
  return info;
}

function assertNoCredentialOrReleaseClaim(value, locator = "index") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialOrReleaseClaim(entry, `${locator}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assert.doesNotMatch(key, /^(credential|credentialValue|secretValue|tokenValue|privateKey)$/iu, locator);
      assertNoCredentialOrReleaseClaim(entry, `${locator}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  assert.notEqual(value, "GO", `${locator}:go_claim`);
  assert.notEqual(value, "APPROVED", `${locator}:approved_claim`);
  assert.notEqual(value, "AUTHENTICITY_VERIFIED", `${locator}:authenticity_claim`);
  assert.doesNotMatch(value, /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+|\bAKIA[0-9A-Z]{16}\b/u,
    `${locator}:credential_material`);
}

function assertMissingExternalInput(lane, label) {
  assert.equal(lane.status, "EXTERNAL_INPUT_MISSING", `${label}:status`);
  assert.equal(lane.authenticityVerified, false, `${label}:authenticity`);
}

function assertDeploymentDecision(value) {
  exactKeys(value, ["kind", "source", "currentActive", "rendererDiagnostic", "region", "os", "resourceClass", "billing",
    "existingMaxOwnedUnregisteredDomain", "dedicatedSubdomain", "selectedSubdomain", "accessMode",
    "audience", "localFriendEntry", "provisioned", "publicFoundation", "publicExposure",
    "publicExposureScope", "finalCandidateDeployed"], "deploymentDecision");
  exactKeys(value.source, ["path", "sha256", "acceptedEvidenceCommit", "historicalDeployedCandidateCommit"],
    "deploymentDecision:source");
  exactKeys(value.currentActive, ["kind", "path", "sha256", "evidenceCommit", "candidateCommit",
    "candidateTree", "result", "finalPackageCandidateCommit", "finalCandidateMatchesCurrentActive",
    "finalCandidateDeployed"], "deploymentDecision:currentActive");
  exactKeys(value.rendererDiagnostic, ["kind", "path", "sha256", "evidenceCommit", "result",
    "acceptedFixCommit", "acceptedFixEvidenceCommit", "targetRetryRequired"],
  "deploymentDecision:rendererDiagnostic");
  assert.deepEqual(value, {
    kind: "PUBLIC_CORE_UI_TARGET_OBSERVATION_NOT_ACCEPTANCE_RECEIPT",
    source: {
      path: "release-evidence/r0/public-core-ui-target-20260814T232050Z/MACHINE-EVIDENCE.json",
      sha256: "c4546702d135a6ccdaba66dd0c200a04778c776b6765a1d00cc1cbe713a5db82",
      acceptedEvidenceCommit: "09ce09c170bbd4b5992a3a1b016e814be2013486",
      historicalDeployedCandidateCommit: "45380ecd77315fcc95f3e445353f8abdc6c77603"
    },
    currentActive: {
      kind: "CURRENT_ACTIVE_DEPLOYMENT_OBSERVATION_NOT_FINAL_PACKAGE_ACCEPTANCE",
      path: "release-evidence/r0/target-deployment-candidate48a-renderer-snap-hardlink-p1-20260815T104618Z/" +
        "MACHINE-EVIDENCE.json",
      sha256: "96a6372d2f4eb61609920f936feb6346edb565ba2c653d462ec0b96e1c27f380",
      evidenceCommit: "87687c956770a409f040ec15c5bbbf9f93aa70a9",
      candidateCommit: "48a3841c91d0f74fa6d51c1e292a27e1d3a2aab6",
      candidateTree: "b81b7216f621c9af37733102921be6d74dafac0b",
      result: "TARGET_CORE_DEPLOYMENT_PASS_RENDERER_PREACCEPTANCE_REJECTED_NONSECRET_EVIDENCE",
      finalPackageCandidateCommit: candidateCommit,
      finalCandidateMatchesCurrentActive: false,
      finalCandidateDeployed: false
    },
    rendererDiagnostic: {
      kind: "ACCEPTED_SNAPD_CACHE_HARDLINK_CODE_GATES_NOT_TARGET_ACCEPTANCE",
      path: "release-evidence/renderer/dedicated-service/snapd-cache-hardlink-topology/machine-summary.json",
      sha256: "83638c095ac7737edc53303416cb3b0d36f9f8ea0defca27fb47ada504f13e77",
      evidenceCommit: "d1acca2fdd5965db5cd611baa7377b138734119c",
      result: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
      acceptedFixCommit: "2e7a2276f233b973fa17e4c05120772d17381c93",
      acceptedFixEvidenceCommit: "d1acca2fdd5965db5cd611baa7377b138734119c",
      targetRetryRequired: true
    },
    region: "China Hong Kong",
    os: "Ubuntu 24.04.4 LTS",
    resourceClass: "2_vCPU_2_GiB_50_GiB",
    billing: "one_month_trial",
    existingMaxOwnedUnregisteredDomain: true,
    dedicatedSubdomain: true,
    selectedSubdomain: "unseen.maxxam.xyz",
    accessMode: "long_running_invite_only_Web_App_PWA_Beta",
    audience: "domestic_friends",
    localFriendEntry: false,
    provisioned: true,
    publicFoundation: true,
    publicExposure: true,
    publicExposureScope: "REAL_CORE_UI_TEMPORARY_BASIC_AUTH_NOT_CORE_OPERABLE_BETA",
    finalCandidateDeployed: false
  });
}

const index = JSON.parse(await readFile(indexPath, "utf8"));
exactKeys(index, ["schema", "kind", "claimBoundary", "package", "handoffDocument", "blockers", "lanes",
  "existingSubinputs", "claudeReview"], "index");
assert.equal(index.schema, "unseen-production-unblock-handoff-index/1");
assert.equal(index.kind, "LINK_AND_HASH_INDEX_NOT_ACCEPTANCE_RECEIPT");
assertNoCredentialOrReleaseClaim(index);

exactKeys(index.claimBoundary, ["testedInputCommit", "testedInputTree", "evidenceOnlyAddendum", "packageRebuilt",
  "postEvidenceCommitIsProductionCandidate", "postEvidenceCommitBrowserExecuted",
  "postEvidenceCommitInventoryGenerated", "authenticityVerified", "externalReceiptReads", "secretReads",
  "externalNetworkRequests"], "claimBoundary");
assert.deepEqual(index.claimBoundary, {
  testedInputCommit: candidateCommit,
  testedInputTree: candidateTree,
  evidenceOnlyAddendum: true,
  packageRebuilt: false,
  postEvidenceCommitIsProductionCandidate: false,
  postEvidenceCommitBrowserExecuted: false,
  postEvidenceCommitInventoryGenerated: false,
  authenticityVerified: false,
  externalReceiptReads: 0,
  secretReads: 0,
  externalNetworkRequests: 0
});

exactKeys(index.package, ["directoryName", "candidateCommit", "candidateTree", "manifestSha256", "bundleSha256",
  "releaseClaim", "productionReady", "releaseBlockers"], "package");
assert.deepEqual(index.package, {
  directoryName: "production-b3145804b435",
  candidateCommit,
  candidateTree,
  manifestSha256: "568ba3e1f9852f7fba44975bbe49ede107711710b3675e8e7e83e62d15259c03",
  bundleSha256: "2124249c6224ebc786933f20921660e1647579c819f809bff33a2c5e1c8187cb",
  releaseClaim: "NO_GO",
  productionReady: false,
  releaseBlockers: blockers
});
assert.deepEqual(index.blockers, blockers);
assert.equal(git(["rev-parse", `${candidateCommit}^{tree}`]), candidateTree);
execFileSync("git", ["merge-base", "--is-ancestor", candidateCommit, "HEAD"], { cwd: repositoryRoot });

const packageRoot = path.resolve(process.env.UNSEEN_PRODUCTION_PACKAGE_DIR ??
  path.join(homedir(), "Library/Application Support/UNSEEN/release-packages", index.package.directoryName));
assert.equal(path.basename(packageRoot), index.package.directoryName, "package:directory_name");
const packageInfo = await lstat(packageRoot);
assert.equal(packageInfo.isDirectory(), true, "package:directory");
assert.equal(packageInfo.isSymbolicLink(), false, "package:symlink");
const manifestPath = path.join(packageRoot, "PACKAGE-MANIFEST.json");
const bundlePath = path.join(packageRoot, "source.bundle");
await Promise.all([regularFile(manifestPath, "manifest"), regularFile(bundlePath, "bundle")]);
const [manifestBytes, bundleBytes] = await Promise.all([readFile(manifestPath), readFile(bundlePath)]);
assert.equal(sha256(manifestBytes), index.package.manifestSha256, "package:manifest_hash");
assert.equal(sha256(bundleBytes), index.package.bundleSha256, "package:bundle_hash");
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.schema, "unseen-production-package/1");
assert.equal(manifest.candidateCommit, candidateCommit);
assert.equal(manifest.releaseClaim, "NO_GO");
assert.equal(manifest.productionReady, false);
assert.deepEqual(manifest.releaseBlockers, blockers);

exactKeys(index.handoffDocument, ["path", "sha256"], "handoffDocument");
assert.equal(index.handoffDocument.path, "runbooks/release/PRODUCTION-UNBLOCK-HANDOFF.md");
const handoffPath = path.join(repositoryRoot, index.handoffDocument.path);
await regularFile(handoffPath, "handoffDocument");
const handoffBytes = await readFile(handoffPath);
assert.equal(sha256(handoffBytes), index.handoffDocument.sha256, "handoffDocument:hash");
const handoff = handoffBytes.toString("utf8");
for (const required of [candidateCommit, candidateTree, index.package.manifestSha256, index.package.bundleSha256,
  "NO_GO", "productionReady=false", "LINK_AND_HASH_INDEX_NOT_ACCEPTANCE_RECEIPT",
  "PASS_LINK_HASH_INDEX_ONLY", "authenticityVerified=false", "externalReceiptReads=0", "secretReads=0",
  "externalNetworkRequests=0", "STRUCTURE_ONLY", "HASH_BOUND_NOT_EXECUTED", "TARGET_ACCEPTANCE_REQUIRED",
  "owner_supplied_not_defined_by_stage5", "China Hong Kong", "24.04.4 LTS",
  "2 vCPU/2 GiB/50 GiB", "unseen.maxxam.xyz", "real Core Web UI",
  "neither claims final package candidate", "exact 32 KiB",
  "HISTORICAL_REJECTED_SUPERSEDED_BY_ACCEPTED_CODE_FIX", "loaded-unit and process-cwd",
  "application-owned production auth", "accepted code only, not deployed",
  "44 focused", "accepted systemd 255 property fix", "accepted IP-deny fix", "target retry remains required"]) {
  assert.match(handoff, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    `handoffDocument:missing:${required}`);
}
assert.doesNotMatch(handoff, /productionReady\s*=\s*true|releaseClaim\s*=\s*GO/u);

exactKeys(index.lanes, ["factsProvider", "legalPrivacy", "targetOperator"], "lanes");
const facts = index.lanes.factsProvider;
const legal = index.lanes.legalPrivacy;
const target = index.lanes.targetOperator;

exactKeys(facts, ["blockerId", "status", "authenticityVerified", "receiptSchema", "receiptSchemaAuthority",
  "structureOnlyCanUnlock", "providerAdapterImplemented", "providerAuthenticationProtocolDefined",
  "receiptOrSecretReadByIndexValidator", "ownerInputs", "authorityRefs", "commands", "proofBoundary",
  "nonClaims"], "factsProvider");
assert.equal(facts.blockerId, blockers[0]);
assertMissingExternalInput(facts, "factsProvider");
assert.equal(facts.receiptSchema, "unseen-core-facts-question-provider-acceptance/1");
assert.equal(facts.receiptSchemaAuthority, "existing_stage5_structure_validator_only");
assert.equal(facts.structureOnlyCanUnlock, false);
assert.equal(facts.providerAdapterImplemented, false);
assert.equal(facts.providerAuthenticationProtocolDefined, false);
assert.equal(facts.receiptOrSecretReadByIndexValidator, false);
assert.equal(facts.proofBoundary, "STRUCTURE_HASH_FILE_AND_CANDIDATE_BINDING_ONLY");
assert.ok(facts.ownerInputs.some((entry) => entry.includes("real image-understanding model/provider")),
  "factsProvider:real_image_provider_input");
assert.deepEqual(facts.commands, [
  `UNSEEN_PRODUCTION_ENV_FILE=/etc/unseen/production.env node /opt/unseen/releases/${candidateCommit}/infra/integration/production-package.mjs preflight`
]);

exactKeys(legal, ["blockerId", "status", "authenticityVerified", "receiptSchema", "receiptSchemaAuthority",
  "humanApprovalsRecorded", "receiptReadByIndexValidator", "ownerInputs", "authorityRefs", "commands",
  "proofBoundary", "nonClaims"], "legalPrivacy");
assert.equal(legal.blockerId, blockers[1]);
assertMissingExternalInput(legal, "legalPrivacy");
assert.equal(legal.receiptSchema, null);
assert.equal(legal.receiptSchemaAuthority, "owner_supplied_not_defined_by_stage5");
assert.equal(legal.humanApprovalsRecorded, 0);
assert.equal(legal.receiptReadByIndexValidator, false);
assert.equal(legal.proofBoundary, "ARTIFACT_INTEGRITY_AND_BYTE_BINDING_ONLY");
assert.deepEqual(legal.commands, ["node tests/security-contract/validate.mjs"]);

exactKeys(target, ["blockerId", "status", "authenticityVerified", "operatorReceiptSchema",
  "operatorReceiptSchemaAuthority", "track1BReceiptSchema", "track3BReceiptSchema",
  "decoderRuntimeValidation", "decoderVersionBuildValidation", "decoderNetworkBoundary",
  "receiptOrSecretReadByIndexValidator", "deploymentDecision", "postPurchaseMissingInputs",
  "postProvisionAcceptance", "blockerMeaning", "ownerInputs", "authorityRefs", "commands",
  "proofBoundary", "nonClaims"], "targetOperator");
assert.equal(target.blockerId, blockers[2]);
assertMissingExternalInput(target, "targetOperator");
assert.equal(target.operatorReceiptSchema, null);
assert.equal(target.operatorReceiptSchemaAuthority, "owner_supplied_not_defined_by_stage5");
assert.equal(target.track1BReceiptSchema, null);
assert.equal(target.track3BReceiptSchema, null);
assert.equal(target.decoderRuntimeValidation, "HASH_BOUND_NOT_EXECUTED");
assert.equal(target.decoderVersionBuildValidation, "TARGET_ACCEPTANCE_REQUIRED");
assert.equal(target.decoderNetworkBoundary, "TARGET_ACCEPTANCE_REQUIRED");
assert.equal(target.receiptOrSecretReadByIndexValidator, false);
assertDeploymentDecision(target.deploymentDecision);
const currentActive = target.deploymentDecision.currentActive;
assert.notEqual(currentActive.candidateCommit, candidateCommit, "current active must differ from final package candidate");
assert.equal(currentActive.finalPackageCandidateCommit, candidateCommit);
assert.equal(currentActive.finalCandidateMatchesCurrentActive, false);
assert.equal(currentActive.finalCandidateDeployed, false);
const currentActivePath = path.join(repositoryRoot, currentActive.path);
await regularFile(currentActivePath, "deploymentDecision:currentActive");
assert.equal(sha256(await readFile(currentActivePath)), currentActive.sha256,
  "deploymentDecision:currentActive:worktree_hash");
execFileSync("git", ["merge-base", "--is-ancestor", currentActive.evidenceCommit, "HEAD"],
  { cwd: repositoryRoot });
assert.equal(sha256(execFileSync("git", ["show", `${currentActive.evidenceCommit}:${currentActive.path}`],
  { cwd: repositoryRoot })), currentActive.sha256, "deploymentDecision:currentActive:evidence_hash");
const rendererDiagnostic = target.deploymentDecision.rendererDiagnostic;
const rendererDiagnosticPath = path.join(repositoryRoot, rendererDiagnostic.path);
await regularFile(rendererDiagnosticPath, "deploymentDecision:rendererDiagnostic");
assert.equal(sha256(await readFile(rendererDiagnosticPath)), rendererDiagnostic.sha256,
  "deploymentDecision:rendererDiagnostic:worktree_hash");
execFileSync("git", ["merge-base", "--is-ancestor", rendererDiagnostic.evidenceCommit, "HEAD"],
  { cwd: repositoryRoot });
assert.equal(sha256(execFileSync("git", ["show", `${rendererDiagnostic.evidenceCommit}:${rendererDiagnostic.path}`],
  { cwd: repositoryRoot })), rendererDiagnostic.sha256,
  "deploymentDecision:rendererDiagnostic:evidence_hash");
for (const commit of [rendererDiagnostic.acceptedFixCommit, rendererDiagnostic.acceptedFixEvidenceCommit]) {
  execFileSync("git", ["merge-base", "--is-ancestor", commit, candidateCommit], { cwd: repositoryRoot });
}
assert.deepEqual(target.postPurchaseMissingInputs, []);
assert.deepEqual(target.postProvisionAcceptance, [
  "final_candidate_deployment_acceptance",
  "private_ai_caddy_body_cap_target_acceptance",
  "secret_delivery_acceptance",
  "decoder_and_operator_acceptance",
  "provider_authorization_acceptance"
]);
assert.equal(target.blockerMeaning,
  "FINAL_CANDIDATE_DEPLOYMENT_SECRET_DECODER_OPERATOR_AND_PROVIDER_ACCEPTANCE_NOT_SERVER_DOMAIN_TLS_ACQUISITION");
assert.ok(target.ownerInputs.some((entry) => entry.includes("worker-token hash")),
  "targetOperator:private_ai_server_secret_boundary");
assert.ok(target.ownerInputs.some((entry) => entry.includes("Hong Kong HTTPS")),
  "targetOperator:private_ai_target_acceptance");
assert.doesNotMatch(JSON.stringify(target), /real image-understanding|real image model/iu,
  "targetOperator:real_image_provider_must_stay_in_facts_lane");
assert.equal(target.proofBoundary, "PACKAGE_BYTES_MIGRATION_PERSISTENCE_AND_HASH_BINDING_ONLY");
assert.deepEqual(target.commands, [
  "node /srv/unseen-release/production-b3145804b435/VERIFY.mjs verify",
  `git clone /srv/unseen-release/production-b3145804b435/source.bundle /opt/unseen/releases/${candidateCommit}`,
  `git -C /opt/unseen/releases/${candidateCommit} switch --detach ${candidateCommit}`,
  `test -z "$(git -C /opt/unseen/releases/${candidateCommit} status --porcelain)"`,
  "UNSEEN_STAGING_SNAPSHOT_ID=pre-deploy-ID node --env-file=/etc/unseen/production.env infra/integration/staging-snapshot.mjs backup",
  "UNSEEN_STAGING_SNAPSHOT_DIR=/var/backups/unseen/production/pre-deploy-ID node --env-file=/etc/unseen/production.env infra/integration/staging-snapshot.mjs verify",
  "UNSEEN_BOOK_WORKTREE=/opt/unseen/book-web node tests/e2e/server-migration.verify.mjs"
]);

const expectedRefs = {
  factsProvider: [
    ["infra/integration/production-package.mjs", "9e42635979cacc619b2398c938bc0c8c170ada71480301a6bdd17e3a00e0a290"],
    ["config/rc/production.env.example", "a1d9185d322395f2cc5fe543a3142cad7c25d6b5a5d2bb8640b25c78e75df142"],
    ["runbooks/release/PRODUCTION-DEPLOYMENT.md", "8279583891805965d72d548c3db9cb8c93903495868e32cd46c696b46adfd024"],
    ["release-evidence/local-operable/stage-rc/PRODUCTION-PACKAGE-ACCEPTANCE-VALIDATOR.json",
      "8fd7d55d93832e4079c6f9c5b1cbb449854afff5e0710e6d29561b34b90979e4"],
    ["release-evidence/book-lab/8c-real-seam/verification.json",
      "0f3663a467b0b7ba799d2d81fa08530d628ab05d943f3d4661799750dad569b0"]
  ],
  legalPrivacy: [
    ["policy-inputs/notices.zh-CN.v1.json", "8cf08d9c139ebeb53e9bb9c0a148f272595d3d17b420d27835e2608db0add099"],
    ["runbooks/drafts/NOTICE-APPROVAL-PACKET.zh-CN.v1.json",
      "ae0749ad6a502ad4ccaf6273738fc91942d5a1b66ccefb46aed50a273eceecb4"],
    ["tests/security-contract/validate.mjs", "9e33f5fdad3e39a43e882cb7f55cad1f2ae4cd12338c9c7d2767a0b57dc62e7c"],
    ["config/rc/production.env.example", "a1d9185d322395f2cc5fe543a3142cad7c25d6b5a5d2bb8640b25c78e75df142"]
  ],
  targetOperator: [
    ["config/rc/production.env.example", "a1d9185d322395f2cc5fe543a3142cad7c25d6b5a5d2bb8640b25c78e75df142"],
    ["ops/release/unseen.service.example", "f888db4af78fefa5b6069889a9fce370d5b35bb83b721c33c9b278dabd6f65c3"],
    ["ops/release/Caddyfile.example", "5a07b83d0e08d943e7390cdc5575692c1ab6a0d3845bfad361031ba8c851b919"],
    ["runbooks/release/PRODUCTION-DEPLOYMENT.md", "8279583891805965d72d548c3db9cb8c93903495868e32cd46c696b46adfd024"],
    ["release-evidence/local-operable/stage-rc/PRODUCTION-PACKAGE-DECODER-RUNTIME.json",
      "4a7d17aed613448c277e4c9b7d979b825383cca7d947467289a19b954c71a1c9"],
    ["release-evidence/r0/private-beta/PUBLIC-FOUNDATION.json",
      "12de9e106a1fff701b4d84e4e1c010ad45ab87abf4fa256bb84a8b6d1b793fa2"],
    ["release-evidence/r0/public-core-ui-target-20260814T232050Z/MACHINE-EVIDENCE.json",
      "c4546702d135a6ccdaba66dd0c200a04778c776b6765a1d00cc1cbe713a5db82"],
    ["release-evidence/renderer/dedicated-service/machine-summary.json",
      "1a7fd73e7ce74012c813263a3bf2e429f04a05c98658b7ae15b00631643cc8d6"],
    ["release-evidence/renderer/dedicated-service/systemd255-property-fix/machine-summary.json",
      "40f3ed9ccc5dd6350a636768d46279d6d004b20775d0770e9168ab7b54633e18"],
    ["release-evidence/renderer/dedicated-service/systemd255-ip-deny-fix/machine-summary.json",
      "33f84b714baed915a287eef36b86f270faab0b8791b976fb28464ccd7f70967b"],
    ["release-evidence/r0/target-deployment-candidate48a-renderer-snap-hardlink-p1-20260815T104618Z/" +
      "MACHINE-EVIDENCE.json", "96a6372d2f4eb61609920f936feb6346edb565ba2c653d462ec0b96e1c27f380"],
    ["release-evidence/renderer/dedicated-service/snapd-cache-hardlink-topology/machine-summary.json",
      "83638c095ac7737edc53303416cb3b0d36f9f8ea0defca27fb47ada504f13e77"],
    ["release-evidence/r0/target-renderer-route1-static-adapter-policy-candidate09f-20260815T091250Z/" +
      "MACHINE-EVIDENCE.json", "883f36b86b89b8f68534eb3e9f58f7a00ed35e2baee026c454c8552e593a9411"],
    ["runbooks/release/PRIVATE-AI-PULL-WORKER.md",
      "fc20a935df1907dd6be9cb9b508f59afc419c92bbddee73e017101bc1cc85519"],
    ["infra/integration/private-beta-deployment/Caddyfile",
      "2eb49b95e2b2eab60cd380d40597fa197f4658e3f43cb407ec2d150cd0d994ff"],
    ["release-evidence/r0/private-ai-caddy-body-cap/machine-summary.json",
      "74556232519622a59663126d6fbec46c01259ec447086de87501210aa7c76e8f"],
    ["release-evidence/r0/deployment-active-release-contract/MACHINE-EVIDENCE.json",
      "37c886c9a5cc5f6370049953add51ac7e4d1a17c5fd6735138ed1528220d6afb"],
    ["release-evidence/r0/candidate-7d2-deployment-attempt-20260814T192158Z/MACHINE-EVIDENCE.json",
      "2dce11bd3ffc934e3cd9dc8137076f355a9b57c2bd7af0dc05aebba62a34c318"],
    ["release-evidence/r0/shadow-transport-acceptance-20260814T183925Z/MACHINE-EVIDENCE.json",
      "c8e4018e122740606e4e6becd01634852e076f86a976cf45e23ad6a3e7159dcd"],
    ["release-evidence/provider/mac-codex-private-worker/REMOTE-PULL-MATRIX.json",
      "c93d3945eb9daea831d02885735a4e65a6a163191fbd7402a7b490bf8a49a59c"],
    ["release-evidence/private-ai-composition/machine-summary.json",
      "7134a2f1d1cdf10365904df17508d5037462aee8eae9c2ef85c57c700c41efcf"],
    ["infra/integration/staging-snapshot.mjs", "3223e1e594f8efbac442fc32397b9c433f1d048d4516a7e1e747b26d02ac8d9b"],
    ["tests/e2e/server-migration.verify.mjs", "612c6568585743815df82fcf033b1f25fcaae928f48ec1be584ed030e6cb96aa"],
    ["release-evidence/local-operable/staging/README.md",
      "454d8d72d4c348e3ace0f9386e22d9c79249485705bb72655ce78c50a84f461b"],
    ["release-evidence/r0/inventory/VERIFICATION.json",
      "889e3fce34be6cbfbfd714c7428b9930c5e368d9cf94028780a54cf002605a73"],
    ["release-evidence/r0/inventory/RELEASE-INVENTORY.json",
      "e94ae7afabffd9bde8a88539d56bdaeac56f22ea7e7958b6e9c20dd4c64869f8"],
    ["runbooks/release/INVENTORY-REVIEW.md", "975c300761f74c8f8921b6ac07c063a5c38bbc0ff88cda493586bd15bb3071f9"]
  ]
};

for (const [laneName, references] of Object.entries(expectedRefs)) {
  const actual = index.lanes[laneName].authorityRefs;
  assert.deepEqual(actual.map((entry) => [entry.path, entry.sha256]), references, `${laneName}:refs`);
  for (const entry of actual) {
    exactKeys(entry, ["path", "sha256"], `${laneName}:ref`);
    const filename = path.join(repositoryRoot, entry.path);
    await regularFile(filename, `${laneName}:${entry.path}`);
    assert.equal(sha256(await readFile(filename)), entry.sha256, `${laneName}:${entry.path}:worktree_hash`);
    const candidateBytes = execFileSync("git", ["show", `${candidateCommit}:${entry.path}`], { cwd: repositoryRoot });
    assert.equal(sha256(candidateBytes), entry.sha256, `${laneName}:${entry.path}:candidate_hash`);
  }
}

for (const [laneName, lane] of Object.entries(index.lanes)) {
  assert.ok(lane.ownerInputs.length > 0, `${laneName}:owner_inputs`);
  assert.ok(lane.nonClaims.includes("no release authorization"), `${laneName}:release_nonclaim`);
}

exactKeys(index.existingSubinputs, ["inventoryReviewState", "inventoryFullRepositoryCandidateCoverage",
  "performanceVerdict", "changesReleaseClaim", "createsAdditionalBlocker"], "existingSubinputs");
assert.deepEqual(index.existingSubinputs, {
  inventoryReviewState: "needs_review",
  inventoryFullRepositoryCandidateCoverage: false,
  performanceVerdict: "INDETERMINATE_PROFILE_UNDERSPECIFIED_FAIL_CLOSED",
  changesReleaseClaim: false,
  createsAdditionalBlocker: false
});
assert.equal(index.claudeReview, "cancelled_by_Max_not_applicable_this_round");

let negativeCases = 0;
function rejected(callback, label) {
  negativeCases += 1;
  assert.throws(callback, undefined, label);
}
rejected(() => exactKeys({ ...index, unexpected: true }, Object.keys(index), "syntheticExtraKey"), "extra key");
rejected(() => assertNoCredentialOrReleaseClaim({ claim: "GO" }), "GO claim");
rejected(() => assertNoCredentialOrReleaseClaim({ status: "APPROVED" }), "approved claim");
rejected(() => assertNoCredentialOrReleaseClaim({ claim: "AUTHENTICITY_VERIFIED" }), "authenticity claim");
rejected(() => assertNoCredentialOrReleaseClaim({ credentialValue: "synthetic" }), "credential key");
rejected(() => assertNoCredentialOrReleaseClaim({ header: "Bearer synthetic-token" }), "credential material");
rejected(() => assertMissingExternalInput({ ...facts, authenticityVerified: true }, "syntheticAuthenticity"),
  "authenticity boolean");
rejected(() => assertMissingExternalInput({ ...facts, status: "RESOLVED" }, "syntheticStatus"),
  "resolved status");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, region: "UNDECIDED" }),
  "region undecided");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, billing: "UNDECIDED" }),
  "purchase undecided");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision,
  existingMaxOwnedUnregisteredDomain: "UNDECIDED" }), "domain undecided");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, selectedSubdomain: null }),
  "selected subdomain regression");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, provisioned: false }),
  "unpurchased regression");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, localFriendEntry: true }),
  "local friend entry regression");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, publicExposure: false }),
  "public foundation regression");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, finalCandidateDeployed: true }),
  "final candidate deployment claim");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, currentActive: {
  ...target.deploymentDecision.currentActive, candidateCommit
} }), "current active replaced by final package candidate");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, currentActive: {
  ...target.deploymentDecision.currentActive, candidateCommit: "45380ecd77315fcc95f3e445353f8abdc6c77603"
} }), "historical candidate replaces current active");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, currentActive: {
  ...target.deploymentDecision.currentActive, finalCandidateMatchesCurrentActive: true
} }), "current active falsely matches final package candidate");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, currentActive: {
  ...target.deploymentDecision.currentActive, finalCandidateDeployed: true
} }), "nested final candidate deployment claim");
rejected(() => assertDeploymentDecision({ ...target.deploymentDecision, credentialValue: "synthetic" }),
  "deployment secret material");
rejected(() => assertMissingExternalInput({ ...target, status: "RESOLVED" }, "syntheticTargetStatus"),
  "target resolved status");
rejected(() => assertNoCredentialOrReleaseClaim({ ...target, releaseClaim: "GO" }), "target GO claim");
rejected(() => assert.equal(sha256(Buffer.concat([handoffBytes, Buffer.from("tamper")])),
  index.handoffDocument.sha256), "document hash drift");
rejected(() => assert.deepEqual({ ...index.package, directoryName: "production-48a3841c91d0" }, index.package),
  "old package regression");
rejected(() => assert.deepEqual([...index.blockers, "synthetic_extra_blocker"], blockers), "blocker drift");

process.stdout.write(`${JSON.stringify({
  schema: "unseen-production-unblock-handoff-verification/1",
  status: "PASS_LINK_HASH_INDEX_ONLY",
  productionCandidateCommit: candidateCommit,
  productionCandidateTree: candidateTree,
  packageManifestSha256: index.package.manifestSha256,
  packageBundleSha256: index.package.bundleSha256,
  releaseClaim: "NO_GO",
  productionReady: false,
  blockers: blockers.length,
  authorityReferences: Object.values(expectedRefs).reduce((total, entries) => total + entries.length, 0),
  negativeCases,
  authenticityVerified: false,
  externalReceiptReads: 0,
  secretReads: 0,
  externalNetworkRequests: 0
})}\n`);
