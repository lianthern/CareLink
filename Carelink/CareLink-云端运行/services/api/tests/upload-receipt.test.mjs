import test from "node:test";
import assert from "node:assert/strict";
import { createAccountUpload, exchangeReceipt, fixture, png } from "./fixture-factory.mjs";
import { assertUploadAuthorization } from "../src/ports/media/upload-authorization-port.mjs";

async function prepared() {
  const f = fixture();
  const account = await f.login("uploader@example.test");
  let space = await f.createSpace(account);
  space = await f.openSpace(account, space);
  return { f, account, space };
}

test("upload commit uses server-observed bytes and a real isolated decoder", async () => {
  const { f, account, space } = await prepared();
  try {
    const flow = await createAccountUpload(f, account, space, png(64, 32));
    assert.ok(flow.committed.photoId);
    const asset = f.db.prepare("SELECT * FROM assets WHERE id=?").get(flow.committed.assetId);
    assert.equal(asset.observed_bytes, flow.bytes.length);
    assert.equal(asset.observed_mime, "image/png");
    assert.equal(asset.width, 64);
    assert.equal(asset.height, 32);
    assert.equal(asset.validation_state, "valid");
    const session = f.db.prepare("SELECT ticket_mac FROM upload_sessions WHERE id=?").get(flow.upload.uploadSessionId);
    assert.equal(session.ticket_mac, null);
  } finally { f.close(); }
});

test("truncated header-only image cannot masquerade as decoded media", async () => {
  const { f, account, space } = await prepared();
  try {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(bytes);
    bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(32, 16); bytes.writeUInt32BE(16, 20);
    const consent = await f.ok("POST", "/v1/consent-events", {
      ...f.mediaConsentBody()
    }, account.headers);
    const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`,
      { clientBatchId: "bad-image", consentEventId: consent.consentEventId, declaredItemCount: 1 }, account.headers);
    const item = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`,
      { clientItemId: "bad", declaredMime: "image/png", declaredBytes: bytes.length, fileNameHash: "opaque" },
      { ...account.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
    const upload = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`,
      { declaredMime: "image/png", declaredBytes: bytes.length, clientUploadId: "bad-upload" },
      { ...account.headers, "if-match": String(item.version) });
    const put = await f.api.putMedia({ ticket: upload.oneTimeUploadTicket, bytes, contentType: "image/png" });
    assert.equal(put.status, 200);
    const rejected = await f.call("POST", `/v1/upload-sessions/${upload.uploadSessionId}/commits`,
      { clientCommitId: "bad-commit" }, { ...account.headers, "if-match": String(put.body.uploadSessionVersion),
        "x-item-version": String(upload.itemVersion) });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, "media_decode_rejected");
    assert.equal(f.db.prepare("SELECT status FROM contribution_batch_items WHERE id=?").get(item.itemId).status, "failed");
  } finally { f.close(); }
});

test("upload ticket is exact-key, MIME-bound, size-bound, expiring, and one route cannot fake success", async () => {
  const { f, account, space } = await prepared();
  try {
    const bytes = png();
    const consent = await f.ok("POST", "/v1/consent-events", {
      ...f.mediaConsentBody()
    }, account.headers);
    const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`,
      { clientBatchId: "ticket", consentEventId: consent.consentEventId, declaredItemCount: 1 }, account.headers);
    const item = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`,
      { clientItemId: "ticket", declaredMime: "image/png", declaredBytes: bytes.length, fileNameHash: "opaque" },
      { ...account.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
    const upload = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`,
      { declaredMime: "image/png", declaredBytes: bytes.length, clientUploadId: "ticket" },
      { ...account.headers, "if-match": String(item.version) });
    assert.equal((await f.api.putMedia({ ticket: "wrong-ticket", bytes, contentType: "image/png" })).status, 404);
    assert.equal((await f.api.putMedia({ ticket: upload.oneTimeUploadTicket, bytes, contentType: "image/jpeg" })).status, 409);
    assert.equal((await f.api.putMedia({ ticket: upload.oneTimeUploadTicket, bytes: Buffer.concat([bytes, Buffer.alloc(1)]), contentType: "image/png" })).status, 409);
    const put = await f.api.putMedia({ ticket: upload.oneTimeUploadTicket, bytes, contentType: "image/png" });
    assert.equal(put.status, 200);
    assert.equal((await f.api.putMedia({ ticket: upload.oneTimeUploadTicket, bytes, contentType: "image/png" })).status, 404);
    await f.api.mediaStore.delete(upload.exactPrivateObjectKey);
    const missing = await f.call("POST", `/v1/upload-sessions/${upload.uploadSessionId}/commits`,
      { clientCommitId: "missing" }, { ...account.headers, "if-match": String(put.body.uploadSessionVersion),
        "x-item-version": String(upload.itemVersion) });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error.code, "object_missing");
  } finally { f.close(); }
});

