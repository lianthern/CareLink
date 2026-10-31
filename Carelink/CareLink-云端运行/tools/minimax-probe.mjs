#!/usr/bin/env node
// Standalone MiniMax API connectivity probe. Not part of the book-lab build/test graph and not imported by any
// production code — this is a one-off diagnostic tool for whoever holds the real UNSEEN_MINIMAX_API_KEY to run
// by hand (this session never had that key and never ran this script against the live API).
//
// Usage:
//   UNSEEN_MINIMAX_API_KEY=sk-... node tools/minimax-probe.mjs
//   UNSEEN_MINIMAX_KEY_FILE=/absolute/path/to/key node tools/minimax-probe.mjs
//
// Optional overrides (all have sane defaults matching services/book-lab's MiniMax provider):
//   UNSEEN_MINIMAX_BASE_URL           default https://api.minimaxi.com
//   UNSEEN_MINIMAX_TEXT_MODEL         default MiniMax-M2   (text-only probe)
//   UNSEEN_MINIMAX_VISION_MODEL       default MiniMax-M3   (vision probe — the only documented multimodal model
//                                                            as of this writing; MiniMax-VL-01 has been
//                                                            superseded, see the accompanying report)
//   UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS default 20000
//
// Output contract: exactly one line per probe, containing only the model name, success flag, round-trip
// milliseconds, and the first 80 characters of the response summary (or of the failure code on error). The API
// key is read once into a local variable and is never printed, logged, included in an error message, or written
// to any file by this script.
import { readFileSync } from "node:fs";
import path from "node:path";

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

// A minimal, valid 1x1 transparent PNG, embedded so the vision probe needs no local file and never reads or
// sends any real photo. Swap in a real (non-sensitive) local image path via --image <path> if you want a more
// meaningful vision smoke test.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function env(name, fallback) {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function resolveApiKey() {
  const direct = process.env.UNSEEN_MINIMAX_API_KEY;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const file = process.env.UNSEEN_MINIMAX_KEY_FILE;
  if (typeof file === "string" && file.length > 0) {
    if (!path.isAbsolute(file)) {
      throw new Error("UNSEEN_MINIMAX_KEY_FILE must be an absolute path");
    }
    const trimmed = readFileSync(file, "utf8").trim();
    if (trimmed.length === 0) throw new Error(`UNSEEN_MINIMAX_KEY_FILE (${file}) is empty`);
    return trimmed;
  }
  return null;
}

function truncate80(text) {
  const characters = [...String(text ?? "")];
  return characters.slice(0, 80).join("");
}

function parseArgs(argv) {
  const args = { imagePath: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--image" && typeof argv[index + 1] === "string") {
      args.imagePath = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function callMiniMax({ apiKey, baseUrl, model, messages, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_completion_tokens: 200, stream: false }),
      signal: controller.signal
    });
    const ms = Date.now() - started;
    if (!response.ok) {
      let bodyPreview = "";
      try { bodyPreview = truncate80(await response.text()); } catch { /* ignore */ }
      return { ok: false, ms, summary: `http_${response.status}${bodyPreview ? ` ${bodyPreview}` : ""}` };
    }
    let payload;
    try { payload = await response.json(); }
    catch { return { ok: false, ms, summary: "invalid_json_response" }; }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return { ok: false, ms, summary: "empty_response_content" };
    }
    return { ok: true, ms, summary: truncate80(content.trim()) };
  } catch (error) {
    const ms = Date.now() - started;
    const code = error?.name === "AbortError" ? "timeout" : (error?.code || error?.message || "request_failed");
    return { ok: false, ms, summary: truncate80(String(code)) };
  } finally {
    clearTimeout(timer);
  }
}

function printResult(label, model, result) {
  const line = `[${label}] model=${model} ok=${result.ok} ms=${result.ms} summary=${JSON.stringify(result.summary)}`;
  process.stdout.write(`${line}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let apiKey;
  try {
    apiKey = resolveApiKey();
  } catch (error) {
    process.stderr.write(`minimax-probe: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (!apiKey) {
    process.stderr.write("minimax-probe: set UNSEEN_MINIMAX_API_KEY or UNSEEN_MINIMAX_KEY_FILE (absolute path) " +
      "before running this probe.\n");
    process.exitCode = 1;
    return;
  }

  const baseUrl = env("UNSEEN_MINIMAX_BASE_URL", "https://api.minimaxi.com");
  const textModel = env("UNSEEN_MINIMAX_TEXT_MODEL", "MiniMax-M2");
  const visionModel = env("UNSEEN_MINIMAX_VISION_MODEL", "MiniMax-M3");
  const timeoutMs = Number(env("UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS", "20000"));

  // Probe 1: plain text, one round.
  const textResult = await callMiniMax({
    apiKey, baseUrl, model: textModel, timeoutMs,
    messages: [
      { role: "system", content: "你是一个简短问候的测试助手。用一句话中文回复即可。" },
      { role: "user", content: "你好，这是一次连通性探测，请用一句话回复确认收到。" }
    ]
  });
  printResult("text", textModel, textResult);

  // Probe 2: a small image, asking what's in it.
  let imageUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
  if (args.imagePath) {
    if (!path.isAbsolute(args.imagePath)) {
      process.stderr.write("minimax-probe: --image must be an absolute path\n");
      process.exitCode = 1;
      return;
    }
    const bytes = readFileSync(args.imagePath);
    const ext = path.extname(args.imagePath).toLowerCase();
    const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    imageUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
  }
  const visionResult = await callMiniMax({
    apiKey, baseUrl, model: visionModel, timeoutMs,
    messages: [
      { role: "system", content: "你是一个视觉理解连通性探测助手。用一句简短中文描述图里有什么。" },
      { role: "user", content: [
        { type: "text", text: "图里有什么？" },
        { type: "image_url", image_url: { url: imageUrl } }
      ] }
    ]
  });
  printResult("vision", visionModel, visionResult);

  if (!textResult.ok && !visionResult.ok) process.exitCode = 1;
}

await main();
