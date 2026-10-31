import assert from "node:assert/strict";
import { createHash, pbkdf2 } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rendererAppArmorProfileHash } from
  "../../../infra/integration/book-lab/linux-apparmor-profile.mjs";
import { buildRendererChildSeccomp, rendererChildSeccompHash } from
  "../../../infra/integration/book-lab/linux-child-seccomp.mjs";
import { buildLinuxRenderSandboxArguments } from
  "../../../infra/integration/book-lab/linux-render-sandbox.mjs";
import { CHROMIUM_SNAP_ADAPTER_POLICY, CHROMIUM_SNAP_ADAPTER_POLICY_SHA256,
  CHROMIUM_SNAP_BROWSER, CHROMIUM_SNAP_ROOT, buildChromiumSnapHeadlessInvocation,
  chromiumSnapAdapterImplementationHash } from
  "../../../infra/integration/book-lab/chromium-snap-headless-adapter.mjs";
import { printExactHtmlToPdf } from "../../../packages/book-renderer/src/pdf.mjs";
import { CHROMIUM_SNAP_ARCHIVE_LINK_POLICY_SHA256, CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY,
  CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY_SHA256, RENDERER_NODE_RUNTIME, buildRendererAcceptanceReceipt,
  measureChromiumSnapTree, measureSnapdArchiveLinkTopologyForTest,
  rendererImplementationHash, rendererVerifierBuildHash,
  validateNodeRuntimeTarget,
  validateCupsTargetProbe, validateSystemdProperties, validateSystemdUnitSources, validateTargetCommandResult,
  validateChromiumSnapDanglingSymlinkObservationForTest,
  verifyChromiumSnapCanonicalDanglingSymlinksForTest,
  verifyRendererRuntimeTargetState, verifyRendererTargetAcceptance } from
  "../../../infra/integration/book-lab/renderer-target-verifier.mjs";
import { renderBookLabJob, renderBookLabJobToFiles } from
  "../../../infra/integration/book-lab/render-worker-adapter.mjs";
import { createDedicatedRendererClient, loadRendererAcceptanceReceiptSync, notifyRendererControl } from
  "../../../infra/integration/book-lab/renderer-client.mjs";
import { createDedicatedRendererService, loadRendererAcceptancePin, sweepRendererWorkDirectory } from
  "../../../infra/integration/book-lab/renderer-service.mjs";
import { BOOK_RENDER_LEASE_MS, RENDERER_CONTROL_ACCEPTANCE_SCHEMA, RENDERER_CONTROL_LIMIT,
  RENDERER_CONTROL_RESPONSE_SCHEMA, RENDERER_PROTOCOL,
  atomicWriteFile, createRendererRequest, validateRendererControlResponse, validateRendererFailureDiagnostic } from
  "../../../infra/integration/book-lab/renderer-ipc-protocol.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const nodePin = Object.freeze({ path: RENDERER_NODE_RUNTIME.executablePath, sha256: "9".repeat(64),
  version: RENDERER_NODE_RUNTIME.version });
const nodeDistribution = Object.freeze({ schema: "unseen-node-runtime-distribution/1",
  archiveUrl: RENDERER_NODE_RUNTIME.archiveUrl, archivePath: RENDERER_NODE_RUNTIME.archivePath,
  archiveSha256: "8".repeat(64), archiveBytes: 123,
  signedShasumsUrl: RENDERER_NODE_RUNTIME.signedShasumsUrl,
  signedShasumsPath: RENDERER_NODE_RUNTIME.signedShasumsPath, signedShasumsSha256: "7".repeat(64),
  releaseKeyringUrl: RENDERER_NODE_RUNTIME.releaseKeyringUrl,
  releaseKeyringPath: RENDERER_NODE_RUNTIME.releaseKeyringPath, releaseKeyringSha256: "6".repeat(64),
  releaseKeyringBytes: 456, releaseKeysCommit: RENDERER_NODE_RUNTIME.releaseKeysCommit,
  verificationMethod: "gpgv-pinned-keyring+signed-shasums+sha256sum/v1",
  checksumPinPath: RENDERER_NODE_RUNTIME.checksumPinPath, checksumPinSha256: "5".repeat(64) });
const browserDistribution = Object.freeze({ schema: "unseen-chromium-snap-distribution/1", name: "chromium",
  snapId: "XKEcBqPM06H1Z7zGOdG5fbICuf8NWK5R", revision: 3507, version: "151.0.7922.108", arch: "amd64",
  numericRoot: CHROMIUM_SNAP_ROOT, archivePath: "/var/lib/snapd/snaps/chromium_3507.snap",
  archiveSha256: "cf10676bdf7a3b4d14201fd6004ec5c8c137ee7365779133cba7c1d39263fae0",
  archiveSha3384: "77155504d7c5fdfa516545da086bd3f31fa6f6283901e93885cbb39366ae55bea834c4042bebfc870a0330904df04c07",
  archiveBytes: 202_833_920,
  archiveLinkTopology: Object.freeze({ schema: "unseen-snapd-cache-link-topology/1",
    state: "ARCHIVE_AND_SNAPD_SHA3_CACHE", linkCount: 2,
    policySha256: "49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5" }),
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
  securityReview: "REQUIRED_NOT_INCLUDED", releaseDecision: "NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED" });
const browserAdapter = Object.freeze({ ...CHROMIUM_SNAP_ADAPTER_POLICY,
  implementationSha256: chromiumSnapAdapterImplementationHash(), policySha256: CHROMIUM_SNAP_ADAPTER_POLICY_SHA256 });

function processorRequest(renderJobId, inputHash) {
  return { renderJobId, jobVersion: 1, draftVersionId: `draft-${renderJobId}`, manifestHash: "3".repeat(64),
    grantSetHash: "4".repeat(64), sourceSnapshotHash: "5".repeat(64),
    authorizedMemoryTextSnapshotHash: "6".repeat(64), assetSnapshotHash: "7".repeat(64),
    accessControlVersion: 1, inputHash, attempt: 1 };
}

function receipt(directory) {
  const value = { schema: "unseen-book-renderer-acceptance/1", profile: RENDERER_PROTOCOL,
    candidateCommit: "a".repeat(40), candidateTree: "0".repeat(40), rendererBuildHash: "b".repeat(64),
    node: nodePin, nodeDistribution,
    browser: { path: CHROMIUM_SNAP_BROWSER, sha256: "c".repeat(64), version: "Chromium 151.0.7922.108" },
    browserDistribution, browserAdapter,
    bwrap: { path: "/usr/bin/bwrap", sha256: "d".repeat(64), version: "bubblewrap 0.9.0" },
    appArmor: { profile: "unseen-book-renderer", sha256: rendererAppArmorProfileHash(), loaded: true },
    seccomp: { schema: "unseen-book-renderer-child-seccomp/1", sha256: rendererChildSeccompHash(),
      deniedSocketFamilies: ["AF_INET", "AF_INET6", "AF_NETLINK", "AF_PACKET"],
      deniedSyscalls: ["mount", "pivot_root", "setns", "umount2", "unshare", "clone3"] },
    fonts: { sha256: "e".repeat(64), count: 1 }, pdfTools: { sha256: "f".repeat(64), count: 2 },
    systemd: { sha256: "1".repeat(64), serviceSha256: "2".repeat(64), socketSha256: "3".repeat(64),
      effectivePropertiesSha256: "4".repeat(64) },
    cups: { connected: false, gate: "deny-and-verify", serviceActive: false, listenerCount: 0 },
    principals: { apiUid: process.getuid(), rendererUid: process.getuid(), rendererGid: process.getgid(),
      ipcGid: process.getgid(), apiUser: "unseen",
      rendererUser: "unseen-renderer", ipcGroup: "unseen-render-ipc" },
    targetVerification: { schema: "unseen-book-renderer-target-verification/1",
      verifierBuildHash: "5".repeat(64), measurementsHash: "6".repeat(64) },
    readOnlyMounts: ["/usr", CHROMIUM_SNAP_ROOT, "/opt/unseen/runtime/node-v22.23.2-linux-x64"] };
  const filename = path.join(directory, "acceptance.json");
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  writeFileSync(filename, bytes, { mode: 0o640 });
  chmodSync(filename, 0o640);
  return { value, filename, hash: sha256(bytes) };
}

