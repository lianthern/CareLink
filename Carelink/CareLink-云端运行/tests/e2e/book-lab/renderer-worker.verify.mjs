import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixtureBundle, resolveFixtureAsset } from "../../../packages/book-renderer/fixtures/frozen-book-fixture.mjs";
import { probeBookRendererIsolation, renderBookLabJob, resolveBookRendererNetworkSandbox } from
  "../../../infra/integration/book-lab/render-worker-adapter.mjs";

function frozenInput() {
  return {
    manifest: fixtureBundle.manifest,
    assetBytes: fixtureBundle.manifest.frozenAssets.map((asset) => ({ localAssetRef: asset.localAssetRef,
      bytesBase64: resolveFixtureAsset(asset.localAssetRef).bytes.toString("base64") })),
    guard: { rendererBuildHash: "test-only" },
    inputHash: fixtureBundle.manifest.manifestHash
  };
}

test("unsupported renderer targets fail closed without an attested egress wrapper", () => {
  assert.throws(() => resolveBookRendererNetworkSandbox({ platform: "linux" }),
    /render_worker_network_sandbox_required/u);
  assert.equal(resolveBookRendererNetworkSandbox({ platform: "linux", egressWrapper: process.execPath,
    egressAttestation: "unseen-egress-wrapper-deny-network-descendants/v1" }).enforcement,
  "attested-external-egress-wrapper+js-api-guard");
});

test("renderer worker denies JS and descendant TCP/UDP/DNS with zero packets", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-8c-render-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let connections = 0;
  const endpoint = createServer((_request, response) => { connections += 1; response.end("unexpected"); });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => endpoint.close(resolve)));
  const udp = dgram.createSocket("udp4");
  const dns = dgram.createSocket("udp4");
  let udpPackets = 0;
  let dnsPackets = 0;
  udp.on("message", () => { udpPackets += 1; });
  dns.on("message", () => { dnsPackets += 1; });
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  await new Promise((resolve) => dns.bind(0, "127.0.0.1", resolve));
  t.after(() => { udp.close(); dns.close(); });
  const address = endpoint.address();
  process.env.UNSEEN_8C_RENDER_SECRET_PROBE = "must-not-cross";
  t.after(() => { delete process.env.UNSEEN_8C_RENDER_SECRET_PROBE; });

  const isolation = await probeBookRendererIsolation({
    url: `http://127.0.0.1:${address.port}/forbidden`, udpPort: udp.address().port,
    dnsPort: dns.address().port, secretName: "UNSEEN_8C_RENDER_SECRET_PROBE", delayMs: 0
  }, { temporaryRoot: directory, timeoutMs: 5_000 });
  assert.equal(isolation.networkDenied, true);
  assert.equal(isolation.inheritedSecret, false);
  assert.equal(isolation.enforcement, "macos-sandbox-exec-deny-network+js-api-guard");
  assert.equal(isolation.kernelNetworkSandbox, true);
  assert.deepEqual(isolation.descendantProbe, { tcp: "EPERM", udp: "EPERM", dns: "ECONNREFUSED" });
  assert.deepEqual(isolation.jsApiGuard, {
    identityVerified: true, throwVerified: true, webSocket: "guarded", undici: "unavailable"
  });
  assert.equal(connections, 0);
  assert.equal(udpPackets, 0);
  assert.equal(dnsPackets, 0);
  await assert.rejects(probeBookRendererIsolation({
    url: `http://127.0.0.1:${address.port}/forbidden`, udpPort: udp.address().port,
    dnsPort: dns.address().port, secretName: "UNSEEN_8C_RENDER_SECRET_PROBE", delayMs: 2_000
  }, { temporaryRoot: directory, timeoutMs: 1_000 }), /render_worker_timeout/u);
  assert.equal(connections, 0);
  assert.equal(udpPackets, 0);
  assert.equal(dnsPackets, 0);
  assert.deepEqual(readdirSync(directory), []);
});

test("renderer worker returns exact same-manifest HTML/PDF under descendant network sandbox", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-8c-render-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = await renderBookLabJob({ kind: "frozen", input: frozenInput() },
    { temporaryRoot: directory, timeoutMs: 90_000 });
  assert.equal(output.status, "ready");
  assert.equal(output.pageCount, fixtureBundle.manifest.pages.length);
  assert.equal(output.htmlHash, "332d91a5acfe536f46e9b19abe4a69d1fd78374366de8d46b6e20a07d19eaf0e");
  assert.equal(output.pdfHash, "f33d00c146b92cef2d4a84c2bbe2ff1952027402d8d31c8376086acc7d5fa75c");
  assert.equal(output.receipt.schemaVersion, "unseen-book-render-receipt/1");
  assert.equal(output.receipt.renderProfile, "production");
  assert.equal(output.receipt.fixtureOnly, false);
  assert.equal(output.receipt.input.manifestHash, fixtureBundle.manifest.manifestHash);
  assert.equal(output.receipt.html.contentHash, output.htmlHash);
  assert.equal(output.receipt.pdf.contentHash, output.pdfHash);
  assert.deepEqual(output.receipt.equality, output.equality);
  assert.doesNotMatch(output.html, /确定性本地样本|非真实 AI|fixture-stamp/u);
  assert.deepEqual(output.equality.orderedPageIds, fixtureBundle.manifest.pages.map((page) => page.pageId));
  assert.equal(Buffer.from(output.pdfBase64, "base64").subarray(0, 5).toString(), "%PDF-");
  assert.deepEqual(readdirSync(directory), []);
});
