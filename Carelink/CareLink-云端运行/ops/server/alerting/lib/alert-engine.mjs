// Pure decision logic for the UNSEEN server alerting timer (see the report handed back alongside
// this file for the 2026-08-17 06:51-09:00 crash-loop that motivated it: 80+ restarts over three
// hours, private_ai_worker_configuration_invalid, and nobody noticed because nothing was watching
// unit ActiveState/NRestarts or backup freshness -- only the old healthz, which itself only ever
// checked OTP config).
//
// Everything in this file is a plain function of plain data: no fetch, no child_process, no
// fs, no Date.now() called internally (every "now" is an explicit argument). check.mjs is the
// only file that does real I/O -- it gathers healthz/systemctl/disk/backup-directory facts and
// hands them to the functions here, which is what makes the tri-state classification and the
// notification dedup/rate-limit logic exhaustively unit-testable (see alert-engine.test.mjs)
// without a real server, a real Telegram bot, or real systemd units.
//
// Levels: "ok" (nothing to say), "warning" (real problem, site still up -- matches healthz's own
// "degraded"), "critical" (site down / unit not running / backup stale / disk critical).

export const LEVEL_OK = "ok";
export const LEVEL_WARNING = "warning";
export const LEVEL_CRITICAL = "critical";

const LEVEL_RANK = { [LEVEL_OK]: 0, [LEVEL_WARNING]: 1, [LEVEL_CRITICAL]: 2 };

// ---------------------------------------------------------------------------------------------
// Individual classifiers -- one per thing being watched. Each returns { id, level, detail,
// nextSteps } where `detail` is a short Chinese fact ("服务名 + 症状"), and `nextSteps` is a
// short Chinese hint for what to check next (both get folded into the final Telegram message by
// composeMessage). `id` is the stable key decideNotifications uses to track state across runs.
// ---------------------------------------------------------------------------------------------

// httpResult: { ok:boolean, httpStatus:number|null, body:object|null, errorMessage:string|null }
// -- errorMessage set means the fetch itself failed (connection refused, timeout, DNS, ...).
export function classifyHealthz(httpResult) {
  const id = "healthz";
  const nextSteps = "systemctl status unseen-operable && journalctl -u unseen-operable -n 100 --no-pager";
  if (httpResult.errorMessage) {
    return { id, level: LEVEL_CRITICAL, detail: `healthz 请求失败：${httpResult.errorMessage}`, nextSteps };
  }
  if (httpResult.httpStatus !== 200) {
    return { id, level: LEVEL_CRITICAL, detail: `healthz 返回 HTTP ${httpResult.httpStatus}`, nextSteps };
  }
  const status = httpResult.body?.status;
  if (status === "ok") return { id, level: LEVEL_OK, detail: "healthz 正常", nextSteps };
  if (status === "degraded") {
    const bad = ["db", "disk", "clipSidecar"].filter((key) => httpResult.body?.[key]?.status &&
      httpResult.body[key].status !== "ok");
    const otpBad = httpResult.body?.otpDelivery?.ready === false;
    const parts = [...bad.map((key) => `${key}=${httpResult.body[key].status}`), ...(otpBad ? ["otpDelivery=not_ready"] : [])];
    return { id, level: LEVEL_WARNING,
      detail: `healthz status=degraded（${parts.join("、") || "未知子项"}），站点仍可服务`, nextSteps };
  }
  // status === "down" would already have been a non-200 above (see http-server.mjs's mapping),
  // so reaching here with an unrecognized/missing status string is itself worth flagging.
  return { id, level: LEVEL_CRITICAL, detail: `healthz 返回了非预期的 status 字段：${JSON.stringify(status)}`, nextSteps };
}

