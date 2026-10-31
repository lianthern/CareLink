import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, png } from "./fixture-factory.mjs";
import { dispatchAvailable } from "../../jobs/dispatch/index.mjs";
import { FfmpegDecoderRunner } from "../src/ports/media/ffmpeg-decoder-runner.mjs";
import { mimeFromExtension, parseArgs, resolvePhotoPaths, seedDemoSpace, shareExistingSpace } from "../../../tools/seed-demo-space.mjs";

// Same technique as fixture-factory.mjs's png() helper, just sized to satisfy
// media.mjs#inspectMedia's panorama policy: width>=1600, height>=800, width===height*2.
function panoramaPng(width = 1600, height = 800, color = "#446688") {
  const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    `color=c=${color}:s=${width}x${height}:d=0.04`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
  { maxBuffer: 60 * 1024 * 1024, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

// seedDemoSpace()'s panorama step polls panorama-candidate status the same way a real invocation
// against a running server would; nothing drains services/jobs/dispatch/index.mjs's queue on its
// own inside a plain fixture(). This mirrors infra/integration/local-operable.mjs's worker with a
// tight real-timer interval so the poll loop's real setTimeout delays actually interleave with it.
function startBackgroundJobDispatcher(f, intervalMs = 15) {
  const timer = setInterval(() => {
    try { dispatchAvailable(f.db, { now: f.clock.iso() }); } catch { /* races with in-flight commits; next tick retries */ }
  }, intervalMs);
  return () => clearInterval(timer);
}

function writeTempFile(dir, name, bytes) {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, bytes);
  return filePath;
}

test("seedDemoSpace rejects an owner account that does not exist, and never creates one", async () => {
  const f = fixture();
  try {
    const before = f.db.prepare("SELECT COUNT(*) count FROM accounts").get().count;
    await assert.rejects(
      seedDemoSpace(f.api, { ownerAccountId: "acct_does_not_exist", name: "Ghost Space",
        panoramaPath: "/nonexistent/pano.jpg", photoPaths: ["/nonexistent/a.jpg"] }),
      /owner account not found/
    );
    const after = f.db.prepare("SELECT COUNT(*) count FROM accounts").get().count;
    assert.equal(after, before, "seedDemoSpace must never create an account");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM spaces").get().count, 0);
  } finally { f.close(); }
});

test("seedDemoSpace rejects an inactive owner account", async () => {
  const f = fixture();
  try {
    const owner = await f.login("inactive-owner@example.test");
    f.db.prepare("UPDATE accounts SET status='deleted' WHERE id=?").run(owner.accountId);
    await assert.rejects(
      seedDemoSpace(f.api, { ownerAccountId: owner.accountId, name: "X",
        panoramaPath: "/nonexistent/pano.jpg", photoPaths: ["/nonexistent/a.jpg"] }),
      /not active/
    );
  } finally { f.close(); }
});

test("dry-run writes nothing: table row counts are unchanged and no account session is minted", async () => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-dry-"));
  try {
    const owner = await f.login("dry-run-owner@example.test");
    const panoramaPath = writeTempFile(dir, "pano.png", panoramaPng());
    const photoPath = writeTempFile(dir, "photo-1.png", png());

    const tables = ["spaces", "scenes", "photos", "assets", "contribution_batches", "contribution_batch_items",
      "panorama_candidates", "panorama_revisions", "account_sessions", "account_session_families",
      "idempotency_records", "audit_events", "jobs", "consent_events"];
    const snapshot = () => Object.fromEntries(tables.map((t) => [t, f.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
    const before = snapshot();

    const result = await seedDemoSpace({ db: f.db, decoderRunner: new FfmpegDecoderRunner() }, {
      ownerAccountId: owner.accountId, name: "Dry Run Space", description: "预演",
      panoramaPath, photoPaths: [photoPath], dryRun: true
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.owner.accountId, owner.accountId);
    assert.equal(result.space.name, "Dry Run Space");
    assert.equal(result.space.description, "预演");
    assert.equal(result.photos.count, 1);
    // Real inspectMedia() ran even in dry-run -- see the file header -- so the decoded panorama
    // dimensions are already known before anything is written.
    assert.equal(result.panorama.width, 1600);
    assert.equal(result.panorama.height, 800);
    assert.equal(result.notices.space_create, true);
    assert.equal(result.notices.panorama_upload, true);
    assert.equal(result.notices.media_photo_upload, true);
    assert.deepEqual(result.share, { willShare: false });

    const after = snapshot();
    assert.deepEqual(after, before, "dry-run must not change any row counts");
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("dry-run previews --share without creating a campaign or writing anything", async () => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-dry-share-"));
  try {
    const owner = await f.login("dry-run-share-owner@example.test");
    const panoramaPath = writeTempFile(dir, "pano.png", panoramaPng());
    const photoPath = writeTempFile(dir, "photo-1.png", png());
    const before = f.db.prepare("SELECT COUNT(*) c FROM external_invitation_campaigns").get().c;

    const result = await seedDemoSpace({ db: f.db, decoderRunner: new FfmpegDecoderRunner() }, {
      ownerAccountId: owner.accountId, name: "Dry Run Share", panoramaPath, photoPaths: [photoPath],
      dryRun: true, share: true, shareTaskMode: "view", shareExpiresDays: 30, shareMaxUses: 500
    });

    assert.deepEqual(result.share, { willShare: true, taskMode: "view", expiresDays: 30, maxSuccessfulUses: 500,
      note: "the actual /open/<token> URL is only known after a real run -- the token is generated at campaign-creation time" });
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM external_invitation_campaigns").get().c, before);
    assert.equal(f.db.prepare("SELECT sharing_state FROM spaces").all().length, 0);
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("pre-validation rejects an unreadable panorama file before any space is created", async () => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-unreadable-"));
  try {
    const owner = await f.login("unreadable-owner@example.test");
    const panoramaPath = writeTempFile(dir, "pano.png", panoramaPng());
    const photoPath = writeTempFile(dir, "photo-1.png", png());
    chmodSync(panoramaPath, 0o000);
    const before = f.db.prepare("SELECT COUNT(*) c FROM spaces").get().c;

    await assert.rejects(
      seedDemoSpace(f.api, { ownerAccountId: owner.accountId, name: "Should Never Exist",
        panoramaPath, photoPaths: [photoPath] }),
      /panorama file is not readable/
    );

    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM spaces").get().c, before,
      "an unreadable input file must never leave an orphan space behind");
  } finally { chmodSync(dir + "/pano.png", 0o600); f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("pre-validation rejects a non-2:1 panorama before any space is created", async () => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-badratio-"));
  try {
    const owner = await f.login("badratio-owner@example.test");
    // A square image fails media.mjs#inspectMedia's `width === height * 2` panorama policy.
    const panoramaPath = writeTempFile(dir, "pano.png", panoramaPng(1600, 1600));
    const photoPath = writeTempFile(dir, "photo-1.png", png());
    const before = f.db.prepare("SELECT COUNT(*) c FROM spaces").get().c;

    await assert.rejects(
      seedDemoSpace(f.api, { ownerAccountId: owner.accountId, name: "Should Never Exist",
        panoramaPath, photoPaths: [photoPath] }),
      /panorama failed media validation/
    );

    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM spaces").get().c, before);
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a failure after the space already exists reports the spaceId and does not delete it", async () => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-orphan-"));
  try {
    const owner = await f.login("orphan-owner@example.test");
    const panoramaPath = writeTempFile(dir, "pano.png", panoramaPng());
    const photoPath = writeTempFile(dir, "photo-1.png", png());
    const before = f.db.prepare("SELECT COUNT(*) c FROM spaces").get().c;

    // No background job dispatcher is running in this test, so the panorama candidate can never
    // reach 'ready' -- this deliberately reproduces "space created, then a later step fails".
    let caught = null;
    try {
      await seedDemoSpace(f.api, { ownerAccountId: owner.accountId, name: "Orphan After Panorama",
        panoramaPath, photoPaths: [photoPath], panoramaPollIntervalMs: 5, panoramaTimeoutMs: 30 });
    } catch (error) { caught = error; }

    assert.ok(caught, "expected the panorama wait to time out");
    assert.match(caught.message, /did not become ready/);
    assert.match(caught.message, /needs manual follow-up/);
    assert.match(caught.message, /never auto-deletes spaces/);
    assert.ok(caught.spaceId, "the error must carry the created spaceId for manual cleanup");

    const after = f.db.prepare("SELECT COUNT(*) c FROM spaces").get().c;
    assert.equal(after, before + 1, "the space must still exist -- this script never deletes on failure");
    const space = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(caught.spaceId);
    assert.ok(space, "the spaceId in the error must resolve to a real row");
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("--share transitions sharing_state to shared and creates a working /open/<token> campaign link", async () => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-share-"));
  const stopDispatcher = startBackgroundJobDispatcher(f);
  try {
    const owner = await f.login("share-owner@example.test");
    const panoramaPath = writeTempFile(dir, "pano.png", panoramaPng());
    const photoPath = writeTempFile(dir, "photo-1.png", png());

    const result = await seedDemoSpace(f.api, {
      ownerAccountId: owner.accountId, name: "Shareable Space", panoramaPath, photoPaths: [photoPath],
      panoramaPollIntervalMs: 15, panoramaTimeoutMs: 5000,
      share: true, shareTaskMode: "view", shareExpiresDays: 30, shareMaxUses: 1000
    });

    assert.ok(result.share);
    assert.equal(result.share.sharingState, "shared");
    assert.equal(result.share.taskMode, "view");
    assert.equal(result.share.maxSuccessfulUses, 1000);
    assert.match(result.share.publicCampaignUrl, /^http:\/\/127\.0\.0\.1:8787\/open\/.+/);
    assert.equal(result.share.qrPayload, result.share.publicCampaignUrl);

    const space = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(result.spaceId);
    assert.equal(space.sharing_state, "shared");
    assert.equal(space.version, result.spaceVersion);

    const campaign = f.db.prepare("SELECT * FROM external_invitation_campaigns WHERE space_id=?").get(result.spaceId);
    assert.ok(campaign);
    assert.equal(campaign.task_mode, "view");
    assert.equal(campaign.campaign_status, "active");
    assert.equal(`http://127.0.0.1:8787/open/${campaign.public_campaign_id}`, result.share.publicCampaignUrl);
  } finally { stopDispatcher(); f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("without --share, sharing_state is left private exactly as before", async () => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-noshare-"));
  const stopDispatcher = startBackgroundJobDispatcher(f);
  try {
    const owner = await f.login("noshare-owner@example.test");
    const panoramaPath = writeTempFile(dir, "pano.png", panoramaPng());
    const photoPath = writeTempFile(dir, "photo-1.png", png());

    const result = await seedDemoSpace(f.api, { ownerAccountId: owner.accountId, name: "Private Space",
      panoramaPath, photoPaths: [photoPath], panoramaPollIntervalMs: 15, panoramaTimeoutMs: 5000 });

    assert.equal(result.share, null);
    const space = f.db.prepare("SELECT sharing_state FROM spaces WHERE id=?").get(result.spaceId);
    assert.equal(space.sharing_state, "private");
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM external_invitation_campaigns WHERE space_id=?").get(result.spaceId).c, 0);
  } finally { stopDispatcher(); f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("shareExistingSpace rejects an owner account that does not exist, without writing anything", async () => {
  const f = fixture();
  try {
    const owner = await f.login("share-existing-real-owner@example.test");
    const space = await f.createSpace(owner);
    await assert.rejects(
      shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: "acct_does_not_exist" }),
      /owner account not found/
    );
    assert.equal(f.db.prepare("SELECT sharing_state FROM spaces WHERE id=?").get(space.spaceId).sharing_state, "private");
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM external_invitation_campaigns").get().c, 0);
  } finally { f.close(); }
});

test("shareExistingSpace rejects a spaceId that does not exist", async () => {
  const f = fixture();
  try {
    const owner = await f.login("share-existing-nospace-owner@example.test");
    await assert.rejects(
      shareExistingSpace(f.api, { spaceId: "space_does_not_exist", ownerAccountId: owner.accountId }),
      /space not found/
    );
  } finally { f.close(); }
});

test("shareExistingSpace rejects a space owned by a different account", async () => {
  const f = fixture();
  try {
    const realOwner = await f.login("share-existing-owner-a@example.test");
    const impostor = await f.login("share-existing-owner-b@example.test");
    const space = await f.createSpace(realOwner);
    await assert.rejects(
      shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: impostor.accountId }),
      /is not owned by/
    );
    assert.equal(f.db.prepare("SELECT sharing_state FROM spaces WHERE id=?").get(space.spaceId).sharing_state, "private");
  } finally { f.close(); }
});

test("shareExistingSpace rejects an archived space", async () => {
  const f = fixture();
  try {
    const owner = await f.login("share-existing-archived-owner@example.test");
    const space = await f.createSpace(owner);
    f.db.prepare("UPDATE spaces SET space_lifecycle='archived' WHERE id=?").run(space.spaceId);
    await assert.rejects(
      shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: owner.accountId }),
      /not active/
    );
  } finally { f.close(); }
});

test("shareExistingSpace dry-run writes nothing and previews the transition", async () => {
  const f = fixture();
  try {
    const owner = await f.login("share-existing-dry-owner@example.test");
    const space = await f.createSpace(owner);
    const before = f.db.prepare("SELECT COUNT(*) c FROM account_sessions").get().c;

    const result = await shareExistingSpace({ db: f.db }, { spaceId: space.spaceId, ownerAccountId: owner.accountId,
      dryRun: true, publicOrigin: "https://unseen.maxxam.xyz" });

    assert.equal(result.dryRun, true);
    assert.equal(result.willTransitionSharing, true);
    assert.equal(result.share.willReuseExistingCampaign, false);
    assert.equal(result.space.sharingState, "private");

    assert.equal(f.db.prepare("SELECT sharing_state FROM spaces WHERE id=?").get(space.spaceId).sharing_state, "private");
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM external_invitation_campaigns").get().c, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM account_sessions").get().c, before,
      "dry-run must not mint an account session either");
  } finally { f.close(); }
});

test("shareExistingSpace on a private space transitions it to shared and creates a view campaign", async () => {
  const f = fixture();
  try {
    const owner = await f.login("share-existing-private-owner@example.test");
    const space = await f.createSpace(owner);

    const result = await shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: owner.accountId,
      shareTaskMode: "view", shareExpiresDays: 30, shareMaxUses: 1000 });

    assert.equal(result.dryRun, false);
    assert.equal(result.sharingState, "shared");
    assert.equal(result.reusedExistingCampaign, false);
    assert.match(result.share.publicCampaignUrl, /^http:\/\/127\.0\.0\.1:8787\/open\/.+/);

    const spaceRow = f.db.prepare("SELECT sharing_state,version FROM spaces WHERE id=?").get(space.spaceId);
    assert.equal(spaceRow.sharing_state, "shared");
    assert.equal(spaceRow.version, result.spaceVersion);
    const campaign = f.db.prepare("SELECT * FROM external_invitation_campaigns WHERE space_id=?").get(space.spaceId);
    assert.equal(campaign.task_mode, "view");
    assert.equal(campaign.campaign_status, "active");
    assert.equal(`http://127.0.0.1:8787/open/${campaign.public_campaign_id}`, result.share.publicCampaignUrl);
  } finally { f.close(); }
});

test("shareExistingSpace is a fully idempotent no-op on a second run: same link, no new campaign, no new session", async () => {
  const f = fixture();
  try {
    const owner = await f.login("share-existing-idempotent-owner@example.test");
    const space = await f.createSpace(owner);

    const first = await shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: owner.accountId });
    const sessionsAfterFirst = f.db.prepare("SELECT COUNT(*) c FROM account_sessions WHERE account_id=?").get(owner.accountId).c;
    const campaignsAfterFirst = f.db.prepare("SELECT COUNT(*) c FROM external_invitation_campaigns").get().c;

    const second = await shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: owner.accountId });

    assert.equal(second.sharingState, "shared");
    assert.equal(second.reusedExistingCampaign, true);
    assert.equal(second.share.campaignId, first.share.campaignId);
    assert.equal(second.share.publicCampaignUrl, first.share.publicCampaignUrl);
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM external_invitation_campaigns").get().c, campaignsAfterFirst,
      "re-running must not create a second campaign");
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM account_sessions WHERE account_id=?").get(owner.accountId).c, sessionsAfterFirst,
      "a fully idempotent no-op must not mint a fresh account session either");
  } finally { f.close(); }
});

