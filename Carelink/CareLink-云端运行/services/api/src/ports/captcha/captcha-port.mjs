import { assert } from "../../errors.mjs";

// Every OTP-issuance captcha provider (pow | tencent_captcha | disabled -- see
// pow-captcha-port.mjs / tencent-captcha-port.mjs / disabled-captcha-port.mjs) implements this
// same two-method shape so identity-service.mjs's requestOtp() never needs to branch on which
// provider is active: issue() mints a public, client-facing challenge descriptor (no auth
// required -- mirrors otp-delivery-port.mjs's "no secrets on this side" stance); consume()
// validates a client-submitted proof and throws a fail-closed ApiError (never returns false) so
// a missing/invalid/expired/replayed proof can never be mistaken for "allowed" by a caller that
// forgets to check a boolean.
export function assertCaptchaPort(port) {
  assert(port && typeof port.provider === "string" && port.provider.length >= 1 &&
    typeof port.issue === "function" && typeof port.consume === "function",
  "otp_captcha_provider_invalid", 503);
  return port;
}
