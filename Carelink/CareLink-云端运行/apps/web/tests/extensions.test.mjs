import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createWebExtensionHost, loadWebExtensionHost } from "../src/extensions/index.js";
import { registerBookLabWebExtension } from "../src/extensions/book-lab.js";
import { homePage } from "../src/ui/templates.js";

test("Book Web loader is inert with the default flag and imports no business bundle", async () => {
  const apiClient = { read() { throw new Error("flag-off API call"); } };
  const host = createWebExtensionHost({ apiClient, featureFlags: { bookLab: false } });
  await host.load();
  assert.equal(await host.route("/v2-labs/books", {}), null);
  assert.equal(await host.route("/labs/memories/photos/photo-1", {}), null);
  assert.equal(await host.route("/manage/space-1/book-lab", {}), null);
  assert.equal(host.renderSecondarySlot("photoDetail.afterPlacementSecondary", {}), "");
  assert.equal(host.renderSecondarySlot("manageOverview.secondary", {}), "");
  // The host only ever imports ./book-lab.js after confirming the flag — verified structurally (source
  // order) below — so this suite never has to fetch/execute that module's real logic while off.
  const source = await readFile(new URL("../src/extensions/index.js", import.meta.url), "utf8");
  assert.ok(source.indexOf("featureFlags.bookLab !== true") < source.indexOf('import("./book-lab.js")'));
});

// P0-1 regression (whole-site white screen): app.js's own module body is one top-level `await` chain (see
// index.html's sole `<script type="module">`), so a rejection from extensions.load() previously aborted that
// chain before routing/render()/event listeners ever ran — a 404 on the optional book-lab.js bundle, or a
// throw inside its own register function, took down the entire SPA with nothing in the console to explain why.
// loadWebExtensionHost() is the wrapper app.js now calls instead of `host.load()` directly; these tests pin
// its "never rethrow, always report" contract so that guard can't quietly regress back to a bare await.
test("loadWebExtensionHost degrades gracefully and reports a diagnostic when the extension module fails to load (404-like import failure)", async () => {
  const errors = [];
  const brokenHost = { async load() { throw new Error("module_not_found: ./book-lab.js"); } };
  const ok = await loadWebExtensionHost(brokenHost, { onError: (error) => errors.push(error) });
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /module_not_found/);
});

test("loadWebExtensionHost degrades gracefully when the extension's own register function throws", async () => {
  const errors = [];
  const brokenHost = { async load() { throw new Error("book_lab_web_extension_invalid"); } };
  const ok = await loadWebExtensionHost(brokenHost, { onError: (error) => errors.push(error) });
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
});

test("loadWebExtensionHost reports through console.error by default so a failure is never silent", async () => {
  const priorConsoleError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    const brokenHost = { async load() { throw new Error("book_lab_web_extension_invalid"); } };
    const ok = await loadWebExtensionHost(brokenHost);
    assert.equal(ok, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].join(" "), /extension host failed to load/);
  } finally {
    console.error = priorConsoleError;
  }
});

test("loadWebExtensionHost returns true and calls no error handler when the real host loads normally (flag off)", async () => {
  const errors = [];
  const apiClient = { read() { throw new Error("flag-off API call"); } };
  const host = createWebExtensionHost({ apiClient, featureFlags: { bookLab: false } });
  const ok = await loadWebExtensionHost(host, { onError: (error) => errors.push(error) });
  assert.equal(ok, true);
  assert.equal(errors.length, 0);
});

test("app.js boots the extension host through the degrade-not-crash wrapper, not a bare unguarded await", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(source, /loadWebExtensionHost\(extensions\)/);
  assert.doesNotMatch(source, /await extensions\.load\(\)/);
});

test("registerBookLabWebExtension is a no-op when featureFlags.bookLab is not true (defense in depth)", async () => {
  let registerRouteCalled = false;
  let registerSlotCalled = false;
  await registerBookLabWebExtension({
    registerRoute: () => { registerRouteCalled = true; },
    registerSecondarySlot: () => { registerSlotCalled = true; },
    featureFlags: { bookLab: false }
  });
  await registerBookLabWebExtension({
    registerRoute: () => { registerRouteCalled = true; },
    registerSecondarySlot: () => { registerSlotCalled = true; },
    featureFlags: {}
  });
  assert.equal(registerRouteCalled, false);
  assert.equal(registerSlotCalled, false);
});

