import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGenerationQuota } from "../lib/worldlabs-quota.mjs";
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "world-quota-reliability-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "usage.json");
}

test("malformed and inconsistent World quota state cannot reopen paid generation allowance", async (t) => {
  const filePath = await setup(t);
  const quota = createGenerationQuota({ filePath });
  for (const invalid of ["{broken", JSON.stringify({ date: "2026-09-05", total: 0, identities: { ["a".repeat(24)]: 5 } })]) {
    await writeFile(filePath, invalid);
    await assert.rejects(quota.reserve("visitor"), { code: "worldlabs_quota_unavailable" });
    assert.equal(await readFile(filePath, "utf8"), invalid);
  }
});

test("World quota disk write failure is classified and does not pretend to reserve", async (t) => {
  const filePath = await setup(t);
  await writeFile(filePath, "a file blocks the parent directory");
  const quota = createGenerationQuota({ filePath: join(filePath, "usage.json") });
  await assert.rejects(quota.reserve("visitor"), { code: "worldlabs_quota_unavailable" });
});

test("World quota survives restart and clock rollback without a second daily allowance", async (t) => {
  const filePath = await setup(t);
  let date = new Date("2026-09-05T12:00:00Z");
  const options = { filePath, dailyLimit: 1, now: () => date };
  const first = createGenerationQuota(options);
  assert.equal((await first.reserve("first")).ok, true);
  date = new Date("2026-09-04T12:00:00Z");
  const restarted = createGenerationQuota(options);
  assert.equal((await restarted.reserve("second")).reason, "daily_limit");
  date = new Date("2026-09-06T12:00:00Z");
  assert.equal((await restarted.reserve("second")).ok, true);
});
