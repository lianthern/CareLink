import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOperationLock } from "./operation-lock.mjs";

process.umask(0o077);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const command = process.argv[2];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function requiredAbsolute(name) {
  const value = process.env[name];
  invariant(value && path.isAbsolute(value), `staging_snapshot_absolute_path_required:${name}`);
  return path.resolve(value);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function exists(filename) {
  try { await lstat(filename); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertStopped(runtimeEvidenceRoot) {
  const runningPath = path.join(runtimeEvidenceRoot, "RUNNING.json");
  let marker;
  try { marker = JSON.parse(await readFile(runningPath, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("staging_snapshot_running_marker_invalid", { cause: error });
  }
  invariant(marker?.schema === "unseen-local-staging-running/1" &&
    Number.isSafeInteger(marker.pid) && marker.pid > 0, "staging_snapshot_running_marker_invalid");
  try {
    process.kill(marker.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(`staging_snapshot_service_running:${marker.pid}`);
}

function gitState(cwd, policy) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
  if (policy === "clean" && status) throw new Error("staging_snapshot_repository_dirty");
  return { commit, clean: !status };
}

async function walk(root, directory = root, entries = []) {
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    invariant(!info.isSymbolicLink(), "staging_snapshot_symlink_rejected");
    const relative = path.relative(root, filename).split(path.sep).join("/");
    if (info.isDirectory()) {
      entries.push({ path: relative, type: "directory", mode: info.mode & 0o777 });
      await walk(root, filename, entries);
    } else {
      invariant(info.isFile(), "staging_snapshot_special_file_rejected");
      const bytes = await readFile(filename);
      entries.push({ path: relative, type: "file", bytes: bytes.length,
        sha256: sha256(bytes), mode: info.mode & 0o777 });
    }
  }
  return entries;
}

async function normalizePrivate(root) {
  await chmod(root, 0o700);
  const entries = await walk(root);
  for (const entry of entries) {
    await chmod(path.join(root, ...entry.path.split("/")), entry.type === "directory" ? 0o700 : 0o600);
  }
}

async function privateInventory(root) {
  const rootInfo = await lstat(root);
  invariant(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && (rootInfo.mode & 0o777) === 0o700,
    "staging_snapshot_root_permissions_invalid");
  const entries = await walk(root);
  for (const entry of entries) {
    invariant(entry.mode === (entry.type === "directory" ? 0o700 : 0o600),
      `staging_snapshot_permissions_invalid:${entry.path}`);
  }
  return entries;
}

async function quickCheck(databasePath) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "unseen-sqlite-check-"));
  try {
    const temporaryDatabase = path.join(temporaryRoot, "unseen.sqlite");
    await cp(databasePath, temporaryDatabase);
    if (await exists(`${databasePath}-wal`)) await cp(`${databasePath}-wal`, `${temporaryDatabase}-wal`);
    const database = new DatabaseSync(temporaryDatabase, { readOnly: true });
    try {
      const result = database.prepare("PRAGMA quick_check").all();
      invariant(result.length === 1 && Object.values(result[0])[0] === "ok", "staging_snapshot_sqlite_invalid");
    } finally {
      database.close();
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function copyPrivate(source, target) {
  const info = await lstat(source);
  invariant(info.isDirectory() && !info.isSymbolicLink(), "staging_snapshot_source_invalid");
  await walk(source);
  await cp(source, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  await normalizePrivate(target);
}

function sameInventory(actual, expected, label) {
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `staging_snapshot_byte_mismatch:${label}`);
}

function readInputs(bookWorktree, policy) {
  invariant(["clean", "allow_dirty"].includes(policy), "staging_snapshot_repository_policy_invalid");
  const core = gitState(repositoryRoot, policy);
  const book = gitState(bookWorktree, "clean");
  return { coreCommit: core.commit, bookCommit: book.commit, repositoryClean: core.clean && book.clean };
}

async function verifySnapshot(snapshotRoot) {
  const manifest = JSON.parse(await readFile(path.join(snapshotRoot, "manifest.json"), "utf8"));
  invariant(manifest?.schema === "unseen-staging-snapshot/1", "staging_snapshot_manifest_invalid");
  const dataRoot = path.join(snapshotRoot, "data");
  await quickCheck(path.join(dataRoot, "unseen.sqlite"));
  sameInventory(await privateInventory(dataRoot), manifest.trees.data, "data");
  if (manifest.layout.book === "separate") {
    sameInventory(await privateInventory(path.join(snapshotRoot, "book")), manifest.trees.book, "book");
  } else {
    invariant(manifest.layout.book === "embedded" && manifest.layout.bookRelative,
      "staging_snapshot_book_layout_invalid");
  }
  return manifest;
}

const dataRoot = requiredAbsolute("UNSEEN_STAGING_DATA_DIR");
const bookOutputRoot = requiredAbsolute("UNSEEN_BOOK_OUTPUT_DIR");
const runtimeEvidenceRoot = requiredAbsolute("UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR");
const bookWorktree = requiredAbsolute("UNSEEN_BOOK_WORKTREE");
const repositoryPolicy = process.env.UNSEEN_STAGING_EXPECT_REPOSITORY_STATE ?? "clean";
const embeddedBook = isWithin(dataRoot, bookOutputRoot);
invariant(dataRoot !== bookOutputRoot && (embeddedBook || !isWithin(bookOutputRoot, dataRoot)),
  "staging_snapshot_data_book_overlap_invalid");
const operationLock = ["backup", "restore"].includes(command)
  ? await acquireOperationLock(dataRoot, command) : null;

try {
if (command === "backup") {
  const backupRoot = requiredAbsolute("UNSEEN_STAGING_BACKUP_DIR");
  invariant(backupRoot !== dataRoot && backupRoot !== bookOutputRoot &&
    !isWithin(dataRoot, backupRoot) && !isWithin(backupRoot, dataRoot) &&
    !isWithin(bookOutputRoot, backupRoot) && !isWithin(backupRoot, bookOutputRoot),
    "staging_snapshot_backup_overlap_invalid");
  await assertStopped(runtimeEvidenceRoot);
  const inputs = readInputs(bookWorktree, repositoryPolicy);
  const requestedId = process.env.UNSEEN_STAGING_SNAPSHOT_ID;
  const snapshotId = requestedId ??
    `snapshot-${new Date().toISOString().replaceAll(":", "-")}-${inputs.coreCommit.slice(0, 12)}`;
  invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(snapshotId), "staging_snapshot_id_invalid");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupInfo = await lstat(backupRoot);
  invariant(backupInfo.isDirectory() && !backupInfo.isSymbolicLink() && (backupInfo.mode & 0o777) === 0o700,
    "staging_snapshot_backup_root_permissions_invalid");
  const finalRoot = path.join(backupRoot, snapshotId);
  invariant(!(await exists(finalRoot)), "staging_snapshot_exists");
  const temporaryRoot = path.join(backupRoot, `.${snapshotId}.${process.pid}.tmp`);
  invariant(!(await exists(temporaryRoot)), "staging_snapshot_temporary_exists");
  await mkdir(temporaryRoot, { mode: 0o700 });
  try {
    await copyPrivate(dataRoot, path.join(temporaryRoot, "data"));
    if (!embeddedBook) await copyPrivate(bookOutputRoot, path.join(temporaryRoot, "book"));
    await quickCheck(path.join(temporaryRoot, "data", "unseen.sqlite"));
    await normalizePrivate(temporaryRoot);
    const manifest = {
      schema: "unseen-staging-snapshot/1",
      snapshotId,
      createdAt: new Date().toISOString(),
      inputs,
      layout: embeddedBook
        ? { book: "embedded", bookRelative: path.relative(dataRoot, bookOutputRoot).split(path.sep).join("/") }
        : { book: "separate" },
      trees: {
        data: await privateInventory(path.join(temporaryRoot, "data")),
        ...(!embeddedBook ? { book: await privateInventory(path.join(temporaryRoot, "book")) } : {})
      }
    };
    await writeFile(path.join(temporaryRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryRoot, finalRoot);
    process.stdout.write(`${JSON.stringify({ status: "STAGING_SNAPSHOT_CREATED", snapshotId,
      snapshotRoot: finalRoot, inputs })}\n`);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
} else if (command === "verify") {
  const snapshotRoot = requiredAbsolute("UNSEEN_STAGING_SNAPSHOT_DIR");
  const manifest = await verifySnapshot(snapshotRoot);
  process.stdout.write(`${JSON.stringify({ status: "STAGING_SNAPSHOT_VERIFIED", snapshotId: manifest.snapshotId,
    inputs: manifest.inputs })}\n`);
} else if (command === "restore") {
  const snapshotRoot = requiredAbsolute("UNSEEN_STAGING_SNAPSHOT_DIR");
  await assertStopped(runtimeEvidenceRoot);
  const manifest = await verifySnapshot(snapshotRoot);
  const inputs = readInputs(bookWorktree, repositoryPolicy);
  invariant(inputs.coreCommit === manifest.inputs.coreCommit && inputs.bookCommit === manifest.inputs.bookCommit,
    "staging_snapshot_code_mismatch");
  invariant(!(await exists(dataRoot)), "staging_snapshot_restore_target_exists:data");
  if (manifest.layout.book === "embedded") {
    invariant(isWithin(dataRoot, bookOutputRoot) &&
      path.relative(dataRoot, bookOutputRoot).split(path.sep).join("/") === manifest.layout.bookRelative,
    "staging_snapshot_restore_book_layout_mismatch");
  } else {
    invariant(!embeddedBook && !(await exists(bookOutputRoot)), "staging_snapshot_restore_target_exists:book");
  }
  await mkdir(path.dirname(dataRoot), { recursive: true, mode: 0o700 });
  if (manifest.layout.book === "separate") {
    await mkdir(path.dirname(bookOutputRoot), { recursive: true, mode: 0o700 });
  }
  const temporaryData = `${dataRoot}.restore-${process.pid}.tmp`;
  const temporaryBook = `${bookOutputRoot}.restore-${process.pid}.tmp`;
  invariant(!(await exists(temporaryData)) && !(await exists(temporaryBook)),
    "staging_snapshot_restore_temporary_exists");
  let dataPublished = false;
  try {
    await copyPrivate(path.join(snapshotRoot, "data"), temporaryData);
    await quickCheck(path.join(temporaryData, "unseen.sqlite"));
    await normalizePrivate(temporaryData);
    sameInventory(await privateInventory(temporaryData), manifest.trees.data, "restored_data");
    if (manifest.layout.book === "separate") {
      await copyPrivate(path.join(snapshotRoot, "book"), temporaryBook);
      sameInventory(await privateInventory(temporaryBook), manifest.trees.book, "restored_book");
    }
    await rename(temporaryData, dataRoot);
    dataPublished = true;
    if (manifest.layout.book === "separate") await rename(temporaryBook, bookOutputRoot);
    process.stdout.write(`${JSON.stringify({ status: "STAGING_SNAPSHOT_RESTORED",
      snapshotId: manifest.snapshotId, inputs })}\n`);
  } catch (error) {
    if (dataPublished && !(await exists(temporaryData))) {
      try { await rename(dataRoot, temporaryData); dataPublished = false; } catch {}
    }
    if (!dataPublished) await rm(temporaryData, { recursive: true, force: true });
    await rm(temporaryBook, { recursive: true, force: true });
    throw error;
  }
} else {
  throw new Error("usage: node infra/integration/staging-snapshot.mjs backup|verify|restore");
}
} finally {
  if (operationLock) await operationLock.release();
}
