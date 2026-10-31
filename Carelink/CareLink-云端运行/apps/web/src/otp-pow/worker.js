// Module Worker entry point for the /login "获取验证码" human-verification step. Runs the PoW
// brute-force loop off the main thread so the UI never freezes while solving -- see
// otp-pow/client.js for the code that spawns this worker and otp-pow/pow.js for the actual
// (DOM-free, independently unit-tested) solver this file just wires up to postMessage.
//
// CSP note: apps/web's script-src is 'self'-only, so this file must be served same-origin (it
// is -- apps/web/server.mjs and infra/integration/local-operable.mjs serve /src/** directly) and
// the CSP's worker-src directive must allow 'self' (both of those servers were updated alongside
// this file; see their own comments at the worker-src line).
import { solvePow } from "./pow.js";

let currentController = null;

self.onmessage = async (event) => {
  const { type, requestId, challenge } = event.data ?? {};
  if (type !== "solve") return;
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;
  try {
    const result = await solvePow(challenge, {
      signal: controller.signal,
      onProgress: (progress) => self.postMessage({ type: "progress", requestId, ...progress })
    });
    if (controller.signal.aborted) return;
    self.postMessage({ type: "solved", requestId, ...result });
  } catch (error) {
    if (controller.signal.aborted) return;
    self.postMessage({ type: "error", requestId, message: error?.message || "otp_pow_solve_failed" });
  }
};
