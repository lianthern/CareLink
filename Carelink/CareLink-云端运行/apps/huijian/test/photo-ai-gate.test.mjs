import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createPhotoAiGate } from "../lib/photo-ai-gate.mjs";
const execute = promisify(execFile);
async function stateFile(t) {
  const directory = await mkdtemp(join(tmpdir(), "photo-ai-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "usage.json");
}

test("shared photo gate serializes bursts; rejected requests never reserve daily calls", async (t) => {
  const filePath = await stateFile(t);
  const gate = createPhotoAiGate({ filePath, concurrencyLimit: 3 });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => gate.reserve(`visitor-${i}`)));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.deepEqual(new Set(results.filter((r) => !r.ok).map((r) => r.scope)), new Set(["concurrency"]));
  for (const result of results.filter((r) => r.ok)) { result.release(); result.release(); }
  assert.equal((await gate.snapshot()).active, 0);
  assert.equal((await gate.snapshot()).used, 3);
});

test("visitor and global window limits share the same upstream budget", async (t) => {
  let now = Date.UTC(2026, 8, 5);
  const gate = createPhotoAiGate({ filePath: await stateFile(t), visitorRequestLimit: 1, globalRequestLimit: 2, now: () => now });
  (await gate.reserve("alice")).release();
  assert.equal((await gate.reserve("alice")).scope, "visitor");
  (await gate.reserve("bob")).release();
  assert.equal((await gate.reserve("carol")).scope, "global");
  now += 60_001;
  (await gate.reserve("alice")).release();
  assert.equal((await gate.snapshot()).used, 3);
});

test("persistent daily budget survives a real process restart", async (t) => {
  const filePath = await stateFile(t);
  const moduleUrl = new URL("../lib/photo-ai-gate.mjs", import.meta.url).href;
  const source = `import { createPhotoAiGate } from ${JSON.stringify(moduleUrl)};
    const gate = createPhotoAiGate({filePath:process.argv[1],dailyRequestLimit:1});
    const reservation = await gate.reserve('local-test');
    reservation.release?.();
    process.stdout.write(JSON.stringify(reservation));`;
  const run = async () => JSON.parse((await execute(process.execPath, ["--input-type=module", "-e", source, filePath])).stdout);
  assert.equal((await run()).ok, true);
  assert.equal((await run()).scope, "daily");
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).used, 1);
});

test("daily rollover opens a new allowance but clock rollback does not", async (t) => {
  let now = Date.UTC(2026, 8, 5);
  const gate = createPhotoAiGate({ filePath: await stateFile(t), dailyRequestLimit: 1, now: () => now });
  (await gate.reserve("alice")).release();
  now += 86_400_000;
  (await gate.reserve("bob")).release();
  now -= 86_400_000;
  assert.equal((await gate.reserve("carol")).scope, "daily");
});

test("missing persistence configuration, corrupted state and failed writes all fail closed", async (t) => {
  assert.equal((await createPhotoAiGate().reserve("alice")).reason, "photo_ai_state_unavailable");
  const filePath = await stateFile(t);
  await writeFile(filePath, "{broken");
  const gate = createPhotoAiGate({ filePath });
  assert.equal((await gate.reserve("alice")).reason, "photo_ai_state_unavailable");
  assert.equal(await readFile(filePath, "utf8"), "{broken");
  const unwritable = createPhotoAiGate({ filePath: join(filePath, "usage.json") });
  assert.equal((await unwritable.reserve("alice")).reason, "photo_ai_state_unavailable");
});
