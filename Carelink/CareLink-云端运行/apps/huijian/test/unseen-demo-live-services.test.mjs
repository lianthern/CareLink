import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMiniMaxTtsProvider, MiniMaxTtsError } from "../lib/minimax-tts-provider.mjs";
import { createTtsCostGate, trustedVisitorIdentity, ttsCharacterUnits } from "../lib/tts-cost-gate.mjs";
import { createTurnVoicePlayer } from "../public/turn-voice.js";

test("MiniMax TTS returns binary audio without exposing provider JSON to the browser", async () => {
  let request;
  const provider = createMiniMaxTtsProvider({
    apiKey: "not-a-real-test-key",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        data: { status: 2, audio: "49443304" },
        base_resp: { status_code: 0 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const outcome = await provider({ text: "回见" });
  assert.equal(request.url, "https://api.minimax.cn/v1/t2a_v2");
  assert.equal(request.options.headers.authorization, "Bearer not-a-real-test-key");
  assert.equal(JSON.parse(request.options.body).text, "回见");
  assert.deepEqual([...outcome.audio], [73, 68, 51, 4]);
  assert.equal(outcome.mimeType, "audio/mpeg");
});

test("TTS without a key is an honest optional-service failure", async () => {
  const provider = createMiniMaxTtsProvider({ apiKey: null });
  await assert.rejects(provider({ text: "文字仍可使用" }), (error) => (
    error instanceof MiniMaxTtsError && error.code === "tts_not_configured"
  ));
});

test("TTS cost gate counts Han conservatively and ignores forged forwarded chains", () => {
  let now = 1_000;
  const gate = createTtsCostGate({
    now: () => now,
    hmacKey: Buffer.alloc(32, 7),
    visitorRequestLimit: 1,
    globalRequestLimit: 4
  });
  assert.equal(ttsCharacterUnits("回见 A"), 6);
  assert.deepEqual(gate.reserve("198.51.100.2", 6), { ok: true });
  assert.equal(gate.reserve("198.51.100.2", 1).ok, false);
  now += 60_001;
  assert.deepEqual(gate.reserve("198.51.100.2", 1), { ok: true });
  assert.equal(trustedVisitorIdentity({
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-huijian-visitor": "198.51.100.9", "x-forwarded-for": "203.0.113.3, 203.0.113.4" }
  }), "198.51.100.9");
});

test("question voice fails without hiding or mutating the readable question", async () => {
  const states = [];
  const question = "照片之外，你还想留下哪句话？";
  const player = createTurnVoicePlayer({
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).text, question);
      return new Response(JSON.stringify({ error: "tts_not_configured" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    },
    onState: (state) => states.push(state)
  });

  assert.equal(await player.speak(question), false);
  assert.equal(states.at(-1).phase, "error");
  assert.equal(states.at(-1).code, "unavailable");
  assert.equal(question, "照片之外，你还想留下哪句话？");
});

test("deployment forwards a trusted visitor identity and preserves optional TTS configuration", async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [caddy, install, push] = await Promise.all([
    read("../deploy/Caddyfile.huijian"),
    read("../deploy/install.sh"),
    read("../deploy/push.sh")
  ]);
  assert.match(caddy, /header_up X-Huijian-Visitor \{remote_host\}/u);
  assert.match(push, /HUIJIAN_SSH_KEY 路径含不支持的引号或换行/u);
  assert.match(push, /RSYNC_RSH="ssh -i '\$HUIJIAN_SSH_KEY' -o IdentitiesOnly=yes"/u);
  for (const name of [
    "MINIMAX_TTS_BASE_URL", "MINIMAX_TTS_MODEL", "MINIMAX_TTS_VOICE_ID",
    "TTS_COST_WINDOW_MS", "TTS_VISITOR_REQUEST_LIMIT", "TTS_VISITOR_CHARACTER_LIMIT",
    "TTS_GLOBAL_REQUEST_LIMIT", "TTS_GLOBAL_CHARACTER_LIMIT"
  ]) {
    assert.match(install, new RegExp(`update_env ${name}`, "u"));
    assert.match(push, new RegExp(name, "u"));
  }
  assert.match(install, /GET \/unseen-demo/u);
});
