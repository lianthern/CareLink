import { spawn } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { buildRenderReceipt, renderCanonicalHtml } from "../../../packages/book-renderer/src/render.mjs";
import { printExactHtmlToPdf } from "../../../packages/book-renderer/src/pdf.mjs";
import { sha256 } from "../../../packages/book-renderer/src/canonical.mjs";
import { networkDenied, networkGuardState } from "./network-deny.mjs";

const INPUT_LIMIT = 16 * 1024 * 1024;
const SCHEMA = "unseen-book-render-worker/1";

function exact(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(code);
  return value;
}

async function input() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > INPUT_LIMIT) throw new Error("render_worker_input_too_large");
    chunks.push(chunk);
  }
  return exact(JSON.parse(Buffer.concat(chunks, length).toString("utf8")),
    ["schemaVersion", "operation", "payload"], "render_worker_request_invalid");
}

function assetsFor(claim) {
  const manifest = claim.manifest;
  const metadata = new Map(manifest.frozenAssets.map((asset) => [asset.localAssetRef, asset]));
  const bytes = new Map(claim.assetBytes.map((asset) => {
    exact(asset, ["localAssetRef", "bytesBase64"], "render_worker_asset_invalid");
    const decoded = Buffer.from(asset.bytesBase64, "base64");
    if (decoded.toString("base64") !== asset.bytesBase64) throw new Error("render_worker_asset_invalid");
    return [asset.localAssetRef, decoded];
  }));
  if (metadata.size !== manifest.frozenAssets.length || bytes.size !== claim.assetBytes.length) {
    throw new Error("render_worker_asset_invalid");
  }
  return (localAssetRef) => {
    const asset = metadata.get(localAssetRef);
    const value = bytes.get(localAssetRef);
    if (!asset || !value) throw new Error("render_worker_asset_unavailable");
    return { bytes: value, contentHash: sha256(value),
      dataUri: `data:${asset.mimeType};base64,${value.toString("base64")}` };
  };
}

