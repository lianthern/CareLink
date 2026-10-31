# Public Core temporary-access UI evidence

Status: PASS

Captured: 2026-08-15 09:47 AEST

Code commit: `4e5fd762d4bc53bc1713b675eaa4027e6f787105`

Base: `09ce09c170bbd4b5992a3a1b016e814be2013486`

The Web UI performs one same-origin, read-only `GET /healthz` and displays the temporary-access notice only when the
canonical response header is exactly `X-Unseen-Access-Mode: temporary-basic-auth-invite` on a 200 or degraded 503
health response. Missing, invalid, failed, and wrong-status inputs remain hidden. The request has no body, redirect,
credential material, or data mutation.

Visible copy:

> 临时邀请访问
>
> 当前通过邀请门浏览；邮件登录、照片上传、AI 问答和纪念册仍在准备，本次临时访问不会接收这些内容。

The presentation reuses the frozen warm-white, burgundy, pink, and gold tokens, typography, radii, shadows, and the
existing three-circle brand mark. No theme, font, dependency, animation, API, server, Caddy, environment, Book, AI,
contract, package, or live-process change is included. The favicon is a local SVG rendering of that same mark.

`browser.json` is a test-only CDP response proof, not production input. It records exact 503 disclosure at Chrome
1440×900 and 390×844, missing-200 and illegal-503 fail-closed cases, native skip-link keyboard flow, accessibility
status/copy, 200% scale, reduced motion, bounds, zero horizontal overflow, zero product writes, zero browser errors,
zero external requests, and correct non-HTML `image/svg+xml` favicon delivery. Screenshots were manually inspected.

Reproduce:

```sh
node --test apps/web/tests/temporary-access.test.mjs
node apps/web/tests/temporary-access-browser.mjs
npm test --workspace @unseen/web
npm run format:check
npm run secret:scan
git diff --check
```

The existing 4282 staging health endpoint was read only after the run and remained `status: ok`, `loopback_only`,
`externalExposure: false`, and `cloudWrites: 0`; this candidate was not mounted there. Claude review/authentication is
N/A because Max cancelled it for this cycle.

Remaining P0/P1/P2 found in this slice: none. Base commit `09ce09c170bbd4b5992a3a1b016e814be2013486`
already proves the live exact `X-Unseen-Access-Mode: temporary-basic-auth-invite` response header in
`release-evidence/r0/public-core-ui-target-20260814T232050Z/MACHINE-EVIDENCE.json`.
