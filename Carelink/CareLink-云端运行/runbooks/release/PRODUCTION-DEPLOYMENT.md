# UNSEEN portable production package

This package makes the server-independent deployment mechanics reproducible. It contains accepted 8C commit `a16f7fdda14759429fd22054506f198980805e9d`: the real Core/Book seam, current-Space Event projection, server-only question worker source seam, production renderer profile and deployment lifecycle are integrated. Fixture fallback is disabled, the Book feature flag remains default-off, and neither approved visible facts nor a production question provider is configured. Release remains `NO_GO` only for approved Core visible facts/question provider, Legal/Privacy notice approvals, and target server/domain/TLS/secret/provider authorization.

## Build and verify off-server

From a clean accepted Track5 checkout, build into a new absolute directory outside the repository:

```sh
UNSEEN_PRODUCTION_PACKAGE_DIR=/absolute/private/output/unseen-release \
  node infra/integration/production-package.mjs build
UNSEEN_PRODUCTION_PACKAGE_DIR=/absolute/private/output/unseen-release \
  node infra/integration/production-package.mjs verify
```

The result contains a Git bundle with the exact candidate, accepted 8C history and pinned Book7d staging fixture, a byte/commit/migration/profile manifest, the non-secret production env template, systemd and Caddy examples, this runbook, and a standalone verifier. Package directories are `0700`; files are `0600`. Those package-at-rest permissions do not define the installed Caddyfile permissions below. The verifier checks every declared byte, rejects missing/extra files and symlinks, validates the Git bundle from a standalone non-Git directory, proves the candidate, integrated 8C and fixture commits from an isolated clone, and rejects the legacy active-checkout alias or an incomplete release/Caddy permission contract.

## Materialize the target without network access

Transfer the package through the approved private channel, verify it again on the target, then materialize a clean detached checkout in an immutable commit-named directory. Replace the two values below from the verified manifest; both are lowercase 40-hex Git object IDs. Never use `/opt/unseen/core` to install or discover the active release. It is a historical rollback-only checkout and may be stale.

```sh
node /srv/unseen-release/VERIFY.mjs verify
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
```

The top-level `bookCommit` and `profiles.staging` entry refer only to the visibly labelled Book7d local-staging fixture. They are retained so the existing staging runtime stays reproducible and are explicitly `productionInput: false`; production runs the Book code already integrated in the candidate. Create the detached fixture checkout only when reproducing local staging:

```sh
git -C "$release_dir" worktree add --detach /opt/unseen/book-web BOOK_FIXTURE_COMMIT_FROM_MANIFEST
```

Mechanically render the non-overlapping `REQUIRED_IMMUTABLE_RELEASE_COMMIT` path marker and
`REQUIRED_CANDIDATE_COMMIT_FROM_PACKAGE_MANIFEST` value marker to the same exact verified commit before install. Reject
either leftover marker, the legacy alias, or any WorkingDirectory other than the immutable release. Do not edit a prior
unit in place or infer the active release from a checkout directory:

```sh
install -d -o root -g root -m 0700 /run/unseen/release-render
sed "s/REQUIRED_IMMUTABLE_RELEASE_COMMIT/$candidate_commit/g" \
  /srv/unseen-release/unseen.service.example > /run/unseen/release-render/unseen.service
sed -e "s/REQUIRED_IMMUTABLE_RELEASE_COMMIT/$candidate_commit/g" \
  -e "s/REQUIRED_CANDIDATE_COMMIT_FROM_PACKAGE_MANIFEST/$candidate_commit/g" \
  /srv/unseen-release/production.env.example > /run/unseen/release-render/production.env
! grep -Eq 'REQUIRED_IMMUTABLE_RELEASE_COMMIT|REQUIRED_CANDIDATE_COMMIT_FROM_PACKAGE_MANIFEST|/opt/unseen/core' \
  /run/unseen/release-render/unseen.service /run/unseen/release-render/production.env
grep -Fx "WorkingDirectory=$release_dir" /run/unseen/release-render/unseen.service
grep -Fx "UNSEEN_PRODUCTION_CANDIDATE_COMMIT=$candidate_commit" \
  /run/unseen/release-render/production.env
grep -Fx "UNSEEN_BOOK_WORKTREE=$release_dir" /run/unseen/release-render/production.env
systemd-analyze verify /run/unseen/release-render/unseen.service
install -o root -g root -m 0644 /run/unseen/release-render/unseen.service \
  /etc/systemd/system/unseen.service
install -o root -g unseen -m 0640 /run/unseen/release-render/production.env \
  /etc/unseen/production.env
```

