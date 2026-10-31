# Private AI pull worker — server queue

Status: **DEFAULT OFF / NOT DEPLOYED / NO SLA**. This is a private test adapter for Max's
ChatGPT-authenticated `codex exec --image` worker. It is not the OpenAI API and must not
be presented as a production AI provider. Core upload, placement, Book editing and export
remain independent when the worker is asleep, offline, timed out or quota-limited.

This runbook covers only the persistent server queue and its internal HTTPS transport. It
does not authorize a live rollout, create a worker credential, change Caddy, or enable the
feature flag.

## Server composition

The API process owns the queue database and viewer-safe media port. No Book process opens
the queue database. Book composition calls the injected API methods
`authorizePrivateAiPhoto`, `enqueuePrivateAiPhoto`, `revokePrivateAiPhotoAuthorization`,
`reconcilePrivateAiPhotoAuthorizations` and `privateAiObservation`.
The last method gives internal composition a deterministic `workerOnline`, `lastSeenAt`,
queued/retry age and counts without exposing worker state as a public API or sharing SQLite.

The base migration is `services/api/db/migrations/0010_private_ai_jobs.sql`; bounded follow-up context is added by
`services/api/db/migrations/0018_private_ai_question_context.sql`. Jobs bind the
authorization snapshot, photo/media hash and version, current placement, task, prompt and
policy. The wire deliberately omits photo IDs, placement IDs and the idempotency key. Contextual v2 follow-up jobs
add only the preceding question, 1–2 model-visible facts, latest user answer (maximum 500 characters), and round
numbers; this is a real privacy-surface change and remains default-off pending review. The migration leaves active
pre-0018 rows without a context marker so they can finish with the legacy job/1 shape, while redacting historical
terminal rows. All jobs enqueued after migration bind an exact context and use job/2.

Set only after acceptance:

```text
UNSEEN_PRIVATE_AI_WORKER_ENABLED=true
UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE=/run/secrets/unseen-private-ai-worker-token.sha256
UNSEEN_PRIVATE_AI_PROMPT_HASH=67a580e7617893004c7edb1e0f7578cd40a28509dd5ac756ae914ed201479d73
UNSEEN_PRIVATE_AI_POLICY_HASH=75ea90bfd53213ce15adf81973de5e26db4f091c3ca853aa991033ee37d46e5d
UNSEEN_PRIVATE_AI_MODEL=gpt-5.6-sol
UNSEEN_PRIVATE_AI_MODEL_VERSION=codex-cli 0.147.0/gpt-5.6-sol
```

The hash file path must be absolute. The target must be a regular, non-symlink, single-link
file owned by root or the API euid with mode `0400` or `0600`, containing exactly the
lowercase SHA-256 of the random worker bearer token plus an optional final newline. Keep the
plaintext token only in the Mac worker's `0600` secret file. Do not put either value in the
repository, service arguments, shell history, screenshots or logs. Rotation means replacing
both files atomically and restarting the API and Mac worker; the old token must then fail.

The API remains loopback-only. The dedicated Caddy route exposes only
`/__internal/private-ai/v1/*` over HTTPS to the API loopback and preserves
`X-Forwarded-Proto: https`. The composed deployment validates against
`UNSEEN_PUBLIC_ORIGIN`, so Caddy must preserve the exact public Host; setting an upstream
loopback Host fails closed with `request_host_invalid`. The route is ordered before the Basic
Auth/static fallback so Basic Auth cannot replace the worker's Bearer header. The API remains
the sole constant-time worker-token authority. No development port or Mac listener is opened,
and JSON request bodies remain limited to exactly 32 KiB (32,768 bytes). Caddy rejects worker
POSTs without `Content-Length` and declared lengths above 32,768 with a local `413` before worker
authentication or upstream is consulted. The frozen worker always sends an exact content length;
rejecting chunked POSTs prevents the reverse proxy from converting a streaming overflow into
`502`. The local response carries the frozen protocol header, `application/json` media
type and `no-store, private`, but has an empty body because Caddy must not forge the API's random
request ID. The `request_body` limit remains as a streaming fail-closed backstop.

## Frozen transport

Every request and response carries:

```text
X-Unseen-Protocol: unseen-private-ai-pull/1
Authorization: Bearer <worker token>
```

