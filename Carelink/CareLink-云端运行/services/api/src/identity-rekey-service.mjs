import { reencryptPersonalMemories } from "./personal-memory-service.mjs";
import { reencryptRecoveryRequests } from "./password-recovery-service.mjs";
import { ApiError, assert } from "./errors.mjs";
import { transaction } from "./database.mjs";
import { IDENTITY_ENVELOPE_FORMAT, identityEnvelopeAad, normalizeEmail } from "./crypto.mjs";
import { id } from "./util.mjs";

const SERVICE_IDENTITY = "identity_rekey_service";
const LEASE_MS = 60_000;

function result(count, fromEpoch, toEpoch) {
  return { examined: count, staged: count, switched: count, verified: count, fromEpoch, toEpoch };
}

export class IdentityRekeyService {
  constructor(core) {
    this.core = core;
    this.db = core.db;
  }

  run(input) {
    const { fromCollisionKeyEpoch, toCollisionKeyEpoch, leaseId, ...extra } = input ?? {};
    assert(Object.keys(extra).length === 0 && typeof fromCollisionKeyEpoch === "string" &&
      typeof toCollisionKeyEpoch === "string" && fromCollisionKeyEpoch !== toCollisionKeyEpoch &&
      typeof leaseId === "string" && leaseId.length >= 8 && leaseId.length <= 200,
    "identity_rekey_storage_unavailable", 409);
    const completed = this.core.one(`SELECT * FROM identity_rekey_operations
      WHERE from_collision_key_epoch=? AND to_collision_key_epoch=? AND lease_id=? AND status='completed'`,
    fromCollisionKeyEpoch, toCollisionKeyEpoch, leaseId);
    if (completed) {
      // A completed identity operation from an older build may still have private snapshots
      // on its source key. Replaying that operation upgrades those references safely too.
      transaction(this.db, () => {
        reencryptPersonalMemories(this.db, this.core.keyring, fromCollisionKeyEpoch, toCollisionKeyEpoch);
        reencryptRecoveryRequests(this.db, this.core.keyring, fromCollisionKeyEpoch, toCollisionKeyEpoch);
      });
      return result(completed.row_count, completed.from_collision_key_epoch, completed.to_collision_key_epoch);
    }

    try {
      return transaction(this.db, () => {
        const replay = this.core.one(`SELECT * FROM identity_rekey_operations
          WHERE from_collision_key_epoch=? AND to_collision_key_epoch=? AND lease_id=?`,
        fromCollisionKeyEpoch, toCollisionKeyEpoch, leaseId);
        if (replay?.status === "completed") return result(replay.row_count, replay.from_collision_key_epoch,
          replay.to_collision_key_epoch);
        assert(!replay, "identity_rekey_storage_unavailable", 409);
        assert(this.core.keyring.keysets.has(fromCollisionKeyEpoch) &&
          this.core.keyring.keysets.has(toCollisionKeyEpoch), "identity_rekey_envelope_unavailable", 503);

        const now = this.core.now();
        const lease = this.core.one("SELECT * FROM identity_namespace_leases WHERE namespace='email_v1'");
        if (lease) {
          assert(lease.lease_id === leaseId || Date.parse(lease.expires_at) <= this.core.nowMs(),
            "identity_rekey_lease_lost", 409);
          this.db.prepare(`UPDATE identity_namespace_leases SET lease_id=?,owner_identity=?,expires_at=?,version=version+1
            WHERE namespace='email_v1' AND version=?`).run(leaseId, SERVICE_IDENTITY,
          new Date(this.core.nowMs() + LEASE_MS).toISOString(), lease.version);
        } else {
          this.db.prepare(`INSERT INTO identity_namespace_leases(namespace,lease_id,owner_identity,expires_at,version)
            VALUES('email_v1',?,?,?,1)`).run(leaseId, SERVICE_IDENTITY,
          new Date(this.core.nowMs() + LEASE_MS).toISOString());
        }

        const operationId = id("identity_rekey");
        this.db.prepare(`INSERT INTO identity_rekey_operations(
          id,from_collision_key_epoch,to_collision_key_epoch,lease_id,status,created_at,version
        ) VALUES(?,?,?,?,'in_progress',?,1)`).run(operationId, fromCollisionKeyEpoch,
        toCollisionKeyEpoch, leaseId, now);
        const equivalences = this.core.all(`SELECT * FROM identifier_equivalences
          WHERE identity_type='email_v1' AND status='active' ORDER BY id`);
        assert(equivalences.every((row) => row.collision_key_epoch === fromCollisionKeyEpoch),
          "identity_rekey_count_mismatch", 409);

        for (const row of equivalences) {
          assert(row.normalized_identifier_ciphertext && row.normalized_identifier_envelope_key_id &&
            row.normalized_identifier_envelope_format === IDENTITY_ENVELOPE_FORMAT,
          "identity_rekey_envelope_unavailable", 503);
          const normalized = normalizeEmail(this.core.keyring.openIdentity(row.normalized_identifier_ciphertext,
            identityEnvelopeAad(row.id, row.identity_type, row.normalized_identifier_envelope_format),
            row.normalized_identifier_envelope_key_id));
          assert(this.core.keyring.equal(row.normalized_collision_key,
            this.core.keyring.equivalentEmailForKey(normalized, fromCollisionKeyEpoch)),
          "identity_rekey_decrypt_failed", 409);
          const nextCollision = this.core.keyring.equivalentEmailForKey(normalized, toCollisionKeyEpoch);
          const nextCiphertext = this.core.keyring.sealIdentity(normalized,
            identityEnvelopeAad(row.id, row.identity_type, IDENTITY_ENVELOPE_FORMAT), toCollisionKeyEpoch);
          try {
            this.db.prepare(`INSERT INTO identity_equivalence_rekey_stage(
              operation_id,equivalence_id,new_collision_key,new_collision_key_epoch,new_identifier_ciphertext,
              new_identifier_envelope_key_id,new_identifier_envelope_format
            ) VALUES(?,?,?,?,?,?,?)`).run(operationId, row.id, nextCollision, toCollisionKeyEpoch,
            nextCiphertext, toCollisionKeyEpoch, IDENTITY_ENVELOPE_FORMAT);
          } catch (error) {
            if (/UNIQUE|constraint/i.test(String(error?.message))) throw new ApiError("identity_rekey_collision", 409);
            throw error;
          }
        }

        const staged = this.core.one("SELECT COUNT(*) count FROM identity_equivalence_rekey_stage WHERE operation_id=?",
          operationId).count;
        const invalidBindings = this.core.one(`SELECT COUNT(*) count FROM account_verified_identifiers v
          LEFT JOIN identifier_equivalences e ON e.id=v.identifier_equivalence_id AND e.status='active'
          WHERE v.status='active' AND e.id IS NULL`).count;
        assert(staged === equivalences.length && invalidBindings === 0, "identity_rekey_count_mismatch", 409);
        const currentLease = this.core.one("SELECT * FROM identity_namespace_leases WHERE namespace='email_v1'");
        assert(currentLease?.lease_id === leaseId && currentLease.owner_identity === SERVICE_IDENTITY &&
          Date.parse(currentLease.expires_at) > this.core.nowMs(), "identity_rekey_lease_lost", 409);

        let changed = 0;
        for (const row of equivalences) {
          const stage = this.core.one(`SELECT * FROM identity_equivalence_rekey_stage
            WHERE operation_id=? AND equivalence_id=?`, operationId, row.id);
          const updated = this.db.prepare(`UPDATE identifier_equivalences SET normalized_collision_key=?,
            collision_key_epoch=?,normalized_identifier_ciphertext=?,normalized_identifier_envelope_key_id=?,
            normalized_identifier_envelope_format=?,version=version+1
            WHERE id=? AND version=? AND collision_key_epoch=? AND status='active'`).run(
          stage.new_collision_key, stage.new_collision_key_epoch, stage.new_identifier_ciphertext,
          stage.new_identifier_envelope_key_id, stage.new_identifier_envelope_format, row.id, row.version,
          fromCollisionKeyEpoch);
          changed += updated.changes;
        }
        assert(changed === equivalences.length, "identity_rekey_count_mismatch", 409);
        reencryptPersonalMemories(this.db, this.core.keyring, fromCollisionKeyEpoch, toCollisionKeyEpoch);
        reencryptRecoveryRequests(this.db, this.core.keyring, fromCollisionKeyEpoch, toCollisionKeyEpoch);
        this.db.prepare(`UPDATE identity_rekey_operations SET status='completed',row_count=?,completed_at=?,version=version+1
          WHERE id=? AND status='in_progress'`).run(changed, this.core.now(), operationId);
        this.db.prepare("DELETE FROM identity_equivalence_rekey_stage WHERE operation_id=?").run(operationId);
        this.db.prepare("DELETE FROM identity_namespace_leases WHERE namespace='email_v1' AND lease_id=?").run(leaseId);
        return result(changed, fromCollisionKeyEpoch, toCollisionKeyEpoch);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("identity_rekey_storage_unavailable", 503);
    }
  }
}
