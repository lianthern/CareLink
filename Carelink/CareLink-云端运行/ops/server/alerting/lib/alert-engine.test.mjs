import assert from "node:assert/strict";
import test from "node:test";
import { classifyBackup, classifyDisk, classifyHealthz, classifyRestartLoop, classifyUnitActiveState,
  composeMessage, decideNotifications, detectRestartLoop, LEVEL_CRITICAL, LEVEL_OK, LEVEL_WARNING,
  sortFindingsBySeverity } from "./alert-engine.mjs";

// ---------------------------------------------------------------------------------------------
// classifyHealthz
// ---------------------------------------------------------------------------------------------

test("classifyHealthz: a failed fetch (server fully unreachable) is critical", () => {
  const result = classifyHealthz({ ok: false, httpStatus: null, body: null, errorMessage: "connect ECONNREFUSED" });
  assert.equal(result.level, LEVEL_CRITICAL);
  assert.match(result.detail, /ECONNREFUSED/);
});

test("classifyHealthz: non-200 (the only case /healthz itself uses for 'down') is critical", () => {
  const result = classifyHealthz({ ok: false, httpStatus: 503, body: { status: "down" }, errorMessage: null });
  assert.equal(result.level, LEVEL_CRITICAL);
  assert.match(result.detail, /503/);
});

test("classifyHealthz: HTTP 200 + status ok is ok", () => {
  const result = classifyHealthz({ ok: true, httpStatus: 200, body: { status: "ok" }, errorMessage: null });
  assert.equal(result.level, LEVEL_OK);
});

test("classifyHealthz: HTTP 200 + status degraded is a warning, not critical -- the site is still up", () => {
  const result = classifyHealthz({ ok: true, httpStatus: 200,
    body: { status: "degraded", clipSidecar: { status: "down" }, db: { status: "ok" }, disk: { status: "ok" },
      otpDelivery: { ready: true } },
    errorMessage: null });
  assert.equal(result.level, LEVEL_WARNING);
  assert.match(result.detail, /clipSidecar=down/);
});

test("classifyHealthz: degraded due to OTP not ready is called out by name", () => {
  const result = classifyHealthz({ ok: true, httpStatus: 200,
    body: { status: "degraded", db: { status: "ok" }, disk: { status: "ok" }, clipSidecar: { status: "ok", enabled: false },
      otpDelivery: { ready: false } },
    errorMessage: null });
  assert.equal(result.level, LEVEL_WARNING);
  assert.match(result.detail, /otpDelivery=not_ready/);
});

test("classifyHealthz: an unrecognized status string on a 200 is treated as critical (fail closed)", () => {
  const result = classifyHealthz({ ok: true, httpStatus: 200, body: { status: "???" }, errorMessage: null });
  assert.equal(result.level, LEVEL_CRITICAL);
});

// ---------------------------------------------------------------------------------------------
// classifyUnitActiveState
// ---------------------------------------------------------------------------------------------

test("classifyUnitActiveState: active is ok", () => {
  const result = classifyUnitActiveState({ name: "unseen-operable.service", kind: "service", activeState: "active" });
  assert.equal(result.level, LEVEL_OK);
});

test("classifyUnitActiveState: failed is critical and names the unit", () => {
  const result = classifyUnitActiveState({ name: "unseen-operable.service", kind: "service",
    activeState: "failed", subState: "failed" });
  assert.equal(result.level, LEVEL_CRITICAL);
  assert.match(result.detail, /unseen-operable\.service/);
  assert.match(result.detail, /failed/);
});

test("classifyUnitActiveState: a timer that's not active (disabled/masked) is critical too", () => {
  const result = classifyUnitActiveState({ name: "unseen-backup.timer", kind: "timer", activeState: "inactive" });
  assert.equal(result.level, LEVEL_CRITICAL);
});

// ---------------------------------------------------------------------------------------------
// detectRestartLoop / classifyRestartLoop -- the crash-loop signal itself
// ---------------------------------------------------------------------------------------------

