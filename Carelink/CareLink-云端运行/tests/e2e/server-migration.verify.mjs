import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOperationLock, operationLockPath } from "../../infra/integration/operation-lock.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = path.join(repositoryRoot, "infra/integration/local-staging.mjs");
const snapshotTool = path.join(repositoryRoot, "infra/integration/staging-snapshot.mjs");
const serverMode = process.env.UNSEEN_MIGRATION_VERIFY_MODE !== "local";

function isolatedEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("UNSEEN_") && !(name in extra)) delete environment[name];
  }
  return environment;
}

function failedLaunch(extra, expected, executable = launcher, cwd = repositoryRoot) {
  const result = spawnSync(process.execPath, [executable], {
    cwd,
    env: isolatedEnvironment(extra),
    encoding: "utf8",
    timeout: 10_000
  });
  assert.notEqual(result.status, 0, `launcher unexpectedly passed: ${expected}`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`server_migration_ready_timeout:${stderr}`));
    }, 30_000);
    const inspect = () => {
      for (const line of stdout.split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.status === "LOCAL_STAGING_READY") {
            clearTimeout(timeout);
            resolve({ value, stderr });
            return;
          }
        } catch {}
      }
    };
    child.stdout.on("data", (bytes) => { stdout += bytes; inspect(); });
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server_migration_launcher_exited:${code}:${stderr}:${stdout}`));
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("server_migration_stop_timeout")), 10_000);
    timer.unref();
  });
  const result = await Promise.race([exited, timeout]);
  assert.equal(result.code, 0, `launcher stop failed: ${JSON.stringify(result)}`);
}

async function getLoopback(url, host) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname,
      headers: { host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

function runTool(command, environment) {
  const result = spawnSync(process.execPath, [snapshotTool, command], {
    cwd: repositoryRoot,
    env: isolatedEnvironment(environment),
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  const line = result.stdout.trim().split("\n").at(-1);
  return JSON.parse(line);
}

function failedTool(command, environment, expected) {
  const result = spawnSync(process.execPath, [snapshotTool, command], {
    cwd: repositoryRoot,
    env: isolatedEnvironment(environment),
    encoding: "utf8",
    timeout: 30_000
  });
  assert.notEqual(result.status, 0, `${command} unexpectedly passed`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}

async function inventory(root, directory = root, output = []) {
  for (const name of (await readdir(directory)).sort()) {
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    const relative = path.relative(root, filename).split(path.sep).join("/");
    assert.equal(info.isSymbolicLink(), false, `symlink: ${relative}`);
    if (info.isDirectory()) {
      output.push({ path: relative, type: "directory" });
      await inventory(root, filename, output);
    } else {
      assert.equal(info.isFile(), true, `special file: ${relative}`);
      const bytes = await readFile(filename);
      output.push({ path: relative, type: "file", bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  return output;
}

async function assertPrivate(root) {
  const rootInfo = await lstat(root);
  assert.equal(rootInfo.mode & 0o777, 0o700, `root permissions: ${root}`);
  const check = async (directory) => {
    for (const name of await readdir(directory)) {
      const filename = path.join(directory, name);
      const info = await lstat(filename);
      assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600, `permissions: ${filename}`);
      if (info.isDirectory()) await check(filename);
    }
  };
  await check(root);
}

failedLaunch({ UNSEEN_STAGING_MODE: "server_staging" }, /server_staging_environment_required/u);
failedLaunch({ UNSEEN_STAGING_MODE: "production" }, /production_runtime_not_implemented/u);

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "unseen-server-migration-"));
const dataRoot = path.join(temporaryRoot, "source", "core-data");
const evidenceRoot = path.join(temporaryRoot, "source", "runtime-evidence");
const bookOutputRoot = path.join(temporaryRoot, "source", "book-artifacts");
const backupRoot = path.join(temporaryRoot, "backups");
const exactBookWorktree = process.env.UNSEEN_BOOK_WORKTREE;
assert.ok(exactBookWorktree && path.isAbsolute(exactBookWorktree),
  "UNSEEN_BOOK_WORKTREE must name the clean detached Book input checkout");
const port = await freePort();
const publicOrigin = serverMode ? "https://staging.example.test" : `http://127.0.0.1:${port}`;
const launchEnvironment = {
  UNSEEN_STAGING_MODE: serverMode ? "server_staging" : "local",
  UNSEEN_STAGING_HOST: "127.0.0.1",
  UNSEEN_STAGING_PORT: String(port),
  UNSEEN_STAGING_PUBLIC_ORIGIN: publicOrigin,
  UNSEEN_STAGING_EXPECT_REPOSITORY_STATE: serverMode ? "clean" : "allow_dirty",
  UNSEEN_STAGING_DATA_DIR: dataRoot,
  UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR: evidenceRoot,
  UNSEEN_BOOK_WORKTREE: exactBookWorktree,
  UNSEEN_BOOK_OUTPUT_DIR: bookOutputRoot,
  UNSEEN_STAGING_EXTERNAL_EXPOSURE_ACK: "access_controlled_tls_reverse_proxy",
  UNSEEN_STAGING_OTP_PROVIDER: "local_fixture_only",
  UNSEEN_STAGING_MEDIA_PROVIDER: "filesystem_fixture_only"
};
const child = spawn(process.execPath, [launcher], {
  cwd: repositoryRoot,
  env: isolatedEnvironment(launchEnvironment),
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  const ready = (await waitForReady(child)).value;
  assert.equal(ready.mode, serverMode ? "server_staging" : "local");
  const listenOrigin = ready.listenOrigin ?? ready.origin;
  const health = await getLoopback(`${listenOrigin}/__staging/healthz`, new URL(ready.origin).host);
  assert.equal(health.status, 200);
  assert.equal(health.headers["x-unseen-staging"], "true");
  const value = JSON.parse(health.body);
  assert.equal(value.status, "ok");
  assert.equal(value.listener, "loopback_only");
  assert.equal(value.deployment, serverMode);
  assert.equal(value.externalExposure, serverMode);
  assert.equal(value.productionReady, false);
  assert.deepEqual(value.providers, { otp: "local_fixture_only", media: "filesystem_fixture_only" });
  const liveLock = operationLockPath(dataRoot);
  const [liveLockInfo, liveOwnerInfo] = await Promise.all([
    lstat(liveLock), lstat(path.join(liveLock, "owner.json"))
  ]);
  assert.equal(liveLockInfo.mode & 0o777, 0o700);
  assert.equal(liveOwnerInfo.mode & 0o777, 0o600);
  await rm(path.join(evidenceRoot, "RUNNING.json"));
  failedTool("backup", { ...launchEnvironment, UNSEEN_STAGING_BACKUP_DIR: backupRoot,
    UNSEEN_STAGING_SNAPSHOT_ID: "must-not-run-live" }, /staging_operation_locked/u);
} finally {
  await stop(child);
}

await assert.rejects(lstat(operationLockPath(dataRoot)), { code: "ENOENT" });

const snapshotLock = await acquireOperationLock(dataRoot, "backup");
try {
  failedLaunch(launchEnvironment, /staging_operation_locked/u);
} finally {
  await snapshotLock.release();
}

const tamperedLock = await acquireOperationLock(dataRoot, "tamper-test");
const tamperedOwner = JSON.parse(await readFile(tamperedLock.tokenPath, "utf8"));
await writeFile(tamperedLock.tokenPath, `${JSON.stringify({ ...tamperedOwner, token: "not-the-owner" })}\n`,
  { mode: 0o600 });
await assert.rejects(tamperedLock.release(), /staging_operation_lock_ownership_mismatch/u);
const tamperedAuditPath = `${tamperedLock.lockPath}.recovered-tamper-test`;
await rename(tamperedLock.lockPath, tamperedAuditPath);
await rm(tamperedAuditPath, { recursive: true });

const staleLock = await acquireOperationLock(dataRoot, "crashed-launcher-test");
const staleOwner = JSON.parse(await readFile(staleLock.tokenPath, "utf8"));
await writeFile(staleLock.tokenPath, `${JSON.stringify({ ...staleOwner, pid: 2147483647 })}\n`, { mode: 0o600 });
failedLaunch(launchEnvironment, /staging_operation_locked/u);
failedTool("backup", { ...launchEnvironment, UNSEEN_STAGING_BACKUP_DIR: backupRoot,
  UNSEEN_STAGING_SNAPSHOT_ID: "must-not-clear-stale" }, /staging_operation_locked/u);
const staleAuditPath = `${staleLock.lockPath}.recovered-stale-test`;
await rename(staleLock.lockPath, staleAuditPath);
await rm(staleAuditPath, { recursive: true });

const wrongCoreRoot = path.join(temporaryRoot, "wrong-clean-core");
execFileSync("git", ["clone", "--quiet", "--no-hardlinks", repositoryRoot, wrongCoreRoot]);
await cp(path.join(repositoryRoot, "infra/integration/local-staging.mjs"),
  path.join(wrongCoreRoot, "infra/integration/local-staging.mjs"));
await cp(path.join(repositoryRoot, "infra/integration/operation-lock.mjs"),
  path.join(wrongCoreRoot, "infra/integration/operation-lock.mjs"));
await writeFile(path.join(wrongCoreRoot, "apps/web/.stage5-provenance-negative"), "wrong clean product tree\n");
execFileSync("git", ["add", "infra/integration/local-staging.mjs", "infra/integration/operation-lock.mjs",
  "apps/web/.stage5-provenance-negative"], { cwd: wrongCoreRoot });
execFileSync("git", ["-c", "user.name=UNSEEN verifier", "-c", "user.email=verifier@invalid.test", "commit",
  "--quiet", "-m", "test: wrong clean product subtree"], { cwd: wrongCoreRoot });
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wrongCoreRoot, encoding: "utf8" }), "");
failedLaunch({ ...launchEnvironment, UNSEEN_STAGING_DATA_DIR: path.join(temporaryRoot, "wrong", "data"),
  UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR: path.join(temporaryRoot, "wrong", "evidence"),
  UNSEEN_BOOK_OUTPUT_DIR: path.join(temporaryRoot, "wrong", "book") },
/local_staging_core_product_pin_mismatch/u, path.join(wrongCoreRoot, "infra/integration/local-staging.mjs"), wrongCoreRoot);
await assert.rejects(lstat(path.join(temporaryRoot, "wrong", "data")), { code: "ENOENT" });

