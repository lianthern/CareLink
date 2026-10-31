import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { validateHeaderValue } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BookLabMemoryApi, FixtureCorePort, sha256 } from "../src/index.mjs";

const ETAG_SECRET = "test-secret-book-lab-etag-not-production-0001";
const WORKER_SECRET = "test-secret-book-lab-worker-not-production-0002";
const CLEANUP_SECRET = "test-secret-book-lab-cleanup-not-production-0003";
const RENDER_SECRET = "test-secret-book-lab-render-not-production-0004";

function source(photoId, contributorId, ordinal = 1) {
  const bytes = Buffer.from(`fixture-image:${photoId}`);
  return {
    spaceId: "space-book", photoId, sceneId: "scene-book", panoramaRevisionId: "panorama-book-1",
    placementRevisionId: `placement-book-${ordinal}`, nodeId: null, sourcePhotosVersion: ordinal,
    yawDegrees: ordinal * 10, capturedAt: `2026-08-14T00:0${ordinal}:00.000Z`, authorId: contributorId,
    photoContentHash: sha256(bytes), placementSnapshotHash: sha256(`placement:${photoId}`)
  };
}

function fixture({ beforeOwnerRevalidate = null, database = ":memory:", previewLeaseMs = 30_000 } = {}) {
  const photos = {};
  for (const [ordinal, photoId, contributorId, visibleAnchor] of [
    [1, "photo-a", "contributor-a", "蓝色桌布旁放着一张名字卡"],
    [2, "photo-b", "contributor-b", "展板边缘贴着一枚红色圆点"]
  ]) photos[photoId] = { photoId, contributorId, completed: true, photoContentState: "visible", deleted: false,
    deletedAt: null, withdrawn: false, l3Enabled: true, visibleAnchor,
    renderAsset: { mimeType: "image/jpeg", bytesBase64: Buffer.from(`fixture-image:${photoId}`).toString("base64"),
      contentHash: sha256(Buffer.from(`fixture-image:${photoId}`)),
      sourcePhotoContentHash: source(photoId, contributorId, ordinal).photoContentHash,
      sourcePhotosVersion: ordinal },
    provenance: source(photoId, contributorId, ordinal) };
  const core = new FixtureCorePort({
    photos,
    accountSessions: {
      "contributor-a-token": { sessionId: "contributor-a-session", contributorId: "contributor-a", active: true,
        revalidated: true, issuedSessionEpoch: 1, accountSessionEpoch: 1 },
      "contributor-b-token": { sessionId: "contributor-b-session", contributorId: "contributor-b", active: true,
        revalidated: true, issuedSessionEpoch: 1, accountSessionEpoch: 1 },
      "owner-token": { sessionId: "owner-session", contributorId: "owner-contributor", accountId: "owner-account",
        familyId: "owner-family", version: 7, active: true, revalidated: true, issuedSessionEpoch: 3,
        accountSessionEpoch: 3 },
      "member-token": { sessionId: "member-session", contributorId: "member-contributor", accountId: "member-account",
        familyId: "member-family", version: 1, active: true, revalidated: true, issuedSessionEpoch: 2,
        accountSessionEpoch: 2 }
    },
    receiptSessions: {
      "receipt-a": { sessionId: "receipt-a-session", contributorId: "contributor-a", active: true,
        photoIds: ["photo-a"], expiresAt: "2027-01-01T00:00:00.000Z" },
      "receipt-wrong": { sessionId: "receipt-wrong-session", contributorId: "contributor-b", active: true,
        photoIds: ["photo-b"], expiresAt: "2027-01-01T00:00:00.000Z" }
    },
    accounts: {
      "owner-account": { accountId: "owner-account", sessionEpoch: 3 },
      "member-account": { accountId: "member-account", sessionEpoch: 2 }
    },
    sessionFamilies: {
      "owner-family": { version: 4, active: true, revalidated: true, issuedSessionEpoch: 3 },
      "member-family": { version: 1, active: true, revalidated: true, issuedSessionEpoch: 2 }
    },
    spaces: { "space-book": { version: 9, ownerAccountId: "owner-account", spaceLifecycle: "active" } },
    events: { "event-book": { eventId: "event-book", spaceId: "space-book", active: true } },
    beforeOwnerRevalidate
  });
  const api = new BookLabMemoryApi({ core, etagSecret: ETAG_SECRET, workerSecret: WORKER_SECRET,
    cleanupSecret: CLEANUP_SECRET, renderWorkerSecret: RENDER_SECRET, previewLeaseMs, database });
  let key = 0;
  const headers = {
    owner: { authorization: "Bearer owner-token" }, member: { authorization: "Bearer member-token" },
    a: { authorization: "Bearer contributor-a-token" }, b: { authorization: "Bearer contributor-b-token" },
    receiptA: { "x-receipt-session": "receipt-a" }, receiptWrong: { "x-receipt-session": "receipt-wrong" }
  };
  async function call(method, path, body = {}, extra = {}) {
    return api.handle({ method, path, body, headers: {
      ...(method === "GET" ? {} : { "idempotency-key": `book-test-${++key}-key` }), ...extra
    } });
  }
  return { api, core, headers, call, close: () => api.close() };
}

async function createBook(f, bookId = "book-one", title = "那天，我们在现场") {
  return f.call("POST", "/v2-labs/owner/spaces/space-book/books", { bookId, title, eventId: "event-book" },
    { ...f.headers.owner, "if-none-match": "*" });
}

async function confirmMemory(f, photoId = "photo-a", auth = f.headers.a, answer = "散场后我把名字卡收进了笔记本。") {
  const open = await f.call("GET", `/v2-labs/memories/photos/${photoId}`, {}, auth);
  const photo = f.core.photos.get(photoId);
  const started = await f.call("POST", `/v2-labs/memories/photos/${photoId}/question-jobs`, {
    noticeVersion: f.api.currentNotice.version, noticeHash: f.api.currentNotice.hash,
    photoContentHash: photo.provenance.photoContentHash,
    placementSnapshotHash: photo.provenance.placementSnapshotHash
  }, { ...auth, "if-none-match": open.body.interviewPrecondition.ifNoneMatch });
  f.api.processQuestion(f.api.pendingQuestionJobs(WORKER_SECRET)[0], WORKER_SECRET);
  const detail = await f.call("GET", `/v2-labs/memories/${started.body.personalMemoryId}`, {}, auth);
  const submissionId = `${photoId}-answer`;
  const saved = await f.call("PUT", `/v2-labs/memories/${started.body.personalMemoryId}/answer-submissions`, {
    clientSubmissionId: submissionId, userText: answer, previousSubmissionId: null,
    interviewIfMatchVersion: detail.body.memory.interviewVersion
  }, { ...auth, "if-match": detail.headers["x-unseen-memory-etag"] });
  const confirmed = await f.call("POST", `/v2-labs/memories/${started.body.personalMemoryId}/confirmations`, {
    submissionId, submissionHash: sha256(answer), interviewIfMatchVersion: saved.body.memory.interviewVersion
  }, { ...auth, "if-match": saved.headers["x-unseen-memory-etag"] });
  assert.equal(confirmed.status, 200);
  return { memoryId: started.body.personalMemoryId, answer, confirmed,
    detail: await f.call("GET", `/v2-labs/memories/${started.body.personalMemoryId}`, {}, auth) };
}

function authorizationToken(detail, bookId) {
  return JSON.parse(detail.headers["x-unseen-book-authorization-etags"])[bookId];
}

function eligibleBooks(detail) {
  return JSON.parse(detail.headers["x-unseen-book-eligible-books"] ?? "[]");
}

function withdrawalTokens(detail) {
  return JSON.parse(detail.headers["x-unseen-book-withdrawal-etags"] ?? "{}");
}

function grantBody(memory, api) {
  return { personalMemoryId: memory.memoryId, memoryRevisionId: memory.confirmed.body.memory.memoryRevisionId,
    confirmedSubmissionHash: memory.confirmed.body.memory.confirmedSubmissionHash, creditLabel: "小满",
    audienceScope: "current_live_space_viewers", noticeVersion: api.currentBookNotice.version,
    noticeHash: api.currentBookNotice.hash };
}

function addDisplayPhoto(f, photoId = "photo-display", overrides = {}) {
  const provenance = { ...source(photoId, "contributor-b", 3), ...(overrides.provenance ?? {}) };
  f.core.photos.set(photoId, { photoId, contributorId: "contributor-b", completed: true,
    photoContentState: "visible", deleted: false, deletedAt: null, withdrawn: false, l3Enabled: true,
    visibleAnchor: "舞台旁边摆着一束白色花",
    renderAsset: { mimeType: "image/jpeg", bytesBase64: Buffer.from(`fixture-image:${photoId}`).toString("base64"),
      contentHash: sha256(Buffer.from(`fixture-image:${photoId}`)),
      sourcePhotoContentHash: provenance.photoContentHash, sourcePhotosVersion: provenance.sourcePhotosVersion },
    ...overrides, provenance });
}

async function authorizeMemory(f, memory, bookId = "book-one", auth = f.headers.a, creditLabel = "小满") {
  const detail = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, auth);
  return f.call("POST", `/v2-labs/books/${bookId}/contribution-grants/${memory.memoryId}`,
    { ...grantBody(memory, f.api), creditLabel }, {
      ...auth, "if-match": authorizationToken(detail, bookId), "if-none-match": "*"
    });
}

function memoryPage(f, memory, grant, { pageId = "page-one", index = 1,
  displayPhotoId = "photo-a" } = {}) {
  const photo = f.core.photos.get(memory.confirmed.body.memory.photoId);
  return {
    pageId, index, kind: "memory", sourcePhotoId: photo.photoId, displayPhotoId,
    personalMemoryId: memory.memoryId, memoryRevisionId: memory.confirmed.body.memory.memoryRevisionId,
    confirmedSubmissionId: memory.confirmed.body.memory.confirmedSubmissionId,
    confirmedSubmissionHash: memory.confirmed.body.memory.confirmedSubmissionHash,
    grantId: grant.body.grantId, authorizedMemoryTextId: `text-${pageId}`,
    sourceProvenance: structuredClone(photo.provenance)
  };
}

function installPages(f, pages, { status = "editing", previewWorkerInputHash = null } = {}) {
  const head = f.api.currentBook("book-one");
  f.api.db.prepare(`UPDATE book_draft_versions SET pages_json=?,status=?,preview_worker_input_hash=? WHERE id=?`)
    .run(JSON.stringify(pages), status, previewWorkerInputHash, head.draft_id);
  return f.api.currentBook("book-one");
}

function previewPages(f, memory, grant, count = 12) {
  return Array.from({ length: count }, (_, index) => memoryPage(f, memory, grant, {
    pageId: `preview-page-${index + 1}`, index: index + 1
  }));
}