test("detectRestartLoop: fewer than two samples in the window is inconclusive, not a loop", () => {
  const result = detectRestartLoop([{ t: 1000, n: 5 }], { nowMs: 1000, windowMs: 20 * 60_000, growthThreshold: 3 });
  assert.equal(result.loop, false);
});

test("detectRestartLoop: steady NRestarts (no growth) across the window is not a loop", () => {
  const samples = [{ t: 0, n: 12 }, { t: 60_000, n: 12 }, { t: 120_000, n: 12 }];
  const result = detectRestartLoop(samples, { nowMs: 120_000, windowMs: 20 * 60_000, growthThreshold: 3 });
  assert.equal(result.loop, false);
  assert.equal(result.growth, 0);
});

test("detectRestartLoop: fires at exactly the growth threshold within the window", () => {
  // Mirrors the real incident's shape: NRestarts climbing steadily every ~2-minute poll.
  const samples = [{ t: 0, n: 10 }, { t: 120_000, n: 11 }, { t: 240_000, n: 12 }, { t: 360_000, n: 13 }];
  const result = detectRestartLoop(samples, { nowMs: 360_000, windowMs: 20 * 60_000, growthThreshold: 3 });
  assert.equal(result.loop, true);
  assert.equal(result.growth, 3);
});

test("detectRestartLoop: samples outside the window are ignored (an old bump doesn't linger forever)", () => {
  const samples = [{ t: 0, n: 0 }, { t: 5_000, n: 20 }, // old spike, now outside the window
    { t: 25 * 60_000, n: 21 }, { t: 26 * 60_000, n: 21 }]; // recent, flat
  const result = detectRestartLoop(samples, { nowMs: 26 * 60_000, windowMs: 20 * 60_000, growthThreshold: 3 });
  assert.equal(result.loop, false, "the old spike must not count once it has aged out of the window");
});

test("classifyRestartLoop: maps loop:true to critical and names the unit", () => {
  const result = classifyRestartLoop({ name: "unseen-operable.service" }, { loop: true, growth: 5, samples: 6 });
  assert.equal(result.level, LEVEL_CRITICAL);
  assert.match(result.detail, /unseen-operable\.service/);
  assert.match(result.detail, /5/);
});

test("classifyRestartLoop: maps loop:false to ok", () => {
  const result = classifyRestartLoop({ name: "unseen-operable.service" }, { loop: false, growth: 0, samples: 6 });
  assert.equal(result.level, LEVEL_OK);
});

// ---------------------------------------------------------------------------------------------
// classifyDisk / classifyBackup
// ---------------------------------------------------------------------------------------------

test("classifyDisk: ok/degraded/down map to ok/warning/critical", () => {
  assert.equal(classifyDisk({ status: "ok", path: "/data", availablePercent: 50 }).level, LEVEL_OK);
  assert.equal(classifyDisk({ status: "degraded", path: "/data", availablePercent: 5, availableBytes: 1e8 }).level,
    LEVEL_WARNING);
  assert.equal(classifyDisk({ status: "down", path: "/data", availablePercent: 1, availableBytes: 1e6 }).level,
    LEVEL_CRITICAL);
});

test("classifyDisk: a stat failure is critical", () => {
  const result = classifyDisk({ status: "down", path: "/data", error: "ENOENT" });
  assert.equal(result.level, LEVEL_CRITICAL);
  assert.match(result.detail, /ENOENT/);
});

test("classifyBackup: no backup ever seen is critical", () => {
  const result = classifyBackup({ latestRunAt: null }, { nowMs: 1_000_000, maxAgeHours: 36 });
  assert.equal(result.level, LEVEL_CRITICAL);
});

