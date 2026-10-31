import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BookLabIntegratedVisualShell,
  IntegratedBookLabShellError,
  buildIntegratedActionRequest,
  createIntegratedBookLabVisualShell,
  downloadIntegratedBookLabPdf,
  renderIntegratedBookLabPage
} from "../src/integrated-shell.mjs";
import { ACTION_REQUESTS } from "../src/integrated-transport.mjs";

const catalog = Object.freeze({ actions: Object.freeze(Object.fromEntries(Object.keys(ACTION_REQUESTS)
  .map((actionId) => [actionId, Object.freeze({ initial: `动作 ${actionId}` })]))) });

const routes = Object.freeze([
  ["BL01", "/labs/memories/photos/photo-01", { photoId: "photo-01" }, {
    photoId: "photo-01", eligibility: "eligible", collectionNotice: { version: "n1", hash: "a".repeat(64),
      plainLanguageCopy: "只依据可见事实" }, provenance: { photoContentHash: "b".repeat(64),
      placementSnapshotHash: "c".repeat(64), placementRevisionId: "placement-01" },
    interviewPrecondition: { branch: "absent", ifNoneMatch: "*", ifMatch: null }
  }],
  ["BL02", "/labs/memories/memory-01", { memoryId: "memory-01" }, {
    memory: { personalMemoryId: "memory-01", status: "draft", interviewVersion: 3,
      headSubmissionId: "submission-01", provenance: { photoContentHash: "b".repeat(64) } },
    submissions: [{ submissionId: "submission-01", submissionHash: "d".repeat(64), userText: "真实原话" }],
    recoverableQuestionJobs: [{ question: "你记得后来发生了什么？" }], followupLimit: 3
  }],
  ["BL03", "/labs/books/book-01/contributions/memory-01", { bookId: "book-01", memoryId: "memory-01" }, {
    memory: { personalMemoryId: "memory-01", status: "confirmed", interviewVersion: 4,
      headSubmissionId: "submission-01", memoryRevisionId: "revision-01", confirmedSubmissionHash: "d".repeat(64) },
    submissions: [{ submissionId: "submission-01", submissionHash: "d".repeat(64), userText: "真实原话" }],
    eligibleBooks: [{ bookId: "book-01", currentTitle: "共光以后", audienceScope: "current_live_space_viewers",
      noticeVersion: "grant-1", noticeHash: "e".repeat(64) }]
  }],
  ["BL04", "/manage/space-01/book-lab", { spaceId: "space-01" }, {
    spaceId: "space-01", books: [{ bookId: "book-01", title: "共光以后", status: "editing", pages: [] }]
  }],
  ["BL05", "/manage/space-01/book-lab/book-01/draft", { spaceId: "space-01", bookId: "book-01" }, {
    bookId: "book-01", spaceId: "space-01", title: "共光以后", status: "editing", draftVersionId: "draft-01",
    grantSetHash: "f".repeat(64), pages: [{ pageId: "page-01", index: 1, kind: "cover" }],
    recoverableRenderJobs: []
  }],
  ["BL06", "/s/space-01/books/book-01/versions/version-01",
    { spaceId: "space-01", bookId: "book-01", versionId: "version-01" }, {
      bookVersion: { versionId: "version-01", ordinal: 1, status: "available", pageCount: 12,
        manifestHash: "1".repeat(64) },
      htmlArtifact: { contentHash: "2".repeat(64), status: "available", pageCount: 12 },
      orderedPageIds: [], orderedSourceIds: [], orderedDisplayPhotoIds: []
    }]
]);

function response(body, extra = {}) {
  return { ok: true, status: 200, body, etag: '"etag-1"', unseenHeaders: {}, ...extra };
}

function view(entry, pathname, parameters, body, extra = {}) {
  return { entry, route: { entry, pathname, parameters }, response: response(body, extra) };
}

function contributionHeaders({ eligible = true, withdrawal = true, withdrawalGrantId = "grant-01" } = {}) {
  return {
    ...(eligible ? {
      "x-unseen-book-eligible-books": JSON.stringify([{ bookId: "book-01",
        audienceScope: "current_live_space_viewers", noticeVersion: "grant-1", noticeHash: "e".repeat(64), eligible: true }]),
      "x-unseen-book-authorization-etags": JSON.stringify({ "book-01": '"authorization-1"' })
    } : {}),
    ...(withdrawal ? { "x-unseen-book-withdrawal-etags": JSON.stringify({
      "book-01": { grantId: withdrawalGrantId, etag: '"withdrawal-1"' }
    }) } : {})
  };
}

function activeGrantBody() {
  return { ...structuredClone(routes[2][3]), grantReceipts: [{ grantId: "grant-01", bookId: "book-01",
    personalMemoryId: "memory-01", status: "active", version: 1 }] };
}

function root() {
  return {
    innerHTML: "",
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type) { this.listeners.delete(type); }
  };
}

test("integrated visual shell reads and renders all BL01-BL06 routes through the real controller boundary", async () => {
  const reads = [];
  const controller = {
    async readRoute(pathname) {
      reads.push(pathname);
      const item = routes.find(([, path]) => path === pathname);
      return view(item[0], item[1], item[2], item[3], item[0] === "BL03" ? {
        unseenHeaders: contributionHeaders({ withdrawal: false })
      } : {});
    },
    async rereadRoute() { return this.readRoute(reads.at(-1)); }
  };
  const target = root();
  const shell = new BookLabIntegratedVisualShell({ controller, catalog });
  for (const [, pathname] of routes) {
    await shell.mount(target, pathname);
    assert.match(target.innerHTML, /integrated-book-shell/u);
    assert.doesNotMatch(target.innerHTML, /undefined|null/u);
  }
  assert.deepEqual(reads, routes.map(([, pathname]) => pathname));
  await shell.reread();
  assert.equal(reads.at(-1), routes.at(-1)[1]);
  shell.destroy();
  assert.equal(target.listeners.size, 0);
});

