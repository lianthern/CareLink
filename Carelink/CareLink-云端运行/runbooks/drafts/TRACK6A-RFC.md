# Track 6A local trust and operations candidate

Status: `NO_GO`. This is a local, unapproved module artifact set; it is not Integration, Release, legal approval, production wiring, or an executed incident drill.

## Frozen source

- Contract revision: `00c918a7549cdeae37a8f6de81a6e4482bd5a8ee`
- `contracts/source/technical/CANONICAL-STATE-AND-API.md`: `6d91751d9e0034ac7b629b3e5c4efd6ba9d42e6e268d7e60994de683ece8c125`
- `contracts/source/technical/RELEASE-READINESS-CONTRACT.md`: `0e80f0654674fa63f5666aa70921f376f730628e3357264f4b1572b4e9e09777`
- `contracts/source/IMPLEMENTATION-ORCHESTRATION.md`: `242a65a7ea21df36fa3736c3df98d639d2a0b7916c4c62f5da4807e266fb6a03`

## What can run locally

`node --test tests/security-contract/validate.test.mjs && node tests/security-contract/validate.mjs` validates source hashes, the nine-purpose notice set, immutable copy hashes, control/evidence-lane partitioning, SLO target shape, alert/runbook/kill-switch linkage, unresolved release blockers and recognized provider credential shapes.

That result proves artifact integrity only. It does not prove runtime authorization, deletion, CDN purge, cloud storage, SLO attainment, alert delivery, backup restore, migration, rollback, legal validity, license eligibility, customer-copy approval or on-call readiness.

## Open cross-owner gaps

| Gap | Owner | Current state | Recommended single fix | Release evidence |
|---|---|---|---|---|
| Notice acknowledgement persistence and current-version check | Track 1A | Open; Track 6A supplies unapproved immutable drafts only | Consume only an approved artifact and append the exact purpose/version/hash in the target mutation transaction | Fixed-RC API negative tests for missing, stale and cross-purpose acknowledgement |
| Approved notice display without leaking internal language | Track 2 | Open; Web must not render `needs_review` copy as terms | Render only server-current `approved` content whose hash matches the approved artifact | Browser trace plus DOM/copy hash bound to the RC |
| Core authorization, deletion, export and case runtime controls | Track 1A | Open outside Track 6A ownership | Implement the existing API contract without adding a bypass or alternate authority source | Module tests followed by Track 5 five-actor and Track 6B release evidence |
| Media deletion, CDN and backup disposition | Track 1B plus infrastructure owner | Waiting for an authorized isolated environment | Wire revoke-first adapters in a deletable sandbox and retain object/CDN/ledger receipts | Sandbox request IDs, hashes, cleanup and restore evidence |
| Alert delivery, dashboards and kill-switch actuation | Track 6B plus service owners | Not executed; this package defines targets and links only | Bind every declared alert and switch to the fixed RC, then exercise each path | Raw alert, switch, recovery and reconciliation receipts |
| Backup restore, migration, canary and rollback | Track 6B plus data operations | Not executed | Run the frozen expand-to-contract and fixture-to-100% procedures in isolation before release | Measured RPO/RTO, manifest hashes, rollback and no-revival proof |
| L3 Book Lab question/render isolation and withdrawal denial | Track 8A/8C, then Track 5/6B | Local fixture work is not Core integration evidence | Keep Book flags off until the fixed Core seam passes BOLA, grant-withdrawal and source-revocation tests | Fixed-RC Book MVE traces and artifact denial/purge receipts |
| Legal, privacy, minors, cross-border, retention, UGC and customer copy | Named human owners in `reviewRegister` | `needs_review`; release blocker | Approve or reject the exact notice version and content hash with a dated human record | Human approval record bound to purpose/version/hash |
| SBOM, font, media, model, data and decoder license eligibility | Legal, Security and Release Engineering | `needs_review`; commercial release blocked | Review the complete recursive evidence rows and explicitly approve each shipped artifact | Signed release inventory and license decision bound to build hashes |
| On-call ownership and incident drills | Track 6B plus named responders | Drafts only; no named acceptance or drill | Assign responders and execute all eight runbooks against the fixed RC | Drill timeline, alert, containment, recovery and reconciliation evidence |

## Handoff rule

Track 6A owns only `policy-inputs/**`, `ops/security/**`, `ops/observability/**`, `runbooks/drafts/**` and `tests/security-contract/**`. Track 5 and Track 6B may consume this candidate after its commit is fixed; they must not upgrade `NO_GO`, `needs_review` or `not_executed` without the named raw evidence and human approvals.
