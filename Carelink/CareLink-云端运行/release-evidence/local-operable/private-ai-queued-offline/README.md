# Private AI queued/offline UI evidence

Status: PASS  
Captured: 2026-08-15 03:30 AEST  
Code commit: `df127bf313559fec1054bf2fed85a086c32a1c78`  
Base: `95d1151e7be72d5a487384b0fb915c5d90fbfde3`

This bounded slice consumes the existing `x-unseen-question-provider` and
`x-unseen-private-ai-worker` response capabilities in the real Book integrated shell. It does not add or change a
service, API, contract, action, DTO, root lockfile, server, fixture, or live process.

- `queued` or `running` prevents a duplicate `MEMORY.START_QUESTION`; `MEMORY.SKIP` stays available.
- An online pending job says `AI 正在准备问题，照片已保存；稍后会自动出现。`.
- An offline worker or a current `model_unavailable` job says `AI 暂时离线，照片已保存，稍后再问`.
- With no job, an offline worker still permits the existing START action to submit the unchanged authorization,
  provenance, idempotency, and CAS request before showing queued state.
- Missing, invalid, disabled, or non-eligible capability input fails closed with the existing generic non-AI copy.
- Polling obeys the server `nextPollAfterMs`, clamped to 1–30 seconds; route changes and destroy clear it, and a ready
  question stops it.

The browser harness uses deterministic response projections only to exercise the real shell. That is not production
input or proof of a production header producer. The visible fixture banner remains explicit in every screenshot.
Chrome 1440px and 390px evidence covers queued online/offline copy, native disabled/skip controls, keyboard traversal,
AX status/disabled semantics, reduced motion, bounds, and zero console/network diagnostics. The existing browser audit
also binds missing/invalid heartbeat, non-eligible, offline admission, and ready transition states.

Reproduce:

```sh
node packages/book-lab-web/tests/browser-audit.mjs
npm test --workspace @unseen/book-lab-web
npm test --workspace @unseen/web
node --test services/book-lab/tests/*.test.mjs
npm run format:check
npm run secret:scan
git diff --check
```

The 4282 health endpoint was read only after the run and remained `status: ok`, `loopback_only`,
`externalExposure: false`, and `cloudWrites: 0`. Claude review/authentication is N/A because Max cancelled it for this
cycle. Remaining P0/P1 found in this slice: none.
