# Track 3A offline locator checkpoint

Status: `MODULE TOOLING PASS / RELEASE NO-GO` on 2026-08-14.

This checkpoint is deliberately small and synthetic. It proves the offline integrity, split, annotation, statistics, and fail-closed worker contracts; it does not contain a locator model or authorized real photos.

## Re-run

```bash
npm --prefix services/locator test
node eval/offline/run.mjs --out release-evidence/locator-offline/synthetic-tooling-v0/report.json
```

The first command must report 6/6 tests. The second must exit successfully with `EVALUATED_NO_GO`, `NO_GO_SYNTHETIC_FIXTURE`, and `jointGatePassed=false`. A no-go is the expected successful result for this fixture.

## What is proved

- The 13 inline synthetic byte records have explicit internal-only permission, purpose, retention, and source declarations. They contain no copied historical/private media or personal data.
- Every byte count and SHA-256 is verified before use. One exact duplicate is removed, leaving 12 canonical records.
- Spaces are SHA-256 sorted within each declared stratum and assigned whole to train/calibration/test. Space, panorama, near-duplicate cluster, and content hash cannot cross a split.
- Two blinded synthetic annotations, structured disagreement, and third-rule adjudication are required. Ambiguous and multi-solution ID examples are frozen non-evaluable before predictions.
- The four frozen endpoints use burst/near-duplicate cluster as the primary unit and Bonferroni-adjusted 98.75% one-sided exact Clopper-Pearson bounds. The report includes pooled, per-Space bound, macro, worst-Space, and canonical-sample sensitivity views.
- Model, preprocessing, dataset, threshold, preregistration, prediction, pipeline, and worker-contract hashes are written into the machine report.
- With no real model, the worker validates the frozen request seam and only returns `abstained`; it performs no photo or database write.

## Honest boundary

The fixture test split has only 2 Spaces, 2 evaluable ID clusters, and 2 OOD clusters. The release minimum is at least 10 test Spaces, 300 evaluable ID clusters, 300 OOD clusters, and 20 ID clusters per Space. Perfect fixture point estimates therefore still produce correctness/coverage lower bounds of `0.111803...` and catastrophic/OOD upper bounds of `0.888196...`; every endpoint remains no-go.

Track 3B stays closed until Max supplies written real-data permission covering purpose, retention, withdrawal, and annotation. No threshold, model, shadow, canary, or production claim is approved here.

Machine report: `synthetic-tooling-v0/report.json`.
