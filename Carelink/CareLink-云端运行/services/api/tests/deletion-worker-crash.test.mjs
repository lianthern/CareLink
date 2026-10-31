import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LocalKeyring } from "../src/crypto.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import { dispatchDeletion } from "../../jobs/dispatch/deletion-worker.mjs";
import { createAccountUpload, fixture } from "./fixture-factory.mjs";

const helper = new URL("./deletion-worker-crash-helper.mjs", import.meta.url).pathname;

async function requestedSpaceDeletion(f, owner, space, suffix) {
  const flow = await createAccountUpload(f, owner, space);
  const grant = await f.reauth(owner, "SPACE.DELETE_REQUEST", "space_delete", "space", space.spaceId);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const deletion = await f.ok("POST", `/v1/spaces/${space.spaceId}/deletion-requests`, {
    reauthGrant: grant.reauthGrantSecret, reason: `crash-${suffix}`, confirmation: true
  }, { ...owner.headers, "if-match": String(current.version) });
  return { deletion, flow };
}

test("deletion lease is reclaimed after SIGKILL at claim and after first media object, with idempotent reconcile", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-deletion-crash-"));
  const database = path.join(directory, "local.sqlite");
  const mediaRoot = path.join(directory, "media");
  const f = fixture({ database, keyring: new LocalKeyring({ persistent: true }),
    mediaStore: new FilesystemMediaStore(mediaRoot) });
  try {
    const owner = await f.login("deletion-crash@example.test");
    let firstSpace = await f.createSpace(owner, "Claim crash");
    firstSpace = await f.openSpace(owner, firstSpace);
    const first = await requestedSpaceDeletion(f, owner, firstSpace, "claim");
    const killedAtClaim = spawnSync(process.execPath,
      [helper, database, mediaRoot, first.deletion.jobId, "after-claim", f.clock.iso()],
      { encoding: "utf8", timeout: 10_000 });
    assert.equal(killedAtClaim.signal, "SIGKILL");
    assert.equal(f.db.prepare("SELECT status FROM deletion_requests WHERE id=?").get(first.deletion.deletionId).status,
      "running");
    f.clock.advance(2_000);
    assert.equal((await dispatchDeletion(f.db, f.api.mediaStore, first.deletion.jobId,
      { now: f.clock.iso(), leaseMs: 1_000 })).status, "succeeded");
    assert.equal((await f.api.mediaStore.head(first.flow.upload.exactPrivateObjectKey)).exists, false);

    let secondSpace = await f.createSpace(owner, "Object crash");
    secondSpace = await f.openSpace(owner, secondSpace);
    const second = await requestedSpaceDeletion(f, owner, secondSpace, "object");
    const killedAfterObject = spawnSync(process.execPath,
      [helper, database, mediaRoot, second.deletion.jobId, "after-first-object", f.clock.iso()],
      { encoding: "utf8", timeout: 10_000 });
    assert.equal(killedAfterObject.signal, "SIGKILL");
    const remainingBeforeRestart = (await Promise.all([
      f.api.mediaStore.head(second.flow.upload.exactPrivateObjectKey),
      f.api.mediaStore.head(f.db.prepare("SELECT private_object_key FROM assets WHERE id=(SELECT viewer_safe_asset_id FROM photos WHERE id=?)")
        .get(second.flow.committed.photoId).private_object_key)
    ])).filter((entry) => entry.exists).length;
    assert.equal(remainingBeforeRestart, 1);
    f.clock.advance(2_000);
    assert.equal((await dispatchDeletion(f.db, f.api.mediaStore, second.deletion.jobId,
      { now: f.clock.iso(), leaseMs: 1_000 })).status, "succeeded");
    assert.equal(f.db.prepare("SELECT status FROM deletion_requests WHERE id=?").get(second.deletion.deletionId).status,
      "completed");
    const actions = f.db.prepare(`SELECT action FROM deletion_attempt_events
      WHERE deletion_request_id=? ORDER BY seq`).all(second.deletion.deletionId).map((row) => row.action);
    assert.ok(actions.includes("lease_reclaim"));
    assert.ok(actions.filter((action) => action === "delete_media").length >= 2);
    for (const table of ["deletion_attempt_events", "deletion_status_events"]) {
      const rows = f.db.prepare(`SELECT id,seq,previous_event_id FROM ${table}
        WHERE deletion_request_id=? ORDER BY seq`).all(second.deletion.deletionId);
      assert.equal(rows[0].seq, 1);
      assert.equal(rows[0].previous_event_id, null);
      for (let index = 1; index < rows.length; index += 1) {
        assert.equal(rows[index].seq, rows[index - 1].seq + 1);
        assert.equal(rows[index].previous_event_id, rows[index - 1].id);
      }
    }
    assert.throws(() => f.db.prepare("UPDATE deletion_attempt_events SET action='changed' WHERE deletion_request_id=?")
      .run(second.deletion.deletionId), /immutable/);
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
