// Browser-API glue: spawns the same-origin module Worker (./worker.js), wraps its postMessage
// protocol in a Promise with a timeout, and reports periodic progress so app.js can update the
// "获取验证码" button. Pure solving logic lives in ./pow.js; this file owns nothing but Worker
// lifecycle (mirrors zine/zine-app.js vs zine/layout.js's split -- see that pair's own comments).
const DEFAULT_TIMEOUT_MS = 20_000;

export class OtpPowTimeoutError extends Error {
  constructor() { super("otp_pow_solve_timeout"); this.name = "OtpPowTimeoutError"; }
}

// challenge is whatever HttpApiAdapter#requestOtpVerificationChallenge() returned from
// POST /v1/auth/otp-verification-challenges. Only mode:"pow" needs a Worker round trip; every
// other mode (today: "disabled", and the not-yet-frontend-wired "tencent_captcha" -- see
// services/api/src/ports/captcha/tencent-captcha-port.mjs's header for that one's status)
// resolves immediately with no proof fields to attach to the AUTH.REQUEST_CODE body.
export function solveVerificationChallenge(challenge, { onProgress, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!challenge || challenge.mode !== "pow") return Promise.resolve({});
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker;
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    } catch {
      reject(new Error("otp_pow_worker_unavailable"));
      return;
    }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => finish(() => reject(new OtpPowTimeoutError())), timeoutMs);
    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      action();
    }
    worker.onmessage = (event) => {
      const data = event.data ?? {};
      if (data.requestId !== requestId) return;
      if (data.type === "progress") { onProgress?.(data); return; }
      if (data.type === "solved") {
        finish(() => resolve({ verificationChallengeId: challenge.challengeId, verificationNonce: data.nonce }));
        return;
      }
      if (data.type === "error") finish(() => reject(new Error(data.message || "otp_pow_solve_failed")));
    };
    worker.onerror = () => finish(() => reject(new Error("otp_pow_worker_unavailable")));
    worker.postMessage({ type: "solve", requestId, challenge });
  });
}
