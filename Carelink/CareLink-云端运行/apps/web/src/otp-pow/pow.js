// Pure proof-of-work solver: no DOM, no fetch, no postMessage -- importable directly by
// node:test (see apps/web/tests/otp-pow.test.mjs) and by worker.js, which is the only place that
// actually calls solvePow() from a real page. Must stay byte-for-byte in sync with the server's
// twin in services/api/src/ports/captcha/pow-captcha-port.mjs: the message format
// (`${salt}:${nonce}`) and the "digest interpreted as a big-endian unsigned integer, must be
// below 2**(256-difficultyBits)" comparison are the actual protocol between browser and server.
export const POW_ALGORITHM = "sha256-prefix-bits-v1";

// crypto.subtle is available on both window and Worker global scope (and in Node 19+, which is
// what apps/web/tests/otp-pow.test.mjs runs under) -- no bundler-shipped hash library needed.
async function sha256Hex(message) {
  const bytes = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function meetsDifficulty(hashHex, difficultyBits) {
  if (difficultyBits <= 0) return true;
  const value = BigInt(`0x${hashHex}`);
  const threshold = 1n << BigInt(256 - difficultyBits);
  return value < threshold;
}

// Brute-forces nonce = 0, 1, 2, ... until sha256(`${salt}:${nonce}`) clears the target difficulty.
// Each iteration awaits crypto.subtle.digest, which both does the real hashing work and yields to
// the event loop -- so `signal` (an AbortSignal) and `onProgress` (called at most every
// `progressIntervalMs`, not every attempt) both get a chance to run between attempts without any
// extra setTimeout throttling.
export async function solvePow({ salt, difficultyBits, algorithm = POW_ALGORITHM }, { signal,
  onProgress, progressIntervalMs = 150 } = {}) {
  if (algorithm !== POW_ALGORITHM) throw new Error("otp_pow_algorithm_unsupported");
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  let lastProgressAt = startedAt;
  for (let nonce = 0; ; nonce += 1) {
    if (signal?.aborted) throw new DOMException("otp_pow_solve_aborted", "AbortError");
    const hash = await sha256Hex(`${salt}:${nonce}`);
    if (meetsDifficulty(hash, difficultyBits)) {
      const elapsedMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
      return { nonce, hash, attempts: nonce + 1, elapsedMs };
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (onProgress && now - lastProgressAt >= progressIntervalMs) {
      lastProgressAt = now;
      onProgress({ attempts: nonce + 1, elapsedMs: now - startedAt });
    }
  }
}