Replace the remaining `REQUIRED_*` values in `/etc/unseen/production.env`; preflight must reject any unresolved release input. This file is non-secret, `root:unseen 0640`, and accepts only the exact template key set with no duplicates, controls or inline `*_SECRET`, `*_TOKEN`, `*_PASSWORD` or `*_API_KEY` variables. The canonical API unit removes `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `LD_*`, `BASH_ENV`, `ENV` and `SSLKEYLOGFILE` after loading its environment and passes the fixed `/etc/unseen/production.env` pathname to preflight. The service manager must materialize `/run/unseen/production.secrets` from the target secret store with the four distinct Book secret environment names documented in the template; keep it outside Git and readable only by the service identity. Never place credential values in the non-secret env file, source bundle, unit or proxy configuration.

Resolve the target decoder executables to their final regular files; do not use `ffmpeg`, `ffprobe`, a relative path, a
`PATH` lookup, or a symlink such as a package-manager convenience link. Each file must be executable, owned by root or the
service identity, and not group/world-writable. Record its SHA-256. Preflight only binds path, ownership, mode, inode
metadata and bytes, reads and hashes the file twice, and deliberately never executes it. A hash-bound binary is still
arbitrary executable code, so preflight reports `HASH_BOUND_NOT_EXECUTED`; it makes no decoder egress or runtime-integrity
claim and cannot change `NO_GO` or `productionReady=false`.

Formal release separately requires target-operator acceptance using an approved target-OS execution wrapper and enforced
egress boundary. That acceptance must bind the same binary hashes, exact `-version` stdout/stderr, version and
`configuration:` build flags, execution limits, wrapper identity/configuration, and observed network/egress evidence. A
macOS-only sandbox is not evidence for Linux production. Stage5 does not define or simulate the missing operator-receipt
schema; until the target owner supplies and accepts it, both decoder version/build validation and network boundary remain
`TARGET_ACCEPTANCE_REQUIRED`.

## Dedicated Book renderer (default off)

The Linux production renderer is a separate fixed `unseen-renderer` service. The API and renderer share no TCP or
abstract socket. Systemd creates `/run/unseen-renderer/render.sock` as filesystem `AF_UNIX` and passes it as FD 3 into a
`PrivateNetwork=true`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX` service. Because the socket is created by
the host `.socket` unit, the renderer can receive the accepted descriptor inside its private network namespace without
giving Chromium a host network namespace. The API remains in the host namespace for Caddy's loopback connection.

The API owns `inbox`, `cancels` and `acks`; the renderer owns `results` and `work`. Neither identity gets write access to
the other direction. Each file is regular, one-link, `0640`, size/hash-bound, written with create-exclusive + fsync +
atomic link, and read with `O_NOFOLLOW`. Control records are at most 4 KiB and requests at most 16 MiB. HTML/PDF bytes
never cross the socket or result JSON. Cold-start readiness has a separate hard 120-second budget; whole render timeout is
120 seconds, the Book claim lease is 150 seconds, render-control/cancel grace is 5 seconds, and renderer concurrency is one.
Book's existing final currentness/CAS validation remains the only
commit point; cancel is only an optimization. Crash replay reuses the request hash and accepts only byte-identical
partial artifacts.

Each control connection is one canonical newline-delimited request followed by one canonical response no larger than
4 KiB. Before creating any inbox file, the client sends a receipt-hash-bound `ready` operation and waits up to the separate
cold-start budget. The ready response is possible only after the daemon has loaded the exact receipt, repeated runtime and
sandbox verification, and registered the systemd-provided FD 3 listener; it never reads or writes spool state. A failed,
closed, malformed or timed-out ready exchange therefore leaves no inbox, cancel, ACK, acceptance marker or result.
For render, `DURABLE_CONTROL_ACCEPTANCE_MARKER_REQUIRED_FOR_RENDER_RESUME`: the renderer first validates the
API-owned inbox, atomically persists and re-reads its own receipt-hash-bound `results/control/<requestId>.json` marker,
then queues the operation and returns `accepted` without waiting for rendering. A bare inbox is never renderable, even
after the 5-second scanner or a daemon restart; cancel and ACK records remain independently replayable cleanup authority.
A rejected, malformed, mismatched, empty,
oversized, timed-out or transport-closed response fails closed. Once an inbox exists, the client atomically persists and
fsyncs cancellation before returning a render-control failure or whole timeout to its caller. The server rechecks that
cancellation immediately before and after acceptance-marker commit and again before child spawn. A lost response is
recovered through the same durable cancel/reconcile and request-hash idempotency path, never by assuming that socket close
means acceptance or by automatically rendering twice.

