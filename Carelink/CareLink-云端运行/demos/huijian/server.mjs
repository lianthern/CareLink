// 回见 · demo server
//
// Deliberately dependency-free: node:http static file serving + one JSON endpoint that proxies a photo to
// MiniMax through the local question provider. All book state lives in the browser; the server
// keeps nothing, so a demo run leaves no session store to clean up.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createMiniMaxQuestionProvider } from "./lib/minimax-question-provider.mjs";
import { minimaxApiKey } from "./lib/provider-keys.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 4610);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Official mainland endpoint (api.minimax.io is the overseas one). The legacy api.minimax.chat also still
// answers on the same key if this host ever misbehaves.
const BASE_URL = process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com";
const VISION_MODEL = process.env.MINIMAX_VISION_MODEL ?? "MiniMax-M3";
const TEXT_MODEL = process.env.MINIMAX_TEXT_MODEL ?? "MiniMax-Text-01";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

const apiKey = await minimaxApiKey();

// The provider only ever sees bytes the request already carried (an uploaded data URL, or a demo photo read
// from ./photos). It never resolves a remote URL on the model's behalf.
const provider = createMiniMaxQuestionProvider({
  apiKey,
  baseUrl: BASE_URL,
  textModel: TEXT_MODEL,
  visionModel: VISION_MODEL,
  temperature: 0.8,
  maxTokens: 2000,
  requestTimeoutMs: 90_000,
  resolveImage: (input) => input.image
});

const DEMO_PHOTOS = [
  { file: "demo-celebration.jpg", caption: "雨夜小庆祝" }
];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseDataUrl(value) {
  const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(value ?? "");
  return match ? { mimeType: match[1], base64: match[2] } : null;
}

// Resolve the request's photo to raw bytes: either an inline upload, or one of the demo files by exact name.
async function resolvePhoto(photo) {
  if (typeof photo?.dataUrl === "string") return parseDataUrl(photo.dataUrl);
  const demo = DEMO_PHOTOS.find((candidate) => candidate.file === photo?.file);
  if (!demo) return null;
  const bytes = await readFile(join(ROOT, "photos", demo.file));
  return { mimeType: "image/jpeg", base64: bytes.toString("base64") };
}

async function handleQuestion(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "bad_request" });
  }
  const image = await resolvePhoto(body?.photo);
  if (!image) return json(res, 400, { error: "photo_unresolved" });

  const kind = body?.kind === "followup_question" ? "followup_question" : "initial_question";
  // The model abstains or trips output validation nondeterministically (~temperature 0.8), which would
  // break the sustained-interview flow with a fallback question. Re-rolling is honest — we never invent
  // facts, just ask the model to look again — so give it three tries before degrading.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const outcome = await provider({
        kind,
        signal: AbortSignal.timeout(120_000),
        model: VISION_MODEL,
        modelVersion: "huijian-demo",
        userText: typeof body?.userText === "string" ? body.userText.slice(-500) : undefined,
        image
      });
      return json(res, 200, {
        question: outcome.question,
        facts: outcome.modelVisibleFacts,
        model: outcome.model,
        latencyMs: outcome.latencyMs,
        degraded: false
      });
    } catch (error) {
      lastError = error;
    }
  }
  // The provider abstains rather than inventing a "visible fact". Surface that honestly and let the
  // client show its own clearly-labelled fallback prompt instead of dressing it up as a model question.
  return json(res, 200, { degraded: true, reason: lastError?.code ?? "provider_failed" });
}

async function serveStatic(req, res, pathname) {
  const relative = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/u, "");
  // Only /photos/* comes from the project root; everything else is served out of ./public.
  const candidate = relative.startsWith(`${sep}photos${sep}`)
    ? join(ROOT, relative)
    : join(ROOT, "public", relative);
  if (!candidate.startsWith(ROOT)) return json(res, 403, { error: "forbidden" });
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("not_a_file");
    const bytes = await readFile(candidate);
    res.writeHead(200, {
      "content-type": MIME[extname(candidate).toLowerCase()] ?? "application/octet-stream",
      "content-length": bytes.length,
      "cache-control": "no-store"
    });
    res.end(bytes);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
  if (req.method === "POST" && pathname === "/api/question") return handleQuestion(req, res);
  if (req.method === "GET" && (pathname === "/api/health" || pathname === "/healthz")) {
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && pathname === "/api/photos") return json(res, 200, { photos: DEMO_PHOTOS });
  if (req.method === "GET") return serveStatic(req, res, pathname);
  return json(res, 405, { error: "method_not_allowed" });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`回见 · http://127.0.0.1:${PORT}  (${VISION_MODEL} @ ${BASE_URL})`);
});
