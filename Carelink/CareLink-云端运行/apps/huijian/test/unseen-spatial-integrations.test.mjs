import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("UNSEEN routes its three working spatial modes through one screen", async () => {
  const source = await read("../public/unseen-demo.js");

  assert.match(source, /data-space-mode="instant"/u);
  assert.match(source, /data-space-mode="dap"/u);
  assert.match(source, /data-space-mode="world"/u);
  assert.match(source, /自有 3DGS 重建/u);
  assert.match(source, /尚未完成整体验证，暂不开放/u);
  assert.match(source, /data-action="open-dap"/u);
  assert.match(source, /data-overlay="world-consent"/u);
  assert.match(source, /saveNavigationState/u);
  assert.match(source, /restoreNavigationState/u);
  assert.match(source, /state\.screen = record\.draft\?\.screen \|\| "space"/u);
});

test("the DAP example is a real depth-limited panorama with an explicit commercial boundary", async () => {
  const [viewer, server] = await Promise.all([
    read("../public/unseen-dap.html"),
    read("../server.mjs")
  ]);

  assert.match(server, /pathname === "\/unseen-dap"[\s\S]*publicPath = "\/unseen-dap\.html"/u);
  assert.match(viewer, /depthPngUrl: "\/unseen-dap\/v1\/assets\/" \+ scene\.slug \+ "-depth\.png"/u);
  assert.match(viewer, /interactionMode: allowWalk \? "limited-parallax" : "rotation-only"/u);
  assert.match(viewer, /var DEFAULT_MAX_WALK_RADIUS = 0\.42/u);
  assert.match(viewer, /DAP © Insta360 Research · CC BY-NC 4\.0/u);
  assert.match(viewer, /正式商用可能需要另行授权或替换模型/u);
});

test("World Labs entry explains the provider boundary and carries the current photo without auto-submitting", async () => {
  const [entry, world] = await Promise.all([
    read("../public/unseen-demo.js"),
    read("../public/world-lab.js")
  ]);

  assert.match(entry, /生成的 3D 世界可通过公开链接访问/u);
  assert.match(entry, /输入可能按其服务条款用于改进模型/u);
  assert.match(entry, /const photo = activePhoto\(\)/u);
  assert.match(entry, /saveWorldHandoff\(await prepareWorldHandoff\(photo\)\)/u);
  assert.match(entry, /source=unseen-demo&mode=single/u);
  assert.match(entry, /source=unseen-demo&mode=multi/u);
  assert.match(world, /UNSEEN_HANDOFF_RECORD = "unseen-handoff"/u);
  assert.match(world, /applyMode\("single", \{ clear: false \}\)/u);
  assert.match(world, /确认说明后即可生成/u);
  assert.doesNotMatch(entry, /publicConsent: true/u);
});
