import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { managePage } from "../src/ui/templates.js";

// The invitations tab is the only place campaign rows (and their QR affordance) render, and
// until now no test ever exercised it — these lock the "复制活动链接"/"显示二维码" wiring the
// QR-completion work depends on, and guard the escaping of server-controlled campaign fields.
function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  globalThis.document = { title: "" };
  globalThis.location = { origin: "https://unseen.example", pathname: "/manage/space-1", search: "?tab=invitations" };
  try { return run(); }
  finally { globalThis.document = priorDocument; globalThis.location = priorLocation; }
}

const baseState = {
  account: null,
  capabilities: { view: true, upload: true, manage: true },
  spaces: [{ id: "space-1", name: "向晚婚礼", dateLabel: "" }],
  currentSpaceId: "space-1",
  uiProductizationFixture: false,
  debug: false,
  localDeterministicLocator: false
};

const managementBase = {
  isOwner: true,
  scopes: ["canInvite"],
  space: { name: "向晚婚礼", scene: { artifactReady: false }, collectionState: "open", sharingState: "shared", ifMatch: '"space:3"' },
  reviewQueue: [],
  placementQueue: []
};

test("invitations tab renders a copy-link and a show-QR control per campaign, each pointing at the /open/ locator", () => {
  withStubbedDocument(() => {
    const management = { ...managementBase, campaigns: [{
      id: "campaign-1", campaignStatus: "active", successfulUseCount: 3, maxSuccessfulUses: 100,
      taskMode: "combo", publicCampaignUrl: "/open/gongguang-2026", qrPayload: "/open/gongguang-2026"
    }] };
    const html = managePage(baseState, management, "invitations");
    assert.match(html, /data-open-campaign/, "创建活动邀请 entry point must still be present");
    assert.match(html, /data-copy-campaign\s+data-url="\/open\/gongguang-2026"/);
    assert.match(html, /data-show-qr\s+data-url="\/open\/gongguang-2026"/);
    assert.match(html, /https:\/\/unseen\.example\/open\/gongguang-2026/, "row shows the full same-origin link, not just the path");
    assert.doesNotMatch(html, /data-copy-member/, "campaign row must not reuse the one-time member-invitation copy control");
  });
});

test("invitations tab renders one row per campaign and escapes a hostile publicCampaignUrl/qrPayload", () => {
  withStubbedDocument(() => {
    const hostile = `/open/tok"><img src=x onerror=alert(1)>`;
    const management = { ...managementBase, campaigns: [
      { id: "campaign-1", campaignStatus: "active", successfulUseCount: 1, maxSuccessfulUses: 10, taskMode: "view", publicCampaignUrl: "/open/a", qrPayload: "/open/a" },
      { id: "campaign-2", campaignStatus: "revoked", successfulUseCount: 5, maxSuccessfulUses: 5, taskMode: "upload", publicCampaignUrl: hostile, qrPayload: hostile }
    ] };
    const html = managePage(baseState, management, "invitations");
    assert.equal((html.match(/class="card campaign-card/g) || []).length, 2);
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
    assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
    // Revoked campaigns keep their copy/QR controls but lose the revoke button.
    assert.match(html, /已撤销/);
  });
});

test("app.js opens the campaign QR dialog automatically right after a successful create, offering a copy-link control inside it", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // Locks the "show it once, not after another click" behavior: the create-confirmation
  // branch must call openQrDialog with the freshly minted campaign's own link.
  assert.match(source, /actionId === "EXTERNAL_INVITATION\.CREATE"[\s\S]{0,200}openQrDialog\(campaignPath\)/);
  // The QR dialog body itself must offer a same-origin, secret-free copy control next to the canvas.
  assert.match(source, /data-qr-canvas[\s\S]{0,200}data-copy-campaign\s+data-url="\$\{esc\(url\.pathname\)\}"/);
});
