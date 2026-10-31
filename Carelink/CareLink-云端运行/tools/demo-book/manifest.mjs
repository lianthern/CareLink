// Pure manifest assembly for the demo book. Takes already-loaded photo bytes (no filesystem access
// here, so this module is unit-testable with synthetic bytes — see build-demo-book.test.mjs) and
// produces a FrozenBookManifest plus a matching resolveAsset(localAssetRef) callback in exactly the
// shape packages/book-renderer/src/render.mjs's validateFrozenManifest()/renderCanonicalHtml()
// expect. Modeled on packages/book-renderer/fixtures/frozen-book-fixture.mjs's own buildManifest,
// but content-driven from ./content.mjs instead of the AdventureX fixture story.
import { canonicalize, manifestSemanticHash, sha256 } from
  "../../packages/book-renderer/src/canonical.mjs";
import { AUTHOR, BOOK_TITLE, COVER_PHOTO_ID, FROZEN_AT, MEMORY_ENTRIES, PHOTO_FILES } from
  "./content.mjs";

export const DEMO_ASSET_REF_PREFIX = "demo-asset:";
export const BOOK_ID = "book-demo-summer-gathering";
export const VERSION_ID = "book-version-demo-01";
export const DEMO_SPACE_ID = "space-demo-summer-gathering";

const provenanceFieldsOrder = [
  "spaceId", "photoId", "sceneId", "panoramaRevisionId", "placementRevisionId", "nodeId",
  "sourcePhotosVersion", "yawDegrees", "capturedAt", "authorId", "photoContentHash", "placementSnapshotHash"
];

function sourceProvenanceFor(photoId, photoContentHash, index, time) {
  const placementRevisionId = `placement-revision-demo-${String(index + 1).padStart(2, "0")}`;
  const placementSeed = `${photoId}|${placementRevisionId}|${time}`;
  const provenance = {
    spaceId: DEMO_SPACE_ID,
    photoId,
    sceneId: "scene-demo-courtyard-evening",
    panoramaRevisionId: "panorama-revision-demo-ready-01",
    placementRevisionId,
    nodeId: null,
    sourcePhotosVersion: 1,
    yawDegrees: (index * 29 + 11) % 360,
    capturedAt: `2026-08-16T${time}:00+08:00`,
    authorId: "contributor-demo-friends",
    photoContentHash,
    placementSnapshotHash: sha256(placementSeed)
  };
  // Keep a stable key order for readability; canonicalize() sorts keys anyway so this has no
  // effect on hashing.
  const ordered = {};
  for (const field of provenanceFieldsOrder) ordered[field] = provenance[field];
  return ordered;
}

function buildManifest(title, pages, authorizedMemoryTexts, frozenAssets) {
  const value = {
    bookId: BOOK_ID,
    versionId: VERSION_ID,
    title,
    authorizationSnapshotHash: sha256(canonicalize(authorizedMemoryTexts.map((item) =>
      ({ grantId: item.grantId, audienceScope: item.audienceScope })))),
    authorizedMemoryTextSnapshotHash: sha256(canonicalize(authorizedMemoryTexts)),
    assetSnapshotHash: sha256(canonicalize(frozenAssets)),
    pages,
    authorizedMemoryTexts,
    frozenAssets,
    frozenAt: FROZEN_AT
  };
  value.manifestHash = manifestSemanticHash(value);
  return value;
}

/**
 * @param {Map<string, {bytes: Buffer, dataUri: string, contentHash: string, mimeType: string}>} photos
 *   Keyed by photoId (see PHOTO_FILES in content.mjs). Byte content is opaque to this module — tests
 *   may pass synthetic buffers, the real CLI passes the actual JPEG bytes.
 * @returns {{ manifest: object, resolveAsset: (ref: string) => {bytes: Buffer, dataUri: string, contentHash: string} }}
 */