test("shareExistingSpace on an already-shared space with a different --share-task-mode creates a second, distinct campaign", async () => {
  const f = fixture();
  try {
    const owner = await f.login("share-existing-retask-owner@example.test");
    const space = await f.createSpace(owner);

    const viewShare = await shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: owner.accountId, shareTaskMode: "view" });
    // 'combo' also grants upload, which CampaignService#create() only allows once collection_state
    // is 'open' -- shareExistingSpace() itself never touches collection_state (see file header), so
    // this test opens it directly, the same way this fixture's own openSpace() helper would.
    const currentVersion = f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version;
    await f.transition(owner, space.spaceId, "collection", "open", currentVersion);
    const comboShare = await shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: owner.accountId, shareTaskMode: "combo" });

    assert.equal(comboShare.sharingState, "shared");
    assert.equal(comboShare.reusedExistingCampaign, false, "a 'view' campaign is not a substitute for 'combo'");
    assert.notEqual(comboShare.share.campaignId, viewShare.share.campaignId);
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM external_invitation_campaigns WHERE space_id=?").get(space.spaceId).c, 2);
  } finally { f.close(); }
});

test("shareExistingSpace gives a clear error for an upload-capable task mode when collection isn't open", async () => {
  const f = fixture();
  try {
    const owner = await f.login("share-existing-collection-closed-owner@example.test");
    const space = await f.createSpace(owner);

    await assert.rejects(
      shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: owner.accountId, shareTaskMode: "combo" }),
      /collection_state is 'paused', not 'open'/
    );
    // Also verified from dry-run, without minting a session or writing anything.
    const before = f.db.prepare("SELECT COUNT(*) c FROM account_sessions").get().c;
    await assert.rejects(
      shareExistingSpace({ db: f.db }, { spaceId: space.spaceId, ownerAccountId: owner.accountId, shareTaskMode: "upload", dryRun: true }),
      /collection_state is 'paused', not 'open'/
    );
    assert.equal(f.db.prepare("SELECT sharing_state FROM spaces WHERE id=?").get(space.spaceId).sharing_state, "private");
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM account_sessions").get().c, before);
  } finally { f.close(); }
});

