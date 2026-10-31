import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { LocalApi } from "../src/api.mjs";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createAccountUpload, exchangeReceipt, fixture, png } from "./fixture-factory.mjs";
import { sha256 } from "../src/util.mjs";

const require = createRequire(import.meta.url);
const coverage = require("../../../packages/contracts/generated/book-lab/action-api-coverage.json");
const allRoutes = [...coverage.actions, { method: "GET", endpoint: "/v2-labs/memories/{memoryId}" },
  { method: "GET", endpoint: "/v2-labs/live/spaces/{spaceId}/books/{bookId}/versions/{versionId}/html" },
  { method: "GET", endpoint: "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/sources" },
  { method: "POST", endpoint: "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/assembly" },];
const route = { method: "GET", template: "/v2-labs/memories/photos/{photoId}",
  handler: (_ctx, params) => ({ status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store, private" },
    body: { photoId: params.photoId, mounted: true } }) };
const job = { endpoint: "internal:book-lab-question-processor",
  handler: (input) => ({ jobId: input.jobId, mounted: true }) };
const bookCoreKeys = ["appendAudit", "authenticateBookLabParticipant", "authorizeCorePhotoParticipant",
  "featureFlags", "listBookLabEligibleBooks", "readBookLabDisplayPhoto", "readBookLabEventForOwner",
  "readBookLabOwnerSnapshot", "readBookLabParticipantPhoto", "readBookLabRenderDerivative",
  "readCorePhotoContext", "readCurrentBookLabOwner", "readCurrentBookLabViewer", "readQuestionSourceForWorker",
  "registerInternalJobs", "registerRoutes", "revalidateCurrentBookLabOwner", "revalidateCurrentBookLabViewer"];
const registerAll = (input) => {
  for (const action of allRoutes) input.registerRoutes(action.method === route.method &&
    action.endpoint === route.template ? route : { method: action.method, template: action.endpoint,
      handler: () => ({ status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store, private" },
        body: { mounted: true } }) });
  for (const operation of coverage.internalOperationCoverage) input.registerInternalJobs(operation.endpoint ===
    job.endpoint ? job : { endpoint: operation.endpoint, handler: () => ({ mounted: true }) });
};

async function activatePanorama(f, owner, space) {
  const bytes = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "book-host-panorama"
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: "book-host-panorama-commit" },
    { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(before.version) });
  return { ...space, version: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version };
}

