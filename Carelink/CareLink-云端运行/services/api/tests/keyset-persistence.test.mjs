import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LocalApi } from "../src/api.mjs";
import { LocalKeyring } from "../src/crypto.mjs";
import { MemoryMediaStore } from "../src/ports/media/memory-media-store.mjs";

const helper = new URL("./keyset-process-helper.mjs", import.meta.url).pathname;
const mediaHelper = new URL("./media-store-process-helper.mjs", import.meta.url).pathname;
const names = ["credentialKey", "identifierKey", "equivalenceKey", "identityEnvelopeKey", "otpKey", "envelopeKey"];

function invoke(database, keyset, mode, email, clientState) {
  const result = spawnSync(process.execPath, [helper, database, keyset, mode, email, clientState], {
    encoding: "utf8", timeout: 10_000
  });
  const line = result.stdout.trim().split("\n").at(-1);
  return { ...result, json: line ? JSON.parse(line) : null };
}

function mediaInvoke(root, operation, key, bytes = Buffer.alloc(0)) {
  const result = spawnSync(process.execPath, [mediaHelper, root, operation, key, bytes.toString("base64url")], {
    encoding: "utf8", timeout: 10_000
  });
  const line = result.stdout.trim().split("\n").at(-1);
  return { ...result, json: line?.startsWith("{") ? JSON.parse(line) : null };
}

test("persistent databases require a durable store and filesystem media survives restart, conflict, cleanup, and crash debris", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-durable-media-"));
  try {
    const database = path.join(directory, "local.sqlite");
    assert.throws(() => new LocalApi({ database, keyring: new LocalKeyring() }),
      (error) => error.code === "keyset_required");
    const stableKeyring = new LocalKeyring({ persistent: true });
    assert.throws(() => new LocalApi({ database, keyring: stableKeyring }),
      (error) => error.code === "durable_media_store_required");
    assert.throws(() => new LocalApi({ database, keyring: stableKeyring, mediaStore: new MemoryMediaStore() }),
      (error) => error.code === "durable_media_store_required");
    const root = path.join(directory, "media");
    const key = "private/space/batches/batch/items/item/asset";
    const bytes = randomBytes(64 * 1024);
    const first = mediaInvoke(root, "put", key, bytes);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.json.created, true);
    const restarted = mediaInvoke(root, "get", key);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(Buffer.from(restarted.json.body, "base64url"), bytes);
    assert.equal(restarted.json.etag, createHash("sha256").update(bytes).digest("hex"));
    const conflict = mediaInvoke(root, "put", key, randomBytes(bytes.length));
    assert.equal(conflict.status, 0, conflict.stderr);
    assert.equal(conflict.json.created, false);
    assert.deepEqual(Buffer.from(mediaInvoke(root, "get", key).json.body, "base64url"), bytes);
    writeFileSync(path.join(root, ".tmp-dead-process"), "partial", { mode: 0o600 });
    assert.equal(mediaInvoke(root, "head", key).json.exists, true);
    assert.equal(existsSync(path.join(root, ".tmp-dead-process")), false);
    const removed = mediaInvoke(root, "delete", key);
    assert.equal(removed.json.exists, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function rotate(file) {
  const document = JSON.parse(readFileSync(file, "utf8"));
  const keys = Object.fromEntries(names.map((name) => [name, randomBytes(32).toString("base64url")]));
  const keyId = `local-${createHash("sha256").update(Buffer.from(keys.credentialKey, "base64url"))
    .digest("hex").slice(0, 16)}`;
  document.previous = [document.current, ...document.previous].slice(0, 2);
  document.current = { keyId, ...keys };
  writeFileSync(file, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function retirePrevious(file) {
  const document = JSON.parse(readFileSync(file, "utf8"));
  document.previous = [];
  writeFileSync(file, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

test("persistent keyset survives cross-process restart and rotation without duplicating account identity", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-keyset-restart-"));
  try {
    const database = path.join(directory, "local.sqlite");
    const keyset = path.join(directory, "local.keyset.json");
    const clientState = path.join(directory, "client-session.secret");
    const first = invoke(database, keyset, "first", "persistent@example.test", clientState);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(statSync(keyset).mode & 0o777, 0o600);
    const restarted = invoke(database, keyset, "restart", "persistent@example.test", clientState);
    assert.equal(restarted.status, 0, restarted.stderr || restarted.stdout);
    assert.equal(restarted.json.accountId, first.json.accountId);
    assert.equal(restarted.json.accountsCount, 1);
    assert.equal(restarted.json.spaceId, first.json.spaceId);
    assert.equal(restarted.json.oldSessionStatus, 200);
    rotate(keyset);
    const rotated = invoke(database, keyset, "rotated", "persistent@example.test", clientState);
    assert.equal(rotated.status, 0, rotated.stderr || rotated.stdout);
    assert.equal(rotated.json.accountId, first.json.accountId);
    assert.equal(rotated.json.accountsCount, 1);
    assert.equal(rotated.json.spaceId, first.json.spaceId);
    assert.equal(rotated.json.oldSessionStatus, 200);
    assert.notEqual(rotated.json.keyId, first.json.keyId);
    retirePrevious(keyset);
    const retired = invoke(database, keyset, "retired", "persistent@example.test", clientState);
    assert.equal(retired.status, 0, retired.stderr || retired.stdout);
    assert.equal(retired.json.accountId, first.json.accountId);
    assert.equal(retired.json.accountsCount, 1);
    assert.equal(retired.json.spaceId, first.json.spaceId);
    assert.equal(readFileSync(keyset, "utf8").includes("persistent@example.test"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("removing a previous identity epoch is refused until every active equivalence is rekeyed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-keyset-retirement-"));
  try {
    const database = path.join(directory, "local.sqlite");
    const keyset = path.join(directory, "local.keyset.json");
    const clientState = path.join(directory, "client.secret");
    assert.equal(invoke(database, keyset, "first", "unmigrated@example.test", clientState).status, 0);
    rotate(keyset);
    retirePrevious(keyset);
    const refused = invoke(database, keyset, "retired-too-early", "unmigrated@example.test", clientState);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.json.error, "identity_key_retirement_incomplete");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("persistent database fails closed for missing, corrupt, or permissive keyset files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-keyset-failclosed-"));
  try {
    const missingDb = path.join(directory, "existing.sqlite");
    const missingKey = path.join(directory, "missing.keyset.json");
    const clientState = path.join(directory, "client.secret");
    writeFileSync(missingDb, "");
    const missing = invoke(missingDb, missingKey, "missing", "missing@example.test", clientState);
    assert.notEqual(missing.status, 0);
    assert.equal(missing.json.error, "keyset_unavailable");

    const corruptDb = path.join(directory, "corrupt.sqlite");
    const corruptKey = path.join(directory, "corrupt.keyset.json");
    writeFileSync(corruptKey, "{}\n", { mode: 0o600 });
    const corrupt = invoke(corruptDb, corruptKey, "corrupt", "corrupt@example.test", clientState);
    assert.notEqual(corrupt.status, 0);
    assert.equal(corrupt.json.error, "keyset_unavailable");

    const validDb = path.join(directory, "valid.sqlite");
    const validKey = path.join(directory, "valid.keyset.json");
    const generated = invoke(validDb, validKey, "first", "permissions@example.test", clientState);
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    chmodSync(validKey, 0o644);
    const permissive = invoke(validDb, validKey, "permissions", "permissions@example.test", clientState);
    assert.notEqual(permissive.status, 0);
    assert.equal(permissive.json.error, "keyset_permissions_invalid");
    assert.equal(permissive.stdout.includes("credentialKey"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
