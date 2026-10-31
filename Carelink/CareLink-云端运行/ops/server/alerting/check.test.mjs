// Tests the I/O-adjacent helpers in check.mjs by injecting a fake `spawn`/`readdir`/`now` --
// no real systemctl, curl, or network call happens in this file. See lib/alert-engine.test.mjs
// for the exhaustive tri-state/dedup matrix; this file is about check.mjs's own plumbing:
// parsing curl/systemctl output correctly, restart-sample bookkeeping across runs, and making
// sure the Telegram secret never ends up in a spawned child's argv.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFindings, latestBackupRun, loadConfig, probeHealthz, queryUnit, runCheck,
  sendTelegram } from "./check.mjs";
import { LEVEL_CRITICAL, LEVEL_OK } from "./lib/alert-engine.mjs";

function fakeSpawnResult({ status = 0, stdout = "", stderr = "", error = null } = {}) {
  return () => ({ status, stdout, stderr, error });
}

// ---------------------------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------------------------

test("loadConfig: sane defaults with no environment set at all", () => {
  const config = loadConfig({});
  assert.equal(config.healthzUrl, "http://127.0.0.1:4300/healthz");
  assert.equal(config.healthzHost, "unseen.maxxam.xyz");
  assert.deepEqual(config.units, ["huijian.service", "unseen-operable.service", "unseen-minimax-worker.service", "unseen-backup.timer"]);
  assert.equal(config.telegramChatId, "8223150297");
  assert.equal(config.telegramBotToken, "");
  assert.equal(config.dryRun, false);
  assert.deepEqual(config.diskThresholds, {}); // no overrides -> checkDiskSpace uses its own defaults
});

test("loadConfig: every value is overridable via environment", () => {
  const config = loadConfig({ UNSEEN_ALERT_HEALTHZ_URL: "http://127.0.0.1:9999/healthz",
    UNSEEN_ALERT_UNITS: "a.service b.timer", UNSEEN_ALERT_DRY_RUN: "true",
    UNSEEN_ALERT_DISK_WARN_PERCENT: "20", UNSEEN_ALERT_TELEGRAM_BOT_TOKEN: "123:ABC" });
  assert.equal(config.healthzUrl, "http://127.0.0.1:9999/healthz");
  assert.deepEqual(config.units, ["a.service", "b.timer"]);
  assert.equal(config.dryRun, true);
  assert.deepEqual(config.diskThresholds, { warnPercent: 20 });
  assert.equal(config.telegramBotToken, "123:ABC");
});

// ---------------------------------------------------------------------------------------------
// probeHealthz
// ---------------------------------------------------------------------------------------------

test("probeHealthz: parses a healthy JSON body and 200 status from curl's combined stdout", () => {
  const spawn = fakeSpawnResult({ stdout: '{"status":"ok"}\n200' });
  const result = probeHealthz(loadConfig({}), { spawn });
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.body, { status: "ok" });
});

test("probeHealthz: a 503 with a degraded/down body is not ok", () => {
  const spawn = fakeSpawnResult({ stdout: '{"status":"down","db":{"status":"down"}}\n503' });
  const result = probeHealthz(loadConfig({}), { spawn });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 503);
});

test("probeHealthz: curl itself failing to spawn (e.g. not installed) surfaces as errorMessage", () => {
  const spawn = fakeSpawnResult({ error: new Error("spawn curl ENOENT") });
  const result = probeHealthz(loadConfig({}), { spawn });
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /ENOENT/);
});

test("probeHealthz: curl exiting non-zero (connection refused, timeout, ...) surfaces stderr", () => {
  const spawn = fakeSpawnResult({ status: 7, stderr: "curl: (7) Failed to connect to 127.0.0.1 port 4300\n" });
  const result = probeHealthz(loadConfig({}), { spawn });
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /Failed to connect/);
});

test("probeHealthz: sends the configured Host header and hits the configured URL", () => {
  let capturedArgs = null;
  const spawn = (bin, args) => { capturedArgs = args; return { status: 0, stdout: '{"status":"ok"}\n200' }; };
  probeHealthz(loadConfig({ UNSEEN_ALERT_HEALTHZ_HOST: "example.test",
    UNSEEN_ALERT_HEALTHZ_URL: "http://127.0.0.1:1234/healthz" }), { spawn });
  assert.ok(capturedArgs.includes("Host: example.test"));
  assert.ok(capturedArgs.includes("http://127.0.0.1:1234/healthz"));
});