// unit: { name, kind: "service"|"timer", activeState, subState }
export function classifyUnitActiveState(unit) {
  const id = `unit:${unit.name}`;
  const nextSteps = `systemctl status ${unit.name} && journalctl -u ${unit.name} -n 100 --no-pager`;
  if (unit.activeState === "active") return { id, level: LEVEL_OK, detail: `${unit.name} 运行正常`, nextSteps };
  return { id, level: LEVEL_CRITICAL,
    detail: `${unit.name} 状态异常：ActiveState=${unit.activeState}${unit.subState ? ` (${unit.subState})` : ""}`,
    nextSteps };
}

// Rolling-window restart-loop detector: samples is [{t: epochMs, n: NRestarts}, ...] for one
// unit, any order. Flags a loop when NRestarts grew by >= growthThreshold within the last
// windowMs, independent of the unit's current ActiveState -- Restart=on-failure units can look
// "active" again moments after each crash, which is exactly why 80+ restarts over three hours
// went unnoticed by anything that only checked ActiveState.
export function detectRestartLoop(samples, { nowMs, windowMs, growthThreshold }) {
  const inWindow = samples.filter((sample) => sample.t >= nowMs - windowMs && sample.t <= nowMs);
  if (inWindow.length < 2) return { loop: false, growth: 0, samples: inWindow.length };
  const values = inWindow.map((sample) => sample.n);
  const growth = Math.max(...values) - Math.min(...values);
  return { loop: growth >= growthThreshold, growth, samples: inWindow.length };
}

export function classifyRestartLoop(unit, restartLoopResult) {
  const id = `restart-loop:${unit.name}`;
  const nextSteps = `journalctl -u ${unit.name} --since "-1 hour" --no-pager | tail -200`;
  if (!restartLoopResult.loop) {
    return { id, level: LEVEL_OK, detail: `${unit.name} 重启次数正常`, nextSteps };
  }
  return { id, level: LEVEL_CRITICAL,
    detail: `${unit.name} 疑似重启循环：最近 ${restartLoopResult.samples} 次采样内 NRestarts 增长了 ${restartLoopResult.growth} 次`,
    nextSteps };
}

// diskResult: the return shape of services/api/src/health-checks.mjs#checkDiskSpace (reused
// directly by check.mjs so the alerting timer's own disk view uses the exact same bytes-AND-
// percent tri-state rule as the app's own /healthz -- see that file for why AND, not OR).
export function classifyDisk(diskResult) {
  const id = "disk";
  const nextSteps = `df -h ${diskResult.path}`;
  if (diskResult.status === "ok") {
    return { id, level: LEVEL_OK, detail: `磁盘空间正常（${diskResult.path} 可用 ${diskResult.availablePercent}%）`,
      nextSteps };
  }
  if (diskResult.error) return { id, level: LEVEL_CRITICAL, detail: `磁盘检查失败（${diskResult.path}）：${diskResult.error}`, nextSteps };
  const level = diskResult.status === "down" ? LEVEL_CRITICAL : LEVEL_WARNING;
  return { id, level,
    detail: `磁盘空间${level === LEVEL_CRITICAL ? "严重不足" : "偏低"}：${diskResult.path} 可用 ${diskResult.availablePercent}%` +
      (Number.isFinite(diskResult.availableBytes) ? `（约 ${Math.round(diskResult.availableBytes / 1024 / 1024)}MB）` : ""),
    nextSteps };
}

// backupInfo: { latestRunAt: epochMs|null } -- latestRunAt is the mtime of the newest timestamped
// backup directory under UNSEEN_BACKUP_ROOT (see check.mjs), or null if none was ever found.
export function classifyBackup(backupInfo, { nowMs, maxAgeHours }) {
  const id = "backup";
  const nextSteps = "journalctl -u unseen-backup -n 50 --no-pager && ls -la /var/backups/unseen";
  if (backupInfo.latestRunAt == null) {
    return { id, level: LEVEL_CRITICAL, detail: "从未见过成功的备份（备份目录下没有已完成的时间戳目录）", nextSteps };
  }
  const ageHours = (nowMs - backupInfo.latestRunAt) / 3_600_000;
  if (ageHours > maxAgeHours) {
    return { id, level: LEVEL_CRITICAL,
      detail: `最近一次备份已经过去 ${ageHours.toFixed(1)} 小时（超过 ${maxAgeHours} 小时阈值）`, nextSteps };
  }
  return { id, level: LEVEL_OK, detail: `最近一次备份 ${ageHours.toFixed(1)} 小时前，正常`, nextSteps };
}

