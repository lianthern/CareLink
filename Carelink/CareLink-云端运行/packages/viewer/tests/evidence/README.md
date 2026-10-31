# Viewer verification evidence

Committed evidence is produced locally by the dependency-free runners in `../browser/`; it contains no credential or external request.

- `browser-report.json`: Chrome version, 29 passing end-to-end assertions, stage markers, first-frame metric, requested loopback URLs, and zero console/runtime/network/external failures. It includes real two-frame APNG/animated-WebP rejection before browser decode and the bounded public `focusPose()` render-failure/flat-fallback rejection counterexample.
- `runner-cleanup-report.json`: successful-run `finally` evidence (`serverClosed`, `chromeExited`, `profileRemoved`, and `orphanProcessCount: 0`).
- `runner-timeout-browser-failure.json`: the deliberately injected stage timeout and non-success result.
- `runner-timeout-cleanup.json`: failed-run `finally` cleanup evidence.
- `runner-timeout-counterexample.json`: independent check that the injected hang exited non-zero, required markers appeared, and owned orphan processes were zero.
- `screenshots/viewer-1280.png` and `screenshots/viewer-390.png`: desktop and DPR 2 coarse-touch layouts.
- `soak-report.json`: acceptance-qualified 1,800,115 ms run (2026-08-13), 8,701 interaction cycles, all bounded checks true, console/network errors zero, and owned process/service finals zero.
- `screenshots/viewer-soak-final.png`: the final steady-state frame before the acceptance run's dispose phase.

Reproduce from the repository root:

```sh
node --test packages/viewer/tests/unit/*.test.mjs
node packages/viewer/tests/browser/run-browser.mjs
node packages/viewer/tests/browser/run-cleanup-counterexample.mjs
node packages/viewer/tests/browser/run-soak.mjs
```

The unit suite has 13 tests covering the single `src/public/` package entry, artifact gating, the shared color/depth canonical yaw seam, three unequal directional boundaries, the 0.42 m absolute clamp, numeric stability, invalid safety data failing closed, real static PNG/WebP parsing, real APNG/animated-WebP rejection, animation-chunk redundancy, and RIFF/chunk boundary rejection. The browser runner uses only the unique Chrome process group and loopback server it creates; the counterexample's emergency cleanup additionally matches its unique run token so it cannot terminate another Track's browser.

The committed soak report is the default-duration acceptance run from the final runtime/test code, not a shortened CI run: `qualification="acceptance"`, `acceptanceEligible=true`, and `boundedChecks.officialDurationReached=true`. Coverage totals are 8,701 orbit/move/resize cycles, 791 scene-reload pairs, 379 context-loss/default-retry cycles, 236 dispose/mount/update cycles, and 165 dispose/mount-with-scene cycles. Baseline/peak/steady-final/disposed-final counters are recorded for heap, DOM, canvas, WebGL contexts, object URLs, RAFs, listeners, observers, owned processes, and the loopback service. After dispose: canvas, WebGL, object URL, RAF, observer, owned process, and owned service counts are all zero.
