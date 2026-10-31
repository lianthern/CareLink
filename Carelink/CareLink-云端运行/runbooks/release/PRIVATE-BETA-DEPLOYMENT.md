# UNSEEN private-beta public foundation and default-off private AI route

This is an independent target profile for an honest, access-controlled milestone while formal production remains
`NO_GO`. It must not replace, alter or bypass the production service or its `ExecStartPre`. The current candidate has no
real `OtpDeliveryPort`, so the public reverse proxy serves only the static status page. The formal Web and persistent Core
API remain loopback-only until OTP delivery is accepted and Core health becomes `ok`.

## Fixed claim boundary

- Package candidate: the exact `candidateCommit` in the standalone-verified package manifest; never substitute a historical checkout SHA.
- Package standalone verification: required before install from `/srv/unseen-release/VERIFY.mjs`.
- Real persistent Core DB, keyset and media directories are enabled with Book, facts/question provider and every fixture
  disabled.
- This is not a Core-operable Beta, a production release, an AI/provider acceptance or a Legal/Privacy approval.
- Basic Auth is a temporary outer invite gate. It is not an owner account, participant capability or substitute OTP.

## Target layout and service boundary

Install the verified candidate as a clean detached checkout under
`/opt/unseen/releases/REQUIRED_IMMUTABLE_RELEASE_COMMIT`. Create a dedicated `unseen` service identity and private `0700`
directories under `/var/lib/unseen/private-beta` and `/var/backups/unseen/private-beta`. Mechanically replace
`REQUIRED_IMMUTABLE_RELEASE_COMMIT` in both example units with the verified lowercase 40-hex commit, reject any leftover marker or
`/opt/unseen/core`, and require the rendered API/Web `WorkingDirectory` values to be the exact immutable release and its
`apps/web` child before installing the units as `root:root 0644`. `/opt/unseen/core` is a historical rollback-only
checkout; it may remain recoverable, but it is never active-release evidence. Split `config/rc/private-beta.env.example`
into root-owned `0600` API and Web environment files.

```sh
candidate_commit=CANDIDATE_COMMIT_FROM_PACKAGE_MANIFEST
candidate_tree=CANDIDATE_TREE_FROM_ACCEPTED_HANDOFF
test "${#candidate_commit}" -eq 40
test "${#candidate_tree}" -eq 40
case "$candidate_commit$candidate_tree" in *[!0-9a-f]*) exit 1 ;; esac
release_dir="/opt/unseen/releases/$candidate_commit"
test ! -e "$release_dir"
install -d -o root -g root -m 0755 /opt/unseen/releases
git clone /srv/unseen-release/source.bundle "$release_dir"
git -C "$release_dir" switch --detach "$candidate_commit"
test "$(git -C "$release_dir" rev-parse HEAD)" = "$candidate_commit"
test "$(git -C "$release_dir" rev-parse 'HEAD^{tree}')" = "$candidate_tree"
test "$(git -C "$release_dir" rev-parse --abbrev-ref HEAD)" = HEAD
test -z "$(git -C "$release_dir" status --porcelain)"
install -d -o root -g root -m 0700 /run/unseen/private-beta-render
sed "s/REQUIRED_IMMUTABLE_RELEASE_COMMIT/$candidate_commit/g" \
  "$release_dir/infra/integration/private-beta-deployment/unseen-private-beta-api.service" \
  > /run/unseen/private-beta-render/unseen-private-beta-api.service
sed "s/REQUIRED_IMMUTABLE_RELEASE_COMMIT/$candidate_commit/g" \
  "$release_dir/infra/integration/private-beta-deployment/unseen-private-beta-web.service" \
  > /run/unseen/private-beta-render/unseen-private-beta-web.service
! grep -Eq 'REQUIRED_IMMUTABLE_RELEASE_COMMIT|/opt/unseen/core' \
  /run/unseen/private-beta-render/unseen-private-beta-api.service \
  /run/unseen/private-beta-render/unseen-private-beta-web.service
grep -Fx "WorkingDirectory=$release_dir" \
  /run/unseen/private-beta-render/unseen-private-beta-api.service
grep -Fx "WorkingDirectory=$release_dir/apps/web" \
  /run/unseen/private-beta-render/unseen-private-beta-web.service
systemd-analyze verify /run/unseen/private-beta-render/unseen-private-beta-api.service \
  /run/unseen/private-beta-render/unseen-private-beta-web.service
```

The API unit is allowed to write only the private data and backup roots. Both app units deny non-loopback IP traffic. They
listen on `127.0.0.1:4282` and `127.0.0.1:4173`; neither is routed publicly. A plain request to the API loopback address can
fail Host validation, so health must preserve the approved public Host:

```sh
curl --fail-with-body -H 'Host: REQUIRED_PRIVATE_BETA_DOMAIN' http://127.0.0.1:4282/healthz
```

