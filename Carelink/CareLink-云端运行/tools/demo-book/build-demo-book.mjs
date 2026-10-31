#!/usr/bin/env node
// Offline generator for the "夏日聚会" demo memory book. Mac-side, one-shot, not a server route —
// same posture as tools/depth-gen's offline artifact generator and
// services/api/scripts/attach-depth-artifact.mjs's attach step: a trusted operator runs this once
// against local files and gets back a self-contained HTML + PDF to hand off.
//
// It reuses packages/book-renderer's real, tested renderCanonicalHtml()/printExactHtmlToPdf()
// pipeline byte-for-byte — this script does not modify anything under packages/book-renderer. The
// one adaptation needed is that render.mjs's cover/closing copy is hardcoded to the AdventureX
// fixture's own narrative (event name, "十四张照片", "版本 02", withdrawal-mechanics copy that only
// applies to a book that went through the live BOOK.FREEZE flow). Since this demo book was NOT
// authorized through that live flow, those specific hardcoded strings are replaced below with
// accurate, clearly-labeled demo copy via exact-match text substitution — never by touching the
// renderer source. See replaceExactlyOnce(): every substitution asserts its target string occurs
// exactly once first, so this fails loudly instead of silently if the renderer's template ever
// changes upstream.
//
// Usage:
//   node tools/demo-book/build-demo-book.mjs [outputDir] [--assets-dir <dir>]
//
// Defaults: outputDir = ~/code/unseen-assets/demo-book, assets-dir = ~/code/unseen-assets/ai-template-space
// Requires a local Chromium/Chrome (see packages/book-renderer/src/pdf.mjs findLocalBrowser) and the
// `pdfinfo`/`pdftotext` CLIs (poppler) already required by that package's own tests.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../packages/book-renderer/src/canonical.mjs";
import { renderCanonicalHtml } from "../../packages/book-renderer/src/render.mjs";
import { printExactHtmlToPdf } from "../../packages/book-renderer/src/pdf.mjs";
import { BOOK_TITLE, FROZEN_AT, MEMORY_ENTRIES, PHOTO_FILES } from "./content.mjs";
import { buildDemoManifest } from "./manifest.mjs";
import { renderLandingPage } from "./landing-page.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../..");

function parseArgs(argv) {
  const rest = [...argv];
  let assetsDir = null;
  const assetsFlagIndex = rest.indexOf("--assets-dir");
  if (assetsFlagIndex !== -1) {
    assetsDir = rest[assetsFlagIndex + 1];
    rest.splice(assetsFlagIndex, 2);
  }
  const outputDir = rest[0] ?? null;
  return { outputDir, assetsDir };
}

function replaceExactlyOnce(html, target, replacement) {
  const parts = html.split(target);
  if (parts.length !== 2) {
    throw new Error(`demo_copy_substitution_target_not_unique:${JSON.stringify(target)} (found ${parts.length - 1} times)`);
  }
  return parts.join(replacement);
}

