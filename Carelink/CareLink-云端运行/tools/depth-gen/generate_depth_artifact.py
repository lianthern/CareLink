#!/usr/bin/env python3
"""
tools/depth-gen/generate_depth_artifact.py — offline depth-artifact generator
for UNSEEN's depth_limited_parallax viewer mode (Track N).

Runs Insta360 Research's DAP ("Depth Any Panoramas", CVPR 2026) on an
equirectangular panorama JPEG and writes two files next to <out-basename>:

    <out-basename>.png
        8-bit grayscale PNG in the "linear-red-v1" encoding
        packages/viewer/src/depth.js expects: pixel value 0 = nearMeters,
        255 = farMeters, linearly interpolated (see viewer.js's fragment
        shader: `mix(uDepthNear, uDepthFar, clamp(encoded,0,1))`). This is
        the exact file the browser decodes at runtime — only its .r channel
        is read, and a grayscale PNG expands losslessly into R=G=B on
        decode, so grayscale-vs-RGB makes no difference to the shader.

    <out-basename>.artifact.json
        Everything else validateDepthArtifact() needs *except*
        sourcePanoramaRevisionId and the final served .../depth-map URL —
        those only exist once a specific space/panorama revision adopts
        this artifact. See services/api/scripts/attach-depth-artifact.mjs
        for the second half (DB insert + media-store copy) that fills
        those in.

Why DAP specifically: it is trained natively on equirectangular panoramas
(hence the name) — generic perspective-photo depth models (Depth Anything
V2, Apple Depth Pro, ...) were trained on rectilinear photos and predict
badly warped results near the poles/seam of a 360 panorama unless you add
extra cubemap-projection-and-stitch engineering, which DAP already solves
end-to-end as its whole reason to exist. Given the brief here optimizes for
visual result over inference cost (this only ever runs offline on a Mac,
once per scene), the panorama-native model is the correct choice even
though it's the older of the two candidates considered.

DAP is CC BY-NC 4.0 (Insta360 Research) — NonCommercial only. That's fine
for Max's private beta / internal testing per his explicit sign-off, but it
MUST be swapped (or a commercial license obtained) before any paid plan or
public commercial UNSEEN launch. See $DAP_ROOT/LICENSE.

Usage:
    <DAP venv python> tools/depth-gen/generate_depth_artifact.py \\
        <panorama.jpg> <out-basename> [--near 0.5] [--far 20] [--directions 36]

Environment:
    DAP_ROOT     directory containing networks/, config/, weights/model.pth
                 (default: ~/code/unseen-assets/models/DAP — a symlink to
                 spatial-memory's vendor/DAP by default on this machine, to
                 avoid duplicating the 1.4GB weights file on disk; point it
                 at a real copy if that project ever goes away)

This intentionally mirrors spatial-memory/tools/depth.py's proven DAP
inference recipe (float32/255 normalize, no ImageNet mean/std, resize to
DAP's native 1024x512 training resolution, no cubemap projection) rather
than reinventing it — see that file's docstring for the detailed rationale
on each of those choices.
"""
import argparse
import json
import os
import sys
import time

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
from PIL import Image  # noqa: E402

DAP_ROOT = os.environ.get("DAP_ROOT") or os.path.expanduser("~/code/unseen-assets/models/DAP")
WEIGHTS_PATH = os.path.join(DAP_ROOT, "weights", "model.pth")

INFER_WIDTH = 1024
INFER_HEIGHT = 512

# Must match packages/viewer/src/math.js's MAX_TRANSLATION_METERS exactly — the viewer clamps
# every direction's allowedRadiusMeters to this regardless of what we emit, but keeping our
# ceiling in sync avoids emitting a misleadingly large absoluteMaxRadiusMeters.
MAX_TRANSLATION_METERS = 0.42

MODEL_ARGS = {
    "name": "dap",
    "args": {
        "midas_model_type": "vitl",
        "fine_tune_type": "hypersim",
        "min_depth": 0.01,
        "max_depth": 1.0,
        "train_decoder": True,
    },
}


