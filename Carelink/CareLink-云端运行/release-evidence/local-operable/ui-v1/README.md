# UI productization v1 evidence

- Product commit: `c6361205b55358c4a5df944931a89b8b86dfbab8`
- Accepted base: `8675d244b9657a3cdc6cb809b75a57a6c7e92a34`
- Loopback staging: `http://127.0.0.1:4283/`
- Health: `GET /__ui-v1/healthz`
- Scope: home → Space album → photo detail → BL01–BL06 Book journey

This is a local, deterministic UI sample. It is not real AI and does not represent a production release. The Core sample (`向晚婚礼`) and the frozen Book sample (`AdventureX 2026`) remain deliberately separate; the photo-to-memory bridge says so before navigation. No provider, cloud write, public listener, credential, production deployment, or fixture fallback in a production profile was used.

Machine evidence:

- `CHROME-DESKTOP-MOBILE.json`: Chrome 1440, 390, and 1440-at-200%-equivalent reflow; real clickable path through BL06; copy/CTA bounds; keyboard focus; reduced motion; console/http/external requests all zero; 11 screenshots.
- `FIREFOX-REPRESENTATIVE-PATH.json`: official Mozilla Firefox 153.0.4 and geckodriver 0.37.1; real representative path through BL06; keyboard focus; no horizontal overflow or external resources; two screenshots.
- Existing Web + Book Node suites: 75/75 PASS.
- `npm run format:check`: PASS.
- `npm run secret:scan`: PASS, 776 files scanned, zero findings.

The browser file-input path is outside this first visible slice. Where later exercised, the declared automation boundary is a same-origin `File` inserted with `DataTransfer`; it must not be described as native file-picker evidence.

P0: 0. P1: 0.
