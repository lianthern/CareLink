// Unit tests for the tri-state /healthz sub-checks and their aggregation/caching (see
// src/health-checks.mjs's header for the incident this responds to). Each check function takes
// its dependency (db handle / statfs / fetch) as a plain argument, so every scenario here is
// constructed directly -- no real database, filesystem, or network needed.
import assert from "node:assert/strict";
import test from "node:test";
import { LocalKeyring } from "../src/crypto.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/database.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import { LocalApi } from "../src/api.mjs";
import { createLocalHttpServer, listenLocalHttpServer } from "../src/http-server.mjs";
import { aggregateHealthStatus, cachedHealthCheck, checkClipSidecar, checkDatabaseWritable,
  checkDiskSpace } from "../src/health-checks.mjs";

// ---------------------------------------------------------------------------------------------
// checkDatabaseWritable
// ---------------------------------------------------------------------------------------------

test("checkDatabaseWritable: ok for a real writable database and leaves no trace behind", () => {
  const db = openDatabase(":memory:");
  try {
    const result = checkDatabaseWritable(db);
    assert.equal(result.status, "ok");
    assert.equal(result.writable, true);
    assert.equal(typeof result.latencyMs, "number");
    const leftover = db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?")
      .get("table", "_unseen_healthz_probe");
    assert.equal(leftover, undefined, "the probe table must never survive the check (rolled back every time)");
    assert.equal(db.isTransaction, false, "must not leave a transaction open");
  } finally { db.close(); }
});

test("checkDatabaseWritable: repeated calls stay clean (no accumulating rows/tables)", () => {
  const db = openDatabase(":memory:");
  try {
    for (let i = 0; i < 5; i += 1) assert.equal(checkDatabaseWritable(db).status, "ok");
    const leftover = db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?")
      .get("table", "_unseen_healthz_probe");
    assert.equal(leftover, undefined);
  } finally { db.close(); }
});

test("checkDatabaseWritable: down when the connection cannot BEGIN a transaction", () => {
  const fakeDb = { exec(sql) { if (sql === "BEGIN IMMEDIATE") throw new Error("database is locked"); } };
  const result = checkDatabaseWritable(fakeDb);
  assert.equal(result.status, "down");
  assert.equal(result.writable, false);
  assert.equal(result.error, "database is locked");
});

test("checkDatabaseWritable: down (and still rolls back) when the write itself fails", () => {
  const calls = [];
  const fakeDb = {
    exec(sql) { calls.push(sql); if (sql.startsWith("CREATE TABLE")) throw new Error("disk I/O error"); }
  };
  const result = checkDatabaseWritable(fakeDb);
  assert.equal(result.status, "down");
  assert.equal(result.error, "disk I/O error");
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "BEGIN IMMEDIATE");
  assert.match(calls[1], /^CREATE TABLE IF NOT EXISTS/);
  assert.equal(calls[2], "ROLLBACK", "must always roll back, even when the write itself failed");
});

// ---------------------------------------------------------------------------------------------
// checkDiskSpace
// ---------------------------------------------------------------------------------------------

function fakeStatfs({ totalBytes, availableBytes, bsize = 4096 }) {
  return () => ({ bsize, blocks: Math.round(totalBytes / bsize), bavail: Math.round(availableBytes / bsize) });
}

test("checkDiskSpace: ok on a huge disk even at a low free PERCENT, as long as absolute bytes are fine", () => {
  // Exactly the dev-machine scenario that motivated the bytes-AND-percent rule: a 245GB disk at
  // 3.6% free is still 8.8GB of headroom for a personal-scale sqlite+media app.
  const result = checkDiskSpace("/data", {}, { statfs: fakeStatfs({ totalBytes: 245e9, availableBytes: 8.8e9 }) });
  assert.equal(result.status, "ok");
  assert.ok(result.availablePercent < 10);
});

test("checkDiskSpace: degraded on a small disk with a low free PERCENT even though bytes look modest", () => {
  const result = checkDiskSpace("/data", {}, { statfs: fakeStatfs({ totalBytes: 2e9, availableBytes: 150e6 }) });
  assert.equal(result.status, "degraded");
});

test("checkDiskSpace: down when both bytes and percent are critically low", () => {
  const result = checkDiskSpace("/data", {}, { statfs: fakeStatfs({ totalBytes: 2e9, availableBytes: 20e6 }) });
  assert.equal(result.status, "down");
});

test("checkDiskSpace: custom thresholds are honored (both bytes and percent must cross to flip status)", () => {
  const statfs = fakeStatfs({ totalBytes: 100e9, availableBytes: 40e9 }); // 40GB free, 40%
  const ok = checkDiskSpace("/data", {}, { statfs }); // default thresholds: 40GB >> 500MB warnBytes -> ok
  assert.equal(ok.status, "ok");
  // Raise warnPercent above 40% AND warnBytes above 40GB so BOTH conditions cross this time.
  const degraded = checkDiskSpace("/data", { warnPercent: 50, warnBytes: 100e9 }, { statfs });
  assert.equal(degraded.status, "degraded");
});

