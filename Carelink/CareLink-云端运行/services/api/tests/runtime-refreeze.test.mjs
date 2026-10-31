import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalKeyring } from "../src/crypto.mjs";
import { openDatabase } from "../src/database.mjs";
import { DeterministicLocatorFixture } from "../src/ports/locator/deterministic-locator-fixture.mjs";
import { registerBookLabExtension } from "../src/extensions/index.mjs";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createAccountUpload, fixture, png } from "./fixture-factory.mjs";

const keyNames = ["credentialKey", "identifierKey", "equivalenceKey", "identityEnvelopeKey", "otpKey", "envelopeKey"];
const keyset = (keyId) => ({ keyId,
  ...Object.fromEntries(keyNames.map((name) => [name, randomBytes(32)])) });

function databaseThrough0005(filename) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (let index = 1; index <= 5; index += 1) {
    const prefix = String(index).padStart(4, "0");
    const migration = [
      "0001_canonical_core", "0002_media_claims_and_capabilities",
      "0003_content_case_composite_foreign_keys", "0004_rate_limits_and_active_panorama",
      "0005_case_admission_and_deletion_leases"
    ][index - 1];
    assert.ok(migration.startsWith(prefix));
    db.exec(readFileSync(new URL(`../db/migrations/${migration}.sql`, import.meta.url), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)")
      .run(migration, "2026-01-01T00:00:00.000Z");
  }
  return db;
}

function databaseThrough0006(filename) {
  const db = databaseThrough0005(filename);
  const migration = "0006_runtime_refreeze";
  db.exec(readFileSync(new URL(`../db/migrations/${migration}.sql`, import.meta.url), "utf8"));
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)")
    .run(migration, "2026-01-01T00:00:00.000Z");
  return db;
}

async function activatePanorama(f, owner, space) {
  const bytes = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "locator-fixture-panorama"
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: "locator-fixture-panorama-commit" },
    { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(before.version) });
  return { ...space, version: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version };
}

test("identity namespace rekey stages the full table, switches atomically, replays without writes, and rolls back bad AAD", async () => {
  const epochA = keyset("identity-epoch-a");
  const f = fixture({ keyring: new LocalKeyring({ current: epochA }) });
  try {
    const first = await f.login("full-rekey-a@example.test");
    const second = await f.login("full-rekey-b@example.test");
    const before = f.db.prepare("SELECT id,version FROM identifier_equivalences ORDER BY id").all();
    const epochB = keyset("identity-epoch-b");
    const rotated = new LocalKeyring({ current: epochB, previous: [epochA] });
    f.api.keyring = rotated;
    f.api.core.keyring = rotated;
    f.api.identity.keyring = rotated;
    const migrated = f.api.identityRekey.run({ fromCollisionKeyEpoch: epochA.keyId,
      toCollisionKeyEpoch: epochB.keyId, leaseId: "identity-full-table-lease-b" });
    assert.deepEqual(migrated, { examined: 2, staged: 2, switched: 2, verified: 2,
      fromEpoch: epochA.keyId, toEpoch: epochB.keyId });
    assert.deepEqual(f.db.prepare("SELECT collision_key_epoch epoch,COUNT(*) count FROM identifier_equivalences GROUP BY 1")
      .all().map((row) => ({ ...row })), [{ epoch: epochB.keyId, count: 2 }]);
    assert.ok(f.db.prepare(`SELECT * FROM identifier_equivalences`).all().every((row) =>
      row.normalized_identifier_ciphertext && row.normalized_identifier_envelope_key_id === epochB.keyId));
    const changes = f.db.prepare("SELECT total_changes() count").get().count;
    const replay = f.api.identityRekey.run({ fromCollisionKeyEpoch: epochA.keyId,
      toCollisionKeyEpoch: epochB.keyId, leaseId: "identity-full-table-lease-b" });
    assert.deepEqual(replay, migrated);
    assert.equal(f.db.prepare("SELECT total_changes() count").get().count, changes);
    assert.equal((await f.login("full-rekey-a@example.test")).accountId, first.accountId);
    assert.equal((await f.login("full-rekey-b@example.test")).accountId, second.accountId);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM accounts").get().count, 2);

    const epochC = keyset("identity-epoch-c");
    const next = new LocalKeyring({ current: epochC, previous: [epochB] });
    f.api.keyring = next;
    f.api.core.keyring = next;
    f.api.identity.keyring = next;
    const victim = f.db.prepare("SELECT * FROM identifier_equivalences ORDER BY id LIMIT 1").get();
    f.db.prepare("UPDATE identifier_equivalences SET normalized_identifier_ciphertext='broken' WHERE id=?")
      .run(victim.id);
    const snapshot = f.db.prepare(`SELECT id,collision_key_epoch,normalized_collision_key,version
      FROM identifier_equivalences ORDER BY id`).all();
    assert.throws(() => f.api.identityRekey.run({ fromCollisionKeyEpoch: epochB.keyId,
      toCollisionKeyEpoch: epochC.keyId, leaseId: "identity-full-table-lease-c" }),
    (error) => error.code === "identity_rekey_decrypt_failed");
    assert.deepEqual(f.db.prepare(`SELECT id,collision_key_epoch,normalized_collision_key,version
      FROM identifier_equivalences ORDER BY id`).all(), snapshot);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM identity_equivalence_rekey_stage").get().count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM identity_namespace_leases").get().count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM accounts").get().count, 2);
    assert.deepEqual(before.map((row) => row.id).sort(), snapshot.map((row) => row.id).sort());
  } finally { f.close(); }
});

