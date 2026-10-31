#!/usr/bin/env bash
# Thin wrapper around upload-to-cos.mjs: loads Tencent COS credentials from a root-only
# EnvironmentFile-style file into THIS PROCESS's environment (never onto any command line, so
# they never show up in `ps`), then execs the actual Node uploader against a backup.sh output
# directory. See upload-to-cos.mjs's header for why the upload/signing logic itself is Node
# rather than raw curl+openssl (short version: node:crypto lets the secret key stay in an
# environment variable end to end; piping it through `openssl dgst -hmac "$key"` would put the
# key on that command's argv, which is exactly what every other secret-handling script in this
# repo goes out of its way to avoid).
#
# Usage (as root, on the server):
#   ./upload-to-cos.sh                          # uploads the newest backup under UNSEEN_BACKUP_ROOT
#   ./upload-to-cos.sh /var/backups/unseen/20260817T031500Z   # uploads a specific backup dir
#
# Required credential file (default /etc/unseen/backup-cos.env, root-only 0600/0400):
#   UNSEEN_BACKUP_COS_SECRET_ID=<SecretId>
#   UNSEEN_BACKUP_COS_SECRET_KEY=<SecretKey>
#   UNSEEN_BACKUP_COS_BUCKET=<bucket-appid>      # full bucket name AS SHOWN in the COS console,
#                                                 # including the trailing -<APPID>
#   UNSEEN_BACKUP_COS_REGION=ap-hongkong         # match the bucket's region
#   UNSEEN_BACKUP_COS_PREFIX=unseen              # optional, defaults to "unseen" if unset
#
# See the report handed back alongside this script for the exact Tencent Cloud console steps
# needed before this file can be created (bucket creation, credentials, and why a scoped
# sub-account is recommended over reusing the main account's SES key).
#
# UNSEEN_BACKUP_COS_ENV_FILE   default: /etc/unseen/backup-cos.env
# UNSEEN_BACKUP_ROOT           default: /var/backups/unseen (used to find "the newest backup"
#                               when no directory argument is given)
#
# Never echoes credential values, never passes them as arguments, never uses `set -x`.
set -euo pipefail

log()  { printf '%s upload-to-cos.sh: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die()  { printf '%s upload-to-cos.sh: ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

if [[ "$(id -u)" -ne 0 ]]; then
  die "must run as root (needs read access to the credential file and the backup directory)"
fi

command -v node >/dev/null 2>&1 || die "node not found on PATH"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
uploader="${script_dir}/upload-to-cos.mjs"
[[ -f "$uploader" ]] || die "expected ${uploader} next to this script, not found"

env_file="${UNSEEN_BACKUP_COS_ENV_FILE:-/etc/unseen/backup-cos.env}"
backup_root="${UNSEEN_BACKUP_ROOT:-/var/backups/unseen}"

# Offsite upload stays optional until the COS credentials are provisioned. Without them the
# daily timer would exit 1 every night even though the LOCAL backup succeeded -- a red light
# that is always on teaches everyone to ignore it, so a missing credential file is a SKIP,
# not a failure. Once the file exists, every later check below stays strict.
if [[ ! -f "$env_file" ]]; then
  printf '%s upload-to-cos.sh: SKIP: offsite upload not configured (%s missing); local backup unaffected
' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$env_file"
  exit 0
fi
mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")"
[[ "$mode" == "600" || "$mode" == "400" ]] || die "${env_file} must be mode 0600 or 0400 (found ${mode})"

backup_dir="${1:-}"
if [[ -z "$backup_dir" ]]; then
  backup_dir="$(
    find "$backup_root" -maxdepth 1 -mindepth 1 -type d \
      -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z' \
      | sort -r | head -n1
  )"
  [[ -n "$backup_dir" ]] || die "no backup found under ${backup_root} and none given as an argument"
fi
[[ -d "$backup_dir" ]] || die "backup directory not found: ${backup_dir}"

if [[ -f "${backup_dir}/config.SECRETS_SUSPECTED" ]]; then
  # Old runs excluded these files entirely. New runs place them in the encrypted
  # bundle and bind both markers, the bundle and the manifest into SHA256SUMS.
  # Do not let a stray marker bypass the old refusal or load credentials before
  # the complete evidence has passed its checksum verification.
  for artifact in config.ENCRYPTED config.SECRETS_SUSPECTED secrets.tar.gz.gpg MANIFEST.txt SHA256SUMS; do
    [[ -s "${backup_dir}/${artifact}" ]] \
      || die "inline configuration recovery evidence is missing or empty: ${artifact}; refusing offsite upload"
  done
  command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found on PATH"
  for artifact in config.ENCRYPTED config.SECRETS_SUSPECTED secrets.tar.gz.gpg MANIFEST.txt; do
    awk -v artifact="$artifact" '$1 ~ /^[[:xdigit:]]+$/ && length($1) == 64 && $2 == artifact { found=1 } END { exit !found }' \
      "${backup_dir}/SHA256SUMS" || die "SHA256SUMS does not cover ${artifact}; refusing offsite upload"
  done
  ( cd "$backup_dir" && sha256sum -c --quiet SHA256SUMS ) \
    || die "backup checksum verification failed; refusing offsite upload"
fi

log "loading COS credentials from ${env_file}"
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

log "uploading ${backup_dir}"
exec node "$uploader" "$backup_dir"
