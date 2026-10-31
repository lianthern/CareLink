import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

export const RENDERER_PROTOCOL = "unseen-book-renderer-dedicated-service/v1";
export const RENDERER_REQUEST_SCHEMA = "unseen-book-renderer-request/1";
export const RENDERER_RESULT_SCHEMA = "unseen-book-renderer-result/1";
export const RENDERER_ACCEPTANCE_SCHEMA = "unseen-book-renderer-acceptance/1";
export const RENDERER_CONTROL_RESPONSE_SCHEMA = "unseen-book-renderer-control-response/1";
export const RENDERER_CONTROL_ACCEPTANCE_SCHEMA = "unseen-book-renderer-control-acceptance/1";
export const RENDERER_REQUEST_LIMIT = 16 * 1024 * 1024;
export const RENDERER_CONTROL_LIMIT = 4 * 1024;
export const RENDERER_WHOLE_TIMEOUT_MS = 120_000;
export const RENDERER_COLD_START_TIMEOUT_MS = 120_000;
export const BOOK_RENDER_LEASE_MS = 150_000;
export const RENDERER_CANCEL_GRACE_MS = 5_000;
export const RENDERER_ORPHAN_SCAN_MS = 5_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA3384 = /^[a-f0-9]{96}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_NAME = /^[a-f0-9]{64}\.(?:json|html|pdf)$/u;
const CONTROL_OPERATIONS = new Set(["ready", "render", "cancel", "ack", "finalize"]);
const CONTROL_REJECTION_CODES = new Set(["renderer_control_invalid", "renderer_control_too_large",
  "renderer_control_not_ready"]);
const FAILURE_DIAGNOSTIC_CODES = new Map([
  ["sandbox_setup", new Set(["renderer_sandbox_setup_failed"])],
  ["request_stage", new Set(["renderer_request_stage_failed"])],
  ["child_spawn", new Set(["renderer_child_spawn_failed"])],
  ["child_exit", new Set(["renderer_child_timeout", "renderer_child_stderr_limit",
    "renderer_child_nonzero_exit", "renderer_child_signalled"])],
  ["output_manifest", new Set(["renderer_output_manifest_invalid"])],
  ["html_validation", new Set(["renderer_html_validation_failed"])],
  ["pdf_validation", new Set(["renderer_pdf_validation_failed"])],
  ["receipt_validation", new Set(["renderer_receipt_validation_failed"])],
  ["unclassified", new Set(["renderer_unclassified"])]
]);

function fail(code) { throw new Error(code); }

export function exact(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(code);
  return value;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function rendererSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateRendererControlMessage(value) {
  exact(value, ["operation", "requestId", "requestHash"], "renderer_control_invalid");
  if (!CONTROL_OPERATIONS.has(value.operation) || !SHA256.test(value.requestId) ||
    value.requestHash !== value.requestId) fail("renderer_control_invalid");
  return Object.freeze(value);
}

export function createRendererControlResponse({ status, operation = null, requestId = null, code = null }) {
  const value = { schema: RENDERER_CONTROL_RESPONSE_SCHEMA, status, operation, requestId, code };
  if (status === "accepted") {
    if (!CONTROL_OPERATIONS.has(operation) || !SHA256.test(requestId) || code !== null) {
      fail("renderer_control_response_invalid");
    }
  } else if (status === "rejected") {
    if (operation !== null || requestId !== null || !CONTROL_REJECTION_CODES.has(code)) {
      fail("renderer_control_response_invalid");
    }
  } else fail("renderer_control_response_invalid");
  return Object.freeze(value);
}

export function validateRendererControlResponse(value, expected) {
  exact(value, ["schema", "status", "operation", "requestId", "code"], "renderer_control_response_invalid");
  if (value.schema !== RENDERER_CONTROL_RESPONSE_SCHEMA) fail("renderer_control_response_invalid");
  createRendererControlResponse(value);
  if (value.status === "accepted" && (value.operation !== expected.operation || value.requestId !== expected.requestId)) {
    fail("renderer_control_response_invalid");
  }
  return Object.freeze(value);
}

export function validateRendererFailureDiagnostic(value) {
  exact(value, ["schema", "phase", "code", "exitCode", "signalled", "stderrBytes"],
    "renderer_failure_diagnostic_invalid");
  const codes = FAILURE_DIAGNOSTIC_CODES.get(value.phase);
  if (value.schema !== "unseen-book-renderer-failure-diagnostic/1" || !codes?.has(value.code) ||
    value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255) ||
    typeof value.signalled !== "boolean" || !Number.isSafeInteger(value.stderrBytes) ||
    value.stderrBytes < 0 || value.stderrBytes > 64 * 1024) fail("renderer_failure_diagnostic_invalid");
  return Object.freeze(value);
}

