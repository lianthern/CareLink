#!/usr/bin/env bash
# Enable the UNSEEN server alerting timer (ops/server/alerting/check.mjs, driven by
# unseen-alerting.timer / unseen-alerting.service) on a running server.
#
# Reads exactly ONE line from stdin -- the Telegram bot token -- and writes it, together with the
# non-secret parameters below, into a root-only (0600) systemd EnvironmentFile. Installs
# unseen-alerting.service and unseen-alerting.timer (read from the release checkout, with the
# service's WorkingDirectory placeholder filled in), then enables and starts the timer. Never
# pass the bot token as a command-line argument or environment variable to THIS script: both end
# up in `ps`, shell history and process-environment dumps. (check.mjs itself later reads the
# token from its own process environment, populated by systemd's EnvironmentFile= -- that hop is
# the same trusted mechanism every other secret in this repo's ops/ scripts already goes through;
# see check.mjs's header for how the token is kept out of curl's argv too when it's actually sent.)
#
# Usage (as root, on the server):
#   UNSEEN_ALERTING_RELEASE_DIR=/opt/unseen/releases/<commit> \
#     ./enable-alerting.sh <<'EOF'
#   <Telegram bot token>
#   EOF
#
# Required:
#   UNSEEN_ALERTING_RELEASE_DIR   absolute path to the immutable release checkout this unit should
#                                 run against (must contain ops/server/alerting/check.mjs and
#                                 ops/server/unseen-alerting.service) -- never a moving "current"
#                                 alias, matching ops/release/unseen.service.example's convention.
#
# Optional overrides (all non-secret -- see check.mjs's own header for what each one does):
#   UNSEEN_ALERT_HEALTHZ_URL                  default: http://127.0.0.1:4300/healthz
#   UNSEEN_ALERT_HEALTHZ_HOST                 default: unseen.maxxam.xyz
#   UNSEEN_ALERT_HTTP_TIMEOUT_MS              default: 5000
#   UNSEEN_ALERT_UNITS                        default: "unseen-operable.service unseen-minimax-worker.service unseen-backup.timer"
#   UNSEEN_ALERT_RESTART_LOOP_WINDOW_MIN      default: 20
#   UNSEEN_ALERT_RESTART_LOOP_THRESHOLD       default: 3
#   UNSEEN_ALERT_DISK_PATH                    default: /var/lib/unseen/operable/data
#   UNSEEN_ALERT_DISK_WARN_PERCENT            default: (unset -> health-checks.mjs default, 10)
#   UNSEEN_ALERT_DISK_CRITICAL_PERCENT        default: (unset -> health-checks.mjs default, 3)
#   UNSEEN_ALERT_DISK_WARN_BYTES              default: (unset -> health-checks.mjs default, 500MB)
#   UNSEEN_ALERT_DISK_CRITICAL_BYTES          default: (unset -> health-checks.mjs default, 100MB)
#   UNSEEN_ALERT_BACKUP_ROOT                  default: /var/backups/unseen
#   UNSEEN_ALERT_BACKUP_MAX_AGE_HOURS         default: 36
#   UNSEEN_ALERT_STATE_FILE                   default: /var/lib/unseen/alerting/state.json
#   UNSEEN_ALERT_REMINDER_INTERVAL_MIN        default: 60
#   UNSEEN_ALERT_TELEGRAM_CHAT_ID             default: 8223150297
#   UNSEEN_ALERT_HOSTNAME                     default: (unset -> check.mjs falls back to os.hostname())
#   UNSEEN_ALERT_DRY_RUN                      default: false
#   UNSEEN_ALERTING_SERVICE_NAME              default: unseen-alerting
#   UNSEEN_ALERTING_ENV_FILE                  default: /etc/unseen/alerting.env
#   UNSEEN_ALERTING_SERVICE_UNIT_FILE         default: /etc/systemd/system/${service_name}.service
#   UNSEEN_ALERTING_TIMER_UNIT_FILE           default: /etc/systemd/system/${service_name}.timer
#
# Idempotent: re-running with the same inputs reproduces the same env file and units, then
# restarts the timer (the next tick runs check.mjs fresh; it does not re-run check.mjs itself
# during `enable`). Never echoes the bot token, not to stdout, not to logs, not via `set -x`.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "enable-alerting: must run as root" >&2
  exit 1
fi

release_dir="${UNSEEN_ALERTING_RELEASE_DIR:-}"
service_name="${UNSEEN_ALERTING_SERVICE_NAME:-unseen-alerting}"
env_file="${UNSEEN_ALERTING_ENV_FILE:-/etc/unseen/alerting.env}"
service_unit_file="${UNSEEN_ALERTING_SERVICE_UNIT_FILE:-/etc/systemd/system/${service_name}.service}"
timer_unit_file="${UNSEEN_ALERTING_TIMER_UNIT_FILE:-/etc/systemd/system/${service_name}.timer}"

