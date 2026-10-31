import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixtureBundle, fixtureHash, resolveFixtureAsset } from "../fixtures/frozen-book-fixture.mjs";
import { canonicalize, manifestSemanticHash, sha256 } from "../src/canonical.mjs";
import { buildRenderReceipt, renderCanonicalHtml, validateFrozenManifest } from "../src/render.mjs";
import { findLocalBrowser, printExactHtmlToPdf } from "../src/pdf.mjs";
import { assertFixturePageText, inspectFixturePdf } from "./pdf-semantic-helper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const fixtureHtmlHash = "b06786fd229bee4721d31532a2a17c8d88f6d9dc0adb47466b1d6b38aeb9d7cd";
const fixturePdfHash = "a4ce30c3d156707e81f1b7069a7c30af9f6860e426f46494fce8a3ebebcd598a";
let currentFixturePromise;
function currentFixture() {
  // The committed golden remains intact as historical evidence. Pin reproducibility to
  // the actual installed browser, while separately checking every page against the manifest.
  return currentFixturePromise ||= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "unseen-book-current-reference-"));
    try {
      const html = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
      const pdfPath = join(directory, "book.pdf");
      const pdf = await printExactHtmlToPdf({ html:html.html, htmlPath:join(directory,"book.html"), pdfPath,
        orderedPageIds:html.equality.orderedPageIds, canonicalTimestamp:fixtureBundle.manifest.frozenAt });
      const inspected = await inspectFixturePdf(pdfPath, fixtureBundle.manifest, pdf);
      const historical = await inspectFixturePdf(resolve(packageRoot, "tests/evidence/book.pdf"), fixtureBundle.manifest);
      if (inspected.creator === historical.creator && inspected.producer === historical.producer) {
        assert.deepEqual(inspected.bytes, historical.bytes, "the original browser/OS PDF signature must still match the exact golden");
      }
      return { ...inspected, pdf };
    } finally { await rm(directory, { recursive:true, force:true }); }
  })();
}

