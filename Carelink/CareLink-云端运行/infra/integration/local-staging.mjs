import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOperationLock } from "./operation-lock.mjs";

process.umask(0o077);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(await readFile(path.join(repositoryRoot, "config/rc/local-staging.json"), "utf8"));
const stagingMode = process.env.UNSEEN_STAGING_MODE ?? "local";
if (!["local", "server_staging", "production"].includes(stagingMode)) {
  throw new Error("local_staging_mode_invalid");
}
if (stagingMode === "production") {
  throw new Error("production_runtime_not_implemented:tracks_1b_3b_6b_8c_required");
}
if (stagingMode === "server_staging") {
  const required = ["UNSEEN_STAGING_HOST", "UNSEEN_STAGING_PORT", "UNSEEN_STAGING_PUBLIC_ORIGIN",
    "UNSEEN_STAGING_DATA_DIR", "UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR", "UNSEEN_BOOK_WORKTREE",
    "UNSEEN_BOOK_OUTPUT_DIR", "UNSEEN_STAGING_EXPECT_REPOSITORY_STATE",
    "UNSEEN_STAGING_EXTERNAL_EXPOSURE_ACK", "UNSEEN_STAGING_OTP_PROVIDER",
    "UNSEEN_STAGING_MEDIA_PROVIDER"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`server_staging_environment_required:${missing.join(",")}`);
  if (process.env.UNSEEN_STAGING_EXPECT_REPOSITORY_STATE !== "clean") {
    throw new Error("server_staging_clean_repository_required");
  }
  if (process.env.UNSEEN_STAGING_EXTERNAL_EXPOSURE_ACK !== "access_controlled_tls_reverse_proxy") {
    throw new Error("server_staging_exposure_ack_invalid");
  }
  if (process.env.UNSEEN_STAGING_OTP_PROVIDER !== "local_fixture_only" ||
    process.env.UNSEEN_STAGING_MEDIA_PROVIDER !== "filesystem_fixture_only") {
    throw new Error("server_staging_provider_disclosure_invalid");
  }
  for (const name of ["UNSEEN_STAGING_DATA_DIR", "UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR",
    "UNSEEN_BOOK_WORKTREE", "UNSEEN_BOOK_OUTPUT_DIR"]) {
    if (!path.isAbsolute(process.env[name])) throw new Error(`server_staging_absolute_path_required:${name}`);
  }
}
const host = process.env.UNSEEN_STAGING_HOST ?? config.host;
const preferredPort = Number(process.env.UNSEEN_STAGING_PORT ?? config.port);
if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("local_staging_loopback_required");
if (!Number.isSafeInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535 ||
  (stagingMode === "server_staging" && preferredPort === 0)) throw new Error("local_staging_port_invalid");
const bookWorktree = path.resolve(process.env.UNSEEN_BOOK_WORKTREE ?? config.book.worktree);
const expectedRepositoryState = process.env.UNSEEN_STAGING_EXPECT_REPOSITORY_STATE;
if (expectedRepositoryState !== undefined && !["clean", "allow_dirty"].includes(expectedRepositoryState)) {
  throw new Error("local_staging_repository_state_policy_invalid");
}
const repositoryStatus = execFileSync("git", ["status", "--porcelain"],
  { cwd: repositoryRoot, encoding: "utf8" }).trim();
if (expectedRepositoryState === "clean" && repositoryStatus) throw new Error("local_staging_repository_dirty");
const coreProductPaths = ["services/api", "services/jobs", "apps/web", "packages/viewer"];
try {
  execFileSync("git", ["rev-parse", "--verify", `${config.inputs.coreLocal}^{commit}`],
    { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["diff", "--quiet", "--no-ext-diff", config.inputs.coreLocal, "--", ...coreProductPaths],
    { cwd: repositoryRoot, stdio: "ignore" });
  const productStatus = execFileSync("git", ["status", "--porcelain", "--", ...coreProductPaths],
    { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (productStatus) throw new Error("product_paths_dirty");
} catch (error) {
  throw new Error("local_staging_core_product_pin_mismatch", { cause: error });
}
const userStateRoot = path.join(homedir(), "Library/Application Support");
const stagingDataRoot = path.resolve(process.env.UNSEEN_STAGING_DATA_DIR ??
  path.join(userStateRoot, config.persistence.dataDirectory));
const stagingEvidenceRoot = path.resolve(process.env.UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR ??
  path.join(userStateRoot, config.persistence.runtimeEvidenceDirectory));
const bookOutputRoot = path.resolve(process.env.UNSEEN_BOOK_OUTPUT_DIR ??
  path.join(stagingDataRoot, "book-artifacts"));
const bookHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: bookWorktree, encoding: "utf8" }).trim();
const bookStatus = execFileSync("git", ["status", "--porcelain"], { cwd: bookWorktree, encoding: "utf8" }).trim();
if (bookHead !== config.inputs.bookWeb || bookStatus) throw new Error("local_staging_book_input_invalid");

async function claimPort(preferred = 0, fallbackOnConflict = true) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      if (error.code !== "EADDRINUSE" || preferred === 0 || !fallbackOnConflict) return reject(error);
      claimPort(0).then(resolve, reject);
    });
    probe.listen(preferred, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function claimDistinctPort(excluded) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const selected = await claimPort(0);
    if (!excluded.has(selected)) return selected;
  }
  throw new Error("local_staging_distinct_port_unavailable");
}