function control(socketPath, request, operation = "render") {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let bytes = Buffer.alloc(0);
    socket.once("connect", () => socket.end(`${JSON.stringify({ operation,
      requestId: request.requestId, requestHash: request.requestHash })}\n`));
    socket.on("data", (chunk) => { bytes = Buffer.concat([bytes, chunk]); });
    socket.once("end", () => {
      try {
        const response = validateRendererControlResponse(JSON.parse(bytes.subarray(0, -1).toString("utf8")),
          { operation, requestId: request.requestId });
        if (response.status !== "accepted") throw new Error(response.code);
        resolve(response);
      } catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
}

function rawControl(socketPath, bytes, { dropResponse = false, pauseResponseMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = Buffer.alloc(0);
    socket.once("connect", () => {
      if (pauseResponseMs > 0) {
        socket.pause();
        setTimeout(() => socket.resume(), pauseResponseMs);
      }
      socket.end(bytes, () => { if (dropResponse) socket.destroy(); });
    });
    socket.on("data", (chunk) => { response = Buffer.concat([response, chunk]); });
    socket.once("end", () => {
      try { resolve(JSON.parse(response.subarray(0, -1).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    socket.once("error", reject);
    if (dropResponse) socket.once("close", () => resolve(null));
  });
}

async function listenFake(socketPath, listener) {
  const server = createServer({ allowHalfOpen: true }, listener);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o660);
  return server;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function assertSpoolEmpty(spoolRoot) {
  for (const relative of ["inbox", "cancels", "acks", "results/receipts", "results/control", "results/cleanup"]) {
    assert.deepEqual(readdirSync(path.join(spoolRoot, relative)), [], relative);
  }
  assert.deepEqual(readdirSync(path.join(spoolRoot, "results")), ["cleanup", "control", "receipts"]);
}

function writeWorkResidual(workRoot, requestId, suffix = "Ab12Cd") {
  const job = path.join(workRoot, `dedicated-job-${requestId}-${suffix}`);
  mkdirSync(job, { mode: 0o700 });
  chmodSync(job, 0o700);
  writeFileSync(path.join(job, "request.json"), "synthetic non-user request\n", { mode: 0o600 });
  chmodSync(path.join(job, "request.json"), 0o600);
  const seccomp = path.join(workRoot, `.renderer-seccomp-${requestId}-123e4567-e89b-42d3-a456-426614174000`);
  writeFileSync(seccomp, buildRendererChildSeccomp(), { mode: 0o600 });
  chmodSync(seccomp, 0o600);
  return { job, seccomp };
}

test("formal service combines systemd private network, filesystem AF_UNIX and child defense in depth", () => {
  const service = readFileSync(path.join(root, "ops/release/unseen-book-renderer.service.example"), "utf8");
  const socket = readFileSync(path.join(root, "ops/release/unseen-book-renderer.socket.example"), "utf8");
  const tmpfiles = readFileSync(path.join(root, "ops/release/unseen-book-renderer.tmpfiles.example"), "utf8");
  const sysusers = readFileSync(path.join(root, "ops/release/unseen-book-renderer.sysusers.example"), "utf8");
  const apiService = readFileSync(path.join(root, "ops/release/unseen.service.example"), "utf8");
  assert.match(service, /^PrivateNetwork=true$/mu);
  assert.match(service, /^IPAddressDeny=any$/mu);
  assert.match(service, /^RestrictAddressFamilies=AF_UNIX$/mu);
  assert.match(service, /^NoNewPrivileges=true$/mu);
  assert.match(service, /^CapabilityBoundingSet=$/mu);
  assert.match(service, /^RestrictNamespaces=user mnt pid ipc uts$/mu);
  assert.match(service, /^MemoryMax=768M$/mu);
  assert.match(service, /^TasksMax=256$/mu);
  assert.match(service,
    /^ExecStartPre=\/usr\/bin\/sha256sum --strict --check --status \/run\/unseen\/approvals\/node-runtime\.sha256$/mu);
  assert.match(service, new RegExp(`^ExecStartPre=${RENDERER_NODE_RUNTIME.executablePath.replaceAll("/", "\\/")} ` +
    "infra/integration/book-lab/renderer-service\\.mjs --verify$", "mu"));
  assert.match(service, new RegExp(`^ExecStart=${RENDERER_NODE_RUNTIME.executablePath.replaceAll("/", "\\/")} ` +
    "infra/integration/book-lab/renderer-service\\.mjs$", "mu"));
  assert.doesNotMatch(service, /ExecStart(?:Pre)?=(?:\/usr\/bin\/node|\/usr\/bin\/env|node\s)/u);
  assert.doesNotMatch(service, /^EnvironmentFile=/mu);
  assert.match(service,
    /^UnsetEnvironment=NODE_OPTIONS NODE_PATH PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_PROFILE GCONV_PATH BASH_ENV ENV PYTHONPATH PYTHONHOME PERL5OPT RUBYOPT OPENSSL_CONF OPENSSL_MODULES SSLKEYLOGFILE$/mu);
  assert.match(service, /ReadOnlyPaths=.*\/opt\/unseen\/runtime\/node-v22\.23\.2-linux-x64.*\/run\/unseen\/approvals\/node-runtime\.sha256/mu);
  assert.doesNotMatch(service, /AF_INET|AF_INET6|AF_NETLINK|ListenStream=/u);
  assert.match(socket, /^ListenStream=\/run\/unseen-renderer\/render\.sock$/mu);
  assert.match(socket, /^Service=unseen-book-renderer\.service$/mu);
  assert.doesNotMatch(socket, /ListenDatagram|ListenStream=(?:[0-9]|\[|@)/u);
  assert.match(tmpfiles, /inbox 2750 unseen unseen-render-ipc/u);
  assert.match(tmpfiles, /results 2750 unseen-renderer unseen-render-ipc/u);
  assert.match(tmpfiles, /results\/control 2750 unseen-renderer unseen-render-ipc/u);
  assert.match(tmpfiles, /work 0700 unseen-renderer unseen-renderer/u);
  assert.match(sysusers, /^m unseen unseen-render-ipc$/mu);
  assert.match(sysusers, /^m unseen-renderer unseen-render-ipc$/mu);
  assert.match(apiService, /^ReadWritePaths=.*\/var\/lib\/unseen\/renderer-spool(?:\s|$)/mu);
  assert.match(apiService,
    /^UnsetEnvironment=NODE_OPTIONS NODE_PATH PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_PROFILE GCONV_PATH BASH_ENV ENV PYTHONPATH PYTHONHOME PERL5OPT RUBYOPT OPENSSL_CONF OPENSSL_MODULES SSLKEYLOGFILE$/mu);
  assert.match(apiService,
    /^ExecStartPre=\/usr\/local\/bin\/node infra\/integration\/production-package\.mjs preflight \/etc\/unseen\/production\.env$/mu);
});

test("target Node runtime binds executable, signed archive provenance, DAC and strict checksum pin", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-node-"));
  const executablePath = path.join(directory, "runtime/node-v22.23.2-linux-x64/bin/node");
  const archivePath = path.join(directory, "sources/node-v22.23.2/node-v22.23.2-linux-x64.tar.xz");
  const signedShasumsPath = path.join(directory, "sources/node-v22.23.2/SHASUMS256.txt.asc");
  const releaseKeyringPath = path.join(directory, "trust/release-keys.kbx");
  const checksumPinPath = path.join(directory, "approvals/node-runtime.sha256");
  const files = new Map([[executablePath, Buffer.from("synthetic-node-binary")],
    [archivePath, Buffer.from("synthetic-signed-archive")],
    [signedShasumsPath, Buffer.from("synthetic-signed-shasums")],
    [releaseKeyringPath, Buffer.from("synthetic-pinned-keyring")]]);
  try {
    for (const [filename, bytes] of files) {
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o755 });
      writeFileSync(filename, bytes, { mode: filename === executablePath ? 0o755 : 0o644 });
      chmodSync(filename, filename === executablePath ? 0o755 : 0o644);
    }
    const runtime = { ...RENDERER_NODE_RUNTIME, executablePath, executableSha256: sha256(files.get(executablePath)),
      archivePath, archiveSha256: sha256(files.get(archivePath)), archiveBytes: files.get(archivePath).length,
      signedShasumsPath, signedShasumsSha256: sha256(files.get(signedShasumsPath)), releaseKeyringPath,
      releaseKeyringSha256: sha256(files.get(releaseKeyringPath)),
      releaseKeyringBytes: files.get(releaseKeyringPath).length, checksumPinPath };
    const checksumBytes = `${runtime.executableSha256}  ${runtime.executablePath}\n`;
    mkdirSync(path.dirname(checksumPinPath), { recursive: true, mode: 0o755 });
    writeFileSync(checksumPinPath, checksumBytes, { mode: 0o640 });
    chmodSync(checksumPinPath, 0o640);
    const commandRunner = (commandPath) => commandPath === executablePath ?
      { status: 0, stdout: "v22.23.2\n", stderr: "" } :
      { status: 0, stdout: `${runtime.archiveSha256}  ${path.basename(archivePath)}\n`,
        stderr: "gpgv: Good signature\n" };
    const options = { runtime, expectedUid: process.getuid(), expectedIpcGid: process.getgid(),
      processExecPath: executablePath, commandRunner, parentBoundary: directory };
    const measured = validateNodeRuntimeTarget(options);
    assert.deepEqual(measured.node, { path: executablePath, sha256: runtime.executableSha256,
      version: "v22.23.2" });
    assert.equal(measured.nodeDistribution.checksumPinSha256, sha256(checksumBytes));
    for (const mutate of [
      () => ({ ...options, processExecPath: "/usr/bin/node" }),
      () => ({ ...options, expectedUid: process.getuid() + 1 }),
      () => ({ ...options, runtime: { ...runtime, executableSha256: "0".repeat(64) } }),
      () => ({ ...options, commandRunner: (commandPath) => commandPath === executablePath ?
        { status: 0, stdout: "v22.23.1\n", stderr: "" } : commandRunner(commandPath) }),
      () => ({ ...options, commandRunner: (commandPath) => commandPath === "/usr/bin/gpgv" ?
        { status: 1, stdout: "", stderr: "BAD signature" } : commandRunner(commandPath) })]) {
      assert.throws(() => validateNodeRuntimeTarget(mutate()), /renderer_target_node_runtime/u);
    }
    chmodSync(executablePath, 0o775);
    assert.throws(() => validateNodeRuntimeTarget(options), /renderer_target_node_runtime_invalid/u);
    chmodSync(executablePath, 0o755);
    chmodSync(path.dirname(executablePath), 0o777);
    assert.throws(() => validateNodeRuntimeTarget(options), /renderer_target_node_runtime_parent_invalid/u);
    chmodSync(path.dirname(executablePath), 0o755);
    const archiveBytes = files.get(archivePath);
    rmSync(archivePath);
    symlinkSync(executablePath, archivePath);
    assert.throws(() => validateNodeRuntimeTarget(options), /renderer_target_node_runtime_invalid/u);
    rmSync(archivePath);
    writeFileSync(archivePath, archiveBytes, { mode: 0o644 });
    chmodSync(archivePath, 0o644);
    writeFileSync(checksumPinPath, `${runtime.executableSha256} ${runtime.executablePath}\n`, { mode: 0o640 });
    chmodSync(checksumPinPath, 0o640);
    assert.throws(() => validateNodeRuntimeTarget(options), /renderer_target_node_runtime_invalid/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("target verifier requires every effective renderer unit property without drop-ins", () => {
  const servicePath = "/etc/systemd/system/unseen-book-renderer.service";
  const socketPath = "/etc/systemd/system/unseen-book-renderer.socket";
  const repositoryRoot = `/opt/unseen/releases/${"a".repeat(40)}`;
  const service = {
    Id: "unseen-book-renderer.service", Names: "unseen-book-renderer.service",
    TriggeredBy: "unseen-book-renderer.socket",
    User: "unseen-renderer", Group: "unseen-render-ipc", WorkingDirectory: repositoryRoot,
    FragmentPath: servicePath, DropInPaths: "", Restart: "on-failure", RestartUSec: "5s",
    TimeoutStartUSec: "2min", TimeoutStopUSec: "5s", UMask: "0027", NoNewPrivileges: "yes",
    PrivateNetwork: "yes", EnvironmentFiles: "",
    UnsetEnvironment: "NODE_OPTIONS NODE_PATH PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_PROFILE GCONV_PATH BASH_ENV ENV PYTHONPATH PYTHONHOME PERL5OPT RUBYOPT OPENSSL_CONF OPENSSL_MODULES SSLKEYLOGFILE",
    IPAddressDeny: "0.0.0.0/0 ::/0", RestrictAddressFamilies: "AF_UNIX",
    AppArmorProfile: "unseen-book-renderer", CapabilityBoundingSet: "", AmbientCapabilities: "",
    SystemCallArchitectures: "native", RestrictNamespaces: "mnt ipc pid user uts", LockPersonality: "yes",
    MemoryDenyWriteExecute: "no", RestrictRealtime: "yes", RestrictSUIDSGID: "yes", RemoveIPC: "yes",
    PrivateDevices: "yes", PrivateTmp: "yes", ProtectClock: "yes", ProtectControlGroups: "yes",
    ProtectHome: "yes", ProtectHostname: "yes", ProtectKernelLogs: "yes", ProtectKernelModules: "yes",
    ProtectKernelTunables: "yes", ProtectSystem: "strict", ReadWritePaths: "/var/lib/unseen/renderer-spool",
    ReadOnlyPaths: "/opt/unseen/runtime/node-v22.23.2-linux-x64 /opt/unseen/runtime/sources/node-v22.23.2 " +
      "/opt/unseen/runtime/trust/node-release-keys-b28073028e6d6855cfb53bf7fa0137599c01f967.kbx " +
      "/run/unseen/approvals/book-renderer-acceptance.json " +
      "/run/unseen/approvals/book-renderer-acceptance.sha256 /run/unseen/approvals/node-runtime.sha256",
    MemoryMax: "805306368",
    MemorySwapMax: "0", CPUQuotaPerSecUSec: "1.500000s", TasksMax: "256", LimitNOFILE: "1024",
    OOMPolicy: "stop", StandardInput: "null", StandardOutput: "journal", StandardError: "journal"
  };
  const socket = { Id: "unseen-book-renderer.socket", Names: "unseen-book-renderer.socket",
    Triggers: "unseen-book-renderer.service", FragmentPath: socketPath, DropInPaths: "",
    Listen: "/run/unseen-renderer/render.sock (Stream)",
    SocketUser: "unseen-renderer",
    SocketGroup: "unseen-render-ipc", SocketMode: "0660", DirectoryMode: "2750", RemoveOnStop: "yes",
    Accept: "no" };
  const lines = (value) => Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n");
  const options = { servicePath, socketPath, repositoryRoot };
  const { EnvironmentFiles: omittedEnvironmentFiles, ...systemd255Service } = service;
  assert.equal(omittedEnvironmentFiles, "");
  assert.doesNotThrow(() => validateSystemdProperties(lines(systemd255Service), lines(socket), options));
  assert.doesNotThrow(() => validateSystemdProperties(lines(service), lines(socket), options));
  assert.doesNotThrow(() => validateSystemdProperties(lines({ ...service,
    IPAddressDeny: "::/0 0.0.0.0/0" }), lines(socket), options));
  for (const key of Object.keys(service).filter((item) => item !== "EnvironmentFiles")) {
    const missing = { ...service };
    delete missing[key];
    assert.throws(() => validateSystemdProperties(lines(missing), lines(socket), options),
      /renderer_target_systemd_properties_invalid/u);
  }
  for (const key of Object.keys(socket)) {
    const missing = { ...socket };
    delete missing[key];
    assert.throws(() => validateSystemdProperties(lines(service), lines(missing), options),
      /renderer_target_systemd_properties_invalid/u);
  }
  for (const [key, value] of [["DropInPaths", "/etc/systemd/system/unseen-book-renderer.service.d/override.conf"],
    ["RestrictAddressFamilies", "AF_UNIX AF_INET"], ["ProtectKernelTunables", "no"],
    ["EnvironmentFiles", "/etc/unseen/production.env (ignore_errors=no)"],
    ["UnsetEnvironment", "NODE_OPTIONS NODE_PATH"], ["Id", "attacker.service"],
    ["Names", "unseen-book-renderer.service attacker.service"], ["TriggeredBy", "attacker.socket"]]) {
    assert.throws(() => validateSystemdProperties(lines({ ...service, [key]: value }), lines(socket), options),
      /renderer_target_systemd_properties_invalid/u);
  }
  for (const value of ["0.0.0.0/0", "::/0", "any", "localhost", "0.0.0.0/0 ::/0 127.0.0.0/8",
    "0.0.0.0/0 ::/0 ::/0", ""]) {
    assert.throws(() => validateSystemdProperties(lines({ ...service, IPAddressDeny: value }), lines(socket), options),
      /renderer_target_systemd_properties_invalid/u);
  }
  assert.throws(() => validateSystemdProperties(lines(service), lines({ ...socket, Listen: "127.0.0.1:9876" }),
    options), /renderer_target_systemd_properties_invalid/u);
  assert.throws(() => validateSystemdProperties(lines(service), lines({ ...socket, DirectoryMode: "0755" }),
    options), /renderer_target_systemd_properties_invalid/u);
  for (const [key, value] of [["Id", "attacker.socket"],
    ["Names", "unseen-book-renderer.socket attacker.socket"],
    ["Triggers", "attacker.service"], ["DropInPaths", "/etc/systemd/system/unseen-book-renderer.socket.d/x.conf"]]) {
    assert.throws(() => validateSystemdProperties(lines(service), lines({ ...socket, [key]: value }), options),
      /renderer_target_systemd_properties_invalid/u);
  }
  assert.throws(() => validateSystemdProperties(`${lines(service)}\nUnexpected=value`, lines(socket), options),
    /renderer_target_systemd_properties_invalid/u);
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-units-"));
  try {
    const sourceService = path.join(directory, "renderer.service");
    const sourceSocket = path.join(directory, "renderer.socket");
    const candidateCommit = "a".repeat(40);
    const serviceTemplate = readFileSync(path.join(root, "ops/release/unseen-book-renderer.service.example"),
      "utf8");
    const socketTemplate = readFileSync(path.join(root, "ops/release/unseen-book-renderer.socket.example"), "utf8");
    const rendered = serviceTemplate.replace("REQUIRED_IMMUTABLE_RELEASE_COMMIT", candidateCommit);
    const verify = () => validateSystemdUnitSources(sourceService, sourceSocket, root, candidateCommit);
    writeFileSync(sourceService, rendered);
    writeFileSync(sourceSocket, socketTemplate);
    assert.doesNotThrow(verify);
    for (const mutation of [`${rendered}Environment=NODE_OPTIONS=--import=/tmp/attacker.mjs\n`,
      `${rendered}UnknownRendererDirective=yes\n`]) {
      writeFileSync(sourceService, mutation);
      assert.throws(verify, /renderer_target_systemd_unit_invalid/u);
    }
    writeFileSync(sourceService, rendered);
    writeFileSync(sourceSocket, socketTemplate.replace("Service=unseen-book-renderer.service",
      "Service=attacker.service"));
    assert.throws(verify, /renderer_target_systemd_unit_invalid/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("acceptance receipt is readable only as root-owned ipc-group 0640", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-receipt-dac-"));
  try {
    const accepted = receipt(directory);
    assert.equal(loadRendererAcceptanceReceiptSync(accepted.filename, accepted.hash,
      { expectedReceiptUid: process.getuid() }).hash, accepted.hash);
    chmodSync(accepted.filename, 0o600);
    assert.throws(() => loadRendererAcceptanceReceiptSync(accepted.filename, accepted.hash,
      { expectedReceiptUid: process.getuid() }), /renderer_acceptance_file_invalid/u);
    chmodSync(accepted.filename, 0o640);
    const wrongGroup = { ...accepted.value,
      principals: { ...accepted.value.principals, ipcGid: accepted.value.principals.ipcGid + 1 } };
    const bytes = Buffer.from(`${JSON.stringify(wrongGroup)}\n`);
    writeFileSync(accepted.filename, bytes, { mode: 0o640 });
    chmodSync(accepted.filename, 0o640);
    assert.throws(() => loadRendererAcceptanceReceiptSync(accepted.filename, sha256(bytes),
      { expectedReceiptUid: process.getuid() }), /renderer_acceptance_group_invalid/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("acceptance pin is a metadata-bound root-owned ipc-group 0640 exact hash", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-pin-dac-"));
  try {
    const accepted = receipt(directory);
    const pin = path.join(directory, "acceptance.sha256");
    writeFileSync(pin, `${accepted.hash}\n`, { mode: 0o640 });
    chmodSync(pin, 0o640);
    assert.deepEqual(await loadRendererAcceptancePin(pin, process.getuid()),
      { hash: accepted.hash, gid: process.getgid() });
    chmodSync(pin, 0o600);
    await assert.rejects(loadRendererAcceptancePin(pin, process.getuid()), /renderer_acceptance_pin_invalid/u);
    chmodSync(pin, 0o640);
    writeFileSync(pin, `${"A".repeat(64)}\n`, { mode: 0o640 });
    chmodSync(pin, 0o640);
    await assert.rejects(loadRendererAcceptancePin(pin, process.getuid()), /renderer_acceptance_pin_invalid/u);
    writeFileSync(pin, `${accepted.hash}\n`, { mode: 0o640 });
    chmodSync(pin, 0o640);
    linkSync(pin, path.join(directory, "acceptance-hardlink.sha256"));
    await assert.rejects(loadRendererAcceptancePin(pin, process.getuid()), /renderer_acceptance_pin_invalid/u);
    rmSync(path.join(directory, "acceptance-hardlink.sha256"));
    rmSync(pin);
    symlinkSync(accepted.filename, pin);
    await assert.rejects(loadRendererAcceptancePin(pin, process.getuid()), /renderer_acceptance_pin_invalid/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("client rejects unsafe work and socket directories before writing", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-layout-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => ({ status: "failed", stableError: "must_not_render" }) });
  t.after(() => service.close());
  const options = { socketPath, spoolRoot, acceptanceReceiptPath: accepted.filename,
    acceptanceReceiptHash: accepted.hash, expectedReceiptUid: process.getuid() };
  chmodSync(path.join(spoolRoot, "work"), 0o750);
  assert.throws(() => createDedicatedRendererClient(options), /renderer_spool_work_directory_invalid/u);
  chmodSync(path.join(spoolRoot, "work"), 0o700);
  rmSync(path.join(spoolRoot, "work"), { recursive: true });
  symlinkSync(directory, path.join(spoolRoot, "work"));
  assert.throws(() => createDedicatedRendererClient(options), /renderer_spool_work_directory_invalid/u);
  rmSync(path.join(spoolRoot, "work"));
  mkdirSync(path.join(spoolRoot, "work"), { mode: 0o700 });
  chmodSync(directory, 0o750);
  assert.throws(() => createDedicatedRendererClient(options), /renderer_socket_directory_invalid/u);
  chmodSync(directory, 0o2750);
  const client = createDedicatedRendererClient(options);
  t.after(() => client.close());
  await client.ready();
});

test("sandbox pin failure leaves no job, request, or seccomp residual", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-preflight-"));
  try {
    const accepted = receipt(directory);
    const temporaryRoot = path.join(directory, "work");
    assert.throws(() => renderBookLabJobToFiles({ kind: "preview", input: { inputHash: "2".repeat(64) } },
      { temporaryRoot, timeoutMs: 1_000, dedicatedReceipt: accepted.value }),
    (error) => error.message === "render_worker_failed" &&
      error.rendererDiagnostic?.code === "renderer_sandbox_setup_failed");
    assert.deepEqual(readdirSync(temporaryRoot), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cold filesystem AF_UNIX readiness waits beyond render control budget without materializing a job", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ur-cold-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  const bootstrap = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => { throw new Error("must_not_render"); } });
  await bootstrap.close();
  let readyEntered;
  const entered = new Promise((resolve) => { readyEntered = resolve; });
  let delayed = false;
  const server = await listenFake(socketPath, (socket) => {
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => { bytes = Buffer.concat([bytes, chunk]); });
    socket.on("end", async () => {
      const message = JSON.parse(bytes.subarray(0, -1).toString("utf8"));
      const acceptedResponse = () => socket.end(`${JSON.stringify({ schema: RENDERER_CONTROL_RESPONSE_SCHEMA,
        status: "accepted", operation: message.operation, requestId: message.requestId, code: null })}\n`);
      if (message.operation === "ready") {
        if (message.requestId !== accepted.hash || message.requestHash !== accepted.hash) {
          socket.end(`${JSON.stringify({ schema: RENDERER_CONTROL_RESPONSE_SCHEMA, status: "rejected",
            operation: null, requestId: null, code: "renderer_control_not_ready" })}\n`);
          return;
        }
        if (!delayed) {
          delayed = true;
          readyEntered();
          await new Promise((resolve) => setTimeout(resolve, 5_100));
        }
        acceptedResponse();
        return;
      }
      const resultPath = path.join(spoolRoot, "results", `${message.requestId}.json`);
      const cleanupPath = path.join(spoolRoot, "results", "cleanup", `${message.requestId}.json`);
      if (message.operation === "render") {
        assert.equal(readdirSync(path.join(spoolRoot, "inbox")).length, 1);
        const diagnostic = { schema: "unseen-book-renderer-failure-diagnostic/1", phase: "unclassified",
          code: "renderer_unclassified", exitCode: null, signalled: false, stderrBytes: 0 };
        writeFileSync(resultPath, `${JSON.stringify({ schema: "unseen-book-renderer-result/1",
          requestId: message.requestId, requestHash: message.requestHash, status: "failed",
          metadata: { stableError: "render_failed", diagnostic }, artifacts: {} })}\n`, { mode: 0o640 });
        chmodSync(resultPath, 0o640);
      } else if (message.operation === "ack") {
        rmSync(resultPath, { force: true });
        writeFileSync(cleanupPath, `${JSON.stringify({ schema: "unseen-book-render-cleanup/1",
          requestId: message.requestId, requestHash: message.requestHash, reason: "terminal" })}\n`, { mode: 0o640 });
        chmodSync(cleanupPath, 0o640);
      } else if (message.operation === "finalize") rmSync(cleanupPath, { force: true });
      acceptedResponse();
    });
  });
  t.after(() => closeServer(server));
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), testOnlyTiming: { wholeTimeoutMs: 10_000,
      cleanupGraceMs: 5_000, coldStartTimeoutMs: 10_000, reconcileIntervalMs: 10_000 } });
  t.after(() => client.close());
  const started = Date.now();
  const rendered = client.render({ kind: "preview", processorRequest: processorRequest("cold-ready",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) } });
  await entered;
  assertSpoolEmpty(spoolRoot);
  assert.deepEqual(await rendered, { status: "failed", stableError: "render_failed" });
  assert.ok(Date.now() - started >= 5_000);
  assert.equal((await notifyRendererControl(socketPath, { operation: "ready", requestId: accepted.hash,
    requestHash: accepted.hash }, 1_000)).status, "accepted");
  assert.equal((await notifyRendererControl(socketPath, { operation: "ready", requestId: accepted.hash,
    requestHash: accepted.hash }, 1_000)).status, "accepted");
  await assert.rejects(notifyRendererControl(socketPath, { operation: "ready", requestId: "0".repeat(64),
    requestHash: "0".repeat(64) }, 1_000), /renderer_control_not_ready/u);
  assertSpoolEmpty(spoolRoot);
});

test("readiness timeout fails before inbox, marker or cancellation exists", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-ready-timeout-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    async checkpoint(name, _requestId, operation) {
      if (name === "after_control_backing_validation" && operation === "ready") {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }, render: async () => { throw new Error("must_not_render"); } });
  t.after(() => service.close());
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), testOnlyTiming: { wholeTimeoutMs: 500,
      cleanupGraceMs: 50, coldStartTimeoutMs: 30, reconcileIntervalMs: 500 } });
  t.after(() => client.close());
  await assert.rejects(client.render({ kind: "preview", processorRequest: processorRequest("ready-timeout",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) } }), /renderer_control_timeout/u);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assertSpoolEmpty(spoolRoot);
});

test("failure diagnostics are exact, privacy-safe internal metadata and never change client output", async (t) => {
  const diagnosticCases = [
    ["sandbox_setup", "renderer_sandbox_setup_failed"],
    ["request_stage", "renderer_request_stage_failed"],
    ["child_spawn", "renderer_child_spawn_failed"],
    ["child_exit", "renderer_child_timeout"],
    ["child_exit", "renderer_child_stderr_limit"],
    ["child_exit", "renderer_child_nonzero_exit"],
    ["child_exit", "renderer_child_signalled"],
    ["output_manifest", "renderer_output_manifest_invalid"],
    ["html_validation", "renderer_html_validation_failed"],
    ["pdf_validation", "renderer_pdf_validation_failed"],
    ["receipt_validation", "renderer_receipt_validation_failed"],
    ["unclassified", "renderer_unclassified"]
  ];
  for (const [phase, code] of diagnosticCases) assert.equal(validateRendererFailureDiagnostic({
    schema: "unseen-book-renderer-failure-diagnostic/1", phase, code, exitCode: null,
    signalled: false, stderrBytes: 0 }).code, code);
  const base = { schema: "unseen-book-renderer-failure-diagnostic/1", phase: "child_exit",
    code: "renderer_child_nonzero_exit", exitCode: 1, signalled: false, stderrBytes: 12 };
  for (const mutation of [{ ...base, phase: "html_validation" }, { ...base, message: "private" },
    { ...base, path: "/private" }, { ...base, stdout: "private" }, { ...base, stderr: "private" },
    { ...base, requestId: "0".repeat(64) }, { ...base, exitCode: 256 }, { ...base, signalled: "false" },
    { ...base, stderrBytes: 65_537 }]) {
    assert.throws(() => validateRendererFailureDiagnostic(mutation), /renderer_failure_diagnostic_invalid/u);
  }

  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-diagnostic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  const observed = [];
  let manifestMetadata;
  const safeDiagnostic = validateRendererFailureDiagnostic(base);
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    onDiagnostic: (diagnostic) => observed.push(diagnostic),
    async checkpoint(name, requestId) {
      if (name === "after_manifest") manifestMetadata = JSON.parse(readFileSync(path.join(spoolRoot, "results",
        `${requestId}.json`), "utf8")).metadata;
    }, async render() {
      throw Object.assign(new Error("private stderr /private/path request body"),
        { rendererDiagnostic: safeDiagnostic });
    } });
  t.after(() => service.close());
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid() });
  t.after(() => client.close());
  assert.deepEqual(await client.render({ kind: "preview", processorRequest: processorRequest("diagnostic",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) } }),
  { status: "failed", stableError: "render_failed" });
  assert.deepEqual(observed, [safeDiagnostic]);
  assert.deepEqual(manifestMetadata, { stableError: "render_failed", diagnostic: safeDiagnostic });
  assert.doesNotMatch(JSON.stringify({ observed, manifestMetadata }), /private|path|request body/u);
  assertSpoolEmpty(spoolRoot);
});