const MANIFEST_FIELDS = ["bookId", "versionId", "title", "manifestHash", "authorizationSnapshotHash",
  "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "pages", "authorizedMemoryTexts", "frozenAssets",
  "frozenAt"];
const AUTHORIZED_TEXT_FIELDS = ["authorizedMemoryTextId", "bookId", "versionId", "personalMemoryId",
  "memoryRevisionId", "confirmedSubmissionId", "confirmedSubmissionHash", "originalUserText", "authorCredit",
  "questionProvenance", "grantId", "audienceScope", "sourceProvenance", "snapshotHash", "frozenAt"];
const FROZEN_ASSET_FIELDS = ["assetSnapshotId", "kind", "photoId", "sourcePhotosVersion", "contentHash",
  "mimeType", "byteLength", "localAssetRef"];

function assertExactFields(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function renderClaimInput(input, htmlArtifactId = "preview-html-one") {
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.manifest), true);
  assertExactFields(input.manifest, MANIFEST_FIELDS);
  const { manifestHash, ...semantic } = input.manifest;
  assert.equal(manifestHash, sha256(canonicalJson(semantic)));
  assert.equal(input.manifest.authorizedMemoryTextSnapshotHash,
    sha256(canonicalJson(input.manifest.authorizedMemoryTexts)));
  assert.equal(input.manifest.assetSnapshotHash, sha256(canonicalJson(input.manifest.frozenAssets)));
  const texts = new Map();
  for (const value of input.manifest.authorizedMemoryTexts) {
    assertExactFields(value, AUTHORIZED_TEXT_FIELDS);
    const { snapshotHash, ...textSemantic } = value;
    assert.equal(snapshotHash, sha256(canonicalJson(textSemantic)));
    assert.equal(value.bookId, input.manifest.bookId);
    assert.equal(value.versionId, input.manifest.versionId);
    assert.equal(value.confirmedSubmissionHash, sha256(value.originalUserText));
    texts.set(value.authorizedMemoryTextId, value);
  }
  const bytesByRef = new Map(input.assetBytes.map((value) => [value.localAssetRef, value]));
  assert.equal(bytesByRef.size, input.assetBytes.length);
  const assets = new Map();
  for (const value of input.manifest.frozenAssets) {
    assertExactFields(value, FROZEN_ASSET_FIELDS);
    const bytes = Buffer.from(bytesByRef.get(value.localAssetRef).bytesBase64, "base64");
    assert.equal(bytes.length, value.byteLength);
    assert.equal(sha256(bytes), value.contentHash);
    assets.set(value.photoId, value);
  }
  for (const page of input.manifest.pages) {
    if (["cover", "closing"].includes(page.kind)) continue;
    const textValue = texts.get(page.authorizedMemoryTextId);
    assert.ok(textValue);
    assert.equal(textValue.grantId, page.grantId);
    assert.deepEqual(textValue.sourceProvenance, page.sourceProvenance);
    assert.ok(assets.has(page.displayPhotoId));
  }
  const html = `<!doctype html><html><title>${input.manifest.title}</title><body>${
    input.manifest.authorizedMemoryTexts.map((value) => value.originalUserText).join("\n")}</body></html>`;
  return { status: "ready", html, htmlHash: sha256(html), pageCount: input.manifest.pages.length, htmlArtifactId,
    equality: {
      bookId: input.manifest.bookId,
      versionId: input.manifest.versionId,
      title: input.manifest.title,
      manifestHash: input.manifest.manifestHash,
      authorizationSnapshotHash: input.manifest.authorizationSnapshotHash,
      authorizedMemoryTextSnapshotHash: input.manifest.authorizedMemoryTextSnapshotHash,
      assetSnapshotHash: input.manifest.assetSnapshotHash,
      pageCount: input.manifest.pages.length,
      orderedPageIds: input.manifest.pages.map((page) => page.pageId),
      orderedSourceIds: input.manifest.pages.map((page) => page.sourcePhotoId),
      orderedDisplayPhotoIds: input.manifest.pages.map((page) => page.displayPhotoId)
    } };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function claimPreview(f, work) {
  const claimed = await f.api.processPreview(work, RENDER_SECRET);
  assert.equal(claimed.status, "claimed");
  return claimed;
}

async function completeReadyPreview(f, work, htmlArtifactId = "preview-html-one") {
  const claimed = await claimPreview(f, work);
  const output = renderClaimInput(claimed.input, htmlArtifactId);
  const request = { renderJobId: work.renderJobId, jobVersion: claimed.version,
    inputHash: work.inputHash, attempt: work.attempt };
  return { claimed, request, result: await f.api.completePreview(request, output, RENDER_SECRET) };
}

test("owner book create/open is BOLA scoped, idempotent, and revalidates current Core owner before writes", async () => {
  const f = fixture();
  try {
    const headers = { ...f.headers.owner, "if-none-match": "*", "idempotency-key": "fixed-create-key" };
    const body = { bookId: "book-one", title: "那天，我们在现场", eventId: "event-book" };
    const created = await f.call("POST", "/v2-labs/owner/spaces/space-book/books", body, headers);
    assert.equal(created.status, 200);
    assert.equal(created.body.status, "editing");
    assert.deepEqual(created.body.pages, []);
    assert.equal(created.body.version, 1);
    const replay = await f.call("POST", "/v2-labs/owner/spaces/space-book/books", body, headers);
    assert.deepEqual(replay, created);
    const changed = await f.call("POST", "/v2-labs/owner/spaces/space-book/books", { ...body, title: "另一标题" }, headers);
    assert.equal(changed.body.error.code, "idempotency_key_reused");

    const lab = await f.call("GET", "/v2-labs/owner/spaces/space-book/book-lab", {}, f.headers.owner);
    assert.equal(lab.status, 200);
    assert.equal(lab.body.books[0].bookId, "book-one");
    const draft = await f.call("GET", "/v2-labs/owner/spaces/space-book/books/book-one/draft", {}, f.headers.owner);
    assert.equal(draft.status, 200);
    for (const path of ["/v2-labs/owner/spaces/space-book/book-lab",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft"]) {
      const denied = await f.call("GET", path, {}, f.headers.member);
      assert.equal(denied.status, 409);
      assert.equal(denied.body.error.code, "authorization_changed");
    }
    const receiptOwner = await f.call("GET", "/v2-labs/owner/spaces/space-book/book-lab", {}, f.headers.receiptA);
    assert.equal(receiptOwner.body.error.code, "authorization_changed");
    const wrongSpace = await f.call("GET", "/v2-labs/owner/spaces/other-space/book-lab", {}, f.headers.owner);
    assert.equal(wrongSpace.body.error.code, "authorization_changed");
  } finally { f.close(); }

  let drifted = false;
  const drift = fixture({ beforeOwnerRevalidate(core) {
    if (!drifted) { drifted = true; core.spaces.get("space-book").version += 1; }
  } });
  try {
    const result = await createBook(drift, "drift-book");
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "authorization_changed");
    assert.equal(drift.api.db.prepare("SELECT count(*) count FROM memory_books").get().count, 0);
  } finally { drift.close(); }
});

