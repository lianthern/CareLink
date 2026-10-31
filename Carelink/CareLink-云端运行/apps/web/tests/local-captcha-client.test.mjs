import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalCaptchaMarkup } from "../src/otp-captcha/local-client.js";

const visual = {
  prompt: "请选择所有星形",
  tiles: Array.from({ length: 9 }, (_, index) => ({
    path: index % 2 ? "M50 12 60 37 87 38Z" : "M18 18H82V82H18Z",
    fill: "#b94f72",
    rotate: index - 4,
    dots: [[12, 18, 2], [78, 71, 1]]
  }))
};

test("local captcha renders a visible keyboard-operable nine-image challenge", () => {
  const markup = buildLocalCaptchaMarkup(visual);
  assert.equal(markup.match(/data-local-captcha-tile=/g)?.length, 9);
  assert.equal(markup.match(/aria-pressed="false"/g)?.length, 9);
  assert.match(markup, /请选择所有星形/);
  assert.match(markup, /完成验证/);
});

test("local captcha rejects malformed server descriptors and escapes its prompt", () => {
  assert.throws(() => buildLocalCaptchaMarkup({ prompt: "x", tiles: [] }),
    (clientError) => clientError.code === "otp_verification_unavailable");
  assert.doesNotMatch(buildLocalCaptchaMarkup({ ...visual, prompt: "请选择<img>" }), /<img>/);
});