test("Book extension host is inert when off and atomically mounts allowed routes and jobs when on", async () => {
  let imports = 0;
  const off = new LocalApi({ featureFlags: { bookLab: false }, extensionModuleLoader: async () => {
    imports += 1;
    throw new Error("must not import");
  } });
  try {
    const before = off.db.prepare("SELECT total_changes() count").get().count;
    assert.deepEqual(await off.ready, { enabled: false, mountedRoutes: 0, registeredJobs: 0,
      businessWrites: 0, businessBundleImported: false });
    assert.equal(imports, 0);
    assert.equal(off.db.prepare("SELECT total_changes() count").get().count, before);
    assert.equal((await off.handle({ method: "GET", path: "/v2-labs/memories/photos/photo-a" })).status, 404);
    assert.throws(() => off.dispatchInternalJob(job.endpoint, { jobId: "job-a" }),
      (error) => error.code === "book_lab_extension_unavailable");
  } finally { off.close(); }

  let inputKeys;
  let extensionInput;
  let releaseModule;
  const moduleReady = new Promise((resolve) => { releaseModule = resolve; });
  const api = new LocalApi({ featureFlags: { bookLab: true }, extensionModuleLoader: () => {
    imports += 1;
    return moduleReady;
  } });
  assert.throws(() => api.dispatchInternalJob(job.endpoint, { jobId: "before-mount" }),
    (error) => error.code === "book_lab_extension_unavailable");
  releaseModule({ registerBookLabExtension: (input) => {
      extensionInput = input;
      inputKeys = Object.keys(input).sort();
      registerAll(input);
      return { enabled: true };
    } });
  try {
    assert.deepEqual(await api.ready, { enabled: true, mountedRoutes: allRoutes.length,
      registeredJobs: coverage.internalOperationCoverage.length,
      businessWrites: 0, businessBundleImported: true });
    assert.deepEqual(inputKeys, bookCoreKeys);
    const response = await api.handle({ method: "GET", path: "/v2-labs/memories/photos/photo-a" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { photoId: "photo-a", mounted: true });
    assert.deepEqual(api.dispatchInternalJob(job.endpoint, { jobId: "job-a" }), { jobId: "job-a", mounted: true });
    assert.deepEqual(await api.mountExtensions(), await api.ready);
    assert.equal(api.routes.filter((item) => item.template === route.template).length, 1);
    assert.throws(() => extensionInput.registerRoutes({ ...route, template:
      "/v2-labs/memories/photos/{photoId}/skip" }),
    (error) => error.code === "book_lab_extension_unavailable");
  } finally { api.close(); }
});

test("Book extension responses preserve only the frozen status/body/header envelope", async () => {
  const pdf = Buffer.from("%PDF-closed-book-host");
  const pdfHash = sha256(pdf);
  const bookToken = `bl1.${Buffer.from(sha256("book-etag-host-test"), "hex").toString("base64url")}`;
  const bookEtag = `"${bookToken}"`;
  const invalidEtags = Object.freeze({
    weak: `W/${bookEtag}`,
    unquoted: bookToken,
    short: `"bl1.${"A".repeat(42)}"`,
    long: `"bl1.${"A".repeat(44)}"`,
    alphabet: `"bl1.${"A".repeat(42)}+"`,
    padding: `"bl1.${"A".repeat(42)}="`,
    crlf: `${bookEtag}\r\n`,
    trailing: `${bookEtag}extra`,
    opaque: `"opaque"`
  });
  const pdfRoute = coverage.actions.find((action) => action.endpoint.endsWith("/pdf"));
  assert.ok(pdfRoute);
  const api = new LocalApi({ featureFlags: { bookLab: true }, extensionModuleLoader: async () => ({
    registerBookLabExtension: (input) => {
      for (const action of allRoutes) input.registerRoutes({ method: action.method, template: action.endpoint,
        handler: (ctx) => {
          if (action.endpoint === route.template) {
            if (ctx.query.case === "book-etag") return { status: 200,
              headers: { "content-type": "application/json", "cache-control": "no-store, private",
                etag: bookEtag, "x-unseen-book-etag": bookToken }, body: { mounted: true } };
            if (invalidEtags[ctx.query.case]) return { status: 200,
              headers: { "content-type": "application/json", "cache-control": "no-store, private",
                etag: invalidEtags[ctx.query.case], "x-unseen-book-etag": bookToken }, body: { mounted: true } };
            if (ctx.query.case === "cookie") return { status: 200,
              headers: { "content-type": "application/json", "cache-control": "no-store, private",
                "set-cookie": "forbidden=1" }, body: { mounted: false } };
            if (ctx.query.case === "redirect") return { status: 302,
              headers: { "content-type": "application/json", "cache-control": "no-store, private",
                location: "https://invalid.example" }, body: { mounted: false } };
            if (ctx.query.case === "arbitrary") return { status: 200,
              headers: { "content-type": "application/json", "cache-control": "no-store, private",
                "x-arbitrary": "forbidden" }, body: { mounted: false } };
            if (ctx.query.case === "status") return { status: 201,
              headers: { "content-type": "application/json", "cache-control": "no-store, private" },
              body: { mounted: false } };
            return { status: 409, headers: { "content-type": "application/json",
              "cache-control": "no-store, private", etag: `"${"b".repeat(64)}"`,
              "x-unseen-memory-etag": "memory-etag" }, body: { error: { code: "version_conflict" } } };
          }
          if (action.endpoint === pdfRoute.endpoint) return { status: 200, headers: {
            "content-type": "application/pdf", "content-disposition": "attachment; filename=unseen-book-version-01.pdf",
            "content-length": ctx.query.case === "length" ? String(pdf.length + 1) : String(pdf.length),
            etag: `"${pdfHash}"`, "cache-control": "no-store, private",
            "x-content-type-options": "nosniff" }, body: pdf };
          return { status: 200, headers: { "content-type": "application/json",
            "cache-control": "no-store, private" }, body: { mounted: true } };
        }
      });
      for (const operation of coverage.internalOperationCoverage) input.registerInternalJobs({
        endpoint: operation.endpoint, handler: () => ({ mounted: true })
      });
      return { enabled: true };
    }
  }) });
  try {
    await api.ready;
    const conflict = await api.handle({ method: route.method, path: "/v2-labs/memories/photos/photo-a" });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.headers, { "content-type": "application/json", "cache-control": "no-store, private",
      etag: `"${"b".repeat(64)}"`, "x-unseen-memory-etag": "memory-etag" });
    assert.deepEqual(conflict.body, { error: { code: "version_conflict" } });

    const signed = await api.handle({ method: route.method,
      path: "/v2-labs/memories/photos/photo-a?case=book-etag" });
    assert.equal(signed.status, 200);
    assert.deepEqual(signed.headers, { "content-type": "application/json", "cache-control": "no-store, private",
      etag: bookEtag, "x-unseen-book-etag": bookToken });
    assert.deepEqual(signed.body, { mounted: true });

    for (const mode of Object.keys(invalidEtags)) {
      const writes = api.db.prepare("SELECT total_changes() count").get().count;
      const rejected = await api.handle({ method: route.method,
        path: `/v2-labs/memories/photos/photo-a?case=${mode}` });
      assert.equal(rejected.status, 503, mode);
      assert.equal(rejected.body.error.code, "book_lab_extension_unavailable", mode);
      assert.equal(api.db.prepare("SELECT total_changes() count").get().count, writes, mode);
    }

    for (const mode of ["cookie", "redirect", "arbitrary", "status"]) {
      const rejected = await api.handle({ method: route.method,
        path: `/v2-labs/memories/photos/photo-a?case=${mode}` });
      assert.equal(rejected.status, 503, mode);
      assert.equal(rejected.body.error.code, "book_lab_extension_unavailable", mode);
      assert.equal(Object.hasOwn(rejected.headers, "set-cookie"), false, mode);
      assert.equal(Object.hasOwn(rejected.headers, "location"), false, mode);
    }

    const pdfResponse = await api.handle({ method: pdfRoute.method,
      path: pdfRoute.endpoint.replace("{spaceId}", "space-a").replace("{bookId}", "book-a")
        .replace("{versionId}", "version-a") });
    assert.equal(pdfResponse.status, 200);
    assert.deepEqual(pdfResponse.body, pdf);
    assert.deepEqual(pdfResponse.headers, { "content-type": "application/pdf",
      "content-disposition": "attachment; filename=unseen-book-version-01.pdf",
      "content-length": String(pdf.length), etag: `"${pdfHash}"`, "cache-control": "no-store, private",
      "x-content-type-options": "nosniff" });
    const lengthMismatch = await api.handle({ method: pdfRoute.method,
      path: `${pdfRoute.endpoint.replace("{spaceId}", "space-a").replace("{bookId}", "book-a")
        .replace("{versionId}", "version-a")}?case=length` });
    assert.equal(lengthMismatch.status, 503);
    assert.equal(lengthMismatch.body.error.code, "book_lab_extension_unavailable");
  } finally { api.close(); }
});

