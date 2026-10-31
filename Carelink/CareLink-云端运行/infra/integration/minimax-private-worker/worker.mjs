// MiniMax private-ai pull worker — entrypoint.
//
// Polls `services/api`'s generic private-ai lease queue (`/__internal/private-ai/v1/*`, protocol
// `unseen-private-ai-pull/1`) for `photo_visible_facts_question_v1` jobs, downloads the leased photo, asks
// MiniMax's vision model for 1-2 objective visible facts plus one gentle, skippable Chinese question, and
// completes or fails the job. This is the MiniMax analogue of `infra/integration/mac-codex-private-worker`: it
// reuses that directory's `https-transport.mjs` and `remote-pull.mjs` (the exact-key wire DTOs, HTTPS/
// TLS/token boundary, lease-budget accounting, and complete/fail replay semantics are protocol-DTO-agnostic —
// nothing there is Codex-specific), and only supplies a different `analyze()` callback
// (`./minimax-vision-analyzer.mjs`) and its own configuration/entry loop.
//
// Unlike the Mac worker, this one is meant to run as a plain systemd service on the production server (see
// `ops/server/unseen-minimax-worker.service`), so configuration comes entirely from environment variables (a
// single `EnvironmentFile`) rather than a private JSON config file plus a launchd plist.
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExactHttpsClient, loadPrivateWorkerToken, PrivateWorkerTransportError } from
  "../mac-codex-private-worker/https-transport.mjs";
import { PrivateAiPullProtocol, PrivateAiProtocolError, RemotePrivateAiPullWorker } from
  "../mac-codex-private-worker/remote-pull.mjs";
import { createMiniMaxPhotoAnalyzer, MINIMAX_WORKER_VISION_POLICY_HASH, MINIMAX_WORKER_VISION_PROMPT_HASH } from
  "./minimax-vision-analyzer.mjs";

const WORKER_MODEL_VERSION_PREFIX = "minimax-private-worker/1";
const TOKEN_FILE_MAX_BYTES = 256;

class WorkerConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "WorkerConfigError";
  }
}

function configFail(code) {
  throw new WorkerConfigError(code);
}

function boolEnv(value, fallback) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  configFail("worker_config_bool_invalid");
}

function intEnv(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) configFail("worker_config_int_invalid");
  return parsed;
}

function floatEnv(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) configFail("worker_config_float_invalid");
  return parsed;
}

function requiredString(value, code, { maxLength = 4_096 } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) configFail(code);
  return value;
}

function absolutePath(value, code) {
  requiredString(value, code);
  if (!path.isAbsolute(value) || path.resolve(value) !== value) configFail(code);
  return value;
}

// The MiniMax API key never lives in the JSON-config-file style used by the Mac worker, and it is read exactly
// once at startup — never per-request, never logged, never included in a diagnostic event. Rotation is by
// restart (see README): `systemctl restart` after the enable script rewrites the EnvironmentFile.
async function resolveMiniMaxApiKey(environment) {
  const direct = environment.UNSEEN_MINIMAX_API_KEY;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const file = environment.UNSEEN_MINIMAX_KEY_FILE;
  if (typeof file !== "string" || file.length === 0) {
    configFail("worker_config_minimax_credential_missing");
  }
  if (!path.isAbsolute(file)) configFail("worker_config_minimax_key_file_invalid");
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 4_096) configFail("worker_config_minimax_key_file_invalid");
    const bytes = await handle.readFile();
    const key = bytes.toString("utf8").trim();
    bytes.fill(0);
    if (key.length === 0) configFail("worker_config_minimax_key_file_invalid");
    return key;
  } catch (error) {
    if (error instanceof WorkerConfigError) throw error;
    configFail("worker_config_minimax_key_file_invalid");
  } finally {
    await handle?.close();
  }
  return undefined;
}

/**
 * Loads and validates the worker's entire configuration from environment variables (normally `process.env`, or
 * an injected object in tests). Returns a frozen config, or throws `WorkerConfigError`. Does not perform any
 * network I/O other than reading the MiniMax API key file (if configured) and does not read the private-ai wire
 * bearer token file yet — that file is re-read fresh on every single HTTPS request by the reused
 * `ExactHttpsClient`/`loadPrivateWorkerToken`, so this function only validates that its *path* is well-formed.
 */