def load_model():
    """Build the DAP model and load the checkpoint. Must run with CWD set to DAP_ROOT because
    DINOv3Adapter's torch.hub.load(repo_dir=..., source="local") resolves repo_dir relative to
    CWD, not to this file (ported verbatim from spatial-memory/tools/depth.py)."""
    if not os.path.isfile(WEIGHTS_PATH):
        raise FileNotFoundError(
            f"DAP weights not found at {WEIGHTS_PATH}. Set DAP_ROOT to a directory containing "
            f"weights/model.pth (from https://huggingface.co/Insta360-Research/DAP-weights)."
        )
    prev_cwd = os.getcwd()
    os.chdir(DAP_ROOT)
    try:
        sys.path.insert(0, DAP_ROOT)
        from networks.models import make  # noqa: WPS433

        model = make(MODEL_ARGS)
        state = torch.load(WEIGHTS_PATH, map_location="cpu")
        if any(k.startswith("module") for k in state.keys()):
            model = nn.DataParallel(model)
        model_state = model.state_dict()
        matched = {k: v for k, v in state.items() if k in model_state}
        missing = len(model_state) - len(matched)
        if missing:
            print(f"warning: {missing}/{len(model_state)} checkpoint keys unmatched", file=sys.stderr)
        model.load_state_dict(matched, strict=False)
        model.eval()
    finally:
        os.chdir(prev_cwd)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    try:
        model = model.to(device)
    except Exception as exc:  # pragma: no cover - defensive fallback
        print(f"warning: could not move model to {device} ({exc}), using cpu", file=sys.stderr)
        model = model.to("cpu")
        device = "cpu"
    return model, device


def infer_depth_and_mask(model, device, img_rgb_u8: np.ndarray):
    """Faithful port of vendor/DAP/test/infer.py's infer_raw(). Returns (depth[0,1] HxW
    float32, valid_mask bool HxW) — valid_mask is True where DAP is confident (kept its own
    predicted depth) and False where it fell back to the far-plane default (1.0)."""
    img = img_rgb_u8.astype(np.float32) / 255.0
    tensor = torch.from_numpy(img.transpose(2, 0, 1)).unsqueeze(0).to(device)
    with torch.inference_mode():
        outputs = model(tensor)
        if isinstance(outputs, dict) and "pred_depth" in outputs:
            depth = outputs["pred_depth"][0].detach().cpu().squeeze().numpy().astype(np.float32)
            if "pred_mask" in outputs:
                mask = 1 - outputs["pred_mask"][0].detach().cpu().squeeze().numpy()
                valid = mask > 0.5
                depth = np.where(valid, depth, 1.0).astype(np.float32)
            else:
                valid = np.ones_like(depth, dtype=bool)
        else:
            depth = outputs[0].detach().cpu().squeeze().numpy().astype(np.float32)
            valid = np.ones_like(depth, dtype=bool)
    return depth, valid


def yaw_to_column(yaw_deg: float, width: int) -> int:
    # Matches packages/viewer/src/viewer.js's panoUv()/uTurn convention exactly: u = yawDeg/360
    # (mod 1), no sign flip — see the shader's atan2(ray.x, ray.z) derivation.
    frac = (yaw_deg % 360.0) / 360.0
    return int(round(frac * width)) % width


