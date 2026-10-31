import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "../..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(code); };
const equal = (actual, expected, code) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code);
};
const sorted = (values) => [...values].sort();
const sortedEntries = (value) => Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
const exactKeys = (value, keys, code) => equal(sorted(Object.keys(value ?? {})), sorted(keys), code);
const historicalBootstrapCommit = "a790b3a2d152701e75171cb4dfdeeda52e7bfbd5";
const historicalBootstrapTree = "36716b1cb5c9e1b9132551c7c9a4bcc7c6967f87";
const maintenanceParent = "f09f0ce9b622a6fcad0c05614bbe06b229ffb572";
const frozenContractPaths = [
  "IMPLEMENTATION-ORCHESTRATION.md",
  "l3-book-lab/ACTION-API-COVERAGE.book-lab.json",
  "l3-book-lab/ACTION-REGISTRY.book-lab.json",
  "l3-book-lab/BOOK-LAB-CONTRACT.md",
  "l3-book-lab/STATE-MACHINES.book-lab.json",
  "l3-book-lab/STRING-CATALOG.book-lab.zh-CN.json",
  "product-ui/ACTION-REGISTRY.json",
  "product-ui/DESIGN-TOKENS.json",
  "product-ui/STRING-CATALOG.zh-CN.json",
  "technical/ACTION-API-COVERAGE.json",
  "technical/CANONICAL-STATE-AND-API.md",
  "technical/CORE-FLOW-CONTRACT.md",
  "technical/RELEASE-READINESS-CONTRACT.md"
];
const authorityEvidencePaths = [
  "C2-CODEX-ACCEPTANCE.md",
  "C3-CLAUDE-DESKTOP-ACCEPTANCE.md",
  "C3-CONTRACT-ERRATUM-ACCEPTANCE.md",
  "C3-CONTRACT-REVISION-ACCEPTANCE.md",
  "C4-SOURCE-PROVENANCE-SUPPLEMENT.md",
  "STATE.md",
  "product-ui/SOURCE-OF-TRUTH.md",
  "product-ui/evidence/SHA256SUMS",
  "technical/EVIDENCE/01-INVENTORY-CLOUD.md",
  "technical/EVIDENCE/c3_contract_gate.py",
  "technical/EVIDENCE/c4-source-manifest-baseline.json",
  "technical/EVIDENCE/verify_c4_source_manifest.py"
];

export const trackTuples = [
  ["0L", "main", "/Users/max/code/unseen", "existing", "historical_bootstrap"],
  ["1A", "track/1a-api", "/Users/max/code/unseen-worktrees/1a-api", "existing", "historical_bootstrap"],
  ["2", "track/2-web", "/Users/max/code/unseen-worktrees/2-web", "existing", "historical_bootstrap"],
  ["3A", "track/3a-locator-offline", "/Users/max/code/unseen-worktrees/3a-locator-offline", "existing", "historical_bootstrap"],
  ["4", "track/4-viewer", "/Users/max/code/unseen-worktrees/4-viewer", "existing", "historical_bootstrap"],
  ["6A", "track/6a-trust-ops", "/Users/max/code/unseen-worktrees/6a-trust-ops", "existing", "historical_bootstrap"],
  ["1B", "track/1b-cloud-sandbox", "/Users/max/code/unseen-worktrees/1b-cloud-sandbox", "existing", "historical_bootstrap"],
  ["3B", "track/3b-locator-shadow", "/Users/max/code/unseen-worktrees/3b-locator-shadow", "existing", "historical_bootstrap"],
  ["5", "integration/r0", "/Users/max/code/unseen-worktrees/5-integration", "existing", "historical_bootstrap"],
  ["6B", "track/6b-release", "/Users/max/code/unseen-worktrees/6b-release", "existing", "historical_bootstrap"],
  ["7", "track/7-miniapp", "/Users/max/code/unseen-worktrees/7-miniapp", "existing", "historical_bootstrap"],
  ["R-C", "research/depth-parallax", "/Users/max/code/unseen-worktrees/r-c-depth", "existing", "historical_bootstrap"],
  ["R-D", "research/walkable3d", "/Users/max/code/unseen-worktrees/r-d-walkable3d", "existing", "historical_bootstrap"],
  ["8A", "track/8a-book-api", "/Users/max/code/unseen-worktrees/8a-book-api", "existing", "effective_revision_gate"],
  ["8B", "track/8b-book-web", "/Users/max/code/unseen-worktrees/8b-book-web", "existing", "effective_revision_gate"],
  ["8C", "integration/book-lab", "/Users/max/code/unseen-worktrees/8c-book-integration", "planned_not_created", "future_fixed_gate"]
];

