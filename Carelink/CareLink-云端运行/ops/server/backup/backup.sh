#!/usr/bin/env bash
# Daily backup of the UNSEEN production data set: both sqlite databases (consistent, WAL-safe
# copies — never a raw `cp` of a live database file), the media directory (synced as a real
# directory tree, BYTE-COPIED — never hard-linked — from the live media dir; see the warning
# above sync_media() for why hard links against live media are forbidden here), the non-secret
# systemd/Caddy configuration, and an ENCRYPTED bundle of everything genuinely secret
# (/etc/unseen/*.env, the local encryption keyset, the OTP mailbox file, the private-ai token
# store). Writes one self-contained, timestamped directory per run under
# UNSEEN_BACKUP_ROOT (default /var/backups/unseen), then prunes older runs beyond the configured
# retention count. Upload to offsite storage is a separate step — see upload-to-cos.sh — so this
# script alone is safe to run standalone for a local-only backup.
#
# Usage (as root, on the server):
#   ./backup.sh
#
# Exit code is non-zero on any failure; a partially-built run is never left where retention
# pruning, upload-to-cos.sh, or restore-drill.sh could mistake it for a complete backup (it is
# assembled in a hidden .tmp-* directory and only renamed to its final timestamped name after
# every step, including manifest checksum generation, has succeeded).
#
# Idempotent / safe to re-run: concurrent runs are prevented by a flock on
# UNSEEN_BACKUP_ROOT/.backup.lock (a second run started while one is in flight exits 0
# immediately rather than racing it). Re-running after a full success simply produces a new,
# separate timestamped backup.
#
# All paths below are overridable via environment variables so this script and restore-drill.sh
# can be pointed at a throwaway local sandbox for testing (see the self-test performed while
# building this script — construct a fake data dir, a fake /etc/unseen, a fake media/ tree, and
# point every UNSEEN_BACKUP_* variable at it).
#
# Sources (see the running background for why these are exactly the paths that matter):
#   UNSEEN_BACKUP_DATA_DIR              default: /var/lib/unseen/operable/data
#   UNSEEN_BACKUP_UNSEEN_SQLITE         default: ${UNSEEN_BACKUP_DATA_DIR}/unseen.sqlite
#   UNSEEN_BACKUP_BOOKLAB_SQLITE        default: ${UNSEEN_BACKUP_DATA_DIR}/book-lab.sqlite
#   UNSEEN_BACKUP_MEDIA_DIR             default: ${UNSEEN_BACKUP_DATA_DIR}/media
#   UNSEEN_BACKUP_KEYSET_FILE           default: ${UNSEEN_BACKUP_DATA_DIR}/local.keyset.json
#   UNSEEN_BACKUP_OTP_MAILBOX_FILE      default: ${UNSEEN_BACKUP_DATA_DIR}/.otp-mailbox.json
#   UNSEEN_BACKUP_ETC_UNSEEN_DIR        default: /etc/unseen
#   UNSEEN_BACKUP_PRIVATE_AI_DIR        default: /var/lib/unseen/private-ai
#   UNSEEN_BACKUP_SYSTEMD_UNITS         default: "unseen-operable.service unseen-minimax-worker.service"
#                                        (space-separated unit names under /etc/systemd/system;
#                                        each unit's own .d/*.conf drop-ins are picked up automatically)
#   UNSEEN_BACKUP_CADDYFILE             default: /etc/caddy/Caddyfile
#
# Destination / policy:
#   UNSEEN_BACKUP_ROOT                  default: /var/backups/unseen
#   UNSEEN_BACKUP_RETENTION_COUNT       default: 7   (how many timestamped runs to keep locally)
#   UNSEEN_BACKUP_MEDIA_MAX_BYTES       default: 2147483648 (2 GiB). Above this, the run FAILS
#                                        without publishing or pruning earlier backups —
#                                        see the comment above sync_media() for the tradeoff.
#   UNSEEN_BACKUP_ENCRYPTION_PASSPHRASE_FILE
#                                        default: /etc/unseen/backup-encryption.passphrase
#                                        A root-only (0600/0400), single-line passphrase file used
#                                        as the symmetric key for the secrets bundle. Must ALSO be
#                                        saved somewhere off this server (e.g. Max's password
#                                        manager) — losing it makes the encrypted offsite secrets
#                                        bundle permanently unreadable even though the ciphertext
#                                        itself survived.
#
# Tool overrides (rarely needed): UNSEEN_BACKUP_SQLITE3_BIN (default sqlite3),
#   UNSEEN_BACKUP_GPG_BIN (default gpg), UNSEEN_BACKUP_NODE_BIN (default /usr/local/bin/node).
#
# Never echoes the encryption passphrase or any secret file content, not even under failure, and
# never uses `set -x`.
set -euo pipefail

