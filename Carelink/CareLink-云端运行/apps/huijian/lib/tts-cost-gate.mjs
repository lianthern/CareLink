import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export const TTS_COST_GATE_DEFAULTS = Object.freeze({
  windowMs: 60_000,
  visitorRequestLimit: 6,
  visitorCharacterLimit: 2_000,
  globalRequestLimit: 12,
  globalCharacterLimit: 4_000
});

function normalizedIp(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim().replace(/^::ffff:/u, "");
  return isIP(candidate) ? candidate : null;
}

function singleHeader(value) {
  if (Array.isArray(value) || typeof value !== "string" || value.includes(",")) return null;
  return normalizedIp(value);
}

export function trustedVisitorIdentity(req) {
  const socketAddress = normalizedIp(req?.socket?.remoteAddress) ?? "unknown";
  if (socketAddress !== "127.0.0.1" && socketAddress !== "::1") return socketAddress;
  return singleHeader(req?.headers?.["x-huijian-visitor"]) ?? socketAddress;
}

export function ttsCharacterUnits(text) {
  if (typeof text !== "string") return 0;
  let total = 0;
  for (const character of text) total += /\p{Script=Han}/u.test(character) ? 2 : 1;
  return total;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createTtsCostGate({
  windowMs = TTS_COST_GATE_DEFAULTS.windowMs,
  visitorRequestLimit = TTS_COST_GATE_DEFAULTS.visitorRequestLimit,
  visitorCharacterLimit = TTS_COST_GATE_DEFAULTS.visitorCharacterLimit,
  globalRequestLimit = TTS_COST_GATE_DEFAULTS.globalRequestLimit,
  globalCharacterLimit = TTS_COST_GATE_DEFAULTS.globalCharacterLimit,
  now = Date.now,
  hmacKey = randomBytes(32)
} = {}) {
  const limits = {
    windowMs: positiveInteger(windowMs, TTS_COST_GATE_DEFAULTS.windowMs),
    visitorRequestLimit: positiveInteger(visitorRequestLimit, TTS_COST_GATE_DEFAULTS.visitorRequestLimit),
    visitorCharacterLimit: positiveInteger(visitorCharacterLimit, TTS_COST_GATE_DEFAULTS.visitorCharacterLimit),
    globalRequestLimit: positiveInteger(globalRequestLimit, TTS_COST_GATE_DEFAULTS.globalRequestLimit),
    globalCharacterLimit: positiveInteger(globalCharacterLimit, TTS_COST_GATE_DEFAULTS.globalCharacterLimit)
  };
  const secret = Buffer.isBuffer(hmacKey) ? hmacKey : Buffer.from(String(hmacKey));
  let windowStartedAt = Number(now());
  let globalUsage = { requests: 0, characters: 0 };
  const visitors = new Map();

  function resetIfExpired(timestamp) {
    if (timestamp < windowStartedAt + limits.windowMs) return;
    windowStartedAt = timestamp;
    globalUsage = { requests: 0, characters: 0 };
    visitors.clear();
  }

  function limited(timestamp, scope) {
    return {
      ok: false,
      reason: "tts_cost_limited",
      scope,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAt + limits.windowMs - timestamp) / 1000))
    };
  }

  return {
    reserve(identity, characters) {
      const timestamp = Number(now());
      resetIfExpired(timestamp);
      const charge = Math.max(1, positiveInteger(characters, 1));
      const key = createHmac("sha256", secret).update(String(identity || "unknown")).digest("hex").slice(0, 24);
      const visitor = visitors.get(key) ?? { requests: 0, characters: 0 };
      if (globalUsage.requests + 1 > limits.globalRequestLimit ||
        globalUsage.characters + charge > limits.globalCharacterLimit) return limited(timestamp, "global");
      if (visitor.requests + 1 > limits.visitorRequestLimit ||
        visitor.characters + charge > limits.visitorCharacterLimit) return limited(timestamp, "visitor");
      globalUsage.requests += 1;
      globalUsage.characters += charge;
      visitors.set(key, { requests: visitor.requests + 1, characters: visitor.characters + charge });
      return { ok: true };
    }
  };
}
