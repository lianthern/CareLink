import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDedicatedRendererClient } from
  "../../../infra/integration/book-lab/renderer-client.mjs";
import { createDedicatedRendererService } from
  "../../../infra/integration/book-lab/renderer-service.mjs";
import { rendererChildSeccompHash } from
  "../../../infra/integration/book-lab/linux-child-seccomp.mjs";
import { BOOK_RENDER_LEASE_MS, RENDERER_PROTOCOL, RENDERER_WHOLE_TIMEOUT_MS, createRendererRequest,
  secureReadFile, validateRendererAcceptanceReceipt, validateRendererResult } from
  "../../../infra/integration/book-lab/renderer-ipc-protocol.mjs";
import { CHROMIUM_SNAP_ADAPTER_POLICY, CHROMIUM_SNAP_ADAPTER_POLICY_SHA256, CHROMIUM_SNAP_BROWSER,
  CHROMIUM_SNAP_ROOT, chromiumSnapAdapterImplementationHash } from
  "../../../infra/integration/book-lab/chromium-snap-headless-adapter.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function processorRequest(renderJobId, inputHash) {
  return { renderJobId, jobVersion: 1, draftVersionId: `draft-${renderJobId}`, manifestHash: "5".repeat(64),
    grantSetHash: "6".repeat(64), sourceSnapshotHash: "7".repeat(64),
    authorizedMemoryTextSnapshotHash: "8".repeat(64), assetSnapshotHash: "9".repeat(64),
    accessControlVersion: 1, inputHash, attempt: 1 };
}