test("daemon restart securely removes exact power-crash job and seccomp residuals before rendering", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-work-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  let service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => ({ status: "failed", stableError: "must_not_render" }) });
  await service.close();
  writeWorkResidual(path.join(spoolRoot, "work"), "8".repeat(64));
  assert.equal(readdirSync(path.join(spoolRoot, "work")).length, 2);
  service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => ({ status: "failed", stableError: "must_not_render" }) });
  t.after(() => service.close());
  assert.deepEqual(readdirSync(path.join(spoolRoot, "work")), []);
});

test("work sweeper preserves current active work, ages inactive work, and fails closed on malicious entries", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-work-sweep-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => ({ status: "failed", stableError: "must_not_render" }) });
  await service.close();
  const workRoot = path.join(spoolRoot, "work");
  const requestId = "9".repeat(64);
  const residual = writeWorkResidual(workRoot, requestId);
  const old = new Date(Date.now() - BOOK_RENDER_LEASE_MS - 1_000);
  for (const filename of [path.join(residual.job, "request.json"), residual.job, residual.seccomp]) {
    utimesSync(filename, old, old);
  }
  await sweepRendererWorkDirectory(workRoot, accepted.value.principals,
    { activeRequestIds: new Set([requestId]), now: Date.now() });
  assert.equal(readdirSync(workRoot).length, 2);
  await sweepRendererWorkDirectory(workRoot, accepted.value.principals, { now: Date.now() });
  assert.deepEqual(readdirSync(workRoot), []);
  writeFileSync(path.join(workRoot, "unknown-entry"), "synthetic\n", { mode: 0o600 });
  await assert.rejects(sweepRendererWorkDirectory(workRoot, accepted.value.principals, { startup: true }),
    /renderer_work_entry_invalid/u);
  rmSync(path.join(workRoot, "unknown-entry"));
  const linkedJob = path.join(workRoot, `dedicated-job-${requestId}-Zy98Xw`);
  symlinkSync(directory, linkedJob);
  await assert.rejects(sweepRendererWorkDirectory(workRoot, accepted.value.principals, { startup: true }),
    /renderer_work_job_invalid/u);
});

