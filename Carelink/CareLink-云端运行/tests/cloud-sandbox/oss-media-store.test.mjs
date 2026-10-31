import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OssMediaStore } from "../../adapters/cloud/cloudbase/src/oss-media-store.mjs";
import { assertMediaStorePort } from "../../services/api/src/ports/media/media-store-port.mjs";

const endpoint = "https://oss-cn-offline.example.test";
const bucket = "unseen-offline-sandbox";
const accessKeyId = ["offline", "access", "id"].join("-");
const accessKeySecret = ["offline", "signing", "material"].join("-");
const securityToken = ["offline", "session", "token"].join("-");
const fixedDate = new Date("2026-08-14T00:00:00.000Z");
const requestId = "ABCDEF0123456789";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

class FakeOss {
  constructor() {
    this.objects = new Map();
    this.calls = [];
    this.failures = [];
  }

  headersFor(object) {
    return {
      "content-length": String(object.body.length),
      "content-type": object.contentType,
      "last-modified": fixedDate.toUTCString(),
      "x-oss-meta-unseen-bytes": String(object.body.length),
      "x-oss-meta-unseen-sha256": object.sha256,
      "x-oss-request-id": requestId
    };
  }

  fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    this.calls.push({ url: String(url), method: init.method, headers, body: init.body,
      redirect: init.redirect });
    const failure = this.failures.shift();
    if (failure === "throw") throw new Error(`transport ${accessKeySecret} ${securityToken}`);
    if (failure) return new Response(`<Error>${accessKeySecret}</Error>`, {
      status: failure,
      headers: { "x-oss-request-id": accessKeySecret }
    });
    const parsed = new URL(url);
    const key = parsed.pathname.slice(1).split("/").map(decodeURIComponent).join("/");
    const object = this.objects.get(key);
    if (init.method === "PUT") {
      if (object && headers.get("x-oss-forbid-overwrite") === "true") {
        return new Response("exists", { status: 412, headers: { "x-oss-request-id": requestId } });
      }
      const body = Buffer.from(init.body);
      const stored = { body, contentType: headers.get("content-type"),
        sha256: headers.get("x-oss-meta-unseen-sha256") };
      assert.equal(headers.get("x-oss-meta-unseen-bytes"), String(body.length));
      assert.equal(stored.sha256, digest(body));
      assert.equal(headers.get("content-md5"), createHash("md5").update(body).digest("base64"));
      this.objects.set(key, stored);
      return new Response(null, { status: 200, headers: { "x-oss-request-id": requestId } });
    }
    if (!object) return new Response(null, { status: 404, headers: { "x-oss-request-id": requestId } });
    if (init.method === "HEAD") return new Response(null, { status: 200, headers: this.headersFor(object) });
    if (init.method === "GET") return new Response(object.body, { status: 200, headers: this.headersFor(object) });
    if (init.method === "DELETE") {
      this.objects.delete(key);
      return new Response(null, { status: 204, headers: { "x-oss-request-id": requestId } });
    }
    return new Response(null, { status: 405 });
  };
}

function fixture(fake = new FakeOss(), overrides = {}) {
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    const response = await fake.fetch(url, init);
    if (response.url === "") Object.defineProperty(response, "url", { value: String(url) });
    return response;
  };
  const store = new OssMediaStore({ endpoint, bucket, accessKeyId, accessKeySecret, securityToken,
    fetchImpl, clock: () => fixedDate, sleep: async (milliseconds) => sleeps.push(milliseconds),
    ...overrides });
  return { fake, store: assertMediaStorePort(store), sleeps };
}

test("deny-network OSS adapter implements put-if-absent, head, get, and idempotent delete", async () => {
  const { fake, store } = fixture();
  const key = "private/space-1/original/photo-1";
  const body = Buffer.from("exact-private-photo-bytes");
  const created = await store.putIfAbsent(key, body, { contentType: "image/jpeg", maxBytes: 1024 });
  assert.deepEqual(created, { created: true, exists: true, bytes: body.length, contentType: "image/jpeg",
    etag: digest(body), updatedAt: fixedDate.toUTCString() });
  const duplicate = await store.putIfAbsent(key, body, { contentType: "image/jpeg", maxBytes: 1024 });
  assert.equal(duplicate.created, false);
  const collision = await store.putIfAbsent(key, Buffer.from("different"),
    { contentType: "image/png", maxBytes: 1024 });
  assert.equal(collision.created, false);
  assert.equal(collision.etag, digest(body));
  assert.equal(collision.contentType, "image/jpeg");
  assert.equal(fake.calls.filter((call) => call.method === "PUT").at(-1).headers.get("x-oss-forbid-overwrite"), "true");
  assert.deepEqual(await store.head(key), { exists: true, bytes: body.length, contentType: "image/jpeg",
    etag: digest(body), updatedAt: fixedDate.toUTCString() });
  const downloaded = await store.get(key, { maxBytes: 1024 });
  assert.deepEqual(downloaded.body, body);
  assert.equal(downloaded.etag, digest(body));
  assert.equal(downloaded.contentType, "image/jpeg");
  const put = fake.calls.find((call) => call.method === "PUT");
  assert.equal(fake.calls.every((call) => call.redirect === "manual"), true);
  assert.equal(new URL(put.url).host, `${bucket}.oss-cn-offline.example.test`);
  assert.equal(put.headers.get("x-oss-object-acl"), "private");
  assert.equal(put.headers.get("if-none-match"), null);
  const canonicalHeaders = [
    "x-oss-forbid-overwrite:true",
    `x-oss-meta-unseen-bytes:${body.length}`,
    `x-oss-meta-unseen-sha256:${digest(body)}`,
    "x-oss-object-acl:private",
    `x-oss-security-token:${securityToken}`
  ].join("\n");
  const stringToSign = `PUT\n${put.headers.get("content-md5")}\nimage/jpeg\n${fixedDate.toUTCString()}\n` +
    `${canonicalHeaders}\n/${bucket}/${key}`;
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
  assert.equal(put.headers.get("authorization"), `OSS ${accessKeyId}:${signature}`);
  assert.ok(!put.headers.get("authorization").includes(accessKeySecret));
  await store.delete(key);
  await store.delete(key);
  assert.deepEqual(await store.head(key), { exists: false });
});