test("historical PDF golden keeps its exact hash and original words; semantics reject missing words and reordered pages", async () => {
  const historical = await inspectFixturePdf(resolve(packageRoot, "tests/evidence/book.pdf"), fixtureBundle.manifest);
  assert.equal(sha256(historical.bytes), fixturePdfHash, "historical evidence is immutable");
  const text = fixtureBundle.manifest.authorizedMemoryTexts[0].originalUserText;
  const missing = [...historical.pages]; missing[1] = missing[1].replace(text.slice(0, 8), "被替换了的文字");
  assert.throws(() => assertFixturePageText(missing, fixtureBundle.manifest), /complete original user words/u);
  const reordered = [...historical.pages]; [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  assert.throws(() => assertFixturePageText(reordered, fixtureBundle.manifest), /order marker/u);
});

function rehashTextMutation(manifest, textIndex = 0) {
  const text = manifest.authorizedMemoryTexts[textIndex];
  text.confirmedSubmissionHash = sha256(text.originalUserText);
  const page = manifest.pages.find((item) => item.authorizedMemoryTextId === text.authorizedMemoryTextId);
  page.confirmedSubmissionHash = text.confirmedSubmissionHash;
  const { snapshotHash: _ignored, ...semantic } = text;
  text.snapshotHash = sha256(canonicalize(semantic));
  manifest.authorizedMemoryTextSnapshotHash = sha256(canonicalize(manifest.authorizedMemoryTexts));
  manifest.manifestHash = manifestSemanticHash(manifest);
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function processExited(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return !processIsAlive(pid);
}

async function writeQuietResidentBrowser(directory) {
  const wrapper = join(directory, "quiet-resident-browser.sh");
  const source = `#!/bin/sh
${JSON.stringify(findLocalBrowser())} "$@" >/dev/null 2>&1 &
browser_pid=$!
wait "$browser_pid"
while :; do sleep 60; done
`;
  await writeFile(wrapper, source, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function writeNoisyBrowserWithDescendant(directory, helperPidPath) {
  const wrapper = join(directory, "noisy-browser-with-descendant.sh");
  const source = `#!/bin/sh
/bin/sleep 60 </dev/null >/dev/null 2>&1 &
printf '%s' "$!" > ${JSON.stringify(helperPidPath)}
i=0
while [ "$i" -lt 2048 ]; do
  printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' >&2
  i=$((i + 1))
done
wait
`;
  await writeFile(wrapper, source, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function writeBrowserArgumentRecorder(directory, argsPath) {
  const wrapper = join(directory, "browser-wrapper.sh");
  const source = `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}
exec ${JSON.stringify(findLocalBrowser())} "$@"
`;
  await writeFile(wrapper, source, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

test("fixture is one event, 14 confirmed photos, four contributors, one question each and 16 pages", () => {
  assert.equal(fixtureBundle.event.panorama.status, "ready");
  assert.equal(fixtureBundle.photos.length, 14);
  assert.equal(new Set(fixtureBundle.photos.map((photo) => photo.contributorId)).size, 4);
  assert.ok(fixtureBundle.photos.every((photo) => photo.status === "confirmed_current" && photo.mainQuestionCount === 1));
  assert.equal(fixtureBundle.manifest.pages.length, 16);
  assert.equal(fixtureBundle.manifest.title, fixtureBundle.book.title);
  assert.deepEqual(fixtureBundle.conflict.sourcePhotoIds, ["photo-04", "photo-05"]);
  assert.match(fixtureHash, /^[a-f0-9]{64}$/u);
});

test("canonical HTML is self-contained, escaped, provenance-complete and script-free", () => {
  const result = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
  assert.equal(result.htmlHash, fixtureHtmlHash);
  assert.equal(result.equality.pageCount, 16);
  assert.equal((result.html.match(/class="book-page/g) ?? []).length, 16);
  assert.equal((result.html.match(/确定性本地样本/g) ?? []).length, 17);
  assert.ok(fixtureBundle.manifest.authorizedMemoryTexts.every((text) => result.html.includes(text.originalUserText)));
  assert.ok(fixtureBundle.manifest.authorizedMemoryTexts.every((text) => result.html.includes(text.authorCredit)));
  assert.doesNotMatch(result.html, /<script\b/iu);
  assert.doesNotMatch(result.html, /(?:src|href)=["'](?:https?:)?\/\//iu);
  assert.match(result.html, /nodeId=null/u);
  assert.match(result.html, /unicode-bidi:plaintext/u);
  assert.match(result.html, /prefers-reduced-motion/u);
  assert.match(result.html, /UNSEEN · 共同记忆/u);
  assert.doesNotMatch(result.html, /ADVENTUREX 2026|一晚，四种视角/u);
  assert.match(result.html, new RegExp(`<title>${fixtureBundle.manifest.title} · 确定性本地样本</title>`, "u"));
  assert.match(result.html, new RegExp(`<h1>${fixtureBundle.manifest.title}</h1>`, "u"));
});

test("cover renders its exact display asset instead of the first frozen asset", () => {
  const manifest = structuredClone(fixtureBundle.manifest);
  const cover = manifest.pages.find((page) => page.kind === "cover");
  cover.displayPhotoId = "photo-02";
  manifest.manifestHash = manifestSemanticHash(manifest);
  const result = renderCanonicalHtml(manifest, resolveFixtureAsset, "fixture");
  const expected = resolveFixtureAsset("fixture-asset:photo-02").dataUri;
  const first = resolveFixtureAsset("fixture-asset:photo-01").dataUri;
  const coverHtml = result.html.match(/<section class="book-page cover"[\s\S]*?<\/section>/u)?.[0];
  assert.ok(coverHtml?.includes('data-display-photo-id="photo-02"'));
  assert.ok(coverHtml?.includes(`<img class="cover-photo" src="${expected}"`));
  assert.ok(!coverHtml?.includes(`<img class="cover-photo" src="${first}"`));
});

test("cover requires a frozen display asset and closing rejects one", () => {
  const missingCover = structuredClone(fixtureBundle.manifest);
  missingCover.pages.find((page) => page.kind === "cover").displayPhotoId = null;
  missingCover.manifestHash = manifestSemanticHash(missingCover);
  assert.throws(() => renderCanonicalHtml(missingCover, resolveFixtureAsset, "fixture"), /cover_display_asset_missing/u);

  const picturedClosing = structuredClone(fixtureBundle.manifest);
  picturedClosing.pages.find((page) => page.kind === "closing").displayPhotoId = "photo-01";
  picturedClosing.manifestHash = manifestSemanticHash(picturedClosing);
  assert.throws(() => renderCanonicalHtml(picturedClosing, resolveFixtureAsset, "fixture"), /closing_display_asset_forbidden/u);
});

test("frozen title is required, hashed and is the only title rendered", () => {
  const missing = structuredClone(fixtureBundle.manifest);
  delete missing.title;
  missing.manifestHash = manifestSemanticHash(missing);
  assert.throws(() => validateFrozenManifest(missing, resolveFixtureAsset), /title_invalid/u);

  const edited = structuredClone(fixtureBundle.manifest);
  edited.title = "灯熄以后，我们还在";
  edited.manifestHash = manifestSemanticHash(edited);
  const result = renderCanonicalHtml(edited, resolveFixtureAsset, "fixture");
  assert.notEqual(edited.manifestHash, fixtureBundle.manifest.manifestHash);
  assert.match(result.html, /<title>灯熄以后，我们还在 · 确定性本地样本<\/title>/u);
  assert.match(result.html, /<h1>灯熄以后，我们还在<\/h1>/u);
  assert.doesNotMatch(result.html, /<h1>共光以后<\/h1>/u);
});

test("contributor text is context-escaped and never becomes active markup", () => {
  const manifest = structuredClone(fixtureBundle.manifest);
  manifest.authorizedMemoryTexts[0].originalUserText = `<img src=x onerror=alert(1)><script>alert(2)</script>مرحبا`;
  rehashTextMutation(manifest);
  const result = renderCanonicalHtml(manifest, resolveFixtureAsset, "fixture");
  assert.doesNotMatch(result.html, /<script>alert/iu);
  assert.doesNotMatch(result.html, /<img src=x/iu);
  assert.match(result.html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;مرحبا/u);
  assert.match(result.html, /blockquote dir="auto"/u);
});

test("remote assets and content that cannot fit a page fail closed", () => {
  const remote = structuredClone(fixtureBundle.manifest);
  remote.frozenAssets[0].localAssetRef = "https://example.invalid/photo.jpg";
  remote.assetSnapshotHash = sha256(canonicalize(remote.frozenAssets));
  remote.manifestHash = manifestSemanticHash(remote);
  assert.throws(() => validateFrozenManifest(remote, resolveFixtureAsset), /remote_asset_forbidden/u);

  const overflow = structuredClone(fixtureBundle.manifest);
  overflow.authorizedMemoryTexts[0].originalUserText = "很长的原话。".repeat(200);
  rehashTextMutation(overflow);
  assert.throws(() => renderCanonicalHtml(overflow, resolveFixtureAsset, "fixture"), /page_text_overflow/u);
});

test("cross-book text and page/text provenance mismatch fail closed", () => {
  const crossBook = structuredClone(fixtureBundle.manifest);
  crossBook.authorizedMemoryTexts[0].bookId = "book-from-another-space";
  rehashTextMutation(crossBook);
  assert.throws(() => validateFrozenManifest(crossBook, resolveFixtureAsset), /authorized_text_book_mismatch/u);

  const provenanceDrift = structuredClone(fixtureBundle.manifest);
  const page = provenanceDrift.pages.find((item) => item.kind === "memory");
  page.sourceProvenance = { ...page.sourceProvenance, placementRevisionId: "placement-revision-from-another-source" };
  provenanceDrift.manifestHash = manifestSemanticHash(provenanceDrift);
  assert.throws(() => validateFrozenManifest(provenanceDrift, resolveFixtureAsset), /source_provenance_mismatch/u);
});

test("render profiles are explicit, closed and receipt-bound", () => {
  assert.throws(() => renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset), /render_profile_invalid/u);
  assert.throws(() => renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "preview"), /render_profile_invalid/u);
  const fixture = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
  const pdf = { pageCount: fixture.equality.pageCount, orderedMarkersVerified: true, contentHash: "0".repeat(64) };
  assert.throws(() => buildRenderReceipt(fixtureBundle.manifest, fixture, pdf), /render_profile_invalid/u);
  assert.throws(() => buildRenderReceipt(fixtureBundle.manifest, fixture, pdf, "preview"), /render_profile_invalid/u);
  assert.throws(() => buildRenderReceipt(fixtureBundle.manifest, fixture, pdf, "production"), /render_profile_mismatch/u);
  assert.throws(() => buildRenderReceipt(fixtureBundle.manifest, { ...fixture, html: `${fixture.html} ` }, pdf, "fixture"), /render_html_hash_mismatch/u);
  assert.throws(() => buildRenderReceipt({ ...fixtureBundle.manifest, title: "另一份 manifest" }, fixture, pdf, "fixture"), /render_manifest_equality_mismatch/u);
});

test("production profile removes fixture presentation but keeps authorization and provenance copy", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "unseen-book-production-profile-"));
  try {
    const htmlPath = join(directory, "book.html");
    const pdfPath = join(directory, "book.pdf");
    const screenshotPath = join(directory, "book.png");
    const result = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "production");
    assert.equal(result.renderProfile, "production");
    assert.match(result.html, new RegExp(`<title>${fixtureBundle.manifest.title}</title>`, "u"));
    assert.doesNotMatch(result.html, /确定性本地样本|非真实 AI/u);
    assert.doesNotMatch(result.html, /fixture-stamp/u);
    assert.match(result.html, /每段原话保留署名、现场方向与授权版本/u);
    assert.match(result.html, /若有人撤回，旧数字版会停止提供/u);
    assert.ok(fixtureBundle.manifest.authorizedMemoryTexts.every((text) => result.html.includes(text.originalUserText)));
    assert.match(result.html, new RegExp(`<meta name="unseen-manifest-hash" content="${fixtureBundle.manifest.manifestHash}"/>`, "u"));

    const pdf = await printExactHtmlToPdf({ html: result.html, htmlPath, pdfPath,
      orderedPageIds: result.equality.orderedPageIds, canonicalTimestamp: fixtureBundle.manifest.frozenAt });
    const receipt = buildRenderReceipt(fixtureBundle.manifest, result, pdf, "production");
    assert.equal(receipt.renderProfile, "production");
    assert.equal(receipt.fixtureOnly, false);
    assert.equal(receipt.input.manifestHash, fixtureBundle.manifest.manifestHash);
    assert.equal(receipt.equality.manifestHash, fixtureBundle.manifest.manifestHash);
    assert.equal(receipt.html.contentHash, result.htmlHash);
    assert.equal(receipt.pdf.contentHash, pdf.contentHash);

    const screenshot = spawnSync(findLocalBrowser(), ["--headless=new", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--disable-sync", "--no-first-run",
      "--hide-scrollbars", "--window-size=1440,1100", `--screenshot=${screenshotPath}`,
      `file://${htmlPath}`], { encoding: "utf8", timeout: 60_000 });
    assert.equal(screenshot.status, 0, screenshot.stderr || screenshot.stdout);
    assert.equal((await readFile(screenshotPath)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const text = spawnSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", timeout: 20_000 });
    assert.equal(text.status, 0, text.stderr);
    assert.doesNotMatch(text.stdout, /确定性本地样本|非真实 AI/u);
    assert.match(text.stdout, new RegExp(fixtureBundle.manifest.authorizedMemoryTexts[0].authorCredit, "u"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default PDF launch isolates and cleans its Chromium profile while retaining the sandbox", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "unseen-book-browser-sandbox-"));
  try {
    const argsPath = join(directory, "browser-args.json");
    const browserPath = await writeBrowserArgumentRecorder(directory, argsPath);
    const htmlResult = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
    const input = { html: htmlResult.html, htmlPath: join(directory, "book.html"),
      pdfPath: join(directory, "book.pdf"), orderedPageIds: htmlResult.equality.orderedPageIds,
      canonicalTimestamp: fixtureBundle.manifest.frozenAt, browserPath };
    await assert.rejects(printExactHtmlToPdf({ ...input, outerSandboxVerified: "true" }),
      /outer_sandbox_verification_invalid/u);
    const pdf = await printExactHtmlToPdf({ ...input, outerSandboxVerified: false });
    const args = (await readFile(argsPath, "utf8")).trimEnd().split("\n");
    assert.ok(!args.includes("--no-sandbox"));
    const profileArgument = args.find((value) => value.startsWith("--user-data-dir="));
    assert.ok(profileArgument, "each PDF render must use an explicit private Chromium profile");
    const profile = profileArgument.slice("--user-data-dir=".length);
    assert.equal(dirname(profile), directory);
    await assert.rejects(stat(profile), { code: "ENOENT" });
    assert.equal((await readFile(input.pdfPath)).subarray(0, 5).toString(), "%PDF-");
    assert.match(pdf.contentHash, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("each browser invocation requires a fresh PDF and cannot reuse a complete stale target", {
  timeout: 90_000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "unseen-book-fresh-pdf-"));
  try {
    const htmlResult = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
    const htmlPath = join(directory, "book.html");
    const pdfPath = join(directory, "book.pdf");
    const input = { html: htmlResult.html, htmlPath, pdfPath,
      orderedPageIds: htmlResult.equality.orderedPageIds,
      canonicalTimestamp: fixtureBundle.manifest.frozenAt };
    const stalePdf = await readFile(resolve(packageRoot, "tests/evidence/book.pdf"));
    await writeFile(pdfPath, stalePdf, { mode: 0o600 });
    await assert.rejects(printExactHtmlToPdf({ ...input, browserPath: "/usr/bin/true" }),
      /pdf_print_failed/u, "a successful non-writer must not reuse an old valid PDF");
    await assert.rejects(stat(pdfPath), { code: "ENOENT" });

    const freshPdf = await printExactHtmlToPdf(input);
    const freshBytes = await readFile(pdfPath);
    assert.equal(freshPdf.contentHash, sha256(freshBytes));
    await inspectFixturePdf(pdfPath, fixtureBundle.manifest, freshPdf);
    assert.deepEqual(freshBytes, (await currentFixture()).bytes,
      "the current browser must recreate the exact current reference, after the stale target was removed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PDF readiness does not depend on Chromium's English completion log or browser exit", {
  timeout: 75_000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "unseen-book-quiet-browser-"));
  try {
    const browserPath = await writeQuietResidentBrowser(directory);
    const htmlResult = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
    const pdfPath = join(directory, "book.pdf");
    const pdf = await printExactHtmlToPdf({ html: htmlResult.html, htmlPath: join(directory, "book.html"),
      pdfPath, orderedPageIds: htmlResult.equality.orderedPageIds,
      canonicalTimestamp: fixtureBundle.manifest.frozenAt, browserPath });
    assert.equal((await readFile(pdfPath)).subarray(0, 5).toString(), "%PDF-");
    assert.match(pdf.contentHash, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local browser failure removes descendants before returning", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "unseen-book-browser-group-"));
  const helperPidPath = join(directory, "helper.pid");
  let helperPid = null;
  t.after(() => { if (helperPid && processIsAlive(helperPid)) process.kill(helperPid, "SIGKILL"); });
  try {
    const browserPath = await writeNoisyBrowserWithDescendant(directory, helperPidPath);
    const htmlResult = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
    await assert.rejects(printExactHtmlToPdf({ html: htmlResult.html, htmlPath: join(directory, "book.html"),
      pdfPath: join(directory, "book.pdf"), orderedPageIds: htmlResult.equality.orderedPageIds,
      canonicalTimestamp: fixtureBundle.manifest.frozenAt, browserPath }), /pdf_print_output_too_large/u);
    helperPid = Number(await readFile(helperPidPath, "utf8"));
    assert.ok(Number.isInteger(helperPid) && helperPid > 0);
    assert.equal(await processExited(helperPid), true, `browser descendant ${helperPid} survived failure cleanup`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified macOS outer sandbox owns the process tree before Chromium sandbox bypass", {
  timeout: 90_000, skip: process.platform !== "darwin"
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "unseen-book-outer-sandbox-"));
  try {
    const argsPath = join(directory, "browser-args.json");
    const browserPath = await writeBrowserArgumentRecorder(directory, argsPath);
    const childPath = join(directory, "render-under-sandbox.mjs");
    const htmlPath = join(directory, "book.html");
    const pdfPath = join(directory, "book.pdf");
    const source = `import { fixtureBundle, resolveFixtureAsset } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "fixtures/frozen-book-fixture.mjs")).href)};
import { renderCanonicalHtml } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "src/render.mjs")).href)};
import { printExactHtmlToPdf } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "src/pdf.mjs")).href)};
const html = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
const pdf = await printExactHtmlToPdf({ html: html.html, htmlPath: ${JSON.stringify(htmlPath)},
  pdfPath: ${JSON.stringify(pdfPath)}, orderedPageIds: html.equality.orderedPageIds,
  canonicalTimestamp: fixtureBundle.manifest.frozenAt, browserPath: ${JSON.stringify(browserPath)},
  outerSandboxVerified: true });
process.stdout.write(JSON.stringify(pdf));
`;
    await writeFile(childPath, source, { mode: 0o600 });
    const sandboxProfile = "(version 1)(allow default)" +
      "(deny network-outbound (remote ip) (literal \"/private/var/run/mDNSResponder\"))" +
      "(deny network-inbound (local ip))(deny network-bind (local ip))";
    const child = spawnSync("/usr/bin/sandbox-exec", ["-p", sandboxProfile, process.execPath, childPath],
      { encoding: "utf8", timeout: 90_000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const pdf = JSON.parse(child.stdout);
    const args = (await readFile(argsPath, "utf8")).trimEnd().split("\n");
    assert.ok(args.includes("--no-sandbox"));
    assert.equal((await readFile(pdfPath)).subarray(0, 5).toString(), "%PDF-");
    await inspectFixturePdf(pdfPath, fixtureBundle.manifest, pdf);
    assert.deepEqual(await readFile(pdfPath), (await currentFixture()).bytes,
      "outer sandbox printing must produce the same exact bytes as the current isolated browser");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PDF prints the exact HTML bytes and verifies page/source order from the same manifest", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "unseen-book-render-"));
  const htmlPath = join(directory, "book.html");
  const pdfPath = join(directory, "book.pdf");
  const secondPdfPath = join(directory, "book-second.pdf");
  const htmlResult = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
  const pdf = await printExactHtmlToPdf({ html: htmlResult.html, htmlPath, pdfPath, orderedPageIds: htmlResult.equality.orderedPageIds, canonicalTimestamp: fixtureBundle.manifest.frozenAt });
  const secondPdf = await printExactHtmlToPdf({ html: htmlResult.html, htmlPath: join(directory, "book-second.html"), pdfPath: secondPdfPath, orderedPageIds: htmlResult.equality.orderedPageIds, canonicalTimestamp: fixtureBundle.manifest.frozenAt });
  const receipt = buildRenderReceipt(fixtureBundle.manifest, htmlResult, pdf, "fixture");
  const evidence = JSON.parse(await readFile(resolve(packageRoot, "tests/evidence/render-receipt.json"), "utf8"));
  delete evidence.fixtureHash;
  const current = await currentFixture();
  // Only the PDF byte hash is renderer-version-dependent. Every input, HTML and equality
  // field must still equal the untouched golden receipt. No original word can be omitted.
  assert.deepEqual({ ...receipt, pdf:{ ...receipt.pdf, contentHash:evidence.pdf.contentHash } }, evidence);
  await inspectFixturePdf(pdfPath, fixtureBundle.manifest, pdf);
  await inspectFixturePdf(secondPdfPath, fixtureBundle.manifest, secondPdf);
  assert.deepEqual(await readFile(pdfPath), current.bytes);
  assert.equal(receipt.html.pageCount, 16);
  assert.equal(receipt.pdf.pageCount, 16);
  assert.equal(receipt.equality.manifestHash, fixtureBundle.manifest.manifestHash);
  assert.equal(receipt.equality.title, fixtureBundle.manifest.title);
  assert.equal(receipt.equality.orderedSourceIds.length, 16);
  assert.equal(pdf.contentHash, secondPdf.contentHash);
  assert.deepEqual(await readFile(pdfPath), await readFile(secondPdfPath));
  assert.equal((await readFile(htmlPath, "utf8")), htmlResult.html);
  assert.equal((await readFile(pdfPath)).subarray(0, 5).toString(), "%PDF-");
});

test("configured Chromium fails closed without leaking a pre-spawn profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "unseen-book-missing-browser-"));
  const previous = process.env.UNSEEN_CHROMIUM_PATH;
  process.env.UNSEEN_CHROMIUM_PATH = resolve(tmpdir(), "unseen-chromium-does-not-exist");
  try {
    assert.throws(() => findLocalBrowser(), /configured_chromium_not_executable/u);
    await assert.rejects(printExactHtmlToPdf({ html: "<html><body>fixture</body></html>",
      htmlPath: join(directory, "book.html"), pdfPath: join(directory, "book.pdf"), orderedPageIds: [],
      canonicalTimestamp: fixtureBundle.manifest.frozenAt }), /configured_chromium_not_executable/u);
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith(".chromium-profile-")), []);
  } finally {
    if (previous === undefined) delete process.env.UNSEEN_CHROMIUM_PATH;
    else process.env.UNSEEN_CHROMIUM_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture CLI honors private output and configured Chromium paths", { timeout: 90_000 }, async () => {
  const privateRoot = await mkdtemp(join(tmpdir(), "unseen-book-cli-"));
  const outputDirectory = resolve(privateRoot, "artifacts");
  try {
    const result = spawnSync(process.execPath, ["src/cli.mjs"], {
      cwd: packageRoot,
      env: { ...process.env, UNSEEN_BOOK_OUTPUT_DIR: outputDirectory, UNSEEN_CHROMIUM_PATH: findLocalBrowser() },
      encoding: "utf8",
      timeout: 90_000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).outputDirectory, outputDirectory);
    assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
    for (const filename of ["book.html", "book.pdf", "render-receipt.json"]) {
      assert.equal((await stat(resolve(outputDirectory, filename))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});
