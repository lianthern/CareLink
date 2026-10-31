"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { OssV1Adapter, canonicalOssHeaders } = require("../lib/oss-v1.js");

test("ListObjects V1 signs the bucket resource, not list filter query parameters", async () => {
  let request;
  const adapter = new OssV1Adapter({
    bucket: "examplebucket",
    endpoint: "oss-cn-hangzhou.aliyuncs.com",
    accessKeyId: "access-id",
    accessKeySecret: "access-secret",
    fetch: async (url, options) => {
      request = { url: new URL(url), options };
      return new Response("<?xml version=\"1.0\"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
        { status: 200, headers: { "content-type": "application/xml" } });
    }
  });
  await adapter.list("unseen-backend/v1/commits/u123/", { marker: "old-key", maxKeys: 91 });
  assert.equal(request.url.pathname, "/");
  assert.equal(request.url.searchParams.get("prefix"), "unseen-backend/v1/commits/u123/");
  assert.equal(request.url.searchParams.get("marker"), "old-key");
  assert.equal(request.url.searchParams.get("max-keys"), "91");
  const date = request.options.headers.Date;
  const stringToSign = `GET\n\n\n${date}\n/examplebucket/`;
  const expected = crypto.createHmac("sha1", "access-secret")
    .update(stringToSign, "utf8").digest("base64");
  assert.equal(request.options.headers.Authorization, `OSS access-id:${expected}`);
});

test("V1 canonicalizes x-oss headers by lowercase name and sorted order", () => {
  assert.equal(canonicalOssHeaders({
    "X-Oss-Metadata-Directive": "  REPLACE  ",
    "x-oss-copy-source": "/bucket/source",
    "Content-Type": "image/jpeg"
  }), "x-oss-copy-source:/bucket/source\nx-oss-metadata-directive:REPLACE\n");
});

test("conditional PUT uses OSS forbid-overwrite without unsupported HTTP If-None-Match", async () => {
  const requests = [];
  const adapter = new OssV1Adapter({
    bucket: "examplebucket",
    endpoint: "oss-cn-hangzhou.aliyuncs.com",
    accessKeyId: "access-id",
    accessKeySecret: "access-secret",
    fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return new Response("", { status: 200, headers: { etag: "abc" } });
    }
  });
  await adapter.put("state.json", Buffer.from("{}\n"), { ifNoneMatch: true });
  const request = requests.find((item) => item.options.method === "PUT");
  assert.ok(request);
  assert.equal(request.options.headers["x-oss-forbid-overwrite"], "true");
  assert.equal(request.options.headers["If-None-Match"], undefined);
});
