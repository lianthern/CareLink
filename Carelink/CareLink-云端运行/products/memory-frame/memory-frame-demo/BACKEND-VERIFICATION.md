# Backend verification

Run from the repository root with Node 22+:

```sh
node --test memory-frame-demo/test/*.test.js
```

Install the existing server dependencies before running the actual SDK contract test. It resolves `@cloudbase/node-sdk` from the server installation or `NODE_PATH`; without it that one test is explicitly skipped. No new production dependency was added.

## Verified locally

Eleven tests passed on 2026-09-23. The HTTP tests start actual loopback servers on ephemeral ports, use separate owner/frame sessions, upload PNG/WAV bytes and download/compare the received bytes. Tests also cover concurrent send/upload retry deduplication, redundant-file cleanup, restart persistence, receipt races, cross-family restrictions, frame restrictions, object query injection, expired/revoked pairing, device revocation, malformed media, metadata write failure cleanup, original audio after AI failure, edits during both ASR and summarization, persisted process leases, lease recovery, stale-worker fencing, and optimistic-update conflict retry.

AI is injected only by tests; tests do not assert any real provider succeeded. CloudBase 3.18.3 and its database 1.4.3 implementation were inspected in an isolated temporary installation. The actual SDK test stubs its network request and checks `where({_id, _rev: command.exists(false)}).update(...)` serialization plus the returned `updated` count. This supplements the adapter conflict test; **it is not a live cloud database or storage test**. Official update API: https://docs.cloudbase.net/en/api-reference/server/node-sdk/database/update .

## Compatible changes

- Existing actions and request fields are retained. `invite` adds `id`; owner `revoke` now accepts an invitation ID as well as a session ID. Revoking an invitation stops future joins; revoke an existing session separately to disconnect it.
- Identical upload bytes from the same session/family return the same file ID. IDs are opaque as before. A concurrent losing upload removes its redundant physical file. A known failed metadata write removes its uploaded file.
- AI processing uses an atomic persisted five-minute lease with a unique owner token. Another instance skips a currently leased message; an expired lease can be retried. Every AI write merges against the latest document and verifies its lease, preserving manual edits and soft deletion.
- Cloud document mutation uses revision-based conditional update with bounded conflict retries, including old documents without a revision. SDK response error codes are checked rather than treated as successful writes.
- Local persistence only publishes in-memory changes after the atomic rename succeeds.

## Demo limits / deployment checks

- No live CloudBase, ASR or model request was made here. Total controller must verify cloud collection permissions, conditional update behavior, file upload/download and provider behavior after deployment.
- LocalStore supports one server process per data directory. Its queue is not an inter-process file lock. CloudStore is the multi-instance adapter.
- Leases reduce duplicate provider calls and fence stale results; they do not guarantee exactly-once external calls after a worker crash/lease expiration. No automatic background retry is introduced; call process again after expiration.
- Upload failures and concurrent retries clean up known redundant files. A process crash between physical upload and metadata persistence, ambiguous cloud response, or deletion failure can still leave an orphan requiring operator cleanup. Unsent drafts are retained, and there is no periodic garbage collector.
- Media checks enforce WAV layout and image structure, not a full JPEG/PNG decoder. Demo quotas remain approximate under simultaneous requests. Signed media links already issued can remain usable until their short expiration after session revocation.

## Manual-text integration follow-up

`process` returns additional compatible fields `state` and `retryAfterMs`. A completed record returns `already-done`, an active lease returns `processing` immediately, and a completed request reports its resulting `aiStatus` (`done`, `failed`, or `ready-text`). `retryAfterMs` is remaining lease time, not a promised provider completion time. Original audio is unchanged; an existing nonempty `editedText` skips ASR and is used for organization. Empty manual summary does not confirm a new card. Saving only original text preserves an already-confirmed card. Changed original text makes an unconfirmed card eligible for organization again, and a text change while a summary is in flight discards the stale result and leaves `ready-text` for another request. Regression tests cover these states and confirmed-card preservation.
