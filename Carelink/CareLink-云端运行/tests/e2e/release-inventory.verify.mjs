import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, chmod, copyFile, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tool = path.join(repositoryRoot, "ops/release/inventory/inventory.mjs");
const candidateCommit = "1cc1615cd9c05ed515711dcd50f5aff62b4238db";
const temporary = await mkdtemp(path.join(tmpdir(), "unseen-release-inventory-test-"));
const networkDeniedProfile = "(version 1)(allow default)(deny network*)";

function run(args, options = {}) {
  return spawnSync(process.execPath, [tool, ...args], {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024
  });
}

async function mutatedInventory(source, label, mutate) {
  const value = JSON.parse(await readFile(source, "utf8"));
  mutate(value);
  const target = path.join(temporary, `${label}.json`);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return target;
}

function rejected(target, expected) {
  const result = run(["verify", "--inventory", target]);
  assert.notEqual(result.status, 0, `${target} unexpectedly passed`);
  assert.match(result.stderr, expected, `${target}: ${result.stderr}`);
}

try {
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }), "",
    "release inventory verification requires a clean checkpoint");
  const inventory = path.join(temporary, "RELEASE-INVENTORY.json");
  const generated = spawnSync("/usr/bin/sandbox-exec", ["-p", networkDeniedProfile, process.execPath, tool, "generate",
    "--candidate", candidateCommit, "--output", inventory], { cwd: repositoryRoot, encoding: "utf8", timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr);
  const generationReceipt = JSON.parse(generated.stdout);
  assert.equal(generationReceipt.status, "PASS");
  assert.equal(generationReceipt.releaseClaim, "NO_GO");
  const verified = run(["verify", "--inventory", inventory]);
  assert.equal(verified.status, 0, verified.stderr);
  const verificationReceipt = JSON.parse(verified.stdout);
  assert.equal(verificationReceipt.status, "PASS");
  assert.equal(verificationReceipt.productionReady, false);
  assert.equal(verificationReceipt.externalNetworkRequests, 0);

  const value = JSON.parse(await readFile(inventory, "utf8"));
  assert.deepEqual(value.candidate, {
    commit: candidateCommit,
    sourceLocator: `git:${candidateCommit}^{tree}`,
    tree: "b222397d2bc12ce0e2e394564720b073dd63301f"
  });
  assert.equal(value.releaseClaim, "NO_GO");
  assert.equal(value.productionReady, false);
  assert.equal(value.approvalState, "needs_review");
  assert.equal(value.discovery.trackedFiles, 863);
  assert.equal(value.discovery.packageManifests, 12);
  assert.equal(value.discovery.workspacePackageManifests, 9);
  assert.equal(value.discovery.lockfiles, 1);
  assert.equal(value.discovery.vendoredComponents, 2);
  assert.equal(value.discovery.assets, 221);
  assert.equal(value.discovery.bundledFonts, 0);
  assert.equal(value.discovery.trackedSymlinks, 0);
  assert.equal(value.discovery.externalNetworkRequests, 0);
  assert.ok(value.discovery.runtimeLibrariesHashed >= 30);
  assert.equal(value.discovery.runtimeLinksNeedsDeploymentResolution, 0);
  assert.ok(value.discovery.runtimeSystemLinksNotAddressable > 0);
  assert.deepEqual(value.vendoredComponents.map((entry) => entry.name), ["dijkstrajs", "qrcode"]);
  assert.ok(value.assets.every((entry) => entry.rightsReviewState === "needs_review" || entry.rightsReviewState === "not_applicable"));
  assert.ok(value.systemFonts.length > 0 && value.systemFonts.every((entry) => entry.exactResolvedPath === null &&
    entry.reviewState === "needs_review"));
  const binaryIds = value.runtimeBinaries.map((entry) => entry.id);
  assert.deepEqual(binaryIds, ["chromium", "chromium_framework", "ffmpeg", "ffprobe", "node"]);
  assert.ok(value.runtimeBinaries.every((entry) => path.isAbsolute(entry.realPath) && entry.sha256.length === 64 &&
    entry.versionOutput.length > 0 && entry.reviewState === "needs_review"));
  assert.equal(value.runtimeBinaries.find((entry) => entry.id === "ffmpeg").gplEnabled, true);
  assert.ok(value.runtimeBinaries.find((entry) => entry.id === "ffmpeg").buildFlags.includes("--enable-gpl"));
  assert.ok(value.runtimeLibraries.some((entry) => entry.resolutionState === "file_hashed" && entry.sha256.length === 64));
  assert.ok(value.runtimeLibraries.some((entry) => entry.resolutionState === "system_managed_not_addressable" && entry.sha256 === null));

  rejected(await mutatedInventory(inventory, "missing-file", (copy) => { copy.assets.shift(); }),
    /inventory_candidate_or_runtime_drift_rejected/u);
  rejected(await mutatedInventory(inventory, "extra-file", (copy) => {
    copy.assets.push({ ...copy.assets.at(-1), componentId: "asset:extra.png", path: "extra.png" });
  }), /inventory_candidate_or_runtime_drift_rejected/u);
  rejected(await mutatedInventory(inventory, "asset-hash-drift", (copy) => { copy.assets[0].sha256 = "00".repeat(32); }),
    /inventory_candidate_or_runtime_drift_rejected/u);
  rejected(await mutatedInventory(inventory, "manifest-drift", (copy) => { copy.packageManifests[0].sha256 = "00".repeat(32); }),
    /inventory_candidate_or_runtime_drift_rejected/u);
  rejected(await mutatedInventory(inventory, "lock-drift", (copy) => { copy.lockfiles[0].sha256 = "00".repeat(32); }),
    /inventory_candidate_or_runtime_drift_rejected/u);
  rejected(await mutatedInventory(inventory, "duplicate-component", (copy) => { copy.assets.push({ ...copy.assets[0] }); }),
    /inventory_duplicate_component_rejected/u);
  rejected(await mutatedInventory(inventory, "unknown-review", (copy) => { copy.reviewItems[0].state = "unknown"; }),
    /inventory_placeholder_or_unknown_rejected/u);
  rejected(await mutatedInventory(inventory, "false-go", (copy) => {
    copy.releaseClaim = "GO"; copy.productionReady = true; copy.approvalState = "reviewed";
  }), /inventory_unreviewed_release_claim_rejected/u);

  const inventoryLink = path.join(temporary, "inventory-link.json");
  await symlink(inventory, inventoryLink);
  rejected(inventoryLink, /inventory_file_symlink_rejected/u);

  const copiedProbe = path.join(temporary, "ffprobe-copy");
  await copyFile(value.runtimeBinaries.find((entry) => entry.id === "ffprobe").realPath, copiedProbe);
  await chmod(copiedProbe, 0o700);
  const replacementInventory = path.join(temporary, "replacement-inventory.json");
  const replacementEnv = { ...process.env, UNSEEN_INVENTORY_FFPROBE_PATH: copiedProbe };
  const replacementBuilt = run(["generate", "--candidate", candidateCommit, "--output", replacementInventory],
    { env: replacementEnv });
  assert.equal(replacementBuilt.status, 0, replacementBuilt.stderr);
  await appendFile(copiedProbe, "replacement-byte", { mode: 0o700 });
  const replacementRejected = run(["verify", "--inventory", replacementInventory], { env: replacementEnv });
  assert.notEqual(replacementRejected.status, 0);
  assert.match(replacementRejected.stderr, /inventory_candidate_or_runtime_drift_rejected/u);

  const freshClone = path.join(temporary, "fresh-clone");
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", repositoryRoot, freshClone]);
  const inventoryCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "--quiet", "--detach", inventoryCommit], { cwd: freshClone });
  const freshInventory = path.join(temporary, "fresh-inventory.json");
  const freshTool = path.join(freshClone, "ops/release/inventory/inventory.mjs");
  const freshBuilt = spawnSync(process.execPath, [freshTool, "generate", "--candidate", candidateCommit, "--output", freshInventory],
    { cwd: freshClone, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(freshBuilt.status, 0, freshBuilt.stderr);
  assert.equal(await readFile(freshInventory, "utf8"), await readFile(inventory, "utf8"));
  assert.equal((await lstat(inventory)).mode & 0o777, 0o600);

  process.stdout.write(`${JSON.stringify({ schema: "unseen-release-inventory-e2e/1", status: "PASS", candidateCommit,
    currentCandidateCoverage: true,
    inventorySha256: generationReceipt.inventorySha256, releaseClaim: "NO_GO", productionReady: false,
    trackedFiles: value.discovery.trackedFiles, workspacePackageManifests: value.discovery.workspacePackageManifests,
    assets: value.discovery.assets, bundledFonts: value.discovery.bundledFonts,
    runtimeBinaries: value.discovery.runtimeBinaries, runtimeLibraries: value.discovery.runtimeLibraries,
    runtimeLibrariesHashed: value.discovery.runtimeLibrariesHashed,
    negativeCases: 10, symlinkRejected: true, binaryReplacementRejected: true,
    freshCloneReproducible: true, networkDeniedGeneration: true, externalNetworkRequests: 0 })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
