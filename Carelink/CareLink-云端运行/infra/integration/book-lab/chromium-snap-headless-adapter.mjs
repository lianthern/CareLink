import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson, validateRendererAcceptanceReceipt } from "./renderer-ipc-protocol.mjs";

export const CHROMIUM_SNAP_ADAPTER_SCHEMA = "unseen-chromium-snap-headless-adapter/1";
export const CHROMIUM_SNAP_DISTRIBUTION_SCHEMA = "unseen-chromium-snap-distribution/1";
export const CHROMIUM_SNAP_ROOT = "/snap/chromium/3507";
export const CHROMIUM_SNAP_BROWSER = `${CHROMIUM_SNAP_ROOT}/usr/lib/chromium-browser/chrome`;

const adapterPath = fileURLToPath(import.meta.url);
const JOB = "{JOB}";
const HTML = "{HTML}";
const PDF = "{PDF}";
const ENVIRONMENT_TEMPLATE = Object.freeze({
  CHROME_VERSION_EXTRA: "snap",
  HOME: `${JOB}/home`,
  LANG: "C.UTF-8",
  SNAP: CHROMIUM_SNAP_ROOT,
  SNAP_ARCH: "amd64",
  SNAP_INSTANCE_NAME: "chromium",
  SNAP_NAME: "chromium",
  SNAP_REAL_HOME: `${JOB}/home`,
  SNAP_REVISION: "3507",
  SNAP_USER_COMMON: `${JOB}/snap-user-common`,
  SNAP_USER_DATA: `${JOB}/snap-user-data`,
  SNAP_VERSION: "151.0.7922.108",
  TMPDIR: `${JOB}/tmp`,
  XDG_RUNTIME_DIR: `${JOB}/xdg`
});
const WRITABLE_DIRECTORIES = Object.freeze([
  `${JOB}/home`, `${JOB}/home/.cache`, `${JOB}/home/.config`, `${JOB}/xdg`,
  `${JOB}/snap-user-common`, `${JOB}/snap-user-data`, `${JOB}/tmp`
]);
const ARGUMENT_TEMPLATE = Object.freeze([
  "--password-store=basic",
  "--headless=new",
  "--no-sandbox",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-features=TFLiteLanguageDetectionEnabled",
  "--disable-sync",
  "--gtk-version=3",
  "--metrics-recording-only",
  "--no-first-run",
  "--no-pdf-header-footer",
  "--run-all-compositor-stages-before-draw",
  `--user-data-dir=${JOB}/home/.config/chromium`,
  `--print-to-pdf=${PDF}`,
  `file://${HTML}`
]);
const FORBIDDEN_DEPENDENCIES = Object.freeze([
  "BASH_ENV", "CHROME_CONFIG_HOME", "CHROMIUM_FLAGS", "DBUS_SESSION_BUS_ADDRESS", "ENV", "LD_AUDIT",
  "LD_LIBRARY_PATH", "LD_PRELOAD", "NODE_OPTIONS", "NODE_PATH", "PATH", "SNAPCTL", "SNAP_COMMON", "SNAP_DATA", "/run/snapd",
  "/var/lib/snapd", "chromium-browser.init", "cups", "first-run", "profile-import", "snap-confine",
  "snapctl"
]);
const trustedInvocations = new WeakSet();

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function projectionHash(value) { return sha256(canonicalJson(value)); }

export function chromiumSnapAdapterImplementationHash() {
  return sha256(readFileSync(adapterPath));
}

export const CHROMIUM_SNAP_ADAPTER_POLICY = Object.freeze({
  schema: CHROMIUM_SNAP_ADAPTER_SCHEMA,
  environmentProjectionSha256: projectionHash(ENVIRONMENT_TEMPLATE),
  argumentProjectionSha256: projectionHash(ARGUMENT_TEMPLATE),
  writableDirectoryProjectionSha256: projectionHash(WRITABLE_DIRECTORIES),
  forbiddenDependencyProjectionSha256: projectionHash(FORBIDDEN_DEPENDENCIES),
  environmentEntryCount: 14,
  environmentInheritance: "EMPTY_ALLOWLIST_ONLY",
  omittedEnvironmentKeys: Object.freeze(["SNAP_COMMON", "SNAP_DATA"]),
  outerSandboxRequired: true
});
export const CHROMIUM_SNAP_ADAPTER_POLICY_SHA256 = projectionHash(CHROMIUM_SNAP_ADAPTER_POLICY);

function exactDirectory(filename, uid, gid) {
  const stat = lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
    (stat.mode & 0o7777) !== 0o700) throw new Error("renderer_browser_private_directory_invalid");
}

