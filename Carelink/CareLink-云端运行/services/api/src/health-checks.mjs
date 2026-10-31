// Real health checks for /healthz — 2026-08-18, in response to the 06:51-09:00 crash-loop
// (private_ai_worker_configuration_invalid, 80+ restarts, three hours nobody noticed) that
// exposed the old healthz as OTP-config-only theater: DB down, CLIP sidecar dead, or the disk
// full all still returned 200 "ok". Every function here is pure/dependency-injected (a `db`
// handle, a `fetchImpl`, an injectable `now`/`statfs`) precisely so the tri-state logic and the
// caching wrapper can be unit tested without a live server — see tests/health-checks.test.mjs.
//
// Status contract used everywhere below:
//   "ok"       — check passed, no operator action needed.
//   "degraded" — a real problem, but the site is still browsable/servable (e.g. the CLIP
//                sidecar is dead, so photo placement can't auto-locate, but viewing/uploading
//                still works; OTP delivery isn't configured, so login-by-email can't send, but
//                that alone doesn't mean existing sessions or already-placed photos are broken).
//   "down"     — genuinely not servable: the database can't be written to, or the disk is
//                critically full. These are the ONLY conditions allowed to flip the aggregate
//                `status` (see aggregateHealthStatus below) to "down", which is in turn the
//                ONLY thing that makes http-server.mjs answer /healthz with a non-200. Every
//                other bad sub-check reports as "degraded" and still yields HTTP 200 — matching
//                the explicit ask: don't manufacture a false "site is down" page from a problem
//                that doesn't actually take the site down (that false-alarm/no-alarm flip-flop
//                is exactly what made the old healthz useless as a signal).
import { statfsSync } from "node:fs";

const HEALTHZ_PROBE_TABLE = "_unseen_healthz_probe";

// Verifies the database can actually be WRITTEN to, not just read (a plain `SELECT 1` says
// nothing about a read-only filesystem, a full disk, or a corrupt WAL). Runs inside its own
// BEGIN IMMEDIATE / ROLLBACK: BEGIN IMMEDIATE forces a real write-lock acquisition (fails fast
// if the DB is wedged/locked), CREATE TABLE IF NOT EXISTS + INSERT force a real page write, and
// the unconditional ROLLBACK means nothing here is ever visible to any other reader — no
// business table is touched, no row survives, schema_migrations/WAL are untouched by the time
// this returns. Entirely synchronous (node:sqlite's DatabaseSync is sync) and runs with no
// `await` in the critical section, so nothing else on this single-threaded process can interleave
// a conflicting transaction mid-probe.
export function checkDatabaseWritable(db) {
  const startedAt = Date.now();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ${HEALTHZ_PROBE_TABLE}(id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)`);
      db.prepare(`INSERT INTO ${HEALTHZ_PROBE_TABLE}(checked_at) VALUES(?)`).run(new Date().toISOString());
    } finally {
      db.exec("ROLLBACK");
    }
    return { status: "ok", writable: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { status: "down", writable: false, latencyMs: Date.now() - startedAt,
      error: typeof error?.message === "string" ? error.message : "db_write_check_failed" };
  }
}

const DEFAULT_DISK_THRESHOLDS = { warnPercent: 10, criticalPercent: 3,
  warnBytes: 500 * 1024 * 1024, criticalBytes: 100 * 1024 * 1024 };

// Available bytes/percent on the filesystem backing `targetPath` (the sqlite/media data
// directory). Below criticalBytes/criticalPercent is "down" (writes are about to start failing
// outright); below warnBytes/warnPercent is "degraded" (still serving, but an operator should
// look before it becomes critical). BOTH the bytes threshold AND the percent threshold must
// trip together (not either alone): percent-only would false-positive on a huge shared disk
// where this app's data is a tiny fraction of a mostly-unrelated volume (e.g. a dev laptop at
// "only" 4% free that's still tens of GB of headroom for a service whose entire media directory
// is tens of MB) -- see the report for the exact dev-machine numbers that surfaced this. Bytes-
// only would miss a genuinely small production disk where a "high" percentage is still only a
// few hundred MB. Requiring both to agree keeps the check meaningful at both scales.
export function checkDiskSpace(targetPath, thresholds = {}, { statfs = statfsSync } = {}) {
  const merged = { ...DEFAULT_DISK_THRESHOLDS, ...thresholds };
  try {
    const stats = statfs(targetPath);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const availablePercent = totalBytes > 0 ? (availableBytes / totalBytes) * 100 : 0;
    const status = (availableBytes <= merged.criticalBytes && availablePercent <= merged.criticalPercent) ? "down" :
      (availableBytes <= merged.warnBytes && availablePercent <= merged.warnPercent) ? "degraded" : "ok";
    return { status, path: targetPath, availableBytes, totalBytes,
      availablePercent: Math.round(availablePercent * 100) / 100 };
  } catch (error) {
    // Can't be "ok" if we can't even see how much space is left -- but a stat failure on the
    // data directory (missing/unmounted/permission) is itself serious, so "down" rather than
    // "degraded" here matches the rule above (genuinely can't establish serviceability).
    return { status: "down", path: targetPath,
      error: typeof error?.message === "string" ? error.message : "disk_check_failed" };
  }
}

// Probes the CLIP sidecar's own /healthz with a hard, short timeout (default 1.5s, well under
// the outer request's patience) so a wedged/slow sidecar degrades the aggregate status but can
// never make /healthz itself hang. `enabled:false` (the UNSEEN_LOCATOR_MODE!=="clip" case) is
// reported as status "ok" -- the sidecar not running is not a problem when nothing is
// configured to use it -- so it never contributes to the aggregate being anything but ok.
export async function checkClipSidecar({ enabled = false, baseUrl = "http://127.0.0.1:8791", timeoutMs = 1500,
  fetchImpl = fetch } = {}) {
  if (!enabled) return { status: "ok", enabled: false };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/healthz`, { signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) return { status: "down", enabled: true, latencyMs, error: `sidecar_http_${response.status}` };
    return { status: "ok", enabled: true, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const timedOut = error?.name === "AbortError";
    return { status: "down", enabled: true, latencyMs,
      error: timedOut ? "clip_sidecar_timeout" :
        (typeof error?.message === "string" ? error.message : "clip_sidecar_unreachable") };
  } finally {
    clearTimeout(timer);
  }
}