function acceptance(directory) {
  const uid = process.getuid();
  const gid = process.getgid();
  const receipt = {
    schema: "unseen-book-renderer-acceptance/1",
    profile: RENDERER_PROTOCOL,
    candidateCommit: "a".repeat(40),
    candidateTree: "0".repeat(40),
    rendererBuildHash: "b".repeat(64),
    node: { path: "/opt/unseen/runtime/node-v22.23.2-linux-x64/bin/node", sha256: "8".repeat(64),
      version: "v22.23.2" },
    nodeDistribution: { schema: "unseen-node-runtime-distribution/1",
      archiveUrl: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz",
      archivePath: "/opt/unseen/runtime/sources/node-v22.23.2/node-v22.23.2-linux-x64.tar.xz",
      archiveSha256: "9".repeat(64), archiveBytes: 123,
      signedShasumsUrl: "https://nodejs.org/dist/v22.23.2/SHASUMS256.txt.asc",
      signedShasumsPath: "/opt/unseen/runtime/sources/node-v22.23.2/SHASUMS256.txt.asc",
      signedShasumsSha256: "a".repeat(64),
      releaseKeyringUrl: "https://raw.githubusercontent.com/nodejs/release-keys/" +
        "b28073028e6d6855cfb53bf7fa0137599c01f967/gpg/pubring.kbx",
      releaseKeyringPath: "/opt/unseen/runtime/trust/" +
        "node-release-keys-b28073028e6d6855cfb53bf7fa0137599c01f967.kbx",
      releaseKeyringSha256: "b".repeat(64), releaseKeyringBytes: 456,
      releaseKeysCommit: "b28073028e6d6855cfb53bf7fa0137599c01f967",
      verificationMethod: "gpgv-pinned-keyring+signed-shasums+sha256sum/v1",
      checksumPinPath: "/run/unseen/approvals/node-runtime.sha256", checksumPinSha256: "c".repeat(64) },
    browser: { path: CHROMIUM_SNAP_BROWSER, sha256: "c".repeat(64), version: "Chromium 151.0.7922.108" },
    browserDistribution: { schema: "unseen-chromium-snap-distribution/1", name: "chromium",
      snapId: "XKEcBqPM06H1Z7zGOdG5fbICuf8NWK5R", revision: 3507, version: "151.0.7922.108", arch: "amd64",
      numericRoot: CHROMIUM_SNAP_ROOT, archivePath: "/var/lib/snapd/snaps/chromium_3507.snap",
      archiveSha256: "cf10676bdf7a3b4d14201fd6004ec5c8c137ee7365779133cba7c1d39263fae0",
      archiveSha3384: "77155504d7c5fdfa516545da086bd3f31fa6f6283901e93885cbb39366ae55bea834c4042bebfc870a0330904df04c07",
      archiveBytes: 202_833_920,
      archiveLinkTopology: { schema: "unseen-snapd-cache-link-topology/1",
        state: "ARCHIVE_AND_SNAPD_SHA3_CACHE", linkCount: 2,
        policySha256: "49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5" },
      assertionSha256: "1835e6aed1d9a03ea7b42f44d01feac6fd81e2e7d72a4e27d0c97f742bdad94c",
      snapDeclarationSha256: "f405bbc39c1ba0036c25f9b0a3f8df50fb1f43a94a489bc76fe1b8d956bce080",
      signingAccountKeySha256: "a1182464402e4e7c8ee10650eb2ec247ffd2496216c9a4f3d40eac39a928b340",
      assertionSignatureVerified: false,
      metaSha256: "eca508d9238f611e2ca4757da991e9c7624a1f3eff499936e73a38d0652b0aa0",
      officialLauncherSha256: "fd5dec09e3f53f1bf0c5cd52eafc39de8bff954bd2b4aeae1850faa0cc97e166",
      officialLauncherBytes: 6_365, launchpadCommit: "c7d4a5ffee0e71a3888a69f56892957cdfb8c919",
      launchpadTree: "5ced77dd54c618cc398943f587847c62473a0457",
      launchpadManifestSha256: "4e344dc0081b3bcccdb47640c4c4c8300a4f3fa0e6f1d7609e08257bf797e92a",
      treeManifestSha256: "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913",
      treeEntryCount: 683, treeRegularFileCount: 591, treeSymlinkCount: 27, treeRegularBytes: 446_326_676,
      resourceManifestSha256: "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5",
      resourceCount: 224, canonicalDanglingSymlinkCount: 2,
      canonicalDanglingSymlinkPolicySha256: "3c3f99c6d62feffb90a873bc245930045a1e42bdc0c3b1e5c2a763208586b128",
      runtimeReachability: "ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE",
      licenseDeclaration: "UNDECLARED_IN_CANONICAL_ASSERTION_AND_LOCAL_META",
      securityReview: "REQUIRED_NOT_INCLUDED", releaseDecision: "NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED" },
    browserAdapter: { ...CHROMIUM_SNAP_ADAPTER_POLICY,
      implementationSha256: chromiumSnapAdapterImplementationHash(),
      policySha256: CHROMIUM_SNAP_ADAPTER_POLICY_SHA256 },
    bwrap: { path: "/usr/bin/bwrap", sha256: "d".repeat(64), version: "bubblewrap 0.9.0" },
    appArmor: { profile: "unseen-book-renderer", sha256: "e".repeat(64), loaded: true },
    seccomp: { schema: "unseen-book-renderer-child-seccomp/1", sha256: rendererChildSeccompHash(),
      deniedSocketFamilies: ["AF_INET", "AF_INET6", "AF_NETLINK", "AF_PACKET"],
      deniedSyscalls: ["mount", "pivot_root", "setns", "umount2", "unshare", "clone3"] },
    fonts: { sha256: "f".repeat(64), count: 1 }, pdfTools: { sha256: "1".repeat(64), count: 2 },
    systemd: { sha256: "2".repeat(64), serviceSha256: "3".repeat(64), socketSha256: "4".repeat(64),
      effectivePropertiesSha256: "5".repeat(64) },
    cups: { connected: false, gate: "deny-and-verify", serviceActive: false, listenerCount: 0 },
    principals: { apiUid: uid, rendererUid: uid, rendererGid: gid, ipcGid: gid, apiUser: "unseen",
      rendererUser: "unseen-renderer", ipcGroup: "unseen-render-ipc" },
    targetVerification: { schema: "unseen-book-renderer-target-verification/1",
      verifierBuildHash: "6".repeat(64), measurementsHash: "7".repeat(64) },
    readOnlyMounts: ["/usr", CHROMIUM_SNAP_ROOT, "/opt/unseen/runtime/node-v22.23.2-linux-x64"]
  };
  const filename = path.join(directory, "acceptance.json");
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  writeFileSync(filename, bytes, { mode: 0o640 });
  chmodSync(filename, 0o640);
  return { filename, hash: sha256(bytes), uid, gid };
}

