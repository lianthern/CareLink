import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { validateHeaderValue } from "node:http";
import os from "node:os";
import path from "node:path";
import { BookLabMemoryApi, FixtureCorePort, sha256 } from "../src/index.mjs";

const SECRET = "test-secret-book-version-worker-not-production-0001";

function provenance() {
  const bytes = Buffer.from("version-photo");
  return { spaceId: "space", photoId: "photo", sceneId: "scene", panoramaRevisionId: "panorama",
    placementRevisionId: "placement", nodeId: null, sourcePhotosVersion: 1, yawDegrees: 12,
    capturedAt: "2026-08-14T00:00:00.000Z", authorId: "contributor", photoContentHash: sha256(bytes),
    placementSnapshotHash: sha256("placement") };
}

function fixture({ database = ":memory:" } = {}) {
  const bytes = Buffer.from("version-photo");
  const core = new FixtureCorePort({
    photos: { photo: { photoId: "photo", contributorId: "contributor", completed: true,
      photoContentState: "visible", deleted: false, deletedAt: null, withdrawn: false, l3Enabled: true,
      visibleAnchor: "桌上有一张卡片", provenance: provenance(), renderAsset: { mimeType: "image/jpeg",
        bytesBase64: bytes.toString("base64"), contentHash: sha256(bytes),
        sourcePhotoContentHash: provenance().photoContentHash, sourcePhotosVersion: 1 } } },
    accountSessions: {
      contributor: { sessionId: "contributor-session", contributorId: "contributor", active: true,
        revalidated: true, issuedSessionEpoch: 1, accountSessionEpoch: 1 },
      owner: { sessionId: "owner-session", contributorId: "owner", accountId: "owner-account",
        familyId: "owner-family", version: 1, active: true, revalidated: true, issuedSessionEpoch: 1,
        accountSessionEpoch: 1 }
    },
    accounts: { "owner-account": { accountId: "owner-account", sessionEpoch: 1 } },
    sessionFamilies: { "owner-family": { version: 1, active: true, revalidated: true,
      issuedSessionEpoch: 1 } },
    spaces: { space: { version: 1, ownerAccountId: "owner-account", spaceLifecycle: "active" } },
    events: { event: { eventId: "event", spaceId: "space", active: true } },
    accountViewSessions: { viewer: { sessionId: "account-viewer-session", spaceId: "space",
      sessionActive: true, sessionRevalidated: true, membershipActive: true, viewTaskActive: true,
      issuedSessionEpoch: 1, accountSessionEpoch: 1, version: 1 } },
    externalViewSessions: { external: { sessionId: "external-viewer-session", spaceId: "space",
      sessionActive: true, principalActive: true, grantActive: true, campaignActive: true,
      campaignShared: true, viewTaskActive: true, spaceLifecycle: "active", version: 1 } }
  });
  const api = new BookLabMemoryApi({ core, database, renderWorkerSecret: SECRET,
    etagSecret: "test-secret-version-etag-not-production-0002",
    workerSecret: "test-secret-version-question-not-production-0003",
    cleanupSecret: "test-secret-version-cleanup-not-production-0004" });
  let key = 0;
  const call = (method, path, body = {}, headers = {}) => api.handle({ method, path, body, headers: {
    ...(method === "GET" ? {} : { "idempotency-key": `version-test-key-${++key}` }), ...headers } });
  return { api, core, call, owner: { authorization: "Bearer owner" },
    contributor: { authorization: "Bearer contributor" },
    accountViewer: { authorization: "Bearer viewer" },
    externalViewer: { "x-external-view-session": "external" } };
}

function frozenOutput(claim) {
  const html = safeHtml("frozen");
  const pdf = Buffer.from("%PDF-1.7\nfixture\n");
  const m = claim.input.manifest;
  return { status: "ready", html, htmlHash: sha256(html), pdfBase64: pdf.toString("base64"),
    pdfHash: sha256(pdf), pageCount: m.pages.length, equality: { bookId: m.bookId, versionId: m.versionId,
      title: m.title, manifestHash: m.manifestHash, authorizationSnapshotHash: m.authorizationSnapshotHash,
      authorizedMemoryTextSnapshotHash: m.authorizedMemoryTextSnapshotHash,
      assetSnapshotHash: m.assetSnapshotHash, pageCount: m.pages.length,
      orderedPageIds: m.pages.map((page) => page.pageId),
      orderedSourceIds: m.pages.map((page) => page.sourcePhotoId),
      orderedDisplayPhotoIds: m.pages.map((page) => page.displayPhotoId) } };
}

