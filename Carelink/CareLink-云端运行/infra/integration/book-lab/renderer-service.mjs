import { createServer } from "node:net";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBookLabJobToFiles } from "./render-worker-adapter.mjs";
import { buildRenderReceipt, renderCanonicalHtml } from "../../../packages/book-renderer/src/render.mjs";
import { printExactHtmlToPdf } from "../../../packages/book-renderer/src/pdf.mjs";
import { sha256 as rendererCanonicalSha256 } from "../../../packages/book-renderer/src/canonical.mjs";
import {
  BOOK_RENDER_LEASE_MS, RENDERER_CANCEL_GRACE_MS, RENDERER_CONTROL_ACCEPTANCE_SCHEMA, RENDERER_CONTROL_LIMIT,
  RENDERER_ORPHAN_SCAN_MS, RENDERER_RESULT_SCHEMA,
  atomicWriteFile, createRendererControlResponse, exact, rendererSha256, secureReadFile,
  validateRendererAcceptanceReceipt, validateRendererControlMessage, validateRendererFailureDiagnostic,
  validateRendererRequest,
  validateRendererResult
} from "./renderer-ipc-protocol.mjs";
import { loadRendererAcceptanceReceipt, validateRendererSpoolLayout } from "./renderer-client.mjs";
import { verifyLinuxRenderSandbox } from "./linux-render-sandbox.mjs";
import { rendererChildSeccompHash } from "./linux-child-seccomp.mjs";
import { verifyRendererRuntimeTargetState } from "./renderer-target-verifier.mjs";
import { buildChromiumSnapHeadlessInvocation } from "./chromium-snap-headless-adapter.mjs";

export const RENDERER_PRODUCTION_PATHS = Object.freeze({
  spoolRoot: "/var/lib/unseen/renderer-spool",
  socketPath: "/run/unseen-renderer/render.sock",
  acceptanceReceiptPath: "/run/unseen/approvals/book-renderer-acceptance.json",
  acceptancePinPath: "/run/unseen/approvals/book-renderer-acceptance.sha256"
});

function json(bytes, code) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(code); }
}

async function createDirectories(root) {
  await mkdir(root, { recursive: true, mode: 0o2750 });
  await chmod(root, 0o2750);
  for (const directory of ["inbox", "cancels", "results", "acks", "results/receipts", "results/control",
    "results/cleanup"]) {
    await mkdir(path.join(root, directory), { recursive: true, mode: 0o2750 });
    await chmod(path.join(root, directory), 0o2750);
  }
  await mkdir(path.join(root, "work"), { recursive: true, mode: 0o700 });
  await chmod(path.join(root, "work"), 0o700);
}

async function exists(filename) {
  try { await lstat(filename); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function writeOnce(directory, name, bytes) {
  try { await atomicWriteFile(directory, name, bytes); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const current = await secureReadFile(path.join(directory, name));
    if (!current.equals(bytes)) throw new Error("renderer_result_idempotency_conflict");
  }
}

export async function loadRendererAcceptancePin(filename, expectedUid = 0) {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== expectedUid ||
    (before.mode & 0o777) !== 0o640 || before.size !== 65) throw new Error("renderer_acceptance_pin_invalid");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const current = await handle.stat();
    if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1 ||
      current.size !== before.size) throw new Error("renderer_acceptance_pin_changed");
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  const value = bytes.toString("utf8");
  if (!/^[a-f0-9]{64}\n$/u.test(value)) throw new Error("renderer_acceptance_pin_invalid");
  return Object.freeze({ hash: value.slice(0, 64), gid: before.gid });
}

const WORK_FILE_LIMITS = Object.freeze({ "request.json": 16 * 1024 * 1024,
  "output.json": 64 * 1024, "book.html": 16 * 1024 * 1024, "book.pdf": 56 * 1024 * 1024,
  "receipt.json": 256 * 1024 });