test("Book extension registration validates structure and never publishes a partial mount", async () => {
  for (const register of [
    () => {},
    (input) => { input.registerRoutes(route); },
    (input) => { input.registerInternalJobs(job); },
    (input) => { input.registerRoutes(route); input.registerRoutes({ ...route, template: "/v2-labs/not-frozen" }); },
    (input) => { input.registerInternalJobs(job); input.registerInternalJobs({ ...job, endpoint: "internal:not-frozen" }); },
    (input) => { input.registerRoutes(route); input.appendAudit({ eventType: "book_lab_registration_write" }); }
  ]) {
    const api = new LocalApi({ featureFlags: { bookLab: true }, extensionModuleLoader: async () => ({
      registerBookLabExtension: (input) => { register(input); return { enabled: true }; }
    }) });
    try {
      const writes = api.db.prepare("SELECT total_changes() count").get().count;
      await assert.rejects(api.ready, (error) => error.code === "book_lab_extension_unavailable");
      assert.equal(api.routes.filter((item) => item.template.startsWith("/v2-labs/")).length, 0);
      assert.equal(api.internalJobs.size, 0);
      assert.equal(api.db.prepare("SELECT total_changes() count").get().count, writes);
    } finally { api.close(); }
  }
});

test("Book Core callbacks enforce the current photo contributor, isolate audit, and fail closed on missing projection", async () => {
  let extension;
  const f = fixture({ featureFlags: { bookLab: true }, extensionModuleLoader: async () => ({
    registerBookLabExtension: (input) => { extension = input; registerAll(input); return { enabled: true }; }
  }) });
  try {
    await f.api.ready;
    const owner = await f.login("book-core-owner@example.test");
    const stranger = await f.login("book-core-stranger@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);

    const ownerPrincipal = extension.authorizeCorePhotoParticipant({ accountSession: owner.token }, flow.committed.photoId);
    assert.equal(ownerPrincipal.kind, "account");
    assert.equal(ownerPrincipal.contributorId, owner.accountId);
    assert.throws(() => extension.authorizeCorePhotoParticipant({ accountSession: stranger.token },
      flow.committed.photoId), (error) => error.code === "photo_unavailable");
    const receipt = await exchangeReceipt(f, flow.finalized, "book-core-receipt-abcdefgh");
    assert.equal(receipt.status, 200);
    assert.equal(extension.authorizeCorePhotoParticipant({ receiptSession: receipt.body.receiptSessionSecret },
      flow.committed.photoId).kind, "receipt");
    assert.throws(() => extension.readCorePhotoContext({ accountSession: owner.token }, flow.committed.photoId),
      (error) => error.code === "photo_unavailable");

    const beforeAudit = f.db.prepare("SELECT COUNT(*) count FROM audit_events").get().count;
    extension.appendAudit({ spaceId: space.spaceId, aggregateType: "book_lab_memory",
      aggregateId: "memory-a", eventType: "book_lab_memory_opened", actorKind: "account",
      authorizationId: ownerPrincipal.authorizationId, detail: { photoId: flow.committed.photoId },
      requestId: "book-runtime-test" });
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM audit_events").get().count, beforeAudit + 1);
    assert.throws(() => extension.appendAudit({ spaceId: space.spaceId, aggregateType: "book_lab_memory",
      aggregateId: "memory-a", eventType: "book_lab_answer_saved", actorKind: "account",
      authorizationId: ownerPrincipal.authorizationId, detail: { originalUserText: "must not enter Core audit" },
      requestId: "book-runtime-test" }), (error) => error.code === "book_lab_extension_unavailable");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM audit_events").get().count, beforeAudit + 1);
  } finally { f.close(); }
});

test("Book Core read ports enforce capabilities/currentness and never fabricate facts or derivative bytes", async () => {
  let extension;
  const f = fixture({ featureFlags: { bookLab: true }, extensionModuleLoader: async () => ({
    registerBookLabExtension: (input) => { extension = input; registerAll(input); return { enabled: true }; }
  }) });
  try {
    await f.api.ready;
    const owner = await f.login("book-host-port-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id);
    f.db.prepare("UPDATE photos SET captured_at='2026-08-13T04:34:56.000Z' WHERE id=?").run(photo.id);
    const placed = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 42, pitchDeg: 3, regionId: "main",
      reason: "book-host-port-test"
    }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    // A: f.createSpace() now defaults auto_approve_uploads on, so the photo may already
    // be 'visible' — only approve if it still actually needs it.
    const approvalState = f.db.prepare("SELECT photo_content_state,version FROM photos WHERE id=?").get(photo.id);
    if (approvalState.photo_content_state === "pending") {
      await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
        to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null
      }, { ...owner.headers, "if-match": String(approvalState.version) });
    }
    const receipt = await exchangeReceipt(f, flow.finalized, "book-host-receipt-exchange");
    const currentSpace = f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 1
    }, { ...owner.headers, "if-match": String(currentSpace.version) });
    const origin = { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787",
      "sec-fetch-site": "same-origin", "x-public-origin": "http://127.0.0.1:8787",
      "x-public-host": "127.0.0.1:8787" };
    const publicCampaignId = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
    const challenge = await f.ok("POST", "/v1/external-campaign-admission-challenges",
      { publicCampaignId, clientNonce: "book-host-external-viewer-nonce" }, origin);
    const admission = await f.ok("POST", "/v1/external-campaign-admissions",
      { publicCampaignId, clientNonce: "book-host-external-viewer-nonce" },
      { ...origin, "x-campaign-challenge": challenge.challengeCookieSecret });
    const external = await f.ok("POST", "/v1/external-invitation-exchanges",
      { secretFromClearedInviteBootstrap: admission.oneTimeSecret });

    const writes = f.db.prepare("SELECT total_changes() count").get().count;
    const ctx = { accountSession: owner.token, receiptSession: null, viewerSession: null,
      contributorSession: null, headers: owner.headers };
    const principal = extension.authenticateBookLabParticipant(ctx);
    assert.equal(principal.kind, "account");
    assert.equal(principal.contributorId, owner.accountId);
    assert.equal(principal.allowedPhotoIds, null);
    // Identity priority, not existence-based rejection: the guest flow legitimately carries a viewer
    // session (came in via an invite link) and/or a contributor session (mid-upload) alongside the
    // identity that actually proves photo ownership; those unrelated session kinds must not veto it.
    const withViewerAndContributor = { ...ctx, viewerSession: external.viewerSessionSecret,
      contributorSession: "unrelated-contributor-session",
      headers: { ...owner.headers, "x-viewer-session": external.viewerSessionSecret,
        "x-contributor-session": "unrelated-contributor-session" } };
    assert.equal(extension.authenticateBookLabParticipant(withViewerAndContributor).kind, "account");
    // account and receipt both present and both actually bound to the same photo: account wins (see the
    // authenticateBookLabParticipant() comment — either order is safe since the real boundary is the
    // downstream contributorId match, not this priority choice).
    assert.equal(extension.authenticateBookLabParticipant({ ...ctx, receiptSession: receipt.body.receiptSessionSecret,
      headers: { ...owner.headers, "x-receipt-session": receipt.body.receiptSessionSecret } }).kind, "account");
    // no account and no receipt: a viewer/contributor session alone is still not a photo-contributor
    // identity, and stays rejected.
    assert.equal(extension.authenticateBookLabParticipant({ accountSession: null, receiptSession: null,
      viewerSession: external.viewerSessionSecret, contributorSession: "unrelated-contributor-session",
      headers: { "x-viewer-session": external.viewerSessionSecret,
        "x-contributor-session": "unrelated-contributor-session" } }), null);
    const source = extension.readBookLabParticipantPhoto(principal, photo.id);
    assert.equal(source.photoId, photo.id);
    assert.equal(source.l3Enabled, false);
    assert.deepEqual(source.visibleFacts, []);
    assert.equal(source.provenance.capturedAt, "2026-08-13T04:34:56.000Z");
    assert.deepEqual(extension.listBookLabEligibleBooks(principal, space.spaceId), []);
    const workerSource = extension.readQuestionSourceForWorker({ photoId: photo.id,
      contributorId: owner.accountId });
    assert.equal(workerSource.photoId, photo.id);
    assert.equal(workerSource.l3Enabled, false);
    assert.deepEqual(workerSource.visibleFacts, []);
    assert.equal(extension.readQuestionSourceForWorker({ photoId: photo.id,
      contributorId: "wrong-contributor" }), null);
    assert.throws(() => extension.readQuestionSourceForWorker({ photoId: photo.id,
      contributorId: owner.accountId, accountSession: owner.token }),
    (error) => error.code === "book_lab_extension_unavailable");

    const currentOwner = extension.readCurrentBookLabOwner(ctx, space.spaceId);
    assert.equal(currentOwner.kind, "owner");
    assert.equal(extension.revalidateCurrentBookLabOwner(currentOwner), true);
    const ownerSnapshot = extension.readBookLabOwnerSnapshot(space.spaceId);
    assert.equal(extension.revalidateCurrentBookLabOwner(ownerSnapshot), true);
    assert.equal(extension.readBookLabEventForOwner(currentOwner, "event-does-not-exist"), null);
    const display = await extension.readBookLabDisplayPhoto(currentOwner, photo.id);
    assert.equal(display.l3Enabled, false);
    assert.deepEqual(display.visibleFacts, []);
    assert.equal(Object.hasOwn(display, "renderAsset"), true);
    const derivative = await extension.readBookLabRenderDerivative(currentOwner, photo.id);
    assert.equal(derivative.sourcePhotoContentHash, source.provenance.photoContentHash);
    assert.equal(derivative.sourcePhotosVersion, source.provenance.sourcePhotosVersion);
    assert.equal(sha256(Buffer.from(derivative.bytesBase64, "base64")), derivative.contentHash);

    const viewer = extension.readCurrentBookLabViewer(ctx, space.spaceId);
    assert.equal(viewer.kind, "owner");
    assert.equal(extension.revalidateCurrentBookLabViewer(viewer), true);
    const externalViewer = extension.readCurrentBookLabViewer({ accountSession: null,
      receiptSession: null, viewerSession: external.viewerSessionSecret, contributorSession: null,
      headers: { "x-viewer-session": external.viewerSessionSecret } }, space.spaceId);
    assert.equal(externalViewer.kind, "external_viewer");
    assert.equal(extension.revalidateCurrentBookLabViewer(externalViewer), true);
    assert.equal((await extension.readBookLabDisplayPhoto(externalViewer, photo.id)).photoId, photo.id);
    assert.throws(() => extension.readBookLabDisplayPhoto({ ...currentOwner }, photo.id),
      (error) => error.code === "book_lab_extension_unavailable");
    const receiptPrincipal = extension.authenticateBookLabParticipant({ accountSession: null,
      receiptSession: receipt.body.receiptSessionSecret, viewerSession: null, contributorSession: null,
      headers: { "x-receipt-session": receipt.body.receiptSessionSecret } });
    assert.equal(receiptPrincipal.kind, "receipt");
    assert.deepEqual(receiptPrincipal.allowedPhotoIds, [photo.id]);
    assert.equal(extension.readBookLabParticipantPhoto(receiptPrincipal, photo.id).photoId, photo.id);
    assert.equal(f.db.prepare("SELECT total_changes() count").get().count, writes,
      "all Core Book callbacks and MediaStore reads stay read-only");

    f.db.prepare("UPDATE spaces SET version=version+1 WHERE id=?").run(space.spaceId);
    assert.equal(extension.revalidateCurrentBookLabOwner(currentOwner), false);
    assert.equal(extension.revalidateCurrentBookLabViewer(viewer), false);
    assert.equal(await extension.readBookLabDisplayPhoto(currentOwner, photo.id), null);
  } finally { f.close(); }
});

