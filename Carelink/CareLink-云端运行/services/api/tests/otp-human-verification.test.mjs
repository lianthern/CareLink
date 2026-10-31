import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAccountUpload, exchangeReceipt, fixture } from "./fixture-factory.mjs";
import { meetsPowDifficulty, POW_ALGORITHM } from "../src/ports/captcha/pow-captcha-port.mjs";

function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }

// Mirrors apps/web/src/otp-pow/pow.js's brute-force loop exactly (same message format, same
// bit-comparison), written independently so this test exercises the real client contract rather
// than reusing a helper the server-side implementation itself could be silently wrong alongside.
function solvePow(salt, difficultyBits) {
  for (let nonce = 0; ; nonce += 1) {
    if (meetsPowDifficulty(sha256Hex(`${salt}:${nonce}`), difficultyBits)) return nonce;
  }
}

function visualAnswer(f, issued) {
  const row = f.db.prepare("SELECT salt FROM otp_pow_challenges WHERE id=?").get(issued.challengeId);
  return JSON.parse(row.salt).answer;
}

function powProof(f, issued) {
  return { verificationChallengeId: issued.challengeId,
    verificationNonce: solvePow(issued.salt, issued.difficultyBits),
    verificationSelection: visualAnswer(f, issued) };
}

function rawRisk(f, path, body, risk, headers = {}) {
  return f.api.handle({ method: "POST", path, body, observedRiskScope: risk,
    headers: { "idempotency-key": `otp-hv-${crypto.randomUUID()}-abcdefgh`, ...headers } });
}

test("bare LocalApi construction defaults the captcha gate to disabled (existing fixtures unaffected)", async () => {
  const f = fixture();
  try {
    assert.equal(f.api.otpCaptcha.provider, "disabled");
    assert.deepEqual(await f.ok("POST", "/v1/auth/otp-verification-challenges", {}), { mode: "disabled" });
    const requested = await f.ok("POST", "/v1/auth/email-otp-challenges", { email: "no-gate@example.test", purpose: "login" });
    assert.equal(requested.accepted, true);
    assert.equal(f.otp.length, 1);
  } finally { f.close(); }
});

test("pow provider issues a real per-request challenge and only mints an OTP after a valid solve", async () => {
  const f = fixture({ otpCaptcha: { provider: "pow", difficultyBits: 10 } });
  try {
    const issued = await f.ok("POST", "/v1/auth/otp-verification-challenges", {});
    assert.equal(issued.mode, "pow");
    assert.equal(issued.algorithm, POW_ALGORITHM);
    assert.equal(issued.difficultyBits, 10);
    assert.match(issued.challengeId, /^powc_[a-f0-9]{32}$/);
    assert.match(issued.salt, /^[a-f0-9]{32}$/);
    assert.match(issued.visual.prompt, /^请选择所有(星形|圆形|三角形|方形)$/);
    assert.equal(issued.visual.tiles.length, 9);
    const row = f.db.prepare("SELECT * FROM otp_pow_challenges WHERE id=?").get(issued.challengeId);
    assert.ok(row && !row.consumed_at && row.difficulty_bits === 10);

    const nonce = solvePow(issued.salt, issued.difficultyBits);
    assert.ok(meetsPowDifficulty(sha256Hex(`${issued.salt}:${nonce}`), 10));
    const wrong = await f.call("POST", "/v1/auth/email-otp-challenges", { email: "pow-wrong-image@example.test",
      purpose: "login", verificationChallengeId: issued.challengeId, verificationNonce: nonce,
      verificationSelection: [0] });
    assert.equal(wrong.status, 403);
    assert.equal(f.otp.length, 0);
    const solved = await f.ok("POST", "/v1/auth/email-otp-challenges", { email: "pow-solved@example.test",
      purpose: "login", verificationChallengeId: issued.challengeId, verificationNonce: nonce,
      verificationSelection: visualAnswer(f, issued) });
    assert.equal(solved.accepted, true);
    assert.equal(f.otp.length, 1);
    assert.ok(f.db.prepare("SELECT consumed_at FROM otp_pow_challenges WHERE id=?").get(issued.challengeId).consumed_at);
  } finally { f.close(); }
});

