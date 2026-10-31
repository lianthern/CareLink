import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest } from "node:http";
import { LocalApi } from "../../../services/api/src/api.mjs";
import { dispatchOne } from "../../../services/jobs/dispatch/index.mjs";
import { createAccountUpload, fixture, png } from "../../../services/api/tests/fixture-factory.mjs";
import { registerBookLabExtension } from "../../../services/api/src/extensions/book-lab.mjs";
import { sha256 } from "../../../services/api/src/util.mjs";
import { BookLabMemoryApi, COLLECTION_NOTICE_CONTEXT_DISCLOSURE, FixtureCorePort } from
  "../../../services/book-lab/src/index.mjs";
import { BookLabIntegratedController } from "../../../packages/book-lab-web/src/integrated-controller.mjs";
import { BookLabIntegratedTransport } from "../../../packages/book-lab-web/src/integrated-transport.mjs";
import { findLocalBrowser } from "../../../packages/book-renderer/src/pdf.mjs";
import { createBookLabSameOriginServer, listenBookLabSameOriginServer } from
  "../../../infra/integration/book-lab/same-origin-server.mjs";

function options(database) {
  const collectionNoticeCopy =
    `测试接缝：未配置真实问题提供方时不会创建问题。${COLLECTION_NOTICE_CONTEXT_DISCLOSURE}`;
  return {
    database,
    etagSecret: "test-secret-8c-etag-not-production-00000001",
    workerSecret: "test-secret-8c-worker-not-production-000002",
    cleanupSecret: "test-secret-8c-cleanup-not-production-00003",
    renderWorkerSecret: "test-secret-8c-render-not-production-000004",
    collectionNoticeVersion: "test-only-collection-notice-1",
    collectionNoticeHash: sha256(collectionNoticeCopy),
    collectionNoticeCopy,
    grantNoticeVersion: "test-only-grant-notice-1",
    grantNoticeHash: sha256("test-only-grant-notice-1")
  };
}

async function activatePanorama(f, owner, space) {
  const panorama = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: panorama.length, clientAssetId: "book-8c-panorama"
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes: panorama, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: "book-8c-panorama-commit" },
    { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(before.version) });
  return { ...space, version: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version };
}

function cookieHeaders(token, origin, mutation = false) {
  return { cookie: `__Host-unseen_account=${token}`,
    ...(mutation ? { origin, "sec-fetch-site": "same-origin" } : {}) };
}

function providerReadyCore() {
  const photoId = "provider-ready-photo";
  const contributorId = "provider-ready-contributor";
  return new FixtureCorePort({
    photos: { [photoId]: { photoId, contributorId, completed: true, deleted: false, withdrawn: false,
      l3Enabled: true, visibleAnchor: "蓝色桌布上放着一张手写名字卡",
      visibleFacts: ["蓝色桌布上放着一张手写名字卡", "名字卡旁有一枚圆形徽章"],
      provenance: { spaceId: "provider-ready-space", photoId, sceneId: "provider-ready-scene",
        panoramaRevisionId: "provider-ready-panorama", placementRevisionId: "provider-ready-placement",
        nodeId: null, sourcePhotosVersion: 1, yawDegrees: 24, capturedAt: "2026-08-13T04:34:56.000Z",
        authorId: contributorId, photoContentHash: sha256("provider-ready-photo"),
        placementSnapshotHash: sha256("provider-ready-placement") } } },
    accountSessions: { "provider-ready-account": { sessionId: "provider-ready-session", contributorId,
      active: true, revalidated: true, issuedSessionEpoch: 1, accountSessionEpoch: 1 } }
  });
}

function directBookOptions(database, core, questionProviderConfigured, overrides = {}) {
  const config = options(database);
  return { core, database, etagSecret: config.etagSecret, workerSecret: config.workerSecret,
    cleanupSecret: config.cleanupSecret, renderWorkerSecret: config.renderWorkerSecret,
    currentNotice: { version: config.collectionNoticeVersion, hash: config.collectionNoticeHash,
      plainLanguageCopy: config.collectionNoticeCopy },
    currentBookNotice: { version: config.grantNoticeVersion, hash: config.grantNoticeHash },
    questionProviderConfigured,
    questionProvider: ({ kind, visibleFacts }) => ({ intent: kind === "initial_question" ?
      "recall_before_after" : "recall_what_happened_next", visibleFacts }),
    ...overrides };
}

function testOnlyApprovedQuestionCore(f, owner, photoId) {
  const state = {
    facts: ["测试标注：蓝色桌布上放着一张手写名字卡", "测试标注：名字卡旁有一枚圆形徽章"],
    reads: []
  };
  const source = () => {
    const current = f.api.readBookLabQuestionSourceForWorker({ photoId, contributorId: owner.accountId });
    return current ? Object.freeze({ ...current, l3Enabled: true,
      visibleFacts: Object.freeze(structuredClone(state.facts)) }) : null;
  };
  return {
    state,
    source,
    core: {
      authenticate(headers) {
        return headers.authorization === `Bearer ${owner.token}` ? Object.freeze({ kind: "account",
          authorizationId: "test-only-approved-provider", contributorId: owner.accountId,
          allowedPhotoIds: null }) : null;
      },
      readOwnedPhoto(principal, requestedPhotoId) {
        return principal?.contributorId === owner.accountId && requestedPhotoId === photoId ? source() : null;
      },
      listEligibleBooks() { return []; },
      readQuestionSourceForWorker(query) {
        state.reads.push(structuredClone(query));
        return source();
      }
    }
  };
}

