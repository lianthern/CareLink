import test from "node:test";
import assert from "node:assert/strict";
import { FixtureViewerAdapter } from "../src/adapters/viewer/index.js";
import { albumPage, managePage, placementEditorPage } from "../src/ui/templates.js";

// Every payload below is a classic stored-XSS probe: it tries to break out of an
// HTML attribute (a bare `"`) and land a live element with an `onerror`/`onload`
// handler. A correctly escaped renderer turns the quote and angle brackets into
// entities, so the payload can never become a real DOM node.
const PAYLOAD = '<img src=x onerror=alert(1)>';
const ATTR_BREAKOUT_PAYLOAD = `space-1"><img src=x onerror=alert(1)>`;

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  globalThis.document = { title: "" };
  globalThis.location = { pathname: "/placements/photo-1/edit", search: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; globalThis.location = priorLocation; }
}

test("FixtureViewerAdapter escapes a malicious photo title before it reaches innerHTML", () => {
  const container = {
    classList: { add() {} },
    style: { setProperty() {} },
    innerHTML: ""
  };
  const adapter = new FixtureViewerAdapter({ panoramaUrl: "/assets/panorama.jpg" });
  // marker.label is sourced from the user-controlled photo title (see
  // fixture-adapter.js `label: photo.title` and app.js's marker projection).
  adapter.mount(container, { markers: [{ photoId: "photo-1", label: PAYLOAD }] });

  assert.doesNotMatch(container.innerHTML, /<img[^>]*onerror/, "raw <img onerror> must not appear in the rendered markup");
  assert.match(container.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/, "photo title must be HTML-entity-escaped");
});

test("FixtureViewerAdapter escapes a malicious photo id used as a data attribute", () => {
  const container = {
    classList: { add() {} },
    style: { setProperty() {} },
    innerHTML: ""
  };
  const adapter = new FixtureViewerAdapter({ panoramaUrl: "/assets/panorama.jpg" });
  const maliciousId = `photo-1" onmouseover="alert(1)`;
  adapter.mount(container, { markers: [{ photoId: maliciousId, label: "ok" }] });

  assert.doesNotMatch(container.innerHTML, /onmouseover="alert\(1\)"/, "attribute breakout via photoId must not succeed");
  assert.match(container.innerHTML, /&quot;/, "photo id quote must be entity-escaped");
});

test("album/scene tab links escape a query-string-controlled currentSpaceId", () => {
  withStubbedDocument(() => {
    const state = {
      account: null,
      capabilities: { view: true, upload: true, manage: true },
      spaces: [{ id: ATTR_BREAKOUT_PAYLOAD, name: "Test Space", dateLabel: "" }],
      currentSpaceId: ATTR_BREAKOUT_PAYLOAD,
      uiProductizationFixture: false,
      debug: false,
      localDeterministicLocator: false
    };
    const viewer = { name: "Test Space", photos: [], effectiveCanUpload: true };
    const html = albumPage(state, viewer);

    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, "currentSpaceId must not break out of the href attribute");
    assert.match(html, /space-1&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/, "currentSpaceId must be entity-escaped inside href");
  });
});

test("manage nav and setup tab links escape a query-string-controlled currentSpaceId", () => {
  withStubbedDocument(() => {
    const state = {
      account: null,
      capabilities: { view: true, upload: true, manage: true },
      spaces: [{ id: ATTR_BREAKOUT_PAYLOAD, name: "Test Space", dateLabel: "" }],
      currentSpaceId: ATTR_BREAKOUT_PAYLOAD,
      uiProductizationFixture: false,
      debug: false,
      localDeterministicLocator: false
    };
    const management = {
      isOwner: true,
      scopes: [],
      space: { name: "Test Space", scene: { artifactReady: false }, collectionState: "paused", sharingState: "stopped" },
      reviewQueue: [],
      placementQueue: []
    };
    const html = managePage(state, management, "overview");

    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, "currentSpaceId must not break out of the manage nav href");
    assert.match(html, /space-1&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/, "currentSpaceId must be entity-escaped inside manage nav href");
  });
});

test("placement editor return-to link escapes a query-string-controlled batch/item id", () => {
  withStubbedDocument(() => {
    const state = { account: null, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false };
    const maliciousReturnTo = `/uploads/x"><img src=x onerror=alert(1)>/items/1`;
    // target with no sceneContext takes the "not editable" branch, which is the
    // simplest path that still renders the returnTo href.
    const html = placementEditorPage(state, { id: "photo-1" }, { returnTo: maliciousReturnTo });

    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, "returnTo must not break out of the href attribute");
    assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/, "returnTo must be entity-escaped inside href");
  });
});
