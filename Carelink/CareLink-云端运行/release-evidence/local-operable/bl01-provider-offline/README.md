# BL01 provider-offline UI evidence

This evidence is bound to accepted capability seam `c76ee298e7a9566506252e291e3dfe050c4a3a9f`.
The product reads `x-unseen-question-provider`; it does not add a fixture, fallback, API, or contract.

The browser harness uses a deterministic response projection only to render the real integrated shell in isolated
Chrome. It is not production input. The screenshots prove the 1440px and 390px layouts, native disabled state,
keyboard traversal around the disabled action, visible fixture disclosure for the harness, and the accessibility
tree. `verification.json` records bounds and zero browser diagnostic counts.

Reproduce:

```sh
node packages/book-lab-web/tests/browser-audit.mjs
npm test --workspace @unseen/book-lab-web
npm test --workspace @unseen/web
node --test services/book-lab/tests/*.test.mjs
npm run format:check
npm run secret:scan
```