function testOnlyProviderOptions(database, core, provider) {
  return directBookOptions(database, core, true, {
    modelVersion: "test-only-approved-provider-v1",
    promptHash: sha256("test-only-approved-provider-prompt"),
    policyHash: sha256("test-only-approved-provider-policy"),
    questionProvider: provider
  });
}

async function startTestOnlyQuestion(api, database, owner, source, idempotencyKey) {
  const config = options(database);
  const started = await api.handle({ method: "POST", path: `/v2-labs/memories/photos/${source.photoId}/question-jobs`,
    headers: { authorization: `Bearer ${owner.token}`, "if-none-match": "*", "idempotency-key": idempotencyKey },
    body: { noticeVersion: config.collectionNoticeVersion, noticeHash: config.collectionNoticeHash,
      photoContentHash: source.provenance.photoContentHash,
      placementSnapshotHash: source.provenance.placementSnapshotHash } });
  assert.equal(started.status, 200);
  return started;
}

function extensionHarness(database, core) {
  const routes = new Map();
  const audits = [];
  const runtime = registerBookLabExtension({
    featureFlags: { bookLab: true },
    registerRoutes: (route) => routes.set(`${route.method} ${route.template}`, route.handler),
    registerInternalJobs() {},
    appendAudit: (event) => audits.push(event),
    authenticateBookLabParticipant: (ctx) => core.authenticate(ctx.headers),
    readBookLabParticipantPhoto: (principal, photoId) => core.readOwnedPhoto(principal, photoId),
    listBookLabEligibleBooks: (principal, spaceId) => core.listEligibleBooks(principal, spaceId),
    readCurrentBookLabOwner: () => null,
    revalidateCurrentBookLabOwner: () => false,
    readCurrentBookLabViewer: () => null,
    revalidateCurrentBookLabViewer: () => false,
    readBookLabOwnerSnapshot: () => null,
    readBookLabEventForOwner: () => null,
    readBookLabDisplayPhoto: (actor, photoId) => core.readDisplayPhotoForOwner(actor, photoId),
    readBookLabRenderDerivative: () => null,
    readQuestionSourceForWorker: (query) => core.readQuestionSourceForWorker(query),
    readCorePhotoContext: () => null,
    authorizeCorePhotoParticipant: () => null
  }, options(database));
  return { routes, audits, runtime };
}

