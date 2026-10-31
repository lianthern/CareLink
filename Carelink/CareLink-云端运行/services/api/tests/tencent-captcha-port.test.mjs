import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { ApiError } from "../src/errors.mjs";
import { createTencentCaptchaPort, tencentCaptchaFromEnv } from "../src/ports/captcha/tencent-captcha-port.mjs";

// Unit-level only: this port is a documented-but-unexercised skeleton (see the file's own header
// comment) -- no sandbox CaptchaAppId/SecretKey exists in this worktree, so these tests prove the
// request is *shaped* correctly (signing, parameter names, fail-closed on a non-1 CaptchaCode)
// against a mocked fetch, the same way tencent-ses-api-otp-delivery-port.test.mjs proves out its
// sibling port -- not that it works against the real captcha.tencentcloudapi.com endpoint.

const SECRET_ID = "AKIDtestSecretIdExampleValue0000";
const SECRET_KEY = "testSecretKeyExampleValueDoNotUse0000";
const APP_SECRET_KEY = "testAppSecretKeyExampleValueDoNotUse";

function env(overrides = {}) {
  return {
    UNSEEN_TENCENT_SES_SECRET_ID: SECRET_ID,
    UNSEEN_TENCENT_SES_SECRET_KEY: SECRET_KEY,
    UNSEEN_TENCENT_CAPTCHA_APP_ID: "1234567890",
    UNSEEN_TENCENT_CAPTCHA_APP_SECRET_KEY: APP_SECRET_KEY,
    ...overrides
  };
}

function okResponse(captchaCode = 1) {
  return { ok: true, json: async () => ({ Response: { CaptchaCode: captchaCode, CaptchaMsg: "OK", RequestId: "req-1" } }) };
}

