# Private AI server queue acceptance

- Evidence time: `2026-08-15T02:59:05+10:00` (AEST)
- Base: `23152d1ab22b79c450f82c35fc0871db20805ad6`
- Initial code checkpoint: `6e87713802e44a7db726e521fe4433ceea511b64`
- P1 closure checkpoint: `4209d552fd79f679ed821fcacb741f5095945fcb`
- Branch: `provider/private-ai-queue-server`
- Release state: **DEFAULT OFF / NOT DEPLOYED / NO_GO**

## Accepted scope

The checkpoint adds a private, persistent SQLite queue for
`photo_visible_facts_question_v1`, the exact worker-only v1 HTTP transport, secure bearer-token
hash loading, current viewer-safe image checks, atomic lease/retry/completion and a durable
Book composition outbox. It adds no public contract or UI route. It does not modify Caddy,
the live server, the Mac worker, Book files, root dependencies/lockfiles, or MaxNotes.

The worker wire contains only job/lease/task/attempt/current input hash, media integrity and
size metadata, prompt/policy hashes, and the same-origin image path. Photo IDs, placement IDs,
authorization snapshots, Book processor requests and result-outbox identity stay server-side.

Independent review rejected the initial checkpoint for an authorization ordering race and a
composition-outbox poison-row risk. The follow-up checkpoint closes both without rewriting
history: revoke now creates an inactive tombstone before any enqueue, enqueue cannot activate
unknown/withdrawn authorization, and only an explicit current-source-bound authorize call can
transition to active. Outbox claim now strictly reparses stored DTOs and recomputes the request,
result and event hashes; malformed or drifted rows are scrubbed, quarantined under one redacted
stable code, and cannot block the next healthy event.

Worker heartbeat is persisted only by authenticated lease polls. Internal composition can
query `privateAiObservation()` for `workerOnline`, `lastSeenAt`, queue counts and oldest
queued/retry age without a public route or cross-process SQLite access.

Completion and outage transitions write an idempotent composition event in the same
transaction. A crash after Book commits but before A marks delivery reclaims the exact same
event/hash/payload; the Book seam's identical delivery is idempotent. An AI retry and outage
consumer claim serialize in SQLite, so an old Book request cannot be both requeued and later
completed.

## Machine evidence

Commands run from `/Users/max/code/unseen-worktrees/9-ai-queue-server`:

```text
node --check services/api/src/private-ai-job-queue.mjs
node --check services/api/src/api.mjs
node --check services/api/src/http-server.mjs
node --check services/api/src/index.mjs
node --test --test-reporter=spec services/api/tests/private-ai-job-queue.test.mjs
npm --workspace services/api test
npm run contracts:check
npm run provenance:check
npm run format:check
npm run secret:scan
npm run backend:baseline
git diff --check
```

Results:

- Focused queue/outbox/HTTP tests: `8/8 PASS`.
- API and jobs workspace: `124/124 PASS`.
- Contract generation: `CONTRACT_GENERATION_CLEAN` (11 files).
- Provenance: `PROVENANCE_OK` (357 included, 178 excluded).
- Format: `FORMAT_OK`.
- Secret scan: `SECRET_SCAN_CLEAN` (910 files, zero findings).
- Backend network-guard baseline: `10/10 PASS`, `BACKEND_FAKE_OSS_BASELINE_OK`.
- SQLite reopen `PRAGMA quick_check`: `ok`; media adapter network count: `0`.
- `git diff --check`: clean before checkpoint.

Focused coverage includes default-off zero secret/media reads; unsafe token hash paths,
permissions, symlink and malformed contents; two dispatchers; lease expiry/restart/reclaim;
wrong and old leases; maximum attempts; retry backoff; duplicate enqueue/complete/fail;
authorization withdrawal; photo/placement/version drift; bad MIME, oversize and tampered media;
strict result and Book binding DTOs; HTTPS/protocol/auth/rate limits; persistent heartbeat and
offline age; composition retry; crash-after-consumer-commit replay; revoke-before-enqueue and
two-dispatcher enqueue/revoke ordering with zero media reads; malformed stored JSON; request,
result and event hash drift; poison quarantine; and delivery of a healthy successor.

## Known repository gate inherited from base

`npm run check` reaches and then fails `freeze:check` with
`FREEZE_TRACK8_REGISTRATION`. `npm run freeze:test` reports 12/14 for the same cause. The
identical `npm run freeze:check` failure was reproduced in the clean base worktree
`/Users/max/code/unseen-worktrees/5-stage-rc-next` at
`23152d1ab22b79c450f82c35fc0871db20805ad6`. This checkpoint does not touch the freeze
manifest and does not reopen or weaken the previously governed tracks.

## Integration bindings

Mac worker accepted checkpoints:

- Code: `3114a1f89c6542550f3fe19b51fee3a04aadea61`
- Evidence: `1ad67378f169057b506987eee96f51b2699a5a22`

Book private-facts accepted checkpoints:

- Code: `deaf767777144c38b045e8265fb7f6e5a4f8de69`
- Evidence: `5ea82de266b1ec07122ed34bf5219069bfa3b18d`

The fixed server/worker binding is prompt SHA
`67a580e7617893004c7edb1e0f7578cd40a28509dd5ac756ae914ed201479d73`, policy SHA
`75ea90bfd53213ce15adf81973de5e26db4f091c3ca853aa991033ee37d46e5d`, model
`gpt-5.6-sol`, and model version `codex-cli 0.147.0/gpt-5.6-sol`. Enabling still requires a
new random worker bearer token, its server-side hash file, accepted composition wiring and a
separately reviewed Caddy internal route. No credential was created or used here.
