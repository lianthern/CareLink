// Dependency-free smoke check: keep the single-photo companion flow and its safety guarantees intact.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const port = 40_000 + process.pid % 20_000;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, MINIMAX_API_KEY: "not-a-real-ui-smoke-test", PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server_did_not_start");
}

try {
  await waitForServer();
  const [htmlResponse, cssResponse, appResponse] = await Promise.all([
    fetch(`${origin}/`),
    fetch(`${origin}/style.css`),
    fetch(`${origin}/app.js`)
  ]);
  assert.equal(htmlResponse.status, 200);
  assert.equal(cssResponse.status, 200);
  assert.equal(appResponse.status, 200);

  const [html, css, app] = await Promise.all([
    htmlResponse.text(),
    cssResponse.text(),
    appResponse.text()
  ]);
  assert.match(html, /id="start-agent"/u);
  assert.match(html, /id="chat-agent"/u);
  assert.match(html, /id="memory-page"/u);
  assert.match(html, /id="photo-input"[^>]*type="file"(?![^>]*multiple)/u);
  assert.match(html, /照片与回答会发送给 MiniMax 生成提问；本站不持久保存/u);
  assert.doesNotMatch(html, /第\s*1\s*句|最多\s*3\s*句/u);
  for (const state of ["entering", "seeing", "thinking", "asking", "closing"]) {
    assert.match(app, new RegExp(`"${state}"`, "u"));
    assert.match(css, new RegExp(`\\.agent\\.${state}`, "u"));
  }
  assert.match(css, /font-size: 18px/u);
  assert.match(css, /\.question \{[\s\S]*?font-size: 22px/u);
  assert.match(css, /min-height: 48px/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /@media print/u);
  assert.match(app, /answer\.textContent = pair\.answer/u);
  assert.match(app, /我看到了：\$\{clean\.join/u);
  assert.match(app, /这张我没看清，所以我不猜/u);
  assert.doesNotMatch(app, /\.innerHTML\s*=/u);

  const invalidPhoto = await fetch(`${origin}/api/question`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ photo: { file: "not-allowed.jpg" } })
  });
  assert.equal(invalidPhoto.status, 400);
  assert.deepEqual(await invalidPhoto.json(), { error: "photo_unresolved" });
  console.log("UI smoke check passed");
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
}

// Also ensure the checked artifact is the same file served by the app, not a copied fixture.
assert.match(await readFile(new URL("../public/app.js", import.meta.url), "utf8"), /reset\(\{ focus: false \}\);/u);