Until a real OTP adapter is injected, the honest result is HTTP `503`, `status=degraded`,
`otpDelivery.configured=false`, `otpDelivery.ready=false`, `provider=unconfigured`. Do not convert that result to healthy.

`UNSEEN_PRIVATE_AI_WORKER_ENABLED=false` is the mandatory initial state. Enabling it requires
`UNSEEN_BOOK_LAB_ENABLED=true`, all Book paths/secrets/notices, the accepted model/prompt/policy
pins and the worker-token hash file. Flag-off startup reads neither that file nor private media
and starts no composition timer.

## Temporary HTTPS status entry

Generate a random credential locally. Keep the plaintext only in a local operator handoff file with mode `0600`; never
put it in Git, shell history, evidence, service environment or logs. Put only the Caddy-generated password hash into the
target Caddy configuration. Replace all `REQUIRED_*` fields in the example and render it to a root-only `0600` staging
file; copy `status.html` as the only public content. A sealed backup stays `root:root 0600`, but the live distribution
service file must be installed as `root:caddy 0640`. Never `cp` or preserve the package/backup mode onto the live path.
Require the Caddy service identity to read the file before validating and enabling or reloading Caddy:

```sh
getent group caddy >/dev/null
install -d -o root -g root -m 0700 /var/backups/unseen/private-beta/REQUIRED_BACKUP_ID
install -o root -g root -m 0600 /etc/caddy/Caddyfile \
  /var/backups/unseen/private-beta/REQUIRED_BACKUP_ID/Caddyfile
install -o root -g caddy -m 0640 /run/unseen/private-beta-render/Caddyfile \
  /etc/caddy/Caddyfile
test "$(stat -c '%U:%G:%a' /etc/caddy/Caddyfile)" = root:caddy:640
sudo -u caddy test -r /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
systemctl is-active --quiet caddy
```

Require public HTTP-to-HTTPS redirect, valid hostname-bound TLS, unauthenticated and wrong-credential `401`, authorized
`200`, HSTS/CSP/nosniff/no-referrer/noindex headers, no `Server` header, zero external resource references and zero enabled
CTA. Do not add routes for the Web or API while health is degraded. Never add, replace or delete DNS records for the root
domain or `www` host as part of this profile.

The reviewed exception is the private-worker route `/__internal/private-ai/v1/*`. It is
ordered before the Basic Auth/static fallback because the worker uses its own authorization
header. Caddy forwards only to `127.0.0.1:4282`, preserves the public Host, sets
`X-Forwarded-Proto: https`, and limits request bodies to exactly 32 KiB (32,768 bytes).
Every worker POST must declare `Content-Length`; chunked POSTs and declared bodies of 32,769
bytes or more receive a local `413` before worker authentication or proxying. The response
retains the frozen protocol header, JSON media type and private
no-store cache policy, but its body is empty rather than inventing an API request ID. The
streaming body limit remains as a fail-closed backstop. Missing or wrong bearer
credentials must return `401`; a loopback Host must return `request_host_invalid`; no other
API route becomes public. With the feature off, the route returns the stable disabled response
without reading a token.

## Backup, restore and rollback

Stop only the private-beta API for a consistent snapshot, run `staging-snapshot.mjs backup`, restart it immediately, then
run `verify`. Bind both Core and Book commit inputs to the exact immutable release directory; keep the unused Book output directory embedded in
the Core data root. Exercise restore into a new private alternate target, never over live data, and require SQLite
`quick_check=ok` plus exactly 10 migrations. When the operator invokes the snapshot tool as root, explicitly restore
ownership of the alternate tree to `unseen:unseen` and repeat both database checks as the `unseen` service identity before
considering the drill complete.

Private-AI rollback is narrower: set `UNSEEN_PRIVATE_AI_WORKER_ENABLED=false`, restart the API,
stop the Mac worker and remove only the dedicated internal Caddy handle if network rollback is
required. Keep Book/Core editing and export online. Do not manually delete queue, authorization,
fact or outbox rows; use the verified pre-enable snapshot for data rollback.

Full service rollback is fail-closed: stop/mask the private-beta app units, restore the last verified snapshot only into
an empty data root, reinstall the preserved previous API/Web units bound to the manifest's exact immutable release, then
re-run loopback health and public status-page smoke. If Caddy must roll back, install the sealed `root:root 0600` backup
onto `/etc/caddy/Caddyfile` as `root:caddy 0640`, require Caddy-user readability, validate, reload and require the service
active. Do not preserve the backup mode on the live file, weaken TLS or expose an app listener.

Use explicit operator-reviewed identifiers and keep the failed tree recoverable:

