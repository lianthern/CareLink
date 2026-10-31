import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { exactTrackPolicy, trackTuples, validate } from "./check-freeze-manifest.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const historicalCommit = "a790b3a2d152701e75171cb4dfdeeda52e7bfbd5";
const historicalTree = "36716b1cb5c9e1b9132551c7c9a4bcc7c6967f87";
const maintenanceParent = "f09f0ce9b622a6fcad0c05614bbe06b229ffb572";
const effectiveCommit = "4".repeat(40);
const immutableAnchorHashes = {
  "package-lock.json": "75f8cd0f8f3b9284fe24cf9d8d07229afb2c5ddfded77b898e8d6201d6eb33ca",
  "contracts/source/technical/EVIDENCE/c4-source-manifest-baseline.json": "0ce863dd54ca485bea2c5acdf3a1cdaa2a1dd8b6376f1cb182a70f54f7b93d05",
  "provenance/safe-import-inventory.json": "2a591fc28e26f88a09af41004a5569657a6883fb0d2f6822c25222348a2aec40",
  "contracts/source/technical/EVIDENCE/verify_c4_source_manifest.py": "cc05a051f126606ffc62803fac2dd559994c085438b9b25318302ebad81754f4"
};
const frozenPaths = [
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
const authorityPaths = [
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
const visualHashes = {
  "product-ui/evidence/contact-sheet-labeled.png": "3c71961209e7d71145b1ddb6adfb1d8109e607ba84274ac1020e993cffc9d9cf",
  "product-ui/evidence/ref-1.webp": "bdb33edbd148578f22f56d23a3b3aa6b90617303c19605339078119aa4cf45df",
  "product-ui/evidence/ref-2.webp": "56fe68ea1d7465f92d87b3f5e53a30368ee503d5c97ed43c480ff7cf2073c59d",
  "product-ui/evidence/ref-3.webp": "7e4685acfad73f12cdabff676ec5ee668420fe9a529937a66d5e2d4408816055",
  "product-ui/evidence/ref-4.webp": "d8e83572553ef0e54c515ed85af9ff29f68421fa6e9d5ff631eb1c6da4f82a77",
  "product-ui/evidence/ref-5.webp": "497b5c2cb21b3f7734369047a949456efaa4b0ad83ca3de817e48d2e4c8802c1",
  "product-ui/evidence/ref-6.webp": "6b3a43279307142f3c1f92dd1304744fd7fb10d348c1229e15edc03f77d91226"
};
const core = {
  actions: 90,
  actionSourceReferenceChecks: 360,
  stringPhasePairs: 810,
  canonicalHttpMutationUniqueEndpoints: 59,
  coverageMutationUniqueEndpoints: 59,
  versionCasDictionaryFields: 47,
  technicalOperationEntries: 8,
  internalOperationEntries: 2
};
const bookLab = {
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
const aggregate = {
  actions: 110,
  actionSourceReferenceChecks: 440,
  stringPhasePairs: 990,
  canonicalHttpMutationUniqueEndpoints: 74,
  coverageMutationUniqueEndpoints: 74,
  versionCasDictionaryFields: 55,
  technicalOperationEntries: 8,
  internalOperationEntries: 4
};

function copyEntry(relativePath, role, copySha256 = immutableAnchorHashes[`contracts/source/${relativePath}`] ?? digest(relativePath)) {
  return {
    relativePath,
    sourceAbsolutePath: `/Users/max/authority/${relativePath}`,
    sourceSha256: copySha256,
    authoritativeCopy: `contracts/source/${relativePath}`,
    copySha256,
    bytes: 1,
    mode: "-rw-r--r--",
    authorityRole: role,
    status: "byte_exact_authoritative_copy"
  };
}

const frozen = frozenPaths.map((relativePath) => copyEntry(
  relativePath,
  relativePath === "IMPLEMENTATION-ORCHESTRATION.md"
    ? "frozen_orchestration_contract"
    : "frozen_semantic_contract"
));
const authority = authorityPaths.map((relativePath) => copyEntry(relativePath, "authority_evidence"));
const visuals = Object.entries(visualHashes).map(([relativePath, hash]) => copyEntry(relativePath, "visual_evidence", hash));
const tracks = trackTuples.map(([id, branch, worktreeAbsolutePath, lifecycle, kind]) => ({
  id,
  branch,
  worktreeAbsolutePath,
  lifecycle,
  base: kind === "historical_bootstrap"
    ? { kind, commit: historicalCommit }
    : kind === "effective_revision_gate"
      ? { kind, requiredGate: "effective_revision_frozen" }
      : { kind, sourceTrack: "5", requiredGate: "fixed_core_rc" },
  requiredEffectiveRevision: "SELF",
  ...structuredClone(exactTrackPolicy[id])
}));

const copyHashes = Object.fromEntries(
  [...frozen, ...authority, ...visuals].map((entry) => [entry.authoritativeCopy, entry.copySha256])
);
const receipt = (authoritativeCopy, finalGate) => ({
  status: "PASS",
  p0: 0,
  p1: 0,
  p2: 0,
  sha256: copyHashes[authoritativeCopy],
  authoritativeCopy,
  ...(finalGate ? { finalGate } : {})
});
const anchor = (relativePath) => ({ relativePath, sha256: immutableAnchorHashes[relativePath] ?? digest(relativePath) });

const manifest = {
  $schema: "./FREEZE-MANIFEST.schema.json",
  schemaVersion: "unseen-c4-freeze-manifest/2",
  status: "c4_effective_revision_freeze_complete",
  c4FreezeComplete: true,
  c4FreezeCompleteOwner: "controller_only",
  canonicalContractWriter: "none-after-effective-revision-freeze",
  completionGates: {
    coreLocalOperable: {
      evidenceRoot: "release-evidence/local-operable/",
      goNoGoOwner: "controller_only",
      passDefinition: "track5_stage_l_real_local_api_web_viewer_with_explicit_locator_fixture",
      releaseMeaning: "local_operable_not_integration_rc_r0_or_production",
      affectsOverall: false
    },
    coreR0: {
      evidenceRoot: "release-evidence/r0/",
      goNoGoOwner: "controller_only",
      passDefinition: "core_module_integration_release_and_final_independent_reviews",
      track7ConsumesOnlyThisBooleanGate: true
    },
    bookLabMve: {
      evidenceRoot: "release-evidence/book-lab/",
      goNoGoOwner: "controller_only",
      passDefinition: "track8_mve_and_final_independent_review",
      featureFlagDefault: "off"
    },
    overall: { expression: "coreR0 == PASS && bookLabMve == PASS", claim: "full_round_complete" }
  },
  historicalBootstrap: {
    commit: historicalCommit,
    tree: historicalTree,
    meaning: "original Track 0L bootstrap and actual starting commit for the original 13 tracks",
    mainReadOnlyAfterCommit: true
  },
  effectiveContractRevision: {
    token: "SELF",
    kind: "runtime_erratum_plus_l3_book_lab",
    parentCommit: maintenanceParent,
    resolvedFullCommitCommand: "git log -1 --format=%H -- FREEZE-MANIFEST.json",
    requiredBeforeAffectedTrackResume: true
  },
  acceptance: {
    historical: {
      C2: receipt("contracts/source/C2-CODEX-ACCEPTANCE.md"),
      "C3-contract": receipt("contracts/source/C3-CLAUDE-DESKTOP-ACCEPTANCE.md", "ERRORS=0")
    },
    revision: {
      "Codex-C2": receipt("contracts/source/C3-CONTRACT-REVISION-ACCEPTANCE.md"),
      "Claude-Desktop-C3": receipt("contracts/source/C3-CONTRACT-REVISION-ACCEPTANCE.md", "ERRORS=0"),
      authoritativeCopy: "contracts/source/C3-CONTRACT-REVISION-ACCEPTANCE.md"
    },
    unresolvedSeverity: { p0: 0, p1: 0, p2: 0, postLocalDebt: [] }
  },
  controllerDeclarations: {
    controllerDeclaredC4FreezeComplete: true,
    controllerIndependentReadback: "PASS",
    candidateStatus: "accepted_by_controller",
    candidateDoesNotSelfDeclareC4Complete: true,
    noDeployPublishCloudWrite: true
  },
  contractMetrics: {
    core,
    bookLab,
    aggregate,
    generatedContractIndex: anchor("packages/contracts/generated/contract-index.json")
  },
  frozenContracts: frozen,
  authorityEvidenceCopies: authority,
  visualEvidenceCopies: visuals,
  rootLockfile: anchor("package-lock.json"),
  sourceManifests: {
    contractSourceManifest: {
      ...anchor("provenance/contract-source-manifest.json"),
      fileCount: 32,
      frozenSemanticContractCount: 13,
      authorityEvidenceCount: 12,
      visualEvidenceCount: 7
    },
    historicalFingerprintBaseline: {
      ...anchor("contracts/source/technical/EVIDENCE/c4-source-manifest-baseline.json"),
      scopes: [
        { id: "formal_web", expectedCount: 130, expectedAggregateSha256: digest("formal_web") },
        { id: "recovered_source", expectedCount: 174, expectedAggregateSha256: digest("recovered_source") },
        { id: "recovered_backend", expectedCount: 13, expectedAggregateSha256: digest("recovered_backend") }
      ]
    },
    safeImportInventory: {
      ...anchor("provenance/safe-import-inventory.json"),
      summary: { included: 357, excluded: 178, total: 535 }
    },
    verifier: {
      ...anchor("contracts/source/technical/EVIDENCE/verify_c4_source_manifest.py"),
      requiredTerminator: "C4_SOURCE_MANIFEST_OK"
    }
  },
  tracks
};
const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
const hashes = {
  ...copyHashes,
  "packages/contracts/generated/contract-index.json": manifest.contractMetrics.generatedContractIndex.sha256,
  "package-lock.json": manifest.rootLockfile.sha256,
  "provenance/contract-source-manifest.json": manifest.sourceManifests.contractSourceManifest.sha256,
  "provenance/safe-import-inventory.json": manifest.sourceManifests.safeImportInventory.sha256
};
const facts = {
  manifestBytes,
  hashes,
  schema: { $id: manifest.schemaVersion, additionalProperties: false, required: Object.keys(manifest) },
  contractIndex: { namespaceCounts: { core, bookLab }, counts: aggregate },
  generatedFiles: [
    "action-api-coverage.json",
    "action-registry.json",
    "canonical-enums.json",
    "contract-index.json",
    "design-tokens.json",
    "string-catalog.zh-CN.json",
    "book-lab/action-api-coverage.json",
    "book-lab/action-registry.json",
    "book-lab/contract-index.json",
    "book-lab/state-machines.json",
    "book-lab/string-catalog.zh-CN.json"
  ],
  contractSource: {
    schemaVersion: "unseen-c4-contract-source-manifest/2",
    entries: [...frozen, ...authority, ...visuals]
  },
  coverage: {
    summary: {
      securityCoverage: {
        versionCasDictionaryFields: 47,
        technicalOperationEntries: 8,
        internalOperationEntries: 2,
        canonicalHttpMutationUniqueEndpoints: 59,
        coverageMutationUniqueEndpoints: 59,
        canonicalHttpMutationSetEqualityMissing: 0,
        canonicalHttpMutationSetEqualityOrphan: 0,
        internalOperationGaps: 0
      }
    },
    actions: [{ actionId: "BATCH.RECOVER_FROM_ACCOUNT", stableErrors: ["receipt_recovery_unavailable"] }]
  },
  canonicalText: "统一`receipt_recovery_unavailable`",
  bookRegistry: { actions: Array.from({ length: 20 }, (_, index) => ({ id: `BOOK_${index}` })) },
  bookCoverage: {
    actions: Array.from({ length: 20 }, (_, index) => ({
      actionId: `BOOK_${index}`,
      method: index < 5 ? "GET" : "POST",
      replayClass: index < 5 ? "not_applicable" : "ordinary_dto"
    })),
    versionCasDictionary: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`table_${index}.version`, "required"])),
    internalOperationCoverage: [
      { operationId: "QUESTION_PROCESSOR", endpoint: "internal:book-lab-question-processor", replayClass: "completed_state" },
      { operationId: "BOOK_RENDER_PROCESSOR", endpoint: "internal:book-lab-render-processor", replayClass: "completed_state" }
    ]
  },
  bookState: {
    machines: Object.fromEntries(
      ["memoryInterview", "bookAuthorization", "bookDraft", "bookVersion", "renderArtifact"]
        .map((name) => [name, {}])
    )
  },
  visualSums: Object.fromEntries(
    Object.entries(visualHashes).map(([relativePath, hash]) => [relativePath.split("/").at(-1), hash])
  ),
  effectiveRevisionCommit: effectiveCommit,
  effectiveRevisionLines: 1,
  effectiveRevisionManifest: manifestBytes,
  effectiveRevisionParents: [effectiveCommit, maintenanceParent],
  track8Presence: [
    { id: "8A", branchExists: true, worktreeExists: true },
    { id: "8B", branchExists: true, worktreeExists: true },
    { id: "8C", branchExists: false, worktreeExists: false }
  ],
  bootstrapCommit: historicalCommit,
  bootstrapTree: historicalTree,
  historicalBootstrapBusinessRootFiles: [],
  historicalScopes: {
    formal_web: [130, digest("formal_web")],
    recovered_source: [174, digest("recovered_source")],
    recovered_backend: [13, digest("recovered_backend")]
  },
  inventorySummary: { included: 357, excluded: 178, total: 535 }
};

