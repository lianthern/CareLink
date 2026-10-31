#!/usr/bin/env node
// UNSEEN server alerting check -- run by unseen-alerting.timer (see ../unseen-alerting.timer /
// ../unseen-alerting.service) roughly every 2 minutes. Gathers real facts (local /healthz, the
// ActiveState/NRestarts of the units that matter, disk space on the data volume, and how long
// ago the last successful backup finished), hands them to the pure classifiers/dedup logic in
// lib/alert-engine.mjs, and sends a Chinese Telegram message via `curl` when -- and only when --
// something actually changed or an ongoing problem's hourly reminder is due.
//
// Built in direct response to the 2026-08-17 06:51-09:00 crash-loop
// (private_ai_worker_configuration_invalid, 80+ restarts, three hours, nobody noticed): the old
// healthz only ever checked OTP config, and nothing at all watched unit restarts or backup
// freshness. See lib/alert-engine.mjs's header for the full rationale and lib/alert-engine.test.mjs
// for the unit-tested decision matrix (this file itself does no branching logic of its own beyond
// wiring real I/O to those pure functions).
//
// No new dependency: only Node's own stdlib (fetch is deliberately NOT used for the HTTP calls --
// see probeHealthz()'s comment for why -- everything network-facing shells out to `curl`, matching
// the existing ops/server/* convention and the exact curl invocation already documented in
// runbooks/release/PRIVATE-BETA-DEPLOYMENT.md).
//
// Environment (all read once at startup; every one of these has a working default except the
// Telegram bot token, without which this script still runs its checks and logs to stdout/stderr
// but cannot actually notify anyone -- see enable-alerting.sh for how the token gets provisioned):
//   UNSEEN_ALERT_HEALTHZ_URL              default: http://127.0.0.1:4300/healthz
//   UNSEEN_ALERT_HEALTHZ_HOST             default: unseen.maxxam.xyz (http-server.mjs rejects any
//                                         request whose Host header doesn't match the configured
//                                         public origin -- this is that Host header, NOT the URL)
//   UNSEEN_ALERT_HTTP_TIMEOUT_MS          default: 5000 (bounds both the healthz probe and the
//                                         Telegram send -- a wedged network call must never wedge
//                                         this timer)
//   UNSEEN_ALERT_UNITS                    default: "unseen-operable.service unseen-minimax-worker.service
//                                         unseen-backup.timer" (space-separated; .timer units are
//                                         checked for ActiveState only, .service units also get
//                                         NRestarts / restart-loop tracking)
//   UNSEEN_ALERT_RESTART_LOOP_WINDOW_MIN  default: 20   (rolling window for the crash-loop detector)
//   UNSEEN_ALERT_RESTART_LOOP_THRESHOLD   default: 3    (NRestarts growth within the window that
//                                         counts as a loop -- the real incident was 80+ in 3h, so 3
//                                         in 20min catches it with wide margin to spare)
//   UNSEEN_ALERT_DISK_PATH                default: /var/lib/unseen/operable/data
//   UNSEEN_ALERT_DISK_WARN_PERCENT / _CRITICAL_PERCENT / _WARN_BYTES / _CRITICAL_BYTES
//                                         default: same as services/api/src/health-checks.mjs
//                                         (10%/500MB warn, 3%/100MB critical, both must agree --
//                                         see that file's checkDiskSpace comment for why AND)
//   UNSEEN_ALERT_BACKUP_ROOT              default: /var/backups/unseen (matches backup.sh)
//   UNSEEN_ALERT_BACKUP_MAX_AGE_HOURS     default: 36
//   UNSEEN_ALERT_STATE_FILE               default: /var/lib/unseen/alerting/state.json (dedup
//                                         state + restart-count history across runs; created on
//                                         first run, corrupt/missing state is treated as "nothing
//                                         has ever been seen before", never a fatal error)
//   UNSEEN_ALERT_REMINDER_INTERVAL_MIN    default: 60 (an ongoing problem reminds at most this often)
//   UNSEEN_ALERT_TELEGRAM_BOT_TOKEN       secret, no default -- see enable-alerting.sh
//   UNSEEN_ALERT_TELEGRAM_CHAT_ID         default: 8223150297
//   UNSEEN_ALERT_SYSTEMCTL_BIN            default: systemctl (override for local testing)
//   UNSEEN_ALERT_CURL_BIN                 default: curl (override for local testing)
//   UNSEEN_ALERT_HOSTNAME                 default: os.hostname() (only used in the message text)
//   UNSEEN_ALERT_DRY_RUN                  default: false -- when "true", runs every real check
//                                         and prints what it WOULD send instead of calling curl;
//                                         state is still persisted so dedup can be rehearsed
//                                         across repeated dry-run invocations.
//
// Exit code: 0 whenever the check itself completed, REGARDLESS of whether it found and reported
// critical problems -- finding problems is this script's normal job, not a failure of the script.
// Non-zero only means the checker itself malfunctioned (couldn't write its state file, threw an
// unexpected exception, etc.) -- that in turn makes systemd mark unseen-alerting.service failed,
// which is itself something worth noticing (journalctl -u unseen-alerting).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDiskSpace } from "../../../services/api/src/health-checks.mjs";
import { probeApp } from './lib/app-probe.mjs';
import { classifyBackup, classifyDisk, classifyHealthz, classifyRestartLoop, classifyUnitActiveState,
  composeMessage, decideNotifications, detectRestartLoop, sortFindingsBySeverity } from "./lib/alert-engine.mjs";

