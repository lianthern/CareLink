import { setTimeout as delay } from "node:timers/promises";
import { connect } from "node:net";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  RENDERER_CANCEL_GRACE_MS, RENDERER_COLD_START_TIMEOUT_MS, RENDERER_CONTROL_LIMIT,
  RENDERER_WHOLE_TIMEOUT_MS, atomicWriteFile,
  createRendererRequest, exact, rendererSha256, secureReadFile, validateRendererAcceptanceReceipt,
  validateRendererControlResponse, validateRendererResult
} from "./renderer-ipc-protocol.mjs";

function absolute(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.startsWith("\0")) {
    throw new Error(code);
  }
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function subscribe(flight) {
  return flight.then((result) => deepFreeze(structuredClone(result)));
}

async function readJson(filename, constraints) {
  const bytes = await secureReadFile(filename, constraints);
  try { return { bytes, value: JSON.parse(bytes.toString("utf8")) }; }
  catch { throw new Error("renderer_spool_json_invalid"); }
}

async function readCleanupAtomicPromotionWitness(filename, expectedBytes, constraints) {
  const name = path.basename(filename);
  if (!/^[a-f0-9]{64}\.json$/u.test(name) || !Buffer.isBuffer(expectedBytes)) {
    throw new Error("renderer_cleanup_atomic_promotion_invalid");
  }
  function validMetadata(stat, links) {
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === links &&
      stat.uid === constraints.uid && stat.gid === constraints.gid &&
      (stat.mode & 0o777) === constraints.mode && stat.size === expectedBytes.length &&
      stat.size <= constraints.maximumBytes;
  }
  async function committedAfterPromotion() {
    try {
      const bytes = await secureReadFile(filename, constraints);
      if (!bytes.equals(expectedBytes) || rendererSha256(bytes) !== rendererSha256(expectedBytes)) {
        throw new Error("renderer_cleanup_atomic_promotion_invalid");
      }
      return Object.freeze({ state: "committed", bytes });
    } catch { throw new Error("renderer_cleanup_atomic_promotion_invalid"); }
  }
  const before = await lstat(filename).catch(() => { throw new Error("renderer_cleanup_atomic_promotion_invalid"); });
  if (before.nlink === 1) return committedAfterPromotion();
  if (!validMetadata(before, 2)) throw new Error("renderer_cleanup_atomic_promotion_invalid");
  const temporaryPattern = new RegExp(`^\\.${name.replace(".", "\\.")}\\.` +
    "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$", "u");
  const candidates = (await readdir(path.dirname(filename))).filter((entry) => temporaryPattern.test(entry));
  if (candidates.length !== 1) {
    const after = await lstat(filename).catch(() => null);
    if (after?.nlink === 1) return committedAfterPromotion();
    throw new Error("renderer_cleanup_atomic_promotion_invalid");
  }
  const temporaryPath = path.join(path.dirname(filename), candidates[0]);
  const temporary = await lstat(temporaryPath).catch(() => null);
  if (!temporary) return committedAfterPromotion();
  if (!validMetadata(temporary, 2) || temporary.dev !== before.dev || temporary.ino !== before.ino) {
    throw new Error("renderer_cleanup_atomic_promotion_invalid");
  }
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const current = await handle.stat();
    if (!new Set([1, 2]).has(current.nlink) || !validMetadata(current, current.nlink) ||
      current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error("renderer_cleanup_atomic_promotion_invalid");
    }
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (!bytes.equals(expectedBytes) || rendererSha256(bytes) !== rendererSha256(expectedBytes)) {
    throw new Error("renderer_cleanup_atomic_promotion_invalid");
  }
  const after = await lstat(filename).catch(() => null);
  if (!after || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("renderer_cleanup_atomic_promotion_invalid");
  }
  if (after.nlink === 1) return Object.freeze({ state: "committed", bytes });
  if (!validMetadata(after, 2)) throw new Error("renderer_cleanup_atomic_promotion_invalid");
  const finalTemporary = await lstat(temporaryPath).catch(() => null);
  if (!finalTemporary) return committedAfterPromotion();
  if (!validMetadata(finalTemporary, 2) || finalTemporary.dev !== after.dev ||
    finalTemporary.ino !== after.ino) throw new Error("renderer_cleanup_atomic_promotion_invalid");
  return Object.freeze({ state: "promoting", bytes });
}

