import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWorker, loadWorkerConfig, main } from
  "../../../infra/integration/mac-codex-private-worker/daemon.mjs";
import { RemotePrivateAiPullWorker } from
  "../../../infra/integration/mac-codex-private-worker/remote-pull.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const example = path.resolve(here, "../../../infra/integration/mac-codex-private-worker/config.example.json");

test("checked-in daemon configuration is valid, default-off and builds no listener", async () => {
  const config = await loadWorkerConfig(example);
  assert.equal(config.enabled, false);
  assert.equal(await main({ UNSEEN_PRIVATE_AI_WORKER_CONFIG: example }), "disabled");
  assert.ok(buildWorker({ ...config, enabled: true }) instanceof RemotePrivateAiPullWorker);
});

test("config rejects symlinks, group-writable bytes and prompt-policy drift", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-worker-config-test-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "config.json");
  await copyFile(example, target);
  await chmod(target, 0o600);
  const link = path.join(directory, "config-link.json");
  await symlink(target, link);
  await assert.rejects(loadWorkerConfig(link), (error) => error.message === "worker_config_file_invalid");
  await chmod(target, 0o620);
  await assert.rejects(loadWorkerConfig(target), (error) => error.message === "worker_config_file_invalid");
  const value = JSON.parse(await readFile(example, "utf8"));
  value.promptHash = "0".repeat(64);
  await writeFile(target, JSON.stringify(value), { mode: 0o600 });
  await chmod(target, 0o600);
  await assert.rejects(loadWorkerConfig(target), (error) => error.message === "worker_config_invalid");
});
