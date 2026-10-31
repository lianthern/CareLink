import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function operationLockPath(dataRoot) {
  return path.join(path.dirname(dataRoot), `.${path.basename(dataRoot)}.operation-lock`);
}

export async function acquireOperationLock(dataRoot, operation) {
  const resolvedDataRoot = path.resolve(dataRoot);
  const lockPath = operationLockPath(resolvedDataRoot);
  const tokenPath = path.join(lockPath, "owner.json");
  const token = randomUUID();
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`staging_operation_locked:${lockPath}`);
    throw error;
  }
  try {
    const owner = { schema: "unseen-staging-operation-lock/1", token, pid: process.pid,
      operation, dataRoot: resolvedDataRoot, acquiredAt: new Date().toISOString() };
    await writeFile(tokenPath, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(lockPath, 0o700);
    await chmod(tokenPath, 0o600);
    const [directoryInfo, tokenInfo] = await Promise.all([lstat(lockPath), lstat(tokenPath)]);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
      (directoryInfo.mode & 0o777) !== 0o700 || !tokenInfo.isFile() || tokenInfo.isSymbolicLink() ||
      (tokenInfo.mode & 0o777) !== 0o600) throw new Error("staging_operation_lock_permissions_invalid");
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  return { lockPath, tokenPath, token, async release() {
    let owner;
    try {
      const [directoryInfo, tokenInfo] = await Promise.all([lstat(lockPath), lstat(tokenPath)]);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
        (directoryInfo.mode & 0o777) !== 0o700 || !tokenInfo.isFile() || tokenInfo.isSymbolicLink() ||
        (tokenInfo.mode & 0o777) !== 0o600) throw new Error("lock_shape_invalid");
      owner = JSON.parse(await readFile(tokenPath, "utf8"));
    } catch (error) {
      throw new Error("staging_operation_lock_owner_invalid", { cause: error });
    }
    if (owner?.schema !== "unseen-staging-operation-lock/1" || owner.token !== token) {
      throw new Error("staging_operation_lock_ownership_mismatch");
    }
    await rm(lockPath, { recursive: true });
  } };
}