export function notifyRendererControl(socketPath, message, timeoutMs = RENDERER_CANCEL_GRACE_MS) {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
  if (bytes.length > RENDERER_CONTROL_LIMIT) throw new Error("renderer_control_too_large");
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = Buffer.alloc(0);
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      if (error) reject(error); else resolve(value);
    }
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.end(bytes));
    socket.on("data", (chunk) => {
      if (response.length + chunk.length > RENDERER_CONTROL_LIMIT) {
        finish(new Error("renderer_control_response_too_large"));
        socket.destroy();
        return;
      }
      response = Buffer.concat([response, chunk]);
    });
    socket.once("end", () => {
      if (response.length === 0) return finish(new Error("renderer_control_transport_closed"));
      if (response.at(-1) !== 0x0a || response.subarray(0, -1).includes(0x0a)) {
        return finish(new Error("renderer_control_response_invalid"));
      }
      try {
        const body = response.subarray(0, -1);
        const parsed = JSON.parse(body.toString("utf8"));
        if (!Buffer.from(JSON.stringify(parsed)).equals(body)) throw new Error("renderer_control_response_invalid");
        const value = validateRendererControlResponse(parsed, message);
        if (value.status === "rejected") return finish(new Error(value.code));
        finish(null, value);
      } catch (error) { finish(error?.message?.startsWith("renderer_control_") ? error :
        new Error("renderer_control_response_invalid")); }
    });
    socket.once("timeout", () => {
      finish(new Error("renderer_control_timeout"));
      socket.destroy();
    });
    socket.once("error", () => finish(new Error("renderer_control_transport_error")));
    socket.once("close", () => finish(new Error("renderer_control_transport_closed")));
  });
}

async function writeIdempotent(directory, name, bytes) {
  try { return await atomicWriteFile(directory, name, bytes); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await secureReadFile(path.join(directory, name));
    if (!existing.equals(bytes)) throw new Error("renderer_spool_idempotency_conflict");
    return path.join(directory, name);
  }
}

export async function loadRendererAcceptanceReceipt(filename, expectedHash, options = {}) {
  return loadRendererAcceptanceReceiptSync(filename, expectedHash, options);
}

export function loadRendererAcceptanceReceiptSync(filename, expectedHash, options = {}) {
  absolute(filename, "renderer_acceptance_path_invalid");
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) throw new Error("renderer_acceptance_hash_invalid");
  const before = lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o640 ||
    before.size < 1 || before.size > 64 * 1024 || before.uid !== (options.expectedReceiptUid ?? 0)) {
    throw new Error("renderer_acceptance_file_invalid");
  }
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const current = fstatSync(fd);
    if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.nlink !== 1) {
      throw new Error("renderer_acceptance_file_changed");
    }
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  if (rendererSha256(bytes) !== expectedHash) throw new Error("renderer_acceptance_hash_mismatch");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("renderer_acceptance_json_invalid"); }
  validateRendererAcceptanceReceipt(value);
  if (before.gid !== value.principals.ipcGid) throw new Error("renderer_acceptance_group_invalid");
  return Object.freeze({ bytes, hash: rendererSha256(bytes), receipt: value });
}

export function validateRendererSpoolLayout(spoolRoot, socketPath, owners, rootUid) {
  const directories = [[spoolRoot, rootUid], [path.join(spoolRoot, "inbox"), owners.apiUid],
    [path.join(spoolRoot, "cancels"), owners.apiUid], [path.join(spoolRoot, "acks"), owners.apiUid],
    [path.join(spoolRoot, "results"), owners.rendererUid],
    [path.join(spoolRoot, "results", "receipts"), owners.rendererUid],
    [path.join(spoolRoot, "results", "control"), owners.rendererUid],
    [path.join(spoolRoot, "results", "cleanup"), owners.rendererUid]];
  for (const [directory, uid] of directories) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== owners.ipcGid ||
      (stat.mode & 0o7777) !== 0o2750) throw new Error("renderer_spool_directory_invalid");
  }
  const work = lstatSync(path.join(spoolRoot, "work"));
  if (!work.isDirectory() || work.isSymbolicLink() || work.uid !== owners.rendererUid ||
    work.gid !== owners.rendererGid || (work.mode & 0o777) !== 0o700) {
    throw new Error("renderer_spool_work_directory_invalid");
  }
  if (socketPath === null) return;
  const socketDirectory = lstatSync(path.dirname(socketPath));
  if (!socketDirectory.isDirectory() || socketDirectory.isSymbolicLink() || socketDirectory.uid !== rootUid ||
    socketDirectory.gid !== owners.ipcGid || (socketDirectory.mode & 0o7777) !== 0o2750) {
    throw new Error("renderer_socket_directory_invalid");
  }
  const socket = lstatSync(socketPath);
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== owners.rendererUid ||
    socket.gid !== owners.ipcGid || (socket.mode & 0o777) !== 0o660) {
    throw new Error("renderer_socket_metadata_invalid");
  }
}

