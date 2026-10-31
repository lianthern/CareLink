import { createHash, createHmac } from "node:crypto";
import { normalizeEmail } from "../../crypto.mjs";

const PROVIDER = "tencent_ses_api";
const SERVICE = "ses";
const API_HOST_SUFFIX = ".tencentcloudapi.com";
const API_VERSION = "2020-10-02";
const ACTION = "SendEmail";
const ALGORITHM = "TC3-HMAC-SHA256";
const DEFAULT_REGION = "ap-guangzhou";
const DEFAULT_FROM = "no-reply@mail.maxxam.xyz";
const DEFAULT_TEMPLATE_VARIABLE = "code";
const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TENCENT_SES_TIMEOUT_MS = 50_000;
// Sent as the outer envelope Subject alongside the template; carries no challenge/purpose/user context,
// matching the SMTP adapter's redaction stance (see smtp-otp-delivery-port.mjs `body`).
const SUBJECT = "UNSEEN 验证码";

export class TencentSesApiOtpDeliveryError extends Error {
  constructor(code) {
    super(code);
    this.name = "TencentSesApiOtpDeliveryError";
    this.code = code;
  }
}

function fail(code) { throw new TencentSesApiOtpDeliveryError(code); }

function integer(value, fallback, minimum, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("tencent_ses_configuration_invalid");
  }
  return parsed;
}

function ascii(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum &&
    /^[\x21-\x7e]+$/u.test(value) && !/[\r\n\0]/u.test(value);
}

function secret(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && !/[\r\n\0]/u.test(value);
}

function displayName(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && !/[\r\n\0<>]/u.test(value);
}

function email(value) {
  try { return ascii(value, 320) && normalizeEmail(value) === value; }
  catch { return false; }
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

// TC3-HMAC-SHA256 per Tencent Cloud's "签名方法 v3": hash the canonical request, build the string to sign,
// derive a date/service/request-scoped signing key, then HMAC the string to sign with it. No SDK dependency.
function authorizationHeader({ secretId, secretKey }, host, requestBody, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256Hex(requestBody)].join("\n");
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [ALGORITHM, String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign).toString("hex");
  return `${ALGORITHM} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function requestBody(message, config) {
  if (!message || !ascii(message.deliveryId, 200) || !ascii(message.challengeId, 200) ||
    !email(message.normalizedEmail) || !/^\d{6}$/u.test(message.code) ||
    typeof message.purpose !== "string" || Number.isNaN(Date.parse(message.expiresAt))) {
    fail("tencent_ses_message_invalid");
  }
  const fromAddress = config.fromName ? `${config.fromName} <${config.from}>` : config.from;
  return JSON.stringify({
    FromEmailAddress: fromAddress,
    Destination: [message.normalizedEmail],
    Subject: SUBJECT,
    Template: { TemplateID: config.templateId,
      TemplateData: JSON.stringify({ [config.templateVariable]: message.code }) }
  });
}

function validateConfiguration(config) {
  if (!config || !ascii(config.secretId, 64) || !secret(config.secretKey, 128) || !ascii(config.region, 50) ||
    !email(config.from) || (config.fromName !== undefined && !displayName(config.fromName, 200)) ||
    !Number.isSafeInteger(config.templateId) || config.templateId < 1 ||
    !ascii(config.templateVariable, 100) ||
    !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 50 || config.timeoutMs > MAX_TENCENT_SES_TIMEOUT_MS) {
    fail("tencent_ses_configuration_invalid");
  }
}

export function createTencentSesApiOtpDeliveryPort(config, { fetch: fetchImpl = globalThis.fetch } = {}) {
  validateConfiguration(config);
  if (typeof fetchImpl !== "function") fail("tencent_ses_configuration_invalid");
  const normalized = Object.freeze({ ...config });
  const host = `${SERVICE}${API_HOST_SUFFIX}`;
  return Object.freeze({
    name: PROVIDER,
    deliveryTimeoutMs: normalized.timeoutMs,
    async deliver(message) {
      const body = requestBody(message, normalized);
      const timestamp = Math.floor(Date.now() / 1000);
      const authorization = authorizationHeader(normalized, host, body, timestamp);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), normalized.timeoutMs);
      let response;
      try {
        response = await fetchImpl(`https://${host}/`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            host,
            "x-tc-action": ACTION,
            "x-tc-timestamp": String(timestamp),
            "x-tc-version": API_VERSION,
            "x-tc-region": normalized.region,
            authorization
          },
          body,
          signal: controller.signal
        });
      } catch (error) {
        if (error?.name === "AbortError") fail("tencent_ses_delivery_timeout");
        fail("tencent_ses_delivery_connection_failed");
      } finally {
        clearTimeout(timer);
      }
      let parsed;
      try { parsed = await response.json(); }
      catch { fail("tencent_ses_delivery_response_invalid"); }
      if (!response.ok || parsed?.Response?.Error) fail("tencent_ses_delivery_rejected");
      if (typeof parsed?.Response?.MessageId !== "string" || parsed.Response.MessageId.length < 1) {
        fail("tencent_ses_delivery_response_invalid");
      }
    }
  });
}

export function tencentSesApiOtpDeliveryFromEnv(env = process.env, options = {}) {
  const selected = env.UNSEEN_OTP_DELIVERY_PROVIDER ?? "disabled";
  if (selected === "disabled") return null;
  if (selected !== "tencent_ses_api") fail("tencent_ses_configuration_invalid");
  const config = {
    secretId: env.UNSEEN_TENCENT_SES_SECRET_ID,
    secretKey: env.UNSEEN_TENCENT_SES_SECRET_KEY,
    region: env.UNSEEN_TENCENT_SES_REGION ?? DEFAULT_REGION,
    from: env.UNSEEN_TENCENT_SES_FROM ?? DEFAULT_FROM,
    fromName: env.UNSEEN_TENCENT_SES_FROM_NAME,
    templateId: integer(env.UNSEEN_TENCENT_SES_TEMPLATE_ID, undefined, 1, 100_000_000),
    templateVariable: env.UNSEEN_TENCENT_SES_TEMPLATE_VARIABLE ?? DEFAULT_TEMPLATE_VARIABLE,
    timeoutMs: integer(env.UNSEEN_TENCENT_SES_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 50, MAX_TENCENT_SES_TIMEOUT_MS)
  };
  return createTencentSesApiOtpDeliveryPort(config, options);
}
