import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGenerationQuota } from "../lib/worldlabs-quota.mjs";

test("the quota caps each visitor and the whole public demo without storing raw addresses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huijian-worldlabs-quota-"));
  const path = join(directory, "usage.json");
  const now = () => new Date("2026-09-02T03:00:00Z");
  const quota = createGenerationQuota({ filePath: path, dailyLimit: 2, identityDailyLimit: 1, now });

  const first = await quota.reserve("198.51.100.1");
  assert.equal(first.ok, true);
  assert.deepEqual(await quota.reserve("198.51.100.1"), { ok: false, reason: "visitor_daily_limit" });
  assert.equal((await quota.reserve("198.51.100.2")).ok, true);
  assert.deepEqual(await quota.reserve("198.51.100.3"), { ok: false, reason: "daily_limit" });

  const persisted = await (await import("node:fs/promises")).readFile(path, "utf8");
  assert.doesNotMatch(persisted, /198\.51\.100/u);
  await quota.release(first.token);
  assert.equal((await quota.reserve("198.51.100.3")).ok, true);
});