test("0006 upgrades an applied 0005 schema, removes the private actor shape, and fails closed on unrecoverable provenance", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-runtime-migration-"));
  try {
    const cleanPath = path.join(directory, "clean.sqlite");
    const before = databaseThrough0005(cleanPath);
    assert.ok(before.prepare("PRAGMA table_info(content_cases)").all()
      .some((column) => column.name === "actor_deleted_account_hash"));
    before.close();
    const upgraded = openDatabase(cleanPath);
    assert.equal(upgraded.prepare("PRAGMA table_info(content_cases)").all()
      .some((column) => column.name === "actor_deleted_account_hash"), false);
    assert.equal(upgraded.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE version='0006_runtime_refreeze'")
      .get().count, 1);
    assert.equal(upgraded.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='trigger'
      AND name IN ('panorama_revisions_stable_fields_immutable','panorama_revisions_immutable_delete')`).get().count, 2);
    upgraded.close();

    const blockedPath = path.join(directory, "blocked.sqlite");
    const legacy = databaseThrough0005(blockedPath);
    legacy.prepare(`INSERT INTO content_cases(
      id,case_type,target_type,actor_relation_kind,actor_deleted_account_hash,category,status,created_at,version
    ) VALUES('legacy_deleted_case','support','none','deleted_account','irreversible','help','open',?,1)`)
      .run("2026-01-01T00:00:00.000Z");
    legacy.close();
    assert.throws(() => openDatabase(blockedPath), /CHECK constraint failed/);
    const afterFailure = new DatabaseSync(blockedPath);
    assert.equal(afterFailure.prepare("SELECT COUNT(*) count FROM content_cases WHERE id='legacy_deleted_case'").get().count, 1);
    assert.equal(afterFailure.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE version='0006_runtime_refreeze'")
      .get().count, 0);
    afterFailure.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0007 preserves legacy null envelopes but every new equivalence requires all three envelope fields", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-identity-envelope-migration-"));
  const database = path.join(directory, "identity.sqlite");
  try {
    const legacy = databaseThrough0006(database);
    legacy.prepare(`INSERT INTO identifier_equivalences(
      id,normalized_collision_key,collision_key_epoch,status,version,created_at
    ) VALUES('legacy_null_envelope',?,'legacy-epoch','active',1,?)`)
      .run(Buffer.from("legacy-null"), "2026-01-01T00:00:00.000Z");
    legacy.close();

    const upgraded = openDatabase(database);
    upgraded.prepare("UPDATE identifier_equivalences SET version=version+1 WHERE id='legacy_null_envelope'").run();
    const retained = upgraded.prepare("SELECT * FROM identifier_equivalences WHERE id='legacy_null_envelope'").get();
    assert.equal(retained.version, 2);
    assert.equal(retained.normalized_identifier_ciphertext, null);
    assert.throws(() => upgraded.prepare(`INSERT INTO identifier_equivalences(
      id,normalized_collision_key,collision_key_epoch,status,version,created_at
    ) VALUES('new_null_envelope',?,'new-epoch','active',1,?)`)
      .run(Buffer.from("new-null"), "2026-01-01T00:00:00.000Z"),
    /new identifier equivalence requires complete envelope/);
    assert.throws(() => upgraded.prepare(`INSERT INTO identifier_equivalences(
      id,normalized_collision_key,collision_key_epoch,status,version,created_at,
      normalized_identifier_ciphertext
    ) VALUES('new_partial_envelope',?,'new-epoch','active',1,?,'ciphertext-only')`)
      .run(Buffer.from("new-partial"), "2026-01-01T00:00:00.000Z"),
    /new identifier equivalence requires complete envelope/);
    assert.throws(() => upgraded.prepare(`UPDATE identifier_equivalences
      SET normalized_identifier_ciphertext='partial' WHERE id='legacy_null_envelope'`).run(),
    /identifier envelope fields must be all present or all absent/);
    upgraded.prepare(`INSERT INTO identifier_equivalences(
      id,normalized_collision_key,collision_key_epoch,status,version,created_at,
      normalized_identifier_ciphertext,normalized_identifier_envelope_key_id,normalized_identifier_envelope_format
    ) VALUES('new_complete_envelope',?,'new-epoch','active',1,?,'ciphertext','key-id','format')`)
      .run(Buffer.from("new-complete"), "2026-01-01T00:00:00.000Z");
    assert.equal(upgraded.prepare("SELECT COUNT(*) count FROM identifier_equivalences").get().count, 2);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("OTP server-risk admission runs before identity, alias, challenge, sink, and idempotency durable writes", async () => {
  const f = fixture();
  try {
    const responses = [];
    for (let index = 0; index < 100; index += 1) {
      responses.push(await f.call("POST", "/v1/auth/email-otp-challenges",
        { email: `risk-pre-gate-${index}@example.test`, purpose: "login" },
        { "idempotency-key": `risk-pre-gate-${index}-abcdefgh` }));
    }
    assert.ok(responses.every((response) => response.status === 200 && response.body.accepted === true));
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM identifier_equivalences").get().count, 20);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM account_verified_identifier_aliases").get().count, 20);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM email_otp_challenges").get().count, 20);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM idempotency_records WHERE canonical_endpoint='/v1/auth/email-otp-challenges'")
      .get().count, 20);
    assert.equal(f.otp.length, 20);
    assert.deepEqual(f.db.prepare(`SELECT count FROM otp_issuance_rate_counters WHERE scope_kind='server_risk'`)
      .all().map((row) => ({ ...row })),
      [{ count: 20 }]);
  } finally { f.close(); }
});

test("support exact-key rejection returns unsupported_field before every durable write", async () => {
  const f = fixture();
  try {
    const before = f.db.prepare("SELECT total_changes() count").get().count;
    for (const [index, extra] of ["contact", "targetObjectId", "photoId", "spaceId", "unexpected"].entries()) {
      const response = await f.call("POST", "/v1/support-cases",
        { category: "help", description: "valid text", [extra]: "must-not-persist" },
        { "idempotency-key": `support-exact-reject-${index}-abcdefgh` });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "unsupported_field");
      assert.equal(f.db.prepare("SELECT total_changes() count").get().count, before);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM content_cases").get().count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM case_admission_counters").get().count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM case_access_sessions").get().count, 0);
  } finally { f.close(); }
});

test("deterministic locator fixture is explicit, normal-entry, policy-bound, and covers high uncertain failed plus retry", async () => {
  const locator = new DeterministicLocatorFixture({ enabled: true });
  const f = fixture({ locatorFixture: locator });
  try {
    const owner = await f.login("locator-fixture@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const immutableRevision = f.db.prepare(`SELECT r.* FROM panorama_revisions r
      JOIN spaces s ON s.current_panorama_revision_id=r.id WHERE s.id=?`).get(space.spaceId);
    assert.throws(() => f.db.prepare("UPDATE panorama_revisions SET created_by='forged' WHERE id=?")
      .run(immutableRevision.id), /panorama revision stable fields are immutable/);
    assert.equal(f.db.prepare("SELECT created_by FROM panorama_revisions WHERE id=?")
      .get(immutableRevision.id).created_by, immutableRevision.created_by);

    const highFlow = await createAccountUpload(f, owner, space);
    const highValidation = dispatchOne(f.db, highFlow.committed.jobId,
      { now: f.clock.iso(), locatorFixture: locator });
    const highJob = f.db.prepare("SELECT * FROM jobs WHERE id=?").get(highValidation.placementJobId);
    const highRefs = JSON.parse(highJob.input_refs_json);
    assert.ok(highRefs.policyReleaseId);
    assert.equal(highRefs.policyVersion, 1);
    const high = dispatchOne(f.db, highJob.id,
      { now: f.clock.iso(), locatorFixture: locator, fixtureClassification: "same_scene_high" });
    assert.equal(high.placementState, "confirmed");
    assert.deepEqual(high.locatorProvenance, { mode: "deterministic_local_fixture", isProduction: false,
      policyReleaseId: highRefs.policyReleaseId, policyVersion: 1 });

    const uncertainFlow = await createAccountUpload(f, owner, space);
    const uncertainValidation = dispatchOne(f.db, uncertainFlow.committed.jobId,
      { now: f.clock.iso(), locatorFixture: locator });
    const uncertain = dispatchOne(f.db, uncertainValidation.placementJobId,
      { now: f.clock.iso(), locatorFixture: locator, fixtureClassification: "uncertain" });
    assert.equal(uncertain.placementState, "needs_confirmation");
    assert.equal(uncertain.locatorProvenance.isProduction, false);

    const failedFlow = await createAccountUpload(f, owner, space);
    const failedValidation = dispatchOne(f.db, failedFlow.committed.jobId,
      { now: f.clock.iso(), locatorFixture: locator });
    const failed = dispatchOne(f.db, failedValidation.placementJobId,
      { now: f.clock.iso(), locatorFixture: locator, fixtureClassification: "failed" });
    assert.equal(failed.placementState, "failed");
    const failedPhoto = f.db.prepare("SELECT * FROM photos WHERE id=?").get(failedFlow.committed.photoId);
    const failedItem = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(failedFlow.item.itemId);
    const retry = await f.ok("POST", `/v1/photos/${failedPhoto.id}/placement-actions`, { action: "retry" },
      { ...owner.headers, "if-match": String(failedPhoto.version), "x-item-version": String(failedItem.version),
        "x-placement-authorization-version": String(failedItem.placement_authorization_version) });
    const retryRefs = JSON.parse(f.db.prepare("SELECT input_refs_json FROM jobs WHERE id=?").get(retry.jobId).input_refs_json);
    assert.equal(retryRefs.policyReleaseId, highRefs.policyReleaseId);
    assert.equal(retryRefs.locatorRuntimeMode, "deterministic_local_fixture");
  } finally { f.close(); }
});

test("locator fixture flag off and Book extension flag off have zero mounts, jobs, policy rows, writes, and business imports", async () => {
  const f = fixture();
  try {
    const owner = await f.login("fixture-off@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    const refs = JSON.parse(f.db.prepare("SELECT input_refs_json FROM jobs WHERE id=?")
      .get(validation.placementJobId).input_refs_json);
    assert.equal(refs.policyReleaseId, null);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM algorithm_releases").get().count, 0);
    assert.equal(dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso() }).placementState,
      "needs_confirmation");

    const calls = { routes: 0, jobs: 0, reads: 0, auth: 0, audit: 0 };
    const read = () => { calls.reads += 1; };
    const writes = f.db.prepare("SELECT total_changes() count").get().count;
    const result = registerBookLabExtension({
      registerRoutes: () => { calls.routes += 1; },
      registerInternalJobs: () => { calls.jobs += 1; },
      authenticateBookLabParticipant: read,
      listBookLabEligibleBooks: read,
      readBookLabDisplayPhoto: read,
      readBookLabEventForOwner: read,
      readBookLabOwnerSnapshot: read,
      readBookLabParticipantPhoto: read,
      readBookLabRenderDerivative: read,
      readCorePhotoContext: read,
      readCurrentBookLabOwner: read,
      readCurrentBookLabViewer: read,
      readQuestionSourceForWorker: read,
      revalidateCurrentBookLabOwner: read,
      revalidateCurrentBookLabViewer: read,
      authorizeCorePhotoParticipant: () => { calls.auth += 1; },
      appendAudit: () => { calls.audit += 1; },
      featureFlags: { bookLab: false }
    });
    assert.deepEqual(result, { enabled: false, mountedRoutes: 0, registeredJobs: 0,
      businessWrites: 0, businessBundleImported: false });
    assert.deepEqual(calls, { routes: 0, jobs: 0, reads: 0, auth: 0, audit: 0 });
    assert.equal(f.db.prepare("SELECT total_changes() count").get().count, writes);
  } finally { f.close(); }
});