Do not enable either unit from package contents alone. This candidate accepts only Chromium snap revision 3507 at
`/snap/chromium/3507/usr/lib/chromium-browser/chrome`; `/snap/bin/chromium`, `/snap/chromium/current`, another revision
and a package-embedded snap are rejected. The production package intentionally contains no snap artifact. Pin exact
browser, the retained `/var/lib/snapd/snaps/chromium_3507.snap`, bubblewrap, AppArmor profile, child seccomp, font inventory,
PDF-tool inventory, rendered systemd fragments, candidate and renderer build hashes in a root-owned,
`root:unseen-render-ipc 0640` receipt using
schema `unseen-book-renderer-acceptance/1`. The receipt must record `cups.connected=false` and `gate=deny-and-verify`;
any snap revision/hash drift, CUPS connection, extra key, placeholder, symlink or ownership/mode drift fails closed.
`SNAPD_CACHE_HARDLINK_GATE=ARCHIVE_ONLY_OR_EXACT_SHA3_384_CACHE_LINK` accepts the archive with one link, or exactly
two links only when the other inode name is
`/var/lib/snapd/cache/77155504d7c5fdfa516545da086bd3f31fa6f6283901e93885cbb39366ae55bea834c4042bebfc870a0330904df04c07`.
The link policy hash is `49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5`.
`snap_archive_dac=root:root:0600 source=TARGET_OBSERVED_EVIDENCE_87687C956770A409F040EC15C5BBBF9F93AA70A9`;
`snap_cache_dir_dac=root:root:0700 source=SNAPD_SOURCE_POLICY_93A01322CDC0AD70AFCD641FF31FCF7BF070F144`.
Ancestors are source-policy checked only as root-owned, nonsymlink and not group/world writable; they are not claimed as
target-observed exact modes. The verifier opens both leaves with `O_NOFOLLOW`, binds dev/inode/DAC/link count/size and
timestamps before and after hashing, then reopens the exact paths. A cache entry beside an nlink-1 archive, a third link,
another filename/inode, metadata drift or any race fails closed. It never changes, deletes or relinks snapd cache data.
`CHROMIUM_CANONICAL_DANGLING_SYMLINK_POLICY=3c3f99c6d62feffb90a873bc245930045a1e42bdc0c3b1e5c2a763208586b128`
allows only `usr/bin/xdg-email -> /usr/bin/xdg-open` and
`usr/share/groff/site-tmac -> ../../../etc/groff` from the byte-pinned revision 3507 tree. Both targets must remain
unresolved with exact `ENOENT`; a resolved target, another error, changed/missing link, extra dangling link, unsafe parent
or metadata/path race rejects. Each source link is exact root:root mode 0777 with nlink 1; all three observations bind its
path and target SHA-256. Target absence uses exact-path `lstat`, so a present leaf symlink pointing at a missing object is
rejected rather than mistaken for absence. The receipt records exactly two links and
`runtimeReachability=ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE`. Full target measurement and every pre-spawn sandbox
preparation repeat the absence and stable lstat/readlink checks. Because `/usr` is a read-only child mount, installing
`/usr/bin/xdg-open` later must fail closed before Chromium starts rather than make the absolute link usable.
`CHROMIUM_SNAP_ADAPTER_GATE=REVISION_3507_EXACT14_EMPTY_ENV_FIXED_ARGV_FULL_TREE_HASH` binds the 683-entry numeric tree,
591 regular files, 27 symlinks, 446326676 regular-file bytes, 224 required resource files, meta and official launcher,
the candidate-owned adapter source/policy, and the fixed 14-key child environment. `SNAP_DATA`, `SNAP_COMMON`, `PATH`,
`NODE_OPTIONS`, loader injection and all other host environment are omitted. HOME, XDG, TMP and snap user directories are
job-private 0700 and removed with renderer work. `--no-sandbox` is admitted exactly once only after the outer systemd,
bwrap, AppArmor and seccomp acceptance is verified.
The frozen full-tree manifest is `7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913` and the
resource manifest is `f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5`; matching counts or
aggregate bytes never substitute for either exact manifest.

The canonical assertion is hash-bound but its signature has not been independently verified and the local evidence does
not contain an approved Chromium license declaration or security review. The receipt therefore records
`assertionSignatureVerified=false`, `licenseDeclaration=UNDECLARED_IN_CANONICAL_ASSERTION_AND_LOCAL_META`,
`securityReview=REQUIRED_NOT_INCLUDED` and `releaseDecision=NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED`. Keep Book off;
neither a successful measurement nor a synthetic render overrides this gate.
The package provides only the measuring verifier; no receipt exists until it succeeds on the target. Book remains
`REQUIRED_NOT_INCLUDED` until that target receipt and the synthetic render/network acceptance both pass.

The renderer never resolves Node through `PATH`, `/usr/bin/node`, apt, a symlink or an operator's existing tree.
Install the exact official x64 Node 22.23.2 archive into the immutable runtime path before rendering the unit. Retain
the archive, its signed SHASUMS and the commit-pinned Node release keyring at the fixed paths measured below. The archive
is accepted only when the pinned keyring verifies the signed manifest, the manifest contains the exact archive hash once,
the archive byte hash/size match, and the extracted executable hash and exact `--version` stdout match. A copied
Lighthouse-owned Node tree, apt's Node 18, an unpinned keyring or an unsigned checksum is not an input to this gate.

