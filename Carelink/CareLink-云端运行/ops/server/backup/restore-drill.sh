#!/usr/bin/env bash
# Restore drill: proves that the LATEST local backup produced by backup.sh is actually usable,
# not just present. Copies (never moves, never touches the live data dir or the backup itself)
# the two sqlite databases from the newest complete backup into a scratch directory under /tmp,
# verifies their checksums against the backup's own manifest, runs PRAGMA integrity_check on
# each, then runs a handful of real read-only queries against the real production schema (space
# count, photo count, most recent upload batch / photo capture time, book-lab book/version
# counts) so "can we get data back out of this" is answered with actual query results, not just
# "the file opened". media/ (a real byte-copied directory tree, not a tar, and never hard-linked
# against the live media dir — see the warning above sync_media() in backup.sh for why) is
# verified in place by recomputing sha256 for every file under it against the backup's own
# media.SHA256SUMS — proving each file's bytes are intact and readable without needing to copy
# potentially hundreds of MB.
#
# Default checks prove databases/media only and report PARTIAL. --verify-secrets decrypts
# into the private scratch directory and verifies encrypted personal records with the
# backed-up keyset. It never restores anything over a live file or prints private content.
#
# Never touches production: only reads from the backup directory (read-only) and writes into a
# fresh mktemp scratch dir under /tmp (or UNSEEN_BACKUP_DRILL_TMPDIR), which it removes on exit
# unless --keep is given.
#
# Usage (as root, on the server):
#   ./restore-drill.sh              # drill the newest backup under UNSEEN_BACKUP_ROOT
#   ./restore-drill.sh /path/to/backup/20260817T031500Z   # drill a specific backup dir
#   ./restore-drill.sh --keep       # leave the scratch dir behind for manual poking
#
# Exit code reflects the verdict: 0 only if every check passed. A partial failure still prints
# the full report (it does not stop at the first failing check) so a single bad query doesn't
# hide everything else that did or didn't work.
#
# UNSEEN_BACKUP_ROOT              default: /var/backups/unseen (where to look for the newest backup)
# UNSEEN_BACKUP_DRILL_TMPDIR      default: /tmp (parent dir for the mktemp scratch dir)
# UNSEEN_BACKUP_SQLITE3_BIN       default: sqlite3
set -euo pipefail

log()  { printf '%s restore-drill.sh: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die()  { printf '%s restore-drill.sh: ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

if [[ "$(id -u)" -ne 0 ]]; then
  die "must run as root (needs read access to the backup directory)"
fi

sqlite3_bin="${UNSEEN_BACKUP_SQLITE3_BIN:-sqlite3}"
command -v "$sqlite3_bin" >/dev/null 2>&1 || die "required command not found: ${sqlite3_bin}"
command -v tar >/dev/null 2>&1 || die "required command not found: tar"
command -v sha256sum >/dev/null 2>&1 || die "required command not found: sha256sum"

backup_root="${UNSEEN_BACKUP_ROOT:-/var/backups/unseen}"
tmp_parent="${UNSEEN_BACKUP_DRILL_TMPDIR:-/tmp}"

keep=0
verify_secrets=0
backup_dir=""
for arg in "$@"; do
  case "$arg" in
    --keep) keep=1 ;;
    --verify-secrets) verify_secrets=1 ;;
    -*) die "unknown flag: ${arg}" ;;
    *) backup_dir="$arg" ;;
  esac
done

if [[ -z "$backup_dir" ]]; then
  backup_dir="$(
    find "$backup_root" -maxdepth 1 -mindepth 1 -type d \
      -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z' \
      | sort -r | head -n1
  )"
  [[ -n "$backup_dir" ]] || die "no backup found under ${backup_root}"
fi
[[ -d "$backup_dir" ]] || die "backup directory not found: ${backup_dir}"
[[ -f "${backup_dir}/MANIFEST.txt" ]] || die "${backup_dir} has no MANIFEST.txt — incomplete or not a backup.sh output"

log "drilling backup: ${backup_dir}"

scratch="$(mktemp -d "${tmp_parent}/unseen-restore-drill.XXXXXX")"
cleanup() {
  if (( keep )); then
    log "leaving scratch dir behind (--keep): ${scratch}"
  else
    rm -rf -- "$scratch"
  fi
}
trap cleanup EXIT

