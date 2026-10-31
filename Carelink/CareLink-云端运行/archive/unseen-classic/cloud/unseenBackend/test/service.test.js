"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AppError } = require("../lib/errors.js");
const { inspectImage } = require("../lib/image.js");
const { makeService, constants } = require("../lib/service.js");
const { FakeOss } = require("./fake-oss.js");

function png(width, height, extraBytes = 0) {
  const body = Buffer.alloc(24 + extraBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body, 0);
  body.writeUInt32BE(13, 8);
  body.write("IHDR", 12, "ascii");
  body.writeUInt32BE(width, 16);
  body.writeUInt32BE(height, 20);
  return body;
}

function config() {
  return {
    bucket: "unit-test-bucket",
    endpoint: "oss-cn-hangzhou.aliyuncs.com",
    ossPublicBase: "https://unit-test-bucket.oss-cn-hangzhou.aliyuncs.com",
    publicApiUrl: "https://example.test/unseen-api",
    accessKeyId: "test-access-id",
    accessKeySecret: "not-a-real-test-access-secret-not-for-production",
    tokenSecret: "not-a-real-token-secret-00000000000000000000000000000000",
    spaceIdSecret: "not-a-real-space-secret-00000000000000000000000000000000",
    hostKeySecret: "not-a-real-host-secret-000000000000000000000000000000000",
    rateLimitSecret: "not-a-real-rate-secret-000000000000000000000000000000000",
    policyTtlSeconds: 900,
    commitTtlSeconds: 1800,
    draftTtlSeconds: 86400,
    uploadTtlSeconds: 86400,
    createRatePerHour: 100,
    ticketRatePerIp10m: 500,
    ticketRatePerSpace10m: 500,
    maintenanceMaxObjects: 1000,
    corsOrigins: ["https://example.test"],
    maintenanceToken: ""
  };
}

function setup() {
  let clock = Date.parse("2026-08-02T00:00:00Z");
  const now = () => clock;
  const oss = new FakeOss(now);
  let sequence = 0;
  const service = makeService({ oss, config: config(), now,
    randomId: () => `creation-${++sequence}` });
  return { oss, service, now, advance(ms) { clock += ms; } };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof AppError && error.code === code);
}

test("strict image rules preserve ordinary and 2:1 panorama limits", () => {
  assert.deepEqual(inspectImage(png(1600, 800), "panorama"), {
    format: "png", mime: "image/png", extension: "png", width: 1600,
    height: 800, animated: false, size: 24
  });
  assert.equal(inspectImage(png(7000, 7000), "photo").width, 7000);
  assert.throws(() => inspectImage(png(1599, 800), "panorama"), /1600/);
  assert.throws(() => inspectImage(png(2000, 800), "panorama"), /2:1/);
  assert.throws(() => inspectImage(png(8193, 4096), "panorama"), /8192/);
});