export function buildDemoManifest(photos) {
  for (const { photoId } of PHOTO_FILES) {
    if (!photos.has(photoId)) throw new Error(`missing_photo_bytes:${photoId}`);
  }

  const frozenAssets = PHOTO_FILES.map(({ photoId }, index) => {
    const photo = photos.get(photoId);
    return {
      assetSnapshotId: `asset-snapshot-demo-${String(index + 1).padStart(2, "0")}`,
      kind: "source_photo",
      photoId,
      sourcePhotosVersion: 1,
      contentHash: photo.contentHash,
      mimeType: photo.mimeType,
      byteLength: photo.bytes.length,
      localAssetRef: `${DEMO_ASSET_REF_PREFIX}${photoId}`
    };
  });

  const authorizedMemoryTexts = MEMORY_ENTRIES.map((entry, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    const photo = photos.get(entry.photoId);
    const sourceProvenance = sourceProvenanceFor(entry.photoId, photo.contentHash, index, entry.time);
    const text = {
      authorizedMemoryTextId: `authorized-memory-text-demo-${suffix}`,
      bookId: BOOK_ID,
      versionId: VERSION_ID,
      personalMemoryId: `memory-demo-${suffix}`,
      memoryRevisionId: `memory-revision-demo-${suffix}`,
      confirmedSubmissionId: `submission-demo-${suffix}-01`,
      confirmedSubmissionHash: sha256(entry.answer),
      originalUserText: entry.answer,
      authorCredit: AUTHOR,
      questionProvenance: [{
        questionId: `question-demo-${suffix}`,
        kind: "initial_question",
        question: entry.question,
        questionHash: sha256(entry.question),
        modelVersion: "hand-authored-demo-copy-v1",
        promptHash: sha256(`visible-only-demo|${entry.photoId}`),
        policyHash: sha256("demo-fixed-qa-v1"),
        sourcePhotoId: entry.photoId,
        photoContentHash: photo.contentHash,
        placementRevisionId: sourceProvenance.placementRevisionId,
        generatedAt: FROZEN_AT
      }],
      grantId: `grant-demo-${suffix}`,
      audienceScope: "current_live_space_viewers",
      sourceProvenance,
      frozenAt: FROZEN_AT
    };
    text.snapshotHash = sha256(canonicalize(text));
    return text;
  });

  const memoryPages = authorizedMemoryTexts.map((text, index) => ({
    pageId: `page-memory-demo-${String(index + 1).padStart(2, "0")}`,
    index: index + 2,
    kind: "memory",
    sourcePhotoId: text.sourceProvenance.photoId,
    displayPhotoId: text.sourceProvenance.photoId,
    personalMemoryId: text.personalMemoryId,
    memoryRevisionId: text.memoryRevisionId,
    confirmedSubmissionId: text.confirmedSubmissionId,
    confirmedSubmissionHash: text.confirmedSubmissionHash,
    grantId: text.grantId,
    authorizedMemoryTextId: text.authorizedMemoryTextId,
    sourceProvenance: text.sourceProvenance
  }));

  const pages = [
    {
      pageId: "page-cover", index: 1, kind: "cover", sourcePhotoId: null,
      displayPhotoId: COVER_PHOTO_ID, personalMemoryId: null, memoryRevisionId: null,
      confirmedSubmissionId: null, confirmedSubmissionHash: null, grantId: null,
      authorizedMemoryTextId: null, sourceProvenance: null
    },
    ...memoryPages,
    {
      pageId: "page-closing", index: memoryPages.length + 2, kind: "closing", sourcePhotoId: null,
      displayPhotoId: null, personalMemoryId: null, memoryRevisionId: null,
      confirmedSubmissionId: null, confirmedSubmissionHash: null, grantId: null,
      authorizedMemoryTextId: null, sourceProvenance: null
    }
  ];

  const manifest = buildManifest(BOOK_TITLE, pages, authorizedMemoryTexts, frozenAssets);

  function resolveAsset(localAssetRef) {
    if (!localAssetRef.startsWith(DEMO_ASSET_REF_PREFIX)) throw new Error("asset_ref_not_local_demo");
    const photoId = localAssetRef.slice(DEMO_ASSET_REF_PREFIX.length);
    const photo = photos.get(photoId);
    if (!photo) throw new Error("asset_not_found");
    return { bytes: photo.bytes, dataUri: photo.dataUri, contentHash: photo.contentHash };
  }

  return { manifest, resolveAsset };
}
