import assert from "node:assert/strict";
import test from "node:test";

const { collectFacts, validate } = await import("./check-freeze-manifest.mjs");

const baseline = await collectFacts(process.env.UNSEEN_FREEZE_TEST_ROOT);
baseline.facts.effectiveRevisionManifest = baseline.facts.manifestBytes;

function rejects(code, change) {
  const manifest = structuredClone(baseline.manifest);
  const facts = structuredClone(baseline.facts);
  change(manifest, facts);
  assert.throws(() => validate(manifest, facts), new RegExp(code));
}

test("current v2 candidate validates", () => {
  assert.equal(validate(baseline.manifest, baseline.facts).status, "FREEZE_MANIFEST_OK");
});

test("revision acceptance cannot borrow historical PASS", () => {
  rejects("FREEZE_TOP_LEVEL_SHAPE", (manifest) => { manifest.selfReference = { token: "SELF" }; });
  rejects("FREEZE_REVISION_ACCEPTANCE", (manifest) => { manifest.acceptance.revision["Codex-C2"].status = "PENDING"; });
  rejects("FREEZE_REVISION_ACCEPTANCE", (manifest) => { manifest.acceptance.revision["Claude-Desktop-C3"].p1 = 1; });
  rejects("FREEZE_REVISION_GATE", (manifest) => { manifest.acceptance.revision.authoritativeCopy = "contracts/source/C3-CLAUDE-DESKTOP-ACCEPTANCE.md"; });
});

test("historical bootstrap and effective revision are distinct", () => {
  rejects("FREEZE_HISTORICAL_BOOTSTRAP", (manifest) => { manifest.historicalBootstrap.commit = "SELF"; });
  rejects("FREEZE_HISTORICAL_BOOTSTRAP", (manifest) => { manifest.historicalBootstrap.commit = "95f5f78fa9a4f41c6188472d47a7601dfcf21d0b"; });
  rejects("FREEZE_EFFECTIVE_REVISION", (manifest) => { manifest.effectiveContractRevision.parentCommit = "0".repeat(40); });
  rejects("FREEZE_EFFECTIVE_REVISION_GIT", (_manifest, facts) => { facts.effectiveRevisionLines = 2; });
});

test("source, generated and metric partitions fail closed", () => {
  rejects("FREEZE_CONTRACT_EVIDENCE_COUNT", (manifest) => { manifest.frozenContracts.pop(); });
  rejects("FREEZE_SOURCE_MANIFEST", (manifest) => { manifest.sourceManifests.contractSourceManifest.fileCount = 31; });
  rejects("FREEZE_SOURCE_MANIFEST", (manifest) => { manifest.sourceManifests.contractSourceManifest.authorityEvidenceCount = 11; });
  rejects("FREEZE_GENERATED_COUNT", (_manifest, facts) => { facts.generatedFiles.pop(); });
  rejects("FREEZE_CORE_METRICS", (manifest) => { manifest.contractMetrics.core.technicalOperationEntries = 6; });
  rejects("FREEZE_BOOK_METRICS", (manifest) => { manifest.contractMetrics.bookLab.stateMachineEntries = 3; });
  rejects("FREEZE_AGGREGATE_METRICS", (manifest) => { manifest.contractMetrics.aggregate.internalOperationEntries = 2; });
  rejects("FREEZE_BOOK_CONTRACT_SHAPE", (_manifest, facts) => { delete facts.bookState.machines.renderArtifact; });
});

test("track matrix and write isolation fail closed", () => {
  rejects("FREEZE_TRACKS", (manifest) => { manifest.tracks.pop(); });
  rejects("FREEZE_TRACK_HISTORICAL_BASE", (manifest) => { manifest.tracks[1].base.commit = "SELF"; });
  rejects("FREEZE_TRACK8_BASE", (manifest) => { manifest.tracks[13].base.requiredGate = "fixed_core_rc"; });
  rejects("FREEZE_TRACK_REVISION", (manifest) => { manifest.tracks[2].requiredEffectiveRevision = "optional"; });
  rejects("FREEZE_WRITE_PATH", (manifest) => { manifest.tracks[2].writePaths = ["apps/web/** excluding viewer"]; });
  rejects("FREEZE_WRITE_OVERLAP", (manifest) => { manifest.tracks[13].writePaths.push("apps/web/**"); });
  rejects("FREEZE_TRACK_POLICY", (manifest) => { manifest.tracks[1].startGate = "anything"; });
  rejects("FREEZE_TRACK_POLICY", (manifest) => { manifest.tracks[13].readOnlyDependencies = []; });
  rejects("FREEZE_WRITE_OVERLAP", (manifest) => { manifest.tracks[13].conditionalWritePaths = [{ path: "apps/web/**", condition: "all_other_writers_stopped" }]; });
});

test("completion gates cannot be weakened or let local-operable imply release", () => {
  rejects("FREEZE_COMPLETION_GATES", (manifest) => { manifest.completionGates.coreR0.goNoGoOwner = "anyone"; });
  rejects("FREEZE_COMPLETION_GATES", (manifest) => { manifest.completionGates.bookLabMve.passDefinition = "x"; });
  rejects("FREEZE_COMPLETION_GATES", (manifest) => { manifest.completionGates.coreLocalOperable.affectsOverall = true; });
  rejects("FREEZE_COMPLETION_GATES", (manifest) => { manifest.completionGates.overall.expression = "coreLocalOperable == PASS"; });
});