test("404 and size/hash corruption map to the frozen MediaStore errors", async () => {
  const { fake, store } = fixture();
  assert.deepEqual(await store.head("private/missing"), { exists: false });
  await assert.rejects(store.get("private/missing"), (error) =>
    error.code === "object_missing" && error.status === 409);
  await store.delete("private/missing");
  const key = "private/corrupt";
  fake.objects.set(key, { body: Buffer.from("bytes"), contentType: "image/png", sha256: digest(Buffer.from("other")) });
  await assert.rejects(store.get(key, { maxBytes: 100 }), (error) =>
    error.code === "media_object_corrupt" && error.status === 503);
  await assert.rejects(store.putIfAbsent("private/large", Buffer.alloc(2), { maxBytes: 1 }), (error) =>
    error.code === "object_too_large" && error.status === 413);
});

test("retryable 5xx responses retry deterministically and exhaustion stays redacted", async () => {
  const first = fixture();
  first.fake.failures.push(500, 503);
  const body = Buffer.from("retry-body");
  const stored = await first.store.putIfAbsent("private/retry", body, { contentType: "image/webp" });
  assert.equal(stored.created, true);
  assert.deepEqual(first.sleeps, [25, 50]);
  assert.equal(first.fake.calls.filter((call) => call.method === "PUT").length, 3);

  const second = fixture();
  second.fake.failures.push(500, 502, 503);
  await assert.rejects(second.store.head("private/redacted-key"), (error) => {
    const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details });
    return error.code === "media_store_unavailable" && error.status === 503 &&
      !serialized.includes(accessKeySecret) && !serialized.includes(securityToken) &&
      !serialized.includes("redacted-key");
  });
});

test("transport exceptions never leak credentials or object keys", async () => {
  const fake = new FakeOss();
  fake.failures.push("throw", "throw", "throw");
  const { store, sleeps } = fixture(fake);
  await assert.rejects(store.get("private/sensitive-object"), (error) => {
    const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details });
    return error.code === "media_store_unavailable" && error.status === 503 &&
      !serialized.includes(accessKeySecret) && !serialized.includes(securityToken) &&
      !serialized.includes("sensitive-object");
  });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(sleeps, [25, 50]);
});

test("redirected or off-origin PUT responses fail once without leaking private request data", async () => {
  const body = Buffer.from("private-put-body");
  for (const kind of ["redirected", "off-origin"]) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), ...init });
      const response = new Response(null, { status: kind === "off-origin" ? 503 : 307,
        headers: kind === "redirected" ? { location: "https://evil.example/private/object" } : undefined });
      Object.defineProperties(response, {
        redirected: { value: false },
        url: { value: kind === "off-origin" ? "https://evil.example/private/object" : String(url) }
      });
      return response;
    };
    const { store, sleeps } = fixture(new FakeOss(), { fetchImpl });
    await assert.rejects(store.putIfAbsent("private/redirect-secret", body,
      { contentType: "image/jpeg" }), (error) => {
      const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details });
      return error.code === "media_store_unavailable" && error.status === 503 &&
        !serialized.includes(accessKeySecret) && !serialized.includes(securityToken) &&
        !serialized.includes("redirect-secret") && !serialized.includes(body.toString());
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, "manual");
    assert.equal(calls[0].url.includes("evil.example"), false);
    assert.deepEqual(sleeps, []);
  }
});

test("HEAD, GET, and DELETE reject redirected and off-origin responses without retry", async () => {
  for (const method of ["HEAD", "GET", "DELETE"]) {
    for (const kind of ["redirected", "off-origin"]) {
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), ...init });
        const response = new Response(method === "GET" ? "private-read-body" : null,
          { status: kind === "off-origin" ? 503 : 307,
            headers: kind === "redirected" ? { location: "https://evil.example/private/object" } : undefined });
        Object.defineProperties(response, {
          redirected: { value: false },
          url: { value: kind === "off-origin" ? "https://evil.example/private/object" : String(url) }
        });
        return response;
      };
      const { store, sleeps } = fixture(new FakeOss(), { fetchImpl });
      const operation = method === "HEAD" ? store.head("private/response-secret") :
        method === "GET" ? store.get("private/response-secret") : store.delete("private/response-secret");
      await assert.rejects(operation, (error) => {
        const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details });
        return error.code === "media_store_unavailable" && error.status === 503 &&
          !serialized.includes(accessKeySecret) && !serialized.includes(securityToken) &&
          !serialized.includes("response-secret");
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, method);
      assert.equal(calls[0].redirect, "manual");
      assert.equal(calls[0].url.includes("evil.example"), false);
      assert.deepEqual(sleeps, []);
    }
  }
});

test("release evidence remains an honest offline preflight, never a Track 1B PASS", () => {
  const evidence = JSON.parse(readFileSync(new URL(
    "../../release-evidence/cloud-sandbox/OFFLINE-PREFLIGHT.json", import.meta.url)));
  assert.equal(evidence.status, "OFFLINE-PREFLIGHT");
  assert.equal(evidence.networkRequests, 0);
  assert.equal(evidence.cloudWrites, 0);
  assert.equal(evidence.credentialsLoaded, false);
  assert.equal(evidence.sandboxAuthorized, false);
  assert.equal(evidence.track1BPass, false);
});