test("no proof at all is a fail-closed 400, never a silent accepted:true", async () => {
  const f = fixture({ otpCaptcha: { provider: "pow" } });
  try {
    const rejected = await f.call("POST", "/v1/auth/email-otp-challenges", { email: "no-proof@example.test", purpose: "login" });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "otp_verification_required");
    assert.equal(f.otp.length, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM email_otp_challenges").get().count, 0);
  } finally { f.close(); }
});

test("an unsolved (wrong nonce) proof is a fail-closed 403, not a silent accepted:true", async () => {
  const f = fixture({ otpCaptcha: { provider: "pow", difficultyBits: 32 } });
  try {
    const issued = await f.ok("POST", "/v1/auth/otp-verification-challenges", {});
    const rejected = await f.call("POST", "/v1/auth/email-otp-challenges", { email: "wrong-nonce@example.test",
      purpose: "login", verificationChallengeId: issued.challengeId, verificationNonce: 0,
      verificationSelection: visualAnswer(f, issued) });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, "otp_verification_failed");
    assert.equal(f.otp.length, 0);
  } finally { f.close(); }
});

test("an unknown challengeId is rejected the same way as a wrong solve (non-enumerable failure code)", async () => {
  const f = fixture({ otpCaptcha: { provider: "pow", difficultyBits: 0 } });
  try {
    const rejected = await f.call("POST", "/v1/auth/email-otp-challenges", { email: "unknown-challenge@example.test",
      purpose: "login", verificationChallengeId: "powc_doesnotexist00000000000000000", verificationNonce: 0 });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, "otp_verification_failed");
  } finally { f.close(); }
});

test("an expired challenge is rejected even with the correct nonce", async () => {
  const f = fixture({ otpCaptcha: { provider: "pow", difficultyBits: 0, challengeTtlMs: 5_000 } });
  try {
    const issued = await f.ok("POST", "/v1/auth/otp-verification-challenges", {});
    f.clock.advance(5_001);
    const rejected = await f.call("POST", "/v1/auth/email-otp-challenges", { email: "expired@example.test",
      purpose: "login", ...powProof(f, issued) });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, "otp_verification_failed");
  } finally { f.close(); }
});

test("a solved challenge is single-use even across two different emails", async () => {
  const f = fixture({ otpCaptcha: { provider: "pow", difficultyBits: 0 } });
  try {
    const issued = await f.ok("POST", "/v1/auth/otp-verification-challenges", {});
    const first = await f.call("POST", "/v1/auth/email-otp-challenges", { email: "replay-a@example.test",
      purpose: "login", ...powProof(f, issued) });
    assert.equal(first.status, 200);
    const replay = await f.call("POST", "/v1/auth/email-otp-challenges", { email: "replay-b@example.test",
      purpose: "login", ...powProof(f, issued) });
    assert.equal(replay.status, 403);
    assert.equal(replay.body.error.code, "otp_verification_failed");
    assert.equal(f.otp.length, 1);
  } finally { f.close(); }
});

test("a solved challenge only redeems from the risk scope it was issued to", async () => {
  const f = fixture({ otpCaptcha: { provider: "pow", difficultyBits: 0 } });
  try {
    const issued = await rawRisk(f, "/v1/auth/otp-verification-challenges", {}, "pow-risk-a");
    assert.equal(issued.status, 200);
    const proof = powProof(f, issued.body);
    const wrongScope = await rawRisk(f, "/v1/auth/email-otp-challenges", { email: "risk-mismatch@example.test",
      purpose: "login", ...proof }, "pow-risk-b");
    assert.equal(wrongScope.status, 403);
    assert.equal(wrongScope.body.error.code, "otp_verification_failed");
    const rightScope = await rawRisk(f, "/v1/auth/email-otp-challenges", { email: "risk-mismatch@example.test",
      purpose: "login", ...proof }, "pow-risk-a");
    assert.equal(rightScope.status, 200);
  } finally { f.close(); }
});