Credentials never appear in a URL. Requests must arrive from the loopback reverse proxy
with `X-Forwarded-Proto: https`. JSON requests have exact keys and
`Content-Type: application/json`.

Lease:

```http
POST /__internal/private-ai/v1/jobs/lease

{"schema":"unseen-private-ai-lease-request/1"}
```

Success is `{schema:"unseen-private-ai-lease-response/1",job,retryAfterMs}`. `job` is null
when idle. The server emits an exact v2 job:

```text
schema, jobId, leaseId, taskType, attempt, maxAttempts, leaseExpiresAt,
inputHash, mediaSha256, mediaBytes, mediaMime, promptHash, policyHash,
questionContext, imagePath
```

`questionContext` is exactly `{kind:"initial_question"}` for an initial round. For a follow-up it is exactly
`{kind,followupOrdinal,followupLimit,priorVisibleFacts,priorQuestion,userAnswerText}` with a hard maximum of three
rounds. The shared worker transport accepts legacy v1 and contextual v2 exact shapes for worker-first rolling
upgrades; the server emits v2 for every newly enqueued job and v1 only for a still-active pre-0018 row. The queue
keeps raw follow-up context only while a job remains retryable and
replaces it with `{kind:"redacted"}` on completion, terminal failure, withdrawal, source invalidation, or after a
hard 24-hour per-job retention ceiling. Expiry emits the privacy-safe provider-unavailable composition event so an
offline worker cannot leave raw answer context in the queue indefinitely.

The collection notice is a fail-closed runtime dependency for this wire change. Its configured SHA-256 must equal
the exact notice copy, and the copy must contain the canonical contextual-follow-up disclosure covering the
preceding question, 1–2 visible facts, the latest answer's first 500 characters, the photo, and the possibility of a
third-party processor. An old notice or an unbound version/hash prevents Book Lab from mounting.

`imagePath` is exactly
`/__internal/private-ai/v1/jobs/${encodeURIComponent(jobId)}/image`. Lease polls also update
the persistent Worker heartbeat. Default lease is 180 seconds, maximum attempts is five,
idle retry is five seconds, and only one lease may be active. Retry backoff is 5 seconds
times `2^(attempt-1)`, capped at 300 seconds.

Image:

```http
GET /__internal/private-ai/v1/jobs/<jobId>/image
X-Unseen-AI-Lease: <leaseId>
```

The response has exact media `Content-Type`, `Content-Length`, quoted SHA-256 `ETag`, and
`X-Unseen-Content-SHA256`. Accepted media are JPEG, PNG and WebP, at most 20 MiB and
16,777,216 pixels. The server rechecks authorization, currentness, MIME, size and SHA before
and after reading bytes.

Completion body:

```json
{"schema":"unseen-private-ai-complete-request/1","leaseId":"pail_...","inputHash":"...","result":{"modelVisibleFacts":["..."],"question":"...？","questionIntent":"photo_context","model":"...","modelVersion":"...","latencyMs":1234}}
```

Facts are one or two unique strings of 2–160 characters. Question is 2–300 characters with
exactly one final `?` or `？`. No fact/question contains controls or newlines. Model and
version must exactly equal server configuration and latency is an integer 0–300000.

Failure body:

```json
{"schema":"unseen-private-ai-fail-request/1","leaseId":"pail_...","inputHash":"...","failureCode":"model_timeout"}
```

Retryable codes are `model_unavailable`, `model_quota_exhausted`, `model_timeout`,
`worker_aborted`, and `worker_internal_failure`. Terminal codes are `image_invalid`,
`image_unsupported`, and `result_policy_rejected`.

Both terminal endpoints are:

```text
POST /__internal/private-ai/v1/jobs/<jobId>/complete
POST /__internal/private-ai/v1/jobs/<jobId>/fail
```

Their exact response is
`{schema:"unseen-private-ai-terminal-response/1",status,replayed,retryAfterMs}`. The tuple
of lease ID, input hash and exact body supplies replay identity: an identical replay returns
200 with `replayed:true`; a divergent replay returns 409. No idempotency header is used.

IDs are `paij_` or `pail_` plus 32 lowercase hex characters; all hashes are exactly 64
lowercase hex characters. Expected errors are 400 invalid request/result/code, 401 bad
worker token, 404 missing job, 409 wrong/expired lease, changed input or stale source,
413 oversize, 415 unsupported MIME, 426 non-HTTPS path, 429 rate limit, and 503 disabled or
invalid configuration.