function bookRoute(pathname) {
  return /^\/labs\/(?:memories|books)\//u.test(pathname) ||
    /^\/manage\/[^/]+\/book-lab(?:\/|$)/u.test(pathname) ||
    /^\/s\/[^/]+\/books\/[^/]+\/versions\/[^/]+\/?$/u.test(pathname) ||
    pathname.startsWith("/packages/book-lab-web/") ||
    ["/__fixture", "/__catalog", "/__artifacts/render", "/__artifacts/book.html",
      "/__artifacts/book.pdf", "/__artifacts/render-receipt.json"].includes(pathname) ||
    /^\/__artifacts\/[a-f0-9]{64}\/(?:book\.html|book\.pdf|render-receipt\.json)$/u.test(pathname);
}

function child(name, cwd, script, env) {
  const processChild = spawn(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  processChild.stdout.on("data", (bytes) => process.stdout.write(`[${name}] ${bytes}`));
  processChild.stderr.on("data", (bytes) => process.stderr.write(`[${name}] ${bytes}`));
  return processChild;
}

async function waitFor(url, validate, init = {}) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      const response = init.headers?.host ? await new Promise((resolve, reject) => {
        const target = new URL(url);
        const probe = httpRequest({ hostname: target.hostname, port: target.port,
          path: `${target.pathname}${target.search}`, headers: init.headers }, (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({ ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
              headers: { get: (name) => incoming.headers[String(name).toLowerCase()] ?? null },
              json: async () => JSON.parse(body.toString("utf8")) });
          });
        });
        probe.once("error", reject);
        probe.end();
      }) : await fetch(url, { cache: "no-store", ...init });
      if (response.ok && await validate(response)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`local_staging_child_not_ready:${url}`);
}

const gatewayPort = await claimPort(preferredPort, stagingMode === "local");
const corePort = await claimDistinctPort(new Set([gatewayPort]));
const bookPort = await claimDistinctPort(new Set([gatewayPort, corePort]));
const listenOrigin = `http://127.0.0.1:${gatewayPort}`;
const origin = String(process.env.UNSEEN_STAGING_PUBLIC_ORIGIN ?? listenOrigin).replace(/\/$/u, "");
const publicUrl = new URL(origin);
const localOrigin = ["127.0.0.1", "localhost"].includes(publicUrl.hostname) &&
  ["http:", "https:"].includes(publicUrl.protocol);
const serverOrigin = stagingMode === "server_staging" && publicUrl.protocol === "https:" && !localOrigin;
if (!(stagingMode === "local" ? localOrigin : serverOrigin) || publicUrl.pathname !== "/" ||
  publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
  throw new Error("local_staging_public_origin_invalid");
}
const coreOrigin = `http://127.0.0.1:${corePort}`;
const bookOrigin = `http://127.0.0.1:${bookPort}`;
await Promise.all([mkdir(stagingDataRoot, { recursive: true, mode: 0o700 }),
  mkdir(stagingEvidenceRoot, { recursive: true, mode: 0o700 }),
  mkdir(bookOutputRoot, { recursive: true, mode: 0o700 })]);
await Promise.all([chmod(stagingDataRoot, 0o700), chmod(stagingEvidenceRoot, 0o700), chmod(bookOutputRoot, 0o700)]);
const runningPath = path.join(stagingEvidenceRoot, "RUNNING.json");
const operationLock = await acquireOperationLock(stagingDataRoot, "launcher");