test("grant authorization binds exact revision and invalidates a preview through immutable draft revisions", async () => {
  const f = fixture();
  try {
    assert.equal((await createBook(f)).status, 200);
    const memory = await confirmMemory(f);
    const token = authorizationToken(memory.detail, "book-one");
    const wrong = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      { ...grantBody(memory, f.api), memoryRevisionId: "wrong-revision" },
      { ...f.headers.a, "if-match": token, "if-none-match": "*" });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error.code, "memory_revision_changed");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_contribution_grants").get().count, 0);

    const before = f.api.currentBook("book-one");
    f.api.db.prepare(`UPDATE book_draft_versions SET status='preview_ready',preview_worker_input_hash='old-input'
      WHERE id=?`).run(before.draft_id);
    f.api.db.prepare(`INSERT INTO book_render_jobs(id,book_id,status,version,input_hash,updated_at)
      VALUES('old-render','book-one','queued',1,'old-input',?)`).run(new Date().toISOString());
    const fixed = { ...f.headers.a, "if-match": token, "if-none-match": "*", "idempotency-key": "fixed-grant-key" };
    const granted = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), fixed);
    assert.equal(granted.status, 200);
    assert.equal(granted.body.status, "active");
    assert.equal(granted.body.titleAuditSnapshot.title, "那天，我们在现场");
    assert.equal(granted.body.titleAuditSnapshot.capturedAt,
      f.api.db.prepare("SELECT created_at FROM book_events WHERE id=?")
        .get(granted.body.titleAuditSnapshot.titleEventId).created_at);
    const replay = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), fixed);
    assert.deepEqual(replay, granted);
    const current = f.api.currentBook("book-one");
    assert.notEqual(current.draft_id, before.draft_id);
    assert.equal(current.parent_version_id, before.draft_id);
    assert.equal(current.draft_version, 2);
    assert.equal(current.draft_status, "stale");
    assert.equal(current.stale_reason, "grant_authorized");
    assert.equal(f.api.db.prepare("SELECT status FROM book_render_jobs WHERE id='old-render'").get().status, "cancelled");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_draft_versions WHERE book_id='book-one'").get().count, 2);
    const event = f.api.db.prepare("SELECT id,detail_json FROM book_events WHERE event_type='BOOK_MEMORY.AUTHORIZE'").get();
    const detail = JSON.parse(event.detail_json);
    assert.notEqual(detail.titleAuditSnapshot.titleEventId, event.id);
    assert.equal(f.api.db.prepare("SELECT event_type FROM book_events WHERE id=?")
      .get(detail.titleAuditSnapshot.titleEventId).event_type, "BOOK.CREATE");
    assert.equal(detail.confirmedSubmissionHash, sha256(memory.answer));

    const other = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.b, "if-match": token, "if-none-match": "*" });
    assert.equal(other.status, 404);
    assert.equal(other.body.error.code, "memory_unavailable");
    const wrongReceipt = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.receiptWrong, "if-match": token, "if-none-match": "*" });
    assert.equal(wrongReceipt.status, 404);
    const wrongBook = await f.call("POST", `/v2-labs/books/not-this-book/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.a, "if-match": token, "if-none-match": "*" });
    assert.equal(wrongBook.status, 404);
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_contribution_grants").get().count, 1);
  } finally { f.close(); }
});

test("BL03 reload exposes only current authorize or withdrawal preconditions without changing the detail DTO", async () => {
  const f = fixture();
  try {
    await createBook(f);
    await createBook(f, "book-two", "第二本现场书");
    await createBook(f, "书三", "不会进入 HTTP 头");
    await createBook(f, "book-\u0001", "控制字符 ID 也不会进入 HTTP 头");
    const memory = await confirmMemory(f);
    f.api.db.prepare("UPDATE memory_interviews SET status='draft' WHERE personal_memory_id=?").run(memory.memoryId);
    const unconfirmed = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    assert.deepEqual(eligibleBooks(unconfirmed), []);
    assert.equal(unconfirmed.headers["x-unseen-book-authorization-etags"], undefined);
    f.api.db.prepare("UPDATE memory_interviews SET status='confirmed' WHERE personal_memory_id=?").run(memory.memoryId);
    const initial = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    assert.equal(Object.hasOwn(initial.body, "eligibleBooks"), false);
    assert.deepEqual(eligibleBooks(initial), [
      { bookId: "book-one", audienceScope: "current_live_space_viewers",
        noticeVersion: f.api.currentBookNotice.version, noticeHash: f.api.currentBookNotice.hash, eligible: true },
      { bookId: "book-two", audienceScope: "current_live_space_viewers",
        noticeVersion: f.api.currentBookNotice.version, noticeHash: f.api.currentBookNotice.hash, eligible: true }
    ]);
    for (const [name, value] of Object.entries(initial.headers)) validateHeaderValue(name, value);
    assert.deepEqual(Object.keys(JSON.parse(initial.headers["x-unseen-book-authorization-etags"])),
      ["book-one", "book-two"]);
    assert.equal(eligibleBooks(initial).some(({ bookId }) => ["书三", "book-\u0001"].includes(bookId)), false);
    assert.deepEqual(withdrawalTokens(initial), {});
    assert.equal((await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.b)).status, 404);
    assert.equal((await f.call("POST", "/v2-labs/books/book-one/contribution-grants/not-this-memory",
      grantBody(memory, f.api), { ...f.headers.a, "if-match": authorizationToken(initial, "book-one"),
        "if-none-match": "*" })).status, 404);

    const frozenSource = structuredClone(f.core.photos.get("photo-a").provenance);
    f.core.photos.get("photo-a").provenance.placementRevisionId = "placement-source-drift";
    const drifted = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    assert.deepEqual(eligibleBooks(drifted), []);
    assert.equal(drifted.headers["x-unseen-book-authorization-etags"], undefined);
    const stale = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.a, "if-match": authorizationToken(initial, "book-one"),
        "if-none-match": "*" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "memory_revision_changed");
    f.core.photos.get("photo-a").provenance = structuredClone(frozenSource);

    const restored = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    const staleAuthorizationEtag = authorizationToken(restored, "book-one");
    const edited = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title",
      { title: "重载后的新标题" }, { ...f.headers.owner,
        "if-match": f.api.bookResponseHeaders(f.api.currentBook("book-one"))["x-unseen-book-etag"] });
    assert.equal(edited.status, 200);
    const staleAuthorization = await f.call("POST",
      `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`, grantBody(memory, f.api), {
        ...f.headers.a, "if-match": staleAuthorizationEtag, "if-none-match": "*"
      });
    assert.equal(staleAuthorization.status, 409);
    assert.equal(staleAuthorization.body.error.code, "version_conflict");
    const current = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    const granted = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.a, "if-match": authorizationToken(current, "book-one"),
        "if-none-match": "*" });
    assert.equal(granted.status, 200);
    const active = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    assert.deepEqual(eligibleBooks(active).map(({ bookId }) => bookId), ["book-two"]);
    assert.deepEqual(Object.keys(JSON.parse(active.headers["x-unseen-book-authorization-etags"])), ["book-two"]);
    assert.deepEqual(withdrawalTokens(active), {
      "book-one": { grantId: granted.body.grantId, etag: granted.headers["x-unseen-grant-etag"] }
    });
    assert.equal(active.body.grantReceipts.find(({ grantId }) => grantId === granted.body.grantId).status, "active");
    const staleWithdrawalEtag = withdrawalTokens(active)["book-one"].etag;
    const editedAgain = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title",
      { title: "撤回前的新标题" }, { ...f.headers.owner,
        "if-match": f.api.bookResponseHeaders(f.api.currentBook("book-one"))["x-unseen-book-etag"] });
    assert.equal(editedAgain.status, 200);
    const staleWithdrawal = await f.call("POST",
      `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}/withdrawals`, {}, {
        ...f.headers.a, "if-match": staleWithdrawalEtag
      });
    assert.equal(staleWithdrawal.status, 409);
    assert.equal(staleWithdrawal.body.error.code, "version_conflict");
    const refreshedActive = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);

    f.core.photos.get("photo-a").provenance.placementRevisionId = "placement-source-drift-after-grant";
    const revokedSource = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    assert.deepEqual(eligibleBooks(revokedSource), []);
    assert.equal(revokedSource.headers["x-unseen-book-authorization-etags"], undefined);
    assert.deepEqual(withdrawalTokens(revokedSource), withdrawalTokens(refreshedActive));
    const withdrawn = await f.call("POST",
      `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}/withdrawals`, {}, {
        ...f.headers.a, "if-match": withdrawalTokens(revokedSource)["book-one"].etag
      });
    assert.equal(withdrawn.status, 200);
    f.api.processGrantCleanup(withdrawn.body.withdrawalId, CLEANUP_SECRET);
    f.core.photos.get("photo-a").provenance = structuredClone(frozenSource);
    const availableAgain = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    assert.deepEqual(eligibleBooks(availableAgain).map(({ bookId }) => bookId), ["book-one", "book-two"]);
    assert.deepEqual(withdrawalTokens(availableAgain), {});
    const reauthorized = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.a, "if-match": authorizationToken(availableAgain, "book-one"),
        "if-none-match": "*" });
    assert.equal(reauthorized.status, 200);
    assert.notEqual(reauthorized.body.grantId, granted.body.grantId);
    const reloaded = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    assert.equal(withdrawalTokens(reloaded)["book-one"].grantId, reauthorized.body.grantId);
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }
});

test("BL03 authorization and withdrawal reload preconditions survive restart", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-book-bl03-reload-"));
  const database = path.join(directory, "book-lab.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = fixture({ database });
  let memoryId;
  let beforeRestart;
  try {
    await createBook(first);
    const memory = await confirmMemory(first);
    memoryId = memory.memoryId;
    assert.equal((await authorizeMemory(first, memory)).status, 200);
    beforeRestart = await first.call("GET", `/v2-labs/memories/${memoryId}`, {}, first.headers.a);
  } finally { first.close(); }

  const second = fixture({ database });
  try {
    const afterRestart = await second.call("GET", `/v2-labs/memories/${memoryId}`, {}, second.headers.a);
    assert.equal(Object.hasOwn(afterRestart.body, "eligibleBooks"), false);
    assert.deepEqual(eligibleBooks(afterRestart), eligibleBooks(beforeRestart));
    assert.deepEqual(withdrawalTokens(afterRestart), withdrawalTokens(beforeRestart));
    assert.equal((await second.call("GET", `/v2-labs/memories/${memoryId}`, {}, second.headers.b)).status, 404);
    const token = withdrawalTokens(afterRestart)["book-one"];
    const withdrawn = await second.call("POST",
      `/v2-labs/books/book-one/contribution-grants/${memoryId}/withdrawals`, {}, {
        ...second.headers.a, "if-match": token.etag
      });
    assert.equal(withdrawn.status, 200);
    assert.equal(second.core.writeCount, 0);
  } finally { second.close(); }
});

test("Memory withdrawal physically purges active zero-version grant answer hashes, credit, and client ids", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-book-grant-purge-"));
  const database = path.join(directory, "book-lab.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture({ database });
  const answer = "短答Q9";
  try {
    await createBook(f);
    const memory = await confirmMemory(f, "photo-a", f.headers.a, answer);
    const body = { ...grantBody(memory, f.api), creditLabel: "物理清理署名Q9" };
    const granted = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`, body,
      { ...f.headers.a, "if-match": authorizationToken(memory.detail, "book-one"), "if-none-match": "*" });
    assert.equal(granted.status, 200);
    const detail = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    const withdrawal = await f.call("POST", `/v2-labs/memories/${memory.memoryId}/withdrawals`, {
      interviewIfMatchVersion: detail.body.memory.interviewVersion
    }, { ...f.headers.a, "if-match": detail.headers["x-unseen-memory-etag"] });
    assert.equal(withdrawal.status, 200);
    assert.deepEqual(withdrawal.body.affectedBookVersionIds, []);
    assert.equal(f.api.pendingCleanup(CLEANUP_SECRET).length, 1);
    assert.equal(f.api.processCleanup(withdrawal.body.withdrawalId, CLEANUP_SECRET).purgeStatus, "complete");
    const grant = f.api.db.prepare(`SELECT status,confirmed_submission_hash confirmedSubmissionHash,
      credit_label creditLabel,title_audit_snapshot_json titleAuditSnapshot FROM book_contribution_grants`).get();
    assert.equal(grant.status, "withdrawn");
    assert.equal(grant.confirmedSubmissionHash, sha256("withdrawn-book-grant"));
    assert.equal(grant.creditLabel, "[withdrawn]");
    assert.equal(grant.titleAuditSnapshot, "{}");
    assert.ok(f.api.db.prepare("SELECT detail_json FROM book_events").all()
      .every((row) => !row.detail_json.includes(answer) && !row.detail_json.includes(sha256(answer)) &&
        !row.detail_json.includes("photo-a-answer") && !row.detail_json.includes("物理清理署名Q9")));
  } finally { f.close(); }
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${database}${suffix}`;
    if (!existsSync(filename)) continue;
    const bytes = readFileSync(filename);
    for (const value of [answer, sha256(answer), "photo-a-answer", "物理清理署名Q9"]) {
      assert.equal(bytes.includes(Buffer.from(value)), false, `${suffix || "db"}:${value}`);
    }
  }
});

test("zero-frozen-version grant withdrawal uses an explicit empty access snapshot and old grants never reactivate", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const memory = await confirmMemory(f);
    const granted = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.a, "if-match": authorizationToken(memory.detail, "book-one"),
        "if-none-match": "*" });
    assert.equal(f.api.accessControlSnapshot("book-one").length, 0);
    const beforeDraft = f.api.currentBook("book-one");
    const fixed = { ...f.headers.a, "if-match": granted.headers["x-unseen-grant-etag"],
      "idempotency-key": "fixed-grant-withdraw-key" };
    const withdrawn = await f.call("POST",
      `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}/withdrawals`, {}, fixed);
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.purgeStatus, "queued");
    assert.deepEqual(withdrawn.body.affectedBookVersionIds, []);
    assert.equal(f.api.db.prepare("SELECT status FROM book_contribution_grants WHERE id=?").get(granted.body.grantId).status,
      "withdrawal_pending");
    assert.equal(f.api.currentBook("book-one").draft_version, beforeDraft.draft_version + 1);
    const replay = await f.call("POST",
      `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}/withdrawals`, {}, fixed);
    assert.deepEqual(replay, withdrawn);
    assert.equal(f.api.processGrantCleanup(withdrawn.body.withdrawalId, CLEANUP_SECRET).purgeStatus, "complete");
    assert.equal(f.api.db.prepare("SELECT status FROM book_contribution_grants WHERE id=?").get(granted.body.grantId).status,
      "withdrawn");

    const freshDetail = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    const regranted = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.a, "if-match": authorizationToken(freshDetail, "book-one"),
        "if-none-match": "*" });
    assert.equal(regranted.status, 200);
    assert.notEqual(regranted.body.grantId, granted.body.grantId);
    const rows = f.api.db.prepare("SELECT id,status FROM book_contribution_grants ORDER BY granted_at,rowid").all();
    assert.deepEqual(rows.map((row) => row.status), ["withdrawn", "active"]);

    const beforeMemoryWithdrawal = f.api.currentBook("book-one");
    const currentMemory = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    const memoryWithdrawal = await f.call("POST", `/v2-labs/memories/${memory.memoryId}/withdrawals`, {
      interviewIfMatchVersion: currentMemory.body.memory.interviewVersion
    }, { ...f.headers.a, "if-match": currentMemory.headers["x-unseen-memory-etag"] });
    assert.equal(memoryWithdrawal.status, 200);
    assert.deepEqual(memoryWithdrawal.body.affectedBookVersionIds, []);
    assert.equal(f.api.currentBook("book-one").draft_version, beforeMemoryWithdrawal.draft_version + 1);
    assert.equal(f.api.db.prepare("SELECT status FROM book_contribution_grants WHERE id=?")
      .get(regranted.body.grantId).status, "withdrawal_pending");
    f.api.processCleanup(memoryWithdrawal.body.withdrawalId, CLEANUP_SECRET);
    assert.equal(f.api.db.prepare("SELECT status FROM book_contribution_grants WHERE id=?")
      .get(regranted.body.grantId).status, "withdrawn");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_version_access_controls").get().count, 0);
  } finally { f.close(); }
});

test("P1 regression: withdrawal filters only the exact grant from the owner draft before success", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const first = await confirmMemory(f, "photo-a", f.headers.a, "第一段撤回答案");
    const second = await confirmMemory(f, "photo-b", f.headers.b, "第二段保留答案");
    const authorize = async (memory, auth, credit) => {
      const detail = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, auth);
      return f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
        { ...grantBody(memory, f.api), creditLabel: credit },
        { ...auth, "if-match": authorizationToken(detail, "book-one"), "if-none-match": "*" });
    };
    const removedGrant = await authorize(first, f.headers.a, "撤回署名");
    const keptGrant = await authorize(second, f.headers.b, "保留署名");
    const head = f.api.currentBook("book-one");
    f.api.db.prepare("UPDATE book_draft_versions SET pages_json=? WHERE id=?").run(JSON.stringify([
      { pageId: "page-removed", grantId: removedGrant.body.grantId, copiedText: first.answer, authorCredit: "撤回署名" },
      { pageId: "page-kept", grantId: keptGrant.body.grantId, copiedText: second.answer, authorCredit: "保留署名" }
    ]), head.draft_id);
    const currentMemory = await f.call("GET", `/v2-labs/memories/${first.memoryId}`, {}, f.headers.a);
    const withdrawn = await f.call("POST", `/v2-labs/memories/${first.memoryId}/withdrawals`, {
      interviewIfMatchVersion: currentMemory.body.memory.interviewVersion
    }, { ...f.headers.a, "if-match": currentMemory.headers["x-unseen-memory-etag"] });
    assert.equal(withdrawn.status, 200);
    const ownerDraft = await f.call("GET", "/v2-labs/owner/spaces/space-book/books/book-one/draft", {}, f.headers.owner);
    assert.deepEqual(ownerDraft.body.pages.map((page) => page.pageId), ["page-kept"]);
    assert.equal(JSON.stringify(ownerDraft.body).includes(first.answer), false);
    assert.equal(JSON.stringify(ownerDraft.body).includes("撤回署名"), false);
    assert.equal(ownerDraft.body.pages[0].grantId, keptGrant.body.grantId);
  } finally { f.close(); }
});

test("P1 regression: grant withdrawal affects only frozen versions that contain the exact grant and is recoverable", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const memory = await confirmMemory(f);
    const granted = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.a, "if-match": authorizationToken(memory.detail, "book-one"),
        "if-none-match": "*" });
    const now = new Date().toISOString();
    for (const versionId of ["version-with-grant", "version-without-grant", "old-version-with-grant"]) {
      f.api.db.prepare(`INSERT INTO book_version_access_controls(version_id,book_id,status,version,updated_at)
        VALUES(?,'book-one','active',1,?)`).run(versionId, now);
    }
    f.api.db.prepare("INSERT INTO book_version_grants(version_id,grant_id) VALUES(?,?)")
      .run("version-with-grant", granted.body.grantId);
    const head = f.api.currentBook("book-one");
    const freshGrant = f.api.db.prepare("SELECT * FROM book_contribution_grants WHERE id=?").get(granted.body.grantId);
    const withdrawn = await f.call("POST",
      `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}/withdrawals`, {}, {
        ...f.headers.a, "if-match": f.api.grantWithdrawalEtag(freshGrant, head)
      });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.purgeStatus, "queued");
    assert.deepEqual(withdrawn.body.affectedBookVersionIds, ["version-with-grant"]);
    assert.deepEqual(f.api.db.prepare(`SELECT version_id versionId,status FROM book_version_access_controls
      ORDER BY version_id`).all().map((row) => ({ ...row })), [
      { versionId: "old-version-with-grant", status: "active" },
      { versionId: "version-with-grant", status: "affected" },
      { versionId: "version-without-grant", status: "active" }
    ]);
    assert.equal(f.api.pendingGrantCleanup(CLEANUP_SECRET).length, 1);
    const complete = f.api.processGrantCleanup(withdrawn.body.withdrawalId, CLEANUP_SECRET);
    assert.equal(complete.purgeStatus, "complete");
    assert.deepEqual(f.api.processGrantCleanup(withdrawn.body.withdrawalId, CLEANUP_SECRET), complete);
    assert.equal(f.api.db.prepare("SELECT status FROM book_contribution_grants WHERE id=?")
      .get(granted.body.grantId).status, "withdrawn");
    const detail = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    const reauthorized = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.a, "if-match": authorizationToken(detail, "book-one"),
        "if-none-match": "*" });
    assert.equal(reauthorized.status, 200);
    assert.notEqual(reauthorized.body.grantId, granted.body.grantId);
  } finally { f.close(); }
});

test("P1 regression: ordinary replay precedes mutable event and notice validation but stays principal/body bound", async () => {
  const f = fixture();
  try {
    const createHeaders = { ...f.headers.owner, "if-none-match": "*", "idempotency-key": "mutable-create-key" };
    const createBody = { bookId: "book-one", title: "那天，我们在现场", eventId: "event-book" };
    const created = await f.call("POST", "/v2-labs/owner/spaces/space-book/books", createBody, createHeaders);
    assert.equal(created.status, 200);
    f.core.events.delete("event-book");
    assert.deepEqual(await f.call("POST", "/v2-labs/owner/spaces/space-book/books", createBody, createHeaders), created);
    const changedCreate = await f.call("POST", "/v2-labs/owner/spaces/space-book/books",
      { ...createBody, title: "篡改标题" }, createHeaders);
    assert.equal(changedCreate.body.error.code, "idempotency_key_reused");

    const memory = await confirmMemory(f);
    const grantHeaders = { ...f.headers.a, "if-match": authorizationToken(memory.detail, "book-one"),
      "if-none-match": "*", "idempotency-key": "mutable-grant-key" };
    const body = grantBody(memory, f.api);
    const granted = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      body, grantHeaders);
    assert.equal(granted.status, 200);
    f.api.currentBookNotice = { version: "later-notice", hash: sha256("later-notice") };
    assert.deepEqual(await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      body, grantHeaders), granted);
    const changedGrant = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      { ...body, creditLabel: "另一个署名" }, grantHeaders);
    assert.equal(changedGrant.body.error.code, "idempotency_key_reused");
    const otherPrincipal = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      body, { ...f.headers.b, "if-match": grantHeaders["if-match"], "if-none-match": "*",
        "idempotency-key": "mutable-grant-key" });
    assert.equal(otherPrincipal.body.error.code, "memory_unavailable");
  } finally { f.close(); }
});

test("P1 regression: authorization title snapshot references the real title audit event, never itself", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const memory = await confirmMemory(f);
    const granted = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      grantBody(memory, f.api), { ...f.headers.a, "if-match": authorizationToken(memory.detail, "book-one"),
        "if-none-match": "*" });
    assert.equal(granted.status, 200);
    const titleEvent = f.api.db.prepare("SELECT * FROM book_events WHERE id=?")
      .get(granted.body.titleAuditSnapshot.titleEventId);
    const authorizeEvent = f.api.db.prepare("SELECT * FROM book_events WHERE event_type='BOOK_MEMORY.AUTHORIZE'").get();
    assert.equal(titleEvent.event_type, "BOOK.CREATE");
    assert.notEqual(titleEvent.id, authorizeEvent.id);
    assert.equal(JSON.parse(titleEvent.detail_json).title, granted.body.titleAuditSnapshot.title);
    assert.equal(JSON.parse(titleEvent.detail_json).titleHash, granted.body.titleAuditSnapshot.titleHash);
  } finally { f.close(); }
});

test("P1 regression: legacy authorization cleanup is exact-book scoped for the same memory revision", async () => {
  const f = fixture();
  try {
    await createBook(f, "book-one", "第一本");
    await createBook(f, "book-two", "第二本");
    const memory = await confirmMemory(f);
    const authorize = async (bookId, creditLabel) => {
      const detail = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
      return f.call("POST", `/v2-labs/books/${bookId}/contribution-grants/${memory.memoryId}`,
        { ...grantBody(memory, f.api), creditLabel }, {
          ...f.headers.a, "if-match": authorizationToken(detail, bookId), "if-none-match": "*"
        });
    };
    const first = await authorize("book-one", "第一本署名");
    const second = await authorize("book-two", "第二本署名");
    for (const event of f.api.db.prepare(`SELECT id,detail_json FROM book_events
      WHERE event_type='BOOK_MEMORY.AUTHORIZE'`).all()) {
      const detail = JSON.parse(event.detail_json);
      delete detail.grantId;
      f.api.db.prepare("UPDATE book_events SET detail_json=? WHERE id=?").run(JSON.stringify(detail), event.id);
    }

    const grant = f.api.db.prepare("SELECT * FROM book_contribution_grants WHERE id=?").get(first.body.grantId);
    const withdrawn = await f.call("POST",
      `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}/withdrawals`, {}, {
        ...f.headers.a, "if-match": f.api.grantWithdrawalEtag(grant, f.api.currentBook("book-one"))
      });
    f.api.processGrantCleanup(withdrawn.body.withdrawalId, CLEANUP_SECRET);

    assert.equal(f.api.db.prepare(`SELECT detail_json FROM book_events
      WHERE book_id='book-one' AND event_type='BOOK_MEMORY.AUTHORIZE'`).get().detail_json, "{}");
    const otherDetail = f.api.db.prepare(`SELECT detail_json FROM book_events
      WHERE book_id='book-two' AND event_type='BOOK_MEMORY.AUTHORIZE'`).get().detail_json;
    assert.equal(JSON.parse(otherDetail).creditLabel, "第二本署名");
    assert.equal(f.api.db.prepare("SELECT status FROM book_contribution_grants WHERE id=?")
      .get(second.body.grantId).status, "active");
  } finally { f.close(); }
});

test("P1 regression: grant cleanup survives checkpoint failure and removes book-derived content bytes before complete", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-book-grant-cleanup-retry-"));
  const database = path.join(directory, "book-lab.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let f = fixture({ database });
  const credit = "仅书内署名ZX7";
  const copiedText = "仅书稿派生内容ZX7";
  let withdrawalId;
  let grantId;
  try {
    await createBook(f);
    const memory = await confirmMemory(f, "photo-a", f.headers.a, "源Memory仍应保留");
    const granted = await f.call("POST", `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}`,
      { ...grantBody(memory, f.api), creditLabel: credit }, {
        ...f.headers.a, "if-match": authorizationToken(memory.detail, "book-one"), "if-none-match": "*"
      });
    grantId = granted.body.grantId;
    const head = f.api.currentBook("book-one");
    f.api.db.prepare("UPDATE book_draft_versions SET pages_json=? WHERE id=?")
      .run(JSON.stringify([{ pageId: "page-secret", grantId, copiedText, authorCredit: credit }]), head.draft_id);
    const grant = f.api.db.prepare("SELECT * FROM book_contribution_grants WHERE id=?").get(grantId);
    const withdrawn = await f.call("POST",
      `/v2-labs/books/book-one/contribution-grants/${memory.memoryId}/withdrawals`, {}, {
        ...f.headers.a, "if-match": f.api.grantWithdrawalEtag(grant, f.api.currentBook("book-one"))
      });
    withdrawalId = withdrawn.body.withdrawalId;
    assert.equal(withdrawn.body.purgeStatus, "queued");
    assert.deepEqual(f.api.draftDto(f.api.currentBook("book-one")).pages, []);

    const blocker = new DatabaseSync(database, { readOnly: true });
    blocker.exec("BEGIN");
    blocker.prepare("SELECT pages_json FROM book_draft_versions").all();
    f.api.db.exec("PRAGMA busy_timeout=1");
    assert.throws(() => f.api.processGrantCleanup(withdrawalId, CLEANUP_SECRET), /cleanup_retry_required/);
    assert.equal(f.api.db.prepare("SELECT purge_status FROM book_grant_withdrawal_receipts WHERE id=?")
      .get(withdrawalId).purge_status, "retrying");
    assert.equal(f.api.pendingGrantCleanup(CLEANUP_SECRET).length, 1);
    blocker.exec("ROLLBACK");
    blocker.close();
  } finally { f.close(); }

  f = fixture({ database });
  try {
    assert.equal(f.api.pendingGrantCleanup(CLEANUP_SECRET)[0].withdrawalId, withdrawalId);
    const complete = f.api.processGrantCleanup(withdrawalId, CLEANUP_SECRET);
    assert.equal(complete.purgeStatus, "complete");
    assert.deepEqual(f.api.processGrantCleanup(withdrawalId, CLEANUP_SECRET), complete);
    assert.equal(f.api.db.prepare("SELECT status FROM book_contribution_grants WHERE id=?").get(grantId).status,
      "withdrawn");
    assert.ok(f.api.db.prepare("SELECT pages_json FROM book_draft_versions").all()
      .every((row) => !row.pages_json.includes(copiedText) && !row.pages_json.includes(credit)));
  } finally { f.close(); }

  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${database}${suffix}`;
    if (!existsSync(filename)) continue;
    const bytes = readFileSync(filename);
    for (const value of [copiedText, credit]) {
      assert.equal(bytes.includes(Buffer.from(value)), false, `${suffix || "db"}:${value}`);
    }
  }
  if (existsSync(`${database}-wal`)) assert.equal(statSync(`${database}-wal`).size, 0);
});