function envString(env, name, fallback) {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}
function envNumber(env, name, fallback) {
  const value = env[name];
  return value === undefined || value === "" ? fallback : Number(value);
}
function envBool(env, name, fallback) {
  const value = env[name];
  return value === undefined ? fallback : value === "true";
}
function definedOnly(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && !Number.isNaN(value)));
}

export function loadConfig(env = process.env) {
  const get = (name, fallback) => envString(env, name, fallback);
  const num = (name, fallback) => envNumber(env, name, fallback);
  return {
    healthzUrl: get("UNSEEN_ALERT_HEALTHZ_URL", "http://127.0.0.1:4300/healthz"),
    healthzHost: get("UNSEEN_ALERT_HEALTHZ_HOST", "unseen.maxxam.xyz"),
    appOrigin: get("UNSEEN_ALERT_APP_ORIGIN", "http://127.0.0.1:4611"),
    appHost: get("UNSEEN_ALERT_APP_HOST", "huijian.maxxam.xyz"),
    httpTimeoutMs: num("UNSEEN_ALERT_HTTP_TIMEOUT_MS", 5000),
    units: get("UNSEEN_ALERT_UNITS", "huijian.service unseen-operable.service unseen-minimax-worker.service unseen-backup.timer")
      .split(/\s+/).filter(Boolean),
    restartLoopWindowMs: num("UNSEEN_ALERT_RESTART_LOOP_WINDOW_MIN", 20) * 60_000,
    restartLoopThreshold: num("UNSEEN_ALERT_RESTART_LOOP_THRESHOLD", 3),
    diskPath: get("UNSEEN_ALERT_DISK_PATH", "/var/lib/unseen/operable/data"),
    diskThresholds: definedOnly({
      warnPercent: num("UNSEEN_ALERT_DISK_WARN_PERCENT", undefined),
      criticalPercent: num("UNSEEN_ALERT_DISK_CRITICAL_PERCENT", undefined),
      warnBytes: num("UNSEEN_ALERT_DISK_WARN_BYTES", undefined),
      criticalBytes: num("UNSEEN_ALERT_DISK_CRITICAL_BYTES", undefined)
    }),
    backupRoot: get("UNSEEN_ALERT_BACKUP_ROOT", "/var/backups/unseen"),
    backupMaxAgeHours: num("UNSEEN_ALERT_BACKUP_MAX_AGE_HOURS", 36),
    stateFile: get("UNSEEN_ALERT_STATE_FILE", "/var/lib/unseen/alerting/state.json"),
    reminderIntervalMs: num("UNSEEN_ALERT_REMINDER_INTERVAL_MIN", 60) * 60_000,
    telegramBotToken: env.UNSEEN_ALERT_TELEGRAM_BOT_TOKEN ?? "",
    telegramChatId: get("UNSEEN_ALERT_TELEGRAM_CHAT_ID", "8223150297"),
    systemctlBin: get("UNSEEN_ALERT_SYSTEMCTL_BIN", "systemctl"),
    curlBin: get("UNSEEN_ALERT_CURL_BIN", "curl"),
    hostname: get("UNSEEN_ALERT_HOSTNAME", os.hostname()),
    dryRun: envBool(env, "UNSEEN_ALERT_DRY_RUN", false)
  };
}

