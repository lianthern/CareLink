# Locator Core seam gap

Severity: `P1 before fixed Core RC`; it does not block the already-labelled local Stage L fixture or this isolated 3A offline checkpoint.

Read-only evidence inspected on 2026-08-14:

- Track 1A commit: `b6a2c7ad69f52acb0a653abc692d1675c5601fde`.
- `services/api/src/ports/locator/deterministic-locator-fixture.mjs` is explicitly local, deterministic, and non-production.
- `services/jobs/dispatch/index.mjs` creates `photo_placement` input refs with photo/item/version, panorama revision, policy release/version, and source validation job fields.
- Frozen `contracts/source/IMPLEMENTATION-ORCHESTRATION.md` requires each locator runtime request to carry at least Space, Scene, panorama revision, Photo, media checksum, and policy release.

The current placement refs do not freeze `spaceId`, `sceneId`, or `mediaSha256`. A worker that accepts that payload cannot independently bind the requested media bytes to the exact Space/Scene job envelope required by the frozen contract.

Required owner action: Track 1A must add those immutable values when the placement job is queued, preserve the existing version/CAS fields, and add a negative test for mismatched Space/Scene/checksum. Track 5 must re-run the seam after accepting that exact 1A fix. Track 3A must not patch API/DB paths and does not claim Core integration before then.
