#!/usr/bin/env bash
set -euo pipefail

if [[ -d /usr/lib/wsl/lib ]]; then
  export PATH="/usr/lib/wsl/lib:$PATH"
fi

confirm=""
new_run=""
download_public_fixture=""
bridge_root="/mnt/c/Users/max/AgentBridge/control"
source_root="/home/max/src/unseen-3dgs-sceneworker/data/360roam-base-v10/download/panos"
product_root="/home/max/unseen-local-product"
install_root="/home/max/src/unseen-local-product"
url="http://127.0.0.1:8780"
wait_seconds="28800"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-full-canary|--confirm-one-preview) confirm=yes; shift;;
    --new-run) new_run=yes; shift;;
    --confirm-download-public-fixture) download_public_fixture=yes; shift;;
    --bridge-root) bridge_root="${2:?missing value}"; shift 2;;
    --source-root) source_root="${2:?missing value}"; shift 2;;
    --product-root) product_root="${2:?missing value}"; shift 2;;
    --install-root) install_root="${2:?missing value}"; shift 2;;
    --url) url="${2:?missing value}"; shift 2;;
    --wait-seconds) wait_seconds="${2:?missing value}"; shift 2;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2;;
  esac
done
[[ "$confirm" == yes ]] || { printf 'This runs one real 7k preview, three held-out photo jobs and an in-flight worker recovery test. Rerun with --confirm-full-canary.\n' >&2; exit 2; }
command -v realpath >/dev/null 2>&1 || { printf 'realpath is required.\n' >&2; exit 1; }
[[ ! -L "$source_root" ]] || { printf 'Source root must not be a symlink: %s\n' "$source_root" >&2; exit 2; }
product_root=$(realpath -m -- "$product_root")
install_root=$(realpath -m -- "$install_root")
source_root=$(realpath -m -- "$source_root")
case "$product_root" in /home/*) ;; *) printf 'Product root must be WSL ext4 under /home.\n' >&2; exit 2;; esac
case "$install_root" in /home/*) ;; *) printf 'Install root must be WSL ext4 under /home.\n' >&2; exit 2;; esac
case "$source_root" in /home/*) ;; *) printf 'Source root must be WSL ext4 under /home.\n' >&2; exit 2;; esac
command -v flock >/dev/null 2>&1 || { printf 'flock is required to serialize the full GPU canary.\n' >&2; exit 1; }
mkdir -p "$product_root/state"
exec 9>"$product_root/state/v15-full-canary.lock"
if ! flock -n 9; then
  printf 'Another v15 full canary already owns the single-GPU canary lock; wait for it to finish.\n' >&2
  exit 1
fi
manifest="$install_root/fixtures/360roam/source-manifest.json"
[[ -f "$manifest" ]] || { printf 'Missing packaged 360Roam source manifest: %s\n' "$manifest" >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
driver="$script_dir/run_v15_full_canary.py"
if [[ ! -f "$driver" ]]; then driver="$install_root/app/run_v15_full_canary.py"; fi
product_app="$install_root/app/unseen_local_product.py"
runner="$install_root/app/pipeline_runner.py"
[[ -f "$driver" && -f "$product_app" && -f "$runner" ]] || { printf 'Installed product/runner/full-canary code is incomplete.\n' >&2; exit 1; }
poc_root="/home/max/src/unseen-3dgs-sceneworker"
if [[ -x "$install_root/.venv/bin/python3" ]]; then
  runtime_python="$install_root/.venv/bin/python3"
elif [[ -x "$poc_root/.venv/bin/python3" ]]; then
  runtime_python="$poc_root/.venv/bin/python3"
else
  printf 'Missing Python environment in %s/.venv and %s/.venv.\n' "$install_root" "$poc_root" >&2
  exit 1
fi
runtime_bin=$(dirname -- "$runtime_python")
export PATH="$runtime_bin:$PATH"
if [[ "$download_public_fixture" == yes ]]; then
  downloader="$install_root/app/download_360roam_fixture.py"
  [[ -f "$downloader" ]] || { printf 'Missing packaged public-fixture downloader: %s\n' "$downloader" >&2; exit 1; }
  printf 'CONFIRMED: resume/download the frozen public 360Roam fixture over its official HTTPS host; media remains in WSL ext4.\n'
  "$runtime_python" "$downloader" \
    --destination "$poc_root/data/360roam-base-v10" \
    --manifest "$manifest" \
    --download-only
fi
if [[ ! -d "$source_root" || -L "$source_root" ]]; then
  printf 'Frozen public fixture cache is missing. Re-run explicitly with --confirm-download-public-fixture to use only the packaged official-HTTPS downloader.\n' >&2
  exit 1
fi
mkdir -p "$product_root/fixtures/v15"
list="$product_root/fixtures/v15/panoramas.ffconcat"
video="$product_root/fixtures/v15/v11-sequence-without-poses.mp4"
video_incomplete="$video.incomplete.mp4"
video_lineage="$product_root/fixtures/v15/v11-sequence-without-poses.lineage.json"
cleanup() { rm -f -- "$video_incomplete"; }
trap cleanup EXIT
"$runtime_python" - "$manifest" "$source_root" "$list" <<'PY'
import hashlib,json,re,sys
from pathlib import Path
manifest=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")); root=Path(sys.argv[2]).resolve(strict=True); output=Path(sys.argv[3])
records=manifest.get("files")
if not isinstance(records,list) or len(records) != 60:
    raise SystemExit("source manifest must contain exactly 60 frozen panorama records")
rows=[]
for record in records:
    name=record.get("name")
    if not isinstance(name,str) or Path(name).name != name or re.fullmatch(r"[A-Za-z0-9._-]+",name) is None:
        raise SystemExit(f"unsafe source manifest basename: {name!r}")
    expected_bytes=record.get("bytes"); expected_sha=record.get("sha256")
    if isinstance(expected_bytes,bool) or not isinstance(expected_bytes,int) or expected_bytes <= 0 or not isinstance(expected_sha,str) or re.fullmatch(r"[0-9a-f]{64}",expected_sha) is None:
        raise SystemExit(f"invalid size/SHA contract for frozen panorama: {name}")
    path=root/name
    if path.is_symlink():
        raise SystemExit(f"frozen panorama must not be a symlink: {name}")
    try:
        resolved=path.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError,ValueError):
        raise SystemExit(f"frozen panorama escaped the source root: {name}")
    digest=hashlib.sha256()
    if resolved.is_file():
        with resolved.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024*1024), b""): digest.update(chunk)
    if not resolved.is_file() or resolved.stat().st_size != expected_bytes or digest.hexdigest()!=expected_sha:
        raise SystemExit(f"missing or invalid frozen panorama: {name}")
    rows.extend([f"file '{resolved}'","duration 1.5"])
rows.append(f"file '{(root/records[-1]['name']).resolve(strict=True)}'")
output.write_text("ffconcat version 1.0\n"+"\n".join(rows)+"\n",encoding="utf-8")
print(f"Verified {len(records)} public fixture panoramas; remotePath/author poses were not copied into the video job.")
PY
ffmpeg_version=$(ffmpeg -version | sed -n '1p')
encoder_contract="concat-verified-panos|scale=4096:2048:lanczos|yuv420p|fps=12|libx264|preset=medium|crf=23|metadata=comment|faststart|$ffmpeg_version"
runtime_fingerprint=$("$runtime_python" - "$ffmpeg_version" <<'PY'
import importlib.metadata,json,subprocess,sys
import torch

def version(name):
    try: return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError: return None

def output(command):
    return subprocess.run(command,check=True,capture_output=True,text=True,timeout=15).stdout.strip()

print(json.dumps({
    "python": sys.version.split()[0],
    "torch": str(torch.__version__),
    "torchCuda": str(torch.version.cuda) if torch.version.cuda else None,
    "torchCudaAvailable": bool(torch.cuda.is_available()),
    "torchGpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    "nvidiaSmi": output(["nvidia-smi","--query-gpu=name,driver_version,memory.total","--format=csv,noheader,nounits"]),
    "ffmpeg": sys.argv[1],
    "colmapDeb": output(["dpkg-query","-W","-f=${Version}","colmap"]),
    "nerfstudio": version("nerfstudio"),
    "gsplat": version("gsplat"),
},sort_keys=True,separators=(",",":")))
PY
)
runtime_fingerprint_sha256=$(printf '%s' "$runtime_fingerprint" | sha256sum | awk '{print $1}')
run_id=$("$runtime_python" - "$install_root" "$driver" "$encoder_contract" "$runtime_fingerprint_sha256" "$new_run" <<'PY'
import hashlib,json,re,secrets,sys
from pathlib import Path

root=Path(sys.argv[1]).resolve(strict=True)
driver=Path(sys.argv[2]).resolve(strict=True)
relative_files = sorted({
    "app/bootstrap-dependencies.sh",
    "app/cleanup-private-media.sh",
    "app/doctor-local-product.sh",
    "app/dry-run-local-product.sh",
    "app/download_360roam_fixture.py",
    "app/install-local-product.sh",
    "app/pipeline_runner.py",
    "app/run-v15-integration-canary.sh",
    "app/run_v15_full_canary.py",
    "app/start-local-product.sh",
    "app/stop-local-product.sh",
    "app/unseen_local_product.py",
    "app/verify_release_payload.py",
    "dependencies/DEPENDENCIES.md",
    "dependencies/SHA256SUMS",
    "dependencies/python-cu121.lock",
    "dependencies/splat-transform/package-lock.json",
    "dependencies/splat-transform/package.json",
    "fixtures/360roam/source-manifest.json",
    "schemas/job.schema.json",
    "schemas/queue-state.schema.json",
    "schemas/result.schema.json",
    "viewer/app.js",
    "viewer/index.html",
    "viewer/scene.schema.json",
    "viewer/styles.css",
    "viewer/vendor/PLAYCANVAS-LICENSE.txt",
    "viewer/vendor/playcanvas.min.mjs",
})
digest=hashlib.sha256()
for relative in relative_files:
    path=(root/relative).resolve(strict=True)
    path.relative_to(root)
    file_digest=hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024*1024), b""): file_digest.update(chunk)
    digest.update(relative.encode()+b"\0"+file_digest.digest())
installed_driver=(root/"app/run_v15_full_canary.py").resolve(strict=True)
if driver != installed_driver:
    raise SystemExit("full canary driver must be the installed release copy")
receipt=json.loads((root/"release-evidence.json").read_text(encoding="utf-8"))
if (receipt.get("jobId") != "unseen-3dgs-local-product-2026-09-04-v15"
    or re.fullmatch(r"[0-9a-f]{64}",str(receipt.get("assetSha256") or "")) is None
    or re.fullmatch(r"[0-9a-f]{40,64}",str(receipt.get("controlCommit") or "")) is None):
    raise SystemExit("installed release evidence is invalid or belongs to another job")
digest.update(b"encoder-contract\0"+sys.argv[3].encode())
runtime_sha=sys.argv[4]
if re.fullmatch(r"[0-9a-f]{64}",runtime_sha) is None:
    raise SystemExit("runtime fingerprint SHA256 is invalid")
digest.update(b"runtime-fingerprint\0"+bytes.fromhex(runtime_sha))
digest.update(b"release-asset\0"+bytes.fromhex(receipt["assetSha256"]))
digest.update(b"control-commit\0"+receipt["controlCommit"].encode())
if sys.argv[5] == "yes":
    digest.update(b"explicit-new-run\0"+secrets.token_bytes(32))
print("run-"+digest.hexdigest()[:24])
PY
)
printf 'Canary release lineage: %s%s\n' "$run_id" "${new_run:+ (explicit new run)}"
prior_sha=$("$runtime_python" - "$video_lineage" "$run_id" <<'PY'
import json,re,sys
from pathlib import Path
path=Path(sys.argv[1])
if path.is_file():
    value=json.loads(path.read_text(encoding="utf-8"))
    if value.get("canaryRunId") == sys.argv[2]:
        digest=value.get("videoSha256")
        if not isinstance(digest,str) or re.fullmatch(r"[0-9a-f]{64}",digest) is None:
            raise SystemExit("same-lineage video sidecar has an invalid SHA256")
        print(digest)
PY
)
rm -f -- "$video_incomplete"
ffmpeg -hide_banner -loglevel warning -y -safe 0 -f concat -i "$list" \
  -vf 'scale=4096:2048:flags=lanczos,format=yuv420p' -r 12 -c:v libx264 -preset medium -crf 23 \
  -map_metadata -1 -metadata "comment=unseen-v15-$run_id" -movflags +faststart "$video_incomplete"
new_sha=$(sha256sum "$video_incomplete" | awk '{print $1}')
if [[ -n "$prior_sha" && "$new_sha" != "$prior_sha" ]]; then
  printf 'Deterministic same-lineage MP4 SHA changed (%s != %s); refusing a duplicate 7k scene.\n' "$new_sha" "$prior_sha" >&2
  exit 1
fi
mv -- "$video_incomplete" "$video"
"$runtime_python" - "$video_lineage" "$run_id" "$new_sha" <<'PY'
import json,os,sys
from pathlib import Path
path=Path(sys.argv[1]); temporary=path.with_suffix(path.suffix+".tmp")
temporary.write_text(json.dumps({"canaryRunId":sys.argv[2],"videoSha256":sys.argv[3]},indent=2)+"\n",encoding="utf-8")
os.replace(temporary,path)
PY
probe=$(ffprobe -v error -show_entries stream=width,height -show_entries format=duration:format_tags=comment -of json "$video")
"$runtime_python" - "$probe" "$run_id" <<'PY'
import json,sys
p=json.loads(sys.argv[1]); s=p["streams"][0]
assert s["width"]==4096 and s["height"]==2048 and float(p["format"]["duration"])>=10
assert p["format"]["tags"]["comment"] == "unseen-v15-" + sys.argv[2]
PY
"$runtime_python" "$driver" \
  --url "$url" \
  --video "$video" \
  --run-id "$run_id" \
  --runtime-fingerprint-sha256 "$runtime_fingerprint_sha256" \
  --product-root "$product_root" \
  --install-root "$install_root" \
  --bridge-root "$bridge_root" \
  --wait-seconds "$wait_seconds" \
  --exercise-worker-recovery