test("BL01 derives question availability from the real provider capability without blocking skip", () => {
  const base = routes[0];
  const unavailable = view(base[0], base[1], base[2], { ...base[3], eligibility: "disabled" }, {
    unseenHeaders: { "x-unseen-question-provider": "unavailable" }
  });
  const unavailableHtml = renderIntegratedBookLabPage(unavailable, catalog);
  assert.match(unavailableHtml, /AI 暂时离线，照片已保存，稍后再问/u);
  assert.match(unavailableHtml, /data-book-action="MEMORY\.START_QUESTION" disabled/u);
  assert.doesNotMatch(unavailableHtml, /data-book-action="MEMORY\.SKIP" disabled/u);

  const notReady = view(base[0], base[1], base[2], { ...base[3], eligibility: "not_ready" }, {
    unseenHeaders: { "x-unseen-question-provider": "configured" }
  });
  const notReadyHtml = renderIntegratedBookLabPage(notReady, catalog);
  assert.doesNotMatch(notReadyHtml, /AI 暂时离线/u);
  assert.match(notReadyHtml, /暂时不能为这张照片生成问题；你仍可以跳过，照片不会受影响/u);
  assert.match(notReadyHtml, /data-book-action="MEMORY\.START_QUESTION" disabled/u);
  assert.doesNotMatch(notReadyHtml, /data-book-action="MEMORY\.SKIP" disabled/u);

  const ready = view(base[0], base[1], base[2], base[3], {
    unseenHeaders: { "x-unseen-question-provider": "configured", "x-unseen-private-ai-worker": "online" }
  });
  const readyHtml = renderIntegratedBookLabPage(ready, catalog);
  assert.doesNotMatch(readyHtml, /AI 暂时离线|暂时不能为这张照片生成问题/u);
  assert.doesNotMatch(readyHtml, /data-book-action="MEMORY\.START_QUESTION" disabled/u);

  const missingCapabilityHtml = renderIntegratedBookLabPage(view(base[0], base[1], base[2], base[3]), catalog);
  assert.match(missingCapabilityHtml, /暂时不能为这张照片生成问题/u);
  assert.match(missingCapabilityHtml, /data-book-action="MEMORY\.START_QUESTION" disabled/u);
});

// Informed-consent regression (security audit P1-4, 2026-08-17): the collection notice — the operator-supplied
// text served as body.collectionNotice.plainLanguageCopy (UNSEEN_BOOK_LAB_COLLECTION_NOTICE_COPY in
// production) — is the one place a contributor is told what happens before they trigger MEMORY.START_QUESTION.
// This pins three things the rendering layer must keep true regardless of what the notice copy itself says:
// (1) the notice text actually reaches the page, escaped, inside the privacy-note element; (2) it renders
// strictly before the trigger button in document order, not after or beside it; (3) a working, non-disabled
// decline path (MEMORY.SKIP) is always present alongside the trigger — so an operator who updates the copy to
// disclose the third-party AI service (see this change's delivery notes for the recommended production text
// and the noticeVersion/noticeHash rollout steps) can trust the page will actually surface it before the ask,
// with skip always available as the "no" path.
test("BL01 renders the collection notice copy, escaped, strictly before the trigger button, with skip always available", () => {
  const base = routes[0];
  const disclosureCopy = "纪念册（实验）收集须知：开始后，这张照片会发送给第三方 AI 服务（MiniMax）用于识别画面内容并生成问题" +
    "；继续聊时，系统会把上一问题、AI 记录的 1–2 条可见事实、你上一答的前 500 字和这张照片发送给当前配置的 AI 处理服务（可能由第三方提供），用来生成下一问题。" +
    "<script>alert(1)</script> 你的回答只用于生成这个空间的纪念册。";
  const withDisclosure = view(base[0], base[1], base[2], { ...base[3],
    collectionNotice: { ...base[3].collectionNotice, plainLanguageCopy: disclosureCopy } });
  const html = renderIntegratedBookLabPage(withDisclosure, catalog);

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u);
  assert.match(html, /第三方 AI 服务（MiniMax）用于识别画面内容并生成问题/u);
  assert.match(html, /上一答的前 500 字和这张照片发送给当前配置的 AI 处理服务/u);

  const noticeIndex = html.indexOf("privacy-note");
  const contextualDisclosureIndex = html.indexOf("上一答的前 500 字");
  const triggerIndex = html.indexOf('data-book-action="MEMORY.START_QUESTION"');
  const skipIndex = html.indexOf('data-book-action="MEMORY.SKIP"');
  assert.ok(noticeIndex >= 0, "privacy-note element must be present");
  assert.ok(triggerIndex > noticeIndex, "the trigger button must render after the notice, not before it");
  assert.ok(triggerIndex > contextualDisclosureIndex,
    "the contextual follow-up disclosure must render before the trigger button");
  assert.ok(skipIndex >= 0, "MEMORY.SKIP must be present as the decline path");
  assert.doesNotMatch(html, /data-book-action="MEMORY\.SKIP" disabled/u);
});

test("BL01 distinguishes private worker queue, offline retry and heartbeat fail-closed states", () => {
  const base = routes[0];
  const candidate = ({ worker, jobs = [], eligibility = "eligible" }) => view(base[0], base[1], base[2], {
    ...base[3], eligibility, recoverableQuestionJobs: jobs
  }, { unseenHeaders: { "x-unseen-question-provider": "configured",
    ...(worker === undefined ? {} : { "x-unseen-private-ai-worker": worker }) } });
  const job = (status, { error = null, delay = 250, question = null } = {}) => ({ status, question,
    recovery: { nextPollAfterMs: ["queued", "running"].includes(status) ? delay : null,
      lastStableError: error } });

  for (const status of ["queued", "running"]) {
    const pending = renderIntegratedBookLabPage(candidate({ worker: "online", jobs: [job(status)] }), catalog);
    assert.match(pending, /AI 正在准备问题，照片已保存；稍后会自动出现。/u);
    assert.match(pending, /data-book-action="MEMORY\.START_QUESTION" disabled/u);
    assert.doesNotMatch(pending, /data-book-action="MEMORY\.SKIP" disabled/u);
  }

  for (const offline of [
    candidate({ worker: "offline" }),
    candidate({ worker: "online", jobs: [job("running", { error: "model_unavailable" })] })
  ]) {
    const html = renderIntegratedBookLabPage(offline, catalog);
    assert.match(html, /AI 暂时离线，照片已保存，稍后再问/u);
  }
  assert.doesNotMatch(renderIntegratedBookLabPage(candidate({ worker: "offline" }), catalog),
    /data-book-action="MEMORY\.START_QUESTION" disabled/u);

  for (const worker of ["disabled", "unknown", undefined]) {
    for (const jobs of [[], [job("queued", { error: "model_unavailable" })]]) {
      const html = renderIntegratedBookLabPage(candidate({ worker, jobs }), catalog);
      assert.match(html, /暂时不能为这张照片生成问题；你仍可以跳过，照片不会受影响/u);
      assert.doesNotMatch(html, /AI 暂时离线/u);
      assert.match(html, /data-book-action="MEMORY\.START_QUESTION" disabled/u);
    }
  }
  const noneligible = renderIntegratedBookLabPage(candidate({ worker: "offline", eligibility: "not_ready" }), catalog);
  assert.match(noneligible, /暂时不能为这张照片生成问题；你仍可以跳过，照片不会受影响/u);
  assert.doesNotMatch(noneligible, /AI 暂时离线/u);

  const ready = renderIntegratedBookLabPage(candidate({ worker: "online",
    jobs: [job("ready", { question: "照片里那张卡片是谁写的？" })] }), catalog);
  assert.match(ready, /照片里那张卡片是谁写的？/u);
  assert.doesNotMatch(ready, /AI 正在准备问题|AI 暂时离线/u);
});

