import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { findLocalBrowser } from "../../../packages/book-renderer/src/pdf.mjs";
import { prepareLinuxRenderSandbox } from "./linux-render-sandbox.mjs";
import { rendererSha256, secureReadFile, validateRendererFailureDiagnostic } from "./renderer-ipc-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const guard = path.join(root, "infra/integration/book-lab/network-deny.mjs");
const worker = path.join(root, "infra/integration/book-lab/render-worker.mjs");
const dedicatedChild = path.join(root, "infra/integration/book-lab/renderer-service.mjs");
const SCHEMA = "unseen-book-render-worker/1";
const INPUT_LIMIT = 16 * 1024 * 1024;
const OUTPUT_LIMIT = 56 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const MACOS_SANDBOX = "/usr/bin/sandbox-exec";
const MACOS_PROFILE = "(version 1)(allow default)" +
  "(deny network-outbound (remote ip) (literal \"/private/var/run/mDNSResponder\"))" +
  "(deny network-inbound (local ip))(deny network-bind (local ip))";
const WRAPPER_ATTESTATION = "unseen-egress-wrapper-deny-network-descendants/v1";

function exact(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(code);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function diagnosticError(phase, code, { exitCode = null, signalled = false, stderrBytes = 0 } = {}) {
  const rendererDiagnostic = validateRendererFailureDiagnostic({
    schema: "unseen-book-renderer-failure-diagnostic/1", phase, code, exitCode, signalled, stderrBytes
  });
  return Object.assign(new Error("render_worker_failed"), { rendererDiagnostic });
}

function validateProductionReceipt(request, output, pdfBytes = null) {
  const receipt = exact(output.receipt,
    ["schemaVersion", "renderProfile", "fixtureOnly", "input", "html", "pdf", "equality"],
    "render_worker_receipt_invalid");
  const equalityKeys = ["bookId", "versionId", "title", "manifestHash", "authorizationSnapshotHash",
    "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "pageCount", "orderedPageIds", "orderedSourceIds",
    "orderedDisplayPhotoIds"];
  exact(receipt.input, equalityKeys, "render_worker_receipt_invalid");
  exact(receipt.equality, equalityKeys, "render_worker_receipt_invalid");
  exact(receipt.html, ["contentHash", "pageCount"], "render_worker_receipt_invalid");
  exact(receipt.pdf, ["contentHash", "pageCount"], "render_worker_receipt_invalid");
  const manifest = request.input.manifest;
  const expected = { bookId: manifest.bookId, versionId: manifest.versionId, title: manifest.title,
    manifestHash: manifest.manifestHash, authorizationSnapshotHash: manifest.authorizationSnapshotHash,
    authorizedMemoryTextSnapshotHash: manifest.authorizedMemoryTextSnapshotHash,
    assetSnapshotHash: manifest.assetSnapshotHash, pageCount: manifest.pages.length,
    orderedPageIds: manifest.pages.map((page) => page.pageId),
    orderedSourceIds: manifest.pages.map((page) => page.sourcePhotoId),
    orderedDisplayPhotoIds: manifest.pages.map((page) => page.displayPhotoId) };
  const pdf = pdfBytes ?? Buffer.from(output.pdfBase64, "base64");
  if (!Buffer.isBuffer(pdf) || pdfBytes === null && pdf.toString("base64") !== output.pdfBase64 ||
    receipt.schemaVersion !== "unseen-book-render-receipt/1" ||
    receipt.renderProfile !== "production" || receipt.fixtureOnly !== false ||
    !isDeepStrictEqual(receipt.input, expected) || !isDeepStrictEqual(receipt.equality, expected) ||
    !isDeepStrictEqual(output.equality, expected) || receipt.html.contentHash !== output.htmlHash ||
    receipt.html.pageCount !== output.pageCount || receipt.pdf.contentHash !== output.pdfHash ||
    receipt.pdf.pageCount !== output.pageCount || sha256(output.html) !== output.htmlHash ||
    sha256(pdf) !== output.pdfHash) throw new Error("render_worker_receipt_invalid");
  return output;
}

function renderOptions(options, operation, payload) {
  const configuredRoot = options.temporaryRoot ?? process.env.UNSEEN_BOOK_LAB_RENDER_TMP;
  if (typeof configuredRoot !== "string" || !path.isAbsolute(configuredRoot)) {
    throw new Error("render_worker_temporary_root_invalid");
  }
  const temporaryRoot = path.normalize(configuredRoot);
  const timeoutMs = Number(options.timeoutMs ?? process.env.UNSEEN_BOOK_LAB_RENDER_TIMEOUT_MS ?? 90_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("render_worker_timeout_invalid");
  }
  mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  chmodSync(temporaryRoot, 0o700);
  const browserPath = operation === "render" && payload.kind === "frozen" ?
    path.resolve(options.dedicatedReceipt?.browser?.path ?? options.browserPath ?? findLocalBrowser()) : null;
  return { temporaryRoot, timeoutMs, browserPath };
}

function terminate(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch {} }
}

