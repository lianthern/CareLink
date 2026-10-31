import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { MAX_TENCENT_SES_TIMEOUT_MS, TencentSesApiOtpDeliveryError,
  createTencentSesApiOtpDeliveryPort, tencentSesApiOtpDeliveryFromEnv } from
  "../src/ports/otp/tencent-ses-api-otp-delivery-port.mjs";

const SECRET_ID = "AKIDtestSecretIdExampleValue0000";
const SECRET_KEY = "testSecretKeyExampleValueDoNotUse0000";

function env(overrides = {}) {
  return {
    UNSEEN_OTP_DELIVERY_PROVIDER: "tencent_ses_api",
    UNSEEN_TENCENT_SES_SECRET_ID: SECRET_ID,
    UNSEEN_TENCENT_SES_SECRET_KEY: SECRET_KEY,
    UNSEEN_TENCENT_SES_TEMPLATE_ID: "100001",
    ...overrides
  };
}

function message(overrides = {}) {
  return { deliveryId: "otp_delivery_test_abcdefgh", challengeId: "otp_challenge_test_abcdefgh",
    normalizedEmail: "friend@example.test", code: "246801", purpose: "login",
    expiresAt: "2026-08-15T01:10:00.000Z", ...overrides };
}

function okResponse(body = { Response: { MessageId: "msg-0000000001", RequestId: "req-0000000001" } }) {
  return { ok: true, json: async () => body };
}

