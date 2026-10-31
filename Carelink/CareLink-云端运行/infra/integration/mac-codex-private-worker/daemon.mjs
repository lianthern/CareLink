import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexSubscriptionRunner, createCodexPhotoAnalyzer, PHOTO_ANALYSIS_POLICY_HASH,
  PHOTO_ANALYSIS_PROMPT_HASH } from "./codex-exec.mjs";
import { ExactHttpsClient } from "./https-transport.mjs";
import { PrivateAiPullProtocol, RemotePrivateAiPullWorker, runPullLoop } from "./remote-pull.mjs";

const CONFIG_SCHEMA = "unseen-mac-private-ai-worker-config/1";
const ROOT_KEYS = ["schema", "enabled", "origin", "expectedHostname", "tokenPath", "tokenUid", "tlsPolicy",
  "promptHash", "policyHash", "codex", "poll"];
const CODEX_KEYS = ["path", "sha256", "version", "uid", "gid", "mode", "model", "modelVersion", "timeoutMs",
  "preflightTimeoutMs", "imageProcessingTimeoutMs", "killGraceMs", "providerTimeoutMs", "leaseMs"];
const POLL_KEYS = ["minimumLeaseRemainingMs", "cleanupBudgetMs", "maximumPixels"];

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

async function readConfig(configPath) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath) || path.resolve(configPath) !== configPath) {
    throw new Error("worker_config_path_invalid");
  }
  let handle;
  try {
    handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > 64 * 1024 ||
      ![0, process.getuid()].includes(before.uid) || (before.mode & 0o022) !== 0) {
      throw new Error("worker_config_file_invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("worker_config_changed");
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error?.message?.startsWith("worker_config_")) throw error;
    throw new Error("worker_config_file_invalid");
  } finally { await handle?.close(); }
}

export async function loadWorkerConfig(configPath) {
  const value = await readConfig(configPath);
  const codex = value?.codex;
  const poll = value?.poll;
  if (!exactKeys(value, ROOT_KEYS) || value.schema !== CONFIG_SCHEMA || typeof value.enabled !== "boolean" ||
    typeof value.origin !== "string" || typeof value.expectedHostname !== "string" ||
    typeof value.tokenPath !== "string" || !path.isAbsolute(value.tokenPath) ||
    !integer(value.tokenUid, 0, Number.MAX_SAFE_INTEGER) || value.promptHash !== PHOTO_ANALYSIS_PROMPT_HASH ||
    value.policyHash !== PHOTO_ANALYSIS_POLICY_HASH || !exactKeys(codex, CODEX_KEYS) ||
    typeof codex.modelVersion !== "string" || codex.modelVersion !== `${codex.version}/${codex.model}` ||
    !exactKeys(poll, POLL_KEYS) || !integer(poll.minimumLeaseRemainingMs, 10_000, 300_000) ||
    !integer(poll.cleanupBudgetMs, 1_000, 30_000) || !integer(poll.maximumPixels, 1, 16_777_216) ||
    1_000 + codex.preflightTimeoutMs + codex.imageProcessingTimeoutMs + codex.timeoutMs +
      4 * codex.killGraceMs + poll.cleanupBudgetMs >= poll.minimumLeaseRemainingMs ||
    poll.minimumLeaseRemainingMs >= codex.leaseMs) throw new Error("worker_config_invalid");
  return Object.freeze({ ...value, codex: Object.freeze({ ...codex }), poll: Object.freeze({ ...poll }),
    tlsPolicy: Object.freeze({ ...value.tlsPolicy }) });
}

export function buildWorker(config, onDiagnostic = () => {}) {
  const client = new ExactHttpsClient({ origin: config.origin, expectedHostname: config.expectedHostname,
    tokenPath: config.tokenPath, tokenUid: config.tokenUid, timeoutMs: 15_000, tlsPolicy: config.tlsPolicy });
  const runner = new CodexSubscriptionRunner({ codexPath: config.codex.path,
    codexSha256: config.codex.sha256, codexVersion: config.codex.version, codexUid: config.codex.uid,
    codexGid: config.codex.gid, codexMode: config.codex.mode, model: config.codex.model,
    timeoutMs: config.codex.timeoutMs, preflightTimeoutMs: config.codex.preflightTimeoutMs,
    imageProcessingTimeoutMs: config.codex.imageProcessingTimeoutMs, killGraceMs: config.codex.killGraceMs,
    providerTimeoutMs: config.codex.providerTimeoutMs, leaseMs: config.codex.leaseMs,
    maximumPixels: config.poll.maximumPixels });
  const protocol = new PrivateAiPullProtocol({ client, promptHash: config.promptHash, policyHash: config.policyHash,
    model: config.codex.model, modelVersion: config.codex.modelVersion, maximumPixels: config.poll.maximumPixels });
  return new RemotePrivateAiPullWorker({ protocol, preflight: (signal) => runner.preflight(signal),
    analyze: createCodexPhotoAnalyzer({ runner, modelVersion: config.codex.modelVersion,
      promptHash: config.promptHash, policyHash: config.policyHash }),
    minimumLeaseRemainingMs: config.poll.minimumLeaseRemainingMs,
    cleanupBudgetMs: config.poll.cleanupBudgetMs, onDiagnostic });
}

export async function main(environment = process.env) {
  const config = await loadWorkerConfig(environment.UNSEEN_PRIVATE_AI_WORKER_CONFIG);
  if (!config.enabled) return "disabled";
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const worker = buildWorker(config, (event) => process.stdout.write(`${JSON.stringify(event)}\n`));
    await runPullLoop(worker, { signal: controller.signal });
    return "stopped";
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Every path out of main() — including the two that were previously silent (disabled at boot, or a clean
  // stop() from SIGTERM/SIGINT) — writes exactly one structured line before the process exits. A silent exit
  // is strictly worse than a crash: it looks identical to "idle and fine" until someone notices the daemon
  // stopped syncing. See remote-pull.mjs's runPullLoop for the unref bug that made this exact failure mode
  // possible (silent exit mid-poll, no log at all).
  main().then((status) => {
    process.stdout.write(`${JSON.stringify({ event: "private_ai_worker_exit", status })}\n`);
    if (status === "disabled") process.exitCode = 0;
  }).catch((error) => {
    const code = error?.message?.startsWith("worker_") ? error.message : "worker_start_failed";
    process.stderr.write(`${JSON.stringify({ event: "private_ai_worker_exit", status: "error", code })}\n`);
    process.exitCode = 78;
  });
}
