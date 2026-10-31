import test from "node:test";
import assert from "node:assert/strict";
import { discoverPage, homePage, homeV3Copy, startUploadPage } from "../src/ui/templates.js";
import { featuredSpaces } from "../src/config/featured-spaces.js";

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; }
}

const loggedOutState = { account: null, capabilities: {}, spaces: [], currentSpaceId: "", debug: false };
// Includes one active space so the "继续：我的空间" progress card (block 2) has
// something to render — a logged-in account with zero spaces renders no
// continue card at all (nothing to continue into), which isn't what this
// fixture is meant to exercise.
const loggedInState = { account: { id: "account-max", name: "Max" }, capabilities: {}, currentSpaceId: "space-1", debug: false,
  spaces: [{ id: "space-1", name: "向晚婚礼", spaceLifecycle: "active", photoCount: 6, pendingPlacementCount: 1 }] };
const loggedInWithPersonalSpaceState = { account: { id: "account-max", name: "Max", personalSpaceId: "space-personal-1" }, capabilities: {}, spaces: [], currentSpaceId: "", debug: false };

test("home v3 renders three nav cards and the /open shortcut for a logged-out visitor", () => {
  withStubbedDocument(() => {
    const html = homePage(loggedOutState);
    // The three cards.
    assert.match(html, /逛逛空间/);
    assert.match(html, /看看大家的共同空间/);
    assert.match(html, /创建我的空间/);
    assert.match(html, /为一场婚礼、一次聚会开一个空间/);
    assert.match(html, /传照片/);
    assert.match(html, /有邀请就进来传，或传到自己的空间/);
    assert.match(html, /href="\/discover"/);
    assert.match(html, /href="\/start-upload"/);
    // Every nav card ends in a chevron-right affordance (B1: icon-tile + title + subtitle + chevron).
    assert.equal((html.match(/nav-card-chevron/g) || []).length, 3);
    // Logged out: creating a space routes through login with a returnTo back to /spaces/new.
    assert.match(html, /href="\/login\?returnTo=%2Fspaces%2Fnew"/);
    // No account yet, so there is no "继续：我的空间" progress card.
    assert.doesNotMatch(html, /继续：我的空间/);
    assert.doesNotMatch(html, /continue-card/);
    // The quiet link to the existing invite-link flow is still present, now with a leading icon.
    assert.match(html, /<a class="text-link" href="\/open" data-nav><svg[\s\S]*?<\/svg>已有邀请链接或二维码？直接打开<\/a>/);
  });
});

test("home v3 sends a logged-in visitor straight to /spaces/new and shows the continue-card progress ring", () => {
  withStubbedDocument(() => {
    const html = homePage(loggedInState);
    assert.match(html, /href="\/spaces\/new"/);
    assert.doesNotMatch(html, /returnTo/);
    // The continue card (progressRing + space name + status line) links straight into
    // that space's album. Through block 7 this card carried the page's one allowed
    // halo-spot (contract §2); v4.1「暖釉」moved that single light effect up to the
    // page-level .bokeh-layer (see homePage), so the legacy halo-spot markup should
    // be fully gone from continue-card and there should still be exactly one
    // light-effect layer on the page overall — same invariant, new implementation.
    assert.match(html, /<a class="card interactive-card continue-card" href="\/s\/space-1\/album" data-nav>/);
    assert.equal((html.match(/halo-spot/g) || []).length, 0, "legacy halo-spot retired from continue-card in v4.1");
    assert.equal((html.match(/bokeh-layer/g) || []).length, 1, "at most one light-effect layer on the page (v4.1 bokeh-layer)");
    assert.match(html, /继续：我的空间/);
    assert.match(html, /<strong>向晚婚礼<\/strong>/);
    // photoCount 6, pendingPlacementCount 1 → 5/6 returned, 1 still awaiting placement.
    assert.match(html, /已回到现场 5\/6 · 还有 1 张待定位/);
    assert.match(html, /aria-label="已回到现场 5\/6 张照片"/);
  });
});

