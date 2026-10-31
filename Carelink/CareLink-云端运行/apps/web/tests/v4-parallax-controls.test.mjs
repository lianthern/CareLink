import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// C (v4 视差回归修复, 2026-08-17): packages/viewer's frozen .unseen-viewer__bottom
// holds two independent controls — the rotation pad (.unseen-viewer__directions) and
// the depth-parallax translation pad (.unseen-viewer__translation-controls, only
// present at all when Track 4's own [data-depth-ready=true] gate is set). The
// regression: styles.css previously put display:none on the whole
// .unseen-viewer__bottom outside compass-open to make room for the v4 filmstrip —
// but a display:none *ancestor* removes every descendant from layout regardless of
// the descendant's own display value, so translation-controls came out genuinely
// 0x0 for every depth-parallax space, not just visually deprioritized like the
// rotation pad. Fix: only .unseen-viewer__directions is hidden behind the compass
// toggle now; .unseen-viewer__bottom itself stays laid out and positioned so
// translation-controls (when Track 4 renders it) has its own always-visible slot.
// These are regex/text assertions against the stylesheet source (same technique as
// contracts.test.mjs's own CSS checks) — there is no headless CSS layout engine in
// this test environment to assert computed 0x0 vs non-zero size directly.

async function loadCss() {
  return readFile(new URL("../src/styles.css", import.meta.url), "utf8");
}

test("no rule ever sets display:none directly on .unseen-viewer__bottom (that zeroed out translation-controls too)", async () => {
  const css = await loadCss();
  assert.doesNotMatch(css, /\.unseen-viewer__bottom\s*\{[^}]*display:\s*none/,
    "a display:none .unseen-viewer__bottom rule would remove .unseen-viewer__translation-controls from layout again");
});

test("only .unseen-viewer__directions (the rotation pad) is hidden behind the compass toggle by default", async () => {
  const css = await loadCss();
  assert.match(css, /\.scene-immersive:not\(\.compass-open\)\s+\.unseen-viewer__directions\s*\{\s*display:\s*none;?\s*\}/);
});

test("no scene-immersive rule targets .unseen-viewer__translation-controls with display:none — Track 4's own [data-depth-ready] gate is the only thing deciding whether it renders", async () => {
  const css = await loadCss();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (selector.includes("unseen-viewer__translation-controls") && /display:\s*none/.test(body)) {
      assert.fail(`unexpected display:none targeting .unseen-viewer__translation-controls via selector: ${selector.trim()}`);
    }
  }
});

test(".unseen-viewer__bottom is positioned (laid out, not display:none) outside compass-open so translation-controls can actually render", async () => {
  const css = await loadCss();
  assert.match(css, /\.scene-immersive\s+\.unseen-viewer__bottom\s*\{\s*position:\s*absolute;/);
});

test("compass-open still gives .unseen-viewer__bottom its glass-panel treatment (rotation pad rejoins translation-controls there too)", async () => {
  const css = await loadCss();
  assert.match(css, /\.scene-immersive\.compass-open\s+\.unseen-viewer__bottom\s*\{[^}]*background:\s*var\(--viewer-glass\)/);
});