test("BL01 offline admission keeps the existing START mutation path available", async () => {
  const base = routes[0];
  const offline = view(base[0], base[1], base[2], { ...base[3], recoverableQuestionJobs: [] }, {
    unseenHeaders: { "x-unseen-question-provider": "configured", "x-unseen-private-ai-worker": "offline" }
  });
  const queued = view(base[0], base[1], base[2], { ...base[3], recoverableQuestionJobs: [{ status: "queued",
    question: null, recovery: { nextPollAfterMs: 1_000, lastStableError: "model_unavailable" } }] }, {
    unseenHeaders: { "x-unseen-question-provider": "configured", "x-unseen-private-ai-worker": "offline" }
  });
  const calls = [];
  const controller = {
    async readRoute() { return offline; },
    async mutate(actionId, request) { calls.push({ actionId, request }); return response({ accepted: true }); },
    async rereadRoute() { return queued; }
  };
  const trigger = { dataset: { bookAction: "MEMORY.START_QUESTION" }, disabled: false,
    closest(selector) { return selector === "[data-book-action]" ? this : null; } };
  const target = { ...root(), contains(node) { return node === trigger; }, querySelectorAll() { return []; },
    setAttribute() {}, removeAttribute() {} };
  const timers = [];
  const shell = new BookLabIntegratedVisualShell({ controller, catalog, randomId: () => "offline-start",
    setTimeoutImpl(callback, delay) { const handle = { callback, delay }; timers.push(handle); return handle; },
    clearTimeoutImpl() {} });
  await shell.mount(target, base[1]);
  assert.doesNotMatch(target.innerHTML, /data-book-action="MEMORY\.START_QUESTION" disabled/u);
  await shell.handleClick({ target: trigger });
  assert.deepEqual(calls, [{ actionId: "MEMORY.START_QUESTION", request: {
    parameters: { photoId: "photo-01" }, idempotencyKey: "offline-start", dto: {
      noticeVersion: "n1", noticeHash: "a".repeat(64), photoContentHash: "b".repeat(64),
      placementSnapshotHash: "c".repeat(64)
    },
    etag: undefined, ifNoneMatch: "*"
  } }]);
  assert.match(target.innerHTML, /AI 暂时离线，照片已保存，稍后再问/u);
  assert.equal(timers[0].delay, 1_000);
  shell.destroy();
});

test("BL01 polling clamps server delay, stops on ready, and clears on route change or destroy", async () => {
  const base = routes[0];
  const queued = (delay) => view(base[0], base[1], base[2], { ...base[3], recoverableQuestionJobs: [{
    status: "queued", question: null, recovery: { nextPollAfterMs: delay, lastStableError: null }
  }] }, { unseenHeaders: { "x-unseen-question-provider": "configured",
    "x-unseen-private-ai-worker": "online" } });
  const ready = view(base[0], base[1], base[2], { ...base[3], recoverableQuestionJobs: [{
    status: "ready", question: "照片里的灯是什么时候点亮的？",
    recovery: { nextPollAfterMs: null, lastStableError: null }
  }] }, { unseenHeaders: { "x-unseen-question-provider": "configured",
    "x-unseen-private-ai-worker": "online" } });
  let current = queued(50);
  const controller = {
    async readRoute(pathname) { return pathname === base[1] ? current : view(...routes[1]); },
    async rereadRoute() { return current; }
  };
  const scheduled = [];
  const cleared = [];
  const shell = new BookLabIntegratedVisualShell({ controller, catalog,
    setTimeoutImpl(callback, delay) { const handle = { callback, delay }; scheduled.push(handle); return handle; },
    clearTimeoutImpl(handle) { cleared.push(handle); } });
  const target = root();
  await shell.mount(target, base[1]);
  assert.equal(scheduled[0].delay, 1_000);
  current = ready;
  await scheduled[0].callback();
  assert.match(target.innerHTML, /照片里的灯是什么时候点亮的？/u);
  assert.equal(scheduled.length, 1);

  current = queued(999_999);
  await shell.read(base[1]);
  assert.equal(scheduled.at(-1).delay, 30_000);
  const routeTimer = scheduled.at(-1);
  await shell.read(routes[1][1]);
  assert.ok(cleared.includes(routeTimer));

  current = queued(2_000);
  await shell.read(base[1]);
  const destroyTimer = scheduled.at(-1);
  shell.destroy();
  assert.ok(cleared.includes(destroyTimer));
});

test("BL02 shows a waiting state for a pending follow-up job, disables re-request/save, and clears once ready", () => {
  const base = routes[1];
  const pending = view(base[0], base[1], base[2], { ...base[3],
    memory: { ...base[3].memory, status: "followup_queued" }, recoverableQuestionJobs: [
    { question: "你记得后来发生了什么？" },
    { followupOrdinal: 1, status: "queued", question: null,
      recovery: { nextPollAfterMs: 1_500, lastStableError: null } }
  ] });
  const html = renderIntegratedBookLabPage(pending, catalog);
  assert.match(html, /AI 正在看照片准备追问；这次回答已经保存，稍后会自动出现。/u);
  assert.match(html, /data-book-action="MEMORY\.SAVE_ANSWER_DRAFT" disabled/u);
  assert.match(html, /data-book-action="MEMORY\.REQUEST_FOLLOWUP" disabled/u);
  assert.doesNotMatch(html, /data-book-action="MEMORY\.CONFIRM" disabled/u);
  assert.doesNotMatch(html, /data-book-action="MEMORY\.WITHDRAW" disabled/u);

  const running = view(base[0], base[1], base[2], { ...base[3],
    memory: { ...base[3].memory, status: "followup_queued" }, recoverableQuestionJobs: [
    { question: "你记得后来发生了什么？" },
    { followupOrdinal: 1, status: "running", question: null,
      recovery: { nextPollAfterMs: 800, lastStableError: null } }
  ] });
  assert.match(renderIntegratedBookLabPage(running, catalog),
    /AI 正在看照片准备追问；这次回答已经保存，稍后会自动出现。/u);

  const ready = view(base[0], base[1], base[2], { ...base[3],
    memory: { ...base[3].memory, status: "followup_ready" }, recoverableQuestionJobs: [
    { question: "你记得后来发生了什么？" },
    { followupOrdinal: 1, status: "ready", question: "灯亮起来的时候你在做什么？",
      recovery: { nextPollAfterMs: null, lastStableError: null } }
  ] });
  const readyHtml = renderIntegratedBookLabPage(ready, catalog);
  assert.doesNotMatch(readyHtml, /AI 正在看照片准备追问|上一次追问没能生成/u);
  assert.doesNotMatch(readyHtml, /data-book-action="MEMORY\.SAVE_ANSWER_DRAFT" disabled/u);
  assert.match(readyHtml, /data-book-action="MEMORY\.REQUEST_FOLLOWUP"[^>]*disabled/u);
  assert.match(readyHtml, /<textarea[^>]*><\/textarea>/u);
  assert.match(readyHtml, /灯亮起来的时候你在做什么？/u);
});

