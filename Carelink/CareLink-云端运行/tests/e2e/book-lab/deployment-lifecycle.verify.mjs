import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createBookLabDeployment } from "../../../infra/integration/book-lab/deployment-entrypoint.mjs";
import { findLocalBrowser } from "../../../packages/book-renderer/src/pdf.mjs";
import { sha256 } from "../../../services/api/src/util.mjs";
import { COLLECTION_NOTICE_CONTEXT_DISCLOSURE } from "../../../services/book-lab/src/index.mjs";

function deploymentEnv(directory, enabled, port = "0") {
  const notice = "8c-deployment-notice";
  const noticeCopy = `测试部署接缝，不代表正式法律文案。${COLLECTION_NOTICE_CONTEXT_DISCLOSURE}`;
  const grant = "8c-deployment-grant";
  return {
    PATH: process.env.PATH,
    UNSEEN_API_HOST: "127.0.0.1",
    UNSEEN_API_PORT: port,
    UNSEEN_API_DB: path.join(directory, "core.sqlite"),
    UNSEEN_API_KEYSET: path.join(directory, "core.keyset.json"),
    UNSEEN_API_MEDIA_ROOT: path.join(directory, "media"),
    UNSEEN_BOOK_LAB_ENABLED: enabled ? "true" : "false",
    UNSEEN_BOOK_LAB_DB: path.join(directory, "book.sqlite"),
    UNSEEN_BOOK_LAB_LOCK: path.join(directory, "deployment.lock"),
    UNSEEN_BOOK_LAB_RENDER_TMP: path.join(directory, "render-tmp"),
    UNSEEN_CHROMIUM_PATH: findLocalBrowser(),
    UNSEEN_BOOK_LAB_ETAG_SECRET: "test-secret-8c-deployment-etag-not-production-0001",
    UNSEEN_BOOK_LAB_WORKER_SECRET: "test-secret-8c-deployment-worker-not-production-002",
    UNSEEN_BOOK_LAB_CLEANUP_SECRET: "test-secret-8c-deployment-cleanup-not-production-03",
    UNSEEN_BOOK_LAB_RENDER_WORKER_SECRET: "test-secret-8c-deployment-render-not-production-004",
    UNSEEN_BOOK_LAB_COLLECTION_NOTICE_VERSION: notice,
    UNSEEN_BOOK_LAB_COLLECTION_NOTICE_HASH: sha256(noticeCopy),
    UNSEEN_BOOK_LAB_COLLECTION_NOTICE_COPY: noticeCopy,
    UNSEEN_BOOK_LAB_GRANT_NOTICE_VERSION: grant,
    UNSEEN_BOOK_LAB_GRANT_NOTICE_HASH: sha256(grant)
  };
}

test("deployment flag-off stays Book-inert while flag-on owns and closes both persistent stores", async (t) => {
  const offDirectory = mkdtempSync(path.join(os.tmpdir(), "unseen-8c-deploy-off-"));
  const onDirectory = mkdtempSync(path.join(os.tmpdir(), "unseen-8c-deploy-on-"));
  t.after(() => rmSync(offDirectory, { recursive: true, force: true }));
  t.after(() => rmSync(onDirectory, { recursive: true, force: true }));

  const offEnv = deploymentEnv(offDirectory, false);
  Object.assign(offEnv, {
    UNSEEN_BOOK_RENDERER_TRANSPORT: "unseen-book-renderer-dedicated-service/v1",
    UNSEEN_BOOK_RENDERER_SOCKET: path.join(offDirectory, "must-not-open.sock"),
    UNSEEN_BOOK_RENDERER_SPOOL: path.join(offDirectory, "must-not-create-spool"),
    UNSEEN_BOOK_RENDERER_ACCEPTANCE_FILE: path.join(offDirectory, "must-not-read-acceptance.json"),
    UNSEEN_BOOK_RENDERER_ACCEPTANCE_SHA256: "0".repeat(64)
  });
  const off = await createBookLabDeployment({ env: offEnv });
  assert.deepEqual(await off.api.ready, { enabled: false, mountedRoutes: 0, registeredJobs: 0,
    businessWrites: 0, businessBundleImported: false });
  assert.equal(existsSync(offEnv.UNSEEN_BOOK_LAB_DB), false);
  assert.equal(existsSync(offEnv.UNSEEN_BOOK_RENDERER_SPOOL), false);
  assert.equal(existsSync(offEnv.UNSEEN_BOOK_RENDERER_SOCKET), false);
  assert.equal(existsSync(offEnv.UNSEEN_BOOK_LAB_LOCK), true);
  await off.close();
  assert.equal(existsSync(offEnv.UNSEEN_BOOK_LAB_LOCK), false);

  const onEnv = deploymentEnv(onDirectory, true);
  const on = await createBookLabDeployment({ env: onEnv });
  assert.equal((await on.api.ready).businessBundleImported, true);
  assert.equal(existsSync(onEnv.UNSEEN_BOOK_LAB_DB), true);
  assert.equal((await fetch(`${on.origin}/__book-lab/healthz`)).status, 200);
  assert.equal((await fetch(`${on.origin}/v2-labs/memories/photos/not-present`))
    .headers.get("x-unseen-private-ai-worker"), "disabled");
  assert.ok([200, 503].includes((await fetch(`${on.origin}/healthz`)).status));
  const serverClose = on.server.close.bind(on.server);
  on.server.close = (callback) => serverClose((error) => setTimeout(() => callback(error), 250));
  const firstClose = on.close();
  const repeatedClose = on.close();
  assert.equal(firstClose, repeatedClose);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(onEnv.UNSEEN_BOOK_LAB_LOCK), true);
  await Promise.all([firstClose, repeatedClose]);
  assert.deepEqual(on.closeOrder, ["public-listener", "core-listener", "otp-timer", "book-runtime",
    "core-runtime", "operation-lock"]);
  assert.equal(existsSync(onEnv.UNSEEN_BOOK_LAB_LOCK), false);
  const restarted = await createBookLabDeployment({ env: onEnv });
  await restarted.close();
});