async function render(payload) {
  exact(payload, ["kind", "input"], "render_worker_payload_invalid");
  if (!new Set(["preview", "frozen"]).has(payload.kind)) throw new Error("render_worker_kind_invalid");
  const allowed = payload.kind === "preview" ? ["manifest", "assetBytes", "accessControlSnapshot", "guard", "inputHash"] :
    ["manifest", "assetBytes", "guard", "inputHash"];
  exact(payload.input, allowed, "render_worker_claim_invalid");
  const html = renderCanonicalHtml(payload.input.manifest, assetsFor(payload.input), "production");
  if (payload.kind === "preview") return { status: "ready", html: html.html, htmlHash: html.htmlHash,
    pageCount: html.equality.pageCount, htmlArtifactId: `preview-${html.htmlHash.slice(0, 32)}`, equality: html.equality };

  const temporaryRoot = process.env.UNSEEN_RENDER_TMP_ROOT;
  if (!temporaryRoot || !path.isAbsolute(temporaryRoot)) throw new Error("render_worker_temporary_root_invalid");
  const directory = await mkdtemp(path.join(temporaryRoot, "job-"));
  await chmod(directory, 0o700);
  try {
    const htmlPath = path.join(directory, "book.html");
    const pdfPath = path.join(directory, "book.pdf");
    const pdf = await printExactHtmlToPdf({ html: html.html, htmlPath, pdfPath,
      orderedPageIds: html.equality.orderedPageIds, pageOrderMarkers: html.pageOrderMarkers, canonicalTimestamp: payload.input.manifest.frozenAt,
      browserPath: process.env.UNSEEN_CHROMIUM_PATH, outerSandboxVerified: true });
    const pdfBytes = await readFile(pdfPath);
    const receipt = buildRenderReceipt(payload.input.manifest, html, pdf, "production");
    return { status: "ready", html: html.html, htmlHash: html.htmlHash, pdfBase64: pdfBytes.toString("base64"),
      pdfHash: pdf.contentHash, pageCount: pdf.pageCount, equality: receipt.equality, receipt };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function probe(payload) {
  exact(payload, ["url", "udpPort", "dnsPort", "secretName", "delayMs"], "render_worker_probe_invalid");
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[^\s]*$/u.test(payload.url) ||
    !/^UNSEEN_[A-Z0-9_]+$/u.test(payload.secretName) || !Number.isSafeInteger(payload.delayMs) ||
    payload.delayMs < 0 || payload.delayMs > 5_000 || !Number.isSafeInteger(payload.udpPort) ||
    payload.udpPort < 1 || payload.udpPort > 65_535 || !Number.isSafeInteger(payload.dnsPort) ||
    payload.dnsPort < 1 || payload.dnsPort > 65_535) throw new Error("render_worker_probe_invalid");
  if (payload.delayMs) await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
  const jsApiGuard = verifyJsApiGuard();
  const descendantProbe = await probeDescendantNetwork(payload);
  const networkDeniedBySandbox = descendantProbe.tcp !== "CONNECTED" && descendantProbe.tcp !== "TIMEOUT" &&
    descendantProbe.udp !== "SENT" && descendantProbe.udp !== "TIMEOUT" &&
    descendantProbe.dns !== "RESOLVED" && descendantProbe.dns !== "TIMEOUT";
  return { networkDenied: jsApiGuard.identityVerified && jsApiGuard.throwVerified && networkDeniedBySandbox,
    inheritedSecret: Object.hasOwn(process.env, payload.secretName),
    enforcement: process.env.UNSEEN_RENDER_NETWORK_ENFORCEMENT,
    kernelNetworkSandbox: process.env.UNSEEN_RENDER_KERNEL_NETWORK_SANDBOX === "true",
    descendantProbe, jsApiGuard };
}

const dnsMethod = /^(?:lookup|resolve|reverse)/u;

function verifyJsApiGuard() {
  const targets = [
    net.Socket.prototype.connect, net.connect, net.createConnection, tls.TLSSocket.prototype.connect, tls.connect,
    http.request, http.get, https.request, https.get, http2.connect, dgram.Socket.prototype.connect,
    dgram.Socket.prototype.send, dgram.Socket.prototype.sendto, globalThis.fetch
  ];
  for (const key of Object.keys(dns).filter((name) => dnsMethod.test(name))) targets.push(dns[key]);
  for (const key of Object.getOwnPropertyNames(dns.Resolver.prototype).filter((name) => dnsMethod.test(name))) {
    targets.push(dns.Resolver.prototype[key]);
  }
  if (dns.promises) {
    for (const key of Object.keys(dns.promises).filter((name) => dnsMethod.test(name))) targets.push(dns.promises[key]);
    for (const key of Object.getOwnPropertyNames(dns.promises.Resolver.prototype)
      .filter((name) => dnsMethod.test(name))) targets.push(dns.promises.Resolver.prototype[key]);
  }
  if (networkGuardState.webSocket === "guarded") targets.push(globalThis.WebSocket);
  const identityVerified = targets.length > 40 && targets.every((target) => target === networkDenied);
  let throwVerified = identityVerified;
  for (const target of targets) {
    try { target(); throwVerified = false; }
    catch (error) {
      if (error?.code !== "NETWORK_DENIED" || error?.message !== "network_denied") throwVerified = false;
    }
  }
  return { identityVerified, throwVerified, webSocket: networkGuardState.webSocket,
    undici: networkGuardState.undici };
}

const descendantScript = String.raw`
const net=require("node:net"),dgram=require("node:dgram"),dns=require("node:dns");
const tcpPort=Number(process.env.PROBE_TCP_PORT),udpPort=Number(process.env.PROBE_UDP_PORT);
const resolver=new dns.Resolver();resolver.setServers(["127.0.0.1:"+process.env.PROBE_DNS_PORT]);
function tcp(){return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(value)};const socket=net.createConnection({host:"127.0.0.1",port:tcpPort});socket.once("connect",()=>finish("CONNECTED"));socket.once("error",error=>finish(error.code||"ERROR"));const timer=setTimeout(()=>finish("TIMEOUT"),1000)})}
function udp(){return new Promise(resolve=>{let done=false;const socket=dgram.createSocket("udp4");const finish=value=>{if(done)return;done=true;clearTimeout(timer);try{socket.close()}catch{}resolve(value)};socket.once("error",error=>finish(error.code||"ERROR"));socket.send(Buffer.from("unseen-network-probe"),udpPort,"127.0.0.1",error=>finish(error?(error.code||"ERROR"):"SENT"));const timer=setTimeout(()=>finish("TIMEOUT"),1000)})}
function dnsProbe(){return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value)};resolver.resolve4("unseen.invalid",error=>finish(error?(error.code||"ERROR"):"RESOLVED"));const timer=setTimeout(()=>finish("TIMEOUT"),1000)})}
Promise.all([tcp(),udp(),dnsProbe()]).then(([tcp,udp,dns])=>process.stdout.write(JSON.stringify({tcp,udp,dns}))).catch(error=>{process.stderr.write(error.stack||error.message);process.exitCode=1});`;

function probeDescendantNetwork(payload) {
  const tcpPort = new URL(payload.url).port;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", descendantScript], { env: {
      PATH: "/usr/bin:/bin", PROBE_TCP_PORT: tcpPort, PROBE_UDP_PORT: String(payload.udpPort),
      PROBE_DNS_PORT: String(payload.dnsPort)
    }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let length = 0;
    let stderrLength = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("network_probe_timeout")); }, 3_000);
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > 4_096) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      if (stderrLength > 4_096) child.kill("SIGKILL");
      else stderr.push(chunk);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal || length > 4_096 || stderrLength > 4_096) {
        return reject(new Error(Buffer.concat(stderr).toString("utf8") || "network_probe_failed"));
      }
      try { resolve(exact(JSON.parse(Buffer.concat(stdout, length).toString("utf8")),
        ["tcp", "udp", "dns"], "network_probe_invalid")); }
      catch (error) { reject(error); }
    });
  });
}

process.umask(0o077);
try {
  const request = await input();
  if (request.schemaVersion !== SCHEMA || !new Set(["render", "probe"]).has(request.operation)) {
    throw new Error("render_worker_request_invalid");
  }
  const output = request.operation === "render" ? await render(request.payload) : await probe(request.payload);
  process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA, status: "ok", output })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA, status: "error",
    error: error?.message ?? "render_worker_failed" })}\n`);
  process.exitCode = 1;
}