test("BOOK.EDIT_TITLE appends an immutable draft and real title audit used by later grants", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const originalMemory = await confirmMemory(f, "photo-a", f.headers.a, "标题修改前授权的原话");
    const originalGrant = await authorizeMemory(f, originalMemory);
    const originalSnapshot = structuredClone(originalGrant.body.titleAuditSnapshot);
    const before = f.api.currentBook("book-one");
    const originalNotice = f.api.currentBookNotice;
    f.api.currentBookNotice = { version: "later-notice", hash: sha256("later-notice") };
    const noticeDrift = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title",
      { title: "notice drift must fail" }, { ...f.headers.owner,
        "if-match": f.api.bookResponseHeaders(before)["x-unseen-book-etag"],
        "idempotency-key": "unplaced-grant-notice-drift-key" });
    assert.equal(noticeDrift.body.error.code, "book_not_editable");
    f.api.currentBookNotice = originalNotice;
    const originalPlacement = f.core.photos.get("photo-a").provenance.placementRevisionId;
    f.core.photos.get("photo-a").provenance.placementRevisionId = "later-placement";
    const sourceDrift = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title",
      { title: "source drift must fail" }, { ...f.headers.owner,
        "if-match": f.api.bookResponseHeaders(before)["x-unseen-book-etag"],
        "idempotency-key": "unplaced-grant-source-drift-key" });
    assert.equal(sourceDrift.body.error.code, "book_not_editable");
    f.core.photos.get("photo-a").provenance.placementRevisionId = originalPlacement;
    f.api.db.prepare(`UPDATE book_draft_versions SET status='preview_ready',preview_worker_input_hash='title-old-input'
      WHERE id=?`).run(before.draft_id);
    f.api.db.prepare(`INSERT INTO book_render_jobs(id,book_id,status,version,input_hash,updated_at)
      VALUES('title-render','book-one','queued',1,'title-old-input',?)`).run(new Date().toISOString());
    const open = await f.call("GET", "/v2-labs/owner/spaces/space-book/books/book-one/draft", {}, f.headers.owner);
    const oldRow = { ...f.api.db.prepare("SELECT * FROM book_draft_versions WHERE id=?").get(open.body.draftVersionId) };
    const headers = { ...f.headers.owner, "if-match": open.headers["x-unseen-book-etag"],
      "idempotency-key": "fixed-title-edit-key" };
    const invalid = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title",
      { title: "", extra: true }, { ...headers, "idempotency-key": "invalid-title-key" });
    assert.equal(invalid.body.error.code, "title_invalid");
    const body = { title: "改过标题的那一天" };
    const edited = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title", body, headers);
    assert.equal(edited.status, 200);
    assert.equal(edited.body.title, body.title);
    assert.equal(edited.body.status, "editing");
    assert.equal(edited.body.version, open.body.version + 1);
    assert.equal(edited.body.staleReason, null);
    const current = f.api.currentBook("book-one");
    assert.equal(current.version, before.version + 1);
    assert.equal(current.parent_version_id, open.body.draftVersionId);
    assert.deepEqual({ ...f.api.db.prepare("SELECT * FROM book_draft_versions WHERE id=?")
      .get(open.body.draftVersionId) }, oldRow);
    assert.equal(f.api.db.prepare("SELECT status FROM book_render_jobs WHERE id='title-render'").get().status,
      "cancelled");
    const event = f.api.db.prepare(`SELECT * FROM book_events WHERE book_id='book-one'
      AND event_type='BOOK.EDIT_TITLE'`).get();
    assert.deepEqual(JSON.parse(event.detail_json), { title: body.title, titleHash: sha256(body.title) });
    assert.equal(event.previous_event_id, f.api.db.prepare(`SELECT id FROM book_events
      WHERE book_id='book-one' AND event_type='BOOK_MEMORY.AUTHORIZE'`).get().id);
    assert.deepEqual(JSON.parse(f.api.db.prepare("SELECT title_audit_snapshot_json FROM book_contribution_grants WHERE id=?")
      .get(originalGrant.body.grantId).title_audit_snapshot_json), originalSnapshot);

    const memory = await confirmMemory(f, "photo-b", f.headers.b, "标题修改后授权的原话");
    const grant = await authorizeMemory(f, memory, "book-one", f.headers.b);
    assert.equal(grant.body.titleAuditSnapshot.titleEventId, event.id);
    assert.equal(grant.body.titleAuditSnapshot.title, body.title);
    assert.equal(grant.body.titleAuditSnapshot.capturedAt, event.created_at);

    assert.deepEqual(await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title", body, headers),
      edited);
    const changed = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title",
      { title: "同 key 的另一个标题" }, headers);
    assert.equal(changed.body.error.code, "idempotency_key_reused");
    const otherPrincipal = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title", body,
      { ...f.headers.member, "if-match": headers["if-match"], "idempotency-key": headers["idempotency-key"] });
    assert.equal(otherPrincipal.body.error.code, "authorization_changed");
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }
});

