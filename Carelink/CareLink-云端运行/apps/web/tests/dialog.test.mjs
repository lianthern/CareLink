import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { exactManagementSpaceIfMatch } from "../src/action-runtime.js";
import { HttpApiAdapter } from "../src/api/http-adapter.js";

test("dialog portal is the single stable sibling of the inert app", async () => {
  const [index, templates] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/ui/templates.js", import.meta.url), "utf8")
  ]);

  assert.equal(index.match(/data-dialog-root/g)?.length, 1);
  assert.match(index, /<div id="app"><\/div>\s*<div data-dialog-root><\/div>/);
  assert.doesNotMatch(templates, /data-dialog-root/);
});

test("activity invitation CAS comes only from the exact current management read model", async () => {
  const requests = [];
  const adapter = new HttpApiAdapter({ transport: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ id: "campaign-new" }), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  adapter.selectSpace("space-gongguang");
  const action = (ifMatch) => adapter.act("EXTERNAL_INVITATION.CREATE", { taskMode: "combo", entryTask: "view", expiresAt: "2026-09-13", maxSuccessfulUses: 100, ifMatch });
  const exact = { space: { id: "space-gongguang", ifMatch: '"space-v7"' } };

  for (const binding of [
    exactManagementSpaceIfMatch(exact, "/manage/space-old", "space-gongguang"),
    exactManagementSpaceIfMatch({}, "/manage/space-gongguang", "space-gongguang"),
    exactManagementSpaceIfMatch({ space: { id: "space-other", ifMatch: '"space-v9"' } }, "/manage/space-gongguang", "space-gongguang")
  ]) await assert.rejects(action(binding), (error) => error.code === "request_if_match_missing");
  assert.equal(requests.length, 0, "stale, missing or wrong-space CAS reached fetch");

  await action(exactManagementSpaceIfMatch(exact, "/manage/space-gongguang", "space-gongguang"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/v1/spaces/space-gongguang/external-invitation-campaigns");
  assert.equal(requests[0].options.headers["If-Match"], '"space-v7"');
});
