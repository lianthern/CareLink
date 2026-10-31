# Frozen bootstrap inputs

These files were copied byte-for-byte from the completed isolated PoC at
`/Users/max/Documents/Codex/2026-09-01/unseen-3dgs-poc`. `SHA256SUMS` is checked
before the offline product copy and again before bootstrap uses the files.

- `python-cu121.lock` is the PoC's Python 3.10 / x86_64-manylinux_2_35 lock. It
  pins package versions, including torch 2.1.2, torchvision 0.16.2,
  nerfstudio 1.1.5 and the base gsplat 1.4.0 requirement. It does not contain
  hashes for every PyPI artifact. The compatible local-version wheel below
  satisfies that requirement without a runtime nvcc build.
- `nerfstudio-1.1.5-py3-none-any.whl` is the PoC's 580,837-byte wheel.
- `splat-transform/package-lock.json` freezes `@playcanvas/splat-transform`
  3.3.3, `@playcanvas/supersplat-viewer` 1.30.2 and their npm integrity values.

The source-only PyPI gsplat wheel is intentionally not used: Max's 4060 already
proved that it disables its CUDA backend without nvcc. The 14,800,006-byte
official precompiled wheel is not in this Git/Bridge tree because the Bridge
verifier rejects tracked files larger than 5 MiB. The explicit bootstrap
downloads and verifies this exact artifact before use:

- Version/file: `gsplat-1.4.0+pt21cu121-cp310-cp310-linux_x86_64.whl`
- URL: `https://github.com/nerfstudio-project/gsplat/releases/download/v1.4.0/gsplat-1.4.0%2Bpt21cu121-cp310-cp310-linux_x86_64.whl`
- SHA256: `19a1dc14f42c1fff4dc2409b7a0bace0f6b59d1dfa58f93cf4083d52a1cce5b4`
- Size: 14,800,006 bytes
- Contents check: the verified wheel includes `gsplat/csrc.so`; doctor executes
  a tiny CUDA forward/backward through it before allowing a preview.

Node is likewise downloaded only by the explicit bootstrap into the user's
WSL ext4 install directory:

- Version/archive: `node-v22.23.1-linux-x64.tar.xz`
- URL: `https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz`
- SHA256: `9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578`

COLMAP is pinned to Ubuntu Jammy `3.7-2`. That official package is not a CUDA
build, so R3 deliberately uses `SiftExtraction.use_gpu=0` and
`SiftMatching.use_gpu=0`. This avoids depending on a WSLg/OpenGL display in a
non-interactive worker. The doctor executes the same CPU feature/matching
smoke before work starts; the RTX 4060 CUDA checks still gate Nerfstudio 7k
training. The Ubuntu archive package is 2,997,642 bytes with SHA256
`1e445221e9667659eece4b5ea53192080e58902cd4280474a45da6f932cec523`;
installation itself remains authenticated by Ubuntu apt metadata.

No default install path downloads these artifacts. Network access, apt changes,
Python package installation and npm installation require the separate
`bootstrap-dependencies.sh --confirm-system-packages` command.