test("BOOK.REMOVE_PAGE removes only the target, accepts an empty draft, and binds pageVersion to draftVersionId", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const firstMemory = await confirmMemory(f, "photo-a", f.headers.a, "第一页原话");
    const secondMemory = await confirmMemory(f, "photo-b", f.headers.b, "第二页原话");
    const firstGrant = await authorizeMemory(f, firstMemory, "book-one", f.headers.a, "甲");
    const secondGrant = await authorizeMemory(f, secondMemory, "book-one", f.headers.b, "乙");
    const firstPage = memoryPage(f, firstMemory, firstGrant, { pageId: "page-one", index: 1 });
    const secondPage = memoryPage(f, secondMemory, secondGrant,
      { pageId: "page-two", index: 2, displayPhotoId: "photo-b" });
    const head = installPages(f, [firstPage, secondPage],
      { status: "preview_ready", previewWorkerInputHash: "remove-old-input" });
    f.api.db.prepare(`INSERT INTO book_render_jobs(id,book_id,status,version,input_hash,updated_at)
      VALUES('remove-render','book-one','queued',1,'remove-old-input',?)`).run(new Date().toISOString());
    const oldRow = { ...f.api.db.prepare("SELECT * FROM book_draft_versions WHERE id=?").get(head.draft_id) };
    const headers = { ...f.headers.owner, "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"],
      "idempotency-key": "fixed-remove-page-key" };
    const body = { pageVersion: head.draft_id };
    const removed = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/removals", body, headers);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.pages, [{ ...secondPage, index: 1 }]);
    assert.equal(removed.body.status, "editing");
    assert.equal(removed.body.staleReason, null);
    assert.equal(removed.body.grantSetHash, head.grant_set_hash);
    assert.deepEqual({ ...f.api.db.prepare("SELECT * FROM book_draft_versions WHERE id=?").get(head.draft_id) }, oldRow);
    assert.equal(f.api.db.prepare("SELECT status FROM book_render_jobs WHERE id='remove-render'").get().status,
      "cancelled");
    assert.deepEqual(await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/removals", body, headers), removed);
    const changedPath = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-two/removals", body, headers);
    assert.equal(changedPath.body.error.code, "idempotency_key_reused");
    const changed = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/removals",
      { pageVersion: removed.body.draftVersionId }, headers);
    assert.equal(changed.body.error.code, "idempotency_key_reused");

    const current = f.api.currentBook("book-one");
    const currentHeaders = { ...f.headers.owner,
      "if-match": f.api.bookResponseHeaders(current)["x-unseen-book-etag"] };
    const stalePage = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-two/removals", body, currentHeaders);
    assert.equal(stalePage.body.error.code, "version_conflict");
    const staleCas = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-two/removals",
      { pageVersion: current.draft_id }, { ...f.headers.owner, "if-match": headers["if-match"] });
    assert.equal(staleCas.body.error.code, "version_conflict");
    const missing = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/not-a-page/removals",
      { pageVersion: current.draft_id }, currentHeaders);
    assert.equal(missing.body.error.code, "page_not_found");
    const empty = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-two/removals",
      { pageVersion: current.draft_id }, currentHeaders);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.pages, []);
    assert.equal(empty.body.status, "editing");
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }
});

