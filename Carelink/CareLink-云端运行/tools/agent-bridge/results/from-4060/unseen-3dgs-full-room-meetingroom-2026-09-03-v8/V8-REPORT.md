# UNSEEN v8 — Full-room Meetingroom canary

**Result:** `BLOCKED` — the required v7 Viewer correction passed. A resumed attempt reached the official Google Drive endpoint through the enabled local proxy, but Drive returned a `2,009`-byte HTML response instead of the frozen `4,271,432,079`-byte video. The byte gate rejected it. The contract requires stopping rather than changing download behavior or using an unknown mirror, so no upload, SfM, GPU training, SOG export, or v8 full-room Viewer was attempted.

- **Phase A Viewer URL:** http://127.0.0.1:8765/?scene=./pexels-classroom-v7.scene.json
- **Still running:** Viewer **yes**, intake **yes**; both bind only to `127.0.0.1`
- **Max should try:** use **+ / − or the wheel**; choose a **photo position** then **free walk**; hold **W for 1 second**; hold **Shift+W** and drag upward to verify sprint and the `+75°` pitch clamp
- **v8 full-room scene:** `PENDING` because the official source could not be downloaded

## Corrected v7 verdict

`TECHNICAL_PIPELINE_PASS / USER_FULL_ROOM_FAIL / TRAJECTORY_SLICE_ONLY`

The v7 source lasts `17.884533s` and keeps a downward-looking classroom trajectory. Its previous Viewer had no wheel/touchpad zoom, used `moveSpeed=0.15`, proved only about `0.106` movement, and allowed an axis-aligned `0.64 × 2.19` navigation rectangle. The first/middle/last camera Y values were approximately `+0.496 / -0.022 / -0.472`. The high adjacent-frame reconstruction metrics therefore did not prove a complete room.

## Phase A — Viewer correction: PASS

The existing Viewer was corrected in place and retained manifest compatibility with v6/v7:

- visible `+ / −` controls, wheel/touchpad scrolling, and keyboard reset control FOV within `30°–90°`;
- the UI displays real camera FOV, optical zoom ratio, navigation mode, and normal/sprint tier;
- entering free walk preserves yaw while setting pitch and roll to zero and Y to the median camera height;
- horizontal movement uses a scene-scaled speed, with Shift measured at `2.9527×` normal speed;
- mouse drag keeps roll at zero and clamps pitch to `[-75°, +75°]`;
- three photo positions still restore exact XYZ/quaternion/FOV;
- the v7 navigation boundary is now the buffered 2D camera-trajectory convex hull, not the former axis-aligned rectangle.

Chromium E2E results:

| Gate | Result |
| --- | ---: |
| FOV button delta | `5.0°` |
| Wheel delta | `5.0°` |
| Clamp | `30°–90°` |
| Free-walk pitch / roll | `0° / 0°` |
| Median-height error | `5.73e-10` |
| One-second normal displacement | `0.198045` |
| Required minimum from old short side | `0.159805` |
| Sprint / normal | `2.952739×` |
| Anchor position / quaternion / FOV gates | PASS |
| Console and page errors | `0` |

All four shipped scene manifests validate against the updated JSON schema. The 24 Python Viewer/processing tests and both legacy/new v7 browser regressions pass. The patch dry-applies to the captured pre-v8 baseline.

## Phase B — official media and loopback upload: BLOCKED

The frozen script was run with `-ConfirmResearchCanary` and the installed `Ubuntu-22.04` distro. Before downloading, intake reported `READY`, `bindAddress=127.0.0.1`, and `trainingStartsAutomatically=false`.

The first run used direct networking and failed to connect to `drive.usercontent.google.com:443` after approximately 21 seconds on each of four attempts. After the user enabled networking, the official endpoint became reachable through the existing local proxy. A one-byte range probe returned HTTP `206`, but the frozen script's full request returned a Google Drive HTML response of only `2,009` bytes. Its SHA256 is `bacca222e69c62ba3ef6d6ec3194d54c114b27dfb37cb9e35f0b085d67aed068`; it is not the expected video and remains only as the diagnostic `.part` file. No official video, prepared copy, or new intake job exists.

Per the v8 stop contract, the agent did not change URL, use a mirror, weaken hashes, treat HTML as media, or continue to SfM/GPU work. Continuing now requires the publisher to revise the frozen official-download method, or the exact official video to be placed locally and pass the frozen byte/MD5 checks.

## Phases C–E — not attempted

- Full `370.37s` extraction and 12-bin contact sheet: `PENDING`
- COLMAP registration/coverage/PCA/convex-hull gates: `PENDING`
- Single permitted 7k training invocation: `0` attempts
- PLY/SOG export and six-direction v8 Viewer evidence: `PENDING`
- `tandt-meetingroom-r001` user gate: `BLOCKED`

## Safety

- Production connections: `0`
- Paid API calls: `0`
- Firewall or port-forward changes: `0`
- Private media uploads: `0`
- Training invocations: `0`
- Forbidden artifacts in this result: `0`
- Viewer and intake listeners remain loopback-only
