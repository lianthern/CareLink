import { canonicalize, assert, escapeHtml, manifestSemanticHash, sha256 } from "./canonical.mjs";

const provenanceFields = [
  "spaceId", "photoId", "sceneId", "panoramaRevisionId", "placementRevisionId", "nodeId",
  "sourcePhotosVersion", "yawDegrees", "capturedAt", "authorId", "photoContentHash", "placementSnapshotHash"
];

const renderProfiles = new Set(["fixture", "production"]);

function assertRenderProfile(renderProfile) {
  assert(renderProfiles.has(renderProfile), "render_profile_invalid");
  return renderProfile;
}

function renderFixtureStamp(renderProfile) {
  return renderProfile === "fixture" ? '<div class="fixture-stamp">确定性本地样本 · 非真实 AI 问题质量</div>' : "";
}

function withoutSnapshotHash(value) {
  const { snapshotHash: _ignored, ...semantic } = value;
  return semantic;
}

function textLength(value) {
  return Array.from(value).length;
}

function pageIdentity(page) {
  return {
    pageId: page.pageId,
    sourcePhotoId: page.sourcePhotoId,
    displayPhotoId: page.displayPhotoId
  };
}

export function validateFrozenManifest(manifest, resolveAsset) {
  assert(manifest && typeof manifest === "object", "manifest_required");
  assert(manifest.manifestHash === manifestSemanticHash(manifest), "manifest_hash_mismatch");
  assert(manifest.templateVersion == null || ["book-lab-v0", "book-lab-v1"].includes(manifest.templateVersion), "template_version_invalid");
  assert(typeof manifest.title === "string" && textLength(manifest.title) >= 1 && textLength(manifest.title) <= 120, "title_invalid");
  assert(Array.isArray(manifest.pages) && manifest.pages.length >= 12 && manifest.pages.length <= 16, "page_count_out_of_range");
  assert(manifest.pages.every((page, index) => page.index === index + 1), "page_order_invalid");
  assert(new Set(manifest.pages.map((page) => page.pageId)).size === manifest.pages.length, "duplicate_page_id");
  assert(Array.isArray(manifest.authorizedMemoryTexts), "authorized_memory_texts_required");
  assert(Array.isArray(manifest.frozenAssets), "frozen_assets_required");
  assert(manifest.authorizedMemoryTextSnapshotHash === sha256(canonicalize(manifest.authorizedMemoryTexts)), "authorized_text_snapshot_hash_mismatch");
  assert(manifest.assetSnapshotHash === sha256(canonicalize(manifest.frozenAssets)), "asset_snapshot_hash_mismatch");

  const texts = new Map(manifest.authorizedMemoryTexts.map((text) => [text.authorizedMemoryTextId, text]));
  const assets = new Map(manifest.frozenAssets.map((asset) => [asset.photoId, asset]));
  assert(texts.size === manifest.authorizedMemoryTexts.length, "duplicate_authorized_memory_text_id");
  assert(assets.size === manifest.frozenAssets.length, "duplicate_frozen_asset_photo_id");

  for (const text of manifest.authorizedMemoryTexts) {
    assert(text.bookId === manifest.bookId, "authorized_text_book_mismatch");
    assert(text.versionId === manifest.versionId, "authorized_text_version_mismatch");
    assert(text.snapshotHash === sha256(canonicalize(withoutSnapshotHash(text))), "authorized_text_snapshot_hash_invalid");
    assert(text.confirmedSubmissionHash === sha256(text.originalUserText), "original_user_text_hash_mismatch");
    assert(textLength(text.originalUserText) <= 900, "page_text_overflow");
    assert(text.authorCredit && textLength(text.authorCredit) <= 120, "author_credit_invalid");
    assert(text.audienceScope === "current_live_space_viewers", "audience_scope_invalid");
    assert(Array.isArray(text.questionProvenance) && text.questionProvenance.length >= 1 && text.questionProvenance.length <= 2, "question_provenance_invalid");
    for (const question of text.questionProvenance) {
      assert(question.questionHash === sha256(question.question), "question_hash_mismatch");
      assert(question.sourcePhotoId === text.sourceProvenance.photoId, "question_source_mismatch");
    }
    for (const field of provenanceFields) assert(Object.hasOwn(text.sourceProvenance, field), `provenance_missing:${field}`);
  }

  for (const asset of manifest.frozenAssets) {
    assert(!/^(?:https?:)?\/\//iu.test(asset.localAssetRef), "remote_asset_forbidden");
    assert(asset.mimeType.startsWith("image/"), "asset_mime_forbidden");
    const resolved = resolveAsset(asset.localAssetRef);
    assert(resolved.contentHash === asset.contentHash, "asset_content_hash_mismatch");
    assert(resolved.bytes.length === asset.byteLength, "asset_byte_length_mismatch");
  }

  for (const page of manifest.pages) {
    if (page.kind === "cover") {
      assert(assets.has(page.displayPhotoId), "cover_display_asset_missing");
      continue;
    }
    if (page.kind === "closing") {
      assert(page.displayPhotoId === null, "closing_display_asset_forbidden");
      continue;
    }
    const text = texts.get(page.authorizedMemoryTextId);
    assert(text, "authorized_memory_text_missing");
    assert(page.sourcePhotoId === text.sourceProvenance.photoId, "source_photo_mismatch");
    assert(page.personalMemoryId === text.personalMemoryId, "personal_memory_mismatch");
    assert(page.memoryRevisionId === text.memoryRevisionId, "memory_revision_mismatch");
    assert(page.confirmedSubmissionId === text.confirmedSubmissionId, "confirmed_submission_mismatch");
    assert(page.confirmedSubmissionHash === text.confirmedSubmissionHash, "confirmed_submission_hash_mismatch");
    assert(page.grantId === text.grantId, "grant_mismatch");
    assert(assets.has(page.displayPhotoId), "display_asset_missing");
    for (const field of provenanceFields) assert(Object.hasOwn(page.sourceProvenance, field), `provenance_missing:${field}`);
    assert(canonicalize(page.sourceProvenance) === canonicalize(text.sourceProvenance), "source_provenance_mismatch");
  }

  return {
    pageCount: manifest.pages.length,
    orderedPageIds: manifest.pages.map((page) => page.pageId),
    orderedSourceIds: manifest.pages.map((page) => page.sourcePhotoId),
    orderedDisplayPhotoIds: manifest.pages.map((page) => page.displayPhotoId)
  };
}

function metadataAttributes(page) {
  const provenance = page.sourceProvenance;
  const values = {
    "page-id": page.pageId,
    "source-photo-id": page.sourcePhotoId,
    "display-photo-id": page.displayPhotoId,
    "scene-id": provenance?.sceneId,
    "panorama-revision-id": provenance?.panoramaRevisionId,
    "placement-revision-id": provenance?.placementRevisionId,
    "node-id": provenance?.nodeId ?? "null",
    "yaw": provenance?.yawDegrees,
    "captured-at": provenance?.capturedAt,
    "author-id": provenance?.authorId,
    "personal-memory-id": page.personalMemoryId,
    "memory-revision-id": page.memoryRevisionId,
    "confirmed-submission-id": page.confirmedSubmissionId,
    "confirmed-submission-hash": page.confirmedSubmissionHash,
    "grant-id": page.grantId,
    "authorized-memory-text-id": page.authorizedMemoryTextId
  };
  return Object.entries(values).map(([key, value]) => `data-${key}="${escapeHtml(value ?? "null")}"`).join(" ");
}

function renderMemoryPage(page, pageCount, text, asset, renderProfile, humanReadable) {
  const provenance = text.sourceProvenance;
  const question = text.questionProvenance.at(-1);
  const compact = textLength(text.originalUserText) > 220 ? " page--compact" : "";
  const conflict = page.kind === "multi_view" ? `<p class="viewpoint-note">同一时刻的署名视角 · 不合并为唯一真相</p>` : "";
  return `<section class="book-page${compact}" ${metadataAttributes(page)} aria-label="第 ${page.index} 页">
    ${renderFixtureStamp(renderProfile)}
    <figure class="photo"><img src="${asset.dataUri}" alt="${escapeHtml(question.question.replace(/[？?]$/u, ""))}"/></figure>
    <div class="page-copy">
      ${conflict}
      <p class="ai-question"><span>AI 提问</span>${escapeHtml(question.question)}</p>
      <blockquote dir="auto">${escapeHtml(text.originalUserText)}</blockquote>
      <p class="credit">— ${escapeHtml(text.authorCredit)}</p>
      <p class="provenance-ribbon"><span>${escapeHtml(humanReadable ? provenance.capturedAt.slice(0, 16).replace("T", " ") : provenance.capturedAt.slice(11, 16))}</span><span>${humanReadable ? "现场照片" : escapeHtml(provenance.photoId)}</span><span>现场 · ${escapeHtml(provenance.yawDegrees)}°</span><span>${escapeHtml(text.authorCredit)}</span></p>
      ${humanReadable ? "" : `<p class="source-line">来源记录 ${escapeHtml(page.sourcePhotoId)} · 展示照片 ${escapeHtml(page.displayPhotoId)} · ${escapeHtml(provenance.sceneId)} · ${escapeHtml(provenance.placementRevisionId)} · nodeId=${escapeHtml(provenance.nodeId ?? "null")}</p>`}
    </div>
    <footer><span>${humanReadable ? "UNSEEN · 共同记忆" : escapeHtml(page.pageId)}</span><span>${page.index} / ${pageCount}</span></footer>
  </section>`;
}

function renderCover(page, pageCount, manifest, coverAsset, renderProfile, humanReadable) {
  return `<section class="book-page cover" ${metadataAttributes(page)} aria-label="封面">
    ${renderFixtureStamp(renderProfile)}
    <img class="cover-photo" src="${coverAsset.dataUri}" alt="${escapeHtml(manifest.title)}封面照片"/>
    <div class="cover-wash"></div>
    <div class="cover-copy"><p class="eyebrow">UNSEEN · 共同记忆</p><h1>${escapeHtml(manifest.title)}</h1><p>${manifest.authorizedMemoryTexts.length} 段由在场者确认的原话。</p><p class="cover-rule">每段原话保留署名、现场方向与授权版本。</p></div>
    <footer><span>${humanReadable ? "UNSEEN · 共同记忆" : escapeHtml(page.pageId)}</span><span>1 / ${pageCount}</span></footer>
  </section>`;
}

function renderClosing(page, pageCount, manifest, renderProfile, humanReadable) {
  return `<section class="book-page closing" ${metadataAttributes(page)} aria-label="尾页">
    ${renderFixtureStamp(renderProfile)}
    <div class="overlap-mark" aria-hidden="true"><i></i><i></i><i></i><b>♥</b></div>
    <p class="eyebrow">${escapeHtml(manifest.title)} · ${escapeHtml(pageCount)} 页</p><h2>记得不同，也可以一起留下。</h2>
    <p>这些回答没有被合并成唯一真相。每个人只为自己的原话署名，并只同意它进入这一版书。</p>
    <p class="closing-note">若有人撤回，旧数字版会停止提供；已经下载到个人设备的文件无法由系统召回。</p>
    <footer><span>${humanReadable ? "UNSEEN · 共同记忆" : escapeHtml(page.pageId)}</span><span>${page.index} / ${pageCount}</span></footer>
  </section>`;
}

export function renderCanonicalHtml(manifest, resolveAsset, renderProfile) {
  assertRenderProfile(renderProfile);
  const equality = validateFrozenManifest(manifest, resolveAsset);
  const humanReadable = manifest.templateVersion === "book-lab-v1";
  const textById = new Map(manifest.authorizedMemoryTexts.map((text) => [text.authorizedMemoryTextId, text]));
  const assetByPhoto = new Map(manifest.frozenAssets.map((asset) => [asset.photoId, resolveAsset(asset.localAssetRef)]));
  const sections = manifest.pages.map((page) => {
    if (page.kind === "cover") return renderCover(page, equality.pageCount, manifest, assetByPhoto.get(page.displayPhotoId), renderProfile, humanReadable);
    if (page.kind === "closing") return renderClosing(page, equality.pageCount, manifest, renderProfile, humanReadable);
    return renderMemoryPage(page, equality.pageCount, textById.get(page.authorizedMemoryTextId), assetByPhoto.get(page.displayPhotoId), renderProfile, humanReadable);
  }).join("\n");
  const ledger = equality.orderedPageIds.map((id, index) => `${id}|${equality.orderedSourceIds[index] ?? "null"}|${equality.orderedDisplayPhotoIds[index] ?? "null"}`).join(" · ");
  const fixtureStampStyle = renderProfile === "fixture" ? ".fixture-stamp{position:absolute;z-index:4;top:5mm;right:7mm;border:1px solid #a57e75;border-radius:999px;background:#fff9f7;color:#725f66;padding:2mm 4mm;font-size:8pt;letter-spacing:.02em}" : "";
  const fixtureStampMobileStyle = renderProfile === "fixture" ? ".fixture-stamp{font-size:7pt}" : "";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'"/>
<meta name="unseen-book-id" content="${escapeHtml(manifest.bookId)}"/><meta name="unseen-version-id" content="${escapeHtml(manifest.versionId)}"/>
<meta name="unseen-manifest-hash" content="${escapeHtml(manifest.manifestHash)}"/><meta name="unseen-authorization-snapshot-hash" content="${escapeHtml(manifest.authorizationSnapshotHash)}"/>
<meta name="unseen-authorized-memory-text-snapshot-hash" content="${escapeHtml(manifest.authorizedMemoryTextSnapshotHash)}"/><meta name="unseen-asset-snapshot-hash" content="${escapeHtml(manifest.assetSnapshotHash)}"/>
<title>${escapeHtml(manifest.title)}${renderProfile === "fixture" ? " · 确定性本地样本" : ""}</title><style>
@page{size:210mm 210mm;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#f7f1ef;color:#321722;font-family:"STSong","Songti SC",serif}body{counter-reset:page}.book-page{position:relative;width:210mm;height:210mm;overflow:hidden;background:#fff9f7;page-break-after:always;break-after:page;padding:15mm;display:grid;grid-template-columns:1.12fr .88fr;gap:10mm}.book-page:last-of-type{page-break-after:auto}${fixtureStampStyle}.photo{margin:0;min-height:0;border-radius:7mm;overflow:hidden;background:#f7f1ef;box-shadow:0 8px 28px rgba(70,21,40,.08)}.photo img,.cover-photo{width:100%;height:100%;object-fit:cover}.page-copy{min-width:0;align-self:center}.ai-question{font-size:10pt;line-height:1.55;color:#725f66;border-left:2px solid #ff96b2;padding-left:4mm}.ai-question span{display:block;color:#a43e4a;font-size:7.5pt;font-weight:600;letter-spacing:.08em;margin-bottom:1.5mm}blockquote{font-size:18pt;line-height:1.62;margin:8mm 0 4mm;overflow-wrap:anywhere;word-break:break-word;unicode-bidi:plaintext}blockquote:before{content:"“";color:#ff96b2;font-size:36pt;line-height:0;vertical-align:-5mm;margin-left:-5mm}.page--compact blockquote{font-size:13pt;line-height:1.45;margin-top:5mm}.credit{text-align:right;font-weight:600}.provenance-ribbon{display:flex;flex-wrap:wrap;gap:2mm;margin:8mm 0 3mm}.provenance-ribbon span{background:#fff0bf;border:1px solid #a57e75;border-radius:999px;padding:1.6mm 3mm;font-size:8pt}.source-line{font:7pt/1.5 "STSong","Songti SC",serif;color:#725f66;overflow-wrap:anywhere}.viewpoint-note{display:inline-block;margin:0 0 3mm;background:#ffd6e1;border-radius:999px;padding:1.5mm 3mm;font-size:8pt;color:#461528}.book-page footer{position:absolute;left:15mm;right:15mm;bottom:6mm;display:flex;justify-content:space-between;border-top:1px solid #e9ddda;padding-top:2.5mm;color:#725f66;font-size:7.5pt}.cover{display:block;padding:0;color:#fff}.cover-photo{position:absolute;inset:0}.cover-wash{position:absolute;inset:0;background:linear-gradient(100deg,rgba(50,23,34,.86),rgba(70,21,40,.14) 72%)}.cover-copy{position:absolute;z-index:2;left:17mm;bottom:24mm;width:112mm}.eyebrow{font-size:8.5pt;font-weight:600;letter-spacing:.13em;text-transform:uppercase}.cover h1{font-size:43pt;line-height:1.06;margin:4mm 0}.cover-copy>p:not(.eyebrow){font-size:13pt;line-height:1.6}.cover-rule{border-top:1px solid rgba(255,255,255,.55);padding-top:4mm}.cover footer{z-index:3;color:#fff;border-color:rgba(255,255,255,.4)}.closing{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:25mm 42mm;background:radial-gradient(circle at 50% 42%,rgba(255,214,120,.34),transparent 36%),linear-gradient(135deg,#fff4f0,#fff9f7 45%,#fff0bf)}.closing h2{font-size:34pt;line-height:1.25;margin:7mm 0}.closing>p:not(.eyebrow){font-size:12pt;line-height:1.75;max-width:118mm}.closing-note{margin-top:10mm;color:#725f66;border-top:1px solid #a57e75;padding-top:5mm}.overlap-mark{position:relative;width:50mm;height:36mm;margin-bottom:7mm}.overlap-mark i{position:absolute;width:25mm;height:25mm;border:1.2mm solid rgba(255,255,255,.9);border-radius:50%;background:rgba(255,150,178,.44)}.overlap-mark i:nth-child(1){left:12.5mm;top:0}.overlap-mark i:nth-child(2){left:3mm;top:10mm}.overlap-mark i:nth-child(3){right:3mm;top:10mm;background:rgba(255,214,120,.55)}.overlap-mark b{position:absolute;z-index:2;left:21.5mm;top:15mm;color:#fff;font-size:16pt}@media screen{body{padding:24px}.book-page{width:min(100%,900px);height:auto;min-height:min(900px,calc(100vh - 48px));aspect-ratio:1;margin:0 auto 24px;box-shadow:0 16px 48px rgba(70,21,40,.14)}}@media(max-width:700px){body{padding:0}.book-page{border-radius:0;margin:0;grid-template-columns:1fr;grid-template-rows:46% 1fr;gap:5mm;padding:12mm 7mm;min-height:100svh;aspect-ratio:auto}${fixtureStampMobileStyle}.page-copy{align-self:start}.photo{border-radius:5mm}blockquote{font-size:15pt;margin:4mm 0 2mm}.source-line{font-size:6pt}.cover-copy{left:8mm;bottom:18mm;width:82%}.cover h1{font-size:34pt}.closing{padding:20mm 10mm}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
${humanReadable ? "blockquote:before{content:none}" : ""}</style></head><body>${sections}<aside class="render-ledger" hidden aria-hidden="true">${escapeHtml(ledger)}</aside></body></html>`;
  assert(!/<script\b/iu.test(html), "active_script_forbidden");
  assert(!/(?:src|href)=["'](?:https?:)?\/\//iu.test(html), "remote_resource_forbidden");
  return {
    html,
    htmlHash: sha256(html),
    ...(humanReadable ? { pageOrderMarkers: manifest.pages.map(page => `${page.index} / ${equality.pageCount}`) } : {}),
    renderProfile,
    equality: {
      bookId: manifest.bookId,
      versionId: manifest.versionId,
      title: manifest.title,
      manifestHash: manifest.manifestHash,
      authorizationSnapshotHash: manifest.authorizationSnapshotHash,
      authorizedMemoryTextSnapshotHash: manifest.authorizedMemoryTextSnapshotHash,
      assetSnapshotHash: manifest.assetSnapshotHash,
      ...equality
    }
  };
}

export function buildRenderReceipt(manifest, htmlResult, pdf, renderProfile) {
  assertRenderProfile(renderProfile);
  assert(htmlResult.renderProfile === renderProfile, "render_profile_mismatch");
  assert(sha256(htmlResult.html) === htmlResult.htmlHash, "render_html_hash_mismatch");
  const expectedEquality = {
    bookId: manifest.bookId,
    versionId: manifest.versionId,
    title: manifest.title,
    manifestHash: manifest.manifestHash,
    authorizationSnapshotHash: manifest.authorizationSnapshotHash,
    authorizedMemoryTextSnapshotHash: manifest.authorizedMemoryTextSnapshotHash,
    assetSnapshotHash: manifest.assetSnapshotHash,
    pageCount: manifest.pages.length,
    orderedPageIds: manifest.pages.map((page) => page.pageId),
    orderedSourceIds: manifest.pages.map((page) => page.sourcePhotoId),
    orderedDisplayPhotoIds: manifest.pages.map((page) => page.displayPhotoId)
  };
  assert(canonicalize(htmlResult.equality) === canonicalize(expectedEquality), "render_manifest_equality_mismatch");
  assert(pdf.pageCount === htmlResult.equality.pageCount, "artifact_page_count_mismatch");
  assert(pdf.orderedMarkersVerified, "pdf_page_order_unverified");
  return {
    schemaVersion: "unseen-book-render-receipt/1",
    ...(renderProfile === "production" ? { renderProfile } : {}),
    fixtureOnly: renderProfile === "fixture",
    input: htmlResult.equality,
    html: { contentHash: htmlResult.htmlHash, pageCount: htmlResult.equality.pageCount },
    pdf: { contentHash: pdf.contentHash, pageCount: pdf.pageCount },
    equality: {
      bookId: manifest.bookId,
      versionId: manifest.versionId,
      title: manifest.title,
      manifestHash: manifest.manifestHash,
      authorizationSnapshotHash: manifest.authorizationSnapshotHash,
      authorizedMemoryTextSnapshotHash: manifest.authorizedMemoryTextSnapshotHash,
      assetSnapshotHash: manifest.assetSnapshotHash,
      pageCount: htmlResult.equality.pageCount,
      orderedPageIds: htmlResult.equality.orderedPageIds,
      orderedSourceIds: htmlResult.equality.orderedSourceIds,
      orderedDisplayPhotoIds: htmlResult.equality.orderedDisplayPhotoIds
    }
  };
}
