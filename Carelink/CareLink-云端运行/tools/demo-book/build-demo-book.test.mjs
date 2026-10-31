import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateFrozenManifest, renderCanonicalHtml } from "../../packages/book-renderer/src/render.mjs";
import { MEMORY_ENTRIES, PHOTO_FILES } from "./content.mjs";
import { buildDemoManifest } from "./manifest.mjs";

function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

// Synthetic per-photo bytes — content is opaque to the manifest builder, so a small deterministic
// buffer per photoId is enough to exercise every hash/shape invariant without touching the real
// asset files under ~/code/unseen-assets. Keeps this test hermetic and independent of machine setup.
function fakePhotos() {
  const photos = new Map();
  for (const { photoId } of PHOTO_FILES) {
    const bytes = Buffer.from(`fake-jpeg-bytes-for-${photoId}`);
    const contentHash = sha256(bytes);
    photos.set(photoId, { bytes, dataUri: `data:image/jpeg;base64,${bytes.toString("base64")}`, contentHash, mimeType: "image/jpeg" });
  }
  return photos;
}

test("buildDemoManifest produces a manifest that passes the renderer's own validateFrozenManifest", () => {
  const { manifest, resolveAsset } = buildDemoManifest(fakePhotos());
  const equality = validateFrozenManifest(manifest, resolveAsset);
  assert.equal(equality.pageCount, MEMORY_ENTRIES.length + 2, "cover + one page per Q&A entry + closing");
  assert.ok(equality.pageCount >= 12 && equality.pageCount <= 16, "page count must satisfy the renderer's 12-16 bound");
});

test("buildDemoManifest: page order is cover, memory pages in content order, closing", () => {
  const { manifest } = buildDemoManifest(fakePhotos());
  assert.equal(manifest.pages[0].kind, "cover");
  assert.equal(manifest.pages.at(-1).kind, "closing");
  for (let i = 1; i < manifest.pages.length - 1; i += 1) assert.equal(manifest.pages[i].kind, "memory");
  const orderedSourceIds = manifest.pages.slice(1, -1).map((page) => page.sourcePhotoId);
  assert.deepEqual(orderedSourceIds, MEMORY_ENTRIES.map((entry) => entry.photoId));
});

test("buildDemoManifest: every source photo in content.mjs is used and every used photo has a frozen asset", () => {
  const { manifest } = buildDemoManifest(fakePhotos());
  const assetPhotoIds = new Set(manifest.frozenAssets.map((asset) => asset.photoId));
  assert.equal(assetPhotoIds.size, PHOTO_FILES.length);
  for (const entry of MEMORY_ENTRIES) assert.ok(assetPhotoIds.has(entry.photoId), `frozen asset missing for ${entry.photoId}`);
});

test("buildDemoManifest: answer/author text stays within the renderer's per-page and credit length limits", () => {
  const { manifest } = buildDemoManifest(fakePhotos());
  for (const text of manifest.authorizedMemoryTexts) {
    assert.ok(Array.from(text.originalUserText).length <= 900, "answer must be <= 900 Unicode characters");
    assert.ok(text.authorCredit.length >= 1 && text.authorCredit.length <= 120, "author credit must be 1-120 characters");
    assert.equal(text.audienceScope, "current_live_space_viewers");
  }
});

test("buildDemoManifest: content contains no real personal names — only the neutral collective credit", () => {
  const { manifest } = buildDemoManifest(fakePhotos());
  const credits = new Set(manifest.authorizedMemoryTexts.map((text) => text.authorCredit));
  assert.deepEqual([...credits], ["朋友们"]);
});

test("renderCanonicalHtml renders the demo manifest to self-contained, CSP-safe HTML with no remote resources or scripts", () => {
  const { manifest, resolveAsset } = buildDemoManifest(fakePhotos());
  const result = renderCanonicalHtml(manifest, resolveAsset, "fixture");
  assert.ok(result.html.includes(manifest.title));
  assert.doesNotMatch(result.html, /<script\b/iu);
  assert.doesNotMatch(result.html, /(?:src|href)=["'](?:https?:)?\/\//iu);
  for (const entry of MEMORY_ENTRIES) {
    assert.ok(result.html.includes(entry.question), `question missing from rendered HTML: ${entry.question}`);
    assert.ok(result.html.includes(entry.answer), `answer missing from rendered HTML: ${entry.answer}`);
  }
});
