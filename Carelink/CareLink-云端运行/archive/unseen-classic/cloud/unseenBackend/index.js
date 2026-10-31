"use strict";

const { AppError, invariant } = require("./lib/errors.js");
const { secureEqual, randomId } = require("./lib/crypto.js");
const { loadConfig } = require("./lib/config.js");
const { OssV1Adapter } = require("./lib/oss-v1.js");
const { makeService } = require("./lib/service.js");

let cachedRuntime;

function runtime() {
  if (cachedRuntime) return cachedRuntime;
  const config = loadConfig(process.env);
  const oss = new OssV1Adapter({
    bucket: config.bucket,
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    securityToken: config.securityToken
  });
  cachedRuntime = { config, service: makeService({ oss, config }) };
  return cachedRuntime;
}

function normalizedHeaders(headers) {
  const result = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    result[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : String(value);
  });
  return result;
}

function corsHeaders(config, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Unseen-Host-Key, X-Unseen-Maintenance-Token",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin"
  };
  if (origin && (config.corsOrigins.includes("*") || config.corsOrigins.includes(origin))) {
    headers["Access-Control-Allow-Origin"] = config.corsOrigins.includes("*") ? "*" : origin;
  }
  return headers;
}

function response(statusCode, payload, headers) {
  return { statusCode, headers, isBase64Encoded: false, body: JSON.stringify(payload) };
}

function parseBody(event) {
  if (event.body === undefined || event.body === null || event.body === "") return {};
  if (typeof event.body === "object") return event.body;
  let raw;
  try {
    raw = event.isBase64Encoded
      ? Buffer.from(String(event.body), "base64").toString("utf8")
      : String(event.body);
  } catch (_) {
    throw new AppError("INVALID_BODY", "请求体编码无效", 400);
  }
  invariant(Buffer.byteLength(raw, "utf8") <= 64 * 1024,
    "BODY_TOO_LARGE", "请求体不能超过 64 KB", 413);
  try { return JSON.parse(raw); } catch (_) {
    throw new AppError("INVALID_JSON", "请求体不是有效 JSON", 400);
  }
}

function sourceIp(event) {
  return String(event.requestContext && (
    event.requestContext.sourceIp ||
    event.requestContext.identity && event.requestContext.identity.sourceIp
  ) || event.clientIP || "unknown").slice(0, 128);
}

function isTimer(event) {
  if (event.httpMethod || event.requestContext && event.requestContext.http) return false;
  const type = String(event.Type || event.type || event.triggerType || "").toLowerCase();
  return type === "timer" || type === "timertrigger" || Boolean(event.TriggerName || event.triggerName);
}

async function main(event = {}, context = {}) {
  const requestId = String(context.request_id || context.requestId || randomId(8)).slice(0, 128);
  let action = "unknown";
  try {
    const { config, service } = runtime();
    if (isTimer(event)) {
      const data = await service.handle("maintenance", {}, { requestId, timer: true });
      return { ok: true, requestId, data };
    }

    const headers = normalizedHeaders(event.headers);
    const origin = headers.origin || "";
    const cors = corsHeaders(config, origin);
    if (origin && !cors["Access-Control-Allow-Origin"]) {
      return response(403, { ok: false, requestId, error: {
        code: "ORIGIN_NOT_ALLOWED", message: "该网页来源不允许访问此接口"
      } }, cors);
    }
    const method = String(event.httpMethod || "POST").toUpperCase();
    if (method === "OPTIONS") return response(204, {}, cors);
    invariant(method === "GET" || method === "POST", "METHOD_NOT_ALLOWED", "请求方法不支持", 405);
    const body = method === "GET" ? {} : parseBody(event);
    action = String(body.action || event.queryStringParameters && event.queryStringParameters.action ||
      (method === "GET" ? "health" : ""));
    invariant(method !== "GET" || action === "health", "METHOD_NOT_ALLOWED", "GET 只支持健康检查", 405);
    if (action === "maintenance") {
      invariant(config.maintenanceToken && headers["x-unseen-maintenance-token"] &&
        secureEqual(config.maintenanceToken, headers["x-unseen-maintenance-token"]),
      "MAINTENANCE_AUTH_FAILED", "维护凭证无效", 401);
    }
    const data = await service.handle(action, body, {
      ip: sourceIp(event),
      requestId,
      hostKey: headers["x-unseen-host-key"] || ""
    });
    return response(200, { ok: true, requestId, data }, cors);
  } catch (error) {
    const safe = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "服务器暂时不可用", 500);
    console.error(JSON.stringify({ service: "unseen-cloudbase-backend", requestId,
      action, code: safe.code, statusCode: safe.statusCode }));
    let headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    try {
      const config = runtime().config;
      headers = corsHeaders(config, normalizedHeaders(event.headers).origin || "");
    } catch (_) {}
    return response(safe.statusCode, { ok: false, requestId,
      error: { code: safe.code, message: safe.message, ...(safe.details ? { details: safe.details } : {}) } }, headers);
  }
}

exports.main = main;
exports._test = { corsHeaders, isTimer, normalizedHeaders, parseBody, sourceIp };