export async function loadWorkerConfig(environment = process.env) {
  const enabled = boolEnv(environment.UNSEEN_MINIMAX_WORKER_ENABLED, false);
  const origin = requiredString(environment.UNSEEN_PRIVATE_AI_ORIGIN, "worker_config_origin_required");
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch { configFail("worker_config_origin_invalid"); }
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin) configFail("worker_config_origin_invalid");
  const expectedHostname = requiredString(environment.UNSEEN_PRIVATE_AI_EXPECTED_HOSTNAME,
    "worker_config_expected_hostname_required");
  const tokenPath = absolutePath(environment.UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE, "worker_config_token_file_required");
  const tlsMode = environment.UNSEEN_PRIVATE_AI_TLS_MODE ?? "system-ca";
  if (!["system-ca", "ca-file"].includes(tlsMode)) configFail("worker_config_tls_mode_invalid");
  const tlsPolicy = { mode: tlsMode };
  if (tlsMode === "ca-file") tlsPolicy.caFile = absolutePath(environment.UNSEEN_PRIVATE_AI_TLS_CA_FILE,
    "worker_config_tls_ca_file_required");
  if (environment.UNSEEN_PRIVATE_AI_TLS_SPKI_SHA256 !== undefined) {
    const pin = environment.UNSEEN_PRIVATE_AI_TLS_SPKI_SHA256;
    if (!/^[A-Za-z0-9+/]{43}=$/u.test(pin)) configFail("worker_config_tls_pin_invalid");
    tlsPolicy.spkiSha256 = pin;
  }
  const visionModel = environment.UNSEEN_MINIMAX_VISION_MODEL ?? "MiniMax-M3";
  requiredString(visionModel, "worker_config_vision_model_invalid", { maxLength: 80 });
  const modelVersion = `${WORKER_MODEL_VERSION_PREFIX}/${visionModel}`;
  const baseUrl = environment.UNSEEN_MINIMAX_BASE_URL ?? "https://api.minimaxi.com";
  let parsedBaseUrl;
  try { parsedBaseUrl = new URL(baseUrl); } catch { configFail("worker_config_minimax_base_url_invalid"); }
  if (parsedBaseUrl.protocol !== "https:") configFail("worker_config_minimax_base_url_invalid");
  const apiKey = await resolveMiniMaxApiKey(environment);
  const requestTimeoutMs = intEnv(environment.UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS, 20_000, 1_000, 120_000);
  const temperature = floatEnv(environment.UNSEEN_MINIMAX_TEMPERATURE, 0.6, 0, 2);
  const maxTokens = intEnv(environment.UNSEEN_MINIMAX_MAX_TOKENS, 400, 16, 4_000);
  const httpTimeoutMs = intEnv(environment.UNSEEN_MINIMAX_WORKER_HTTP_TIMEOUT_MS, 15_000, 1_000, 60_000);
  const minimumLeaseRemainingMs = intEnv(environment.UNSEEN_PRIVATE_AI_MIN_LEASE_REMAINING_MS, 60_000, 10_000,
    250_000);
  const cleanupBudgetMs = intEnv(environment.UNSEEN_PRIVATE_AI_CLEANUP_BUDGET_MS, 5_000, 1_000, 30_000);
  if (cleanupBudgetMs >= minimumLeaseRemainingMs) configFail("worker_config_lease_budget_invalid");
  // 2 * requestTimeoutMs bounds worst-case analyzer time (initial call + one reworded retry); the remaining
  // lease budget after that must still cover request/complete round trips and the cleanup budget.
  if (2 * requestTimeoutMs + cleanupBudgetMs >= minimumLeaseRemainingMs) configFail("worker_config_lease_budget_invalid");
  const maximumPixels = intEnv(environment.UNSEEN_PRIVATE_AI_MAX_PIXELS, 16_777_216, 1, 16_777_216);

  return Object.freeze({
    enabled, origin, expectedHostname, tokenPath, tlsPolicy: Object.freeze(tlsPolicy),
    promptHash: MINIMAX_WORKER_VISION_PROMPT_HASH, policyHash: MINIMAX_WORKER_VISION_POLICY_HASH,
    model: visionModel, modelVersion,
    minimax: Object.freeze({ apiKey, baseUrl, requestTimeoutMs, temperature, maxTokens }),
    transport: Object.freeze({ httpTimeoutMs }),
    poll: Object.freeze({ minimumLeaseRemainingMs, cleanupBudgetMs, maximumPixels })
  });
}

export function buildWorker(config, { onDiagnostic = () => {} } = {}) {
  const client = new ExactHttpsClient({ origin: config.origin, expectedHostname: config.expectedHostname,
    tokenPath: config.tokenPath, timeoutMs: config.transport.httpTimeoutMs, tlsPolicy: config.tlsPolicy });
  const protocol = new PrivateAiPullProtocol({ client, promptHash: config.promptHash, policyHash: config.policyHash,
    model: config.model, modelVersion: config.modelVersion, maximumPixels: config.poll.maximumPixels });
  const analyze = createMiniMaxPhotoAnalyzer({ apiKey: config.minimax.apiKey, baseUrl: config.minimax.baseUrl,
    model: config.model, modelVersion: config.modelVersion, temperature: config.minimax.temperature,
    maxTokens: config.minimax.maxTokens, requestTimeoutMs: config.minimax.requestTimeoutMs });
  // No local trusted-runtime surface to fingerprint (unlike the Codex worker's pinned executable): every call
  // this worker makes is a plain HTTPS request, already re-authenticated per-request by `ExactHttpsClient`. The
  // preflight hook still exists because `RemotePrivateAiPullWorker` requires one; it is intentionally a no-op
  // beyond honoring an already-aborted signal.
  const preflight = async (signal) => { if (signal.aborted) throw new PrivateAiProtocolError("worker_aborted"); };
  return new RemotePrivateAiPullWorker({ protocol, preflight, analyze,
    minimumLeaseRemainingMs: config.poll.minimumLeaseRemainingMs, cleanupBudgetMs: config.poll.cleanupBudgetMs,
    onDiagnostic });
}

