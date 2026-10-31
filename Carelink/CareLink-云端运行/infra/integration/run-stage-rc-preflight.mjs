import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "unseen-stage-rc-preflight-"));
const dataRoot = path.join(temporaryRoot, "data");
const evidenceRoot = path.join(temporaryRoot, "evidence");
await Promise.all([mkdir(dataRoot), mkdir(evidenceRoot)]);

const runtime = spawn(process.execPath, ["infra/integration/local-operable.mjs"], {
  cwd: repositoryRoot,
  env: { ...process.env, UNSEEN_LOCAL_PORT: "4298", UNSEEN_LOCAL_DATA_DIR: dataRoot,
    UNSEEN_LOCAL_EVIDENCE_DIR: evidenceRoot },
  stdio: ["ignore", "pipe", "pipe"]
});
let runtimeStderr = "";
runtime.stderr.on("data", (bytes) => { runtimeStderr += bytes; });

async function poll(run, label) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const result = await run().catch(() => null);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`stage_rc_preflight_timeout:${label}:${runtimeStderr}`);
}

async function stop() {
  if (runtime.exitCode !== null) return;
  const exited = new Promise((resolve) => runtime.once("exit", resolve));
  runtime.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (runtime.exitCode === null) runtime.kill("SIGKILL");
}

try {
  const startup = await poll(async () => JSON.parse(await readFile(path.join(evidenceRoot, "LOCAL-STARTUP.json"), "utf8")),
    "startup");
  await poll(async () => (await fetch(`${startup.origin}/healthz`)).ok, "health");
  const preflight = spawn(process.execPath, ["tests/e2e/stage-rc-five-actor.preflight.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, UNSEEN_STAGE_RC_ORIGIN: startup.origin, UNSEEN_STAGE_RC_DATA_DIR: dataRoot },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  preflight.stdout.on("data", (bytes) => stdout.push(bytes));
  preflight.stderr.on("data", (bytes) => stderr.push(bytes));
  const code = await new Promise((resolve) => preflight.once("exit", resolve));
  if (code !== 0) throw new Error(`stage_rc_preflight_failed:${Buffer.concat(stderr).toString("utf8")}`);
  process.stdout.write(Buffer.concat(stdout));
} finally {
  await stop();
  await rm(temporaryRoot, { recursive: true, force: true });
}
