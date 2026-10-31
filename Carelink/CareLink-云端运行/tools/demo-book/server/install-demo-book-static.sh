#!/usr/bin/env bash
# Installs the offline-generated demo book (book.html, book.pdf, index.html) into the static root
# the demo-book-caddy-snippet.conf matcher serves. Run this ON the server, as whichever
# user/sudo context owns /var/www — this script never touches the private-beta SQLite database, the
# API process, or /var/www/unseen-private-beta. It only copies three static files into a dedicated
# directory. See ../README.md for the full checklist (Caddyfile edit, reload, verification).
#
# Usage:
#   install-demo-book-static.sh <source_dir> [<static_root>]
#
#   <source_dir>   Directory containing book.html, book.pdf and index.html — i.e. whatever you
#                  scp'd/rsync'd from the Mac's ~/code/unseen-assets/demo-book/ output.
#   <static_root>  Defaults to /var/www/unseen-demo-book (must match the `root` directive in
#                  demo-book-caddy-snippet.conf).
set -euo pipefail

source_dir=${1:?"usage: install-demo-book-static.sh <source_dir> [<static_root>]"}
static_root=${2:-/var/www/unseen-demo-book}

for f in book.html book.pdf index.html; do
  if [ ! -f "${source_dir}/${f}" ]; then
    echo "install-demo-book-static: missing ${source_dir}/${f}" >&2
    exit 1
  fi
done

mkdir -p "${static_root}"
install -m 0644 "${source_dir}/book.html" "${static_root}/book.html"
install -m 0644 "${source_dir}/book.pdf" "${static_root}/book.pdf"
install -m 0644 "${source_dir}/index.html" "${static_root}/index.html"

echo "installed:"
ls -la "${static_root}"
echo
echo "Next steps (not done by this script):"
echo "  1. Insert infra/integration/private-beta-deployment/demo-book-caddy-snippet.conf into the"
echo "     real Caddyfile if it is not already there (one-time)."
echo "  2. caddy validate --config <path-to-Caddyfile>"
echo "  3. caddy reload --config <path-to-Caddyfile> (or this deployment's normal reload command)"
echo "  4. curl -sI https://<private-beta-domain>/demo-book/  — expect 200, no basic-auth prompt"