log()  { printf '%s backup.sh: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { printf '%s backup.sh: WARNING: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die()  { printf '%s backup.sh: ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

if [[ "$(id -u)" -ne 0 ]]; then
  die "must run as root (needs read access to /etc/unseen, /var/lib/unseen and friends)"
fi

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
for c in tar gzip sha256sum flock mktemp date du find sort; do require_cmd "$c"; done

sqlite3_bin="${UNSEEN_BACKUP_SQLITE3_BIN:-sqlite3}"
gpg_bin="${UNSEEN_BACKUP_GPG_BIN:-gpg}"
require_cmd "$sqlite3_bin"

data_dir="${UNSEEN_BACKUP_DATA_DIR:-/var/lib/unseen/operable/data}"
unseen_sqlite="${UNSEEN_BACKUP_UNSEEN_SQLITE:-${data_dir}/unseen.sqlite}"
booklab_sqlite="${UNSEEN_BACKUP_BOOKLAB_SQLITE:-${data_dir}/book-lab.sqlite}"
media_dir="${UNSEEN_BACKUP_MEDIA_DIR:-${data_dir}/media}"
keyset_file="${UNSEEN_BACKUP_KEYSET_FILE:-${data_dir}/local.keyset.json}"
otp_mailbox_file="${UNSEEN_BACKUP_OTP_MAILBOX_FILE:-${data_dir}/.otp-mailbox.json}"
etc_unseen_dir="${UNSEEN_BACKUP_ETC_UNSEEN_DIR:-/etc/unseen}"
private_ai_dir="${UNSEEN_BACKUP_PRIVATE_AI_DIR:-/var/lib/unseen/private-ai}"
caddyfile="${UNSEEN_BACKUP_CADDYFILE:-/etc/caddy/Caddyfile}"
# shellcheck disable=SC2206 # intentional word-splitting of a caller-supplied space-separated list
systemd_units=(${UNSEEN_BACKUP_SYSTEMD_UNITS:-huijian.service unseen-operable.service unseen-minimax-worker.service})
systemd_unit_dir="${UNSEEN_BACKUP_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"

backup_root="${UNSEEN_BACKUP_ROOT:-/var/backups/unseen}"
retention_count="${UNSEEN_BACKUP_RETENTION_COUNT:-7}"
media_max_bytes="${UNSEEN_BACKUP_MEDIA_MAX_BYTES:-2147483648}"
passphrase_file="${UNSEEN_BACKUP_ENCRYPTION_PASSPHRASE_FILE:-/etc/unseen/backup-encryption.passphrase}"

case "$retention_count" in ''|*[!0-9]*) die "UNSEEN_BACKUP_RETENTION_COUNT must be a positive integer" ;; esac
case "$media_max_bytes" in ''|*[!0-9]*) die "UNSEEN_BACKUP_MEDIA_MAX_BYTES must be a non-negative integer" ;; esac

[[ -f "$unseen_sqlite" ]] || die "unseen.sqlite not found at ${unseen_sqlite} (set UNSEEN_BACKUP_UNSEEN_SQLITE)"
[[ -f "$booklab_sqlite" ]] || die "book-lab.sqlite not found at ${booklab_sqlite} (set UNSEEN_BACKUP_BOOKLAB_SQLITE)"
[[ -d "$media_dir" ]] || die "media directory not found at ${media_dir}; earlier backups will be retained"
[[ -s "$keyset_file" && -r "$keyset_file" ]] || die "keyset missing, empty or unreadable at ${keyset_file}; earlier backups will be retained"

