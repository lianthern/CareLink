# @unseen/book-renderer

Track 8B renderer. It accepts one immutable `FrozenBookManifest`, creates self-contained print HTML, and prints those exact HTML bytes to PDF with a locally installed Chromium browser. Server callers must pass the closed render profile `"fixture"` or `"production"` as the final argument to both `renderCanonicalHtml` and `buildRenderReceipt`; it is never read from the manifest or request data.

```bash
node packages/book-renderer/src/cli.mjs /tmp/unseen-book-preview
node --test packages/book-renderer/tests/*.test.mjs
```

The included CLI passes `"fixture"` and remains visibly marked `确定性本地样本 / 非真实 AI 问题质量`. The production profile removes those fixture presentation labels while retaining authorization, withdrawal and provenance copy. It does not provide the real provider, Core Event, approval or deployment seams by itself and is not a production-readiness claim.

`printExactHtmlToPdf` keeps Chromium's sandbox by default. A server adapter may pass `outerSandboxVerified: true` only after it has placed the renderer and every descendant process inside an OS-enforced sandbox that denies network access across the full process tree; this is the sole path that adds Chromium's `--no-sandbox` compatibility flag. The rendered HTML remains self-contained and protected by its deny-by-default CSP. Never source this option from a manifest or request payload.