def build_safety_envelope(depth_m: np.ndarray, n_directions: int, margin_m: float):
    height, width = depth_m.shape
    row_lo = int(height * 0.42)
    row_hi = int(height * 0.58) + 1
    half_window = max(1, width // (n_directions * 2))
    directions = []
    for i in range(n_directions):
        yaw = (360.0 / n_directions) * i
        col = yaw_to_column(yaw, width)
        cols = [(col + offset) % width for offset in range(-half_window, half_window + 1)]
        window = depth_m[row_lo:row_hi, :][:, cols]
        nearest = float(window.min())
        allowed = max(0.0, min(MAX_TRANSLATION_METERS, nearest - margin_m))
        directions.append({"yawDeg": round(yaw, 4), "allowedRadiusMeters": round(allowed, 4)})
    return {
        "schemaVersion": "unseen-polar-safety-envelope/1",
        "absoluteMaxRadiusMeters": MAX_TRANSLATION_METERS,
        "directions": directions,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("panorama", help="path to an equirectangular (2:1) panorama JPEG/PNG")
    parser.add_argument("out_basename", help="writes <out_basename>.png and <out_basename>.artifact.json")
    parser.add_argument("--near", type=float, default=0.5, help="meters mapped to the nearest predicted depth (default 0.5)")
    parser.add_argument("--far", type=float, default=20.0, help="meters mapped to the farthest predicted depth (default 20)")
    parser.add_argument("--directions", type=int, default=36, help="safety-envelope sample count, 8-72 (default 36)")
    parser.add_argument("--margin", type=float, default=0.3, help="safety margin subtracted from the nearest surface, meters (default 0.3)")
    args = parser.parse_args()
    assert 8 <= args.directions <= 72, "--directions must be 8-72 (packages/viewer/src/math.js's validateSafetyEnvelope bound)"
    assert args.near >= 0.1, "--near must be >= 0.1 (depth.js's validateDepthArtifact bound)"
    assert args.far > args.near and args.far <= 100, "--far must be > --near and <= 100"

    img_bgr = cv2.imread(args.panorama, cv2.IMREAD_COLOR)
    if img_bgr is None:
        raise FileNotFoundError(f"cannot read image: {args.panorama}")
    orig_h, orig_w = img_bgr.shape[:2]
    print(f"loading DAP model (weights: {WEIGHTS_PATH}) ...")
    t0 = time.time()
    model, device = load_model()
    print(f"model ready in {time.time() - t0:.1f}s, device={device}")

    img_bgr_small = cv2.resize(img_bgr, (INFER_WIDTH, INFER_HEIGHT), interpolation=cv2.INTER_AREA)
    img_rgb = cv2.cvtColor(img_bgr_small, cv2.COLOR_BGR2RGB)

    t1 = time.time()
    raw, valid = infer_depth_and_mask(model, device, img_rgb)
    elapsed = time.time() - t1

    d_min, d_max = float(raw.min()), float(raw.max())
    norm = (raw - d_min) / (d_max - d_min) if d_max > d_min else np.zeros_like(raw)
    norm = np.clip(norm, 0.0, 1.0)
    depth_m = args.near + norm * (args.far - args.near)
    # validFraction is a numerical-sanity gate (depth.js requires >=0.98), not DAP's own
    # foreground/background confidence mask: DAP's sigmoid-bounded output can't produce
    # NaN/Inf under normal operation, so this is ~1.0 whenever the model actually ran
    # correctly, and would legitimately drop (and fail the gate) if inference produced
    # garbage. DAP's separate confidence mask (sky/background gets defaulted to far-plane
    # depth, not marked invalid) is reported alongside for transparency, not as the gate —
    # gating a strict quality bound on "how much sky is in the shot" would unfairly fail
    # normal outdoor panoramas that DAP otherwise handled fine.
    valid_fraction = float(np.isfinite(raw).mean())
    dap_confident_fraction = float(valid.mean())

    png_u8 = np.clip(np.round(norm * 255.0), 0, 255).astype(np.uint8)
    png_path = f"{args.out_basename}.png"
    Image.fromarray(png_u8, mode="L").save(png_path, optimize=True)
    with open(png_path, "rb") as handle:
        import hashlib
        png_sha256 = hashlib.sha256(handle.read()).hexdigest()

    safety_envelope = build_safety_envelope(depth_m, args.directions, args.margin)

    artifact = {
        "schemaVersion": "unseen-depth-artifact-precursor/1",
        "model": "DAP (Insta360 Research, CVPR 2026, CC BY-NC 4.0 — NonCommercial only)",
        "sourceImage": os.path.abspath(args.panorama),
        "sourceResolution": [orig_w, orig_h],
        "width": INFER_WIDTH,
        "height": INFER_HEIGHT,
        "encoding": "linear-red-v1",
        "nearMeters": args.near,
        "farMeters": args.far,
        "quality": {"validFraction": round(valid_fraction, 6)},
        "dapConfidentFraction": round(dap_confident_fraction, 6),
        "safetyEnvelope": safety_envelope,
        "pngSha256": png_sha256,
        "device": device,
        "elapsedSeconds": round(elapsed, 2),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    json_path = f"{args.out_basename}.artifact.json"
    with open(json_path, "w") as handle:
        json.dump(artifact, handle, indent=2)

    print(f"depth inference done in {elapsed:.2f}s on {device}")
    print(f"raw_depth_min={d_min:.4f} raw_depth_max={d_max:.4f} valid_fraction={valid_fraction:.4f}")
    print(f"near_allowed (min over directions) = {min(d['allowedRadiusMeters'] for d in safety_envelope['directions']):.3f}m, "
          f"max = {max(d['allowedRadiusMeters'] for d in safety_envelope['directions']):.3f}m")
    print(f"wrote {png_path}")
    print(f"wrote {json_path}")


if __name__ == "__main__":
    main()