test("BL02 obeys the server follow-up limit and disables a fourth round", () => {
  const base = routes[1];
  const limited = view(base[0], base[1], base[2], { ...base[3], followupLimit: 2,
    memory: { ...base[3].memory, status: "draft" }, recoverableQuestionJobs: [
      { status: "ready", question: "你记得后来发生了什么？" },
      { followupOrdinal: 1, status: "ready", question: "灯亮起来的时候你在做什么？" },
      { followupOrdinal: 2, status: "ready", question: "灯熄灭后，桌边还留下了什么？" }
    ] });
  const html = renderIntegratedBookLabPage(limited, catalog);
  assert.match(html, /最多继续 2 轮/u);
  assert.match(html, /已经聊完 2 轮追问/u);
  assert.match(html, /data-book-action="MEMORY\.REQUEST_FOLLOWUP"[^>]*disabled/u);
  assert.match(html, /3 个问题/u);
});

test("BL02 discloses the bounded answer transfer before every continue action", () => {
  const base = routes[1];
  const html = renderIntegratedBookLabPage(view(base[0], base[1], base[2], base[3]), catalog);
  const disclosure = html.indexOf("点“继续聊”会发送");
  const thirdParty = html.indexOf("该服务可能由第三方提供");
  const request = html.indexOf('data-book-action="MEMORY.REQUEST_FOLLOWUP"');
  assert.ok(disclosure >= 0 && thirdParty > disclosure);
  assert.ok(request > thirdParty, "the answer-transfer disclosure must precede the follow-up action");
  assert.match(html, /上一答的前 500 字/u);
});

test("BL02 offers an honest retry message after a stable follow-up failure without disabling the retry action", () => {
  const base = routes[1];
  const failed = view(base[0], base[1], base[2], { ...base[3], recoverableQuestionJobs: [
    { question: "你记得后来发生了什么？" },
    { followupOrdinal: 1, status: "failed", question: null,
      recovery: { nextPollAfterMs: null, lastStableError: "model_unavailable" } }
  ] });
  const html = renderIntegratedBookLabPage(failed, catalog);
  assert.match(html, /上一次追问没能生成；可以再试一次，也可以先确认这次的原话。/u);
  assert.doesNotMatch(html, /data-book-action="MEMORY\.REQUEST_FOLLOWUP" disabled/u);
  assert.doesNotMatch(html, /data-book-action="MEMORY\.SAVE_ANSWER_DRAFT" disabled/u);

  const cancelledIsNotAFailure = view(base[0], base[1], base[2], { ...base[3], recoverableQuestionJobs: [
    { question: "你记得后来发生了什么？" },
    { followupOrdinal: 1, status: "cancelled", question: null,
      recovery: { nextPollAfterMs: null, lastStableError: null } }
  ] });
  assert.doesNotMatch(renderIntegratedBookLabPage(cancelledIsNotAFailure, catalog),
    /AI 正在看照片准备追问|上一次追问没能生成/u);
});

test("BL02 follow-up poll timer schedules, clamps, stops on ready, and clears on route change or destroy", async () => {
  const base = routes[1];
  const queued = (delay) => view(base[0], base[1], base[2], { ...base[3], recoverableQuestionJobs: [
    { followupOrdinal: 1, status: "queued", question: null, recovery: { nextPollAfterMs: delay, lastStableError: null } }
  ] });
  const ready = view(base[0], base[1], base[2], { ...base[3], recoverableQuestionJobs: [
    { followupOrdinal: 1, status: "ready", question: "灯亮起来的时候你在做什么？",
      recovery: { nextPollAfterMs: null, lastStableError: null } }
  ] });
  let current = queued(999_999);
  const controller = {
    async readRoute(pathname) { return pathname === base[1] ? current : view(...routes[0]); },
    async rereadRoute() { return current; }
  };
  const scheduled = [];
  const cleared = [];
  const shell = new BookLabIntegratedVisualShell({ controller, catalog,
    setTimeoutImpl(callback, delay) { const handle = { callback, delay }; scheduled.push(handle); return handle; },
    clearTimeoutImpl(handle) { cleared.push(handle); } });
  const target = root();
  await shell.mount(target, base[1]);
  assert.equal(scheduled[0].delay, 30_000);
  current = ready;
  await scheduled[0].callback();
  assert.match(target.innerHTML, /灯亮起来的时候你在做什么？/u);
  assert.equal(scheduled.length, 1);

  current = queued(500);
  await shell.read(base[1]);
  const routeTimer = scheduled.at(-1);
  await shell.read(routes[0][1]);
  assert.ok(cleared.includes(routeTimer));

  current = queued(500);
  await shell.read(base[1]);
  const destroyTimer = scheduled.at(-1);
  shell.destroy();
  assert.ok(cleared.includes(destroyTimer));
});

test("all 20 actions dispatch through controller with exact mutation conditionals unchanged", async () => {
  const calls = [];
  const controller = {
    async readAction(actionId, options) { calls.push({ kind: "read", actionId, options }); return response({ actionId }); },
    async mutate(actionId, options) { calls.push({ kind: "mutation", actionId, options }); return response({ actionId }); },
    async readRoute() { throw new Error("not used"); },
    async rereadRoute() { throw new Error("not used"); }
  };
  const shell = new BookLabIntegratedVisualShell({ controller, catalog });
  for (const [actionId, contract] of Object.entries(ACTION_REQUESTS)) {
    const options = contract.mutation ? {
      parameters: { photoId: "photo-01", memoryId: "memory-01", personalMemoryId: "memory-01", bookId: "book-01",
        spaceId: "space-01", versionId: "version-01", pageId: "page-01" },
      dto: { exact: actionId }, idempotencyKey: `key-${actionId}`,
      ...(["if-match", "exclusive_either", "both"].includes(contract.precondition) ? { etag: '"etag"' } : {}),
      ...(["if-none-match", "both"].includes(contract.precondition) ? { ifNoneMatch: "*" } : {})
    } : { parameters: { photoId: "photo-01", bookId: "book-01", spaceId: "space-01", versionId: "version-01" } };
    await shell.dispatch(actionId, options);
  }
  assert.equal(calls.length, 20);
  for (const [index, [actionId, contract]] of Object.entries(ACTION_REQUESTS).entries()) {
    assert.equal(calls[index].actionId, actionId);
    assert.equal(calls[index].kind, contract.mutation ? "mutation" : "read");
    if (contract.mutation) {
      assert.equal(calls[index].options.idempotencyKey, `key-${actionId}`);
      assert.equal(calls[index].options.etag !== undefined,
        ["if-match", "exclusive_either", "both"].includes(contract.precondition));
      assert.equal(calls[index].options.ifNoneMatch !== undefined,
        ["if-none-match", "both"].includes(contract.precondition));
    }
  }
});

