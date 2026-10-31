# UNSEEN 回忆时刻 account and private storage API

These additive routes use the existing canonical accounts, sessions, SQLite DB and encryption keys. They do not use public spaces or require an AI provider. Existing email OTP endpoints continue to work.

## Browser transport

Serve the app and API through the same HTTPS origin. Use `credentials: "include"` for every request. Login sets the existing `__Host-unseen_account` cookie (`HttpOnly; Secure; SameSite=Strict`); its secret is never returned to browser JavaScript. The in-process test adapter can return the secret for a trusted fixture.

Every write needs `Idempotency-Key` (8–200 chars; a UUID is appropriate). Reuse the key when retrying the same operation. Signed-in writes should also send `X-Unseen-Expected-Account-Id` from the account associated with the local outbox; a different active account returns `409 account_changed` before saving anything. This header is a guard, never a credential. Browser cookie writes require matching Origin, Host and `Sec-Fetch-Site: same-origin`; there is no separate CSRF token. Password login checks browser Origin before the first cookie too.

All JSON uses `Content-Type: application/json`. IDs for moments, photos, messages and media accept 1–96 ASCII letters/digits/underscore/hyphen; client UUIDs work. Responses and private media are not cacheable.

## Identity and profile

- `POST /v1/auth/password-login` body `{username,password}` → `{accountId,accountSessionId,sessionEpoch,expiresAt,user}` plus cookie. Usernames are trimmed, case insensitive and 3–32 characters: first alphanumeric, remainder alphanumeric, dot, underscore or hyphen. Invalid credentials return generic `401 authentication_failed`; persistent username/IP attempt budgets return 429. A successful login rotates the browser's existing session; other devices remain signed in.
- `GET /v1/me` keeps its existing response shape.
- `GET /v1/profile` → `{user:{id,username,displayName,avatar?,preferences:{photoMode:"reveal"|"clear",readReplies:boolean,continuous:boolean}},version}`. OTP-only users have `username:null`; preferences default to reveal with readReplies and continuous both true. Boolean false values persist; partial preference patches preserve omitted settings.
- `PATCH /v1/profile` accepts any of `displayName`, `avatar`, `preferences:{photoMode?,readReplies?,continuous?}`, `expectedVersion`, or `username` plus `currentPassword`. Avatar is null to clear or an owned `/v1/moment-media/:id[/preview]` URL. Username changes verify the current password. `expectedVersion` is optional but recommended to prevent profile writes from overwriting a newer device.
- `POST /v1/auth/password-change` body `{currentPassword,newPassword}` → `{changed:true,accountId,...}` plus a replacement cookie. All previous devices/sessions are invalidated. Passwords are 10–256 UTF-8 bytes; the server stores salted scrypt (N=32768, r=8, p=3) and applies bounded asynchronous hashing. If the response is lost after password change, log in with the new password.
- `POST /v1/auth/logout` keeps its existing behavior.

No public registration/password-reset endpoint is introduced. Existing OTP reauthentication for account deletion and other sensitive legacy actions continues to require a verified email; a newly seeded password-only account has no email recovery until one is deliberately attached through a later account-management flow.

## Private photo and original audio records

`PUT /v1/moment-media/:mediaId`

```json
{"kind":"audio","name":"voice.webm","mimeType":"audio/webm;codecs=opus","dataBase64":"..."}
```

Returns `{media:{id,mediaId,url,kind,mimeType,name,byteLength}}`. Upload immutable media before saving any moment referencing it. Canonical padded base64 is required without a data-URL prefix. The exact original bytes are encrypted in a separate record. Re-uploading identical content to the same ID is safe; different content with that ID returns `409 moment_media_conflict`. The app should send the expected-account guard on every upload.

Maximum original size is 12 MiB. Images: JPEG, PNG, WebP, GIF, AVIF, HEIC/HEIF. Audio: WebM, Ogg, MP4, MP3, WAV. MIME codec suffixes are accepted and normalized. Basic container signatures are checked; SVG/HTML and mismatched types are rejected. Header checks do not claim full decoding of every original.

For a photo needing a browser-compatible preview, include `createPreview:true`. The existing bounded FFmpeg decoder validates and creates a JPEG; the response also includes `previewUrl`, `width`, `height`. HEIC/HEIF conversion works only when installed FFmpeg can decode that specific file; unsupported/corrupt input returns `422 media_decode_rejected` and creates no media record. The original is never replaced. Client-converted JPEG uploads can omit `createPreview`.

`GET /v1/moment-media/:mediaId` returns authenticated original bytes. `GET /v1/moment-media/:mediaId/preview` returns the optional JPEG. Both enforce account ownership, `nosniff`, same-origin resource policy, and bounded single-range byte requests (`206`) for audio playback. Neither URL contains access tokens.

## Continuous memories

- `GET /v1/moments` → `{accountId,moments:[{id,title,createdAt,updatedAt,status,version,photoCount,messageCount,coverPhotoUrl}]}`. An empty account returns an empty array, with no sample records.
- `GET /v1/moments/:id` → `{accountId,moment,version}`.
- `PUT /v1/moments/:id` body `{expectedVersion,moment}` → `{accountId,moment,version,replayed?}`. Use version 0 for a new document and the returned current version afterward. Stale concurrent writes return `409 version_conflict`; the client must retain its pending changes and merge/reload rather than silently overwrite them. A retried completed write may return the latest document/version.

