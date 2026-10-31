# UNSEEN staging start, migrate, back up, and roll back

This package composes the accepted Core slice and Book 8B fixture on one origin. Core locator, Book questions/content, OTP delivery, and media storage remain visibly labelled staging adapters. It does not enable real AI, cloud writes, or production release.

Package revision and product inputs are intentionally distinct. `git rev-parse HEAD` identifies the Stage package revision actually being operated. The launcher emits and independently verifies Core product pin `2cfb25f7da1cbdab901a1f731326c8dfaad6a765` byte-for-byte across `services/api`, `services/jobs`, `apps/web`, and `packages/viewer`, while allowing later Track5-only package/evidence changes. The Book fixture checkout is pinned to accepted commit `7d3590d3329252f4226adb2a751ffe9a2384d390`; launch fails closed if that checkout is missing, dirty, or at another commit.

Provision Book as a detached checkout from the package repository before launch (the commit object must already be present in the delivered repository):

```sh
git worktree add --detach /opt/unseen/book-web 7d3590d3329252f4226adb2a751ffe9a2384d390
test "$(git -C /opt/unseen/book-web rev-parse HEAD)" = 7d3590d3329252f4226adb2a751ffe9a2384d390
test -z "$(git -C /opt/unseen/book-web status --porcelain)"
```

## One-command start

Local loopback remains the default:

```sh
UNSEEN_BOOK_WORKTREE=/absolute/path/to/detached/book-web node --env-file=config/rc/local-staging.env.example infra/integration/local-staging.mjs
```

For a server staging checkout, copy `config/rc/server-staging.env.example` outside Git, replace every example host/path, set the file to mode `0600`, then use the same stdlib launcher:

```sh
node --env-file=/etc/unseen/server-staging.env infra/integration/local-staging.mjs
```

`server_staging` requires a clean Core checkout, exact clean Book checkout, absolute private paths, an external HTTPS origin, explicit fixture-provider disclosure, and `access_controlled_tls_reverse_proxy` acknowledgement. The process still binds only `127.0.0.1`; an occupied fixed server port fails instead of silently moving. `production` deliberately fails with `production_runtime_not_implemented` until Tracks 1B/3B/6B/8C replace the fixture seams.

Readiness is `GET /__staging/healthz` with `x-unseen-staging: true`. `RUNNING.json` remains an auxiliary diagnostic marker. Mutual exclusion is enforced by the data-root-scoped atomic directory beside the data root (for `/var/lib/unseen/staging/core-data`, `/var/lib/unseen/staging/.core-data.operation-lock`) so an empty-target restore remains possible. Its owner token is `0600`, its directory is `0700`, and only the matching owner releases it after clean stop. Launcher, backup, and restore all use this lock; deleting or losing `RUNNING.json` cannot permit a concurrent operation. The supervisor chooses loopback-only child ports, applies umask `077`, validates the exact public Host, strips Core cookies before Book proxying, and continuously probes both children.

## Reverse proxy, domain, and TLS boundary

The external proxy is responsible for DNS, TLS, and authentication/access allowlisting before any request reaches UNSEEN. It must proxy only to `127.0.0.1:$UNSEEN_STAGING_PORT`, preserve the original `Host` exactly, preserve request bodies, and never expose the private child ports. Do not bind the Node process to `0.0.0.0`.

After configuring the proxy:

```sh
curl --fail --silent --show-error https://staging.example.com/__staging/healthz
```

Before DNS is live, the same Host guard can be checked locally:

```sh
curl --fail --silent --show-error -H 'Host: staging.example.com' http://127.0.0.1:4282/__staging/healthz
```

The response must say `status: ok`, `listener: loopback_only`, `deploymentMode: server_staging`, `productionReady: false`, and disclose both fixture providers. A `400 request_host_invalid` means the proxy did not preserve the configured Host.

## Consistent private snapshot and restore

Stop the supervisor and wait for both `RUNNING.json` and the operation-lock directory to disappear before backup or restore. The tool atomically claims that same lock before reading or restoring data, rejects a live PID as a secondary check, refuses symlinks/special files and dirty deployed checkouts, copies SQLite plus WAL/SHM, keyset, media, and Book artifacts, verifies SQLite on an isolated temporary copy, hashes every restored byte, and normalizes snapshot/restore permissions to directories `0700` and files `0600`.

A lock left by a crash fails closed and is never guessed stale or automatically deleted. Recovery is an audited operator action: preserve `owner.json`; independently prove its PID is absent and that no launcher, backup, or restore process uses this exact data root; record the incident and data path; then rename the whole lock directory to a dated `.recovered-*` evidence path. Start only after a second check of the preserved owner record. Retain that renamed directory with the incident record instead of silently deleting it.

Create and verify a named snapshot:

```sh
UNSEEN_STAGING_SNAPSHOT_ID=pre-release-2026-08-14 node --env-file=/etc/unseen/server-staging.env infra/integration/staging-snapshot.mjs backup
UNSEEN_STAGING_SNAPSHOT_DIR=/var/backups/unseen/staging/pre-release-2026-08-14 node --env-file=/etc/unseen/server-staging.env infra/integration/staging-snapshot.mjs verify
```

Each `manifest.json` binds the byte inventory to the exact Core and Book commits. Restore refuses a running service, existing target directories, or code whose two commits do not match that manifest. Move the current directories aside first; do not delete them:

```sh
mv /var/lib/unseen/staging/core-data /var/lib/unseen/staging/core-data.failed-2026-08-14
mv /var/lib/unseen/staging/book-artifacts /var/lib/unseen/staging/book-artifacts.failed-2026-08-14
UNSEEN_STAGING_SNAPSHOT_DIR=/var/backups/unseen/staging/pre-release-2026-08-14 node --env-file=/etc/unseen/server-staging.env infra/integration/staging-snapshot.mjs restore
```

If Book output is configured inside the data directory, move only the data directory; the manifest records and enforces that embedded layout.

## Code + data rollback

1. Stop the service; record the failed Core/Book commits and preserve both current data directories.
2. Read the chosen snapshot's `manifest.json`, then switch the Core and Book checkouts to those exact commits. Both checkouts must be clean.
3. Run `staging-snapshot.mjs restore` into empty configured targets.
4. Start with the one command above; require proxy health plus an authorized browser pass through Core and Book routes.
5. If validation fails, stop again and manually restore the preserved failed-version directories/code. Nothing here claims or performs an automatic rollback.

Run the offline package verification from a clean candidate checkout:

```sh
UNSEEN_BOOK_WORKTREE=/opt/unseen/book-web node tests/e2e/server-migration.verify.mjs
```

For the local-mode variant, add `UNSEEN_MIGRATION_VERIFY_MODE=local`. The verifier requires the explicit detached Book path instead of falling back to a mutable development worktree. It uses only dynamic loopback ports plus the reserved `.test` hostname (never resolved), and covers missing-env/production fail-closed behavior, exact Core product provenance, a wrong clean Core subtree, health, Host routing, private permissions, deleted-marker and two-way operation-lock races, stale/tampered locks, symlink/tampered snapshots, SQLite verification, and backup/restore byte equality.