healthz_url="${UNSEEN_ALERT_HEALTHZ_URL:-http://127.0.0.1:4300/healthz}"
healthz_host="${UNSEEN_ALERT_HEALTHZ_HOST:-unseen.maxxam.xyz}"
http_timeout_ms="${UNSEEN_ALERT_HTTP_TIMEOUT_MS:-5000}"
units="${UNSEEN_ALERT_UNITS:-unseen-operable.service unseen-minimax-worker.service unseen-backup.timer}"
restart_loop_window_min="${UNSEEN_ALERT_RESTART_LOOP_WINDOW_MIN:-20}"
restart_loop_threshold="${UNSEEN_ALERT_RESTART_LOOP_THRESHOLD:-3}"
disk_path="${UNSEEN_ALERT_DISK_PATH:-/var/lib/unseen/operable/data}"
disk_warn_percent="${UNSEEN_ALERT_DISK_WARN_PERCENT:-}"
disk_critical_percent="${UNSEEN_ALERT_DISK_CRITICAL_PERCENT:-}"
disk_warn_bytes="${UNSEEN_ALERT_DISK_WARN_BYTES:-}"
disk_critical_bytes="${UNSEEN_ALERT_DISK_CRITICAL_BYTES:-}"
backup_root="${UNSEEN_ALERT_BACKUP_ROOT:-/var/backups/unseen}"
backup_max_age_hours="${UNSEEN_ALERT_BACKUP_MAX_AGE_HOURS:-36}"
state_file="${UNSEEN_ALERT_STATE_FILE:-/var/lib/unseen/alerting/state.json}"
reminder_interval_min="${UNSEEN_ALERT_REMINDER_INTERVAL_MIN:-60}"
telegram_chat_id="${UNSEEN_ALERT_TELEGRAM_CHAT_ID:-8223150297}"
alert_hostname="${UNSEEN_ALERT_HOSTNAME:-}"
dry_run="${UNSEEN_ALERT_DRY_RUN:-false}"

if [[ -z "${release_dir}" ]]; then
  echo "enable-alerting: UNSEEN_ALERTING_RELEASE_DIR is required (absolute immutable release checkout)" >&2
  exit 1