test("bwrap shares outer private netns while seccomp blocks IP, netlink, packet and namespace escape", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-sandbox-"));
  try {
    const acceptance = receipt(directory).value;
    const args = buildLinuxRenderSandboxArguments({ receipt: acceptance,
      repositoryRoot: "/opt/unseen/releases/" + "a".repeat(40),
      temporaryRoot: "/var/lib/unseen/renderer-spool/work" });
    assert.ok(args.includes("--share-net"));
    assert.equal(args.includes("--unshare-net"), false);
    assert.ok(args.includes("--unshare-user"));
    assert.ok(args.includes("--unshare-pid"));
    assert.ok(args.includes("--unshare-ipc"));
    assert.ok(args.includes("--unshare-uts"));
    assert.ok(args.includes("--disable-userns"));
    assert.ok(args.includes("--seccomp"));
    assert.equal(args[args.lastIndexOf("TMPDIR") + 1], "/tmp");
    assert.ok(args.some((entry, index) => entry === "--ro-bind" &&
      args[index + 1] === "/opt/unseen/runtime/node-v22.23.2-linux-x64" && args[index + 2] === args[index + 1]));
    assert.equal(args.some((entry, index) => entry === "--ro-bind" && args[index + 1] === "/"), false);
    assert.equal(buildRendererChildSeccomp().length, 23 * 8);
    assert.match(rendererChildSeccompHash(), /^[a-f0-9]{64}$/u);
    const missingNode = structuredClone(acceptance);
    missingNode.readOnlyMounts = missingNode.readOnlyMounts.filter((entry) => !entry.startsWith("/opt/unseen/runtime/"));
    assert.throws(() => buildLinuxRenderSandboxArguments({ receipt: missingNode,
      repositoryRoot: "/opt/unseen/releases/" + "a".repeat(40),
      temporaryRoot: "/var/lib/unseen/renderer-spool/work" }), /renderer_acceptance_node_mount_missing/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("candidate-owned Chromium adapter seals exact14 environment, fixed argv and private disposable profile", async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-snap-adapter-"));
  const jobRoot = path.join(temporaryRoot, `dedicated-job-${"a".repeat(64)}-Ab12Cd`);
  mkdirSync(jobRoot, { mode: 0o700 });
  chmodSync(jobRoot, 0o700);
  try {
    const accepted = receipt(temporaryRoot).value;
    const htmlPath = path.join(jobRoot, "book.html");
    const pdfPath = path.join(jobRoot, "book.pdf");
    const options = { receipt: accepted, temporaryRoot, jobRoot, htmlPath, pdfPath,
      outerSandboxVerified: true };
    assert.throws(() => renderBookLabJob({ kind: "preview", input: {} },
      { temporaryRoot, dedicatedReceipt: accepted }), /render_worker_dedicated_files_only/u);
    const invocation = buildChromiumSnapHeadlessInvocation(options);
    assert.equal(invocation.command, CHROMIUM_SNAP_BROWSER);
    assert.equal(invocation.policySha256, CHROMIUM_SNAP_ADAPTER_POLICY_SHA256);
    assert.deepEqual(Object.keys(invocation.environment).sort(), ["CHROME_VERSION_EXTRA", "HOME", "LANG", "SNAP",
      "SNAP_ARCH", "SNAP_INSTANCE_NAME", "SNAP_NAME", "SNAP_REAL_HOME", "SNAP_REVISION", "SNAP_USER_COMMON",
      "SNAP_USER_DATA", "SNAP_VERSION", "TMPDIR", "XDG_RUNTIME_DIR"]);
    assert.equal(invocation.environment.SNAP_ARCH, "amd64");
    assert.equal(invocation.environment.CHROME_VERSION_EXTRA, "snap");
    for (const key of ["PATH", "SNAP_COMMON", "SNAP_DATA", "SNAPCTL", "NODE_OPTIONS", "LD_PRELOAD"]) {
      assert.equal(Object.hasOwn(invocation.environment, key), false);
    }
    assert.deepEqual(invocation.arguments.slice(0, 4),
      ["--password-store=basic", "--headless=new", "--no-sandbox", "--disable-background-networking"]);
    assert.equal(invocation.arguments.filter((value) => value === "--no-sandbox").length, 1);
    assert.equal(invocation.arguments.at(-2), `--print-to-pdf=${pdfPath}`);
    assert.equal(invocation.arguments.at(-1), new URL(`file://${htmlPath}`).href);
    assert.equal(invocation.arguments.some((value) => /snapctl|profile-import|\/var\/snap/u.test(value)), false);
    assert.equal(Object.isFrozen(invocation), true);
    assert.equal(Object.isFrozen(invocation.arguments), true);
    assert.equal(Object.isFrozen(invocation.environment), true);
    assert.throws(() => invocation.arguments.push("--forged"), TypeError);
    assert.throws(() => { invocation.environment.PATH = "/tmp"; }, TypeError);
    for (const relative of ["home", "home/.cache", "home/.config", "xdg", "snap-user-common",
      "snap-user-data", "tmp"]) assert.equal(lstatSync(path.join(jobRoot, relative)).mode & 0o7777, 0o700);
    assert.deepEqual(buildChromiumSnapHeadlessInvocation(options), invocation);
    assert.throws(() => buildChromiumSnapHeadlessInvocation({ ...options, outerSandboxVerified: false }),
      /renderer_browser_adapter_pin_drift/u);
    const badPolicy = structuredClone(accepted);
    badPolicy.browserAdapter.argumentProjectionSha256 = "0".repeat(64);
    assert.throws(() => buildChromiumSnapHeadlessInvocation({ ...options, receipt: badPolicy }),
      /renderer_browser_adapter_pin_drift/u);
    const currentRevision = structuredClone(accepted);
    currentRevision.browserDistribution.numericRoot = "/snap/chromium/current";
    assert.throws(() => buildChromiumSnapHeadlessInvocation({ ...options, receipt: currentRevision }),
      /renderer_acceptance_browser_distribution_invalid/u);
    const inheritedEnvironment = structuredClone(invocation);
    inheritedEnvironment.environment.PATH = "/tmp";
    await assert.rejects(printExactHtmlToPdf({ html: "synthetic", htmlPath, pdfPath, orderedPageIds: [],
      canonicalTimestamp: "2026-08-15T00:00:00.000Z", browserInvocation: inheritedEnvironment,
      outerSandboxVerified: true }), /browser_invocation_invalid/u);
    const injectedArgument = structuredClone(invocation);
    injectedArgument.arguments.push("--load-extension=/tmp/attacker");
    await assert.rejects(printExactHtmlToPdf({ html: "synthetic", htmlPath, pdfPath, orderedPageIds: [],
      canonicalTimestamp: "2026-08-15T00:00:00.000Z", browserInvocation: injectedArgument,
      outerSandboxVerified: true }), /browser_invocation_invalid/u);
    const exactClone = structuredClone(invocation);
    await assert.rejects(printExactHtmlToPdf({ html: "synthetic", htmlPath, pdfPath, orderedPageIds: [],
      canonicalTimestamp: "2026-08-15T00:00:00.000Z", browserInvocation: exactClone,
      outerSandboxVerified: true }), /browser_invocation_invalid/u);
    await assert.rejects(printExactHtmlToPdf({ html: "synthetic", htmlPath, pdfPath, orderedPageIds: [],
      canonicalTimestamp: "2026-08-15T00:00:00.000Z", browserInvocation: { ...invocation },
      outerSandboxVerified: true }), /browser_invocation_invalid/u);
    const serialized = JSON.parse(JSON.stringify(invocation));
    serialized.policySha256 = "9".repeat(64);
    await assert.rejects(printExactHtmlToPdf({ html: "synthetic", htmlPath, pdfPath, orderedPageIds: [],
      canonicalTimestamp: "2026-08-15T00:00:00.000Z", browserInvocation: serialized,
      outerSandboxVerified: true }), /browser_invocation_invalid/u);
    const isolatedAdapter = await import(new URL(
      "../../../infra/integration/book-lab/chromium-snap-headless-adapter.mjs?isolated-provenance=1",
      import.meta.url));
    const crossModule = isolatedAdapter.buildChromiumSnapHeadlessInvocation(options);
    await assert.rejects(printExactHtmlToPdf({ html: "synthetic", htmlPath, pdfPath, orderedPageIds: [],
      canonicalTimestamp: "2026-08-15T00:00:00.000Z", browserInvocation: crossModule,
      outerSandboxVerified: true }), /browser_invocation_invalid/u);
    const externalProfile = path.join(temporaryRoot, "external-profile");
    mkdirSync(externalProfile, { mode: 0o755 });
    chmodSync(externalProfile, 0o755);
    rmSync(path.join(jobRoot, "tmp"), { recursive: true });
    symlinkSync(externalProfile, path.join(jobRoot, "tmp"));
    assert.throws(() => buildChromiumSnapHeadlessInvocation(options),
      /renderer_browser_private_directory_invalid/u);
    assert.equal(lstatSync(externalProfile).mode & 0o7777, 0o755);
    rmSync(path.join(jobRoot, "tmp"));
    mkdirSync(path.join(jobRoot, "tmp"), { mode: 0o700 });
    await assert.rejects(printExactHtmlToPdf({ html: "<!doctype html><title>synthetic</title>", htmlPath,
      pdfPath, orderedPageIds: [], canonicalTimestamp: "2026-08-15T00:00:00.000Z",
      browserInvocation: invocation, outerSandboxVerified: true }), /^Error: pdf_print_failed$/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("snap archive accepts only one inode or its exact snapd SHA3 cache hardlink with stable metadata", () => {
  assert.equal(CHROMIUM_SNAP_ARCHIVE_LINK_POLICY_SHA256,
    "49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5");
  const makeFixture = () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-snap-link-"));
    const snapd = path.join(directory, "var/lib/snapd");
    const snaps = path.join(snapd, "snaps");
    const cacheDirectory = path.join(snapd, "cache");
    for (const target of [path.join(directory, "var"), path.join(directory, "var/lib"), snapd, snaps]) {
      mkdirSync(target, { recursive: true, mode: 0o755 });
      chmodSync(target, 0o755);
    }
    mkdirSync(cacheDirectory, { mode: 0o700 });
    const archivePath = path.join(snaps, "chromium_3507.snap");
    const contents = Buffer.from("synthetic private-free snap archive\n");
    writeFileSync(archivePath, contents, { mode: 0o600 });
    chmodSync(archivePath, 0o600);
    const expectedSha3384 = createHash("sha3-384").update(contents).digest("hex");
    const cachePath = path.join(cacheDirectory, expectedSha3384);
    const policy = { archivePath, cacheDirectory, cachePath, expectedSha256: sha256(contents), expectedSha3384,
      expectedBytes: contents.length, expectedUid: process.getuid(), expectedGid: process.getgid(), fileMode: 0o600,
      cacheDirectoryMode: 0o700, ancestorDirectories: [directory, path.join(directory, "var"),
        path.join(directory, "var/lib"), snapd, snaps], policySha256: CHROMIUM_SNAP_ARCHIVE_LINK_POLICY_SHA256 };
    return { directory, snapd, snaps, cacheDirectory, archivePath, cachePath, contents, policy };
  };
  const withFixture = (callback) => {
    const fixture = makeFixture();
    try { callback(fixture); } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
  };

  withFixture(({ policy }) => assert.deepEqual(measureSnapdArchiveLinkTopologyForTest(policy), {
    schema: "unseen-snapd-cache-link-topology/1", state: "ARCHIVE_ONLY", linkCount: 1,
    policySha256: CHROMIUM_SNAP_ARCHIVE_LINK_POLICY_SHA256 }));
  withFixture(({ archivePath, cachePath, policy }) => {
    linkSync(archivePath, cachePath);
    assert.deepEqual(measureSnapdArchiveLinkTopologyForTest(policy), {
      schema: "unseen-snapd-cache-link-topology/1", state: "ARCHIVE_AND_SNAPD_SHA3_CACHE", linkCount: 2,
      policySha256: CHROMIUM_SNAP_ARCHIVE_LINK_POLICY_SHA256 });
  });
  withFixture(({ cachePath, contents, policy }) => {
    writeFileSync(cachePath, contents, { mode: 0o600 });
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ archivePath, cacheDirectory, policy }) => {
    linkSync(archivePath, path.join(cacheDirectory, "wrong-cache-key"));
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ archivePath, cachePath, cacheDirectory, contents, policy }) => {
    linkSync(archivePath, path.join(cacheDirectory, "other-link"));
    writeFileSync(cachePath, contents, { mode: 0o600 });
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ archivePath, cachePath, cacheDirectory, policy }) => {
    linkSync(archivePath, path.join(cacheDirectory, "other-link"));
    symlinkSync(archivePath, cachePath);
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ archivePath, cachePath, cacheDirectory, policy }) => {
    linkSync(archivePath, cachePath);
    linkSync(archivePath, path.join(cacheDirectory, "third-link"));
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ archivePath, policy }) => {
    chmodSync(archivePath, 0o640);
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ policy }) => assert.throws(() => measureSnapdArchiveLinkTopologyForTest({ ...policy,
    expectedUid: policy.expectedUid + 1 }), /renderer_target_browser_archive_invalid/u));
  withFixture(({ policy }) => assert.throws(() => measureSnapdArchiveLinkTopologyForTest({ ...policy,
    expectedSha256: "0".repeat(64) }), /renderer_target_browser_archive_invalid/u));
  withFixture(({ policy }) => assert.throws(() => measureSnapdArchiveLinkTopologyForTest({ ...policy,
    expectedBytes: policy.expectedBytes + 1 }), /renderer_target_browser_archive_invalid/u));
  withFixture(({ snapd, policy }) => {
    chmodSync(snapd, 0o775);
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ cacheDirectory, policy }) => {
    chmodSync(cacheDirectory, 0o750);
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ directory, snapd, policy }) => {
    const alias = path.join(directory, "snapd-alias");
    symlinkSync(snapd, alias);
    const throughAlias = { ...policy, archivePath: path.join(alias, "snaps/chromium_3507.snap"),
      cacheDirectory: path.join(alias, "cache"), cachePath: path.join(alias, "cache", policy.expectedSha3384),
      ancestorDirectories: [...policy.ancestorDirectories.slice(0, 3), alias, path.join(alias, "snaps")] };
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(throughAlias),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ archivePath, cachePath, policy }) => {
    linkSync(archivePath, cachePath);
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy, () => unlinkSync(cachePath)),
      /renderer_target_browser_archive_invalid/u);
  });
  withFixture(({ archivePath, contents, policy }) => {
    assert.throws(() => measureSnapdArchiveLinkTopologyForTest(policy, () => {
      renameSync(archivePath, `${archivePath}.replaced`);
      writeFileSync(archivePath, contents, { mode: 0o600 });
    }), /renderer_target_browser_archive_invalid/u);
  });
});