test("successful create/start/open/freeze actions navigate into the next real Book Lab route", async () => {
  const freezeHeaders = { "x-unseen-book-owner-preconditions": JSON.stringify({
    freeze: { draftVersionId: "draft-01", previewHash: "3".repeat(64), grantSetHash: "4".repeat(64),
      authorizationSnapshotHash: "5".repeat(64) }
  }) };
  const cases = [
    {
      actionId: "MEMORY.START_QUESTION",
      current: view(...routes[0]),
      fields: [],
      result: response({ personalMemoryId: "memory-new" }),
      destination: "/labs/memories/memory-new"
    },
    {
      actionId: "BOOK.CREATE",
      current: view(...routes[3]),
      fields: [{ dataset: { bookField: "newBookId" }, value: "book-new" },
        { dataset: { bookField: "title" }, value: "新书名" }],
      result: response({ bookId: "book-new" }),
      destination: "/manage/space-01/book-lab/book-new/draft"
    },
    {
      actionId: "BOOK.OPEN_DRAFT",
      current: view(...routes[3]),
      fields: [{ dataset: { bookField: "bookId" }, value: "book-01" }],
      result: response(routes[4][3]),
      destination: "/manage/space-01/book-lab/book-01/draft"
    },
    {
      actionId: "BOOK.FREEZE",
      current: view(routes[4][0], routes[4][1], routes[4][2], routes[4][3], { unseenHeaders: freezeHeaders }),
      fields: [],
      result: response({ versionId: "version-new" }),
      destination: "/s/space-01/books/book-01/versions/version-new"
    }
  ];

  for (const candidate of cases) {
    const navigations = [];
    let rereads = 0;
    const controller = {
      async readRoute() { return candidate.current; },
      async rereadRoute() { rereads += 1; return candidate.current; },
      async mutate() { return candidate.result; },
      async readAction() { return candidate.result; }
    };
    const trigger = { dataset: { bookAction: candidate.actionId }, disabled: false,
      closest(selector) { return selector === "[data-book-action]" ? this : null; } };
    const target = { ...root(), contains(node) { return node === trigger; },
      querySelectorAll() { return candidate.fields; }, setAttribute() {}, removeAttribute() {} };
    const shell = new BookLabIntegratedVisualShell({ controller, catalog, randomId: () => "next-route-id",
      navigate(pathname) { navigations.push(pathname); } });
    await shell.mount(target, candidate.current.route.pathname);
    await shell.handleClick({ target: trigger });
    assert.deepEqual(navigations, [candidate.destination], candidate.actionId);
    assert.equal(rereads, 0, candidate.actionId);
    shell.destroy();
  }
});

test("default action builder preserves absent/present and both-precondition shapes without guessing missing API projections", () => {
  let id = 0;
  const randomId = () => `client-${++id}`;
  const absent = view(...routes[0]);
  assert.deepEqual(buildIntegratedActionRequest("MEMORY.SKIP", absent, {}, randomId), {
    parameters: { photoId: "photo-01" }, idempotencyKey: "client-1", dto: {}, etag: undefined, ifNoneMatch: "*"
  });
  const presentBody = { ...routes[0][3], interviewPrecondition: { branch: "present", ifMatch: "interview-2", ifNoneMatch: null } };
  assert.equal(buildIntegratedActionRequest("MEMORY.START_QUESTION", view(routes[0][0], routes[0][1], routes[0][2], presentBody), {}, randomId).etag, "interview-2");

  const draft = view(...routes[4]);
  const preview = buildIntegratedActionRequest("BOOK.GENERATE_PREVIEW", draft, {}, randomId);
  assert.equal(preview.etag, '"etag-1"');
  assert.equal(preview.ifNoneMatch, "*");
  assert.throws(() => buildIntegratedActionRequest("BOOK.FREEZE", draft, {}, randomId),
    (error) => error instanceof IntegratedBookLabShellError && error.code === "integrated_input_unavailable");
  assert.throws(() => buildIntegratedActionRequest("BOOK.START_NEW_VERSION", draft, {}, randomId),
    (error) => error instanceof IntegratedBookLabShellError && error.code === "integrated_input_unavailable");

  const ownerPreconditions = { "x-unseen-book-owner-preconditions": JSON.stringify({
    freeze: { draftVersionId: "draft-01", previewHash: "3".repeat(64), grantSetHash: "4".repeat(64),
      authorizationSnapshotHash: "5".repeat(64) },
    startNewVersion: { fromVersionId: "version-01", accessControlVersion: 1, accessControlStatus: "active" }
  }) };
  const prepared = view(routes[4][0], routes[4][1], routes[4][2], routes[4][3], {
    unseenHeaders: ownerPreconditions
  });
  assert.deepEqual(buildIntegratedActionRequest("BOOK.FREEZE", prepared, {}, randomId).dto, {
    draftVersionId: "draft-01", previewHash: "3".repeat(64), grantSetHash: "4".repeat(64),
    authorizationSnapshotHash: "5".repeat(64)
  });
  assert.deepEqual(buildIntegratedActionRequest("BOOK.START_NEW_VERSION", prepared, {}, randomId).dto, {
    draftVersionId: "client-9", fromVersionId: "version-01", excludeWithdrawn: true
  });
  const validFrozen = view(routes[4][0], routes[4][1], routes[4][2], { ...routes[4][3], status: "frozen" }, {
    unseenHeaders: ownerPreconditions
  });
  const validFrozenHtml = renderIntegratedBookLabPage(validFrozen, catalog);
  assert.doesNotMatch(validFrozenHtml, /data-book-action="BOOK\.START_NEW_VERSION" disabled/u);
  assert.match(validFrozenHtml, /data-book-action="BOOK\.GENERATE_PREVIEW" disabled/u);
  for (const accessControlStatus of ["active", "affected", "revoked"]) {
    const startNewVersion = { fromVersionId: `version-${accessControlStatus}`,
      accessControlVersion: 2, accessControlStatus };
    const candidate = view(routes[4][0], routes[4][1], routes[4][2],
      { ...routes[4][3], status: "frozen" }, { unseenHeaders: {
        "x-unseen-book-owner-preconditions": JSON.stringify({ startNewVersion })
      } });
    const ids = [`${accessControlStatus}-idempotency`, `${accessControlStatus}-draft`];
    assert.deepEqual(buildIntegratedActionRequest("BOOK.START_NEW_VERSION", candidate, {}, () => ids.shift()), {
      parameters: { spaceId: "space-01", bookId: "book-01" },
      idempotencyKey: `${accessControlStatus}-idempotency`,
      dto: { draftVersionId: `${accessControlStatus}-draft`,
        fromVersionId: `version-${accessControlStatus}`, excludeWithdrawn: true },
      etag: '"etag-1"', ifNoneMatch: "*"
    });
    assert.doesNotMatch(renderIntegratedBookLabPage(candidate, catalog),
      /data-book-action="BOOK\.START_NEW_VERSION" disabled/u);
  }
  for (const startNewVersion of [
    { accessControlVersion: 2, accessControlStatus: "active" },
    { fromVersionId: "", accessControlVersion: 2, accessControlStatus: "active" },
    { fromVersionId: "version-01", accessControlStatus: "active" },
    { fromVersionId: "version-01", accessControlVersion: 0, accessControlStatus: "active" },
    { fromVersionId: "version-01", accessControlVersion: "1", accessControlStatus: "active" },
    { fromVersionId: "version-01", accessControlVersion: Number.NaN, accessControlStatus: "active" },
    { fromVersionId: "version-01", accessControlVersion: 2 },
    { fromVersionId: "version-01", accessControlVersion: 2, accessControlStatus: "Affected" },
    { fromVersionId: "version-01", accessControlVersion: 2, accessControlStatus: "withdrawal_affected" }
  ]) {
    const invalid = view(routes[4][0], routes[4][1], routes[4][2], { ...routes[4][3], status: "frozen" }, {
      unseenHeaders: { "x-unseen-book-owner-preconditions": JSON.stringify({ startNewVersion }) }
    });
    assert.throws(() => buildIntegratedActionRequest("BOOK.START_NEW_VERSION", invalid, {}, randomId),
      (error) => error instanceof IntegratedBookLabShellError && error.code === "integrated_input_unavailable");
    const invalidHtml = renderIntegratedBookLabPage(invalid, catalog);
    assert.match(invalidHtml, /data-book-action="BOOK\.START_NEW_VERSION" disabled/u);
    assert.match(invalidHtml, /data-book-action="BOOK\.GENERATE_PREVIEW" disabled/u);
  }
});