test("dedicated renderer performs filesystem AF_UNIX true I/O without artifact bytes in control/result JSON", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-ipc-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receipt = acceptance(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  let active = 0;
  let maximum = 0;
  let calls = 0;
  let artifactReads = 0;
  let acknowledgements = 0;
  let failOnce = true;
  let resolveHtmlDeleted;
  const htmlDeleted = new Promise((resolve) => { resolveHtmlDeleted = resolve; });
  const resultManifests = [];
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: receipt.filename, acceptanceReceiptHash: receipt.hash,
    expectedReceiptUid: receipt.uid, initializeDirectories: true,
    checkpoint(name, requestId) {
      if (name === "after_manifest") resultManifests.push(readFileSync(path.join(spoolRoot, "results",
        `${requestId}.json`), "utf8"));
      if (name === "after_ack_html_delete") resolveHtmlDeleted();
      if (name === "after_ack_cleanup_marker") acknowledgements += 1;
    },
    async render(request) {
      active += 1;
      maximum = Math.max(maximum, active);
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      if (request.input.manifest.bookId === "book-fail-once" && failOnce) {
        failOnce = false;
        return { status: "failed", stableError: "render_failed" };
      }
      return request.kind === "preview" ? { status: "ready", html: "<main>synthetic</main>",
        htmlHash: sha256("<main>synthetic</main>"), pageCount: 1, htmlArtifactId: "preview-test",
        equality: { pageCount: 1, orderedPageIds: ["page-1"] } } :
        { status: "ready", html: "<main>synthetic frozen</main>",
        htmlHash: sha256("<main>synthetic frozen</main>"), pdfBytes: Buffer.from("%PDF-test"),
        pdfHash: sha256("%PDF-test"), pageCount: 1,
        equality: { pageCount: 1, orderedPageIds: ["page-1"] },
        receipt: { schemaVersion: "synthetic-not-acceptance",
          equality: { pageCount: 1, orderedPageIds: ["page-1"] } } };
    } });
  t.after(() => service.close());
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: receipt.filename, acceptanceReceiptHash: receipt.hash,
    expectedReceiptUid: receipt.uid,
    async testOnlyBeforeArtifactRead() {
      artifactReads += 1;
      // Without single-flight, subscriber two resumes only after subscriber one ACK-deletes this HTML: ENOENT.
      if (artifactReads === 2) await htmlDeleted;
    } });
  const processor = processorRequest("job-1", "3".repeat(64));
  const input = { inputHash: "3".repeat(64), manifest: { bookId: "book-1" } };
  // 0a2d2de returned one flight promise/object; these identity checks fail deterministically on that parent.
  const subscriptions = Array.from({ length: 12 }, () =>
    client.render({ kind: "preview", processorRequest: processor, input }));
  assert.notEqual(subscriptions[0], subscriptions[1]);
  const results = await Promise.all(subscriptions);
  const [first, second] = results;
  assert.equal(new Set(results).size, 12);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.equality, second.equality);
  assert.notEqual(first.equality.orderedPageIds, second.equality.orderedPageIds);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.equality), true);
  assert.equal(Object.isFrozen(first.equality.orderedPageIds), true);
  assert.throws(() => { first.equality.pageCount = 2; }, TypeError);
  assert.throws(() => { first.equality.orderedPageIds.push("forged"); }, TypeError);
  assert.equal(second.equality.pageCount, 1);
  assert.deepEqual(second.equality.orderedPageIds, ["page-1"]);
  assert.equal(first.html, "<main>synthetic</main>");
  assert.equal(calls, 1);
  assert.equal(maximum, 1);
  assert.equal(artifactReads, 1);
  assert.equal(acknowledgements, 1);

  const afterSettle = await client.render({ kind: "preview", processorRequest: processor, input });
  assert.notEqual(afterSettle, first);
  assert.notEqual(afterSettle.equality, first.equality);
  assert.equal(calls, 2);
  assert.equal(artifactReads, 2);
  assert.equal(acknowledgements, 2);

  const failedProcessor = processorRequest("job-fail-once", "a".repeat(64));
  const failedInput = { inputHash: "a".repeat(64), manifest: { bookId: "book-fail-once" } };
  const failedResults = await Promise.all(Array.from({ length: 12 }, () =>
    client.render({ kind: "preview", processorRequest: failedProcessor, input: failedInput })));
  assert.equal(new Set(failedResults).size, 12);
  assert.ok(failedResults.every((result) => Object.isFrozen(result)));
  assert.deepEqual(failedResults[0], { status: "failed", stableError: "render_failed" });
  assert.notEqual(failedResults[0], failedResults[1]);
  assert.throws(() => { failedResults[0].stableError = "forged"; }, TypeError);
  assert.equal(failedResults[1].stableError, "render_failed");
  assert.equal(calls, 3);
  assert.equal(acknowledgements, 3);
  const recovered = await client.render({ kind: "preview", processorRequest: failedProcessor, input: failedInput });
  assert.equal(recovered.status, "ready");
  assert.equal(calls, 4);
  assert.equal(acknowledgements, 4);

  const frozenProcessor = processorRequest("job-2", "4".repeat(64));
  const frozenInput = { ...input, inputHash: "4".repeat(64) };
  const [frozen, frozenPeer] = await Promise.all([
    client.render({ kind: "frozen", processorRequest: frozenProcessor, input: frozenInput }),
    client.render({ kind: "frozen", processorRequest: frozenProcessor, input: frozenInput })]);
  assert.notEqual(frozen, frozenPeer);
  assert.notEqual(frozen.equality, frozenPeer.equality);
  assert.notEqual(frozen.receipt, frozenPeer.receipt);
  assert.notEqual(frozen.receipt.equality, frozenPeer.receipt.equality);
  assert.equal(Object.isFrozen(frozen.receipt), true);
  assert.equal(Object.isFrozen(frozen.receipt.equality), true);
  assert.equal(Object.isFrozen(frozen.receipt.equality.orderedPageIds), true);
  assert.throws(() => { frozen.receipt.equality.pageCount = 2; }, TypeError);
  assert.throws(() => { frozen.receipt.equality.orderedPageIds.push("forged"); }, TypeError);
  assert.equal(frozenPeer.receipt.equality.pageCount, 1);
  assert.equal(Buffer.from(frozen.pdfBase64, "base64").toString(), "%PDF-test");
  assert.equal(typeof frozen.pdfBase64, "string");
  assert.equal(calls, 5);
  assert.equal(artifactReads, 4);
  assert.equal(acknowledgements, 5);
  assert.equal(resultManifests.some((value) => value.includes("pdfBase64") || value.includes("%PDF-test")), false);
  await service.idle();
});

