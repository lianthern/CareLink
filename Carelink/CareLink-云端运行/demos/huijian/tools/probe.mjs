// Probe: which MiniMax base URL + model actually answers with this key, on a real photo.
// Prints only base/model/ok/ms and a short excerpt. Never prints the key.
import { readFile } from "node:fs/promises";
import { minimaxApiKey } from "../lib/provider-keys.mjs";

const bases = ["https://api.minimaxi.com", "https://api.minimax.chat"];
const textModels = ["MiniMax-M2", "MiniMax-Text-01"];
const visionModels = ["MiniMax-M3", "MiniMax-VL-01"];

const apiKey = await minimaxApiKey();
const photo = await readFile(new URL("../photos/demo-celebration.jpg", import.meta.url));
const dataUrl = `data:image/jpeg;base64,${photo.toString("base64")}`;

async function call(base, model, messages) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_completion_tokens: 300, stream: false }),
      signal: AbortSignal.timeout(45_000)
    });
    const ms = Date.now() - started;
    const body = await res.text();
    let excerpt = body.slice(0, 200).replace(/\s+/g, " ");
    return { ok: res.ok, status: res.status, ms, excerpt };
  } catch (error) {
    return { ok: false, status: "throw", ms: Date.now() - started, excerpt: String(error.message).slice(0, 120) };
  }
}

for (const base of bases) {
  for (const model of textModels) {
    const r = await call(base, model, [{ role: "user", content: "只回复两个字：在的" }]);
    console.log(`TEXT  ${base} ${model} -> ok=${r.ok} status=${r.status} ${r.ms}ms | ${r.excerpt}`);
  }
  for (const model of visionModels) {
    const r = await call(base, model, [{
      role: "user",
      content: [{ type: "text", text: "用一句话客观描述这张照片里最确定的一个细节。" },
        { type: "image_url", image_url: { url: dataUrl } }]
    }]);
    console.log(`VISION ${base} ${model} -> ok=${r.ok} status=${r.status} ${r.ms}ms | ${r.excerpt}`);
  }
}