function safeHtml(label) {
  const image = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>").toString("base64");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
    @page{size:210mm 210mm}@media screen{body{margin:0}}</style></head><body>${label}
    <img src="data:image/svg+xml;base64,${image}" alt="fixture"></body></html>`;
}

function freezeRequest(f, key = "freeze-version-key") {
  const book = f.api.currentBook("book");
  const preview = f.api.db.prepare("SELECT * FROM book_render_jobs WHERE id='preview'").get();
  return { method: "POST", path: "/v2-labs/owner/spaces/space/books/book/versions",
    body: { draftVersionId: book.draft_id, previewHash: preview.preview_hash,
      grantSetHash: book.grant_set_hash, authorizationSnapshotHash: book.grant_set_hash },
    headers: { ...f.owner, "if-match": f.api.bookResponseHeaders(book)["x-unseen-book-etag"],
      "idempotency-key": key } };
}

async function freeze(f, key = undefined, request = freezeRequest(f, key)) {
  return f.api.handle(request);
}

async function readyDraft(f, { previewHtml = safeHtml("preview") } = {}) {
  await f.call("POST", "/v2-labs/owner/spaces/space/books", { bookId: "book", title: "现场回忆",
    eventId: "event" }, { ...f.owner, "if-none-match": "*" });
  const opened = await f.call("GET", "/v2-labs/memories/photos/photo", {}, f.contributor);
  const started = await f.call("POST", "/v2-labs/memories/photos/photo/question-jobs", {
    noticeVersion: f.api.currentNotice.version, noticeHash: f.api.currentNotice.hash,
    photoContentHash: provenance().photoContentHash, placementSnapshotHash: provenance().placementSnapshotHash
  }, { ...f.contributor, "if-none-match": opened.body.interviewPrecondition.ifNoneMatch });
  f.api.processQuestion(f.api.pendingQuestionJobs(f.api.workerSecret)[0], f.api.workerSecret);
  let detail = await f.call("GET", `/v2-labs/memories/${started.body.personalMemoryId}`, {}, f.contributor);
  const answer = "这是用户确认的原话。";
  const saved = await f.call("PUT", `/v2-labs/memories/${started.body.personalMemoryId}/answer-submissions`, {
    clientSubmissionId: "answer", userText: answer, previousSubmissionId: null,
    interviewIfMatchVersion: detail.body.memory.interviewVersion
  }, { ...f.contributor, "if-match": detail.headers["x-unseen-memory-etag"] });
  const confirmed = await f.call("POST", `/v2-labs/memories/${started.body.personalMemoryId}/confirmations`, {
    submissionId: "answer", submissionHash: sha256(answer),
    interviewIfMatchVersion: saved.body.memory.interviewVersion
  }, { ...f.contributor, "if-match": saved.headers["x-unseen-memory-etag"] });
  detail = await f.call("GET", `/v2-labs/memories/${started.body.personalMemoryId}`, {}, f.contributor);
  const token = JSON.parse(detail.headers["x-unseen-book-authorization-etags"]).book;
  const grant = await f.call("POST", `/v2-labs/books/book/contribution-grants/${started.body.personalMemoryId}`, {
    personalMemoryId: started.body.personalMemoryId, memoryRevisionId: confirmed.body.memory.memoryRevisionId,
    confirmedSubmissionHash: confirmed.body.memory.confirmedSubmissionHash, creditLabel: "贡献者",
    audienceScope: "current_live_space_viewers", noticeVersion: f.api.currentBookNotice.version,
    noticeHash: f.api.currentBookNotice.hash
  }, { ...f.contributor, "if-match": token, "if-none-match": "*" });
  let book = f.api.currentBook("book");
  const pages = Array.from({ length: 12 }, (_, index) => ({ pageId: `page-${index + 1}`, index: index + 1,
    kind: "memory", sourcePhotoId: "photo", displayPhotoId: "photo",
    personalMemoryId: started.body.personalMemoryId, memoryRevisionId: confirmed.body.memory.memoryRevisionId,
    confirmedSubmissionId: confirmed.body.memory.confirmedSubmissionId,
    confirmedSubmissionHash: confirmed.body.memory.confirmedSubmissionHash, grantId: grant.body.grantId,
    authorizedMemoryTextId: `text-${index + 1}`, sourceProvenance: provenance() }));
  f.api.db.prepare("UPDATE book_draft_versions SET pages_json=? WHERE id=?").run(JSON.stringify(pages), book.draft_id);
  book = f.api.currentBook("book");
  const queued = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/render-jobs", {
    renderJobId: "preview", draftVersionId: book.draft_id, grantSetHash: book.grant_set_hash,
    layoutProfile: "book-lab-v0"
  }, { ...f.owner, "if-match": f.api.bookResponseHeaders(book)["x-unseen-book-etag"], "if-none-match": "*" });
  const work = f.api.pendingPreviewJobs(SECRET)[0];
  const claim = await f.api.processPreview(work, SECRET);
  const equality = { bookId: claim.input.manifest.bookId, versionId: claim.input.manifest.versionId,
    title: claim.input.manifest.title, manifestHash: claim.input.manifest.manifestHash,
    authorizationSnapshotHash: claim.input.manifest.authorizationSnapshotHash,
    authorizedMemoryTextSnapshotHash: claim.input.manifest.authorizedMemoryTextSnapshotHash,
    assetSnapshotHash: claim.input.manifest.assetSnapshotHash, pageCount: 12,
    orderedPageIds: pages.map((page) => page.pageId), orderedSourceIds: pages.map(() => "photo"),
    orderedDisplayPhotoIds: pages.map(() => "photo") };
  await f.api.completePreview({ renderJobId: work.renderJobId, jobVersion: claim.version,
    inputHash: work.inputHash, attempt: work.attempt }, { status: "ready", html: previewHtml,
    htmlHash: sha256(previewHtml),
    pageCount: 12, htmlArtifactId: "preview-html", equality }, SECRET);
  return queued;
}

async function availableVersion(f, key = "available-freeze-key") {
  await readyDraft(f);
  const frozen = await freeze(f, key);
  assert.equal(frozen.status, 200);
  const work = f.api.pendingFrozenRenderJobs(SECRET)[0];
  const claim = await f.api.processFrozenRender(work, SECRET);
  const request = { renderJobId: work.renderJobId, jobVersion: claim.version,
    inputHash: work.inputHash, attempt: work.attempt };
  assert.equal((await f.api.completeFrozenRender(request, frozenOutput(claim), SECRET)).status, "ready");
  return frozen;
}

function livePath(versionId, suffix = "") {
  return `/v2-labs/live/spaces/space/books/book/versions/${versionId}${suffix}`;
}

function newVersionRequest(f, versionId, draftVersionId = "new-draft", key = "new-version-key") {
  const book = f.api.currentBook("book");
  return { method: "POST", path: "/v2-labs/owner/spaces/space/books/book/draft-versions",
    body: { draftVersionId, fromVersionId: versionId, excludeWithdrawn: true },
    headers: { ...f.owner, "if-match": f.api.bookResponseHeaders(book)["x-unseen-book-etag"],
      "if-none-match": "*", "idempotency-key": key } };
}

test("owner reload receives freeze/start-new preconditions and readable completed-version entries", async () => {
  const f = fixture();
  try {
    await readyDraft(f);
    const ready = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    assert.deepEqual(Object.keys(ready.body).sort(), ["bookId", "completedVersions", "draftVersionId", "grantSetHash", "pages",
      "recoverableRenderJobs", "spaceId", "staleReason", "status", "title", "version"].sort());
    const readyPreconditions = JSON.parse(ready.headers["x-unseen-book-owner-preconditions"]);
    for (const [name, value] of Object.entries(ready.headers)) validateHeaderValue(name, value);
    assert.deepEqual(readyPreconditions, { freeze: {
      authorizationSnapshotHash: ready.body.grantSetHash,
      draftVersionId: ready.body.draftVersionId,
      grantSetHash: ready.body.grantSetHash,
      previewHash: f.api.db.prepare("SELECT preview_hash previewHash FROM book_render_jobs WHERE id='preview'").get()
        .previewHash
    } });
    const staleFreeze = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/versions",
      { ...readyPreconditions.freeze, previewHash: sha256("stale-preview") },
      { ...f.owner, "if-match": ready.headers.etag });
    assert.equal(staleFreeze.status, 409);
    assert.equal(staleFreeze.body.error.code, "preview_required");
    const frozen = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/versions",
      readyPreconditions.freeze, { ...f.owner, "if-match": ready.headers.etag });
    assert.equal(frozen.status, 200);

    const frozenDraft = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    const frozenPreconditions = JSON.parse(frozenDraft.headers["x-unseen-book-owner-preconditions"]);
    assert.deepEqual(frozenPreconditions, { startNewVersion: { accessControlStatus: "active",
      accessControlVersion: 1, fromVersionId: frozen.body.versionId } });
    f.api.db.prepare(`UPDATE book_version_access_controls SET status='affected',version=version+1,updated_at=?
      WHERE version_id=?`)
      .run("2026-08-14T02:00:00.000Z", frozen.body.versionId);
    const affected = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    assert.deepEqual(JSON.parse(affected.headers["x-unseen-book-owner-preconditions"]), {
      startNewVersion: { accessControlStatus: "affected", accessControlVersion: 2,
        fromVersionId: frozen.body.versionId }
    });
    f.api.db.prepare(`UPDATE book_version_access_controls SET status='active',version=version+1,updated_at=?
      WHERE version_id=?`).run("2026-08-14T02:01:00.000Z", frozen.body.versionId);
    const staleStart = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/draft-versions", {
      draftVersionId: "stale-new-draft", fromVersionId: frozenPreconditions.startNewVersion.fromVersionId,
      excludeWithdrawn: true
    }, { ...f.owner, "if-match": frozenDraft.headers.etag, "if-none-match": "*" });
    assert.equal(staleStart.status, 409);
    assert.equal(staleStart.body.error.code, "version_conflict");

    const reloaded = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    const reloadedPreconditions = JSON.parse(reloaded.headers["x-unseen-book-owner-preconditions"]);
    assert.equal(reloadedPreconditions.startNewVersion.accessControlVersion, 3);
    const started = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/draft-versions", {
      draftVersionId: "reloaded-new-draft", fromVersionId: reloadedPreconditions.startNewVersion.fromVersionId,
      excludeWithdrawn: true
    }, { ...f.owner, "if-match": reloaded.headers.etag, "if-none-match": "*" });
    assert.equal(started.status, 200);
    assert.equal(started.body.draftVersionId, "reloaded-new-draft");
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("owner preconditions survive restart but omit stale Core source and grant state", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-book-owner-preconditions-"));
  const database = path.join(directory, "book.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let f = fixture({ database });
  let currentPreconditions;
  try {
    await readyDraft(f);
    const current = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    currentPreconditions = JSON.parse(current.headers["x-unseen-book-owner-preconditions"]);
  } finally { f.api.close(); }
  f = fixture({ database });
  try {
    const restarted = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    assert.deepEqual(JSON.parse(restarted.headers["x-unseen-book-owner-preconditions"]), currentPreconditions);
    const photo = f.core.photos.get("photo");
    photo.provenance = { ...photo.provenance, placementRevisionId: "placement-drift" };
    f.core.photos.set("photo", photo);
    const stale = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    assert.equal(stale.headers["x-unseen-book-owner-preconditions"], undefined);
    assert.deepEqual(stale.body, restarted.body);
    const rejected = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/versions",
      currentPreconditions.freeze, { ...f.owner, "if-match": restarted.headers.etag });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "preview_stale");
    photo.provenance = provenance();
    f.core.photos.set("photo", photo);
    f.api.db.prepare("UPDATE book_contribution_grants SET version=version+1 WHERE book_id='book'").run();
    const staleGrant = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    assert.equal(staleGrant.headers["x-unseen-book-owner-preconditions"], undefined);
    assert.deepEqual(staleGrant.body, restarted.body);
    f.core.beforeOwnerRevalidate = (core) => {
      core.beforeOwnerRevalidate = null;
      core.spaces.get("space").version += 1;
    };
    const staleOwner = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    assert.equal(staleOwner.status, 409);
    assert.equal(staleOwner.body.error.code, "authorization_changed");
  } finally { f.api.close(); }
});

test("BOOK.FREEZE persists immutable input and accepts one exact HTML/PDF worker result", async () => {
  const f = fixture();
  try {
    await readyDraft(f);
    const frozen = await freeze(f);
    assert.equal(frozen.status, 200);
    assert.equal(frozen.body.status, "rendering");
    const storedManifest = f.api.db.prepare(`SELECT * FROM immutable_frozen_book_manifests
      WHERE book_version_id=?`).get(frozen.body.versionId);
    assert.equal(storedManifest.title, "现场回忆");
    assert.equal(storedManifest.manifest_hash, frozen.body.manifestHash);
    assert.equal(JSON.parse(storedManifest.pages_json).length, 12);
    assert.equal(JSON.parse(f.api.db.prepare(`SELECT snapshot_json FROM immutable_authorized_memory_text_snapshots
      WHERE book_version_id=? LIMIT 1`).get(frozen.body.versionId).snapshot_json).originalUserText,
    "这是用户确认的原话。");
    assert.equal(f.api.db.prepare(`SELECT count(*) count FROM immutable_frozen_book_assets
      WHERE book_version_id=?`).get(frozen.body.versionId).count, 1);
    assert.throws(() => f.api.db.prepare(`UPDATE immutable_frozen_book_manifests SET title='forged'
      WHERE book_version_id=?`).run(frozen.body.versionId), /frozen_manifest_immutable/);
    const work = f.api.pendingFrozenRenderJobs(SECRET)[0];
    const claim = await f.api.processFrozenRender(work, SECRET);
    assert.equal(claim.input.manifest.versionId, frozen.body.versionId);
    const m = claim.input.manifest;
    const request = { renderJobId: work.renderJobId, jobVersion: claim.version,
      inputHash: work.inputHash, attempt: work.attempt };
    const complete = await f.api.completeFrozenRender(request, frozenOutput(claim), SECRET);
    assert.equal(complete.status, "ready");
    assert.equal(f.api.db.prepare("SELECT status FROM book_versions WHERE id=?").get(frozen.body.versionId).status,
      "available");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE status='available'").get().count, 2);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("preview and frozen completion durably reject active or network-capable HTML", async () => {
  const preview = fixture();
  try {
    await readyDraft(preview, { previewHtml: "<!doctype html><html><body onload=alert(1)>x</body></html>" });
    const job = preview.api.db.prepare("SELECT * FROM book_render_jobs WHERE id='preview'").get();
    assert.equal(job.status, "failed");
    assert.equal(job.last_stable_error, "artifact_mismatch");
    assert.equal(preview.api.db.prepare("SELECT count(*) count FROM book_preview_artifacts").get().count, 0);
  } finally { preview.api.close(); }

  const unsafeHtml = [
    "<!doctype html><html><head><style>body{background:url(https://audit.invalid/a)}</style></head><body>x</body></html>",
    "<!doctype html><html><body><img SRC = \"https://audit.invalid/a\"></body></html>",
    "<!doctype html><html><body><img srcset=\"https://audit.invalid/a 1x\"></body></html>",
    "<!doctype html><html><body onload=\"alert(1)\">x</body></html>",
    "<!doctype html><html><head><meta http-equiv=\"refresh\" content=\"0;url=https://audit.invalid\"></head><body>x</body></html>",
    "<!doctype html><html><body><svg><a href=\"https://audit.invalid\">x</a></svg></body></html>"
  ];
  for (const [index, html] of unsafeHtml.entries()) {
    const f = fixture();
    try {
      await readyDraft(f);
      const frozen = await freeze(f, `unsafe-html-freeze-${index}`);
      const work = f.api.pendingFrozenRenderJobs(SECRET)[0];
      const claim = await f.api.processFrozenRender(work, SECRET);
      const output = frozenOutput(claim);
      output.html = html;
      output.htmlHash = sha256(html);
      const result = await f.api.completeFrozenRender({ renderJobId: work.renderJobId, jobVersion: claim.version,
        inputHash: work.inputHash, attempt: work.attempt }, output, SECRET);
      assert.equal(result.status, "failed");
      assert.equal(result.stableError, "artifact_mismatch");
      assert.equal(f.api.db.prepare("SELECT status FROM book_versions WHERE id=?")
        .get(frozen.body.versionId).status, "render_failed");
      assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE status='available'")
        .get().count, 0);
      assert.equal(f.core.writeCount, 0);
    } finally { f.api.close(); }
  }
});

test("rejected freeze creates zero version, immutable snapshot, job, or artifact rows", async () => {
  const f = fixture();
  try {
    await readyDraft(f);
    f.api.db.prepare("UPDATE book_preview_artifacts SET html_blob=? WHERE render_job_id='preview'")
      .run(Buffer.from("tampered"));
    const rejected = await freeze(f, "rejected-freeze-key");
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "preview_stale");
    for (const table of ["book_versions", "book_version_source_entries", "immutable_frozen_book_manifests",
      "immutable_authorized_memory_text_snapshots", "immutable_frozen_book_assets", "render_artifacts"]) {
      assert.equal(f.api.db.prepare(`SELECT count(*) count FROM ${table}`).get().count, 0, table);
    }
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_render_jobs WHERE book_version_id IS NOT NULL")
      .get().count, 0);
    assert.equal(f.api.currentBook("book").draft_status, "preview_ready");
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("forged frozen equality fails durably and source drift revokes before publish", async () => {
  for (const scenario of ["forged", "drift"]) {
    const f = fixture();
    try {
      await readyDraft(f);
      const frozen = await freeze(f, `freeze-${scenario}-key`);
      const work = f.api.pendingFrozenRenderJobs(SECRET)[0];
      const claim = await f.api.processFrozenRender(work, SECRET);
      const request = { renderJobId: work.renderJobId, jobVersion: claim.version,
        inputHash: work.inputHash, attempt: work.attempt };
      if (scenario === "forged") {
        const output = frozenOutput(claim);
        output.equality.manifestHash = sha256("forged");
        const result = await f.api.completeFrozenRender(request, output, SECRET);
        assert.equal(result.status, "failed");
        assert.equal(result.stableError, "artifact_mismatch");
        assert.equal(f.api.db.prepare("SELECT status FROM book_versions WHERE id=?")
          .get(frozen.body.versionId).status, "render_failed");
      } else {
        f.core.photos.get("photo").provenance.placementRevisionId = "placement-drift";
        const result = await f.api.completeFrozenRender(request, frozenOutput(claim), SECRET);
        assert.equal(result.status, "discarded_stale");
        assert.equal(f.api.db.prepare("SELECT status FROM book_versions WHERE id=?")
          .get(frozen.body.versionId).status, "withdrawal_affected");
        assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE status='available'")
          .get().count, 0);
      }
      assert.equal(f.core.writeCount, 0);
    } finally { f.api.close(); }
  }
});

test("freeze and frozen processor completed-state replay survive restart", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-book-freeze-"));
  const database = path.join(directory, "book.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let f = fixture({ database });
  let frozen;
  let work;
  let request;
  let freezeCall;
  let response;
  try {
    await readyDraft(f);
    freezeCall = freezeRequest(f);
    frozen = await freeze(f, undefined, freezeCall);
    assert.deepEqual(await freeze(f, undefined, freezeCall), frozen);
    work = f.api.pendingFrozenRenderJobs(SECRET)[0];
    const claim = await f.api.processFrozenRender(work, SECRET);
    request = { renderJobId: work.renderJobId, jobVersion: claim.version,
      inputHash: work.inputHash, attempt: work.attempt };
    response = await f.api.completeFrozenRender(request, frozenOutput(claim), SECRET);
  } finally { f.api.close(); }
  f = fixture({ database });
  try {
    assert.deepEqual(await freeze(f, undefined, freezeCall), frozen);
    assert.deepEqual(await f.api.processFrozenRender(work, SECRET), response);
    assert.deepEqual(await f.api.completeFrozenRender(request, { status: "failed", stableError: "render_failed" },
      SECRET), response);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("grant withdrawal after claim revokes the version before publish and cleanup purges frozen content", async () => {
  const f = fixture();
  try {
    await readyDraft(f);
    const frozen = await freeze(f, "withdraw-freeze-key");
    const manifestBefore = f.api.db.prepare(`SELECT * FROM immutable_frozen_book_manifests
      WHERE book_version_id=?`).get(frozen.body.versionId);
    const work = f.api.pendingFrozenRenderJobs(SECRET)[0];
    const claim = await f.api.processFrozenRender(work, SECRET);
    const grant = f.api.db.prepare("SELECT * FROM book_contribution_grants WHERE book_id='book'").get();
    const book = f.api.currentBook("book");
    const withdrawn = await f.call("POST",
      `/v2-labs/books/book/contribution-grants/${grant.personal_memory_id}/withdrawals`, {}, {
        ...f.contributor, "if-match": f.api.grantWithdrawalEtag(grant, book) });
    assert.equal(withdrawn.status, 200);
    assert.deepEqual(withdrawn.body.affectedBookVersionIds, [frozen.body.versionId]);
    assert.equal(f.api.db.prepare("SELECT status FROM book_versions WHERE id=?")
      .get(frozen.body.versionId).status, "withdrawal_affected");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE status='revoked'").get().count, 2);
    const result = await f.api.completeFrozenRender({ renderJobId: work.renderJobId, jobVersion: claim.version,
      inputHash: work.inputHash, attempt: work.attempt }, frozenOutput(claim), SECRET);
    assert.equal(result.status, "discarded_stale");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE status='available'").get().count, 0);
    f.api.processGrantCleanup(withdrawn.body.withdrawalId, f.api.cleanupSecret);
    const manifestAfter = f.api.db.prepare(`SELECT * FROM immutable_frozen_book_manifests
      WHERE book_version_id=?`).get(frozen.body.versionId);
    assert.equal(manifestAfter.manifest_hash, manifestBefore.manifest_hash);
    assert.equal(manifestAfter.pages_json, manifestBefore.pages_json);
    assert.equal(f.api.db.prepare(`SELECT count(*) count FROM immutable_authorized_memory_text_snapshots
      WHERE book_version_id=?`).get(frozen.body.versionId).count, 0);
    assert.equal(f.api.db.prepare(`SELECT count(*) count FROM immutable_frozen_book_assets
      WHERE book_version_id=?`).get(frozen.body.versionId).count, 0);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("BOOK.OPEN_PREVIEW returns the exact JSON projection for owner, Account viewer, and external viewer", async () => {
  const f = fixture();
  try {
    const frozen = await availableVersion(f);
    for (const viewer of [f.owner, f.accountViewer, f.externalViewer]) {
      const opened = await f.call("GET", livePath(frozen.body.versionId), {}, viewer);
      assert.equal(opened.status, 200);
      assert.deepEqual(Object.keys(opened.body).sort(), ["bookVersion", "htmlArtifact",
        "orderedDisplayPhotoIds", "orderedPageIds", "orderedSourceIds"].sort());
      assert.equal(opened.body.bookVersion.status, "available");
      assert.equal(opened.body.htmlArtifact.format, "html");
      assert.equal(opened.body.htmlArtifact.status, "available");
      assert.equal(opened.body.htmlArtifact.contentHash, sha256(safeHtml("frozen")));
      assert.equal(Object.hasOwn(opened.body.htmlArtifact, "body"), false);
      assert.deepEqual(opened.body.orderedPageIds, Array.from({ length: 12 }, (_, index) => `page-${index + 1}`));
      assert.deepEqual(opened.body.orderedSourceIds, Array(12).fill("photo"));
      assert.deepEqual(opened.body.orderedDisplayPhotoIds, Array(12).fill("photo"));
      assert.equal(opened.headers.etag, `"${opened.body.htmlArtifact.contentHash}"`);
    }
    const unsafe = Buffer.from("<!doctype html><html><head><style>body{background:url(https://audit.invalid)}</style></head><body>x</body></html>");
    f.api.db.prepare(`UPDATE render_artifacts SET content_blob=?,content_hash=?
      WHERE version_id=? AND format='html'`).run(unsafe, sha256(unsafe), frozen.body.versionId);
    const rejected = await f.call("GET", livePath(frozen.body.versionId), {}, f.owner);
    assert.equal(rejected.status, 404);
    assert.deepEqual(rejected.body, { error: { code: "book_version_unavailable" } });
    assert.equal(f.api.artifactLookupCount, 4);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("live reads await Core assets, revalidate viewers, reject hash drift, and survive restart", async (t) => {
  const delayed = fixture();
  try {
    const frozen = await availableVersion(delayed);
    const read = delayed.core.readDisplayPhotoForOwner.bind(delayed.core);
    let reads = 0;
    delayed.core.readDisplayPhotoForOwner = async (...args) => {
      reads += 1;
      await Promise.resolve();
      return read(...args);
    };
    const opened = await delayed.call("GET", livePath(frozen.body.versionId), {}, delayed.accountViewer);
    assert.equal(opened.status, 200);
    assert.ok(reads >= 4);
    assert.equal(delayed.core.writeCount, 0);
  } finally { delayed.api.close(); }

  const revoked = fixture();
  try {
    const frozen = await availableVersion(revoked);
    const read = revoked.core.readDisplayPhotoForOwner.bind(revoked.core);
    revoked.core.readDisplayPhotoForOwner = async (...args) => {
      const value = await read(...args);
      revoked.core.accountViewSessions.get("viewer").sessionActive = false;
      return value;
    };
    revoked.api.artifactLookupCount = 0;
    const denied = await revoked.call("GET", livePath(frozen.body.versionId), {}, revoked.accountViewer);
    assert.equal(denied.status, 404);
    assert.equal(revoked.api.artifactLookupCount, 0);
    assert.equal(revoked.api.db.prepare("SELECT status FROM book_versions WHERE id=?")
      .get(frozen.body.versionId).status, "available");
    assert.equal(revoked.core.writeCount, 0);
  } finally { revoked.api.close(); }

  const drifted = fixture();
  try {
    const frozen = await availableVersion(drifted);
    const read = drifted.core.readDisplayPhotoForOwner.bind(drifted.core);
    let reads = 0;
    drifted.core.readDisplayPhotoForOwner = async (...args) => {
      const value = await read(...args);
      reads += 1;
      if (reads === 1) drifted.core.photos.get("photo").provenance.photoContentHash = sha256("changed-source");
      return value;
    };
    drifted.api.artifactLookupCount = 0;
    const denied = await drifted.call("GET", livePath(frozen.body.versionId), {}, drifted.externalViewer);
    assert.equal(denied.status, 404);
    assert.equal(drifted.api.artifactLookupCount, 0);
    assert.equal(drifted.api.db.prepare("SELECT status FROM book_versions WHERE id=?")
      .get(frozen.body.versionId).status, "withdrawal_affected");
    assert.equal(drifted.core.writeCount, 0);
  } finally { drifted.api.close(); }

  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-async-book-read-"));
  const database = path.join(directory, "book-lab.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let restarted = fixture({ database });
  let versionId;
  try { versionId = (await availableVersion(restarted)).body.versionId; }
  finally { restarted.api.close(); }
  restarted = fixture({ database });
  try {
    const read = restarted.core.readDisplayPhotoForOwner.bind(restarted.core);
    restarted.core.readDisplayPhotoForOwner = async (...args) => {
      await Promise.resolve();
      return read(...args);
    };
    const opened = await restarted.call("GET", livePath(versionId), {}, restarted.externalViewer);
    assert.equal(opened.status, 200);
    assert.equal(restarted.core.writeCount, 0);
  } finally { restarted.api.close(); }
});

test("internal canonical HTML read preserves BOLA, source, hash, and Core read-only guards", async () => {
  const readable = fixture();
  try {
    const frozen = await availableVersion(readable);
    const result = await readable.api.readCanonicalHtmlForUi({ headers: readable.accountViewer }, "space", "book",
      frozen.body.versionId);
    assert.deepEqual(result.bytes, Buffer.from(safeHtml("frozen")));
    assert.equal(result.contentHash, sha256(result.bytes));
    assert.equal(readable.core.writeCount, 0);
  } finally { readable.api.close(); }

  const revoked = fixture();
  try {
    const frozen = await availableVersion(revoked);
    revoked.api.db.prepare("UPDATE book_version_access_controls SET status='revoked' WHERE version_id=?")
      .run(frozen.body.versionId);
    revoked.api.artifactLookupCount = 0;
    await assert.rejects(() => revoked.api.readCanonicalHtmlForUi({ headers: revoked.owner }, "space", "book",
      frozen.body.versionId), (error) => error.code === "book_version_unavailable" && error.status === 404);
    assert.equal(revoked.api.artifactLookupCount, 0);
    assert.equal(revoked.core.writeCount, 0);
  } finally { revoked.api.close(); }

  const drifted = fixture();
  try {
    const frozen = await availableVersion(drifted);
    drifted.core.photos.get("photo").provenance.placementRevisionId = "drifted-placement";
    drifted.api.artifactLookupCount = 0;
    await assert.rejects(() => drifted.api.readCanonicalHtmlForUi({ headers: drifted.externalViewer }, "space", "book",
      frozen.body.versionId), (error) => error.code === "book_version_unavailable" && error.status === 404);
    assert.equal(drifted.api.artifactLookupCount, 0);
    assert.equal(drifted.core.writeCount, 0);
  } finally { drifted.api.close(); }

  const mismatched = fixture();
  try {
    const frozen = await availableVersion(mismatched);
    mismatched.api.db.prepare("UPDATE render_artifacts SET content_hash=? WHERE version_id=? AND format='html'")
      .run(sha256("forged-html"), frozen.body.versionId);
    mismatched.api.artifactLookupCount = 0;
    await assert.rejects(() => mismatched.api.readCanonicalHtmlForUi({ headers: mismatched.accountViewer }, "space", "book",
      frozen.body.versionId), (error) => error.code === "book_version_unavailable" && error.status === 404);
    assert.equal(mismatched.api.artifactLookupCount, 1);
    assert.equal(mismatched.core.writeCount, 0);
  } finally { mismatched.api.close(); }
});

test("live read BOLA and every unavailable branch fail uniformly before artifact lookup", async () => {
  const f = fixture();
  try {
    const frozen = await availableVersion(f);
    const denied = [
      [livePath("missing-version"), f.owner],
      [`/v2-labs/live/spaces/space/books/other/versions/${frozen.body.versionId}`, f.accountViewer],
      [`/v2-labs/live/spaces/other/books/book/versions/${frozen.body.versionId}`, f.accountViewer],
      [livePath(frozen.body.versionId), f.contributor],
      [livePath(frozen.body.versionId), { ...f.accountViewer, ...f.externalViewer }],
      [livePath(frozen.body.versionId), {}]
    ];
    f.api.artifactLookupCount = 0;
    for (const [pathValue, headers] of denied) {
      const response = await f.call("GET", pathValue, {}, headers);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: { code: "book_version_unavailable" } });
    }
    assert.equal(f.api.artifactLookupCount, 0);
    f.api.db.prepare("UPDATE book_version_access_controls SET status='revoked' WHERE version_id=?")
      .run(frozen.body.versionId);
    const revoked = await f.call("GET", livePath(frozen.body.versionId), {}, f.owner);
    assert.equal(revoked.status, 404);
    assert.equal(revoked.body.error.code, "book_version_unavailable");
    assert.equal(f.api.artifactLookupCount, 0);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("BOOK.DOWNLOAD_PDF returns exact bytes, hash, length, disposition, and rechecks before first byte", async () => {
  const f = fixture();
  try {
    const frozen = await availableVersion(f);
    const expected = Buffer.from("%PDF-1.7\nfixture\n");
    const downloaded = await f.call("GET", livePath(frozen.body.versionId, "/pdf"), {}, f.accountViewer);
    assert.equal(downloaded.status, 200);
    assert.ok(Buffer.isBuffer(downloaded.body));
    assert.deepEqual(downloaded.body, expected);
    assert.equal(downloaded.headers["content-type"], "application/pdf");
    assert.equal(downloaded.headers["content-disposition"], "attachment; filename=unseen-book-version-01.pdf");
    assert.equal(downloaded.headers["content-length"], String(expected.length));
    assert.equal(downloaded.headers.etag, `"${sha256(expected)}"`);
    assert.equal(downloaded.headers["cache-control"], "no-store, private");
    assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
    let revalidations = 0;
    f.core.beforeViewerRevalidate = (core, viewer) => {
      if (viewer.kind !== "account_viewer" || ++revalidations !== 2) return;
      core.accountViewSessions.get("viewer").sessionActive = false;
    };
    f.api.artifactLookupCount = 0;
    const deniedAtByteBoundary = await f.call("GET", livePath(frozen.body.versionId, "/pdf"), {}, f.accountViewer);
    assert.equal(deniedAtByteBoundary.status, 404);
    assert.deepEqual(deniedAtByteBoundary.body, { error: { code: "book_version_unavailable" } });
    assert.equal(f.api.artifactLookupCount, 0);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("grant withdrawal immediately denies preview and PDF with zero artifact lookup", async () => {
  const f = fixture();
  try {
    const frozen = await availableVersion(f);
    const grant = f.api.db.prepare("SELECT * FROM book_contribution_grants WHERE book_id='book'").get();
    const book = f.api.currentBook("book");
    const withdrawn = await f.call("POST",
      `/v2-labs/books/book/contribution-grants/${grant.personal_memory_id}/withdrawals`, {}, {
        ...f.contributor, "if-match": f.api.grantWithdrawalEtag(grant, book) });
    assert.equal(withdrawn.status, 200);
    f.api.artifactLookupCount = 0;
    for (const suffix of ["", "/pdf"]) {
      const denied = await f.call("GET", livePath(frozen.body.versionId, suffix), {}, f.owner);
      assert.equal(denied.status, 404);
      assert.equal(denied.body.error.code, "book_version_unavailable");
    }
    assert.equal(f.api.artifactLookupCount, 0);
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE status='revoked'").get().count, 2);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("source drift is an idempotent SOURCE_REVOKED denial that purges before artifact lookup", async () => {
  const f = fixture();
  try {
    const frozen = await availableVersion(f);
    f.core.photos.get("photo").provenance.placementRevisionId = "revoked-placement";
    f.api.artifactLookupCount = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const denied = await f.call("GET", livePath(frozen.body.versionId), {}, f.externalViewer);
      assert.equal(denied.status, 404);
      assert.equal(denied.body.error.code, "book_version_unavailable");
    }
    assert.equal(f.api.artifactLookupCount, 0);
    assert.equal(f.api.db.prepare("SELECT status FROM book_versions WHERE id=?").get(frozen.body.versionId).status,
      "withdrawal_affected");
    assert.equal(f.api.db.prepare("SELECT status FROM book_version_access_controls WHERE version_id=?")
      .get(frozen.body.versionId).status, "affected");
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE status='purged'").get().count, 2);
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE content_blob IS NOT NULL")
      .get().count, 0);
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_source_grant_denials").get().count, 1);
    assert.equal(f.api.db.prepare(`SELECT count(*) count FROM book_events WHERE event_type='SOURCE_REVOKED'`).get().count, 1);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("one source drift fans out across books with distinct grants, drafts, versions, and artifacts", async () => {
  const f = fixture();
  try {
    const frozen = await availableVersion(f);
    const now = "2026-08-14T01:00:00.000Z";
    const originalGrant = f.api.db.prepare("SELECT * FROM book_contribution_grants WHERE book_id='book'").get();
    const originalManifest = f.api.db.prepare(`SELECT * FROM immutable_frozen_book_manifests
      WHERE book_version_id=?`).get(frozen.body.versionId);
    const pages = JSON.parse(originalManifest.pages_json).map((page) => ({ ...page, grantId: "grant-2" }));
    f.api.db.prepare(`INSERT INTO memory_books(id,space_id,event_id,title,version,current_draft_version_id,
      created_at,updated_at) VALUES('book-2','space','event','另一视角',1,'draft-2',?,?)`).run(now, now);
    f.api.db.prepare(`INSERT INTO book_draft_versions(id,book_id,parent_version_id,title,status,version,pages_json,
      grant_set_hash,stale_reason,preview_worker_input_hash,created_at,updated_at)
      VALUES('frozen-draft-2','book-2',NULL,'另一视角','frozen',1,?,?,NULL,NULL,?,?)`).run(
    JSON.stringify(pages), sha256("grant-set-2"), now, now);
    f.api.db.prepare(`INSERT INTO book_draft_versions(id,book_id,parent_version_id,title,status,version,pages_json,
      grant_set_hash,stale_reason,preview_worker_input_hash,created_at,updated_at)
      VALUES('draft-2','book-2','frozen-draft-2','另一视角','editing',2,?,?,NULL,NULL,?,?)`).run(
    JSON.stringify(pages), sha256("grant-set-2"), now, now);
    f.api.db.prepare(`INSERT INTO book_contribution_grants(id,book_id,personal_memory_id,memory_revision_id,
      confirmed_submission_hash,contributor_id,credit_label,audience_scope,status,notice_version,notice_hash,
      title_audit_snapshot_json,version,granted_at,updated_at)
      SELECT 'grant-2','book-2',personal_memory_id,memory_revision_id,confirmed_submission_hash,contributor_id,
      credit_label,audience_scope,status,notice_version,notice_hash,title_audit_snapshot_json,version,?,?
      FROM book_contribution_grants WHERE id=?`).run(now, now, originalGrant.id);
    f.api.db.prepare(`INSERT INTO book_versions(id,book_id,ordinal,draft_version_id,status,manifest_hash,
      authorization_snapshot_hash,authorized_text_snapshot_hash,asset_snapshot_hash,page_count,created_at,frozen_at)
      VALUES('version-2','book-2',1,'frozen-draft-2','available',?,?,?,?,12,?,?)`).run(
    sha256("manifest-2"), sha256("authorization-2"), sha256("text-2"), sha256("asset-2"), now, now);
    f.api.db.prepare(`INSERT INTO book_version_access_controls(version_id,book_id,status,version,updated_at)
      VALUES('version-2','book-2','active',1,?)`).run(now);
    f.api.db.prepare("INSERT INTO book_version_grants(version_id,grant_id) VALUES('version-2','grant-2')").run();
    f.api.db.prepare(`INSERT INTO book_version_source_entries(version_id,photo_id,provenance_json)
      VALUES('version-2','photo',?)`).run(JSON.stringify(provenance()));
    f.api.db.prepare(`INSERT INTO book_render_jobs(id,book_id,status,version,input_hash,draft_version_id,
      book_version_id,input_json,access_control_version,attempt,created_at,updated_at)
      VALUES('render-2','book-2','ready',1,?,'frozen-draft-2','version-2','{}',1,1,?,?)`).run(
    sha256("render-2"), now, now);
    for (const format of ["html", "pdf"]) {
      const bytes = Buffer.from(format === "html" ? safeHtml("second") : "%PDF-1.7\nsecond\n");
      f.api.db.prepare(`INSERT INTO render_artifacts(id,render_job_id,version_id,format,status,content_blob,
        content_hash,page_count,created_at,updated_at) VALUES(?,?,?,?, 'available',?,?,12,?,?)`).run(
      `artifact-2-${format}`, "render-2", "version-2", format, bytes, sha256(bytes), now, now);
    }

    f.core.photos.get("photo").provenance.sourcePhotosVersion += 1;
    f.api.artifactLookupCount = 0;
    const denied = await f.call("GET", livePath(frozen.body.versionId), {}, f.owner);
    assert.equal(denied.status, 404);
    assert.equal(denied.body.error.code, "book_version_unavailable");
    assert.equal(f.api.artifactLookupCount, 0);
    for (const versionId of [frozen.body.versionId, "version-2"]) {
      assert.equal(f.api.db.prepare("SELECT status FROM book_versions WHERE id=?").get(versionId).status,
        "withdrawal_affected");
      assert.equal(f.api.db.prepare("SELECT status FROM book_version_access_controls WHERE version_id=?")
        .get(versionId).status, "affected");
    }
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_source_grant_denials").get().count, 2);
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE status='purged'").get().count, 4);
    assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE content_blob IS NOT NULL")
      .get().count, 0);
    assert.deepEqual(JSON.parse(f.api.currentBook("book-2").pages_json), []);
    assert.equal(f.api.db.prepare(`SELECT count(*) count FROM book_events WHERE event_type='SOURCE_REVOKED'`)
      .get().count, 2);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("BOOK.START_NEW_VERSION copies only live content and leaves the old frozen title immutable", async () => {
  const f = fixture();
  try {
    const frozen = await availableVersion(f);
    const versionBefore = structuredClone(f.api.db.prepare("SELECT * FROM book_versions WHERE id=?")
      .get(frozen.body.versionId));
    const manifestBefore = structuredClone(f.api.db.prepare(`SELECT * FROM immutable_frozen_book_manifests
      WHERE book_version_id=?`).get(frozen.body.versionId));
    const started = await f.api.handle(newVersionRequest(f, frozen.body.versionId));
    assert.equal(started.status, 200);
    assert.equal(started.body.status, "editing");
    assert.equal(started.body.draftVersionId, "new-draft");
    assert.equal(started.body.pages.length, 12);
    const edited = await f.call("PATCH", "/v2-labs/owner/spaces/space/books/book/title",
      { title: "新版标题" }, { ...f.owner, "if-match": started.headers["x-unseen-book-etag"] });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.title, "新版标题");
    assert.deepEqual({ ...f.api.db.prepare("SELECT * FROM book_versions WHERE id=?").get(frozen.body.versionId) },
      versionBefore);
    assert.deepEqual({ ...f.api.db.prepare(`SELECT * FROM immutable_frozen_book_manifests WHERE book_version_id=?`)
      .get(frozen.body.versionId) }, manifestBefore);
    const oldPreview = await f.call("GET", livePath(frozen.body.versionId), {}, f.owner);
    assert.equal(oldPreview.status, 200);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("BOOK.START_NEW_VERSION public precondition recovers grant, memory, and source withdrawal", async () => {
  for (const scenario of ["grant_withdrawn", "memory_withdrawn", "source_revoked"]) {
    const f = fixture();
    try {
      const frozen = await availableVersion(f, `available-${scenario}`);
      const manifestBefore = structuredClone(f.api.db.prepare(`SELECT * FROM immutable_frozen_book_manifests
        WHERE book_version_id=?`).get(frozen.body.versionId));
      if (scenario === "grant_withdrawn") {
        const grant = f.api.db.prepare("SELECT * FROM book_contribution_grants WHERE book_id='book'").get();
        const book = f.api.currentBook("book");
        const result = await f.call("POST",
          `/v2-labs/books/book/contribution-grants/${grant.personal_memory_id}/withdrawals`, {}, {
            ...f.contributor, "if-match": f.api.grantWithdrawalEtag(grant, book) });
        assert.equal(result.status, 200);
      } else if (scenario === "memory_withdrawn") {
        const memory = f.api.db.prepare(`SELECT p.*,i.version interview_version,i.status interview_status
          FROM personal_memories p JOIN memory_interviews i ON i.personal_memory_id=p.id
          WHERE p.photo_id='photo'`).get();
        const result = await f.call("POST", `/v2-labs/memories/${memory.id}/withdrawals`, {
          interviewIfMatchVersion: memory.interview_version
        }, { ...f.contributor, "if-match": f.api.memoryEtag(memory) });
        assert.equal(result.status, 200);
      } else {
        f.core.photos.get("photo").provenance.sourcePhotosVersion += 1;
        const denied = await f.call("GET", livePath(frozen.body.versionId), {}, f.owner);
        assert.equal(denied.status, 404);
        assert.equal(denied.body.error.code, "book_version_unavailable");
      }
      const opened = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
      const precondition = JSON.parse(opened.headers["x-unseen-book-owner-preconditions"]).startNewVersion;
      assert.deepEqual(precondition, { accessControlStatus: "affected", accessControlVersion: 2,
        fromVersionId: frozen.body.versionId });
      const started = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/draft-versions", {
        draftVersionId: `draft-${scenario}`, fromVersionId: precondition.fromVersionId, excludeWithdrawn: true
      }, { ...f.owner, "if-match": opened.headers.etag, "if-none-match": "*" });
      assert.equal(started.status, 200);
      assert.equal(started.body.status, "editing");
      assert.deepEqual(started.body.pages, []);
      assert.deepEqual({ ...f.api.db.prepare(`SELECT * FROM immutable_frozen_book_manifests WHERE book_version_id=?`)
        .get(frozen.body.versionId) }, manifestBefore);
      assert.equal(f.api.db.prepare("SELECT status FROM book_versions WHERE id=?").get(frozen.body.versionId).status,
        "withdrawal_affected");
      if (scenario === "source_revoked") {
        assert.equal(f.api.db.prepare("SELECT count(*) count FROM book_source_grant_denials").get().count, 1);
        assert.equal(f.api.db.prepare("SELECT count(*) count FROM render_artifacts WHERE status='purged'").get().count, 2);
      }
      assert.equal(f.core.writeCount, 0);
    } finally { f.api.close(); }
  }
});

test("BOOK.START_NEW_VERSION reloads revoked access control and rejects the pre-cleanup owner ETag", async () => {
  const f = fixture();
  try {
    const frozen = await availableVersion(f, "available-cleanup-revoked");
    const grant = f.api.db.prepare("SELECT * FROM book_contribution_grants WHERE book_id='book'").get();
    const book = f.api.currentBook("book");
    const withdrawn = await f.call("POST",
      `/v2-labs/books/book/contribution-grants/${grant.personal_memory_id}/withdrawals`, {}, {
        ...f.contributor, "if-match": f.api.grantWithdrawalEtag(grant, book) });
    assert.equal(withdrawn.status, 200);
    const affected = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    const affectedPrecondition = JSON.parse(affected.headers["x-unseen-book-owner-preconditions"])
      .startNewVersion;
    assert.equal(affectedPrecondition.accessControlStatus, "affected");
    f.api.processGrantCleanup(withdrawn.body.withdrawalId, f.api.cleanupSecret);

    const stale = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/draft-versions", {
      draftVersionId: "stale-cleanup-draft", fromVersionId: affectedPrecondition.fromVersionId,
      excludeWithdrawn: true
    }, { ...f.owner, "if-match": affected.headers.etag, "if-none-match": "*" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "version_conflict");

    const current = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    const currentPrecondition = JSON.parse(current.headers["x-unseen-book-owner-preconditions"])
      .startNewVersion;
    assert.deepEqual(currentPrecondition, { accessControlStatus: "revoked", accessControlVersion: 3,
      fromVersionId: frozen.body.versionId });
    const started = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/draft-versions", {
      draftVersionId: "current-cleanup-draft", fromVersionId: currentPrecondition.fromVersionId,
      excludeWithdrawn: true
    }, { ...f.owner, "if-match": current.headers.etag, "if-none-match": "*" });
    assert.equal(started.status, 200);
    assert.deepEqual(started.body.pages, []);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});

test("BOOK.START_NEW_VERSION accepts render_failed but fails closed on superseded or corrupt source", async () => {
  const failed = fixture();
  try {
    await readyDraft(failed);
    const frozen = await freeze(failed, "render-failed-freeze");
    const work = failed.api.pendingFrozenRenderJobs(SECRET)[0];
    const claim = await failed.api.processFrozenRender(work, SECRET);
    const result = await failed.api.completeFrozenRender({ renderJobId: work.renderJobId, jobVersion: claim.version,
      inputHash: work.inputHash, attempt: work.attempt }, { status: "failed", stableError: "render_failed" }, SECRET);
    assert.equal(result.status, "failed");
    const opened = await failed.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, failed.owner);
    const precondition = JSON.parse(opened.headers["x-unseen-book-owner-preconditions"]).startNewVersion;
    const started = await failed.call("POST", "/v2-labs/owner/spaces/space/books/book/draft-versions", {
      draftVersionId: "render-failed-draft", fromVersionId: precondition.fromVersionId, excludeWithdrawn: true
    }, { ...failed.owner, "if-match": opened.headers.etag, "if-none-match": "*" });
    assert.equal(started.status, 200);
    assert.equal(started.body.pages.length, 12);
    assert.equal(failed.core.writeCount, 0);
  } finally { failed.api.close(); }

  for (const scenario of ["superseded", "manifest_hash"]) {
    const f = fixture();
    try {
      const frozen = await availableVersion(f, `invalid-source-${scenario}`);
      const opened = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
      if (scenario === "superseded") {
        f.api.db.prepare("UPDATE book_versions SET status='superseded' WHERE id=?").run(frozen.body.versionId);
      } else {
        f.api.db.prepare("UPDATE book_versions SET manifest_hash=? WHERE id=?")
          .run(sha256("corrupt-manifest"), frozen.body.versionId);
      }
      const invalid = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
      assert.equal(invalid.headers["x-unseen-book-owner-preconditions"], undefined);
      const rejected = await f.call("POST", "/v2-labs/owner/spaces/space/books/book/draft-versions", {
        draftVersionId: `invalid-${scenario}-draft`, fromVersionId: frozen.body.versionId,
        excludeWithdrawn: true
      }, { ...f.owner, "if-match": opened.headers.etag, "if-none-match": "*" });
      assert.equal(rejected.status, 404);
      assert.equal(rejected.body.error.code, "source_version_not_found");
      assert.equal(f.api.currentBook("book").draft_status, "frozen");
      assert.equal(f.core.writeCount, 0);
    } finally { f.api.close(); }
  }
});

test("BOOK.START_NEW_VERSION exact replay survives restart and a second open draft is rejected", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-book-new-version-"));
  const database = path.join(directory, "book.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let f = fixture({ database });
  let request;
  let started;
  try {
    const frozen = await availableVersion(f);
    const opened = await f.call("GET", "/v2-labs/owner/spaces/space/books/book/draft", {}, f.owner);
    const precondition = JSON.parse(opened.headers["x-unseen-book-owner-preconditions"]).startNewVersion;
    request = { method: "POST", path: "/v2-labs/owner/spaces/space/books/book/draft-versions",
      body: { draftVersionId: "restart-draft", fromVersionId: precondition.fromVersionId,
        excludeWithdrawn: true },
      headers: { ...f.owner, "if-match": opened.headers.etag, "if-none-match": "*",
        "idempotency-key": "restart-new-version-key" } };
    started = await f.api.handle(request);
    assert.equal(started.status, 200);
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
  f = fixture({ database });
  try {
    assert.deepEqual(await f.api.handle(request), started);
    const second = await f.api.handle({ ...request,
      body: { ...request.body, draftVersionId: "second-draft" },
      headers: { ...f.owner,
        "if-match": f.api.bookResponseHeaders(f.api.currentBook("book"))["x-unseen-book-etag"],
        "if-none-match": "*", "idempotency-key": "second-new-version-key" } });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "new_version_already_open");
    assert.equal(f.core.writeCount, 0);
  } finally { f.api.close(); }
});
