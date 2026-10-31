# Track 1A contract evidence matrix

All commands are local and offline: `npm --prefix services/api test`.

| Contract area | Implementation | Negative/concurrency evidence |
|---|---|---|
| Identity/session/reauth | `identity-service.mjs`, `crypto.mjs`, keyed-MAC schema | OTP purpose/expiry/attempt lockout and issuance buckets; secret-at-rest; credential replay rotation; cross-process rekey+retirement; residual epoch/corrupt/missing/permission fail-closed |
| Space/Scene lifecycle | `space-service.mjs`, `lifecycle-service.mjs`, `deletion-worker.mjs` | all-snapshot CAS; request-time member/invite/external/session revoke; retryable per-media immutable ledger; owner disposition; expired owner-transfer sweep |
| Member invitation/ownership | `space-service.mjs` | account-equivalence binding; wrong account rejected |
| External campaign admission | `campaign-service.mjs`, HTTP adapter | locator has no grant, uniform public errors, admission rechecks current risk/rate/abuse, combo CookieJar, concurrent ordinal, expiry sweep |
| Upload/photo/batch/receipt | `upload-service.mjs`, `src/ports/media/**` | atomic claim + conditional durable put; cross-process exact bytes/hash/delete/crash cleanup; 20/32 MiB HTTP boundaries; canonical receipt recovery error |
| Placement | `placement-service.mjs`, job dispatcher | failure mapping, candidate yaw not trusted, manager lock/audit, delayed job after manual write/panorama switch is stale with zero photo write |
| Panorama revisions | `panorama-service.mjs`, job dispatcher | strict 2:1, one current session, ready irreversible, A→B→A has one active revision, same-current zero-write |
| Media projection | `viewer-media-service.mjs`, `read-service.mjs`, HTTP adapter | exact immutable photo/panorama asset identity; repeatable session-cookie same-origin full/single-range/suffix-range reads; live principal/scene/revision/placement revalidation; old URLs fail after drift; no bearer, custom auth header, query secret, capability row, or object-key leakage |
| Moderation/cases | `case-service.mjs`, exact XOR + composite FK schema | exact receipt/viewer branches, rotating case cookie replay, case-access survival, anti-enumeration |
| Export/account lifecycle | `lifecycle-service.mjs`, job dispatcher | participant membership/binding/contribution/case/consent privacy projection; one-time header only; no URL/object-key secret |
| Audit/dispatch | immutable DB triggers, `services/jobs/dispatch` | composite FKs; append-only consent withdrawal/deletion; unknown work explicit; sweeper exactly once; default-off local locator fixture uses normal jobs and labels high/uncertain/failed output non-production |
| Book extension boundary | `extensions/index.mjs`, `LocalApi.mountExtensions` | real default-off runtime host; no business import/route/job/callback/write while off; generated allowlists; duplicate-load idempotence; malformed/duplicate registration and registration-time callback use fail atomically with no partial mount; contributor binding and isolated audit are live; exact current SourceProvenance is read-only and fail-closed unless trusted timezone-qualified capture time and every Core scene/placement/asset relation are current |
| Decoder runtime | `ffmpeg-decoder-runner.mjs` | no shell, executable injection isolation, ENOENT/crash/timeout, group kill, input/output/time/concurrency caps, no SQLite transaction across process IO |
| L2 scene note | explicit 503 routes | never returns success without implementation |

`contract-coverage.test.mjs` mechanically compares every frozen API action in
`ACTION-API-COVERAGE.json` to the concrete router. Static application pages and
client navigation are outside this backend Track; the HTTP entrypoint only owns
the frozen invite/receipt bootstrap documents needed to keep secrets out of URLs
after first load.