test("BOOK.REPLACE_PAGE_PHOTO changes displayPhotoId only and exact replay ignores later photo drift", async () => {
  const f = fixture();
  try {
    addDisplayPhoto(f);
    await createBook(f);
    const memory = await confirmMemory(f);
    const grant = await authorizeMemory(f, memory);
    const page = memoryPage(f, memory, grant);
    const head = installPages(f, [page]);
    const oldRow = { ...f.api.db.prepare("SELECT * FROM book_draft_versions WHERE id=?").get(head.draft_id) };
    const headers = { ...f.headers.owner, "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"],
      "idempotency-key": "fixed-replace-photo-key" };
    const body = { displayPhotoId: "photo-display", pageVersion: head.draft_id };
    const missing = await f.call("PUT",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/not-a-page/photo", body,
      { ...headers, "idempotency-key": "missing-replace-page-key" });
    assert.equal(missing.body.error.code, "version_conflict");
    const sourceAttempt = await f.call("PUT",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/photo",
      { ...body, sourcePhotoId: "photo-display" }, { ...headers, "idempotency-key": "source-change-key" });
    assert.equal(sourceAttempt.body.error.code, "source_photo_immutable");
    const replaced = await f.call("PUT",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/photo", body, headers);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.pages[0].displayPhotoId, "photo-display");
    const { displayPhotoId: oldDisplay, ...oldSource } = page;
    const { displayPhotoId: newDisplay, ...newSource } = replaced.body.pages[0];
    assert.equal(oldDisplay, "photo-a");
    assert.equal(newDisplay, "photo-display");
    assert.deepEqual(newSource, oldSource);
    assert.equal(replaced.body.grantSetHash, head.grant_set_hash);
    assert.deepEqual({ ...f.api.db.prepare("SELECT * FROM book_draft_versions WHERE id=?").get(head.draft_id) }, oldRow);

    f.core.photos.get("photo-display").withdrawn = true;
    f.core.photos.get("photo-a").provenance.placementRevisionId = "later-source-drift";
    assert.deepEqual(await f.call("PUT",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/photo", body, headers), replaced);
    const changed = await f.call("PUT",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/photo",
      { ...body, displayPhotoId: "photo-b" }, headers);
    assert.equal(changed.body.error.code, "idempotency_key_reused");
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }
});

test("three owner edits are BOLA-safe and revalidate the canonical owner inside each transaction", async () => {
  const routes = [
    ["PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title", { title: "新标题" }],
    ["POST", "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/removals", null],
    ["PUT", "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/photo", null]
  ];
  for (const [method, route, routeBody] of routes) {
    const f = fixture();
    try {
      addDisplayPhoto(f);
      await createBook(f);
      const memory = await confirmMemory(f);
      const grant = await authorizeMemory(f, memory);
      const head = installPages(f, [memoryPage(f, memory, grant)]);
      const body = routeBody ?? (method === "POST" ? { pageVersion: head.draft_id }
        : { displayPhotoId: "photo-display", pageVersion: head.draft_id });
      const etag = f.api.bookResponseHeaders(head)["x-unseen-book-etag"];
      const count = f.api.db.prepare("SELECT count(*) count FROM book_draft_versions").get().count;
      for (const auth of [f.headers.member, f.headers.receiptA]) {
        const denied = await f.call(method, route, body, { ...auth, "if-match": etag });
        assert.equal(denied.body.error.code, "authorization_changed");
      }
      const wrongSpace = await f.call(method, route.replace("space-book", "other-space"), body,
        { ...f.headers.owner, "if-match": etag });
      assert.equal(wrongSpace.body.error.code, "authorization_changed");
      const wrongBook = await f.call(method, route.replace("book-one", "missing-book"), body,
        { ...f.headers.owner, "if-match": etag });
      assert.equal(wrongBook.body.error.code, "authorization_changed");
      assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_draft_versions").get().count, count);

      f.core.beforeOwnerRevalidate = (core) => {
        core.beforeOwnerRevalidate = null;
        core.spaces.get("space-book").version += 1;
      };
      const drift = await f.call(method, route, body, { ...f.headers.owner, "if-match": etag });
      assert.equal(drift.body.error.code, "authorization_changed");
      assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_draft_versions").get().count, count);
      assert.equal(f.core.writeCount, 0);
    } finally { f.close(); }
  }
});

test("EDIT_TITLE ordinary replay precedes later owner and draft drift for the exact original principal/body", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const open = await f.call("GET", "/v2-labs/owner/spaces/space-book/books/book-one/draft", {}, f.headers.owner);
    const headers = { ...f.headers.owner, "if-match": open.headers["x-unseen-book-etag"],
      "idempotency-key": "title-replay-before-drift-key" };
    const body = { title: "漂移后仍可重放" };
    const edited = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title", body, headers);
    assert.equal(edited.status, 200);
    f.core.spaces.get("space-book").version += 1;
    f.api.db.prepare("UPDATE book_draft_versions SET status='frozen' WHERE id=?")
      .run(edited.body.draftVersionId);
    assert.deepEqual(await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title", body, headers),
      edited);
    const changed = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title",
      { title: "不同正文" }, headers);
    assert.equal(changed.body.error.code, "idempotency_key_reused");
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }
});

test("display replacement rejects wrong-space, deleted, withdrawn, and not-ready Core photos with zero writes", async () => {
  const f = fixture();
  try {
    addDisplayPhoto(f);
    await createBook(f);
    const memory = await confirmMemory(f);
    const grant = await authorizeMemory(f, memory);
    const head = installPages(f, [memoryPage(f, memory, grant)]);
    const etag = f.api.bookResponseHeaders(head)["x-unseen-book-etag"];
    const original = structuredClone(f.core.photos.get("photo-display"));
    for (const [label, mutate] of [
      ["wrong-space", (photo) => { photo.provenance.spaceId = "other-space"; }],
      ["deleted", (photo) => { photo.deleted = true; photo.deletedAt = "2026-08-14T01:00:00.000Z"; }],
      ["withdrawn", (photo) => { photo.withdrawn = true; }],
      ["not-ready", (photo) => { photo.completed = false; }],
      ["not-visible", (photo) => { photo.photoContentState = "hidden"; }],
      ["l3-disabled", (photo) => { photo.l3Enabled = false; }]
    ]) {
      const candidate = structuredClone(original);
      mutate(candidate);
      f.core.photos.set("photo-display", candidate);
      const failed = await f.call("PUT",
        "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/photo",
        { displayPhotoId: "photo-display", pageVersion: head.draft_id }, {
          ...f.headers.owner, "if-match": etag, "idempotency-key": `display-${label}-key`
        });
      assert.equal(failed.body.error.code, "display_photo_not_eligible", label);
      assert.equal(f.api.currentBook("book-one").draft_id, head.draft_id, label);
    }
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }
});

test("owner edits fail closed on grant, notice, and source drift without mutating immutable drafts", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const memory = await confirmMemory(f);
    const granted = await authorizeMemory(f, memory);
    const page = memoryPage(f, memory, granted);
    const head = installPages(f, [page]);
    const etag = f.api.bookResponseHeaders(head)["x-unseen-book-etag"];
    const count = f.api.db.prepare("SELECT count(*) count FROM book_draft_versions").get().count;
    const grant = f.api.db.prepare("SELECT * FROM book_contribution_grants WHERE id=?").get(granted.body.grantId);
    const cases = [
      ["grant", () => f.api.db.prepare("UPDATE book_contribution_grants SET status='withdrawal_pending' WHERE id=?")
        .run(grant.id), () => f.api.db.prepare("UPDATE book_contribution_grants SET status='active' WHERE id=?")
        .run(grant.id)],
      ["notice", () => { f.api.currentBookNotice = { version: "drift", hash: sha256("drift") }; },
        () => { f.api.currentBookNotice = { version: grant.notice_version, hash: grant.notice_hash }; }],
      ["source", () => { f.core.photos.get("photo-a").provenance.placementRevisionId = "drifted-placement"; },
        () => { f.core.photos.get("photo-a").provenance.placementRevisionId = page.sourceProvenance.placementRevisionId; }],
      ["display", () => { f.core.photos.get("photo-a").photoContentState = "hidden"; },
        () => { f.core.photos.get("photo-a").photoContentState = "visible"; }]
    ];
    for (const [label, drift, restore] of cases) {
      drift();
      const failed = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title",
        { title: `不会保存-${label}` }, { ...f.headers.owner, "if-match": etag,
          "idempotency-key": `drift-${label}-key` });
      assert.equal(failed.body.error.code, "book_not_editable", label);
      assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_draft_versions").get().count, count, label);
      restore();
    }
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }
});