test("BL04 create binds Event to the exact route Space and rejects conflicting server projections", () => {
  const candidate = view(...routes[3]);
  assert.deepEqual(buildIntegratedActionRequest("BOOK.CREATE", candidate, {
    newBookId: "book-new", title: "我们的故事", eventId: "attacker-event"
  }, () => "create-key"), {
    parameters: { spaceId: "space-01", bookId: "book-new" },
    idempotencyKey: "create-key",
    dto: { bookId: "book-new", title: "我们的故事", eventId: "space-01" },
    ifNoneMatch: "*"
  });

  const html = renderIntegratedBookLabPage(candidate, catalog);
  assert.match(html, /事件：<strong>当前记忆空间<\/strong>/u);
  assert.doesNotMatch(html, /事件 ID|data-book-field="eventId"/u);

  const wrong = [
    view(routes[3][0], routes[3][1], {}, routes[3][3]),
    { ...candidate, response: { ...candidate.response, ok: false } },
    view(routes[4][0], routes[4][1], routes[4][2], routes[4][3]),
    view(routes[3][0], routes[3][1], { spaceId: "space-01", eventId: "attacker-event" }, routes[3][3]),
    view(routes[3][0], routes[3][1], { spaceId: "space-01" }, { ...routes[3][3], spaceId: "space-02" }),
    view(routes[3][0], routes[3][1], { spaceId: "space-01" }, { ...routes[3][3], books: [
      { ...routes[3][3].books[0], spaceId: "space-02" }
    ] })
  ];
  for (const invalid of wrong) {
    assert.throws(() => buildIntegratedActionRequest("BOOK.CREATE", invalid, {
      newBookId: "book-new", title: "我们的故事", eventId: "space-01"
    }, () => "unused"),
    (error) => error instanceof IntegratedBookLabShellError && error.code === "integrated_input_unavailable");
  }
});

test("BL05 start-new-version fails closed before mutation for malformed, wrong-header, and wrong-book views", async () => {
  const valid = { fromVersionId: "version-01", accessControlVersion: 2, accessControlStatus: "affected" };
  const candidates = [
    view(routes[4][0], routes[4][1], routes[4][2], { ...routes[4][3], status: "frozen" }, {
      unseenHeaders: { "x-unseen-book-owner-preconditions": "{" }
    }),
    view(routes[4][0], routes[4][1], routes[4][2], { ...routes[4][3], status: "frozen" }, {
      unseenHeaders: { "X-Unseen-Book-Owner-Preconditions": JSON.stringify({ startNewVersion: valid }) }
    }),
    view(routes[4][0], routes[4][1], routes[4][2],
      { ...routes[4][3], bookId: "book-02", status: "frozen" }, {
        unseenHeaders: { "x-unseen-book-owner-preconditions": JSON.stringify({ startNewVersion: valid }) }
      }),
    view(routes[4][0], routes[4][1], { spaceId: "space-01", bookId: "book-02" },
      { ...routes[4][3], status: "frozen" }, {
        unseenHeaders: { "x-unseen-book-owner-preconditions": JSON.stringify({ startNewVersion: valid }) }
      })
  ];
  for (const candidate of candidates) {
    let mutations = 0;
    const controller = {
      async readRoute() { return candidate; },
      async readAction() { throw new Error("not used"); },
      async mutate() { mutations += 1; throw new Error("mutation_must_not_run"); },
      async rereadRoute() { throw new Error("reread_must_not_run"); }
    };
    const target = { ...root(), contains: () => true, querySelectorAll: () => [],
      setAttribute() {}, removeAttribute() {} };
    const shell = new BookLabIntegratedVisualShell({ controller, catalog });
    await shell.mount(target, candidate.route.pathname);
    assert.match(target.innerHTML, /data-book-action="BOOK\.START_NEW_VERSION" disabled/u);
    assert.throws(() => buildIntegratedActionRequest("BOOK.START_NEW_VERSION", candidate, {}, () => "unused"),
      (error) => error instanceof IntegratedBookLabShellError && error.code === "integrated_input_unavailable");
    const trigger = { dataset: { bookAction: "BOOK.START_NEW_VERSION" }, disabled: true };
    await shell.handleClick({ target: { closest: (selector) => selector === "[data-book-action]" ? trigger : null } });
    assert.equal(mutations, 0);
    assert.equal(shell.view.response.body.error.code, "integrated_input_unavailable");
  }
});