install -d -m 0700 -o root -g root "$backup_root"

# gpg insists on a writable GNUPGHOME (keybox/trustdb bookkeeping) even for plain symmetric
# encryption. Point it at a directory under backup_root — writable under the unseen-backup.service
# hardening (ProtectSystem=strict + ReadWritePaths=/var/backups/unseen; see that file's comment
# for the full ProtectSystem= history) since backup_root sits inside the one path this unit is
# explicitly allowed to write to — rather than trusting $HOME/.gnupg, which ProtectHome=true on
# that unit makes inaccessible.
export GNUPGHOME="${backup_root}/.gnupg"
install -d -m 0700 -o root -g root "$GNUPGHOME"

# Single-writer lock: a second concurrent invocation (e.g. a slow run still finishing when the
# next day's timer fires) exits cleanly instead of racing this one's temp directory or manifest.
lock_file="${backup_root}/.backup.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
  log "another backup run holds the lock, exiting without doing anything"
  exit 0
fi

# Sweep stale temp workdirs left behind by a crashed previous run (older than 24h — a run in
# progress right now is always younger than that, so this never touches the live one).
find "$backup_root" -maxdepth 1 -mindepth 1 -type d -name '.tmp-*' -mmin +1440 -exec rm -rf -- {} + 2>/dev/null || true

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
work_dir="$(mktemp -d "${backup_root}/.tmp-${timestamp}.XXXXXX")"
final_dir="${backup_root}/${timestamp}"

cleanup() {
  local status=$?
  if [[ -d "$work_dir" ]]; then
    warn "run did not complete successfully, removing incomplete workdir ${work_dir}"
    rm -rf -- "$work_dir"
  fi
  exec 9>&- || true
  exit "$status"
}
trap cleanup EXIT

manifest="${work_dir}/MANIFEST.txt"
warnings=()

record_warning() { local msg="$*"; warnings+=("$msg"); warn "$msg"; }

# --- sqlite databases: online-backup API, never a raw cp of a WAL-active file -----------------
backup_sqlite() {
  local src="$1" dest_name="$2"
  local dest="${work_dir}/${dest_name}"
  case "$src" in *"'"*) die "refusing to back up a path containing a single quote: ${src}" ;; esac
  log "backing up ${src} -> ${dest_name}"
  "$sqlite3_bin" "$src" ".backup '${dest}'" || die "sqlite3 .backup failed for ${src}"
  [[ -s "$dest" ]] || die "sqlite3 .backup produced an empty file for ${src}"
  local check
  check="$("$sqlite3_bin" "$dest" 'PRAGMA integrity_check;')"
  [[ "$check" == "ok" ]] || die "PRAGMA integrity_check failed on the fresh backup of ${src}: ${check}"
}
backup_sqlite "$unseen_sqlite" "unseen.sqlite"
backup_sqlite "$booklab_sqlite" "book-lab.sqlite"