function rejects(code, change) {
  const nextManifest = structuredClone(manifest);
  const nextFacts = structuredClone(facts);
  change(nextManifest, nextFacts);
  let thrown;
  try {
    validate(nextManifest, nextFacts);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.message, code);
}

test("entirely in-memory v2 candidate validates the exact 16-track matrix", () => {
  assert.deepEqual(trackTuples.map(([id]) => id), tracks.map(({ id }) => id));
  assert.equal(validate(manifest, facts).status, "FREEZE_MANIFEST_OK");
});

test("registered non-blocking P2 debt does not block the effective freeze", () => {
  const value = structuredClone(manifest);
  value.acceptance.unresolvedSeverity = {
    p0: 0,
    p1: 0,
    p2: 1,
    postLocalDebt: [{
      id: "POST-LOCAL-001",
      summary: "Track 0L historical section wording cleanup",
      classification: "non_blocking_governance_or_quality",
      disposition: "post_local_operable",
      doesNotAffect: ["authorization", "privacy", "data_consistency", "real_integration_seam"]
    }]
  };
  assert.equal(validate(value, structuredClone(facts)).status, "FREEZE_MANIFEST_OK");
  value.acceptance.unresolvedSeverity.p2 = 2;
  assert.throws(() => validate(value, structuredClone(facts)), /FREEZE_REVISION_ACCEPTANCE/);
});