test("Book Event identity is the exact current owner Space and stays read-only", async () => {
  let extension;
  const f = fixture({ featureFlags: { bookLab: true }, extensionModuleLoader: async () => ({
    registerBookLabExtension: (input) => { extension = input; registerAll(input); return { enabled: true }; }
  }) });
  try {
    await f.api.ready;
    const owner = await f.login("book-event-owner@example.test");
    const nextOwner = await f.login("book-event-next-owner@example.test");
    const space = await f.createSpace(owner, "我们的婚礼");
    const otherSpace = await f.createSpace(owner, "旅行记忆");
    const currentOwner = extension.readCurrentBookLabOwner({ accountSession: owner.token,
      receiptSession: null, viewerSession: null, contributorSession: null, headers: owner.headers }, space.spaceId);
    const readOnlyEvent = (eventId) => {
      const before = f.db.prepare("SELECT total_changes() count").get().count;
      const value = extension.readBookLabEventForOwner(currentOwner, eventId);
      assert.equal(f.db.prepare("SELECT total_changes() count").get().count, before,
        "Event projection never writes Core state");
      return value;
    };

    const event = readOnlyEvent(space.spaceId);
    assert.deepEqual(event, { active: true, eventId: space.spaceId, spaceId: space.spaceId,
      title: "我们的婚礼", version: space.version });
    assert.equal(Object.isFrozen(event), true);
    assert.throws(() => extension.readBookLabEventForOwner({ ...currentOwner }, space.spaceId),
      (error) => error.code === "book_lab_extension_unavailable");
    assert.equal(readOnlyEvent("event-does-not-exist"), null);
    assert.equal(readOnlyEvent(otherSpace.spaceId), null);

    f.db.prepare("UPDATE spaces SET space_lifecycle='archived' WHERE id=?").run(space.spaceId);
    assert.equal(readOnlyEvent(space.spaceId), null);
    f.db.prepare("UPDATE spaces SET space_lifecycle='active' WHERE id=?").run(space.spaceId);
    f.db.prepare("UPDATE spaces SET owner_account_id=? WHERE id=?").run(nextOwner.accountId, space.spaceId);
    assert.equal(readOnlyEvent(space.spaceId), null);
    f.db.prepare("UPDATE spaces SET owner_account_id=? WHERE id=?").run(owner.accountId, space.spaceId);
    f.db.prepare("UPDATE accounts SET session_epoch=session_epoch+1 WHERE id=?").run(owner.accountId);
    assert.equal(readOnlyEvent(space.spaceId), null);
    f.db.prepare("UPDATE accounts SET session_epoch=session_epoch-1 WHERE id=?").run(owner.accountId);
    f.db.prepare("UPDATE spaces SET version=version+1 WHERE id=?").run(space.spaceId);
    assert.equal(readOnlyEvent(space.spaceId), null);
  } finally { f.close(); }
});