export const exactTrackPolicy = {
  "0L": {
    startGate: "historical_bootstrap_complete_main_read_only",
    readOnlyDependencies: ["authority-contract-root", "formal-web-source-root", "recovered-backend-source-root"],
    writePaths: [],
    conditionalWritePaths: [],
    evidencePaths: ["C4-PROGRESS.md", "C4-BLOCKED.md", "C4-EVIDENCE.md", "provenance/**"],
    handoffCondition: "historical_bootstrap_and_matrix_readback_complete",
    writeRestrictions: "closed_historical_track_main_read_only"
  },
  "1A": {
    startGate: "effective_revision_frozen_controller_resumes_1a",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "imports/recovered-backend/**"],
    writePaths: ["services/api/src/**", "services/api/db/migrations/**", "services/api/tests/**", "services/api/package.json", "services/jobs/dispatch/**", "services/jobs/tests/**"],
    conditionalWritePaths: [], evidencePaths: ["services/api/tests/**", "services/jobs/tests/**"],
    handoffCondition: "clean_module_commit_with_runtime_a_d_and_api_evidence", writeRestrictions: "no_web_viewer_locator_release_paths"
  },
  "2": {
    startGate: "effective_revision_frozen_controller_resumes_2",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "imports/legacy-web/**", "packages/viewer/src/public/**"],
    writePaths: ["apps/web/**"], conditionalWritePaths: [], evidencePaths: ["apps/web/**/tests/**", "apps/web/**/screenshots/**"],
    handoffCondition: "clean_module_commit_with_production_adapter_and_visual_evidence", writeRestrictions: "viewer_kernel_forbidden"
  },
  "3A": {
    startGate: "effective_revision_frozen_controller_opens_locator_offline",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "imports/**"],
    writePaths: ["services/locator/**", "datasets/manifests/offline/**", "eval/offline/**", "release-evidence/locator-offline/**"], conditionalWritePaths: [], evidencePaths: ["eval/offline/**", "release-evidence/locator-offline/**"],
    handoffCondition: "clean_offline_locator_commit_with_dataset_model_threshold_hashes", writeRestrictions: "model_metadata_only_services_locator_releases"
  },
  "4": {
    startGate: "historical_track4_pass_commit_read_only",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "imports/legacy-web/**"],
    writePaths: ["packages/viewer/**"], conditionalWritePaths: [], evidencePaths: ["packages/viewer/**/tests/**", "packages/viewer/**/fixtures/**"],
    handoffCondition: "accepted_commit_5e068e3d04263adc2f480ac9db5a3bc1f18157d7", writeRestrictions: "read_only_unless_controller_reopens_for_exact_seam_rfc"
  },
  "6A": {
    startGate: "effective_revision_frozen_controller_opens_trust_ops",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "services/api/**", "apps/web/**"],
    writePaths: ["policy-inputs/**", "ops/security/**", "ops/observability/**", "runbooks/drafts/**", "tests/security-contract/**"], conditionalWritePaths: [], evidencePaths: ["tests/security-contract/**", "ops/security/**", "ops/observability/**"],
    handoffCondition: "clean_policy_security_ops_input_commit_no_business_backwrite", writeRestrictions: "services_and_apps_read_only"
  },
  "1B": {
    startGate: "approved_1a_plus_explicit_deletable_sandbox_authorization",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "services/api/src/ports/**"],
    writePaths: ["adapters/cloud/cloudbase/**", "infra/sandbox/**", "tests/cloud-sandbox/**", "release-evidence/cloud-sandbox/**"], conditionalWritePaths: [], evidencePaths: ["tests/cloud-sandbox/**", "release-evidence/cloud-sandbox/**"],
    handoffCondition: "clean_adapter_commit_with_request_ids_hashes_cleanup_cost", writeRestrictions: "no_production_cloud_write"
  },
  "3B": {
    startGate: "approved_3a_plus_written_real_data_authorization",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "services/locator/**"],
    writePaths: ["datasets/authorized/**", "eval/shadow/**", "release-evidence/locator-shadow/**"], conditionalWritePaths: [], evidencePaths: ["eval/shadow/**", "release-evidence/locator-shadow/**"],
    handoffCondition: "versioned_dataset_shadow_counterexample_destruction_evidence", writeRestrictions: "production_policy_db_ui_forbidden"
  },
  "5": {
    startGate: "stage_l_after_1a_2_4_stop_then_stage_rc_after_all_approved_inputs",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "approved-module-commits"],
    writePaths: ["tests/e2e/**", "infra/integration/**", "config/rc/**", "release-evidence/local-operable/**"], conditionalWritePaths: [{ path: "package-lock.json", condition: "all_other_writers_stopped" }], evidencePaths: ["tests/e2e/**", "infra/integration/**", "config/rc/**", "release-evidence/local-operable/**"],
    handoffCondition: "stage_l_local_operable_then_fixed_core_rc", writeRestrictions: "no_apps_services_viewer_business_writes"
  },
  "6B": {
    startGate: "fixed_core_rc",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "fixed-track5-core-rc", "release-evidence/cloud-sandbox/**", "release-evidence/locator-shadow/**", "release-evidence/locator-offline/**"],
    writePaths: ["release-evidence/r0/**", "ops/release/**", "runbooks/release/**"], conditionalWritePaths: [], evidencePaths: ["release-evidence/r0/**", "ops/release/**", "runbooks/release/**"],
    handoffCondition: "release_evidence_commit_for_controller_core_r0", writeRestrictions: "no_product_module_backwrite"
  },
  "7": {
    startGate: "controller_declares_core_r0_pass",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "canonical-api-read-only", "release-evidence/r0/**"],
    writePaths: ["apps/miniapp/**"], conditionalWritePaths: [], evidencePaths: ["apps/miniapp/**/tests/**"],
    handoffCondition: "thin_client_commit_same_ids_api_state", writeRestrictions: "no_second_backend"
  },
  "R-C": {
    startGate: "controller_registered_research_baseline_plus_model_gpu_data_authorization",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "formal-product-api-viewer-read-only"],
    writePaths: ["research/depth-parallax/**", "release-evidence/research/depth-parallax/**"], conditionalWritePaths: [], evidencePaths: ["release-evidence/research/depth-parallax/**"],
    handoffCondition: "research_commit_license_manifests_benchmark_go_no_go", writeRestrictions: "integration_only_by_future_rfc"
  },
  "R-D": {
    startGate: "controller_approved_fixture_and_research_baseline",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "formal-product-canonical-production-read-only"],
    writePaths: ["research/walkable3d/**", "release-evidence/research/walkable3d/**"], conditionalWritePaths: [], evidencePaths: ["release-evidence/research/walkable3d/**"],
    handoffCondition: "poc_commit_license_destruction_benchmark_go_no_go", writeRestrictions: "integration_only_by_future_rfc"
  },
  "8A": {
    startGate: "effective_revision_frozen_fixture_only_until_fixed_core_rc",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "frozen-book-fixtures"],
    writePaths: ["services/book-lab/**"], conditionalWritePaths: [{ path: "services/api/src/extensions/book-lab.mjs", condition: "fixed_core_rc_and_prior_owner_stopped" }], evidencePaths: ["services/book-lab/**/tests/**"],
    handoffCondition: "clean_fixture_backed_book_api_domain_commit_then_exact_seam_commit", writeRestrictions: "core90_and_core_services_forbidden_except_registered_seam"
  },
  "8B": {
    startGate: "effective_revision_frozen_fixture_only_until_fixed_core_rc",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "frozen-book-fixtures", "product-ui/evidence/**"],
    writePaths: ["packages/book-lab-web/**", "packages/book-renderer/**"], conditionalWritePaths: [{ path: "apps/web/src/extensions/book-lab.js", condition: "fixed_core_rc_and_prior_owner_stopped" }], evidencePaths: ["packages/book-lab-web/**/tests/**", "packages/book-renderer/**/tests/**"],
    handoffCondition: "clean_fixture_backed_book_web_renderer_commit_then_exact_seam_commit", writeRestrictions: "core_web_routes_ia_viewer_forbidden_except_registered_seam"
  },
  "8C": {
    startGate: "8a_8b_stopped_and_approved_on_same_fixed_core_rc",
    readOnlyDependencies: ["FREEZE-MANIFEST.json", "contracts/source/**", "packages/contracts/generated/**", "fixed-track5-core-rc", "approved-8a-commit", "approved-8b-commit"],
    writePaths: ["tests/e2e/book-lab/**", "infra/integration/book-lab/**", "config/book-lab-rc/**", "release-evidence/book-lab/**"], conditionalWritePaths: [{ path: "package-lock.json", condition: "all_other_writers_stopped" }], evidencePaths: ["tests/e2e/book-lab/**", "release-evidence/book-lab/**"],
    handoffCondition: "book_mve_candidate_with_12_16_page_html_pdf_and_core_regression", writeRestrictions: "business_seam_failures_return_to_8a_or_8b"
  }
};