function executable(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

export function resolveBookRendererNetworkSandbox(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin" && executable(MACOS_SANDBOX)) return Object.freeze({
    command: MACOS_SANDBOX, prefix: Object.freeze(["-p", MACOS_PROFILE]),
    enforcement: "macos-sandbox-exec-deny-network+js-api-guard", kernelNetworkSandbox: true
  });
  const wrapper = options.egressWrapper ?? process.env.UNSEEN_BOOK_LAB_EGRESS_WRAPPER;
  const attestation = options.egressAttestation ?? process.env.UNSEEN_BOOK_LAB_EGRESS_ATTESTATION;
  if (typeof wrapper !== "string" || !path.isAbsolute(wrapper) || !executable(wrapper) ||
    attestation !== WRAPPER_ATTESTATION) throw new Error("render_worker_network_sandbox_required");
  return Object.freeze({ command: path.normalize(wrapper), prefix: Object.freeze([]),
    enforcement: "attested-external-egress-wrapper+js-api-guard", kernelNetworkSandbox: false });
}

function invoke(operation, payload, options = {}) {
  if (options.dedicatedReceipt) throw new Error("render_worker_dedicated_files_only");
  const { temporaryRoot, timeoutMs, browserPath } = renderOptions(options, operation, payload);
  const sandbox = resolveBookRendererNetworkSandbox(options);
  const request = Buffer.from(JSON.stringify({ schemaVersion: SCHEMA, operation, payload }));
  if (request.length > INPUT_LIMIT) throw new Error("render_worker_input_too_large");
  const args = ["--max-old-space-size=256", "--permission", `--allow-fs-read=${root}`,
    `--allow-fs-read=${temporaryRoot}`,
    `--allow-fs-write=${temporaryRoot}`];
  if (browserPath) args.push(`--allow-fs-read=${browserPath}`);
  args.push("--allow-child-process");
  args.push("--import", guard, worker);
  const env = { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", LANG: "C.UTF-8",
    UNSEEN_RENDER_TMP_ROOT: temporaryRoot, UNSEEN_RENDER_NETWORK_ENFORCEMENT: sandbox.enforcement,
    UNSEEN_RENDER_KERNEL_NETWORK_SANDBOX: String(sandbox.kernelNetworkSandbox),
    ...(browserPath ? { UNSEEN_CHROMIUM_PATH: browserPath } : {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(sandbox.command, [...sandbox.prefix, process.execPath, ...args],
      { env, stdio: ["pipe", "pipe", "pipe", ...(sandbox.extraStdio ?? [])], detached: true });
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let failure = null;
    const fail = (error) => { if (!failure) failure = error; terminate(child); };
    const timer = setTimeout(() => fail(new Error("render_worker_timeout")), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutLength += chunk.length;
      if (stdoutLength > OUTPUT_LIMIT) return fail(new Error("render_worker_output_too_large"));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      if (stderrLength > STDERR_LIMIT) return fail(new Error("render_worker_stderr_too_large"));
      stderr.push(chunk);
    });
    child.once("error", (error) => { clearTimeout(timer); sandbox.close?.(); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      sandbox.close?.();
      if (failure) return reject(failure);
      let reply;
      try { reply = JSON.parse(Buffer.concat(stdout, stdoutLength).toString("utf8")); }
      catch { return reject(new Error("render_worker_response_invalid")); }
      if (code !== 0 || signal || reply?.schemaVersion !== SCHEMA || reply?.status !== "ok" ||
        !Object.hasOwn(reply, "output") || Object.keys(reply).sort().join("\0") !== "output\0schemaVersion\0status") {
        return reject(new Error(reply?.error ?? "render_worker_failed"));
      }
      resolve(reply.output);
    });
    child.stdin.on("error", (error) => fail(error));
    child.stdin.end(request);
  });
}

