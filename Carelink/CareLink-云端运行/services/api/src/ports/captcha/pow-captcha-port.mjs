import { randomBytes, randomInt } from "node:crypto";
import { ApiError, assert } from "../../errors.mjs";
import { id, logStructured, sha256 } from "../../util.mjs";

// Altcha-style client-side proof-of-work: the server hands out a random salt and a target
// difficulty (in leading zero *bits* of the SHA-256 digest -- BigInt comparison rather than a
// hex-nibble prefix check so difficulty can be tuned one bit at a time instead of jumping by 16x
// per hex character), the browser brute-forces a nonce such that sha256(`${salt}:${nonce}`) has
// at least `difficultyBits` leading zero bits, and the server redoes that one cheap hash to check
// the answer. See apps/web/src/otp-pow/pow.js for the client-side twin of meetsPowDifficulty()
// below -- the two must stay byte-for-byte in sync on the message format (`${salt}:${nonce}`)
// and the bit-comparison algorithm, or every real solve will fail verification.
export const POW_ALGORITHM = "sha256-prefix-bits-v1";
// Calibrated 2026-08-17 against a real headless Chromium (crypto.subtle, same code path as
// otp-pow/worker.js) inside this sandboxed dev environment: 16 bits averaged ~0.9s (range
// ~0.1-1.5s across trials -- proof-of-work solve time is inherently a geometric distribution, so
// wide variance run-to-run is expected, not a bug) versus ~3.4s average at 18 bits and ~8.7s at
// 20. Real end-user hardware (unthrottled desktop/phone, no sandbox contention) should generally
// land faster than this measurement, not slower, but 16 bits already sits closer to the ~200-600ms
// target than 18 does. Tune via UNSEEN_OTP_CAPTCHA_DIFFICULTY_BITS if real traffic tells a
// different story.
const DEFAULT_DIFFICULTY_BITS = 16;
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60_000;

const VISUAL_SHAPES = [
  { label: "星形", path: "M50 12 60 37 87 38 66 55 73 82 50 67 27 82 34 55 13 38 40 37Z" },
  { label: "圆形", path: "M50 16A34 34 0 1 1 49.9 16Z" },
  { label: "三角形", path: "M50 14 88 82 12 82Z" },
  { label: "方形", path: "M18 18H82V82H18Z" }
];
const VISUAL_COLORS = ["#b94f72", "#426f8d", "#5e7d55", "#a7672a", "#76578f"];

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = randomInt(0, index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function createVisualChallenge() {
  const targetIndex = randomInt(0, VISUAL_SHAPES.length);
  const shapeIndexes = shuffled([targetIndex, targetIndex,
    ...Array.from({ length: 7 }, () => {
      const distractor = randomInt(0, VISUAL_SHAPES.length - 1);
      return distractor >= targetIndex ? distractor + 1 : distractor;
    })]);
  const answer = [];
  const tiles = shapeIndexes.map((shapeIndex, index) => {
    if (shapeIndex === targetIndex) answer.push(index);
    return {
      path: VISUAL_SHAPES[shapeIndex].path,
      fill: VISUAL_COLORS[randomInt(0, VISUAL_COLORS.length)],
      rotate: randomInt(-12, 13),
      dots: Array.from({ length: 4 }, () => [randomInt(8, 93), randomInt(8, 93), randomInt(1, 4)])
    };
  });
  return { prompt: `请选择所有${VISUAL_SHAPES[targetIndex].label}`, tiles, answer };
}

function storedChallenge(value) {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed?.salt === "string" && Array.isArray(parsed.answer)) return parsed;
  } catch { /* rolling-deploy compatibility with already-issued plain-salt challenges */ }
  return { salt: value, answer: null };
}

function normalizedSelection(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 9 ||
    value.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 8)) return null;
  const sorted = [...new Set(value)].sort((a, b) => a - b);
  return sorted.length === value.length ? sorted : null;
}

export function meetsPowDifficulty(hashHex, difficultyBits) {
  if (difficultyBits <= 0) return true;
  const value = BigInt(`0x${hashHex}`);
  const threshold = 1n << BigInt(256 - difficultyBits);
  return value < threshold;
}