function bookBusinessState(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      AND name!='schema_migrations' ORDER BY name`).all().map((row) => row.name);
    return Object.fromEntries(names.map((name) => [name,
      db.prepare(`SELECT COUNT(*) count FROM "${name}"`).get().count]));
  } finally { db.close(); }
}

function restartedExtension(f, database) {
  const routes = new Map();
  const runtime = registerBookLabExtension({
    featureFlags: { bookLab: true },
    registerRoutes: (route) => routes.set(`${route.method} ${route.template}`, route.handler),
    registerInternalJobs() {},
    appendAudit: (event) => f.api.appendBookLabAudit(event),
    authenticateBookLabParticipant: (ctx) => f.api.authenticateBookLabParticipant(ctx),
    readBookLabParticipantPhoto: (principal, photoId) => f.api.readBookLabParticipantPhoto(principal, photoId),
    listBookLabEligibleBooks: (principal, spaceId) => f.api.listBookLabEligibleBooks(principal, spaceId),
    readCurrentBookLabOwner: (ctx, spaceId) => f.api.readCurrentBookLabOwner(ctx, spaceId),
    revalidateCurrentBookLabOwner: (owner) => f.api.revalidateCurrentBookLabOwner(owner),
    readCurrentBookLabViewer: (ctx, spaceId) => f.api.readCurrentBookLabViewer(ctx, spaceId),
    revalidateCurrentBookLabViewer: (viewer) => f.api.revalidateCurrentBookLabViewer(viewer),
    readBookLabOwnerSnapshot: (spaceId) => f.api.readBookLabOwnerSnapshot(spaceId),
    readBookLabEventForOwner: (owner, eventId) => f.api.readBookLabEventForOwner(owner, eventId),
    readBookLabDisplayPhoto: (actor, photoId) => f.api.readBookLabDisplayPhoto(actor, photoId),
    readBookLabRenderDerivative: (actor, photoId) => f.api.readBookLabRenderDerivative(actor, photoId),
    readQuestionSourceForWorker: (query) => f.api.readBookLabQuestionSourceForWorker(query),
    readCorePhotoContext: (ctx, photoId) => f.api.readCorePhotoContext(ctx, photoId),
    authorizeCorePhotoParticipant: (ctx, photoId) => f.api.authorizeCorePhotoParticipant(ctx, photoId)
  }, options(database));
  return { routes, runtime };
}

async function poll(read, label) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const value = await read();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`wait_timeout:${label}`);
}

function cdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); }
  };
}

async function clickRealBl04Create({ origin, spaceId, token, profile }) {
  const browser = spawn(findLocalBrowser(), ["--headless=new", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only",
    "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "about:blank"], { stdio: "ignore" });
  let client;
  try {
    const debugPort = await poll(() => {
      const portFile = path.join(profile, "DevToolsActivePort");
      return existsSync(portFile) ? Number(readFileSync(portFile, "utf8").split("\n", 1)[0]) : null;
    }, "chrome_devtools_port");
    const page = await poll(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json())
      .find((target) => target.type === "page"), "chrome_page");
    client = cdp(page.webSocketDebuggerUrl);
    await client.ready;
    await client.send("Page.enable");
    await client.send("Page.navigate", { url: `${origin}/manage/${spaceId}/book-lab` });
    await poll(async () => (await client.send("Runtime.evaluate", {
      expression: "document.readyState === 'complete'", returnByValue: true
    })).result.value, "book_lab_page");
    const result = await client.send("Runtime.evaluate", { expression: `(async () => {
      const [{ createIntegratedBookLabVisualShell }, catalogResponse] = await Promise.all([
        import('/packages/book-lab-web/src/integrated-shell.mjs'), fetch('/__book-lab/catalog.json')
      ]);
      const catalog = await catalogResponse.json();
      const root = document.createElement('section');
      root.id = 'real-book-lab-shell';
      document.body.append(root);
      const fetchImpl = (url, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', ${JSON.stringify(`Bearer ${token}`)});
        return fetch(url, { ...init, headers });
      };
      const shell = createIntegratedBookLabVisualShell({ origin: location.origin, catalog, fetchImpl,
        randomId: () => '8c-real-shell-create-key' });
      await shell.mount(root, ${JSON.stringify(`/manage/${spaceId}/book-lab`)});
      const nativeEventField = Boolean(root.querySelector('[data-book-field="eventId"]'));
      const label = root.querySelector('.material-summary .microcopy')?.textContent.trim();
      root.querySelector('[data-book-field="newBookId"]').value = 'book-real-8c';
      root.querySelector('[data-book-field="title"]').value = '真实接缝书稿';
      const injected = document.createElement('input');
      injected.type = 'hidden';
      injected.dataset.bookField = 'eventId';
      injected.value = 'attacker-event';
      root.append(injected);
      root.querySelector('[data-book-action="BOOK.CREATE"]').click();
      for (let attempt = 0; attempt < 150 && root.hasAttribute('aria-busy'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { nativeEventField, label, busy: root.hasAttribute('aria-busy'),
        status: shell.view.response.status, ok: shell.view.response.ok,
        books: shell.view.response.body.books?.map(({ bookId, spaceId, title }) => ({ bookId, spaceId, title })) ?? null,
        error: shell.view.response.body.error?.code ?? null };
    })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`book_lab_browser_exception:${result.exceptionDetails.text}`);
    return result.result.value;
  } finally {
    client?.close();
    if (browser.exitCode === null) browser.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => browser.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (browser.exitCode === null) browser.kill("SIGKILL");
  }
}