function strictString(value, code, maximum = 240) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function strictAbsolute(value, code) {
  strictString(value, code, 1_024);
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value === path.parse(value).root) fail(code);
  return value;
}

function strictPin(value, code) {
  if (!SHA256.test(value)) fail(code);
  return value;
}

function validatePinnedExecutable(value, label) {
  exact(value, ["path", "sha256", "version"], `renderer_acceptance_${label}_invalid`);
  strictAbsolute(value.path, `renderer_acceptance_${label}_path_invalid`);
  strictPin(value.sha256, `renderer_acceptance_${label}_hash_invalid`);
  strictString(value.version, `renderer_acceptance_${label}_version_invalid`);
}

function validateBrowserArchiveLinkTopology(value) {
  exact(value, ["schema", "state", "linkCount", "policySha256"],
    "renderer_acceptance_browser_archive_link_topology_invalid");
  if (value.schema !== "unseen-snapd-cache-link-topology/1" ||
    value.policySha256 !== "49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5" ||
    value.state === "ARCHIVE_ONLY" && value.linkCount !== 1 ||
    value.state === "ARCHIVE_AND_SNAPD_SHA3_CACHE" && value.linkCount !== 2 ||
    !["ARCHIVE_ONLY", "ARCHIVE_AND_SNAPD_SHA3_CACHE"].includes(value.state)) {
    fail("renderer_acceptance_browser_archive_link_topology_invalid");
  }
}