// Independent re-derivation of the TC3-HMAC-SHA256 signature from Tencent Cloud's documented algorithm
// ("签名方法 v3"), written separately from the adapter implementation so this test can catch a corrupted
// canonical-request, string-to-sign or key-derivation step rather than just echoing the same code back.
function expectedAuthorization({ secretId, secretKey, host, body, timestamp }) {
  const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const hmac = (key, value) => createHmac("sha256", key).update(value, "utf8").digest();
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:sendemail\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256Hex(body)].join("\n");
  const credentialScope = `${date}/ses/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, "ses");
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign).toString("hex");
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;
}

test("stays default-off without building a request or requiring credentials", () => {
  assert.equal(tencentSesApiOtpDeliveryFromEnv({}), null);
  assert.equal(tencentSesApiOtpDeliveryFromEnv({ UNSEEN_OTP_DELIVERY_PROVIDER: "disabled" }), null);
});

test("an unsupported provider value fails closed", () => {
  assert.throws(() => tencentSesApiOtpDeliveryFromEnv({ UNSEEN_OTP_DELIVERY_PROVIDER: "ses" }),
    (error) => error.code === "tencent_ses_configuration_invalid");
});

test("invalid or incomplete configuration fails before any network call", () => {
  const spy = { called: false, fetch: async () => { spy.called = true; return okResponse(); } };
  for (const overrides of [
    { UNSEEN_TENCENT_SES_SECRET_ID: undefined },
    { UNSEEN_TENCENT_SES_SECRET_KEY: undefined },
    { UNSEEN_TENCENT_SES_TEMPLATE_ID: undefined },
    { UNSEEN_TENCENT_SES_TEMPLATE_ID: "0" },
    { UNSEEN_TENCENT_SES_TEMPLATE_ID: "not-a-number" },
    { UNSEEN_TENCENT_SES_FROM: "not-an-email" },
    { UNSEEN_TENCENT_SES_TIMEOUT_MS: String(MAX_TENCENT_SES_TIMEOUT_MS + 1) }
  ]) {
    assert.throws(() => tencentSesApiOtpDeliveryFromEnv(env(overrides), { fetch: spy.fetch }),
      (error) => error instanceof TencentSesApiOtpDeliveryError &&
        error.code === "tencent_ses_configuration_invalid");
  }
  assert.equal(spy.called, false);
});

test("defaults: region ap-guangzhou, from no-reply@mail.maxxam.xyz, template variable \"code\"", async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = { url, init }; return okResponse(); };
  const port = tencentSesApiOtpDeliveryFromEnv(env(), { fetch: fetchImpl });
  assert.equal(port.name, "tencent_ses_api");
  await port.deliver(message());
  assert.equal(captured.url, "https://ses.tencentcloudapi.com/");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["x-tc-region"], "ap-guangzhou");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.FromEmailAddress, "no-reply@mail.maxxam.xyz");
  assert.deepEqual(body.Destination, ["friend@example.test"]);
  assert.equal(body.Template.TemplateID, 100001);
  assert.deepEqual(JSON.parse(body.Template.TemplateData), { code: "246801" });
});

test("request carries a correctly signed TC3-HMAC-SHA256 Authorization header and expected common headers", async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = { url, init }; return okResponse(); };
  const port = tencentSesApiOtpDeliveryFromEnv(env({ UNSEEN_TENCENT_SES_REGION: "ap-hongkong" }),
    { fetch: fetchImpl });
  await port.deliver(message());
  const headers = captured.init.headers;
  assert.equal(headers["content-type"], "application/json; charset=utf-8");
  assert.equal(headers.host, "ses.tencentcloudapi.com");
  assert.equal(headers["x-tc-action"], "SendEmail");
  assert.equal(headers["x-tc-version"], "2020-10-02");
  assert.equal(headers["x-tc-region"], "ap-hongkong");
  assert.match(headers["x-tc-timestamp"], /^\d+$/u);
  const timestamp = Number(headers["x-tc-timestamp"]);
  assert.ok(Math.abs(Date.now() / 1000 - timestamp) < 5);
  assert.equal(headers.authorization, expectedAuthorization({ secretId: SECRET_ID, secretKey: SECRET_KEY,
    host: "ses.tencentcloudapi.com", body: captured.init.body, timestamp }));
});

test("custom template variable name and a from display name are honored", async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = { url, init }; return okResponse(); };
  const port = tencentSesApiOtpDeliveryFromEnv(env({
    UNSEEN_TENCENT_SES_TEMPLATE_VARIABLE: "verifyCode",
    UNSEEN_TENCENT_SES_FROM_NAME: "UNSEEN 团队",
    UNSEEN_TENCENT_SES_FROM: "no-reply@mail.maxxam.xyz"
  }), { fetch: fetchImpl });
  await port.deliver(message());
  const body = JSON.parse(captured.init.body);
  assert.equal(body.FromEmailAddress, "UNSEEN 团队 <no-reply@mail.maxxam.xyz>");
  assert.deepEqual(JSON.parse(body.Template.TemplateData), { verifyCode: "246801" });
});

test("an invalid OTP message is rejected before any network call", async () => {
  const spy = { called: false };
  const fetchImpl = async () => { spy.called = true; return okResponse(); };
  const port = tencentSesApiOtpDeliveryFromEnv(env(), { fetch: fetchImpl });
  await assert.rejects(port.deliver(message({ code: "12345" })),
    (error) => error.code === "tencent_ses_message_invalid");
  await assert.rejects(port.deliver(message({ normalizedEmail: "Not-Normalized@Example.TEST" })),
    (error) => error.code === "tencent_ses_message_invalid");
  assert.equal(spy.called, false);
});

test("a provider-level API error rejects with a stable code and never leaks the secret key or the OTP code", async () => {
  const fetchImpl = async () => okResponse({ Response: { Error: { Code: "FailedOperation.TemplateNotExist",
    Message: "template not found" }, RequestId: "req-0000000002" } });
  const port = tencentSesApiOtpDeliveryFromEnv(env(), { fetch: fetchImpl });
  await assert.rejects(port.deliver(message()), (error) => {
    assert.equal(error.code, "tencent_ses_delivery_rejected");
    assert.ok(!error.message.includes(SECRET_KEY));
    assert.ok(!error.message.includes("246801"));
    assert.ok(!error.message.includes("friend@example.test"));
    return true;
  });
});

test("an HTTP-level failure rejects with a stable code", async () => {
  const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
  const port = tencentSesApiOtpDeliveryFromEnv(env(), { fetch: fetchImpl });
  await assert.rejects(port.deliver(message()), (error) => error.code === "tencent_ses_delivery_rejected");
});

test("a missing MessageId in an otherwise-ok response is treated as an invalid response", async () => {
  const fetchImpl = async () => okResponse({ Response: { RequestId: "req-0000000003" } });
  const port = tencentSesApiOtpDeliveryFromEnv(env(), { fetch: fetchImpl });
  await assert.rejects(port.deliver(message()), (error) => error.code === "tencent_ses_delivery_response_invalid");
});

test("malformed JSON in the response is treated as an invalid response", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } });
  const port = tencentSesApiOtpDeliveryFromEnv(env(), { fetch: fetchImpl });
  await assert.rejects(port.deliver(message()), (error) => error.code === "tencent_ses_delivery_response_invalid");
});

test("a network failure rejects with a stable connection-failed code", async () => {
  const fetchImpl = async () => { throw new Error("getaddrinfo ENOTFOUND ses.tencentcloudapi.com"); };
  const port = tencentSesApiOtpDeliveryFromEnv(env(), { fetch: fetchImpl });
  await assert.rejects(port.deliver(message()), (error) => error.code === "tencent_ses_delivery_connection_failed");
});

test("an aborted (timed-out) request rejects with a stable timeout code", async () => {
  const fetchImpl = async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; };
  const port = tencentSesApiOtpDeliveryFromEnv(env(), { fetch: fetchImpl });
  await assert.rejects(port.deliver(message()), (error) => error.code === "tencent_ses_delivery_timeout");
});

test("createTencentSesApiOtpDeliveryPort requires a fetch implementation", () => {
  assert.throws(() => createTencentSesApiOtpDeliveryPort({ secretId: SECRET_ID, secretKey: SECRET_KEY,
    region: "ap-guangzhou", from: "no-reply@mail.maxxam.xyz", templateId: 1, templateVariable: "code",
    timeoutMs: 1_000 }, { fetch: null }),
  (error) => error.code === "tencent_ses_configuration_invalid");
});
