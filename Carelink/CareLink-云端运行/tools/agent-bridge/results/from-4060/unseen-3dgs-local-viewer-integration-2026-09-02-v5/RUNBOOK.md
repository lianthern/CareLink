# UNSEEN local Viewer integration v5 runbook

This runbook targets the verified machine layout on `Ubuntu-22.04` and keeps the repaired Pexels v3 profile separate from the TUM RGB-D v4 profile. The v5 integration does not train a model, export a PLY, or convert a SOG. It reuses and verifies the frozen artifacts already present under `/home/max/src/unseen-3dgs-sceneworker`.

## 1. Static and unit gates (WSL)

Fetch the official portable ShellCheck 0.11.0 binary to a temporary directory (Windows PowerShell; no system install):

```powershell
$toolDir = "$env:TEMP\unseen-v5-shellcheck"
New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.xz" -OutFile "$toolDir\shellcheck-v0.11.0.linux.x86_64.tar.xz"
wsl.exe -d Ubuntu-22.04 -- bash -lc "mkdir -p /tmp/unseen-v5-shellcheck && tar -xJf /mnt/c/Users/15pro/AppData/Local/Temp/unseen-v5-shellcheck/shellcheck-v0.11.0.linux.x86_64.tar.xz -C /tmp/unseen-v5-shellcheck"
```

```bash
cd /home/max/src/unseen-3dgs-sceneworker
source .venv/bin/activate
python -m py_compile \
  scripts/repair_sfm_v3.py \
  scripts/evaluate_repair_v3.py \
  scripts/validate_repair_v3_artifacts.py \
  scripts/generate_repair_v3_viewer.py \
  scripts/validate_repair_v3_viewer_anchors.py \
  scripts/tum_v4_adapter.py \
  scripts/evaluate_tum_v4.py \
  scripts/validate_tum_v4_artifacts.py \
  scripts/generate_tum_v4_viewer.py
bash -n scripts/run_repair_v3_train.sh scripts/run_tum_v4_train.sh
/tmp/unseen-v5-shellcheck/shellcheck-v0.11.0/shellcheck \
  scripts/run_repair_v3_train.sh scripts/run_tum_v4_train.sh
python scripts/test_generate_repair_v3_viewer.py
python scripts/test_tum_v4_adapter.py
python scripts/test_generate_tum_v4_viewer.py
python tests/verify_contract.py
```

## 2. Verify the frozen v3 SOG and its Viewer-local copy (WSL)

Both commands must print `0d417735d1b91573f2e2199b53567c07014a420943dac8c84cb73811a1ec0e01` and `2693010` bytes.

```bash
cd /home/max/src/unseen-3dgs-sceneworker
sha256sum artifacts/export/repair-v3/scene.sog viewer/assets/repair-v3.scene.sog
stat -c '%s %n' artifacts/export/repair-v3/scene.sog viewer/assets/repair-v3.scene.sog
```

## 3. Rebuild only the two Viewer contracts (WSL)

These commands do not train or convert artifacts. They use the correct v5 CLI shapes: both Viewer generators take `--manifest-output` and `--validation-output`.

```bash
cd /home/max/src/unseen-3dgs-sceneworker
source .venv/bin/activate
mkdir -p reports/integration-v5/logs

python scripts/generate_repair_v3_viewer.py \
  --transforms reports/repair-v3/processed/SIMPLE_RADIAL_AUTO/transforms.json \
  --dataparser-transforms artifacts/training/repair-v3/pexels-simple-radial-auto-v3/splatfacto/2026-09-02_142353/dataparser_transforms.json \
  --scene-asset-url ./assets/repair-v3.scene.sog \
  --manifest-output viewer/repair-v3.scene.json \
  --validation-output reports/integration-v5/logs/repair-v3-viewer-generator.json

python scripts/generate_tum_v4_viewer.py \
  --transforms data/tum-v4/processed/desk-5hz/transforms.json \
  --dataparser-transforms artifacts/training/tum-v4/freiburg1-desk-v4/splatfacto/2026-09-02_134448/dataparser_transforms.json \
  --scene-asset-url ./assets/tum-v4.scene.sog \
  --manifest-output viewer/tum-v4.scene.json \
  --validation-output reports/integration-v5/logs/tum-v4-viewer-generator.json

python scripts/validate_repair_v3_viewer_anchors.py \
  --config artifacts/training/repair-v3/pexels-simple-radial-auto-v3/splatfacto/2026-09-02_142353/config.yml \
  --manifest viewer/repair-v3.scene.json \
  --output reports/integration-v5/logs/repair-v3-viewer-anchors.json
```

## 4. Start the loopback-only Viewer and open it (Windows PowerShell)

No administrator privileges are used. The launcher verifies the frozen SOG, binds only `127.0.0.1`, tries port `8765` first and then `8766` through `8775`, records the actual PID/URL, and opens the default Windows browser.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-22.04\home\max\src\unseen-3dgs-sceneworker\scripts\windows\Start-Local-PexelsViewer.ps1" -OpenBrowser
```

## 5. Check HTTP from both sides (Windows PowerShell)

```powershell
$statePath = "\\wsl.localhost\Ubuntu-22.04\home\max\src\unseen-3dgs-sceneworker\reports\integration-v5\local-viewer-state.json"
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
(Invoke-WebRequest -UseBasicParsing -Uri $state.url).StatusCode
wsl.exe -d Ubuntu-22.04 -- python3 -c "import urllib.request; print(urllib.request.urlopen('$($state.url)', timeout=5).status)"
```

Both status codes must be `200`.

## 6. Run the real-SOG browser gate (Windows PowerShell)

This produces the one v5 generated-scene screenshot. It verifies `SOG ready`, bounded movement, the fixed `navigation.eyeHeight` walk plane, UI/walk-height agreement, and exact full pose/FOV restoration of the default photo anchor.

```powershell
$project = "\\wsl.localhost\Ubuntu-22.04\home\max\src\unseen-3dgs-sceneworker"
$state = Get-Content -LiteralPath "$project\reports\integration-v5\local-viewer-state.json" -Raw | ConvertFrom-Json
$node = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$env:NODE_PATH = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
& $node "$project\scripts\viewer_repair_v3_e2e.js" $state.url "$project\reports\integration-v5\logs\viewer-e2e.json" "$project\reports\integration-v5\viewer-screenshot.png"
if ($LASTEXITCODE -ne 0) { throw "Viewer E2E gate failed" }
```

Leave the Viewer running after the v5 delivery. To stop it later:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-22.04\home\max\src\unseen-3dgs-sceneworker\scripts\windows\Stop-Local-PexelsViewer.ps1"
```

## 7. Profile construction commands (provenance only; not run by v5)

The repaired Pexels profile uses a positional candidate, not `--candidate`:

```bash
cd /home/max/src/unseen-3dgs-sceneworker
source .venv/bin/activate
python scripts/repair_sfm_v3.py SIMPLE_RADIAL_AUTO
```

The TUM adapter accepts only `--source` and `--output`; it has no `--target-hz` or `--max-frames` options:

```bash
cd /home/max/src/unseen-3dgs-sceneworker
source .venv/bin/activate
python scripts/tum_v4_adapter.py \
  --source data/tum-v4/raw/rgbd_dataset_freiburg1_desk \
  --output data/tum-v4/processed/desk-5hz
```

The guarded training entry points are `scripts/run_repair_v3_train.sh` and `scripts/run_tum_v4_train.sh`. They intentionally refuse to overwrite the existing frozen outputs. The evaluation and artifact validators write their JSON result before returning exit code `1` when a threshold fails.
