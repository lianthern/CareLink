import test from "node:test";
import assert from "node:assert/strict";
import { openCampaignPage } from "../src/ui/templates.js";

// F1 regression: openCampaignPage() used to hardcode a demo wedding name ("向晚婚礼") for every
// /open/{token} admission page regardless of which space actually shared the link. It now takes
// the real display name (fetched from GET /v1/external-invitation-campaigns/{token}/preview in
// app.js — see the route() handler for "/open/") and falls back to neutral copy whenever that
// fetch fails or the endpoint has nothing to say, so the page can never again show one hardcoded
// space name for every invite.

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; }
}

const baseState = { account: null, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false, uiProductizationFixture: false };

test("renders the real display name when the preview lookup succeeds", () => {
  withStubbedDocument(() => {
    const html = openCampaignPage(baseState, "0iM0Lj48vhMz5gAPm4h-a9pV7BANC41TiZJH1aNUyWI", "AdventureX 2026 现场");
    // v4.1「暖釉」wraps the h1 text in the shared .text-grad heading treatment
    // (see homePage/openCampaignPage in ui/templates.js) — the display name
    // itself is unchanged, just no longer a bare text node.
    assert.match(html, /<p class="eyebrow">UNSEEN 分享给你的空间<\/p>/);
    assert.match(html, /<h1><span class="text-grad">AdventureX 2026 现场<\/span><\/h1>/);
    assert.match(html, /<img src="\/assets\/brand\/adventurex-cover\.jpg"[^>]+>/);
    assert.doesNotMatch(html, /向晚婚礼/, "must never show the old hardcoded demo name");
    assert.match(document.title, /^AdventureX 2026 现场 · UNSEEN$/);
  });
});

test("falls back to neutral copy when no display name is available (preview failed, rate-limited, or offline)", () => {
  withStubbedDocument(() => {
    const html = openCampaignPage(baseState, "campaign-unknown");
    assert.match(html, /<h1><span class="text-grad">UNSEEN 分享给你的空间<\/span><\/h1>/);
    assert.doesNotMatch(html, /向晚婚礼/, "must never fall back to a hardcoded specific space/event name");
    // The eyebrow line would just repeat the fallback heading; it must not be duplicated.
    assert.equal((html.match(/UNSEEN 分享给你的空间/g) || []).length, 1);
  });
});

test("never hardcodes any specific space name regardless of which token or name is passed", () => {
  withStubbedDocument(() => {
    for (const [token, name] of [["a", "生日派对"], ["b", "AdventureX 2026"], ["c", ""]]) {
      const html = openCampaignPage(baseState, token, name);
      assert.doesNotMatch(html, /向晚婚礼/);
      assert.doesNotMatch(html, /wedding-light\.webp" alt="向晚婚礼/);
    }
  });
});

test("display name and campaign id are HTML-escaped (no injection surface from the preview response or the URL token)", () => {
  withStubbedDocument(() => {
    const payload = '<img src=x onerror=alert(1)>';
    const html = openCampaignPage(baseState, `token"><script>${payload}</script>`, payload);
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

test("unknown invitations do not borrow an unrelated preview image", () => {
  withStubbedDocument(() => {
    const html = openCampaignPage(baseState, "campaign-1", "任意空间");
    assert.doesNotMatch(html, /alt="向晚婚礼现场"/);
    assert.doesNotMatch(html, /<img src="\/assets\/brand\//);
  });
});
