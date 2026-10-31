import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("cold server is same-origin, no-store and strict before app resources", async (context) => {
  const port = 4392;
  const server = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...process.env, UNSEEN_WEB_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => server.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server timeout")), 3000);
    server.stdout.on("data", () => { clearTimeout(timer); resolve(); });
    server.once("error", reject);
  });
  const response = await fetch(`http://127.0.0.1:${port}/open#invite=fixturebootstrapvalue123`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy"), /worker-src 'self'/);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self' 'nonce-/);
  assert.ok(html.indexOf("__UNSEEN_BOOTSTRAP__") < html.indexOf("/src/styles.css"));
  assert.ok(html.indexOf("/src/styles.css") < html.indexOf("/src/app.js"));
  assert.doesNotMatch(html, /localDeterministicLocator:true/);
});

test("local launcher can disclose deterministic locator mode without fixture bootstrap", async (context) => {
  const port = 4393;
  const server = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...process.env, UNSEEN_WEB_PORT: String(port), UNSEEN_WEB_LOCAL_DETERMINISTIC_LOCATOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => server.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server timeout")), 3000);
    server.stdout.on("data", () => { clearTimeout(timer); resolve(); });
    server.once("error", reject);
  });
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, /localDeterministicLocator:true/);
  assert.doesNotMatch(html, /fixture=1|__UNSEEN_TEST_BOOTSTRAP__/);
});

test("Book Lab feature flag is not injected by default, and the book-lab-web bridge is served with a safe path boundary", async (context) => {
  const port = 4394;
  const server = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...process.env, UNSEEN_WEB_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => server.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server timeout")), 3000);
    server.stdout.on("data", () => { clearTimeout(timer); resolve(); });
    server.once("error", reject);
  });
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.doesNotMatch(html, /__UNSEEN_CONFIG__/, "no config script should be injected when nothing is configured");
  assert.doesNotMatch(html, /bookLab/);

  const catalog = await fetch(`http://127.0.0.1:${port}/__book_lab_web__/catalog.json`);
  assert.equal(catalog.status, 200);
  assert.match(catalog.headers.get("content-type"), /application\/json/);
  const catalogBody = await catalog.json();
  assert.equal(catalogBody.locale, "zh-CN");

  const shellModule = await fetch(`http://127.0.0.1:${port}/__book_lab_web__/src/integrated-shell.mjs`);
  assert.equal(shellModule.status, 200);
  assert.match(shellModule.headers.get("content-type"), /text\/javascript/);
  assert.match(await shellModule.text(), /createIntegratedBookLabVisualShell/);

  // WHATWG URL parsing already collapses literal ".." segments before this handler ever sees them, and
  // an escaped "..%2F" is treated as a literal filename (never decoded back into a separator) — either
  // way nothing outside the package root must ever be readable through this route.
  const escaped = await fetch(`http://127.0.0.1:${port}/__book_lab_web__/${encodeURIComponent("../../package.json")}`);
  assert.equal(escaped.status, 404, "must not leak files outside the book-lab-web package root");
});

test("UNSEEN_WEB_BOOK_LAB_ENABLED=1 injects featureFlags.bookLab for local preview", async (context) => {
  const port = 4395;
  const server = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...process.env, UNSEEN_WEB_PORT: String(port), UNSEEN_WEB_BOOK_LAB_ENABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => server.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server timeout")), 3000);
    server.stdout.on("data", () => { clearTimeout(timer); resolve(); });
    server.once("error", reject);
  });
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, /featureFlags:\{bookLab:true\}/);
});

test("local login preview requires the visible image answer before issuing its mock OTP", async (context) => {
  const port = 4396;
  const server = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url),
    env: { ...process.env, UNSEEN_WEB_PORT: String(port), UNSEEN_WEB_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => server.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server timeout")), 3000);
    server.stdout.on("data", () => { clearTimeout(timer); resolve(); });
    server.once("error", reject);
  });
  const origin = `http://127.0.0.1:${port}`;
  const challenge = await (await fetch(`${origin}/v1/auth/otp-verification-challenges`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  assert.equal(challenge.mode, "pow");
  assert.equal(challenge.visual.tiles.length, 9);
  assert.equal(challenge.visual.prompt, "请选择所有星形");
  const request = (verificationSelection) => fetch(`${origin}/v1/auth/email-otp-challenges`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "preview@example.test", purpose: "login", locale: "zh-CN",
      verificationChallengeId: challenge.challengeId, verificationNonce: 0, verificationSelection })
  });
  assert.equal((await request([0])).status, 403);
  const accepted = await request([1, 5]);
  assert.equal(accepted.status, 200);
  assert.ok((await accepted.json()).challengeId);
  assert.equal((await request([1, 5])).status, 403, "the local proof must be single-use");
});