test("title, display replacement, and page removal persist across restart", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-book-edits-restart-"));
  const database = path.join(directory, "book-lab.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let f = fixture({ database });
  let replaceResponse;
  let replaceRequest;
  try {
    addDisplayPhoto(f);
    await createBook(f);
    const firstMemory = await confirmMemory(f, "photo-a", f.headers.a, "重启后保留页");
    const secondMemory = await confirmMemory(f, "photo-b", f.headers.b, "重启后删除页");
    const firstGrant = await authorizeMemory(f, firstMemory, "book-one", f.headers.a);
    const secondGrant = await authorizeMemory(f, secondMemory, "book-one", f.headers.b);
    let head = installPages(f, [memoryPage(f, firstMemory, firstGrant),
      memoryPage(f, secondMemory, secondGrant, { pageId: "page-two", index: 2, displayPhotoId: "photo-b" })]);
    const title = await f.call("PATCH", "/v2-labs/owner/spaces/space-book/books/book-one/title",
      { title: "重启后仍在的标题" }, { ...f.headers.owner,
        "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"] });
    head = f.api.currentBook("book-one");
    replaceRequest = { body: { displayPhotoId: "photo-display", pageVersion: head.draft_id },
      headers: { ...f.headers.owner, "if-match": title.headers["x-unseen-book-etag"],
        "idempotency-key": "restart-replace-key" } };
    replaceResponse = await f.call("PUT",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/photo",
      replaceRequest.body, replaceRequest.headers);
    head = f.api.currentBook("book-one");
    const removed = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-two/removals",
      { pageVersion: head.draft_id }, { ...f.headers.owner,
        "if-match": replaceResponse.headers["x-unseen-book-etag"] });
    assert.equal(removed.status, 200);
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }

  f = fixture({ database });
  try {
    addDisplayPhoto(f);
    const draft = await f.call("GET", "/v2-labs/owner/spaces/space-book/books/book-one/draft", {}, f.headers.owner);
    assert.equal(draft.status, 200);
    assert.equal(draft.body.title, "重启后仍在的标题");
    assert.equal(draft.body.pages.length, 1);
    assert.equal(draft.body.pages[0].pageId, "page-one");
    assert.equal(draft.body.pages[0].displayPhotoId, "photo-display");
    f.core.photos.get("photo-display").withdrawn = true;
    assert.deepEqual(await f.call("PUT",
      "/v2-labs/owner/spaces/space-book/books/book-one/draft/pages/page-one/photo",
      replaceRequest.body, replaceRequest.headers), replaceResponse);
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }
});

test("BOOK.GENERATE_PREVIEW queues an immutable exact renderer snapshot and completes through a worker receipt", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const memory = await confirmMemory(f, "photo-a", f.headers.a, "预览必须保留用户原话。");
    const grant = await authorizeMemory(f, memory);
    const head = installPages(f, previewPages(f, memory, grant));
    const headers = { ...f.headers.owner, "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"],
      "if-none-match": "*", "idempotency-key": "preview-exact-replay-key" };
    const body = { renderJobId: "preview-job-one", draftVersionId: head.draft_id,
      grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0" };
    const queued = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs", body, headers);
    assert.equal(queued.status, 200);
    assert.equal(queued.body.status, "queued");
    assert.equal(f.api.currentBook("book-one").draft_status, "preview_queued");
    assert.deepEqual(await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs", body, headers), queued);
    const changed = await f.call("POST",
      "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs", { ...body, layoutProfile: "unknown" }, headers);
    assert.equal(changed.body.error.code, "preview_input_changed");
    const work = f.api.pendingPreviewJobs(RENDER_SECRET);
    assert.equal(work.length, 1);
    const claimed = await claimPreview(f, work[0]);
    assert.equal(claimed.input.manifest.authorizedMemoryTexts.length, 12);
    assert.equal(claimed.input.manifest.authorizedMemoryTexts[0].originalUserText,
      "预览必须保留用户原话。" );
    assert.equal(claimed.input.manifest.versionId, head.draft_id);
    assert.equal(claimed.input.manifest.authorizationSnapshotHash, head.grant_set_hash);
    assert.throws(() => { claimed.input.manifest.title = "篡改"; });
    assert.deepEqual(await f.api.processPreview(work[0], RENDER_SECRET), claimed);
    const request = { renderJobId: work[0].renderJobId, jobVersion: claimed.version,
      inputHash: work[0].inputHash, attempt: work[0].attempt };
    const ready = await f.api.completePreview(request, renderClaimInput(claimed.input), RENDER_SECRET);
    assert.equal(ready.status, "ready");
    assert.deepEqual(await f.api.completePreview(request, renderClaimInput(claimed.input), RENDER_SECRET), ready);
    assert.deepEqual(await f.api.processPreview(work[0], RENDER_SECRET), ready);
    await assert.rejects(() => f.api.completePreview({ ...request, inputHash: sha256("forged") },
      renderClaimInput(claimed.input), RENDER_SECRET));
    assert.equal(f.api.currentBook("book-one").draft_status, "preview_ready");
    const artifact = f.api.db.prepare("SELECT * FROM book_preview_artifacts WHERE render_job_id=?")
      .get("preview-job-one");
    assert.equal(artifact.page_count, 12);
    assert.equal(artifact.html_hash, sha256(Buffer.from(artifact.html_blob)));
    assert.equal(ready.manifestHash, claimed.input.manifest.manifestHash);
    assert.equal(f.core.writeCount, 0);
  } finally { f.close(); }
});

test("preview rejects stale CAS and collisions, and discards a late render after draft invalidation", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const memory = await confirmMemory(f);
    const grant = await authorizeMemory(f, memory);
    const head = installPages(f, previewPages(f, memory, grant));
    const pathValue = "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs";
    const body = { renderJobId: "late-preview-job", draftVersionId: head.draft_id,
      grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0" };
    const stale = await f.call("POST", pathValue, body, { ...f.headers.owner, "if-match": "stale",
      "if-none-match": "*" });
    assert.equal(stale.body.error.code, "version_conflict");
    const queued = await f.call("POST", pathValue, body, { ...f.headers.owner,
      "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"], "if-none-match": "*" });
    assert.equal(queued.status, 200);
    const collision = await f.call("POST", pathValue, { ...body, renderJobId: "late-preview-job-two" }, {
      ...f.headers.owner, "if-match": queued.headers["x-unseen-book-etag"], "if-none-match": "*" });
    assert.equal(collision.body.error.code, "book_not_editable");
    const work = f.api.pendingPreviewJobs(RENDER_SECRET)[0];
    const claimed = await claimPreview(f, work);
    f.core.photos.get("photo-a").provenance.placementRevisionId = "placement-book-drift";
    const discarded = await f.api.completePreview({ renderJobId: work.renderJobId, jobVersion: claimed.version,
      inputHash: work.inputHash, attempt: work.attempt }, renderClaimInput(claimed.input, "late-preview-html"),
    RENDER_SECRET);
    assert.equal(discarded.status, "discarded_stale");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_preview_artifacts").get().count, 0);
    assert.equal(f.api.db.prepare("SELECT status FROM book_render_jobs WHERE id=?").get(body.renderJobId).status,
      "cancelled");
    assert.equal(f.api.db.prepare("SELECT status FROM book_draft_versions WHERE id=?")
      .get(head.draft_id).status, "stale");
  } finally { f.close(); }
});

test("preview accepts delayed Core asset reads and fails closed on owner or asset drift", async () => {
  const setup = async () => {
    const f = fixture();
    await createBook(f);
    const memory = await confirmMemory(f);
    const grant = await authorizeMemory(f, memory);
    const head = installPages(f, previewPages(f, memory, grant));
    const request = () => f.call("POST", "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs", {
      renderJobId: "async-preview-job", draftVersionId: head.draft_id,
      grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0"
    }, { ...f.headers.owner, "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"],
      "if-none-match": "*" });
    return { f, request };
  };

  const delayed = await setup();
  try {
    const read = delayed.f.core.readDisplayPhotoForOwner.bind(delayed.f.core);
    let reads = 0;
    delayed.f.core.readDisplayPhotoForOwner = async (...args) => {
      reads += 1;
      await Promise.resolve();
      return read(...args);
    };
    const queued = await delayed.request();
    assert.equal(queued.status, 200);
    assert.equal(queued.body.status, "queued");
    assert.ok(reads >= 2);
    assert.equal(delayed.f.core.writeCount, 0);
  } finally { delayed.f.close(); }

  const revoked = await setup();
  try {
    const read = revoked.f.core.readDisplayPhotoForOwner.bind(revoked.f.core);
    revoked.f.core.readDisplayPhotoForOwner = async (...args) => {
      const value = read(...args);
      await Promise.resolve();
      revoked.f.core.accountSessions.get("owner-token").version += 1;
      return value;
    };
    const rejected = await revoked.request();
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "authorization_changed");
    assert.equal(revoked.f.api.db.prepare("SELECT count(*) count FROM book_render_jobs").get().count, 0);
    assert.equal(revoked.f.core.writeCount, 0);
  } finally { revoked.f.close(); }

  const drifted = await setup();
  try {
    const read = drifted.f.core.readDisplayPhotoForOwner.bind(drifted.f.core);
    let reads = 0;
    drifted.f.core.readDisplayPhotoForOwner = async (...args) => {
      const value = read(...args);
      await Promise.resolve();
      reads += 1;
      if (reads === 1) {
        const next = Buffer.from("async-derivative-drift");
        const photo = drifted.f.core.photos.get("photo-a");
        photo.renderAsset.bytesBase64 = next.toString("base64");
        photo.renderAsset.contentHash = sha256(next);
      }
      return value;
    };
    const rejected = await drifted.request();
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "preview_input_changed");
    assert.equal(drifted.f.api.db.prepare("SELECT count(*) count FROM book_render_jobs").get().count, 0);
    assert.equal(drifted.f.core.writeCount, 0);
  } finally { drifted.f.close(); }
});

test("display derivative drift after claim discards the job and makes the draft retryable stale", async () => {
  const f = fixture();
  try {
    await createBook(f);
    addDisplayPhoto(f);
    const memory = await confirmMemory(f);
    const grant = await authorizeMemory(f, memory);
    const pages = previewPages(f, memory, grant).map((page) => ({ ...page, displayPhotoId: "photo-display" }));
    const head = installPages(f, pages);
    await f.call("POST", "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs",
      { renderJobId: "display-drift-preview", draftVersionId: head.draft_id,
        grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0" }, { ...f.headers.owner,
        "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"], "if-none-match": "*" });
    const work = f.api.pendingPreviewJobs(RENDER_SECRET)[0];
    const claimed = await claimPreview(f, work);
    const replacement = Buffer.from("replacement-render-derivative");
    Object.assign(f.core.photos.get("photo-display").renderAsset, {
      bytesBase64: replacement.toString("base64"), contentHash: sha256(replacement)
    });
    const result = await f.api.completePreview({ renderJobId: work.renderJobId, jobVersion: claimed.version,
      inputHash: work.inputHash, attempt: work.attempt }, renderClaimInput(claimed.input), RENDER_SECRET);
    assert.equal(result.status, "discarded_stale");
    assert.equal(f.api.currentBook("book-one").draft_status, "stale");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_preview_artifacts").get().count, 0);
  } finally { f.close(); }
});

