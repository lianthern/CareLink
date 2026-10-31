import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { artifactPaths, validateArtifacts } from "./validate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function mutateFixture(relative, mutate, run) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "unseen-track6a-"));
  try {
    for (const artifact of Object.values(artifactPaths)) {
      const target = path.join(fixtureRoot, artifact);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(repoRoot, artifact)));
    }
    const target = path.join(fixtureRoot, relative);
    const value = JSON.parse(await readFile(target, "utf8"));
    mutate(value);
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
    await run(fixtureRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

test("current Track 6A artifacts validate only as a local NO_GO candidate", async () => {
  const result = await validateArtifacts({ repoRoot });
  assert.equal(result.status, "TRACK6A_LOCAL_ARTIFACT_VALID");
  assert.equal(result.claim, "artifact_integrity_only");
  assert.equal(result.releaseClaim, "NO_GO");
  assert.equal(result.counts.noticePurposes, 9);
  assert.equal(result.counts.fixedRcOrServerControlsNotExecuted, 29);
  assert.equal(result.counts.humanApprovalsRecorded, 0);
});

test("rejects an old or altered contract source hash", async () => {
  await mutateFixture(artifactPaths.notices, (value) => {
    value.sourceAnchors[0].sha256 = "0".repeat(64);
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /source anchor hash mismatch/);
  });
});

test("rejects a missing NoticePurpose", async () => {
  await mutateFixture(artifactPaths.notices, (value) => {
    value.notices = value.notices.filter((notice) => notice.purpose !== "memory_interview_l3");
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /notice purposes closed set mismatch/);
  });
});

for (const [caseName, mutate, expected] of [
  ["photo-upload v2 semantic drift", (notice) => { notice.copy.summary = "只上传照片。"; }, /notice copy hash mismatch/],
  ["photo-upload v2 version drift", (notice) => { notice.version = "photo_upload.zh-CN.3"; }, /photo upload notice version drift/],
  ["photo-upload v2 hash drift", (notice) => { notice.contentHash = "0".repeat(64); }, /notice copy hash mismatch/],
  ["photo-upload v2 false approval", (notice) => { notice.approvalState = "approved"; }, /notice falsely approved/]
]) {
  test(`rejects ${caseName}`, async () => {
    await mutateFixture(artifactPaths.notices, (value) => {
      mutate(value.notices.find((notice) => notice.purpose === "photo_upload"));
    }, async (fixtureRoot) => {
      await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), expected);
    });
  });
}

test("rejects a false closed evidence state", async () => {
  await mutateFixture(artifactPaths.operations, (value) => {
    value.alerts[0].executionState = "closed";
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /alert falsely closed/);
  });
});

test("rejects an approval packet that claims release readiness", async () => {
  await mutateFixture(artifactPaths.approvalPacket, (value) => {
    value.releaseClaim = "GO";
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /release claim must remain NO_GO/);
  });
});

test("rejects a fabricated human approval record", async () => {
  await mutateFixture(artifactPaths.approvalPacket, (value) => {
    value.recordedHumanApprovals.push({ decision: "approved" });
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /must not record human approvals/);
  });
});

for (const [id, weakenedTarget] of [
  ["authorized_api_availability", ">= 0%"],
  ["authorization_leakage", "unbounded"]
]) {
  test(`rejects a weakened ${id} target`, async () => {
    await mutateFixture(artifactPaths.operations, (value) => {
      value.serviceLevelTargets.find((target) => target.id === id).target = weakenedTarget;
    }, async (fixtureRoot) => {
      await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /SLI target drift/);
    });
  });
}

test("rejects an alert that links an unknown runbook", async () => {
  await mutateFixture(artifactPaths.operations, (value) => {
    value.alerts[0].runbookId = "unknown_runbook";
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /alert links unknown runbook/);
  });
});

test("rejects a runbook missing its forward-linked alert", async () => {
  await mutateFixture(artifactPaths.incidents, (value) => {
    const runbook = value.incidents.find((incident) => incident.id === "restore_mismatch");
    runbook.linkedAlertIds = runbook.linkedAlertIds.filter((id) => id !== "error_budget_burn");
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /incident alert linkage/);
  });
});

test("rejects a recognized secret-like value", async () => {
  await mutateFixture(artifactPaths.operations, (value) => {
    value.alerts[0].condition = ["sk", "A".repeat(32)].join("-");
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /recognized credential shape/);
  });
});

test("rejects an unresolved license register that no longer blocks release", async () => {
  await mutateFixture(artifactPaths.security, (value) => {
    value.licenseEvidenceMatrix.releaseBlocker = false;
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /unresolved license evidence must block release/);
  });
});

test("rejects a control omitted from evidence lanes", async () => {
  await mutateFixture(artifactPaths.security, (value) => {
    value.evidenceLanes.fixedRcOrServer.controlIds.pop();
  }, async (fixtureRoot) => {
    await assert.rejects(validateArtifacts({ repoRoot, artifactRoot: fixtureRoot }), /server control lane closed set mismatch/);
  });
});