test("discover page renders the configured featured space as a cover card", () => {
  withStubbedDocument(() => {
    const html = discoverPage(loggedOutState);
    assert.equal(featuredSpaces.length, 1, "sanity check: v0 config still has exactly one entry");
    const [space] = featuredSpaces;
    assert.match(html, new RegExp(`href="${space.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.equal(space.title, "夏日聚会");
    assert.match(html, /夏日聚会/);
    assert.match(html, /AI 生成的夏日聚会：花园全景 \+ 6 张朋友随手拍，照片已回到现场/);
    assert.match(html, new RegExp(`<img src="${space.cover.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" alt="夏日聚会封面"[^>]+>`));
    assert.doesNotMatch(html, /模板空间/);
    // The footnote is now an icon+text empty-note component, not a lone <p class="fine">.
    assert.match(html, /<div class="empty-note"><span class="icon-tile empty-note-icon" aria-hidden="true">[\s\S]*?更多公开空间即将开放。<\/p><\/div>/);
  });
});

test("discover page escapes a malicious title and drops an entry with a disallowed url", () => {
  withStubbedDocument(() => {
    const maliciousSpaces = [
      { title: '<img src=x onerror=alert(1)>', description: "ok", url: "https://unseen.maxxam.xyz/open/safe-one" },
      { title: "跨站演示空间", description: "should not render", url: "https://evil.example.com/open/steal" },
      { title: "javascript 协议", description: "should not render", url: "javascript:alert(1)" },
      { title: "相对路径也允许", description: "same-origin relative path", url: "/open/relative-one" }
    ];
    const html = discoverPage(loggedOutState, maliciousSpaces);
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, "raw <img onerror> must never reach innerHTML");
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, "malicious title must be HTML-entity-escaped");
    assert.doesNotMatch(html, /evil\.example\.com/, "cross-origin url must be dropped entirely");
    assert.doesNotMatch(html, /javascript:alert/, "javascript: url must be dropped entirely");
    assert.match(html, /href="\/open\/relative-one"/, "same-origin relative path is allowed through");
    assert.match(html, /href="https:\/\/unseen\.maxxam\.xyz\/open\/safe-one"/);
  });
});

test("discover page does not tag a real, ops-approved live space (e.g. an actual event space) as 「模板空间」", () => {
  withStubbedDocument(() => {
    const liveSpaces = [
      { title: "AdventureX 2026 现场", description: "真实活动空间，不是模板", url: "https://unseen.maxxam.xyz/open/adventurex-2026" }
    ];
    const html = discoverPage(loggedOutState, liveSpaces);
    assert.match(html, /AdventureX 2026 现场/);
    assert.doesNotMatch(html, /模板空间/, "a live, backend-curated listing must not be tagged as a template — there is no data backing that claim");
  });
});

test("discover page does not label the static fallback as a template", () => {
  withStubbedDocument(() => {
    const html = discoverPage(loggedOutState, []);
    assert.doesNotMatch(html, /模板空间/);
  });
});

test("start-upload page offers the invite flow and the my-space flow, login-aware", () => {
  withStubbedDocument(() => {
    // Logged out: the my-space card routes through login with a returnTo back
    // to /start-upload itself, so the visitor lands back here to continue.
    const loggedOutHtml = startUploadPage(loggedOutState);
    assert.match(loggedOutHtml, /我有邀请/);
    assert.match(loggedOutHtml, /打开朋友发来的邀请链接或二维码/);
    assert.match(loggedOutHtml, /href="\/open"/);
    assert.match(loggedOutHtml, /传到我的空间/);
    assert.match(loggedOutHtml, /登录后在自己的空间里上传/);
    assert.match(loggedOutHtml, /href="\/login\?returnTo=%2Fstart-upload"/);

    // Logged in but no personal space yet (state.account.personalSpaceId is
    // unset): the card is a button that lazily provisions the space on click
    // (see app.js openPersonalSpace()), not a plain link.
    const loggedInHtml = startUploadPage(loggedInState);
    assert.match(loggedInHtml, /<button[^>]*data-open-personal-space[^>]*>/);
    assert.doesNotMatch(loggedInHtml, /returnTo/);

    // Logged in with a known personalSpaceId: direct link to its upload page,
    // no intermediate click/round-trip needed.
    const loggedInWithSpaceHtml = startUploadPage(loggedInWithPersonalSpaceState);
    assert.match(loggedInWithSpaceHtml, /href="\/s\/space-personal-1\/upload"/);
    assert.doesNotMatch(loggedInWithSpaceHtml, /data-open-personal-space/);
    assert.doesNotMatch(loggedInWithSpaceHtml, /returnTo/);
  });
});

test("homeV3Copy centralizes the new v3 copy in one exported object", () => {
  assert.equal(homeV3Copy.home.discoverCard.title, "逛逛空间");
  assert.equal(homeV3Copy.home.createSpaceCard.title, "创建我的空间");
  assert.equal(homeV3Copy.home.uploadCard.title, "传照片");
  assert.equal(homeV3Copy.discover.title, "逛逛空间");
  assert.equal(homeV3Copy.startUpload.title, "传照片");
});
