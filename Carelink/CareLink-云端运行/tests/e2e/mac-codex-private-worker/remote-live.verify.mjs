import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { CodexSubscriptionRunner, createCodexPhotoAnalyzer, PHOTO_ANALYSIS_POLICY_HASH,
  PHOTO_ANALYSIS_PROMPT_HASH } from "../../../infra/integration/mac-codex-private-worker/codex-exec.mjs";
import { ExactHttpsClient } from "../../../infra/integration/mac-codex-private-worker/https-transport.mjs";
import { PRIVATE_AI_BASE, PRIVATE_AI_PROTOCOL, PrivateAiPullProtocol, RemotePrivateAiPullWorker } from
  "../../../infra/integration/mac-codex-private-worker/remote-pull.mjs";

if (process.env.UNSEEN_RUN_CODEX_SUBSCRIPTION_REMOTE_LIVE !== "1") {
  throw new Error("requires_UNSEEN_RUN_CODEX_SUBSCRIPTION_REMOTE_LIVE_1");
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
const projectPhoto = path.resolve(path.dirname(new URL(import.meta.url).pathname),
  "../../../apps/web/assets/photos/photo-1.jpg");
const image = await readFile(projectPhoto);
const token = "live_test_worker_token_0123456789abcdef";
const job = Object.freeze({ schema: "unseen-private-ai-job/1",
  jobId: "paij_11111111111111111111111111111111", leaseId: "pail_22222222222222222222222222222222",
  taskType: "photo_visible_facts_question_v1", attempt: 1, maxAttempts: 1,
  leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(), inputHash: hash("remote-live-input-v1"),
  mediaSha256: hash(image), mediaBytes: image.length, mediaMime: "image/jpeg",
  promptHash: PHOTO_ANALYSIS_PROMPT_HASH, policyHash: PHOTO_ANALYSIS_POLICY_HASH,
  imagePath: `${PRIVATE_AI_BASE}/jobs/paij_11111111111111111111111111111111/image` });
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "unseen-remote-live-"));
await chmod(temporaryRoot, 0o700);
let server;
try {
  const keyPath = path.join(temporaryRoot, "server.key.pem");
  const certPath = path.join(temporaryRoot, "server.cert.pem");
  const tokenPath = path.join(temporaryRoot, "worker.token");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out",
    certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
  { stdio: "ignore" });
  await writeFile(tokenPath, token, { mode: 0o600 });
  let terminal;
  let imageGets = 0;
  server = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) },
    async (request, response) => {
      const headers = { "cache-control": "no-store, private", "x-unseen-protocol": PRIVATE_AI_PROTOCOL };
      const json = (value) => response.writeHead(200, { ...headers, "content-type": "application/json" })
        .end(JSON.stringify(value));
      if (request.headers.authorization !== `Bearer ${token}` ||
        request.headers["x-unseen-protocol"] !== PRIVATE_AI_PROTOCOL) {
        response.writeHead(401, { ...headers, "content-type": "application/json" }).end("{}");
        return;
      }
      const body = await new Promise((resolve) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      if (request.url === `${PRIVATE_AI_BASE}/jobs/lease`) {
        return json({ schema: "unseen-private-ai-lease-response/1", job, retryAfterMs: 5_000 });
      }
      if (request.url === job.imagePath) {
        imageGets += 1;
        response.writeHead(200, { ...headers, "content-type": job.mediaMime,
          "content-length": String(image.length), etag: `"${job.mediaSha256}"`,
          "x-unseen-content-sha256": job.mediaSha256 }).end(image);
        return;
      }
      if (request.url?.endsWith("/complete")) {
        terminal = JSON.parse(body);
        return json({ schema: "unseen-private-ai-terminal-response/1", status: "completed", replayed: false,
          retryAfterMs: null });
      }
      response.writeHead(404, { ...headers, "content-type": "application/json" }).end("{}");
    });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  const client = new ExactHttpsClient({ origin: `https://localhost:${server.address().port}`,
    expectedHostname: "localhost", tokenPath, tokenUid: process.getuid(), timeoutMs: 15_000,
    tlsPolicy: { mode: "ca-file", caFile: certPath } });
  const runner = new CodexSubscriptionRunner({
    codexPath: "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    codexSha256: "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37",
    codexVersion: "codex-cli 0.147.0", codexUid: 501, codexGid: 80, codexMode: 0o755,
    model: "gpt-5.6-sol", timeoutMs: 90_000, preflightTimeoutMs: 15_000,
    imageProcessingTimeoutMs: 5_000, killGraceMs: 1_000, providerTimeoutMs: 130_000, leaseMs: 180_000,
    maximumPixels: 16_777_216 });
  const protocol = new PrivateAiPullProtocol({ client, promptHash: PHOTO_ANALYSIS_PROMPT_HASH,
    policyHash: PHOTO_ANALYSIS_POLICY_HASH, model: runner.model,
    modelVersion: "codex-cli 0.147.0/gpt-5.6-sol" });
  const worker = new RemotePrivateAiPullWorker({ protocol, preflight: (signal) => runner.preflight(signal),
    analyze: createCodexPhotoAnalyzer({ runner, modelVersion: "codex-cli 0.147.0/gpt-5.6-sol" }),
    minimumLeaseRemainingMs: 140_000, cleanupBudgetMs: 20_000 });
  const started = performance.now();
  const outcome = await worker.runOnce();
  if (outcome.status !== "completed" || imageGets !== 1 || terminal?.schema !==
    "unseen-private-ai-complete-request/1") throw new Error("remote_live_e2e_failed");
  const result = terminal.result;
  process.stdout.write(`${JSON.stringify({ evidenceClass: "PRIVATE_TEST_PROOF", productionEnabled: false,
    productionTransport: false, liveServerContacted: false, localTlsQueue: true, projectNonPrivateImage: true,
    resultPersisted: false, imagePersisted: false, authPersisted: false, imageGets,
    elapsedMs: Math.round(performance.now() - started), model: result.model, modelVersion: result.modelVersion,
    factCount: result.modelVisibleFacts.length, questionCharacters: result.question.length,
    questionMarks: (result.question.match(/[?？]/gu) ?? []).length, questionIntent: result.questionIntent,
    promptHash: PHOTO_ANALYSIS_PROMPT_HASH, policyHash: PHOTO_ANALYSIS_POLICY_HASH,
    outcome: outcome.status, releaseDecision: "PRIVATE_BETA_DEFAULT_OFF" }, null, 2)}\n`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