# --- results accumulation: every check appends a line here; nothing aborts the drill early ----
report_lines=()
overall_ok=1
private_verified=0
pass() { report_lines+=("  [PASS] $*"); }
fail() { report_lines+=("  [FAIL] $*"); overall_ok=0; }
info() { report_lines+=("         $*"); }

# --- checksum verification against the backup's own manifest ----------------------------------
if [[ -f "${backup_dir}/SHA256SUMS" ]]; then
  sha256_err="${scratch}/.sha256-err"
  if ( cd "$backup_dir" && sha256sum -c --quiet SHA256SUMS ) 2>"$sha256_err"; then
    pass "SHA256SUMS verified against backup contents"
  else
    fail "SHA256SUMS verification failed — backup files may be corrupted or truncated"
    info "$(head -5 "$sha256_err" 2>/dev/null)"
  fi
  rm -f "$sha256_err"
else
  fail "no SHA256SUMS file in ${backup_dir}, cannot verify integrity before restoring"
fi

# --- copy databases into the scratch dir (never touch the backup or production) ----------------
for db in unseen.sqlite book-lab.sqlite; do
  if [[ -f "${backup_dir}/${db}" ]]; then
    cp -p "${backup_dir}/${db}" "${scratch}/${db}"
  else
    fail "${db} missing from backup — cannot drill it"
  fi
done

run_query() {
  local db="$1" label="$2" sql="$3" result
  if ! result="$("$sqlite3_bin" "${scratch}/${db}" "$sql" 2>&1)"; then
    fail "${db}: ${label} — query failed: ${result}"
    return
  fi
  pass "${db}: ${label} = ${result}"
}

if [[ -f "${scratch}/unseen.sqlite" ]]; then
  check="$("$sqlite3_bin" "${scratch}/unseen.sqlite" 'PRAGMA integrity_check;' 2>&1 || true)"
  if [[ "$check" == "ok" ]]; then
    pass "unseen.sqlite: PRAGMA integrity_check = ok"
  else
    fail "unseen.sqlite: PRAGMA integrity_check = ${check}"
  fi
  # Real read-only queries against the actual production schema
  # (services/api/db/migrations/0001_canonical_core.sql + 0009_photo_capture_time.sql).
  run_query unseen.sqlite "space count" "SELECT COUNT(*) FROM spaces;"
  run_query unseen.sqlite "photo count (total / active, i.e. not soft-deleted)" \
    "SELECT COUNT(*) || ' total / ' || SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) || ' active' FROM photos;"
  run_query unseen.sqlite "most recent upload batch" "SELECT COALESCE(MAX(created_at), '(none)') FROM contribution_batches;"
  run_query unseen.sqlite "most recent photo capture time" "SELECT COALESCE(MAX(captured_at), '(none)') FROM photos;"
  run_query unseen.sqlite "active account count" "SELECT COUNT(*) FROM accounts WHERE status='active';"
else
  fail "unseen.sqlite: skipped queries, file was not restored"
fi

if [[ -f "${scratch}/book-lab.sqlite" ]]; then
  check="$("$sqlite3_bin" "${scratch}/book-lab.sqlite" 'PRAGMA integrity_check;' 2>&1 || true)"
  if [[ "$check" == "ok" ]]; then
    pass "book-lab.sqlite: PRAGMA integrity_check = ok"
  else
    fail "book-lab.sqlite: PRAGMA integrity_check = ${check}"
  fi
  run_query book-lab.sqlite "memory book count" "SELECT COUNT(*) FROM memory_books;"
  run_query book-lab.sqlite "book version count" "SELECT COUNT(*) FROM book_versions;"
else
  fail "book-lab.sqlite: skipped queries, file was not restored"
fi

# --- media: real directory tree now (not a tar) — verify every file's bytes against the backup's
# own media.SHA256SUMS. This is stronger than the old "tar tzf lists ok" check: it proves each
# individual file's content is actually intact and readable, not just that an archive's structure
# parses. Read-only: hashes files in place under backup_dir, never copies/extracts anything.
if [[ -d "${backup_dir}/media" ]]; then
  if [[ -f "${backup_dir}/media.SHA256SUMS" ]]; then
    media_count="$(find "${backup_dir}/media" -type f | wc -l | tr -d ' ')"
    manifest_count="$(wc -l < "${backup_dir}/media.SHA256SUMS" | tr -d ' ')"
    media_err="${scratch}/.media-sha256-err"
    if ( cd "$backup_dir" && sha256sum -c --quiet media.SHA256SUMS ) 2>"$media_err"; then
      pass "media/: ${media_count} file(s) verified against media.SHA256SUMS (${manifest_count} entries)"
    else
      fail "media/: checksum verification failed against media.SHA256SUMS — file(s) missing or corrupted"
      info "$(head -5 "$media_err" 2>/dev/null)"
    fi
    rm -f "$media_err"
    if [[ "$media_count" != "$manifest_count" ]]; then
      fail "media/: ${media_count} file(s) on disk but media.SHA256SUMS lists ${manifest_count} — mismatch"
    fi
  else
    fail "media/ is present but media.SHA256SUMS is missing, cannot verify its integrity"
  fi
