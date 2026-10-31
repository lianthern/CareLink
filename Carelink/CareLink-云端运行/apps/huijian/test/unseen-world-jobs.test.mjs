import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorldJobStore, publicWorldJob } from "../lib/unseen-world-jobs.mjs";
const cwd = fileURLToPath(new URL("..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const image = `data:image/jpeg;base64,${Buffer.alloc(300, 7).toString("base64")}`;
const requestBody = (id = "local-world-request-0001", extras = {}) => ({ mode: "single", image, publicConsent: true, clientRequestId: id, ...extras });
const operation = { operation_id: "local-operation-0001", done: false, metadata: { progress: { status: "PROCESSING" } } };
const world = { world_id: "local-world-0001", display_name: "Local World", assets: { imagery: { pano_url: "https://example.invalid/public-pano.jpg" } } };

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), "unseen-world-jobs-"));
  const calls = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString("utf8") });
    res.setHeader("content-type", "application/json");
    if (handler) return handler(req, res);
    if (req.url.startsWith("/worlds/")) return res.end(JSON.stringify(world));
    res.end(JSON.stringify(operation));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await session.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function boot() {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), STATE_DIRECTORY: directory,
        MINIMAX_API_KEY: "not-a-real-local-world-fixture", WORLDLABS_API_KEY: "not-a-real-local-world-fixture",
        MINIMAX_BASE_URL: "http://127.0.0.1:1", WORLDLABS_BASE_URL: base,
        WORLDLABS_DAILY_LIMIT: "10", WORLDLABS_VISITOR_DAILY_LIMIT: "10" }
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const session = {
      url: `http://127.0.0.1:${port}`, child,
      async stop() { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } },
      async owner() {
        const response = await fetch(`${this.url}/api/worldlabs/jobs`);
        assert.equal(response.status, 200);
        const cookie = response.headers.getSetCookie()[0];
        assert.match(cookie, /unseen_world_owner=[a-f0-9]{64}/);
        assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
        return cookie.split(";")[0];
      },
      post(cookie, body = requestBody()) {
        return fetch(`${this.url}/api/worldlabs/generate`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
      },
      get(path, cookie) { return fetch(`${this.url}${path}`, { headers: { cookie } }); }
    };
    sessions.push(session);
    for (let i = 0; i < 100; i += 1) {
      if (child.exitCode !== null) throw new Error(`server exited:${output}`);
      try { if ((await fetch(`${session.url}/api/health`)).ok) return session; } catch { /* await listen */ }
      await delay(20);
    }
    throw new Error(`server did not listen:${output}`);
  }
  return { boot, calls, directory, generations: () => calls.filter((call) => call.path === "/worlds:generate").length };
}

test("World store persists owner isolation and hashes, never photo inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "world-store-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "jobs.json");
  const store = createWorldJobStore(file);
  const input = { photo: "PRIVATE PHOTO BYTES", text: "PRIVATE TEXT" };
  const first = await store.begin("owner-alice", "request-0001", input);
  assert.equal(first.fresh, true);
  assert.equal((await store.begin("owner-alice", "request-0001", input)).fresh, false);
  await assert.rejects(store.begin("owner-alice", "request-0001", { photo: "changed" }), { status: 409 });
  assert.deepEqual(await store.list("owner-bob"), []);
  assert.equal(await store.get("owner-bob", "request-0001"), null);
  await store.update("owner-alice", "request-0001", { status: "unknown" });
  assert.equal((await createWorldJobStore(file).get("owner-alice", "request-0001")).status, "unknown");
  const published = publicWorldJob(first.job);
  assert.equal(published.owner, undefined); assert.equal(published.inputHash, undefined);
  const disk = await readFile(file, "utf8");
  assert.doesNotMatch(disk, /PRIVATE|owner-alice/);
});

