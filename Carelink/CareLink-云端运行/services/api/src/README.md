# UNSEEN local canonical API

This Node 22 implementation adds no npm dependencies, but it does have an external decoder runtime dependency. It uses `node:sqlite`, a replaceable local MediaStore port under `src/ports/media/**`, domain-separated keyed MACs, explicit idempotency replay classes, multi-resource CAS, append-only audit/deletion events, and deterministic local jobs.

Run:

```sh
npm --prefix services/api start
```

Environment:

- `UNSEEN_API_HOST` defaults to `127.0.0.1`.
- `UNSEEN_API_PORT` defaults to `8787`.
- `UNSEEN_API_DB` defaults to `services/api/local.sqlite`.
- `UNSEEN_API_KEYSET` defaults to `services/api/local.keyset.json`.
- `UNSEEN_API_MEDIA_ROOT` defaults to `<resolved UNSEEN_API_DB>.media`.
- `UNSEEN_FFPROBE_PATH` defaults to `ffprobe` resolved from `PATH`.
- `UNSEEN_FFMPEG_PATH` defaults to `ffmpeg` resolved from `PATH`.
- `UNSEEN_BOOK_LAB_ENABLED` defaults off; only exact `true` attempts the fixed lazy import
  `src/extensions/book-lab.mjs` before the server listens.
- `UNSEEN_OTP_DELIVERY_PROVIDER` defaults to `disabled`. The deployment entrypoint accepts exact `smtp` only with
  `UNSEEN_SMTP_HOST`, `UNSEEN_SMTP_PORT`, `UNSEEN_SMTP_SECURITY=implicit_tls|starttls`, `UNSEEN_SMTP_USERNAME`,
  normalized `UNSEEN_SMTP_FROM`, and an absolute `UNSEEN_OTP_PROVIDER_SECRET_FILE`. Optional timeout controls are
  `UNSEEN_SMTP_CONNECT_TIMEOUT_MS`, `UNSEEN_SMTP_SEND_TIMEOUT_MS`, and the absolute whole-delivery deadline
  `UNSEEN_SMTP_TOTAL_TIMEOUT_MS` (default 30 seconds, maximum 50 seconds).

The Book Lab runtime host reuses `LocalApi.handle`: it validates extension routes and internal jobs against the
generated Book contract, stages every registration, and publishes routes/jobs only after the whole registration
succeeds. Repeated mounts are idempotent. When the flag is off, the business module is not imported and no route,
job, callback, or DB write occurs. When on, missing/invalid/partial registration fails startup without a partial
mount. The extension receives no DB or `Core` object. Its contributor callback revalidates only an account or exact
receipt-bound source photo, and its audit callback accepts only a strict `book_lab_*` namespace.

This host closes the inert-loader runtime gap, not the fixed Core RC. `readCorePhotoContext` returns the exact frozen
`SourceProvenance` only for the current contributor, live validated asset, current ready scene/panorama, visible photo,
confirmed current placement, and a trusted timezone-qualified capture time. Missing or conflicting metadata fails
closed; upload, batch, item, placement, filesystem, and server times are never substituted. Book route/eligibility
fields remain absent from the frozen Core read DTOs and hidden rather than inferred from view access.

Persistent databases require both a stable keyset and the durable filesystem MediaStore. The media root is mode `0700`; objects are mode `0600`, atomically linked into isolated key paths, content-hashed on every read, and never overwritten. A persistent `LocalApi` without an explicitly durable store fails with `durable_media_store_required`; only `:memory:` tests may use `MemoryMediaStore`. On the first start only, when the database does not yet exist, the local process atomically creates the explicit keyset file with mode `0600`; later starts reuse it. A missing keyset beside an existing database, corrupt JSON/key material, a symlink, wrong owner, or group/other permissions fails startup with `keyset_unavailable` or `keyset_permissions_invalid`. Removing a previous identity epoch while an active equivalence still uses it fails with `identity_key_retirement_incomplete`; retirement requires the exclusive all-table `IDENTITY.REKEY_EQUIVALENCES` operation, never opportunistic login-time rewrites. The file supports one current key and up to two previous key IDs for bounded rotation. Only `:memory:` tests may use ephemeral keys. The keyset and media root must never be committed or printed.

