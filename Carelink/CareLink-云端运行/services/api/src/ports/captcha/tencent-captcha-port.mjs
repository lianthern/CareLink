import { createHash, createHmac } from "node:crypto";
import { ApiError } from "../../errors.mjs";

// SKELETON -- second captcha channel, deliberately not wired to any frontend UI yet and not
// exercised by any test in this branch (no sandbox CaptchaAppId/SecretKey is available in this
// worktree). Rationale for having it at all: Cloudflare Turnstile/hCaptcha are unreliable for
// visitors on the Chinese mainland (network path to the challenge script/verify endpoint can be
// blocked or throttled), so if the "pow" provider ever needs a fallback, Tencent's 天御 captcha
// (same cloud account UNSEEN already uses for SES) is the mainland-friendly option -- see the
// task brief this file was written against.
//
// TODO before this can be selected in production (UNSEEN_OTP_CAPTCHA_PROVIDER=tencent_captcha):
//   1. Max opens the 腾讯云验证码 (Captcha) console, creates an application, and copies its
//      CaptchaAppId (public, safe to ship to the browser) and AppSecretKey (server-side only).
//   2. Set UNSEEN_TENCENT_CAPTCHA_APP_ID / UNSEEN_TENCENT_CAPTCHA_APP_SECRET_KEY.
//   3. Frontend work this branch does NOT do: load Tencent's captcha widget script client-side
//      (apps/web's CSP is `script-src 'self'` -- the widget is loaded from Tencent's own CDN, so
//      selecting this provider also needs a CSP allowlist change and a new apps/web/src/otp-pow
//      -sibling module that renders the widget and forwards its {ticket, randstr} callback
//      instead of running the PoW worker), wire HttpApiAdapter to send verificationTicket/
//      verificationRandstr instead of verificationNonce, and extend identity-service.mjs's proof
//      shape accordingly.
//   4. Verify a real end-to-end request against captcha.tencentcloudapi.com once credentials
//      exist -- the request signing below reuses the exact TC3-HMAC-SHA256 recipe already proven
//      out by tencent-ses-api-otp-delivery-port.mjs (same account, same signature scheme across
//      every Tencent Cloud API 3.0 service), but DescribeCaptchaResult's parameter names come
//      from public docs (https://cloud.tencent.com/document/product/1110/36926) that this branch
//      could not exercise against a live endpoint.
const SERVICE = "captcha";
const API_HOST = "captcha.tencentcloudapi.com";
const API_VERSION = "2019-07-22";
const ACTION = "DescribeCaptchaResult";
const ALGORITHM = "TC3-HMAC-SHA256";
// CaptchaType=9 is the "验证码 2.0" type used by DescribeCaptchaResult per Tencent's docs; kept
// as a named constant rather than inlined so a future maintainer can see at a glance that it is
// a fixed protocol constant, not a tunable.
const CAPTCHA_TYPE = 9;
const DEFAULT_TIMEOUT_MS = 5_000;

export class TencentCaptchaError extends Error {
  constructor(code) {
    super(code);
    this.name = "TencentCaptchaError";
    this.code = code;
  }
}

function fail(code) { throw new TencentCaptchaError(code); }