test("World job store corrupted JSON fails closed without overwriting records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "world-store-broken-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "jobs.json");
  await writeFile(file, "{broken");
  await assert.rejects(createWorldJobStore(file).list("owner"), { code: "world_jobs_unavailable" });
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("same owner request reopens existing World task without a second upstream generation", async (t) => {
  const f = await fixture(t);
  const session = await f.boot();
  const alice = await session.owner();
  const bob = await session.owner();
  assert.equal((await session.post(alice)).status, 202);
  const duplicate = await session.post(alice);
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).operation.id, operation.operation_id);
  assert.equal(f.generations(), 1);
  const list = await (await session.get("/api/worldlabs/jobs", alice)).json();
  assert.equal(list.jobs.length, 1);
  assert.equal(list.jobs[0].status, "processing");
  assert.equal(list.jobs[0].owner, undefined); assert.equal(list.jobs[0].inputHash, undefined);
  assert.deepEqual((await (await session.get("/api/worldlabs/jobs", bob)).json()).jobs, []);
  assert.equal((await session.get("/api/worldlabs/jobs/local-world-request-0001", bob)).status, 404);
});

test("changed input under an existing World clientRequestId is an explicit 409, with zero extra generation", async (t) => {
  const f = await fixture(t);
  const session = await f.boot();
  const cookie = await session.owner();
  assert.equal((await session.post(cookie)).status, 202);
  assert.equal((await session.post(cookie, requestBody(undefined, { prompt: "different" }))).status, 409);
  assert.equal(f.generations(), 1);
});

test("unknown acceptance preserves quota and owner job across real process restart; repeat never resubmits", async (t) => {
  const f = await fixture(t, (_req, res) => res.end("invalid provider JSON after receiving the generation"));
  const first = await f.boot();
  const cookie = await first.owner();
  const response = await first.post(cookie);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).status, "unknown");
  await first.stop();
  const restarted = await f.boot();
  const recovered = await (await restarted.get("/api/worldlabs/jobs/local-world-request-0001", cookie)).json();
  assert.equal(recovered.job.status, "unknown");
  assert.equal((await restarted.post(cookie)).status, 409);
  assert.equal(f.generations(), 1);
  const quota = await (await restarted.get("/api/worldlabs/config", cookie)).json();
  assert.equal(quota.quota.remainingToday, 9);
});

test("submitting task survives server interruption and cannot replay a paid call", { timeout: 10_000 }, async (t) => {
  let markReceived;
  const received = new Promise((resolve) => { markReceived = resolve; });
  const f = await fixture(t, (_req, _res) => markReceived());
  const first = await f.boot();
  const cookie = await first.owner();
  const pending = first.post(cookie).catch(() => null);
  await received;
  const duplicate = await first.post(cookie);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).job.status, "submitting");
  assert.equal(f.generations(), 1);
  await first.stop();
  await pending;
  const restarted = await f.boot();
  assert.equal((await restarted.post(cookie)).status, 409);
  assert.equal(f.generations(), 1);
  const quota = await (await restarted.get("/api/worldlabs/config", cookie)).json();
  assert.equal(quota.quota.remainingToday, 9);
});

for (const status of [400, 401, 402, 429]) {
  test(`explicit upstream World rejection ${status} restores quota and records rejected job`, async (t) => {
    const f = await fixture(t, (_req, res) => { res.statusCode = status; res.end('{"error":"local explicit rejection"}'); });
    const session = await f.boot();
    const cookie = await session.owner();
    const response = await session.post(cookie);
    assert.equal(response.status, status === 402 ? 503 : status);
    assert.equal((await response.json()).status, "rejected");
    assert.equal(f.generations(), 1);
    assert.equal((await (await session.get("/api/worldlabs/config", cookie)).json()).quota.remainingToday, 10);
  });
}