OTP delivery uses the injected `OtpDeliveryPort` (`{ name, async deliver(message) }`). Challenge creation writes one encrypted outbox row in the business transaction; provider I/O runs only after commit. The stable `message.deliveryId` **must** be used as the downstream provider idempotency key: a crash after provider success and before local finalize intentionally causes at-least-once redelivery with the same ID and payload. Failed sends remain queued with a lease and stable error code; startup and the local interval drain queued work. An invalid sealed payload is terminally discarded without provider I/O. Full email addresses and OTP codes exist only inside the keyring-sealed payload and are cleared after terminal delivery/discard.

`otpSink` remains an explicit local/test adapter and is invoked through the same post-commit outbox. A persistent `LocalApi` with neither `otpDelivery` nor `otpSink` starts degraded, returns `503 otp_delivery_unavailable` for challenge creation, and reports `otpDelivery.ready=false` on `/healthz`; it never claims that an OTP was sent. Track 1B supplies the deployment adapter without changing identity business APIs.

The generic SMTP adapter is dependency-free and default-off. It requires certificate-verified TLS 1.2 or newer, using
implicit TLS or mandatory STARTTLS, and never exposes a switch to disable certificate verification. Its password is read
only when `smtp` is selected, from a regular non-symlink file owned by root or the service identity with exact mode `0400`
or `0600`. The adapter allows one in-flight send; the existing Core issuance buckets and serial encrypted outbox remain
the rate, retry and idempotency authority. Every SMTP phase shares one absolute deadline, and deployment composition
requires that deadline plus a five-second cleanup grace remain below the outbox's 60-second lease. SMTP acceptance is
at-least-once, not exactly-once. A stable opaque
`Message-ID` derived from `deliveryId` supports downstream duplicate suppression without disclosing the outbox ID.

Photo upload authorization returns a browser-consumable one-time `{url, headers}`. The local direct-object adapter uses `PUT /__local/media/direct/{exactPrivateObjectKey}`: the credential remains only in `X-Upload-Ticket`, the URL contains no credential, the PUT is create-only, and it does not mutate upload/session/photo state. `POST /v1/upload-sessions/{uid}/commits` then HEAD/GETs and hashes the exact immutable object before one session/item CAS advances the upload.

Deployment may replace only the injected `UploadAuthorizationPort` and `MediaStore`; those adapters sign/write/read the bound object and never receive database access. Provider account credentials stay server-side. The browser receives only the short-lived exact-object capability.

The legacy local proxy remains available at `PUT /__local/media` with the ticket in `X-Upload-Ticket`. Add `X-Media-Kind: panorama` for panorama objects. Both local endpoints are transport adapters, not canonical business mutations. Canonical commit endpoints always re-read and validate server-observed bytes.

Media validation requires local `ffprobe` and `ffmpeg` executables. Probe with `command -v ffprobe`, `command -v ffmpeg`, `ffprobe -version`, and `ffmpeg -version`. They run via `spawn()` with `shell:false`, constant argv, media over stdin, one decoder thread, an 8-second timeout, a 32 MiB input cap, a 2 MiB combined output cap, and a two-process fail-closed semaphore. POSIX children are detached into their own process group and the group is `SIGKILL`ed before timeout/output-limit completion returns. Results expose stable error cause, duration, signal, PID, and termination state without logging input, raw URL, IP, or full UA. Missing/busy decoders return `media_decoder_unavailable`; timeout/crash/corrupt input returns a stable decode rejection. Nothing falls back to header-only acceptance. Capture-time retention is limited by media notice v2 to timezone-qualified `DateTimeOriginal` plus `OffsetTimeOriginal` (or zoned `creation_time`), while GPS and device serial metadata remain discarded. Legal approval of this notice remains a formal-release blocker. The exact audited version/build flags are recorded in `tests/DECODER-RUNTIME-EVIDENCE.md`.

Run all API, schema, concurrency, replay, authorization, media, lifecycle, and job-dispatch tests offline:

```sh
npm --prefix services/api test
```

Exports are assembled by the deterministic `export_generation` dispatcher into a local JSON artifact. Download credentials are one-time, short-lived, account-session-bound keyed hashes delivered in `X-Export-Download`; they never appear in a URL/path/referrer. Idempotent authorization replay rotates the credential and invalidates the prior one.

Deletion requests enqueue `deletion_execution`; use the exported async `dispatchDeletion(db, mediaStore, jobId)` local worker. It claims in one short transaction, revokes scoped authorization, deletes media outside the transaction, and CAS-finalizes an append-only status/attempt ledger. Media errors append a per-resource failure and return the same job to `queued` for retry; they never become false terminal completion. A synchronous dispatcher rejects this job type with `async_dispatch_required` rather than reporting fake success.

