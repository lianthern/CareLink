// No-op captcha provider: issue() hands back a public "there is nothing to solve" descriptor and
// consume() always succeeds, regardless of proof. This is the default for bare LocalApi
// construction (see api.mjs) so every existing test fixture -- none of which mint/solve a PoW
// challenge -- keeps working unchanged; real server entrypoints (services/api/src/index.mjs,
// infra/integration/local-operable.mjs) default UNSEEN_OTP_CAPTCHA_PROVIDER to "pow" instead, so
// this mode only runs where an operator explicitly opts out.
export function createDisabledCaptchaPort() {
  return {
    provider: "disabled",
    issue() { return { mode: "disabled" }; },
    consume() {}
  };
}
