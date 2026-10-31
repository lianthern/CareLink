# UI v2 Core state evidence

Status: **PASS** for test commit `2f85856eb5d2753c2ef7d68175ecafa45f001ee0`, based on clean Stage5 `e16dd93eaacce4ad8fe1fd25930277638e795f96`.

This is explicitly `TEST_ONLY_FIXTURE_FAULTS` evidence. It uses a fresh Chrome profile and temporary loopback-only UI-v2 processes, changes no product bytes, and is not a production input or production fault-injection claim. The injected state is confined to that profile's fixture `sessionStorage`; no canonical API, contract, product data, cloud state, or live staging process is changed.

## Covered states

- Empty album: “这个空间还没有可查看的照片。” and the keyboard-operable “上传第一张照片” action reaches the upload route.
- Scene unavailable: “这个空间暂时没有现场” and the keyboard-operable “查看相册” action returns to the gallery.
- Stable error: “照片暂时无法加载。” remains on the same route; one native keyboard activation of “重新加载” recovers after the fixture is brought online.
- Missing photo: “这张照片已不可查看。” appears without retry, media, or report controls.

Each state ran at Chrome widths 1440, 390, and 720 (the 1440-at-200% equivalent), producing 12 screenshots. Fixture disclosure, reduced motion, horizontal bounds, control bounds, native keyboard behavior, console, exceptions, failed requests, HTTP failures, external requests, and owned-process cleanup were checked.

This closes the earlier `NOT_EXERCISED` gap only for the deterministic fixture UI surface. It does not claim production provider failures, production API fault injection, or release readiness.