Track 5 can drive queued work through the Node-stdlib `dispatchLocalJobs()` seam in `services/jobs/dispatch/local-runtime.mjs`. Its deterministic locator fixture is off by default. Explicit enablement writes the fixed local-only policy release and labels every fixture result with `mode=deterministic_local_fixture` and `isProduction=false`; it never contacts a model or cloud service.

This remains deliberately unsuitable for production. The local viewer-safe derivative path removes source metadata during an isolated decode/re-encode and is byte/hash tested, but production KMS/OS Keychain, durable cloud media, OTP delivery, real model execution, decoder CPU/RAM sandboxing beyond the local limits above, production derivative quality review, explicit sRGB conversion, FFmpeg/codec licensing and redistribution review, vulnerability inventory, and a complete SBOM remain Track 6A / Release **NO-GO** gates. HEIC/HEIF is accepted only when the installed decoder fully decodes that exact input. This implementation must not be described as zero-external-dependency, production-ready, distributable, or app-store-ready.

### Account and publication administration

`POST /v1/auth/register` creates a pending password identity without issuing a
session. First-time OTP identities also return a pending registration. Existing
identities are backfilled as active by migration 0023. Admission is checked at
session issuance and every authenticated read/write; status transitions advance
the session epoch and revoke prior sessions. No username grants administrator
rights.

Grant a role to an explicitly reviewed, active account using its exact ID:

```sh
UNSEEN_API_DB=/absolute/existing/unseen.sqlite node services/api/scripts/grant-admin.mjs acct_EXACT_ID
```

The CLI refuses missing databases and usernames, is idempotent, and records the
operator action. All HTTP administrative mutations require existing session and
idempotency protections, an expected record version, and a reason. The current
administrator cannot disable itself; the last active administrator also cannot
use the old account-deletion route to remove its role.

Only an owner's explicit submission makes a memory visible for review. The
submission copies the document and each referenced media item into reserved,
immutable encrypted personal-memory records. These use the established key
rotation, export, quota and account deletion paths. Private edits do not change a
submitted or published version. Public lists use only persisted card metadata,
return at most 100 newest entries, and never decrypt full media. Every public
media read checks the publication and owner account state and sends `no-store`.
See `.task/admin-console/API-CONTRACT.md` at the repository root for routes.

Rollback constraint: accounts still use the original lifecycle status column;
admission lives in the additive administration table. An older API binary does
not enforce pending/disabled admission. Do not roll back to that binary while any
such identities exist. App rollback can keep the new API running; never restore
an old database over new registrations or submissions.

### Authorized private administrator inspection

The later explicit administrator-inspection authorization also allows active
administrators to inspect verified full emails and an account's live private
memories at `/v1/admin/accounts/:accountId/moments`. This is independent of
publication consent: reading never submits or publishes anything. The earlier
paragraph's submission-only visibility applies to publication review, not this
separately authorized inspection route.

Email recovery uses the existing identity envelope AAD, decryption and collision
check, only through current active verified relationships. Unavailable identity
envelopes produce `emailUnavailable: true`; accounts without email produce
`email: null` and `emails: []`. No passwords, password hashes or tokens are
returned. Full emails are not stored in mutation response caches.

Private detail returns `targetAccountId`, `moment` and `version`. Its rewritten
media routes require current administrator authority, target lifecycle, moment
ownership and media references on every request. Disabled target accounts remain
inspectable; deleted/deleting targets and trashed records do not. Successful
account/list/detail/media reads record stable target IDs and fixed action names,
never identity or conversation contents. All administrator responses are
`no-store, private`. Exact contract: `.task/admin-inspection/API-CONTRACT.md`.

### Administrator account operations

Administrators can manage another account's role or revoke its active sessions
through the versioned `/role` and `/sessions/revoke` routes. True role changes,
including CLI grants, require the target to sign in again. Self-role changes,
self-session revocation and removal of the last active administrator are blocked.

Account detail includes safe profile, credential-presence/update metadata,
verified-email relationship history, serialized-record storage usage and quotas.
Separate paginated reads expose safe session and submission metadata, owned
spaces, bounded job metadata and current safe photo/video previews. Full stored
panorama/depth assets and current profile avatars have dedicated administrator
routes. Async media reads recheck authorization, ownership, lifecycle and asset
currentness before returning bytes. No object keys, payloads, hashes of passwords,
credentials, fabricated device/IP activity or new generated content are exposed.
See `.task/admin-operations/API-CONTRACT.md` for exact fields and query filters.
