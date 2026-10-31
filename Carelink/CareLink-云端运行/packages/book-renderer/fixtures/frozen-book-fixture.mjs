import { canonicalize, manifestSemanticHash, sha256 } from "../src/canonical.mjs";

const frozenAt = "2026-05-18T21:10:00+10:00";
const bookId = "book-adventurex-night";
const versionId = "book-version-02";

const contributors = [
  { id: "contributor-lin", credit: "阿琳" },
  { id: "contributor-yuan", credit: "阿远" },
  { id: "contributor-mei", credit: "小梅" },
  { id: "contributor-an", credit: "安然" }
];

const moments = [
  ["入口的三串灯刚亮起来", "你拍下入口灯串时，大家正准备去哪里？", "我们刚把最后一盒相片搬进来，正往舞台那边走。", "contributor-lin", "阿琳", "入口长廊", "朝向舞台", "19:18", "#7b5366", "#f8c77d"],
  ["木桌上放着写名字的卡片", "桌上的名字卡是谁一张张摆好的？", "是阿远写、我负责按座位放。我们还为“然”字争了两分钟。", "contributor-mei", "小梅", "迎宾木桌", "朝向花门", "19:24", "#5a6757", "#e6b987"],
  ["舞台左侧有人调试一盏圆灯", "照片里舞台边的圆灯为什么单独亮着？", "那盏灯是给合照留的，摄影师说不要关，晚一点会用上。", "contributor-yuan", "阿远", "舞台左侧", "朝向圆灯", "19:31", "#5a516c", "#efb08f"],
  ["四个人在户外长桌旁举杯", "你记得这次举杯前说的第一句话吗？", "我记得第一句是“先敬没能到场的人”，所以大家安静了一下。", "contributor-mei", "小梅", "户外长桌", "朝向草坪", "19:42", "#654a42", "#f2b66e"],
  ["同一张长桌从另一侧拍到笑脸", "从你这一侧看，举杯前大家为什么突然笑了？", "我听见的第一句明明是阿远说“杯子别碰灯串”，然后所有人都笑了。", "contributor-an", "安然", "户外长桌", "朝向舞台", "19:42", "#684c57", "#ffb4a7"],
  ["有人把一只纸星星放到蛋糕旁", "蛋糕旁那只纸星星是谁带来的？", "是小满折的。她把名字写在背面，说等切完蛋糕再送出去。", "contributor-lin", "阿琳", "甜品桌", "朝向长桌", "19:51", "#74554c", "#ffd378"],
  ["台阶上并排放着四双湿鞋", "这四双湿鞋为什么都放在台阶上？", "我们刚从河边回来，谁都不肯把泥带进屋，就一起光脚进去了。", "contributor-yuan", "阿远", "南侧台阶", "朝向院门", "20:03", "#425c66", "#d8b991"],
  ["窗边投下两个人的影子", "窗边的两道影子当时在做什么？", "我们在练那段很短的开场词，越练越像播天气预报。", "contributor-an", "安然", "西侧窗边", "朝向院子", "20:11", "#554b61", "#e7a684"],
  ["相机屏幕里是一张模糊的奔跑照片", "相机里那张奔跑的照片是谁按下的快门？", "应该是我，但我当时一边跑一边拍，后来才发现所有人都糊成了光。", "contributor-mei", "小梅", "草坪中央", "朝向河岸", "20:19", "#3f5b4f", "#ffc07e"],
  ["两个人在金色帘幕前交换手写信", "帘幕前交换的两封信是什么时候写的？", "一封是三年前写的，另一封是当天清晨补的；我们没有当场念。", "contributor-lin", "阿琳", "金色帘幕", "朝向主桌", "20:28", "#765367", "#ffd186"],
  ["长椅下露出一台小录音机", "长椅下的录音机收到了什么声音？", "除了讲话，还录到了风吹铃铛和远处的火车，回放时大家都听见了。", "contributor-yuan", "阿远", "梧桐长椅", "朝向西墙", "20:37", "#4a5c68", "#dbad87"],
  ["一面墙上贴着许多旧车票", "墙上的旧车票为什么按颜色排，而不是按时间？", "颜色是我们各自记得的天气。蓝色不是冬天，是那次下雨的海边。", "contributor-an", "安然", "回忆墙", "朝向北窗", "20:46", "#5c536d", "#e8bb7b"],
  ["圆灯下只剩一把空椅子和花束", "圆灯下为什么特意留了一把空椅子？", "那是留给迟到的阿澄。她到时没坐，先把花放在椅子上。", "contributor-mei", "小梅", "舞台左侧", "朝向圆灯", "20:55", "#6a4c5d", "#f4b79d"],
  ["散场前四个人背对镜头看灯串", "散场前看灯串的这一分钟，谁先说不要走？", "是安然。我们最后又站了十分钟，直到灯一串串熄掉。", "contributor-yuan", "阿远", "入口长廊", "朝向院内", "21:04", "#3f4d61", "#efbd77"]
];