test("Chromium numeric tree manifest binds every entry, resource, mode, link and target", () => {
  const rootDirectory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-snap-tree-"));
  const snapRoot = path.join(rootDirectory, "3507");
  const browserRoot = path.join(snapRoot, "usr/lib/chromium-browser");
  const locales = path.join(browserRoot, "locales");
  mkdirSync(locales, { recursive: true, mode: 0o755 });
  try {
    writeFileSync(path.join(browserRoot, "chrome"), "synthetic ELF bytes\n", { mode: 0o755 });
    writeFileSync(path.join(browserRoot, "resources.pak"), "synthetic resource\n", { mode: 0o644 });
    writeFileSync(path.join(locales, "en-US.pak"), "synthetic locale\n", { mode: 0o644 });
    symlinkSync("resources.pak", path.join(browserRoot, "resource-link"));
    const measured = measureChromiumSnapTree(snapRoot, process.getuid());
    assert.equal(measured.treeRegularFileCount, 3);
    assert.equal(measured.treeSymlinkCount, 1);
    assert.equal(measured.resourceCount, 2);
    assert.equal(measured.canonicalDanglingSymlinkCount, 0);
    assert.equal(measured.canonicalDanglingSymlinkPolicySha256,
      CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY_SHA256);
    assert.deepEqual(measureChromiumSnapTree(snapRoot, process.getuid()), measured);

    const resourcePath = path.join(browserRoot, "resources.pak");
    const originalResource = readFileSync(resourcePath);
    const changedResource = Buffer.from(originalResource);
    changedResource[0] ^= 1;
    writeFileSync(resourcePath, changedResource, { mode: 0o644 });
    const sameShapeDrift = measureChromiumSnapTree(snapRoot, process.getuid());
    assert.equal(sameShapeDrift.treeEntryCount, measured.treeEntryCount);
    assert.equal(sameShapeDrift.treeRegularBytes, measured.treeRegularBytes);
    assert.equal(sameShapeDrift.resourceCount, measured.resourceCount);
    assert.notEqual(sameShapeDrift.treeManifestSha256, measured.treeManifestSha256);
    assert.notEqual(sameShapeDrift.resourceManifestSha256, measured.resourceManifestSha256);
    writeFileSync(resourcePath, originalResource, { mode: 0o644 });

    writeFileSync(path.join(browserRoot, "unexpected.bin"), "unexpected\n", { mode: 0o644 });
    assert.notEqual(measureChromiumSnapTree(snapRoot, process.getuid()).treeManifestSha256,
      measured.treeManifestSha256);
    rmSync(path.join(browserRoot, "unexpected.bin"));
    chmodSync(path.join(browserRoot, "resources.pak"), 0o666);
    assert.throws(() => measureChromiumSnapTree(snapRoot, process.getuid()),
      /renderer_target_browser_tree_invalid/u);
    chmodSync(path.join(browserRoot, "resources.pak"), 0o644);
    linkSync(path.join(browserRoot, "resources.pak"), path.join(browserRoot, "hardlink.pak"));
    assert.throws(() => measureChromiumSnapTree(snapRoot, process.getuid()),
      /renderer_target_browser_tree_invalid/u);
    rmSync(path.join(browserRoot, "hardlink.pak"));
    symlinkSync("missing-resource", path.join(browserRoot, "unexpected-dangling-link"));
    assert.throws(() => measureChromiumSnapTree(snapRoot, process.getuid()),
      /renderer_target_browser_tree_invalid/u);
    rmSync(path.join(browserRoot, "unexpected-dangling-link"));
    symlinkSync(rootDirectory, path.join(browserRoot, "escape-link"));
    assert.throws(() => measureChromiumSnapTree(snapRoot, process.getuid()),
      /renderer_target_browser_tree_invalid/u);
  } finally { rmSync(rootDirectory, { recursive: true, force: true }); }
});

test("canonical Snap dangling symlinks are exact, absent, stable and policy-bound", () => {
  const withFixture = (callback) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-snap-dangling-"));
    const snapRoot = path.join(directory, "snap/3507");
    const absoluteRoot = path.join(directory, "namespace");
    const xdgEmail = path.join(snapRoot, "usr/bin/xdg-email");
    const groffSite = path.join(snapRoot, "usr/share/groff/site-tmac");
    mkdirSync(path.dirname(xdgEmail), { recursive: true, mode: 0o755 });
    mkdirSync(path.dirname(groffSite), { recursive: true, mode: 0o755 });
    mkdirSync(path.join(absoluteRoot, "usr/bin"), { recursive: true, mode: 0o755 });
    symlinkSync("/usr/bin/xdg-open", xdgEmail);
    symlinkSync("../../../etc/groff", groffSite);
    const sourceStat = lstatSync(xdgEmail);
    const sourceMetadata = { uid: sourceStat.uid, gid: sourceStat.gid, mode: sourceStat.mode & 0o7777,
      nlink: 1 };
    const verify = (afterFirstCheck = null) => verifyChromiumSnapCanonicalDanglingSymlinksForTest(
      snapRoot, process.getuid(), absoluteRoot, afterFirstCheck, sourceMetadata);
    try { callback({ directory, snapRoot, absoluteRoot, xdgEmail, groffSite, verify }); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  };
  withFixture(({ verify }) => {
    assert.deepEqual(verify(), {
      schema: "unseen-chromium-snap-canonical-dangling-symlinks/1",
      sha256: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY_SHA256,
      count: 2,
      runtimeReachability: "ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE"
    });
    assert.equal(CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.entries.length, 2);
    assert.equal(CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.entries[0].relative, "usr/bin/xdg-email");
    assert.equal(CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.entries[1].relative,
      "usr/share/groff/site-tmac");
  });
  const exactObservation = { type: "symlink", uid: 0, gid: 0, mode: 0o777, nlink: 1,
    relative: "usr/bin/xdg-email", target: "/usr/bin/xdg-open" };
  assert.equal(validateChromiumSnapDanglingSymlinkObservationForTest(exactObservation), true);
  for (const candidate of [
    { ...exactObservation, uid: 1 },
    { ...exactObservation, gid: 12 },
    { ...exactObservation, mode: 0o755 },
    { ...exactObservation, nlink: 2 },
    { ...exactObservation, relative: "usr/bin/other" },
    { ...exactObservation, target: "/usr/bin/other" }
  ]) assert.throws(() => validateChromiumSnapDanglingSymlinkObservationForTest(candidate),
    /renderer_target_browser_tree_invalid/u);
  withFixture(({ xdgEmail, verify }) => {
    unlinkSync(xdgEmail);
    symlinkSync("/usr/bin/other", xdgEmail);
    assert.throws(() => verify(), /renderer_target_browser_tree_invalid/u);
  });
  withFixture(({ groffSite, verify }) => {
    unlinkSync(groffSite);
    symlinkSync("../../../etc/other", groffSite);
    assert.throws(() => verify(), /renderer_target_browser_tree_invalid/u);
  });
  withFixture(({ absoluteRoot, verify }) => {
    writeFileSync(path.join(absoluteRoot, "usr/bin/xdg-open"), "synthetic\n", { mode: 0o755 });
    assert.throws(() => verify(), /renderer_target_browser_tree_invalid/u);
  });
  withFixture(({ snapRoot, verify }) => {
    mkdirSync(path.join(snapRoot, "etc/groff"), { recursive: true, mode: 0o755 });
    assert.throws(() => verify(), /renderer_target_browser_tree_invalid/u);
  });
  withFixture(({ xdgEmail, verify }) => {
    unlinkSync(xdgEmail);
    assert.throws(() => verify(), /renderer_target_browser_tree_invalid/u);
  });
  withFixture(({ absoluteRoot, verify }) => {
    chmodSync(path.join(absoluteRoot, "usr"), 0o777);
    assert.throws(() => verify(), /renderer_target_browser_tree_invalid/u);
  });
  withFixture(({ absoluteRoot, verify }) => {
    symlinkSync("missing-xdg-open", path.join(absoluteRoot, "usr/bin/xdg-open"));
    assert.throws(() => verify(), /renderer_target_browser_tree_invalid/u);
  });
  withFixture(({ absoluteRoot, verify }) => {
    symlinkSync("xdg-open", path.join(absoluteRoot, "usr/bin/xdg-open"));
    assert.throws(() => verify(), /renderer_target_browser_tree_invalid/u);
  });
  withFixture(({ snapRoot, verify }) => {
    mkdirSync(path.join(snapRoot, "etc"), { recursive: true, mode: 0o755 });
    symlinkSync("missing-groff", path.join(snapRoot, "etc/groff"));
    assert.throws(() => verify(), /renderer_target_browser_tree_invalid/u);
  });
  withFixture(({ xdgEmail, verify }) => {
    assert.throws(() => verify((entry) => {
        if (entry.relative === "usr/bin/xdg-email") {
          unlinkSync(xdgEmail);
          symlinkSync("/usr/bin/xdg-open", xdgEmail);
        }
      }), /renderer_target_browser_tree_invalid/u);
  });
});

test("measured target receipt rejects fake or stale build, tools, units, policy and principals", () => {
  const measurements = { schema: "unseen-book-renderer-target-measurements/1", candidateCommit: "a".repeat(40),
    candidateTree: "b".repeat(40), rendererBuildHash: rendererImplementationHash(root),
    node: nodePin, nodeDistribution,
    browser: { path: CHROMIUM_SNAP_BROWSER, sha256: "c".repeat(64), version: "Chromium 151.0.7922.108" },
    browserDistribution, browserAdapter,
    bwrap: { path: "/usr/bin/bwrap", sha256: "d".repeat(64), version: "bubblewrap 0.9.0" },
    appArmor: { profile: "unseen-book-renderer", sha256: rendererAppArmorProfileHash(), loaded: true },
    fonts: { sha256: "e".repeat(64), count: 12 }, pdfTools: { sha256: "f".repeat(64), count: 2 },
    systemd: { sha256: "1".repeat(64), serviceSha256: "2".repeat(64), socketSha256: "3".repeat(64),
      effectivePropertiesSha256: "4".repeat(64) },
    cups: { connected: false, gate: "deny-and-verify", serviceActive: false, listenerCount: 0 },
    principals: { apiUid: 101, rendererUid: 102, rendererGid: 102, ipcGid: 103, apiUser: "unseen",
      rendererUser: "unseen-renderer", ipcGroup: "unseen-render-ipc" } };
  const accepted = buildRendererAcceptanceReceipt(measurements,
    ["/usr", CHROMIUM_SNAP_ROOT, "/opt/unseen/runtime/node-v22.23.2-linux-x64"]);
  assert.equal(accepted.targetVerification.verifierBuildHash, rendererVerifierBuildHash());
  assert.equal(verifyRendererTargetAcceptance({ receipt: accepted, repositoryRoot: root, measurements }).status,
    "TARGET_MEASUREMENTS_VERIFIED_NOT_RENDER_ACCEPTANCE");
  assert.equal(verifyRendererRuntimeTargetState({ receipt: accepted, repositoryRoot: root, measurements }).status,
    "RUNTIME_TARGET_STATE_VERIFIED");
  assert.throws(() => validateTargetCommandResult({ status: 1, stdout: "inactive\n", stderr: "denied" }, [0, 3]),
    /renderer_target_command_failed/u);
  assert.throws(() => validateTargetCommandResult({ status: 0, stdout: null, stderr: "" }),
    /renderer_target_command_failed/u);
  assert.doesNotThrow(() => validateTargetCommandResult({ status: 3, stdout: "inactive\ninactive\n", stderr: "" },
    [0, 3]));
  const mutate = (callback) => { const value = structuredClone(accepted); callback(value); return value; };
  for (const candidate of [
    mutate((value) => { value.browserDistribution.treeManifestSha256 = "9".repeat(64); }),
    mutate((value) => { value.browserDistribution.resourceManifestSha256 = "9".repeat(64); }),
    mutate((value) => { value.browserDistribution.canonicalDanglingSymlinkCount = 3; }),
    mutate((value) => { value.browserDistribution.canonicalDanglingSymlinkPolicySha256 = "9".repeat(64); }),
    mutate((value) => { value.browserDistribution.runtimeReachability = "REACHABLE"; })
  ]) assert.throws(() => verifyRendererTargetAcceptance({ receipt: candidate, repositoryRoot: root, measurements }),
    /renderer_acceptance_browser_distribution_invalid/u);
  for (const candidate of [
    mutate((value) => { value.browserDistribution.archiveLinkTopology.policySha256 = "9".repeat(64); }),
    mutate((value) => { value.browserDistribution.archiveLinkTopology.state = "ARCHIVE_ONLY"; }),
    mutate((value) => { value.browserDistribution.archiveLinkTopology.linkCount = 3; }),
    mutate((value) => { value.browserDistribution.archiveLinkTopology.extra = true; })
  ]) assert.throws(() => verifyRendererTargetAcceptance({ receipt: candidate, repositoryRoot: root, measurements }),
    /renderer_acceptance_browser_archive_link_topology_invalid/u);
  for (const candidate of [
    mutate((value) => { value.rendererBuildHash = "9".repeat(64); }),
    mutate((value) => { value.node.sha256 = "0".repeat(64); }),
    mutate((value) => { value.nodeDistribution.archiveSha256 = "9".repeat(64); }),
    mutate((value) => { value.browserAdapter.implementationSha256 = "9".repeat(64); }),
    mutate((value) => { value.browserAdapter.argumentProjectionSha256 = "9".repeat(64); }),
    mutate((value) => { value.candidateTree = "9".repeat(40); }),
    mutate((value) => { value.fonts.sha256 = "9".repeat(64); }),
    mutate((value) => { value.pdfTools.sha256 = "9".repeat(64); }),
    mutate((value) => { value.systemd.effectivePropertiesSha256 = "9".repeat(64); }),
    mutate((value) => { value.targetVerification.measurementsHash = "9".repeat(64); }),
    mutate((value) => { value.targetVerification.verifierBuildHash = "9".repeat(64); })
  ]) assert.throws(() => verifyRendererTargetAcceptance({ receipt: candidate, repositoryRoot: root, measurements }),
    /renderer_(?:build_pin|target_acceptance|target_verifier_pin)_drift/u);
  assert.throws(() => buildRendererAcceptanceReceipt({ ...measurements,
    principals: { ...measurements.principals, rendererUid: measurements.principals.apiUid } },
  ["/usr", CHROMIUM_SNAP_ROOT, "/opt/unseen/runtime/node-v22.23.2-linux-x64"]),
  /renderer_target_principals_invalid/u);
  for (const candidate of [mutate((value) => { value.appArmor.loaded = false; }),
    mutate((value) => { value.cups.serviceActive = true; }),
    mutate((value) => { value.cups.listenerCount = 1; value.cups.connected = true; })]) {
    assert.throws(() => verifyRendererTargetAcceptance({ receipt: candidate, repositoryRoot: root, measurements }),
      /renderer_acceptance_(?:apparmor|cups)_invalid/u);
  }
});