test("checkDiskSpace: down when statfs itself throws (missing/unmounted path)", () => {
  const result = checkDiskSpace("/no/such/path", {}, { statfs: () => { throw new Error("ENOENT"); } });
  assert.equal(result.status, "down");
  assert.equal(result.error, "ENOENT");
});

// ---------------------------------------------------------------------------------------------
// checkClipSidecar
// ---------------------------------------------------------------------------------------------

test("checkClipSidecar: disabled reports ok without making any network call", async () => {
  let called = false;
  const result = await checkClipSidecar({ enabled: false, fetchImpl: async () => { called = true; } });
  assert.deepEqual(result, { status: "ok", enabled: false });
  assert.equal(called, false);
});

test("checkClipSidecar: ok when the sidecar answers 200", async () => {
  const result = await checkClipSidecar({ enabled: true, fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(result.status, "ok");
  assert.equal(result.enabled, true);
});

test("checkClipSidecar: down when the sidecar answers a non-2xx", async () => {
  const result = await checkClipSidecar({ enabled: true, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(result.status, "down");
  assert.equal(result.error, "sidecar_http_503");
});

test("checkClipSidecar: down (not a hang) when the sidecar is unreachable", async () => {
  const result = await checkClipSidecar({ enabled: true,
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8791"); } });
  assert.equal(result.status, "down");
  assert.match(result.error, /ECONNREFUSED/);
});

test("checkClipSidecar: a slow sidecar is aborted at timeoutMs and reported down, never hangs the caller", async () => {
  const startedAt = Date.now();
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    // Never resolves on its own -- only the AbortSignal should end this.
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const result = await checkClipSidecar({ enabled: true, timeoutMs: 40, fetchImpl });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, "down");
  assert.equal(result.error, "clip_sidecar_timeout");
  assert.ok(elapsedMs < 500, `expected the timeout to bound latency, took ${elapsedMs}ms`);
});

// ---------------------------------------------------------------------------------------------
// aggregateHealthStatus
// ---------------------------------------------------------------------------------------------

const OK_OTP = { ready: true };
const BAD_OTP = { ready: false };
const OK_DB = { status: "ok" };
const DOWN_DB = { status: "down" };
const OK_DISK = { status: "ok" };
const DEGRADED_DISK = { status: "degraded" };
const DOWN_DISK = { status: "down" };
const OK_CLIP = { status: "ok" };
const DOWN_CLIP = { status: "down" };

test("aggregateHealthStatus: all-ok is ok", () => {
  assert.equal(aggregateHealthStatus({ otpDelivery: OK_OTP, db: OK_DB, disk: OK_DISK, clipSidecar: OK_CLIP }), "ok");
});

test("aggregateHealthStatus: db down always wins as down, regardless of everything else", () => {
  assert.equal(aggregateHealthStatus({ otpDelivery: OK_OTP, db: DOWN_DB, disk: OK_DISK, clipSidecar: OK_CLIP }), "down");
});

test("aggregateHealthStatus: disk down is down even if db/otp/clip are fine", () => {
  assert.equal(aggregateHealthStatus({ otpDelivery: OK_OTP, db: OK_DB, disk: DOWN_DISK, clipSidecar: OK_CLIP }), "down");
});

test("aggregateHealthStatus: CLIP sidecar down is degraded, never down -- the canonical 'site still browsable' case", () => {
  assert.equal(aggregateHealthStatus({ otpDelivery: OK_OTP, db: OK_DB, disk: OK_DISK, clipSidecar: DOWN_CLIP }),
    "degraded");
});

test("aggregateHealthStatus: OTP not ready is degraded, never down (matches pre-existing behavior)", () => {
  assert.equal(aggregateHealthStatus({ otpDelivery: BAD_OTP, db: OK_DB, disk: OK_DISK, clipSidecar: OK_CLIP }),
    "degraded");
});

test("aggregateHealthStatus: low (but not critical) disk is degraded", () => {
  assert.equal(aggregateHealthStatus({ otpDelivery: OK_OTP, db: OK_DB, disk: DEGRADED_DISK, clipSidecar: OK_CLIP }),
    "degraded");
});

test("aggregateHealthStatus: multiple simultaneous degraded reasons still collapse to degraded, not down", () => {
  assert.equal(aggregateHealthStatus({ otpDelivery: BAD_OTP, db: OK_DB, disk: DEGRADED_DISK, clipSidecar: DOWN_CLIP }),
    "degraded");
});

test("aggregateHealthStatus: down always beats degraded when both are present", () => {
  assert.equal(aggregateHealthStatus({ otpDelivery: BAD_OTP, db: DOWN_DB, disk: DEGRADED_DISK, clipSidecar: DOWN_CLIP }),
    "down");
});

// ---------------------------------------------------------------------------------------------
// cachedHealthCheck
// ---------------------------------------------------------------------------------------------

test("cachedHealthCheck: serves cached results within the TTL window", async () => {
  let calls = 0;
  let clockMs = 1_000;
  const cached = cachedHealthCheck(async () => { calls += 1; return { status: "ok", n: calls }; },
    { ttlMs: 10_000, now: () => clockMs });
  const first = await cached();
  assert.equal(first.cached, false);
  assert.equal(calls, 1);
  clockMs += 5_000; // still inside the 10s window
  const second = await cached();
  assert.equal(second.cached, true);
  assert.equal(second.n, 1);
  assert.equal(calls, 1, "must not have recomputed");
});

test("cachedHealthCheck: recomputes once the TTL has elapsed", async () => {
  let calls = 0;
  let clockMs = 0;
  const cached = cachedHealthCheck(async () => { calls += 1; return { status: "ok", n: calls }; },
    { ttlMs: 1_000, now: () => clockMs });
  await cached();
  clockMs = 1_001;
  const result = await cached();
  assert.equal(result.cached, false);
  assert.equal(calls, 2);
});

test("cachedHealthCheck: concurrent callers during one in-flight computation share it (no duplicate work)", async () => {
  let calls = 0;
  let releaseCompute;
  const gate = new Promise((resolve) => { releaseCompute = resolve; });
  const cached = cachedHealthCheck(async () => { calls += 1; await gate; return { status: "ok", n: calls }; },
    { ttlMs: 10_000, now: () => 0 });
  const p1 = cached();
  const p2 = cached();
  const p3 = cached();
  releaseCompute();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(calls, 1, "three concurrent callers must trigger only one real computation");
  assert.deepEqual([r1.n, r2.n, r3.n], [1, 1, 1]);
  assert.deepEqual([r1.cached, r2.cached, r3.cached], [false, false, false],
    "none of them were served a stale cache -- they all got this fresh computation");
});

test("cachedHealthCheck: a failed computation is not cached and a later call can retry", async () => {
  let calls = 0;
  const cached = cachedHealthCheck(async () => {
    calls += 1;
    if (calls === 1) throw new Error("probe_failed");
    return { status: "ok", n: calls };
  }, { ttlMs: 10_000, now: () => 0 });
  await assert.rejects(cached(), /probe_failed/);
  const result = await cached();
  assert.equal(result.status, "ok");
  assert.equal(calls, 2, "the failed attempt must not have poisoned the cache");
});

// ---------------------------------------------------------------------------------------------
// End-to-end through the real HTTP layer: /healthz status code mapping + sidecar timeout budget
// ---------------------------------------------------------------------------------------------

async function bootPersistentApi(extra = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-healthz-http-"));
  const api = new LocalApi({
    database: path.join(directory, "api.sqlite"),
    keyring: new LocalKeyring({ persistent: true }),
    mediaStore: new FilesystemMediaStore(path.join(directory, "media")),
    otpSink: () => {},
    ...extra
  });
  await api.ready;
  const server = createLocalHttpServer({ api });
  const listening = await listenLocalHttpServer(server, { host: "127.0.0.1", port: 0 });
  api.campaigns.publicOrigin = listening.origin;
  return { api, server, origin: listening.origin, directory,
    async close() { await new Promise((resolve) => server.close(resolve)); api.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("/healthz: degraded CLIP sidecar still answers HTTP 200 (site stays up)", async (t) => {
  const deployment = await bootPersistentApi({ health: { cacheTtlMs: 0,
    clipSidecar: { enabled: true, baseUrl: "http://127.0.0.1:1", timeoutMs: 200 } } });
  t.after(() => deployment.close());
  const response = await fetch(`${deployment.origin}/healthz`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.clipSidecar.status, "down");
});

test("/healthz: db down (simulated) is the one case that answers a non-200", async (t) => {
  const deployment = await bootPersistentApi({ health: { cacheTtlMs: 0 } });
  t.after(() => deployment.close());
  const originalExec = deployment.api.db.exec.bind(deployment.api.db);
  deployment.api.db.exec = (sql) => { if (sql === "BEGIN IMMEDIATE") throw new Error("simulated_db_down"); return originalExec(sql); };
  const response = await fetch(`${deployment.origin}/healthz`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.status, "down");
  assert.equal(body.db.status, "down");
});

test("/healthz: a wedged CLIP sidecar cannot delay the response past its own short timeout", async (t) => {
  const deployment = await bootPersistentApi({ health: { cacheTtlMs: 0,
    clipSidecar: { enabled: true, baseUrl: "http://127.0.0.1:1", timeoutMs: 150 } } });
  t.after(() => deployment.close());
  const startedAt = Date.now();
  const response = await fetch(`${deployment.origin}/healthz`);
  await response.json();
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 2_000, `expected the sidecar timeout to bound the whole request, took ${elapsedMs}ms`);
});

test("/healthz: repeated requests inside the cache TTL reuse the same computation (cached:true)", async (t) => {
  const deployment = await bootPersistentApi({ health: { cacheTtlMs: 60_000 } });
  t.after(() => deployment.close());
  const first = await (await fetch(`${deployment.origin}/healthz`)).json();
  const second = await (await fetch(`${deployment.origin}/healthz`)).json();
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
});
