import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadLocalKeyring } from "../../services/api/src/crypto.mjs";
import { MEDIA_NOTICE_V2_NOTICE } from "../../services/api/src/media-notice.mjs";
import { FilesystemMediaStore } from "../../services/api/src/ports/media/filesystem-media-store.mjs";
import { fixture } from "../../services/api/tests/fixture-factory.mjs";
import { buildActionBody } from "../../apps/web/src/api/action-request-registry.js";
import { requireCurrentMediaNotice } from "../../apps/web/src/ui/templates.js";

const root = await mkdtemp(path.join(tmpdir(), "unseen-media-consent-upgrade-"));
const database = path.join(root, "unseen.sqlite");
const keyset = path.join(root, "local.keyset.json");
const mediaRoot = path.join(root, "media");
const oldHash = MEDIA_NOTICE_V2_NOTICE.legacyPolicyHash;
const newHash = MEDIA_NOTICE_V2_NOTICE.contentHash;
let first;
let second;

try {
  await mkdir(mediaRoot, { mode: 0o700 });
  first = fixture({ database, keyring: loadLocalKeyring(keyset, { allowCreate: true }),
    mediaStore: new FilesystemMediaStore(mediaRoot) });
  const owner = await first.login("persistent-notice-upgrade@example.test");
  let space = await first.createSpace(owner, "Persistent notice upgrade");
  space = await first.openSpace(owner, space);
  const legacyActor = first.api.core.account(owner.token);
  const legacyConsentId = "consent_legacy_policy_hash";
  first.close();
  first = null;

  const legacy = new DatabaseSync(database);
  legacy.prepare("UPDATE media_notices SET content_hash=? WHERE id=?").run(oldHash, MEDIA_NOTICE_V2_NOTICE.id);
  legacy.prepare(`INSERT INTO consent_events(
    id,space_id,actor_auth_kind,authorization_id,notice_id,notice_version,notice_hash,notice_purpose,accepted_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(legacyConsentId, space.spaceId, legacyActor.authKind,
    legacyActor.authorizationId, MEDIA_NOTICE_V2_NOTICE.id, MEDIA_NOTICE_V2_NOTICE.version, oldHash,
    "photo_upload", "2026-08-13T00:00:01.000Z");
  assert.equal(legacy.prepare("SELECT content_hash FROM media_notices WHERE id=?")
    .get(MEDIA_NOTICE_V2_NOTICE.id).content_hash, oldHash);
  legacy.close();

  second = fixture({ database, keyring: loadLocalKeyring(keyset), mediaStore: new FilesystemMediaStore(mediaRoot) });
  const before = await second.ok("GET", `/v1/spaces/${space.spaceId}/upload-context`, {}, owner.headers);
  assert.equal(before.mediaNotice.hash, newHash);
  assert.equal(before.currentConsent, null);
  assert.equal(before.canCreateBatch, false);
  assert.equal(second.db.prepare("SELECT content_hash FROM media_notices WHERE id=?")
    .get(MEDIA_NOTICE_V2_NOTICE.id).content_hash, newHash);

  const projection = await requireCurrentMediaNotice(before, space.spaceId);
  assert.equal(projection.noticeHash, newHash);
  await assert.rejects(() => requireCurrentMediaNotice({ ...before, noticeHash: newHash }, space.spaceId),
    /media_notice_unavailable/);
  await assert.rejects(() => requireCurrentMediaNotice({ ...before,
    mediaNotice: { ...before.mediaNotice, hash: oldHash } }, space.spaceId), /media_notice_unavailable/);

  const stale = await second.call("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
    clientBatchId: "legacy-consent-must-not-authorize", consentEventId: legacyConsentId, declaredItemCount: 1
  }, owner.headers);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "consent_required");

  const accepted = await second.ok("POST", "/v1/consent-events",
    buildActionBody("UPLOAD.ACCEPT_NOTICE", projection), owner.headers);
  const after = await second.ok("GET", `/v1/spaces/${space.spaceId}/upload-context`, {}, owner.headers);
  assert.equal(after.mediaNotice.hash, newHash);
  assert.equal(after.currentConsent.consentEventId, accepted.consentEventId);
  assert.equal(after.canCreateBatch, true);
  assert.equal((await requireCurrentMediaNotice(after, space.spaceId)).consentEventId, accepted.consentEventId);
  const batch = await second.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
    clientBatchId: "exact-copy-consent-authorizes", consentEventId: accepted.consentEventId, declaredItemCount: 1
  }, owner.headers);
  assert.ok(batch.batchId);

  process.stdout.write(`${JSON.stringify({ schema: "unseen-media-consent-upgrade-verification/1", status: "PASS",
    persistentDatabase: true, legacyNoticeHashMigrated: `${oldHash.slice(0, 8)}… -> ${newHash.slice(0, 8)}…`,
    legacyConsentCurrent: false, productionWebConsumedNestedContext: true,
    wrongNestedAndTopLevelFailClosed: true, exactConsentCurrent: true, exactConsentCreatedBatch: true,
    externalNetworkRequests: 0 })}\n`);
} finally {
  first?.close();
  second?.close();
  await rm(root, { recursive: true, force: true });
}