test("CUPS target probe accepts only both absent or both installed inactive units with zero listeners", () => {
  const result = (status, stdout, stderr = "") => ({ status, stdout, stderr });
  const show = (id, loadState, unitFileState, fragmentPath) => result(0,
    `Id=${id}\nLoadState=${loadState}\nActiveState=inactive\nSubState=dead\n` +
    `UnitFileState=${unitFileState}\nFragmentPath=${fragmentPath}\n`);
  const absentShows = [show("cups.service", "not-found", "", ""), show("cups.socket", "not-found", "", "")];
  const absentActive = [result(4, "inactive\n"), result(4, "inactive\n")];
  const noListeners = result(0, "");
  assert.deepEqual(validateCupsTargetProbe({ showResults: absentShows, activeResults: absentActive,
    listenerResult: noListeners }),
  { connected: false, gate: "deny-and-verify", serviceActive: false, listenerCount: 0 });
  const installedShows = [show("cups.service", "loaded", "disabled", "/usr/lib/systemd/system/cups.service"),
    show("cups.socket", "masked", "masked", "/etc/systemd/system/cups.socket")];
  const installedActive = [result(3, "inactive\n"), result(3, "inactive\n")];
  assert.doesNotThrow(() => validateCupsTargetProbe({ showResults: installedShows,
    activeResults: installedActive, listenerResult: noListeners }));

  const cases = [
    { showResults: [absentShows[0], installedShows[1]], activeResults: [absentActive[0], installedActive[1]],
      listenerResult: noListeners },
    { showResults: absentShows, activeResults: [result(4, "active\n"), absentActive[1]],
      listenerResult: noListeners },
    { showResults: absentShows, activeResults: absentActive,
      listenerResult: result(1, "", "ss: permission denied\n") },
    { showResults: [result(1, "", "Failed to get properties\n"), absentShows[1]],
      activeResults: absentActive, listenerResult: noListeners },
    { showResults: absentShows, activeResults: [result(1, "", "Access denied\n"), absentActive[1]],
      listenerResult: noListeners },
    { showResults: [show("cups.service", "error", "", ""), absentShows[1]], activeResults: absentActive,
      listenerResult: noListeners },
    { showResults: [result(0, `${absentShows[0].stdout}LoadState=not-found\n`), absentShows[1]],
      activeResults: absentActive, listenerResult: noListeners },
    { showResults: [show("cups.service", "not-found", "", "/run/systemd/generator/cups.service"), absentShows[1]],
      activeResults: absentActive, listenerResult: noListeners },
    { showResults: [show("cups-alias.service", "not-found", "", ""), absentShows[1]],
      activeResults: absentActive, listenerResult: noListeners },
    { showResults: [show("cups.service", "loaded", "generated", "/run/systemd/generator/cups.service"),
      installedShows[1]], activeResults: installedActive, listenerResult: noListeners },
    { showResults: [show("cups.service", "masked", "masked-runtime", "/run/systemd/system/cups.service"),
      installedShows[1]], activeResults: installedActive, listenerResult: noListeners },
    { showResults: absentShows, activeResults: absentActive,
      listenerResult: result(0, "tcp LISTEN 0 4096 127.0.0.1:631 0.0.0.0:*\n") },
    { showResults: absentShows, activeResults: absentActive,
      listenerResult: result(0, "unexpected ss output\n") },
    { showResults: absentShows, activeResults: absentActive, listenerResult: noListeners, listenerCount: 0 },
    { showResults: absentShows, activeResults: absentActive, listenerResult: noListeners,
      unixSocketPresent: true }
  ];
  for (const candidate of cases) {
    assert.throws(() => validateCupsTargetProbe(candidate), /renderer_target_cups_probe_invalid/u);
  }
});

test("filesystem AF_UNIX control ACK is immediate, duplicate-safe and lost-response replay leaves no orphan",
  async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-control-ack-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const accepted = receipt(directory);
    const spoolRoot = path.join(directory, "spool");
    const socketPath = path.join(directory, "render.sock");
    let releaseRender;
    let markEntered;
    const held = new Promise((resolve) => { releaseRender = resolve; });
    const entered = new Promise((resolve) => { markEntered = resolve; });
    let calls = 0;
    const service = await createDedicatedRendererService({ spoolRoot, socketPath,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true, async render() {
        calls += 1;
        markEntered();
        await held;
        return { status: "ready", html: "<main>control-ack</main>",
          htmlHash: sha256("<main>control-ack</main>"), pageCount: 1,
          htmlArtifactId: "preview-control-ack", equality: { pageCount: 1 } };
      } });
    t.after(() => service.close());
    const request = createRendererRequest({ kind: "preview", processorRequest: processorRequest("control-ack",
      "2".repeat(64)), input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
    await atomicWriteFile(path.join(spoolRoot, "inbox"), `${request.requestId}.json`,
      Buffer.from(`${JSON.stringify(request)}\n`));
    const first = await Promise.race([control(socketPath, request), new Promise((_, reject) =>
      setTimeout(() => reject(new Error("control_ack_waited_for_render")), 250))]);
    assert.equal(first.status, "accepted");
    await entered;
    const duplicate = await control(socketPath, request);
    assert.equal(duplicate.status, "accepted");
    await rawControl(socketPath, Buffer.from(`${JSON.stringify({ operation: "render", requestId: request.requestId,
      requestHash: request.requestHash })}\n`), { dropResponse: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    releaseRender();
    await service.idle();
    const client = createDedicatedRendererClient({ socketPath, spoolRoot,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid() });
    t.after(() => client.close());
    const result = await client.render({ kind: "preview", processorRequest: processorRequest("control-ack",
      "2".repeat(64)), input: { inputHash: "2".repeat(64) } });
    assert.equal(result.status, "ready");
    assert.equal(calls, 1);
    assertSpoolEmpty(spoolRoot);
  });

test("control validation deadline atomically accepts once or rejects with zero side effects after restart",
  async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-control-deadline-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const accepted = receipt(directory);

    const acceptedRoot = path.join(directory, "accepted-spool");
    const acceptedSocket = path.join(directory, "accepted.sock");
    let acceptedCalls = 0;
    const acceptedService = await createDedicatedRendererService({ spoolRoot: acceptedRoot,
      socketPath: acceptedSocket, acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true,
      async checkpoint(name) { if (name === "after_control_backing_validation") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      } },
      render: async () => { acceptedCalls += 1; return { status: "failed", stableError: "render_failed" }; } });
    t.after(() => acceptedService.close());
    const acceptedRequest = createRendererRequest({ kind: "preview",
      processorRequest: processorRequest("deadline-accepted", "2".repeat(64)),
      input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
    await atomicWriteFile(path.join(acceptedRoot, "inbox"), `${acceptedRequest.requestId}.json`,
      Buffer.from(`${JSON.stringify(acceptedRequest)}\n`));
    assert.equal((await control(acceptedSocket, acceptedRequest)).status, "accepted");
    await acceptedService.idle();
    assert.equal(acceptedCalls, 1);
    const acceptedClient = createDedicatedRendererClient({ socketPath: acceptedSocket, spoolRoot: acceptedRoot,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid() });
    t.after(() => acceptedClient.close());
    await acceptedClient.render({ kind: "preview", processorRequest: processorRequest("deadline-accepted",
      "2".repeat(64)), input: { inputHash: "2".repeat(64) } });
    assert.equal(acceptedCalls, 1);
    assertSpoolEmpty(acceptedRoot);

    const rejectedRoot = path.join(directory, "rejected-spool");
    const rejectedSocket = path.join(directory, "rejected.sock");
    let rejectedCalls = 0;
    let delayValidation = true;
    const uvPoolCounterexample = process.env.UNSEEN_RENDERER_UV_POOL_COUNTEREXAMPLE === "1";
    if (uvPoolCounterexample) assert.equal(process.env.UV_THREADPOOL_SIZE, "1");
    let rejectedService = await createDedicatedRendererService({ spoolRoot: rejectedRoot,
      socketPath: rejectedSocket, acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true,
      async checkpoint(name, _requestId, operation) {
        if (delayValidation && name === "after_control_backing_validation" && operation === "render") {
          delayValidation = false;
          if (!uvPoolCounterexample) await new Promise((resolve) => setTimeout(resolve, 5_200));
        }
      }, render: async () => { rejectedCalls += 1; return { status: "failed", stableError: "render_failed" }; } });
    const rejectedRequest = createRendererRequest({ kind: "preview",
      processorRequest: processorRequest("deadline-rejected", "3".repeat(64)),
      input: { inputHash: "3".repeat(64) }, acceptanceReceiptHash: accepted.hash });
    await atomicWriteFile(path.join(rejectedRoot, "inbox"), `${rejectedRequest.requestId}.json`,
      Buffer.from(`${JSON.stringify(rejectedRequest)}\n`));
    const poolBlock = uvPoolCounterexample ? new Promise((resolve, reject) => {
      pbkdf2("renderer-control", "synthetic-non-secret", 75_000_000, 32, "sha256",
        (error) => error ? reject(error) : resolve());
    }) : Promise.resolve();
    const rejected = await rawControl(rejectedSocket, Buffer.from(`${JSON.stringify({ operation: "render",
      requestId: rejectedRequest.requestId, requestHash: rejectedRequest.requestHash })}\n`));
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.code, "renderer_control_not_ready");
    await poolBlock;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await rejectedService.idle();
    assert.equal(rejectedCalls, 0);
    assert.deepEqual(readdirSync(path.join(rejectedRoot, "results")), ["cleanup", "control", "receipts"]);
    await atomicWriteFile(path.join(rejectedRoot, "cancels"), `${rejectedRequest.requestId}.json`,
      Buffer.from(`${JSON.stringify({ requestId: rejectedRequest.requestId,
        requestHash: rejectedRequest.requestHash })}\n`));
    await rejectedService.close();
    rejectedService = await createDedicatedRendererService({ spoolRoot: rejectedRoot, socketPath: rejectedSocket,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true,
      render: async () => { rejectedCalls += 1; return { status: "failed", stableError: "render_failed" }; } });
    t.after(() => rejectedService.close());
    const rejectedClient = createDedicatedRendererClient({ socketPath: rejectedSocket, spoolRoot: rejectedRoot,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid() });
    t.after(() => rejectedClient.close());
    await rejectedClient.ready();
    await rejectedService.idle();
    assert.equal(rejectedCalls, 0);
    assertSpoolEmpty(rejectedRoot);
  });

test("render control failure durably writes cancellation before returning to a short-lived caller", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ur-cancel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  let calls = 0;
  let cancelDelayed = false;
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    async checkpoint(name, _requestId, operation) {
      if (name === "after_control_backing_validation" && operation === "render") {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      if (!cancelDelayed && name === "after_control_backing_validation" && operation === "cancel") {
        cancelDelayed = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }, render: async () => { calls += 1; return { status: "failed", stableError: "render_failed" }; } });
  t.after(() => service.close());
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), testOnlyTiming: { wholeTimeoutMs: 500,
      cleanupGraceMs: 30, coldStartTimeoutMs: 500, reconcileIntervalMs: 500 } });
  t.after(() => client.close());
  let requestId;
  await assert.rejects(client.render({ kind: "preview", processorRequest: processorRequest("durable-cancel",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) } }).catch((error) => {
    const names = readdirSync(path.join(spoolRoot, "cancels"));
    assert.equal(names.length, 1, "cancel marker exists before caller observes failure");
    requestId = names[0].slice(0, 64);
    assert.deepEqual(JSON.parse(readFileSync(path.join(spoolRoot, "cancels", names[0]), "utf8")),
      { requestId, requestHash: requestId });
    throw error;
  }), /renderer_control_timeout/u);
  assert.match(requestId, /^[a-f0-9]{64}$/u);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await client.reconcile();
  await service.idle();
  assert.equal(calls, 0);
  assertSpoolEmpty(spoolRoot);
});