test("private AI requires Book, starts offline with pinned composition, and closes before both stores", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-deploy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const invalid = deploymentEnv(directory, false);
  invalid.UNSEEN_PRIVATE_AI_WORKER_ENABLED = "true";
  await assert.rejects(createBookLabDeployment({ env: invalid }), /private_ai_book_lab_required/u);

  const env = deploymentEnv(directory, true);
  const tokenHashFile = path.join(directory, "worker-token.sha256");
  writeFileSync(tokenHashFile, `${sha256("private-ai-deployment-token")}\n`, { mode: 0o600 });
  chmodSync(tokenHashFile, 0o600);
  Object.assign(env, {
    UNSEEN_PRIVATE_AI_WORKER_ENABLED: "true",
    UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE: tokenHashFile,
    UNSEEN_PRIVATE_AI_PROMPT_HASH: sha256("private-ai-deployment-prompt"),
    UNSEEN_PRIVATE_AI_POLICY_HASH: sha256("private-ai-deployment-policy"),
    UNSEEN_PRIVATE_AI_MODEL: "test-private-image-model",
    UNSEEN_PRIVATE_AI_MODEL_VERSION: "test-private-image-model-v1"
  });
  const deployment = await createBookLabDeployment({ env });
  const health = await (await fetch(`${deployment.origin}/__book-lab/healthz`)).json();
  assert.equal(health.providerConfigured, true);
  assert.equal(health.privateAiWorker, "offline");
  const unavailable = await fetch(`${deployment.origin}/v2-labs/memories/photos/not-present`);
  assert.equal(unavailable.headers.get("x-unseen-private-ai-worker"), "offline");
  assert.equal(deployment.api.privateAi.lease().job, null);
  assert.equal((await fetch(`${deployment.origin}/v2-labs/memories/photos/not-present`))
    .headers.get("x-unseen-private-ai-worker"), "online");
  assert.equal(deployment.status.privateAiWorker, true);
  await deployment.close();
  assert.deepEqual(deployment.closeOrder, ["public-listener", "core-listener", "otp-timer",
    "private-ai-composition", "book-runtime", "core-runtime", "operation-lock"]);
});

test("start failure, SIGTERM, and SIGINT release the operation lock and permit restart", async (t) => {
  const failureDirectory = mkdtempSync(path.join(os.tmpdir(), "unseen-8c-deploy-failure-"));
  const signalDirectory = mkdtempSync(path.join(os.tmpdir(), "unseen-8c-deploy-signal-"));
  t.after(() => rmSync(failureDirectory, { recursive: true, force: true }));
  t.after(() => rmSync(signalDirectory, { recursive: true, force: true }));
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const failureEnv = deploymentEnv(failureDirectory, true, String(occupied.address().port));
  await assert.rejects(createBookLabDeployment({ env: failureEnv }), /EADDRINUSE/u);
  assert.equal(existsSync(failureEnv.UNSEEN_BOOK_LAB_LOCK), false);
  await new Promise((resolve) => occupied.close(resolve));
  const recoveredAfterStartFailure = await createBookLabDeployment({ env: failureEnv });
  await recoveredAfterStartFailure.close();

  const signalEnv = deploymentEnv(signalDirectory, true);
  const entrypoint = path.resolve("infra/integration/book-lab/deployment-entrypoint.mjs");
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const child = spawn(process.execPath, [entrypoint], { cwd: path.resolve("."), env: signalEnv,
      stdio: ["ignore", "pipe", "pipe"] });
    const ready = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("deployment_ready_timeout")), 15_000);
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!output.includes("\n")) return;
        clearTimeout(timer);
        resolve(JSON.parse(output.split("\n", 1)[0]));
      });
    });
    assert.equal(ready.status, "UNSEEN_BOOK_DEPLOYMENT_READY");
    assert.equal(existsSync(signalEnv.UNSEEN_BOOK_LAB_LOCK), true);
    child.kill(signal);
    if (signal === "SIGTERM") child.kill("SIGINT");
    assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
    assert.equal(existsSync(signalEnv.UNSEEN_BOOK_LAB_LOCK), false);
  }
  const restarted = await createBookLabDeployment({ env: signalEnv });
  await restarted.close();
});