// Every hardcoded AdventureX-fixture string this demo book replaces, and what it becomes. Kept as
// an ordered list (not an object) so duplicate targets are impossible to accidentally shadow.
function applyDemoCopy(html, pageCount) {
  const substitutions = [
    // Cover eyebrow — carries the "演示内容 / 虚构示例" label front and center, page 1.
    ["ADVENTUREX 2026 · 一晚，四种视角", "虚构示例 · 一场夏日聚会"],
    // Cover subhead — states the real photo/answer counts and repeats the demo label.
    ["十四张照片，十四个只属于在场者的问题。",
      `${PHOTO_FILES.length}张照片，${MEMORY_ENTRIES.length}段问答，内容为虚构示例。`],
    // Cover rule line — the original references live authorization/version semantics this demo
    // never went through; replace with an honest description of what the page demonstrates.
    ["每段原话保留署名、现场方向与授权版本。", "内容为虚构示例，用于展示纪念册的排版与问答形式。"],
    // Closing eyebrow — "版本 02" is a specific fixture version number, not true of this demo.
    ["版本 02 ·", "演示版 ·"],
    // Closing headline — original implies the multi-viewpoint "记得不同" conflict device this demo
    // does not use (every page here has one photo, one Q&A, no competing accounts).
    ["记得不同，也可以一起留下。", "每一页，都是这晚被记住的一部分。"],
    // Closing body — original describes real per-user authorization that did not happen for this
    // hand-built manifest; replace with an accurate description of how this file was produced.
    ["这些回答没有被合并成唯一真相。每个人只为自己的原话署名，并只同意它进入这一版书。",
      "这是一次功能演示：问答内容为虚构示例，用来展示纪念册从照片到成书的样子。"],
    // Closing note — original describes live withdrawal behavior that only applies to a book
    // served through the real Book Lab pipeline, not this static demo file.
    ["若有人撤回，旧数字版会停止提供；已经下载到个人设备的文件无法由系统召回。",
      "本页由本地渲染流水线一次性生成，用于产品演示，不代表真实用户数据或真实的书本发布流程。"]
  ];
  let next = html;
  for (const [target, replacement] of substitutions) next = replaceExactlyOnce(next, target, replacement);
  // Re-assert the same safety invariants render.mjs itself enforces, since we just edited the HTML
  // text after its own asserts ran.
  if (/<script\b/iu.test(next)) throw new Error("active_script_forbidden_after_demo_copy");
  if (/(?:src|href)=["'](?:https?:)?\/\//iu.test(next)) throw new Error("remote_resource_forbidden_after_demo_copy");
  if (!next.includes("虚构示例")) throw new Error("demo_notice_missing_after_substitution");
  void pageCount;
  return next;
}

async function loadPhotos(assetsDir) {
  const photos = new Map();
  for (const { photoId, file } of PHOTO_FILES) {
    const filePath = path.join(assetsDir, file);
    let bytes;
    try {
      bytes = await readFile(filePath);
    } catch {
      throw new Error(`demo_photo_missing:${filePath}`);
    }
    const contentHash = sha256(bytes);
    const dataUri = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    photos.set(photoId, { bytes, dataUri, contentHash, mimeType: "image/jpeg", sourceFile: filePath });
  }
  return photos;
}

async function main() {
  const { outputDir: outputDirArg, assetsDir: assetsDirArg } = parseArgs(process.argv.slice(2));
  const assetsDir = path.resolve(assetsDirArg ?? path.join(homedir(), "code/unseen-assets/ai-template-space"));
  const outputDir = path.resolve(outputDirArg ?? path.join(homedir(), "code/unseen-assets/demo-book"));

  await mkdir(outputDir, { recursive: true, mode: 0o755 });

  const photos = await loadPhotos(assetsDir);
  const { manifest, resolveAsset } = buildDemoManifest(photos);

  const htmlResult = renderCanonicalHtml(manifest, resolveAsset, "fixture");
  const demoHtml = applyDemoCopy(htmlResult.html, htmlResult.equality.pageCount);

  const htmlPath = path.join(outputDir, "book.html");
  const pdfPath = path.join(outputDir, "book.pdf");
  const pdf = await printExactHtmlToPdf({
    html: demoHtml, htmlPath, pdfPath,
    orderedPageIds: htmlResult.equality.orderedPageIds,
    canonicalTimestamp: manifest.frozenAt
  });

  const receipt = {
    schemaVersion: "unseen-demo-book-receipt/1",
    notice: "演示内容 · 内容为虚构示例 · 非真实用户数据",
    generatedBy: "tools/demo-book/build-demo-book.mjs",
    generatedAt: new Date().toISOString(),
    bookId: manifest.bookId,
    versionId: manifest.versionId,
    title: manifest.title,
    manifestHash: manifest.manifestHash,
    frozenAt: manifest.frozenAt,
    html: { contentHash: sha256(demoHtml), byteLength: Buffer.byteLength(demoHtml), pageCount: htmlResult.equality.pageCount },
    pdf: { contentHash: pdf.contentHash, pageCount: pdf.pageCount, byteLength: pdf.byteLength, orderedMarkersVerified: pdf.orderedMarkersVerified },
    orderedPageIds: htmlResult.equality.orderedPageIds,
    sourcePhotos: PHOTO_FILES.map(({ photoId, file }) => ({ photoId, sourceFile: path.join(assetsDir, file), contentHash: photos.get(photoId).contentHash }))
  };
  await writeFile(path.join(outputDir, "render-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);

  const landingHtml = renderLandingPage({ title: BOOK_TITLE, pageCount: htmlResult.equality.pageCount, generatedAt: receipt.generatedAt });
  await writeFile(path.join(outputDir, "index.html"), landingHtml);

  for (const file of ["book.html", "book.pdf", "render-receipt.json", "index.html"]) {
    await chmod(path.join(outputDir, file), 0o644);
  }

  console.log(JSON.stringify({
    status: "DEMO_BOOK_BUILD_OK",
    outputDir,
    repoRoot,
    frozenAt: FROZEN_AT,
    pageCount: htmlResult.equality.pageCount,
    html: receipt.html,
    pdf: receipt.pdf
  }, null, 2));
}

main().catch((error) => {
  console.error(`build-demo-book: ${error.stack || error.message}`);
  process.exitCode = 1;
});
