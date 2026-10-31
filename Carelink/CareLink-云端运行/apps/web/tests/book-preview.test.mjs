import test from "node:test";
import assert from "node:assert/strict";
import { albumPage, bookPreviewCopy, bookPreviewExperimentCopy, bookPreviewPage } from "../src/ui/templates.js";

// Track J: honest "coming soon" teaser for Book Lab (纪念册). The real backend
// stays behind UNSEEN_BOOK_LAB_ENABLED=false — this page is a static preview
// only, so it must never simulate a working feature (no fake CTA, no email
// capture, no countdown) and must never regress the "one primary CTA per
// page" rule on the album page it's linked from.

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; }
}

const baseState = { account: null, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false, uiProductizationFixture: false };

test("book preview page always exposes the local quick-book mode without pretending story-book is live", () => {
  withStubbedDocument(() => {
    const html = bookPreviewPage(baseState);
    assert.match(html, /让照片成为一本小书/);
    assert.match(html, /快速成册/);
    assert.match(html, /三套页面节奏/);
    assert.match(html, /故事成书正在打磨/);
    assert.match(html, /<a class="button button-primary" href="\/zine" data-nav>开始快速排版<\/a>/);
    assert.equal((html.match(/button-primary/g) || []).length, 1);
    assert.doesNotMatch(html, /<input/, "must not collect an email or any other input");
    assert.doesNotMatch(html, /倒计时|data-countdown/, "must not show a countdown");
    assert.doesNotMatch(html, /\/demo-book\//, "must not link to an unavailable or rights-uncleared demo artifact");
  });
});

test("bookPreviewCopy centralizes the teaser copy the same way homeV3Copy does", () => {
  assert.equal(bookPreviewCopy.badge, "快速排版可用");
  assert.equal(bookPreviewCopy.entryCard.title, "纪念册");
  assert.equal(bookPreviewCopy.entryCard.subtitle, "快速排版可用");
});

test("bookPreviewPage is byte-identical whether featureFlags is omitted or explicitly {} (flag off)", () => {
  withStubbedDocument(() => {
    assert.equal(bookPreviewPage(baseState), bookPreviewPage(baseState, {}));
    assert.equal(bookPreviewPage(baseState), bookPreviewPage(baseState, { bookLab: false }));
  });
});

test("book preview page becomes a real experimental entry once featureFlags.bookLab is true", () => {
  withStubbedDocument(() => {
    const html = bookPreviewPage(baseState, { bookLab: true });
    assert.match(html, /让照片成为一本小书/);
    assert.match(html, /<span class="status-pill">实验<\/span>/);
    assert.match(html, /故事成书仍是实验功能/);
    assert.match(html, /<a class="button" href="\/manage\/space-1\/book-lab" data-nav>进入故事成书<\/a>/);
    assert.match(html, /<a class="button button-primary" href="\/zine" data-nav>开始快速排版<\/a>/);
    assert.doesNotMatch(html, /\/demo-book\//, "must not link to an unavailable or rights-uncleared demo artifact");
    assert.equal((html.match(/button-primary/g) || []).length, 1, "exactly one primary CTA, story entry must not compete with it");
  });
});

test("book preview page falls back to /spaces when the flag is on but no space is selected yet", () => {
  withStubbedDocument(() => {
    const html = bookPreviewPage({ ...baseState, currentSpaceId: "" }, { bookLab: true });
    assert.match(html, /<a class="button" href="\/spaces" data-nav>先打开一个空间<\/a>/);
    assert.equal((html.match(/button-primary/g) || []).length, 1);
  });
});

test("bookPreviewExperimentCopy centralizes the enabled-state teaser copy", () => {
  assert.equal(bookPreviewExperimentCopy.badge, "两种模式");
  assert.equal(bookPreviewExperimentCopy.entryCard.title, "纪念册");
  assert.equal(bookPreviewExperimentCopy.entryCard.subtitle, "快速排版 + 故事实验");
});

test("book preview page escapes a query-string-controlled currentSpaceId in the flag-on entry link", () => {
  withStubbedDocument(() => {
    const maliciousState = { ...baseState, currentSpaceId: 'space-1"><img src=x onerror=alert(1)>' };
    const html = bookPreviewPage(maliciousState, { bookLab: true });
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, "the flag-on entry link must escape currentSpaceId");
    assert.match(html, /href="\/manage\/space-1&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;\/book-lab"/);
  });
});

test("album page (with photos) links to the low-key /book-preview entry card and adds no second primary CTA", () => {
  withStubbedDocument(() => {
    const viewer = { name: "Test Space", photos: [{ id: "p1", title: "照片一", asset: "/assets/photos/photo-1.jpg", placementState: "confirmed" }], effectiveCanUpload: true };
    const html = albumPage(baseState, viewer);
    assert.match(html, /href="\/book-preview" data-nav/);
    assert.match(html, /nav-card/);
    assert.match(html, /纪念册/);
    assert.match(html, /快速排版可用/);
    assert.equal((html.match(/button-primary/g) || []).length, 0, "album page with photos has no primary CTA; the new entry card must not add one");
  });
});

test("album empty state keeps exactly one primary CTA even with the new entry card present", () => {
  withStubbedDocument(() => {
    const viewer = { name: "Test Space", photos: [], effectiveCanUpload: true };
    const html = albumPage(baseState, viewer);
    assert.match(html, /上传第一张照片/);
    assert.match(html, /href="\/book-preview" data-nav/);
    assert.equal((html.match(/button-primary/g) || []).length, 1, "the book-preview entry card must stay low-key and not introduce a second primary CTA");
  });
});

test("albumPage is byte-identical whether featureFlags is omitted or explicitly {} (flag off)", () => {
  withStubbedDocument(() => {
    const viewer = { name: "Test Space", photos: [], effectiveCanUpload: true };
    assert.equal(albumPage(baseState, viewer), albumPage(baseState, viewer, {}));
    assert.equal(albumPage(baseState, viewer), albumPage(baseState, viewer, { bookLab: false }));
  });
});

test("album page entry card switches to the 实验 badge once featureFlags.bookLab is true, still no extra primary CTA", () => {
  withStubbedDocument(() => {
    const viewer = { name: "Test Space", photos: [{ id: "p1", title: "照片一", asset: "/assets/photos/photo-1.jpg", placementState: "confirmed" }], effectiveCanUpload: true };
    const html = albumPage(baseState, viewer, { bookLab: true });
    assert.match(html, /href="\/book-preview" data-nav/);
    assert.match(html, /纪念册/);
    assert.match(html, /<span class="fine">快速排版 \+ 故事实验<\/span>/);
    assert.equal((html.match(/button-primary/g) || []).length, 0, "the entry card must still not add a primary CTA to the album page");
  });
});

test("book preview page never reflects state-controlled data (no injection surface)", () => {
  withStubbedDocument(() => {
    const maliciousState = {
      account: null,
      capabilities: {},
      spaces: [{ id: 'space-1"><img src=x onerror=alert(1)>', name: "Test" }],
      currentSpaceId: 'space-1"><img src=x onerror=alert(1)>',
      debug: false,
      uiProductizationFixture: false
    };
    const html = bookPreviewPage(maliciousState);
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, "book preview body is fully static copy and must never reflect a raw, unescaped payload");
  });
});
