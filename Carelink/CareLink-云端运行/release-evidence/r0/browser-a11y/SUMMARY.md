# Browser and accessibility release evidence

Candidate: `09076727051411eeb9274a26663f6ccd168378c3`

Current-candidate coverage: `true` for the exact Chrome and Firefox runs recorded here.

Release boundary: **NO_GO**. This directory proves only the named macOS browser paths and measured accessibility scope below. It does not claim a complete R0, production readiness, a native file-picker run, or a complete device/browser matrix.

## Actual results

- Chrome 151.0.7922.138 on macOS 15.7.8: `CHROME_CURRENT_CANDIDATE_NAMED_MAIN_CHAIN_PASS`.
- Official Firefox 153.0.4 with official geckodriver 0.37.1 on macOS 15.7.8: `NAMED_BROWSER_CORE_MAIN_CHAIN_PASS_NOT_COMPLETE_MATRIX`.
- Both runs used isolated dynamic loopback staging and the visible owner/participant/upload/review/real Scene Viewer chain. Product mutations were triggered by visible controls. Only file bytes crossed the explicitly declared `DataTransfer` automation boundary; no native picker is claimed.
- Chrome measured the accepted desktop path at 1280×900 and the 390×844 home, participant upload, and real Scene Viewer path. The 390px pages had no horizontal overflow and passed the same names, landmarks, keyboard, focus, and reduced-motion checks; desktop retained the existing 200% reflow check.
- Chrome diagnostics: unexpected console/HTTP/fetch/external requests `0/0/0/0`.
- Firefox diagnostics: unexpected console/HTTP/failed/external requests `0/0/0/0`; the report separately records expected authorization denials and one expected navigation abort.
- Firefox also passed Viewer keyboard focus and album return, then cleared site data and reopened the persisted approved photo in a new browser context.
- Chrome real Viewer cold diagnostic, 25 Mbps / 0 ms RTT / 1x CPU / cold cache, five samples: P75 `491.2 ms`, under the diagnostic 3000 ms threshold. Formal release-profile verdict remains `INDETERMINATE_PROFILE_UNDERSPECIFIED_FAIL_CLOSED` because the frozen profile did not specify RTT, CPU throttling, or cache policy.
- Accessibility definite findings: `0` for measured landmarks, headings, names, duplicate IDs, keyboard order, visible focus, 200% reflow, reduced motion, and measurable contrast. Gradient/image/pseudo-element text and controls that could not be reliably pixel-isolated remain conservatively `INDETERMINATE`; they are not reported as PASS.

## Remaining external-device gaps

- macOS Safari was not run because Safari remote automation is disabled. This track did not change `AllowRemoteAutomation`; enabling it is an external device setting decision.
- Physical iOS Safari, Android Chrome, and native upload-picker coverage remain outside this local named-browser evidence.

Within this track's tested scope: P0 `0`, P1 `0`. No product owner hand-back is required.

Claude Code authentication/review: cancelled by Max for this cycle; N/A and not a release dependency.