function sha256Hex(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function hmac(key, value) { return createHmac("sha256", key).update(value, "utf8").digest(); }

// Identical recipe to tencent-ses-api-otp-delivery-port.mjs's authorizationHeader() -- Tencent
// Cloud API 3.0's TC3-HMAC-SHA256 signing is uniform across every service, only `service`/`host`/
// `action` change.
function authorizationHeader({ secretId, secretKey }, requestBody, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = `content-type:${contentType}\nhost:${API_HOST}\nx-tc-action:${ACTION.toLowerCase()}\n`;
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

function validateConfig(config) {
  if (!config || typeof config.secretId !== "string" || !config.secretId ||
    typeof config.secretKey !== "string" || !config.secretKey ||
    !Number.isSafeInteger(config.captchaAppId) || config.captchaAppId < 1 ||
    typeof config.appSecretKey !== "string" || !config.appSecretKey ||
    !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 50) fail("tencent_captcha_configuration_invalid");
}

export function createTencentCaptchaPort(config, { fetch: fetchImpl = globalThis.fetch } = {}) {
  validateConfig(config);
  if (typeof fetchImpl !== "function") fail("tencent_captcha_configuration_invalid");
  const normalized = Object.freeze({ ...config });
  return Object.freeze({
    provider: "tencent_captcha",

    // The widget challenge itself is issued client-side by Tencent's own script using the public
    // CaptchaAppId -- our server has nothing to mint or store, unlike the "pow" provider.
    issue() {
      return { mode: "tencent_captcha", captchaAppId: normalized.captchaAppId };
    },

    async consume(ctx, proof) {
      if (typeof proof?.ticket !== "string" || !proof.ticket || typeof proof?.randstr !== "string" || !proof.randstr) {
        throw new ApiError("otp_verification_required", 400);
      }
      // riskScope is `${"ipv4"|"ipv6"|"unknown"}:${address}` (see http-server.mjs's
      // deriveRiskScope) -- split on the *first* colon only, since an IPv6 address itself
      // contains colons and would otherwise be truncated to its last hextet.
      const colonIndex = typeof ctx?.riskScope === "string" ? ctx.riskScope.indexOf(":") : -1;
      const userIp = colonIndex >= 0 ? ctx.riskScope.slice(colonIndex + 1) : "0.0.0.0";
      const body = JSON.stringify({
        CaptchaType: CAPTCHA_TYPE,
        Ticket: proof.ticket,
        UserIp: userIp,
        Randstr: proof.randstr,
        CaptchaAppId: normalized.captchaAppId,
        AppSecretKey: normalized.appSecretKey
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const authorization = authorizationHeader(normalized, body, timestamp);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), normalized.timeoutMs);
      let response;
      try {
        response = await fetchImpl(`https://${API_HOST}/`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            host: API_HOST,
            "x-tc-action": ACTION,
            "x-tc-timestamp": String(timestamp),
            "x-tc-version": API_VERSION,
            authorization
          },
          body,
          signal: controller.signal
        });
      } catch {
        throw new ApiError("otp_verification_unavailable", 503);
      } finally {
        clearTimeout(timer);
      }
      let parsed;
      try { parsed = await response.json(); }
      catch { throw new ApiError("otp_verification_unavailable", 503); }
      // CaptchaCode===1 is Tencent's documented "verified" result; anything else (wrong/expired
      // ticket, replayed randstr, flagged-as-abusive) is fail-closed the same as a bad PoW proof.
      if (!response.ok || parsed?.Response?.Error || parsed?.Response?.CaptchaCode !== 1) {
        throw new ApiError("otp_verification_failed", 403);
      }
    }
  });
}

export function tencentCaptchaFromEnv(env = process.env, options = {}) {
  const config = {
    secretId: env.UNSEEN_TENCENT_SES_SECRET_ID, // shared Tencent Cloud account credentials (same as the SES port)
    secretKey: env.UNSEEN_TENCENT_SES_SECRET_KEY,
    captchaAppId: env.UNSEEN_TENCENT_CAPTCHA_APP_ID === undefined ? NaN : Number(env.UNSEEN_TENCENT_CAPTCHA_APP_ID),
    appSecretKey: env.UNSEEN_TENCENT_CAPTCHA_APP_SECRET_KEY,
    timeoutMs: env.UNSEEN_TENCENT_CAPTCHA_TIMEOUT_MS === undefined ? DEFAULT_TIMEOUT_MS : Number(env.UNSEEN_TENCENT_CAPTCHA_TIMEOUT_MS)
  };
  return createTencentCaptchaPort(config, options);
}