test("shared renderer timeout clears its flight so the same request can retry", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-timeout-flight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receipt = acceptance(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  let delayFirstReady = true;
  let releaseFirstReady;
  const firstReadyGate = new Promise((resolve) => { releaseFirstReady = resolve; });
  t.after(() => releaseFirstReady());
  let calls = 0;
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: receipt.filename, acceptanceReceiptHash: receipt.hash,
    expectedReceiptUid: receipt.uid, initializeDirectories: true,
    async checkpoint(name, _requestId, operation) {
      if (name === "after_control_backing_validation" && operation === "ready" && delayFirstReady) {
        delayFirstReady = false;
        // Hold the first control response until every subscriber has observed the timeout.
        // A fixed 100ms sleep / 20ms I/O deadline races filesystem scheduling under the full suite.
        await firstReadyGate;
      }
    }, async render() {
      calls += 1;
      return { status: "ready", html: "<main>retry</main>", htmlHash: sha256("<main>retry</main>"),
        pageCount: 1, htmlArtifactId: "retry-test", equality: { pageCount: 1 } };
    } });
  t.after(() => service.close());
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: receipt.filename, acceptanceReceiptHash: receipt.hash,
    expectedReceiptUid: receipt.uid, testOnlyTiming: { wholeTimeoutMs: 3000,
      cleanupGraceMs: 500, coldStartTimeoutMs: 500, reconcileIntervalMs: 3000 } });
  t.after(() => client.close());
  const processor = processorRequest("job-timeout-retry", "b".repeat(64));
  const input = { inputHash: "b".repeat(64), manifest: { bookId: "book-timeout-retry" } };
  const subscriptions = Array.from({ length: 12 }, () =>
    client.render({ kind: "preview", processorRequest: processor, input }));
  assert.equal(new Set(subscriptions).size, 12);
  const timedOut = await Promise.allSettled(subscriptions);
  assert.ok(timedOut.every((result) => result.status === "rejected" &&
    result.reason?.message === "renderer_control_timeout"));
  assert.equal(calls, 0);
  assert.equal(delayFirstReady, false, 'the timeout was caused by the held response');
  releaseFirstReady();
  const recovered = await client.render({ kind: "preview", processorRequest: processor, input });
  assert.equal(recovered.html, "<main>retry</main>");
  assert.equal(calls, 1);
  await service.idle();
});