function validateBrowserDistribution(value) {
  exact(value, ["schema", "name", "snapId", "revision", "version", "arch", "numericRoot", "archivePath",
    "archiveSha256", "archiveSha3384", "archiveBytes", "archiveLinkTopology", "assertionSha256",
    "snapDeclarationSha256",
    "signingAccountKeySha256", "assertionSignatureVerified", "metaSha256", "officialLauncherSha256",
    "officialLauncherBytes", "launchpadCommit", "launchpadTree", "launchpadManifestSha256",
    "treeManifestSha256", "treeEntryCount", "treeRegularFileCount", "treeSymlinkCount", "treeRegularBytes",
    "resourceManifestSha256", "resourceCount", "canonicalDanglingSymlinkCount",
    "canonicalDanglingSymlinkPolicySha256", "runtimeReachability", "licenseDeclaration", "securityReview",
    "releaseDecision"],
  "renderer_acceptance_browser_distribution_invalid");
  validateBrowserArchiveLinkTopology(value.archiveLinkTopology);
  if (value.schema !== "unseen-chromium-snap-distribution/1" || value.name !== "chromium" ||
    value.snapId !== "XKEcBqPM06H1Z7zGOdG5fbICuf8NWK5R" || value.revision !== 3507 ||
    value.version !== "151.0.7922.108" || value.arch !== "amd64" ||
    value.numericRoot !== "/snap/chromium/3507" ||
    value.archivePath !== "/var/lib/snapd/snaps/chromium_3507.snap" ||
    !SHA256.test(value.archiveSha256) || !SHA3384.test(value.archiveSha3384) ||
    !Number.isSafeInteger(value.archiveBytes) || value.archiveBytes !== 202_833_920 ||
    !["assertionSha256", "snapDeclarationSha256", "signingAccountKeySha256", "metaSha256",
      "officialLauncherSha256", "launchpadManifestSha256", "treeManifestSha256",
      "resourceManifestSha256", "canonicalDanglingSymlinkPolicySha256"].every((field) =>
      SHA256.test(value[field])) ||
    value.assertionSignatureVerified !== false || value.officialLauncherBytes !== 6_365 ||
    !COMMIT.test(value.launchpadCommit) || !COMMIT.test(value.launchpadTree) ||
    value.archiveSha256 !== "cf10676bdf7a3b4d14201fd6004ec5c8c137ee7365779133cba7c1d39263fae0" ||
    value.archiveSha3384 !== "77155504d7c5fdfa516545da086bd3f31fa6f6283901e93885cbb39366ae55bea834c4042bebfc870a0330904df04c07" ||
    value.assertionSha256 !== "1835e6aed1d9a03ea7b42f44d01feac6fd81e2e7d72a4e27d0c97f742bdad94c" ||
    value.snapDeclarationSha256 !== "f405bbc39c1ba0036c25f9b0a3f8df50fb1f43a94a489bc76fe1b8d956bce080" ||
    value.signingAccountKeySha256 !== "a1182464402e4e7c8ee10650eb2ec247ffd2496216c9a4f3d40eac39a928b340" ||
    value.metaSha256 !== "eca508d9238f611e2ca4757da991e9c7624a1f3eff499936e73a38d0652b0aa0" ||
    value.officialLauncherSha256 !== "fd5dec09e3f53f1bf0c5cd52eafc39de8bff954bd2b4aeae1850faa0cc97e166" ||
    value.launchpadCommit !== "c7d4a5ffee0e71a3888a69f56892957cdfb8c919" ||
    value.launchpadTree !== "5ced77dd54c618cc398943f587847c62473a0457" ||
    value.launchpadManifestSha256 !== "4e344dc0081b3bcccdb47640c4c4c8300a4f3fa0e6f1d7609e08257bf797e92a" ||
    value.treeManifestSha256 !== "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913" ||
    value.resourceManifestSha256 !== "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5" ||
    value.treeEntryCount !== 683 || value.treeRegularFileCount !== 591 || value.treeSymlinkCount !== 27 ||
    value.treeRegularBytes !== 446_326_676 || value.resourceCount !== 224 ||
    value.canonicalDanglingSymlinkCount !== 2 ||
    value.canonicalDanglingSymlinkPolicySha256 !==
      "3c3f99c6d62feffb90a873bc245930045a1e42bdc0c3b1e5c2a763208586b128" ||
    value.runtimeReachability !== "ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE" ||
    value.licenseDeclaration !== "UNDECLARED_IN_CANONICAL_ASSERTION_AND_LOCAL_META" ||
    value.securityReview !== "REQUIRED_NOT_INCLUDED" ||
    value.releaseDecision !== "NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED") {
    fail("renderer_acceptance_browser_distribution_invalid");
  }
}

function validateBrowserAdapter(value) {
  exact(value, ["schema", "implementationSha256", "policySha256", "environmentProjectionSha256",
    "argumentProjectionSha256", "writableDirectoryProjectionSha256", "forbiddenDependencyProjectionSha256",
    "environmentEntryCount", "environmentInheritance", "omittedEnvironmentKeys", "outerSandboxRequired"],
  "renderer_acceptance_browser_adapter_invalid");
  if (value.schema !== "unseen-chromium-snap-headless-adapter/1" ||
    !["implementationSha256", "policySha256", "environmentProjectionSha256", "argumentProjectionSha256",
      "writableDirectoryProjectionSha256", "forbiddenDependencyProjectionSha256"]
      .every((field) => SHA256.test(value[field])) || value.environmentEntryCount !== 14 ||
    value.environmentInheritance !== "EMPTY_ALLOWLIST_ONLY" ||
    JSON.stringify(value.omittedEnvironmentKeys) !== JSON.stringify(["SNAP_COMMON", "SNAP_DATA"]) ||
    value.outerSandboxRequired !== true) fail("renderer_acceptance_browser_adapter_invalid");
}