## Durable Book composition outbox

Before enqueue, the authorized server-side composition must explicitly call
`authorizePrivateAiPhoto({photoId,authorizationSnapshotHash})`. That operation binds the
authorization to the current immutable photo/placement/media source. Enqueue never creates
or activates an authorization. Withdrawal always upserts an inactive tombstone—even when it
arrives before enqueue—and atomically fails already queued or leased work. Only another
explicit authorize operation may reactivate that snapshot after rechecking the current source.

Enqueue also requires the server-owned Book processor request with exact keys
`{jobId,jobVersion,kind,inputHash,attempt}`. `kind` is `initial_question` or
`followup_question`; v2 mirrors that kind and the bounded context on the worker wire, while the full Book identity
and source binding stay server-only. Worker output cannot alter either.

Successful completion and retryable provider outage each create an idempotent composition
event in the same transaction as the queue transition. The API-only injected port exposes:

```text
claimPrivateAiCompositionEvent({leaseMs})
markPrivateAiCompositionEventDelivered({eventId,deliveryLeaseId})
retryPrivateAiCompositionEvent({eventId,deliveryLeaseId,failureCode})
```

This is not an HTTP surface. A claimed `completed` event contains the stored
`questionProcessorRequest` and six-field `completionDto`; composition calls
`bookLab.ingestPrivateQuestionResult(request, dto, workerSecret)`. A
`provider_unavailable` event contains the stored request and a null DTO; composition calls
`bookLab.recordQuestionProviderUnavailable(request, workerSecret)`. That Book method commits
the queued retry and deliberately throws `model_unavailable`; this stable throw counts as a
successful delivery and the outbox should then be marked delivered.

Claims use a CAS lease. If the process dies after Book commits but before the delivered mark,
the same event and payload are reclaimed after expiry; Book's identical replay is idempotent.
If an AI retry and an outage dispatcher race, SQLite gives one winner: a new AI lease cancels
the still-pending outage event, while a claimed outage event blocks the old Book request from
being retried and its delivered mark retires that AI job. The next Book retry uses the fresh
request returned by `pendingQuestionJobs`; old request bindings are never rewritten.

Every claim reparses the strict stored Book request/result DTOs and recomputes the request,
result and composition-event hashes before returning any payload. A malformed row or binding
drift is atomically scrubbed, marked `quarantined` with only the stable
`composition_payload_invalid` code, and skipped so it cannot poison the single dispatcher or
expose its raw content in logs. The dispatcher then continues to the next healthy event.

Composition is single-flight and starts only when both Book and the private worker flags are
true. It reconciles Core and Book sources before applying authorization/enqueue intents and at
most one durable result event. Repeated authorize/revoke calls are true no-ops. Delete,
withdrawal, content, placement, viewer-safe asset or version drift tombstones authorization,
cancels inaccessible work and writes a CAS-bound `FACT_SOURCE_REVOKED` Book event. The current
generated question, model facts and their hashes are removed; unconfirmed Memory returns to
stable `question_source_revoked` / `question_failed` and requires explicit regeneration.
Confirmed user text and existing public Book grants are not automatically changed.

## Acceptance and rollback

Before enablement, run the focused queue tests and the API workspace suite, verify SQLite
`PRAGMA quick_check`, inspect logs for absence of tokens, media and result content, and test
Mac sleep/offline plus recovery. Approve and deploy a new collection-notice version/hash/copy that explicitly
discloses the bounded latest answer and the possibly third-party processor before enabling contextual jobs. A
queued or retrying job stays durable while core features
continue; UI must say the photo is saved and AI will ask later. Never substitute fixture AI.

Also prove the approved backup-retention/deletion procedure with a snapshot taken while a contextual job is active.
Live-row redaction cannot rewrite an already sealed backup; the approved notice and retention record must cover that
bounded backup lifetime before enablement.

To fail closed, set `UNSEEN_PRIVATE_AI_WORKER_ENABLED=false` and restart the loopback API.
This reads neither the secret hash nor media and leaves durable rows for inspection/recovery.
Remove only the dedicated Caddy internal route if it was separately deployed; do not modify
the root domain or public Web routes. Database rollback is restore-from-backup, not manual
row deletion. Authorization withdrawal marks active work failed and prevents subsequent
image/result access.