test("shareExistingSpace does not reuse an expired campaign", async () => {
  const f = fixture();
  try {
    const owner = await f.login("share-existing-expired-owner@example.test");
    const space = await f.createSpace(owner);

    const firstShare = await shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: owner.accountId });
    f.db.prepare("UPDATE external_invitation_campaigns SET expires_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", firstShare.share.campaignId);

    const secondShare = await shareExistingSpace(f.api, { spaceId: space.spaceId, ownerAccountId: owner.accountId });

    assert.equal(secondShare.reusedExistingCampaign, false);
    assert.notEqual(secondShare.share.campaignId, firstShare.share.campaignId);
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM external_invitation_campaigns WHERE space_id=?").get(space.spaceId).c, 2);
  } finally { f.close(); }
});

test("end-to-end: creates the space, activates the panorama, and commits every photo through the real pipeline", async () => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-e2e-"));
  const stopDispatcher = startBackgroundJobDispatcher(f);
  try {
    const owner = await f.login("demo-owner@example.test");
    const panoramaPath = writeTempFile(dir, "pano.png", panoramaPng());
    const photoPaths = [
      writeTempFile(dir, "photo-1.png", png(32, 16, "#112233")),
      writeTempFile(dir, "photo-2.png", png(32, 16, "#332211")),
      writeTempFile(dir, "photo-3.png", png(32, 16, "#556677"))
    ];

    const result = await seedDemoSpace(f.api, {
      ownerAccountId: owner.accountId, name: "AdventureX 2026 现场", description: "test",
      panoramaPath, photoPaths, panoramaPollIntervalMs: 20, panoramaTimeoutMs: 5000
    });

    assert.equal(result.dryRun, false);
    assert.ok(result.spaceId);
    assert.equal(result.photos.requested, 3);
    assert.equal(result.photos.committed, 3);
    assert.equal(result.photos.failed, 0);
    assert.equal(result.photos.photoIds.length, 3);
    assert.ok(result.panorama.panoramaRevisionId);
    assert.equal(result.panorama.width, 1600);
    assert.equal(result.panorama.height, 800);
    assert.equal(result.share, null, "--share was not requested");

    const space = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(result.spaceId);
    assert.equal(space.owner_account_id, owner.accountId);
    assert.equal(space.collection_state, "open");
    assert.equal(space.auto_approve_uploads, 1);
    assert.equal(space.current_panorama_revision_id, result.panorama.panoramaRevisionId);

    const photos = f.db.prepare("SELECT * FROM photos WHERE space_id=? ORDER BY rowid").all(result.spaceId);
    assert.equal(photos.length, 3);
    for (const photo of photos) {
      // auto_approve_uploads=1 -> straight to 'visible', no manual review queue -- see
      // upload-service.mjs commit()'s initialContentState comment.
      assert.equal(photo.photo_content_state, "visible");
      assert.ok(["processing", "needs_confirmation", "confirmed", "failed"].includes(photo.placement_state));
    }

    // This script never mints more than the one session it needs.
    assert.equal(f.db.prepare("SELECT COUNT(*) c FROM account_sessions WHERE account_id=?").get(owner.accountId).c, 2);
  } finally { stopDispatcher(); f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("resolvePhotoPaths expands a directory (image files only) and dedupes across repeated/comma-separated entries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-resolve-"));
  try {
    const a = writeTempFile(dir, "a.jpg", Buffer.from("not-real-bytes"));
    const b = writeTempFile(dir, "b.png", Buffer.from("not-real-bytes"));
    writeTempFile(dir, "notes.txt", Buffer.from("ignore me"));

    const resolved = resolvePhotoPaths([dir, `${a},${b}`]);
    assert.deepEqual(resolved, [a, b].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolvePhotoPaths rejects a literal file path with an unsupported extension", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-seed-demo-resolve-bad-"));
  try {
    const badFile = writeTempFile(dir, "notes.txt", Buffer.from("hi"));
    assert.throws(() => resolvePhotoPaths([badFile]), /unsupported photo extension/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mimeFromExtension maps known extensions and rejects unknown ones", () => {
  assert.equal(mimeFromExtension("a/b.JPG"), "image/jpeg");
  assert.equal(mimeFromExtension("a/b.jpeg"), "image/jpeg");
  assert.equal(mimeFromExtension("a/b.png"), "image/png");
  assert.equal(mimeFromExtension("a/b.webp"), "image/webp");
  assert.equal(mimeFromExtension("a/b.heic"), "image/heic");
  assert.throws(() => mimeFromExtension("a/b.gif"), /unsupported file extension/);
});

test("parseArgs parses repeated --photos, --dry-run, and kebab-case flags", () => {
  const flags = parseArgs(["--owner", "acct_1", "--name", "N", "--panorama", "p.jpg",
    "--photos", "dirA", "--photos", "dirB,dirC", "--data-dir", "/tmp/x", "--dry-run"]);
  assert.equal(flags.owner, "acct_1");
  assert.equal(flags.name, "N");
  assert.equal(flags.panorama, "p.jpg");
  assert.deepEqual(flags.photos, ["dirA", "dirB,dirC"]);
  assert.equal(flags.dataDir, "/tmp/x");
  assert.equal(flags.dryRun, true);
});

test("parseArgs parses --share and its sub-flags", () => {
  const flags = parseArgs(["--owner", "acct_1", "--name", "N", "--panorama", "p.jpg", "--photos", "dirA",
    "--share", "--share-task-mode", "combo", "--share-expires-days", "30", "--share-max-uses", "500",
    "--public-origin", "https://unseen.maxxam.xyz"]);
  assert.equal(flags.share, true);
  assert.equal(flags.shareTaskMode, "combo");
  assert.equal(flags.shareExpiresDays, "30");
  assert.equal(flags.shareMaxUses, "500");
  assert.equal(flags.publicOrigin, "https://unseen.maxxam.xyz");
});

test("parseArgs leaves --share unset when not passed", () => {
  const flags = parseArgs(["--owner", "acct_1", "--name", "N", "--panorama", "p.jpg", "--photos", "dirA"]);
  assert.equal(flags.share, undefined);
});

test("parseArgs parses --share-existing as a valued flag", () => {
  const flags = parseArgs(["--owner", "acct_1", "--share-existing", "space_abc", "--share-task-mode", "view"]);
  assert.equal(flags.shareExisting, "space_abc");
  assert.equal(flags.shareTaskMode, "view");
  assert.deepEqual(flags.photos, []);
});
