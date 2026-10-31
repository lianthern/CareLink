import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

// Conservative preview call caps, not an estimate of provider billing. All photo AI routes must
// share ONE gate instance and charge each upstream attempt (including any retry). This store assumes
// the deployed single Node process; multiple workers require a transactional shared store first.
export const PHOTO_AI_GATE_DEFAULTS = Object.freeze({
  dailyRequestLimit: 200, visitorRequestLimit: 6, globalRequestLimit: 20,
  concurrencyLimit: 4, windowMs: 60_000
});

export function createPhotoAiGate({ filePath, now = Date.now, ...options } = {}) {
  const limits = Object.fromEntries(Object.entries(PHOTO_AI_GATE_DEFAULTS).map(([key, fallback]) => {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`photo_ai_invalid_${key}`);
    return [key, value];
  }));
  let queue = Promise.resolve();
  let active = 0;
  const secret = randomBytes(32);
  let windowStart = Number(now());
  let windowRequests = 0;
  const visitors = new Map();
  const serial = (run) => {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
  async function readState(timestamp) {
    if (!filePath) throw new Error("photo_ai_state_path_required");
    const today = new Date(timestamp).toISOString().slice(0, 10);
    let state;
    try {
      state = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, date: today, used: 0 };
      throw error;
    }
    if (state?.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/u.test(state.date) ||
        !Number.isSafeInteger(state.used) || state.used < 0) throw new Error("photo_ai_state_invalid");
    // A clock rollback must not reopen the previous day's allowance.
    return state.date < today ? { version: 1, date: today, used: 0 } : state;
  }
  async function persist(state) {
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flush: true });
      await rename(temporary, filePath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  function limited(scope, retryAfterSeconds = 1) {
    return { ok: false, reason: "photo_ai_limited", scope, retryAfterSeconds };
  }
  return {
    reserve(identity) {
      return serial(async () => {
        const timestamp = Number(now());
        if (timestamp >= windowStart + limits.windowMs) {
          windowStart = timestamp;
          windowRequests = 0;
          visitors.clear();
        }
        const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + limits.windowMs - timestamp) / 1000));
        const key = createHmac("sha256", secret).update(String(identity || "unknown")).digest("hex");
        if (active >= limits.concurrencyLimit) return limited("concurrency");
        if (windowRequests >= limits.globalRequestLimit) return limited("global", retryAfterSeconds);
        if ((visitors.get(key) ?? 0) >= limits.visitorRequestLimit) return limited("visitor", retryAfterSeconds);
        let state;
        try {
          state = await readState(timestamp);
          if (state.used >= limits.dailyRequestLimit) {
            return limited("daily", Math.max(1, Math.ceil((Date.parse(`${state.date}T00:00:00Z`) + 86_400_000 - timestamp) / 1000)));
          }
          // Persist before allowing a network call. Failed/cancelled calls are never refunded because
          // acceptance by the upstream can be unknown. A process restart preserves the hard daily cap.
          await persist({ ...state, used: state.used + 1 });
        } catch {
          return { ok: false, reason: "photo_ai_state_unavailable", scope: "storage", retryAfterSeconds: 60 };
        }
        active += 1;
        windowRequests += 1;
        visitors.set(key, (visitors.get(key) ?? 0) + 1);
        let released = false;
        return {
          ok: true, remaining: Math.max(0, limits.dailyRequestLimit - state.used - 1),
          release() {
            if (!released) active -= 1;
            released = true;
          }
        };
      });
    },
    snapshot() {
      return serial(async () => {
        try {
          const state = await readState(Number(now()));
          return { ok: true, date: state.date, used: state.used, remaining: Math.max(0, limits.dailyRequestLimit - state.used), active, limits };
        } catch {
          return { ok: false, reason: "photo_ai_state_unavailable", active, limits };
        }
      });
    }
  };
}
