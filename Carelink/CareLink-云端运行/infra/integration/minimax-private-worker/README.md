# MiniMax private-ai pull worker — external vision worker for Book Lab "看图提问"

Status: **default-off, not deployed, no SLA**. This directory makes the Book Lab memory-interview "AI looks at
your photo and asks a gentle question" experience actually work by supplying real image bytes to a real vision
model. The default-off composition path now also carries a narrowly bounded follow-up context; this has not
been deployed or exercised against a real MiniMax account.

## Why this exists

Book Lab's synchronous, in-process question composer
(`services/book-lab/src/providers/minimax-question-provider.mjs`, wired in via `UNSEEN_BOOK_QUESTION_PROVIDER=
minimax` in `services/api/src/extensions/book-lab.mjs`) only ever takes the "known facts" branch
(`composeFromKnownFacts`): it needs `input.visibleFacts` to already be non-empty. Nothing in the real Core
projection populates that field today, and the provider's own `resolveImage` capability — the only way it could
fall back to actually looking at the photo — is never supplied by `book-lab.mjs`. So every real photo's question
job fails closed with `minimax_no_visible_source`, and the interview stays queued/skippable forever. This worker
closes that gap the way the design already anticipated: `services/api` ships a complete, generic external pull
queue for exactly this (`services/api/src/private-ai-job-queue.mjs`, migration
`services/api/db/migrations/0010_private_ai_jobs.sql`), and `infra/integration/mac-codex-private-worker` is a
full reference implementation of the consumer side of that queue — it just uses Max's local Codex subscription
instead of an API-keyed model, and only runs on Max's Mac when he's logged in. This directory is the same
consumer role, running as an always-on systemd service on the production server, calling MiniMax's hosted vision
model instead.

## The lease protocol (investigation)

The wire is `unseen-private-ai-pull/1` at `/__internal/private-ai/v1`, fully specified by
`services/api/src/private-ai-job-queue.mjs` + `services/api/src/http-server.mjs` (`handlePrivateAi`) and
mirrored client-side, DTO-for-DTO, by `infra/integration/mac-codex-private-worker/remote-pull.mjs` +
`https-transport.mjs`. It is documented end-to-end in `runbooks/release/PRIVATE-AI-PULL-WORKER.md`. This worker
**reuses `remote-pull.mjs` and `https-transport.mjs` unchanged** — nothing in either file is Codex-specific, so
there was nothing to fork:

- **Auth**: a single, random, per-deployment bearer token. The worker reads it from an absolute, `O_NOFOLLOW`,
  0400/0600 file (`loadPrivateWorkerToken`, re-read fresh on *every* HTTPS request, never accepted from argv/env/
  JSON/a log). The server checks it with `timingSafeEqual` against a SHA-256 it holds
  (`UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE`); the raw token itself lives only in the worker's file — see
  "Server enablement" below for how the two sides share this.
- **Lease** (`POST /jobs/lease`): returns `{schema, job, retryAfterMs}`. `job` is `null` when idle. A v2 job has
  the v1 exact fields plus `questionContext`; `remote-pull.mjs` accepts the exact legacy v1 or contextual v2
  shape, but rejects hybrids and unknown fields. One lease at a time; default lease budget 180s, five max
  attempts, five second idle poll, all server-configured.
- **Image** (`GET /jobs/{id}/image` with `X-Unseen-AI-Lease`): exact `Content-Type`/`Content-Length`/quoted
  SHA-256 `ETag`/`X-Unseen-Content-SHA256`; re-validated byte-for-byte after download
  (`withPrivateDownloadedImage`), written to a private 0600 temp file, and unconditionally truncated+fsynced
  +removed in a `finally` regardless of outcome.
- **Complete** (`POST /jobs/{id}/complete`) / **Fail** (`POST /jobs/{id}/fail`): both are lease-ID+input-hash+
  exact-body replay-safe — an identical retry returns `200 {status, replayed:true}`; a divergent one returns
  `409`. `fail` requires one of a fixed, closed set of failure codes (`FAILURE_CODES` in `remote-pull.mjs`):
  `model_unavailable | model_quota_exhausted | model_timeout | worker_aborted | worker_internal_failure` are
  retryable; `image_invalid | image_unsupported | result_policy_rejected` are terminal.