```sh
NODE_RUNTIME_TARGET_GATE=PINNED_NODE_22_23_2_SIGNED_SHASUMS_AND_EXACT_BINARY
node_runtime_root=/opt/unseen/runtime/node-v22.23.2-linux-x64
node_executable_sha=3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327
node_archive_sha=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
node_archive_bytes=31058332
node_shasums_asc_sha=cfcf12eb3146d641be185d08ca018166b98495b1d8e5f7f94ab77f9965b651d2
node_release_keys_commit=b28073028e6d6855cfb53bf7fa0137599c01f967
node_keyring_sha=6030d4e0cd53330acf2ab68acd455b7ca98bb5d5975376f0b7c0892308ba2d57
node_keyring_bytes=95960
node_archive_url=https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz
node_shasums_url=https://nodejs.org/dist/v22.23.2/SHASUMS256.txt.asc
node_keyring_url="https://raw.githubusercontent.com/nodejs/release-keys/$node_release_keys_commit/gpg/pubring.kbx"
install -d -o root -g root -m 0755 /opt/unseen /opt/unseen/runtime \
  /opt/unseen/runtime/sources /opt/unseen/runtime/trust
node_stage="$(mktemp -d /opt/unseen/runtime/.node-v22.23.2-install.XXXXXX)"
trap 'rm -rf -- "$node_stage"' EXIT
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "$node_archive_url" -o "$node_stage/node-v22.23.2-linux-x64.tar.xz"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "$node_shasums_url" -o "$node_stage/SHASUMS256.txt.asc"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "$node_keyring_url" -o "$node_stage/release-keys.kbx"
printf '%s  %s\n' "$node_shasums_asc_sha" "$node_stage/SHASUMS256.txt.asc" | sha256sum --strict --check
printf '%s  %s\n' "$node_keyring_sha" "$node_stage/release-keys.kbx" | sha256sum --strict --check
test "$(stat -c '%s' "$node_stage/release-keys.kbx")" = "$node_keyring_bytes"
/usr/bin/gpgv --keyring "$node_stage/release-keys.kbx" --output "$node_stage/SHASUMS256.txt" \
  "$node_stage/SHASUMS256.txt.asc"
node_archive_line="$node_archive_sha  node-v22.23.2-linux-x64.tar.xz"
test "$(grep -Fxc "$node_archive_line" "$node_stage/SHASUMS256.txt")" -eq 1
printf '%s  %s\n' "$node_archive_sha" "$node_stage/node-v22.23.2-linux-x64.tar.xz" | \
  sha256sum --strict --check
test "$(stat -c '%s' "$node_stage/node-v22.23.2-linux-x64.tar.xz")" = "$node_archive_bytes"
install -d -o root -g root -m 0700 "$node_stage/extract"
tar --extract --xz --file "$node_stage/node-v22.23.2-linux-x64.tar.xz" \
  --directory "$node_stage/extract" --no-same-owner --no-same-permissions
printf '%s  %s\n' "$node_executable_sha" "$node_stage/extract/node-v22.23.2-linux-x64/bin/node" | \
  sha256sum --strict --check
test "$("$node_stage/extract/node-v22.23.2-linux-x64/bin/node" --version)" = v22.23.2
test ! -e "$node_runtime_root"
install -d -o root -g root -m 0755 "$node_stage/runtime" "$node_stage/runtime/bin"
install -o root -g root -m 0755 "$node_stage/extract/node-v22.23.2-linux-x64/bin/node" \
  "$node_stage/runtime/bin/node"
mv "$node_stage/runtime" "$node_runtime_root"
install -d -o root -g root -m 0755 "$node_stage/sources"
install -o root -g root -m 0644 "$node_stage/node-v22.23.2-linux-x64.tar.xz" \
  "$node_stage/sources/node-v22.23.2-linux-x64.tar.xz"
install -o root -g root -m 0644 "$node_stage/SHASUMS256.txt.asc" "$node_stage/sources/SHASUMS256.txt.asc"
test ! -e /opt/unseen/runtime/sources/node-v22.23.2
mv "$node_stage/sources" /opt/unseen/runtime/sources/node-v22.23.2
install -o root -g root -m 0644 "$node_stage/release-keys.kbx" \
  /opt/unseen/runtime/trust/.node-release-keys.installing
test ! -e \
  /opt/unseen/runtime/trust/node-release-keys-b28073028e6d6855cfb53bf7fa0137599c01f967.kbx
mv /opt/unseen/runtime/trust/.node-release-keys.installing \
  /opt/unseen/runtime/trust/node-release-keys-b28073028e6d6855cfb53bf7fa0137599c01f967.kbx
install -d -o root -g unseen-render-ipc -m 0750 /run/unseen/approvals
printf '%s  %s\n' "$node_executable_sha" "$node_runtime_root/bin/node" \
  > "$node_stage/node-runtime.sha256"
install -o root -g unseen-render-ipc -m 0640 "$node_stage/node-runtime.sha256" \
  /run/unseen/approvals/node-runtime.sha256
/usr/bin/sha256sum --strict --check --status /run/unseen/approvals/node-runtime.sha256
test "$(stat -c '%U:%G:%a' "$node_runtime_root/bin/node")" = root:root:755
test "$(stat -c '%U:%G:%a:%s' /run/unseen/approvals/node-runtime.sha256)" = \
  root:unseen-render-ipc:640:119
```