fi
if [[ "${release_dir}" != /* ]]; then
  echo "enable-alerting: UNSEEN_ALERTING_RELEASE_DIR must be an absolute path" >&2
  exit 1
fi
checker_entrypoint="${release_dir}/ops/server/alerting/check.mjs"
service_unit_source="${release_dir}/ops/server/unseen-alerting.service"
timer_unit_source="${release_dir}/ops/server/unseen-alerting.timer"
for required in "${checker_entrypoint}" "${service_unit_source}" "${timer_unit_source}"; do
  if [[ ! -f "${required}" ]]; then
    echo "enable-alerting: ${required} not found under the given release dir" >&2
    exit 1
  fi
done

single_line() {
  local value="$1" label="$2"
  if [[ -z "${value}" ]]; then
    echo "enable-alerting: ${label} must not be empty" >&2
    exit 1
  fi
  if [[ "${value}" == *$'\n'* ]]; then
    echo "enable-alerting: ${label} must be a single line" >&2
    exit 1
  fi
}

positive_int() {
  local value="$1" label="$2"
  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo "enable-alerting: ${label} must be a positive integer (got '${value}')" >&2
    exit 1
  fi
}

IFS= read -r telegram_bot_token
single_line "${telegram_bot_token}" "Telegram bot token"
if [[ "${telegram_bot_token}" != *:* ]]; then
  echo "enable-alerting: that doesn't look like a Telegram bot token (expected the '<id>:<secret>' shape)" >&2
  exit 1
fi
single_line "${healthz_url}" "UNSEEN_ALERT_HEALTHZ_URL"
single_line "${healthz_host}" "UNSEEN_ALERT_HEALTHZ_HOST"
single_line "${units}" "UNSEEN_ALERT_UNITS"
single_line "${disk_path}" "UNSEEN_ALERT_DISK_PATH"
single_line "${backup_root}" "UNSEEN_ALERT_BACKUP_ROOT"
single_line "${state_file}" "UNSEEN_ALERT_STATE_FILE"
single_line "${telegram_chat_id}" "UNSEEN_ALERT_TELEGRAM_CHAT_ID"
positive_int "${http_timeout_ms}" "UNSEEN_ALERT_HTTP_TIMEOUT_MS"
positive_int "${restart_loop_window_min}" "UNSEEN_ALERT_RESTART_LOOP_WINDOW_MIN"
positive_int "${restart_loop_threshold}" "UNSEEN_ALERT_RESTART_LOOP_THRESHOLD"
positive_int "${backup_max_age_hours}" "UNSEEN_ALERT_BACKUP_MAX_AGE_HOURS"
positive_int "${reminder_interval_min}" "UNSEEN_ALERT_REMINDER_INTERVAL_MIN"
[[ -z "${disk_warn_percent}" ]] || positive_int "${disk_warn_percent}" "UNSEEN_ALERT_DISK_WARN_PERCENT"
[[ -z "${disk_critical_percent}" ]] || positive_int "${disk_critical_percent}" "UNSEEN_ALERT_DISK_CRITICAL_PERCENT"
[[ -z "${disk_warn_bytes}" ]] || positive_int "${disk_warn_bytes}" "UNSEEN_ALERT_DISK_WARN_BYTES"
[[ -z "${disk_critical_bytes}" ]] || positive_int "${disk_critical_bytes}" "UNSEEN_ALERT_DISK_CRITICAL_BYTES"
if [[ "${dry_run}" != "true" && "${dry_run}" != "false" ]]; then
  echo "enable-alerting: UNSEEN_ALERT_DRY_RUN must be 'true' or 'false'" >&2
  exit 1
fi
if [[ "${healthz_url}" != http://* && "${healthz_url}" != https://* ]]; then
  echo "enable-alerting: UNSEEN_ALERT_HEALTHZ_URL must be an http(s):// URL" >&2
  exit 1
fi

install -d -m 0700 -o root -g root "$(dirname "${env_file}")"

tmp_env_file="$(mktemp "${env_file}.XXXXXX")"
trap 'rm -f "${tmp_env_file}"' EXIT
{
  echo "UNSEEN_ALERT_HEALTHZ_URL=${healthz_url}"
  echo "UNSEEN_ALERT_HEALTHZ_HOST=${healthz_host}"
  echo "UNSEEN_ALERT_HTTP_TIMEOUT_MS=${http_timeout_ms}"
  echo "UNSEEN_ALERT_UNITS=${units}"
  echo "UNSEEN_ALERT_RESTART_LOOP_WINDOW_MIN=${restart_loop_window_min}"
  echo "UNSEEN_ALERT_RESTART_LOOP_THRESHOLD=${restart_loop_threshold}"
  echo "UNSEEN_ALERT_DISK_PATH=${disk_path}"
  [[ -z "${disk_warn_percent}" ]] || echo "UNSEEN_ALERT_DISK_WARN_PERCENT=${disk_warn_percent}"
  [[ -z "${disk_critical_percent}" ]] || echo "UNSEEN_ALERT_DISK_CRITICAL_PERCENT=${disk_critical_percent}"
  [[ -z "${disk_warn_bytes}" ]] || echo "UNSEEN_ALERT_DISK_WARN_BYTES=${disk_warn_bytes}"
  [[ -z "${disk_critical_bytes}" ]] || echo "UNSEEN_ALERT_DISK_CRITICAL_BYTES=${disk_critical_bytes}"
  echo "UNSEEN_ALERT_BACKUP_ROOT=${backup_root}"
  echo "UNSEEN_ALERT_BACKUP_MAX_AGE_HOURS=${backup_max_age_hours}"
  echo "UNSEEN_ALERT_STATE_FILE=${state_file}"
  echo "UNSEEN_ALERT_REMINDER_INTERVAL_MIN=${reminder_interval_min}"
  echo "UNSEEN_ALERT_TELEGRAM_BOT_TOKEN=${telegram_bot_token}"
  echo "UNSEEN_ALERT_TELEGRAM_CHAT_ID=${telegram_chat_id}"
  [[ -z "${alert_hostname}" ]] || echo "UNSEEN_ALERT_HOSTNAME=${alert_hostname}"
  echo "UNSEEN_ALERT_DRY_RUN=${dry_run}"
} > "${tmp_env_file}"
chown root:root "${tmp_env_file}"
chmod 0600 "${tmp_env_file}"
mv -f "${tmp_env_file}" "${env_file}"
trap - EXIT
unset telegram_bot_token

install -d -m 0700 -o root -g root "$(dirname "${state_file}")"

tmp_service_file="$(mktemp "${service_unit_file}.XXXXXX")"
trap 'rm -f "${tmp_service_file}"' EXIT
sed "s#/opt/unseen/releases/REQUIRED_IMMUTABLE_RELEASE_COMMIT#${release_dir}#" "${service_unit_source}" > "${tmp_service_file}"
if grep -q 'REQUIRED_IMMUTABLE_RELEASE_COMMIT' "${tmp_service_file}"; then
  echo "enable-alerting: failed to substitute the release directory into the service unit template" >&2
  exit 1
fi
chown root:root "${tmp_service_file}"
chmod 0644 "${tmp_service_file}"
mv -f "${tmp_service_file}" "${service_unit_file}"
trap - EXIT

install -m 0644 -o root -g root "${timer_unit_source}" "${timer_unit_file}"

systemctl daemon-reload
systemctl enable --now "${service_name}.timer"

echo "enable-alerting: ${service_name}.timer enabled and started" \
  "(env file: ${env_file}, service unit: ${service_unit_file}, timer unit: ${timer_unit_file}, release: ${release_dir})"
echo "enable-alerting: first check will run within ~1 minute; to run one immediately: systemctl start ${service_name}.service"
echo "enable-alerting: to watch it: journalctl -u ${service_name} -f"