test("a forged renderer equality receipt becomes a durable preview failure", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const memory = await confirmMemory(f);
    const grant = await authorizeMemory(f, memory);
    const head = installPages(f, previewPages(f, memory, grant));
    await f.call("POST", "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs",
      { renderJobId: "forged-receipt-preview", draftVersionId: head.draft_id,
        grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0" }, { ...f.headers.owner,
        "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"], "if-none-match": "*" });
    const work = f.api.pendingPreviewJobs(RENDER_SECRET)[0];
    const claimed = await claimPreview(f, work);
    const output = renderClaimInput(claimed.input);
    output.equality.manifestHash = sha256("forged-manifest");
    const result = await f.api.completePreview({ renderJobId: work.renderJobId, jobVersion: claimed.version,
      inputHash: work.inputHash, attempt: work.attempt }, output, RENDER_SECRET);
    assert.equal(result.status, "failed");
    assert.equal(result.stableError, "artifact_mismatch");
    assert.equal(f.api.currentBook("book-one").draft_status, "preview_failed");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_preview_artifacts").get().count, 0);
  } finally { f.close(); }
});

test("failed previews are recoverable after restart and stale worker claims cannot advance them", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-preview-restart-"));
  const database = path.join(directory, "book-lab.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let f = fixture({ database });
  try {
    await createBook(f);
    const memory = await confirmMemory(f);
    const grant = await authorizeMemory(f, memory);
    const head = installPages(f, previewPages(f, memory, grant));
    const queued = await f.call("POST", "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs",
      { renderJobId: "restart-preview-job", draftVersionId: head.draft_id,
        grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0" }, {
        ...f.headers.owner, "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"],
        "if-none-match": "*" });
    assert.equal(queued.status, 200);
    const work = f.api.pendingPreviewJobs(RENDER_SECRET)[0];
    const forged = { ...work, inputHash: sha256("forged") };
    await assert.rejects(() => f.api.processPreview(forged, RENDER_SECRET));
    assert.equal(f.api.db.prepare("SELECT status FROM book_render_jobs WHERE id=?").get(work.renderJobId).status,
      "queued");
  } finally { f.close(); }
  f = fixture({ database });
  try {
    const work = f.api.pendingPreviewJobs(RENDER_SECRET)[0];
    const claimed = await claimPreview(f, work);
    const completion = { renderJobId: work.renderJobId, jobVersion: claimed.version,
      inputHash: work.inputHash, attempt: work.attempt };
    const failed = await f.api.completePreview(completion, { status: "failed", stableError: "render_failed" },
      RENDER_SECRET);
    assert.equal(failed.status, "failed");
    assert.equal(failed.stableError, "render_failed");
    const draft = await f.call("GET", "/v2-labs/owner/spaces/space-book/books/book-one/draft", {}, f.headers.owner);
    assert.equal(draft.body.status, "preview_failed");
    assert.equal(draft.body.recoverableRenderJobs[0].status, "failed");
    assert.deepEqual(await f.api.completePreview(completion, { status: "failed", stableError: "render_failed" },
      RENDER_SECRET), failed);
  } finally { f.close(); }
});

test("Memory withdrawal removes persisted preview text and HTML before cleanup reports complete", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const answer = "即将撤回的预览秘密句。";
    const memory = await confirmMemory(f, "photo-a", f.headers.a, answer);
    const grant = await authorizeMemory(f, memory);
    const head = installPages(f, previewPages(f, memory, grant));
    await f.call("POST", "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs",
      { renderJobId: "withdraw-preview-job", draftVersionId: head.draft_id,
        grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0" }, {
        ...f.headers.owner, "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"],
        "if-none-match": "*" });
    await completeReadyPreview(f, f.api.pendingPreviewJobs(RENDER_SECRET)[0], "withdraw-preview-html");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_preview_artifacts").get().count, 1);
    const detail = await f.call("GET", `/v2-labs/memories/${memory.memoryId}`, {}, f.headers.a);
    const withdrawn = await f.call("POST", `/v2-labs/memories/${memory.memoryId}/withdrawals`,
      { interviewIfMatchVersion: detail.body.memory.interviewVersion }, {
        ...f.headers.a, "if-match": detail.headers["x-unseen-memory-etag"] });
    f.api.processCleanup(withdrawn.body.withdrawalId, CLEANUP_SECRET);
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_preview_artifacts").get().count, 0);
    const row = f.api.db.prepare("SELECT * FROM book_render_jobs WHERE id='withdraw-preview-job'").get();
    assert.equal(row.status, "cancelled");
    assert.equal(row.input_json.includes(answer), false);
    assert.equal(row.manifest_hash, sha256("withdrawn-preview-content"));
  } finally { f.close(); }
});

test("preview fails before queue on unrenderable exact text", async () => {
  const f = fixture();
  try {
    await createBook(f);
    const memory = await confirmMemory(f, "photo-a", f.headers.a, "原".repeat(901));
    const grant = await authorizeMemory(f, memory);
    const head = installPages(f, previewPages(f, memory, grant));
    const rejected = await f.call("POST", "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs",
      { renderJobId: "text-overflow-preview", draftVersionId: head.draft_id,
        grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0" }, { ...f.headers.owner,
        "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"], "if-none-match": "*" });
    assert.equal(rejected.body.error.code, "preview_input_changed");
    assert.equal(f.api.currentBook("book-one").draft_status, "editing");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_render_jobs").get().count, 0);
  } finally { f.close(); }
});

test("preview fails before queue on an unbound or oversized local derivative", async () => {
  for (const [name, mutate] of [
    ["unbound", (asset) => { asset.sourcePhotoContentHash = sha256("wrong-source"); }],
    ["oversized", (asset) => {
      const bytes = Buffer.alloc(256 * 1024 + 1, 1);
      asset.bytesBase64 = bytes.toString("base64");
      asset.contentHash = sha256(bytes);
    }]
  ]) {
    const f = fixture();
    try {
      await createBook(f);
      const memory = await confirmMemory(f);
      const grant = await authorizeMemory(f, memory);
      const head = installPages(f, previewPages(f, memory, grant));
      mutate(f.core.photos.get("photo-a").renderAsset);
      const rejected = await f.call("POST", "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs",
        { renderJobId: `${name}-derivative-preview`, draftVersionId: head.draft_id,
          grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0" }, { ...f.headers.owner,
          "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"], "if-none-match": "*" });
      assert.equal(rejected.body.error.code, "preview_input_changed");
      assert.equal(f.api.currentBook("book-one").draft_status, "editing");
      assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_render_jobs").get().count, 0);
    } finally { f.close(); }
  }
});

test("preview provenance excludes a ready question the contributor later skipped", async () => {
  const f = fixture();
  try {
    await createBook(f);
    await f.call("POST", "/v2-labs/memories/photos/photo-a/question-jobs", {
      noticeVersion: f.api.currentNotice.version, noticeHash: f.api.currentNotice.hash,
      photoContentHash: f.core.photos.get("photo-a").provenance.photoContentHash,
      placementSnapshotHash: f.core.photos.get("photo-a").provenance.placementSnapshotHash
    }, { ...f.headers.a, "if-none-match": "*" });
    const firstReady = f.api.processQuestion(f.api.pendingQuestionJobs(WORKER_SECRET)[0], WORKER_SECRET);
    const firstQuestionId = firstReady.questionProvenance.questionId;
    const workspace = await f.call("GET", "/v2-labs/memories/photos/photo-a", {}, f.headers.a);
    const skipped = await f.call("POST", "/v2-labs/memories/photos/photo-a/skip", {}, {
      ...f.headers.a, "if-match": workspace.body.interviewPrecondition.ifMatch });
    const restarted = await f.call("POST", "/v2-labs/memories/photos/photo-a/question-jobs", {
      noticeVersion: f.api.currentNotice.version, noticeHash: f.api.currentNotice.hash,
      photoContentHash: f.core.photos.get("photo-a").provenance.photoContentHash,
      placementSnapshotHash: f.core.photos.get("photo-a").provenance.placementSnapshotHash
    }, { ...f.headers.a, "if-match": skipped.headers["x-unseen-interview-etag"] });
    f.api.processQuestion(f.api.pendingQuestionJobs(WORKER_SECRET)[0], WORKER_SECRET);
    const detail = await f.call("GET", `/v2-labs/memories/${restarted.body.personalMemoryId}`, {}, f.headers.a);
    const answer = "只回答第二次确认的问题。";
    const saved = await f.call("PUT", `/v2-labs/memories/${restarted.body.personalMemoryId}/answer-submissions`, {
      clientSubmissionId: "second-chain-answer", userText: answer, previousSubmissionId: null,
      interviewIfMatchVersion: detail.body.memory.interviewVersion
    }, { ...f.headers.a, "if-match": detail.headers["x-unseen-memory-etag"] });
    const confirmed = await f.call("POST", `/v2-labs/memories/${restarted.body.personalMemoryId}/confirmations`, {
      submissionId: "second-chain-answer", submissionHash: sha256(answer),
      interviewIfMatchVersion: saved.body.memory.interviewVersion
    }, { ...f.headers.a, "if-match": saved.headers["x-unseen-memory-etag"] });
    const memory = { memoryId: restarted.body.personalMemoryId, confirmed };
    const grant = await authorizeMemory(f, memory);
    const head = installPages(f, previewPages(f, memory, grant));
    await f.call("POST", "/v2-labs/owner/spaces/space-book/books/book-one/render-jobs",
      { renderJobId: "second-chain-preview", draftVersionId: head.draft_id,
        grantSetHash: head.grant_set_hash, layoutProfile: "book-lab-v0" }, { ...f.headers.owner,
        "if-match": f.api.bookResponseHeaders(head)["x-unseen-book-etag"], "if-none-match": "*" });
    const claimed = await claimPreview(f, f.api.pendingPreviewJobs(RENDER_SECRET)[0]);
    for (const textValue of claimed.input.manifest.authorizedMemoryTexts) {
      assert.equal(textValue.questionProvenance.length, 1);
      assert.notEqual(textValue.questionProvenance[0].questionId, firstQuestionId);
    }
  } finally { f.close(); }
});