# --- media: synced as a real directory tree, BYTE-COPIED (never hard-linked) from the live -----
# media dir ---------------------------------------------------------------------------------------
#
# ================================================================================================
# DO NOT HARD-LINK MEDIA AGAINST THE LIVE MEDIA DIRECTORY. Not `cp -al`, not `ln`, not
# `rsync --link-dest=<live media dir>`, not anything else that gives a backup-side path a second
# hard link to a file that is still reachable from the live media directory.
#
# Why: services/api/src/ports/media/filesystem-media-store.mjs:22 asserts, on EVERY read, that a
# media object file has exactly `nlink === 1`:
#     assert(stat.isFile() && (stat.mode & 0o077) === 0 && stat.nlink === 1,
#       "media_store_permissions_invalid", 503);
# This is a deliberate anti-tamper / anti-alias invariant: a media object must be reachable
# through exactly one filesystem path, ever. It is not a soft check — any file whose nlink is not
# exactly 1 makes every read of that object return 503 media_store_permissions_invalid, forever,
# until the extra link is removed.
#
# This already happened in production. An earlier version of this function used `cp -al` to
# hard-link media/ into the backup tree instead of copying it. It looked correct (media objects
# are write-once and never rewritten in place, so "sharing the inode is safe" felt true) and it
# shipped. The next scheduled run (unseen-backup.timer, 03:15 Asia/Hong_Kong) hard-linked every
# media file in the live directory into the backup tree, pushing every one of their nlink counts
# to 2+. Every media read in production started returning 503 — every album thumbnail, in every
# space, site-wide. Mitigation was deleting the hard-linked copies out of the backup tree
# (restoring nlink=1 on the live files) and disabling the timer so it couldn't do it again that
# night. This function is the fix: byte copy only, never a link, full stop.
# ================================================================================================
#
# What this function does: `cp -a` — a recursive, attribute-preserving BYTE copy (real, independent
# file content and inode, not a link) — of media/ into the backup, as a real directory tree (same
# relative file paths as the source; NOT re-packed into media.tar.gz). Two things from the
# hard-link design this replaced are deliberately KEPT, because they were correct on their own
# merits and are unrelated to hard-linking:
#
#   1. media/ stays a real directory tree, not a single tar.gz. A tar.gz is one opaque blob — ANY
#      single byte changing anywhere inside it changes the whole archive's bytes, which is what
#      forced Max's nightly `rsync` pull from the server to re-transfer the ENTIRE archive every
#      night regardless of how little of media/ actually changed that day (this was the original
#      problem being fixed, and it gets worse as video upload takes media from ~24MB towards an
#      estimated ~660MB per 50x60s upload event).
#
#   2. Incremental transfer on the PULL side (Max's Mac, outside this repo) is still achievable
#      with zero hard links anywhere near the live media dir: pull each day into its own fresh
#      local directory with `rsync --link-dest=<yesterday's local pull dir>`. `--link-dest`
#      matches candidate files by RELATIVE PATH (`media/<name>`, stable across days) plus rsync's
#      quick check (size + mtime) against that local reference directory — it never inspects, and
#      does not care, whether the SOURCE side has any hard links at all. `cp -a` preserves each
#      source file's mtime, and application media objects are write-once and never rewritten in
#      place (see services/api/src/README.md: "atomically linked into isolated key paths, ... and
#      never overwritten"), so an unchanged file's byte-copied backup carries the same size+mtime
#      every night — `--link-dest` still hard-links it locally, on the PULLER's own Mac, among his
#      own previously-pulled copies, instead of re-transferring it. That is the only hard-linking
#      involved anywhere in this design; it happens nowhere near, and has no path back to, the live
#      production media directory that filesystem-media-store.mjs's nlink check watches.
#      (The OTHER incremental option from the original design — mirroring the whole retained tree
#      with `rsync -a -H` so the puller's rsync notices today's file is hard-linked, on the SOURCE
#      side, to an already-pulled file — no longer applies now that the source side is independent
#      byte copies, not hard links. Use `--link-dest`; it never depended on source-side linking.)
#
# What's DIFFERENT, and the actual cost of this fix: every retained day's `<timestamp>/media/` is
# now its own independent set of bytes on THIS server's disk, not a directory of hard links sharing
# inodes with the live source or with each other. 7-day retention therefore costs ~7x the disk for
# media that never changes, not ~1x. At today's media size (~26MB) that is irrelevant (~180MB
# worst case). Once video upload ships, the ~660MB-per-event estimate above means a week with a
# fully populated event could cost on the order of ~4.6GB across 7 kept days — still comfortably
# inside this server's ~30GB available disk, but a real number, not a rounding error, and someone
# should actually watch it (`du -sh /var/backups/unseen`) once video traffic is real rather than
# assume it stays small forever. If retention cost ever becomes a real problem, the fix is a
# SOURCE-side dedup scheme that still never touches the live media directory (e.g. content-
# addressed storage, or `--link-dest` chaining between this server's OWN prior backup runs) — not
# hard-linking against live media again.
#
# The 2 GiB guard below measures the live media dir's logical size and fails the WHOLE run
# (never publishes a partial backup) above the cap. This forces a
# human decision (raise the guard deliberately, or revisit media/'s flat-directory layout) rather
# than silently letting an unbounded directory balloon sync time / disk / offsite-upload cost.
sync_media() {
  local media_dest="${work_dir}/media"
  if [[ ! -d "$media_dir" ]]; then
    die "media dir ${media_dir} disappeared; refusing to publish an incomplete backup"
  fi
  local size_bytes
  size_bytes="$(du -sb "$media_dir" 2>/dev/null | cut -f1)" \
    || die "could not measure size of ${media_dir}; refusing to publish an incomplete backup"
  case "$size_bytes" in ''|*[!0-9]*) die "invalid media size for ${media_dir}; refusing to publish an incomplete backup" ;; esac
  if (( size_bytes > media_max_bytes )); then
    die "media dir ${media_dir} is ${size_bytes} bytes, over the ${media_max_bytes}-byte guard" \
      "(UNSEEN_BACKUP_MEDIA_MAX_BYTES); earlier backups will be retained. Check disk headroom" \
      "before deliberately raising the guard"
  fi

  log "byte-copying media (${size_bytes} logical bytes) from ${media_dir}"
  # `cp -a` — a real byte copy, preserving mode/ownership/timestamps — NEVER `cp -al`. See the
  # warning block above this function: a hard link here corrupts the live media store's nlink=1
  # invariant and takes down photo reads site-wide. A byte copy also has no EXDEV/cross-device
  # failure mode to recover from the way `link()` does — `cp -a` copies bytes the same way whether
  # source and destination are on the same filesystem, different filesystems, or on either side of
  # a systemd bind-mount boundary — so there is deliberately no fallback branch here anymore.
  cp -a -- "$media_dir" "$media_dest" || die "byte copy of ${media_dir} to ${media_dest} failed"

  # Per-file checksum manifest. media/ has no single blob to sha256 the way media.tar.gz did, and
  # files are not literally named by content hash either — the store names each object
  # `sha256(logical-key).media` (services/api/src/ports/media/filesystem-media-store.mjs), so the
  # filename alone can't be used to verify content. Walk the copied tree for real and hash every
  # file — this is strictly MORE thorough integrity coverage than the old scheme had (a single
  # tar.gz checksum only proved the archive as a whole was intact, never that any individual
  # member's bytes were still correct on their own).
  local media_list="${work_dir}/media.SHA256SUMS"
  ( cd "$work_dir" && find media -type f -print0 | LC_ALL=C sort -z \
      | while IFS= read -r -d '' f; do sha256sum -- "$f"; done ) > "$media_list" \
    || die "failed to build media.SHA256SUMS for ${media_dir}"
  local file_count
  file_count="$(wc -l < "$media_list" | tr -d ' ')"
  log "media sync complete: ${file_count} file(s), ${size_bytes} logical bytes"
}
sync_media