After rendering both unit templates to the immutable candidate, install the fixed principals and private directories,
then generate and load the unit-scoped AppArmor profile. The profile only grants user-namespace creation to this named
unit; systemd still supplies the outer private network, empty capability bounding set and no-new-privileges boundary.
Bubblewrap shares that already-private netns (never `--unshare-net`) while isolating user/mount/PID/IPC/UTS. Its inherited
seccomp filter rejects `AF_INET`, `AF_INET6`, `AF_NETLINK`, `AF_PACKET`, `setns`, new network namespaces, mount,
unmount and pivot-root attempts by Chromium descendants.

```sh
candidate_commit=REQUIRED_VERIFIED_CANDIDATE_COMMIT
release_dir="/opt/unseen/releases/$candidate_commit"
install -d -o root -g root -m 0700 /run/unseen/renderer-install
sed "s/REQUIRED_IMMUTABLE_RELEASE_COMMIT/$candidate_commit/g" \
  /srv/unseen-release/unseen-book-renderer.service.example \
  > /run/unseen/renderer-install/unseen-book-renderer.service
cp /srv/unseen-release/unseen-book-renderer.socket.example \
  /run/unseen/renderer-install/unseen-book-renderer.socket
! grep -R 'REQUIRED_' /run/unseen/renderer-install
systemd-analyze verify /run/unseen/renderer-install/unseen-book-renderer.service \
  /run/unseen/renderer-install/unseen-book-renderer.socket
install -o root -g root -m 0644 /srv/unseen-release/unseen-book-renderer.sysusers.example \
  /etc/sysusers.d/unseen-book-renderer.conf
systemd-sysusers /etc/sysusers.d/unseen-book-renderer.conf
install -o root -g root -m 0644 /srv/unseen-release/unseen-book-renderer.tmpfiles.example \
  /etc/tmpfiles.d/unseen-book-renderer.conf
systemd-tmpfiles --create /etc/tmpfiles.d/unseen-book-renderer.conf
"$node_runtime_root/bin/node" "$release_dir/infra/integration/book-lab/linux-apparmor-profile.mjs" \
  > /run/unseen/renderer-install/unseen-book-renderer.apparmor
apparmor_parser -Q /run/unseen/renderer-install/unseen-book-renderer.apparmor
install -o root -g root -m 0644 /run/unseen/renderer-install/unseen-book-renderer.apparmor \
  /etc/apparmor.d/unseen-book-renderer
apparmor_parser -r /etc/apparmor.d/unseen-book-renderer
install -o root -g root -m 0644 /run/unseen/renderer-install/unseen-book-renderer.service \
  /etc/systemd/system/unseen-book-renderer.service
install -o root -g root -m 0644 /run/unseen/renderer-install/unseen-book-renderer.socket \
  /etc/systemd/system/unseen-book-renderer.socket
systemctl daemon-reload
systemctl show cups.service cups.socket --no-pager \
  --property=Id,LoadState,ActiveState,SubState,UnitFileState,FragmentPath
set +e
systemctl is-active cups.service
cups_service_rc="$?"
systemctl is-active cups.socket
cups_socket_rc="$?"
set -e
test "$cups_service_rc" -eq 3 -o "$cups_service_rc" -eq 4
test "$cups_socket_rc" -eq 3 -o "$cups_socket_rc" -eq 4
cups_listeners="$(ss -H -lntup 'sport = :631')"
test -z "$cups_listeners"
test ! -S /run/cups/cups.sock
numeric_snap_root="/snap/chromium/3507"
UNSEEN_CHROMIUM_PATH="$numeric_snap_root/usr/lib/chromium-browser/chrome" \
UNSEEN_BOOK_RENDERER_READ_ONLY_MOUNTS_JSON="[\"/usr\",\"/lib\",\"/lib64\",\"/etc/fonts\",\"$numeric_snap_root\",\"$node_runtime_root\"]" \
  "$node_runtime_root/bin/node" "$release_dir/infra/integration/book-lab/renderer-target-verifier.mjs" \
  --measure "$release_dir" \
  > /run/unseen/renderer-install/book-renderer-acceptance.json
install -o root -g unseen-render-ipc -m 0640 \
  /run/unseen/renderer-install/book-renderer-acceptance.json \
  /run/unseen/approvals/book-renderer-acceptance.json
receipt_sha="$(sha256sum /run/unseen/approvals/book-renderer-acceptance.json | awk '{print $1}')"
printf '%s\n' "$receipt_sha" > /run/unseen/renderer-install/book-renderer-acceptance.sha256
install -o root -g unseen-render-ipc -m 0640 \
  /run/unseen/renderer-install/book-renderer-acceptance.sha256 \
  /run/unseen/approvals/book-renderer-acceptance.sha256
test "$(stat -c '%U:%G:%a' /run/unseen/approvals/book-renderer-acceptance.json)" = \
  root:unseen-render-ipc:640
test "$(stat -c '%U:%G:%a:%s' /run/unseen/approvals/book-renderer-acceptance.sha256)" = \
  root:unseen-render-ipc:640:65
sudo -u unseen test -r /run/unseen/approvals/book-renderer-acceptance.json
sudo -u unseen-renderer test -r /run/unseen/approvals/book-renderer-acceptance.json
sudo -u unseen-renderer test -r /run/unseen/approvals/book-renderer-acceptance.sha256
grep -Fx "UNSEEN_BOOK_RENDERER_ACCEPTANCE_SHA256=$receipt_sha" /etc/unseen/production.env
```