test("BL03 binds authorize and pre-existing-grant withdrawal to exact route book server projections", () => {
  const authorizable = view(routes[2][0], routes[2][1], routes[2][2], routes[2][3], {
    unseenHeaders: contributionHeaders({ withdrawal: false })
  });
  const authorize = buildIntegratedActionRequest("BOOK_MEMORY.AUTHORIZE", authorizable, {
    bookId: "wrong-book", creditLabel: "署名", consent: true
  }, () => "authorize-key");
  assert.equal(authorize.parameters.bookId, "book-01");
  assert.equal(authorize.etag, '"authorization-1"');
  assert.equal(authorize.dto.audienceScope, "current_live_space_viewers");

  const active = view(routes[2][0], routes[2][1], routes[2][2], activeGrantBody(), {
    unseenHeaders: contributionHeaders({ eligible: false })
  });
  const withdrawal = buildIntegratedActionRequest("BOOK_MEMORY.WITHDRAW", active, {
    bookId: "wrong-book", ifMatch: '"user-controlled"'
  }, () => "withdraw-key");
  assert.deepEqual(withdrawal, {
    parameters: { bookId: "book-01", memoryId: "memory-01", personalMemoryId: "memory-01" },
    idempotencyKey: "withdraw-key", dto: {}, etag: '"withdrawal-1"'
  });
  const html = renderIntegratedBookLabPage(active, catalog);
  assert.match(html, /data-book-action="BOOK_MEMORY\.AUTHORIZE" disabled/u);
  assert.doesNotMatch(html, /data-book-action="BOOK_MEMORY\.WITHDRAW" disabled/u);
});

test("authorize mutation refreshes BL03 before withdrawal and never reuses its singular response ETag", async () => {
  const initial = view(routes[2][0], routes[2][1], routes[2][2], routes[2][3], {
    unseenHeaders: contributionHeaders({ withdrawal: false })
  });
  const reread = view(routes[2][0], routes[2][1], routes[2][2], activeGrantBody(), {
    unseenHeaders: contributionHeaders({ eligible: false })
  });
  const calls = [];
  const controller = {
    async readRoute() { return initial; },
    async readAction() { throw new Error("not used"); },
    async mutate(actionId, request) {
      calls.push({ actionId, request });
      return response({}, { unseenHeaders: { "x-unseen-grant-etag": '"discarded-mutation-etag"' } });
    },
    async rereadRoute() { calls.push({ actionId: "REREAD" }); return reread; }
  };
  const shell = new BookLabIntegratedVisualShell({ controller, catalog });
  await shell.mount(root(), routes[2][1]);
  const authorize = buildIntegratedActionRequest("BOOK_MEMORY.AUTHORIZE", shell.view,
    { creditLabel: "署名", consent: true }, () => "authorize-key");
  await shell.dispatch("BOOK_MEMORY.AUTHORIZE", authorize, { refresh: true });
  const withdrawal = buildIntegratedActionRequest("BOOK_MEMORY.WITHDRAW", shell.view, {}, () => "withdraw-key");
  assert.equal(withdrawal.etag, '"withdrawal-1"');
  assert.notEqual(withdrawal.etag, '"discarded-mutation-etag"');
  assert.deepEqual(calls.map(({ actionId }) => actionId), ["BOOK_MEMORY.AUTHORIZE", "REREAD"]);
});

test("BL03 fails closed before fetch for absent, malformed, wrong-book, and wrong-grant projections", async () => {
  async function assertClickDoesNotMutate(candidate, actionId) {
    let mutations = 0;
    const controller = {
      async readRoute() { return candidate; },
      async readAction() { throw new Error("not used"); },
      async mutate() { mutations += 1; throw new Error("mutation_must_not_run"); },
      async rereadRoute() { throw new Error("reread_must_not_run"); }
    };
    const fields = actionId === "BOOK_MEMORY.AUTHORIZE" ? [
      { type: "select-one", dataset: { bookField: "bookId" }, value: "book-01" },
      { type: "text", dataset: { bookField: "creditLabel" }, value: "署名" },
      { type: "checkbox", dataset: { bookField: "consent" }, checked: true }
    ] : [];
    const target = { ...root(), contains: () => true, querySelectorAll: () => fields, setAttribute() {}, removeAttribute() {} };
    const shell = new BookLabIntegratedVisualShell({ controller, catalog });
    await shell.mount(target, routes[2][1]);
    const trigger = { dataset: { bookAction: actionId }, disabled: false };
    await shell.handleClick({ target: { closest: (selector) => selector === "[data-book-action]" ? trigger : null } });
    assert.equal(mutations, 0);
    assert.equal(shell.view.response.body.error.code, "integrated_input_unavailable");
  }

  const cases = [
    {},
    { "x-unseen-book-withdrawal-etags": "{" },
    { "x-unseen-book-withdrawal-etags": JSON.stringify({ other: { grantId: "grant-01", etag: '"wrong-book"' } }) },
    { "x-unseen-book-withdrawal-etags": JSON.stringify({ "book-01": { grantId: "wrong-grant", etag: '"wrong-grant"' } }) }
  ];
  for (const headers of cases) {
    const candidate = view(routes[2][0], routes[2][1], routes[2][2], activeGrantBody(), { unseenHeaders: headers });
    assert.throws(() => buildIntegratedActionRequest("BOOK_MEMORY.WITHDRAW", candidate,
      { ifMatch: '"must-not-be-used"' }, () => "unused"),
    (error) => error instanceof IntegratedBookLabShellError && error.code === "integrated_input_unavailable");
    assert.match(renderIntegratedBookLabPage(candidate, catalog), /data-book-action="BOOK_MEMORY\.WITHDRAW" disabled/u);
    await assertClickDoesNotMutate(candidate, "BOOK_MEMORY.WITHDRAW");
  }

  const wrongMemoryBody = structuredClone(activeGrantBody());
  wrongMemoryBody.memory.personalMemoryId = "memory-02";
  wrongMemoryBody.grantReceipts[0].personalMemoryId = "memory-02";
  const wrongMemoryProjection = view(routes[2][0], routes[2][1], routes[2][2], wrongMemoryBody, {
    unseenHeaders: contributionHeaders()
  });
  assert.throws(() => buildIntegratedActionRequest("BOOK_MEMORY.WITHDRAW", wrongMemoryProjection, {}, () => "unused"),
    (error) => error instanceof IntegratedBookLabShellError && error.code === "integrated_input_unavailable");
  assert.throws(() => buildIntegratedActionRequest("BOOK_MEMORY.AUTHORIZE", wrongMemoryProjection,
    { creditLabel: "署名", consent: true }, () => "unused"),
  (error) => error instanceof IntegratedBookLabShellError && error.code === "integrated_input_unavailable");
  const wrongMemoryHtml = renderIntegratedBookLabPage(wrongMemoryProjection, catalog);
  assert.match(wrongMemoryHtml,
    /data-book-action="BOOK_MEMORY\.WITHDRAW" disabled/u);
  assert.match(wrongMemoryHtml, /data-book-action="BOOK_MEMORY\.AUTHORIZE" disabled/u);
  await assertClickDoesNotMutate(wrongMemoryProjection, "BOOK_MEMORY.WITHDRAW");
  await assertClickDoesNotMutate(wrongMemoryProjection, "BOOK_MEMORY.AUTHORIZE");

  for (const headers of [
    {},
    { "x-unseen-book-eligible-books": "[", "x-unseen-book-authorization-etags": JSON.stringify({ "book-01": '"etag"' }) },
    { "x-unseen-book-eligible-books": JSON.stringify([{ bookId: "other", audienceScope: "scope",
      noticeVersion: "v", noticeHash: "h", eligible: true }]),
    "x-unseen-book-authorization-etags": JSON.stringify({ other: '"etag"' }) }
  ]) {
    const candidate = view(routes[2][0], routes[2][1], routes[2][2], routes[2][3], { unseenHeaders: headers });
    assert.throws(() => buildIntegratedActionRequest("BOOK_MEMORY.AUTHORIZE", candidate,
      { bookId: "book-01", creditLabel: "署名", consent: true }, () => "unused"),
    (error) => error instanceof IntegratedBookLabShellError && error.code === "integrated_input_unavailable");
    assert.match(renderIntegratedBookLabPage(candidate, catalog), /data-book-action="BOOK_MEMORY\.AUTHORIZE" disabled/u);
    await assertClickDoesNotMutate(candidate, "BOOK_MEMORY.AUTHORIZE");
  }
});

