# V13 multiview photo relocalization report

**Final result:** `PHOTO_RELOCALIZATION_MULTIVIEW_PARTIAL_2_OF_3`

The single frozen CPU-only v13 run localized query 1 and query 3. Query 2 improved from 13 to 56 ratio-test matches, but those correspondences still did not produce a valid PnP RANSAC solution. The contract requires 3/3, so the result is not accepted. No query, threshold, matcher parameter, or descriptor-bank parameter was changed after the result, and the official localizer was not rerun.

## Frozen baseline

- v11 parent: `PANORAMIC_POSEFIX_ACCEPTED_7K`, scene `360roam-base-posefix-r001`
- v12 baseline: `PHOTO_RELOCALIZATION_PARTIAL_2_OF_3`
- Query set and five pose thresholds: identical to v12
- Reused inputs: accepted v11 450 training / 90 held-out split and frozen v12 training-only map geometry
- Source redownloads, GPU optimization, 7k, and 30k runs: 0
- v11 dataset, checkpoint, SOG, Viewer, and dataparser-transform mutations: 0

## Training-only multiview descriptor bank

- Training images processed: 400 horizontal views
- Candidate training keypoints: 1,998,111
- Associated additional observations: 134,223
- Descriptor entries: 161,614
- Landmarks: 27,391
- Multiview landmarks: 27,362
- Mean / maximum descriptors per landmark: 5.9003 / 6
- Reference and query descriptors: RootSIFT
- Association radius / ratio threshold: 3.5 px / 0.82
- Ratio-test runner-up constrained to a different landmark: yes
- Held-out images used to build map or descriptor bank: no
- Author PLY or v11 SOG geometry used: no

## Frozen query results

| Query | v12 matches / inliers | v13 matches / inliers | Inlier ratio | Median reprojection | Position error / extent | Rotation error | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| 1: held-out panorama 2 / front | 122 / 64 | 480 / 199 | 41.46% | 2.110 px | 0.0904% | 0.123° | PASS |
| 2: middle held-out panorama / right | 13 / 0 | 56 / 0 | null | null | null | null | FAIL (`pnp-ransac-failed`) |
| 3: penultimate held-out panorama / left | 139 / 44 | 290 / 53 | 18.28% | 1.144 px | 0.1778% | 1.250° | PASS |

All three queries are the unchanged v12 held-out images. Their ground-truth poses were unavailable to map construction, descriptor-bank construction, matching, PnP, initialization, and parameter selection; ground truth was used only after a pose estimate existed for scoring. Query 2 produced no pose, so its post-PnP metrics remain `null`.

## Viewer gate

Status: `NOT_RUN_ALGORITHM_GATE`.

The v13 contract permits Viewer work only after Phase A passes 3/3. Because Phase A remained 2/3, no v13 manifest, photo buttons, localized renders, comparison images, Viewer listener, or browser E2E run was created. The accepted v11 Viewer remains unchanged.

## Disposition and security

- Bridge terminal receipt: `BLOCKED`
- Product result: `PHOTO_RELOCALIZATION_MULTIVIEW_PARTIAL_2_OF_3`
- Official frozen runs: 1
- Retuning, alternate-query attempts, and reruns: 0
- Production calls, paid API calls, firewall changes, and LAN/public listeners: 0
- Uploaded evidence is restricted to the structured reports, explicit not-run Viewer log, and self-excluding file manifest allowed by the v13 contract.