# --- config: systemd units + drop-ins + Caddyfile, plaintext (no secret VALUES expected here) -
# Defense in depth: scan every file before it goes in the plaintext bundle for lines that look
# like an inline secret assignment (SECRET/TOKEN/PASSWORD/API_KEY/PRIVATE_KEY/ACCESS_KEY = ...).
# The known drop-ins (otp-tencent-api, minimax-worker) only ever set EnvironmentFile= pointers,
# not secret values, but this repo's own audit could not read every drop-in on the live server to
# confirm that holds for all of them — so this is a hard gate, not just a warning: a hit removes
# the offending file from the plaintext bundle and marks the whole config bundle SUSPECT so
# upload-to-cos.sh requires proof that the excluded files were included in the encrypted bundle.
looks_like_inline_secret() {
  grep -EIqi '(SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY|_TOKEN)[A-Za-z0-9_]*[[:space:]]*[:=][[:space:]]*[^[:space:]]' -- "$1" 2>/dev/null
}

sensitive_config_paths=()
pack_config() {
  local config_stage="${work_dir}/.config-stage"
  install -d -m 0700 "$config_stage"
  local collected=0 suspect=0
  local unit path
  for unit in "${systemd_units[@]}"; do
    path="${systemd_unit_dir}/${unit}"
    if [[ -f "$path" ]]; then
      if looks_like_inline_secret "$path"; then
        record_warning "config file ${path} looks like it contains an inline secret assignment;" \
          "excluding it from the plaintext config bundle"
        sensitive_config_paths+=("$path")
        suspect=1
      else
        install -D -m 0644 "$path" "${config_stage}/etc/systemd/system/${unit}"
        collected=1
      fi
    else
      record_warning "expected systemd unit ${path} not found, skipping"
    fi
    local dropin_dir="${systemd_unit_dir}/${unit}.d"
    if [[ -d "$dropin_dir" ]]; then
      local f
      while IFS= read -r -d '' f; do
        local rel="${f#"${systemd_unit_dir}"/}"
        if looks_like_inline_secret "$f"; then
          record_warning "drop-in ${f} looks like it contains an inline secret assignment;" \
            "excluding it from the plaintext config bundle"
          sensitive_config_paths+=("$f")
          suspect=1
        else
          install -D -m 0644 "$f" "${config_stage}/etc/systemd/system/${rel}"
          collected=1
        fi
      done < <(find "$dropin_dir" -maxdepth 1 -type f -name '*.conf' -print0)
    fi
  done
  if [[ -f "$caddyfile" ]]; then
    if looks_like_inline_secret "$caddyfile"; then
      record_warning "Caddyfile ${caddyfile} looks like it contains an inline secret assignment;" \
        "excluding it from the plaintext config bundle"
      sensitive_config_paths+=("$caddyfile")
      suspect=1
    else
      install -D -m 0644 "$caddyfile" "${config_stage}/etc/caddy/Caddyfile"
      collected=1
    fi
  else
    record_warning "Caddyfile ${caddyfile} not found, skipping"
  fi

  if (( collected )); then
    tar -C "$config_stage" -czf "${work_dir}/config.tar.gz" . || die "tar failed while packing config"
  else
    record_warning "no config files were collected, config.tar.gz was not created"
  fi
  if (( suspect )); then
    echo "One or more config files were excluded because they looked like they contain an inline" \
      "secret. Check the run's warnings (journalctl -u unseen-backup) and inspect the source files" \
      "by hand before trusting or uploading config.tar.gz from this run." \
      > "${work_dir}/config.SECRETS_SUSPECTED"
  fi
  rm -rf -- "$config_stage"
}
pack_config

