import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, css, app, viewer, server, service, secret] = await Promise.all([
  readFile(new URL("../public/world-lab.html", import.meta.url), "utf8"),
  readFile(new URL("../public/world-lab.css", import.meta.url), "utf8"),
  readFile(new URL("../public/world-lab.js", import.meta.url), "utf8"),
  readFile(new URL("../public/world-viewer.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../deploy/unseen-huijian.service", import.meta.url), "utf8"),
  readFile(new URL("../lib/provider-keys.mjs", import.meta.url), "utf8")
]);

test("/world opens with honest same-scene reconstruction and preserves single-photo mode", () => {
  assert.match(server, /pathname === "\/world"[\s\S]*"\/world-lab\.html"/u);
  assert.match(html, /WORLD LAB/u);
  assert.match(html, /同场景 2–8 图 → 一个 3D 世界/u);
  assert.match(html, /id="mode-multi"[\s\S]*aria-pressed="true"/u);
  assert.match(html, /id="mode-single"/u);
  assert.match(html, /Marble 未返回每张照片的精确相机位姿/u);
  assert.match(html, /Powered by World Labs Marble/u);
  assert.match(html, /长视频全域重建 \/ bullet time 属于 Atlas 早期能力/u);
});

test("generation requires an explicit public-world consent and never ships a provider key", () => {
  assert.match(html, /id="public-consent" type="checkbox"/u);
  assert.match(app, /publicConsent: consent\.checked/u);
  assert.match(server, /body\?\.publicConsent !== true/u);
  assert.match(server, /worldLabsApiKey/u);
  assert.match(secret, /WORLDLABS_API_KEY/u);
  assert.doesNotMatch(html + app + viewer, /WORLDLABS_API_KEY|WLT-Api-Key/u);
});

test("the client compresses source photos, resumes with local portals, and renders SPZ on-domain", () => {
  assert.match(app, /mode === "multi" \? 1400 : 1600/u);
  assert.match(app, /localStorage\.setItem\(RESUME_KEY/u);
  assert.match(app, /searchParams\.set\("operation", operationId\)/u);
  assert.match(app, /OPERATION_ID\.test\(linkedOperationId/u);
  assert.match(app, /indexedDB\.open\(SOURCE_DB, 1\)/u);
  assert.match(app, /renderPhotoPortals/u);
  assert.match(app, /setTimeout\(\(\) => void pollOperation\(operationId\), 8000\)/u);
  assert.match(viewer, /SplatMesh/u);
  assert.match(viewer, /world\?\.splats\?\.standard/u);
  assert.match(viewer, /splats\.quaternion\.set\(1, 0, 0, 0\)/u);
  assert.match(viewer, /PerspectiveCamera\(75/u);
  assert.match(viewer, /camera\.position\.set\(0, 1\.4, 3\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("the public experiment has a persistent cost gate", () => {
  assert.match(server, /WORLDLABS_DAILY_LIMIT/u);
  assert.match(server, /WORLDLABS_VISITOR_DAILY_LIMIT/u);
  assert.match(server, /worldLabsQuota\.reserve\(requestIdentity\(req\)\)/u);
  assert.match(service, /StateDirectory=huijian/u);
});

test("the server constrains reconstruction inputs before spending provider credits", () => {
  assert.match(server, /WORLDLABS_MAX_IMAGES = 8/u);
  assert.match(server, /WORLDLABS_MAX_TOTAL_IMAGE_BYTES/u);
  assert.match(server, /rawImages\.length < minimum \|\| rawImages\.length > maximum/u);
  assert.match(server, /generateMultiImageWorld/u);
  assert.match(server, /worldLabsQuota\.reserve/u);
});