test("owner job polling reconciles operation to completed public World and keeps private task ownership", async (t) => {
  const f = await fixture(t, (req, res) => {
    if (req.url === "/worlds:generate") return res.end(JSON.stringify(operation));
    if (req.url.startsWith("/operations/")) return res.end(JSON.stringify({ ...operation, done: true, response: world }));
    if (req.url.startsWith("/worlds/")) return res.end(JSON.stringify(world));
    res.writeHead(404); res.end("{}");
  });
  const session = await f.boot();
  const owner = await session.owner();
  await session.post(owner);
  const result = await (await session.get("/api/worldlabs/jobs/local-world-request-0001", owner)).json();
  assert.equal(result.job.status, "complete");
  assert.equal(result.job.operation.world.id, world.world_id);
  const reopened = await (await session.get(`/api/worldlabs/worlds/${world.world_id}`, owner)).json();
  assert.equal(reopened.world.panoramaUrl, "https://example.invalid/public-pano.jpg");
  assert.equal(f.generations(), 1);
});

test("World generation rejects cross-site and non-JSON calls before storing or contacting upstream", async (t) => {
  const f = await fixture(t);
  const session = await f.boot();
  const cookie = await session.owner();
  for (const [headers, expected] of [
    [{ "content-type": "application/json", origin: "https://malicious.example" }, 403],
    [{ "content-type": "text/plain" }, 415],
    [{ "content-type": "application/json", "sec-fetch-site": "cross-site" }, 403]
  ]) {
    const response = await fetch(`${session.url}/api/worldlabs/generate`, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify(requestBody()) });
    assert.equal(response.status, expected);
  }
  assert.equal(f.generations(), 0);
  assert.deepEqual((await (await session.get("/api/worldlabs/jobs", cookie)).json()).jobs, []);
  assert.equal((await (await session.get("/api/worldlabs/config", cookie)).json()).quota.remainingToday, 10);
});

test('selected models reach the provider, survive restart, and cannot be changed on replay',async t=>{
 const f=await fixture(t),s=await f.boot(),cookie=await s.owner();
 const config=await (await s.get('/api/worldlabs/config',cookie)).json();
 assert.equal(config.recommendedModel,'marble-1.1');assert.ok(config.inputTypes.includes('panorama'));
 for(const [i,model] of ['marble-1.0-draft','marble-1.1','marble-1.1-plus','marble-1.0'].entries()){
  const body=requestBody('model-selection-test-000'+i,{model});
  assert.equal((await s.post(cookie,body)).status,202);
  const actual=JSON.parse(f.calls.filter(c=>c.path==='/worlds:generate').at(-1).body);
  assert.equal(actual.model,model);assert.equal(actual.world_prompt.is_pano,false);
  assert.equal((await s.post(cookie,body)).status,202);
  assert.equal((await s.post(cookie,{...body,model:model==='marble-1.1'?'marble-1.1-plus':'marble-1.1'})).status,409);
 }
 assert.equal(f.generations(),4);await s.stop();const restarted=await f.boot();
 const jobs=(await (await restarted.get('/api/worldlabs/jobs',cookie)).json()).jobs;
 assert.equal(jobs.length,4);assert.ok(jobs.some(j=>j.model==='marble-1.1-plus'&&j.mode==='single'&&j.imageCount===1));
});

test('invalid models and unconfirmed panoramas stop before quota; a confirmed panorama reaches is_pano',async t=>{
 const f=await fixture(t),s=await f.boot(),cookie=await s.owner();
 for(const model of [null,{},'plus','marble-999']){
  const r=await s.post(cookie,requestBody('invalid-model-test-0001',{model}));assert.equal(r.status,400);assert.equal((await r.json()).error,'world_model_invalid');
 }
 const unconfirmed=await s.post(cookie,requestBody('pano-confirm-test-0001',{mode:'pano',model:'marble-1.1-plus'}));
 assert.equal(unconfirmed.status,400);assert.equal(f.generations(),0);
 assert.equal((await (await s.get('/api/worldlabs/config',cookie)).json()).quota.remainingToday,10);
 const valid=await s.post(cookie,requestBody('pano-confirm-test-0002',{mode:'pano',model:'marble-1.1-plus',panoConfirmed:true}));
 assert.equal(valid.status,202);const body=JSON.parse(f.calls.at(-1).body);assert.equal(body.model,'marble-1.1-plus');assert.equal(body.world_prompt.type,'image');assert.equal(body.world_prompt.is_pano,true);
});