const anchorPaths = {
  rootLockfile: "package-lock.json",
  generatedContractIndex: "packages/contracts/generated/contract-index.json",
  contractSourceManifest: "provenance/contract-source-manifest.json",
  historicalFingerprintBaseline: "contracts/source/technical/EVIDENCE/c4-source-manifest-baseline.json",
  safeImportInventory: "provenance/safe-import-inventory.json",
  verifier: "contracts/source/technical/EVIDENCE/verify_c4_source_manifest.py"
};
const immutableAnchorHashes = {
  rootLockfile: "75f8cd0f8f3b9284fe24cf9d8d07229afb2c5ddfded77b898e8d6201d6eb33ca",
  historicalFingerprintBaseline: "0ce863dd54ca485bea2c5acdf3a1cdaa2a1dd8b6376f1cb182a70f54f7b93d05",
  safeImportInventory: "2a591fc28e26f88a09af41004a5569657a6883fb0d2f6822c25222348a2aec40",
  verifier: "cc05a051f126606ffc62803fac2dd559994c085438b9b25318302ebad81754f4"
};
const sequentialOwnershipTransfers = {
  "8A": {
    priorTrack: "1A",
    futurePaths: ["services/api/src/extensions/book-lab.mjs"]
  },
  "8B": {
    priorTrack: "2",
    futurePaths: ["apps/web/src/extensions/book-lab.js"]
  },
  "8C": {
    priorTrack: "5",
    futurePaths: [
      "tests/e2e/book-lab/**",
      "infra/integration/book-lab/**",
      "package-lock.json"
    ]
  }
};

const visualHashes = {
  "contact-sheet-labeled.png": "3c71961209e7d71145b1ddb6adfb1d8109e607ba84274ac1020e993cffc9d9cf",
  "ref-1.webp": "bdb33edbd148578f22f56d23a3b3aa6b90617303c19605339078119aa4cf45df",
  "ref-2.webp": "56fe68ea1d7465f92d87b3f5e53a30368ee503d5c97ed43c480ff7cf2073c59d",
  "ref-3.webp": "7e4685acfad73f12cdabff676ec5ee668420fe9a529937a66d5e2d4408816055",
  "ref-4.webp": "d8e83572553ef0e54c515ed85af9ff29f68421fa6e9d5ff631eb1c6da4f82a77",
  "ref-5.webp": "497b5c2cb21b3f7734369047a949456efaa4b0ad83ca3de817e48d2e4c8802c1",
  "ref-6.webp": "6b3a43279307142f3c1f92dd1304744fd7fb10d348c1229e15edc03f77d91226"
};
const coreMetricCounts = {
  actions: 90,
  actionSourceReferenceChecks: 360,
  stringPhasePairs: 810,
  canonicalHttpMutationUniqueEndpoints: 59,
  coverageMutationUniqueEndpoints: 59,
  versionCasDictionaryFields: 47,
  technicalOperationEntries: 8,
  internalOperationEntries: 2
};
const bookMetricCounts = {
  actions: 20,
  actionSourceReferenceChecks: 80,
  stringPhasePairs: 180,
  canonicalHttpMutationUniqueEndpoints: 15,
  coverageMutationUniqueEndpoints: 15,
  versionCasDictionaryFields: 8,
  technicalOperationEntries: 0,
  internalOperationEntries: 2,
  stateMachineEntries: 5
};
const aggregateMetricCounts = {
  actions: 110,
  actionSourceReferenceChecks: 440,
  stringPhasePairs: 990,
  canonicalHttpMutationUniqueEndpoints: 74,
  coverageMutationUniqueEndpoints: 74,
  versionCasDictionaryFields: 55,
  technicalOperationEntries: 8,
  internalOperationEntries: 4
};

function assertHash(value, code) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) fail(code);
}

function assertRelativePath(value, code) {
  if (typeof value !== "string" || !value || /\s|\\|(^|\/)\.\.($|\/)/.test(value) || value.startsWith("/") || value.includes("*") && !value.endsWith("/**")) fail(code);
}

function overlaps(left, right) {
  const root = (value) => value.endsWith("/**") ? value.slice(0, -3) : value;
  const leftRoot = root(left);
  const rightRoot = root(right);
  return leftRoot === rightRoot || left.endsWith("/**") && rightRoot.startsWith(`${leftRoot}/`) || right.endsWith("/**") && leftRoot.startsWith(`${rightRoot}/`);
}

function assertMetricBlock(actual, expected, code) {
  equal(actual, expected, code);
}

function receiptByCopy(manifest, authoritativeCopy) {
  return [...manifest.frozenContracts, ...manifest.authorityEvidenceCopies, ...manifest.visualEvidenceCopies]
    .find((entry) => entry.authoritativeCopy === authoritativeCopy);
}

function isAllowedSequentialTransfer(previous, currentTrack, currentPath) {
  const transfer = sequentialOwnershipTransfers[currentTrack.id];
  if (!transfer || previous.track !== transfer.priorTrack || !transfer.futurePaths.includes(currentPath)) return false;
  const conditional = currentTrack.conditionalWritePaths.find((entry) => entry.path === currentPath);
  if (currentTrack.id === "8A" || currentTrack.id === "8B") {
    return currentTrack.base.kind === "effective_revision_gate"
      && currentTrack.base.requiredGate === "effective_revision_frozen"
      && conditional?.condition === "fixed_core_rc_and_prior_owner_stopped";
  }
  return currentTrack.base.kind === "future_fixed_gate"
    && currentTrack.base.sourceTrack === "5"
    && currentTrack.base.requiredGate === "fixed_core_rc"
    && (!conditional || conditional.condition === "all_other_writers_stopped");
}