// ---------------------------------------------------------------------------------------------
// State file: dedup state (see alert-engine.mjs#decideNotifications) + restart-count history,
// both keyed so a corrupt/missing file just means "nothing has ever been observed" rather than a
// fatal error -- a fresh install or a hand-deleted state file must never crash the timer.
// ---------------------------------------------------------------------------------------------

function loadState(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    return { findings: parsed.findings ?? {}, restartSamples: parsed.restartSamples ?? {} };
  } catch {
    return { findings: {}, restartSamples: {} };
  }
}

function saveState(stateFile, state) {
  mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  // Atomic rename -- a run that crashes mid-write never corrupts the previous good state.
  execFileSync("mv", ["-f", tmp, stateFile]);
}

// ---------------------------------------------------------------------------------------------
// healthz probe. Deliberately shells out to `curl` rather than using Node's own fetch: undici's
// fetch() silently ignores an explicit `Host` header (it always sends the header matching the
// actual TCP connection target), and http-server.mjs hard-rejects any request whose Host header
// doesn't match the configured public origin (see api/src/http-server.mjs's
// `request.headers.host !== expected.host` check) -- so probing 127.0.0.1 directly requires
// overriding Host, which only a real HTTP client (curl) does. This is also the exact invocation
// already documented in runbooks/release/PRIVATE-BETA-DEPLOYMENT.md.
// ---------------------------------------------------------------------------------------------

export function probeHealthz(config, { spawn = spawnSync } = {}) {
  const timeoutSeconds = Math.max(1, Math.ceil(config.httpTimeoutMs / 1000));
  const result = spawn(config.curlBin, ["-sS", "--max-time", String(timeoutSeconds),
    "-H", `Host: ${config.healthzHost}`, "-w", "\n%{http_code}", config.healthzUrl], { encoding: "utf8" });
  if (result.error) return { ok: false, httpStatus: null, body: null, errorMessage: result.error.message };
  if (result.status !== 0) {
    const message = (result.stderr || `curl exited with status ${result.status}`).toString().trim();
    return { ok: false, httpStatus: null, body: null, errorMessage: message };
  }
  const stdout = result.stdout ?? "";
  const splitAt = stdout.lastIndexOf("\n");
  const bodyText = splitAt === -1 ? "" : stdout.slice(0, splitAt);
  const httpStatus = Number((splitAt === -1 ? stdout : stdout.slice(splitAt + 1)).trim());
  let body = null;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  return { ok: httpStatus === 200, httpStatus: Number.isFinite(httpStatus) ? httpStatus : null, body, errorMessage: null };
}

// ---------------------------------------------------------------------------------------------
// systemd unit inspection: ActiveState (+ SubState for detail) always; NRestarts only for
// .service units (timers don't expose a meaningful equivalent -- a timer's own "is it armed"
// question IS its ActiveState).
// ---------------------------------------------------------------------------------------------

