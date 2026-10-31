# Demo book — "夏日聚会" 演示纪念册

Offline-generated demonstration of Book Lab's finished output (photos → AI-style question → short
human answer → printed page), built from the six AI-template-space stock photos. It is fictional
content, not real user data, and it did not go through the live Book Lab interview/authorization
flow. See `content.mjs` for every question/answer and `../../packages/book-renderer/README.md` for
the renderer this reuses unmodified.

## Why this exists (investigation summary)

- **Book Lab's data model** (`services/book-lab/src/memory-api.mjs`, see its README) stores a
  `BookDraft` that `BOOK.FREEZE` turns into one immutable `BookVersion` — frozen manifest
  header/pages, verbatim authorized-text snapshots, local asset bytes, access control and a render
  job. Everything is content-addressed (SHA-256 hashes tie pages ↔ authorized-memory-text ↔
  frozen-asset together) and re-validated on every read.
- **The renderer** (`packages/book-renderer`) is a pure function: give it one immutable
  `FrozenBookManifest` + an asset resolver + a render profile (`"fixture"` or `"production"`), it
  returns self-contained, CSP-locked HTML, and `printExactHtmlToPdf` prints those exact bytes to
  PDF with a local Chromium. It has zero npm dependencies and no knowledge of Book Lab, Core, or any
  server — this is exactly what `build-demo-book.mjs` calls directly, the same way
  `packages/book-renderer/src/cli.mjs` calls it for its own fixture (`node
  packages/book-renderer/src/cli.mjs /tmp/unseen-book-preview` — the command referenced as "12 页真
  PDF" — reproduces byte-for-byte identical mechanics, just with a different manifest).
- **There is no anonymous-visitor viewer path today.** `services/book-lab/README.md` says outright
  that the package "has no upload, placement, album, Viewer, Core extension, or release-enablement
  route." The one HTTP surface that does exist (`BOOK.OPEN_PREVIEW` / `BOOK.DOWNLOAD_PDF` via
  `services/api/src/extensions/book-lab.mjs`) requires `readableBookVersion()` →
  `liveBookViewer()`, which calls back into Core's `readCurrentBookLabViewer` — an authenticated,
  invited space participant, not a public visitor. On top of that, `UNSEEN_BOOK_LAB_ENABLED=false`
  in production today (`tests/e2e/private-beta-deployment.verify.mjs`), so the backend is dormant
  regardless. And the *entire* private-beta domain sits behind one blanket
  `handle { basicauth ... }` in `infra/integration/private-beta-deployment/Caddyfile` — there is no
  public page anywhere on that domain right now.
