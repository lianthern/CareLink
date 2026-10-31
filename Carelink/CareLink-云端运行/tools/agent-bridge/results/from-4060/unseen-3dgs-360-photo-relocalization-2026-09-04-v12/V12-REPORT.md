# V12 photo relocalization report

**Final result:** `PHOTO_RELOCALIZATION_PARTIAL_2_OF_3`

The single frozen CPU-only run localized query 1 and query 3, but query 2 did not produce a valid PnP solution. The contract requires 3/3, so this task is not accepted. No thresholds were changed, no query was replaced, and the official localizer was not rerun.

## Frozen parent scene

- Parent job: `unseen-3dgs-360roam-posefix-2026-09-04-v11`
- Scene revision: `360roam-base-posefix-r001`
- Parent result verified: `PANORAMIC_POSEFIX_ACCEPTED_7K`
- Reused inputs: 450 training views and 90 held-out views from the accepted v11 cache
- Source redownloads: 0
- GPU optimization runs: 0
- v11 checkpoint, SOG, Viewer, and dataset mutations: 0

## Phase A — training-only reference map

- Training panoramas: 50
- Reference images: 400 horizontal training views
- Attempted/useful image pairs: 800 / 800
- Triangulated points before deduplication: 119,010
- Final reference map points: 27,391 (minimum 2,000)
- Training camera path extent: 13.6221765175
- Held-out images used to build the map: no
- Author scene PLY used: no
- v11 SOG geometry used: no

## Frozen query results

| Query | Frozen source | Ratio matches | PnP inliers | Inlier ratio | Median reprojection | Position error / extent | Rotation error | Result |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | held-out panorama 2 / front | 122 | 64 | 52.46% | 1.258 px | 0.0292% | 0.089° | PASS |
| 2 | middle held-out panorama / right | 13 | 0 | null | null | null | null | FAIL (`pnp-ransac-failed`) |
| 3 | penultimate held-out panorama / left | 139 | 44 | 31.65% | 1.196 px | 0.1821% | 1.263° | PASS |

The ground-truth pose for each held-out image was unavailable to reference-map construction, feature matching, and PnP. It was used only after a pose had been estimated for scoring. Query 2 yielded only 13 ratio-test matches and no PnP solution; all post-PnP metrics for that query remain `null`.

## Phase B — Viewer integration

Status: `NOT_RUN_ALGORITHM_GATE`.

Phase B is permitted only after Phase A passes 3/3. Because the frozen result was 2/3, no v12 scene manifest, photo buttons, localized renders, comparison images, Viewer listener, or browser E2E run was created. The accepted v11 Viewer remains unchanged.

## Disposition and security

- Bridge terminal receipt: `BLOCKED`
- Product result: `PHOTO_RELOCALIZATION_PARTIAL_2_OF_3`
- Threshold tuning or alternate-query attempts: 0
- Training, checkpoint writes, SOG writes, production calls, paid API calls, firewall changes, and LAN/public listeners: 0
- Uploaded evidence contains only the report, structured result, the frozen localizer JSON, the explicit not-run Viewer log, and the self-excluding file manifest.