export function validate(manifest, facts) {
  const required = ["$schema", "schemaVersion", "status", "c4FreezeComplete", "c4FreezeCompleteOwner", "canonicalContractWriter", "completionGates", "historicalBootstrap", "effectiveContractRevision", "acceptance", "controllerDeclarations", "contractMetrics", "frozenContracts", "authorityEvidenceCopies", "visualEvidenceCopies", "rootLockfile", "sourceManifests", "tracks"];
  if (!required.every((key) => Object.hasOwn(manifest, key))) fail("FREEZE_REQUIRED");
  exactKeys(manifest, required, "FREEZE_TOP_LEVEL_SHAPE");
  if (manifest.$schema !== "./FREEZE-MANIFEST.schema.json" || manifest.schemaVersion !== "unseen-c4-freeze-manifest/2" || manifest.status !== "c4_effective_revision_freeze_complete") fail("FREEZE_SCHEMA");
  if (facts.schema.$id !== manifest.schemaVersion || facts.schema.additionalProperties !== false || !facts.schema.required?.every((key) => Object.hasOwn(manifest, key))) fail("FREEZE_SCHEMA_FILE");
  if (manifest.c4FreezeComplete !== true || manifest.c4FreezeCompleteOwner !== "controller_only" || manifest.canonicalContractWriter !== "none-after-effective-revision-freeze") fail("FREEZE_STATUS");
  const completion = manifest.completionGates;
  exactKeys(completion, ["coreLocalOperable", "coreR0", "bookLabMve", "overall"], "FREEZE_COMPLETION_GATES");
  exactKeys(completion.coreLocalOperable, ["evidenceRoot", "goNoGoOwner", "passDefinition", "releaseMeaning", "affectsOverall"], "FREEZE_COMPLETION_GATES");
  exactKeys(completion.coreR0, ["evidenceRoot", "goNoGoOwner", "passDefinition", "track7ConsumesOnlyThisBooleanGate"], "FREEZE_COMPLETION_GATES");
  exactKeys(completion.bookLabMve, ["evidenceRoot", "goNoGoOwner", "passDefinition", "featureFlagDefault"], "FREEZE_COMPLETION_GATES");
  exactKeys(completion.overall, ["expression", "claim"], "FREEZE_COMPLETION_GATES");
  if (
    completion?.coreLocalOperable?.evidenceRoot !== "release-evidence/local-operable/"
    || completion?.coreLocalOperable?.goNoGoOwner !== "controller_only"
    || completion?.coreLocalOperable?.passDefinition !== "track5_stage_l_real_local_api_web_viewer_with_explicit_locator_fixture"
    || completion?.coreLocalOperable?.releaseMeaning !== "local_operable_not_integration_rc_r0_or_production"
    || completion?.coreLocalOperable?.affectsOverall !== false
    || completion?.coreR0?.evidenceRoot !== "release-evidence/r0/"
    || completion?.coreR0?.goNoGoOwner !== "controller_only"
    || completion?.coreR0?.passDefinition !== "core_module_integration_release_and_final_independent_reviews"
    || completion?.coreR0?.track7ConsumesOnlyThisBooleanGate !== true
    || completion?.bookLabMve?.evidenceRoot !== "release-evidence/book-lab/"
    || completion?.bookLabMve?.goNoGoOwner !== "controller_only"
    || completion?.bookLabMve?.passDefinition !== "track8_mve_and_final_independent_review"
    || completion?.bookLabMve?.featureFlagDefault !== "off"
    || completion?.overall?.expression !== "coreR0 == PASS && bookLabMve == PASS"
    || completion?.overall?.claim !== "full_round_complete"
  ) fail("FREEZE_COMPLETION_GATES");

  exactKeys(manifest.acceptance, ["historical", "revision", "unresolvedSeverity"], "FREEZE_ACCEPTANCE_SHAPE");
  exactKeys(manifest.acceptance.historical, ["C2", "C3-contract"], "FREEZE_ACCEPTANCE_SHAPE");
  exactKeys(manifest.acceptance.revision, ["Codex-C2", "Claude-Desktop-C3", "authoritativeCopy"], "FREEZE_ACCEPTANCE_SHAPE");
  exactKeys(manifest.acceptance.unresolvedSeverity, ["p0", "p1", "p2", "postLocalDebt"], "FREEZE_ACCEPTANCE_SHAPE");
  const acceptanceReceipts = [manifest.acceptance.historical.C2, manifest.acceptance.historical["C3-contract"], manifest.acceptance.revision["Codex-C2"], manifest.acceptance.revision["Claude-Desktop-C3"]];
  for (const receipt of acceptanceReceipts) {
    const receiptKeys = receipt.finalGate === undefined ? ["status", "p0", "p1", "p2", "sha256", "authoritativeCopy"] : ["status", "p0", "p1", "p2", "sha256", "authoritativeCopy", "finalGate"];
    exactKeys(receipt, receiptKeys, "FREEZE_ACCEPTANCE_SHAPE");
    assertHash(receipt.sha256, "FREEZE_ACCEPTANCE_RECEIPT");
    const copy = receiptByCopy(manifest, receipt.authoritativeCopy);
    if (!copy || copy.copySha256 !== receipt.sha256) fail("FREEZE_ACCEPTANCE_RECEIPT");
    if (receipt.status !== "PASS" || receipt.p0 !== 0 || receipt.p1 !== 0 || !Number.isInteger(receipt.p2) || receipt.p2 < 0) fail("FREEZE_REVISION_ACCEPTANCE");
  }
  if (
    manifest.acceptance.historical.C2.authoritativeCopy !== "contracts/source/C2-CODEX-ACCEPTANCE.md"
    || manifest.acceptance.historical["C3-contract"].authoritativeCopy !== "contracts/source/C3-CLAUDE-DESKTOP-ACCEPTANCE.md"
    || manifest.acceptance.revision["Codex-C2"].authoritativeCopy !== "contracts/source/C3-CONTRACT-REVISION-ACCEPTANCE.md"
    || manifest.acceptance.revision["Claude-Desktop-C3"].authoritativeCopy !== "contracts/source/C3-CONTRACT-REVISION-ACCEPTANCE.md"
    || manifest.acceptance.revision["Codex-C2"].sha256 !== manifest.acceptance.revision["Claude-Desktop-C3"].sha256
  ) fail("FREEZE_ACCEPTANCE_RECEIPT");
  const unresolved = manifest.acceptance.unresolvedSeverity;
  if (unresolved.p0 !== 0 || unresolved.p1 !== 0 || !Number.isInteger(unresolved.p2) || unresolved.p2 < 0 || unresolved.p2 !== unresolved.postLocalDebt.length) fail("FREEZE_REVISION_ACCEPTANCE");
  for (const debt of unresolved.postLocalDebt) {
    exactKeys(debt, ["id", "summary", "classification", "disposition", "doesNotAffect"], "FREEZE_POST_LOCAL_DEBT");
    if (typeof debt.id !== "string" || !debt.id || typeof debt.summary !== "string" || !debt.summary || debt.classification !== "non_blocking_governance_or_quality" || debt.disposition !== "post_local_operable") fail("FREEZE_POST_LOCAL_DEBT");
    equal(debt.doesNotAffect, ["authorization", "privacy", "data_consistency", "real_integration_seam"], "FREEZE_POST_LOCAL_DEBT");
  }
  if (manifest.acceptance.revision["Claude-Desktop-C3"].finalGate !== "ERRORS=0" || manifest.acceptance.revision.authoritativeCopy !== "contracts/source/C3-CONTRACT-REVISION-ACCEPTANCE.md") fail("FREEZE_REVISION_GATE");
  const declarations = manifest.controllerDeclarations;
  exactKeys(declarations, ["controllerDeclaredC4FreezeComplete", "controllerIndependentReadback", "candidateStatus", "candidateDoesNotSelfDeclareC4Complete", "noDeployPublishCloudWrite"], "FREEZE_CONTROLLER");
  if (declarations.controllerDeclaredC4FreezeComplete !== true || declarations.controllerIndependentReadback !== "PASS" || declarations.candidateStatus !== "accepted_by_controller" || declarations.candidateDoesNotSelfDeclareC4Complete !== true || declarations.noDeployPublishCloudWrite !== true) fail("FREEZE_CONTROLLER");

  exactKeys(manifest.historicalBootstrap, ["commit", "tree", "meaning", "mainReadOnlyAfterCommit"], "FREEZE_HISTORICAL_BOOTSTRAP");
  exactKeys(manifest.effectiveContractRevision, ["token", "kind", "parentCommit", "resolvedFullCommitCommand", "requiredBeforeAffectedTrackResume"], "FREEZE_EFFECTIVE_REVISION");
  if (manifest.historicalBootstrap.commit !== historicalBootstrapCommit || manifest.historicalBootstrap.tree !== historicalBootstrapTree || manifest.historicalBootstrap.meaning !== "original Track 0L bootstrap and actual starting commit for the original 13 tracks" || manifest.historicalBootstrap.mainReadOnlyAfterCommit !== true) fail("FREEZE_HISTORICAL_BOOTSTRAP");
  if (facts.bootstrapCommit !== historicalBootstrapCommit || facts.bootstrapTree !== historicalBootstrapTree) fail("FREEZE_HISTORICAL_BOOTSTRAP_GIT");
  if (manifest.effectiveContractRevision.token !== "SELF" || manifest.effectiveContractRevision.kind !== "runtime_erratum_plus_l3_book_lab" || manifest.effectiveContractRevision.parentCommit !== maintenanceParent || manifest.effectiveContractRevision.resolvedFullCommitCommand !== "git log -1 --format=%H -- FREEZE-MANIFEST.json" || manifest.effectiveContractRevision.requiredBeforeAffectedTrackResume !== true) fail("FREEZE_EFFECTIVE_REVISION");
  if (!/^[0-9a-f]{40}$/.test(facts.effectiveRevisionCommit) || facts.effectiveRevisionLines !== 1 || facts.effectiveRevisionManifest !== facts.manifestBytes) fail("FREEZE_EFFECTIVE_REVISION_GIT");
  equal(facts.effectiveRevisionParents, [facts.effectiveRevisionCommit, maintenanceParent], "FREEZE_EFFECTIVE_PARENT");

  if (manifest.frozenContracts.length !== 13 || manifest.authorityEvidenceCopies.length !== 12 || manifest.visualEvidenceCopies.length !== 7) fail("FREEZE_CONTRACT_EVIDENCE_COUNT");
  equal(sorted(manifest.frozenContracts.map((entry) => entry.relativePath)), frozenContractPaths, "FREEZE_CONTRACT_SET");
  equal(sorted(manifest.authorityEvidenceCopies.map((entry) => entry.relativePath)), authorityEvidencePaths, "FREEZE_AUTHORITY_SET");
  for (const entry of [...manifest.frozenContracts, ...manifest.authorityEvidenceCopies, ...manifest.visualEvidenceCopies]) {
    exactKeys(entry, ["relativePath", "sourceAbsolutePath", "sourceSha256", "authoritativeCopy", "copySha256", "bytes", "mode", "authorityRole", "status"], "FREEZE_COPY_SHAPE");
    assertHash(entry.sourceSha256, "FREEZE_COPY_HASH_SHAPE");
    assertHash(entry.copySha256, "FREEZE_COPY_HASH_SHAPE");
    if (entry.sourceSha256 !== entry.copySha256 || facts.hashes[entry.authoritativeCopy] !== entry.copySha256) fail("FREEZE_COPY_HASH");
  }
  const visualByName = Object.fromEntries(manifest.visualEvidenceCopies.map((entry) => [path.posix.basename(entry.authoritativeCopy), entry.copySha256]));
  equal(sortedEntries(visualByName), sortedEntries(visualHashes), "FREEZE_VISUAL_SET");
  equal(sortedEntries(facts.visualSums), sortedEntries(visualHashes), "FREEZE_VISUAL_SUMS");
  const declaredCopies = sorted([...manifest.frozenContracts, ...manifest.authorityEvidenceCopies, ...manifest.visualEvidenceCopies].map((entry) => entry.authoritativeCopy));
  equal(declaredCopies, sorted(facts.contractSource.entries.map((entry) => entry.authoritativeCopy)), "FREEZE_SOURCE_COPY_SET");
  const copyProjection = (entries) => [...entries]
    .sort((left, right) => left.authoritativeCopy.localeCompare(right.authoritativeCopy))
    .map((entry) => ({
      relativePath: entry.relativePath,
      sourceAbsolutePath: entry.sourceAbsolutePath,
      sourceSha256: entry.sourceSha256,
      authoritativeCopy: entry.authoritativeCopy,
      copySha256: entry.copySha256,
      bytes: entry.bytes,
      mode: entry.mode,
      authorityRole: entry.authorityRole,
      status: entry.status
    }));
  equal(copyProjection([...manifest.frozenContracts, ...manifest.authorityEvidenceCopies, ...manifest.visualEvidenceCopies]), copyProjection(facts.contractSource.entries), "FREEZE_SOURCE_COPY_METADATA");
  const source = manifest.sourceManifests.contractSourceManifest;
  if (source.fileCount !== 32 || source.frozenSemanticContractCount !== 13 || source.authorityEvidenceCount !== 12 || source.visualEvidenceCount !== 7 || facts.hashes[source.relativePath] !== source.sha256) fail("FREEZE_SOURCE_MANIFEST");
  if (facts.contractSource.schemaVersion !== "unseen-c4-contract-source-manifest/2" || facts.contractSource.entries.length !== 32) fail("FREEZE_SOURCE_MANIFEST_V2");

  const metrics = manifest.contractMetrics;
  exactKeys(metrics, ["core", "bookLab", "aggregate", "generatedContractIndex"], "FREEZE_METRIC_SHAPE");
  exactKeys(metrics.generatedContractIndex, ["relativePath", "sha256"], "FREEZE_METRIC_SHAPE");
  assertMetricBlock(metrics.core, coreMetricCounts, "FREEZE_CORE_METRICS");
  assertMetricBlock(metrics.bookLab, bookMetricCounts, "FREEZE_BOOK_METRICS");
  assertMetricBlock(metrics.aggregate, aggregateMetricCounts, "FREEZE_AGGREGATE_METRICS");
  assertMetricBlock(facts.contractIndex.namespaceCounts.core, coreMetricCounts, "FREEZE_CORE_INDEX_METRICS");
  assertMetricBlock(facts.contractIndex.namespaceCounts.bookLab, bookMetricCounts, "FREEZE_BOOK_INDEX_METRICS");
  assertMetricBlock(facts.contractIndex.counts, aggregateMetricCounts, "FREEZE_AGGREGATE_INDEX_METRICS");
  if (metrics.generatedContractIndex.relativePath !== anchorPaths.generatedContractIndex) fail("FREEZE_ANCHOR_PATH");
  if (metrics.generatedContractIndex.sha256 !== facts.hashes[metrics.generatedContractIndex.relativePath]) fail("FREEZE_INDEX_HASH");
  if (facts.generatedFiles.length !== 11) fail("FREEZE_GENERATED_COUNT");
  const requiredBookGenerated = ["book-lab/action-api-coverage.json", "book-lab/action-registry.json", "book-lab/contract-index.json", "book-lab/state-machines.json", "book-lab/string-catalog.zh-CN.json"];
  if (!requiredBookGenerated.every((entry) => facts.generatedFiles.includes(entry))) fail("FREEZE_BOOK_GENERATED_SET");

  const security = facts.coverage.summary.securityCoverage;
  if (security.versionCasDictionaryFields !== 47 || security.technicalOperationEntries !== 8 || security.internalOperationEntries !== 2 || security.canonicalHttpMutationUniqueEndpoints !== 59 || security.coverageMutationUniqueEndpoints !== 59 || security.canonicalHttpMutationSetEqualityMissing !== 0 || security.canonicalHttpMutationSetEqualityOrphan !== 0 || security.internalOperationGaps !== 0) fail("FREEZE_CORE_COVERAGE_GAPS");
  const receiptRecovery = facts.coverage.actions.find((entry) => entry.actionId === "BATCH.RECOVER_FROM_ACCOUNT");
  if (!receiptRecovery || !receiptRecovery.stableErrors.includes("receipt_recovery_unavailable") || receiptRecovery.stableErrors.includes("recovery_unavailable") || !facts.canonicalText.includes("统一`receipt_recovery_unavailable`")) fail("FREEZE_RECEIPT_RECOVERY_ERROR");
  const bookActionIds = facts.bookRegistry.actions.map((entry) => entry.id);
  if (new Set(bookActionIds).size !== 20 || Object.keys(facts.bookState.machines).length !== 5 || facts.bookCoverage.actions.length !== 20 || Object.keys(facts.bookCoverage.versionCasDictionary).length !== 8 || (facts.bookCoverage.internalOperationCoverage ?? []).length !== 2) fail("FREEZE_BOOK_CONTRACT_SHAPE");
  equal(sorted((facts.bookCoverage.internalOperationCoverage ?? []).map((entry) => `${entry.operationId}|${entry.endpoint}`)), ["BOOK_RENDER_PROCESSOR|internal:book-lab-render-processor", "QUESTION_PROCESSOR|internal:book-lab-question-processor"], "FREEZE_BOOK_INTERNAL_SET");
  if (facts.bookCoverage.actions.some((entry) => entry.method === "GET" && entry.replayClass !== "not_applicable" || ["POST", "PUT", "PATCH", "DELETE"].includes(entry.method) && !["ordinary_dto", "completed_state"].includes(entry.replayClass))) fail("FREEZE_BOOK_REPLAY_CLASS");
  if ((facts.bookCoverage.internalOperationCoverage ?? []).some((entry) => entry.replayClass !== "completed_state")) fail("FREEZE_BOOK_INTERNAL_REPLAY_CLASS");

  const historical = Object.fromEntries(manifest.sourceManifests.historicalFingerprintBaseline.scopes.map((scope) => [scope.id, [scope.expectedCount, scope.expectedAggregateSha256]]));
  exactKeys(manifest.rootLockfile, ["relativePath", "sha256"], "FREEZE_ANCHOR_SHAPE");
  exactKeys(manifest.sourceManifests, ["contractSourceManifest", "historicalFingerprintBaseline", "safeImportInventory", "verifier"], "FREEZE_ANCHOR_SHAPE");
  exactKeys(manifest.sourceManifests.contractSourceManifest, ["relativePath", "sha256", "fileCount", "frozenSemanticContractCount", "authorityEvidenceCount", "visualEvidenceCount"], "FREEZE_ANCHOR_SHAPE");
  exactKeys(manifest.sourceManifests.historicalFingerprintBaseline, ["relativePath", "sha256", "scopes"], "FREEZE_ANCHOR_SHAPE");
  exactKeys(manifest.sourceManifests.safeImportInventory, ["relativePath", "sha256", "summary"], "FREEZE_ANCHOR_SHAPE");
  exactKeys(manifest.sourceManifests.verifier, ["relativePath", "sha256", "requiredTerminator"], "FREEZE_ANCHOR_SHAPE");
  if (
    manifest.rootLockfile.relativePath !== anchorPaths.rootLockfile
    || metrics.generatedContractIndex.relativePath !== anchorPaths.generatedContractIndex
    || manifest.sourceManifests.contractSourceManifest.relativePath !== anchorPaths.contractSourceManifest
    || manifest.sourceManifests.historicalFingerprintBaseline.relativePath !== anchorPaths.historicalFingerprintBaseline
    || manifest.sourceManifests.safeImportInventory.relativePath !== anchorPaths.safeImportInventory
    || manifest.sourceManifests.verifier.relativePath !== anchorPaths.verifier
  ) fail("FREEZE_ANCHOR_PATH");
  if (
    manifest.rootLockfile.sha256 !== immutableAnchorHashes.rootLockfile
    || manifest.sourceManifests.historicalFingerprintBaseline.sha256 !== immutableAnchorHashes.historicalFingerprintBaseline
    || manifest.sourceManifests.safeImportInventory.sha256 !== immutableAnchorHashes.safeImportInventory
    || manifest.sourceManifests.verifier.sha256 !== immutableAnchorHashes.verifier
    || manifest.sourceManifests.verifier.requiredTerminator !== "C4_SOURCE_MANIFEST_OK"
  ) fail("FREEZE_ANCHOR_HASH");
  equal(historical, facts.historicalScopes, "FREEZE_HISTORICAL");
  for (const [key, value] of Object.entries(facts.inventorySummary)) if (manifest.sourceManifests.safeImportInventory.summary[key] !== value) fail("FREEZE_INVENTORY_COUNTS");
  if (
    facts.hashes[manifest.sourceManifests.contractSourceManifest.relativePath] !== manifest.sourceManifests.contractSourceManifest.sha256
    || facts.hashes[manifest.sourceManifests.historicalFingerprintBaseline.relativePath] !== manifest.sourceManifests.historicalFingerprintBaseline.sha256
    || facts.hashes[manifest.sourceManifests.safeImportInventory.relativePath] !== manifest.sourceManifests.safeImportInventory.sha256
    || facts.hashes[manifest.sourceManifests.verifier.relativePath] !== manifest.sourceManifests.verifier.sha256
    || facts.hashes[manifest.rootLockfile.relativePath] !== manifest.rootLockfile.sha256
  ) fail("FREEZE_ANCHOR_HASH");

  const projectedTracks = manifest.tracks.map((track) => [track.id, track.branch, track.worktreeAbsolutePath, track.lifecycle, track.base.kind]);
  equal(projectedTracks, trackTuples, "FREEZE_TRACKS");
  if (manifest.tracks.some((track) => track.requiredEffectiveRevision !== "SELF")) fail("FREEZE_TRACK_REVISION");
  for (const track of manifest.tracks.slice(0, 13)) if (track.base.commit !== historicalBootstrapCommit) fail("FREEZE_TRACK_HISTORICAL_BASE");
  for (const track of manifest.tracks.slice(13, 15)) if (track.base.kind !== "effective_revision_gate" || track.base.requiredGate !== "effective_revision_frozen") fail("FREEZE_TRACK8_BASE");
  const track8C = manifest.tracks[15];
  if (track8C.base.kind !== "future_fixed_gate" || track8C.base.sourceTrack !== "5" || track8C.base.requiredGate !== "fixed_core_rc") fail("FREEZE_TRACK8_BASE");
  equal(facts.track8Presence, [
    { id: "8A", branchExists: true, worktreeExists: true },
    { id: "8B", branchExists: true, worktreeExists: true },
    { id: "8C", branchExists: false, worktreeExists: false }
  ], "FREEZE_TRACK8_REGISTRATION");

  const owned = [];
  for (const track of manifest.tracks) {
    exactKeys(track, ["id", "branch", "worktreeAbsolutePath", "lifecycle", "base", "requiredEffectiveRevision", "startGate", "readOnlyDependencies", "writePaths", "conditionalWritePaths", "evidencePaths", "handoffCondition", "writeRestrictions"], "FREEZE_TRACK_SHAPE");
    const expectedPolicy = exactTrackPolicy[track.id];
    if (!expectedPolicy) fail("FREEZE_TRACK_POLICY");
    if (!Array.isArray(track.writePaths) || !Array.isArray(track.conditionalWritePaths)) fail("FREEZE_WRITE_SHAPE");
    exactKeys(track.base, track.base.kind === "historical_bootstrap"
      ? ["kind", "commit"]
      : track.base.kind === "effective_revision_gate"
        ? ["kind", "requiredGate"]
        : ["kind", "sourceTrack", "requiredGate"], "FREEZE_TRACK_BASE_SHAPE");
    for (const writePath of track.writePaths) {
      assertRelativePath(writePath, "FREEZE_WRITE_PATH");
      for (const previous of owned) if (overlaps(writePath, previous.path) && !isAllowedSequentialTransfer(previous, track, writePath)) fail("FREEZE_WRITE_OVERLAP");
      owned.push({ track: track.id, path: writePath });
    }
    for (const conditional of track.conditionalWritePaths) {
      assertRelativePath(conditional.path, "FREEZE_CONDITIONAL_PATH");
      exactKeys(conditional, ["path", "condition"], "FREEZE_CONDITIONAL_SHAPE");
      if (!["all_other_writers_stopped", "fixed_core_rc_and_prior_owner_stopped"].includes(conditional.condition)) fail("FREEZE_CONDITIONAL_ENUM");
      for (const previous of owned) if (overlaps(conditional.path, previous.path) && !isAllowedSequentialTransfer(previous, track, conditional.path)) fail("FREEZE_WRITE_OVERLAP");
      owned.push({ track: track.id, path: conditional.path });
    }
    for (const key of ["startGate", "readOnlyDependencies", "writePaths", "conditionalWritePaths", "evidencePaths", "handoffCondition", "writeRestrictions"]) {
      equal(track[key], expectedPolicy[key], "FREEZE_TRACK_POLICY");
    }
  }
  if (facts.historicalBootstrapBusinessRootFiles.length !== 0) fail("FREEZE_BOOTSTRAP_BUSINESS_ROOT");
  return { status: "FREEZE_MANIFEST_OK", effectiveRevisionCommit: facts.effectiveRevisionCommit, tracks: 16, contractSources: 32, generatedFiles: 11 };
}

