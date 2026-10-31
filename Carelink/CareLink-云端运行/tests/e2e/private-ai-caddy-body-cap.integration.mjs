import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const caddyBin = process.env.UNSEEN_CADDY_BIN;
assert.ok(caddyBin, "UNSEEN_CADDY_BIN is required for the real Caddy integration check");

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const reservePort = async () => {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
};
const request = ({ port, pathname, method = "POST", body = Buffer.alloc(0), authorization,
  extraHeaders = {}, chunked = false }) =>
  new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, ...extraHeaders };
    if (!chunked) headers["Content-Length"] = String(body.length);
    if (authorization) headers.Authorization = authorization;
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        protocol: res.headers["x-unseen-protocol"] ?? null,
        cacheControl: res.headers["cache-control"] ?? null,
        contentType: res.headers["content-type"] ?? null,
        csp: res.headers["content-security-policy"] ?? null,
        challenge: res.headers["www-authenticate"] ?? null,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.once("error", reject);
    if (chunked) {
      req.write(body.subarray(0, 16384));
      req.end(body.subarray(16384));
    } else {
      req.end(body);
    }
  });

const requestWithoutLength = ({ port, pathname }) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const chunks = [];
  socket.once("connect", () => socket.end(
    `POST ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.once("error", reject);
  socket.once("end", () => {
    const response = Buffer.concat(chunks).toString("utf8");
    const [head, body = ""] = response.split("\r\n\r\n", 2);
    const lines = head.split("\r\n");
    const status = Number(/^HTTP\/1\.[01] (\d{3})/u.exec(lines.shift())?.[1]);
    const headers = Object.fromEntries(lines.map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
    }));
    resolve({ status, protocol: headers["x-unseen-protocol"] ?? null,
      cacheControl: headers["cache-control"] ?? null, contentType: headers["content-type"] ?? null, body });
  });
});

const workerAuthorization = (value) => `Bearer ${value}`;
const auth = workerAuthorization("private-ai-test-only");
const protocol = "unseen-private-ai-pull/1";
let observations = [];
let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
  upstreamHits += 1;
  let bytes = 0;
  req.on("data", (chunk) => { bytes += chunk.length; });
  req.on("end", () => {
    observations.push({ path: req.url, method: req.method, authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null, host: req.headers.host,
      forwardedProto: req.headers["x-forwarded-proto"], bytes });
    if (req.url.startsWith("/__internal/private-ai/v1/")) {
      res.setHeader("X-Unseen-Protocol", protocol);
      if (req.headers.authorization !== auth) {
        res.writeHead(401).end();
        return;
      }
      if (req.headers["x-test-disabled"] === "1") {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(204).end();
      return;
    }
    const contentTypes = { ".js": "application/javascript", ".css": "text/css", ".jpg": "image/jpeg" };
    res.setHeader("Content-Security-Policy",
      "script-src 'nonce-upstream-test' 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:");
    res.setHeader("Content-Type", contentTypes[path.extname(req.url)] ?? "application/json");
    res.writeHead(200).end(`upstream:${req.url}`);
  });
});

const temp = await mkdtemp(path.join(os.tmpdir(), "unseen-caddy-body-cap-"));
let caddy;
try {
  const upstreamPort = await listen(upstream);
  const hashed = spawnSync(caddyBin, ["hash-password", "--plaintext", "public-test-only"], { encoding: "utf8" });
  assert.equal(hashed.status, 0, "Caddy must generate the test-only Basic Auth verifier");
  const profiles = [
    { id: "private_beta", source: "infra/integration/private-beta-deployment/Caddyfile",
      domainMarker: "REQUIRED_PRIVATE_BETA_DOMAIN", publicUpstream: false, readyStatus: 401 },
    { id: "production_package", source: "ops/release/Caddyfile.example",
      domainMarker: "REQUIRED_DOMAIN", publicUpstream: true, readyStatus: 200 }
  ];
  const results = [];
  for (const profile of profiles) {
    observations = [];
    upstreamHits = 0;
    const caddyPort = await reservePort();
    const source = await readFile(path.join(root, profile.source), "utf8");
    const config = `{
\tadmin off
\tauto_https off
}
${source}`
      .replace(profile.domainMarker, `http://127.0.0.1:${caddyPort}`)
      .replace("REQUIRED_BASIC_AUTH_USERNAME", "test-only")
      .replace("REQUIRED_BCRYPT_HASH", hashed.stdout.trim())
      .replaceAll("127.0.0.1:4282", `127.0.0.1:${upstreamPort}`);
    const configPath = path.join(temp, `${profile.id}.Caddyfile`);
    await writeFile(configPath, config, { mode: 0o600 });
    caddy = spawn(caddyBin, ["run", "--config", configPath, "--adapter", "caddyfile"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let caddyOutput = "";
    caddy.stdout.on("data", (chunk) => { caddyOutput += chunk; });
    caddy.stderr.on("data", (chunk) => { caddyOutput += chunk; });

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (caddy.exitCode !== null) break;
      try {
        const response = await request({ port: caddyPort, pathname: "/", body: Buffer.alloc(0) });
        if (response.status === profile.readyStatus) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(ready,
      `${profile.id}: Caddy did not become ready: ${caddyOutput.replace(/\$2[aby]\$[^\s"}]+/gu, "[REDACTED]").slice(-1000)}`);

    const endpoint = "/__internal/private-ai/v1/jobs/lease";
    const exact = await request({ port: caddyPort, pathname: endpoint,
      body: Buffer.alloc(32768), authorization: auth });
    assert.equal(exact.status, 204, `${profile.id}: exactly 32768 bytes must reach the upstream`);
    assert.equal(exact.protocol, protocol);
    assert.equal(observations.at(-1).bytes, 32768);
    assert.equal(observations.at(-1).host, "127.0.0.1");
    assert.equal(observations.at(-1).forwardedProto, "https");

    const hitsBeforeRejected = upstreamHits;
    const noLength = await requestWithoutLength({ port: caddyPort, pathname: endpoint });
    assert.equal(noLength.status, 413, `${profile.id}: missing Content-Length must receive local 413`);
    assert.equal(noLength.protocol, protocol);
    assert.ok(noLength.cacheControl.split(",").map((value) => value.trim()).includes("no-store"));
    assert.equal(noLength.contentType, "application/json");
    assert.equal(noLength.body, "");
    assert.equal(upstreamHits, hitsBeforeRejected, `${profile.id}: missing length must not reach upstream`);
    for (const size of [32769, 65536]) {
      const oversized = await request({ port: caddyPort, pathname: endpoint, body: Buffer.alloc(size) });
      assert.equal(oversized.status, 413, `${profile.id}:${size} must receive a local 413`);
      assert.equal(oversized.protocol, protocol);
      assert.ok(oversized.cacheControl.split(",").map((value) => value.trim()).includes("no-store"));
      assert.ok(oversized.cacheControl.split(",").map((value) => value.trim()).includes("private"));
      assert.equal(oversized.contentType, "application/json");
      assert.equal(oversized.body, "");
      assert.equal(upstreamHits, hitsBeforeRejected, `${profile.id}:${size} must not reach upstream`);
    }
    const chunkedOversized = await request({ port: caddyPort, pathname: endpoint,
      body: Buffer.alloc(32769), authorization: auth, chunked: true });
    assert.equal(chunkedOversized.status, 413, `${profile.id}: chunked POST must fail locally`);
    assert.equal(chunkedOversized.protocol, protocol);
    assert.ok(chunkedOversized.cacheControl.split(",").map((value) => value.trim()).includes("no-store"));
    assert.equal(chunkedOversized.contentType, "application/json");
    assert.equal(chunkedOversized.body, "");
    assert.equal(upstreamHits, hitsBeforeRejected, `${profile.id}: chunked POST must not reach upstream`);

    const missingBearer = await request({ port: caddyPort, pathname: endpoint, body: Buffer.alloc(1) });
    assert.equal(missingBearer.status, 401);
    assert.equal(missingBearer.protocol, protocol);
    const wrongBearer = await request({ port: caddyPort, pathname: endpoint, body: Buffer.alloc(1),
      authorization: workerAuthorization("wrong-test-only") });
    assert.equal(wrongBearer.status, 401);
    assert.equal(wrongBearer.protocol, protocol);
    const disabled = await request({ port: caddyPort, pathname: endpoint, body: Buffer.alloc(1),
      authorization: auth, extraHeaders: { "X-Test-Disabled": "1" } });
    assert.equal(disabled.status, 503);
    assert.equal(disabled.protocol, protocol);

    const publicHits = upstreamHits;
    const publicMissingAuth = await request({ port: caddyPort, pathname: "/healthz", body: Buffer.alloc(1) });
    assert.equal(publicMissingAuth.protocol, null);
    if (profile.publicUpstream) {
      assert.equal(publicMissingAuth.status, 200, "production must not add an outer auth challenge");
      assert.equal(publicMissingAuth.challenge, null);
      assert.equal(upstreamHits, publicHits + 1, "production public request must reach the application");
      assert.equal(publicMissingAuth.csp,
        "script-src 'nonce-upstream-test' 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:");
      assert.doesNotMatch(publicMissingAuth.csp, /default-src 'none'/u);
      assert.equal(publicMissingAuth.contentType, "application/json");
      assert.equal(publicMissingAuth.body, "upstream:/healthz");
      assert.equal(observations.at(-1).host, "127.0.0.1");
      assert.equal(observations.at(-1).forwardedProto, "https");
      const cookie = "unseen_session=cookie-test-only";
      const cookieResponse = await request({ port: caddyPort, pathname: "/api/spaces", body: Buffer.alloc(1),
        extraHeaders: { Cookie: cookie } });
      assert.equal(cookieResponse.status, 200);
      assert.equal(observations.at(-1).cookie, cookie, "production must pass the application session cookie");
      const appBearer = workerAuthorization("public-app-test-only");
      const bearerResponse = await request({ port: caddyPort, pathname: "/api/capability", body: Buffer.alloc(1),
        authorization: appBearer });
      assert.equal(bearerResponse.status, 200);
      assert.equal(observations.at(-1).authorization, appBearer,
        "production must pass application Authorization headers without proxy auth");
      for (const pathname of ["/assets/app.js", "/styles/app.css", "/media/photo.jpg", "/api/connect"]) {
        const asset = await request({ port: caddyPort, pathname, method: "GET" });
        assert.equal(asset.status, 200, `production must proxy ${pathname}`);
        assert.doesNotMatch(asset.csp, /default-src 'none'/u);
        assert.equal(asset.body, `upstream:${pathname}`);
      }
    } else {
      assert.equal(publicMissingAuth.status, 401, "private beta must retain outer Basic Auth");
      assert.equal(upstreamHits, publicHits, "private-beta static fallback must not reach the API upstream");
      const wrongBasic = await request({ port: caddyPort, pathname: "/healthz", body: Buffer.alloc(1),
        authorization: `Basic ${Buffer.from("test-only:wrong-test-only").toString("base64")}` });
      assert.equal(wrongBasic.status, 401);
      const rightBasic = await request({ port: caddyPort, pathname: "/healthz", body: Buffer.alloc(1),
        authorization: `Basic ${Buffer.from("test-only:public-test-only").toString("base64")}` });
      assert.equal(rightBasic.status, 404, "private-beta correct Basic Auth must reach static file handling");
      assert.equal(upstreamHits, publicHits);
    }

    results.push({ id: profile.id, exactBytesPassed: 32768, missingContentLengthRejectedLocally: true,
      oversizeBytesRejectedLocally: [32769, 65536], chunkedPostRejectedLocally: true,
      upstreamRequestsForRejectedBodies: 0, protocolHeader: protocol,
      cacheControl: "private, no-store, max-age=0", contentType: "application/json",
      hostPreserved: true, forwardedProtoHttps: true, publicMissingAuthStatus: publicMissingAuth.status,
      publicOuterAuth: profile.publicUpstream ? "absent_app_owned" : "basic_auth",
      publicFallback: profile.publicUpstream ? "proxy" : "static",
      applicationCookieAndBearerForwarded: profile.publicUpstream,
      upstreamCspAndContentPreserved: profile.publicUpstream,
      publicAssetAndConnectPathsProxied: profile.publicUpstream });
    if (caddy.exitCode === null) {
      caddy.kill("SIGTERM");
      await new Promise((resolve) => caddy.once("exit", resolve));
    }
    caddy = null;
  }

  process.stdout.write(`${JSON.stringify({ schema: "unseen-private-ai-caddy-body-cap-check/3",
    caddyVersion: spawnSync(caddyBin, ["version"], { encoding: "utf8" }).stdout.trim().split(" ")[0],
    profiles: results
  }, null, 2)}\n`);
} finally {
  if (caddy && caddy.exitCode === null) {
    caddy.kill("SIGTERM");
    await new Promise((resolve) => caddy.once("exit", resolve));
  }
  await close(upstream);
  await rm(temp, { recursive: true, force: true });
}