export function queryUnit(name, config, { spawn = spawnSync } = {}) {
  const kind = name.endsWith(".timer") ? "timer" : "service";
  const properties = kind === "service" ? "ActiveState,SubState,NRestarts" : "ActiveState,SubState";
  const result = spawn(config.systemctlBin, ["show", name, `--property=${properties}`], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const message = (result.error?.message ?? result.stderr ?? `systemctl exited with status ${result.status}`)
      .toString().trim();
    return { name, kind, activeState: "unknown", subState: null, nrestarts: null, queryError: message };
  }
  const values = Object.fromEntries((result.stdout ?? "").split("\n").filter(Boolean).map((line) => {
    const at = line.indexOf("=");
    return at === -1 ? [line, ""] : [line.slice(0, at), line.slice(at + 1)];
  }));
  return { name, kind, activeState: values.ActiveState || "unknown", subState: values.SubState || null,
    nrestarts: kind === "service" ? Number(values.NRestarts ?? "0") : null };
}

// ---------------------------------------------------------------------------------------------
// Backup freshness: authoritative timestamp comes from the directory NAME (backup.sh names each
// completed run's directory from `date -u +%Y%m%dT%H%M%SZ` at the moment it's published -- see
// backup.sh's final `mv -T "$work_dir" "$final_dir"`), not filesystem mtime, so a later
// tar/upload step touching the directory can never make a stale backup look fresh.
// ---------------------------------------------------------------------------------------------

const BACKUP_DIR_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export function latestBackupRun(backupRoot, { readdir = readdirSync } = {}) {
  let entries;
  try { entries = readdir(backupRoot, { withFileTypes: true }); }
  catch (error) { return { latestRunAt: null, queryError: error.message }; }
  const timestamps = entries.filter((entry) => entry.isDirectory()).map((entry) => {
    const match = BACKUP_DIR_PATTERN.exec(entry.name);
    if (!match) return null;
    const [, y, mo, d, h, mi, s] = match;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  }).filter((value) => value != null);
  return { latestRunAt: timestamps.length ? Math.max(...timestamps) : null };
}

// ---------------------------------------------------------------------------------------------
// Telegram send. Token flows: root-only env file -> systemd EnvironmentFile -> this process's
// own environment (never argv) -- see enable-alerting.sh. From here it goes into a curl -K
// config file fed over STDIN (never a curl argv element, so it never appears in `ps` either).
// The message body itself (chat_id + text, no secret) goes in a small private-tmp file
// referenced by the config, kept separate so the only thing ever touching the token is this
// process's memory and curl's own stdin pipe.
// ---------------------------------------------------------------------------------------------

function escapeCurlConfigValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function sendTelegram(message, config, { spawn = spawnSync } = {}) {
  if (config.dryRun) {
    process.stdout.write(`[dry-run] would send Telegram message to chat ${config.telegramChatId}:\n${message}\n`);
    return { sent: false, reason: "dry_run" };
  }
  if (!config.telegramBotToken) {
    process.stderr.write("unseen-alerting: UNSEEN_ALERT_TELEGRAM_BOT_TOKEN is not set, cannot send notification\n");
    return { sent: false, reason: "missing_token" };
  }
  if (/[\r\n]/.test(config.telegramBotToken)) {
    process.stderr.write("unseen-alerting: UNSEEN_ALERT_TELEGRAM_BOT_TOKEN must be a single line, refusing to send\n");
    return { sent: false, reason: "invalid_token" };
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "unseen-alert-"));
  const bodyFile = path.join(tmpDir, "body.json");
  try {
    writeFileSync(bodyFile, JSON.stringify({ chat_id: config.telegramChatId, text: message }), { mode: 0o600 });
    const timeoutSeconds = Math.max(1, Math.ceil(config.httpTimeoutMs / 1000));
    const curlConfig = [
      `url = "https://api.telegram.org/bot${escapeCurlConfigValue(config.telegramBotToken)}/sendMessage"`,
      'header = "Content-Type: application/json"',
      `data-binary = "@${escapeCurlConfigValue(bodyFile)}"`,
      "silent", "show-error",
      `max-time = ${timeoutSeconds}`,
      'write-out = "\\n%{http_code}"'
    ].join("\n");
    const result = spawn(config.curlBin, ["-K", "-"], { input: curlConfig, encoding: "utf8" });
    if (result.error) return { sent: false, reason: "curl_spawn_failed", error: result.error.message };
    const stdout = result.stdout ?? "";
    const splitAt = stdout.lastIndexOf("\n");
    const httpStatus = Number((splitAt === -1 ? stdout : stdout.slice(splitAt + 1)).trim());
    if (result.status !== 0 || httpStatus !== 200) {
      // Telegram's error bodies never include our own secrets, but stay conservative and log
      // only the HTTP status -- the full body could theoretically echo request contents back.
      return { sent: false, reason: "telegram_rejected", httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
        curlExitStatus: result.status };
    }
    return { sent: true };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export function buildFindings(config, { nowMs, healthzResult, unitResults, diskResult, backupResult, restartSamples }) {
  const findings = [classifyHealthz(healthzResult)];
  const updatedRestartSamples = { ...restartSamples };
  for (const unit of unitResults) {
    findings.push(classifyUnitActiveState(unit));
    if (unit.kind !== "service" || unit.nrestarts == null) continue;
    const history = [...(restartSamples[unit.name] ?? []), { t: nowMs, n: unit.nrestarts }]
      .filter((sample) => sample.t >= nowMs - config.restartLoopWindowMs * 3); // keep a bit past the window
    updatedRestartSamples[unit.name] = history;
    const restartLoopResult = detectRestartLoop(history,
      { nowMs, windowMs: config.restartLoopWindowMs, growthThreshold: config.restartLoopThreshold });
    findings.push(classifyRestartLoop(unit, restartLoopResult));
  }
  findings.push(classifyDisk(diskResult));
  findings.push(classifyBackup(backupResult, { nowMs, maxAgeHours: config.backupMaxAgeHours }));
  return { findings, restartSamples: updatedRestartSamples };
}

export async function runCheck(config, { now = () => Date.now(), spawn = spawnSync,
  readdir = readdirSync } = {}) {
  const nowMs = now();
  const healthzResult = probeHealthz(config, { spawn });
  const unitResults = config.units.map((name) => queryUnit(name, config, { spawn }));
  const diskResult = checkDiskSpace(config.diskPath, config.diskThresholds);
  const backupResult = latestBackupRun(config.backupRoot, { readdir });
  const state = loadState(config.stateFile);
  const { findings, restartSamples } = buildFindings(config,
    { nowMs, healthzResult, unitResults, diskResult, backupResult, restartSamples: state.restartSamples });
  findings.push(probeApp(config,{spawn}));
  const { notifications, nextState } = decideNotifications({ findings, previousState: state.findings, nowMs,
    reminderIntervalMs: config.reminderIntervalMs });
  const message = composeMessage(sortFindingsBySeverity(notifications),
    { hostname: config.hostname, generatedAt: new Date(nowMs).toISOString() });
  let sendResult = null;
  if (message) sendResult = sendTelegram(message, config, { spawn });
  saveState(config.stateFile, { findings: nextState, restartSamples, lastRunAt: nowMs });
  const summary = { event: "unseen_alert_check", at: new Date(nowMs).toISOString(),
    findings: findings.map((f) => ({ id: f.id, level: f.level })),
    notified: notifications.length, sent: sendResult?.sent ?? null,
    sendReason: sendResult && !sendResult.sent ? sendResult.reason : undefined };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return { findings, notifications, message, sendResult };
}

async function main() {
  const config = loadConfig();
  await runCheck(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`unseen-alerting: check failed: ${error?.stack ?? error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
