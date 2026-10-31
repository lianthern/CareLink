import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const entrypoint = path.join(repositoryRoot, "infra/integration/local-operable.mjs");

async function boot(t, extraEnv, { expectReady = true, timeoutMs = 10_000 } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "unseen-local-operable-book-lab-data-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "unseen-local-operable-book-lab-evidence-"));
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  });
  const preferredPort = 20_000 + Math.floor(Math.random() * 40_000);
  const env = { ...process.env, UNSEEN_LOCAL_PORT: String(preferredPort), UNSEEN_LOCAL_DATA_DIR: dataDir,
    UNSEEN_LOCAL_EVIDENCE_DIR: evidenceDir, ...extraEnv };
  const runtime = spawn(process.execPath, [entrypoint], { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (runtime.exitCode !== null) return;
    const exited = new Promise((resolve) => runtime.once("exit", resolve));
    runtime.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (runtime.exitCode === null) runtime.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  runtime.stdout.on("data", (bytes) => { stdout += bytes; });
  runtime.stderr.on("data", (bytes) => { stderr += bytes; });
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`local_operable_boot_timeout:${stdout}${stderr}`)), timeoutMs);
    const settle = (value) => { clearTimeout(timer); resolve(value); };
    runtime.stdout.on("data", () => {
      const line = stdout.split("\n").find((entry) => entry.includes("LOCAL_OPERABLE_READY"));
      if (line) settle({ ready: JSON.parse(line) });
    });
    runtime.once("exit", (code) => {
      if (!stdout.includes("LOCAL_OPERABLE_READY")) settle({ exitCode: code, stderr });
    });
  });
  if (expectReady) assert.ok(outcome.ready, `expected LOCAL_OPERABLE_READY, got exit ${outcome.exitCode}: ${stderr}`);
  else assert.ok(!outcome.ready, `expected startup failure, got ready line: ${JSON.stringify(outcome.ready)}`);
  return { ...outcome, origin: outcome.ready?.origin };
}

async function fetchText(origin, pathname) {
  const response = await fetch(new URL(pathname, origin));
  return { status: response.status, text: await response.text() };
}

test("UNSEEN_BOOK_LAB_ENABLED unset: behavior is identical to before — flag off, book-lab routes not wired to the API", async (t) => {
  const { ready, origin } = await boot(t, {});
  assert.deepEqual(ready.bookLab, { enabled: false, privateAiWorker: false, renderWorker: false, mounted: false });

  const status = await (await fetch(new URL("/__local-operable/status", origin))).json();
  assert.deepEqual(status.bookLab, { enabled: false, privateAiWorker: false, renderWorker: false, mounted: false });

  const index = await fetchText(origin, "/");
  assert.match(index.text, /featureFlags":\{"bookLab":false\}/);

  // /v2-labs/* is not routed to the API when the flag is off — it still falls through to the SPA shell,
  // exactly like before this change (never a 503/404 JSON error from the (unmounted) extension).
  const bookLabPath = await fetchText(origin, "/v2-labs/owner/spaces/x/book-lab");
  assert.equal(bookLabPath.status, 200);
  assert.match(bookLabPath.text, /<!doctype html>/i);
});

test("UNSEEN_PRIVATE_AI_WORKER_ENABLED=true without UNSEEN_BOOK_LAB_ENABLED fails closed at startup", async (t) => {
  const { exitCode, stderr } = await boot(t, { UNSEEN_PRIVATE_AI_WORKER_ENABLED: "true" }, { expectReady: false });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /local_operable_invalid:private_ai_book_lab_required/);
});

test("UNSEEN_BOOK_LAB_ENABLED=true: extension mounts, frontend flag flips, /v2-labs/* reaches the real API", async (t) => {
  const { ready, origin } = await boot(t, { UNSEEN_BOOK_LAB_ENABLED: "true" });
  assert.deepEqual(ready.bookLab, { enabled: true, privateAiWorker: false, renderWorker: false, mounted: true });

  const status = await (await fetch(new URL("/__local-operable/status", origin))).json();
  assert.deepEqual(status.bookLab, { enabled: true, privateAiWorker: false, renderWorker: false, mounted: true });

  const index = await fetchText(origin, "/");
  assert.match(index.text, /featureFlags":\{"bookLab":true\}/);

  // The route is now dispatched to the real book-lab extension instead of the SPA fallback — a JSON API
  // error (not an index.html 200) proves the wiring reaches BookLabMemoryApi.
  const response = await fetch(new URL("/v2-labs/owner/spaces/x/book-lab", origin));
  const body = await response.json();
  assert.notEqual(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.ok(body.error?.code, `expected a book-lab JSON error, got ${JSON.stringify(body)}`);
});

test("core /v1 behavior is unaffected when book-lab is enabled alongside it", async (t) => {
  const { origin } = await boot(t, { UNSEEN_BOOK_LAB_ENABLED: "true" });
  const health = await (await fetch(new URL("/healthz", origin))).json();
  assert.equal(health.status, "ok");
  const spaces = await fetch(new URL("/v1/me/spaces", origin));
  assert.equal(spaces.status, 401); // unauthenticated, same as always — proves /v1 routing untouched
});
