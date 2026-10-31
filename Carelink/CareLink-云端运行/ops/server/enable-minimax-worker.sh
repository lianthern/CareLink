#!/usr/bin/env bash
# Enable the MiniMax private-ai pull worker (infra/integration/minimax-private-worker) on a running server.
#
# Reads exactly ONE line from stdin — the MiniMax API key — and writes it, together with the non-secret
# parameters below, into a root-only (0600) systemd EnvironmentFile. Installs
# ops/server/unseen-minimax-worker.service (read from the release checkout, with its WorkingDirectory
# placeholder filled in), then enables and (re)starts the unit. Never pass the key as a command-line argument
# or environment variable to this script: both end up in `ps`, shell history and process-environment dumps.
#
# This script does NOT provision the *private-ai wire* bearer token (the credential the worker uses to
# authenticate to services/api's `/__internal/private-ai/v1/*`, distinct from the MiniMax API key). That token
# is shared with the server's own `UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE` configuration (see
# runbooks/release/PRIVATE-AI-PULL-WORKER.md and infra/integration/mac-codex-private-worker/README.md step 2:
# create a random token in an absolute 0600 file, install only its SHA-256 on the server) and must already
# exist, at the path given by UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE below, before running this script.
#
# Usage (as root, on the server):
#   UNSEEN_MINIMAX_WORKER_RELEASE_DIR=/opt/unseen/releases/<commit> \
#     UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE=/etc/unseen/minimax-worker/private-ai.token \
#     ./enable-minimax-worker.sh <<'EOF'
#   <MiniMax API key>
#   EOF
#
# Required:
#   UNSEEN_MINIMAX_WORKER_RELEASE_DIR      absolute path to the immutable release checkout this unit should run
#                                           against (must contain infra/integration/minimax-private-worker/
#                                           worker.mjs and ops/server/unseen-minimax-worker.service) — never a
#                                           moving "current" alias, matching ops/release/unseen.service.example.
#   UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE    absolute path to the already-provisioned, already 0600, single-line
#                                           private-ai wire bearer token file (see above).
#
# Optional overrides (all non-secret):
#   UNSEEN_PRIVATE_AI_ORIGIN                  default: https://unseen.maxxam.xyz
#   UNSEEN_PRIVATE_AI_EXPECTED_HOSTNAME       default: unseen.maxxam.xyz
#   UNSEEN_MINIMAX_BASE_URL                   default: https://api.minimaxi.com
#   UNSEEN_MINIMAX_VISION_MODEL               default: MiniMax-M3
#   UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS         default: 20000  (per MiniMax call; up to 2 calls per job)
#   UNSEEN_MINIMAX_TEMPERATURE                default: 0.6
#   UNSEEN_MINIMAX_MAX_TOKENS                 default: 400
#   UNSEEN_PRIVATE_AI_MIN_LEASE_REMAINING_MS  default: 60000  (poll/lease safety margin — see README "why there
#                                              is no separate poll-interval flag": actual poll cadence is
#                                              server-dictated via retryAfterMs; this is the one timing knob the
#                                              worker genuinely owns, bounding how close to lease expiry it will
#                                              still accept a job)
#   UNSEEN_PRIVATE_AI_CLEANUP_BUDGET_MS       default: 5000
#   UNSEEN_MINIMAX_WORKER_SERVICE_NAME        default: unseen-minimax-worker
#   UNSEEN_MINIMAX_WORKER_ENV_FILE            default: /etc/unseen/minimax-worker.env
#   UNSEEN_MINIMAX_WORKER_UNIT_FILE           default: /etc/systemd/system/${service_name}.service
#
# Idempotent: re-running with the same inputs reproduces the same env file and unit, then restarts the service.
# It never echoes the API key (not to stdout, not to logs, not via `set -x`).
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "enable-minimax-worker: must run as root" >&2
  exit 1
fi

