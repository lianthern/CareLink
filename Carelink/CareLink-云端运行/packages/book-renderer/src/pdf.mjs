import { constants, accessSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256, assert } from "./canonical.mjs";
import { validateChromiumSnapHeadlessInvocation } from
  "../../../infra/integration/book-lab/chromium-snap-headless-adapter.mjs";

const browserCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];
const BROWSER_OUTPUT_LIMIT = 64 * 1024;
const BROWSER_TIMEOUT_MS = 60_000;
const BROWSER_TERMINATION_GRACE_MS = 1_000;
const PDF_STABILITY_MS = 100;
const PDF_POLL_MS = 25;

function samePdfSnapshot(left, right) {
  return left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.contentHash === right.contentHash;
}

async function completePdfSnapshot(pdfPath) {
  let before;
  let bytes;
  let after;
  try {
    before = await stat(pdfPath, { bigint: true });
    if (!before.isFile() || before.size < 32n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    bytes = await readFile(pdfPath);
    after = await stat(pdfPath, { bigint: true });
  }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== after.size ||
    bytes.subarray(0, 5).toString() !== "%PDF-") return null;
  const tailStart = Math.max(0, bytes.length - 4_096);
  const tail = bytes.subarray(tailStart).toString("latin1");
  const boundary = /startxref\s+(\d+)\s+%%EOF\s*$/u.exec(tail);
  if (!boundary) return null;
  const xrefOffset = Number(boundary[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 5 || xrefOffset >= tailStart + boundary.index) return null;
  const xref = bytes.subarray(xrefOffset, Math.min(bytes.length, xrefOffset + 128)).toString("latin1");
  if (!/^(?:xref\b|\d+\s+\d+\s+obj\b)/u.test(xref)) return null;
  return { size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs, contentHash: sha256(bytes) };
}

function printWithLocalBrowser(command, args, pdfPath) {
  return new Promise((resolve, reject) => {
    const posixGroup = process.platform !== "win32";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: posixGroup });
    let stdout = "";
    let stderr = "";
    let failure = null;
    let stdoutLength = 0;
    let stderrLength = 0;
    let artifactCandidate = null;
    let artifactChecking = false;
    let childClosed = false;
    let shutdownRequested = false;
    let timeout = null;
    let artifactTimer = null;
    let graceTimer = null;
    let cleanupTimer = null;
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(artifactTimer);
      clearTimeout(graceTimer);
      clearInterval(cleanupTimer);
      if (error) reject(error);
      else resolve();
    };
    const groupAlive = () => {
      if (!child.pid) return false;
      if (!posixGroup) return !childClosed;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return error.code !== "ESRCH"; }
    };
    const signalGroup = (signal) => {
      try {
        if (posixGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { try { child.kill(signal); } catch {} }
    };
    const finishIfClean = () => {
      if (shutdownRequested && childClosed && !groupAlive()) finish(failure);
    };
    const shutDown = (error = null) => {
      if (error && !failure) failure = error;
      if (shutdownRequested) return;
      shutdownRequested = true;
      clearTimeout(timeout);
      clearInterval(artifactTimer);
      signalGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        if (groupAlive()) signalGroup("SIGKILL");
        cleanupTimer = setInterval(finishIfClean, 10);
        finishIfClean();
      }, BROWSER_TERMINATION_GRACE_MS);
      finishIfClean();
    };
    const collect = (target, length, chunk) => {
      const nextLength = length + chunk.length;
      if (nextLength > BROWSER_OUTPUT_LIMIT) shutDown(new Error("pdf_print_output_too_large"));
      return { value: nextLength > BROWSER_OUTPUT_LIMIT ? target : target + chunk.toString("utf8"),
        length: nextLength };
    };
    const checkArtifact = async () => {
      if (artifactChecking || shutdownRequested) return;
      artifactChecking = true;
      try {
        const snapshot = await completePdfSnapshot(pdfPath);
        if (snapshot === null) artifactCandidate = null;
        else if (artifactCandidate && samePdfSnapshot(artifactCandidate, snapshot) &&
          Date.now() - artifactCandidate.observedAt >= PDF_STABILITY_MS) shutDown();
        else if (!artifactCandidate || !samePdfSnapshot(artifactCandidate, snapshot)) {
          artifactCandidate = { ...snapshot, observedAt: Date.now() };
        }
        if (!shutdownRequested && childClosed && !groupAlive()) {
          if (snapshot !== null) shutDown();
          else shutDown(new Error(`pdf_print_failed:${stderr || stdout}`));
        }
      } catch (error) {
        shutDown(error);
      } finally {
        artifactChecking = false;
      }
    };
    child.stdout.on("data", (chunk) => {
      const collected = collect(stdout, stdoutLength, chunk);
      stdout = collected.value;
      stdoutLength = collected.length;
    });
    child.stderr.on("data", (chunk) => {
      const collected = collect(stderr, stderrLength, chunk);
      stderr = collected.value;
      stderrLength = collected.length;
    });
    child.once("error", (error) => shutDown(error));
    child.once("close", (code, signal) => {
      childClosed = true;
      if (shutdownRequested) return finishIfClean();
      if (code !== 0 || signal !== null) failure = new Error(`pdf_print_failed:${stderr || stdout}`);
      void checkArtifact();
    });
    timeout = setTimeout(() => shutDown(new Error("pdf_print_timeout")), BROWSER_TIMEOUT_MS);
    artifactTimer = setInterval(() => { void checkArtifact(); }, PDF_POLL_MS);
    void checkArtifact();
  });
}