async function readChildFile(directory, record, maximumBytes) {
  exact(record, ["name", "bytes", "sha256"], "render_child_output_invalid");
  if (!new Set(["book.html", "book.pdf", "receipt.json"]).has(record.name) ||
    !Number.isSafeInteger(record.bytes) || record.bytes < 1 || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
    throw new Error("render_child_output_invalid");
  }
  return secureReadFile(path.join(directory, record.name), { mode: 0o600, maximumBytes,
    uid: process.getuid(), gid: process.getgid(), size: record.bytes, sha256: record.sha256 });
}

export function renderBookLabJobToFiles(request, options) {
  exact(request, ["kind", "input"], "render_worker_request_invalid");
  if (!new Set(["preview", "frozen"]).has(request.kind) || !options?.dedicatedReceipt) {
    throw new Error("render_worker_dedicated_request_invalid");
  }
  let prepared;
  try { prepared = renderOptions(options, "render", request); }
  catch { throw diagnosticError("sandbox_setup", "renderer_sandbox_setup_failed"); }
  const { temporaryRoot, timeoutMs, browserPath } = prepared;
  let requestBytes;
  try {
    requestBytes = Buffer.from(JSON.stringify({ schemaVersion: SCHEMA, operation: "render", payload: request,
      rendererAcceptance: options.dedicatedReceipt }));
    if (requestBytes.length > INPUT_LIMIT || options.workId !== undefined &&
      !/^[a-f0-9]{64}$/u.test(options.workId)) throw new Error("renderer_request_stage_invalid");
  } catch { throw diagnosticError("request_stage", "renderer_request_stage_failed"); }
  let sandbox;
  try {
    sandbox = prepareLinuxRenderSandbox({ receipt: options.dedicatedReceipt, repositoryRoot: root, temporaryRoot,
      workId: options.workId });
  } catch { throw diagnosticError("sandbox_setup", "renderer_sandbox_setup_failed"); }
  let directory;
  try {
    directory = mkdtempSync(path.join(temporaryRoot, `dedicated-job-${options.workId ? `${options.workId}-` : ""}`));
    chmodSync(directory, 0o700);
    writeFileSync(path.join(directory, "request.json"), requestBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    sandbox.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw diagnosticError("request_stage", "renderer_request_stage_failed");
  }
  const requestPath = path.join(directory, "request.json");
  const args = ["--max-old-space-size=256", "--permission", `--allow-fs-read=${root}`,
    `--allow-fs-read=${temporaryRoot}`, `--allow-fs-write=${temporaryRoot}`,
    ...(browserPath ? [`--allow-fs-read=${browserPath}`] : []), "--allow-child-process", "--import", guard,
    dedicatedChild, "--child", requestPath, directory];
  const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", UNSEEN_RENDER_TMP_ROOT: temporaryRoot,
    UNSEEN_RENDER_NETWORK_ENFORCEMENT: sandbox.enforcement,
    UNSEEN_RENDER_KERNEL_NETWORK_SANDBOX: String(sandbox.kernelNetworkSandbox) };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(sandbox.command, [...sandbox.prefix, process.execPath, ...args],
        { env, stdio: ["ignore", "ignore", "pipe", ...(sandbox.extraStdio ?? [])], detached: true });
    } catch {
      sandbox.close();
      rmSync(directory, { recursive: true, force: true });
      reject(diagnosticError("child_spawn", "renderer_child_spawn_failed"));
      return;
    }
    let stderrLength = 0;
    let failureCode = null;
    const finish = () => { sandbox.close(); rmSync(directory, { recursive: true, force: true }); };
    const fail = (code) => { if (!failureCode) failureCode = code; terminate(child); };
    const timer = setTimeout(() => fail("renderer_child_timeout"), timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      if (stderrLength > STDERR_LIMIT) fail("renderer_child_stderr_limit");
    });
    child.once("error", () => {
      clearTimeout(timer);
      finish();
      reject(diagnosticError("child_spawn", "renderer_child_spawn_failed",
        { stderrBytes: Math.min(stderrLength, STDERR_LIMIT) }));
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      if (failureCode || code !== 0 || signal) {
        const diagnosticCode = failureCode ?? (signal ? "renderer_child_signalled" : "renderer_child_nonzero_exit");
        finish();
        return reject(diagnosticError("child_exit", diagnosticCode,
          { exitCode: code, signalled: Boolean(signal), stderrBytes: Math.min(stderrLength, STDERR_LIMIT) }));
      }
      let phase = "output_manifest";
      try {
        const metaBytes = await secureReadFile(path.join(directory, "output.json"), { mode: 0o600,
          maximumBytes: 64 * 1024, uid: process.getuid(), gid: process.getgid() });
        const meta = exact(JSON.parse(metaBytes.toString("utf8")),
          request.kind === "preview" ? ["schema", "status", "metadata", "html"] :
            ["schema", "status", "metadata", "html", "pdf", "receipt"], "render_child_output_invalid");
        if (meta.schema !== "unseen-book-render-child-files/1" || meta.status !== "ready") {
          throw new Error("render_child_output_invalid");
        }
        phase = "html_validation";
        const html = await readChildFile(directory, meta.html, 16 * 1024 * 1024);
        if (rendererSha256(html) !== meta.metadata.htmlHash) throw new Error("render_child_output_invalid");
        if (request.kind === "preview") return resolve({ status: "ready", ...meta.metadata,
          html: html.toString("utf8") });
        phase = "pdf_validation";
        const pdf = await readChildFile(directory, meta.pdf, OUTPUT_LIMIT);
        phase = "receipt_validation";
        const receipt = JSON.parse((await readChildFile(directory, meta.receipt, 256 * 1024)).toString("utf8"));
        const output = { status: "ready", ...meta.metadata, html: html.toString("utf8"), pdfBytes: pdf, receipt };
        validateProductionReceipt(request, output, pdf);
        resolve(output);
      } catch {
        const codeByPhase = { output_manifest: "renderer_output_manifest_invalid",
          html_validation: "renderer_html_validation_failed", pdf_validation: "renderer_pdf_validation_failed",
          receipt_validation: "renderer_receipt_validation_failed" };
        reject(diagnosticError(phase, codeByPhase[phase],
          { exitCode: code, signalled: false, stderrBytes: Math.min(stderrLength, STDERR_LIMIT) }));
      }
      finally { finish(); }
    });
  });
}

export function renderBookLabJob(request, options) {
  exact(request, ["kind", "input"], "render_worker_request_invalid");
  if (!new Set(["preview", "frozen"]).has(request.kind)) throw new Error("render_worker_kind_invalid");
  return invoke("render", request, options).then((output) => {
    const keys = request.kind === "preview" ? ["status", "html", "htmlHash", "pageCount", "htmlArtifactId", "equality"] :
      ["status", "html", "htmlHash", "pdfBase64", "pdfHash", "pageCount", "equality", "receipt"];
    exact(output, keys, "render_worker_output_invalid");
    return request.kind === "frozen" ? validateProductionReceipt(request, output) : output;
  });
}

export function probeBookRendererIsolation(request, options) {
  exact(request, ["url", "udpPort", "dnsPort", "secretName", "delayMs"], "render_worker_probe_invalid");
  return invoke("probe", request, options).then((output) => exact(output,
    ["networkDenied", "inheritedSecret", "enforcement", "kernelNetworkSandbox", "descendantProbe", "jsApiGuard"],
    "render_worker_probe_invalid"));
}
