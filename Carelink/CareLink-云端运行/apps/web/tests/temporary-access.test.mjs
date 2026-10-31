import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { hasTemporaryAccess, TEMPORARY_ACCESS_MODE } from "../src/temporary-access.js";

function response(status, mode) {
  return { status, headers: new Headers(mode === undefined ? {} : { "X-Unseen-Access-Mode": mode }) };
}

test("temporary invitation disclosure accepts the exact same-origin health capability on 200 or 503", async () => {
  for (const status of [200, 503]) {
    const calls = [];
    const enabled = await hasTemporaryAccess(async (...args) => { calls.push(args); return response(status, TEMPORARY_ACCESS_MODE); });
    assert.equal(enabled, true);
    assert.deepEqual(calls, [["/healthz", {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error"
    }]]);
    assert.equal(Object.hasOwn(calls[0][1], "body"), false);
  }
});

test("missing, invalid, or failed health capability stays hidden without throwing", async () => {
  for (const status of [200, 503]) {
    for (const candidate of [undefined, "temporary-basic-auth", "temporary-basic-auth-invite extra",
      "TEMPORARY-BASIC-AUTH-INVITE"]) {
      assert.equal(await hasTemporaryAccess(async () => response(status, candidate)), false);
    }
  }
  assert.equal(await hasTemporaryAccess(async () => response(404, TEMPORARY_ACCESS_MODE)), false);
  assert.equal(await hasTemporaryAccess(async () => { throw new Error("offline"); }), false);
  assert.equal(await hasTemporaryAccess(null), false);
});

test("document copy and favicon are static, credential-free, local brand assets", async () => {
  const [html, favicon] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/brand/favicon.svg", import.meta.url), "utf8")
  ]);
  assert.match(html, /<strong id="temporary-access-title">临时邀请访问<\/strong>/u);
  assert.match(html, /当前通过邀请门浏览；邮件登录、照片上传、AI 问答和纪念册仍在准备，本次临时访问不会接收这些内容。/u);
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/assets\/brand\/favicon\.svg"/u);
  assert.doesNotMatch(html, /Basic |Authorization|password|credential/iu);
  assert.match(favicon, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  assert.doesNotMatch(favicon, /<script|(?:href|src)=["']https?:/iu);
});
