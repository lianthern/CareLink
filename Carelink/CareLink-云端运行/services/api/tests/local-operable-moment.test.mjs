import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Boot the same outer runtime used by the supervised server, including its
// public-origin/Host checks and legacy viewer adapters. This is deliberately
// separate from createLocalHttpServer-only tests.
test("supervised local-operable mounts moment APIs, accepts large authenticated JSON and preserves original media ranges", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "unseen-operable-moment-"));
  const data = path.join(root, "data"), evidence = path.join(root, "evidence");
  const publicOrigin = "https://moment-runtime.example.test";
  const runtime = spawn(process.execPath, [path.join(repositoryRoot, "infra/integration/local-operable.mjs")], {
    cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      UNSEEN_LOCAL_PORT: String(20000 + Math.floor(Math.random() * 30000)), UNSEEN_LOCAL_HOST: "127.0.0.1",
      UNSEEN_LOCAL_DATA_DIR: data, UNSEEN_LOCAL_EVIDENCE_DIR: evidence,
      UNSEEN_LOCAL_PUBLIC_ORIGIN: publicOrigin, UNSEEN_LOCAL_SUPERVISED_MODE: "server_staging",
      UNSEEN_LOCAL_EXTERNAL_ORIGIN_ACK: "access_controlled_tls_reverse_proxy",
      UNSEEN_BOOK_LAB_ENABLED: "false", UNSEEN_PRIVATE_AI_WORKER_ENABLED: "false"
    }
  });
  t.after(async () => {
    if (runtime.exitCode === null) {
      const exit = new Promise(resolve => runtime.once("exit", resolve)); runtime.kill("SIGTERM");
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (runtime.exitCode === null) { runtime.kill("SIGKILL"); await exit; }
    }
    rmSync(root, { recursive: true, force: true });
  });
  let stdout = "", stderr = "";
  runtime.stdout.on("data", chunk => { stdout += chunk; });
  runtime.stderr.on("data", chunk => { stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("supervised_runtime_boot_timeout")), 10000);
    runtime.stdout.on("data", () => {
      const line = stdout.split("\n").find(line => line.includes('"status":"LOCAL_OPERABLE_READY"'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    runtime.once("exit", code => { clearTimeout(timer); reject(new Error(`supervised_runtime_boot_failed:${code}:${stderr}`)); });
  });
  assert.equal(ready.origin, publicOrigin);
  assert.ok(ready.listenOrigin.startsWith("http://127.0.0.1:"));
  const seed = spawnSync(process.execPath, [path.join(repositoryRoot, "services/api/scripts/create-password-account.mjs")], {
    cwd: repositoryRoot, encoding: "utf8", env: { ...process.env,
      UNSEEN_API_DB: path.join(data, "unseen.sqlite"), UNSEEN_API_KEYSET: path.join(data, "local.keyset.json"),
      UNSEEN_SEED_USERNAME: "runtime_moment", UNSEEN_SEED_CREDENTIALS_FILE: path.join(root, "credentials.json")
    }
  });
  assert.equal(seed.status, 0, seed.stderr);
  const credential = JSON.parse(readFileSync(path.join(root, "credentials.json")));
  const call = (method, route, body, cookie, extra = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(ready.listenOrigin + route, { method,
      headers: { host: new URL(publicOrigin).host, origin: publicOrigin, "sec-fetch-site": "same-origin",
        "content-type": "application/json", "idempotency-key": randomUUID(), ...(cookie ? { cookie } : {}),
        ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }), ...extra }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers(Object.fromEntries(Object.entries(response.headers).map(([key,value]) => [key, Array.isArray(value) ? value.join(", ") : value])));
        const raw = Buffer.concat(chunks);
        const result = headers.get("content-type")?.startsWith("application/json") ? JSON.parse(raw.toString()) : raw;
        resolve({ status: response.statusCode, headers, body: result });
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error("http_timeout")));
    request.once("error", reject); request.end(payload);
  });
  const logged = await call("POST", "/v1/auth/password-login", credential);
  assert.equal(logged.status, 200, JSON.stringify(logged.body));
  const cookie = logged.headers.get("set-cookie").split(";")[0];
  assert.ok(cookie.startsWith("__Host-unseen_account="));
  assert.equal(logged.body.accountSessionSecret, undefined);
  const profile = await call("PATCH", "/v1/profile", { preferences: { readReplies: false, continuous: false } }, cookie);
  assert.equal(profile.status, 200); assert.equal(profile.body.user.preferences.readReplies, false);
  assert.deepEqual((await call("GET", "/v1/moments", undefined, cookie)).body.moments, []);

  // Actual PCM WAV data whose selected byte range is valid JSON with whitespace.
  // Legacy JSON response adaptation would shrink the bytes but retain the old
  // Content-Length, causing a corrupt range/hanging reader.
  const pcm = Buffer.from('{"fixture": 1}');
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  const wave = Buffer.concat([header, pcm]);
  const mediaBody = { kind: "audio", name: "range-test.wav", mimeType: "audio/wav", dataBase64: wave.toString("base64") };
  assert.equal((await call("PUT", "/v1/moment-media/range-test", mediaBody, cookie)).status, 200);
  const ranged = await call("GET", "/v1/moment-media/range-test", undefined, cookie, { range: `bytes=44-${wave.length - 1}` });
  assert.equal(ranged.status, 206); assert.deepEqual(ranged.body, pcm);
  assert.equal(ranged.headers.get("content-length"), String(pcm.length));
  assert.equal(ranged.headers.get("content-range"), `bytes 44-${wave.length - 1}/${wave.length}`);
  assert.deepEqual((await call("GET", "/v1/moment-media/range-test", undefined, cookie)).body, wave);

  const largeWave = Buffer.concat([header, Buffer.alloc(1024 * 1024)]);
  largeWave.writeUInt32LE(largeWave.length - 8, 4); largeWave.writeUInt32LE(largeWave.length - 44, 40);
  const largeMedia = { ...mediaBody, name: "large.wav", dataBase64: largeWave.toString("base64") };
  assert.equal((await call("PUT", "/v1/moment-media/large", largeMedia, cookie)).status, 200);
  assert.equal((await call("PUT", "/v1/moment-media/unauth", largeMedia)).status, 401);
  const now = new Date().toISOString();
  const moment = { id: "runtime", title: "运行时挂载验证", status: "active", createdAt: now, updatedAt: now,
    photos: [], messages: [{ id: "message", role: "user", text: "原话".repeat(190000), createdAt: now }], context: {},
    preferences: { photoMode: "clear" } };
  const saved = await call("PUT", "/v1/moments/runtime", { expectedVersion: 0, moment }, cookie);
  assert.equal(saved.status, 200); assert.equal(saved.body.version, 1);
  assert.deepEqual((await call("GET", "/v1/moments/runtime", undefined, cookie)).body.moment, moment);
  assert.equal((await call("PATCH", "/v1/profile", { displayName: "blocked" }, cookie,
    { origin: "https://foreign.example", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await call("PUT", "/v1/moments/oversized", { padding: "x".repeat(9 * 1024 * 1024 + 1) }, cookie)).status, 413);
});