release_dir="${UNSEEN_MINIMAX_WORKER_RELEASE_DIR:-}"
private_ai_token_file="${UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE:-}"
service_name="${UNSEEN_MINIMAX_WORKER_SERVICE_NAME:-unseen-minimax-worker}"
env_file="${UNSEEN_MINIMAX_WORKER_ENV_FILE:-/etc/unseen/minimax-worker.env}"
unit_file="${UNSEEN_MINIMAX_WORKER_UNIT_FILE:-/etc/systemd/system/${service_name}.service}"

private_ai_origin="${UNSEEN_PRIVATE_AI_ORIGIN:-https://unseen.maxxam.xyz}"
private_ai_hostname="${UNSEEN_PRIVATE_AI_EXPECTED_HOSTNAME:-unseen.maxxam.xyz}"
minimax_base_url="${UNSEEN_MINIMAX_BASE_URL:-https://api.minimaxi.com}"
minimax_vision_model="${UNSEEN_MINIMAX_VISION_MODEL:-MiniMax-M3}"
minimax_request_timeout_ms="${UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS:-20000}"
minimax_temperature="${UNSEEN_MINIMAX_TEMPERATURE:-0.6}"
minimax_max_tokens="${UNSEEN_MINIMAX_MAX_TOKENS:-400}"
min_lease_remaining_ms="${UNSEEN_PRIVATE_AI_MIN_LEASE_REMAINING_MS:-60000}"
cleanup_budget_ms="${UNSEEN_PRIVATE_AI_CLEANUP_BUDGET_MS:-5000}"

if [[ -z "${release_dir}" ]]; then
  echo "enable-minimax-worker: UNSEEN_MINIMAX_WORKER_RELEASE_DIR is required (absolute immutable release checkout)" >&2
  exit 1
