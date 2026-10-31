#!/usr/bin/env node
// Local App + canonical runtime. One independent state directory per checkout.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const children = new Set();
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }));
  process.exitCode = code;
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

async function freePort(preferred) {
  const server = createServer();
  const ready = once(server, "listening");
  server.listen(preferred, "127.0.0.1");
  await ready;
  const port = server.address().port;
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return port;
}

function start(name, entry, cwd, env, isReady) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  return new Promise((accept, reject) => {
    let ready = false;
    const timeout = setTimeout(() => reject(new Error(`${name}: startup timed out`)), 30000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); void stop(1); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (!ready) reject(new Error(`${name}: exited before ready (${code ?? signal})`));
      if (!stopping) { console.error(`${name}: stopped (${code ?? signal})`); void stop(code || 1); }
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      process.stdout.write(`[${name}] ${line}\n`);
      if (ready) return;
      const result = isReady(line);
      if (result) { ready = true; clearTimeout(timeout); accept(result); }
    });
  });
}

try {
  const requested = Number(process.env.UNSEEN_TEAM_PORT ?? 4610);
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw new Error("UNSEEN_TEAM_PORT must be 0..65535");
  const appPort = await freePort(requested);
  const corePort = await freePort(0);
  const origin = `http://127.0.0.1:${appPort}`;
  const state = resolve(process.env.UNSEEN_TEAM_STATE_DIR || resolve(root, ".local/team"));
  await mkdir(state, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"].includes(key)));
  const core = await start("core", "infra/integration/local-operable.mjs", root, {
    ...env,
    UNSEEN_LOCAL_HOST: "127.0.0.1", UNSEEN_LOCAL_PORT: String(corePort),
    UNSEEN_LOCAL_PUBLIC_ORIGIN: origin, UNSEEN_LOCAL_SUPERVISED_MODE: "local",
    UNSEEN_LOCAL_DATA_DIR: resolve(state, "core"), UNSEEN_LOCAL_EVIDENCE_DIR: resolve(state, "evidence"),
    UNSEEN_OTP_DELIVERY_PROVIDER: "disabled", UNSEEN_BOOK_LAB_ENABLED: "true"
  }, (line) => { try { const value = JSON.parse(line); return value.status === "LOCAL_OPERABLE_READY" && value; } catch { return false; } });
  const providers = process.env.UNSEEN_TEAM_ENABLE_PROVIDERS === "1"
    ? Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(MINIMAX_|WORLDLABS_|WLT_API_KEY$|MOMENT_)/u.test(key)))
    : {};
  await start("app", "server.mjs", resolve(root, "apps/huijian"), {
    ...env, ...providers, PORT: String(appPort), STATE_DIRECTORY: resolve(state, "app"),
    CANONICAL_UPSTREAM: core.listenOrigin || core.origin, CANONICAL_PUBLIC_ORIGIN: origin,
    UNSEEN_PROVIDER_KEYS_ENV_ONLY: "true", BUILD_ID: "unseen-team-local"
  }, (line) => /127\.0\.0\.1:/u.test(line));
  console.log(JSON.stringify({ status: "UNSEEN_TEAM_READY", url: `${origin}/app-v2`, core: core.listenOrigin || core.origin,
    stateDirectory: state, externalProvidersEnabled: process.env.UNSEEN_TEAM_ENABLE_PROVIDERS === "1" }));
} catch (error) {
  console.error(error.message);
  if (error.code === "EADDRINUSE") console.error("Choose another port: UNSEEN_TEAM_PORT=0 npm run dev");
  await stop(1);
}
