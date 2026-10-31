import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const [html, css, app, spatial, field, core, exporter] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/style.css", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/spatial-photo.js", import.meta.url), "utf8"),
  readFile(new URL("../public/spatial-memory-field.js", import.meta.url), "utf8"),
  readFile(new URL("../public/spatial-lab-core.js", import.meta.url), "utf8"),
  readFile(new URL("../public/export-memory.js", import.meta.url), "utf8")
]);

function sourceBetween(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

test("the old overlapping CSS 3D and particle system are absent", async () => {
  assert.doesNotMatch(html, /spatial-depth-backdrop|result-spatial-backdrop|spatial-memory-mesh|result-particle-clip/u);
  assert.doesNotMatch(css, /has-particle-field|--spatial-tilt|--result-spatial-tilt|translateZ\(|transform-style:\s*preserve-3d/u);
  assert.doesNotMatch(spatial, /createLivingParticleField|setDepthProperties|pointerDepth/u);
  await assert.rejects(access(new URL("../public/spatial-particle-field.js", import.meta.url)));
});

test("chat and result each contain exactly one Demo-derived field canvas inside the photo face", () => {
  assert.equal((html.match(/id="memory-particles"/gu) ?? []).length, 1);
  assert.equal((html.match(/id="result-memory-particles"/gu) ?? []).length, 1);
  assert.match(html, /<div class="spatial-photo-face">\s*<canvas id="memory-particles"[^>]*hidden><\/canvas>\s*<img id="chat-photo"/u);
  assert.match(html, /<div class="memory-photo-face">\s*<canvas id="result-memory-particles"[^>]*hidden><\/canvas>\s*<img id="result-photo"/u);
  assert.match(css, /#memory-particles,\s*#result-memory-particles\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100%/su);
  assert.match(css, /has-memory-field #memory-particles:not\(\[hidden\]\) \+ #chat-photo/u);
  assert.match(css, /has-memory-field #result-memory-particles:not\(\[hidden\]\) \+ #result-photo/u);
});

test("production promotes the same persistent velocity field and photo surface used by the Demo", () => {
  assert.match(field, /import \{[\s\S]*flowVector,[\s\S]*particleSeed,[\s\S]*timelineState[\s\S]*\} from "\.\/spatial-lab-core\.js"/u);
  assert.match(field, /https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.181\.2\/build\/three\.module\.js/u);
  assert.match(field, /const velocities = new Float32Array\(count \* 3\)/u);
  assert.match(field, /positionAttribute\.setUsage\(THREE\.DynamicDrawUsage\)/u);
  assert.match(field, /velocities\[offset\] \+= \(desiredX - positions\[offset\]\) \* spring/u);
  assert.match(field, /positions\[offset\] \+= velocities\[offset\] \* deltaScale/u);
  assert.match(field, /particles\.geometry\.attributes\.position\.needsUpdate = true/u);
  assert.match(field, /makePortalSurface\(\);\s*makeParticles\(photoData\)/u);
  assert.match(field, /canvas\.dataset\.motionEnergy = motionEnergy\.toFixed\(6\)/u);
  assert.match(core, /if \(viewportWidth < 520\) return 15000;[\s\S]*return 36000;/u);
});

test("voice drives the Demo ribbon while motion continues after formation", () => {
  assert.match(field, /const voiceMorph = smoothstep\(\.035, \.48, voice\)/u);
  assert.match(field, /const ribbonX = voiceTargets\[offset\]/u);
  assert.match(field, /audioLevel = audioEnvelope\(audioLevel, listening \? audioTarget : 0\)/u);
  assert.match(app, /spatialPhoto\?\.setAudioLevel\(level\)/u);
  assert.match(app, /spatialPhoto\?\.setListening\(name === "listening" \|\| name === "processing"\)/u);
  assert.match(field, /fieldTime \+= deltaSeconds \* SETTINGS\.flowSpeed/u);
  assert.match(field, /if \(!settledSent && introProgress >= \.98\)/u);
});

test("single-field lifecycle remains non-blocking, reduced-motion safe and off exports", () => {
  assert.match(app, /const spatialResultField = createSpatialResultField/u);
  assert.match(app, /createSpatialResultField\(\{[\s\S]*stage: \$\("memory-page"\),[\s\S]*image: \$\("result-photo"\),[\s\S]*canvas: \$\("result-memory-particles"\)[\s\S]*\}\)/u);
  assert.match(spatial, /field\.stop\(\{ keepWanted: true \}\)/u);
  assert.match(spatial, /event\.pointerType === "touch"/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*#memory-particles,[\s\S]*#result-memory-particles \{ display: none; \}/u);
  assert.doesNotMatch(exporter, /memory-particles|spatial-memory-field|createSpatialResultField/u);
  assert.match(css, /@media print[\s\S]*#memory-particles,[\s\S]*#result-memory-particles,[\s\S]*\.spatial-memory-field \{ display: none !important; \}/u);
  assert.match(sourceBetween(app, "function reset(", "function readFile("), /spatialResultField\.resetSession\(\)/u);
  assert.match(sourceBetween(app, "function startConversation(", "function resetVoicePrompt("), /spatialResultField\.resetSession\(\)/u);
  assert.match(sourceBetween(app, "function restoreStoredMemory(", "async function handleCollectionAction("), /spatialResultField\.resetSession\(\)/u);
});
