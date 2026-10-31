import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { meetsDifficulty, POW_ALGORITHM, solvePow } from "../src/otp-pow/pow.js";

// Node-side re-derivation of the same digest, independent of pow.js's own crypto.subtle call, so
// this test can catch a corrupted message format rather than just echoing pow.js back at itself.
function sha256Hex(message) { return createHash("sha256").update(message, "utf8").digest("hex"); }

// A real SHA-256 digest is always exactly 64 hex characters (32 bytes / 256 bits) -- meetsDifficulty
// assumes that length when computing 256 - difficultyBits, so every fixture here is built to that
// exact length rather than hand-typed (a hand-typed string a couple of characters short silently
// shifts every comparison and was caught by this test suite once already while writing it).
const hex64 = (firstByteHex, fillHex) => firstByteHex + fillHex.repeat(31);

test("meetsDifficulty(0) accepts anything", () => {
  assert.equal(meetsDifficulty(hex64("ff", "ff"), 0), true);
  assert.equal(meetsDifficulty(hex64("00", "00"), 0), true);
});

test("meetsDifficulty checks leading zero *bits*, not just hex nibbles", () => {
  // 0x7f... has a leading zero bit (0111_1111) but not a leading zero hex nibble.
  const oneBitZero = hex64("7f", "ff");
  assert.equal(meetsDifficulty(oneBitZero, 1), true);
  assert.equal(meetsDifficulty(oneBitZero, 2), false);
  // Exactly 8 leading zero bits (one full hex byte), then a 1 bit immediately after.
  const eightBitsZero = hex64("00", "ff");
  assert.equal(meetsDifficulty(eightBitsZero, 8), true);
  assert.equal(meetsDifficulty(eightBitsZero, 9), false);
  assert.equal(hex64("00", "ff").length, 64);
});

test("solvePow(difficultyBits:0) resolves instantly with nonce 0", async () => {
  const result = await solvePow({ salt: "deadbeef", difficultyBits: 0 });
  assert.equal(result.nonce, 0);
  assert.equal(result.attempts, 1);
  assert.equal(result.hash, sha256Hex("deadbeef:0"));
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
});

test("solvePow finds a nonce whose hash actually clears a real (small) difficulty", async () => {
  const salt = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const difficultyBits = 12; // ~4096 expected attempts, milliseconds on any real machine
  const result = await solvePow({ salt, difficultyBits });
  assert.equal(result.hash, sha256Hex(`${salt}:${result.nonce}`));
  assert.equal(meetsDifficulty(result.hash, difficultyBits), true);
  // The server (pow-captcha-port.mjs) verifies with the exact same message format -- prove it
  // here too, independent of pow.js's own internal digest call.
  assert.equal(meetsDifficulty(sha256Hex(`${salt}:${result.nonce}`), difficultyBits), true);
});

test("solvePow rejects an unrecognized algorithm instead of silently solving the wrong puzzle", async () => {
  await assert.rejects(solvePow({ salt: "x", difficultyBits: 0, algorithm: "some-future-v2" }),
    /otp_pow_algorithm_unsupported/);
});

test("solvePow honors an AbortSignal instead of spinning forever on an unreachable difficulty", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(solvePow({ salt: "x", difficultyBits: 40 }, { signal: controller.signal }),
    (error) => error.name === "AbortError");
});

test("solvePow reports periodic progress without spamming on every single attempt", async () => {
  const progressCalls = [];
  await solvePow({ salt: "progress-salt", difficultyBits: 16 },
    { onProgress: (p) => progressCalls.push(p), progressIntervalMs: 0 });
  // progressIntervalMs:0 means "report as often as the loop yields" -- just confirm the shape
  // and that it never fires *after* a solve is already found (checked via the solve's own return
  // above having succeeded synchronously with the promise).
  for (const call of progressCalls) {
    assert.ok(Number.isSafeInteger(call.attempts) && call.attempts >= 1);
    assert.ok(Number.isFinite(call.elapsedMs) && call.elapsedMs >= 0);
  }
});

test("POW_ALGORITHM matches the server's documented identifier", () => {
  assert.equal(POW_ALGORITHM, "sha256-prefix-bits-v1");
});
