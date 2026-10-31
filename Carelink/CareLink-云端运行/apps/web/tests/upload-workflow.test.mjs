import test from "node:test";
import assert from "node:assert/strict";
import { PanoramaUploadWorkflowClient, pollPanoramaCandidate, UploadWorkflowClient } from "../src/api/upload-workflow.js";

const file = { name: "窗边.jpg", type: "image/jpeg", size: 4, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer };
const okPut = new Response(null, { status: 200, headers: { ETag: '"object-etag"' } });

test("photo workflow keeps the exact File bytes through plan, ticket PUT, commit and result read", async () => {
  const calls = [];
  const api = {
    async send(request) {
      calls.push(request);
      if (request.path.endsWith("/contribution-batches")) return { batchId: "batch-1", ifMatch: '"space:1;batch:1"' };
      if (request.path.endsWith("/items")) return { itemId: "item-1", ifMatch: '"item:1"' };
      if (request.path.endsWith("/upload-sessions")) return { uploadSessionId: "upload-1", exactPrivateObjectKey: "/exact/item-1", oneTimeUploadTicket: { url: "https://objects.invalid/exact/item-1", headers: { "X-Ticket": "one-time" } }, commitIfMatch: '"upload:1;item:2"' };
      if (request.path.endsWith("/commits")) return { itemId: "item-1", status: "validating" };
      throw new Error(`unexpected ${request.path}`);
    },
    async read(resource, params) { calls.push({ read: resource, params }); return { id: "batch-1", items: [{ id: "item-1" }] }; }
  };
  const puts = [];
  const workflow = new UploadWorkflowClient({ apiAdapter: api, transport: async (url, init) => { puts.push({ url, init }); return okPut; } });
  const result = await workflow.uploadFiles({ spaceId: "space-1", files: [file], consentEventId: "consent-1", batchIfMatch: '"space:1"' });
  assert.equal(result.batchId, "batch-1");
  assert.deepEqual(calls[0].body, { clientBatchId: calls[0].body.clientBatchId, consentEventId: "consent-1", declaredItemCount: 1 });
  assert.deepEqual(Object.keys(calls[1].body), ["clientItemId", "declaredMime", "declaredBytes", "fileNameHash"]);
  assert.equal(calls[1].ifMatch, '"space:1;batch:1"');
  assert.deepEqual(calls[2].body, { declaredMime: "image/jpeg", declaredBytes: 4, clientUploadId: calls[2].body.clientUploadId });
  assert.equal(puts[0].url, "https://objects.invalid/exact/item-1");
  assert.deepEqual(puts[0].init.headers, { "X-Ticket": "one-time" });
  assert.equal(puts[0].init.body, file);
  assert.equal(puts[0].init.credentials, "omit");
  assert.deepEqual(calls[3].body, { clientCommitId: calls[3].body.clientCommitId, observedETag: '"object-etag"' });
  assert.equal(calls[3].ifMatch, '"upload:1;item:2"');
  assert.deepEqual(calls[4], { read: "batchResult", params: { batchId: "batch-1" } });
});

test("failed photo retry requires a reselected File and performs a new exact-ticket PUT", async () => {
  const calls = [];
  const api = {
    async send(request) {
      calls.push(request);
      if (request.path.endsWith("/retries")) return { uploadSessionId: "upload-2", exactPrivateObjectKey: "/exact/retry", oneTimeUploadTicket: { url: "https://objects.invalid/exact/retry", headers: { Authorization: "Ticket retry" } }, commitIfMatch: '"upload:2"' };
      return { status: "validating" };
    },
    async read(resource, params) { calls.push({ read: resource, params }); return { id: "batch-1" }; }
  };
  const puts = [];
  const workflow = new UploadWorkflowClient({ apiAdapter: api, transport: async (url, init) => { puts.push({ url, init }); return okPut; } });
  await workflow.retryItem({ batchId: "batch-1", itemId: "item-1", failureVersion: 3, file });
  assert.deepEqual(calls[0], { method: "POST", path: "/v1/contribution-batches/batch-1/items/item-1/retries", body: { failureVersion: 3 } });
  assert.equal(puts[0].init.body, file);
  assert.deepEqual(puts[0].init.headers, { Authorization: "Ticket retry" });
  assert.equal(calls[1].path, "/v1/upload-sessions/upload-2/commits");
  assert.deepEqual(calls[2], { read: "batchResult", params: { batchId: "batch-1" } });
});