async function clearStaleRunningMarker() {
  let marker;
  try {
    marker = JSON.parse(await readFile(runningPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("local_staging_running_marker_invalid", { cause: error });
  }
  if (marker?.schema !== "unseen-local-staging-running/1" ||
    !Number.isSafeInteger(marker.pid) || marker.pid <= 0) {
    throw new Error("local_staging_running_marker_invalid");
  }
  try {
    process.kill(marker.pid, 0);
    throw new Error(`local_staging_already_running:${marker.pid}`);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await rm(runningPath, { force: true });
}

async function removeOwnRunningMarker() {
  try {
    const marker = JSON.parse(await readFile(runningPath, "utf8"));
    if (marker?.pid === process.pid) await rm(runningPath, { force: true });
  } catch (error) {
    if (error.code !== "ENOENT") process.stderr.write(`[staging] running marker cleanup failed: ${error.message}\n`);
  }
}

try {
  await clearStaleRunningMarker();
} catch (error) {
  await operationLock.release();
  throw error;
}
const core = child("core", repositoryRoot, "infra/integration/local-operable.mjs", {
  UNSEEN_LOCAL_PORT: String(corePort),
  UNSEEN_LOCAL_PUBLIC_ORIGIN: origin,
  UNSEEN_LOCAL_DATA_DIR: stagingDataRoot,
  UNSEEN_LOCAL_EVIDENCE_DIR: stagingEvidenceRoot,
  UNSEEN_LOCAL_SUPERVISED_MODE: stagingMode,
  UNSEEN_LOCAL_EXTERNAL_ORIGIN_ACK: process.env.UNSEEN_STAGING_EXTERNAL_EXPOSURE_ACK ?? ""
});
const book = child("book", bookWorktree, "packages/book-lab-web/scripts/dev-server.mjs", {
  UNSEEN_BOOK_LAB_PORT: String(bookPort),
  UNSEEN_BOOK_OUTPUT_DIR: bookOutputRoot
});
async function stopChildren() {
  for (const processChild of [core, book]) processChild.kill("SIGTERM");
  await Promise.all([core, book].map((processChild) => new Promise((resolve) => {
    if (processChild.exitCode != null) return resolve();
    processChild.once("exit", resolve);
    setTimeout(() => { processChild.kill("SIGKILL"); resolve(); }, 2000).unref();
  })));
}
let ready = false;
let stopping = false;
for (const processChild of [core, book]) processChild.once("exit", () => {
  if (!stopping) {
    ready = false;
    void removeOwnRunningMarker().finally(() => process.kill(process.pid, "SIGTERM"));
  }
});

async function childrenHealthy() {
  if (!ready) return false;
  try {
    const [coreHealthy, bookResponse] = await Promise.all([
      new Promise((resolve) => {
        const probe = httpRequest({ hostname: "127.0.0.1", port: corePort, path: "/healthz",
          headers: { host: publicUrl.host } }, (response) => {
          const healthy = response.statusCode === 200 &&
            response.headers["x-unseen-runtime-id"] === "unseen-stage-l-local-operable-v1";
          response.resume();
          response.once("end", () => resolve(healthy));
        });
        probe.once("error", () => resolve(false));
        probe.setTimeout(1000, () => probe.destroy());
        probe.end();
      }),
      fetch(`${bookOrigin}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(1000) })
    ]);
    if (!coreHealthy || !bookResponse.ok) return false;
    const bookHealth = await bookResponse.json();
    return bookHealth.ready === true && bookHealth.fixtureOnly === true &&
      /^[a-f0-9]{64}$/u.test(bookHealth.input?.fixtureHash);
  } catch {
    return false;
  }
}

const server = createServer(async (incoming, outgoing) => {
  const pathname = new URL(incoming.url, origin).pathname;
  const expectedHost = new URL(origin).host;
  if (incoming.headers.host !== expectedHost) {
    outgoing.writeHead(400, { "content-type": "application/json", "cache-control": "no-store",
      "x-unseen-staging": "true", "x-unseen-staging-surface": "supervisor" });
    outgoing.end(JSON.stringify({ error: { code: "request_host_invalid" } }));
    return;
  }
  if (incoming.method === "GET" && ["/__staging/healthz", "/__staging/meta"].includes(pathname)) {
    const healthy = await childrenHealthy();
    outgoing.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store",
      "x-unseen-staging": "true", "x-unseen-staging-surface": "supervisor" });
    outgoing.end(JSON.stringify({ schema: "unseen-local-staging-status/1", status: healthy ? "ok" : "unavailable", origin,
      listener: "loopback_only", inputs: config.inputs, core: { route: "/", fixture: "deterministic_locator" },
      book: { route: "/labs/memories/photos/photo-01", fixture: true, notice: config.book.fixtureNotice },
      deployment: stagingMode === "server_staging", deploymentMode: stagingMode,
      externalExposure: stagingMode === "server_staging",
      exposureBoundary: stagingMode === "server_staging" ? "access_controlled_tls_reverse_proxy" : "none",
      providers: { otp: process.env.UNSEEN_STAGING_OTP_PROVIDER ?? "local_fixture_only",
        media: process.env.UNSEEN_STAGING_MEDIA_PROVIDER ?? "filesystem_fixture_only" },
      productionReady: false, cloudWrites: 0 }));
    return;
  }
  if (incoming.method === "GET" && ["/__staging", "/__staging/"].includes(pathname)) {
    outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-unseen-staging": "true", "x-unseen-staging-surface": "supervisor" });
    outgoing.end(`<!doctype html><meta charset="utf-8"><title>UNSEEN Local Staging</title><style>body{font:16px system-ui;max-width:48rem;margin:4rem auto;padding:0 1rem}a{display:block;margin:1rem 0}</style><h1>UNSEEN Local Staging</h1><p>服务进程仅监听本机回环；外部访问（如有）必须经过带访问控制的 TLS 反向代理。Core 使用确定性定位 fixture；Book 使用确定性本地样本，不代表真实 AI 问题质量。OTP 与媒体仍是 staging adapter。</p><a href="/">打开 Core Local Operable</a><a href="/labs/memories/photos/photo-01">打开 Book Lab fixture</a>`);
    return;
  }
  const target = bookRoute(pathname) ? new URL(bookOrigin) : new URL(coreOrigin);
  const headers = { ...incoming.headers,
    host: target.origin === bookOrigin ? target.host : expectedHost };
  if (target.origin === bookOrigin) delete headers.cookie;
  const upstream = httpRequest({ hostname: target.hostname, port: target.port, method: incoming.method,
    path: incoming.url, headers }, (response) => {
    const output = { ...response.headers, "x-unseen-staging": "true",
      "x-unseen-staging-surface": target.origin === bookOrigin ? "book-fixture" : "core" };
    outgoing.writeHead(response.statusCode, output);
    response.pipe(outgoing);
  });
  upstream.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8",
      "x-unseen-staging": "true", "x-unseen-staging-surface": "supervisor" });
    outgoing.end("local staging upstream unavailable");
  });
  incoming.pipe(upstream);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  stopping = true;
  ready = false;
  await new Promise((resolve) => server.close(resolve));
  await stopChildren();
  await removeOwnRunningMarker();
  await operationLock.release();
  process.stdout.write(`${JSON.stringify({ status: "LOCAL_STAGING_STOPPED", signal, clean: true })}\n`);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  void shutdown(signal).then(() => process.exit(0), () => process.exit(1));
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(gatewayPort, "127.0.0.1", resolve);
  });
  await Promise.all([
    waitFor(`${listenOrigin}/healthz`, async (response) =>
      response.headers.get("x-unseen-runtime-id") === "unseen-stage-l-local-operable-v1",
    { headers: { host: publicUrl.host } }),
    waitFor(`${listenOrigin}/__fixture`, async (response) => {
      const value = await response.json();
      return value.fixtureNotice === config.book.fixtureNotice && /^[a-f0-9]{64}$/u.test(value.fixtureHash);
    }, { headers: { host: publicUrl.host } })
  ]);
  ready = true;
  const temporaryRunning = `${runningPath}.${process.pid}.tmp`;
  await writeFile(temporaryRunning, `${JSON.stringify({ schema: "unseen-local-staging-running/1", pid: process.pid,
    origin, listenOrigin, mode: stagingMode, inputs: config.inputs,
    startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryRunning, runningPath);
  process.stdout.write(`${JSON.stringify({ status: "LOCAL_STAGING_READY", origin,
    listenOrigin: origin === listenOrigin ? undefined : listenOrigin,
    mode: stagingMode, core: "/", book: "/labs/memories/photos/photo-01", bookFixture: true,
    inputs: config.inputs, cloudWrites: 0 })}\n`);
} catch (error) {
  stopping = true;
  await stopChildren();
  await operationLock.release();
  throw error;
}