const WORK_JOB = /^dedicated-job-(?:([a-f0-9]{64})-)?[A-Za-z0-9]{6}$/u;
const WORK_SECCOMP = /^\.renderer-seccomp-(?:([a-f0-9]{64})-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function sweepRendererWorkDirectory(workRoot, owners, options = {}) {
  const startup = options.startup ?? false;
  const active = options.activeRequestIds ?? new Set();
  const now = options.now ?? Date.now();
  if (typeof startup !== "boolean" || !(active instanceof Set) || !Number.isFinite(now)) {
    throw new Error("renderer_work_sweep_invalid");
  }
  for (const name of (await readdir(workRoot)).sort()) {
    const job = name.match(WORK_JOB);
    const seccomp = name.match(WORK_SECCOMP);
    if (!job && !seccomp) throw new Error("renderer_work_entry_invalid");
    const requestId = (job ?? seccomp)[1] ?? null;
    const filename = path.join(workRoot, name);
    const entry = await lstat(filename);
    if (seccomp) {
      try {
        await secureReadFile(filename, { mode: 0o600, maximumBytes: 4 * 1024, uid: owners.rendererUid,
          gid: owners.ipcGid, sha256: rendererChildSeccompHash() });
      } catch { throw new Error("renderer_work_seccomp_invalid"); }
      if (requestId !== null && active.has(requestId)) continue;
      if (!startup && now - entry.mtimeMs < BOOK_RENDER_LEASE_MS) continue;
      await rm(filename);
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== owners.rendererUid ||
      entry.gid !== owners.ipcGid || (entry.mode & 0o777) !== 0o700) throw new Error("renderer_work_job_invalid");
    if (requestId !== null && active.has(requestId)) continue;
    let newest = entry.mtimeMs;
    for (const child of (await readdir(filename)).sort()) {
      const limit = WORK_FILE_LIMITS[child];
      if (limit === undefined) throw new Error("renderer_work_job_invalid");
      const childStat = await lstat(path.join(filename, child));
      if (!childStat.isFile() || childStat.isSymbolicLink() || childStat.nlink !== 1 ||
        childStat.uid !== owners.rendererUid || childStat.gid !== owners.ipcGid ||
        (childStat.mode & 0o777) !== 0o600 || childStat.size > limit ||
        child === "request.json" && childStat.size < 1) throw new Error("renderer_work_job_invalid");
      newest = Math.max(newest, childStat.mtimeMs);
    }
    if (!startup && now - newest < BOOK_RENDER_LEASE_MS) continue;
    await rm(filename, { recursive: true });
  }
}

export async function createDedicatedRendererService(options) {
  const required = ["spoolRoot", "socketPath", "acceptanceReceiptPath", "acceptanceReceiptHash", "expectedReceiptUid"];
  const allowed = [...required, "listenFd", "initializeDirectories", "render", "checkpoint", "onDiagnostic"];
  if (!options || Object.keys(options).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(options, key))) throw new Error("renderer_service_configuration_invalid");
  if (![options.spoolRoot, options.socketPath, options.acceptanceReceiptPath].every((value) =>
    typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value) ||
    options.listenFd !== undefined && options.listenFd !== 3 || !Number.isSafeInteger(options.expectedReceiptUid) ||
    options.expectedReceiptUid < 0 || options.onDiagnostic !== undefined && typeof options.onDiagnostic !== "function") {
    throw new Error("renderer_service_configuration_invalid");
  }
  if (options.initializeDirectories === true) {
    await createDirectories(options.spoolRoot);
    await mkdir(path.dirname(options.socketPath), { recursive: true, mode: 0o2750 });
    await chmod(path.dirname(options.socketPath), 0o2750);
  }
  const acceptance = await loadRendererAcceptanceReceipt(options.acceptanceReceiptPath,
    options.acceptanceReceiptHash, { expectedReceiptUid: options.expectedReceiptUid });
  const owners = acceptance.receipt.principals;
  if (owners.rendererUid !== (process.getuid?.() ?? owners.rendererUid) && options.initializeDirectories !== true) {
    throw new Error("renderer_service_principal_invalid");
  }
  const paths = Object.freeze({ inbox: path.join(options.spoolRoot, "inbox"),
    cancels: path.join(options.spoolRoot, "cancels"), results: path.join(options.spoolRoot, "results"),
    acks: path.join(options.spoolRoot, "acks"), control: path.join(options.spoolRoot, "results", "control"),
    cleanup: path.join(options.spoolRoot, "results", "cleanup") });
  validateRendererSpoolLayout(options.spoolRoot, null, owners, options.expectedReceiptUid);
  await sweepRendererWorkDirectory(path.join(options.spoolRoot, "work"), owners, { startup: true });
  if (!options.render) {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    verifyRendererRuntimeTargetState({ receipt: acceptance.receipt, repositoryRoot });
    verifyLinuxRenderSandbox({ receipt: acceptance.receipt, repositoryRoot,
      temporaryRoot: path.join(options.spoolRoot, "work") });
  }
  const render = options.render ?? ((request, requestId) => renderBookLabJobToFiles(request, { temporaryRoot:
    path.join(options.spoolRoot, "work"), timeoutMs: 120_000, dedicatedReceipt: acceptance.receipt,
    workId: requestId }));
  let tail = Promise.resolve();
  let stopped = false;
  let lastFailure = null;
  const inFlight = new Set();
  const controlCommits = new Map();
  const unclassifiedDiagnostic = Object.freeze({ schema: "unseen-book-renderer-failure-diagnostic/1",
    phase: "unclassified", code: "renderer_unclassified", exitCode: null, signalled: false, stderrBytes: 0 });

  function failureDiagnostic(errorOrOutput) {
    try { return validateRendererFailureDiagnostic(errorOrOutput?.rendererDiagnostic ?? errorOrOutput?.diagnostic); }
    catch { return unclassifiedDiagnostic; }
  }

  function recordDiagnostic(diagnostic) {
    try { options.onDiagnostic?.(diagnostic); } catch {}
  }

  async function cancelled(requestId) {
    const filename = path.join(paths.cancels, `${requestId}.json`);
    if (!await exists(filename)) return false;
    const marker = json(await secureReadFile(filename, { mode: 0o640, maximumBytes: 4 * 1024,
      uid: owners.apiUid, gid: owners.ipcGid }), "renderer_cancel_invalid");
    exact(marker, ["requestId", "requestHash"], "renderer_cancel_invalid");
    if (marker.requestId !== requestId || marker.requestHash !== requestId) {
      throw new Error("renderer_cancel_invalid");
    }
    return true;
  }

  async function readAck(requestId) {
    const filename = path.join(paths.acks, `${requestId}.json`);
    if (!await exists(filename)) return null;
    const ack = json(await secureReadFile(filename, { mode: 0o640, maximumBytes: 4 * 1024,
      uid: owners.apiUid, gid: owners.ipcGid }), "renderer_ack_invalid");
    exact(ack, ["requestId", "requestHash", "resultHash"], "renderer_ack_invalid");
    if (ack.requestId !== requestId || ack.requestHash !== requestId || !/^[a-f0-9]{64}$/u.test(ack.resultHash)) {
      throw new Error("renderer_ack_invalid");
    }
    return ack;
  }

  async function readCleanupMarker(requestId) {
    const filename = path.join(paths.cleanup, `${requestId}.json`);
    if (!await exists(filename)) return null;
    const marker = json(await secureReadFile(filename, { mode: 0o640, maximumBytes: 4 * 1024,
      uid: owners.rendererUid, gid: owners.ipcGid }), "renderer_cleanup_invalid");
    exact(marker, ["schema", "requestId", "requestHash", "reason"], "renderer_cleanup_invalid");
    if (marker.schema !== "unseen-book-render-cleanup/1" || marker.requestId !== requestId ||
      marker.requestHash !== requestId || marker.reason !== "terminal") throw new Error("renderer_cleanup_invalid");
    return marker;
  }

  function controlAcceptanceBytes(requestId) {
    return Buffer.from(`${JSON.stringify({ schema: RENDERER_CONTROL_ACCEPTANCE_SCHEMA, requestId,
      requestHash: requestId, acceptanceReceiptHash: acceptance.hash })}\n`);
  }

  async function readControlAcceptance(requestId) {
    const filename = path.join(paths.control, `${requestId}.json`);
    if (!await exists(filename)) return null;
    const bytes = await secureReadFile(filename, { mode: 0o640, maximumBytes: RENDERER_CONTROL_LIMIT,
      uid: owners.rendererUid, gid: owners.ipcGid });
    const marker = json(bytes, "renderer_control_acceptance_invalid");
    exact(marker, ["schema", "requestId", "requestHash", "acceptanceReceiptHash"],
      "renderer_control_acceptance_invalid");
    if (marker.schema !== RENDERER_CONTROL_ACCEPTANCE_SCHEMA || marker.requestId !== requestId ||
      marker.requestHash !== requestId || marker.acceptanceReceiptHash !== acceptance.hash ||
      !bytes.equals(controlAcceptanceBytes(requestId))) throw new Error("renderer_control_acceptance_invalid");
    return marker;
  }

  function persistControlAcceptance(requestId) {
    const current = controlCommits.get(requestId);
    if (current) return current;
    const pending = (async () => {
      await writeOnce(paths.control, `${requestId}.json`, controlAcceptanceBytes(requestId));
      await readControlAcceptance(requestId);
    })();
    controlCommits.set(requestId, pending);
    void pending.finally(() => {
      if (controlCommits.get(requestId) === pending) controlCommits.delete(requestId);
    }).catch(() => {});
    return pending;
  }

  async function removeControlAcceptance(requestId, reason) {
    await rm(path.join(paths.control, `${requestId}.json`), { force: true });
    await options.checkpoint?.(`after_${reason}_control_acceptance_delete`, requestId);
  }

  async function sweepControlAcceptances() {
    const markerIds = new Set();
    for (const name of (await readdir(paths.control)).sort()) {
      const marker = name.match(/^([a-f0-9]{64})\.json$/u);
      const temporary = name.match(/^\.([a-f0-9]{64})\.json\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u);
      if (marker) {
        const requestId = marker[1];
        if (controlCommits.has(requestId)) continue;
        await readControlAcceptance(requestId);
        if (!await exists(path.join(paths.inbox, `${requestId}.json`))) {
          if (!await readCleanupMarker(requestId)) throw new Error("renderer_control_acceptance_orphaned");
          await rm(path.join(paths.control, name));
          continue;
        }
        markerIds.add(requestId);
        continue;
      }
      if (!temporary) throw new Error("renderer_control_acceptance_entry_invalid");
      const requestId = temporary[1];
      if (controlCommits.has(requestId)) continue;
      const filename = path.join(paths.control, name);
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== owners.rendererUid ||
        stat.gid !== owners.ipcGid || (stat.mode & 0o777) !== 0o640 || stat.size < 1 ||
        stat.size > RENDERER_CONTROL_LIMIT || stat.nlink < 1 || stat.nlink > 2) {
        throw new Error("renderer_control_acceptance_entry_invalid");
      }
      const destination = path.join(paths.control, `${requestId}.json`);
      if (stat.nlink === 2) {
        const destinationStat = await lstat(destination).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (!destinationStat || destinationStat.dev !== stat.dev || destinationStat.ino !== stat.ino) {
          throw new Error("renderer_control_acceptance_entry_invalid");
        }
      } else {
        const temporaryBytes = await secureReadFile(filename, { mode: 0o640,
          maximumBytes: RENDERER_CONTROL_LIMIT, uid: owners.rendererUid, gid: owners.ipcGid });
        if (!temporaryBytes.equals(controlAcceptanceBytes(requestId))) {
          throw new Error("renderer_control_acceptance_entry_invalid");
        }
      }
      await rm(filename);
      if (stat.nlink === 2) {
        await readControlAcceptance(requestId);
        if (!await exists(path.join(paths.inbox, `${requestId}.json`))) {
          if (!await readCleanupMarker(requestId)) throw new Error("renderer_control_acceptance_orphaned");
          await rm(destination);
          continue;
        }
        markerIds.add(requestId);
      }
    }
    return markerIds;
  }

  async function persistResult(request, output) {
    const metadata = { ...output };
    delete metadata.status;
    delete metadata.html;
    delete metadata.pdfBase64;
    delete metadata.pdfBytes;
    delete metadata.receipt;
    const artifacts = {};
    if (output.status === "ready") {
      const html = Buffer.from(output.html);
      const htmlName = `${request.requestId}.html`;
      await writeOnce(paths.results, htmlName, html);
      artifacts.html = { name: htmlName, bytes: html.length, sha256: rendererSha256(html) };
      await options.checkpoint?.("after_html", request.requestId);
      if (request.kind === "frozen") {
        if (!Buffer.isBuffer(output.pdfBytes)) throw new Error("renderer_pdf_invalid");
        const pdf = output.pdfBytes;
        const pdfName = `${request.requestId}.pdf`;
        const receiptName = `${request.requestId}.json`;
        const receiptDirectory = path.join(paths.results, "receipts");
        await mkdir(receiptDirectory, { recursive: true, mode: 0o2750 });
        await chmod(receiptDirectory, 0o2750);
        const receiptBytes = Buffer.from(`${JSON.stringify(output.receipt)}\n`);
        await writeOnce(paths.results, pdfName, pdf);
        await writeOnce(receiptDirectory, receiptName, receiptBytes);
        artifacts.pdf = { name: pdfName, bytes: pdf.length, sha256: rendererSha256(pdf) };
        artifacts.receipt = { name: receiptName, bytes: receiptBytes.length, sha256: rendererSha256(receiptBytes) };
        await options.checkpoint?.("after_pdf", request.requestId);
      }
    }
    const result = { schema: RENDERER_RESULT_SCHEMA, requestId: request.requestId,
      requestHash: request.requestHash, status: output.status, metadata, artifacts };
    await options.checkpoint?.("before_manifest", request.requestId);
    await writeOnce(paths.results, `${request.requestId}.json`, Buffer.from(`${JSON.stringify(result)}\n`));
    await options.checkpoint?.("after_manifest", request.requestId);
  }

  async function processRequest(requestId) {
    if (inFlight.has(requestId)) return;
    const [controlAcceptance, cancellation, ack] = await Promise.all([
      readControlAcceptance(requestId), cancelled(requestId), readAck(requestId)
    ]);
    if (!controlAcceptance && !cancellation && !ack) return;
    const manifestExists = await exists(path.join(paths.results, `${requestId}.json`));
    if (manifestExists && cancellation) return cleanupResult(requestId, "cancel");
    if (manifestExists && ack) return acknowledge(requestId);
    if (manifestExists) {
      const requestStat = await lstat(path.join(paths.inbox, `${requestId}.json`));
      return Date.now() - requestStat.mtimeMs > BOOK_RENDER_LEASE_MS ? cleanupResult(requestId, "expired") : undefined;
    }
    if (ack) return cleanupPartialResult(requestId, "ack");
    if (cancellation) return cleanupPartialResult(requestId, "cancel");
    const requestStat = await lstat(path.join(paths.inbox, `${requestId}.json`));
    if (Date.now() - requestStat.mtimeMs > BOOK_RENDER_LEASE_MS) return cleanupPartialResult(requestId, "expired");
    inFlight.add(requestId);
    try {
      const requestBytes = await secureReadFile(path.join(paths.inbox, `${requestId}.json`), { mode: 0o640,
        uid: owners.apiUid, gid: owners.ipcGid });
      const request = validateRendererRequest(json(requestBytes, "renderer_request_json_invalid"), acceptance.hash);
      if (request.requestId !== requestId) throw new Error("renderer_request_filename_invalid");
      await options.checkpoint?.("after_claim", requestId);
      if (await cancelled(requestId)) {
        await persistResult(request, { status: "cancelled", stableError: "render_cancelled" });
        return;
      }
      let output;
      try { output = await render({ kind: request.kind, input: request.input }, request.requestId); }
      catch (error) {
        const diagnostic = failureDiagnostic(error);
        recordDiagnostic(diagnostic);
        output = { status: "failed", stableError: "render_failed", diagnostic };
      }
      if (output.status === "failed" && output.diagnostic === undefined) {
        const diagnostic = failureDiagnostic(output);
        recordDiagnostic(diagnostic);
        output = { ...output, diagnostic };
      }
      if (await cancelled(requestId)) output = { status: "cancelled", stableError: "render_cancelled" };
      await persistResult(request, output);
    } finally {
      inFlight.delete(requestId);
    }
  }

  function schedule(requestId) {
    if (!/^[a-f0-9]{64}$/u.test(requestId) || stopped) return false;
    tail = tail.then(() => processRequest(requestId)).catch((error) => {
      lastFailure = error?.message ?? "renderer_service_failure";
    });
    return true;
  }

  async function resume() {
    const accepted = await sweepControlAcceptances();
    for (const name of (await readdir(paths.inbox)).sort()) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const requestId = name.slice(0, 64);
      if (controlCommits.has(requestId)) continue;
      if (accepted.has(requestId) || await cancelled(requestId) || await readAck(requestId)) schedule(requestId);
    }
    for (const name of (await readdir(paths.cleanup)).sort()) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const requestId = name.slice(0, 64);
      if (!await exists(path.join(paths.inbox, name)) && !await exists(path.join(paths.cancels, name)) &&
        !await exists(path.join(paths.acks, name))) await rm(path.join(paths.cleanup, name), { force: true });
    }
    return tail;
  }

  async function acknowledge(requestId) {
    const manifestPath = path.join(paths.results, `${requestId}.json`);
    const ack = await readAck(requestId);
    if (!ack) return;
    if (!await exists(manifestPath)) return;
    const manifest = await secureReadFile(manifestPath, { mode: 0o640, uid: owners.rendererUid,
      gid: owners.ipcGid });
    if (ack.requestId !== requestId || ack.requestHash !== requestId || ack.resultHash !== rendererSha256(manifest)) {
      throw new Error("renderer_ack_invalid");
    }
    await cleanupResult(requestId, "ack", manifest);
  }

  async function cleanupResult(requestId, reason, manifestBytes = null) {
    const request = validateRendererRequest(json(await secureReadFile(path.join(paths.inbox,
      `${requestId}.json`), { mode: 0o640, uid: owners.apiUid, gid: owners.ipcGid }),
    "renderer_request_json_invalid"), acceptance.hash);
    const manifestPath = path.join(paths.results, `${requestId}.json`);
    const bytes = manifestBytes ?? await secureReadFile(manifestPath, { mode: 0o640,
      uid: owners.rendererUid, gid: owners.ipcGid });
    const record = validateRendererResult(json(bytes, "renderer_result_invalid"), request);
    for (const [kind, artifact] of Object.entries(record.artifacts)) {
      const directory = kind === "receipt" ? path.join(paths.results, "receipts") : paths.results;
      await rm(path.join(directory, artifact.name), { force: true });
      await options.checkpoint?.(`after_${reason}_${kind}_delete`, requestId);
    }
    await rm(manifestPath, { force: true });
    await options.checkpoint?.(`after_${reason}_manifest_delete`, requestId);
    await persistCleanupMarker(requestId, reason);
    await removeControlAcceptance(requestId, reason);
  }

  async function cleanupPartialResult(requestId, reason) {
    const artifacts = [[paths.results, `${requestId}.html`, 16 * 1024 * 1024, "html"],
      [paths.results, `${requestId}.pdf`, 56 * 1024 * 1024, "pdf"],
      [path.join(paths.results, "receipts"), `${requestId}.json`, 256 * 1024, "receipt"]];
    for (const [directory, name, maximumBytes, kind] of artifacts) {
      const filename = path.join(directory, name);
      if (!await exists(filename)) continue;
      await secureReadFile(filename, { mode: 0o640, maximumBytes, uid: owners.rendererUid, gid: owners.ipcGid });
      await rm(filename);
      await options.checkpoint?.(`after_${reason}_partial_${kind}_delete`, requestId);
    }
    await persistCleanupMarker(requestId, reason);
    await removeControlAcceptance(requestId, reason);
  }

  async function persistCleanupMarker(requestId, reason) {
    if (!new Set(["ack", "cancel", "expired"]).has(reason)) throw new Error("renderer_cleanup_invalid");
    const bytes = Buffer.from(`${JSON.stringify({ schema: "unseen-book-render-cleanup/1", requestId,
      requestHash: requestId, reason: "terminal" })}\n`);
    await writeOnce(paths.cleanup, `${requestId}.json`, bytes);
    await options.checkpoint?.(`after_${reason}_cleanup_marker`, requestId);
  }

  async function finalizeCleanup(requestId) {
    for (const directory of [paths.inbox, paths.cancels, paths.acks]) {
      if (await exists(path.join(directory, `${requestId}.json`))) throw new Error("renderer_cleanup_not_final");
    }
    await rm(path.join(paths.cleanup, `${requestId}.json`), { force: true });
  }

  async function validateControlBacking(message) {
    if (stopped) throw new Error("renderer_control_not_ready");
    if (message.operation === "ready") {
      if (message.requestId !== acceptance.hash || message.requestHash !== acceptance.hash) {
        throw new Error("renderer_control_not_ready");
      }
      return;
    }
    if (message.operation === "render" || message.operation === "cancel") {
      const request = validateRendererRequest(json(await secureReadFile(path.join(paths.inbox,
        `${message.requestId}.json`), { mode: 0o640, maximumBytes: 16 * 1024 * 1024,
        uid: owners.apiUid, gid: owners.ipcGid }), "renderer_request_json_invalid"), acceptance.hash);
      const cancellation = await cancelled(message.requestId);
      if (request.requestId !== message.requestId || message.operation === "cancel" && !cancellation ||
        message.operation === "render" && (cancellation || await readAck(message.requestId))) {
        throw new Error("renderer_control_not_ready");
      }
      return;
    }
    if (message.operation === "ack") {
      if (!await readAck(message.requestId)) throw new Error("renderer_control_not_ready");
      return;
    }
    if (!await readCleanupMarker(message.requestId)) throw new Error("renderer_cleanup_invalid");
    for (const directory of [paths.inbox, paths.cancels, paths.acks]) {
      if (await exists(path.join(directory, `${message.requestId}.json`))) {
        throw new Error("renderer_control_not_ready");
      }
    }
  }

  function enqueueControl(message) {
    if (message.operation === "ready") return true;
    if (message.operation === "render" || message.operation === "cancel") return schedule(message.requestId);
    const operation = message.operation === "ack" ? acknowledge : finalizeCleanup;
    tail = tail.then(() => operation(message.requestId))
      .catch((error) => { lastFailure = error?.message ?? "renderer_service_failure"; });
    return true;
  }

  function controlResponse(value) {
    const bytes = Buffer.from(`${JSON.stringify(createRendererControlResponse(value))}\n`);
    if (bytes.length > RENDERER_CONTROL_LIMIT) throw new Error("renderer_control_response_too_large");
    return bytes;
  }

  function rejectionCode(error) {
    if (error?.message === "renderer_control_too_large") return "renderer_control_too_large";
    if (error?.message === "renderer_control_not_ready" || error?.code === "ENOENT") {
      return "renderer_control_not_ready";
    }
    return "renderer_control_invalid";
  }

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let bytes = Buffer.alloc(0);
    let replied = false;
    let committing = false;
    const controlTimeoutMs = RENDERER_CANCEL_GRACE_MS;
    const deadline = Date.now() + controlTimeoutMs;
    function writeResponse(response) {
      socket.setTimeout(0);
      socket.end(response);
      socket.destroySoon();
    }
    function reply(value) {
      if (replied || socket.destroyed) return false;
      replied = true;
      writeResponse(controlResponse(value));
      return true;
    }
    function reject(error) {
      if (committing) return false;
      reply({ status: "rejected", code: rejectionCode(error) });
      return true;
    }
    async function accept(message) {
      const response = controlResponse({ status: "accepted", operation: message.operation,
        requestId: message.requestId });
      if (replied || socket.destroyed) return false;
      if (stopped || Date.now() >= deadline) {
        reject(new Error("renderer_control_not_ready"));
        return false;
      }
      if (message.operation === "render") {
        if (await cancelled(message.requestId) || await readAck(message.requestId)) {
          reject(new Error("renderer_control_not_ready"));
          return false;
        }
        committing = true;
        try { await persistControlAcceptance(message.requestId); }
        catch (error) {
          committing = false;
          reject(error);
          return false;
        }
        committing = false;
        await options.checkpoint?.("after_control_acceptance_commit", message.requestId, message.operation);
        if (await cancelled(message.requestId) || await readAck(message.requestId)) {
          enqueueControl({ operation: "cancel", requestId: message.requestId, requestHash: message.requestId });
          reject(new Error("renderer_control_not_ready"));
          return false;
        }
      }
      if (replied) return false;
      replied = true;
      enqueueControl(message);
      if (!socket.destroyed) writeResponse(response);
      return true;
    }
    socket.setTimeout(controlTimeoutMs);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (replied) return;
      if (bytes.length + chunk.length > RENDERER_CONTROL_LIMIT) {
        socket.pause();
        reject(new Error("renderer_control_too_large"));
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
    });
    socket.on("end", async () => {
      if (replied) return;
      try {
        if (bytes.length < 2 || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) {
          throw new Error("renderer_control_invalid");
        }
        const body = bytes.subarray(0, -1);
        const parsed = json(body, "renderer_control_invalid");
        if (!Buffer.from(JSON.stringify(parsed)).equals(body)) throw new Error("renderer_control_invalid");
        const message = validateRendererControlMessage(parsed);
        await validateControlBacking(message);
        await options.checkpoint?.("after_control_backing_validation", message.requestId, message.operation);
        await accept(message);
      } catch (error) { reject(error); }
    });
    socket.on("timeout", () => reject(new Error("renderer_control_not_ready")));
  });
  const listen = options.listenFd === undefined ? { path: options.socketPath } : { fd: options.listenFd };
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen, resolve);
  });
  try {
    if (options.initializeDirectories === true && options.listenFd === undefined) await chmod(options.socketPath, 0o660);
    validateRendererSpoolLayout(options.spoolRoot, options.socketPath, owners, options.expectedReceiptUid);
    await resume();
  } catch (error) {
    stopped = true;
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  const orphanScanner = setInterval(() => { void sweepRendererWorkDirectory(path.join(options.spoolRoot, "work"),
    owners, { activeRequestIds: inFlight }).then(resume).catch((error) => {
    lastFailure = error?.message ?? "renderer_service_failure";
    if (lastFailure.startsWith("renderer_work_") || lastFailure.startsWith("renderer_control_acceptance_")) {
      stopped = true;
    }
  }); }, RENDERER_ORPHAN_SCAN_MS);
  orphanScanner.unref();
  return Object.freeze({ server, paths, acceptance, resume, idle: () => tail,
    status: () => Object.freeze({ lastFailure, inFlight: inFlight.size }),
    async close() { stopped = true; clearInterval(orphanScanner);
      await Promise.allSettled([...controlCommits.values()]); await tail;
      await new Promise((resolve) => server.close(resolve)); } });
}