function expectedAuthorization({ secretId, secretKey, body, timestamp }) {
  const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const hmac = (key, value) => createHmac("sha256", key).update(value, "utf8").digest();
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = "content-type:application/json; charset=utf-8\nhost:captcha.tencentcloudapi.com\nx-tc-action:describecaptcharesult\n";
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256Hex(body)].join("\n");
  const credentialScope = `${date}/captcha/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, "captcha");
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign).toString("hex");
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

test("issue() hands back only the public CaptchaAppId, no server-side state", () => {
  const port = tencentCaptchaFromEnv(env());
  assert.equal(port.provider, "tencent_captcha");
  assert.deepEqual(port.issue(), { mode: "tencent_captcha", captchaAppId: 1234567890 });
});

test("invalid or incomplete configuration fails before any network call", () => {
  const spy = { called: false, fetch: async () => { spy.called = true; return okResponse(); } };
  for (const overrides of [
    { UNSEEN_TENCENT_SES_SECRET_ID: undefined },
    { UNSEEN_TENCENT_SES_SECRET_KEY: undefined },
    { UNSEEN_TENCENT_CAPTCHA_APP_ID: undefined },
    { UNSEEN_TENCENT_CAPTCHA_APP_ID: "not-a-number" },
    { UNSEEN_TENCENT_CAPTCHA_APP_SECRET_KEY: undefined }
  ]) {
    assert.throws(() => tencentCaptchaFromEnv(env(overrides), { fetch: spy.fetch }),
      (error) => error.name === "TencentCaptchaError" && error.code === "tencent_captcha_configuration_invalid");
  }
  assert.equal(spy.called, false);
});

test("consume() requires both ticket and randstr before making any network call", async () => {
  const spy = { called: false, fetch: async () => { spy.called = true; return okResponse(); } };
  const port = createTencentCaptchaPort({ secretId: SECRET_ID, secretKey: SECRET_KEY, captchaAppId: 1234567890,
    appSecretKey: APP_SECRET_KEY, timeoutMs: 5000 }, { fetch: spy.fetch });
  for (const proof of [undefined, {}, { ticket: "t" }, { randstr: "r" }, { ticket: "", randstr: "r" }]) {
    await assert.rejects(port.consume({ riskScope: "ipv4:203.0.113.9" }, proof),
      (error) => error instanceof ApiError && error.code === "otp_verification_required");
  }
  assert.equal(spy.called, false);
});

test("a signed DescribeCaptchaResult request carries the documented parameters and TC3 signature", async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = { url, init }; return okResponse(); };
  const port = createTencentCaptchaPort({ secretId: SECRET_ID, secretKey: SECRET_KEY, captchaAppId: 1234567890,
    appSecretKey: APP_SECRET_KEY, timeoutMs: 5000 }, { fetch: fetchImpl });
  await port.consume({ riskScope: "ipv4:203.0.113.9" }, { ticket: "ticket-value", randstr: "randstr-value" });
  assert.equal(captured.url, "https://captcha.tencentcloudapi.com/");
  assert.equal(captured.init.method, "POST");
  const headers = captured.init.headers;
  assert.equal(headers.host, "captcha.tencentcloudapi.com");
  assert.equal(headers["x-tc-action"], "DescribeCaptchaResult");
  assert.equal(headers["x-tc-version"], "2019-07-22");
  assert.match(headers["x-tc-timestamp"], /^\d+$/u);
  const timestamp = Number(headers["x-tc-timestamp"]);
  assert.equal(headers.authorization, expectedAuthorization({ secretId: SECRET_ID, secretKey: SECRET_KEY,
    body: captured.init.body, timestamp }));
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body, { CaptchaType: 9, Ticket: "ticket-value", UserIp: "203.0.113.9",
    Randstr: "randstr-value", CaptchaAppId: 1234567890, AppSecretKey: APP_SECRET_KEY });
});

test("UserIp is derived from the trailing address in riskScope (ipv4:<addr> / ipv6:<addr>)", async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = { url, init }; return okResponse(); };
  const port = createTencentCaptchaPort({ secretId: SECRET_ID, secretKey: SECRET_KEY, captchaAppId: 1234567890,
    appSecretKey: APP_SECRET_KEY, timeoutMs: 5000 }, { fetch: fetchImpl });
  await port.consume({ riskScope: "ipv6:2001:db8::1" }, { ticket: "t", randstr: "r" });
  assert.equal(JSON.parse(captured.init.body).UserIp, "2001:db8::1");
});

test("a non-1 CaptchaCode is fail-closed the same as a bad PoW proof", async () => {
  const port = createTencentCaptchaPort({ secretId: SECRET_ID, secretKey: SECRET_KEY, captchaAppId: 1234567890,
    appSecretKey: APP_SECRET_KEY, timeoutMs: 5000 }, { fetch: async () => okResponse(8) });
  await assert.rejects(port.consume({ riskScope: "ipv4:203.0.113.9" }, { ticket: "t", randstr: "r" }),
    (error) => error instanceof ApiError && error.code === "otp_verification_failed");
});

test("a network failure is a distinct, stable unavailable code (not silently treated as verified)", async () => {
  const port = createTencentCaptchaPort({ secretId: SECRET_ID, secretKey: SECRET_KEY, captchaAppId: 1234567890,
    appSecretKey: APP_SECRET_KEY, timeoutMs: 5000 }, { fetch: async () => { throw new Error("boom"); } });
  await assert.rejects(port.consume({ riskScope: "ipv4:203.0.113.9" }, { ticket: "t", randstr: "r" }),
    (error) => error instanceof ApiError && error.code === "otp_verification_unavailable");
});

test("a malformed JSON response is a distinct unavailable code", async () => {
  const port = createTencentCaptchaPort({ secretId: SECRET_ID, secretKey: SECRET_KEY, captchaAppId: 1234567890,
    appSecretKey: APP_SECRET_KEY, timeoutMs: 5000 }, { fetch: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) });
  await assert.rejects(port.consume({ riskScope: "ipv4:203.0.113.9" }, { ticket: "t", randstr: "r" }),
    (error) => error instanceof ApiError && error.code === "otp_verification_unavailable");
});