test("provider authorization rejects unusable browser PUT output with full transaction rollback", async () => {
  const exactHeaders = (binding, extra = {}) => ({
    "Content-Type": binding.declaredMime, "If-None-Match": "*",
    "X-Unseen-Upload-Session": binding.uploadSessionId,
    "X-Unseen-Upload-Session-Version": String(binding.uploadSessionVersion),
    "X-Unseen-Upload-Item": binding.itemId, "X-Unseen-Upload-Asset": binding.assetId,
    "X-Unseen-Upload-Bytes": String(binding.declaredBytes),
    "X-Unseen-Upload-Expires-At": binding.expiresAt, ...extra
  });
  const cases = [
    (binding) => ({ url: `javascript:/${binding.exactPrivateObjectKey}`, headers: exactHeaders(binding) }),
    (binding) => ({ url: `http://objects.invalid/${binding.exactPrivateObjectKey}`, headers: exactHeaders(binding) }),
    (binding) => ({ url: `/wrong/${binding.exactPrivateObjectKey}`, headers: exactHeaders(binding) }),
    (binding) => ({ url: `https://objects.invalid/evil${binding.exactPrivateObjectKey}`, headers: exactHeaders(binding) }),
    (binding) => ({ url: `https://objects.invalid/prefix/${binding.exactPrivateObjectKey}`,
      headers: exactHeaders(binding, { "Bad Header": "unusable" }) }),
    (binding) => ({ url: `https://objects.invalid/prefix/${binding.exactPrivateObjectKey}`,
      headers: exactHeaders(binding, { "X-Provider": "safe\r\nInjected: bad" }) }),
    (binding) => ({ url: `https://objects.invalid/prefix/${binding.exactPrivateObjectKey}`,
      headers: exactHeaders(binding, { "X-Provider": "safe\0bad" }) }),
    (binding) => ({ url: `https://objects.invalid/prefix/${binding.exactPrivateObjectKey}`,
      headers: exactHeaders(binding, { "X-Provider": "a", "x-provider": "b" }) }),
    (binding) => ({ url: `https://objects.invalid/prefix/${binding.exactPrivateObjectKey}`,
      headers: exactHeaders(binding, { "X-HTTP-Method-Override": "POST" }) }),
    (binding) => ({ url: `https://objects.invalid/prefix/${binding.exactPrivateObjectKey}`,
      headers: exactHeaders(binding, { Origin: "https://evil.invalid" }) })
  ];
  for (const [index, authorize] of cases.entries()) {
    const f = fixture({ uploadAuthorization: { authorize } });
    try {
      const account = await f.login(`provider-boundary-${index}@example.test`);
      let space = await f.createSpace(account);
      space = await f.openSpace(account, space);
      const bytes = png();
      const consent = await f.ok("POST", "/v1/consent-events", {
        ...f.mediaConsentBody()
      }, account.headers);
      const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
        clientBatchId: `bad-provider-${index}`, consentEventId: consent.consentEventId, declaredItemCount: 1
      }, account.headers);
      const item = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`, {
        clientItemId: `bad-provider-${index}`, declaredMime: "image/png", declaredBytes: bytes.length,
        fileNameHash: "opaque"
      }, { ...account.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
      const before = f.db.prepare("SELECT COUNT(*) count FROM idempotency_records").get().count;
      const rejected = await f.call("POST",
        `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`, {
          declaredMime: "image/png", declaredBytes: bytes.length, clientUploadId: `bad-provider-${index}`
        }, { ...account.headers, "if-match": String(item.version) });
      assert.equal(rejected.status, 503);
      assert.equal(rejected.body.error.code, "upload_policy_unavailable");
      assert.equal(f.db.prepare("SELECT COUNT(*) count FROM upload_sessions WHERE item_id=?").get(item.itemId).count, 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) count FROM assets WHERE space_id=? AND kind='photo'").get(space.spaceId).count, 0);
      assert.equal(f.db.prepare("SELECT status FROM contribution_batch_items WHERE id=?").get(item.itemId).status, "selected");
      assert.equal(f.db.prepare("SELECT COUNT(*) count FROM idempotency_records").get().count, before);
    } finally { f.close(); }
  }
  const binding = { rawTicket: "r".repeat(43), uploadSessionId: "upload", uploadSessionVersion: 1,
    itemId: "item", assetId: "asset", exactPrivateObjectKey: "private/space/item/asset",
    declaredMime: "image/png", declaredBytes: 10, expiresAt: "2030-01-01T00:00:00.000Z" };
  assert.doesNotThrow(() => assertUploadAuthorization({
    url: `https://objects.invalid/provider-prefix/${binding.exactPrivateObjectKey}`,
    headers: exactHeaders(binding, { Authorization: "OSS credential", "X-OSS-Meta-Source": "unseen" })
  }, binding));
});

