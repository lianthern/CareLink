#!/usr/bin/env bash
set -euo pipefail
root="/home/max/unseen-local-product"
scene_id=""
confirm=""
while [[ $# -gt 0 ]]; do
  case "$1" in --root) root="${2:?missing value}"; shift 2;; --scene-id) scene_id="${2:?missing value}"; shift 2;; --confirm-delete) confirm=yes; shift;; *) exit 2;; esac
done
[[ "$confirm" == yes && "$scene_id" =~ ^scene-[0-9a-f]{12}$ ]] || { printf 'Usage: %s --scene-id scene-xxxxxxxxxxxx --confirm-delete\n' "$0" >&2; exit 2; }
case "$root" in /home/*) ;; *) printf 'Root must be under /home.\n' >&2; exit 2;; esac
python3 - "$root" "$scene_id" <<'PY'
import json,shutil,sqlite3,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve(); scene_id=sys.argv[2]
if str(root)=="/" or not str(root).startswith("/home/"): raise SystemExit("unsafe root")
db=sqlite3.connect(root/"state/product.sqlite3"); db.row_factory=sqlite3.Row
scene=db.execute("SELECT * FROM scenes WHERE id=?",(scene_id,)).fetchone()
if scene is None: raise SystemExit("scene not found")
active=db.execute("SELECT count(*) FROM jobs WHERE scene_id=? AND state IN ('leased','running','uploading')",(scene_id,)).fetchone()[0]
if active: raise SystemExit("refusing to delete an active scene")
paths={Path(scene["source_path"]).parent,root/"scenes"/scene["revision_id"]}
jobs=list(db.execute("SELECT id,input_path FROM jobs WHERE scene_id=?",(scene_id,)))
for row in jobs:
    paths.add(Path(row["input_path"]).parent); paths.add(root/"work"/row["id"])
db.execute("BEGIN"); db.execute("DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE scene_id=?)",(scene_id,)); db.execute("DELETE FROM jobs WHERE scene_id=?",(scene_id,)); db.execute("DELETE FROM scenes WHERE id=?",(scene_id,)); db.commit()
for path in paths:
    try:
        if root in path.resolve().parents: shutil.rmtree(path,ignore_errors=True)
    except FileNotFoundError: pass
print(json.dumps({"deletedScene":scene_id,"recoverable":False,"paths":[str(p) for p in paths]}))
PY