try {
  await mkdir(path.join(dataRoot, "media", "verification"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dataRoot, "media", "verification", "bytes.bin"), Buffer.from([0, 1, 2, 254, 255]),
    { mode: 0o600 });
  await mkdir(bookOutputRoot, { recursive: true, mode: 0o700 });
  await chmod(bookOutputRoot, 0o700);
  await writeFile(path.join(bookOutputRoot, "verification.html"), "<!doctype html><title>snapshot</title>\n",
    { mode: 0o600 });
  const snapshotEnvironment = {
    ...launchEnvironment,
    UNSEEN_STAGING_EXPECT_REPOSITORY_STATE: serverMode ? "clean" : "allow_dirty",
    UNSEEN_STAGING_BACKUP_DIR: backupRoot,
    UNSEEN_STAGING_SNAPSHOT_ID: "verification-snapshot"
  };
  const symlinkPath = path.join(dataRoot, "media", "verification", "forbidden-link");
  await symlink(path.join(dataRoot, "media", "verification", "bytes.bin"), symlinkPath);
  failedTool("backup", snapshotEnvironment, /staging_snapshot_symlink_rejected/u);
  await rm(symlinkPath);
  const backup = runTool("backup", snapshotEnvironment);
  assert.equal(backup.status, "STAGING_SNAPSHOT_CREATED");
  const snapshotRoot = backup.snapshotRoot;
  assert.equal(runTool("verify", { ...snapshotEnvironment,
    UNSEEN_STAGING_SNAPSHOT_DIR: snapshotRoot }).status, "STAGING_SNAPSHOT_VERIFIED");
  const tamperedSnapshotRoot = path.join(backupRoot, "tampered-copy");
  await cp(snapshotRoot, tamperedSnapshotRoot, { recursive: true, preserveTimestamps: true });
  await writeFile(path.join(tamperedSnapshotRoot, "data", "media", "verification", "bytes.bin"),
    Buffer.from([9, 8, 7]), { mode: 0o600 });
  failedTool("verify", { ...snapshotEnvironment, UNSEEN_STAGING_SNAPSHOT_DIR: tamperedSnapshotRoot },
    /staging_snapshot_byte_mismatch:data/u);
  const unsafeModeSnapshotRoot = path.join(backupRoot, "unsafe-mode-copy");
  await cp(snapshotRoot, unsafeModeSnapshotRoot, { recursive: true, preserveTimestamps: true });
  await chmod(path.join(unsafeModeSnapshotRoot, "data", "media", "verification", "bytes.bin"), 0o644);
  failedTool("verify", { ...snapshotEnvironment, UNSEEN_STAGING_SNAPSHOT_DIR: unsafeModeSnapshotRoot },
    /staging_snapshot_permissions_invalid/u);

  const restoredDataRoot = path.join(temporaryRoot, "restored", "core-data");
  const restoredBookRoot = path.join(temporaryRoot, "restored", "book-artifacts");
  const restoreEnvironment = {
    ...snapshotEnvironment,
    UNSEEN_STAGING_DATA_DIR: restoredDataRoot,
    UNSEEN_BOOK_OUTPUT_DIR: restoredBookRoot,
    UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR: path.join(temporaryRoot, "restored", "runtime-evidence"),
    UNSEEN_STAGING_SNAPSHOT_DIR: snapshotRoot
  };
  assert.equal(runTool("restore", restoreEnvironment).status, "STAGING_SNAPSHOT_RESTORED");
  assert.deepEqual(await inventory(restoredDataRoot), await inventory(dataRoot));
  assert.deepEqual(await inventory(restoredBookRoot), await inventory(bookOutputRoot));
  await Promise.all([assertPrivate(dataRoot), assertPrivate(evidenceRoot), assertPrivate(bookOutputRoot),
    assertPrivate(snapshotRoot), assertPrivate(restoredDataRoot), assertPrivate(restoredBookRoot)]);
  process.stdout.write(`${JSON.stringify({ schema: "unseen-server-migration-verification/1", status: "PASS",
    mode: serverMode ? "server_staging" : "local_precommit", missingEnvFailClosed: true,
    productionFailClosed: true, coreProductPinByteExact: true, wrongCleanCoreCommitRejected: true,
    health: "ok", permissions: "0700/0600", markerDeletionCannotBypassLock: true,
    launcherSnapshotMutualExclusion: true, staleLockFailClosed: true, lockOwnershipTamperFailClosed: true,
    symlinkRejected: true, snapshotTamperRejected: true, unsafePermissionsRejected: true,
    backupRestoreByteEquality: true,
    externalNetworkRequests: 0 })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