test("cancellation committed after renderer acceptance marker still prevents child spawn", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-post-marker-cancel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  let calls = 0;
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    async checkpoint(name, requestId) {
      if (name === "after_control_acceptance_commit") await atomicWriteFile(path.join(spoolRoot, "cancels"),
        `${requestId}.json`, Buffer.from(`${JSON.stringify({ requestId, requestHash: requestId })}\n`));
    }, render: async () => { calls += 1; return { status: "failed", stableError: "render_failed" }; } });
  t.after(() => service.close());
  const request = createRendererRequest({ kind: "preview", processorRequest: processorRequest("post-marker-cancel",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
  await atomicWriteFile(path.join(spoolRoot, "inbox"), `${request.requestId}.json`,
    Buffer.from(`${JSON.stringify(request)}\n`));
  const response = await rawControl(socketPath, Buffer.from(`${JSON.stringify({ operation: "render",
    requestId: request.requestId, requestHash: request.requestHash })}\n`));
  assert.deepEqual({ status: response.status, code: response.code },
    { status: "rejected", code: "renderer_control_not_ready" });
  await service.idle();
  assert.equal(calls, 0);
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid() });
  t.after(() => client.close());
  await client.reconcile();
  await service.idle();
  assertSpoolEmpty(spoolRoot);
});

test("restart schedules only a strict durable control acceptance and rejects unsafe marker state", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-control-marker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  const makeService = (render) => createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true, render });
  let calls = 0;
  const render = async () => { calls += 1; return { status: "failed", stableError: "render_failed" }; };
  let service = await makeService(render);
  await service.close();
  const request = createRendererRequest({ kind: "preview",
    processorRequest: processorRequest("durable-control-marker", "2".repeat(64)),
    input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
  const inboxPath = path.join(spoolRoot, "inbox", `${request.requestId}.json`);
  const controlDirectory = path.join(spoolRoot, "results", "control");
  const markerPath = path.join(controlDirectory, `${request.requestId}.json`);
  const markerBytes = Buffer.from(`${JSON.stringify({ schema: RENDERER_CONTROL_ACCEPTANCE_SCHEMA,
    requestId: request.requestId, requestHash: request.requestHash, acceptanceReceiptHash: accepted.hash })}\n`);
  await atomicWriteFile(path.dirname(inboxPath), path.basename(inboxPath), Buffer.from(`${JSON.stringify(request)}\n`));

  service = await makeService(render);
  await service.resume();
  await service.idle();
  assert.equal(calls, 0, "a bare inbox is never renderer-owned work");
  await service.close();

  const temporaryName = `.${request.requestId}.json.123e4567-e89b-42d3-a456-426614174000.tmp`;
  writeFileSync(path.join(controlDirectory, temporaryName), markerBytes, { mode: 0o640 });
  chmodSync(path.join(controlDirectory, temporaryName), 0o640);
  service = await makeService(render);
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(controlDirectory), []);
  await service.close();

  symlinkSync(accepted.filename, markerPath);
  await assert.rejects(makeService(render), /renderer_spool_file_invalid/u);
  rmSync(markerPath);
  writeFileSync(markerPath, markerBytes, { mode: 0o600 });
  await assert.rejects(makeService(render), /renderer_spool_file_invalid/u);
  rmSync(markerPath);
  writeFileSync(markerPath, Buffer.from(`${JSON.stringify({ schema: RENDERER_CONTROL_ACCEPTANCE_SCHEMA,
    requestId: request.requestId, requestHash: request.requestHash, acceptanceReceiptHash: "0".repeat(64) })}\n`),
  { mode: 0o640 });
  chmodSync(markerPath, 0o640);
  await assert.rejects(makeService(render), /renderer_control_acceptance_invalid/u);
  rmSync(markerPath);
  writeFileSync(markerPath, markerBytes, { mode: 0o640 });
  chmodSync(markerPath, 0o640);
  const hardlink = path.join(directory, "control-marker-hardlink");
  linkSync(markerPath, hardlink);
  await assert.rejects(makeService(render), /renderer_spool_file_invalid/u);
  rmSync(hardlink);
  rmSync(markerPath);
  writeFileSync(path.join(controlDirectory, "unexpected"), markerBytes, { mode: 0o640 });
  await assert.rejects(makeService(render), /renderer_control_acceptance_entry_invalid/u);
  rmSync(path.join(controlDirectory, "unexpected"));

  await atomicWriteFile(controlDirectory, `${request.requestId}.json`, markerBytes);
  rmSync(inboxPath);
  await assert.rejects(makeService(render), /renderer_control_acceptance_orphaned/u);
  await atomicWriteFile(path.join(spoolRoot, "results", "cleanup"), `${request.requestId}.json`,
    Buffer.from(`${JSON.stringify({ schema: "unseen-book-render-cleanup/1", requestId: request.requestId,
      requestHash: request.requestHash, reason: "terminal" })}\n`));
  service = await makeService(render);
  assert.deepEqual(readdirSync(controlDirectory), []);
  assert.deepEqual(readdirSync(path.join(spoolRoot, "results", "cleanup")), []);
  await service.close();
  await atomicWriteFile(path.dirname(inboxPath), path.basename(inboxPath), Buffer.from(`${JSON.stringify(request)}\n`));

  const cancelledRequest = createRendererRequest({ kind: "preview",
    processorRequest: processorRequest("durable-control-cancel", "3".repeat(64)),
    input: { inputHash: "3".repeat(64) }, acceptanceReceiptHash: accepted.hash });
  const cancelledBytes = Buffer.from(`${JSON.stringify({ schema: RENDERER_CONTROL_ACCEPTANCE_SCHEMA,
    requestId: cancelledRequest.requestId, requestHash: cancelledRequest.requestHash,
    acceptanceReceiptHash: accepted.hash })}\n`);
  await atomicWriteFile(path.join(spoolRoot, "inbox"), `${cancelledRequest.requestId}.json`,
    Buffer.from(`${JSON.stringify(cancelledRequest)}\n`));
  await atomicWriteFile(controlDirectory, `${cancelledRequest.requestId}.json`, cancelledBytes);
  await atomicWriteFile(path.join(spoolRoot, "cancels"), `${cancelledRequest.requestId}.json`,
    Buffer.from(`${JSON.stringify({ requestId: cancelledRequest.requestId,
      requestHash: cancelledRequest.requestHash })}\n`));
  service = await makeService(render);
  const cancellationClient = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid() });
  await cancellationClient.ready();
  await service.idle();
  cancellationClient.close();
  assert.equal(calls, 0, "durable cancellation wins over an accepted render");
  await service.close();

  writeFileSync(path.join(controlDirectory, temporaryName), markerBytes, { mode: 0o640 });
  chmodSync(path.join(controlDirectory, temporaryName), 0o640);
  linkSync(path.join(controlDirectory, temporaryName), markerPath);
  service = await makeService(render);
  t.after(() => service.close());
  await service.idle();
  assert.equal(calls, 1, "a marker committed before a crash resumes exactly once");
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid() });
  t.after(() => client.close());
  assert.equal((await client.render({ kind: "preview",
    processorRequest: processorRequest("durable-control-marker", "2".repeat(64)),
    input: { inputHash: "2".repeat(64) } })).status, "failed");
  assert.equal(calls, 1);
  assertSpoolEmpty(spoolRoot);
});

test("cleanup reader retries only an exact atomic link promotion and rejects persistent or forged hardlinks",
  async () => {
    async function runCase(label, kind) {
      const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-cleanup-link-"));
      const accepted = receipt(directory);
      const spoolRoot = path.join(directory, "spool");
      const socketPath = path.join(directory, "render.sock");
      const bootstrap = await createDedicatedRendererService({ spoolRoot, socketPath,
        acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
        expectedReceiptUid: process.getuid(), initializeDirectories: true,
        render: async () => ({ status: "failed", stableError: "render_failed" }) });
      await bootstrap.close();
      const requestId = sha256(`cleanup-promotion-${label}`);
      await atomicWriteFile(path.join(spoolRoot, "inbox"), `${requestId}.json`, Buffer.from(`${JSON.stringify({
        requestId, requestHash: requestId })}\n`));
      let finalized = false;
      const cleanupDirectory = path.join(spoolRoot, "results", "cleanup");
      const markerPath = path.join(cleanupDirectory, `${requestId}.json`);
      const temporaryPath = path.join(cleanupDirectory,
        `.${requestId}.json.123e4567-e89b-42d3-a456-426614174000.tmp`);
      const markerBytes = Buffer.from(`${JSON.stringify({ schema: "unseen-book-render-cleanup/1", requestId,
        requestHash: requestId, reason: "terminal" })}\n`);
      if (kind === "wrong-inode") {
        writeFileSync(markerPath, markerBytes, { mode: 0o640 });
        chmodSync(markerPath, 0o640);
        linkSync(markerPath, path.join(directory, "outside-hardlink"));
        writeFileSync(temporaryPath, markerBytes, { mode: 0o640 });
        chmodSync(temporaryPath, 0o640);
      } else {
        const name = kind === "wrong-name" ? path.join(cleanupDirectory,
          `.${requestId}.json.not-a-uuid.tmp`) : temporaryPath;
        writeFileSync(name, markerBytes, { mode: 0o640 });
        chmodSync(name, 0o640);
        linkSync(name, markerPath);
        if (kind === "extra-link") linkSync(markerPath, path.join(directory, "outside-hardlink"));
        if (kind === "wrong-mode") chmodSync(markerPath, 0o600);
      }
      let release;
      const server = await listenFake(socketPath, (socket) => {
        let controlBytes = Buffer.alloc(0);
        socket.on("data", (chunk) => { controlBytes = Buffer.concat([controlBytes, chunk]); });
        socket.on("end", () => {
          const message = JSON.parse(controlBytes.subarray(0, -1).toString("utf8"));
          if (message.operation === "finalize") {
            finalized = true;
            rmSync(markerPath, { force: true });
          }
          if (message.operation === "cancel" && kind === "transient") {
            release = setTimeout(() => rmSync(temporaryPath), 40);
          }
          socket.end(`${JSON.stringify({ schema: RENDERER_CONTROL_RESPONSE_SCHEMA, status: "accepted",
            operation: message.operation, requestId: message.requestId, code: null })}\n`);
        });
      });
      const client = createDedicatedRendererClient({ socketPath, spoolRoot,
        acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
        expectedReceiptUid: process.getuid(), testOnlyTiming: { wholeTimeoutMs: 10_000,
          cleanupGraceMs: kind === "transient" ? 250 : 90, coldStartTimeoutMs: 10_000,
          reconcileIntervalMs: 10_000 } });
      await client.ready();
      try {
        if (kind === "transient") {
          const startedAt = Date.now();
          await client.cancel(requestId, requestId);
          assert.ok(Date.now() - startedAt >= 35, "cleanup waited for temp-link promotion to commit");
          assert.equal(finalized, true);
        } else if (kind === "persistent") {
          await assert.rejects(client.cancel(requestId, requestId), /renderer_ack_cleanup_timeout/u);
        } else {
          await assert.rejects(client.cancel(requestId, requestId), /renderer_cleanup_atomic_promotion_invalid/u);
        }
      } finally {
        if (release) clearTimeout(release);
        client.close();
        await closeServer(server);
        rmSync(directory, { recursive: true, force: true });
      }
    }
    await runCase("transient", "transient");
    await runCase("persistent", "persistent");
    await runCase("extra-link", "extra-link");
    await runCase("wrong-name", "wrong-name");
    await runCase("wrong-inode", "wrong-inode");
    await runCase("wrong-mode", "wrong-mode");
  });