# --- secrets: tar then symmetric-encrypt, plaintext intermediate never touches disk longer than
# it takes to encrypt it (removed immediately after, best-effort shredded) ---------------------
pack_secrets() {
  local secret_stage="${work_dir}/.secret-stage"
  install -d -m 0700 "$secret_stage"
  local collected=0

  # Suspected inline secrets are still necessary to restore the running service.
  # Keep their full configuration only inside the encrypted archive.
  local config_file rel
  for config_file in "${sensitive_config_paths[@]}"; do
    if [[ "$config_file" == "$caddyfile" ]]; then rel="etc/caddy/Caddyfile"
    else rel="etc/systemd/system/${config_file#"${systemd_unit_dir}"/}"; fi
    install -D -m 0600 "$config_file" "${secret_stage}/${rel}"
    collected=1
  done
  if (( ${#sensitive_config_paths[@]} )); then
    printf '%s\n' "Inline secret configuration was included in secrets.tar.gz.gpg." > "${work_dir}/config.ENCRYPTED"
  fi
  local app_etc="${UNSEEN_BACKUP_APP_ETC_DIR:-/etc/huijian}"
  local app_state="${UNSEEN_BACKUP_APP_STATE_DIR:-/var/lib/huijian}"
  if [[ -d "$app_etc" ]]; then
    while IFS= read -r -d '' config_file; do
      install -D -m 0600 "$config_file" "${secret_stage}/etc/huijian/${config_file#"${app_etc}"/}"
      collected=1
    done < <(find "$app_etc" -type f -print0)
  fi
  # World request identity/cost ledgers are atomic JSON documents, not live SQLite.
  for rel in world-jobs.json worldlabs-usage.json photo-ai-usage.json; do
    if [[ -f "${app_state}/${rel}" ]]; then
      install -D -m 0600 "${app_state}/${rel}" "${secret_stage}/huijian-state/${rel}"
      collected=1
    fi
  done

  if [[ -d "$etc_unseen_dir" ]]; then
    # Copy everything under /etc/unseen EXCEPT the backup passphrase file itself and this
    # subsystem's own COS credential file — those authenticate the backup pipeline; leaking them
    # into the backup they produce would let anyone who reads one backup decrypt/overwrite all of
    # them. Application secrets (SES keys, minimax key, private-ai token hash, etc.) still go in.
    local f rel
    while IFS= read -r -d '' f; do
      rel="${f#"${etc_unseen_dir}"/}"
      case "$rel" in
        backup-encryption.passphrase|backup-cos.env) continue ;;
      esac
      install -D -m 0600 "$f" "${secret_stage}/etc/unseen/${rel}"
      collected=1
    done < <(find "$etc_unseen_dir" -type f -print0)
  else
    record_warning "${etc_unseen_dir} does not exist, no application secrets collected"
  fi

  if [[ -s "$keyset_file" && -r "$keyset_file" ]]; then
    install -D -m 0600 "$keyset_file" "${secret_stage}/keyset/$(basename "$keyset_file")"
    collected=1
  else
    die "keyset file ${keyset_file} missing, empty or unreadable; refusing to publish an incomplete backup"
  fi

  if [[ -f "$otp_mailbox_file" ]]; then
    install -D -m 0600 "$otp_mailbox_file" "${secret_stage}/otp-mailbox/$(basename "$otp_mailbox_file")"
    collected=1
  fi

  if [[ -d "$private_ai_dir" ]]; then
    local f rel
    while IFS= read -r -d '' f; do
      rel="${f#"${private_ai_dir}"/}"
      install -D -m 0600 "$f" "${secret_stage}/private-ai/${rel}"
      collected=1
    done < <(find "$private_ai_dir" -type f -print0)
  fi

  if (( ! collected )); then
    record_warning "no secret material found to back up (nothing under ${etc_unseen_dir}, no" \
      "keyset, no private-ai state) — secrets.tar.gz.gpg was not created"
    rm -rf -- "$secret_stage"
    return
  fi

  [[ -f "$passphrase_file" ]] || die "encryption passphrase file ${passphrase_file} not found —" \
    "provision it (see report / runbook) before secrets can be backed up"
  local mode
  mode="$(stat -c '%a' "$passphrase_file" 2>/dev/null || stat -f '%Lp' "$passphrase_file")"
  [[ "$mode" == "600" || "$mode" == "400" ]] || die "${passphrase_file} must be mode 0600 or 0400" \
    "(found ${mode})"
  require_cmd "$gpg_bin"

  # Use the copied keyset and SQLite snapshot, never the live files. A readable
  # archive alone is insufficient: every private record and referenced original
  # must survive before this run can replace an earlier complete backup.
  local node_bin="${UNSEEN_BACKUP_NODE_BIN:-/usr/local/bin/node}" script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  require_cmd "$node_bin"
  "$node_bin" "${script_dir}/verify-private-backup.mjs" "${work_dir}/unseen.sqlite" \
    "${secret_stage}/keyset/$(basename "$keyset_file")" \
    || die "private records or referenced media cannot be restored; earlier backups will be retained"

  local plaintext_tar="${work_dir}/.secrets-plaintext.tar.gz"
  tar -C "$secret_stage" -czf "$plaintext_tar" . || die "tar failed while packing secrets"
  rm -rf -- "$secret_stage"

  "$gpg_bin" --batch --yes --pinentry-mode loopback --passphrase-file "$passphrase_file" \
    --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
    --output "${work_dir}/secrets.tar.gz.gpg" "$plaintext_tar" \
    || die "gpg symmetric encryption of the secrets bundle failed"

  if command -v shred >/dev/null 2>&1; then
    shred -u "$plaintext_tar"
  else
    rm -f "$plaintext_tar"
  fi
}
pack_secrets

# These are mandatory recovery materials. A failed or skipped collection must never
# become the newest published run or cause an earlier complete backup to be pruned.
[[ -d "${work_dir}/media" && -f "${work_dir}/media.SHA256SUMS" && ! -e "${work_dir}/media.SKIPPED" ]] \
  || die "media backup is incomplete; earlier backups will be retained"
[[ -s "${work_dir}/secrets.tar.gz.gpg" ]] \
  || die "encrypted keyset bundle is missing or empty; earlier backups will be retained"

# --- manifest: sizes + sha256 of every artifact actually produced, plus warnings ---------------
# media/ is a directory now, not a single file, so it can't go through the same "one size + one
# sha256" line as the other artifacts below — it gets its own summary line (file count + total
# logical bytes), and its real per-file integrity data lives in media.SHA256SUMS, which DOES then
# flow through the generic loop below like any other artifact (so its own sha256 — covering every
# individual media file's checksum — is itself chained into the top-level SHA256SUMS, and tamper
# with the manifest file itself would be caught same as tamper with config.tar.gz would be).
{
  echo "UNSEEN backup manifest"
  echo "timestamp_utc: ${timestamp}"
  echo "host: $(hostname 2>/dev/null || echo unknown)"
  echo "generated_by: ops/server/backup/backup.sh"
  echo
  echo "artifacts:"
  if [[ -d "${work_dir}/media" ]]; then
    media_file_count="$(wc -l < "${work_dir}/media.SHA256SUMS" 2>/dev/null | tr -d ' ')"
    media_bytes="$(du -sb "${work_dir}/media" 2>/dev/null | cut -f1)"
    printf '  %-28s files=%-8s bytes=%-12s (see media.SHA256SUMS for per-file sha256)\n' \
      "media/" "${media_file_count:-0}" "${media_bytes:-unknown}"
  fi
  for f in unseen.sqlite book-lab.sqlite media.SHA256SUMS media.SKIPPED \
    config.tar.gz config.SECRETS_SUSPECTED config.ENCRYPTED secrets.tar.gz.gpg; do
    if [[ -f "${work_dir}/${f}" ]]; then
      size="$(stat -c '%s' "${work_dir}/${f}" 2>/dev/null || stat -f '%z' "${work_dir}/${f}")"
      sum="$(sha256sum "${work_dir}/${f}" | cut -d' ' -f1)"
      printf '  %-28s size=%-10s sha256=%s\n' "$f" "$size" "$sum"
    fi
  done
  echo
  if (( ${#warnings[@]} > 0 )); then
    echo "warnings:"
    for w in "${warnings[@]}"; do printf '  - %s\n' "$w"; done
  else
    echo "warnings: (none)"
  fi
} > "$manifest"

# sha256sum-friendly companion file so restore-drill.sh (and any human) can `sha256sum -c` it.
# media.SHA256SUMS stands in for media.tar.gz here — see the comment above the manifest block —
# so this top-level file covers "is the media checksum manifest itself intact" and
# media.SHA256SUMS covers "is every individual media file's content still intact".
( cd "$work_dir" && for f in unseen.sqlite book-lab.sqlite media.SHA256SUMS config.tar.gz \
    secrets.tar.gz.gpg config.SECRETS_SUSPECTED config.ENCRYPTED MANIFEST.txt; do
    if [[ -f "$f" ]]; then sha256sum "$f" || exit 1; fi
  done ) > "${work_dir}/SHA256SUMS" || die "failed to create SHA256SUMS; earlier backups will be retained"

log "assembling complete, publishing ${final_dir}"
mv -T "$work_dir" "$final_dir" || die "failed to publish backup directory ${final_dir}"
# From here on `cleanup` must not delete anything: work_dir no longer exists under that name.
work_dir="/nonexistent-already-published"

total_size="$(du -sh "$final_dir" 2>/dev/null | cut -f1)"
log "backup OK: ${final_dir} (${total_size:-unknown size}), ${#warnings[@]} warning(s)"

# --- retention: prune older runs, newest N kept. Only reached after a full success, so a failed
# run never causes a good backup to be pruned. ---------------------------------------------------
prune_old_backups() {
  local keep="$1" dirs=() d
  while IFS= read -r d; do dirs+=("$d"); done < <(
    find "$backup_root" -maxdepth 1 -mindepth 1 -type d \
      -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z' | sort -r
  )
  if (( ${#dirs[@]} > keep )); then
    local i
    for (( i = keep; i < ${#dirs[@]}; i++ )); do
      log "pruning old backup ${dirs[$i]}"
      rm -rf -- "${dirs[$i]}"
    done
  fi
}
prune_old_backups "$retention_count"

log "done"
