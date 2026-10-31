import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { actionDefinitions } from "../src/action-runtime.js";
import { readApi } from "../src/api/http-adapter.js";
import { actionRegistry, strings, tokens } from "../src/generated/contracts.js";

test("all frozen actions expose all nine product phases", () => {
  assert.equal(Object.keys(actionDefinitions).length, 90);
  assert.deepEqual(actionRegistry.phases, ["initial", "loading", "success", "stable_error", "retry", "session_or_permission_loss", "empty", "destructive_confirm", "return"]);
  for (const action of actionRegistry.actions) {
    const definition = actionDefinitions[action.id];
    assert.ok(definition, action.id);
    assert.deepEqual(Object.keys(definition.phases), actionRegistry.phases, action.id);
    for (const phase of actionRegistry.phases) assert.ok(Object.hasOwn(strings.actions[action.id], phase), `${action.id}.${phase}`);
    assert.ok(definition.api, `${action.id} has API/navigation/static boundary`);
  }
});

test("layout has exactly one product breakpoint and frozen 1280→1440 width", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const widthQueries = [...css.matchAll(/@media \((?:min|max)-width:\s*(\d+)px\)/g)].map((match) => Number(match[1]));
  assert.deepEqual(widthQueries, [1248, 1247]);
  assert.match(css, /width:\s*min\(1184px,\s*calc\(100% - 64px\)\)/);
  assert.equal(tokens.layout.desktop.contentWidth, 1184);
  const rules = css.slice(css.indexOf("}\n") + 2);
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}|rgba?\(/i, "component rules must reference frozen token variables");
});

test("customer templates contain none of the retired engineering IA", async () => {
  const templates = await readFile(new URL("../src/ui/templates.js", import.meta.url), "utf8");
  assert.doesNotMatch(templates, /演示中心|\bLab\b|多图生成全景|模型名|WebGL|\bDAP\b/);
  assert.doesNotMatch(templates, /选择角色|我是主人|我是贡献者/);
});

test("activity QR copy is locator-only while member and receipt remain separate", () => {
  const copy = actionDefinitions["INVITATION.COPY_LINK"];
  assert.equal(copy.callerContracts.activity.urlTemplate, "/open/{publicCampaignId}");
  assert.equal(copy.callerContracts.member.urlTemplate, "/member-invitations/accept#invite=:secret");
  assert.equal(actionDefinitions["INVITATION.SHOW_QR"].encodes, "same-origin-/open/{publicCampaignId}-only");
  assert.equal(actionDefinitions["BATCH_RECEIPT.EXCHANGE"].route, "/uploads/open#receipt=:secret");
});

test("canonical read client uses named API boundaries, never UI route strings", () => {
  assert.equal(readApi.state, "/v1/me");
  assert.equal(readApi.viewerSpace, "/v1/viewer/spaces/{sid}");
  assert.equal(readApi.managementView, "/v1/spaces/{sid}/management");
  assert.equal(readApi.batchReceipt, "/v1/batch-receipt");
  assert.equal(readApi.batchItemPlacementEdit, "/v1/batch-receipt/items/{iid}/placement-edit");
  for (const endpoint of Object.values(readApi)) assert.match(endpoint, /^\/v1\//);
});