test("real 8C bridge mounts BL01-BL06, creates from the route-bound Space event, and fails closed without facts or provider", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-8c-real-seam-"));
  const offDatabase = path.join(directory, "off.sqlite");
  const bookDatabase = path.join(directory, "book.sqlite");
  const browserProfile = path.join(directory, "chrome");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  let imports = 0;
  const off = new LocalApi({ featureFlags: { bookLab: false }, extensionModuleLoader: async () => {
    imports += 1;
    return { registerBookLabExtension: (input) => registerBookLabExtension(input, options(offDatabase)) };
  } });
  try {
    const writes = off.db.prepare("SELECT total_changes() count").get().count;
    assert.deepEqual(await off.ready, { enabled: false, mountedRoutes: 0, registeredJobs: 0,
      businessWrites: 0, businessBundleImported: false });
    assert.equal(imports, 0);
    assert.equal(existsSync(offDatabase), false);
    assert.equal(off.db.prepare("SELECT total_changes() count").get().count, writes);
  } finally { off.close(); }

  let runtime;
  const f = fixture({ featureFlags: { bookLab: true }, extensionModuleLoader: async () => ({
    registerBookLabExtension(input) {
      runtime = registerBookLabExtension(input, options(bookDatabase));
      return runtime;
    }
  }) });
  let server;
  try {
    assert.deepEqual(await f.api.ready, { enabled: true, mountedRoutes: 20, registeredJobs: 2,
      businessWrites: 0, businessBundleImported: true });
    const owner = await f.login("book-8c-owner@example.test");
    const stranger = await f.login("book-8c-stranger@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id);
    f.db.prepare("UPDATE photos SET captured_at='2026-08-13T04:34:56.000Z' WHERE id=?").run(photo.id);
    const placed = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 42, pitchDeg: 3, regionId: "main",
      reason: "book-8c-loopback"
    }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
      to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null
    }, { ...owner.headers, "if-match": String(placed.version) });

    server = createBookLabSameOriginServer({ api: f.api, runtime });
    const { origin } = await listenBookLabSameOriginServer(server);
    const ownerHeaders = cookieHeaders(owner.token, origin);
    const health = await fetch(`${origin}/__book-lab/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", sameOrigin: true, fixtureFallback: false,
      providerConfigured: false, eventSourceConfigured: true, rendererConfigured: true, productionReady: false });

    const page = await fetch(`${origin}/labs/memories/photos/${photo.id}`, { headers: ownerHeaders });
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /真实 Core 接缝/u);
    assert.doesNotMatch(pageHtml, /确定性本地样本/u);

    const authenticatedFetch = (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Cookie", `__Host-unseen_account=${owner.token}`);
      if (init.method && init.method !== "GET") {
        headers.set("Origin", origin);
        headers.set("Sec-Fetch-Site", "same-origin");
      }
      return fetch(url, { ...init, headers });
    };
    const controller = new BookLabIntegratedController({ transport: new BookLabIntegratedTransport({ origin,
      fetchImpl: authenticatedFetch }) });
    const bl01 = await controller.readRoute(`/labs/memories/photos/${photo.id}`);
    assert.equal(bl01.response.status, 200);
    assert.equal(bl01.response.body.eligibility, "disabled");
    assert.deepEqual(bl01.response.body.eligibleBooks, []);
    assert.equal(bl01.response.unseenHeaders["x-unseen-book-eligible-books"], "[]");
    assert.equal(bl01.response.body.collectionNotice.version, "test-only-collection-notice-1");
    const bl04 = await controller.readRoute(`/manage/${space.spaceId}/book-lab`);
    assert.equal(bl04.response.status, 200);
    assert.deepEqual(bl04.response.body.books, []);

    const start = await fetch(`${origin}/v2-labs/memories/photos/${photo.id}/question-jobs`, {
      method: "POST", headers: { ...cookieHeaders(owner.token, origin, true), "content-type": "application/json",
        "idempotency-key": "8c-no-facts-question", "if-none-match": "*" }, body: JSON.stringify({
        noticeVersion: bl01.response.body.collectionNotice.version,
        noticeHash: bl01.response.body.collectionNotice.hash,
        photoContentHash: bl01.response.body.provenance.photoContentHash,
        placementSnapshotHash: bl01.response.body.provenance.placementSnapshotHash
      })
    });
    assert.equal(start.status, 503);
    assert.equal((await start.json()).error.code, "model_unavailable");

    const clicked = await clickRealBl04Create({ origin, spaceId: space.spaceId, token: owner.token,
      profile: browserProfile });
    assert.deepEqual(clicked, { nativeEventField: false, label: "事件：当前记忆空间", busy: false,
      status: 200, ok: true, books: [{ bookId: "book-real-8c", spaceId: space.spaceId, title: "真实接缝书稿" }],
      error: null });
    const persisted = new DatabaseSync(bookDatabase, { readOnly: true });
    try {
      assert.deepEqual({ ...persisted.prepare(`SELECT id,space_id,event_id,title,version
        FROM memory_books WHERE id='book-real-8c'`).get() }, { id: "book-real-8c", space_id: space.spaceId,
        event_id: space.spaceId, title: "真实接缝书稿", version: 1 });
      assert.equal(persisted.prepare("SELECT COUNT(*) count FROM memory_books").get().count, 1);
      assert.equal(persisted.prepare("SELECT COUNT(*) count FROM book_draft_versions").get().count, 1);
      assert.equal(persisted.prepare("SELECT COUNT(*) count FROM book_events WHERE event_type='BOOK.CREATE'").get().count, 1);
    } finally { persisted.close(); }

    const createState = bookBusinessState(bookDatabase);
    const coreAfterCreate = f.db.prepare("SELECT total_changes() count").get().count;
    const replay = await fetch(`${origin}/v2-labs/owner/spaces/${space.spaceId}/books`, {
      method: "POST", headers: { ...cookieHeaders(owner.token, origin, true), "content-type": "application/json",
        "idempotency-key": "8c-real-shell-create-key", "if-none-match": "*" },
      body: JSON.stringify({ bookId: "book-real-8c", title: "真实接缝书稿", eventId: space.spaceId })
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).bookId, "book-real-8c");
    assert.deepEqual(bookBusinessState(bookDatabase), createState);
    assert.equal(f.db.prepare("SELECT total_changes() count").get().count, coreAfterCreate);

    let negativeSequence = 0;
    const expectNoWriteCreate = async ({ eventId, code }) => {
      negativeSequence += 1;
      const beforeBook = bookBusinessState(bookDatabase);
      const beforeCore = f.db.prepare("SELECT total_changes() count").get().count;
      const response = await fetch(`${origin}/v2-labs/owner/spaces/${space.spaceId}/books`, {
        method: "POST", headers: { ...cookieHeaders(owner.token, origin, true), "content-type": "application/json",
          "idempotency-key": `8c-event-denial-${negativeSequence}`, "if-none-match": "*" },
        body: JSON.stringify({ bookId: `book-denied-${negativeSequence}`, title: "不得落库", eventId })
      });
      assert.equal(response.status, code === "event_unavailable" ? 404 : 409);
      assert.equal((await response.json()).error.code, code);
      assert.deepEqual(bookBusinessState(bookDatabase), beforeBook);
      assert.equal(f.db.prepare("SELECT total_changes() count").get().count, beforeCore);
    };

    await expectNoWriteCreate({ eventId: "random-event", code: "event_unavailable" });
    const crossSpace = await f.createSpace(owner, "Cross-space event");
    await expectNoWriteCreate({ eventId: crossSpace.spaceId, code: "event_unavailable" });

    const currentSpace = () => f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
    let current = currentSpace();
    f.db.prepare("UPDATE spaces SET space_lifecycle='archived',version=version+1 WHERE id=?").run(space.spaceId);
    await expectNoWriteCreate({ eventId: space.spaceId, code: "authorization_changed" });
    f.db.prepare("UPDATE spaces SET space_lifecycle=?,version=? WHERE id=?")
      .run(current.space_lifecycle, current.version, space.spaceId);

    current = currentSpace();
    f.db.prepare("UPDATE spaces SET owner_account_id=?,version=version+1 WHERE id=?")
      .run(stranger.accountId, space.spaceId);
    await expectNoWriteCreate({ eventId: space.spaceId, code: "authorization_changed" });
    f.db.prepare("UPDATE spaces SET owner_account_id=?,version=? WHERE id=?")
      .run(current.owner_account_id, current.version, space.spaceId);

    const account = f.db.prepare("SELECT * FROM accounts WHERE id=?").get(owner.accountId);
    f.db.prepare("UPDATE accounts SET session_epoch=session_epoch+1,version=version+1 WHERE id=?").run(owner.accountId);
    await expectNoWriteCreate({ eventId: space.spaceId, code: "authorization_changed" });
    f.db.prepare("UPDATE accounts SET session_epoch=?,version=? WHERE id=?")
      .run(account.session_epoch, account.version, owner.accountId);

    current = currentSpace();
    const staleOwner = f.api.readCurrentBookLabOwner({ headers: owner.headers }, space.spaceId);
    assert.ok(staleOwner);
    f.db.prepare("UPDATE spaces SET version=version+1 WHERE id=?").run(space.spaceId);
    const readCurrentOwner = f.api.readCurrentBookLabOwner;
    f.api.readCurrentBookLabOwner = () => staleOwner;
    try {
      await expectNoWriteCreate({ eventId: space.spaceId, code: "authorization_changed" });
    } finally {
      delete f.api.readCurrentBookLabOwner;
      assert.equal(f.api.readCurrentBookLabOwner, readCurrentOwner);
      f.db.prepare("UPDATE spaces SET version=? WHERE id=?").run(current.version, space.spaceId);
    }

    const wrongOwner = await fetch(`${origin}/v2-labs/owner/spaces/${space.spaceId}/book-lab`, {
      headers: cookieHeaders(stranger.token, origin)
    });
    assert.equal(wrongOwner.status, 409);
    assert.equal((await wrongOwner.json()).error.code, "authorization_changed");
    const unavailableVersion = await fetch(`${origin}/s/${space.spaceId}/books/book-real-8c/versions/version-1`,
      { headers: ownerHeaders });
    assert.equal(unavailableVersion.status, 404);
    assert.equal((await unavailableVersion.json()).error.code, "book_version_unavailable");

    const bookDb = new DatabaseSync(bookDatabase, { readOnly: true });
    try {
      assert.equal(bookDb.prepare("SELECT COUNT(*) count FROM personal_memories").get().count, 0);
      assert.equal(bookDb.prepare("SELECT COUNT(*) count FROM memory_question_jobs").get().count, 0);
      assert.equal(bookDb.prepare("SELECT COUNT(*) count FROM memory_books").get().count, 1);
      assert.equal(bookDb.prepare("SELECT COUNT(*) count FROM render_artifacts").get().count, 0);
    } finally { bookDb.close(); }
    const target = new URL(origin);
    const badHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: target.hostname, port: target.port, path: "/__book-lab/healthz",
        headers: { host: "invalid.example" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(badHostStatus, 400);

    await new Promise((resolve) => server.close(resolve));
    server = null;
    runtime.close();
    runtime = null;
    const restarted = restartedExtension(f, bookDatabase);
    runtime = restarted.runtime;
    const reopened = await restarted.routes.get("GET /v2-labs/owner/spaces/{spaceId}/book-lab")(
      { headers: owner.headers, body: {} }, { spaceId: space.spaceId });
    assert.equal(reopened.status, 200);
    assert.deepEqual(reopened.body.books.map(({ bookId, title }) => ({ bookId, title })),
      [{ bookId: "book-real-8c", title: "真实接缝书稿" }]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    runtime?.close();
    f.close();
  }
});

test("configured Core facts with no QuestionProvider reject start and follow-up before every Book write", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-8c-provider-off-"));
  const startDatabase = path.join(directory, "start.sqlite");
  const followupDatabase = path.join(directory, "followup.sqlite");
  const core = providerReadyCore();
  const readQuestionSourceForWorker = core.readQuestionSourceForWorker.bind(core);
  let workerSourceReads = 0;
  core.readQuestionSourceForWorker = (query) => {
    workerSourceReads += 1;
    return readQuestionSourceForWorker(query);
  };
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(core.photos.get("provider-ready-photo").l3Enabled, true);
  assert.equal(core.photos.get("provider-ready-photo").visibleFacts.length, 2);

  const startHarness = extensionHarness(startDatabase, core);
  try {
    const before = bookBusinessState(startDatabase);
    assert.ok(Object.values(before).every((count) => count === 0));
    const denied = await startHarness.routes.get(
      "POST /v2-labs/memories/photos/{photoId}/question-jobs")({
      headers: { authorization: "Bearer provider-ready-account", "if-none-match": "*",
        "idempotency-key": "provider-off-start" },
      body: { noticeVersion: options(startDatabase).collectionNoticeVersion,
        noticeHash: options(startDatabase).collectionNoticeHash,
        photoContentHash: core.photos.get("provider-ready-photo").provenance.photoContentHash,
        placementSnapshotHash: core.photos.get("provider-ready-photo").provenance.placementSnapshotHash }
    }, { photoId: "provider-ready-photo" });
    assert.equal(denied.status, 503);
    assert.equal(denied.body.error.code, "model_unavailable");
    assert.deepEqual(bookBusinessState(startDatabase), before);
    assert.deepEqual(startHarness.audits, []);
    assert.equal(workerSourceReads, 0);
  } finally { startHarness.runtime.close(); }

  const seeded = new BookLabMemoryApi(directBookOptions(followupDatabase, core, true));
  const config = options(followupDatabase);
  let followup;
  try {
    const headers = { authorization: "Bearer provider-ready-account" };
    const started = await seeded.handle({ method: "POST",
      path: "/v2-labs/memories/photos/provider-ready-photo/question-jobs",
      headers: { ...headers, "if-none-match": "*", "idempotency-key": "provider-seed-start" },
      body: { noticeVersion: config.collectionNoticeVersion, noticeHash: config.collectionNoticeHash,
        photoContentHash: core.photos.get("provider-ready-photo").provenance.photoContentHash,
        placementSnapshotHash: core.photos.get("provider-ready-photo").provenance.placementSnapshotHash } });
    assert.ok(started.status >= 200 && started.status < 300);
    const work = seeded.pendingQuestionJobs(config.workerSecret)[0];
    assert.equal((await seeded.processQuestion(work, config.workerSecret)).status, "ready");
    const detail = await seeded.handle({ method: "GET", path: `/v2-labs/memories/${started.body.personalMemoryId}`,
      headers, body: {} });
    assert.equal(detail.status, 200);
    const userText = "散场后是我把名字卡夹进蓝色笔记本的。";
    const answer = await seeded.handle({ method: "PUT",
      path: `/v2-labs/memories/${started.body.personalMemoryId}/answer-submissions`,
      headers: { ...headers, "if-match": detail.headers["x-unseen-memory-etag"],
        "idempotency-key": "provider-seed-answer" },
      body: { clientSubmissionId: "provider-seed-submission", userText, previousSubmissionId: null,
        interviewIfMatchVersion: detail.body.memory.interviewVersion } });
    assert.equal(answer.status, 200);
    followup = { memoryId: started.body.personalMemoryId,
      headers: { ...headers, "if-match": answer.headers["x-unseen-followup-etag"],
        "idempotency-key": "provider-off-followup" },
      body: { submissionId: "provider-seed-submission", submissionHash: sha256(userText),
        photoContentHash: core.photos.get("provider-ready-photo").provenance.photoContentHash,
        interviewIfMatchVersion: answer.body.memory.interviewVersion } };
  } finally { seeded.close(); }
  assert.equal(workerSourceReads, 2);
  workerSourceReads = 0;

  const followupHarness = extensionHarness(followupDatabase, core);
  try {
    const before = bookBusinessState(followupDatabase);
    const denied = await followupHarness.routes.get(
      "POST /v2-labs/memories/{memoryId}/followup-jobs")({ headers: followup.headers, body: followup.body },
    { memoryId: followup.memoryId });
    assert.equal(denied.status, 503);
    assert.equal(denied.body.error.code, "model_unavailable");
    assert.deepEqual(bookBusinessState(followupDatabase), before);
    assert.deepEqual(followupHarness.audits, []);
    assert.equal(workerSourceReads, 0);
  } finally { followupHarness.runtime.close(); }
});

test("TEST-ONLY approved facts/provider exercises the real Core worker port without becoming production evidence", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-8c-worker-source-"));
  const f = fixture();
  t.after(() => {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const owner = await f.login("book-worker-source@example.test");
  let space = await f.createSpace(owner);
  space = await f.openSpace(owner, space);
  space = await activatePanorama(f, owner, space);
  const flow = await createAccountUpload(f, owner, space);
  const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
  const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id);
  f.db.prepare("UPDATE photos SET captured_at='2026-08-13T04:34:56.000Z' WHERE id=?").run(photo.id);
  const placed = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
    mode: "manual", confirmationMode: "manual", yawDeg: 42, pitchDeg: 3, regionId: "main",
    reason: "book-8c-worker-source"
  }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
    "x-placement-authorization-version": String(item.placement_authorization_version) });
  await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
    to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null
  }, { ...owner.headers, "if-match": String(placed.version) });

  const approved = testOnlyApprovedQuestionCore(f, owner, photo.id);
  const productionSource = f.api.readBookLabQuestionSourceForWorker({ photoId: photo.id,
    contributorId: owner.accountId });
  assert.equal(productionSource.l3Enabled, false);
  assert.deepEqual(productionSource.visibleFacts, []);

  const happyDatabase = path.join(directory, "two-reads.sqlite");
  const happy = new BookLabMemoryApi(testOnlyProviderOptions(happyDatabase, approved.core,
    ({ kind, visibleFacts }) => ({ intent: kind === "initial_question" ?
      "recall_before_after" : "recall_what_happened_next", visibleFacts })));
  try {
    const source = approved.source();
    await startTestOnlyQuestion(happy, happyDatabase, owner, source, "test-only-two-reads");
    const work = happy.pendingQuestionJobs(options(happyDatabase).workerSecret)[0];
    const result = await happy.processQuestion(work, options(happyDatabase).workerSecret);
    assert.equal(result.status, "ready");
    assert.deepEqual(approved.state.reads, [
      { photoId: photo.id, contributorId: owner.accountId },
      { photoId: photo.id, contributorId: owner.accountId }
    ]);
  } finally { happy.close(); }

  const driftCases = [
    {
      name: "authorization",
      apply() {
        f.db.prepare("UPDATE contribution_batch_items SET revoked_at=? WHERE id=?")
          .run("2026-08-13T05:00:00.000Z", item.id);
        return () => f.db.prepare("UPDATE contribution_batch_items SET revoked_at=NULL WHERE id=?").run(item.id);
      },
      status: "cancelled"
    },
    {
      name: "source",
      apply() {
        f.db.prepare("UPDATE photos SET deleted_at=? WHERE id=?").run("2026-08-13T05:00:00.000Z", photo.id);
        return () => f.db.prepare("UPDATE photos SET deleted_at=NULL,captured_at=? WHERE id=?")
          .run("2026-08-13T04:34:56.000Z", photo.id);
      },
      status: "cancelled"
    },
    {
      name: "facts",
      apply() {
        const before = approved.state.facts;
        approved.state.facts = ["测试标注：事实在 claim 后变化"];
        return () => { approved.state.facts = before; };
      },
      status: "failed"
    },
    {
      name: "content-hash",
      apply() {
        const before = f.db.prepare("SELECT raw_sha256 FROM assets WHERE id=?").get(photo.asset_id);
        f.db.prepare("UPDATE assets SET raw_sha256=? WHERE id=?").run(sha256("test-only-content-drift"), photo.asset_id);
        return () => f.db.prepare("UPDATE assets SET raw_sha256=? WHERE id=?").run(before.raw_sha256, photo.asset_id);
      },
      status: "failed"
    },
    {
      name: "placement-hash",
      async apply() {
        const currentPhoto = f.db.prepare("SELECT * FROM photos WHERE id=?").get(photo.id);
        const currentItem = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(item.id);
        await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
          mode: "manual", confirmationMode: "manual", yawDeg: 43, pitchDeg: 3, regionId: "main",
          reason: "book-8c-worker-placement-drift"
        }, { ...owner.headers, "if-match": String(currentPhoto.version), "x-item-version": String(currentItem.version),
          "x-placement-authorization-version": String(currentItem.placement_authorization_version) });
        return () => {};
      },
      status: "failed"
    }
  ];

  for (const drift of driftCases) {
    approved.state.reads.length = 0;
    const database = path.join(directory, `${drift.name}.sqlite`);
    let releaseProvider;
    let markProviderStarted;
    const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
    const api = new BookLabMemoryApi(testOnlyProviderOptions(database, approved.core, (input) => {
      markProviderStarted();
      return new Promise((resolve) => { releaseProvider = () => resolve({
        intent: input.kind === "initial_question" ? "recall_before_after" : "recall_what_happened_next",
        visibleFacts: input.visibleFacts
      }); });
    }));
    let restore = () => {};
    try {
      const source = approved.source();
      assert.ok(source, `${drift.name}: source must be restored before admission`);
      await startTestOnlyQuestion(api, database, owner, source, `test-only-drift-${drift.name}`);
      const work = api.pendingQuestionJobs(options(database).workerSecret)[0];
      const processing = api.processQuestion(work, options(database).workerSecret);
      await providerStarted;
      restore = await drift.apply();
      const coreWrites = f.db.prepare("SELECT total_changes() count").get().count;
      releaseProvider();
      const result = await processing;
      assert.equal(result.status, drift.status, drift.name);
      assert.equal(f.db.prepare("SELECT total_changes() count").get().count, coreWrites, drift.name);
      assert.deepEqual(approved.state.reads, [
        { photoId: photo.id, contributorId: owner.accountId },
        { photoId: photo.id, contributorId: owner.accountId }
      ], drift.name);
      const persisted = api.db.prepare(`SELECT question,question_hash,model_version,provenance_json
        FROM memory_question_jobs`).get();
      assert.deepEqual({ ...persisted }, { question: null, question_hash: null,
        model_version: null, provenance_json: null }, `${drift.name}: provider result must not persist`);
    } finally {
      restore();
      api.close();
    }
  }

  approved.state.reads.length = 0;
  const withdrawalDatabase = path.join(directory, "withdrawal.sqlite");
  let releaseWithdrawalProvider;
  let markWithdrawalStarted;
  const withdrawalStarted = new Promise((resolve) => { markWithdrawalStarted = resolve; });
  const withdrawalApi = new BookLabMemoryApi(testOnlyProviderOptions(withdrawalDatabase, approved.core, (input) => {
    markWithdrawalStarted();
    return new Promise((resolve) => { releaseWithdrawalProvider = () => resolve({
      intent: "recall_before_after", visibleFacts: input.visibleFacts
    }); });
  }));
  try {
    const started = await startTestOnlyQuestion(withdrawalApi, withdrawalDatabase, owner, approved.source(),
      "test-only-withdrawal");
    const work = withdrawalApi.pendingQuestionJobs(options(withdrawalDatabase).workerSecret)[0];
    const processing = withdrawalApi.processQuestion(work, options(withdrawalDatabase).workerSecret);
    await withdrawalStarted;
    const detail = await withdrawalApi.handle({ method: "GET",
      path: `/v2-labs/memories/${started.body.personalMemoryId}`, headers: { authorization: `Bearer ${owner.token}` } });
    const withdrawn = await withdrawalApi.handle({ method: "POST",
      path: `/v2-labs/memories/${started.body.personalMemoryId}/withdrawals`,
      headers: { authorization: `Bearer ${owner.token}`, "if-match": detail.headers.etag,
        "idempotency-key": "test-only-withdrawal-after-claim" },
      body: { interviewIfMatchVersion: detail.body.memory.interviewVersion } });
    assert.equal(withdrawn.status, 200);
    const beforeStaleCompletion = withdrawalApi.db.prepare("SELECT total_changes() count").get().count;
    const beforeStaleState = bookBusinessState(withdrawalDatabase);
    releaseWithdrawalProvider();
    await assert.rejects(processing, (error) => error.code === "question_input_changed");
    assert.equal(withdrawalApi.db.prepare("SELECT total_changes() count").get().count, beforeStaleCompletion);
    assert.deepEqual(bookBusinessState(withdrawalDatabase), beforeStaleState);
    assert.equal(withdrawalApi.db.prepare("SELECT question FROM memory_question_jobs").get().question, null);
  } finally { withdrawalApi.close(); }

  approved.state.reads.length = 0;
  const restartDatabase = path.join(directory, "restart-reclaim.sqlite");
  let restarted = new BookLabMemoryApi(testOnlyProviderOptions(restartDatabase, approved.core,
    ({ visibleFacts }) => ({ intent: "recall_before_after", visibleFacts })));
  const restartSource = approved.source();
  await startTestOnlyQuestion(restarted, restartDatabase, owner, restartSource, "test-only-restart-reclaim");
  const staleWork = restarted.pendingQuestionJobs(options(restartDatabase).workerSecret)[0];
  restarted.db.prepare(`UPDATE memory_question_jobs SET status='running',version=version+1,attempt=1,
    lease_expires_at='2000-01-01T00:00:00.000Z'`).run();
  restarted.close();
  restarted = new BookLabMemoryApi(testOnlyProviderOptions(restartDatabase, approved.core,
    ({ visibleFacts }) => ({ intent: "recall_before_after", visibleFacts })));
  try {
    const reclaimed = restarted.pendingQuestionJobs(options(restartDatabase).workerSecret)[0];
    assert.equal(reclaimed.attempt, 2);
    assert.equal((await restarted.processQuestion(reclaimed, options(restartDatabase).workerSecret)).status, "ready");
    assert.deepEqual(approved.state.reads, [
      { photoId: photo.id, contributorId: owner.accountId },
      { photoId: photo.id, contributorId: owner.accountId }
    ]);
    const beforeStale = restarted.db.prepare("SELECT total_changes() count").get().count;
    const beforeStaleState = bookBusinessState(restartDatabase);
    assert.throws(() => restarted.processQuestion(staleWork, options(restartDatabase).workerSecret),
      (error) => error.code === "question_input_changed");
    assert.equal(restarted.db.prepare("SELECT total_changes() count").get().count, beforeStale);
    assert.deepEqual(bookBusinessState(restartDatabase), beforeStaleState);
  } finally { restarted.close(); }
});

test("canonical HTML is served only on the authenticated same-origin BL06 route", async (t) => {
  const expected = Buffer.from("<!doctype html><html><body><h1>Canonical</h1></body></html>");
  const contentHash = sha256(expected);
  let observed;
  const api = {
    handle() { throw new Error("unexpected_api_route"); },
    context(request, url) {
      observed = { request, url };
      return { headers: request.headers, url };
    }
  };
  const runtime = {
    async readCanonicalHtmlForUi(ctx, ids) {
      assert.equal(ctx.headers.authorization, "Bearer canonical-account-token");
      assert.deepEqual(ids, { spaceId: "space canonical", bookId: "book canonical", versionId: "version canonical" });
      return { bytes: expected, contentHash };
    }
  };
  const server = createBookLabSameOriginServer({ api, runtime });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { origin } = await listenBookLabSameOriginServer(server);
  const canonical = await fetch(`${origin}/s/space%20canonical/books/book%20canonical/versions/version%20canonical`, {
    headers: { cookie: "__Host-unseen_account=canonical-account-token" }
  });
  assert.equal(canonical.status, 200);
  assert.deepEqual(Buffer.from(await canonical.arrayBuffer()), expected);
  assert.equal(canonical.headers.get("etag"), `"${contentHash}"`);
  assert.equal(canonical.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(canonical.headers.get("content-security-policy"), /script-src 'none'/u);
  assert.equal(observed.url.pathname, "/s/space%20canonical/books/book%20canonical/versions/version%20canonical");

  const legacyArtifact = await fetch(`${origin}/__artifacts/book.html`);
  assert.equal(legacyArtifact.status, 404);
  assert.equal((await legacyArtifact.json()).error.code, "route_unavailable");
});