`CUPS_TARGET_GATE=BOTH_NOT_FOUND_RC4_OR_BOTH_INSTALLED_INACTIVE_DISABLED_MASKED_AND_ZERO_LISTENERS` is enforced by
the target verifier, not by interpreting the diagnostic commands above. It accepts exactly one coherent state for both
`cups.service` and `cups.socket`: both are installed and `inactive/dead` with `disabled` or `masked`, or both have
`LoadState=not-found`, empty `UnitFileState`/`FragmentPath`, and `is-active` returns rc 4 with `inactive`. A mixed pair,
alias/generated/transient unit, command error or stderr, malformed properties, rc/text mismatch, port 631 listener or
`/run/cups/cups.sock` rejects measurement. The `ss` command itself must succeed; missing CUPS packages never waive the
listener probe.

Before acceptance, prove the fixed Node executable, resolved browser and bwrap are regular, root-owned, executable,
non-writable by group/world
and byte-equal to the receipt; prove the numeric snap revision and CUPS disconnection have not drifted; hash the exact
loaded AppArmor profile, generated seccomp bytes, font inventory, every executed PDF tool (`pdfinfo` and `pdftotext`), named
numeric principals, rendered unit bytes and every expected effective systemd property. Drop-ins, alternate executables,
non-filesystem/TCP sockets and weakened effective properties are rejected. The target verifier builds the receipt from those
measurements. It also re-verifies the pinned official Node release keyring against the retained signed SHASUMS, checks the
exact archive hash/size and strict one-line `sha256sum` pin, and refuses to run unless `process.execPath` is the fixed
runtime. That same fixed runtime root must be an explicit read-only bwrap mount so the renderer child can execute Node
without exposing any other `/opt` content. It does not accept an operator-authored pin list. Set
`UNSEEN_BOOK_RENDERER_ACCEPTANCE_SHA256` to the measured
receipt hash for the API client. The renderer daemon reads no shared production or secret environment file: it uses fixed
production paths and loads that same hash from the one-link, root-owned, IPC-group-readable 65-byte pin file, then runs
`--verify` as `unseen-renderer`. Runtime loads the exact receipt hash and repeats
the full target measurement inside the service: its current AppArmor attachment, candidate tree/build, browser, bwrap,
fonts/PDF tools, unit fragments/effective properties, principals and CUPS state must still byte/semantically match before it
touches a render request. Then use a synthetic local HTML/assets request to prove PDF output plus a
loopback canary, DNS name, public TCP and UDP all remain unreachable to Chromium and every descendant. A test or skipped
probe is never production acceptance. A failed renderer manifest and its journal line may contain only exact schema
`unseen-book-renderer-failure-diagnostic/1`: an allowlisted phase/code, nullable numeric exit code, signal boolean and bounded
stderr byte count. The API client strips that internal diagnostic and preserves the existing public `render_failed` result.
Record only hashes, versions, counts, stable error codes and systemd properties—never stdout/stderr text, request IDs or
request bodies, filesystem paths, HTML, PDF, media, answers or credentials.

The installed renderer service and socket must be byte-equal to the candidate templates after replacing exactly the single
immutable-release commit marker; there are no other substitutions. The socket explicitly binds
`Service=unseen-book-renderer.service`. Any extra `Environment=`, `Exec*=`, credential, socket service, unknown directive or
drop-in is a hard rejection even if it is root-owned. On renderer restart, the service securely enumerates its private work
directory before accepting work, removes only exact renderer-owned/mode-bound job and seccomp residuals, and refuses to start
on unknown, linked or metadata-drifted entries. The periodic collector excludes current request IDs and work younger than the
150-second render lease; renderer work validation failure blocks further scheduling.