// ---------------------------------------------------------------------------------------------
// queryUnit
// ---------------------------------------------------------------------------------------------

test("queryUnit: parses ActiveState/SubState/NRestarts for a .service unit", () => {
  const spawn = fakeSpawnResult({ stdout: "ActiveState=active\nSubState=running\nNRestarts=42\n" });
  const result = queryUnit("unseen-operable.service", loadConfig({}), { spawn });
  assert.equal(result.kind, "service");
  assert.equal(result.activeState, "active");
  assert.equal(result.nrestarts, 42);
});

test("queryUnit: a .timer unit only checks ActiveState (no NRestarts concept)", () => {
  const spawn = fakeSpawnResult({ stdout: "ActiveState=active\nSubState=waiting\n" });
  const result = queryUnit("unseen-backup.timer", loadConfig({}), { spawn });
  assert.equal(result.kind, "timer");
  assert.equal(result.nrestarts, null);
});

test("queryUnit: systemctl failure (unit missing, systemctl not found, ...) fails closed to 'unknown'", () => {
  const spawn = fakeSpawnResult({ status: 1, stderr: "Unit foo.service could not be found.\n" });
  const result = queryUnit("foo.service", loadConfig({}), { spawn });
  assert.equal(result.activeState, "unknown");
  assert.match(result.queryError, /could not be found/);
});

// ---------------------------------------------------------------------------------------------
// latestBackupRun
// ---------------------------------------------------------------------------------------------

function direntLike(name, isDir = true) { return { name, isDirectory: () => isDir }; }

test("latestBackupRun: picks the newest timestamped directory and ignores junk entries", () => {
  const readdir = () => [direntLike("20260815T031500Z"), direntLike("20260817T031829Z"),
    direntLike("20260816T031602Z"), direntLike(".backup.lock", false), direntLike(".gnupg"),
    direntLike(".tmp-20260818T031500Z.abc123")];
  const result = latestBackupRun("/var/backups/unseen", { readdir });
  assert.equal(result.latestRunAt, Date.UTC(2026, 7, 17, 3, 18, 29));
});

test("latestBackupRun: an empty/never-backed-up directory reports latestRunAt: null", () => {
  const result = latestBackupRun("/var/backups/unseen", { readdir: () => [] });
  assert.equal(result.latestRunAt, null);
});

test("latestBackupRun: a missing backup root reports null with a queryError, not a throw", () => {
  const result = latestBackupRun("/var/backups/unseen", { readdir: () => { throw new Error("ENOENT"); } });
  assert.equal(result.latestRunAt, null);
  assert.match(result.queryError, /ENOENT/);
});

// ---------------------------------------------------------------------------------------------
// sendTelegram -- the token-never-in-argv invariant is the whole point of this section
// ---------------------------------------------------------------------------------------------

test("sendTelegram: dry run never spawns curl and reports sent:false", () => {
  let called = false;
  const spawn = () => { called = true; return { status: 0, stdout: "200" }; };
  const result = sendTelegram("test message", loadConfig({ UNSEEN_ALERT_DRY_RUN: "true",
    UNSEEN_ALERT_TELEGRAM_BOT_TOKEN: "123:ABC" }), { spawn });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "dry_run");
  assert.equal(called, false);
});

test("sendTelegram: missing token refuses to send without spawning curl", () => {
  let called = false;
  const spawn = () => { called = true; return { status: 0, stdout: "200" }; };
  const result = sendTelegram("test message", loadConfig({}), { spawn });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "missing_token");
  assert.equal(called, false);
});