test("Book Lab identity priority ignores unrelated session cookies without crossing the contributorId/allowedPhotoIds boundary", async () => {
  let extension;
  const f = fixture({ featureFlags: { bookLab: true }, extensionModuleLoader: async () => ({
    registerBookLabExtension: (input) => { extension = input; registerAll(input); return { enabled: true }; }
  }) });
  try {
    await f.api.ready;
    const owner = await f.login("book-priority-owner@example.test");
    const stranger = await f.login("book-priority-stranger@example.test");
    let spaceA = await f.createSpace(owner);
    spaceA = await f.openSpace(owner, spaceA);
    let spaceB = await f.createSpace(stranger);
    spaceB = await f.openSpace(stranger, spaceB);
    const flowA = await createAccountUpload(f, owner, spaceA);
    const flowB = await createAccountUpload(f, stranger, spaceB);
    const receiptA = await exchangeReceipt(f, flowA.finalized, "book-priority-receipt-a-abcdefgh");
    const receiptB = await exchangeReceipt(f, flowB.finalized, "book-priority-receipt-b-abcdefgh");
    assert.equal(receiptA.status, 200);
    assert.equal(receiptB.status, 200);

    // Pure viewer/contributor sessions (no account, no receipt) prove no photo ownership and stay rejected —
    // their mere presence never becomes a fallback identity.
    assert.equal(extension.authenticateBookLabParticipant({ accountSession: null, receiptSession: null,
      viewerSession: "stray-viewer-session", contributorSession: "stray-contributor-session",
      headers: { "x-viewer-session": "stray-viewer-session", "x-contributor-session": "stray-contributor-session" } }),
    null);

    // A garbage/nonexistent receipt secret still fails closed via the try/catch — removing the old
    // existence-based XOR guard does not weaken validation of the secret itself.
    assert.equal(extension.authenticateBookLabParticipant({ accountSession: null,
      receiptSession: "not-a-real-receipt-secret", viewerSession: null, contributorSession: null,
      headers: { "x-receipt-session": "not-a-real-receipt-secret" } }), null);

    // The real guest shape: viewer + contributor + receipt all present at once (invite-link admission,
    // mid-upload contributor cookie, and the batch receipt) authenticates as receipt, scoped to that
    // receipt's own batch only.
    const receiptAWithGuestCookies = extension.authenticateBookLabParticipant({ accountSession: null,
      receiptSession: receiptA.body.receiptSessionSecret, viewerSession: "guest-viewer-session",
      contributorSession: "guest-contributor-session",
      headers: { "x-receipt-session": receiptA.body.receiptSessionSecret, "x-viewer-session": "guest-viewer-session",
        "x-contributor-session": "guest-contributor-session" } });
    assert.equal(receiptAWithGuestCookies.kind, "receipt");
    assert.equal(receiptAWithGuestCookies.contributorId, owner.accountId);
    assert.deepEqual(receiptAWithGuestCookies.allowedPhotoIds, [flowA.committed.photoId]);

    // Red team: receiptA's principal cannot be used to reach flowB's photo, which lives in a different
    // batch and a different space — allowedPhotoIds and the space scoping in readBookLabParticipantPhoto()
    // are the real boundary and are untouched by this fix.
    assert.equal(extension.readBookLabParticipantPhoto(receiptAWithGuestCookies, flowB.committed.photoId), null);
    assert.equal(extension.listBookLabEligibleBooks(receiptAWithGuestCookies, spaceB.spaceId).length, 0);

    // account + viewer + contributor coexist (the owner who also opened their own invite link, or is
    // mid-upload): authenticates as account, not rejected, and still cannot be redirected at another
    // space/stranger's identity by the unrelated cookies.
    const accountCtx = { accountSession: owner.token, receiptSession: null, viewerSession: "owner-viewer-session",
      contributorSession: "owner-contributor-session",
      headers: { ...owner.headers, "x-viewer-session": "owner-viewer-session",
        "x-contributor-session": "owner-contributor-session" } };
    const ownerPrincipal = extension.authenticateBookLabParticipant(accountCtx);
    assert.equal(ownerPrincipal.kind, "account");
    assert.equal(ownerPrincipal.contributorId, owner.accountId);
    assert.equal(ownerPrincipal.allowedPhotoIds, null);

    // account and receipt both present and both genuinely bound to the same photo: account wins. Either
    // priority is equally safe here since both resolve to the same contributorId for this batch — see the
    // authenticateBookLabParticipant() source comment for why the choice does not matter for security.
    const bothPresent = extension.authenticateBookLabParticipant({ ...accountCtx,
      receiptSession: receiptA.body.receiptSessionSecret,
      headers: { ...accountCtx.headers, "x-receipt-session": receiptA.body.receiptSessionSecret } });
    assert.equal(bothPresent.kind, "account");
    assert.equal(bothPresent.contributorId, owner.accountId);

    // readCurrentBookLabOwner: an unrelated receipt/viewer/contributor session must not veto a valid owner
    // account session (contract §4 space-owner is exclusively account-based) ...
    const ownerRead = extension.readCurrentBookLabOwner({ accountSession: owner.token,
      receiptSession: receiptA.body.receiptSessionSecret, viewerSession: "stray-viewer",
      contributorSession: "stray-contributor",
      headers: { ...owner.headers, "x-receipt-session": receiptA.body.receiptSessionSecret,
        "x-viewer-session": "stray-viewer", "x-contributor-session": "stray-contributor" } }, spaceA.spaceId);
    assert.equal(ownerRead.kind, "owner");
    assert.equal(ownerRead.accountId, owner.accountId);
    // ... but a stranger's account carrying the exact same stray sessions is still not spaceA's owner —
    // no escalation from the relaxed check.
    assert.equal(extension.readCurrentBookLabOwner({ accountSession: stranger.token, receiptSession: null,
      viewerSession: null, contributorSession: null, headers: stranger.headers }, spaceA.spaceId), null);

    // readCurrentBookLabViewer: account + external-viewer session coexisting (same "opened my own invite
    // link" shape) authenticates as owner via the account branch rather than being rejected by the old
    // account-XOR-viewer check.
    const viewerRead = extension.readCurrentBookLabViewer({ accountSession: owner.token, receiptSession: null,
      viewerSession: "stray-external-viewer-session", contributorSession: null,
      headers: { ...owner.headers, "x-viewer-session": "stray-external-viewer-session" } }, spaceA.spaceId);
    assert.equal(viewerRead.kind, "owner");
    assert.equal(viewerRead.accountId, owner.accountId);
  } finally { f.close(); }
});