```json
{
  "id":"memory-uuid",
  "title":"那个下午",
  "createdAt":"2026-09-05T00:00:00Z",
  "updatedAt":"2026-09-05T00:00:00Z",
  "status":"active",
  "photos":[{"id":"photo-uuid","name":"照片.jpg","mediaId":"preview-uuid","url":"/v1/moment-media/preview-uuid","originalMediaId":"original-uuid","width":1200,"height":900}],
  "messages":[{"id":"message-uuid","role":"user","text":"记得当时……","photoId":"photo-uuid","createdAt":"2026-09-05T00:00:00Z","audio":{"mediaId":"voice-uuid","url":"/v1/moment-media/voice-uuid","duration":6.2,"waveform":[0,0.3,1,0.2]}}],
  "context":{"summary":"供下一轮使用的摘要","throughMessageId":"message-uuid"},
  "preferences":{"photoMode":"reveal"}
}
```

Messages retain complete text and optional original audio. Waveform samples are normalized floats 0–1, up to 4096; duration is seconds, up to 3600. All message/photo IDs must be unique in their arrays; photo references must exist. Photo and audio ownership are verified; supplied URLs are normalized to the corresponding private media routes. A photo can use the `/preview` URL when its media has a server preview, and may use the same ID as `originalMediaId`. `originalUrl` is derived by the server. Extra message fields (e.g. a local status) and provider-independent `context` data are preserved; they are inert JSON, not instructions interpreted by this service.

A moment document is limited to 8 MiB, without a small turn-count limit. Full raw history remains in the document while `context` can hold rolling summaries. Photos, original voices and profiles are encrypted in the established private-record store, so backup, key rotation, account export and account deletion include them. Legacy `/v1/me/memories` lists do not show the new typed records. The existing account quota is 128 MiB of JSON records (base64 adds overhead), max 1000 records across snapshots/moments/media/profile; exhausted accounts receive `413 memory_storage_limit`. Pagination, external object-storage capacity growth and orphan-media cleanup are future extensions; they must not silently truncate history.

## Create the empty operator-provisioned account

Requires Node 22+, explicit database and keyset paths. The script does not overwrite a username, existing account or credential file, and never prints a password. Generated/env-supplied credentials are written to a new mode-0600 file.

```sh
UNSEEN_API_DB=/absolute/private/account.sqlite \
UNSEEN_API_KEYSET=/absolute/private/account.keyset.json \
UNSEEN_SEED_CREDENTIALS_FILE=/absolute/private/unseen-credentials.json \
node services/api/scripts/create-password-account.mjs
```

Default username: `unseen`. Set `UNSEEN_SEED_PASSWORD` via the process environment if a chosen password is needed; otherwise a random password is generated. `UNSEEN_SEED_USERNAME` can provision a different username. Do not paste secrets into commands, logs or task output. The script creates zero memory/media/profile records.

For an isolated local fixture, start the existing API with the same DB/keyset, a new media directory, and an unused loopback port:

```sh
UNSEEN_API_DB=/absolute/private/account.sqlite \
UNSEEN_API_KEYSET=/absolute/private/account.keyset.json \
UNSEEN_API_MEDIA_ROOT=/absolute/private/media \
UNSEEN_API_HOST=127.0.0.1 UNSEEN_API_PORT=18897 \
node services/api/src/index.mjs
```

The canonical proxy must forward the new route families and allow ~17 MiB authenticated media JSON, ~9 MiB moment JSON; it must retain cookies, Origin handling, Idempotency-Key, Range, and the expected-account guard. Production provisioning/deployment is a separate explicit operator action.

## Narrow production provisioning and rollback

1. Resolve the running canonical API's actual DB, keyset, runtime user and release directory from its service configuration. Use those existing paths; never point the seed command at a copied fixture DB or temporary keyset. Take a consistent SQLite online backup (including any outstanding WAL through SQLite's backup operation) and keep the matching keyset/private media backup before rollout.
2. Install the additive backend release and let the existing migration runner apply migration 0020. Keep the previous release available. Run the seed CLI as the same runtime user, with `UNSEEN_API_DB` and `UNSEEN_API_KEYSET` set to those resolved existing files and `UNSEEN_SEED_CREDENTIALS_FILE` pointing to a new file in a mode-0700 private directory. Omit `UNSEEN_SEED_PASSWORD` to generate one. The CLI reports only username, account ID and credential-file location. If `username_already_exists`, stop provisioning; do not change the existing user's password or erase its data.
3. Read the credential file inside the smoke-test process; do not print it or place the password in shell arguments. Check login, `GET /v1/profile`, and that `GET /v1/moments` is empty for the newly created account. Keep the credentials file owner-only and deliver it through the user's established private channel.
4. If the frontend rollout needs rollback, restore the prior frontend release while retaining the additive canonical backend/schema. Do not drop migration 0020, truncate typed records, reset the unseen password, or replace the live DB from the pre-rollout backup after any real write. A code rollback should preserve the DB, keyset, raw media, and credential file. If backend rollback is necessary, pause new moment writes first and retain the DB/keyset backup plus the new records; the older API does not understand typed-record filtering. Provisioning rollback means leaving the new account unused until a deliberate account-management decision, not deleting unrelated accounts or content.

The supervised `infra/integration/local-operable.mjs` entrypoint routes all `/v1/` requests to `createLocalHttpServer`; it does not impose a separate smaller request-body cap. Moment, media, profile and password routes bypass its legacy viewer adapters to preserve canonical JSON and exact arbitrary audio byte ranges. This is covered by the real-process `local-operable-moment.test.mjs` in `server_staging` mode, including public-origin/Host checks and authenticated JSON larger than 1 MiB.
