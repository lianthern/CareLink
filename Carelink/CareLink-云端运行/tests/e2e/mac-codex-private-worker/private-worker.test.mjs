import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexExecError, CodexSubscriptionRunner, createCodexPhotoAnalyzer, createCodexQuestionProvider,
  PHOTO_ANALYSIS_POLICY_HASH, PHOTO_ANALYSIS_PROMPT_HASH } from
  "../../../infra/integration/mac-codex-private-worker/codex-exec.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const fakeCodex = path.join(here, "fake-codex.mjs");
const projectPhoto = path.resolve(here, "../../../apps/web/assets/photos/photo-1.jpg");
const TEST_EXECUTABLE = realpathSync(process.execPath);
const TEST_EXECUTABLE_STAT = statSync(TEST_EXECUTABLE);
const TEST_EXECUTABLE_HASH = createHash("sha256").update(readFileSync(TEST_EXECUTABLE)).digest("hex");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function metadataImage(directory) {
  const source = await readFile(projectPhoto);
  assert.equal(source.subarray(0, 2).toString("hex"), "ffd8");
  const payload = Buffer.from("Exif\0\0UNSEEN_PRIVATE_EXIF_GPS=27.4705,153.0260");
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  const bytes = Buffer.concat([source.subarray(0, 2), segment, source.subarray(2)]);
  const imagePath = path.join(directory, "private-source.jpg");
  await writeFile(imagePath, bytes, { mode: 0o600 });
  return { imagePath, contentHash: hash(bytes) };
}

function providerInput(contentHash, signal = new AbortController().signal) {
  return Object.freeze({ jobId: "test-job", attempt: 1, inputHash: hash("input"),
    idempotencyKey: hash("idempotency"), kind: "initial_question",
    visibleFacts: Object.freeze(["蓝色桌布上放着一张手写名字卡", "名字卡旁有一枚圆形徽章"]), userText: "",
    sourcePhotoId: "test-photo", photoContentHash: contentHash, modelVersion: "test-model-v1",
    promptHash: hash("prompt"), policyHash: hash("policy"), signal });
}

function resolution(input, imagePath, overrides = {}) {
  return { imagePath, authorization: { consentCurrent: true, inputHash: input.inputHash, l3Enabled: true,
    photoContentHash: input.photoContentHash, sourcePhotoId: input.sourcePhotoId, ...overrides } };
}

function runner(mode, overrides = {}) {
  const environment = { ...process.env };
  for (const key of ["OPENAI_API" + "_KEY", "SSH_AUTH" + "_SOCK", "TEST" + "_SECRET"]) {
    environment[key] = "synthetic-environment-fixture";
  }
  return new CodexSubscriptionRunner({ codexPath: TEST_EXECUTABLE, codexSha256: TEST_EXECUTABLE_HASH,
    codexVersion: process.version, codexUid: TEST_EXECUTABLE_STAT.uid, codexGid: TEST_EXECUTABLE_STAT.gid,
    codexMode: TEST_EXECUTABLE_STAT.mode & 0o777, model: "gpt-test", timeoutMs: 1_000,
    preflightTimeoutMs: 1_000, imageProcessingTimeoutMs: 2_000, killGraceMs: 100,
    providerTimeoutMs: 7_000, leaseMs: 7_000, environment, testOnly: true,
    testOnlyCommandPrefix: [fakeCodex, mode], ...overrides });
}

test("fixed runner strips metadata, binds current bytes and returns only strict DTO plus diagnostics", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-private-worker-test-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = await metadataImage(directory);
  const input = providerInput(image.contentHash);
  const result = await runner("good").run({ imageResolution: resolution(input, image.imagePath),
    providerInput: input });
  assert.deepEqual(result.dto, { intent: "recall_before_after", visibleFacts: [...input.visibleFacts] });
  assert.deepEqual(result.diagnostics.eventTypes,
    ["thread.started", "turn.started", "item.completed", "turn.completed"]);
  assert.deepEqual(result.diagnostics.itemTypes, ["agent_message"]);
  assert.equal(result.diagnostics.quotaRemaining, "UNKNOWN_NOT_EXPOSED");
  assert.deepEqual(result.diagnostics.runtime, { codexVersion: process.version,
    codexSha256: TEST_EXECUTABLE_HASH,
    eventTypes: ["thread.started", "turn.started", "item.completed", "turn.completed"],
    itemTypes: ["agent_message"] });
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /名字卡|OPENAI|synthetic-environment-fixture/u);
});

test("runtime identity, exact version and strict dry-run fail before the resolver can touch image bytes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-private-worker-preflight-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = path.join(directory, "codex-link");
  await symlink(TEST_EXECUTABLE, link);
  const input = providerInput(hash("not-read"));
  for (const [candidate, code] of [
    [runner("good", { codexSha256: hash("wrong-runtime") }), "codex_runtime_changed"],
    [runner("good", { codexPath: link }), "codex_runtime_changed"],
    [runner("good", { codexVersion: "v0.0.0-test-drift" }), "codex_runtime_changed"],
    [runner("preflight-tool"), "codex_tool_exposed"]
  ]) {
    let resolverCalls = 0;
    const provider = createCodexQuestionProvider({ runner: candidate, resolveImage() {
      resolverCalls += 1;
      throw new Error("resolver_must_not_run");
    } });
    await assert.rejects(provider(input), (error) => error.code === code);
    assert.equal(resolverCalls, 0);
  }
});