export function createDedicatedRendererClient(options) {
  exact(options, ["socketPath", "spoolRoot", "acceptanceReceiptPath", "acceptanceReceiptHash",
    "expectedReceiptUid", ...(options?.testOnlyTiming === undefined ? [] : ["testOnlyTiming"]),
    ...(options?.testOnlyBeforeArtifactRead === undefined ? [] : ["testOnlyBeforeArtifactRead"])],
  "renderer_client_configuration_invalid");
  const timing = options.testOnlyTiming === undefined ? { wholeTimeoutMs: RENDERER_WHOLE_TIMEOUT_MS,
    cleanupGraceMs: RENDERER_CANCEL_GRACE_MS, coldStartTimeoutMs: RENDERER_COLD_START_TIMEOUT_MS,
    reconcileIntervalMs: 5_000 } :
    exact(options.testOnlyTiming, ["wholeTimeoutMs", "cleanupGraceMs", "coldStartTimeoutMs", "reconcileIntervalMs"],
      "renderer_client_test_timing_invalid");
  if (![timing.wholeTimeoutMs, timing.cleanupGraceMs, timing.coldStartTimeoutMs, timing.reconcileIntervalMs]
    .every((value) => Number.isSafeInteger(value) && value >= 10 && value <= RENDERER_WHOLE_TIMEOUT_MS)) {
    throw new Error("renderer_client_test_timing_invalid");
  }
  if (options.testOnlyBeforeArtifactRead !== undefined &&
    typeof options.testOnlyBeforeArtifactRead !== "function") throw new Error("renderer_client_configuration_invalid");
  const socketPath = absolute(options.socketPath, "renderer_socket_path_invalid");
  const spoolRoot = absolute(options.spoolRoot, "renderer_spool_path_invalid");
  const acceptance = loadRendererAcceptanceReceiptSync(options.acceptanceReceiptPath,
    options.acceptanceReceiptHash, { expectedReceiptUid: options.expectedReceiptUid });
  const paths = Object.freeze({ inbox: path.join(spoolRoot, "inbox"), cancels: path.join(spoolRoot, "cancels"),
    results: path.join(spoolRoot, "results"), acks: path.join(spoolRoot, "acks"),
    cleanup: path.join(spoolRoot, "results", "cleanup") });
  const owners = acceptance.receipt.principals;
  validateRendererSpoolLayout(spoolRoot, socketPath, owners, options.expectedReceiptUid);
  let closed = false;
  let reconciliation = Promise.resolve();
  const cleanupFlights = new Map();
  const activeRequests = new Map();
  const renderFlights = new Map();

  async function exists(filename) {
    try { await lstat(filename); return true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  }

  async function cleanupApiFiles(requestId) {
    await Promise.all([rm(path.join(paths.inbox, `${requestId}.json`), { force: true }),
      rm(path.join(paths.cancels, `${requestId}.json`), { force: true }),
      rm(path.join(paths.acks, `${requestId}.json`), { force: true })]);
  }

  async function waitForCleanup(requestId, operation) {
    const markerPath = path.join(paths.cleanup, `${requestId}.json`);
    const expectedMarkerBytes = Buffer.from(`${JSON.stringify({ schema: "unseen-book-render-cleanup/1", requestId,
      requestHash: requestId, reason: "terminal" })}\n`);
    const deadline = Date.now() + timing.cleanupGraceMs;
    let nextNotify = 0;
    while (Date.now() <= deadline) {
      if (Date.now() >= nextNotify) {
        await notifyRendererControl(socketPath, { operation, requestId, requestHash: requestId },
          timing.cleanupGraceMs);
        nextNotify = Date.now() + 250;
      }
      try {
        const constraints = { mode: 0o640, maximumBytes: 4 * 1024,
          uid: owners.rendererUid, gid: owners.ipcGid };
        let markerBytes;
        try { markerBytes = await secureReadFile(markerPath, constraints); }
        catch (error) {
          if (error?.message !== "renderer_spool_file_invalid") throw error;
          const witness = await readCleanupAtomicPromotionWitness(markerPath, expectedMarkerBytes, constraints);
          if (witness.state === "promoting") {
            await delay(10);
            continue;
          }
          markerBytes = witness.bytes;
        }
        if (!markerBytes.equals(expectedMarkerBytes)) throw new Error("renderer_cleanup_invalid");
        const marker = JSON.parse(markerBytes.toString("utf8"));
        exact(marker, ["schema", "requestId", "requestHash", "reason"], "renderer_cleanup_invalid");
        if (marker.schema !== "unseen-book-render-cleanup/1" || marker.requestId !== requestId ||
          marker.requestHash !== requestId || marker.reason !== "terminal") throw new Error("renderer_cleanup_invalid");
        await cleanupApiFiles(requestId);
        await notifyRendererControl(socketPath, { operation: "finalize", requestId, requestHash: requestId },
          timing.cleanupGraceMs);
        while (Date.now() <= deadline) {
          try { await lstat(markerPath); }
          catch (error) { if (error?.code === "ENOENT") return; throw error; }
          await delay(10);
        }
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await delay(25);
    }
    throw new Error("renderer_ack_cleanup_timeout");
  }

  function cleanupOnce(requestId, operation, prepare) {
    if (cleanupFlights.has(requestId)) return cleanupFlights.get(requestId);
    const flight = (async () => {
      await prepare();
      await waitForCleanup(requestId, operation);
    })();
    cleanupFlights.set(requestId, flight);
    void flight.finally(() => {
      if (cleanupFlights.get(requestId) === flight) cleanupFlights.delete(requestId);
    }).catch(() => {});
    return flight;
  }

  function persistCancellation(requestId) {
    return writeIdempotent(paths.cancels, `${requestId}.json`,
      Buffer.from(`${JSON.stringify({ requestId, requestHash: requestId })}\n`));
  }

  function requestCancellation(requestId) {
    return cleanupOnce(requestId, "cancel", () => persistCancellation(requestId));
  }

  async function persistCancellationBeforeFailure(requestId) {
    await persistCancellation(requestId);
    void cleanupOnce(requestId, "cancel", async () => {}).catch(() => {});
  }

  async function reconcileOrphans() {
    const names = [];
    const committingIds = new Set();
    for (const directory of [paths.inbox, paths.cancels, paths.acks]) {
      for (const name of await readdir(directory)) {
        const temporary = name.match(/^\.([a-f0-9]{64})\.json\.[0-9a-f-]{36}\.tmp$/u);
        if (temporary) {
          const filename = path.join(directory, name);
          const stat = await lstat(filename).catch((error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
          });
          if (stat === null) continue;
          if (!stat.isFile() || stat.isSymbolicLink() || !new Set([1, 2]).has(stat.nlink) ||
            stat.uid !== owners.apiUid ||
            stat.gid !== owners.ipcGid || (stat.mode & 0o777) !== 0o640) {
            throw new Error("renderer_spool_orphan_invalid");
          }
          if (stat.nlink === 2) {
            const destination = await lstat(path.join(directory, `${temporary[1]}.json`)).catch((error) => {
              if (error?.code === "ENOENT") return null;
              throw error;
            });
            if (!destination || destination.dev !== stat.dev || destination.ino !== stat.ino) {
              throw new Error("renderer_spool_orphan_invalid");
            }
            committingIds.add(temporary[1]);
          } else if (Date.now() - stat.mtimeMs > timing.cleanupGraceMs) await rm(filename);
          else committingIds.add(temporary[1]);
          continue;
        }
        names.push(name);
      }
    }
    for (const name of [...new Set(names)].sort()) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw new Error("renderer_spool_orphan_invalid");
      const requestId = name.slice(0, 64);
      if (committingIds.has(requestId)) continue;
      const inboxPath = path.join(paths.inbox, name);
      let requestStat = null;
      if (await exists(inboxPath)) {
        const request = JSON.parse((await secureReadFile(inboxPath, { mode: 0o640,
          uid: owners.apiUid, gid: owners.ipcGid })).toString("utf8"));
        if (request.requestId !== requestId || request.requestHash !== requestId) {
          throw new Error("renderer_spool_orphan_invalid");
        }
        requestStat = await lstat(inboxPath);
      }
      if (activeRequests.has(requestId)) continue;
      if (await exists(path.join(paths.acks, name))) {
        await cleanupOnce(requestId, "ack", async () => {});
      } else if (await exists(path.join(paths.cancels, name)) || requestStat &&
        Date.now() - requestStat.mtimeMs >= timing.wholeTimeoutMs) {
        await requestCancellation(requestId);
      }
    }
    await Promise.all([...cleanupFlights.values()]);
  }

  function scheduleReconciliation() {
    reconciliation = reconciliation.catch(() => {}).then(() => closed ? undefined : reconcileOrphans());
    return reconciliation;
  }

  const startup = scheduleReconciliation();
  void startup.catch(() => {});
  const reconciler = setInterval(() => { void scheduleReconciliation().catch(() => {}); },
    timing.reconcileIntervalMs);
  reconciler.unref();

  async function performRender(request) {
    await startup;
    await notifyRendererControl(socketPath, { operation: "ready", requestId: acceptance.hash,
      requestHash: acceptance.hash }, timing.coldStartTimeoutMs);
    activeRequests.set(request.requestId, (activeRequests.get(request.requestId) ?? 0) + 1);
    try {
      const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`);
      await writeIdempotent(paths.inbox, `${request.requestId}.json`, requestBytes);
      try { await notifyRendererControl(socketPath, { operation: "render", requestId: request.requestId,
        requestHash: request.requestHash }, timing.cleanupGraceMs); }
      catch (error) {
        await persistCancellationBeforeFailure(request.requestId);
        throw error;
      }
      const resultPath = path.join(paths.results, `${request.requestId}.json`);
      const deadline = Date.now() + timing.wholeTimeoutMs;
      let resultRecord;
      while (Date.now() <= deadline) {
        try {
          resultRecord = await readJson(resultPath, { mode: 0o640, maximumBytes: 64 * 1024,
            uid: owners.rendererUid, gid: owners.ipcGid });
          break;
        } catch (error) {
          if (!new Set(["ENOENT", "renderer_spool_file_invalid"]).has(error?.code ?? error?.message)) throw error;
        }
        await delay(25);
      }
      if (!resultRecord) {
        await persistCancellationBeforeFailure(request.requestId);
        throw new Error("renderer_whole_timeout");
      }
      const result = validateRendererResult(resultRecord.value, request);
      function acknowledge() {
        return cleanupOnce(request.requestId, "ack", () => writeIdempotent(paths.acks,
          `${request.requestId}.json`, Buffer.from(`${JSON.stringify({ requestId: request.requestId,
            requestHash: request.requestHash, resultHash: rendererSha256(resultRecord.bytes) })}\n`)));
      }
      if (result.status !== "ready") {
        await acknowledge();
        return Object.freeze({ status: result.status, stableError: result.metadata.stableError });
      }
      await options.testOnlyBeforeArtifactRead?.(request.requestId);
      const html = await secureReadFile(path.join(paths.results, result.artifacts.html.name), { mode: 0o640,
        maximumBytes: 16 * 1024 * 1024, uid: owners.rendererUid, gid: owners.ipcGid,
        size: result.artifacts.html.bytes, sha256: result.artifacts.html.sha256 });
      const output = { status: "ready", ...result.metadata, html: html.toString("utf8") };
      if (request.kind === "frozen") {
        const pdf = await secureReadFile(path.join(paths.results, result.artifacts.pdf.name), { mode: 0o640,
          maximumBytes: 56 * 1024 * 1024, uid: owners.rendererUid, gid: owners.ipcGid,
          size: result.artifacts.pdf.bytes, sha256: result.artifacts.pdf.sha256 });
        const receipt = await readJson(path.join(paths.results, "receipts", result.artifacts.receipt.name), {
          mode: 0o640,
          maximumBytes: 256 * 1024, uid: owners.rendererUid, gid: owners.ipcGid,
          size: result.artifacts.receipt.bytes, sha256: result.artifacts.receipt.sha256 });
        Object.assign(output, { pdfBase64: pdf.toString("base64"), receipt: receipt.value });
      }
      await acknowledge();
      return Object.freeze(output);
    } finally {
      const remaining = (activeRequests.get(request.requestId) ?? 1) - 1;
      if (remaining === 0) activeRequests.delete(request.requestId);
      else activeRequests.set(request.requestId, remaining);
    }
  }

  function render({ kind, processorRequest, input }) {
    let request;
    try { request = createRendererRequest({ kind, processorRequest, input,
      acceptanceReceiptHash: acceptance.hash }); }
    catch (error) { return Promise.reject(error); }
    const current = renderFlights.get(request.requestId);
    if (current) return subscribe(current);
    const flight = performRender(request);
    renderFlights.set(request.requestId, flight);
    void flight.finally(() => {
      if (renderFlights.get(request.requestId) === flight) renderFlights.delete(request.requestId);
    }).catch(() => {});
    return subscribe(flight);
  }

  async function cancel(requestId, requestHash) {
    if (!/^[a-f0-9]{64}$/u.test(requestId) || requestHash !== requestId) throw new Error("renderer_cancel_invalid");
    await requestCancellation(requestId);
  }

  return Object.freeze({ protocol: acceptance.receipt.profile, render, cancel,
    ready: async () => { await startup; return notifyRendererControl(socketPath, { operation: "ready",
      requestId: acceptance.hash, requestHash: acceptance.hash }, timing.coldStartTimeoutMs); },
    reconcile: scheduleReconciliation,
    close() { closed = true; clearInterval(reconciler); }, acceptance,
    paths, socketPath });
}
