import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

test("a clean checkout starts App + core with isolated state and closes both on SIGTERM", { timeout: 45000 }, async (t) => {
  const state = await mkdtemp(join(tmpdir(), "unseen-team-stack-"));
  const child = spawn(process.execPath, ["scripts/team/dev.mjs"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, UNSEEN_TEAM_PORT: "0", UNSEEN_TEAM_STATE_DIR: state, UNSEEN_TEAM_ENABLE_PROVIDERS: "0",
      MINIMAX_API_KEY: "not-a-real-parent-key-must-not-be-used", WORLDLABS_API_KEY: "not-a-real-parent-key-must-not-be-used" }
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped;
    }
    await rm(state, { recursive: true, force: true });
  });
  const ready = await new Promise((accept, reject) => {
    child.once("exit", (code) => reject(new Error(`launcher exited (${code}): ${errors}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      try { const value = JSON.parse(line); if (value.status === 'UNSEEN_TEAM_READY') accept(value); } catch { /* child log */ }
    });
  });
  const origin = new URL(ready.url).origin;
  assert.equal(ready.externalProvidersEnabled, false);
  const health = await (await fetch(`${origin}/healthz`)).json();
  assert.equal(health.buildId, 'unseen-team-local');
  assert.equal(health.photoAi.configured, false);
  const coreStatus = await new Promise((accept, reject) => {
    const request = get(`${ready.core}/healthz`, { headers: { host: new URL(origin).host } }, (response) => {
      response.resume(); response.once('end', () => accept(response.statusCode));
    });
    request.once('error', reject);
  });
  assert.equal(coreStatus, 200);
  const page = await fetch(ready.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const entry = html.match(/import\('([^']*\/app-assets\/[^']+\.js)'\)/u)?.[1];
  assert.ok(entry, 'current App HTML must load its generated module');
  assert.equal((await fetch(new URL(entry, origin))).status, 200);
  const unauthorized = await fetch(`${origin}/v1/me`);
  assert.ok([401, 403].includes(unauthorized.status), `canonical request must reach auth guard, got ${unauthorized.status}`);
  assert.ok(!JSON.stringify(await unauthorized.json()).includes('canonical_unavailable'));
  const stopped = once(child, "exit"); child.kill("SIGTERM");
  const [code] = await stopped;
  assert.equal(code, 0, errors);
  const shutdown = JSON.parse(await readFile(join(state, 'evidence/SHUTDOWN.json'), 'utf8'));
  assert.equal(shutdown.clean, true);
  await assert.rejects(fetch(`${origin}/healthz`));
  await assert.rejects(fetch(`${ready.core}/healthz`));
});