test("runner fails closed for source drift, authorization drift, malformed media, tools and DTOs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-private-worker-reject-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = await metadataImage(directory);
  const input = providerInput(image.contentHash);
  const expectCode = async (operation, code) => assert.rejects(operation,
    (error) => error instanceof CodexExecError && error.code === code);
  await expectCode(runner("good").run({ imageResolution: resolution(input, image.imagePath,
    { consentCurrent: false }), providerInput: input }), "image_authorization_changed");
  await expectCode(runner("good").run({ imageResolution: resolution({ ...input, photoContentHash: hash("wrong") },
    image.imagePath), providerInput: { ...input, photoContentHash: hash("wrong") } }), "image_source_changed");
  const bad = path.join(directory, "bad.jpg");
  await writeFile(bad, Buffer.alloc(32), { mode: 0o600 });
  const badInput = providerInput(hash(Buffer.alloc(32)));
  await expectCode(runner("good").run({ imageResolution: resolution(badInput, bad), providerInput: badInput }),
    "image_invalid");
  await expectCode(runner("good", { maximumImageBytes: 32 }).run({
    imageResolution: resolution(input, image.imagePath), providerInput: input }), "image_too_large");
  await expectCode(runner("tool").run({ imageResolution: resolution(input, image.imagePath),
    providerInput: input }), "codex_tool_exposed");
  await expectCode(runner("invalid-dto").run({ imageResolution: resolution(input, image.imagePath),
    providerInput: input }), "codex_dto_invalid");
});

test("runner enforces concurrency one, abort and bounded TERM to KILL", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-private-worker-timeout-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = await metadataImage(directory);
  const input = providerInput(image.contentHash);
  const timed = runner("timeout");
  const first = timed.run({ imageResolution: resolution(input, image.imagePath), providerInput: input });
  await assert.rejects(timed.run({ imageResolution: resolution(input, image.imagePath), providerInput: input }),
    (error) => error.code === "codex_worker_busy");
  await assert.rejects(first, (error) => error.code === "codex_timeout");

  const controller = new AbortController();
  const abortedInput = providerInput(image.contentHash, controller.signal);
  const operation = runner("timeout").run({ imageResolution: resolution(abortedInput, image.imagePath),
    providerInput: abortedInput });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(operation, (error) => error.code === "codex_aborted");
});

test("photo analyzer returns only strict private draft facts and one optional question", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-private-worker-analysis-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = await metadataImage(directory);
  const analyzer = createCodexPhotoAnalyzer({ runner: runner("good"), modelVersion: "test-cli/test-model-v1" });
  const job = { taskType: "photo_visible_facts_question_v1", mediaSha256: image.contentHash,
    promptHash: PHOTO_ANALYSIS_PROMPT_HASH, policyHash: PHOTO_ANALYSIS_POLICY_HASH };
  const result = await analyzer({ job, imagePath: image.imagePath, signal: new AbortController().signal });
  assert.deepEqual(result, { modelVisibleFacts: ["桌面上放着一张手写卡片"],
    question: "拍下照片时，这张卡片是谁放在这里的？", questionIntent: "photo_context",
    model: "gpt-test", modelVersion: "test-cli/test-model-v1", latencyMs: result.latencyMs });
  assert.ok(result.latencyMs >= 0 && result.latencyMs <= 300_000);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_EXIF_GPS|input_tokens|answerSha256/u);

  await assert.rejects(createCodexPhotoAnalyzer({ runner: runner("invalid-dto"),
    modelVersion: "test-cli/test-model-v1" })({ job, imagePath: image.imagePath,
    signal: new AbortController().signal }), (error) => error.code === "codex_dto_invalid");
  await assert.rejects(createCodexPhotoAnalyzer({ runner: runner("tool"),
    modelVersion: "test-cli/test-model-v1" })({ job, imagePath: image.imagePath,
    signal: new AbortController().signal }), (error) => error.code === "codex_tool_exposed");
  await assert.rejects(analyzer({ job: { ...job, promptHash: hash("wrong") }, imagePath: image.imagePath,
    signal: new AbortController().signal }), (error) => error.code === "provider_input_invalid");
});

test("photo analyzer consumes a v2 follow-up context instead of silently treating it as an initial question", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-private-worker-followup-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = await metadataImage(directory);
  const analyzer = createCodexPhotoAnalyzer({ runner: runner("followup-context"),
    modelVersion: "test-cli/test-model-v1" });
  const job = { schema: "unseen-private-ai-job/2", taskType: "photo_visible_facts_question_v1",
    mediaSha256: image.contentHash, promptHash: PHOTO_ANALYSIS_PROMPT_HASH,
    policyHash: PHOTO_ANALYSIS_POLICY_HASH, questionContext: {
      kind: "followup_question", followupOrdinal: 1, followupLimit: 3,
      priorVisibleFacts: ["桌面上放着一张手写名字卡"], priorQuestion: "上一轮问过的问题？",
      userAnswerText: "散场后我把名字卡夹进蓝色笔记本"
    } };
  const result = await analyzer({ job, imagePath: image.imagePath, signal: new AbortController().signal });
  assert.equal(result.questionIntent, "photo_context");
});
