import { assert } from "../../errors.mjs";
import { assertCaptchaPort } from "./captcha-port.mjs";
import { createDisabledCaptchaPort } from "./disabled-captcha-port.mjs";
import { createPowCaptchaPort } from "./pow-captcha-port.mjs";
import { createTencentCaptchaPort } from "./tencent-captcha-port.mjs";

const PROVIDERS = new Set(["pow", "tencent_captcha", "disabled"]);

// LocalApi (api.mjs) calls this once at construction time, after this.core exists (the "pow"
// provider needs core.db/core.keyring/core.now to store+verify challenges). Bare LocalApi
// construction defaults to "disabled" -- see disabled-captcha-port.mjs's header comment for why;
// real server entrypoints (services/api/src/index.mjs, infra/integration/local-operable.mjs)
// pass provider explicitly, defaulting *their own* fallback to "pow" via
// `process.env.UNSEEN_OTP_CAPTCHA_PROVIDER ?? "pow"`.
export function createOtpCaptchaGate(core, { provider = "disabled", difficultyBits, challengeTtlMs,
  tencent } = {}) {
  assert(PROVIDERS.has(provider), "otp_captcha_provider_invalid", 503);
  const port = provider === "pow" ? createPowCaptchaPort(core, { difficultyBits, challengeTtlMs }) :
    provider === "tencent_captcha" ? createTencentCaptchaPort(tencent) : createDisabledCaptchaPort();
  return assertCaptchaPort(port);
}