test("PDF presentation uses only validated in-memory bytes and the host factory installs it by default", async () => {
  const events = [];
  const anchor = { hidden: false, click() { events.push("click"); }, remove() { events.push("remove"); } };
  const documentImpl = { body: { append(node) { assert.equal(node, anchor); events.push("append"); } },
    createElement(name) { assert.equal(name, "a"); return anchor; } };
  const urlImpl = { createObjectURL(blob) { assert.equal(blob.type, "application/pdf"); events.push("create"); return "blob:book"; },
    revokeObjectURL(url) { assert.equal(url, "blob:book"); events.push("revoke"); } };
  await downloadIntegratedBookLabPdf({ body: new Uint8Array([37, 80, 68, 70, 45]),
    contentDisposition: 'attachment; filename="book.pdf"' }, { documentImpl, urlImpl });
  assert.equal(anchor.href, "blob:book");
  assert.equal(anchor.download, "book.pdf");
  assert.deepEqual(events, ["create", "append", "click", "remove", "revoke"]);

  const controller = { readRoute() {}, readAction() {}, mutate() {}, rereadRoute() {} };
  const shell = createIntegratedBookLabVisualShell({ controller, catalog });
  assert.equal(shell.onPdf, downloadIntegratedBookLabPdf);
});

test("rendering escapes untrusted DTOs, keeps native keyboard controls, and reports permission loss", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=1">';
  const body = structuredClone(routes[1][3]);
  body.submissions[0].userText = hostile;
  const html = renderIntegratedBookLabPage(view(routes[1][0], routes[1][1], routes[1][2], body), catalog);
  assert.doesNotMatch(html, /<img/u);
  assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/u);
  assert.match(html, /<textarea[^>]*>/u);
  assert.match(html, /<button type="button"/u);
  assert.doesNotMatch(html, /<div[^>]+role="button"/u);

  const sessionLoss = renderIntegratedBookLabPage({ entry: "BL02", response: {
    ok: false, status: 403, body: { error: { code: "authorization_changed" } }
  } }, catalog);
  assert.match(sessionLoss, /会话或权限已变化/u);
  assert.match(sessionLoss, /authorization_changed/u);
  assert.match(sessionLoss, /data-book-retry/u);
});

test("integrated shell contains no fixture, artifact-render, fallback, or canonical HTML reconstruction path", async () => {
  const source = await readFile(new URL("../src/integrated-shell.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/__fixture|\/__artifacts|fixtureBundle|frozen-book-fixture/u);
  assert.doesNotMatch(source, /authorizedMemoryTexts|data:image|renderBookSpread|canonical\.mjs/u);
  assert.match(source, /印刷版内容由服务端安全提供/u);
});


test("late PDF response cannot publish after destroy or route generation changes", async () => {
  for (const change of ["destroy", "route"]) {
    let complete; const outputs = [];
    const shell = new BookLabIntegratedVisualShell({ catalog,
      controller: { readRoute() {}, readAction: () => new Promise(resolve => { complete = resolve; }) },
      onPdf: response => outputs.push(response) });
    const pending = shell.dispatch("BOOK.DOWNLOAD_PDF", {});
    if (change === "destroy") shell.destroy(); else shell.readGeneration += 1;
    complete({ ok: true, body: new Uint8Array([37, 80, 68, 70]) });
    await pending;
    assert.deepEqual(outputs, []);
  }
});

test("late click results cannot navigate or paint a replaced account surface", async () => {
  for (const rejected of [false, true]) {
    let complete, reject; const events = [];
    const shell = new BookLabIntegratedVisualShell({ catalog,
      controller: { readRoute() {} }, navigate: () => events.push("navigate") });
    const trigger = { dataset: { bookAction: "BOOK.DOWNLOAD_PDF" } };
    const root = { contains: () => true, setAttribute() {}, removeAttribute: () => events.push("busy"),
      removeEventListener() {}, querySelectorAll: () => [] };
    shell.root = root;
    shell.view = view(...routes[5]);
    shell.paint = () => events.push("paint");
    shell.dispatch = () => new Promise((resolve, fail) => { complete = resolve; reject = fail; });
    const pending = shell.handleClick({ target: { closest: selector => selector === "[data-book-action]" ? trigger : null } });
    shell.destroy();
    if (rejected) reject(new Error("late transport error")); else complete({ ok: false, status: 401 });
    await pending;
    assert.deepEqual(events, []);
  }
});


test("a completed PDF download leaves the current download button usable again", async () => {
  const shell = new BookLabIntegratedVisualShell({ catalog, controller: { readRoute() {} } });
  const trigger = { dataset: { bookAction: "BOOK.DOWNLOAD_PDF" }, disabled: false };
  shell.root = { contains: node => node === trigger, setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [] };
  shell.view = view(...routes[5]);
  let calls = 0;
  shell.dispatch = async () => { calls += 1; return { ok: true }; };
  for (let i = 0; i < 2; i += 1) {
    await shell.handleClick({ target: { closest: selector => selector === "[data-book-action]" ? trigger : null } });
    assert.equal(trigger.disabled, false);
  }
  assert.equal(calls, 2);
});