function allowedReadOnlyMount(value) {
  return new Set(["/usr", "/lib", "/lib64", "/etc/fonts", "/usr/share/fonts",
    "/usr/local/share/fonts", "/opt/unseen/runtime/node-v22.23.2-linux-x64"]).has(value) ||
    /^\/snap\/chromium\/[1-9][0-9]*$/u.test(value);
}

function validateProcessorRequest(value, kind) {
  exact(value, ["renderJobId", "jobVersion", "draftVersionId", "manifestHash", "grantSetHash",
    "sourceSnapshotHash", "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "accessControlVersion",
    "inputHash", "attempt"], "renderer_processor_request_invalid");
  strictString(value.renderJobId, "renderer_processor_request_invalid");
  strictString(value.draftVersionId, "renderer_processor_request_invalid");
  for (const field of ["manifestHash", "grantSetHash", "sourceSnapshotHash",
    "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "inputHash"]) {
    strictPin(value[field], "renderer_processor_request_invalid");
  }
  if (!Number.isSafeInteger(value.jobVersion) || value.jobVersion < 1 ||
    !Number.isSafeInteger(value.attempt) || value.attempt < 1 ||
    !Number.isSafeInteger(value.accessControlVersion) ||
    value.accessControlVersion < (kind === "frozen" ? 1 : 0)) fail("renderer_processor_request_invalid");
}

export function validateRendererAcceptanceReceipt(value) {
  exact(value, ["schema", "profile", "candidateCommit", "candidateTree", "rendererBuildHash", "node",
    "nodeDistribution", "browser", "browserDistribution", "browserAdapter", "bwrap", "appArmor", "seccomp", "fonts", "pdfTools", "systemd", "cups",
    "principals", "readOnlyMounts",
    "targetVerification"],
  "renderer_acceptance_invalid");
  if (value.schema !== RENDERER_ACCEPTANCE_SCHEMA || value.profile !== RENDERER_PROTOCOL ||
    !COMMIT.test(value.candidateCommit) || !COMMIT.test(value.candidateTree) ||
    !SHA256.test(value.rendererBuildHash)) fail("renderer_acceptance_invalid");
  validatePinnedExecutable(value.browser, "browser");
  validateBrowserDistribution(value.browserDistribution);
  validateBrowserAdapter(value.browserAdapter);
  validatePinnedExecutable(value.bwrap, "bwrap");
  validatePinnedExecutable(value.node, "node");
  if (value.node.path !== "/opt/unseen/runtime/node-v22.23.2-linux-x64/bin/node" ||
    value.node.version !== "v22.23.2") fail("renderer_acceptance_node_invalid");
  exact(value.nodeDistribution, ["schema", "archiveUrl", "archivePath", "archiveSha256", "archiveBytes",
    "signedShasumsUrl", "signedShasumsPath", "signedShasumsSha256", "releaseKeyringUrl", "releaseKeyringPath",
    "releaseKeyringSha256", "releaseKeyringBytes", "releaseKeysCommit", "verificationMethod", "checksumPinPath",
    "checksumPinSha256"], "renderer_acceptance_node_distribution_invalid");
  if (value.nodeDistribution.schema !== "unseen-node-runtime-distribution/1" ||
    !["archiveUrl", "signedShasumsUrl", "releaseKeyringUrl"].every((field) =>
      typeof value.nodeDistribution[field] === "string" &&
      value.nodeDistribution[field].startsWith("https://")) ||
    !["archivePath", "signedShasumsPath", "releaseKeyringPath", "checksumPinPath"].every((field) => {
      try { strictAbsolute(value.nodeDistribution[field], "renderer_acceptance_node_distribution_invalid"); }
      catch { return false; }
      return true;
    }) ||
    !["archiveSha256", "signedShasumsSha256", "releaseKeyringSha256", "checksumPinSha256"].every((field) =>
      SHA256.test(value.nodeDistribution[field])) ||
    !Number.isSafeInteger(value.nodeDistribution.archiveBytes) || value.nodeDistribution.archiveBytes < 1 ||
    !Number.isSafeInteger(value.nodeDistribution.releaseKeyringBytes) || value.nodeDistribution.releaseKeyringBytes < 1 ||
    !COMMIT.test(value.nodeDistribution.releaseKeysCommit) ||
    value.nodeDistribution.verificationMethod !== "gpgv-pinned-keyring+signed-shasums+sha256sum/v1") {
    fail("renderer_acceptance_node_distribution_invalid");
  }
  if (value.browser.path !== "/snap/chromium/3507/usr/lib/chromium-browser/chrome" ||
    value.browser.version !== "Chromium 151.0.7922.108" ||
    value.browserDistribution.numericRoot !== "/snap/chromium/3507" ||
    !value.browser.path.startsWith(`${value.browserDistribution.numericRoot}/`)) {
    fail("renderer_acceptance_snap_unpinned");
  }
  if (value.bwrap.path !== "/usr/bin/bwrap") fail("renderer_acceptance_bwrap_path_invalid");
  exact(value.appArmor, ["profile", "sha256", "loaded"], "renderer_acceptance_apparmor_invalid");
  if (value.appArmor.profile !== "unseen-book-renderer" || !SHA256.test(value.appArmor.sha256) ||
    value.appArmor.loaded !== true) {
    fail("renderer_acceptance_apparmor_invalid");
  }
  exact(value.seccomp, ["schema", "sha256", "deniedSocketFamilies", "deniedSyscalls"],
    "renderer_acceptance_seccomp_invalid");
  if (value.seccomp.schema !== "unseen-book-renderer-child-seccomp/1" || !SHA256.test(value.seccomp.sha256) ||
    JSON.stringify(value.seccomp.deniedSocketFamilies) !== JSON.stringify(["AF_INET", "AF_INET6", "AF_NETLINK",
      "AF_PACKET"]) || JSON.stringify(value.seccomp.deniedSyscalls) !== JSON.stringify(["mount", "pivot_root",
      "setns", "umount2", "unshare", "clone3"])) fail("renderer_acceptance_seccomp_invalid");
  for (const [record, label] of [[value.fonts, "fonts"], [value.pdfTools, "pdf_tools"],
    ]) {
    exact(record, ["sha256", "count"], `renderer_acceptance_${label}_invalid`);
    strictPin(record.sha256, `renderer_acceptance_${label}_invalid`);
    if (!Number.isSafeInteger(record.count) || record.count < 1) fail(`renderer_acceptance_${label}_invalid`);
  }
  exact(value.systemd, ["sha256", "serviceSha256", "socketSha256", "effectivePropertiesSha256"],
    "renderer_acceptance_systemd_invalid");
  for (const field of ["sha256", "serviceSha256", "socketSha256", "effectivePropertiesSha256"]) {
    strictPin(value.systemd[field], "renderer_acceptance_systemd_invalid");
  }
  exact(value.cups, ["connected", "gate", "serviceActive", "listenerCount"],
    "renderer_acceptance_cups_invalid");
  if (value.cups.connected !== false || value.cups.gate !== "deny-and-verify" ||
    value.cups.serviceActive !== false || value.cups.listenerCount !== 0) fail("renderer_acceptance_cups_invalid");
  exact(value.principals, ["apiUid", "rendererUid", "rendererGid", "ipcGid", "apiUser", "rendererUser", "ipcGroup"],
    "renderer_acceptance_principals_invalid");
  for (const field of ["apiUid", "rendererUid", "rendererGid", "ipcGid"]) {
    if (!Number.isSafeInteger(value.principals[field]) || value.principals[field] < 1) {
      fail("renderer_acceptance_principals_invalid");
    }
  }
  if (value.principals.apiUser !== "unseen" || value.principals.rendererUser !== "unseen-renderer" ||
    value.principals.ipcGroup !== "unseen-render-ipc") {
    fail("renderer_acceptance_principals_invalid");
  }
  exact(value.targetVerification, ["schema", "verifierBuildHash", "measurementsHash"],
    "renderer_acceptance_target_verification_invalid");
  if (value.targetVerification.schema !== "unseen-book-renderer-target-verification/1" ||
    !SHA256.test(value.targetVerification.verifierBuildHash) ||
    !SHA256.test(value.targetVerification.measurementsHash)) fail("renderer_acceptance_target_verification_invalid");
  if (!Array.isArray(value.readOnlyMounts) || value.readOnlyMounts.length < 1 ||
    value.readOnlyMounts.length > 32 || new Set(value.readOnlyMounts).size !== value.readOnlyMounts.length) {
    fail("renderer_acceptance_mounts_invalid");
  }
  value.readOnlyMounts.forEach((entry) => {
    strictAbsolute(entry, "renderer_acceptance_mounts_invalid");
    if (!allowedReadOnlyMount(entry)) fail("renderer_acceptance_mounts_invalid");
  });
  if (!value.readOnlyMounts.includes("/opt/unseen/runtime/node-v22.23.2-linux-x64")) {
    fail("renderer_acceptance_node_mount_missing");
  }
  if (!value.readOnlyMounts.includes(value.browserDistribution.numericRoot)) {
    fail("renderer_acceptance_browser_mount_missing");
  }
  return Object.freeze(value);
}

export function createRendererRequest({ kind, processorRequest, input, acceptanceReceiptHash }) {
  if (!new Set(["preview", "frozen"]).has(kind) || !processorRequest || typeof processorRequest !== "object" ||
    Array.isArray(processorRequest) || !input || typeof input !== "object" || Array.isArray(input) ||
    !SHA256.test(acceptanceReceiptHash)) fail("renderer_request_invalid");
  validateProcessorRequest(processorRequest, kind);
  if (!SHA256.test(input.inputHash) || input.inputHash !== processorRequest.inputHash) {
    fail("renderer_processor_request_invalid");
  }
  const body = { schema: RENDERER_REQUEST_SCHEMA, kind, processorRequest, input, acceptanceReceiptHash };
  const requestHash = rendererSha256(canonicalJson(body));
  const envelope = Object.freeze({ ...body, requestId: requestHash, requestHash });
  if (Buffer.byteLength(JSON.stringify(envelope)) > RENDERER_REQUEST_LIMIT) fail("renderer_request_too_large");
  return envelope;
}

export function validateRendererRequest(value, expectedAcceptanceHash) {
  exact(value, ["schema", "kind", "processorRequest", "input", "acceptanceReceiptHash", "requestId",
    "requestHash"], "renderer_request_invalid");
  const rebuilt = createRendererRequest(value);
  if (value.schema !== RENDERER_REQUEST_SCHEMA || rebuilt.requestId !== value.requestId ||
    rebuilt.requestHash !== value.requestHash || value.acceptanceReceiptHash !== expectedAcceptanceHash) {
    fail("renderer_request_invalid");
  }
  return value;
}

function validateArtifact(value, extension, code) {
  exact(value, ["name", "bytes", "sha256"], code);
  if (!SAFE_NAME.test(value.name) || !value.name.endsWith(extension) || !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 || value.bytes > 56 * 1024 * 1024 || !SHA256.test(value.sha256)) fail(code);
}

export function validateRendererResult(value, request) {
  exact(value, ["schema", "requestId", "requestHash", "status", "metadata", "artifacts"],
    "renderer_result_invalid");
  if (value.schema !== RENDERER_RESULT_SCHEMA || value.requestId !== request.requestId ||
    value.requestHash !== request.requestHash || !new Set(["ready", "failed", "cancelled"]).has(value.status) ||
    !value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata) ||
    !value.artifacts || typeof value.artifacts !== "object" || Array.isArray(value.artifacts)) {
    fail("renderer_result_invalid");
  }
  if (value.status !== "ready") {
    exact(value.artifacts, [], "renderer_result_invalid");
    const expected = value.status === "cancelled" ? "render_cancelled" : "render_failed";
    if (value.metadata.stableError !== expected) fail("renderer_result_invalid");
    if (value.status === "cancelled") exact(value.metadata, ["stableError"], "renderer_result_invalid");
    else {
      exact(value.metadata, ["stableError", "diagnostic"], "renderer_result_invalid");
      validateRendererFailureDiagnostic(value.metadata.diagnostic);
    }
    return value;
  }
  const expected = request.kind === "preview" ? ["html"] : ["html", "pdf", "receipt"];
  const metadataKeys = request.kind === "preview" ? ["htmlHash", "pageCount", "htmlArtifactId", "equality"] :
    ["htmlHash", "pdfHash", "pageCount", "equality"];
  exact(value.metadata, metadataKeys, "renderer_result_invalid");
  strictPin(value.metadata.htmlHash, "renderer_result_invalid");
  if (!Number.isSafeInteger(value.metadata.pageCount) || value.metadata.pageCount < 1 ||
    !value.metadata.equality || typeof value.metadata.equality !== "object" || Array.isArray(value.metadata.equality)) {
    fail("renderer_result_invalid");
  }
  if (request.kind === "preview") strictString(value.metadata.htmlArtifactId, "renderer_result_invalid");
  else strictPin(value.metadata.pdfHash, "renderer_result_invalid");
  exact(value.artifacts, expected, "renderer_result_invalid");
  validateArtifact(value.artifacts.html, ".html", "renderer_result_invalid");
  if (value.artifacts.html.sha256 !== value.metadata.htmlHash) fail("renderer_result_invalid");
  if (request.kind === "frozen") {
    validateArtifact(value.artifacts.pdf, ".pdf", "renderer_result_invalid");
    validateArtifact(value.artifacts.receipt, ".json", "renderer_result_invalid");
    if (value.artifacts.pdf.sha256 !== value.metadata.pdfHash) fail("renderer_result_invalid");
  }
  if (Object.hasOwn(value.metadata, "pdfBase64") || Object.hasOwn(value.metadata, "html")) {
    fail("renderer_result_embedded_artifact_forbidden");
  }
  return value;
}