On Ubuntu 24.04/systemd 255, `systemctl show` legitimately omits the unset `EnvironmentFiles` service property and does not
expose the socket-file `Service=` directive as a runtime property. The verifier normalizes only that one omitted empty value.
It binds activation instead through byte-exact unit sources plus exact `Id`, singleton `Names`, reciprocal
`Triggers`/`TriggeredBy`, `FragmentPath` and empty `DropInPaths`; every other missing, extra or changed property remains a hard
rejection. The byte-exact service source still requires `IPAddressDeny=any`, while systemd 255 exposes that runtime policy as
the exact order-independent pair `0.0.0.0/0 ::/0`; missing, duplicate or additional CIDRs are rejected.
The v255 sources bind this representation in the
[property parser](https://github.com/systemd/systemd/blob/v255/src/shared/bus-unit-util.c#L824-L863),
[`systemctl show` formatter](https://github.com/systemd/systemd/blob/v255/src/systemctl/systemctl-show.c#L1530-L1585) and
[resource-control definition](https://github.com/systemd/systemd/blob/v255/man/systemd.resource-control.xml#L805-L829).

Only after the exact receipt and target evidence pass may the operator enable the socket and set Book true. Socket
activation is deliberate; no separate renderer port is opened. Stop immediately on any pin drift, CUPS connection,
unexpected address family, inherited network FD, bwrap/AppArmor failure, non-private directory, artifact mismatch,
timeout/resource escape or unresolved `REQUIRED_*` marker.

```sh
systemctl enable --now unseen-book-renderer.socket
systemctl show unseen-book-renderer.service \
  -p PrivateNetwork -p IPAddressDeny -p RestrictAddressFamilies -p User -p Group
test -S /run/unseen-renderer/render.sock
test "$(stat -c '%U:%G:%a' /run/unseen-renderer/render.sock)" = unseen-renderer:unseen-render-ipc:660
```

Renderer rollback is independent of the public service: set Book false, stop and mask the renderer socket/service,
restore the prior hash-bound receipt and matching SHA pin, AppArmor profile, rendered units and immutable release, then repeat target
verification before unmasking. Preserve the spool and failed artifacts privately for incident review; do not delete or
reinterpret them as completed Books. Rolling back the renderer never authorizes a stale result—API final CAS/currentness
still rejects withdrawn grants, revoked sources and superseded versions.

## Preflight, database and persistence

Run preflight before enabling a service:

```sh
sudo -u unseen node "$release_dir/infra/integration/production-package.mjs" \
  preflight /etc/unseen/production.env
```

`NO_GO` with exit code `2` is the only correct result while any of the three named release facts remains unresolved. The preflight proves that the package selects the integrated 8C profile and keeps the feature flag off; editing it, flipping the flag or replacing placeholders is not acceptance evidence.

Core facts/question-provider acceptance is separately default-off through `UNSEEN_CORE_FACTS_PROVIDER_ENABLED=false`.
In that state preflight does not open the acceptance receipt or provider secret and performs no provider network operation. To
validate an externally supplied receipt without enabling production, set the flag to `true`, copy the exact package-manifest
candidate to `UNSEEN_PRODUCTION_CANDIDATE_COMMIT`, and supply the receipt's independently delivered SHA-256 plus the approved
Legal/Privacy receipt SHA-256. The receipt file and declared provider secret must be regular non-symlink files with mode `0400`
or `0600`; preflight hashes and reads the receipt but only `lstat`s the secret.

The receipt is strict schema `unseen-core-facts-question-provider-acceptance/1` with only these top-level keys:
`schema`, `status`, `candidateCommit`, `accepted8CCommit`, `issuedAt`, `expiresAt`, `visibleFacts`, `provider`, and
`legalReceiptSha256`. `visibleFacts` binds `unseen-visible-facts/1`, `photoId`, `contentHash`,
`placementSnapshotHash`, `factsHash`, `policyHash`, `approvalVersion`, exact `currentness: "current"`, and
`revokedAt: null`. Provider metadata is an external declaration only: `adapterProtocolId`, one public-DNS HTTPS endpoint,
`region`, `modelVersion`, prompt/policy hashes, bounded timeout/request/response bytes, `TLSv1.3`, redirect deny,
`public_dns_only`, `exact_https_endpoint_only`, and an absolute private secret-file path. Userinfo, query, fragment, non-443
ports, literal/private/loopback IPs, placeholders, extra keys, stale/revoked facts, expired receipts, hash or commit drift, and
unsafe files fail closed. This validator does not implement a provider adapter or authentication protocol. A
`STRUCTURE_ONLY` receipt can test the validator, but it leaves `questionProviderConfigured=false`,
`visibleFactsApproved=false`, `productionReady=false`, and release `NO_GO`.

The integrated lifecycle entrypoint opens `/var/lib/unseen/production/core-data/unseen.sqlite`, applies ordered `services/api/db/migrations/*.sql` inside individual immediate transactions, records each version in `schema_migrations`, enables foreign keys and WAL, and reuses the persisted keyset/media directories. When enabled after acceptance, it also opens the persistent Book database in the same private data root and uses the accepted isolated production renderer. First start initializes empty stores; restart is idempotent. Missing/corrupt keysets beside an existing database fail closed. The package verifier independently records the ordered Core migration hashes and runs init, reopen, `schema_migrations`, and SQLite `quick_check` against a private temporary database.

Use separate private volumes for Core data, Book artifacts, runtime evidence and backups. Do not mount source code or the
secret directory inside a public web root. The Node process remains loopback-only. The packaged `Caddyfile.example` is the
accepted executable boundary: its private-worker matcher is ordered before the public application proxy, rejects missing
`Content-Length`, chunked POSTs and declared bodies above 32,768 bytes locally with `413`, retains the streaming `32KiB`
backstop, and preserves `Authorization`, `Cookie`, upstream response content/CSP, public `Host`, and
`X-Forwarded-Proto: https`. Production has no outer proxy Basic Auth: OTP, capability and cookie authorization belong to
the application. The proxy adds transport HSTS but does not replace the application's CSP. Render it into a root-only
`0600` staging file only after privately replacing `REQUIRED_DOMAIN`; never emit the rendered bytes. Before changing the
live file, seal the prior live bytes as `root:root 0600`. The installed `/etc/caddy/Caddyfile` is a different permission boundary: install it as
`root:caddy 0640`, require the distribution service identity to read it, then validate and reload. Never `cp` a package or
sealed-backup Caddyfile directly onto the live path because preserving `0600` makes the distribution reload fail.

```sh
getent group caddy >/dev/null
install -d -o root -g root -m 0700 /var/backups/unseen/production/REQUIRED_BACKUP_ID
install -o root -g root -m 0600 /etc/caddy/Caddyfile \
  /var/backups/unseen/production/REQUIRED_BACKUP_ID/Caddyfile
install -o root -g caddy -m 0640 /run/unseen/release-render/Caddyfile \
  /etc/caddy/Caddyfile
test "$(stat -c '%U:%G:%a' /etc/caddy/Caddyfile)" = root:caddy:640
sudo -u caddy test -r /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl is-active --quiet caddy
```

The proxy must preserve `Host`, terminate TLS, and expose neither child ports nor filesystem paths.

With the flag intentionally off, the isolated lifecycle smoke uses Core `GET /healthz` and proves zero Book import/store/write. After the three release facts are accepted and the owner wiring enables Book, readiness additionally requires `GET /__book-lab/healthz` on the same origin with `fixtureFallback: false`; a healthy transport alone is never release approval.

## Backup, restore and rollback

Before every migration or deploy, stop the service and create plus verify a named snapshot with the existing operation-lock-aware tool:

```sh
UNSEEN_STAGING_SNAPSHOT_ID=pre-deploy-ID \
  node --env-file=/etc/unseen/production.env infra/integration/staging-snapshot.mjs backup
UNSEEN_STAGING_SNAPSHOT_DIR=/var/backups/unseen/production/pre-deploy-ID \
  node --env-file=/etc/unseen/production.env infra/integration/staging-snapshot.mjs verify
```

The production template points snapshot commit binding at the exact immutable release, so both Core and integrated Book code bind to the candidate; Book7d is not a production snapshot input. The data root includes both Core and Book databases. The tool refuses live, overlapping, dirty, symlinked, tampered or permission-unsafe inputs and verifies Core SQLite plus every restored byte. Stop and mask the service during snapshot/restore, copy the verified snapshot to the approved independent backup target, and enforce the approved retention there.

For rollback, stop and mask the service, move (never delete) the current data root aside, restore only into empty targets, reinstall the previous rendered unit and environment bound to the exact commit in the chosen snapshot manifest, then start and require Core health plus the appropriate flag-off/on release smoke. If Caddy must roll back, install the sealed `root:root 0600` backup onto the live path as `root:caddy 0640`, repeat the service-user readability check, validate, reload, and require Caddy active; never preserve the backup mode on the live file. Retain both failed and previous immutable release directories plus evidence until the incident owner approves disposition.

```sh
install -o root -g caddy -m 0640 \
  /var/backups/unseen/production/REQUIRED_BACKUP_ID/Caddyfile /etc/caddy/Caddyfile
test "$(stat -c '%U:%G:%a' /etc/caddy/Caddyfile)" = root:caddy:640
sudo -u caddy test -r /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl is-active --quiet caddy
```

After every start or rollback, the only active-release proof is the conjunction of the loaded unit, its active process and its immutable Git checkout. Require `ActiveState=active`, nonzero `MainPID`, the PID in the reported `ControlGroup`, exact `WorkingDirectory=$release_dir`, `/proc/$MainPID/cwd=$release_dir`, detached exact HEAD, exact tree and a clean checkout. A directory, including `/opt/unseen/core`, is never active-release evidence by itself. Full data commands and stale-lock recovery rules remain in `release-evidence/local-operable/staging/README.md`.

```sh
expected_commit=EXPECTED_ACTIVE_COMMIT
expected_tree=EXPECTED_ACTIVE_TREE
release_dir="/opt/unseen/releases/$expected_commit"
test "$(systemctl show unseen.service -p ActiveState --value)" = active
test "$(systemctl show unseen.service -p WorkingDirectory --value)" = "$release_dir"
main_pid="$(systemctl show unseen.service -p MainPID --value)"
case "$main_pid" in ''|0|*[!0-9]*) exit 1 ;; esac
control_group="$(systemctl show unseen.service -p ControlGroup --value)"
test -n "$control_group"
grep -Fx "0::$control_group" "/proc/$main_pid/cgroup"
test "$(readlink -f "/proc/$main_pid/cwd")" = "$release_dir"
test "$(git -C "$release_dir" rev-parse HEAD)" = "$expected_commit"
test "$(git -C "$release_dir" rev-parse 'HEAD^{tree}')" = "$expected_tree"
test "$(git -C "$release_dir" rev-parse --abbrev-ref HEAD)" = HEAD
test -z "$(git -C "$release_dir" status --porcelain)"
```