```sh
systemctl stop unseen-private-beta-web unseen-private-beta-api
systemctl mask --runtime unseen-private-beta-web unseen-private-beta-api
rollback_commit=REQUIRED_SNAPSHOT_COMMIT
rollback_tree=REQUIRED_SNAPSHOT_TREE
test "${#rollback_commit}" -eq 40
test "${#rollback_tree}" -eq 40
case "$rollback_commit$rollback_tree" in *[!0-9a-f]*) exit 1 ;; esac
rollback_release="/opt/unseen/releases/$rollback_commit"
test "$(git -C "$rollback_release" rev-parse HEAD)" = "$rollback_commit"
test "$(git -C "$rollback_release" rev-parse 'HEAD^{tree}')" = "$rollback_tree"
test "$(git -C "$rollback_release" rev-parse --abbrev-ref HEAD)" = HEAD
test -z "$(git -C "$rollback_release" status --porcelain)"
install -o root -g root -m 0644 REQUIRED_PREVIOUS_API_UNIT \
  /etc/systemd/system/unseen-private-beta-api.service
install -o root -g root -m 0644 REQUIRED_PREVIOUS_WEB_UNIT \
  /etc/systemd/system/unseen-private-beta-web.service
! grep -Eq 'REQUIRED_IMMUTABLE_RELEASE_COMMIT|/opt/unseen/core' \
  /etc/systemd/system/unseen-private-beta-api.service \
  /etc/systemd/system/unseen-private-beta-web.service
grep -Fx "WorkingDirectory=$rollback_release" \
  /etc/systemd/system/unseen-private-beta-api.service
grep -Fx "WorkingDirectory=$rollback_release/apps/web" \
  /etc/systemd/system/unseen-private-beta-web.service
test ! -e /var/lib/unseen/private-beta/core-data.failed-REQUIRED_ROLLBACK_ID
mv /var/lib/unseen/private-beta/core-data \
  /var/lib/unseen/private-beta/core-data.failed-REQUIRED_ROLLBACK_ID
env \
  UNSEEN_STAGING_DATA_DIR=/var/lib/unseen/private-beta/core-data \
  UNSEEN_BOOK_OUTPUT_DIR=/var/lib/unseen/private-beta/core-data/book-artifacts \
  UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR=/var/lib/unseen/private-beta/runtime \
  UNSEEN_BOOK_WORKTREE="$rollback_release" \
  UNSEEN_STAGING_SNAPSHOT_DIR=/var/backups/unseen/private-beta/REQUIRED_VERIFIED_SNAPSHOT_ID \
  UNSEEN_STAGING_EXPECT_REPOSITORY_STATE=clean \
  /usr/local/bin/node "$rollback_release/infra/integration/staging-snapshot.mjs" restore
chown -R unseen:unseen /var/lib/unseen/private-beta/core-data
test "$(sudo -u unseen sqlite3 /var/lib/unseen/private-beta/core-data/unseen.sqlite \
  'PRAGMA quick_check;')" = ok
test "$(sudo -u unseen sqlite3 /var/lib/unseen/private-beta/core-data/unseen.sqlite \
  'SELECT count(*) FROM schema_migrations;')" -eq 10
install -o root -g caddy -m 0640 REQUIRED_SEALED_CADDY_BACKUP /etc/caddy/Caddyfile
test "$(stat -c '%U:%G:%a' /etc/caddy/Caddyfile)" = root:caddy:640
sudo -u caddy test -r /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl is-active --quiet caddy
systemctl daemon-reload
systemctl unmask --runtime unseen-private-beta-api unseen-private-beta-web
systemctl start unseen-private-beta-api unseen-private-beta-web
curl --fail-with-body -H 'Host: REQUIRED_PRIVATE_BETA_DOMAIN' \
  http://127.0.0.1:4282/healthz
```

After every start or rollback, determine the active release only by binding both loaded units to their own live
processes: each unit must report `ActiveState=active`, a nonzero `MainPID` and `ControlGroup`; that PID must belong to the
reported cgroup; API and Web `WorkingDirectory` values must be the same exact release root (Web adds `/apps/web`);
`/proc/$MainPID/cwd` must match those paths; and the shared checkout must be detached at the expected HEAD/tree and clean.
Reject any mismatch in working directory, PID/cgroup, HEAD, tree or status. Never use the existence or Git state of
`/opt/unseen/core` as a proxy for runtime state.