test("control endpoint explicitly rejects malformed, oversized and unbacked requests then remains healthy",
  async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-control-reject-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const accepted = receipt(directory);
    const spoolRoot = path.join(directory, "spool");
    const socketPath = path.join(directory, "render.sock");
    const service = await createDedicatedRendererService({ spoolRoot, socketPath,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true,
      render: async () => ({ status: "failed", stableError: "render_failed" }) });
    t.after(() => service.close());
    const requestId = "a".repeat(64);
    const cases = [
      [Buffer.alloc(0), "renderer_control_invalid"],
      [Buffer.from("{\n"), "renderer_control_invalid"],
      [Buffer.from(`${JSON.stringify({ operation: "render", requestId, requestHash: requestId, extra: true })}\n`),
        "renderer_control_invalid"],
      [Buffer.from(`${JSON.stringify({ operation: "render", requestId, requestHash: requestId })}\n\n`),
        "renderer_control_invalid"],
      [Buffer.from(`${JSON.stringify({ operation: "unknown", requestId, requestHash: requestId })}\n`),
        "renderer_control_invalid"],
      [Buffer.from(`${JSON.stringify({ operation: "render", requestId, requestHash: requestId })}\n`),
        "renderer_control_not_ready"],
      [Buffer.alloc(RENDERER_CONTROL_LIMIT + 1, 0x61), "renderer_control_too_large"]
    ];
    for (const [payload, code] of cases) {
      const response = await rawControl(socketPath, payload);
      validateRendererControlResponse(response, { operation: "render", requestId });
      assert.equal(response.status, "rejected");
      assert.equal(response.code, code);
    }
    const slowReader = await rawControl(socketPath, Buffer.from(`${JSON.stringify({ operation: "render", requestId,
      requestHash: requestId })}\n`), { pauseResponseMs: 25 });
    assert.equal(slowReader.code, "renderer_control_not_ready");
    assert.equal(service.status().lastFailure, null);
    const request = createRendererRequest({ kind: "preview", processorRequest: processorRequest("after-reject",
      "2".repeat(64)), input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
    await atomicWriteFile(path.join(spoolRoot, "inbox"), `${request.requestId}.json`,
      Buffer.from(`${JSON.stringify(request)}\n`));
    assert.equal((await control(socketPath, request)).status, "accepted");
    await service.idle();
    const client = createDedicatedRendererClient({ socketPath, spoolRoot,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid() });
    t.after(() => client.close());
    assert.equal((await client.render({ kind: "preview", processorRequest: processorRequest("after-reject",
      "2".repeat(64)), input: { inputHash: "2".repeat(64) } })).status, "failed");
    assertSpoolEmpty(spoolRoot);
  });

test("control client distinguishes graceful close, reset and stall on filesystem AF_UNIX", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-control-transport-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, "render.sock");
  const message = { operation: "render", requestId: "a".repeat(64), requestHash: "a".repeat(64) };

  let server = await listenFake(socketPath, (socket) => {
    socket.on("data", () => {});
    socket.on("end", () => socket.end());
  });
  await assert.rejects(notifyRendererControl(socketPath, message, 100), /renderer_control_transport_closed/u);
  await closeServer(server);

  server = await listenFake(socketPath, (socket) => {
    socket.on("data", () => {});
    socket.on("end", () => socket.end(`${JSON.stringify({ schema: RENDERER_CONTROL_RESPONSE_SCHEMA,
      status: "accepted", operation: "render", requestId: "b".repeat(64), code: null })}\n`));
  });
  await assert.rejects(notifyRendererControl(socketPath, message, 100), /renderer_control_response_invalid/u);
  await closeServer(server);

  server = await listenFake(socketPath, (socket) => {
    socket.on("data", () => {});
    socket.on("end", () => socket.end(Buffer.alloc(RENDERER_CONTROL_LIMIT + 1, 0x61)));
  });
  await assert.rejects(notifyRendererControl(socketPath, message, 100), /renderer_control_response_too_large/u);
  await closeServer(server);

  server = await listenFake(socketPath, (socket) => {
    socket.on("error", () => {});
    socket.destroy(new Error("synthetic-reset"));
  });
  await assert.rejects(notifyRendererControl(socketPath, message, 100), /renderer_control_transport_error/u);
  await closeServer(server);

  const open = new Set();
  server = await listenFake(socketPath, (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("data", () => {});
    socket.on("end", () => {});
  });
  await assert.rejects(notifyRendererControl(socketPath, message, 20), /renderer_control_timeout/u);
  for (const socket of open) socket.destroy();
  await closeServer(server);
});

test("notify failure is reconciled after renderer restart without a caller or sensitive residual", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-notify-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  let service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => ({ status: "ready", html: "<main>notify</main>", htmlHash: sha256("<main>notify</main>"),
      pageCount: 1, htmlArtifactId: "preview-notify", equality: { pageCount: 1 } }) });
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), testOnlyTiming: { wholeTimeoutMs: 100, cleanupGraceMs: 500,
      coldStartTimeoutMs: 500, reconcileIntervalMs: 500 } });
  t.after(() => client.close());
  await client.ready();
  await service.close();
  await assert.rejects(client.render({ kind: "preview", processorRequest: processorRequest("notify-failure",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) } }));
  service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => ({ status: "ready", html: "<main>notify</main>", htmlHash: sha256("<main>notify</main>"),
      pageCount: 1, htmlArtifactId: "preview-notify", equality: { pageCount: 1 } }) });
  t.after(() => service.close());
  await client.reconcile();
  await service.idle();
  assertSpoolEmpty(spoolRoot);
});

test("whole timeout leaves durable cancel and background reconciliation reaches zero residual", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-timeout-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true, async render() {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { status: "ready", html: "<main>late</main>", htmlHash: sha256("<main>late</main>"),
        pageCount: 1, htmlArtifactId: "preview-late", equality: { pageCount: 1 } };
    } });
  t.after(() => service.close());
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), testOnlyTiming: { wholeTimeoutMs: 30, cleanupGraceMs: 1_000,
      coldStartTimeoutMs: 1_000, reconcileIntervalMs: 500 } });
  t.after(() => client.close());
  await assert.rejects(client.render({ kind: "preview", processorRequest: processorRequest("timeout",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) } }), /renderer_whole_timeout/u);
  await client.reconcile();
  await service.idle();
  assertSpoolEmpty(spoolRoot);
});

test("periodic reconciliation never cancels an active render before its whole deadline", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-active-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  let calls = 0;
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true, async render() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { status: "ready", html: "<main>active</main>", htmlHash: sha256("<main>active</main>"),
        pageCount: 1, htmlArtifactId: "preview-active", equality: { pageCount: 1 } };
    } });
  t.after(() => service.close());
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), testOnlyTiming: { wholeTimeoutMs: 300, cleanupGraceMs: 500,
      coldStartTimeoutMs: 500, reconcileIntervalMs: 10 } });
  t.after(() => client.close());
  const result = await client.render({ kind: "preview", processorRequest: processorRequest("active",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) } });
  assert.equal(result.status, "ready");
  assert.equal(calls, 1);
  assertSpoolEmpty(spoolRoot);
});

test("expired inbox is terminally collected after restart without rendering", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-expired-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  let calls = 0;
  let service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => { calls += 1; return { status: "failed", stableError: "render_failed" }; } });
  await service.close();
  const request = createRendererRequest({ kind: "preview", processorRequest: processorRequest("expired",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
  const requestPath = await atomicWriteFile(path.join(spoolRoot, "inbox"), `${request.requestId}.json`,
    Buffer.from(`${JSON.stringify(request)}\n`));
  const stale = new Date(Date.now() - 151_000);
  utimesSync(requestPath, stale, stale);
  service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => { calls += 1; return { status: "failed", stableError: "render_failed" }; } });
  t.after(() => service.close());
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid() });
  t.after(() => client.close());
  await client.ready();
  assert.equal(calls, 0);
  assertSpoolEmpty(spoolRoot);
});

test("API cleanup crash after inbox deletion replays from ACK and terminal marker", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-api-cleanup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accepted = receipt(directory);
  const spoolRoot = path.join(directory, "spool");
  const socketPath = path.join(directory, "render.sock");
  const service = await createDedicatedRendererService({ spoolRoot, socketPath,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid(), initializeDirectories: true,
    render: async () => ({ status: "ready", html: "<main>api-cleanup</main>",
      htmlHash: sha256("<main>api-cleanup</main>"), pageCount: 1, htmlArtifactId: "preview-api-cleanup",
      equality: { pageCount: 1 } }) });
  t.after(() => service.close());
  const request = createRendererRequest({ kind: "preview", processorRequest: processorRequest("api-cleanup",
    "2".repeat(64)), input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
  await atomicWriteFile(path.join(spoolRoot, "inbox"), `${request.requestId}.json`,
    Buffer.from(`${JSON.stringify(request)}\n`));
  await control(socketPath, request);
  await service.idle();
  const resultBytes = readFileSync(path.join(spoolRoot, "results", `${request.requestId}.json`));
  await atomicWriteFile(path.join(spoolRoot, "acks"), `${request.requestId}.json`, Buffer.from(`${JSON.stringify({
    requestId: request.requestId, requestHash: request.requestHash, resultHash: sha256(resultBytes) })}\n`));
  await control(socketPath, request, "ack");
  await service.idle();
  rmSync(path.join(spoolRoot, "inbox", `${request.requestId}.json`));
  const client = createDedicatedRendererClient({ socketPath, spoolRoot,
    acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
    expectedReceiptUid: process.getuid() });
  t.after(() => client.close());
  await client.ready();
  assertSpoolEmpty(spoolRoot);
});

for (const crashPoint of ["after_claim", "after_html", "after_pdf", "after_manifest"]) {
  test(`restart/replay is idempotent after ${crashPoint}`, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-crash-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const accepted = receipt(directory);
    const spoolRoot = path.join(directory, "spool");
    const socketPath = path.join(directory, "render.sock");
    let calls = 0;
    let crash = true;
    const render = async () => {
      calls += 1;
      return { status: "ready", html: "<main>deterministic</main>", htmlHash: sha256("<main>deterministic</main>"),
        pdfBytes: Buffer.from("%PDF-deterministic"), pdfHash: sha256("%PDF-deterministic"),
        pageCount: 1, equality: { pageCount: 1 }, receipt: { schemaVersion: "synthetic-replay" } };
    };
    let service = await createDedicatedRendererService({ spoolRoot, socketPath,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true,
      render, checkpoint(name) { if (crash && name === crashPoint) { crash = false; throw new Error("crash"); } } });
    const request = createRendererRequest({ kind: "frozen",
      processorRequest: processorRequest(`job-${crashPoint}`, "2".repeat(64)),
      input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
    await atomicWriteFile(path.join(spoolRoot, "inbox"), `${request.requestId}.json`,
      Buffer.from(`${JSON.stringify(request)}\n`));
    await control(socketPath, request);
    await service.idle();
    assert.equal(service.status().lastFailure, "crash");
    await service.close();
    service = await createDedicatedRendererService({ spoolRoot, socketPath,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true,
      render, checkpoint() {} });
    t.after(() => service.close());
    await service.idle();
    const result = JSON.parse(readFileSync(path.join(spoolRoot, "results", `${request.requestId}.json`), "utf8"));
    assert.equal(result.status, "ready");
    assert.equal(result.requestHash, request.requestHash);
    assert.equal(calls, crashPoint === "after_claim" || crashPoint === "after_manifest" ? 1 : 2);
  });
}

for (const crashPoint of ["after_html", "after_pdf", "before_manifest"]) {
  test(`cancel after pre-manifest crash securely deletes partial artifacts at ${crashPoint}`, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-partial-cancel-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const accepted = receipt(directory);
    const spoolRoot = path.join(directory, "spool");
    const socketPath = path.join(directory, "render.sock");
    let calls = 0;
    let service = await createDedicatedRendererService({ spoolRoot, socketPath,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true, async render() {
        calls += 1;
        return { status: "ready", html: "<main>partial</main>", htmlHash: sha256("<main>partial</main>"),
          pdfBytes: Buffer.from("%PDF-partial"), pdfHash: sha256("%PDF-partial"), pageCount: 1,
          equality: { pageCount: 1 }, receipt: { schemaVersion: "synthetic-partial" } };
      }, checkpoint(name) { if (name === crashPoint) throw new Error("partial-crash"); } });
    const request = createRendererRequest({ kind: "frozen",
      processorRequest: processorRequest(`partial-${crashPoint}`, "2".repeat(64)),
      input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
    await atomicWriteFile(path.join(spoolRoot, "inbox"), `${request.requestId}.json`,
      Buffer.from(`${JSON.stringify(request)}\n`));
    await control(socketPath, request);
    await service.idle();
    assert.equal(service.status().lastFailure, "partial-crash");
    await service.close();
    await atomicWriteFile(path.join(spoolRoot, "cancels"), `${request.requestId}.json`,
      Buffer.from(`${JSON.stringify({ requestId: request.requestId, requestHash: request.requestHash })}\n`));
    service = await createDedicatedRendererService({ spoolRoot, socketPath,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true,
      render: async () => { calls += 1; throw new Error("must-not-render"); } });
    t.after(() => service.close());
    const client = createDedicatedRendererClient({ socketPath, spoolRoot,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid() });
    t.after(() => client.close());
    await client.ready();
    assert.equal(calls, 1);
    assertSpoolEmpty(spoolRoot);
  });
}

for (const crashPoint of ["after_ack_html_delete", "after_ack_pdf_delete", "after_ack_receipt_delete",
  "after_ack_manifest_delete", "after_ack_control_acceptance_delete", "after_ack_cleanup_marker"]) {
  test(`ACK cleanup is crash-replayable after ${crashPoint}`, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-renderer-ack-crash-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const accepted = receipt(directory);
    const spoolRoot = path.join(directory, "spool");
    const socketPath = path.join(directory, "render.sock");
    let crash = true;
    let calls = 0;
    const render = async () => {
      calls += 1;
      return { status: "ready", html: "<main>ack-replay</main>", htmlHash: sha256("<main>ack-replay</main>"),
        pdfBytes: Buffer.from("%PDF-ack-replay"), pdfHash: sha256("%PDF-ack-replay"), pageCount: 1,
        equality: { pageCount: 1 }, receipt: { schemaVersion: "synthetic-ack-replay" } };
    };
    let service = await createDedicatedRendererService({ spoolRoot, socketPath,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true, render,
      checkpoint(name) { if (crash && name === crashPoint) { crash = false; throw new Error("ack-crash"); } } });
    const request = createRendererRequest({ kind: "frozen",
      processorRequest: processorRequest(`job-${crashPoint}`, "2".repeat(64)),
      input: { inputHash: "2".repeat(64) }, acceptanceReceiptHash: accepted.hash });
    await atomicWriteFile(path.join(spoolRoot, "inbox"), `${request.requestId}.json`,
      Buffer.from(`${JSON.stringify(request)}\n`));
    await control(socketPath, request);
    await service.idle();
    const resultBytes = readFileSync(path.join(spoolRoot, "results", `${request.requestId}.json`));
    await atomicWriteFile(path.join(spoolRoot, "acks"), `${request.requestId}.json`, Buffer.from(`${JSON.stringify({
      requestId: request.requestId, requestHash: request.requestHash, resultHash: sha256(resultBytes) })}\n`));
    await control(socketPath, request, "ack");
    await service.idle();
    assert.equal(service.status().lastFailure, "ack-crash");
    await service.close();

    service = await createDedicatedRendererService({ spoolRoot, socketPath,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid(), initializeDirectories: true, render, checkpoint() {} });
    t.after(() => service.close());
    const client = createDedicatedRendererClient({ socketPath, spoolRoot,
      acceptanceReceiptPath: accepted.filename, acceptanceReceiptHash: accepted.hash,
      expectedReceiptUid: process.getuid() });
    t.after(() => client.close());
    await client.ready();
    await service.idle();
    assert.equal(calls, 1);
    assertSpoolEmpty(spoolRoot);
  });
}
