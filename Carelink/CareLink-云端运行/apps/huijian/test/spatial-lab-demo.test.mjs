import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, server] = await Promise.all([
  readFile(new URL("../public/spatial-lab.html", import.meta.url), "utf8"),
  readFile(new URL("../public/spatial-lab.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8")
]);

test("the main experience exposes the three controls that separate particles from a flat photo", () => {
  assert.match(html, /id="surface-opacity"/u);
  assert.match(html, /id="scatter"/u);
  assert.match(html, /id="density"/u);
  assert.match(script, /surfaceOpacity: 0\.18/u);
  assert.match(script, /scatter: 0\.28/u);
  assert.match(script, /density: 0\.64/u);
  assert.match(script, /const INTRO_MS = 9000/u);
  assert.match(script, /positions\[offset\] = targets\[offset\]/u);
  assert.match(script, /methodStatus\.textContent = "正在读取新照片；粒子场准备好后会从原图开始。"/u);
});

test("the photo dialogue is the HUIJIAN root experience and keeps the Demo URL as an alias", () => {
  assert.match(server, /pathname === "\/" \|\| pathname === "\/demo"/u);
  assert.match(server, /"\/spatial-lab\.html"/u);
  assert.match(html, /<title>回见 · 和 AI 聊照片<\/title>/u);
  assert.match(html, /回见主体验/u);
  assert.doesNotMatch(html, /独立 DEMO|不影响回见主版本/u);
});

test("the main experience can turn the photo through 360 degrees and renders a real back surface", () => {
  assert.match(html, /id="flip-photo"/u);
  assert.match(html, /id="orbit-angle"/u);
  assert.match(script, /let portalBack;/u);
  assert.match(script, /side: THREE\.BackSide/u);
  assert.match(script, /orbitTargetYaw \+= Math\.PI/u);
  assert.match(script, /orbitTargetYaw \+= deltaX \* 0\.012/u);
});

test("AI automatically reads the clear original and three guided turns progressively reveal the photo", () => {
  assert.match(html, /id="dialogue-form"/u);
  assert.match(html, /id="dialogue-progress"/u);
  assert.match(html, /id="rebuild-meter"/u);
  assert.match(script, /dialogueClarityTarget = dialogueRound \/ 3/u);
  assert.match(script, /dialoguePhoto = \{ dataUrl: photoData\.source\.toDataURL/u);
  assert.match(script, /void startDialogue\(\);/u);
  assert.match(script, /uFocusStrength/u);
  assert.match(script, /fetch\("\/api\/memory-dialogue"/u);
  assert.match(server, /pathname === "\/api\/memory-dialogue"/u);
  assert.match(server, /MEMORY_DIALOGUE_SYSTEM_PROMPT/u);
  assert.match(server, /始终是用户上传的清晰原图/u);
  assert.match(server, /你已经负责识图/u);
  assert.match(server, /是什么\|叫什么\|什么东西/u);
  assert.match(html, /AI 已读取原图/u);
  assert.doesNotMatch(html, /把照片讲回来|照片会忘记/u);
});
