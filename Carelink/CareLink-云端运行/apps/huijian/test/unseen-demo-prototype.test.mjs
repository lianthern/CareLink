import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("UNSEEN 3.0 prototype keeps the primary navigation to three intentions", async () => {
  const source = await read("../public/unseen-demo.js");

  assert.match(source, /<span>看看<\/span>/u);
  assert.match(source, /aria-label="添加一段新记忆"/u);
  assert.match(source, /<span>我的<\/span>/u);
  assert.doesNotMatch(source, /<span>World Lab<\/span>/u);
  assert.doesNotMatch(source, /<span>3DGS<\/span>/u);
});

test("UNSEEN Demo exposes contextual routes only after a real personal photo appears", async () => {
  const source = await read("../public/unseen-demo.js");
  const html = await read("../public/unseen-demo.html");

  assert.match(html, /id="unseen-photo-input"[^>]+type="file"/u);
  assert.match(html, /id="unseen-camera-input"[^>]+capture="environment"/u);
  assert.match(source, /if \(!state\.photo\)[^]*noPhotoStage/u);
  assert.match(source, /data-action="choose-camera"/u);
  assert.match(source, /data-action="choose-library"/u);
  assert.doesNotMatch(source, /data-sample=/u);
  assert.doesNotMatch(source, /内置例图/u);
  assert.match(source, /聊聊这张/u);
  assert.match(source, /加入现场/u);
  assert.match(source, /走进照片/u);
  assert.match(source, /功能示意 · 尚未接入/u);
  assert.match(source, /这版不会假装上传成功/u);
});

test("UNSEEN Demo wires the honest photo-to-local-memory spine", async () => {
  const source = await read("../public/unseen-demo.js");

  assert.match(source, /fetch\("\/api\/question"/u);
  assert.match(source, /kind: followup \? "followup_question" : "initial_question"/u);
  assert.match(source, /outcome\.facts/u);
  assert.match(source, /state\.questionStatus = "degraded"/u);
  assert.match(source, /state\.questionStatus = "ready"/u);
  assert.match(source, /备用开放问题，不表示系统已经看懂照片/u);
  assert.match(source, /createVoiceInput/u);
  assert.match(source, /continuous: true/u);
  assert.match(source, /data-action="voice-turn"/u);
  assert.match(source, /说完后点“停”/u);
  assert.match(source, /转写文字还能修改/u);
  assert.match(source, /store\.saveMemory/u);
  assert.match(source, /store\.listMemories/u);
  assert.match(source, /store\.getMemory/u);
  assert.match(source, /"unseen-demo-live:model"/u);
  assert.match(source, /"unseen-demo-live:degraded"/u);
  assert.match(source, /state\.questionStatus = memory\.origin === "unseen-demo-live:model"/u);
  assert.match(source, /state\.memoryOrigin = memory\.origin \|\| ""/u);
  assert.match(source, /return contentSnapshot\(state\)/u);
  const content = await read("../public/unseen-content.js");
  assert.match(content, /state\.memoryOrigin\|\|'unseen-demo-live:restored'/u);
  assert.match(source, /memory\.question \|\| recentPair\?\.question/u);
  assert.match(source, /memory\.answer \|\| recentPair\?\.answer/u);
  assert.match(source, /if \(outcome\.degraded \|\| typeof outcome\.question !== "string"/u);
  assert.match(source, /已真实保存到“我的 → 记忆”/u);
  assert.match(source, /function resetMemoryFlow\(\) \{[^]*invalidateQuestion\(\)/u);
  assert.match(source, /if \(requestId !== state\.requestId/u);
});

test("instant space is real, reversible, and respects reduced motion", async () => {
  const source = await read("../public/unseen-demo.js");
  const css = await read("../public/unseen-demo.css");

  assert.match(source, /createDemoMemoryField/u);
  assert.match(source, /data-action="toggle-spatial"/u);
  assert.match(source, /关闭动态，回到照片/u);
  assert.match(source, /动态已关闭，已经回到原照片/u);
  assert.match(source, /prefers-reduced-motion: reduce/u);
  assert.match(source, /field\.destroy\(\)/u);
  assert.match(css, /\.instant-stage/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("question speech is an optional server-backed enhancement and never blocks text", async () => {
  const source = await read("../public/unseen-demo.js");
  const server = await read("../server.mjs");

  assert.match(source, /createTurnVoicePlayer/u);
  assert.match(source, /问题文字仍可正常使用/u);
  assert.match(server, /pathname === "\/api\/tts"/u);
  assert.match(server, /tts_not_configured/u);
});

test("server exposes the isolated prototype without changing the default route", async () => {
  const server = await read("../server.mjs");
  const installer = await read("../deploy/install.sh");

  assert.match(server, /pathname === "\/unseen-demo"/u);
  assert.match(server, /pathname === "\/unseen-3"/u);
  assert.match(server, /publicPath = "\/unseen-demo\.html"/u);
  assert.match(server, /pathname === "\/"[^\n]+publicPath = "\/spatial-lab\.html"/u);
  assert.match(installer, /GET \/unseen-demo/u);
});