```sh
expected_commit=EXPECTED_ACTIVE_COMMIT
expected_tree=EXPECTED_ACTIVE_TREE
release_dir="/opt/unseen/releases/$expected_commit"
test "$(systemctl show unseen-private-beta-api.service -p ActiveState --value)" = active
test "$(systemctl show unseen-private-beta-web.service -p ActiveState --value)" = active
test "$(systemctl show unseen-private-beta-api.service -p WorkingDirectory --value)" = "$release_dir"
test "$(systemctl show unseen-private-beta-web.service -p WorkingDirectory --value)" = "$release_dir/apps/web"
api_pid="$(systemctl show unseen-private-beta-api.service -p MainPID --value)"
web_pid="$(systemctl show unseen-private-beta-web.service -p MainPID --value)"
case "$api_pid:$web_pid" in *[!0-9:]*|0:*|*:0|:*|*:) exit 1 ;; esac
api_control_group="$(systemctl show unseen-private-beta-api.service -p ControlGroup --value)"
web_control_group="$(systemctl show unseen-private-beta-web.service -p ControlGroup --value)"
test -n "$api_control_group"
test -n "$web_control_group"
grep -Fx "0::$api_control_group" "/proc/$api_pid/cgroup"
grep -Fx "0::$web_control_group" "/proc/$web_pid/cgroup"
test "$(readlink -f "/proc/$api_pid/cwd")" = "$release_dir"
test "$(readlink -f "/proc/$web_pid/cwd")" = "$release_dir/apps/web"
test "$(git -C "$release_dir" rev-parse HEAD)" = "$expected_commit"
test "$(git -C "$release_dir" rev-parse 'HEAD^{tree}')" = "$expected_tree"
test "$(git -C "$release_dir" rev-parse --abbrev-ref HEAD)" = HEAD
test -z "$(git -C "$release_dir" status --porcelain)"
```

For the current no-OTP profile, replace `--fail-with-body` with an explicit HTTP-status assertion and require the honest
`503 degraded` body; only a separately accepted real adapter may change that expectation to `200 ok`.

## Only implementable Core-unblock seam

The existing Core already provides encrypted transactional OTP outbox, stable delivery idempotency key, leases, retries,
payload clearing and an injected `{ name, async deliver(message) }` port. It has no deployment adapter and no operator
bootstrap/seeding CLI. Campaign capabilities let already-created campaigns admit friends without OTP, but an authenticated
owner must first create the account, Space and campaign.

The next implementation must therefore remain a Track 1B adapter change: select one real mail provider and its documented
authentication/idempotency contract, implement exactly one `OtpDeliveryPort`, inject it into the deployment entrypoint,
load its secret from a root-managed file, and test provider success, retry, duplicate delivery ID, secret redaction and
health. Provider selection plus private credential delivery is the sole external input. Do not add a local fixed code,
fixture sink, database seeding, Basic-Auth-as-owner or a second identity protocol.

## Default-off SMTP adapter candidate

A post-foundation candidate now provides one vendor-neutral SMTP `OtpDeliveryPort`; it does not retroactively change the
deployed package or evidence above. Keep `UNSEEN_OTP_DELIVERY_PROVIDER=disabled` until the adapter commit is independently
accepted and a real mailbox operator supplies all of: SMTP hostname, port, `implicit_tls` or `starttls`, username,
normalized sender address, and the password via `UNSEEN_OTP_PROVIDER_SECRET_FILE`. Prefer standard implicit TLS port 465
or STARTTLS port 587 according to the mailbox provider's documented configuration.

The current private-beta API unit permits loopback IP traffic only, so it intentionally blocks an external SMTP host.
Before enabling this adapter, the deployment owner must add a reviewed, provider-specific outbound policy without exposing
the API listener or granting unrelated egress. Do not weaken the unit to unrestricted network access as a workaround.

The password file must be absolute, regular, non-symlink, owned by root or the `unseen` identity, readable by the service,
and exact mode `0400` or `0600`. Do not put its value in an environment file, command line, journal, evidence or Git. The
adapter requires certificate-verified TLS 1.2 or newer, fixed connection/send timeouts and one in-flight send. It sends
only the six-digit code and generic expiry/safety copy; it omits purpose, Space, photo, challenge and user context.
`UNSEEN_SMTP_TOTAL_TIMEOUT_MS` is the single deadline across connection, TLS, authentication and delivery (30 seconds
by default; 50 seconds maximum). Startup rejects SMTP composition unless that deadline plus the fixed five-second socket
cleanup grace is strictly below the Core outbox's 60-second lease, preventing another dispatcher from reclaiming a live
send after a sequence of individually slow but legal SMTP phases.

Before public API routing, exercise implicit TLS or STARTTLS against the chosen provider, verify `/healthz` returns
`status=ok` and `otpDelivery.provider=smtp_tls`, and complete a real request/receive/verify cycle. Then repeat the same
idempotency key and require one outbox row and one accepted message. SMTP itself is at-least-once: a crash after server
acceptance may retry the same opaque `Message-ID`, so provider/mailbox duplicate handling must be recorded during
acceptance. If provider setup, TLS, auth or send fails, the adapter returns a stable redacted error and the outbox remains
encrypted and queued with `provider_failed`; no fixture delivery may substitute.