// ---------------------------------------------------------------------------------------------
// Notification dedup / rate-limit. Given this run's findings and the PREVIOUS run's persisted
// state, decides which findings are actually worth sending a Telegram message about right now.
// Rule (matches the brief): notify on every level FLIP (including recovery back to ok), and at
// most once every reminderIntervalMs while a finding stays at the same bad level.
// ---------------------------------------------------------------------------------------------

export function decideNotifications({ findings, previousState = {}, nowMs, reminderIntervalMs }) {
  const notifications = [];
  const nextState = {};
  for (const finding of findings) {
    const prior = previousState[finding.id] ?? { level: LEVEL_OK, since: nowMs, lastNotifiedAt: null };
    if (finding.level === LEVEL_OK) {
      if (prior.level !== LEVEL_OK) {
        notifications.push({ ...finding, kind: "recovered", sinceMs: prior.since, nowMs });
        nextState[finding.id] = { level: LEVEL_OK, since: nowMs, lastNotifiedAt: nowMs };
      } else {
        nextState[finding.id] = prior;
      }
      continue;
    }
    if (finding.level !== prior.level) {
      notifications.push({ ...finding, kind: "new", sinceMs: nowMs, nowMs });
      nextState[finding.id] = { level: finding.level, since: nowMs, lastNotifiedAt: nowMs };
      continue;
    }
    const dueForReminder = prior.lastNotifiedAt == null || nowMs - prior.lastNotifiedAt >= reminderIntervalMs;
    if (dueForReminder) {
      notifications.push({ ...finding, kind: "reminder", sinceMs: prior.since, nowMs });
      nextState[finding.id] = { level: prior.level, since: prior.since, lastNotifiedAt: nowMs };
    } else {
      nextState[finding.id] = prior;
    }
  }
  return { notifications, nextState };
}

// ---------------------------------------------------------------------------------------------
// Message composition -- Chinese, batches every notification from one run into a single
// message (so a run with three simultaneous problems sends one Telegram message, not three).
// Never include anything from `previousState`/env beyond what's already in `notifications`
// (no tokens, no OTP codes, no emails ever flow through this path).
// ---------------------------------------------------------------------------------------------

function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} 分钟`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} 小时`;
  return `${(hours / 24).toFixed(1)} 天`;
}

const KIND_LABEL = { new: "新故障", reminder: "持续提醒", recovered: "已恢复" };
const LEVEL_EMOJI = { [LEVEL_WARNING]: "🟡", [LEVEL_CRITICAL]: "🔴" };

export function composeMessage(notifications, { hostname, generatedAt }) {
  if (notifications.length === 0) return null;
  const lines = [`UNSEEN 服务器告警（${hostname}，${generatedAt}）`, ""];
  for (const notification of notifications) {
    const emoji = notification.kind === "recovered" ? "✅" : (LEVEL_EMOJI[notification.level] ?? "⚠️");
    const label = `${emoji} ${KIND_LABEL[notification.kind] ?? notification.level}`;
    const duration = formatDuration(notification.nowMs - notification.sinceMs);
    lines.push(`${label}：${notification.detail}`);
    lines.push(notification.kind === "recovered" ? `　持续了约 ${duration}` : `　已持续约 ${duration}`);
    if (notification.kind !== "recovered" && notification.nextSteps) lines.push(`　下一步：${notification.nextSteps}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// Sorts findings so the composed message reads most-severe-first, stable otherwise.
export function sortFindingsBySeverity(findings) {
  return [...findings].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
}
