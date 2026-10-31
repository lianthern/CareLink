# UI productization v2 evidence

- Status: `PASS`
- Fixed code commit: `9c208fa4d78d4a35092d27ce2cd258df91712140`
- Loopback staging: `http://127.0.0.1:4286/`
- Captured: `2026-08-14T19:07:12+10:00`
- Production exposure: none

The accepted v1 service remains online on 4283 and owns child ports 4284–4285, so v2 uses 4286 with child ports 4287–4288. Checks also confirmed the pre-existing 4282 staging and 4283 v1 health endpoints remained healthy.

## Product assertions

- Home → space → photo → memory → Book is clickable in Chrome and Firefox.
- The six Book tasks use user task names; no visible `BL01`–`BL06` identifiers remain.
- At 390 CSS pixels, all six task links are visible in a two-row grid without clipping or horizontal overflow.
- Visible customer copy contains no `Manifest`, `HTML`, `PDF`, “打开打印”, or “同源对账”.
- `向晚婚礼` Core and `AdventureX 2026` Book are explicitly labelled as independent deterministic samples, never continuous data.
- Fixture disclosure remains visible throughout: `本地确定性样本 / 非真实 AI / 不代表正式发布`.
- Permission, withdrawal, version, and source controls remain fail-closed; this slice changes no business action or transport contract.

## Machine evidence

- Web tests: 43/43 PASS
- Book tests: 32/32 PASS
- Chrome: 1440 desktop, 390 mobile, 720 CSS-pixel 200% equivalent; 12 page audits and 11 screenshots PASS
- Firefox 153.0.4 representative path: PASS
- Chrome console errors/warnings: 0
- Chrome HTTP failures: 0
- Chrome external requests/resources: 0
- Firefox external resources: 0
- Keyboard focus, reduced motion, visible CTA/copy bounding boxes, and horizontal overflow: PASS
- Format check: PASS
- Secret scan: PASS
- File input was not used by this slice; the declared automation boundary remains local `DataTransfer`, never a provider or cloud upload.

Primary machine records are `CHROME-DESKTOP-MOBILE.json` and `FIREFOX-REPRESENTATIVE-PATH.json`; screenshots are under `screenshots/`.