test("illegal cross-track ownership overlap fails closed", () => {
  rejects("FREEZE_WRITE_OVERLAP", (value) => {
    value.tracks.find(({ id }) => id === "8A").writePaths.push("apps/web/**");
  });
});

test("completion gates cannot be weakened or widened", () => {
  rejects("FREEZE_COMPLETION_GATES", (value) => {
    value.completionGates.coreLocalOperable.affectsOverall = true;
  });
  rejects("FREEZE_COMPLETION_GATES", (value) => {
    value.completionGates.bookLabMve.bypass = true;
  });
});

test("registered Track 8A/8B must exist while Track 8C remains absent", () => {
  rejects("FREEZE_TRACK8_REGISTRATION", (_value, state) => {
    state.track8Presence[0].branchExists = false;
  });
  rejects("FREEZE_TRACK8_REGISTRATION", (_value, state) => {
    state.track8Presence[2].worktreeExists = true;
  });
});

test("effective revision must have the exact non-merge parent", () => {
  rejects("FREEZE_EFFECTIVE_PARENT", (_value, state) => {
    state.effectiveRevisionParents[1] = "0".repeat(40);
  });
  rejects("FREEZE_EFFECTIVE_PARENT", (_value, state) => {
    state.effectiveRevisionParents.push("1".repeat(40));
  });
});

test("acceptance receipts are bound to their authoritative copy hashes", () => {
  rejects("FREEZE_ACCEPTANCE_RECEIPT", (value) => {
    value.acceptance.revision["Claude-Desktop-C3"].sha256 = digest("not-the-authoritative-copy");
  });
});

test("anchor paths and hashes cannot drift", () => {
  rejects("FREEZE_ANCHOR_PATH", (value) => {
    value.rootLockfile.relativePath = "nested/package-lock.json";
  });
  rejects("FREEZE_ANCHOR_HASH", (value) => {
    value.sourceManifests.safeImportInventory.sha256 = digest("wrong-safe-import-inventory");
  });
});