// Aggregates every sub-check into the single top-level `status`. This is the one place that
// decides down-vs-degraded-vs-ok, kept as a small pure function (no I/O) so the whole decision
// matrix can be exhaustively unit tested. otpDelivery keeps its pre-existing shape/semantics
// (see otp-delivery-outbox.mjs#health()) -- not ready is treated as "degraded", matching
// existing behavior, never "down": an unconfigured OTP provider means email login can't send,
// not that the whole site is unservable.
export function aggregateHealthStatus({ otpDelivery, db, disk, clipSidecar }) {
  const down = db.status === "down" || disk.status === "down";
  if (down) return "down";
  const degraded = otpDelivery.ready !== true || disk.status === "degraded" || clipSidecar.status !== "ok";
  return degraded ? "degraded" : "ok";
}

// Wraps an async health computation with a small TTL cache plus in-flight de-duplication, so a
// monitoring timer hitting /healthz every minute (or several concurrent human/monitor requests
// landing in the same instant) doesn't re-run the DB/disk/sidecar probes on every single call.
// `now` is injectable for deterministic tests. Concurrent callers during a single in-flight
// computation all share that one computation's result (and are reported cached:false, since
// nothing stale was served) rather than each kicking off their own probe.
export function cachedHealthCheck(computeFn, { ttlMs = 10_000, now = () => Date.now() } = {}) {
  let cachedResult = null;
  let cachedAt = -Infinity;
  let inFlight = null;
  return async function getHealth() {
    if (cachedResult && now() - cachedAt < ttlMs) return { ...cachedResult, cached: true };
    if (!inFlight) {
      inFlight = computeFn().then((result) => {
        cachedResult = result;
        cachedAt = now();
        return result;
      }, (error) => { throw error; }).finally(() => { inFlight = null; });
    }
    const result = await inFlight;
    return { ...result, cached: false };
  };
}
