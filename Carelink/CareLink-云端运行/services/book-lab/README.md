# @unseen/book-lab · Track 8A Memory and draft slice

Private, fixture-backed implementation of the frozen L3 Memory interview contract. It is deliberately separate from
Core: the injected Core port has read methods only, and this package has no upload, placement, album, Viewer, Core
extension, or release-enablement route.

Implemented product reads and mutations:

- `MEMORY.OPEN` and its contributor-scoped Memory detail read;
- `MEMORY.START_QUESTION` / `MEMORY.SKIP` with absent-or-present interview CAS;
- `MEMORY.SAVE_ANSWER_DRAFT`, `MEMORY.REQUEST_FOLLOWUP`, `MEMORY.CONFIRM`, and `MEMORY.WITHDRAW`;
- `BOOK.OPEN_LAB`, `BOOK.CREATE`, `BOOK.OPEN_DRAFT`, `BOOK_MEMORY.AUTHORIZE`, and `BOOK_MEMORY.WITHDRAW`;
- `BOOK.EDIT_TITLE`, `BOOK.REMOVE_PAGE`, and `BOOK.REPLACE_PAGE_PHOTO`, each appending a new immutable draft row;
- `BOOK.FREEZE`, which atomically revalidates an exact ready preview and persists one immutable `BookVersion`,
  manifest header/pages, verbatim authorized-text snapshots, local asset bytes, access control, and render job;
- the contract's `QUESTION_PROCESSOR`, backed by persistent job rows and complete recovery DTOs.
- `BOOK.GENERATE_PREVIEW` and the preview-only branch of `BOOK_RENDER_PROCESSOR`, backed by a persisted immutable
  snapshot and recoverable render job. Claim and completion are two separate worker calls: this service returns one
  deeply frozen JSON envelope and accepts only an exact renderer hash/equality receipt. It never executes renderer
  code in-process; Track 8C must run the renderer in its network-denied subprocess boundary.
- the frozen HTML/PDF branch of `BOOK_RENDER_PROCESSOR`, exposed as two internal calls
  `processFrozenRender` / `completeFrozenRender`. It claims only persisted immutable input and accepts canonical HTML,
  `%PDF-` bytes, content hashes, page count, and the exact 8B equality ledger before making a version available.
- `BOOK.OPEN_PREVIEW`, which returns the frozen `BookPreviewDTO` only after validating the canonical HTML bytes/hash,
  and `BOOK.DOWNLOAD_PDF`, which returns the exact PDF bytes with strict length/hash/disposition headers;
- `BOOK.START_NEW_VERSION`, which starts one owner-CAS draft from the current frozen version and excludes withdrawn or
  source-revoked pages without mutating the old frozen manifest; only the required denial status overlay may change.

Every mutation requires `Idempotency-Key`. ETags are HMAC capabilities, not encoded version strings. Answer and
confirmation mutations use the Memory ETag plus the body's exact interview version. Follow-up uses one opaque ETag
covering the current PersonalMemory version and current question-job id/version; clients must not parse or synthesize
it. Withdrawal commits a denial row before returning, then a persisted cleanup outbox removes reconstructable text.

The in-memory default provider remains an explicit `fixture-question-v1` test helper. The production/private-test
provider result is the exact object `{modelVisibleFacts,question,questionIntent,model,modelVersion,latencyMs}` under
policy `photo_visible_facts_question_v1`; `questionIntent` is only `photo_context`. It accepts one or two unique
objective visible observations and one bounded question, then rejects identity, sensitive-attribute,
emotion/relationship inference, image-text instructions, unrelated questions, extra fields, and model/version drift.
The accepted worker question is preserved instead of being replaced by a deterministic template.

Model facts live only in the additive private `memory_model_fact_drafts` aggregate. They are bound to the Book job,
attempt, lease, input hash, photo content hash, placement revision/snapshot, model/version, prompt hash, and policy
hash. They never enter Core, a public Memory DTO, a grant, or a Book page. Its audited CAS flow is
`pending -> draft_ready -> question_ready -> answered -> confirmed|withdrawn`; retries remain `pending`, and
withdraw/skip clears the fact text. Only the user's immutable selected answer can become a confirmed Memory, and the
existing per-entry/per-book authorization remains the only path into a Book.

