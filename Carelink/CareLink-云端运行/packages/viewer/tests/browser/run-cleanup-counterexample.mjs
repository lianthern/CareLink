import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceRoot = path.join(packageRoot, "tests/evidence");
const cleanupPath = path.join(evidenceRoot, "runner-timeout-cleanup.json");
const failurePath = path.join(evidenceRoot, "runner-timeout-browser-failure.json");
const outputPath = path.join(evidenceRoot, "runner-timeout-counterexample.json");
const runId = `timeout-${crypto.randomUUID()}`;
const ownedProfileToken = `unseen-viewer-browser-${runId}-`;
fs.rmSync(cleanupPath, { force: true });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function ownedProcessGroups() {
  const output = spawnSync("ps", ["-axo", "pgid=,command="], { encoding: "utf8" }).stdout || "";
  return new Set(output.split("\n")
    .filter((line) => line.includes(ownedProfileToken))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter(Number.isInteger));
}

async function terminateOwnedProcesses() {
  for (const group of ownedProcessGroups()) {
    try { process.kill(-group, "SIGTERM"); } catch {}
  }
  await delay(150);
  for (const group of ownedProcessGroups()) {
    try { process.kill(-group, "SIGKILL"); } catch {}
  }
  await delay(100);
}

const child = spawn(process.execPath, [path.join(packageRoot, "tests/browser/run-browser.mjs")], {
  cwd: path.resolve(packageRoot, "../.."),
  env: {
    ...process.env,
    UNSEEN_VIEWER_RUN_ID: runId,
    UNSEEN_VIEWER_TEST_TIMEOUT_STAGE: "initial-scene-ready",
    UNSEEN_VIEWER_STAGE_TIMEOUT_MS: "500",
    UNSEEN_VIEWER_GLOBAL_TIMEOUT_MS: "10000",
    UNSEEN_VIEWER_CLEANUP_REPORT: cleanupPath,
    UNSEEN_VIEWER_FAILURE_REPORT: failurePath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
let exit;
try {
  exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      reject(new Error("counterexample child exceeded 15s"));
    }, 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM"); } catch {}
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(3_000),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
  // This token is unique to this counterexample. It cannot match another Track.
  await terminateOwnedProcesses();
}

assert.notEqual(exit.code, 0, "the injected timeout must exit non-zero");
assert.ok(fs.existsSync(cleanupPath), "the failed runner must write cleanup evidence");
const cleanup = JSON.parse(fs.readFileSync(cleanupPath, "utf8"));
assert.equal(cleanup.failure.code, "RUNNER_TIMEOUT");
assert.equal(cleanup.serverClosed, true);
assert.equal(cleanup.chromeExited, true);
assert.equal(cleanup.profileRemoved, true);
assert.equal(cleanup.orphanProcessCount, 0);
const ps = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout || "";
const observedOwnedProcesses = ps.split("\n").filter((line) => line.includes(cleanup.profile)).length;
assert.equal(observedOwnedProcesses, 0);
assert.equal(ownedProcessGroups().size, 0);
assert.match(stdout, /STAGE_START initial-scene-ready/);
assert.match(stdout, /STAGE_FAIL initial-scene-ready/);
assert.match(stdout, /CLEANUP_PASS failure/);

const report = {
  schemaVersion: "unseen-viewer-runner-timeout-counterexample/1",
  runId,
  injectedStage: "initial-scene-ready",
  childExit: exit,
  expectedNonZero: true,
  failureCode: cleanup.failure.code,
  serverClosed: cleanup.serverClosed,
  chromeExited: cleanup.chromeExited,
  profileRemoved: cleanup.profileRemoved,
  orphanProcessCount: cleanup.orphanProcessCount,
  independentlyObservedOwnedProcesses: observedOwnedProcesses,
  requiredMarkersObserved: true,
  stdout,
  stderr,
};
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write("RUNNER_TIMEOUT_COUNTEREXAMPLE_PASS nonzero_exit cleanup_complete orphan_processes=0\n");
