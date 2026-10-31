#!/usr/bin/env bash
set -euo pipefail
data_root="${1:-/home/max/unseen-local-product}"
case "$data_root" in /home/*) ;; *) printf 'Data root must be WSL ext4 under /home.\n' >&2; exit 2;; esac
failed=0
for name in worker server; do
  pid_file="$data_root/reports/$name.pid"
  if [[ -f "$pid_file" ]]; then
    pid=$(cat "$pid_file")
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      command_line=""
      if [[ -r "/proc/$pid/cmdline" ]]; then command_line=$(tr '\0' ' ' < "/proc/$pid/cmdline"); fi
      if [[ "$command_line" == *"unseen_local_product.py"* && "$command_line" == *" $name "* ]]; then
        kill "$pid"
        stopped=""
        for _attempt in $(seq 1 200); do
          if ! kill -0 "$pid" 2>/dev/null; then stopped=yes; break; fi
          if [[ -r "/proc/$pid/stat" ]] && [[ "$(awk '{print $3}' "/proc/$pid/stat")" == Z ]]; then stopped=yes; break; fi
          sleep 0.1
        done
        if [[ "$stopped" == yes ]]; then
          rm -f -- "$pid_file"
          printf 'Stopped %s PID %s and waited for process cleanup.\n' "$name" "$pid"
        else
          printf 'FAIL %s PID %s did not stop within 20 seconds; PID file retained and no replacement should start.\n' "$name" "$pid" >&2
          failed=1
        fi
      else
        printf 'Ignored stale %s PID file; PID %s belongs to another process.\n' "$name" "$pid" >&2
        rm -f -- "$pid_file"
      fi
    else
      rm -f -- "$pid_file"
    fi
  fi
done
[[ "$failed" -eq 0 ]] || exit 1
printf 'Local media, queue and checkpoints were preserved for restart.\n'
