import { transaction } from "../../database.mjs";
import { assert } from "../../errors.mjs";
import { id, parseJson, sha256 } from "../../util.mjs";

const CLAIM_TTL_MS = 30_000;

// hardLimitBytes may be a plain number (every existing caller: photo/panorama uploads, both a
// single fixed cap) or a `(declaredMime) => bytes` function for a config whose cap depends on
// what's being uploaded (video uploads: 100MB vs. photo uploads: 20MB share the same upload
// pipeline/config shape, see upload-service.mjs's photoUploadConfig).
function effectiveHardLimitBytes(config, declaredMime) {
  return typeof config.hardLimitBytes === "function" ? config.hardLimitBytes(declaredMime) : config.hardLimitBytes;
}

export function ticketUploadInfo(core, rawTicket, config) {
  const { table, credentialDomain, unavailableCode, mismatchCode } = config;
  let session = null;
  for (const { keyId, mac } of core.keyring.credentialCandidates(credentialDomain, rawTicket)) {
    session = core.one(`SELECT * FROM ${table} WHERE ticket_key_id=? AND ticket_mac=?`, keyId, mac);
    if (session) break;
  }
  assert(session && ["issued", "committing"].includes(session.status) &&
    Date.parse(session.expires_at) > core.nowMs(), unavailableCode, 404);
  const declared = parseJson(session.declared_metadata_json);
  return { session, declared, hardLimitBytes: effectiveHardLimitBytes(config, declared.mime), mismatchCode, unavailableCode };
}

export async function uploadWithClaim(core, mediaStore, rawTicket, bytes, contentType, config) {
  const body = Buffer.from(bytes);
  const digest = sha256(body);
  const claim = transaction(core.db, () => {
    const info = ticketUploadInfo(core, rawTicket, config);
    const { session, declared } = info;
    assert(body.length <= info.hardLimitBytes, "object_too_large", 413);
    assert(declared.mime === contentType && body.length === Number(declared.bytes), config.mismatchCode, 409);
    const expiredClaim = session.status === "committing" && Date.parse(session.upload_claim_expires_at) <= core.nowMs();
    assert(session.status === "issued" || expiredClaim, config.unavailableCode, 404);
    if (expiredClaim) {
      assert(session.observed_upload_sha256 === digest && session.observed_upload_bytes === body.length &&
        session.observed_upload_mime === contentType, config.mismatchCode, 409);
    }
    const claimId = id("upload_claim");
    const claimExpiresAt = new Date(core.nowMs() + CLAIM_TTL_MS).toISOString();
    const updated = core.db.prepare(`UPDATE ${config.table} SET status='committing',upload_claim_id=?,upload_claim_expires_at=?,
      observed_upload_sha256=?,observed_upload_bytes=?,observed_upload_mime=?,version=version+1
      WHERE id=? AND version=? AND (status='issued' OR (status='committing' AND upload_claim_expires_at<=?))`)
      .run(claimId, claimExpiresAt, digest, body.length, contentType, session.id, session.version, core.now());
    assert(updated.changes === 1, config.unavailableCode, 404);
    return { ...info, claimId, claimedVersion: session.version + 1, digest };
  });

  try {
    const stored = await mediaStore.putIfAbsent(claim.session.exact_private_object_key, body,
      { contentType, maxBytes: claim.hardLimitBytes });
    assert(stored.created || stored.etag === claim.digest, config.mismatchCode, 409);
    return transaction(core.db, () => {
      const current = core.one(`SELECT * FROM ${config.table} WHERE id=?`, claim.session.id);
      assert(current?.status === "committing" && current.upload_claim_id === claim.claimId &&
        current.version === claim.claimedVersion, config.unavailableCode, 404);
      const updated = core.db.prepare(`UPDATE ${config.table} SET status='uploaded',ticket_mac=NULL,
        upload_claim_id=NULL,upload_claim_expires_at=NULL,observed_upload_etag=?,version=version+1
        WHERE id=? AND version=? AND status='committing' AND upload_claim_id=?`)
        .run(stored.etag, current.id, current.version, claim.claimId);
      assert(updated.changes === 1, config.unavailableCode, 404);
      return { uploaded: true, uploadSessionId: current.id, exactPrivateObjectKey: current.exact_private_object_key,
        observedSha256: claim.digest, observedBytes: body.length, observedETag: stored.etag,
        uploadSessionVersion: current.version + 1 };
    });
  } catch (error) {
    const head = await mediaStore.head(claim.session.exact_private_object_key).catch(() => ({ exists: false }));
    if (!head.exists) transaction(core.db, () => {
      core.db.prepare(`UPDATE ${config.table} SET status='issued',upload_claim_id=NULL,upload_claim_expires_at=NULL,
        observed_upload_sha256=NULL,observed_upload_bytes=NULL,observed_upload_mime=NULL,version=version+1
        WHERE id=? AND status='committing' AND upload_claim_id=?`).run(claim.session.id, claim.claimId);
    });
    throw error;
  }
}