test("classifyBackup: fresh backup is ok", () => {
  const nowMs = Date.parse("2026-08-18T09:00:00Z");
  const latestRunAt = Date.parse("2026-08-18T03:20:00Z"); // ~5.7h ago
  const result = classifyBackup({ latestRunAt }, { nowMs, maxAgeHours: 36 });
  assert.equal(result.level, LEVEL_OK);
});

test("classifyBackup: older than the threshold is critical", () => {
  const nowMs = Date.parse("2026-08-19T16:00:00Z");
  const latestRunAt = Date.parse("2026-08-18T03:20:00Z"); // ~36.7h ago
  const result = classifyBackup({ latestRunAt }, { nowMs, maxAgeHours: 36 });
  assert.equal(result.level, LEVEL_CRITICAL);
  assert.match(result.detail, /36/);
});

// ---------------------------------------------------------------------------------------------
// decideNotifications -- the anti-spam dedup core
// ---------------------------------------------------------------------------------------------

const REMINDER_MS = 60 * 60_000; // 1 hour, matching the brief's "每小时最多一次提醒"

function finding(id, level, detail = "detail") { return { id, level, detail, nextSteps: "next" }; }

test("decideNotifications: a brand-new problem notifies immediately (kind:new)", () => {
  const { notifications, nextState } = decideNotifications({
    findings: [finding("disk", LEVEL_CRITICAL)], previousState: {}, nowMs: 1000, reminderIntervalMs: REMINDER_MS });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "new");
  assert.equal(nextState.disk.level, LEVEL_CRITICAL);
  assert.equal(nextState.disk.lastNotifiedAt, 1000);
});

test("decideNotifications: the SAME bad level within the reminder window does not re-notify", () => {
  const previousState = { disk: { level: LEVEL_CRITICAL, since: 0, lastNotifiedAt: 0 } };
  const { notifications, nextState } = decideNotifications({
    findings: [finding("disk", LEVEL_CRITICAL)], previousState, nowMs: 30 * 60_000, reminderIntervalMs: REMINDER_MS });
  assert.equal(notifications.length, 0, "must not spam every 2-minute run for a single ongoing problem");
  assert.equal(nextState.disk.lastNotifiedAt, 0, "must not bump lastNotifiedAt when nothing was sent");
});

test("decideNotifications: past the reminder interval, the same bad level notifies again (kind:reminder)", () => {
  const previousState = { disk: { level: LEVEL_CRITICAL, since: 0, lastNotifiedAt: 0 } };
  const { notifications, nextState } = decideNotifications({
    findings: [finding("disk", LEVEL_CRITICAL)], previousState, nowMs: REMINDER_MS + 1,
    reminderIntervalMs: REMINDER_MS });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "reminder");
  assert.equal(notifications[0].sinceMs, 0, "the reminder must still report the ORIGINAL onset time, not now");
  assert.equal(nextState.disk.since, 0, "since must be preserved across reminders");
  assert.equal(nextState.disk.lastNotifiedAt, REMINDER_MS + 1);
});

test("decideNotifications: recovery (bad -> ok) always notifies once, regardless of timing", () => {
  const previousState = { disk: { level: LEVEL_CRITICAL, since: 0, lastNotifiedAt: 500 } };
  const { notifications, nextState } = decideNotifications({
    findings: [finding("disk", LEVEL_OK, "磁盘空间正常")], previousState, nowMs: 600, reminderIntervalMs: REMINDER_MS });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "recovered");
  assert.equal(notifications[0].sinceMs, 0, "reports how long the original problem lasted");
  assert.equal(nextState.disk.level, LEVEL_OK);
});

test("decideNotifications: staying ok never notifies and never resets `since`", () => {
  const previousState = { disk: { level: LEVEL_OK, since: 0, lastNotifiedAt: null } };
  const { notifications, nextState } = decideNotifications({
    findings: [finding("disk", LEVEL_OK)], previousState, nowMs: 99_999, reminderIntervalMs: REMINDER_MS });
  assert.equal(notifications.length, 0);
  assert.equal(nextState.disk.since, 0);
});

