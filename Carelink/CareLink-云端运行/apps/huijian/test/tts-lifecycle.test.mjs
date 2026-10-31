import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createMiniMaxTtsProvider } from "../lib/minimax-tts-provider.mjs";
import { createMiniMaxQuestionProvider } from "../lib/minimax-question-provider.mjs";

async function upstream(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const audio = JSON.stringify({ base_resp: { status_code: 0 }, data: { status: 2, audio: "fffb90" } });

for (const mode of ["timeout", "abort"]) {
  test(`TTS ${mode} covers slow body after real HTTP headers`, async (t) => {
    let headersSent;
    const headers = new Promise((resolve) => { headersSent = resolve; });
    let closed;
    const disconnected = new Promise((resolve) => { closed = resolve; });
    const baseUrl = await upstream(t, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(" ");
      res.on("close", closed);
      headersSent();
      // Do not finish the response: the provider must terminate it, not a fixture timer.
    });
    const controller = new AbortController();
    const provider = createMiniMaxTtsProvider({ apiKey: "not-a-real-local-test", baseUrl, requestTimeoutMs: mode === "timeout" ? 120 : 2000 });
    const started = performance.now();
    const result = provider({ text: "你好", signal: controller.signal });
    const checked = assert.rejects(result, { code: mode === "timeout" ? "tts_timeout" : "tts_aborted" });
    await headers;
    if (mode === "abort") { await new Promise((r) => setTimeout(r, 20)); controller.abort(); }
    await checked;
    assert.ok(performance.now() - started < 1500);
    await Promise.race([disconnected, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("upstream connection was not closed")), 1000);
      timer.unref();
    })]);
  });
}

test("TTS oversized streamed body is stopped before it ends", async (t) => {
  const baseUrl = await upstream(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write(' {"audio":"' + "a".repeat(70 * 1024));
  });
  const provider = createMiniMaxTtsProvider({ apiKey: "not-a-real-local-test", baseUrl, maximumAudioBytes: 10, requestTimeoutMs: 2000 });
  await assert.rejects(provider({ text: "你好" }), { code: "tts_audio_too_large" });
});

test("TTS still returns complete valid audio over HTTP", async (t) => {
  const baseUrl = await upstream(t, (_req, res) => res.end(audio));
  const provider = createMiniMaxTtsProvider({ apiKey: "not-a-real-local-test", baseUrl });
  assert.deepEqual((await provider({ text: "你好" })).audio, Buffer.from("fffb90", "hex"));
});

for (const mode of ["timeout", "abort"]) {
  test(`photo provider distinguishes ${mode} during a slow HTTP body`, async (t) => {
    let headersSent;
    const headers = new Promise((resolve) => { headersSent = resolve; });
    const baseUrl = await upstream(t, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(" ");
      headersSent();
    });
    const controller = new AbortController();
    const provider = createMiniMaxQuestionProvider({ apiKey: "not-a-real-local-test", baseUrl, requestTimeoutMs: mode === "timeout" ? 120 : 2000 });
    const result = provider({ signal: controller.signal, kind: "initial_question", visibleFacts: ["桌上有杯子"], model: "test", modelVersion: "test" });
    const checked = assert.rejects(result, { code: mode === "timeout" ? "minimax_timeout" : "minimax_aborted" });
    await headers;
    if (mode === "abort") { await new Promise((r) => setTimeout(r, 20)); controller.abort(); }
    await checked;
  });
}

test("photo provider already cancelled never contacts upstream", async (t) => {
  let calls = 0;
  const baseUrl = await upstream(t, (_req, res) => { calls += 1; res.end("{}"); });
  const controller = new AbortController();
  controller.abort();
  const provider = createMiniMaxQuestionProvider({ apiKey: "not-a-real-local-test", baseUrl });
  await assert.rejects(provider({ signal: controller.signal, kind: "initial_question", visibleFacts: ["杯子"], model: "test", modelVersion: "test" }), { code: "minimax_aborted" });
  assert.equal(calls, 0);
});