function createPrivateDirectory(filename, uid, gid) {
  try { mkdirSync(filename, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  exactDirectory(filename, uid, gid);
}

function relativeJobPath(jobRoot, value, code) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || path.dirname(value) !== jobRoot) {
    throw new Error(code);
  }
  return value;
}

function materialize(template, jobRoot) { return template.replaceAll(JOB, jobRoot); }

function invocationEnvironment(jobRoot) {
  return Object.freeze(Object.fromEntries(Object.entries(ENVIRONMENT_TEMPLATE)
    .map(([key, value]) => [key, materialize(value, jobRoot)])));
}

function invocationArguments(jobRoot, htmlPath, pdfPath) {
  return Object.freeze(ARGUMENT_TEMPLATE.map((value) => value
    .replaceAll(JOB, jobRoot).replaceAll(PDF, pdfPath)
    .replaceAll(`file://${HTML}`, pathToFileURL(htmlPath).href)));
}

export function validateChromiumSnapHeadlessInvocation(value, { htmlPath, pdfPath }) {
  const jobRoot = path.dirname(htmlPath);
  if (!trustedInvocations.has(value) || !Object.isFrozen(value) || !Object.isFrozen(value.arguments) ||
    !Object.isFrozen(value.environment) || path.dirname(pdfPath) !== jobRoot ||
    canonicalJson(value) !== canonicalJson({ schema: CHROMIUM_SNAP_ADAPTER_SCHEMA, command: CHROMIUM_SNAP_BROWSER,
      arguments: invocationArguments(jobRoot, htmlPath, pdfPath), environment: invocationEnvironment(jobRoot),
      policySha256: CHROMIUM_SNAP_ADAPTER_POLICY_SHA256 })) {
    throw new Error("renderer_browser_invocation_invalid");
  }
  return value;
}

export function buildChromiumSnapHeadlessInvocation({ receipt, temporaryRoot, jobRoot, htmlPath, pdfPath,
  outerSandboxVerified, uid = process.getuid(), gid = process.getgid() }) {
  validateRendererAcceptanceReceipt(receipt);
  if (outerSandboxVerified !== true || receipt.browser.path !== CHROMIUM_SNAP_BROWSER ||
    receipt.browserDistribution.numericRoot !== CHROMIUM_SNAP_ROOT ||
    receipt.browserAdapter.implementationSha256 !== chromiumSnapAdapterImplementationHash() ||
    receipt.browserAdapter.policySha256 !== CHROMIUM_SNAP_ADAPTER_POLICY_SHA256 ||
    canonicalJson(Object.fromEntries(Object.keys(CHROMIUM_SNAP_ADAPTER_POLICY)
      .map((key) => [key, receipt.browserAdapter[key]]))) !== canonicalJson(CHROMIUM_SNAP_ADAPTER_POLICY)) {
    throw new Error("renderer_browser_adapter_pin_drift");
  }
  if (!path.isAbsolute(temporaryRoot) || path.normalize(temporaryRoot) !== temporaryRoot ||
    path.dirname(jobRoot) !== temporaryRoot || !/^dedicated-job-(?:[a-f0-9]{64}-)?[A-Za-z0-9]{6}$/u.test(
      path.basename(jobRoot))) throw new Error("renderer_browser_job_root_invalid");
  exactDirectory(jobRoot, uid, gid);
  relativeJobPath(jobRoot, htmlPath, "renderer_browser_html_path_invalid");
  relativeJobPath(jobRoot, pdfPath, "renderer_browser_pdf_path_invalid");
  if (path.basename(htmlPath) !== "book.html" || path.basename(pdfPath) !== "book.pdf") {
    throw new Error("renderer_browser_artifact_path_invalid");
  }
  for (const template of WRITABLE_DIRECTORIES) createPrivateDirectory(materialize(template, jobRoot), uid, gid);
  const environment = invocationEnvironment(jobRoot);
  const arguments_ = invocationArguments(jobRoot, htmlPath, pdfPath);
  if (Object.keys(environment).sort().join("\0") !== Object.keys(ENVIRONMENT_TEMPLATE).sort().join("\0") ||
    arguments_.some((value) => typeof value !== "string" || value.length < 1) ||
    arguments_.filter((value) => value === "--no-sandbox").length !== 1) {
    throw new Error("renderer_browser_adapter_policy_invalid");
  }
  const invocation = Object.freeze({ schema: CHROMIUM_SNAP_ADAPTER_SCHEMA, command: receipt.browser.path,
    arguments: arguments_, environment, policySha256: CHROMIUM_SNAP_ADAPTER_POLICY_SHA256 });
  trustedInvocations.add(invocation);
  return invocation;
}