Authenticated queue integration completes a pending Book job with
`ingestPrivateQuestionResult(questionProcessorRequest, completionDto, workerSecret)`. The existing request is exactly
`{jobId,jobVersion,kind,inputHash,attempt}` from `pendingQuestionJobs`. A Mac-offline/quota/timeout adapter calls
`recordQuestionProviderUnavailable(request, workerSecret)`, which keeps the job queued with bounded backoff. Existing
`MEMORY.OPEN` recovery data distinguishes ordinary pending (`status=queued`, `lastStableError=null`) from offline
retry (`status=queued`, `lastStableError=model_unavailable`) without a public DTO change. Production adapters must
keep `questionProviderConfigured: false` until this authenticated transport and fixed provider model/version,
`promptHash`, and `policyHash` are configured; false rejects start and follow-up admission before any owned write.
A fixture result is not evidence that production transport is configured.

`QUESTION_PROCESSOR` uses a persisted `queued -> running -> ready|failed|cancelled` claim/lease/complete state
machine. Claim and completion are separate short SQLite transactions; the provider call and timeout run between
them, with no transaction held across a network-capable `Promise`. Expired leases are reclaimable after process or
database restart, each claim increments `attempt`, provider requests carry a stable per-attempt idempotency key, and
a stale worker cannot overwrite a reclaimed or withdrawn job. Transient `model_unavailable` returns to `queued`
with exponential backoff rather than becoming a terminal failed interview. Production Core integration must provide the narrow
read-only port `readQuestionSourceForWorker({photoId, contributorId}): Photo|null|Promise<Photo|null>`. This port is
called before claim and again before completion and must return only the current authorized, hash-bound source; it
must not manufacture a request principal or fall back to fixture facts. `questionLeaseMs` defaults to 30 seconds and
`questionProviderTimeoutMs` defaults to 30 seconds; both are bounded configuration.

```bash
cd services/book-lab
npm run check
```

Persistent use requires separate stable `etagSecret`, `workerSecret`, and `cleanupSecret` values of at least 32
characters. Enabling preview additionally requires a separate `renderWorkerSecret` and the single v0 layout id
`book-lab-v0`; the package never executes a renderer or performs a network render. The owner Core port must implement
async-capable `readDisplayPhotoForOwner(actor, photoId): Promise<PhotoWithRenderAsset|null>` plus the existing
owner/viewer currentness predicates. `PhotoWithRenderAsset.renderAsset` is the immutable local derivative
`{bytesBase64,contentHash,sourcePhotoContentHash,sourcePhotosVersion}` bound to the current source photo. The API
revalidates the actor before and after two exact reads, then carries only a closure-backed immutable capability into
the SQLite transaction; it never holds a transaction across `await`. Preview/frozen worker claim and completion,
live HTML reads, and `handle` therefore return Promises. v0 accepts at most 256 KiB per derivative, 8 MiB per input
envelope, and 900
Unicode characters of exact user text per rendered page; a larger answer remains stored unchanged and preview
returns `preview_input_changed` rather than truncating or rewriting it. The SQLite directory and
database/WAL/SHM files are forced to `0700` and `0600`. Withdrawal uses SQLite
secure delete and does not mark purge complete until the sensitive WAL frames have checkpointed and truncated; an
interrupted cleanup remains retryable. Track 8C must provide the fixed Core read adapter and same-origin HTTP seam;
this package does not enable itself.

Every live read calls the injected current Core owner/Account/external viewer predicate, checks the version access
overlay, all exact grants and every frozen source before artifact lookup, and repeats the guard before returning. Any
failure is the uniform `book_version_unavailable`; source drift idempotently revokes and purges every affected frozen
version. The fixture Core port exists only to prove those read/revalidate calls. Track 8C must bind them to the fixed
Core seam. `BOOK.OPEN_PREVIEW` intentionally exposes no second HTML URL or HTML bytes outside the frozen JSON schema;
displaying its canonical HTML in BL06 remains a real Track 8C integration requirement.

For the two page mutations, frozen `pageVersion` maps to the current `BookDraft.draftVersionId`; clients must echo the
exact value returned by `BOOK.OPEN_DRAFT` while also sending its opaque `If-Match` value. Photo replacement changes
only `displayPhotoId`; the injected owner-scoped Core read verifies one candidate photo without exposing or mutating
the wider Core dataset.