async function main() {
  if (process.argv[2] === "--child") {
    process.umask(0o077);
    await runDedicatedChild(process.argv[3], process.argv[4]);
    return;
  }
  const pin = await loadRendererAcceptancePin(RENDERER_PRODUCTION_PATHS.acceptancePinPath);
  const pinnedAcceptance = await loadRendererAcceptanceReceipt(RENDERER_PRODUCTION_PATHS.acceptanceReceiptPath,
    pin.hash, { expectedReceiptUid: 0 });
  if (pin.gid !== pinnedAcceptance.receipt.principals.ipcGid) {
    throw new Error("renderer_acceptance_pin_group_invalid");
  }
  if (process.argv[2] === "--verify") {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const target = verifyRendererRuntimeTargetState({ receipt: pinnedAcceptance.receipt, repositoryRoot });
    const result = verifyLinuxRenderSandbox({ receipt: pinnedAcceptance.receipt, repositoryRoot,
      temporaryRoot: path.join(RENDERER_PRODUCTION_PATHS.spoolRoot, "work") });
    process.stdout.write(`${JSON.stringify({ ...result,
      targetMeasurementsHash: pinnedAcceptance.receipt.targetVerification.measurementsHash, target })}\n`);
    return;
  }
  const service = await createDedicatedRendererService({
    spoolRoot: RENDERER_PRODUCTION_PATHS.spoolRoot,
    socketPath: RENDERER_PRODUCTION_PATHS.socketPath,
    listenFd: Number(process.env.LISTEN_FDS) === 1 ? 3 : undefined,
    acceptanceReceiptPath: RENDERER_PRODUCTION_PATHS.acceptanceReceiptPath,
    acceptanceReceiptHash: pin.hash,
    expectedReceiptUid: 0,
    onDiagnostic: (diagnostic) => process.stderr.write(`${JSON.stringify(diagnostic)}\n`)
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => service.close());
}

function childAssets(claim) {
  const metadata = new Map(claim.manifest.frozenAssets.map((asset) => [asset.localAssetRef, asset]));
  const bytes = new Map(claim.assetBytes.map((asset) => {
    exact(asset, ["localAssetRef", "bytesBase64"], "render_child_asset_invalid");
    const decoded = Buffer.from(asset.bytesBase64, "base64");
    if (decoded.toString("base64") !== asset.bytesBase64) throw new Error("render_child_asset_invalid");
    return [asset.localAssetRef, decoded];
  }));
  if (metadata.size !== claim.manifest.frozenAssets.length || bytes.size !== claim.assetBytes.length) {
    throw new Error("render_child_asset_invalid");
  }
  return (localAssetRef) => {
    const asset = metadata.get(localAssetRef);
    const value = bytes.get(localAssetRef);
    if (!asset || !value) throw new Error("render_child_asset_unavailable");
    return { bytes: value, contentHash: rendererCanonicalSha256(value),
      dataUri: `data:${asset.mimeType};base64,${value.toString("base64")}` };
  };
}

async function childWrite(filename, bytes) {
  const handle = await open(filename, "wx", 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return { name: path.basename(filename), bytes: bytes.length, sha256: rendererSha256(bytes) };
}

async function runDedicatedChild(requestPath, outputDirectory) {
  const root = process.env.UNSEEN_RENDER_TMP_ROOT;
  for (const value of [requestPath, outputDirectory]) {
    if (typeof root !== "string" || !path.isAbsolute(root) || !path.isAbsolute(value) ||
      path.relative(root, value).startsWith("..")) throw new Error("render_child_path_invalid");
  }
  const request = json(await secureReadFile(requestPath, { mode: 0o600, maximumBytes: 16 * 1024 * 1024,
    uid: process.getuid(), gid: process.getgid() }), "render_child_request_invalid");
  exact(request, ["schemaVersion", "operation", "payload", "rendererAcceptance"],
    "render_child_request_invalid");
  validateRendererAcceptanceReceipt(request.rendererAcceptance);
  exact(request.payload, ["kind", "input"], "render_child_request_invalid");
  if (request.schemaVersion !== "unseen-book-render-worker/1" || request.operation !== "render" ||
    !new Set(["preview", "frozen"]).has(request.payload.kind)) throw new Error("render_child_request_invalid");
  const inputKeys = request.payload.kind === "preview" ?
    ["manifest", "assetBytes", "accessControlSnapshot", "guard", "inputHash"] :
    ["manifest", "assetBytes", "guard", "inputHash"];
  exact(request.payload.input, inputKeys, "render_child_request_invalid");
  const html = renderCanonicalHtml(request.payload.input.manifest, childAssets(request.payload.input), "production");
  const htmlPath = path.join(outputDirectory, "book.html");
  if (request.payload.kind === "preview") {
    const htmlRecord = await childWrite(htmlPath, Buffer.from(html.html));
    const metadata = { htmlHash: html.htmlHash, pageCount: html.equality.pageCount,
      htmlArtifactId: `preview-${html.htmlHash.slice(0, 32)}`, equality: html.equality };
    await childWrite(path.join(outputDirectory, "output.json"), Buffer.from(`${JSON.stringify({
      schema: "unseen-book-render-child-files/1", status: "ready", metadata, html: htmlRecord })}\n`));
    return;
  }
  const pdfPath = path.join(outputDirectory, "book.pdf");
  const browserInvocation = buildChromiumSnapHeadlessInvocation({ receipt: request.rendererAcceptance,
    temporaryRoot: root, jobRoot: outputDirectory, htmlPath, pdfPath, outerSandboxVerified: true });
  const pdf = await printExactHtmlToPdf({ html: html.html, htmlPath, pdfPath,
    orderedPageIds: html.equality.orderedPageIds, pageOrderMarkers: html.pageOrderMarkers, canonicalTimestamp: request.payload.input.manifest.frozenAt,
    browserInvocation, outerSandboxVerified: true });
  await chmod(htmlPath, 0o600);
  await chmod(pdfPath, 0o600);
  const htmlBytes = await secureReadFile(htmlPath, { mode: 0o600, maximumBytes: 16 * 1024 * 1024,
    uid: process.getuid(), gid: process.getgid() });
  const pdfBytes = await secureReadFile(pdfPath, { mode: 0o600, maximumBytes: 56 * 1024 * 1024,
    uid: process.getuid(), gid: process.getgid() });
  const receipt = buildRenderReceipt(request.payload.input.manifest, html, pdf, "production");
  const receiptRecord = await childWrite(path.join(outputDirectory, "receipt.json"),
    Buffer.from(`${JSON.stringify(receipt)}\n`));
  const metadata = { htmlHash: html.htmlHash, pdfHash: pdf.contentHash, pageCount: pdf.pageCount,
    equality: receipt.equality };
  await childWrite(path.join(outputDirectory, "output.json"), Buffer.from(`${JSON.stringify({
    schema: "unseen-book-render-child-files/1", status: "ready", metadata,
    html: { name: "book.html", bytes: htmlBytes.length, sha256: rendererSha256(htmlBytes) },
    pdf: { name: "book.pdf", bytes: pdfBytes.length, sha256: rendererSha256(pdfBytes) },
    receipt: receiptRecord })}\n`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