function svgFor(index, visibleDetail, colorA, colorB) {
  const label = String(index + 1).padStart(2, "0");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colorA}"/><stop offset="1" stop-color="${colorB}"/></linearGradient><radialGradient id="h"><stop stop-color="#fff9e7" stop-opacity=".92"/><stop offset="1" stop-color="#fff9e7" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="900" fill="url(#g)"/><circle cx="980" cy="145" r="260" fill="url(#h)"/><path d="M0 650 Q260 470 510 650 T1200 610 V900 H0Z" fill="#2b1721" opacity=".34"/><path d="M90 165 C300 70 520 250 730 120 S1040 190 1180 80" fill="none" stroke="#fff2c8" stroke-width="8" opacity=".75"/><g fill="#fff2c8">${[150,310,490,680,860,1050].map((x, n) => `<circle cx="${x}" cy="${120 + (n % 2) * 55}" r="16"/>`).join("")}</g><rect x="70" y="700" width="1060" height="120" rx="28" fill="#fff9f7" opacity=".9"/><text x="105" y="752" fill="#321722" font-family="system-ui,sans-serif" font-size="30">确定性本地照片样本 ${label}</text><text x="105" y="795" fill="#725f66" font-family="system-ui,sans-serif" font-size="24">${visibleDetail}</text></svg>`;
}

function sourceProvenance(photo, index, capturedTime) {
  const placementSeed = `${photo.photoId}|${photo.place}|${photo.direction}|${capturedTime}`;
  return {
    spaceId: "space-adventurex-2026",
    photoId: photo.photoId,
    sceneId: "scene-evening-courtyard",
    panoramaRevisionId: "panorama-revision-ready-01",
    placementRevisionId: `placement-revision-${String(index + 1).padStart(2, "0")}`,
    nodeId: null,
    sourcePhotosVersion: 3,
    yawDegrees: (index * 23 + 17) % 360,
    capturedAt: `2026-05-18T${capturedTime}:00+10:00`,
    authorId: photo.contributorId,
    photoContentHash: photo.contentHash,
    placementSnapshotHash: sha256(placementSeed)
  };
}

const photos = moments.map((moment, index) => {
  const [visibleDetail, question, answer, contributorId, credit, place, direction, time, colorA, colorB] = moment;
  const photoId = `photo-${String(index + 1).padStart(2, "0")}`;
  const svg = svgFor(index, visibleDetail, colorA, colorB);
  return {
    photoId,
    visibleDetail,
    question,
    answer,
    contributorId,
    credit,
    place,
    direction,
    time,
    svg,
    dataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    contentHash: sha256(svg)
  };
});

const authorizedMemoryTexts = photos.map((photo, index) => {
  const suffix = String(index + 1).padStart(2, "0");
  const provenance = sourceProvenance(photo, index, photo.time);
  const text = {
    authorizedMemoryTextId: `authorized-memory-text-${suffix}`,
    bookId,
    versionId,
    personalMemoryId: `memory-${suffix}`,
    memoryRevisionId: `memory-revision-${suffix}`,
    confirmedSubmissionId: `submission-${suffix}-02`,
    confirmedSubmissionHash: sha256(photo.answer),
    originalUserText: photo.answer,
    authorCredit: photo.credit,
    questionProvenance: [{
      questionId: `question-${suffix}`,
      kind: "initial_question",
      question: photo.question,
      questionHash: sha256(photo.question),
      modelVersion: "deterministic-local-question-fixture-v1",
      promptHash: sha256(`visible-only|${photo.visibleDetail}`),
      policyHash: sha256("visible-fact-grounded-no-identity-no-emotion-v1"),
      sourcePhotoId: photo.photoId,
      photoContentHash: photo.contentHash,
      placementRevisionId: provenance.placementRevisionId,
      generatedAt: "2026-05-19T09:00:00+10:00"
    }],
    grantId: `grant-${suffix}`,
    audienceScope: "current_live_space_viewers",
    sourceProvenance: provenance,
    frozenAt
  };
  text.snapshotHash = sha256(canonicalize(text));
  return text;
});

const frozenAssets = photos.map((photo, index) => ({
  assetSnapshotId: `asset-snapshot-${String(index + 1).padStart(2, "0")}`,
  kind: "source_photo",
  photoId: photo.photoId,
  sourcePhotosVersion: 3,
  contentHash: photo.contentHash,
  mimeType: "image/svg+xml",
  byteLength: Buffer.byteLength(photo.svg),
  localAssetRef: `fixture-asset:${photo.photoId}`
}));