export function findLocalBrowser() {
  const configured = process.env.UNSEEN_CHROMIUM_PATH;
  const candidates = configured === undefined ? browserCandidates : [configured];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(configured === undefined ? "local_chromium_not_found" : "configured_chromium_not_executable");
}

function canonicalPdfDate(timestamp) {
  const date = new Date(timestamp);
  assert(Number.isFinite(date.valueOf()), "canonical_pdf_timestamp_invalid");
  const compact = date.toISOString().replaceAll(/[-:T]/gu, "").slice(0, 14);
  return `D:${compact}+00'00'`;
}

export async function printExactHtmlToPdf({ html, htmlPath, pdfPath, orderedPageIds, pageOrderMarkers = null, canonicalTimestamp,
  browserPath, browserInvocation = null, outerSandboxVerified }) {
  assert(outerSandboxVerified === undefined || typeof outerSandboxVerified === "boolean", "outer_sandbox_verification_invalid");
  assert(browserInvocation === null || outerSandboxVerified === true, "browser_invocation_invalid");
  if (browserInvocation !== null) {
    try { validateChromiumSnapHeadlessInvocation(browserInvocation, { htmlPath, pdfPath }); }
    catch { throw new Error("browser_invocation_invalid"); }
  }
  await writeFile(htmlPath, html, { mode: 0o600 });
  await chmod(htmlPath, 0o600);
  const persistedHtml = await readFile(htmlPath);
  assert(sha256(persistedHtml) === sha256(html), "persisted_html_hash_mismatch");
  const browserArguments = browserInvocation?.arguments ?? [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-pdf-header-footer",
    "--run-all-compositor-stages-before-draw",
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href
  ];
  let browserProfile = null;
  try {
    if (browserInvocation === null) {
      browserProfile = await mkdtemp(join(dirname(pdfPath), ".chromium-profile-"));
      await chmod(browserProfile, 0o700);
      browserArguments.splice(1, 0, `--user-data-dir=${browserProfile}`);
      if (outerSandboxVerified === true) browserArguments.splice(1, 0, "--no-sandbox");
    }
    const command = browserInvocation?.command ?? browserPath ?? findLocalBrowser();
    await rm(pdfPath, { force: true });
    if (browserInvocation === null) await printWithLocalBrowser(command, browserArguments, pdfPath);
    else {
      const result = spawnSync(command, browserArguments, { encoding: "utf8", timeout: 60_000,
        env: browserInvocation.environment });
      assert(result.status === 0, "pdf_print_failed");
    }
  } finally {
    if (browserProfile) await rm(browserProfile, { recursive: true, force: true });
  }
  const printedPdf = await readFile(pdfPath);
  const replacement = canonicalPdfDate(canonicalTimestamp);
  let metadataCount = 0;
  const normalized = printedPdf.toString("latin1").replace(/\/(CreationDate|ModDate) \(D:\d{14}[+-]\d{2}'\d{2}'\)/gu, (_match, field) => {
    metadataCount += 1;
    return `/${field} (${replacement})`;
  });
  assert(metadataCount === 2, "pdf_metadata_shape_changed");
  const pdf = Buffer.from(normalized, "latin1");
  await writeFile(pdfPath, pdf, { mode: 0o600 });
  await chmod(pdfPath, 0o600);
  assert(pdf.subarray(0, 5).toString() === "%PDF-", "pdf_signature_invalid");

  const info = spawnSync("pdfinfo", [pdfPath], { encoding: "utf8", timeout: 10_000 });
  assert(info.status === 0, "pdfinfo_failed");
  const pageCount = Number(info.stdout.match(/^Pages:\s+(\d+)/mu)?.[1]);
  const text = spawnSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", timeout: 20_000 });
  assert(text.status === 0, "pdftotext_failed");
  let cursor = -1;
  const orderedMarkersVerified = pageOrderMarkers === null ? orderedPageIds.every((pageId) => {
    cursor = text.stdout.indexOf(pageId, cursor + 1);
    return cursor >= 0;
  }) : (() => {
    assert(Array.isArray(pageOrderMarkers) && pageOrderMarkers.length === orderedPageIds.length,
      "pdf_page_markers_invalid");
    // V1 binds canonical source ordering in the exact HTML, then checks each PDF page's
    // human-readable footer independently. No UUID needs to be printed into body copy.
    let htmlCursor = -1;
    const sourceOrder = orderedPageIds.every(pageId => {
      htmlCursor = html.indexOf(`data-page-id="${pageId}"`, htmlCursor + 1);
      return htmlCursor >= 0;
    });
    const pages = text.stdout.split("\f");
    return sourceOrder && pageCount === orderedPageIds.length && pageOrderMarkers.every((marker, index) =>
      typeof marker === "string" && pages[index]?.split("\n").some(line => line.trim().endsWith(marker)));
  })();
  return { contentHash: sha256(pdf), pageCount, orderedMarkersVerified, byteLength: pdf.length };
}