test("registerBookLabWebExtension registers the BL01-BL06 route matcher and both secondary slots when the flag is on", async () => {
  const routes = [];
  const slots = {};
  await registerBookLabWebExtension({
    registerRoute: (matcher, render) => routes.push({ matcher, render }),
    registerSecondarySlot: (name, render) => { slots[name] = render; },
    featureFlags: { bookLab: true }
  });
  assert.equal(routes.length, 1);
  assert.equal(typeof routes[0].matcher, "function");
  const matches = [
    "/labs/memories/photos/photo-1",
    "/labs/memories/memory-1",
    "/labs/books/book-1/contributions/memory-1",
    "/manage/space-1/book-lab",
    "/manage/space-1/book-lab/book-1/draft",
    "/s/space-1/books/book-1/versions/version-1"
  ];
  for (const path of matches) assert.equal(routes[0].matcher(path), true, `expected ${path} to match`);
  for (const path of ["/", "/spaces", "/manage/space-1", "/s/space-1/album", "/book-preview"]) {
    assert.equal(routes[0].matcher(path), false, `expected ${path} not to match`);
  }
  assert.equal(typeof slots["photoDetail.afterPlacementSecondary"], "function");
  assert.equal(typeof slots["manageOverview.secondary"], "function");
});

test("Book Lab secondary slots render nothing without the identifiers they need, and an escaped entry link with them", async () => {
  const slots = {};
  await registerBookLabWebExtension({
    registerRoute: () => {},
    registerSecondarySlot: (name, render) => { slots[name] = render; },
    featureFlags: { bookLab: true }
  });
  assert.equal(slots["photoDetail.afterPlacementSecondary"]({ photo: null }), "");
  assert.equal(slots["photoDetail.afterPlacementSecondary"]({}), "");
  const photoHtml = slots["photoDetail.afterPlacementSecondary"]({ photo: { id: 'p1"><script>alert(1)</script>' } });
  assert.doesNotMatch(photoHtml, /<script>alert\(1\)<\/script>/);
  assert.match(photoHtml, /聊聊这张/);
  // Informed-consent regression (security audit P1-4): the teaser must disclose, before the user ever
  // navigates to the trigger page, that the photo goes to a third-party AI service — not just that "AI"
  // (ambiguously, possibly UNSEEN's own) is involved.
  assert.match(photoHtml, /第三方/);
  assert.match(photoHtml, /href="\/labs\/memories\/photos\/p1&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;" data-nav/);

  assert.equal(slots["manageOverview.secondary"]({ state: { currentSpaceId: "" } }), "");
  assert.equal(slots["manageOverview.secondary"]({}), "");
  const manageHtml = slots["manageOverview.secondary"]({ state: { currentSpaceId: 'space-1"><script>alert(1)</script>' } });
  assert.doesNotMatch(manageHtml, /<script>alert\(1\)<\/script>/);
  assert.match(manageHtml, /查看纪念册/);
  assert.match(manageHtml, /href="\/manage\/space-1&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;\/book-lab" data-nav/);
});

test("Book Lab route render returns an accessible loading shell synchronously and does not throw while the mount point never appears", async () => {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  const priorMutationObserver = globalThis.MutationObserver;
  class InertMutationObserver {
    observe() {}
    disconnect() {}
  }
  globalThis.MutationObserver = InertMutationObserver;
  globalThis.location = { pathname: "/manage/space-1/book-lab", search: "" };
  globalThis.document = { title: "", body: {}, getElementById: () => null, head: { append() {} }, querySelector: () => null };
  try {
    const routes = [];
    await registerBookLabWebExtension({
      registerRoute: (matcher, render) => routes.push({ matcher, render }),
      registerSecondarySlot: () => {},
      featureFlags: { bookLab: true }
    });
    const state = { account: null, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false };
    const html = routes[0].render({ state });
    assert.match(html, /<span class="status-pill">实验<\/span>/);
    assert.match(html, /id="book-lab-mount-\d+"/);
    assert.match(html, /正在打开纪念册实验/);
  } finally {
    globalThis.document = priorDocument;
    globalThis.location = priorLocation;
    globalThis.MutationObserver = priorMutationObserver;
  }
});

test("local deterministic locator disclosure is flag-bound and does not use fixture chrome", () => {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try {
    const base = { account: null, capabilities: {}, spaces: [], currentSpaceId: "", debug: false };
    const ordinary = homePage({ ...base, localDeterministicLocator: false });
    assert.doesNotMatch(ordinary, /确定性本地定位样本|非真实定位质量|local-locator-banner/);
    const local = homePage({ ...base, localDeterministicLocator: true });
    assert.match(local, /确定性本地定位样本/);
    assert.match(local, /非真实定位质量/);
    assert.doesNotMatch(local, /本地验收模式|fixture-banner/);
  } finally {
    globalThis.document = priorDocument;
  }
});

test("customer app pre-provisions only the two frozen secondary slots", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(source, /photoDetail\.afterPlacementSecondary/);
  assert.match(source, /manageOverview\.secondary/);
  assert.doesNotMatch(source, /BL0[1-6]|\/v2-labs\//);
});