test("panorama workflow sends real bytes only to its exact ticket and then commits/statuses", async () => {
  const calls = [];
  const api = {
    async send(request) {
      calls.push(request);
      if (request.path.endsWith("/panorama-candidates")) return { candidateId: "candidate-1", uploadSessionId: "pano-upload-1", exactPrivateUploadTicketOnce: { url: "https://objects.invalid/exact/pano", headers: { "X-Pano-Ticket": "one-time" }, exactPrivateObjectKey: "/exact/pano" }, uploadSessionIfMatch: '"pano-upload:1"' };
      if (request.method === "GET") return { candidateId: "candidate-1", status: "validating" };
      return { status: "validating" };
    }
  };
  const puts = [];
  const workflow = new PanoramaUploadWorkflowClient({ apiAdapter: api, transport: async (url, init) => { puts.push({ url, init }); return okPut; } });
  const result = await workflow.uploadCandidate({ spaceId: "space-1", file, noticeAcknowledgement: { version: 1, hash: "notice-hash" }, ifMatch: '"space:1"' });
  assert.equal(calls[0].path, "/v1/spaces/space-1/panorama-candidates");
  assert.deepEqual(Object.keys(calls[0].body), ["declaredMime", "declaredBytes", "clientAssetId", "noticeAcknowledgement"]);
  assert.equal(puts[0].init.body, file);
  assert.deepEqual(puts[0].init.headers, { "X-Pano-Ticket": "one-time" });
  assert.equal(calls[1].path, "/v1/panorama-upload-sessions/pano-upload-1/commits");
  assert.deepEqual(result, { candidateId: "candidate-1", status: "validating" });
});

test("panorama polling follows the exact candidate from validating to ready without a refresh", async () => {
  const statuses = [
    { candidateId: "candidate-1", status: "validating" },
    { candidateId: "candidate-1", status: "ready", panoramaRevisionId: "pano-2" }
  ];
  const result = await pollPanoramaCandidate({
    spaceId: "space-1",
    candidateId: "candidate-1",
    readStatus: async () => statuses.shift(),
    wait: async () => true
  });
  assert.equal(result.outcome, "ready");
  assert.equal(result.candidate.panoramaRevisionId, "pano-2");
});

test("panorama polling returns failed terminal state without claiming ready", async () => {
  const result = await pollPanoramaCandidate({
    spaceId: "space-1",
    candidateId: "candidate-1",
    readStatus: async () => ({ candidateId: "candidate-1", status: "failed", validationCode: "invalid_ratio" }),
    wait: async () => true
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.candidate.validationCode, "invalid_ratio");
});

test("panorama polling times out after its bounded attempts", async () => {
  let reads = 0;
  const result = await pollPanoramaCandidate({
    spaceId: "space-1",
    candidateId: "candidate-1",
    maxAttempts: 3,
    readStatus: async () => { reads += 1; return { candidateId: "candidate-1", status: "validating" }; },
    wait: async () => true
  });
  assert.equal(result.outcome, "timeout");
  assert.equal(reads, 3);
});

test("panorama polling drops a response after its route request becomes stale", async () => {
  let current = true;
  const result = await pollPanoramaCandidate({
    spaceId: "space-1",
    candidateId: "candidate-1",
    isCurrent: () => current,
    readStatus: async () => { current = false; return { candidateId: "candidate-1", status: "ready" }; },
    wait: async () => true
  });
  assert.equal(result.outcome, "cancelled");
});

test("a second panorama upload wins and the first poll cannot publish", async () => {
  let currentRequest = 1;
  let releaseFirst;
  const firstRead = new Promise((resolve) => { releaseFirst = resolve; });
  const first = pollPanoramaCandidate({
    spaceId: "space-1",
    candidateId: "candidate-1",
    isCurrent: () => currentRequest === 1,
    readStatus: async () => firstRead,
    wait: async () => true
  });
  currentRequest = 2;
  const second = pollPanoramaCandidate({
    spaceId: "space-1",
    candidateId: "candidate-2",
    isCurrent: () => currentRequest === 2,
    readStatus: async () => ({ candidateId: "candidate-2", status: "ready" }),
    wait: async () => true
  });
  releaseFirst({ candidateId: "candidate-1", status: "ready" });
  assert.equal((await second).outcome, "ready");
  assert.equal((await first).outcome, "cancelled");
});