test("spool reader rejects symlink, hardlink and mode drift", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-tamper-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, `${"a".repeat(64)}.json`);
  writeFileSync(target, "{}\n", { mode: 0o640 });
  chmodSync(target, 0o640);
  const symlink = path.join(directory, `${"b".repeat(64)}.json`);
  symlinkSync(target, symlink);
  await assert.rejects(secureReadFile(symlink), /renderer_spool_file_invalid/u);
  const hardlink = path.join(directory, `${"c".repeat(64)}.json`);
  linkSync(target, hardlink);
  await assert.rejects(secureReadFile(target), /renderer_spool_file_invalid/u);
  rmSync(hardlink);
  chmodSync(target, 0o600);
  await assert.rejects(secureReadFile(target), /renderer_spool_file_invalid/u);
});

test("spool and protocol reject owner, size, hash, extra-field, snap and CUPS drift", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-strict-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, `${"d".repeat(64)}.json`);
  writeFileSync(filename, "strict\n", { mode: 0o640 });
  chmodSync(filename, 0o640);
  await assert.rejects(secureReadFile(filename, { uid: process.getuid() + 1 }),
    /renderer_spool_file_invalid/u);
  await assert.rejects(secureReadFile(filename, { size: 1 }), /renderer_spool_size_mismatch/u);
  await assert.rejects(secureReadFile(filename, { sha256: "0".repeat(64) }), /renderer_spool_hash_mismatch/u);
  await assert.rejects(secureReadFile(filename, { maximumBytes: 1 }), /renderer_spool_file_invalid/u);

  const accepted = acceptance(directory);
  const receipt = JSON.parse(readFileSync(accepted.filename, "utf8"));
  assert.throws(() => validateRendererAcceptanceReceipt({ ...receipt,
    browser: { ...receipt.browser, path: "/snap/chromium/current/chrome" } }),
  /renderer_acceptance_(?:snap_unpinned|browser_path_invalid)/u);
  assert.throws(() => validateRendererAcceptanceReceipt({ ...receipt,
    cups: { connected: true, gate: "deny-and-verify" } }), /renderer_acceptance_cups_invalid/u);
  const request = createRendererRequest({ kind: "preview", processorRequest: processorRequest("strict",
    "1".repeat(64)),
    input: { inputHash: "1".repeat(64) }, acceptanceReceiptHash: accepted.hash });
  assert.throws(() => validateRendererResult({ schema: "unseen-book-renderer-result/1",
    requestId: request.requestId, requestHash: request.requestHash, status: "ready",
    metadata: { htmlHash: "1".repeat(64) }, artifacts: { html: { name: `${request.requestId}.html`,
      bytes: 1, sha256: "1".repeat(64) }, extra: {} } }, request), /renderer_result_invalid/u);
});

test("dedicated renderer preserves Book final CAS/currentness and the 120s/150s timeout invariant", () => {
  assert.equal(RENDERER_WHOLE_TIMEOUT_MS, 120_000);
  assert.equal(BOOK_RENDER_LEASE_MS, 150_000);
  assert.ok(BOOK_RENDER_LEASE_MS > RENDERER_WHOLE_TIMEOUT_MS);
  const extension = readFileSync(new URL("../src/extensions/book-lab.mjs", import.meta.url), "utf8");
  assert.ok(extension.indexOf("api.processPreview") < extension.indexOf("config.rendererClient.render"));
  assert.ok(extension.indexOf("config.rendererClient.render") < extension.indexOf("api.completePreview"));
  assert.match(extension, /previewLeaseMs: BOOK_RENDER_LEASE_MS/u);
  assert.match(extension, /api\.completeFrozenRender\(completion, output/u);
});