fi
if [[ "${release_dir}" != /* ]]; then
  echo "enable-minimax-worker: UNSEEN_MINIMAX_WORKER_RELEASE_DIR must be an absolute path" >&2
  exit 1
fi
worker_entrypoint="${release_dir}/infra/integration/minimax-private-worker/worker.mjs"
unit_source="${release_dir}/ops/server/unseen-minimax-worker.service"
if [[ ! -f "${worker_entrypoint}" ]]; then
  echo "enable-minimax-worker: ${worker_entrypoint} not found under the given release dir" >&2
  exit 1
fi
if [[ ! -f "${unit_source}" ]]; then
  echo "enable-minimax-worker: ${unit_source} not found under the given release dir" >&2
  exit 1
fi

if [[ -z "${private_ai_token_file}" ]]; then
  echo "enable-minimax-worker: UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE is required (see script header)" >&2
  exit 1
fi
if [[ "${private_ai_token_file}" != /* ]]; then
  echo "enable-minimax-worker: UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE must be an absolute path" >&2
  exit 1
fi
if [[ ! -f "${private_ai_token_file}" ]]; then
  echo "enable-minimax-worker: ${private_ai_token_file} does not exist — provision the shared private-ai wire" \
    "token first (see script header and infra/integration/mac-codex-private-worker/README.md step 2)" >&2
  exit 1
fi
token_mode="$(stat -c '%a' "${private_ai_token_file}" 2>/dev/null || stat -f '%Lp' "${private_ai_token_file}")"
if [[ "${token_mode}" != "600" && "${token_mode}" != "400" ]]; then
  echo "enable-minimax-worker: ${private_ai_token_file} must be mode 0600 or 0400 (found ${token_mode})" >&2
  exit 1
fi

single_line() {
  # Rejects empty values and anything carrying a newline, so a fat-fingered multi-line paste fails closed
  # instead of silently truncating or corrupting the env file.
  local value="$1" label="$2"
  if [[ -z "${value}" ]]; then
    echo "enable-minimax-worker: ${label} must not be empty" >&2
    exit 1
  fi
  if [[ "${value}" == *$'\n'* ]]; then
    echo "enable-minimax-worker: ${label} must be a single line" >&2
    exit 1
  fi
}

positive_int() {
  local value="$1" label="$2"
  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo "enable-minimax-worker: ${label} must be a positive integer (got '${value}')" >&2
    exit 1
  fi
}

IFS= read -r minimax_api_key
single_line "${minimax_api_key}" "MiniMax API key"
single_line "${private_ai_origin}" "UNSEEN_PRIVATE_AI_ORIGIN"
single_line "${private_ai_hostname}" "UNSEEN_PRIVATE_AI_EXPECTED_HOSTNAME"
single_line "${minimax_base_url}" "UNSEEN_MINIMAX_BASE_URL"
single_line "${minimax_vision_model}" "UNSEEN_MINIMAX_VISION_MODEL"
positive_int "${minimax_request_timeout_ms}" "UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS"
positive_int "${minimax_max_tokens}" "UNSEEN_MINIMAX_MAX_TOKENS"
positive_int "${min_lease_remaining_ms}" "UNSEEN_PRIVATE_AI_MIN_LEASE_REMAINING_MS"
positive_int "${cleanup_budget_ms}" "UNSEEN_PRIVATE_AI_CLEANUP_BUDGET_MS"
if [[ "${private_ai_origin}" != https://* ]]; then
  echo "enable-minimax-worker: UNSEEN_PRIVATE_AI_ORIGIN must be an https:// origin" >&2
  exit 1
fi
if [[ "${minimax_base_url}" != https://* ]]; then
  echo "enable-minimax-worker: UNSEEN_MINIMAX_BASE_URL must be an https:// origin" >&2
  exit 1
fi

install -d -m 0700 -o root -g root "$(dirname "${env_file}")"

tmp_env_file="$(mktemp "${env_file}.XXXXXX")"
trap 'rm -f "${tmp_env_file}"' EXIT
{
  echo "UNSEEN_MINIMAX_WORKER_ENABLED=true"
  echo "UNSEEN_PRIVATE_AI_ORIGIN=${private_ai_origin}"
  echo "UNSEEN_PRIVATE_AI_EXPECTED_HOSTNAME=${private_ai_hostname}"
  echo "UNSEEN_PRIVATE_AI_WORKER_TOKEN_FILE=${private_ai_token_file}"
  echo "UNSEEN_MINIMAX_API_KEY=${minimax_api_key}"
  echo "UNSEEN_MINIMAX_BASE_URL=${minimax_base_url}"
  echo "UNSEEN_MINIMAX_VISION_MODEL=${minimax_vision_model}"
  echo "UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS=${minimax_request_timeout_ms}"
  echo "UNSEEN_MINIMAX_TEMPERATURE=${minimax_temperature}"
  echo "UNSEEN_MINIMAX_MAX_TOKENS=${minimax_max_tokens}"
  echo "UNSEEN_PRIVATE_AI_MIN_LEASE_REMAINING_MS=${min_lease_remaining_ms}"
  echo "UNSEEN_PRIVATE_AI_CLEANUP_BUDGET_MS=${cleanup_budget_ms}"
} > "${tmp_env_file}"
chown root:root "${tmp_env_file}"
chmod 0600 "${tmp_env_file}"
mv -f "${tmp_env_file}" "${env_file}"
trap - EXIT
unset minimax_api_key

tmp_unit_file="$(mktemp "${unit_file}.XXXXXX")"
trap 'rm -f "${tmp_unit_file}"' EXIT
sed "s#/opt/unseen/releases/REQUIRED_IMMUTABLE_RELEASE_COMMIT#${release_dir}#" "${unit_source}" > "${tmp_unit_file}"
if grep -q 'REQUIRED_IMMUTABLE_RELEASE_COMMIT' "${tmp_unit_file}"; then
  echo "enable-minimax-worker: failed to substitute the release directory into the unit template" >&2
  exit 1
fi
chown root:root "${tmp_unit_file}"
chmod 0644 "${tmp_unit_file}"
mv -f "${tmp_unit_file}" "${unit_file}"
trap - EXIT

systemctl daemon-reload
systemctl enable "${service_name}"
systemctl restart "${service_name}"

echo "enable-minimax-worker: ${service_name} enabled and (re)started" \
  "(env file: ${env_file}, unit: ${unit_file}, release: ${release_dir})"