function jitteredDelay(baseMs, random) {
  return Math.max(1_000, Math.min(300_000, Math.round(baseMs * (0.8 + random() * 0.4))));
}

// Interruptible, event-driven sleep (no polling): resolves as soon as either the timer elapses or `stopSignal`
// aborts, whichever comes first. Used only between cycles, never while a lease is in flight.
function sleepUntilStop(ms, stopSignal) {
  return new Promise((resolve) => {
    if (stopSignal.aborted) { resolve(); return; }
    // 注意：这个定时器是常驻服务空闲期的唯一活句柄，绝不能 unref——unref 会让事件循环清零、
    // 进程在两次轮询之间静默 exit 0（systemd 表现为 93ms 秒退无日志，2026-08-17 生产实测踩坑）。
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      stopSignal.removeEventListener("abort", onAbort);
      resolve();
    }
    stopSignal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs the poll loop with "finish in-flight work, then stop" shutdown semantics: `stopSignal` is checked, and can
 * only interrupt, *between* cycles — it is never passed into the in-flight `worker.runOnce()` call itself. This
 * is a deliberate, documented departure from reusing `runPullLoop()`
 * (`infra/integration/mac-codex-private-worker/remote-pull.mjs`) verbatim for the outer loop: that helper shares
 * one `AbortSignal` between the loop condition and every in-flight network call, so a SIGTERM there aborts
 * whatever lease/complete cycle happens to be in flight. This worker instead gives every `runOnce()` call its
 * own, never-externally-aborted signal, so a leased job's `/complete` or `/fail` call is always allowed to finish
 * before the loop exits — while an idle poll *sleep* is still interrupted immediately so shutdown doesn't wait
 * out a long backoff. `RemotePrivateAiPullWorker.runOnce()` itself is reused unchanged, so its own internal
 * lease-expiry timer (`minimumLeaseRemainingMs`/`cleanupBudgetMs`) still applies exactly as it does for the Mac
 * worker.
 */
export async function runWorkerLoop(worker, { stopSignal, random = Math.random, sleep = sleepUntilStop } = {}) {
  let consecutiveOffline = 0;
  while (!stopSignal.aborted) {
    const cycleSignal = new AbortController().signal;
    const result = await worker.runOnce(cycleSignal);
    if (stopSignal.aborted) return;
    const base = result.status === "offline" ? Math.min(300_000, 5_000 * 2 ** consecutiveOffline) :
      Number.isSafeInteger(result.retryAfterMs) && result.retryAfterMs >= 1_000 && result.retryAfterMs <= 300_000 ?
        result.retryAfterMs : 5_000;
    consecutiveOffline = result.status === "offline" ? Math.min(consecutiveOffline + 1, 6) : 0;
    await sleep(jitteredDelay(base, random), stopSignal);
  }
}

export async function main(environment = process.env) {
  const config = await loadWorkerConfig(environment);
  if (!config.enabled) return "disabled";
  const stopController = new AbortController();
  const stop = () => stopController.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const worker = buildWorker(config, { onDiagnostic: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) });
    await runWorkerLoop(worker, { stopSignal: stopController.signal });
    return "stopped";
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Every path out of main() — including the two that used to exit with no trace at all (disabled at boot, or
  // a clean stop() from SIGTERM/SIGINT) — writes exactly one structured line before the process exits. This is
  // the same "silent exit is worse than a crash" lesson as the 2026-08-17 sleepUntilStop() unref incident: a
  // daemon that stops without saying why looks identical to "idle and fine" until someone notices it's gone.
  main().then((status) => {
    process.stdout.write(`${JSON.stringify({ event: "minimax_worker_exit", status })}\n`);
    if (status === "disabled") process.exitCode = 0;
  }).catch((error) => {
    const code = error?.message?.startsWith("worker_") ? error.message : "worker_start_failed";
    process.stderr.write(`${JSON.stringify({ event: "minimax_worker_exit", status: "error", code })}\n`);
    process.exitCode = 78;
  });
}

// Re-exported so tests and the enable script's smoke check can reference them without importing the analyzer
// module directly.
export { loadPrivateWorkerToken, PrivateWorkerTransportError };