- **Exactly-once / retry**: not exactly-once in the strict sense — it's **at-least-once with idempotent
  terminal calls**. A lease that expires before `complete`/`fail` lands is silently recovered server-side
  (`recoverExpired()`), incrementing `attempts` and re-queuing with exponential backoff
  (`5s * 2^(attempts-1)`, capped 300s) until `max_attempts`. The worker itself enforces concurrency-one
  (`RemotePrivateAiPullWorker`'s `#active` flag) and a `minimumLeaseRemainingMs` safety margin before ever
  accepting a leased job, so it never starts work it can't plausibly finish before the lease would expire.
- **Privacy boundary**: neither version carries a photo ID, account/owner ID, Space/placement ID, consent record,
  or source identifier. An initial-question v2 context is only `{kind:"initial_question"}`. A follow-up v2
  context contains the round number (maximum three), the preceding 1–2 model-visible facts, preceding question,
  and at most 500 characters of the user's latest answer. Those words are disclosed to the same private vision
  processor solely to make the next question contextual; they are bound into `inputHash` and never enter the
  composition result/event DTO. The queue retains them only while the job can still retry, with a hard 24-hour
  ceiling, then replaces the JSON with a redaction marker on completion, terminal failure, withdrawal, source
  invalidation, or TTL expiry. Sealed backups can still retain pre-redaction rows until their approved retention
  window expires, so backup deletion/restore evidence is a release gate. This is narrower than sending the full
  conversation, but it is a real privacy change and must be reviewed before enablement.

`infra/integration/mac-codex-private-worker`'s own reference tests (`tests/e2e/mac-codex-private-worker/
remote-pull.test.mjs`) exercise this wire against a real self-signed-TLS `https.createServer`, and this
worker's own equivalent test (`tests/e2e/minimax-private-worker/remote-pull-minimax.test.mjs`) does the same.

## Compliance: two validators, and the constraint the reviewer flagged

Two independent checks sit downstream of whatever the worker sends to `/complete`:

1. **Wire-level, structural only** — `services/api/src/private-ai-job-queue.mjs` `checkedResult()` (mirrored
   client-side by `remote-pull.mjs` `checkedAnalysisResult()`): 1-2 unique facts, 2-160 chars each, no control
   characters; a question 2-300 chars with exactly one trailing `?`/`？`; `model`/`modelVersion` equal to what the
   server was configured with; `latencyMs` 0-300000. **It does not check for sensitive content, and it does not
   check that the question has anything to do with the facts.**
2. **Book Lab's own semantic validator**, `privateProviderOutcome()` in `services/book-lab/src/memory-api.mjs`
   (lines 126-154, using `UNSAFE_MODEL_TEXT` at line 35 and `GENERIC_FACT_BIGRAMS`/`factBigrams()` at lines 36
   and 116-124) — this is the validator that will actually gate whether a completed result becomes a real
   interview question, once something drains `private_ai_composition_outbox` into
   `bookRuntime.ingestPrivateQuestionResult()` (see `infra/integration/book-lab/private-ai-composition.mjs`). It
   additionally forbids:
   - Prompt-injection-shaped text and a long list of identity/sensitive-attribute/relationship/emotion/inference
     language: face/identity phrasing (谁/人脸/身份/姓名 …), protected attributes (民族/宗教/政治/疾病/性取向/
     性别认同 …), gendered nouns (男士/女士/男人/女人 …), emotion words (开心/伤心/焦虑 …), relationship words
     (情侣/夫妻/父母/同事 …), and hedge/inference words (显然/似乎/可能是/应该是 …).
   - **The constraint the overall reviewer specifically flagged: a Chinese bigram overlap requirement.** The
     question must share at least one 2-character (or 2-token, NFKC-normalized) substring with at least one
     visible fact, excluding eight generic filler bigrams (`照片/画面/可以/看到/一张/一个/一位/其中`). This is
     what stops a model from writing a technically-valid but *unrelated* question next to real facts.

   Concretely, this second check would even reject the **example question used in the reference Codex worker's
   own test fixture** (`"...卡片是谁放在这里的？"`, from `tests/e2e/mac-codex-private-worker/private-worker.test.mjs`)
   — it contains `谁`. That is direct evidence the wire-level check alone is not enough to guarantee a compliant
   result, which is exactly why this worker does not gamble on it.

**Generation-side counter-measure**: `./compliance.mjs` ports validator #2's regex, bigram algorithm, and
generic-bigram exclusion list **verbatim** (with a from-scratch control-character scan standing in for the one
part of the source regex — `\p{Cc}|\r|\n` — that can't be embedded as a literal control byte in a maintainable
source file). It was cross-checked against the *actual* `BookLabMemoryApi.validatePrivateProviderOutcome()`
method — not just re-derived by hand — on both a hand-picked battery of cases and a 400-case randomized fuzz run
(zero mismatches either way). `./minimax-vision-analyzer.mjs` runs `checkCompliance()` locally, before ever
returning to the caller that will call `/complete`:

1. Ask MiniMax's vision model once. If the result is compliant, use it.
2. If not, retry **once** with an explicit, reason-specific correction appended to the system prompt (e.g. "the
   question didn't reuse a word from the facts — this time make sure it does").
3. If still non-compliant (or the model abstains both times), **abstain**: throw `result_policy_rejected`, a
   terminal (non-retryable) wire failure code — never a third attempt, never a best-effort ship.

The system prompt (`MINIMAX_WORKER_VISION_PROMPT`) additionally instructs the model never to use 谁 ("who") at
all and to always reuse a concrete noun/phrase from its own stated facts inside the question, specifically to
make bigram overlap likely on the *first* try rather than relying on the reworded retry.

## Follow-up chain

- `MEMORY.REQUEST_FOLLOWUP` creates a `followup_question` job and enforces the Book Lab limit before dispatch.
  The constructor default and hard maximum are both three.
- `privateAiCompositionIntents()` derives the bounded context from the immediately preceding ready question,
  its model-visible facts, and the answer submission that triggered this follow-up. The API queue validates the
  exact shape, binds its hash into the job input, persists it for retry, and emits it only in a v2 lease.
- `createMiniMaxPhotoAnalyzer()` reads `job.questionContext` in production. Its optional
  `resolveJobContext(job)` remains a test/integration override. Follow-ups add the previous exchange to the prompt
  while instructing the model to inspect the photo independently; the normal compliance/retry/abstain checks are
  unchanged. An over-limit context abstains before spending a MiniMax call.
- `remote-pull.mjs` remains rolling-upgrade compatible: deploy a worker that accepts v1 and v2 first, then a
  server that emits v2 for newly enqueued jobs. Migration 0018 deliberately leaves still-active legacy rows without
  context so they finish as v1; historical terminal rows are redacted. An old worker rejects v2 by design, so
  reversing the rollout order would strand new leases.

Tests cover Book Lab context derivation, queue validation and hashing, the exact v2 lease, worker prompting,
over-limit abstention, and a real self-signed-TLS pull loop using the contextual lease shape. This is still fake
model traffic; a privacy review and live canary remain release gates.

## Files

- `worker.mjs` — env-var configuration loader (`loadWorkerConfig`), wiring (`buildWorker`), and the poll loop
  entrypoint (`main`). Reuses `ExactHttpsClient`/`loadPrivateWorkerToken` from
  `../mac-codex-private-worker/https-transport.mjs` and `PrivateAiPullProtocol`/`RemotePrivateAiPullWorker` from
  `../mac-codex-private-worker/remote-pull.mjs`.
- `minimax-vision-analyzer.mjs` — the `analyze({job, imagePath, signal})` callback: prompts (initial + follow-up
  addendum), the MiniMax `chat/completions` HTTP call (same shape as `tools/minimax-probe.mjs` and
  `services/book-lab/src/providers/minimax-question-provider.mjs`), reply parsing, and the compliance-checked
  retry-then-abstain composition loop.
- `compliance.mjs` — the ported, cross-checked copy of `privateProviderOutcome()`'s semantic rules.
- `minimax-worker.env.example` — non-secret template for the systemd `EnvironmentFile` (see below).

## Configuration (environment variables)

Unlike the Mac worker's private JSON config file + launchd plist, this worker is meant to run as a plain systemd
service, so its **entire** configuration is environment variables — normally one `EnvironmentFile`. `enabled:
false` still requires every other value to be valid (matching the Mac worker's `config.example.json` philosophy:
"disabled" means administratively off, not "unconfigured").

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `UNSEEN_MINIMAX_WORKER_ENABLED` | no | `false` | `main()` returns `"disabled"` and exits 0 without any network activity when false. |
| `UNSEEN_PRIVATE_AI_ORIGIN` | yes | — | Must be `https://` and an exact origin (no path). |
| `UNSEEN_PRIVATE_AI_EXPECTED_HOSTNAME` | yes | — | Must match the origin's hostname; pinned separately from the URL parse, same as the Mac worker. |
| `UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE` | yes | — | Absolute path to the private-ai wire bearer token (0400/0600, re-read every request). Shared with the server's `UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE` — see "Server enablement". |
| `UNSEEN_PRIVATE_AI_TLS_MODE` | no | `system-ca` | `system-ca` or `ca-file`. |
| `UNSEEN_PRIVATE_AI_TLS_CA_FILE` | if `ca-file` | — | Absolute path. |
| `UNSEEN_PRIVATE_AI_TLS_SPKI_SHA256` | no | — | Optional certificate SPKI pin (base64). |
| `UNSEEN_MINIMAX_API_KEY` / `UNSEEN_MINIMAX_KEY_FILE` | one required | — | Exact same two names and precedence as `tools/minimax-probe.mjs`. Read once at startup; **never logged, never in a diagnostic event.** Rotate by restarting the service after rewriting the env file. |
| `UNSEEN_MINIMAX_BASE_URL` | no | `https://api.minimaxi.com` | Must be `https://`. |
| `UNSEEN_MINIMAX_VISION_MODEL` | no | `MiniMax-M3` | Also becomes the wire `model` field — must equal the server's `UNSEEN_PRIVATE_AI_MODEL`. |
| `UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS` | no | `20000` | Per MiniMax call; composition makes at most two calls (initial + one reworded retry). |
| `UNSEEN_MINIMAX_TEMPERATURE` | no | `0.6` | |
| `UNSEEN_MINIMAX_MAX_TOKENS` | no | `400` | |
| `UNSEEN_MINIMAX_WORKER_HTTP_TIMEOUT_MS` | no | `15000` | `ExactHttpsClient`'s own per-request timeout to `services/api`. |
| `UNSEEN_PRIVATE_AI_MIN_LEASE_REMAINING_MS` | no | `60000` | See "Why there is no separate poll-interval flag" below. |
| `UNSEEN_PRIVATE_AI_CLEANUP_BUDGET_MS` | no | `5000` | Reserved at the tail of the lease for the `/complete`/`/fail` round trip itself. |
| `UNSEEN_PRIVATE_AI_MAX_PIXELS` | no | `16777216` | Passed through to `PrivateAiPullProtocol`'s decode-bomb guard. |

`promptHash`/`policyHash` are **not** environment variables — they are fixed constants
(`MINIMAX_WORKER_VISION_PROMPT_HASH`/`MINIMAX_WORKER_VISION_POLICY_HASH`) derived from this worker's own pinned
prompt text, the same way the Mac worker pins its own. The operator sets the server's
`UNSEEN_PRIVATE_AI_PROMPT_HASH`/`UNSEEN_PRIVATE_AI_POLICY_HASH` to match — printed by `loadWorkerConfig()`'s
returned config for copy-paste.

### Why there is no separate poll-interval flag

Actual poll cadence is **server-dictated**: every `lease()`/`complete()`/`fail()` response carries its own
`retryAfterMs`, and `runWorkerLoop()` (this worker's own outer loop — see below) applies ±20% jitter and
exponential offline backoff (capped at 300s) on top of whatever the server says, exactly like the Mac worker's
`runPullLoop()`. The one timing knob this worker actually owns is `minimumLeaseRemainingMs`: how much lease time
must remain before it will even start a job. `enable-minimax-worker.sh` exposes that as the closest real
equivalent of "poll interval."

## SIGTERM: finishes in-flight work, then stops

`runWorkerLoop()` in `worker.mjs` is a **deliberate, documented departure** from reusing the Mac worker's
`runPullLoop()` verbatim for the outer loop. `runPullLoop()` shares one `AbortSignal` between the loop condition
and every in-flight network call, so a SIGTERM there aborts whatever lease/complete cycle happens to be running.
This worker instead gives every `worker.runOnce()` call its own, never-externally-aborted signal — a leased job's
`/complete` or `/fail` call is always allowed to land before the loop exits — while an **idle** poll sleep is
still woken immediately on SIGTERM (no waiting out a long backoff). `RemotePrivateAiPullWorker.runOnce()` itself
is reused completely unchanged, so its internal lease-expiry timer
(`minimumLeaseRemainingMs`/`cleanupBudgetMs`) still applies exactly as it does for the Mac worker — this is only
about what happens to the *outer* loop, not the per-cycle safety margins.
`tests/e2e/minimax-private-worker/remote-pull-minimax.test.mjs` has a dedicated test that gates a MiniMax call
open, sends the stop signal mid-flight, asserts nothing was sent to the server yet, then releases the gate and
asserts the `/complete` call landed before the loop actually returned.

## Server enablement checklist (for whoever runs this)

This worker alone is not sufficient to make "看图提问" work end to end — it only makes the external vision
pipeline function correctly. The full chain also needs Book Lab itself enabled and the (already-built, currently
unwired-to-anything) composition consumer running. In order:

1. **Book Lab core.** `UNSEEN_BOOK_LAB_ENABLED=true`, plus everything `infra/integration/book-lab/
   deployment-entrypoint.mjs`'s `configuration()` requires when that flag is set: `UNSEEN_API_HOST`,
   `UNSEEN_API_PORT`, `UNSEEN_PUBLIC_ORIGIN`, `UNSEEN_API_DB`, `UNSEEN_API_KEYSET`, `UNSEEN_API_MEDIA_ROOT`,
   `UNSEEN_BOOK_LAB_LOCK`, `UNSEEN_BOOK_LAB_DB`, `UNSEEN_BOOK_LAB_RENDER_TMP`, `UNSEEN_CHROMIUM_PATH`, and (per
   `services/book-lab/src/extensions/book-lab.mjs` / `memory-api.mjs`) the four distinct 32+ char secrets
   (`UNSEEN_BOOK_LAB_ETAG_SECRET`, `_WORKER_SECRET`, `_CLEANUP_SECRET`, `_RENDER_WORKER_SECRET`) plus the
   approved collection/grant notice version+hash(+copy) pairs. The collection notice must be a new version whose
   hash is the SHA-256 of its exact displayed copy and whose copy includes the canonical contextual-disclosure
   sentence: continuing the conversation sends the preceding question, 1–2 visible facts and the first 500
   characters of the user's latest answer to the configured AI processor, which may be third-party. A stale,
   incomplete, or independently hashed notice prevents Book Lab from mounting.
   See `config/rc/production.env.example` for a real (still-gated, `NO_GO`) template of the full set — this task
   does not change or approve any of it.
2. **Chromium, for PDF rendering** (`packages/book-renderer/src/pdf.mjs`). Confirmed real dependency:
   `findLocalBrowser()` shells out to a local Chrome/Chromium/Edge executable via `spawnSync` +
   `--headless=new --print-to-pdf=...`; it honors `UNSEEN_CHROMIUM_PATH` as an override and otherwise only knows
   macOS `.app` paths (dev-machine convenience, not a production install method).
   `deployment-entrypoint.mjs` requires `UNSEEN_CHROMIUM_PATH` to point at an *executable* file when Book Lab is
   enabled. `config/rc/production.env.example`'s real value is
   `UNSEEN_CHROMIUM_PATH=/snap/chromium/3507/usr/lib/chromium-browser/chrome` — i.e., production installs
   Chromium via `snap install chromium` on the Linux host and points at the resulting binary. **Unresolved /
   flag for verification**: `production.env.example` *also* references a separate, dedicated, network-isolated
   `unseen-book-renderer` systemd service talking over a Unix socket
   (`UNSEEN_BOOK_RENDERER_TRANSPORT=unseen-book-renderer-dedicated-service/v1`,
   `ops/release/unseen-book-renderer.service.example`, `infra/integration/book-lab/renderer-service.mjs`), which
   would mean the API process never spawns Chromium directly in that profile. This investigation did not
   determine whether `deployment-entrypoint.mjs` (the entrypoint this worker's composition consumer actually
   runs inside) is compatible with, or currently bypasses, that dedicated-renderer profile — treat this as
   **待验证 (needs verification by whoever owns the renderer/production-package track)** before relying on PDF
   export in the same deployment as this worker.
3. **The private-ai wire bearer token**, shared between the server and this worker (see `runbooks/release/
   PRIVATE-AI-PULL-WORKER.md` and `infra/integration/mac-codex-private-worker/README.md` step 2): generate one
   random token into an absolute 0600 file; install only its SHA-256 into another absolute 0400/0600 file at the
   path the server reads via `UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE`; give the *raw* token file's path to this
   worker via `UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE` (see `ops/server/enable-minimax-worker.sh`'s header for the
   exact expectations it checks).
4. **The private-ai queue itself**: `UNSEEN_PRIVATE_AI_WORKER_ENABLED=true`,
   `UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE`, `UNSEEN_PRIVATE_AI_PROMPT_HASH`/`_POLICY_HASH` set to **this
   worker's own** `MINIMAX_WORKER_VISION_PROMPT_HASH`/`MINIMAX_WORKER_VISION_POLICY_HASH` (not the Codex
   worker's — they are deliberately different prompts with different hashes), `UNSEEN_PRIVATE_AI_MODEL` /
   `_MODEL_VERSION` set to match this worker's `UNSEEN_MINIMAX_VISION_MODEL` / the computed
   `minimax-private-worker/1/<model>` string.
5. **This worker**: run `ops/server/enable-minimax-worker.sh` as root (see that script's own header for its full
   parameter list) — it writes `/etc/unseen/minimax-worker.env` (0600), installs
   `ops/server/unseen-minimax-worker.service`, and starts it.
6. **Confirm the composition consumer is actually running.** `infra/integration/book-lab/
   private-ai-composition.mjs`'s `createPrivateAiComposition()` is already instantiated inside
   `deployment-entrypoint.mjs` whenever `config.privateAiEnabled` is true — nothing new needs wiring there. It is
   the piece that drains `private_ai_composition_outbox` into `bookRuntime.ingestPrivateQuestionResult()`
   (successful completions) / `recordQuestionProviderUnavailable()` (retryable failures), and the piece that
   turns Book Lab's own `startQuestion`/`requestFollowup` calls into `enqueuePrivateAiPhoto()` calls in the first
   place. Confirming it is live is just confirming step 1 and step 4 are both on in the same process.

None of this task's changes flip any of `UNSEEN_BOOK_LAB_ENABLED`, `UNSEEN_PRIVATE_AI_WORKER_ENABLED`, or any
other production switch — every value above is `false`/unset in the checked-in example, matching the "default
off, no SLA" status this worker is explicitly labeled with.

## Deterministic verification

```sh
node --test tests/e2e/minimax-private-worker/*.test.mjs
node --check infra/integration/minimax-private-worker/worker.mjs
node --check infra/integration/minimax-private-worker/minimax-vision-analyzer.mjs
node --check infra/integration/minimax-private-worker/compliance.mjs
UNSEEN_MINIMAX_WORKER_ENABLED=false \
  UNSEEN_PRIVATE_AI_ORIGIN=https://unseen.example.com \
  UNSEEN_PRIVATE_AI_EXPECTED_HOSTNAME=unseen.example.com \
  UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE=/etc/unseen/minimax-worker/private-ai.token \
  UNSEEN_MINIMAX_API_KEY=placeholder \
  node infra/integration/minimax-private-worker/worker.mjs
```

The last command must exit 0 without any network activity: `loadWorkerConfig()` still validates every field even
though `UNSEEN_MINIMAX_WORKER_ENABLED=false` (matching the Mac worker's "disabled means administratively off,
not unconfigured" convention — see `minimax-worker.env.example` for the fully-populated, still-disabled
EnvironmentFile shape a real deployment starts from), and `main()` returns `"disabled"` before opening any
connection. A live MiniMax smoke test is what `tools/minimax-probe.mjs` is for; this worker's own tests never
make a real network call — every HTTPS and MiniMax interaction is a fake/self-signed-TLS fixture
(`tests/e2e/minimax-private-worker/remote-pull-minimax.test.mjs`'s server,
`minimax-vision-analyzer.test.mjs`'s injected `fetchImpl`).

## Known limitations

- **The contextual v2 lease changes the privacy surface.** It still omits source identifiers and sends only the
  latest bounded exchange, but it now discloses user-written answer text to the configured private processor.
  Default-off status, privacy review, migration rehearsal, worker-first rollout, and live canary are required.
- **The composition path was not newly deployed by this change.** It was exercised against local fakes and a
  self-signed-TLS test server, not a real MiniMax account or production data.
- **PDF rendering's exact production shape is unresolved** — see the Chromium bullet above.
- **Key rotation is by restart**, not by hot-reload; the private-ai wire bearer token *is* re-read every
  request, but the MiniMax API key is read once at process start.
- **The contextual v2 path is not live-tested.** Its server, transport, and analyzer tests use local fixtures;
  no real private-ai server, account, or photo answer was used.