export async function atomicWriteFile(directory, name, bytes, mode = 0o640) {
  if (!SAFE_NAME.test(name) || !Buffer.isBuffer(bytes) || !new Set([0o600, 0o640]).has(mode)) {
    fail("renderer_spool_write_invalid");
  }
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  const destination = path.join(directory, name);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
    constants.O_NOFOLLOW, mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
    await unlink(temporary);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    try { await unlink(temporary); } catch {}
    throw error;
  }
  return destination;
}

export async function secureReadFile(filename, options = {}) {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
    (before.mode & 0o777) !== (options.mode ?? 0o640) || before.size < 1 ||
    before.size > (options.maximumBytes ?? RENDERER_REQUEST_LIMIT) ||
    options.uid !== undefined && before.uid !== options.uid || options.gid !== undefined && before.gid !== options.gid) {
    fail("renderer_spool_file_invalid");
  }
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.nlink !== 1) {
      fail("renderer_spool_file_changed");
    }
    const bytes = await handle.readFile();
    if (options.size !== undefined && bytes.length !== options.size) fail("renderer_spool_size_mismatch");
    if (options.sha256 && rendererSha256(bytes) !== options.sha256) fail("renderer_spool_hash_mismatch");
    return bytes;
  } finally {
    await handle.close();
  }
}
