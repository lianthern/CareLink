# Track 8B browser evidence

Status: `fixture-backed package evidence only`; not Core integration, Book MVE, R0, deployment, or production readiness.

The 18 screenshots cover every BL01–BL06 route at exact 320 and 390 CSS-pixel viewports, plus the existing BL05 boundary and selected 1440-pixel desktop evidence. Capture uses Chrome DevTools viewport emulation because headless Chrome otherwise clamps small `--window-size` values to a 500 CSS-pixel layout viewport before cropping the PNG. `browser-audit.json` records 23 live-Chrome cases, including key-copy, CTA, exact fixture-badge, viewport-bound and clipping-ancestor checks at 320/390, plus the 624 CSS-pixel reflow equivalent of a 1248-pixel viewport at 200%. It also records a real BL05 interaction that edits the title, removes one page, generates the preview, freezes 15 pages, reaches BL06, and verifies that the manifestHash-keyed HTML/PDF/receipt expose the edited frozen title and page count rather than the static fixture artifact.

Every audit case passed:

- no document-level horizontal overflow;
- key copy, CTA and the complete fixture badge remain inside the 320/390 viewport with no clipping ancestor;
- at most one enabled primary action;
- fixture label visible;
- no unnamed visible controls or image without alt text;
- keyboard Tab reaches the visible skip link first;
- accessibility tree contains banner, navigation and main landmarks with no unnamed buttons;
- reduced-motion media query active;
- no external resource requests;
- all six routes render non-empty content.

The page/source presentation model also has a destructive unit test proving that changing `displayPhotoId` cannot change `sourcePhotoId`, placement provenance, user original text, grant, or contributor-approved credit.

Reproduce:

```bash
node --test packages/book-lab-web/tests/*.test.mjs
node packages/book-lab-web/tests/browser-audit.mjs
node packages/book-lab-web/tests/capture-viewports.mjs /tmp/unseen-book-lab-viewports
```

For Max to open the local fixture UI:

```bash
node packages/book-lab-web/scripts/dev-server.mjs
```

Then open `http://127.0.0.1:4328/labs/memories/photos/photo-01`. The server binds only to `127.0.0.1`; all mutations are in-memory fixture interactions and reset on reload.