test("createSpace is deterministic and issues exact private policies only", async () => {
  const { service } = setup();
  const input = { clientCreateId: "create-request-00000001", title: "  <庆典>  ",
    media: { cover: true, panorama: true } };
  const first = await service.createSpace(input, { ip: "203.0.113.1" });
  const retry = await service.createSpace(input, { ip: "203.0.113.1" });
  assert.equal(first.spaceId, retry.spaceId);
  assert.equal(first.hostKey, retry.hostKey);
  for (const purpose of ["cover", "panorama"]) {
    const ticket = first.uploads[purpose];
    const policy = JSON.parse(Buffer.from(ticket.fields.policy, "base64").toString("utf8"));
    assert.ok(policy.conditions.some((condition) => Array.isArray(condition) &&
      condition[0] === "eq" && condition[1] === "$key" && condition[2] === ticket.fields.key));
    assert.ok(!policy.conditions.some((condition) => Array.isArray(condition) && condition[0] === "starts-with"));
    assert.equal(ticket.fields["x-oss-object-acl"], "private");
    assert.match(ticket.fields.key, /^unseen-backend\/v1\/staging\/u[a-f0-9]{24}\//);
  }
});

test("full create/finalize/ticket/commit path publishes safe idempotent manifest", async () => {
  const { oss, service } = setup();
  const created = await service.createSpace({
    clientCreateId: "create-request-00000002",
    title: "夏夜 <script>alert(1)</script>", date: "2026-08-02", place: "Brisbane",
    media: { cover: true, panorama: true }
  }, { ip: "203.0.113.2" });
  await oss.put(created.uploads.cover.fields.key, png(1200, 800), { acl: "private" });
  await oss.put(created.uploads.panorama.fields.key, png(2048, 1024), { acl: "private" });
  const finalized = await service.finalizeSpace({ spaceId: created.spaceId }, { hostKey: created.hostKey });
  assert.equal(finalized.status, "published");
  assert.equal(finalized.manifest.upload.mode, "ticket-v1");
  assert.equal(finalized.manifest.upload.endpoint, "https://example.test/unseen-api");
  assert.ok(!JSON.stringify(finalized.manifest).includes("OSSAccessKeyId"));
  assert.ok(!finalized.manifest.title.includes("<"));
  assert.equal((await oss.head(`spaces/${created.spaceId}/space.json`)).exists, true);

  const request = { spaceId: created.spaceId,
    clientUploadId: "photo-upload-0000000001", contributor: "<Max>", caption: "  hello  " };
  const ticket = await service.photoTicket(request, { ip: "203.0.113.3" });
  const retryTicket = await service.photoTicket(request, { ip: "203.0.113.3" });
  assert.equal(ticket.upload.fields.key, retryTicket.upload.fields.key);
  const policy = JSON.parse(Buffer.from(ticket.upload.fields.policy, "base64").toString("utf8"));
  assert.ok(policy.conditions.some((condition) => Array.isArray(condition) && condition[0] === "eq" &&
    condition[2] === ticket.upload.fields.key));
  await oss.put(ticket.upload.fields.key, png(1600, 1000), { acl: "private" });
  const committed = await service.commitPhoto({ commitToken: ticket.commitToken });
  assert.equal(committed.photo.id, ticket.photoId);
  assert.equal(committed.photo.contributor, "Max");
  assert.equal(committed.photo.caption, "hello");
  assert.equal((await oss.head(ticket.upload.fields.key)).exists, false);
  const manifest = oss.json(`spaces/${created.spaceId}/space.json`);
  assert.equal(manifest.photos.length, 1);
  assert.equal(manifest.capacity.received, 1);
  assert.equal(manifest.capacity.remaining, 89);

  const idempotent = await service.commitPhoto({ commitToken: ticket.commitToken });
  assert.equal(idempotent.idempotent, true);
  assert.equal(oss.json(`spaces/${created.spaceId}/space.json`).photos.length, 1);
  const committedTicket = await service.photoTicket(request, { ip: "203.0.113.3" });
  assert.equal(committedTicket.committed, true);
});

test("host and commit credentials fail closed", async () => {
  const { service } = setup();
  const created = await service.createSpace({ clientCreateId: "create-request-00000003",
    media: {} }, { ip: "203.0.113.4" });
  await expectCode(service.finalizeSpace({ spaceId: created.spaceId }, { hostKey: "wrong" }), "HOST_AUTH_FAILED");
  await service.finalizeSpace({ spaceId: created.spaceId }, { hostKey: created.hostKey });
  const ticket = await service.photoTicket({ spaceId: created.spaceId,
    clientUploadId: "photo-upload-0000000002" }, { ip: "203.0.113.4" });
  const tampered = `${ticket.commitToken.slice(0, -1)}${ticket.commitToken.endsWith("a") ? "b" : "a"}`;
  await expectCode(service.commitPhoto({ commitToken: tampered }), "INVALID_COMMIT_TOKEN");
});

test("timer maintenance expires abandoned drafts without touching published spaces", async () => {
  const { oss, service, advance } = setup();
  const abandoned = await service.createSpace({ clientCreateId: "create-request-00000004",
    media: { cover: true } }, { ip: "203.0.113.5" });
  await oss.put(abandoned.uploads.cover.fields.key, png(1000, 700));
  const live = await service.createSpace({ clientCreateId: "create-request-00000005",
    media: {} }, { ip: "203.0.113.5" });
  await service.finalizeSpace({ spaceId: live.spaceId }, { hostKey: live.hostKey });
  advance(25 * 60 * 60 * 1000);
  const result = await service.maintenance();
  assert.equal(result.expiredDrafts, 1);
  assert.equal(result.reconciledSpaces, 1);
  assert.equal((await oss.head(`unseen-backend/v1/spaces/${abandoned.spaceId}/state.json`)).exists, false);
  assert.equal((await oss.head(`spaces/${live.spaceId}/space.json`)).exists, true);
});

test("timer maintenance releases a stale ticket slot even when no upload object exists", async () => {
  const { oss, service, advance } = setup();
  const created = await service.createSpace({ clientCreateId: "create-request-00000006",
    media: {} }, { ip: "203.0.113.6" });
  await service.finalizeSpace({ spaceId: created.spaceId }, { hostKey: created.hostKey });
  const ticket = await service.photoTicket({ spaceId: created.spaceId,
    clientUploadId: "photo-upload-no-file-0001" }, { ip: "203.0.113.6" });
  assert.equal((await oss.head(ticket.upload.fields.key)).exists, false,
    "the case must contain a ticket but no uploaded object");
  advance(25 * 60 * 60 * 1000);
  const result = await service.maintenance();
  assert.equal(result.expiredTickets, 1);
  const ticketObjects = await oss.list(`unseen-backend/v1/tickets/${created.spaceId}/`);
  const slotObjects = await oss.list(`unseen-backend/v1/slots/${created.spaceId}/`);
  assert.equal(ticketObjects.objects.length, 0);
  assert.equal(slotObjects.objects.length, 0);
  const reissued = await service.photoTicket({ spaceId: created.spaceId,
    clientUploadId: "photo-upload-no-file-0002" }, { ip: "203.0.113.6" });
  assert.equal(reissued.committed, false);
});

test("declared capacity is exactly 90", () => {
  assert.equal(constants.MAX_PHOTOS, 90);
  assert.equal(constants.PHOTO_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(constants.PANO_MAX_BYTES, 50 * 1024 * 1024);
});
