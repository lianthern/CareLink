"use strict";

const { AppError, invariant } = require("./errors.js");

function required(env, name) {
  const value = String(env[name] || "").trim();
  invariant(value, "CONFIG_MISSING", `缺少环境变量 ${name}`, 500);
  return value;
}

function secret(env, name, fallbackName) {
  const value = String(env[name] || (fallbackName ? env[fallbackName] : "") || "");
  invariant(value.length >= 32 && !value.startsWith("__SET_"),
    "CONFIG_SECRET_INVALID", `${name} 必须是至少 32 字节的独立密钥`, 500);
  return value;
}

function positiveInt(env, name, fallback, min, max) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  invariant(Number.isInteger(value) && value >= min && value <= max,
    "CONFIG_INVALID", `${name} 配置无效`, 500);
  return value;
}

function httpsUrl(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch (_) {
    throw new AppError("CONFIG_INVALID", `${name} 必须是 HTTPS URL`, 500);
  }
  invariant(parsed.protocol === "https:" && !parsed.username && !parsed.password,
    "CONFIG_INVALID", `${name} 必须是 HTTPS URL`, 500);
  return parsed.toString().replace(/\/+$/, "");
}

function loadConfig(env = process.env) {
  const bucket = required(env, "OSS_BUCKET");
  invariant(/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket),
    "CONFIG_INVALID", "OSS_BUCKET 格式无效", 500);
  const endpoint = required(env, "OSS_ENDPOINT")
    .replace(/^https?:\/\//, "").replace(/\/+$/, "");
  invariant(/^[a-z0-9.-]+$/.test(endpoint) && !endpoint.includes("/"),
    "CONFIG_INVALID", "OSS_ENDPOINT 格式无效", 500);

  const corsOrigins = String(env.CORS_ORIGINS || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  corsOrigins.forEach((origin) => {
    if (origin === "*") return;
    const parsed = new URL(origin);
    invariant(parsed.protocol === "https:" && parsed.origin === origin,
      "CONFIG_INVALID", "CORS_ORIGINS 只能包含 HTTPS origin", 500);
  });

  return Object.freeze({
    bucket,
    endpoint,
    ossPublicBase: httpsUrl(required(env, "OSS_PUBLIC_BASE"), "OSS_PUBLIC_BASE"),
    publicApiUrl: httpsUrl(required(env, "PUBLIC_API_URL"), "PUBLIC_API_URL"),
    accessKeyId: required(env, "OSS_ACCESS_KEY_ID"),
    accessKeySecret: required(env, "OSS_ACCESS_KEY_SECRET"),
    securityToken: String(env.OSS_SECURITY_TOKEN || ""),
    tokenSecret: secret(env, "TOKEN_SECRET"),
    spaceIdSecret: secret(env, "SPACE_ID_SECRET"),
    hostKeySecret: secret(env, "HOST_KEY_SECRET"),
    rateLimitSecret: secret(env, "RATE_LIMIT_SECRET"),
    corsOrigins,
    policyTtlSeconds: positiveInt(env, "POLICY_TTL_SECONDS", 900, 300, 3600),
    commitTtlSeconds: positiveInt(env, "COMMIT_TTL_SECONDS", 1800, 600, 7200),
    draftTtlSeconds: positiveInt(env, "DRAFT_TTL_SECONDS", 86400, 3600, 604800),
    uploadTtlSeconds: positiveInt(env, "UPLOAD_TTL_SECONDS", 86400, 7200, 604800),
    createRatePerHour: positiveInt(env, "CREATE_RATE_PER_HOUR", 5, 1, 100),
    ticketRatePerIp10m: positiveInt(env, "TICKET_RATE_PER_IP_10M", 30, 1, 500),
    ticketRatePerSpace10m: positiveInt(env, "TICKET_RATE_PER_SPACE_10M", 20, 1, 500),
    maintenanceMaxObjects: positiveInt(env, "MAINTENANCE_MAX_OBJECTS", 500, 10, 1000),
    maintenanceToken: String(env.MAINTENANCE_TOKEN || "")
  });
}

module.exports = { loadConfig };