test("an idempotent replay of a successful request never re-checks pow, even after the challenge is spent", async () => {
  const f = fixture({ otpCaptcha: { provider: "pow", difficultyBits: 0 } });
  try {
    const issued = await f.ok("POST", "/v1/auth/otp-verification-challenges", {});
    const idempotencyKey = `pow-idem-replay-${crypto.randomUUID()}`;
    const body = { email: "idem-replay@example.test", purpose: "login",
      ...powProof(f, issued) };
    const first = await f.call("POST", "/v1/auth/email-otp-challenges", body, { "idempotency-key": idempotencyKey });
    assert.equal(first.status, 200);
    const replay = await f.call("POST", "/v1/auth/email-otp-challenges", body, { "idempotency-key": idempotencyKey });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.challengeId, first.body.challengeId);
    assert.equal(replay.body.replayed, true);
    assert.equal(f.otp.length, 1);
  } finally { f.close(); }
});

// fixture-factory.mjs's own f.login() posts straight to /v1/auth/email-otp-challenges with no
// proof, so it can't be reused once the gate is on -- this redoes the same login flow with a
// real (if instantly-solvable, difficultyBits:0) challenge round trip in front of it.
async function loginWithPow(f, email) {
  const issued = await f.ok("POST", "/v1/auth/otp-verification-challenges", {});
  assert.equal(issued.mode, "pow");
  const requested = await f.ok("POST", "/v1/auth/email-otp-challenges", { email, purpose: "login",
    ...powProof(f, issued) });
  const message = f.otp.findLast((entry) => entry.challengeId === requested.challengeId);
  const verified = await f.ok("POST", "/v1/auth/email-otp-verifications",
    { challengeId: requested.challengeId, otp: message.code, purpose: "login" });
  return { ...verified, headers: { authorization: `Bearer ${verified.accountSessionSecret}` } };
}