test("sendTelegram: the bot token is passed via curl's stdin config, NEVER as a spawned argv element", () => {
  let capturedArgs = null;
  let capturedInput = null;
  const spawn = (bin, args, options) => {
    capturedArgs = args;
    capturedInput = options.input;
    return { status: 0, stdout: "200" };
  };
  const token = "123456789:AAExampleSecretTokenValue";
  sendTelegram("测试消息", loadConfig({ UNSEEN_ALERT_TELEGRAM_BOT_TOKEN: token }), { spawn });
  assert.equal(capturedArgs.includes(token), false, "token must never appear as a raw curl argv element");
  for (const arg of capturedArgs) assert.doesNotMatch(String(arg), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(capturedInput, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the token must reach curl only via its -K stdin config");
  assert.deepEqual(capturedArgs, ["-K", "-"]);
});

test("sendTelegram: a rejected send (bad token, Telegram 4xx) is reported without throwing", () => {
  const spawn = () => ({ status: 0, stdout: '{"ok":false,"description":"Unauthorized"}\n401' });
  const result = sendTelegram("msg", loadConfig({ UNSEEN_ALERT_TELEGRAM_BOT_TOKEN: "bad:token-not-production" }), { spawn });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "telegram_rejected");
  assert.equal(result.httpStatus, 401);
});

test("sendTelegram: a successful send is reported sent:true", () => {
  const spawn = () => ({ status: 0, stdout: '{"ok":true,"result":{}}\n200' });
  const result = sendTelegram("msg", loadConfig({ UNSEEN_ALERT_TELEGRAM_BOT_TOKEN: "good:token-not-production" }), { spawn });
  assert.equal(result.sent, true);
});

// ---------------------------------------------------------------------------------------------
// buildFindings -- restart-sample bookkeeping across (simulated) runs
// ---------------------------------------------------------------------------------------------

test("buildFindings: accumulates restart samples across calls and flags a loop once growth crosses the threshold", () => {
  const config = loadConfig({ UNSEEN_ALERT_RESTART_LOOP_WINDOW_MIN: "20", UNSEEN_ALERT_RESTART_LOOP_THRESHOLD: "3" });
  let restartSamples = {};
  let nowMs = 0;
  const baseFinding = { healthzResult: { ok: true, httpStatus: 200, body: { status: "ok" } },
    diskResult: { status: "ok", path: "/data", availablePercent: 50 } };
  // Steady at 10, then starts climbing: 10 -> 10 -> 11 -> 12 -> 13 (total growth 3 by the last sample).
  for (const nrestarts of [10, 10, 11, 12, 13]) {
    const unit = { name: "unseen-operable.service", kind: "service", activeState: "active", subState: "running",
      nrestarts };
    const result = buildFindings(config, { ...baseFinding, nowMs, unitResults: [unit],
      backupResult: { latestRunAt: nowMs }, restartSamples });
    restartSamples = result.restartSamples;
    const loopFinding = result.findings.find((f) => f.id === "restart-loop:unseen-operable.service");
    const expectedLevel = nrestarts === 13 ? LEVEL_CRITICAL : LEVEL_OK;
    assert.equal(loopFinding.level, expectedLevel, `at nrestarts=${nrestarts} (t=${nowMs})`);
    nowMs += 2 * 60_000; // 2-minute timer cadence
  }
});

// ---------------------------------------------------------------------------------------------
// runCheck -- end-to-end with everything injected: proves dedup survives a real state-file
// round trip (JSON write + read), not just the in-memory decideNotifications logic.
// ---------------------------------------------------------------------------------------------

async function withTempStateFile(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-alert-check-test-"));
  try { return await fn(path.join(dir, "state.json")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("runCheck: first run with a critical finding notifies; the immediate next run does not (dedup via real state file)", async () => {
  await withTempStateFile(async (stateFile) => {
    const sentMessages = [];
    const spawn = (bin, args) => {
      if (args[0] === "-sS" && args.at(-1).includes(':4611')) {
        const route=new URL(args.at(-1)).pathname;
        return {status:0,stdout:({'/api/health':'{"ok":true,"buildId":"test"}','/app':'<!doctype html><html>app-assets</html>','/api/app-catalog':'{"cases":[{}]}'}[route])+'\n200'};
      }
      if (args[0] === "-sS") return { status: 0, stdout: '{"status":"down","db":{"status":"down"}}\n503' }; // healthz
      if (args[0] === "show") return { status: 0, stdout: "ActiveState=active\nSubState=running\nNRestarts=0\n" };
      if (args[0] === "-K") { sentMessages.push(args); return { status: 0, stdout: "200" }; }
      throw new Error(`unexpected spawn: ${bin} ${args.join(" ")}`);
    };
    const config = loadConfig({ UNSEEN_ALERT_STATE_FILE: stateFile, UNSEEN_ALERT_TELEGRAM_BOT_TOKEN: "123:ABC",
      UNSEEN_ALERT_UNITS: "unseen-operable.service", UNSEEN_ALERT_BACKUP_ROOT: "/nonexistent-in-this-test",
      // Point disk-space checking at a directory that actually exists on the test machine (a
      // temp dir), so this test's healthz-down scenario isn't confounded by an unrelated
      // "disk path doesn't exist" finding from the real UNSEEN_ALERT_DISK_PATH default.
      UNSEEN_ALERT_DISK_PATH: path.dirname(stateFile) });
    // A fresh-looking backup dir so this test's healthz-down scenario is the ONLY problem in
    // play -- nowMs below is an arbitrary (very early, 1970-ish) fake clock, so any real-looking
    // 2020s-dated backup directory always reads as "in the future" (negative age), i.e. fresh.
    const readdir = () => [{ name: "20260817T031500Z", isDirectory: () => true }];
    let nowMs = 1_000_000;
    const first = await runCheck(config, { now: () => nowMs, spawn, readdir });
    assert.equal(first.notifications.length, 1, "the down healthz must notify on first sight");
    assert.equal(first.sendResult.sent, true);

    nowMs += 2 * 60_000; // next timer tick, still the same problem
    const second = await runCheck(config, { now: () => nowMs, spawn, readdir });
    assert.equal(second.notifications.length, 0, "must not re-notify the same ongoing problem two minutes later");
    assert.equal(second.sendResult, null);

    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(persisted.findings.healthz.level, LEVEL_CRITICAL);
    assert.equal(sentMessages.length, 1, "only the first run should have actually sent a Telegram message");
  });
});

test("runCheck: recovery after a critical run sends an 已恢复 notification", async () => {
  await withTempStateFile(async (stateFile) => {
    let healthy = false;
    const spawn = (bin, args) => {
      if (args[0] === "-sS" && args.at(-1).includes(':4611')) {
        const route=new URL(args.at(-1)).pathname;
        return {status:0,stdout:({'/api/health':'{"ok":true,"buildId":"test"}','/app':'<!doctype html><html>app-assets</html>','/api/app-catalog':'{"cases":[{}]}'}[route])+'\n200'};
      }
      if (args[0] === "-sS") return healthy ? { status: 0, stdout: '{"status":"ok"}\n200' } :
        { status: 0, stdout: '{"status":"down"}\n503' };
      if (args[0] === "show") return { status: 0, stdout: "ActiveState=active\nSubState=running\nNRestarts=0\n" };
      if (args[0] === "-K") return { status: 0, stdout: "200" };
      throw new Error(`unexpected spawn: ${bin} ${args.join(" ")}`);
    };
    const config = loadConfig({ UNSEEN_ALERT_STATE_FILE: stateFile, UNSEEN_ALERT_TELEGRAM_BOT_TOKEN: "123:ABC",
      UNSEEN_ALERT_UNITS: "unseen-operable.service", UNSEEN_ALERT_BACKUP_ROOT: "/nonexistent-in-this-test",
      // Point disk-space checking at a directory that actually exists on the test machine (a
      // temp dir), so this test's healthz-down scenario isn't confounded by an unrelated
      // "disk path doesn't exist" finding from the real UNSEEN_ALERT_DISK_PATH default.
      UNSEEN_ALERT_DISK_PATH: path.dirname(stateFile) });
    const readdir = () => [{ name: "20260817T031500Z", isDirectory: () => true }];
    await runCheck(config, { now: () => 0, spawn, readdir });
    healthy = true;
    const recovered = await runCheck(config, { now: () => 120_000, spawn, readdir });
    const healthzNotification = recovered.notifications.find((n) => n.id === "healthz");
    assert.equal(healthzNotification.kind, "recovered");
    assert.match(recovered.message, /已恢复/);
  });
});
