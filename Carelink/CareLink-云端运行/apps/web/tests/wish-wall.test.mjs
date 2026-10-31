import test from "node:test";
import assert from "node:assert/strict";
import { managePage, uploadPage, wishWallCopy } from "../src/ui/templates.js";

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; }
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
  scopes: [],
  space: { name: "向晚婚礼", scene: { artifactReady: false }, collectionState: "paused", sharingState: "stopped", ifMatch: '"space:3"' },
  reviewQueue: [],
  placementQueue: []
};

test("upload page renders the host wish card when the space has wishes", () => {
  withStubbedDocument(() => {
    const state = { ...baseState, uploadContext: { wishes: ["新娘母亲落泪的瞬间", "全场大合影"] } };
    const html = uploadPage(state, null, true);
    assert.match(html, new RegExp(wishWallCopy.upload.eyebrow));
    assert.match(html, /<li>新娘母亲落泪的瞬间<\/li>/);
    assert.match(html, /<li>全场大合影<\/li>/);
  });
});

test("upload page omits the wish card entirely when there are no wishes", () => {
  withStubbedDocument(() => {
    const noContext = uploadPage({ ...baseState, uploadContext: {} }, null, true);
    assert.doesNotMatch(noContext, new RegExp(wishWallCopy.upload.eyebrow));
    assert.doesNotMatch(noContext, /aria-label="主办方心愿"/);

    const emptyArray = uploadPage({ ...baseState, uploadContext: { wishes: [] } }, null, true);
    assert.doesNotMatch(emptyArray, /aria-label="主办方心愿"/);

    const blankOnly = uploadPage({ ...baseState, uploadContext: { wishes: ["   ", ""] } }, null, true);
    assert.doesNotMatch(blankOnly, /aria-label="主办方心愿"/);
  });
});

test("upload page wish card HTML-escapes a malicious wish before it reaches innerHTML", () => {
  withStubbedDocument(() => {
    const payload = "<img src=x onerror=alert(1)>";
    const html = uploadPage({ ...baseState, uploadContext: { wishes: [payload] } }, null, true);
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, "raw payload must never reach innerHTML");
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, "wish text must be HTML-entity-escaped");
  });
});

test("manage setup tab renders the wish editor with exactly 6 slots, prefilled and escaped", () => {
  withStubbedDocument(() => {
    const management = { ...managementBase, wishes: ["新娘母亲落泪的瞬间"] };
    const html = managePage(baseState, management, "setup");
    assert.match(html, new RegExp(wishWallCopy.manage.title));
    // exactly 6 wish input slots, named wish-0..wish-5
    for (let index = 0; index < 6; index += 1) {
      assert.match(html, new RegExp(`name="wish-${index}"`), `expected input for wish-${index}`);
    }
    assert.doesNotMatch(html, /name="wish-6"/);
    assert.match(html, /value="新娘母亲落泪的瞬间"/);
    // the remaining 5 slots stay blank
    assert.match(html, /value=""/);
    assert.match(html, new RegExp(wishWallCopy.manage.hint));
    assert.doesNotMatch(html, new RegExp(wishWallCopy.manage.emptyHint));
  });
});

test("manage setup tab shows the empty-state hint and blank inputs when there are no wishes yet", () => {
  withStubbedDocument(() => {
    const management = { ...managementBase, wishes: [] };
    const html = managePage(baseState, management, "setup");
    assert.match(html, new RegExp(wishWallCopy.manage.emptyHint));
    for (let index = 0; index < 6; index += 1) assert.match(html, new RegExp(`name="wish-${index}" type="text"[^>]*value=""`));
  });
});

test("manage setup tab escapes a malicious existing wish inside the input value attribute", () => {
  withStubbedDocument(() => {
    const payload = `x"><img src=x onerror=alert(1)>`;
    const management = { ...managementBase, wishes: [payload] };
    const html = managePage(baseState, management, "setup");
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, "malicious wish must not break out of the value attribute");
    assert.match(html, /value="x&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/, "wish text must be entity-escaped inside the input value");
  });
});

test("manage setup tab wish editor form carries the space id and current If-Match for the save request", () => {
  withStubbedDocument(() => {
    const management = { ...managementBase, wishes: [] };
    const html = managePage(baseState, management, "setup");
    assert.match(html, /data-wish-form/);
    assert.match(html, /data-space-id="space-1"/);
    assert.match(html, /data-if-match="&quot;space:3&quot;"/);
  });
});

// F4: the tab bar (总览/审核/位置/现场/邀请/成员/设置 — see managePage()) has no
// "setup" entry, so a space past initial setup left the wish editor permanently
// unreachable even though setupTab() rendered it. Fixed by also rendering it in the
// settings tab, which is reachable at every point in the space's lifetime.
test("manage settings tab also renders the wish editor with exactly 6 slots, prefilled and escaped", () => {
  withStubbedDocument(() => {
    const management = { ...managementBase, wishes: ["新娘母亲落泪的瞬间"], publicListing: null };
    const html = managePage(baseState, management, "settings");
    assert.match(html, new RegExp(wishWallCopy.manage.title));
    for (let index = 0; index < 6; index += 1) {
      assert.match(html, new RegExp(`name="wish-${index}"`), `expected input for wish-${index}`);
    }
    assert.doesNotMatch(html, /name="wish-6"/);
    assert.match(html, /value="新娘母亲落泪的瞬间"/);
    assert.match(html, new RegExp(wishWallCopy.manage.hint));
    assert.doesNotMatch(html, new RegExp(wishWallCopy.manage.emptyHint));
    assert.match(html, /data-wish-form/);
    assert.match(html, /data-space-id="space-1"/);
    assert.match(html, /data-if-match="&quot;space:3&quot;"/);
  });
});

test("manage settings tab shows the empty-state hint and blank inputs when there are no wishes yet", () => {
  withStubbedDocument(() => {
    const management = { ...managementBase, wishes: [], publicListing: null };
    const html = managePage(baseState, management, "settings");
    assert.match(html, new RegExp(wishWallCopy.manage.emptyHint));
    for (let index = 0; index < 6; index += 1) assert.match(html, new RegExp(`name="wish-${index}" type="text"[^>]*value=""`));
  });
});

test("manage settings tab places the wish editor after 收集与分享 and before 空间处置", () => {
  withStubbedDocument(() => {
    const management = { ...managementBase, wishes: ["全场大合影"], publicListing: null };
    const html = managePage(baseState, management, "settings");
    const collectionIndex = html.indexOf("收集与分享");
    const wishIndex = html.indexOf(wishWallCopy.manage.title);
    const dangerZoneIndex = html.indexOf("空间处置");
    assert.ok(collectionIndex >= 0 && wishIndex >= 0 && dangerZoneIndex >= 0, "all three sections must render");
    assert.ok(collectionIndex < wishIndex, "wish editor must come after 收集与分享");
    assert.ok(wishIndex < dangerZoneIndex, "wish editor must come before 空间处置");
  });
});

test("manage settings tab wish editor escapes a malicious existing wish inside the input value attribute", () => {
  withStubbedDocument(() => {
    const payload = `x"><img src=x onerror=alert(1)>`;
    const management = { ...managementBase, wishes: [payload], publicListing: null };
    const html = managePage(baseState, management, "settings");
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, "malicious wish must not break out of the value attribute");
    assert.match(html, /value="x&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/, "wish text must be entity-escaped inside the input value");
  });
});