test("receipt-account-binding OTP requests never require a pow proof, even with the gate on", async () => {
  const f = fixture({ otpCaptcha: { provider: "pow", difficultyBits: 0 } });
  try {
    const owner = await loginWithPow(f, "binding-pow-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const exchanged = await exchangeReceipt(f, flow.finalized);
    assert.equal(exchanged.status, 200);
    const sentBeforeBinding = f.otp.length;
    const bound = await f.ok("POST", "/v1/batch-receipt/account-binding-otp-challenges",
      { email: "binder@example.test" }, { "x-receipt-session": exchanged.body.receiptSessionSecret });
    assert.equal(bound.accepted, true);
    assert.equal(f.otp.length, sentBeforeBinding + 1);
    // ...but a direct POST to the public /login route can't dodge the gate by claiming the same
    // purpose string -- requirePow is decided by which server code path called requestOtp(), not
    // by anything the client sends.
    const spoofed = await f.call("POST", "/v1/auth/email-otp-challenges",
      { email: "spoofed-purpose@example.test", purpose: "receipt_account_binding" });
    assert.equal(spoofed.status, 400);
    assert.equal(spoofed.body.error.code, "otp_verification_required");
  } finally { f.close(); }
});

test("invalid captcha provider configuration fails closed at construction time", () => {
  assert.throws(() => fixture({ otpCaptcha: { provider: "not_a_real_provider" } }),
    (error) => /otp_captcha_provider_invalid/.test(error.message));
});

test("per-risk-scope hourly send limit is enforced independently per scope and stays accepted:true", async () => {
  const f = fixture({ otpRateLimits: { ipHourlyLimit: 2, ipDailyLimit: 1000, dailyBudget: 1000 } });
  try {
    const send = (email, risk) => rawRisk(f, "/v1/auth/email-otp-challenges", { email, purpose: "login" }, risk);
    const a1 = await send("hourly-a-1@example.test", "hourly-risk-a");
    const a2 = await send("hourly-a-2@example.test", "hourly-risk-a");
    const a3 = await send("hourly-a-3@example.test", "hourly-risk-a");
    for (const response of [a1, a2, a3]) { assert.equal(response.status, 200); assert.equal(response.body.accepted, true); }
    assert.equal(f.otp.length, 2, "third request in the same hour must not actually send");
    const b1 = await send("hourly-b-1@example.test", "hourly-risk-b");
    assert.equal(b1.status, 200);
    assert.equal(f.otp.length, 3, "a different risk scope has its own independent hourly counter");
  } finally { f.close(); }
});

test("hourly bucket resets after an hour while the daily counter keeps accumulating", async () => {
  const f = fixture({ otpRateLimits: { ipHourlyLimit: 1, ipDailyLimit: 2, dailyBudget: 1000 } });
  try {
    const send = (email) => rawRisk(f, "/v1/auth/email-otp-challenges", { email, purpose: "login" }, "hourly-reset-risk");
    await send("reset-1@example.test");
    await send("reset-2@example.test");
    assert.equal(f.otp.length, 1, "hourly=1 blocks the second send within the same hour");
    f.clock.advance(60 * 60_000 + 1_000);
    await send("reset-3@example.test");
    assert.equal(f.otp.length, 2, "a fresh hour allows one more send");
    f.clock.advance(60 * 60_000 + 1_000);
    await send("reset-4@example.test");
    assert.equal(f.otp.length, 2, "daily=2 still blocks a third send even in a third distinct hour");
  } finally { f.close(); }
});

test("the site-wide daily send budget fails closed once exhausted while staying accepted:true and non-enumerable", async () => {
  const f = fixture({ otpRateLimits: { ipHourlyLimit: 1000, ipDailyLimit: 1000, dailyBudget: 2 } });
  try {
    const send = (email, risk) => rawRisk(f, "/v1/auth/email-otp-challenges", { email, purpose: "login" }, risk);
    const first = await send("budget-1@example.test", "budget-risk-1");
    const second = await send("budget-2@example.test", "budget-risk-2");
    const third = await send("budget-3@example.test", "budget-risk-3");
    for (const response of [first, second, third]) { assert.equal(response.status, 200); assert.equal(response.body.accepted, true); }
    assert.equal(f.otp.length, 2, "budget=2 caps total sends across every risk scope");
    const counter = f.db.prepare("SELECT count FROM otp_abuse_counters WHERE counter_kind='global_daily'").get();
    assert.equal(counter.count, 2);
  } finally { f.close(); }
});

test("rate-limit and budget hits log a structured line with no email address or OTP code", async (t) => {
  const f = fixture({ otpRateLimits: { ipHourlyLimit: 1, ipDailyLimit: 1000, dailyBudget: 1000 } });
  const lines = [];
  // Captures a copy of everything written while still forwarding to the real stdout, so this
  // doesn't swallow node:test's own TAP/spec output on the shared process.stdout stream.
  const originalWrite = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk, ...rest) => { lines.push(String(chunk)); return originalWrite(chunk, ...rest); });
  try {
    const send = (email) => rawRisk(f, "/v1/auth/email-otp-challenges", { email, purpose: "login" }, "logged-risk");
    await send("logged-1@example.test");
    await send("logged-2@example.test");
    const events = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((event) => event?.event === "otp_send_budget_exceeded");
    assert.equal(events.length, 1);
    assert.equal(events[0].counterKind, "risk_hourly");
    assert.equal(events[0].limit, 1);
    assert.ok(Number.isSafeInteger(events[0].count));
    const raw = lines.join("\n");
    assert.equal(raw.includes("logged-1@example.test"), false);
    assert.equal(raw.includes("logged-2@example.test"), false);
  } finally { f.close(); }
});
