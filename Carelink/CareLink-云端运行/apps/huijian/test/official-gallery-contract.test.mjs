import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const galleryModuleUrl = new URL("../public/official-gallery/v1/official-posts.js", import.meta.url);

const [appSource, dapSource, worldSource] = await Promise.all([
  read("../public/unseen-demo.js"),
  read("../public/unseen-dap.html"),
  read("../public/world-lab.html")
]);

let galleryModulePromise;

function loadGalleryModule() {
  galleryModulePromise ??= import(galleryModuleUrl.href);
  return galleryModulePromise;
}

function functionSource(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing function ${name}`);
  const remainder = source.slice(start + marker.length);
  const nextFunction = /\n(?:async\s+)?function\s+/u.exec(remainder);
  const next = nextFunction ? start + marker.length + nextFunction.index : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

function serialized(value) {
  return JSON.stringify(value);
}

function capabilityText(post) {
  return serialized({
    capability: post.capability,
    facts: post.facts,
    body: post.body,
    summary: post.summary,
    limitations: post.limitations,
    source: post.source
  });
}

test("the versioned gallery manifest has one official author and stable post identities", async () => {
  const gallery = await loadGalleryModule();
  const author = gallery.OFFICIAL_GALLERY_AUTHOR;
  const posts = gallery.OFFICIAL_POSTS;

  assert.ok(author && typeof author === "object", "missing OFFICIAL_GALLERY_AUTHOR");
  assert.match(String(author.id), /unseen[^]*official|official[^]*unseen/iu);
  assert.equal(author.name, "UNSEEN 官方");
  assert.match(String(author.kind ?? author.type), /official/iu);
  assert.ok(Array.isArray(posts) && posts.length >= 3, "gallery needs at least three curated official posts");

  const ids = posts.map((post) => post.id);
  const slugs = posts.map((post) => post.slug);
  assert.equal(new Set(ids).size, posts.length, "official post ids must be unique");
  assert.equal(new Set(slugs).size, posts.length, "official post slugs must be unique");
  for (const post of posts) {
    assert.match(String(post.id), /^[a-z0-9][a-z0-9-]+$/u);
    assert.match(String(post.slug), /^[a-z0-9][a-z0-9-]+$/u);
    const postAuthorId = post.authorId ?? post.author?.id;
    assert.equal(postAuthorId, author.id, `${post.id} must use the sole official author`);
    assert.ok(post.source, `${post.id} needs an attributable source`);
    assert.ok(Array.isArray(post.limitations) && post.limitations.length > 0, `${post.id} needs explicit limits`);
    assert.ok(post.capability && typeof post.capability === "object", `${post.id} needs one capability object`);
    assert.ok(post.capability.status, `${post.id} needs an honest capability status`);
  }
});

test("official cases cover memory, DAP, and World Labs single plus multi without opening 3DGS", async () => {
  const { OFFICIAL_POSTS: posts } = await loadGalleryModule();
  const byCapability = (pattern) => posts.find((post) => pattern.test(String(post.capability?.id)));
  const memory = byCapability(/memory/iu);
  const dap = byCapability(/dap/iu);
  const world = byCapability(/world/iu);

  assert.ok(memory, "missing photo-question-to-memory-page case");
  assert.match(capabilityText(memory), /照片|photo/iu);
  assert.match(capabilityText(memory), /追问|问题|question/iu);
  assert.match(capabilityText(memory), /一页|memory.page/iu);

  assert.ok(dap, "missing DAP ballroom case");
  assert.match(capabilityText(dap), /宴会厅|ballroom/iu);
  assert.match(capabilityText(dap), /受限|limited/iu);
  assert.match(capabilityText(dap), /0\.42/u);
  assert.match(capabilityText(dap), /CC BY-NC 4\.0/iu);
  assert.match(capabilityText(dap), /授权|替换|commercial|license/iu);

  assert.ok(world, "missing World Labs case");
  const worldText = capabilityText(world);
  assert.match(worldText, /单图|single/iu);
  assert.match(worldText, /多图|multi/iu);
  assert.match(worldText, /公开|public/iu);
  assert.match(worldText, /改进模型|model improvement/iu);
  assert.match(worldText, /额度|credit|quota/iu);
  assert.match(worldText, /非精确|不精确|not exact|approximate/iu);

  for (const post of posts) {
    if (!/3dgs/iu.test(String(post.capability?.id))) continue;
    assert.doesNotMatch(String(post.capability.status), /available|live|open|ready|已开放|可用|已接通/iu);
  }
});

test("official media is local, versioned, dimensioned, and rendered lazily off the first view", async () => {
  const { OFFICIAL_POSTS: posts } = await loadGalleryModule();
  for (const post of posts) {
    assert.ok(Array.isArray(post.media) && post.media.length > 0, `${post.id} needs local media`);
    for (const media of post.media) {
      assert.match(String(media.src), /^\/official-gallery\/v1\/media\//u);
      assert.match(String(media.thumbnailSrc), /^\/official-gallery\/v1\/media\//u);
      assert.ok(Number.isInteger(media.width) && media.width > 0, `${post.id} media width must be intrinsic`);
      assert.ok(Number.isInteger(media.height) && media.height > 0, `${post.id} media height must be intrinsic`);
      assert.doesNotMatch(String(media.src) + String(media.thumbnailSrc), /^https?:|data:/iu);
    }
  }

  assert.match(appSource, /official-gallery\/v1\/official-posts\.js/u);
  const galleryImage = functionSource(appSource, "galleryImageMarkup");
  assert.match(galleryImage, /loading\s*=\s*"lazy"/u);
  assert.match(galleryImage, /width="\$\{/u);
  assert.match(galleryImage, /height="\$\{/u);
});

test("the center add control only opens camera or library and never offers official samples", () => {
  const nav = functionSource(appSource, "bottomNav");
  const add = functionSource(appSource, "addSheet");

  assert.equal((nav.match(/class="nav-item /gu) ?? []).length, 2);
  assert.equal((nav.match(/class="nav-add"/gu) ?? []).length, 1);
  assert.match(nav, /<span>看看<\/span>/u);
  assert.match(nav, /aria-label="添加一段新记忆"/u);
  assert.match(nav, /<span>我的<\/span>/u);

  assert.match(add, /data-action="choose-camera"/u);
  assert.match(add, /data-action="choose-library"/u);
  assert.equal((add.match(/class="sheet-option(?:\s|")/gu) ?? []).length, 2);
  assert.doesNotMatch(add, /data-sample|内置例图|官方案例|data-screen=|not-connected|上传一段视频|加入一个现场/u);
  assert.doesNotMatch(appSource, /data-sample=|内置例图/u);
});

test("opening an official post is a read-only gallery transition with no personal side effects", () => {
  assert.match(appSource, /data-official-post-id=/u);
  const openOfficialPost = functionSource(appSource, "openOfficialPost");
  assert.match(openOfficialPost, /state\.officialPostId/u);
  assert.match(openOfficialPost, /state\.screen/u);
  assert.doesNotMatch(
    openOfficialPost,
    /state\.photo\s*=|saveMemory|store\.saveMemory|saveWorldHandoff|prepareWorldHandoff|saveNavigationState|indexedDB/u
  );
  assert.doesNotMatch(
    appSource,
    /data-action="(?:like|comment|follow|rank|message|publish|register)[^"]*"/iu
  );
});

test("official case permalinks and the DAP return path preserve browsing context", async () => {
  const { OFFICIAL_POSTS: posts } = await loadGalleryModule();
  const dap = posts.find((post) => /dap/iu.test(String(post.capability?.id)));

  assert.ok(dap?.viewer?.href, "DAP case needs a read-only viewer link");
  assert.match(dap.viewer.href, /back=unseen-demo%3Fcase%3Ddap-ballroom-limited-panorama/u);
  assert.match(appSource, /initialOfficialPost[^\n]+URLSearchParams/u);
  assert.match(functionSource(appSource, "openOfficialPost"), /history\.pushState/u);
  assert.match(functionSource(appSource, "officialPostUrl"), /searchParams\.set\("case", id\)/u);
  assert.match(appSource, /addEventListener\("popstate"/u);
  assert.match(appSource, /if \(state\.screen !== "case"\) state\.history\.push\(state\.screen\)/u);
  assert.match(functionSource(appSource, "goBack"), /history\.(?:back|replaceState)/u);
  assert.match(
    functionSource(appSource, "navigate"),
    /state\.history\.push\(leavingOfficialCase \? "home" : state\.screen\)/u,
    "leaving a case for creation must return to the gallery, not an id-less case screen"
  );
});

test("personal-photo guards fence dialogue, memory writes, navigation state, and World handoff", () => {
  const guard = /function (is(?:Personal|UserOwned)Photo)\(/u.exec(appSource)?.[1];
  assert.ok(guard, "missing an explicit personal-photo ownership guard");
  const activePhoto = functionSource(appSource, "activePhoto");
  assert.doesNotMatch(activePhoto, /OFFICIAL|official|photos?\s*\[/u);

  for (const name of ["startDialogue", "saveMemory", "saveNavigationState", "openWorldLabs"]) {
    assert.match(functionSource(appSource, name), new RegExp(`${guard}\\(`, "u"), `${name} needs a personal-photo guard`);
  }
  const personalMarker = /(?:(?:kind|provenance):\s*"personal"|ownership:\s*"user")/u;
  assert.match(functionSource(appSource, "prepareUpload"), personalMarker);
  assert.match(functionSource(appSource, "restoreMemory"), personalMarker);
  assert.match(appSource, /handleFile\(file, source\)\.finally\(\(\) => \{ input\.value = ""; \}\)/u);
});

test("Mine contains only local personal records, never the official DAP example", () => {
  const mine = functionSource(appSource, "mineContent") + functionSource(appSource, "mineScreen");
  assert.match(mine, /state\.memories|本机|IndexedDB/u);
  assert.doesNotMatch(mine, /DAP 全景范例|ballroom|data-official-post-id|UNSEEN 官方/u);
});

test("the gallery preserves the live product spine and all provider disclosures", () => {
  assert.match(appSource, /fetch\("\/api\/question"/u);
  assert.match(appSource, /createVoiceInput/u);
  assert.match(appSource, /store\.saveMemory/u);
  assert.match(appSource, /store\.listMemories/u);
  assert.match(appSource, /store\.getMemory/u);
  assert.match(appSource, /data-space-mode="instant"/u);
  assert.match(appSource, /data-action="open-dap"/u);
  assert.match(appSource, /source=unseen-demo&mode=single/u);
  assert.match(appSource, /source=unseen-demo&mode=multi/u);
  assert.match(appSource, /生成的 3D 世界可通过公开链接访问/u);
  assert.match(appSource, /输入可能按其服务条款用于改进模型/u);
  assert.match(appSource, /照片入口不是精确空间锚点/u);
  assert.match(appSource, /公共体验额度/u);
  assert.match(appSource, /自有 3DGS/u);
  assert.match(appSource, /尚未完成整体验证，暂不开放/u);

  assert.match(dapSource, /DAP © Insta360 Research · CC BY-NC 4\.0/u);
  assert.match(dapSource, /正式商用可能需要另行授权或替换模型/u);
  assert.match(worldSource, /Marble 未返回每张照片的精确相机位姿/u);
  assert.match(worldSource, /Powered by World Labs Marble/u);
});
