import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}
function identityKey(value) {
  return createHash("sha256").update(String(value || "unknown")).digest("hex").slice(0, 24);
}

function emptyState(date) {
  return { date, total: 0, identities: {} };
}

export function createGenerationQuota({ filePath = null, dailyLimit = 5, identityDailyLimit = 1, now = () => new Date() } = {}) {
  let memoryState = emptyState(dayKey(now()));
  let writeQueue = Promise.resolve();

  async function load() {
    if (!filePath) return memoryState;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (cause) {
      if (cause.code === "ENOENT") return emptyState(dayKey(now()));
      throw Object.assign(new Error("worldlabs_quota_unavailable", { cause }), { code: "worldlabs_quota_unavailable" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(parsed?.date) || !Number.isSafeInteger(parsed.total) || parsed.total < 0 ||
        !parsed.identities || typeof parsed.identities !== "object" || Array.isArray(parsed.identities) ||
        Object.entries(parsed.identities).some(([key, count]) => !/^[a-f0-9]{24}$/u.test(key) || !Number.isSafeInteger(count) || count < 0) ||
        Object.values(parsed.identities).reduce((sum, count) => sum + count, 0) !== parsed.total) {
      throw Object.assign(new Error("worldlabs_quota_unavailable"), { code: "worldlabs_quota_unavailable" });
    }
    return parsed.date < dayKey(now()) ? emptyState(dayKey(now())) : parsed;
  }

  async function persist(state) {
    if (!filePath) { memoryState = state; return; }
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flush: true });
      await rename(temporary, filePath);
      memoryState = state;
    } catch (cause) {
      throw Object.assign(new Error("worldlabs_quota_unavailable", { cause }), { code: "worldlabs_quota_unavailable" });
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  function serial(task) {
    const result = writeQueue.then(task, task);
    writeQueue = result.catch(() => {});
    return result;
  }

  return {
    reserve(identity) {
      return serial(async () => {
        const today = dayKey(now());
        const state = await load();
        if (state.date < today) Object.assign(state, emptyState(today));
        const key = identityKey(identity);
        const usedByIdentity = Number(state.identities[key] ?? 0);
        if (state.total >= dailyLimit) return { ok: false, reason: "daily_limit" };
        if (usedByIdentity >= identityDailyLimit) return { ok: false, reason: "visitor_daily_limit" };
        state.total += 1;
        state.identities[key] = usedByIdentity + 1;
        await persist(state);
        return { ok: true, token: { date: today, key } };
      });
    },

    release(token) {
      return serial(async () => {
        if (!token?.date || !token?.key) return;
        const state = await load();
        if (state.date !== token.date) return;
        state.total = Math.max(0, state.total - 1);
        state.identities[token.key] = Math.max(0, Number(state.identities[token.key] ?? 0) - 1);
        await persist(state);
      });
    },

    snapshot() {
      return serial(async () => {
        const state = await load();
        return { date: state.date, used: state.total, limit: dailyLimit };
      });
    }
  };
}
