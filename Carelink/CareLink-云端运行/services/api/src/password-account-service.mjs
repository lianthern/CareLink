import { adminPermissions } from "./admin-permissions.mjs";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { assert } from "./errors.mjs";
import { transaction } from "./database.mjs";
import { id, stableJson } from "./util.mjs";
import { PersonalMemoryService } from "./personal-memory-service.mjs";

const derive = promisify(scrypt);
const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const FORMAT = "scrypt-v1";
const DUMMY_HASH = `${FORMAT}$${Buffer.alloc(16, 41).toString("base64url")}$${Buffer.alloc(32).toString("base64url")}`;
let activeDerivations = 0;
const validPassword = value => typeof value === "string" && Buffer.byteLength(value) >= 10 && Buffer.byteLength(value) <= 256;
export function normalizeUsername(value) {
  assert(typeof value === "string", "username_invalid");
  const normalized = value.trim().toLowerCase();
  assert(/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(normalized), "username_invalid");
  return normalized;
}
async function derivePassword(password, salt) {
  assert(activeDerivations < 4, "authentication_busy", 429);
  activeDerivations += 1;
  try { return await derive(password, salt, 32, SCRYPT_OPTIONS); }
  finally { activeDerivations -= 1; }
}
export async function hashAccountPassword(password) {
  assert(validPassword(password), "password_invalid", 400, { minBytes: 10, maxBytes: 256 });
  const salt = randomBytes(16), hash = await derivePassword(password, salt);
  return `${FORMAT}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
async function verifyPassword(password, encoded) {
  const [format, saltText, hashText] = encoded.split("$");
  assert(format === FORMAT, "password_credential_unavailable", 503);
  const salt = Buffer.from(saltText, "base64url"), expected = Buffer.from(hashText, "base64url");
  assert(salt.length === 16 && expected.length === 32, "password_credential_unavailable", 503);
  const actual = await derivePassword(password, salt);
  return timingSafeEqual(actual, expected);
}

// Operator-only helper. It creates an empty existing-identity account; it cannot
// overwrite credentials or silently attach a username to another account.
export async function createPasswordAccount(core, { username, password }) {
  username = normalizeUsername(username);
  assert(!core.one("SELECT 1 FROM account_password_credentials WHERE username=?", username), "username_already_exists", 409);
  const passwordHash = await hashAccountPassword(password);
  return transaction(core.db, () => {
    assert(!core.one("SELECT 1 FROM account_password_credentials WHERE username=?", username), "username_already_exists", 409);
    const accountId = id("acct"), now = core.now();
    core.db.prepare("INSERT INTO accounts(id,locale,status,session_epoch,version,created_at) VALUES(?,'zh-CN','active',1,1,?)").run(accountId, now);
    core.db.prepare(`INSERT INTO account_password_credentials(account_id,username,password_hash,created_at,updated_at)
      VALUES(?,?,?,?,?)`).run(accountId, username, passwordHash, now, now);
    return { accountId, username };
  });
}

export class PasswordAccountService {
  constructor(core, identity, moments) {
    this.core = core; this.identity = identity; this.moments = moments;
    this.profiles = new PersonalMemoryService(core, { recordKind: "profile" });
  }
  privateRequest(ctx) {
    // Core stores a request digest for replay checks. Key password-bearing
    // request data first so it cannot become a fast offline password oracle.
    return { ...ctx, body: { credentialProof: this.core.keyring.mac("password-request-v1", stableJson(ctx.body)).toString("hex") } };
  }
  claimRate(username, riskScope, purpose = "login") {
    // Commit counters before doing expensive asynchronous password work. Invalid
    // credentials and unknown usernames consume the same persistent budgets.
    const bucket = Math.floor(this.core.nowMs() / 600000);
    const scopes = [[`username:${purpose}:${username}`, 10], [`risk:${purpose}:${riskScope}`, 60]];
    return transaction(this.core.db, () => {
      this.core.db.prepare("DELETE FROM password_rate_counters WHERE bucket_start<?").run(bucket - 2);
      const bindings = scopes.map(([scope, limit]) => ({
        scope: this.core.keyring.mac("password-rate-v1", scope).toString("hex"), limit }));
      if (bindings.some(binding => (this.core.one("SELECT count FROM password_rate_counters WHERE scope=? AND bucket_start=?",
        binding.scope, bucket)?.count ?? 0) >= binding.limit)) return false;
      for (const binding of bindings) this.core.db.prepare(`INSERT INTO password_rate_counters(scope,bucket_start,count)
        VALUES(?,?,1) ON CONFLICT(scope,bucket_start) DO UPDATE SET count=count+1`).run(binding.scope, bucket);
      return true;
    });
  }
  profile(account) {
    const credential = this.core.one("SELECT username FROM account_password_credentials WHERE account_id=?", account.accountId);
    const row = this.profiles.row(account, "profile:account");
    const data = row ? this.profiles.get(account, row.id).document : {};
    return { user: { id: account.accountId, username: credential?.username ?? null,
      ...adminPermissions(this.core,account.accountId),
      displayName: data.displayName ?? this.core.one("SELECT display_name FROM account_administration WHERE account_id=?",account.accountId)?.display_name ?? credential?.username ?? "我", ...(data.avatar ? { avatar: data.avatar } : {}),
      preferences: { photoMode: data.preferences?.photoMode ?? "reveal", readReplies: data.preferences?.readReplies ?? true,
        continuous: data.preferences?.continuous ?? true } }, version: row?.version ?? 0 };
  }
  async register(ctx) {
    const username=normalizeUsername(ctx.body?.username), displayName=ctx.body?.displayName;
    assert(typeof displayName==='string' && displayName.trim().length>0 && displayName.length<=80,'profile_invalid');
    assert(this.claimRate(username,ctx.riskScope,'register'),'authentication_rate_limited',429);
    const hash=await hashAccountPassword(ctx.body.password);
    return this.core.mutation(this.privateRequest({...ctx,accountSession:null,selectedPrincipalKind:null}),{endpoint:'/v1/auth/register',scope:`register:${username}`,reauthorize:()=>{}},()=>{
      assert(!this.core.one('SELECT 1 FROM account_password_credentials WHERE username=?',username),'username_already_exists',409);
      const accountId=id('acct'), now=this.core.now();
      this.core.db.prepare("INSERT INTO accounts(id,locale,status,session_epoch,version,created_at) VALUES(?,'zh-CN','active',1,1,?)").run(accountId,now);
      this.core.db.prepare('INSERT INTO account_password_credentials(account_id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(accountId,username,hash,now,now);
      this.core.db.prepare("INSERT INTO account_administration(account_id,status,display_name) VALUES(?,'active',?)").run(accountId,displayName.trim());
      return {registration:{accountId,username,status:'active'}};
    });
  }
  async login(ctx) {
    const username = normalizeUsername(ctx.body?.username), password = ctx.body?.password;
    assert(typeof password === "string" && Buffer.byteLength(password) <= 256, "authentication_failed", 401);
    assert(this.claimRate(username, ctx.riskScope), "authentication_rate_limited", 429);
    const credential = this.core.one("SELECT * FROM account_password_credentials WHERE username=?", username);
    const valid = await verifyPassword(password, credential?.password_hash ?? DUMMY_HASH);
    assert(valid && credential, "authentication_failed", 401);
    const result = this.core.mutation(this.privateRequest(ctx), { endpoint: "/v1/auth/password-login", scope: `password-login:${credential.account_id}`,
      replayClass: "credential_reissue", reauthorize: () => {
        const current = this.core.one("SELECT * FROM account_password_credentials WHERE account_id=?", credential.account_id);
        assert(current?.password_hash === credential.password_hash && current.username === username, "authentication_failed", 401);
      },
      reissue: completed => this.identity.reissueAccountSession(completed) }, () => {
      const current = this.core.one("SELECT * FROM account_password_credentials WHERE account_id=?", credential.account_id);
      assert(current?.password_hash === credential.password_hash && current.username === username, "authentication_failed", 401);
      const account = this.core.one("SELECT * FROM accounts WHERE id=?", credential.account_id);
      // Rotate only the credential supplied by this browser; other devices keep
      // their own sessions until password-change increments the account epoch.
      if (ctx.accountSession) {
        const old = this.core.credentialRow("account_sessions", "account-session-v1", ctx.accountSession);
        if (old) this.core.db.prepare("UPDATE account_sessions SET revoked_at=?,version=version+1 WHERE id=?")
          .run(this.core.now(), old.id);
      }
      return this.identity.issueAccountSession(account);
    });
    return { ...result, user: this.profile({ accountId: credential.account_id }).user };
  }
  async updateProfile(ctx, account) {
    this.profiles.requireExpectedAccount(ctx, account);
    const body = ctx.body;
    assert(body && typeof body === "object" && !Array.isArray(body), "profile_invalid");
    assert(Object.keys(body).every(key => ["displayName", "username", "currentPassword", "avatar", "preferences", "expectedVersion"].includes(key)), "profile_invalid");
    const current = this.profile(account), data = { displayName: current.user.displayName, preferences: current.user.preferences,
      ...(current.user.avatar ? { avatar: current.user.avatar } : {}) };
    if (body.displayName !== undefined) {
      assert(typeof body.displayName === "string" && body.displayName.trim().length > 0 && body.displayName.length <= 80, "profile_invalid");
      data.displayName = body.displayName.trim();
    }
    if (body.preferences !== undefined) {
      const patch = body.preferences;
      assert(patch && typeof patch === "object" && !Array.isArray(patch) &&
        Object.keys(patch).every(key => ["photoMode", "readReplies", "continuous"].includes(key)) &&
        (patch.photoMode === undefined || ["reveal", "clear"].includes(patch.photoMode)) &&
        ["readReplies", "continuous"].every(key => patch[key] === undefined || typeof patch[key] === "boolean"), "profile_invalid");
      data.preferences = { ...data.preferences, ...patch };
    }
    if (body.avatar !== undefined) {
      if (body.avatar === null) delete data.avatar;
      else {
        const match = typeof body.avatar === "string" && body.avatar.match(/^\/v1\/moment-media\/([A-Za-z0-9_-]{1,96})(?:\/preview)?$/);
        assert(match && this.moments.mediaDocument(account, match[1]).kind === "photo", "profile_avatar_invalid");
        data.avatar = body.avatar;
      }
    }
    // Display/preferences writes are the ordinary frequent profile action.
    // Username changes are separately verified and atomic with the encrypted profile.
    const username = body.username === undefined ? current.user.username : normalizeUsername(body.username);
    const changingUsername = username !== current.user.username;
    let credential;
    if (changingUsername) {
      credential = this.core.one("SELECT * FROM account_password_credentials WHERE account_id=?", account.accountId);
      assert(credential && typeof body.currentPassword === "string" && Buffer.byteLength(body.currentPassword) <= 256, "authentication_failed", 401);
      assert(this.claimRate(account.accountId, ctx.riskScope, "profile"), "authentication_rate_limited", 429);
      assert(await verifyPassword(body.currentPassword, credential.password_hash), "authentication_failed", 401);
      this.core.account(ctx.accountSession);
    }
    const result = this.core.mutation(this.privateRequest(ctx), { endpoint: "/v1/profile", method: "PATCH", scope: account.accountId }, () => {
      if (body.expectedVersion !== undefined) assert(body.expectedVersion === current.version, "version_conflict", 409);
      const row = this.profiles.row(account, "profile:account");
      assert(row || !this.core.one("SELECT 1 FROM personal_memories WHERE account_id=? AND id='profile:account'", account.accountId),
        "memory_kind_conflict", 409);
      assert((row?.version ?? 0) === current.version, "version_conflict", 409);
      if (changingUsername) {
        assert(!this.core.one("SELECT 1 FROM account_password_credentials WHERE username=?", username), "username_already_exists", 409);
        const changed = this.core.db.prepare("UPDATE account_password_credentials SET username=?,version=version+1,updated_at=? WHERE account_id=? AND version=?")
          .run(username, this.core.now(), account.accountId, credential.version);
        assert(changed.changes === 1, "version_conflict", 409);
      }
      const document = JSON.stringify(data), now = this.core.now();
      const usage = this.core.one("SELECT COALESCE(SUM(byte_length),0) bytes,COUNT(*) count FROM personal_memories WHERE account_id=?", account.accountId);
      assert(usage.bytes - (row?.byte_length ?? 0) + Buffer.byteLength(document) <= 128 * 1024 * 1024 &&
        (row || usage.count < 1000), "memory_storage_limit", 413);
      // Same AAD and storage layout as PersonalMemoryService: rekey/export/deletion
      // operate on this record without adding a second encryption implementation.
      this.core.db.prepare(`INSERT INTO personal_memories(account_id,id,document_ciphertext,envelope_key_id,byte_length,version,created_at,updated_at,record_kind)
        VALUES(?,'profile:account',?,?,?,?,?,?,'profile') ON CONFLICT(account_id,id) DO UPDATE SET
        document_ciphertext=excluded.document_ciphertext,envelope_key_id=excluded.envelope_key_id,
        byte_length=excluded.byte_length,version=excluded.version,updated_at=excluded.updated_at`)
        .run(account.accountId, this.core.keyring.seal(document, `personal-memory-v1:${account.accountId}:profile:account`),
          this.core.keyring.keyId, Buffer.byteLength(document), current.version + 1, row?.created_at ?? now, now);
      return { version: current.version + 1 };
    });
    return { ...this.profile(account), ...(result.replayed ? { replayed: true } : {}) };
  }
  async changePassword(ctx, account) {
    this.profiles.requireExpectedAccount(ctx, account);
    const { currentPassword, newPassword } = ctx.body ?? {};
    assert(typeof currentPassword === "string" && Buffer.byteLength(currentPassword) <= 256, "authentication_failed", 401);
    assert(validPassword(newPassword), "password_invalid", 400, { minBytes: 10, maxBytes: 256 });
    assert(this.claimRate(account.accountId, ctx.riskScope, "change"), "authentication_rate_limited", 429);
    const credential = this.core.one("SELECT * FROM account_password_credentials WHERE account_id=?", account.accountId);
    assert(credential && await verifyPassword(currentPassword, credential.password_hash), "authentication_failed", 401);
    const hash = await hashAccountPassword(newPassword);
    this.core.account(ctx.accountSession);
    return this.core.mutation(this.privateRequest(ctx), { endpoint: "/v1/auth/password-change", scope: account.accountId }, () => {
      const changed = this.core.db.prepare("UPDATE account_password_credentials SET password_hash=?,version=version+1,updated_at=? WHERE account_id=? AND version=?")
        .run(hash, this.core.now(), account.accountId, credential.version);
      assert(changed.changes === 1, "version_conflict", 409);
      this.core.db.prepare("UPDATE accounts SET session_epoch=session_epoch+1,version=version+1 WHERE id=?").run(account.accountId);
      const updated = this.core.one("SELECT * FROM accounts WHERE id=?", account.accountId);
      return { changed: true, ...this.identity.issueAccountSession(updated) };
    });
  }
}