test("receipt bootstrap is single-consume under concurrent exchange and is batch-isolated", async () => {
  const { f, account, space } = await prepared();
  try {
    const firstFlow = await createAccountUpload(f, account, space);
    const [a, b] = await Promise.all([
      exchangeReceipt(f, firstFlow.finalized, "receipt-race-a-abcdefgh"),
      exchangeReceipt(f, firstFlow.finalized, "receipt-race-b-abcdefgh")
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 404]);
    const receipt = a.status === 200 ? a.body : b.body;
    const secondFlow = await createAccountUpload(f, account, space, png(48, 24));
    const crossBatch = await f.call("GET", `/v1/batch-receipt/items/${secondFlow.item.itemId}`, {},
      { "x-receipt-session": receipt.receiptSessionSecret });
    assert.equal(crossBatch.status, 404);
    assert.equal(crossBatch.body.error.code, "batch_item_unavailable");
  } finally { f.close(); }
});

test("CAS and idempotency conflicts reject without extra state", async () => {
  const { f, account, space } = await prepared();
  try {
    const consent = await f.ok("POST", "/v1/consent-events", {
      ...f.mediaConsentBody()
    }, account.headers);
    const headers = { ...account.headers, "idempotency-key": "batch-fixed-abcdefgh" };
    const body = { clientBatchId: "same", consentEventId: consent.consentEventId, declaredItemCount: 1 };
    const first = await f.call("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, body, headers);
    const replay = await f.call("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, body, headers);
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM contribution_batches WHERE space_id=?").get(space.spaceId).count, 1);
    const conflict = await f.call("POST", `/v1/spaces/${space.spaceId}/contribution-batches`,
      { ...body, declaredItemCount: 2 }, headers);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "idempotency_conflict");
    const wrongCas = await f.call("POST", `/v1/contribution-batches/${first.body.batchId}/items`,
      { clientItemId: "bad-cas", declaredMime: "image/png", declaredBytes: 100, fileNameHash: "opaque" },
      { ...account.headers, "if-match": "999" });
    assert.equal(wrongCas.status, 409);
    assert.equal(wrongCas.body.error.code, "version_conflict");
  } finally { f.close(); }
});

test("batch item capacity is a hard server-side maximum", async () => {
  const { f, account, space } = await prepared();
  try {
    const consent = await f.ok("POST", "/v1/consent-events", {
      ...f.mediaConsentBody()
    }, account.headers);
    const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`,
      { clientBatchId: "capacity", consentEventId: consent.consentEventId, declaredItemCount: 50 }, account.headers);
    let version = batch.version;
    for (let index = 0; index < 50; index += 1) {
      const item = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`,
        { clientItemId: `capacity-${index}`, declaredMime: "image/png", declaredBytes: 100, fileNameHash: "opaque" },
        { ...account.headers, "if-match": String(version), "x-space-version": String(space.version) });
      version = item.batchVersion;
    }
    const overflow = await f.call("POST", `/v1/contribution-batches/${batch.batchId}/items`,
      { clientItemId: "capacity-overflow", declaredMime: "image/png", declaredBytes: 100, fileNameHash: "opaque" },
      { ...account.headers, "if-match": String(version), "x-space-version": String(space.version) });
    assert.equal(overflow.status, 413);
    assert.equal(overflow.body.error.code, "media_limit_exceeded");
    assert.equal(f.db.prepare("SELECT item_count FROM contribution_batches WHERE id=?").get(batch.batchId).item_count, 50);
  } finally { f.close(); }
});
