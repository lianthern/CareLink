# UNSEEN v14 fixed real-photo return report

## Current outcome

Status remains **RUNNING / MAC_TECHNICAL_ACCEPTED_5_OF_5 / MAX_VISUAL_REJECTED_CONTEXT_EVIDENCE_REQUESTED**.

Mac accepted the immutable five-run technical package at commit `0a3fd4f`. Max then directly rejected the visual evidence with “我没看到原空间.” and requested one evidence-only spatial-context demonstration in https://github.com/maxi-max-dev/max-agent-bridge/issues/15#issuecomment-5537182020. This supplement answers only that request and does not claim visual acceptance or completion.

## Algorithm and technical gates (unchanged)

- Method: `alexnet-superpoint-lightglue-training-track-v1`.
- Algorithm final gate: `ACCEPTED_5_OF_5`.
- Mac technical status: `MAC_TECHNICAL_ACCEPTED_5_OF_5`.
- Candidate implementation SHA256: `7620f3d9d296f679b555b461e45fc36fecaf9bf28db8bb6ddee1031ba043f4ec`.
- Immutable index before/after: `cb97169c17c6a662fc33936445f6eb90aa3367b9021407ed38f2a1d1d993e7d9`.
- Source-byte closure commit: `eae4cfb`; accepted by Mac in `0a3fd4f`.
- This supplement added 0 localization inference, Viewer-mechanics gate, GPU training, or 3DGS training runs.

| Run | Inliers | Ratio | Median reprojection | Translation / scene extent | Rotation error | Status |
|---|---:|---:|---:|---:|---:|---|
| final-01 | 55 | 31.25% | 2.732 px | 0.0871% | 0.548° | PASS |
| final-02 | 59 | 34.91% | 2.534 px | 0.0768% | 0.466° | PASS |
| final-03 | 57 | 33.93% | 2.832 px | 0.1047% | 0.805° | PASS |
| final-04 | 60 | 33.15% | 2.815 px | 0.0668% | 0.555° | PASS |
| final-05 | 66 | 35.68% | 2.556 px | 0.0574% | 0.298° | PASS |

## Requested spatial-context evidence

One continuous `final-01` demonstration is included:

1. `fixed-photo-spatial-context.mp4` starts with a recognizable free-walk wide view of the original room: ceiling, columns, poster wall, tables/chairs, and walkway.
2. A large top-down overlay continuously shows current and target XZ positions.
3. The actual Viewer `Return to source frame` control triggers the frozen `final-01` estimated anchor.
4. At arrival, the derived fixed-query inset and Viewer pose/FOV remain visible. Arrival maximum position error is `2.049e-08`, sign-invariant quaternion error is `1.840e-09`, and FOV error is `0°`.
5. Only after arrival, the video changes its label to `context reveal / 非估计位姿`, performs a small orbit and backward movement, and shows the wall's relation to the original room. The moved camera is never presented as the estimated pose.

Video: 1280×720, 24 fps, 11.042 s, 785942 bytes, SHA256 `b8941a08293f4b8cc6c0a500851be11d26400a92acaf45bd4e1e2a6fa0cfca74` (target ≤3 MB; hard cap ≤5 MB). Contact sheet: 7 labeled frames from that same continuous video, 219160 bytes, SHA256 `f58d9735dfed2ae63ddb92cabc5e7b8b9662fc443e668670dbe37169f9240d91`. Audit log: `logs/viewer-spatial-context.json`, SHA256 `cd527987043027d170dc031070b42b87b1c3b4c5465b9568bae141237277e151`.

## Frozen bindings and safety

- v14 manifest SHA256: `0aebf762799689bc0049e693c77d4856c2ed629f09ba52113066800f9c4e8993`.
- frozen v11 SOG SHA256: `00c9e28b4285b7b05c870f91220ae01e348c141c36ed0dce5d6bc9b603f71680`.
- final-01 position / quaternion / FOV are unchanged.
- Loopback only; no query ground truth read or used.
- No repeated five-viewer video set, no localization rerun, no manifest edit, no anchor edit, and no v11 scene edit.
- The authorized query appears only as a derived inset inside the evidence media; no original or standalone query is included.
- Known limitation: the frozen v11 7k-preview SOG remains blurry. This supplement supplies the missing spatial relationship only; it does not claim a reconstruction-quality improvement.

Direct Max rereview remains pending. The earlier rejected terminal claim and append-only receipt remain preserved and are not relied upon.
