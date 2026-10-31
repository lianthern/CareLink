# Book Lab RC seam

The API extension is lazy and default-off. Turning it on requires every value in `env.example`; no in-memory database,
generated secret, draft notice, question fixture, or renderer fallback is used.

The current candidate intentionally reports `providerConfigured=false`, `eventSourceConfigured=true`,
`rendererConfigured=true`, and `productionReady=false`. Core participant/owner/viewer currentness, the persistent Book
store, all 20 frozen API routes, two internal job boundaries, strict JSON/PDF response passthrough, and the loopback
same-origin UI host are wired. A current active owner Space is projected as the owner-scoped Event identity; BL04 binds
`BOOK.CREATE` to that route identity and rejects random, cross-space, archived, owner/session, or version-drifted access
without Book or Core business writes. Question creation still fails closed until approved facts and a real provider exist.
The question worker has a server-only `readQuestionSourceForWorker({photoId, contributorId})` Core port and re-reads the
exact current persisted source before claim and before completion. It does not synthesize an HTTP principal or use a
fixture fallback; current production Core still returns `l3Enabled=false` and no visible facts, so the provider remains
default-off and admission remains zero-write.
Render jobs use a one-shot subprocess with strict bounded JSON/bytes IPC, a 256 MiB Node heap,
timeout/process-group termination, filesystem permissions, and an environment allowlist. The full worker process tree
is wrapped by macOS `sandbox-exec`: its kernel profile denies IP outbound/bind/inbound and the system resolver socket
while retaining local Unix process-control sockets required by Chromium. A descendant probe without the JavaScript
guard must fail TCP, UDP, and DNS; the preload independently replaces Node TCP/TLS/HTTP/HTTP2/UDP/DNS, global fetch,
global WebSocket, and an installed `undici` surface with one synchronous denial function. On other targets, startup and
rendering fail closed unless the operator supplies an executable OS/container egress wrapper and the exact descendant
capability attestation from `env.example`. Canonical HTML is additionally self-contained and CSP-locked.
The worker selects the renderer's `production` profile as a server constant and never reads the profile or Chromium
launch policy from a request or manifest. The only `outerSandboxVerified=true` call occurs inside that already-wrapped
worker. Frozen output carries the complete production receipt; the adapter verifies its profile, fixture marker,
manifest equality, HTML hash, PDF hash, and bytes before reducing it to the existing Book completion contract.

The canonical HTML is served only at the authenticated BL06 UI route
`/s/:spaceId/books/:bookId/versions/:versionId`. There is no second HTML artifact URL. Every read re-enters the same 8A
authorization/source-currentness checks before bytes are returned.

Run `node infra/integration/book-lab/deployment-entrypoint.mjs` under the service manager. The process owns a PID/token
operation lock, captures both Core and Book runtime handles, proxies Core through the same origin when Book is enabled,
and closes public listener → internal Core listener → timer → Book store → Core store → lock on SIGINT/SIGTERM or start
failure. TLS terminates at the reverse proxy; preserve the exact `Host` and `Origin` represented by
`UNSEEN_PUBLIC_ORIGIN`. The flag-off path never imports the Book business bundle or creates the Book database.
