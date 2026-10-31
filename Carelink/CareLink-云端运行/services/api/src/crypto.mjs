import { constants as fsConstants, closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError, assert } from "./errors.mjs";

const KEY_NAMES = ["credentialKey", "identifierKey", "equivalenceKey", "identityEnvelopeKey", "otpKey", "envelopeKey"];

export const IDENTITY_ENVELOPE_FORMAT = "normalized-identifier-aes256gcm-v1";

export function identityEnvelopeAad(equivalenceId, identityType = "email_v1",
  envelopeFormat = IDENTITY_ENVELOPE_FORMAT) {
  return `identifier-equivalence-rekey-v1\0${equivalenceId}\0${identityType}\0${envelopeFormat}`;
}

function decodeKey(value) {
  assert(typeof value === "string", "keyset_unavailable", 503);
  const key = Buffer.from(value, "base64url");
  assert(key.length === 32, "keyset_unavailable", 503);
  return key;
}

function normalizeKeyset(value) {
  assert(value && typeof value === "object" && typeof value.keyId === "string" && value.keyId.length >= 8,
    "keyset_unavailable", 503);
  const result = { keyId: value.keyId };
  for (const name of KEY_NAMES) result[name] = Buffer.isBuffer(value[name]) ? Buffer.from(value[name]) : decodeKey(value[name]);
  assert(KEY_NAMES.every((name) => result[name].length === 32), "keyset_unavailable", 503);
  return result;
}

function freshKeyset() {
  const result = Object.fromEntries(KEY_NAMES.map((name) => [name, randomBytes(32)]));
  result.keyId = `local-${createHash("sha256").update(result.credentialKey).digest("hex").slice(0, 16)}`;
  return result;
}

function serializeKeyset(current, previous = []) {
  const encode = (set) => ({ keyId: set.keyId,
    ...Object.fromEntries(KEY_NAMES.map((name) => [name, set[name].toString("base64url")])) });
  return `${JSON.stringify({ schema: "unseen-local-keyset-v1", current: encode(current), previous: previous.map(encode) })}\n`;
}

function verifySecretFile(file) {
  const stat = lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    "keyset_permissions_invalid", 503);
  if (typeof process.getuid === "function") assert(stat.uid === process.getuid(), "keyset_permissions_invalid", 503);
}

