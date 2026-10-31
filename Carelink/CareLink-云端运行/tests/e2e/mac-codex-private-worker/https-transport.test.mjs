import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExactHttpsClient, loadPrivateWorkerToken, PrivateWorkerTransportError,
  withPrivateDownloadedImage } from "../../../infra/integration/mac-codex-private-worker/https-transport.mjs";

const projectPhoto = path.resolve(path.dirname(new URL(import.meta.url).pathname),
  "../../../apps/web/assets/photos/photo-1.jpg");
const hash = (value, encoding = "hex") => createHash("sha256").update(value).digest(encoding);

function certificate(directory, name) {
  const key = path.join(directory, `${name}.key.pem`);
  const cert = path.join(directory, `${name}.cert.pem`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  return { key, cert };
}

async function serverFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-private-https-test-"));
  await chmod(directory, 0o700);
  const primary = certificate(directory, "primary");
  const other = certificate(directory, "other");
  const tokenPath = path.join(directory, "worker.token");
  const token = "test_private_worker_token_0123456789abcdef";
  await writeFile(tokenPath, token, { mode: 0o600 });
  const server = https.createServer({ key: await readFile(primary.key), cert: await readFile(primary.cert) },
    (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/ok" }).end();
      } else if (request.url === "/disconnect") {
        response.writeHead(200, { "content-type": "application/json", "content-length": "40" });
        response.write("{");
        response.destroy();
      } else if (request.url === "/large") {
        response.writeHead(200, { "content-type": "application/json" }).end("x".repeat(200));
      } else {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify({ ok: true }));
      }
    });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  const address = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const common = { origin: `https://localhost:${address.port}`, expectedHostname: "localhost", tokenPath,
    tokenUid: process.getuid(), timeoutMs: 2_000, tlsPolicy: { mode: "ca-file", caFile: primary.cert } };
  return { directory, primary, other, token, tokenPath, common };
}

test("exact HTTPS client accepts only the configured origin, CA, token and non-redirect response", async (t) => {
  const fixture = await serverFixture(t);
  const client = new ExactHttpsClient(fixture.common);
  assert.deepEqual((await client.requestJson("/ok")).value, { ok: true });
  assert.throws(() => new ExactHttpsClient({ ...fixture.common, expectedHostname: "example.invalid" }),
    (error) => error.code === "transport_configuration_invalid");
  await assert.rejects(client.requestJson("https://example.invalid/ok"),
    (error) => error.code === "transport_endpoint_invalid");
  await assert.rejects(client.requestJson("/redirect"),
    (error) => error.code === "transport_redirect_rejected");

  const wrongCa = new ExactHttpsClient({ ...fixture.common,
    tlsPolicy: { mode: "ca-file", caFile: fixture.other.cert } });
  await assert.rejects(wrongCa.requestJson("/ok"),
    (error) => error instanceof PrivateWorkerTransportError && error.code === "transport_unavailable");

  const cert = new X509Certificate(await readFile(fixture.primary.cert));
  const correctPin = hash(cert.publicKey.export({ format: "der", type: "spki" }), "base64");
  assert.deepEqual((await new ExactHttpsClient({ ...fixture.common, tlsPolicy: { mode: "ca-file",
    caFile: fixture.primary.cert, spkiSha256: correctPin } }).requestJson("/ok")).value, { ok: true });
  await assert.rejects(new ExactHttpsClient({ ...fixture.common, tlsPolicy: { mode: "ca-file",
    caFile: fixture.primary.cert, spkiSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" } })
    .requestJson("/ok"), (error) => error.code === "transport_unavailable");
});

test("private token rejects wrong owner surface, loose mode and symlinks without returning contents", async (t) => {
  const fixture = await serverFixture(t);
  assert.equal(await loadPrivateWorkerToken(fixture.tokenPath, process.getuid()), fixture.token);
  await assert.rejects(loadPrivateWorkerToken(fixture.tokenPath, process.getuid() + 1),
    (error) => error.code === "private_file_invalid");
  await chmod(fixture.tokenPath, 0o644);
  await assert.rejects(loadPrivateWorkerToken(fixture.tokenPath, process.getuid()),
    (error) => error.code === "private_file_invalid" && !error.message.includes(fixture.token));
  await chmod(fixture.tokenPath, 0o600);
  const link = path.join(fixture.directory, "token-link");
  await symlink(fixture.tokenPath, link);
  await assert.rejects(loadPrivateWorkerToken(link, process.getuid()),
    (error) => error.code === "private_file_invalid");
});

test("transport bounds bodies and treats disconnects as retryable without response disclosure", async (t) => {
  const fixture = await serverFixture(t);
  const client = new ExactHttpsClient(fixture.common);
  await assert.rejects(client.requestJson("/large", { maximumBytes: 32 }),
    (error) => error.code === "transport_response_too_large");
  await assert.rejects(client.requestJson("/disconnect"),
    (error) => error.code === "transport_unavailable" && error.retryable === true);
  await writeFile(fixture.tokenPath, "wrong_private_worker_token_0123456789abcdef", { mode: 0o600 });
  await assert.rejects(client.requestJson("/ok"),
    (error) => error.code === "transport_auth_rejected" && !error.message.includes("wrong_private"));
});

test("downloaded image is hash/pixel checked, fsynced at 0600 and removed after use", async (t) => {
  const bytes = await readFile(projectPhoto);
  let temporaryPath;
  const result = await withPrivateDownloadedImage({ bytes, contentType: "image/jpeg", expectedSha256: hash(bytes),
    maximumBytes: 20 * 1024 * 1024, maximumPixels: 16_777_216 }, async ({ imagePath, width, height }) => {
    temporaryPath = imagePath;
    assert.equal((await lstat(imagePath)).mode & 0o777, 0o600);
    assert.ok(width > 0 && height > 0);
    return "processed";
  });
  assert.equal(result, "processed");
  await assert.rejects(access(temporaryPath));
  await assert.rejects(withPrivateDownloadedImage({ bytes, contentType: "image/png", expectedSha256: hash(bytes),
    maximumBytes: bytes.length, maximumPixels: 16_777_216 }, async () => {}),
  (error) => error.code === "transport_image_invalid");
  await assert.rejects(withPrivateDownloadedImage({ bytes, contentType: "image/jpeg", expectedSha256: hash("bad"),
    maximumBytes: bytes.length, maximumPixels: 16_777_216 }, async () => {}),
  (error) => error.code === "transport_image_invalid");
});