const memoryPages = authorizedMemoryTexts.map((text, index) => ({
  pageId: `page-memory-${String(index + 1).padStart(2, "0")}`,
  index: index + 2,
  kind: index === 3 || index === 4 ? "multi_view" : "memory",
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
    pageId: "page-cover",
    index: 1,
    kind: "cover",
    sourcePhotoId: null,
    displayPhotoId: "photo-01",
    personalMemoryId: null,
    memoryRevisionId: null,
    confirmedSubmissionId: null,
    confirmedSubmissionHash: null,
    grantId: null,
    authorizedMemoryTextId: null,
    sourceProvenance: null
  },
  ...memoryPages,
  {
    pageId: "page-closing",
    index: 16,
    kind: "closing",
    sourcePhotoId: null,
    displayPhotoId: null,
    personalMemoryId: null,
    memoryRevisionId: null,
    confirmedSubmissionId: null,
    confirmedSubmissionHash: null,
    grantId: null,
    authorizedMemoryTextId: null,
    sourceProvenance: null
  }
];

function buildManifest(title, frozenPages) {
  const value = {
    bookId,
    versionId,
    title,
    authorizationSnapshotHash: sha256(canonicalize(authorizedMemoryTexts.map((item) => ({ grantId: item.grantId, audienceScope: item.audienceScope })))),
    authorizedMemoryTextSnapshotHash: sha256(canonicalize(authorizedMemoryTexts)),
    assetSnapshotHash: sha256(canonicalize(frozenAssets)),
    pages: frozenPages,
    authorizedMemoryTexts,
    frozenAssets,
    frozenAt
  };
  value.manifestHash = manifestSemanticHash(value);
  return value;
}

const manifest = buildManifest("共光以后", pages);

export const fixtureBundle = Object.freeze({
  fixtureNotice: "确定性本地样本 / 非真实 AI 问题质量",
  fixtureVersion: "unseen-book-lab-fixture/1",
  event: {
    eventId: "event-adventurex-2026",
    title: "共光以后",
    subtitle: "AdventureX 2026 · 院子里的一个晚上",
    spaceId: "space-adventurex-2026",
    panorama: { panoramaRevisionId: "panorama-revision-ready-01", status: "ready" }
  },
  contributors,
  photos: photos.map(({ svg: _svg, ...photo }) => ({ ...photo, status: "confirmed_current", mainQuestionCount: 1 })),
  manifest,
  book: {
    bookId,
    title: manifest.title,
    currentVersion: { versionId, ordinal: 2, status: "available" },
    previousVersion: { versionId: "book-version-01", ordinal: 1, status: "withdrawal_affected" }
  },
  conflict: {
    sourcePhotoIds: ["photo-04", "photo-05"],
    rule: "保留两位参与者的署名视角，不合并成唯一真相"
  }
});

export const fixtureHash = sha256(canonicalize(fixtureBundle));

export function freezeFixtureDraft({ title, pages: draftPages }) {
  if (typeof title !== "string" || Array.from(title).length < 1 || Array.from(title).length > 120) throw new Error("title_invalid");
  if (!Array.isArray(draftPages) || draftPages.length < 12 || draftPages.length > 16) throw new Error("page_count_out_of_range");
  const pageById = new Map(pages.map((page) => [page.pageId, page]));
  const assetIds = new Set(frozenAssets.map((asset) => asset.photoId));
  if (new Set(draftPages.map((page) => page?.pageId)).size !== draftPages.length) throw new Error("duplicate_page_id");
  const frozenPages = draftPages.map((draftPage, index) => {
    const sourcePage = pageById.get(draftPage?.pageId);
    if (!sourcePage || sourcePage.kind !== draftPage.kind) throw new Error("fixture_page_invalid");
    const displayPhotoId = draftPage.displayPhotoId;
    if (sourcePage.kind === "cover" && !assetIds.has(displayPhotoId)) throw new Error("cover_display_asset_missing");
    if (sourcePage.kind === "closing" && displayPhotoId !== null) throw new Error("closing_display_asset_forbidden");
    if (displayPhotoId !== null && !assetIds.has(displayPhotoId)) throw new Error("display_asset_missing");
    return { ...structuredClone(sourcePage), index: index + 1, displayPhotoId };
  });
  if (frozenPages[0]?.kind !== "cover" || frozenPages.at(-1)?.kind !== "closing") throw new Error("fixture_bookends_invalid");
  return buildManifest(title, frozenPages);
}

export function resolveFixtureAsset(localAssetRef) {
  const prefix = "fixture-asset:";
  if (!localAssetRef.startsWith(prefix)) throw new Error("asset_ref_not_local_fixture");
  const photo = photos.find((item) => item.photoId === localAssetRef.slice(prefix.length));
  if (!photo) throw new Error("asset_not_found");
  return { bytes: Buffer.from(photo.svg), dataUri: photo.dataUri, contentHash: photo.contentHash };
}