elif [[ -f "${backup_dir}/media.SKIPPED" ]]; then
  fail "media was skipped; this is an incomplete backup: $(head -1 "${backup_dir}/media.SKIPPED")"
else
  fail "media/ not present in this backup"
fi

# --- structural check on the remaining archive (list contents, don't extract) ------------------
archive="config.tar.gz"
if [[ -f "${backup_dir}/${archive}" ]]; then
  count="$(tar tzf "${backup_dir}/${archive}" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ -n "$count" && "$count" != "0" ]]; then
    pass "${archive}: readable, ${count} entries"
  else
    fail "${archive}: present but tar listing came back empty or unreadable"
  fi
else
  fail "${archive} not present in this backup"
fi

if [[ -f "${backup_dir}/config.SECRETS_SUSPECTED" && ! -f "${backup_dir}/config.ENCRYPTED" ]]; then
  fail "inline service configuration was excluded and not included in the encrypted archive"
fi
if (( verify_secrets )); then
  passphrase_file="${UNSEEN_BACKUP_ENCRYPTION_PASSPHRASE_FILE:-/etc/unseen/backup-encryption.passphrase}"
  node_bin="${UNSEEN_BACKUP_NODE_BIN:-/usr/local/bin/node}"
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  mkdir -m 0700 "${scratch}/secrets" "${scratch}/gnupg"
  if [[ ! -f "${backup_dir}/secrets.tar.gz.gpg" || ! -r "$passphrase_file" ]]; then
    fail "encrypted secrets or decryption passphrase are unavailable"
  elif GNUPGHOME="${scratch}/gnupg" gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$passphrase_file" \
    --decrypt --output "${scratch}/secrets.tar.gz" "${backup_dir}/secrets.tar.gz.gpg" 2>"${scratch}/decrypt-error"; then
    if tar -xzf "${scratch}/secrets.tar.gz" -C "${scratch}/secrets" && \
      "$node_bin" "${script_dir}/verify-private-backup.mjs" "${scratch}/unseen.sqlite" \
        "${scratch}/secrets/keyset/local.keyset.json" > "${scratch}/private-result"; then
      private_verified=1
      pass "backed-up keyset decrypts private records and validates original media bytes: $(cat "${scratch}/private-result")"
    else fail "backed-up keyset/private content cannot be restored"; fi
  else fail "encrypted secrets could not be decrypted"; fi
elif [[ -f "${backup_dir}/secrets.tar.gz.gpg" ]]; then
  info "secrets.tar.gz.gpg present ($(stat -c '%s' "${backup_dir}/secrets.tar.gz.gpg" 2>/dev/null || stat -f '%z' "${backup_dir}/secrets.tar.gz.gpg") bytes) — NOT decrypted by this drill by design"
else
  fail "encrypted secrets missing from backup"
fi

# --- report ---------------------------------------------------------------------------------
echo
echo "==================== restore drill report ===================="
echo "backup:    ${backup_dir}"
echo "drilled:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "scratch:   ${scratch}$( (( keep )) && echo ' (kept)' || echo ' (removed on exit)')"
echo "-----------------------------------------------------------------"
for line in "${report_lines[@]}"; do echo "$line"; done
echo "-----------------------------------------------------------------"
if (( overall_ok && private_verified )); then
  echo "VERDICT: PASS — database, media and encrypted private content were read from backup."
elif (( overall_ok )); then
  echo "VERDICT: PARTIAL — database/media checks passed; private-key recovery remains unverified. Use --verify-secrets."
else
  echo "VERDICT: FAIL — see [FAIL] lines above. Do not treat this backup as trustworthy until resolved."
fi
echo "=================================================================="

if (( ! overall_ok )); then exit 1; fi
if (( ! private_verified )); then exit 2; fi
exit 0