test("decideNotifications: severity flip (warning -> critical) is treated as a new problem, not a reminder", () => {
  const previousState = { healthz: { level: LEVEL_WARNING, since: 0, lastNotifiedAt: 0 } };
  const { notifications } = decideNotifications({
    findings: [finding("healthz", LEVEL_CRITICAL)], previousState, nowMs: 100, reminderIntervalMs: REMINDER_MS });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "new");
});

test("decideNotifications: an unseen finding id starts clean (no crash on missing prior state)", () => {
  const { notifications } = decideNotifications({
    findings: [finding("brand-new-check", LEVEL_OK)], previousState: {}, nowMs: 0, reminderIntervalMs: REMINDER_MS });
  assert.equal(notifications.length, 0);
});

test("decideNotifications: independent findings are deduped independently of each other", () => {
  const previousState = { disk: { level: LEVEL_CRITICAL, since: 0, lastNotifiedAt: 0 },
    healthz: { level: LEVEL_OK, since: 0, lastNotifiedAt: null } };
  const { notifications } = decideNotifications({
    findings: [finding("disk", LEVEL_CRITICAL), finding("healthz", LEVEL_WARNING)],
    previousState, nowMs: 1000, reminderIntervalMs: REMINDER_MS });
  assert.equal(notifications.length, 1, "only the healthz flip should notify; disk is still inside its reminder window");
  assert.equal(notifications[0].id, "healthz");
});

// ---------------------------------------------------------------------------------------------
// composeMessage / sortFindingsBySeverity
// ---------------------------------------------------------------------------------------------

test("composeMessage: no notifications composes to null (nothing to send)", () => {
  assert.equal(composeMessage([], { hostname: "unseen-prod", generatedAt: "now" }), null);
});

test("composeMessage: is Chinese, names the host, and includes next-step guidance for a new problem", () => {
  const message = composeMessage(
    [{ id: "disk", level: LEVEL_CRITICAL, detail: "磁盘空间严重不足", nextSteps: "df -h /data", kind: "new",
      sinceMs: 0, nowMs: 5 * 60_000 }],
    { hostname: "unseen-prod", generatedAt: "2026-08-18 12:00" });
  assert.match(message, /unseen-prod/);
  assert.match(message, /磁盘空间严重不足/);
  assert.match(message, /df -h \/data/);
  assert.match(message, /5 分钟/);
});

test("composeMessage: a recovered finding is labeled distinctly and omits next-step guidance", () => {
  const message = composeMessage(
    [{ id: "disk", level: LEVEL_CRITICAL, detail: "磁盘空间严重不足", nextSteps: "df -h /data", kind: "recovered",
      sinceMs: 0, nowMs: 3_600_000 }],
    { hostname: "unseen-prod", generatedAt: "now" });
  assert.match(message, /已恢复/);
  assert.doesNotMatch(message, /下一步/);
});

test("composeMessage: never leaks anything resembling a secret/token/email -- inputs are the only source of truth", () => {
  const message = composeMessage(
    [{ id: "healthz", level: LEVEL_CRITICAL, detail: "healthz 请求失败：connect ECONNREFUSED", nextSteps: "next",
      kind: "new", sinceMs: 0, nowMs: 1000 }],
    { hostname: "unseen-prod", generatedAt: "now" });
  assert.doesNotMatch(message, /@/); // no email-shaped content
  assert.doesNotMatch(message, /bot\d+:/i); // no telegram-bot-token shape
});

test("sortFindingsBySeverity: critical first, then warning, then ok; stable within a level", () => {
  const findings = [finding("a", LEVEL_OK), finding("b", LEVEL_CRITICAL), finding("c", LEVEL_WARNING),
    finding("d", LEVEL_CRITICAL)];
  const sorted = sortFindingsBySeverity(findings).map((entry) => entry.id);
  assert.deepEqual(sorted, ["b", "d", "c", "a"]);
});
