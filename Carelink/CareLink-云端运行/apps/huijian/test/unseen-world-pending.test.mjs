import test from "node:test";
import assert from "node:assert/strict";
import {
  worldPendingDecision, isWorldPendingUnresolved, canClearWorldPending,
  canClearWorldPendingAfterError, worldScreen, jobsScreen
} from "../public/unseen-app-world.js";
const id = "pending-world-request-0001";
const photo = { src: "blob:local-user-photo", ownership: "user" };
const state = { photo, photos: [photo], worldMode: "single", worldBusy: false };
const job = (status, extra = {}) => ({ id, status, createdAt: 1788566400000, ...extra });
function generateButton(html) { return html.match(/<button[^>]*data-app-world="generate"[^>]*>/u)?.[0]; }

test("no pending marker permits the normal request flow without inventing a cleanup action", () => {
  for (const pending of [undefined, null, "", false]) {
    assert.equal(isWorldPendingUnresolved(pending), false);
    assert.equal(canClearWorldPending(pending), false);
  }
  assert.doesNotMatch(generateButton(worldScreen(state)), /disabled/);
});

test("legacy string marker and object marker survive an empty or unavailable job list", () => {
  for (const pending of [id, { id }, { clientRequestId: id, status: "unknown" }, { requestId: id }]) {
    for (const jobs of [undefined, [], null]) {
      const result = worldPendingDecision(pending, jobs);
      assert.equal(result.requestId, id);
      assert.equal(result.blocked, true);
      assert.equal(result.canClear, false);
      assert.equal(result.reason, "server_record_not_found");
    }
  }
});

test("submitting, unknown and processing-without-receipt stay blocked; a local terminal hint is insufficient", () => {
  for (const status of ["submitting", "unknown", "processing", "unrecognized"]) {
    assert.equal(isWorldPendingUnresolved(id, [job(status)]), true);
    assert.equal(canClearWorldPending(id, [job(status)]), false);
  }
  assert.equal(canClearWorldPending({ id, status: "rejected" }, []), false);
  assert.equal(canClearWorldPending({ id, status: "complete" }, []), false);
});

test("only matching settled server jobs or a known accepted-operation receipt permit clearing", () => {
  for (const status of ["rejected", "failed", "complete"]) {
    assert.equal(canClearWorldPending(id, [job(status)]), true);
    assert.equal(isWorldPendingUnresolved(id, [job(status)]), false);
  }
  const processing = job("processing", { operation: { id: "operation-known-0001", done: false } });
  assert.equal(canClearWorldPending(id, [processing]), true);
  assert.equal(canClearWorldPending(id, [{ ...processing, id: "other-request-0001" }]), false);
  assert.equal(canClearWorldPending(id, [job("unknown", { operation: { id: "operation-known-0001" } })]), false);
});

test("world screen disables generation for unresolved requests and preserves an actionable original ID", () => {
  for (const status of ["submitting", "unknown"]) {
    const html = worldScreen({ ...state, worldPending: id, worldJobs: [job(status)] });
    assert.match(generateButton(html), /disabled/);
    assert.match(html, /先核对上一次提交/);
    assert.match(html, new RegExp(id));
    assert.match(html, /data-screen="jobs"/);
    assert.doesNotMatch(html, /重新生成|data-app-world="retry"/);
  }
  const absent = worldScreen({ ...state, worldPending: id, worldJobs: [] });
  assert.match(absent, /不代表服务商没有受理/);
  assert.match(generateButton(absent), /disabled/);
});

test("unknown jobs without receipts do not claim progress, completion, refund or a queryable provider operation", () => {
  const html = jobsScreen({ worldPending: id, worldJobs: [job("unknown", { error: "provider_invalid_response" })] });
  assert.match(html, /尚无可查询的供应商回执/);
  assert.match(html, /无法确认是否已受理或扣费/);
  assert.doesNotMatch(html, /data-app-world-(?:poll|open)=|data-app-world="generate"|退款|已退/);
  const empty = jobsScreen({ worldPending: id, worldJobs: [] });
  assert.match(empty, /请保留本机记录继续核对/);
  assert.doesNotMatch(empty, /还没有已记录的空间任务/);
});

test("job actions distinguish a usable completed result, known processing receipt and confirmed rejection", () => {
  assert.match(jobsScreen({ worldJobs: [job("complete", { operation: { done: true, world: { id: "world-0001" } } })] }), /data-app-world-open=/);
  assert.match(jobsScreen({ worldJobs: [job("processing", { operation: { id: "operation-0001", done: false } })] }), /data-app-world-poll=/);
  const partial = jobsScreen({ worldJobs: [job("processing", { operation: { id: "operation-0001", done: false, world: { id: "partial-world" } } })] });
  assert.doesNotMatch(partial, /data-app-world-open=/);
  const rejected = jobsScreen({ worldJobs: [job("rejected")] });
  assert.match(rejected, /已确认这次请求未被受理/);
  assert.doesNotMatch(rejected, /等待核对|data-app-world-poll=/);
});

test("request IDs, image sources and state messages remain escaped", () => {
  const attack = '\"><img src=x onerror=alert(1)>';
  const html = worldScreen({ ...state, title: attack, worldPending: attack, worldStatus: attack });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test("cleanup helpers are pure and cannot discard a marker for another request", () => {
  const pending = Object.freeze({ id, status: "unknown" });
  const jobs = Object.freeze([Object.freeze(job("unknown"))]);
  assert.equal(Object.isFrozen(worldPendingDecision(pending, jobs)), true);
  assert.deepEqual(pending, { id, status: "unknown" });
  assert.equal(canClearWorldPendingAfterError(pending, { status: 503, data: { error: "worldlabs_not_configured" } }, "older-request-0001"), false);
});

test("only exact pre-admission code/status responses from the same request safely clear without a job", () => {
  for (const [code, status] of [["worldlabs_not_configured", 503], ["origin_not_allowed", 403], ["json_required", 415], ["image_count_invalid", 400], ["image_size_invalid", 413]]) {
    assert.equal(canClearWorldPendingAfterError(id, { status, data: { error: code } }, id), true);
  }
  for (const error of [
    new TypeError("fetch failed"), new DOMException("deadline", "TimeoutError"),
    { status: 503, data: { error: "service_temporarily_unavailable" } },
    { status: 502, data: { error: "provider_invalid_response", status: "unknown" } },
    { status: 402, data: { error: "provider_credits_low" } },
    { status: 503, data: { error: "WL-204" } },
    { status: 503, data: { error: "image_count_invalid" } }
  ]) assert.equal(canClearWorldPendingAfterError(id, error, id), false);
});