export function createPowCaptchaPort(core, { difficultyBits = DEFAULT_DIFFICULTY_BITS,
  challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS } = {}) {
  assert(Number.isSafeInteger(difficultyBits) && difficultyBits >= 0 && difficultyBits <= 64,
    "otp_captcha_configuration_invalid", 500);
  assert(Number.isSafeInteger(challengeTtlMs) && challengeTtlMs >= 1_000 && challengeTtlMs <= 30 * 60_000,
    "otp_captcha_configuration_invalid", 500);
  const riskMac = (riskScope) => core.keyring.mac("otp-pow-risk-v1", riskScope ?? "");
  return {
    provider: "pow",

    // Unauthenticated, side-effect-light: any visitor of /login may mint one of these, so this
    // deliberately does *not* itself rate-limit issuance -- solving costs the requester real CPU
    // time and each row is single-use + short-lived, so the only cost of over-issuing is
    // otp_pow_challenges rows that expire quickly. The actual scarce resource (an outbound
    // email) stays gated by claimOtpCounter()/OtpDeliveryOutbox#claimSendBudget() at
    // consume()+enqueue() time.
    issue(ctx) {
      const challengeId = id("powc");
      const salt = randomBytes(16).toString("hex");
      const visual = createVisualChallenge();
      const expiresAt = new Date(core.nowMs() + challengeTtlMs).toISOString();
      core.db.prepare(`INSERT INTO otp_pow_challenges(
        id,algorithm,salt,difficulty_bits,risk_key_mac,risk_key_id,expires_at,created_at,version
      ) VALUES(?,?,?,?,?,?,?,?,1)`).run(challengeId, POW_ALGORITHM,
      JSON.stringify({ salt, answer: visual.answer }), difficultyBits,
      riskMac(ctx.riskScope), core.keyring.keyId, expiresAt, core.now());
      return { mode: "pow", challengeId, salt, algorithm: POW_ALGORITHM, difficultyBits, expiresAt,
        visual: { prompt: visual.prompt, tiles: visual.tiles } };
    },

    // Must run inside an already-open transaction (see identity-service.mjs's requestOtp(),
    // which calls this from core.mutation()'s beforeCreate -- itself already inside
    // transaction()) so a solved-but-ultimately-rate-limited challenge is still burned exactly
    // once: consumed_at is written unconditionally on a valid proof, before any downstream
    // per-email/per-risk-scope/budget check runs, so a script can't cheaply replay one solved
    // challenge across many otherwise-rate-limited attempts to dodge the PoW cost.
    consume(ctx, proof) {
      assert(core.db.isTransaction, "otp_captcha_transaction_required", 500);
      const challengeId = typeof proof?.challengeId === "string" && proof.challengeId.length >= 1 &&
        proof.challengeId.length <= 200 ? proof.challengeId : null;
      const nonce = Number.isSafeInteger(proof?.nonce) && proof.nonce >= 0 ? proof.nonce : null;
      if (!challengeId || nonce === null) {
        logStructured("otp_pow_verification_failed", { reason: "malformed_proof" });
        throw new ApiError("otp_verification_required", 400);
      }
      const row = core.one("SELECT * FROM otp_pow_challenges WHERE id=?", challengeId);
      const stored = row ? storedChallenge(row.salt) : null;
      const selection = normalizedSelection(proof?.selection);
      const visualMatches = stored?.answer === null || selection &&
        selection.length === stored.answer.length && selection.every((value, index) => value === stored.answer[index]);
      const expectedRisk = riskMac(ctx.riskScope);
      const riskMatches = Boolean(row) && row.risk_key_id === core.keyring.keyId &&
        core.keyring.equal(row.risk_key_mac, expectedRisk);
      const valid = row && !row.consumed_at && Date.parse(row.expires_at) > core.nowMs() && riskMatches &&
        row.algorithm === POW_ALGORITHM && visualMatches &&
        meetsPowDifficulty(sha256(`${stored.salt}:${nonce}`), row.difficulty_bits);
      if (!valid) {
        logStructured("otp_pow_verification_failed", { reason: !row ? "unknown_challenge" :
          row.consumed_at ? "already_consumed" : Date.parse(row.expires_at) <= core.nowMs() ? "expired" :
            !riskMatches ? "risk_scope_mismatch" : !visualMatches ? "visual_answer_wrong" : "difficulty_not_met" });
        throw new ApiError("otp_verification_failed", 403);
      }
      const updated = core.db.prepare(`UPDATE otp_pow_challenges SET consumed_at=?,version=version+1
        WHERE id=? AND version=? AND consumed_at IS NULL`).run(core.now(), row.id, row.version);
      assert(updated.changes === 1, "concurrent_change", 409);
    }
  };
}
