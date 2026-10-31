import { assert } from "./errors.mjs";

const RECORD_LIMIT = 24 * 1024 * 1024;
const ACCOUNT_LIMIT = 128 * 1024 * 1024;
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(id);
const metadata = (row) => ({ id: row.id, version: row.version, createdAt: row.created_at,
  updatedAt: row.updated_at, deletedAt: row.deleted_at, byteLength: row.byte_length });
const aad = (accountId, id) => `personal-memory-v1:${accountId}:${id}`;

// Explicit opt-in snapshots, separate from public spaces and Book Lab grants.
// The opaque document preserves the user's complete local schema and photo order.
export class PersonalMemoryService {
  constructor(core, { recordKind = "snapshot" } = {}) {
    this.core = core; this.db = core.db; this.recordKind = recordKind;
  }
  row(account, id) {
    assert(validId(id), "memory_id_invalid");
    return this.core.one("SELECT * FROM personal_memories WHERE account_id=? AND id=? AND record_kind=?",
      account.accountId, id, this.recordKind);
  }
  list(account) {
    // The account quota bounds a scan to 128 MiB / 1000 records. Iterate ciphertext
    // one row at a time (each at most 24 MiB); keep only small summaries in memory.
    // Titles stay encrypted at rest and never enter a public or cross-account query.
    const memories = [];
    for (const row of this.db.prepare(`SELECT * FROM personal_memories WHERE account_id=? AND record_kind=?
      ORDER BY updated_at DESC,id`).iterate(account.accountId, this.recordKind)) {
      const document = JSON.parse(this.core.keyring.open(row.document_ciphertext,
        aad(account.accountId, row.id), row.envelope_key_id));
      memories.push({ ...metadata(row), title: typeof document.title === "string" ? document.title.slice(0, 500) : "",
        photoCount: Array.isArray(document.photos) ? document.photos.length : 0 });
    }
    return { memories };
  }
  get(account, id) {
    const row = this.row(account, id);
    assert(row, "memory_unavailable", 404);
    return { ...metadata(row), accountId: account.accountId, document: JSON.parse(this.core.keyring.open(row.document_ciphertext,
      aad(account.accountId, id), row.envelope_key_id)) };
  }
  requireExpectedAccount(ctx, account) {
    const expected = ctx.headers?.["x-unseen-expected-account-id"];
    assert(expected === undefined || expected === account.accountId, "account_changed", 409);
  }
  save(ctx, account, id, { endpoint = `/v1/me/memories/${id}`, method = "POST" } = {}) {
    this.requireExpectedAccount(ctx, account);
    assert(!id.startsWith("submission:"), "memory_reserved", 403);
    assert(validId(id), "memory_id_invalid");
    assert(ctx.body.consent === true, "memory_sync_consent_required");
    assert(ctx.body.document && typeof ctx.body.document === "object" && !Array.isArray(ctx.body.document), "memory_document_invalid");
    const document = JSON.stringify(ctx.body.document);
    const size = Buffer.byteLength(document);
    assert(size <= RECORD_LIMIT, "memory_too_large", 413);
    return this.core.mutation(ctx, { endpoint, method, scope: account.accountId }, () => {
      const old = this.row(account, id);
      assert(old || !this.core.one("SELECT 1 FROM personal_memories WHERE account_id=? AND id=?", account.accountId, id),
        "memory_kind_conflict", 409);
      assert(String(ctx.ifMatch) === String(old?.version ?? 0), "version_conflict", 409);
      assert(!old?.deleted_at, "memory_trashed", 409);
      const usage = this.core.one("SELECT COALESCE(SUM(byte_length),0) AS bytes,COUNT(*) AS count FROM personal_memories WHERE account_id=?", account.accountId);
      assert(usage.bytes - (old?.byte_length ?? 0) + size <= ACCOUNT_LIMIT && (old || usage.count < 1000), "memory_storage_limit", 413);
      const now = this.core.now();
      this.db.prepare(`INSERT INTO personal_memories(account_id,id,document_ciphertext,envelope_key_id,byte_length,version,created_at,updated_at,record_kind)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET document_ciphertext=excluded.document_ciphertext,
        envelope_key_id=excluded.envelope_key_id,byte_length=excluded.byte_length,version=excluded.version,updated_at=excluded.updated_at`)
        .run(account.accountId, id, this.core.keyring.seal(document, aad(account.accountId, id)), this.core.keyring.keyId,
          size, (old?.version ?? 0) + 1, old?.created_at ?? now, now, this.recordKind);
      return metadata(this.row(account, id));
    });
  }
  transition(ctx, account, id, action) {
    this.requireExpectedAccount(ctx, account);
    assert(!id.startsWith("submission:"), "memory_reserved", 403);
    assert(validId(id), "memory_id_invalid");
    return this.core.mutation(ctx, { endpoint: `/v1/me/memories/${id}/${action}`, scope: account.accountId }, () => {
      const row = this.row(account, id);
      assert(row, "memory_unavailable", 404);
      this.core.requireIfMatch(ctx, row);
      const now = this.core.now();
      this.db.prepare("UPDATE personal_memories SET deleted_at=?,version=version+1,updated_at=? WHERE account_id=? AND id=?")
        .run(action === "trash" ? now : null, now, account.accountId, id);
      return metadata(this.row(account, id));
    });
  }
}

// Must be called inside the caller's transaction. No user document or version is changed.
export function reencryptPersonalMemories(db, keyring, fromKeyId, toKeyId) {
  assert(db.isTransaction, "memory_rekey_transaction_required", 500);
  const rows = db.prepare("SELECT * FROM personal_memories WHERE envelope_key_id=? ORDER BY account_id,id").all(fromKeyId);
  if (!rows.length) return 0;
  assert(keyring.keysets.has(fromKeyId) && keyring.keysets.has(toKeyId), "personal_memory_key_unavailable", 503);
  for (const row of rows) {
    const context = aad(row.account_id, row.id);
    const plaintext = keyring.open(row.document_ciphertext, context, fromKeyId);
    const encrypted = keyring.seal(plaintext, context, toKeyId);
    assert(keyring.open(encrypted, context, toKeyId) === plaintext, "personal_memory_rekey_verification_failed", 503);
    const changed = db.prepare("UPDATE personal_memories SET document_ciphertext=?,envelope_key_id=? WHERE account_id=? AND id=? AND envelope_key_id=?")
      .run(encrypted, toKeyId, row.account_id, row.id, fromKeyId);
    assert(changed.changes === 1, "personal_memory_rekey_conflict", 409);
  }
  return rows.length;
}

export function exportPersonalMemories(db, keyring, accountId) {
  const rows = db.prepare("SELECT * FROM personal_memories WHERE account_id=? ORDER BY id").all(accountId);
  assert(!rows.length || keyring, "personal_memory_export_key_required", 503);
  return rows.map(row => ({ ...metadata(row), document: JSON.parse(keyring.open(row.document_ciphertext,
    aad(accountId, row.id), row.envelope_key_id)) }));
}
