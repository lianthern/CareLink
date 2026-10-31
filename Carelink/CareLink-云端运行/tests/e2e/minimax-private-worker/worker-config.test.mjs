import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWorker, loadWorkerConfig, main, runWorkerLoop } from
  "../../../infra/integration/minimax-private-worker/worker.mjs";
import { RemotePrivateAiPullWorker } from "../../../infra/integration/mac-codex-private-worker/remote-pull.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-minimax-worker-config-test-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, "worker.token");
  await writeFile(tokenPath, "a".repeat(40), { mode: 0o600 });
  const keyFile = path.join(directory, "minimax.key");
  await writeFile(keyFile, "file-sourced-test-key\n", { mode: 0o600 });
  return { directory, tokenPath, keyFile };
}

function baseEnv(tokenPath) {
  return {
    UNSEEN_MINIMAX_WORKER_ENABLED: "true",
    UNSEEN_PRIVATE_AI_ORIGIN: "https://unseen.example.com",
    UNSEEN_PRIVATE_AI_EXPECTED_HOSTNAME: "unseen.example.com",
    UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE: tokenPath,
    UNSEEN_MINIMAX_API_KEY: "test-minimax-key-not-production"
  };
}

test("a fully configured environment loads, builds a RemotePrivateAiPullWorker and pins the worker's own prompt/policy hashes", async (t) => {
  const { tokenPath } = await fixture(t);
  const config = await loadWorkerConfig(baseEnv(tokenPath));
  assert.equal(config.enabled, true);
  assert.equal(config.model, "MiniMax-M3");
  assert.equal(config.modelVersion, "minimax-private-worker/1/MiniMax-M3");
  assert.match(config.promptHash, /^[a-f0-9]{64}$/u);
  assert.match(config.policyHash, /^[a-f0-9]{64}$/u);
  assert.ok(buildWorker(config) instanceof RemotePrivateAiPullWorker);
});

test("the MiniMax key may come from a key file instead of the direct env var, and is never exposed on the returned config JSON path", async (t) => {
  const { tokenPath, keyFile } = await fixture(t);
  const env = baseEnv(tokenPath);
  delete env.UNSEEN_MINIMAX_API_KEY;
  env.UNSEEN_MINIMAX_KEY_FILE = keyFile;
  const config = await loadWorkerConfig(env);
  assert.equal(config.minimax.apiKey, "file-sourced-test-key");
});

test("enabled:false still requires a fully valid configuration, matching the checked-in Mac worker's config.example.json convention", async (t) => {
  const { tokenPath } = await fixture(t);
  const env = { ...baseEnv(tokenPath), UNSEEN_MINIMAX_WORKER_ENABLED: "false" };
  const config = await loadWorkerConfig(env);
  assert.equal(config.enabled, false);
  assert.equal(await main(env), "disabled");
});

test("a completely empty environment is rejected, not silently treated as disabled", async () => {
  await assert.rejects(loadWorkerConfig({}), (error) => error.message === "worker_config_origin_required");
});

test("rejects a non-HTTPS origin, a relative token file path, and neither MiniMax credential source", async (t) => {
  const { tokenPath } = await fixture(t);
  await assert.rejects(loadWorkerConfig({ ...baseEnv(tokenPath), UNSEEN_PRIVATE_AI_ORIGIN: "http://unseen.example.com" }),
    (error) => error.message === "worker_config_origin_invalid");
  await assert.rejects(loadWorkerConfig({ ...baseEnv(tokenPath), UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE: "relative/path" }),
    (error) => error.message === "worker_config_token_file_required");
  const noCredential = baseEnv(tokenPath);
  delete noCredential.UNSEEN_MINIMAX_API_KEY;
  await assert.rejects(loadWorkerConfig(noCredential),
    (error) => error.message === "worker_config_minimax_credential_missing");
});

test("rejects a lease budget that cannot cover the analyzer's worst-case two-call retry window", async (t) => {
  const { tokenPath } = await fixture(t);
  await assert.rejects(loadWorkerConfig({ ...baseEnv(tokenPath), UNSEEN_PRIVATE_AI_MIN_LEASE_REMAINING_MS: "20000",
    UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS: "20000" }), (error) => error.message === "worker_config_lease_budget_invalid");
});

test("ca-file TLS mode requires an absolute CA path; an optional SPKI pin must be base64", async (t) => {
  const { tokenPath } = await fixture(t);
  await assert.rejects(loadWorkerConfig({ ...baseEnv(tokenPath), UNSEEN_PRIVATE_AI_TLS_MODE: "ca-file" }),
    (error) => error.message === "worker_config_tls_ca_file_required");
  await assert.rejects(loadWorkerConfig({ ...baseEnv(tokenPath), UNSEEN_PRIVATE_AI_TLS_SPKI_SHA256: "not-base64!!" }),
    (error) => error.message === "worker_config_tls_pin_invalid");
});

test("runWorkerLoop stops between cycles once its stop signal is aborted, without an extra poll", async () => {
  const controller = new AbortController();
  let calls = 0;
  const worker = { runOnce: async () => { calls += 1; controller.abort(); return { status: "idle", retryAfterMs: 1_000 }; } };
  await runWorkerLoop(worker, { stopSignal: controller.signal, random: () => 0,
    sleep: async () => { throw new Error("must not sleep after stop"); } });
  assert.equal(calls, 1);
});
