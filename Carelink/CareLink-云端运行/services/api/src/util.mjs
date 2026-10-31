import { createHash, randomBytes, randomUUID } from "node:crypto";

export const nowIso = (clock = Date) => new Date(clock.now()).toISOString();
export const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
export const secret = () => randomBytes(32).toString("base64url");

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

export function json(value) {
  return JSON.stringify(value);
}

export function requireObject(body) {
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

export function exactFields(body, allowed, required = []) {
  const object = requireObject(body);
  for (const field of Object.keys(object)) {
    if (!allowed.includes(field)) return { ok: false, field };
  }
  for (const field of required) {
    if (!(field in object)) return { ok: false, field };
  }
  return { ok: true, value: object };
}

export function integer(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

export function futureIso(value, now = Date.now()) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now ? new Date(time).toISOString() : null;
}

// Structured, single-line JSON log for operational events that must never carry an email address
// or OTP code (see callers: identity-service.mjs's claimOtpCounter and otp-delivery-outbox.mjs's
// claimSendBudget). Every other service module is silent today -- this is the smallest step that
// makes rate-limit/budget hits observable without inventing a logging framework; a future
// Telegram-alert consumer can just tail stdout for these `event` values.
export function logStructured(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, at: new Date().toISOString(), ...fields })}\n`);
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|ticket|cookie|signedurl|sameoriginurl|bootstrapurlonce/i.test(key)) continue;
    result[key] = redact(item);
  }
  return result;
}
