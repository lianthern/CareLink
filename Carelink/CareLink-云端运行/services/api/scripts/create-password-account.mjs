import { constants, closeSync, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { openDatabase } from "../src/database.mjs";
import { Core } from "../src/core.mjs";
import { loadLocalKeyring } from "../src/crypto.mjs";
import { createPasswordAccount, normalizeUsername } from "../src/password-account-service.mjs";

// Explicit paths prevent an operator typo from creating a second, unrelated DB.
const database = process.env.UNSEEN_API_DB;
const keyset = process.env.UNSEEN_API_KEYSET;
if (!database || database === ":memory:" || !keyset) {
  process.stderr.write("Set UNSEEN_API_DB and UNSEEN_API_KEYSET to explicit persistent paths.\n");
  process.exit(1);
}
let db, descriptor;
try {
  const isNew = !existsSync(path.resolve(database));
  const keyring = loadLocalKeyring(path.resolve(keyset), { allowCreate: isNew });
  db = openDatabase(path.resolve(database));
  const core = new Core({ db, keyring });
  const username = normalizeUsername(process.env.UNSEEN_SEED_USERNAME ?? "unseen");
  if (core.one("SELECT 1 FROM account_password_credentials WHERE username=?", username)) {
    throw Object.assign(new Error("username_already_exists"), { code: "username_already_exists" });
  }
  const password = process.env.UNSEEN_SEED_PASSWORD ?? randomBytes(18).toString("base64url");
  if (typeof password !== "string" || Buffer.byteLength(password) < 10 || Buffer.byteLength(password) > 256) {
    throw Object.assign(new Error("password_invalid"), { code: "password_invalid" });
  }
  const credentialsFile = path.resolve(process.env.UNSEEN_SEED_CREDENTIALS_FILE ?? `${database}.${username}-credentials.json`);
  // O_EXCL and NOFOLLOW ensure existing files/credentials cannot be overwritten.
  descriptor = openSync(credentialsFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  writeFileSync(descriptor, JSON.stringify({ username, password }) + "\n");
  fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
  const result = await createPasswordAccount(core, { username, password });
  process.stdout.write(JSON.stringify({ created: true, ...result, credentialsFile }) + "\n");
} catch (error) {
  // Never echo errors that might contain request bodies, passwords, or SQL binds.
  process.stderr.write(JSON.stringify({ created: false, error: error.code ?? "account_creation_failed" }) + "\n");
  process.exitCode = 1;
} finally {
  if (descriptor !== undefined) closeSync(descriptor);
  db?.close();
}
