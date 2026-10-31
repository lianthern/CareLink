"use strict";

const crypto = require("node:crypto");
const { AppError, invariant } = require("./errors.js");

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function hmac(secret, value, encoding = "base64url") {
  return crypto.createHmac("sha256", secret).update(String(value), "utf8").digest(encoding);
}

function sha256(value, encoding = "hex") {
  return crypto.createHash("sha256").update(value).digest(encoding);
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function signToken(payload, secret) {
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${hmac(secret, encoded)}`;
}

function verifyToken(token, secret, nowMs) {
  invariant(typeof token === "string" && token.length >= 40 && token.length <= 4096,
    "INVALID_COMMIT_TOKEN", "提交凭证无效", 401);
  const parts = token.split(".");
  invariant(parts.length === 2 && secureEqual(hmac(secret, parts[0]), parts[1]),
    "INVALID_COMMIT_TOKEN", "提交凭证无效", 401);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch (_) {
    throw new AppError("INVALID_COMMIT_TOKEN", "提交凭证无效", 401);
  }
  invariant(payload && payload.v === 1 && payload.a === "commitPhoto",
    "INVALID_COMMIT_TOKEN", "提交凭证无效", 401);
  invariant(Number.isSafeInteger(payload.exp) && payload.exp >= Math.floor(nowMs / 1000),
    "COMMIT_TOKEN_EXPIRED", "提交凭证已过期，请重新获取上传票据", 401);
  return payload;
}

module.exports = {
  base64url,
  hmac,
  randomId,
  secureEqual,
  sha256,
  signToken,
  verifyToken
};
