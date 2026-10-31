# Track 6A artifact inventory and acceptance matrix

Status: construction contract only. This file does not assert Module, Integration, or Release PASS.

## Closed artifact inventory

| Path | Contents | Machine gate |
|---|---|---|
| `policy-inputs/notices.zh-CN.v1.json` | Canonical NoticePurpose set, immutable draft copy hashes, review ownership, release blockers, future-feature isolation | Notice set/hash/approval and Web-consumption checks |
| `ops/security/security-controls.v1.json` | Security/privacy test cases, log redaction, deletion/export/case controls, license evidence matrix | Required-control, locator, evidence-shape, privacy and license checks |
| `ops/observability/release-operations.v1.json` | Target SLI/SLOs, alerts, RPO/RTO, migration, canary and kill switches | Exact target, alert-owner and closed kill-switch checks |
| `runbooks/drafts/incidents.v1.json` | Draft incident procedures for the eight required incident families | Required runbook, linkage and non-success-state checks |
| `runbooks/drafts/NOTICE-APPROVAL-PACKET.zh-CN.v1.json` | Exact nine-notice human-review manifest and unresolved decision inputs; no approval record | Source/hash mirror and fail-closed approval checks |
| `runbooks/drafts/TRACK6A-RFC.md` | Cross-owner implementation gaps and one recommended fix per gap | Human handoff; path audit only |
| `tests/security-contract/validate.mjs` | Node.js standard-library validator | Positive module-contract validation |
| `tests/security-contract/validate.test.mjs` | Positive checks and temporary mutated-artifact rejection checks | Negative gate proof |

No root package or lockfile change, dependency, business-module write, deployment, cloud write, credential use, or production claim is in scope.

## Acceptance matrix

| Area | Required acceptance | Stage / evidence |
|---|---|---|
| Policy inputs | Exact generated `noticePurpose` closed set; one immutable version/hash/approval state per notice; SceneNote and walkable3d independent and disabled; unapproved copy is not Web-consumable | Module / validator JSON result |
| Customer copy | Plain-language zh-CN copy contains no registered internal model, algorithm, schema, CAS, credential, or legal-analysis terms | Module / validator JSON result |
| Legal review | Legal, minors, cross-border, retention, UGC SLA, evidence preservation, and legal-notice questions remain `needs_review` with owners and release blockers | Module / validator JSON result plus later human evidence |
| Campaign/auth | Locator, challenge, admission, bootstrap, exchange, fragment clearing, Cookie/CSRF/Origin/Host, anti-enumeration, abuse, cross-visitor and cross-Space BOLA | Module contract now; Integration/Release execution later |
| Identity/CAS | OTP, session epoch, reauth, canonical version/CAS, idempotency and credential replay | Module contract now; Integration execution later |
| Media | Observed bytes/MIME/magic/decoder limits, static media, EXIF orientation, GPS/device-serial removal, hashes and provenance | Module contract now; Integration evidence later |
| Privacy lifecycle | Photo/Space/account revoke-first deletion, object/CDN/backup semantics, immutable retry ledger, participant export projection | Module contract now; Integration/Release evidence later |
| Cases | Report, appeal and generic support authorization, anti-enumeration, unsupported media fields and minimal post-revocation case access | Module contract now; Integration/Release evidence later |
| Logging | Secret, raw bootstrap URL, raw IP, full UA, risk MAC and stable cross-campaign visitor key prohibited; observable fields and runtime redaction canary specified | Module / validator JSON result; canary execution later |
| Reliability | Frozen SLI/SLO values explicitly marked targets, not current results; every alert has owner, severity, condition, read-only diagnosis, kill switch, recovery, reconciliation and escalation | Module / validator JSON result |
| Recovery/change | Metadata RPO/RTO targets, restore ledger replay, expand-to-contract migration and fixture/test-Space/1/5/25/100 canary | Module / validator JSON result; exercise later |
| Incident response | Authorization leak, checksum mismatch, panorama invariant, locator storm, deletion/CDN, restore mismatch, decoder crash and secret redaction drafts | Module / validator JSON result; drill later |
| Licenses | SBOM, font, media, model, data and FFmpeg evidence rows; DAP and CC BY-NC cannot be commercially eligible | Module / validator JSON result plus later human approval |
| Negative gate proof | Temporary artifacts are rejected for an old contract hash, a missing notice purpose, false closed evidence, a recognized secret-like value, an unresolved license register that stops blocking release, and a control omitted from its evidence lane | Module / Node test output |
| Baseline | `git diff --check`; closed-path audit; validator/tests; secret scan; contracts/source/provenance/format/backend checks; clean status after one commit | Raw command output in handoff |

Track 5 owns integration execution. Track 6B owns fixed-RC release evidence. The controller remains the only R0 go/no-go owner.