- **Conclusion:** building a "real data path" (enabling Book Lab, wiring a public viewer route,
  carving an auth exception into the product's permission model) is exactly the high-cost path Max's
  brief said to avoid for a demo. The static-file mount below is the same shape as the existing
  `@private_ai` unauthenticated-matcher carve-out already in that Caddyfile, applied to one new path
  instead, serving a pre-rendered file instead of proxying a live process.

## Rebuilding the book

```bash
node tools/demo-book/build-demo-book.mjs [outputDir] [--assets-dir <dir>]
```

Defaults: `outputDir=~/code/unseen-assets/demo-book`,
`assets-dir=~/code/unseen-assets/ai-template-space`. Requires a local Chrome/Chromium (see
`packages/book-renderer/src/pdf.mjs`) and `pdfinfo`/`pdftotext` (poppler) — both already required by
that package's own test suite, and both present via `/opt/homebrew/bin` in this environment.

Produces, in `outputDir`:

- `book.html` — the canonical, self-contained, CSP-locked page (`default-src 'none'`), exactly what
  `renderCanonicalHtml` returns aside from six copy substitutions (see next section).
- `book.pdf` — printed from those exact HTML bytes; `pdfinfo`/`pdftotext -layout` verify 14 pages in
  the correct order.
- `index.html` — a separate, minimal landing page (own CSP) with a prominent
  "演示内容 · 内容为虚构示例" banner and links to the two files above. Not part of the renderer's
  hash-verified artifact — safe to iterate on independently.
- `render-receipt.json` — hashes, byte lengths, page count, ordered page IDs and each source photo's
  content hash, for anyone who wants to confirm the artifact wasn't altered after generation.

None of this output is committed to git — `~/code/unseen-assets/demo-book/` is outside the repo
entirely.

### Why `render.mjs` isn't modified

`renderCanonicalHtml`'s cover/closing copy is hardcoded to the AdventureX fixture's own narrative
("ADVENTUREX 2026 · 一晚，四种视角", "十四张照片…", "版本 02", real withdrawal-mechanics copy that
only applies to a book that actually went through `BOOK.FREEZE`). `build-demo-book.mjs`'s
`applyDemoCopy()` replaces those specific hardcoded strings with accurate demo copy via **exact,
assert-checked substitution** on the rendered HTML string — `packages/book-renderer/src/*.mjs` is
never edited (`git diff -- packages/book-renderer` stays empty). Every substitution target is
asserted to occur exactly once before being replaced, so a future change to the renderer's template
fails the build loudly instead of silently mismatching.

## Verification already done

- `node --test packages/book-renderer/tests/*.test.mjs` — 15/15 pass, untouched (baseline check,
  confirms this worktree didn't regress the package this reuses).
- `node --test tools/demo-book/build-demo-book.test.mjs` — 6/6 pass: the hand-built manifest passes
  the renderer's own `validateFrozenManifest`, page order/count is correct (14, within the [12,16]
  bound), every source photo is used, every answer/credit stays within the renderer's length limits,
  every credit is the neutral "朋友们" (no invented personal names), and the rendered HTML contains
  every question/answer with no `<script>` or remote-resource reference.
- Manual: `pdftotext -layout book.pdf` inspected page-by-page — Chinese renders correctly, all 12
  Q&A pairs and both bookend pages present, no leftover fixture strings (`grep -i
  "adventurex\|阿琳\|阿远\|小梅\|安然\|阿澄\|共光以后"` — zero matches in `book.html` or the PDF
  text). `pdftoppm` renders of the cover, one memory page, and the closing page checked visually
  (photos load, layout intact, demo notice legible in three places: cover eyebrow, cover subhead,
  closing body — plus the renderer's own automatic per-page "确定性本地样本" ribbon).

## Mounting checklist (for whoever has real server access)

This repo enforces "不碰服务器" for this task — everything below is written to be run by the
acceptance operator, not executed here.

1. **Build** the artifact on a Mac with this repo + the template-space photos (see above). Confirm
   `render-receipt.json`'s `pageCount` is 14 and `pdf.orderedMarkersVerified` is `true`.
2. **Copy** `book.html`, `book.pdf`, `index.html` to the server, e.g.
   `rsync -av ~/code/unseen-assets/demo-book/{book.html,book.pdf,index.html} <host>:/tmp/demo-book-src/`.
3. **Install** them into the static root:
   `ssh <host> 'bash -s' -- /tmp/demo-book-src < tools/demo-book/server/install-demo-book-static.sh`
   (or copy the script over first and run it directly). This only writes into
   `/var/www/unseen-demo-book`; it does not touch `/var/www/unseen-private-beta` or any database.
4. **Wire the route**: insert the block from
   `infra/integration/private-beta-deployment/demo-book-caddy-snippet.conf` into the real Caddyfile,
   above the trailing `handle { basicauth ... } ...` block (see that file's own comments for exact
   placement and why). `caddy validate` then `caddy reload`.
5. **Verify**: `curl -sI https://<private-beta-domain>/demo-book/` returns `200` with **no**
   basic-auth challenge; `/demo-book/book.pdf` downloads and opens; the private-beta domain's *other*
   paths still require basic auth (spot-check one, e.g. `curl -sI https://<domain>/` should still
   401).
6. **Link it in** (out of scope for this worktree — flagged for the `book-bridge` branch, which is
   already wiring the album → book-preview path): the natural place is
   `apps/web/src/ui/templates.js`'s `bookPreviewPage`/`albumPage` (see
   `apps/web/tests/book-preview.test.mjs` — today an honest "即将上线" teaser with no live CTA).
   Once this is mounted, that teaser (or a copy of it) can link to
   `https://<private-beta-domain>/demo-book/` as a "看看纪念册长什么样" preview, separate from the
   real feature's own CTA which should stay disabled while `UNSEEN_BOOK_LAB_ENABLED=false`. This
   worktree does not touch `apps/web` — that file sits in a parallel task's scope.

## Known limitations

- The mount deliberately bypasses the private-beta domain's blanket basic-auth for exactly one path.
  It serves three static files with no PII and no real user data — the demo book payload itself
  admits fictional-example status four separate times (cover eyebrow, cover subhead, closing body,
  and the renderer's own per-page fixture ribbon) — but this is still a real, if narrow, exception to
  "everything on this domain requires a login," and should be reviewed as such before being applied.
- `book.html` is ~4.8 MB and `book.pdf` is ~2.6 MB (six real JPEGs re-embedded as base64 across 13
  image placements, since two Q&A entries share each of the six source photos). No compression step
  was added — the source JPEGs were used byte-for-byte so their content hashes trace directly back
  to the files in `~/code/unseen-assets/ai-template-space/`.
- This manifest was assembled directly (like `packages/book-renderer/fixtures/frozen-book-fixture.mjs`
  builds its own fixture) rather than produced by a real `BOOK.FREEZE` call — there is no live
  `BookVersion` row anywhere, no grant, no withdrawal wiring. If someone ever wanted this specific
  demo content reachable through the real authenticated Book Lab surfaces too, that is separate,
  additional work this task did not do.
- No automated CI hook re-runs `build-demo-book.mjs` — it is a one-shot Mac-side artifact generator,
  matching `services/api/scripts/attach-depth-artifact.mjs`'s own "why a script instead of an HTTP
  admin endpoint" reasoning for the depth-artifact precedent.