function atomicCreate(file, contents) {
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temp, file);
    const directory = openSync(path.dirname(file), fsConstants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function loadLocalKeyring(filePath, { allowCreate = false } = {}) {
  const file = path.resolve(filePath);
  try {
    if (!existsSync(file)) {
      assert(allowCreate, "keyset_unavailable", 503);
      atomicCreate(file, serializeKeyset(freshKeyset()));
    }
    verifySecretFile(file);
    const document = JSON.parse(readFileSync(file, "utf8"));
    assert(document?.schema === "unseen-local-keyset-v1" && Array.isArray(document.previous) && document.previous.length <= 2,
      "keyset_unavailable", 503);
    const current = normalizeKeyset(document.current);
    const previous = document.previous.map(normalizeKeyset);
    assert(new Set([current.keyId, ...previous.map((entry) => entry.keyId)]).size === previous.length + 1,
      "keyset_unavailable", 503);
    return new LocalKeyring({ current, previous, persistent: true });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("keyset_unavailable", 503);
  }
}

export class LocalKeyring {
  constructor(keys = {}) {
    const legacy = keys.current ?? { keyId: keys.keyId ?? "local-ephemeral-v1",
      ...Object.fromEntries(KEY_NAMES.map((name) => [name, keys[name] ?? randomBytes(32)])) };
    this.current = normalizeKeyset(legacy);
    this.previous = (keys.previous ?? []).map(normalizeKeyset);
    this.keysets = new Map([this.current, ...this.previous].map((entry) => [entry.keyId, entry]));
    this.keyId = this.current.keyId;
    for (const name of KEY_NAMES) this[name] = this.current[name];
    this.persistent = Boolean(keys.persistent);
  }

  mac(domain, value, key = this.credentialKey) {
    return createHmac("sha256", key).update(domain).update("\0").update(String(value)).digest();
  }

  credential(domain, rawSecret) {
    assert(typeof rawSecret === "string" && rawSecret.length <= 256, "credential_unavailable", 401);
    return { keyId: this.keyId, mac: this.mac(domain, rawSecret) };
  }

  credentialCandidates(domain, rawSecret) {
    assert(typeof rawSecret === "string" && rawSecret.length <= 256, "credential_unavailable", 401);
    return [this.current, ...this.previous].map((entry) => ({ keyId: entry.keyId,
      mac: this.mac(domain, rawSecret, entry.credentialKey) }));
  }

  equivalentEmail(normalizedEmail) {
    return this.mac("email-equivalence-v1", normalizedEmail, this.equivalenceKey);
  }

  equivalentEmailForKey(normalizedEmail, keyId) {
    const keyset = this.keysets.get(keyId);
    assert(keyset, "identity_rekey_envelope_unavailable", 503);
    return this.mac("email-equivalence-v1", normalizedEmail, keyset.equivalenceKey);
  }

  equivalentEmailCandidates(normalizedEmail) {
    return [this.current, ...this.previous].map((entry) => ({ keyId: entry.keyId,
      mac: this.mac("email-equivalence-v1", normalizedEmail, entry.equivalenceKey) }));
  }

  identifier(normalizedEmail) {
    return this.mac("email-v1", normalizedEmail, this.identifierKey);
  }

  identifierCandidates(normalizedEmail) {
    return [this.current, ...this.previous].map((entry) => ({ keyId: entry.keyId,
      mac: this.mac("email-v1", normalizedEmail, entry.identifierKey) }));
  }

  otp(challengeId, equivalenceId, purpose, code) {
    return this.mac("email-otp-v1", `${challengeId}\0${equivalenceId}\0${purpose}\0${code}`, this.otpKey);
  }

  otpCandidates(challengeId, equivalenceId, purpose, code) {
    return [this.current, ...this.previous].map((entry) => ({ keyId: entry.keyId,
      mac: this.mac("email-otp-v1", `${challengeId}\0${equivalenceId}\0${purpose}\0${code}`, entry.otpKey) }));
  }

  equal(left, right) {
    const a = Buffer.from(left ?? []);
    const b = Buffer.from(right ?? []);
    return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
  }

  seal(value, aad, keyId = this.keyId) {
    const keyset = this.keysets.get(keyId);
    assert(keyset, "credential_unavailable", 401);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyset.envelopeKey, nonce);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  open(envelope, aad, keyId = this.keyId) {
    const keyset = this.keysets.get(keyId);
    assert(keyset, "credential_unavailable", 401);
    const bytes = Buffer.from(envelope, "base64url");
    assert(bytes.length >= 29, "credential_unavailable", 401);
    const decipher = createDecipheriv("aes-256-gcm", keyset.envelopeKey, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }

  sealIdentity(value, aad, keyId = this.keyId) {
    const keyset = this.keysets.get(keyId);
    assert(keyset, "identity_rekey_envelope_unavailable", 503);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyset.identityEnvelopeKey, nonce);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  openIdentity(envelope, aad, keyId) {
    const keyset = this.keysets.get(keyId);
    assert(keyset, "identity_rekey_envelope_unavailable", 503);
    try {
      const bytes = Buffer.from(envelope, "base64url");
      assert(bytes.length >= 29, "identity_rekey_decrypt_failed", 409);
      const decipher = createDecipheriv("aes-256-gcm", keyset.identityEnvelopeKey, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("identity_rekey_decrypt_failed", 409);
    }
  }
}

export function normalizeEmail(input) {
  assert(typeof input === "string" && input.length <= 320, "validation_failed");
  const normalized = input.normalize("NFC").trim();
  const at = normalized.lastIndexOf("@");
  assert(at > 0 && at < normalized.length - 1, "validation_failed");
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  assert(/^[\x21-\x7e]+$/.test(local) && /^[A-Za-z0-9.-]+$/.test(domain), "validation_failed");
  assert(local.length <= 64 && domain.length <= 253 && !local.startsWith(".") && !local.endsWith(".") &&
    !local.includes("..") && !domain.startsWith(".") && !domain.endsWith(".") && !domain.includes("..") &&
    domain.split(".").every((label) => label && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")),
  "validation_failed");
  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}

export function maskEmail(input) {
  const [local, domain] = input.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