async function hashFile(repoRoot, relative) {
  return sha256(await readFile(path.join(repoRoot, relative)));
}

async function allFiles(root, prefix = "") {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await allFiles(absolute, relative));
    else if (entry.isFile()) output.push(relative);
  }
  return output.sort();
}

export async function collectFacts(repoRoot = defaultRepoRoot) {
  const manifestBytes = await readFile(path.join(repoRoot, "FREEZE-MANIFEST.json"), "utf8");
  const manifest = JSON.parse(manifestBytes);
  const relativeFiles = new Set([
    ...manifest.frozenContracts.map((entry) => entry.authoritativeCopy),
    ...manifest.authorityEvidenceCopies.map((entry) => entry.authoritativeCopy),
    ...manifest.visualEvidenceCopies.map((entry) => entry.authoritativeCopy),
    manifest.sourceManifests.contractSourceManifest.relativePath,
    manifest.sourceManifests.safeImportInventory.relativePath,
    manifest.rootLockfile.relativePath,
    manifest.contractMetrics.generatedContractIndex.relativePath
  ]);
  const hashes = {};
  for (const relative of relativeFiles) hashes[relative] = await hashFile(repoRoot, relative);
  const visualSums = {};
  for (const line of (await readFile(path.join(repoRoot, "contracts/source/product-ui/evidence/SHA256SUMS"), "utf8")).trim().split("\n")) {
    const match = /^([0-9a-f]{64})  ([^/]+)$/.exec(line);
    if (!match || Object.hasOwn(visualSums, match[2])) fail("FREEZE_VISUAL_SUMS_FORMAT");
    visualSums[match[2]] = match[1];
  }
  const effective = spawnSync("git", ["log", "-1", "--format=%H", "--", "FREEZE-MANIFEST.json"], { cwd: repoRoot, encoding: "utf8" });
  if (effective.status !== 0) fail("FREEZE_EFFECTIVE_COMMAND");
  const effectiveLines = effective.stdout.trim().split("\n").filter(Boolean);
  const effectiveRevisionCommit = effectiveLines[0] ?? "";
  const effectiveManifest = spawnSync("git", ["show", `${effectiveRevisionCommit}:FREEZE-MANIFEST.json`], { cwd: repoRoot, encoding: "utf8" });
  const effectiveParents = spawnSync("git", ["rev-list", "--parents", "-n", "1", effectiveRevisionCommit], { cwd: repoRoot, encoding: "utf8" });
  const bootstrapTree = spawnSync("git", ["show", "-s", "--format=%T", historicalBootstrapCommit], { cwd: repoRoot, encoding: "utf8" });
  const bootstrapBusinessRoots = spawnSync("git", ["ls-tree", "-r", "--name-only", historicalBootstrapCommit, "--", "apps", "services"], { cwd: repoRoot, encoding: "utf8" });
  if (effectiveManifest.status !== 0 || effectiveParents.status !== 0 || bootstrapTree.status !== 0 || bootstrapBusinessRoots.status !== 0) fail("FREEZE_GIT_FACTS");
  const inventory = JSON.parse(await readFile(path.join(repoRoot, "provenance/safe-import-inventory.json"), "utf8"));
  const baseline = JSON.parse(await readFile(path.join(repoRoot, "contracts/source/technical/EVIDENCE/c4-source-manifest-baseline.json"), "utf8"));
  return {
    manifest,
    facts: {
      manifestBytes,
      hashes,
      schema: JSON.parse(await readFile(path.join(repoRoot, "FREEZE-MANIFEST.schema.json"), "utf8")),
      contractIndex: JSON.parse(await readFile(path.join(repoRoot, "packages/contracts/generated/contract-index.json"), "utf8")),
      generatedFiles: await allFiles(path.join(repoRoot, "packages/contracts/generated")),
      contractSource: JSON.parse(await readFile(path.join(repoRoot, "provenance/contract-source-manifest.json"), "utf8")),
      coverage: JSON.parse(await readFile(path.join(repoRoot, "contracts/source/technical/ACTION-API-COVERAGE.json"), "utf8")),
      canonicalText: await readFile(path.join(repoRoot, "contracts/source/technical/CANONICAL-STATE-AND-API.md"), "utf8"),
      bookRegistry: JSON.parse(await readFile(path.join(repoRoot, "contracts/source/l3-book-lab/ACTION-REGISTRY.book-lab.json"), "utf8")),
      bookCoverage: JSON.parse(await readFile(path.join(repoRoot, "contracts/source/l3-book-lab/ACTION-API-COVERAGE.book-lab.json"), "utf8")),
      bookState: JSON.parse(await readFile(path.join(repoRoot, "contracts/source/l3-book-lab/STATE-MACHINES.book-lab.json"), "utf8")),
      visualSums,
      effectiveRevisionCommit,
      effectiveRevisionLines: effectiveLines.length,
      effectiveRevisionManifest: effectiveManifest.stdout,
      effectiveRevisionParents: effectiveParents.stdout.trim().split(/\s+/).filter(Boolean),
      bootstrapCommit: historicalBootstrapCommit,
      bootstrapTree: bootstrapTree.stdout.trim(),
      historicalBootstrapBusinessRootFiles: bootstrapBusinessRoots.stdout.trim() ? bootstrapBusinessRoots.stdout.trim().split("\n") : [],
      historicalScopes: Object.fromEntries(baseline.scopes.map((scope) => [scope.id, [scope.expectedCount, scope.expectedAggregateSha256]])),
      inventorySummary: {
        included: inventory.entries.filter((entry) => entry.status === "included").length,
        excluded: inventory.entries.filter((entry) => entry.status === "excluded").length,
        total: inventory.entries.length
      },
      track8Presence: [
        ["8A", "track/8a-book-api", "/Users/max/code/unseen-worktrees/8a-book-api"],
        ["8B", "track/8b-book-web", "/Users/max/code/unseen-worktrees/8b-book-web"],
        ["8C", "integration/book-lab", "/Users/max/code/unseen-worktrees/8c-book-integration"]
      ].map(([id, branch, worktree]) => ({
        id,
        branchExists: spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot }).status === 0,
        worktreeExists: existsSync(worktree)
      }))
    }
  };
}

if (process.argv[1] === scriptPath) {
  const { manifest, facts } = await collectFacts();
  process.stdout.write(`${JSON.stringify(validate(manifest, facts))}\n`);
}
