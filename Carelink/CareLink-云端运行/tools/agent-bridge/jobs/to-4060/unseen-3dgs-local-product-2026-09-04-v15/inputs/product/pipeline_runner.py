#!/usr/bin/env python3
"""Idempotent 360-video preview and ordinary-photo localization runner.

This runner is intentionally local-only. It consumes a job contract written by
unseen_local_product.py, executes the existing Nerfstudio/COLMAP/PlayCanvas
toolchain, and writes progress/result JSON inside the job's WSL ext4 work dir.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
import re
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


FACES = (
    ("front", 0, 0), ("front_right", 45, 0), ("right", 90, 0),
    ("back_right", 135, 0), ("back", 180, 0), ("back_left", -135, 0),
    ("left", -90, 0), ("front_left", -45, 0), ("up", 0, 65),
)
FACE_SIZE = 1024
FACE_FOV = 100
PANORAMA_FRAMES = 53
HELD_OUT_INDICES = {13, 26, 39}
PREVIEW_ITERATIONS = 7000
PIPELINE_CONTRACT_VERSION = "v15-runner-2026-09-04.6"
STAGE_ORDER = ("extract", "project", "process", "train", "export")
PHOTO_MIN_GEOMETRIC_INLIERS = 20
PHOTO_MIN_GEOMETRIC_INLIER_RATIO = 0.10
PHOTO_MAX_MEDIAN_REPROJECTION_PX = 3.5
COLMAP_MAX_IMAGE_ID = 2**31 - 1
CHECKPOINT_NAME = re.compile(r"^step-(\d{9})\.ckpt$")
TRAIN_REMAINING_PLACEHOLDER = "{remainingIterations}"
TRAIN_RESUME_STEP_PLACEHOLDER = "{resumeStep}"
PROJECTED_VIEW_NAME = re.compile(r"^t(\d{4})_(front|front_right|right|back_right|back|back_left|left|front_left|up)\.jpg$")
PLAYCANVAS_FROM_NERFSTUDIO = (
    (1.0, 0.0, 0.0, 0.0),
    (0.0, 0.0, 1.0, 0.0),
    (0.0, -1.0, 0.0, 0.0),
    (0.0, 0.0, 0.0, 1.0),
)
JSONSCHEMA_VERSION = "4.26.0"
SCHEMA_ROOT = Path(__file__).resolve().parents[1] / "schemas"
# The Mac handoff test interpreter has no third-party packages. Tests opt into
# this in-process hook explicitly; production exposes no flag or environment
# escape from the pinned jsonschema validator.
_SCHEMA_VALIDATOR_FOR_TESTS = None
_SCHEMA_VALIDATORS: dict[str, Any] = {}


def validate_json_contract(value: Any, schema_name: str) -> Any:
    """Validate one installed JSON contract, failing closed on dependency drift."""
    if _SCHEMA_VALIDATOR_FOR_TESTS is not None:
        _SCHEMA_VALIDATOR_FOR_TESTS(value, schema_name)
        return value
    try:
        json.dumps(value, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"could not validate {schema_name}: {exc}") from exc
    validator = _SCHEMA_VALIDATORS.get(schema_name)
    if validator is None:
        try:
            import jsonschema
            actual_version = importlib.metadata.version("jsonschema")
        except (ImportError, importlib.metadata.PackageNotFoundError) as exc:
            raise RuntimeError(
                f"jsonschema {JSONSCHEMA_VERSION} is required for runtime contract validation"
            ) from exc
        if actual_version != JSONSCHEMA_VERSION:
            raise RuntimeError(
                f"jsonschema {JSONSCHEMA_VERSION} is required; found {actual_version}"
            )
        schema_path = SCHEMA_ROOT / schema_name
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"could not load {schema_name}: {exc}") from exc
        jsonschema.Draft202012Validator.check_schema(schema)
        validator = jsonschema.Draft202012Validator(schema)
        _SCHEMA_VALIDATORS[schema_name] = validator
    errors = sorted(
        validator.iter_errors(value),
        key=lambda error: "/".join(str(part) for part in error.absolute_path),
    )
    if errors:
        error = errors[0]
        location = "$" + "".join(f"[{part!r}]" for part in error.absolute_path)
        raise RuntimeError(f"{schema_name} contract violation at {location}: {error.message}")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(json_document_bytes(value))
    os.replace(temporary, path)


def json_document_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def json_document_sha256(value: dict[str, Any]) -> str:
    return hashlib.sha256(json_document_bytes(value)).hexdigest()


def stage_lineage(stage: str, upstream_sha256: str) -> dict[str, str]:
    if stage not in STAGE_ORDER:
        raise ValueError(f"unknown pipeline stage: {stage}")
    return {
        "contractVersion": PIPELINE_CONTRACT_VERSION,
        "stage": stage,
        "upstreamSha256": upstream_sha256,
    }


def stage_lineage_matches(marker: dict[str, Any], stage: str, upstream_sha256: str) -> bool:
    return all(marker.get(key) == value for key, value in stage_lineage(stage, upstream_sha256).items())


def invalidate_stage_markers(stages: Path, start: str) -> None:
    """Invalidate a stage and every consumer of its outputs.

    Only tiny generated marker files are removed here. Generated data is rebuilt
    into an incomplete directory before publication by the owning stage.
    """
    try:
        start_index = STAGE_ORDER.index(start)
    except ValueError as exc:
        raise ValueError(f"unknown pipeline stage: {start}") from exc
    for stage in STAGE_ORDER[start_index:]:
        (stages / f"{stage}.json").unlink(missing_ok=True)
    if start_index <= STAGE_ORDER.index("train"):
        (stages / "train.intent.json").unlink(missing_ok=True)


def publish_nonempty_file(incomplete: Path, destination: Path) -> None:
    if not incomplete.is_file() or incomplete.stat().st_size == 0:
        raise RuntimeError(f"refusing to publish empty staged artifact: {incomplete}")
    os.replace(incomplete, destination)


def quarantine_generated_tree(path: Path) -> Path | None:
    """Atomically move an untrusted generated tree out of the active lineage."""
    if not path.exists():
        return None
    destination = path.with_name(f"{path.name}.invalid-{time.time_ns()}")
    os.replace(path, destination)
    return destination


def quarantine_untrusted_training_state(training: Path, export: Path) -> tuple[Path | None, Path | None]:
    """Remove checkpoint-derived bytes from the active path before a fresh attempt.

    An interrupted training tree has no completed marker binding its config and
    checkpoints to the current process lineage. Checkpoint filenames and file
    sizes alone are not integrity evidence, so such a tree must never be used
    as a resume source.
    """
    return quarantine_generated_tree(training), quarantine_generated_tree(export)


def training_command_template(processed: Path, training: Path, revision_id: str) -> list[str]:
    """Return the immutable CLI portion committed by the pre-train intent."""
    return [
        "ns-train", "splatfacto", "--data", str(processed), "--output-dir", str(training),
        "--experiment-name", revision_id, "--timestamp", "preview-7000",
        "--max-num-iterations", TRAIN_REMAINING_PLACEHOLDER,
        "--steps-per-save", "2000", "--steps-per-eval-image", "100000",
        "--steps-per-eval-all-images", "100000", "--vis", "tensorboard",
        "--pipeline.model.use-scale-regularization", "True",
        "--pipeline.model.random-init", "False",
        "--pipeline.datamanager.dataparser.eval-mode", "all",
    ]


def training_intent_contract(
    process_lineage_sha256: str,
    command_template: list[str],
    training: Path,
    checkpoint_dir: Path,
    config: Path,
) -> dict[str, Any]:
    """Build the exact, stable contract written before the first GPU byte."""
    return {
        "schemaVersion": "1.0",
        "contractVersion": PIPELINE_CONTRACT_VERSION,
        "stage": "train-intent",
        "processLineageSha256": process_lineage_sha256,
        "targetIterations": PREVIEW_ITERATIONS,
        "targetFinalStep": PREVIEW_ITERATIONS - 1,
        "commandTemplate": command_template,
        "resumeArgumentsTemplate": [
            "--load-dir", str(checkpoint_dir), "--load-step", TRAIN_RESUME_STEP_PLACEHOLDER,
        ],
        "outputDir": str(training),
        "checkpointDir": str(checkpoint_dir),
        "configPath": str(config),
        "checkpointValidation": "torch.load(weights_only=True)+integer-step-matches-filename",
    }


def materialize_training_command(
    command_template: list[str],
    remaining_iterations: int,
    checkpoint_dir: Path,
    resume_step: int | None,
) -> list[str]:
    if remaining_iterations < 0:
        raise RuntimeError("remaining training iterations cannot be negative")
    command = [
        str(remaining_iterations) if value == TRAIN_REMAINING_PLACEHOLDER else value
        for value in command_template
    ]
    if resume_step is not None and remaining_iterations > 0:
        command.extend(["--load-dir", str(checkpoint_dir), "--load-step", str(resume_step)])
    return command


def torch_load_checkpoint(path: Path) -> Any:
    """Load only tensor/state-dict data using the runtime that executes ns-train."""
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("PyTorch is unavailable for checkpoint validation") from exc
    return torch.load(path, map_location="cpu", weights_only=True)


def validate_nerfstudio_checkpoint(path: Path, target_iterations: int, *, loader: Any = None) -> dict[str, Any]:
    match = CHECKPOINT_NAME.fullmatch(path.name)
    if match is None or not path.is_file() or path.stat().st_size <= 0:
        raise RuntimeError(f"invalid Nerfstudio checkpoint artifact: {path.name}")
    filename_step = int(match.group(1))
    try:
        state = (loader or torch_load_checkpoint)(path)
    except Exception as exc:
        raise RuntimeError(f"Nerfstudio checkpoint cannot be loaded: {path.name}") from exc
    if not isinstance(state, dict):
        raise RuntimeError(f"Nerfstudio checkpoint root is not a state dictionary: {path.name}")
    state_step = state.get("step")
    if type(state_step) is not int or state_step != filename_step:
        raise RuntimeError(
            f"Nerfstudio checkpoint step mismatch: filename={filename_step} state={state_step!r}"
        )
    if state_step < 0 or state_step >= target_iterations:
        raise RuntimeError(
            f"Nerfstudio checkpoint step {state_step} is outside target 0..{target_iterations - 1}"
        )
    for key in ("pipeline", "optimizers", "scalers"):
        if not isinstance(state.get(key), dict):
            raise RuntimeError(f"Nerfstudio checkpoint lacks required {key} state: {path.name}")
    return {
        "step": state_step,
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
    }


def validated_training_resume_plan(
    checkpoint_dir: Path,
    target_iterations: int,
    *,
    loader: Any = None,
) -> tuple[int | None, int, dict[str, Any] | None]:
    if not checkpoint_dir.is_dir():
        return None, target_iterations, None
    checkpoint_files = sorted(checkpoint_dir.glob("*.ckpt"))
    malformed = [path.name for path in checkpoint_files if CHECKPOINT_NAME.fullmatch(path.name) is None]
    if malformed:
        raise RuntimeError(f"unexpected checkpoint filenames: {malformed[:3]}")
    if not checkpoint_files:
        return None, target_iterations, None
    latest = max(checkpoint_files, key=lambda path: int(CHECKPOINT_NAME.fullmatch(path.name).group(1)))
    evidence = validate_nerfstudio_checkpoint(latest, target_iterations, loader=loader)
    resume_step = int(evidence["step"])
    # Nerfstudio loads step N, sets start_step=N+1, then executes exactly
    # max_num_iterations iterations. This reaches target_final inclusively.
    remaining_iterations = (target_iterations - 1) - resume_step
    return resume_step, remaining_iterations, evidence


def prepare_training_attempt(
    intent_path: Path,
    expected_intent: dict[str, Any],
    training: Path,
    export: Path,
    checkpoint_dir: Path,
    *,
    checkpoint_loader: Any = None,
) -> dict[str, Any]:
    """Recover only an attempt authorized by the exact pre-train intent."""
    intent_exists = intent_path.is_file()
    actual_intent: Any = None
    if intent_exists:
        try:
            actual_intent = json.loads(intent_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            actual_intent = None
    intent_matches = actual_intent == expected_intent

    recovery_reason: str | None = None
    checkpoint_evidence: dict[str, Any] | None = None
    resume_step: int | None = None
    remaining_iterations = PREVIEW_ITERATIONS
    must_quarantine = False
    if not intent_matches:
        must_quarantine = training.exists() or export.exists()
        recovery_reason = "intent-missing" if not intent_exists else "intent-mismatch"
    elif export.exists():
        must_quarantine = True
        recovery_reason = "unexpected-export-before-completion"
    else:
        try:
            resume_step, remaining_iterations, checkpoint_evidence = validated_training_resume_plan(
                checkpoint_dir, PREVIEW_ITERATIONS, loader=checkpoint_loader
            )
            if resume_step is None and training.exists():
                must_quarantine = True
                recovery_reason = "partial-training-without-checkpoint"
        except (OSError, RuntimeError, ValueError) as exc:
            must_quarantine = True
            recovery_reason = f"checkpoint-validation-failed:{type(exc).__name__}"

    training_quarantine: Path | None = None
    export_quarantine: Path | None = None
    if must_quarantine:
        training_quarantine, export_quarantine = quarantine_untrusted_training_state(training, export)
        resume_step, remaining_iterations, checkpoint_evidence = None, PREVIEW_ITERATIONS, None
    write_json(intent_path, expected_intent)
    return {
        "resumeStep": resume_step,
        "remainingIterations": remaining_iterations,
        "resumeCheckpoint": checkpoint_evidence,
        "trainingQuarantine": training_quarantine,
        "exportQuarantine": export_quarantine,
        "recoveryReason": recovery_reason,
    }


def latest_checkpoint_step(checkpoint_dir: Path) -> int | None:
    steps = []
    if checkpoint_dir.is_dir():
        for path in checkpoint_dir.iterdir():
            match = CHECKPOINT_NAME.fullmatch(path.name)
            if match and path.is_file() and path.stat().st_size > 0:
                steps.append(int(match.group(1)))
    return max(steps) if steps else None


def training_marker_matches(
    marker: dict[str, Any],
    upstream_sha256: str,
    train_intent_sha256: str,
    config: Path,
    checkpoint_dir: Path,
) -> bool:
    try:
        final_checkpoint = checkpoint_dir / f"step-{PREVIEW_ITERATIONS - 1:09d}.ckpt"
        return (
            stage_lineage_matches(marker, "train", upstream_sha256)
            and marker.get("iterations") == PREVIEW_ITERATIONS
            and marker.get("evalMode") == "all"
            and marker.get("trainIntentSha256") == train_intent_sha256
            and config.is_file()
            and marker.get("configSha256") == sha256(config)
            and latest_checkpoint_step(checkpoint_dir) == PREVIEW_ITERATIONS - 1
            and final_checkpoint.is_file()
            and marker.get("finalCheckpointBytes") == final_checkpoint.stat().st_size
            and marker.get("finalCheckpointSha256") == sha256(final_checkpoint)
        )
    except (OSError, ValueError):
        return False


def checkpoint_result_evidence(train_marker: dict[str, Any]) -> dict[str, Any]:
    checkpoint_bytes = train_marker.get("finalCheckpointBytes")
    checkpoint_sha256 = train_marker.get("finalCheckpointSha256")
    if not isinstance(checkpoint_bytes, int) or checkpoint_bytes <= 0:
        raise RuntimeError("training marker lacks a non-empty final checkpoint size")
    if not isinstance(checkpoint_sha256, str) or re.fullmatch(r"[0-9a-f]{64}", checkpoint_sha256) is None:
        raise RuntimeError("training marker lacks a valid final checkpoint SHA256")
    return {"checkpointBytes": checkpoint_bytes, "checkpointSha256": checkpoint_sha256}


def colmap_gpu_value(spec: dict[str, Any]) -> str:
    # Ubuntu 22.04's packaged COLMAP 3.7-2 is not a CUDA build. Its SiftGPU
    # path relies on an OpenGL context and is not reliable in the headless WSL
    # worker. R3's doctor validates only the CPU path, so this release refuses
    # every GPU override rather than exposing an unproved escape hatch.
    value = spec.get("colmapUseGpu", os.environ.get("UNSEEN_COLMAP_USE_GPU", "0"))
    if value is False:
        return "0"
    normalized = str(value).strip()
    if normalized != "0":
        raise RuntimeError("COLMAP GPU is unsupported by the R3 Jammy/headless contract; use exactly 0")
    return "0"


def validate_reusable_result(result: Any, spec: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise RuntimeError("existing result is not an object")
    expected = {
        "status": "ready",
        "kind": spec["kind"],
        "inputSha256": spec["inputSha256"],
        "sceneRevisionId": spec["scene"]["revision_id"],
    }
    mismatches = [key for key, value in expected.items() if result.get(key) != value]
    if mismatches:
        raise RuntimeError("existing result contract mismatch: " + ", ".join(mismatches))
    return result


def parent_death_signal() -> None:
    """Ask Linux to terminate a command if this runner disappears."""
    if sys.platform != "linux":
        return
    import ctypes
    libc = ctypes.CDLL(None)
    if libc.prctl(1, signal.SIGTERM) != 0:  # PR_SET_PDEATHSIG
        raise OSError("prctl(PR_SET_PDEATHSIG) failed")


def colmap_model_image_count(model_dir: Path) -> int:
    """Read COLMAP images.bin's fixed uint64 image-count header."""
    path = model_dir / "images.bin"
    if not path.is_file() or path.stat().st_size < 8:
        return 0
    with path.open("rb") as handle:
        raw = handle.read(8)
    return int(struct.unpack("<Q", raw)[0])


def select_largest_colmap_model(sparse_root: Path) -> tuple[Path, dict[str, int]]:
    counts: dict[str, int] = {}
    if sparse_root.is_dir():
        for candidate in sorted(sparse_root.iterdir(), key=lambda path: path.name):
            if not candidate.is_dir():
                continue
            if not all((candidate / name).is_file() for name in ("cameras.bin", "images.bin", "points3D.bin")):
                continue
            count = colmap_model_image_count(candidate)
            if count > 0:
                counts[candidate.name] = count
    if not counts:
        raise RuntimeError("COLMAP produced no valid sparse model")
    name = max(counts, key=lambda value: (counts[value], -int(value) if value.isdigit() else 0, value))
    return sparse_root / name, counts


def projection_identity_map(paths: list[Path]) -> dict[str, dict[str, Any]]:
    """Bind every preserved projected filename to its time and direction."""
    output: dict[str, dict[str, Any]] = {}
    for path in sorted(paths):
        match = PROJECTED_VIEW_NAME.fullmatch(path.name)
        if not match:
            raise RuntimeError(f"unexpected projected view name: {path.name}")
        output[path.name] = {
            "sourceName": path.name,
            "timeIndex": int(match.group(1)),
            "direction": match.group(2),
        }
    return output


def registered_projection_coverage(
    frames: list[dict[str, Any]], rename_map: dict[str, dict[str, Any]]
) -> tuple[set[str], set[int]]:
    directions: set[str] = set()
    time_indices: set[int] = set()
    for frame in frames:
        identity = rename_map.get(Path(str(frame.get("file_path", ""))).name)
        if identity is None:
            raise RuntimeError(f"registered image is absent from projection map: {frame.get('file_path')}")
        directions.add(str(identity["direction"]))
        time_indices.add(int(identity["timeIndex"]))
    return directions, time_indices


def link_or_copy(source: Path, destination: Path) -> None:
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def reset_uncommitted_projection_outputs(project_marker: Path, outputs: tuple[Path, ...]) -> bool:
    """Discard every projected JPG unless a validated stage marker owns it.

    A crash can leave correctly named but truncated images. Counts and names do
    not make those bytes reusable, so an absent/invalid marker always causes a
    complete projection rebuild instead of per-file skipping.
    """
    if project_marker.is_file():
        return False
    for output in outputs:
        if output.exists():
            shutil.rmtree(output)
        output.mkdir(parents=True)
    return True


class Runner:
    def __init__(self, spec: dict[str, Any], *, dry_run: bool = False):
        validate_json_contract(spec, "job.schema.json")
        self.spec = spec
        self.work = Path(spec["workDir"]).resolve()
        self.progress_path = Path(spec["progressPath"]).resolve()
        self.result_path = Path(spec["resultPath"]).resolve()
        self.input = Path(spec["inputPath"]).resolve()
        self.scene = spec["scene"]
        self.dry_run = dry_run
        self.colmap_gpu = colmap_gpu_value(spec)
        self.commands: list[list[str]] = []

    def finish_result(self, result: dict[str, Any]) -> dict[str, Any]:
        validate_json_contract(result, "result.schema.json")
        if not self.dry_run:
            write_json(self.result_path, result)
        return result

    def progress(self, stage: str, fraction: float) -> None:
        write_json(self.progress_path, {"stage": stage, "progress": fraction, "at": time.time()})
        print(f"stage={stage} progress={fraction:.3f}", flush=True)

    def run(
        self,
        command: list[str],
        *,
        log: Path | None = None,
        cwd: Path | None = None,
        timeout: float = 7200,
    ) -> None:
        self.commands.append(command)
        print("$ " + " ".join(command), flush=True)
        if self.dry_run:
            return
        if log:
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a", encoding="utf-8") as output:
                try:
                    completed = subprocess.run(
                        command,
                        cwd=cwd,
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        text=True,
                        timeout=timeout,
                        preexec_fn=parent_death_signal if sys.platform == "linux" else None,
                    )
                except subprocess.TimeoutExpired as exc:
                    raise RuntimeError(f"command timed out after {timeout:.0f}s: {command[0]}") from exc
        else:
            try:
                completed = subprocess.run(
                    command,
                    cwd=cwd,
                    timeout=timeout,
                    preexec_fn=parent_death_signal if sys.platform == "linux" else None,
                )
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError(f"command timed out after {timeout:.0f}s: {command[0]}") from exc
        if completed.returncode:
            raise RuntimeError(f"command exited {completed.returncode}: {command[0]}")

    def run_training(self, command: list[str], *, log: Path, checkpoint_dir: Path) -> tuple[float, int | None]:
        self.commands.append(command)
        print("$ " + " ".join(command), flush=True)
        if self.dry_run:
            return 0.0, None
        log.parent.mkdir(parents=True, exist_ok=True)
        # The log is intentionally append-only for diagnosis, but failure
        # classification must inspect only bytes emitted by this subprocess.
        # Otherwise an OOM from an older attempt can mislabel an unrelated
        # current failure. VRAM sampling is likewise initialized per call.
        attempt_log_start = log.stat().st_size if log.is_file() else 0
        started = time.monotonic()
        peak_vram_mib: int | None = None
        with log.open("a", encoding="utf-8") as output:
            process = subprocess.Popen(
                command,
                stdout=output,
                stderr=subprocess.STDOUT,
                text=True,
                preexec_fn=parent_death_signal if sys.platform == "linux" else None,
            )
            last_reported = None
            while process.poll() is None:
                step = latest_checkpoint_step(checkpoint_dir)
                if step is not None and step != last_reported:
                    completed = min(PREVIEW_ITERATIONS, step + 1)
                    fraction = 0.48 + 0.40 * (completed / PREVIEW_ITERATIONS)
                    self.progress(f"training 3DGS preview {completed}/{PREVIEW_ITERATIONS}", fraction)
                    last_reported = step
                try:
                    sample = subprocess.run(
                        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    values = [int(value.strip()) for value in sample.stdout.splitlines() if value.strip().isdigit()]
                    if values:
                        peak_vram_mib = max([peak_vram_mib or 0, *values])
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    pass
                time.sleep(2)
            return_code = process.wait()
        wall_seconds = time.monotonic() - started
        if return_code:
            with log.open("rb") as handle:
                handle.seek(attempt_log_start)
                attempt_log_text = handle.read().decode("utf-8", errors="replace")
            if re.search(r"out of memory|cuda.*oom", attempt_log_text, re.I):
                raise RuntimeError("CUDA OOM; automatic profile mutation is intentionally disabled")
            raise RuntimeError(f"command exited {return_code}: {command[0]}")
        return wall_seconds, peak_vram_mib

    def require_tools(self, names: list[str]) -> None:
        missing = [name for name in names if shutil.which(name) is None]
        if missing and not self.dry_run:
            raise RuntimeError("missing commands: " + ", ".join(missing))

    def validate_identity(self) -> None:
        if not self.input.is_file():
            raise RuntimeError(f"input missing: {self.input}")
        if sha256(self.input) != self.spec["inputSha256"]:
            raise RuntimeError("input SHA256 changed after queueing")
        if str(self.work).startswith("/mnt/") or str(Path(self.spec["productRoot"]).resolve()).startswith("/mnt/"):
            raise RuntimeError("training/localization work must stay on WSL ext4")

    def execute(self) -> dict[str, Any]:
        self.validate_identity()
        if self.result_path.is_file():
            existing = json.loads(self.result_path.read_text(encoding="utf-8"))
            # Identity alone is not sufficient to reuse a claimed success.
            # Continue through the stage validators so markers, checkpoint,
            # PLY/SOG and Viewer/photo artifacts are re-verified or rebuilt.
            validate_json_contract(existing, "result.schema.json")
            validate_reusable_result(existing, self.spec)
        if self.spec["kind"] == "scene_preview":
            return self.scene_preview()
        if self.spec["kind"] == "photo_localize":
            return self.photo_localize()
        raise RuntimeError(f"unknown job kind: {self.spec['kind']}")

    def scene_preview(self) -> dict[str, Any]:
        self.require_tools(["ffmpeg", "ffprobe", "ns-process-data", "ns-train", "ns-export"])
        scene_root = Path(self.spec["productRoot"]) / "scenes" / self.scene["revision_id"]
        erp_dir, train_dir = scene_root / "erp", scene_root / "projected/train"
        held_dir, processed = scene_root / "projected/held-out", scene_root / "processed"
        training, export, viewer = scene_root / "training", scene_root / "export", scene_root / "viewer"
        for path in (erp_dir, train_dir, held_dir, training, export, viewer):
            path.mkdir(parents=True, exist_ok=True)
        stages = scene_root / "stages"; stages.mkdir(exist_ok=True)

        duration = float(self.scene["duration_seconds"])
        extract_done = stages / "extract.json"
        if extract_done.is_file() and not self.dry_run:
            try:
                marker = json.loads(extract_done.read_text(encoding="utf-8"))
                valid = (
                    stage_lineage_matches(marker, "extract", self.spec["inputSha256"])
                    and
                    marker.get("sourceSha256") == self.spec["inputSha256"]
                    and marker.get("frames") == PANORAMA_FRAMES
                    and len(list(erp_dir.glob("erp_*.jpg"))) == PANORAMA_FRAMES
                )
            except (OSError, ValueError, json.JSONDecodeError):
                valid = False
            if not valid:
                invalidate_stage_markers(stages, "extract")
        if not extract_done.is_file():
            self.progress("extracting 53 panorama frames", 0.05)
            fps = PANORAMA_FRAMES / duration
            self.run(["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y", "-i", str(self.input),
                      "-vf", f"fps={fps:.12f}", "-frames:v", str(PANORAMA_FRAMES), "-q:v", "2", str(erp_dir / "erp_%04d.jpg")],
                     log=self.work / "extract.log", timeout=1800)
            if not self.dry_run and len(list(erp_dir.glob("erp_*.jpg"))) != PANORAMA_FRAMES:
                raise RuntimeError("frame extraction did not produce exactly 53 panoramas")
            if not self.dry_run:
                write_json(extract_done, {
                    **stage_lineage("extract", self.spec["inputSha256"]),
                    "sourceSha256": self.spec["inputSha256"],
                    "frames": PANORAMA_FRAMES,
                })

        extract_lineage_sha = sha256(extract_done) if not self.dry_run else "DRY_RUN_EXTRACT"

        project_done = stages / "project.json"
        expected_train = (PANORAMA_FRAMES - len(HELD_OUT_INDICES)) * len(FACES)
        expected_held = len(HELD_OUT_INDICES) * len(FACES)
        if project_done.is_file() and not self.dry_run:
            try:
                marker = json.loads(project_done.read_text(encoding="utf-8"))
                valid = (
                    stage_lineage_matches(marker, "project", extract_lineage_sha)
                    and marker.get("trainingViews") == expected_train
                    and marker.get("heldOutViews") == expected_held
                    and len(list(train_dir.glob("*.jpg"))) == expected_train
                    and len(list(held_dir.glob("*.jpg"))) == expected_held
                )
            except (OSError, ValueError, json.JSONDecodeError):
                valid = False
            if not valid:
                invalidate_stage_markers(stages, "project")
        if not project_done.is_file():
            self.progress("projecting overlapping perspective views", 0.12)
            if not self.dry_run:
                reset_uncommitted_projection_outputs(project_done, (train_dir, held_dir))
            sources = sorted(erp_dir.glob("erp_*.jpg"))
            if not self.dry_run and len(sources) != PANORAMA_FRAMES: raise RuntimeError("panorama frame set is incomplete")
            if self.dry_run: sources = [erp_dir / "erp_0001.jpg"]
            total = max(1, len(sources) * len(FACES))
            for source_index, source in enumerate(sources):
                target_root = held_dir if source_index in HELD_OUT_INDICES else train_dir
                for face_index, (name, yaw, pitch) in enumerate(FACES):
                    target = target_root / f"t{source_index:04d}_{name}.jpg"
                    if target.is_file(): continue
                    self.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                              "-vf", f"v360=input=equirect:output=flat:yaw={yaw}:pitch={pitch}:h_fov={FACE_FOV}:v_fov={FACE_FOV}:w={FACE_SIZE}:h={FACE_SIZE}",
                              "-frames:v", "1", "-q:v", "2", str(target)], log=self.work / "project.log", timeout=300)
                    self.progress("projecting overlapping perspective views", 0.12 + 0.16 * ((source_index * len(FACES) + face_index + 1) / total))
            if not self.dry_run and (len(list(train_dir.glob("*.jpg"))) != expected_train or len(list(held_dir.glob("*.jpg"))) != expected_held):
                raise RuntimeError("perspective projection count mismatch")
            if not self.dry_run:
                write_json(project_done, {
                    **stage_lineage("project", extract_lineage_sha),
                    "trainingViews": expected_train,
                    "heldOutViews": expected_held,
                    "faceSize": FACE_SIZE,
                    "fov": FACE_FOV,
                })

        project_lineage_sha = sha256(project_done) if not self.dry_run else "DRY_RUN_PROJECT"

        process_done = stages / "process.json"
        projection_map_path = stages / "projection-identity-map.json"
        if process_done.is_file() and not self.dry_run:
            try:
                marker = json.loads(process_done.read_text(encoding="utf-8"))
                model = processed / marker["colmapModel"]
                valid = (
                    stage_lineage_matches(marker, "process", project_lineage_sha)
                    and marker.get("registeredViews", 0) >= 270
                    and len(marker.get("directions", [])) >= 6
                    and (processed / "transforms.json").is_file()
                    and (processed / "colmap/database.db").is_file()
                    and model.is_dir()
                    and colmap_model_image_count(model) == marker.get("registeredViews")
                    and projection_map_path.is_file()
                )
            except (KeyError, OSError, ValueError, json.JSONDecodeError):
                valid = False
            if not valid:
                invalidate_stage_markers(stages, "process")
        if not process_done.is_file():
            # A newly generated COLMAP model defines a new coordinate/point
            # lineage. Never resume an old checkpoint or export against it.
            if not self.dry_run:
                invalidate_stage_markers(stages, "process")
                for generated in (training, export):
                    if generated.exists():
                        shutil.rmtree(generated)
            self.progress("estimating camera poses with COLMAP", 0.30)
            temporary = scene_root / "processed.incomplete"
            if temporary.exists() and not self.dry_run: shutil.rmtree(temporary)
            identity_map = projection_identity_map(sorted(train_dir.glob("*.jpg"))) if not self.dry_run else {}
            if not self.dry_run:
                write_json(projection_map_path, {"schemaVersion": "1.0", "filenamesPreserved": True, "entries": identity_map})
                images = temporary / "images"
                images.mkdir(parents=True)
                for source in sorted(train_dir.glob("*.jpg")):
                    link_or_copy(source, images / source.name)
                (temporary / "colmap/candidates").mkdir(parents=True)
            focal = FACE_SIZE / (2.0 * math.tan(math.radians(FACE_FOV) / 2.0))
            camera_parameters = f"{focal:.12f},{focal:.12f},{FACE_SIZE / 2:.6f},{FACE_SIZE / 2:.6f}"
            self.run([
                "colmap", "feature_extractor", "--database_path", str(temporary / "colmap/database.db"),
                "--image_path", str(temporary / "images"), "--ImageReader.single_camera", "1",
                "--ImageReader.camera_model", "PINHOLE", "--ImageReader.camera_params", camera_parameters,
                "--SiftExtraction.use_gpu", self.colmap_gpu,
            ], log=self.work / "sfm.log")
            self.run([
                "colmap", "exhaustive_matcher", "--database_path", str(temporary / "colmap/database.db"),
                "--SiftMatching.use_gpu", self.colmap_gpu,
            ], log=self.work / "sfm.log")
            self.run([
                "colmap", "mapper", "--database_path", str(temporary / "colmap/database.db"),
                "--image_path", str(temporary / "images"), "--output_path", str(temporary / "colmap/candidates"),
                "--Mapper.ba_refine_focal_length", "0", "--Mapper.ba_refine_principal_point", "0",
                "--Mapper.ba_refine_extra_params", "0", "--Mapper.ba_global_function_tolerance", "1e-6",
            ], log=self.work / "sfm.log")
            registered = 0; directions: set[str] = set(); time_indices: set[int] = set()
            if not self.dry_run:
                selected_model, model_counts = select_largest_colmap_model(temporary / "colmap/candidates")
                canonical_model = temporary / "colmap/sparse/0"
                canonical_model.parent.mkdir(parents=True)
                shutil.copytree(selected_model, canonical_model)
            self.run([
                "ns-process-data", "images", "--data", str(temporary / "images"), "--output-dir", str(temporary),
                "--skip-image-processing", "--skip-colmap", "--colmap-model-path", "colmap/sparse/0",
                "--camera-type", "perspective", "--num-downscales", "0",
            ], log=self.work / "sfm.log")
            if not self.dry_run:
                registered = colmap_model_image_count(canonical_model)
                transforms = json.loads((temporary / "transforms.json").read_text(encoding="utf-8"))
                frames = transforms.get("frames", [])
                if len(frames) != registered or registered != model_counts[selected_model.name]:
                    raise RuntimeError("selected COLMAP model and regenerated transforms disagree")
                directions, time_indices = registered_projection_coverage(frames, identity_map)
                if registered < 270 or len(directions) < 6 or len(time_indices) < 30:
                    raise RuntimeError(
                        f"SfM coverage gate failed: registered={registered}/450 "
                        f"directions={sorted(directions)} timeIndices={len(time_indices)}/50"
                    )
                if processed.exists(): shutil.rmtree(processed)
                os.replace(temporary, processed)
                write_json(process_done, {
                    **stage_lineage("process", project_lineage_sha),
                    "registeredViews": registered,
                    "inputViews": expected_train,
                    "directions": sorted(directions),
                    "registeredTimeIndices": len(time_indices),
                    "colmapModel": "colmap/sparse/0",
                    "selectedCandidateModel": selected_model.name,
                    "colmapModelCounts": model_counts,
                    "cameraModel": "PINHOLE_FIXED_100_DEGREES",
                    "cameraParameters": [focal, focal, FACE_SIZE / 2, FACE_SIZE / 2],
                    "colmapGpuRequested": self.colmap_gpu == "1",
                })

        process_lineage_sha = sha256(process_done) if not self.dry_run else "DRY_RUN_PROCESS"

        train_done = stages / "train.json"
        train_intent = stages / "train.intent.json"
        config = training / self.scene["revision_id"] / "splatfacto" / "preview-7000" / "config.yml"
        checkpoint_dir = config.parent / "nerfstudio_models"
        command_template = training_command_template(processed, training, self.scene["revision_id"])
        expected_train_intent = training_intent_contract(
            process_lineage_sha, command_template, training, checkpoint_dir, config
        )
        expected_train_intent_sha256 = json_document_sha256(expected_train_intent)
        invalid_training_quarantine: Path | None = None
        invalid_export_quarantine: Path | None = None
        recovery_reason: str | None = None
        resume_checkpoint_evidence: dict[str, Any] | None = None
        if train_done.is_file() and not self.dry_run:
            try:
                marker = json.loads(train_done.read_text(encoding="utf-8"))
                valid = training_marker_matches(
                    marker, process_lineage_sha, expected_train_intent_sha256, config, checkpoint_dir
                )
            except (OSError, ValueError, json.JSONDecodeError):
                valid = False
            if not valid:
                invalidate_stage_markers(stages, "train")
                # A marker/artifact hash disagreement makes every checkpoint in
                # this tree untrusted. Keep it for diagnosis, but move it out of
                # the active path so resume cannot consume corrupt or stale
                # bytes. Export is derived from that checkpoint and is isolated
                # with it; the Viewer SOG remains last-known-good until the new
                # export passes staged validation and is atomically published.
                invalid_training_quarantine = quarantine_generated_tree(training)
                invalid_export_quarantine = quarantine_generated_tree(export)
                recovery_reason = "completed-marker-or-artifact-invalid"
            else:
                # train.json is the durable completion record. A stale intent
                # can remain only if the process died between these two atomic
                # operations, and is no longer needed for recovery.
                train_intent.unlink(missing_ok=True)
        if not train_done.is_file():
            if self.dry_run:
                resume_step, remaining_iterations = None, PREVIEW_ITERATIONS
            else:
                attempt = prepare_training_attempt(
                    train_intent,
                    expected_train_intent,
                    training,
                    export,
                    checkpoint_dir,
                )
                resume_step = attempt["resumeStep"]
                remaining_iterations = attempt["remainingIterations"]
                resume_checkpoint_evidence = attempt["resumeCheckpoint"]
                invalid_training_quarantine = invalid_training_quarantine or attempt["trainingQuarantine"]
                invalid_export_quarantine = invalid_export_quarantine or attempt["exportQuarantine"]
                recovery_reason = recovery_reason or attempt["recoveryReason"]
            completed_iterations = 0 if resume_step is None else resume_step + 1
            self.progress(
                f"training 3DGS preview {completed_iterations}/{PREVIEW_ITERATIONS}",
                0.48 + 0.40 * (completed_iterations / PREVIEW_ITERATIONS),
            )
            command = materialize_training_command(
                command_template, remaining_iterations, checkpoint_dir, resume_step
            )
            training_wall_seconds = 0.0
            peak_vram_mib = None
            if remaining_iterations > 0:
                training_wall_seconds, peak_vram_mib = self.run_training(
                    command, log=self.work / "train.log", checkpoint_dir=checkpoint_dir
                )
            if not self.dry_run:
                if not config.is_file(): raise RuntimeError("training finished without config.yml")
                if not train_intent.is_file() or sha256(train_intent) != expected_train_intent_sha256:
                    raise RuntimeError("pre-train intent changed or disappeared during training")
                final_step, final_remaining, final_checkpoint_evidence = validated_training_resume_plan(
                    checkpoint_dir, PREVIEW_ITERATIONS
                )
                if final_step != PREVIEW_ITERATIONS - 1:
                    raise RuntimeError(
                        f"training did not reach fixed preview target: final checkpoint step={final_step}, expected={PREVIEW_ITERATIONS - 1}"
                    )
                if final_remaining != 0 or final_checkpoint_evidence is None:
                    raise RuntimeError("final checkpoint validation did not prove preview completion")
                final_checkpoint = checkpoint_dir / f"step-{final_step:09d}.ckpt"
                write_json(train_done, {
                    **stage_lineage("train", process_lineage_sha),
                    "trainIntentSha256": expected_train_intent_sha256,
                    "iterations": PREVIEW_ITERATIONS,
                    "evalMode": "all",
                    "resumedFromStep": resume_step,
                    "finalCheckpointStep": final_step,
                    "finalCheckpointBytes": final_checkpoint_evidence["bytes"],
                    "finalCheckpointSha256": final_checkpoint_evidence["sha256"],
                    "config": str(config),
                    "configSha256": sha256(config),
                    "lastAttemptWallSeconds": training_wall_seconds,
                    "lastAttemptPeakVramMiB": peak_vram_mib,
                    "oom": False,
                    "invalidArtifactRecovery": {
                        "trainingQuarantine": str(invalid_training_quarantine) if invalid_training_quarantine else None,
                        "exportQuarantine": str(invalid_export_quarantine) if invalid_export_quarantine else None,
                        "reason": recovery_reason,
                    },
                    "resumeCheckpointBytes": resume_checkpoint_evidence["bytes"] if resume_checkpoint_evidence else None,
                    "resumeCheckpointSha256": resume_checkpoint_evidence["sha256"] if resume_checkpoint_evidence else None,
                })
                train_intent.unlink(missing_ok=True)

        train_lineage_sha = sha256(train_done) if not self.dry_run else "DRY_RUN_TRAIN"

        export_done = stages / "export.json"
        ply = export / "splat.ply"; sog = viewer / "assets/scene.sog"
        if export_done.is_file() and not self.dry_run:
            try:
                marker = json.loads(export_done.read_text(encoding="utf-8"))
                final_checkpoint = checkpoint_dir / f"step-{PREVIEW_ITERATIONS - 1:09d}.ckpt"
                valid = (
                    stage_lineage_matches(marker, "export", train_lineage_sha)
                    and final_checkpoint.is_file()
                    and marker.get("sourceCheckpointSha256") == sha256(final_checkpoint)
                    and ply.is_file()
                    and sog.is_file()
                    and marker.get("plyBytes") == ply.stat().st_size
                    and marker.get("plySha256") == sha256(ply)
                    and marker.get("sogBytes") == sog.stat().st_size
                    and marker.get("sogSha256") == sha256(sog)
                    and marker.get("sogShBands") == 1
                    and marker.get("sogIterations") == 2
                )
            except (OSError, ValueError, json.JSONDecodeError):
                valid = False
            if not valid:
                invalidate_stage_markers(stages, "export")
        if not export_done.is_file():
            self.progress("exporting PLY and SOG", 0.90)
            self.run(["ns-export", "gaussian-splat", "--load-config", str(config), "--output-dir", str(export)], log=self.work / "export.log")
            sog.parent.mkdir(parents=True, exist_ok=True)
            sog_incomplete = sog.with_name(f"{sog.stem}.incomplete{sog.suffix}")
            if not self.dry_run:
                sog_incomplete.unlink(missing_ok=True)
            splat_transform = self.splat_transform_command()
            self.run(
                [*splat_transform, "-g", "cpu", "-H", "1", "-i", "2", str(ply), str(sog_incomplete)],
                log=self.work / "sog.log",
                timeout=600,
            )
            if not self.dry_run and (not sog_incomplete.is_file() or sog_incomplete.stat().st_size == 0):
                raise RuntimeError("splat-transform produced an empty incomplete SOG")
            # A zero exit code from conversion is not enough: parse the staged
            # artifact before replacing the last known-good Viewer asset.
            self.run(
                [*splat_transform, str(sog_incomplete), "--info", "json", "null"],
                log=self.work / "sog-validate.log",
                timeout=120,
            )
            if not self.dry_run:
                publish_nonempty_file(sog_incomplete, sog)
                if not ply.is_file() or not sog.is_file() or sog.stat().st_size == 0:
                    raise RuntimeError("export did not produce non-empty PLY and SOG")
                final_checkpoint = checkpoint_dir / f"step-{PREVIEW_ITERATIONS - 1:09d}.ckpt"
                write_json(export_done, {
                    **stage_lineage("export", train_lineage_sha),
                    "sourceCheckpointSha256": sha256(final_checkpoint),
                    "plyBytes": ply.stat().st_size,
                    "plySha256": sha256(ply),
                    "sogBytes": sog.stat().st_size,
                    "sogSha256": sha256(sog),
                    "sogShBands": 1,
                    "sogIterations": 2,
                    "sogTimeoutSeconds": 600,
                })

        self.progress("assembling local viewer", 0.95)
        viewer_source = self.find_viewer_source()
        if not self.dry_run:
            for name in ("index.html", "styles.css", "app.js", "scene.schema.json"):
                shutil.copy2(viewer_source / name, viewer / name)
            vendor = viewer / "vendor"; vendor.mkdir(exist_ok=True)
            shutil.copy2(viewer_source / "vendor/playcanvas.min.mjs", vendor / "playcanvas.min.mjs")
            shutil.copy2(viewer_source / "vendor/PLAYCANVAS-LICENSE.txt", vendor / "PLAYCANVAS-LICENSE.txt")
            manifest = self.initial_manifest(processed, sog, scene_root)
            write_json(viewer / "scene.json", manifest)
            held_manifest = {"sceneRevisionId": self.scene["revision_id"], "sourceVideoSha256": self.spec["inputSha256"],
                             "trainingViews": 450, "heldOutViews": 27, "heldOutPaths": [str(path) for path in sorted(held_dir.glob("*.jpg"))],
                             "usedForTraining": False}
            write_json(scene_root / "held-out/manifest.json", held_manifest)
            process_metrics = json.loads(process_done.read_text(encoding="utf-8"))
            train_metrics = json.loads(train_done.read_text(encoding="utf-8"))
            export_metrics = json.loads(export_done.read_text(encoding="utf-8"))
            result = {"schemaVersion": "1.0", "status": "ready", "kind": "scene_preview", "sceneRevisionId": self.scene["revision_id"],
                      "inputSha256": self.spec["inputSha256"], "sogPath": str(sog), "sogBytes": sog.stat().st_size, "sogSha256": sha256(sog),
                      "viewerRoot": str(viewer), "viewerCommand": f"python3 -m http.server 8790 --bind 127.0.0.1 --directory {viewer}",
                      "heldOutManifest": str(scene_root / "held-out/manifest.json"), "registeredViews": process_metrics["registeredViews"],
                      "registeredDirections": process_metrics["directions"], "registeredTimeIndices": process_metrics["registeredTimeIndices"],
                      "colmapModel": process_metrics["colmapModel"], "colmapModelCounts": process_metrics["colmapModelCounts"],
                      "trainingIterations": train_metrics["iterations"], "trainingResumedFromStep": train_metrics["resumedFromStep"],
                      "trainingLastAttemptWallSeconds": train_metrics["lastAttemptWallSeconds"],
                      "trainingLastAttemptPeakVramMiB": train_metrics["lastAttemptPeakVramMiB"], "oom": train_metrics["oom"],
                      "plyBytes": export_metrics["plyBytes"], "plySha256": export_metrics["plySha256"],
                      "productionConnected": False, "commands": self.commands}
            result.update(checkpoint_result_evidence(train_metrics))
            return self.finish_result(result)
        return self.finish_result({"schemaVersion": "1.0", "status": "dry-run", "kind": "scene_preview", "sceneRevisionId": self.scene["revision_id"], "inputSha256": self.spec["inputSha256"], "commands": self.commands})

    def find_viewer_source(self) -> Path:
        candidates = [
            Path(os.environ.get("UNSEEN_VIEWER_SOURCE", "")),
            Path(__file__).resolve().parents[1] / "viewer",
            Path("/home/max/src/unseen-3dgs-sceneworker/viewer"),
        ]
        for candidate in candidates:
            if candidate and (candidate / "app.js").is_file() and (candidate / "vendor/playcanvas.min.mjs").is_file(): return candidate
        if self.dry_run: return Path("/home/max/src/unseen-3dgs-sceneworker/viewer")
        raise RuntimeError("viewer source missing; set UNSEEN_VIEWER_SOURCE to the existing PoC viewer")

    def splat_transform_command(self, candidates: list[Path] | None = None) -> list[str]:
        if candidates is None:
            candidates = [
                Path(__file__).resolve().parents[1] / "tools/splat-transform/node_modules/.bin/splat-transform",
                Path("/home/max/src/unseen-3dgs-sceneworker/tools/splat-transform/node_modules/.bin/splat-transform"),
            ]
        for candidate in candidates:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return [str(candidate)]
        if self.dry_run and candidates:
            return [str(candidates[0])]
        raise RuntimeError("pinned splat-transform executable is missing; run the explicit dependency bootstrap")

    def initial_manifest(self, processed: Path, sog: Path, scene_root: Path) -> dict[str, Any]:
        transforms = json.loads((processed / "transforms.json").read_text(encoding="utf-8"))
        parser_transform = find_dataparser_transform(scene_root)
        poses = []
        for frame in transforms["frames"]:
            matrix = frame["transform_matrix"]
            raw = {"rotation": [[float(matrix[r][c]) for c in range(3)] for r in range(3)],
                   "position": [float(matrix[r][3]) for r in range(3)]}
            pose = saved_pose_to_viewer(raw, parser_transform, transforms.get("applied_transform"))
            pose["fovDegrees"] = camera_vertical_fov(transforms, frame)
            poses.append(pose)
        position = poses[0]["position"]
        xs = [row["position"][0] for row in poses]
        zs = [row["position"][2] for row in poses]
        margin = max(0.25, 0.08 * max(max(xs) - min(xs), max(zs) - min(zs)))
        boundary = [[min(xs)-margin, min(zs)-margin], [max(xs)+margin, min(zs)-margin], [max(xs)+margin, max(zs)+margin], [min(xs)-margin, max(zs)+margin]]
        anchor = {"id": "start", "label": "Initial scene camera", "sceneRevisionId": self.scene["revision_id"], "position": position,
                  "quaternion": poses[0]["quaternion"], "fov": poses[0]["fovDegrees"]}
        return {"$schema": "./scene.schema.json", "sceneRevisionId": self.scene["revision_id"], "name": self.scene["display_name"],
                "sceneAsset": {"url": "./assets/scene.sog", "format": "sog", "required": True, "position": [0,0,0], "rotationEuler": [-90,0,0], "scale": 1},
                "backgroundColor": [0.12,0.12,0.12], "defaultPhotoAnchorId": anchor["id"],
                "navigation": {"eyeHeight": sorted(row["position"][1] for row in poses)[len(poses)//2], "moveSpeed": max(0.02, margin), "lookSensitivity": 0.11,
                "defaultFov": 70, "fovRangeDegrees": [30,110], "sprintMultiplier": 3, "startMode": "walk", "boundaryType": "camera-bounds",
                "boundaryXZ": boundary, "startPose": anchor}, "photoAnchors": [anchor]}

    def photo_localize(self) -> dict[str, Any]:
        self.require_tools(["colmap"])
        scene_result = self.scene.get("result")
        if not isinstance(scene_result, dict) or scene_result.get("status") != "ready": raise RuntimeError("scene result is not ready")
        scene_root = Path(self.spec["productRoot"]) / "scenes" / self.scene["revision_id"]
        processed = scene_root / "processed"; base_db = processed / "colmap/database.db"
        process_marker = json.loads((scene_root / "stages/process.json").read_text(encoding="utf-8"))
        base_model = processed / process_marker["colmapModel"]
        if not base_db.is_file() or not base_model.is_dir(): raise RuntimeError("scene COLMAP map is missing")
        local = self.work / "localize"; images = local / "images"; output_model = local / "registered"; text_model = local / "text"; base_text_model = local / "base-text"
        # A failed COLMAP registration can leave a partial database/model. Photo
        # localization is cheap relative to training, so retries rebuild this
        # isolated workspace instead of trusting ambiguous partial state.
        if local.exists() and not self.dry_run:
            shutil.rmtree(local)
        local.mkdir(parents=True, exist_ok=True); images.mkdir(exist_ok=True); output_model.mkdir(exist_ok=True); text_model.mkdir(exist_ok=True); base_text_model.mkdir(exist_ok=True)
        database = local / "database.db"
        if not database.is_file(): shutil.copy2(base_db, database)
        base_database_sha256 = sha256(base_db) if not self.dry_run else None
        if not self.dry_run and sha256(database) != base_database_sha256:
            raise RuntimeError("copied localization database does not match the frozen scene database")
        source_images = processed / "images"
        query_name = "query" + self.input.suffix.lower()
        query_list = local / "query-list.txt"; query_list.write_text(query_name + "\n", encoding="utf-8")
        # Ubuntu 22.04 supplies COLMAP 3.7. Its image_registrator has neither a
        # Mapper.image_list_path option nor the newer fix_existing_frames name.
        # Build a private database containing exactly the frozen model's
        # references; feature extraction then adds the sole unregistered image,
        # query. The source database is copied and is never mutated.
        self.run(["colmap", "model_converter", "--input_path", str(base_model), "--output_path", str(base_text_model), "--output_type", "TXT"], log=self.work / "photo.log")
        reference_frame_count = 0
        database_prune_evidence: dict[str, Any] = {}
        if not self.dry_run:
            base_records = parse_colmap_image_poses(base_text_model / "images.txt")
            database_prune_evidence = prune_colmap_database_to_model(database, base_records)
            database_prune_evidence["sourceDatabaseSha256"] = base_database_sha256
            reference_frame_count = len(base_records)
            for name in sorted(base_records):
                reference = source_images / name
                if not reference.is_file():
                    raise RuntimeError(f"base COLMAP reference image is missing: {name}")
                (images / name).symlink_to(reference)
        query_path = images / query_name
        if not query_path.is_file(): shutil.copy2(self.input, query_path)
        self.progress("extracting photo features", 0.10)
        self.run(["colmap", "feature_extractor", "--database_path", str(database), "--image_path", str(images), "--image_list_path", str(query_list),
                  "--ImageReader.camera_model", "SIMPLE_RADIAL", "--SiftExtraction.use_gpu", self.colmap_gpu], log=self.work / "photo.log")
        if not self.dry_run:
            database_prune_evidence.update(validate_colmap_localization_database(database, base_records, query_name))
        self.progress("matching photo against scene map", 0.35)
        self.run(["colmap", "exhaustive_matcher", "--database_path", str(database), "--SiftMatching.use_gpu", self.colmap_gpu], log=self.work / "photo.log")
        self.progress("solving truth-free camera pose", 0.75)
        self.run([
            "colmap", "image_registrator", "--database_path", str(database),
            "--input_path", str(base_model), "--output_path", str(output_model),
            "--Mapper.fix_existing_images", "1",
            "--Mapper.abs_pose_min_num_inliers", str(PHOTO_MIN_GEOMETRIC_INLIERS),
            "--Mapper.abs_pose_min_inlier_ratio", str(PHOTO_MIN_GEOMETRIC_INLIER_RATIO),
            "--Mapper.abs_pose_max_error", str(PHOTO_MAX_MEDIAN_REPROJECTION_PX),
            "--Mapper.filter_max_reproj_error", str(PHOTO_MAX_MEDIAN_REPROJECTION_PX),
        ], log=self.work / "photo.log")
        self.run(["colmap", "model_converter", "--input_path", str(output_model), "--output_path", str(text_model), "--output_type", "TXT"], log=self.work / "photo.log")
        if self.dry_run:
            return self.finish_result({"schemaVersion": "1.0", "status": "dry-run", "kind": "photo_localize", "sceneRevisionId": self.scene["revision_id"], "inputSha256": self.spec["inputSha256"], "commands": self.commands})
        pose = parse_colmap_query_pose(text_model / "images.txt", query_name)
        registration_quality = parse_colmap_registration_quality(
            text_model / "images.txt",
            text_model / "cameras.txt",
            text_model / "points3D.txt",
            query_name,
        )
        registration_quality.update(validate_colmap_reference_gauge(
            base_text_model / "images.txt", text_model / "images.txt", query_name
        ))
        registration_quality["referenceFramesWhitelisted"] = validate_reference_frame_contract(
            reference_frame_count, registration_quality, database_prune_evidence
        )
        registration_quality["referenceFramesInIsolatedDatabase"] = reference_frame_count
        registration_quality["localDatabaseIsolation"] = database_prune_evidence
        registration_quality["colmapGpuRequested"] = self.colmap_gpu == "1"
        if not registration_quality["gatePassed"]:
            raise RuntimeError(
                "photo localization quality gate failed: "
                f"inliers={registration_quality['geometricInliers']} "
                f"ratio={registration_quality['geometricInlierRatio']:.6f} "
                f"medianPx={registration_quality['medianReprojectionPx']:.6f}"
            )
        transformed = original_pose_to_viewer(pose, find_dataparser_transform(scene_root))
        transformed["fovDegrees"] = parse_colmap_camera_fov(text_model / "cameras.txt", pose["cameraId"])
        manifest_path = Path(scene_result["viewerRoot"]) / "scene.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        anchor_id = "photo-" + self.spec["inputSha256"][:12]
        anchor = {"id": anchor_id, "label": "Uploaded photo", "sceneRevisionId": self.scene["revision_id"],
                  "position": transformed["position"], "quaternion": transformed["quaternion"], "fov": transformed["fovDegrees"]}
        # The reused Viewer intentionally displays photoAnchors[0]. Put the
        # newest localized photo first so "Return to source frame" targets the
        # photo the user just submitted, rather than the scene's initial camera.
        prioritize_photo_anchor(manifest, anchor)
        write_json(manifest_path, manifest)
        result = {"schemaVersion": "1.0", "status": "ready", "kind": "photo_localize", "sceneRevisionId": self.scene["revision_id"],
                  "inputSha256": self.spec["inputSha256"], "groundTruthRead": False, "hardcodedPoseUsed": False, "anchor": anchor,
                  "registrationQuality": registration_quality,
                  "viewerManifest": str(manifest_path), "commands": self.commands}
        return self.finish_result(result)


def prioritize_photo_anchor(manifest: dict[str, Any], anchor: dict[str, Any]) -> None:
    anchors = [row for row in manifest.get("photoAnchors", []) if row.get("id") != anchor["id"]]
    manifest["photoAnchors"] = [anchor, *anchors]
    manifest["defaultPhotoAnchorId"] = anchor["id"]


def quaternion_to_rotation(qw: float, qx: float, qy: float, qz: float) -> list[list[float]]:
    return [[1-2*(qy*qy+qz*qz), 2*(qx*qy-qz*qw), 2*(qx*qz+qy*qw)],
            [2*(qx*qy+qz*qw), 1-2*(qx*qx+qz*qz), 2*(qy*qz-qx*qw)],
            [2*(qx*qz-qy*qw), 2*(qy*qz+qx*qw), 1-2*(qx*qx+qy*qy)]]


def find_colmap_query_record(path: Path, query_name: str) -> tuple[list[str], list[str]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    for index, line in enumerate(lines):
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 10 and parts[9] == query_name:
            point_tokens = lines[index + 1].split() if index + 1 < len(lines) else []
            if len(point_tokens) % 3:
                raise RuntimeError("localized query has malformed POINTS2D data")
            return parts, point_tokens
    raise RuntimeError("uploaded photo did not register into the scene map")


def rotation_to_quaternion(matrix: list[list[float]]) -> list[float]:
    trace = matrix[0][0] + matrix[1][1] + matrix[2][2]
    if trace > 0:
        s = math.sqrt(trace + 1) * 2; qw = 0.25*s; qx=(matrix[2][1]-matrix[1][2])/s; qy=(matrix[0][2]-matrix[2][0])/s; qz=(matrix[1][0]-matrix[0][1])/s
    elif matrix[0][0] > matrix[1][1] and matrix[0][0] > matrix[2][2]:
        s=math.sqrt(1+matrix[0][0]-matrix[1][1]-matrix[2][2])*2; qw=(matrix[2][1]-matrix[1][2])/s; qx=.25*s; qy=(matrix[0][1]+matrix[1][0])/s; qz=(matrix[0][2]+matrix[2][0])/s
    elif matrix[1][1] > matrix[2][2]:
        s=math.sqrt(1+matrix[1][1]-matrix[0][0]-matrix[2][2])*2; qw=(matrix[0][2]-matrix[2][0])/s; qx=(matrix[0][1]+matrix[1][0])/s; qy=.25*s; qz=(matrix[1][2]+matrix[2][1])/s
    else:
        s=math.sqrt(1+matrix[2][2]-matrix[0][0]-matrix[1][1])*2; qw=(matrix[1][0]-matrix[0][1])/s; qx=(matrix[0][2]+matrix[2][0])/s; qy=(matrix[1][2]+matrix[2][1])/s; qz=.25*s
    length=math.sqrt(qx*qx+qy*qy+qz*qz+qw*qw); return [qx/length,qy/length,qz/length,qw/length]


def parse_colmap_query_pose(path: Path, query_name: str) -> dict[str, Any]:
    parts, _point_tokens = find_colmap_query_record(path, query_name)
    qw,qx,qy,qz = map(float, parts[1:5]); tx,ty,tz = map(float, parts[5:8])
    rotation = quaternion_to_rotation(qw,qx,qy,qz)
    rotation_t = [list(row) for row in zip(*rotation)]
    centre = [-sum(rotation_t[row][column]*[tx,ty,tz][column] for column in range(3)) for row in range(3)]
    # COLMAP/OpenCV camera axes -> OpenGL camera axes.
    gl_rotation = [[rotation_t[r][0], -rotation_t[r][1], -rotation_t[r][2]] for r in range(3)]
    return {"rotation": gl_rotation, "position": centre, "cameraId": int(parts[8])}


def parse_colmap_image_poses(path: Path) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    expecting_header = True
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#"):
            continue
        if not expecting_header:
            expecting_header = True
            continue
        if not line:
            continue
        parts = line.split()
        if len(parts) < 10:
            raise RuntimeError("COLMAP images.txt has a malformed image record")
        qw, qx, qy, qz = map(float, parts[1:5])
        translation = [float(value) for value in parts[5:8]]
        world_to_camera = quaternion_to_rotation(qw, qx, qy, qz)
        camera_to_world = [list(row) for row in zip(*world_to_camera)]
        centre = [
            -sum(camera_to_world[row][column] * translation[column] for column in range(3))
            for row in range(3)
        ]
        records[parts[9]] = {
            "imageId": int(parts[0]),
            "cameraId": int(parts[8]),
            "rotation": camera_to_world,
            "position": centre,
        }
        expecting_header = False
    if not expecting_header:
        raise RuntimeError("COLMAP images.txt is missing a POINTS2D row")
    return records


def validate_colmap_reference_gauge(base_path: Path, registered_path: Path, query_name: str) -> dict[str, Any]:
    base = parse_colmap_image_poses(base_path)
    registered = parse_colmap_image_poses(registered_path)
    if not base:
        raise RuntimeError("base COLMAP model has no reference frames")
    missing = sorted(set(base) - set(registered))
    added = sorted(set(registered) - set(base))
    if missing:
        raise RuntimeError(f"photo registration dropped base reference frames: {missing[:3]}")
    if added != [query_name]:
        raise RuntimeError(f"photo registration was not query-only: added={added}")
    max_rotation_delta = 0.0
    max_position_delta = 0.0
    for name, expected in base.items():
        actual = registered[name]
        max_rotation_delta = max(
            max_rotation_delta,
            *(abs(actual["rotation"][row][column] - expected["rotation"][row][column]) for row in range(3) for column in range(3)),
        )
        max_position_delta = max(
            max_position_delta,
            *(abs(actual["position"][axis] - expected["position"][axis]) for axis in range(3)),
        )
    tolerance = 1e-7
    if max_rotation_delta > tolerance or max_position_delta > tolerance:
        raise RuntimeError(
            "photo registration changed the training-map gauge: "
            f"rotationDelta={max_rotation_delta:.3g} positionDelta={max_position_delta:.3g}"
        )
    return {
        "existingFramesFixed": True,
        "onlyQueryAdded": True,
        "referenceFramesCompared": len(base),
        "maxReferenceRotationDelta": max_rotation_delta,
        "maxReferencePositionDelta": max_position_delta,
        "referenceGaugeTolerance": tolerance,
    }


def validate_reference_frame_contract(
    reference_frame_count: int,
    registration_quality: dict[str, Any],
    database_isolation: dict[str, Any],
) -> int:
    """Bind the model, isolated DB, and post-registration gauge cardinality."""
    if reference_frame_count <= 0:
        raise RuntimeError("photo localization has no whitelisted reference frames")
    compared = registration_quality.get("referenceFramesCompared")
    isolated = database_isolation.get("baseReferenceImages")
    if compared != reference_frame_count or isolated != reference_frame_count:
        raise RuntimeError(
            "photo localization reference-frame counts disagree: "
            f"whitelisted={reference_frame_count} compared={compared} isolated={isolated}"
        )
    return reference_frame_count


def colmap_pair_image_ids(pair_id: int) -> tuple[int, int]:
    image_id2 = pair_id % COLMAP_MAX_IMAGE_ID
    image_id1 = (pair_id - image_id2) // COLMAP_MAX_IMAGE_ID
    return image_id1, image_id2


def prune_colmap_database_to_model(database_path: Path, base_records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Reduce a copied COLMAP DB to the selected model's registered images."""
    if not base_records:
        raise RuntimeError("base COLMAP model has no reference frames")
    expected_by_id: dict[int, tuple[str, int]] = {}
    for name, record in base_records.items():
        image_id = int(record["imageId"])
        if image_id in expected_by_id:
            raise RuntimeError(f"base COLMAP model repeats image id {image_id}")
        expected_by_id[image_id] = (name, int(record["cameraId"]))
    allowed_ids = set(expected_by_id)
    placeholders = ",".join("?" for _ in allowed_ids)
    with sqlite3.connect(database_path) as connection:
        table_names = {
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        required = {"cameras", "images", "keypoints", "descriptors", "matches", "two_view_geometries"}
        if not required.issubset(table_names):
            raise RuntimeError(f"COLMAP database schema is incomplete: missing={sorted(required - table_names)}")
        database_rows = {
            int(image_id): (str(name), int(camera_id))
            for image_id, name, camera_id in connection.execute("SELECT image_id, name, camera_id FROM images")
        }
        for image_id, expected in expected_by_id.items():
            actual = database_rows.get(image_id)
            if actual != expected:
                raise RuntimeError(
                    f"COLMAP model/database image mismatch for id {image_id}: expected={expected} actual={actual}"
                )
        removed_image_ids = sorted(set(database_rows) - allowed_ids)
        for table in ("keypoints", "descriptors", "pose_priors"):
            columns = {
                str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")
            } if table in table_names else set()
            if "image_id" in columns:
                connection.execute(
                    f"DELETE FROM {table} WHERE image_id NOT IN ({placeholders})", tuple(sorted(allowed_ids))
                )
        removed_pair_rows = 0
        for table in ("matches", "two_view_geometries"):
            pair_ids = [int(row[0]) for row in connection.execute(f"SELECT pair_id FROM {table}")]
            rejected = [
                pair_id
                for pair_id in pair_ids
                if not set(colmap_pair_image_ids(pair_id)).issubset(allowed_ids)
            ]
            if rejected:
                connection.executemany(f"DELETE FROM {table} WHERE pair_id = ?", ((value,) for value in rejected))
            removed_pair_rows += len(rejected)
        connection.execute(
            f"DELETE FROM images WHERE image_id NOT IN ({placeholders})", tuple(sorted(allowed_ids))
        )
        used_camera_ids = sorted({camera_id for _name, camera_id in expected_by_id.values()})
        camera_placeholders = ",".join("?" for _ in used_camera_ids)
        connection.execute(
            f"DELETE FROM cameras WHERE camera_id NOT IN ({camera_placeholders})", tuple(used_camera_ids)
        )
        remaining_rows = {
            int(image_id): (str(name), int(camera_id))
            for image_id, name, camera_id in connection.execute("SELECT image_id, name, camera_id FROM images")
        }
        if remaining_rows != expected_by_id:
            raise RuntimeError("failed to isolate COLMAP localization database to the base sparse model")
        for table in ("matches", "two_view_geometries"):
            for (pair_id,) in connection.execute(f"SELECT pair_id FROM {table}"):
                if not set(colmap_pair_image_ids(int(pair_id))).issubset(allowed_ids):
                    raise RuntimeError(f"COLMAP database retained an out-of-model {table} pair")
        connection.commit()
    return {
        "sourceDatabaseCopied": True,
        "baseReferenceImages": len(allowed_ids),
        "removedNonModelImages": len(removed_image_ids),
        "removedOutOfModelPairRows": removed_pair_rows,
    }


def validate_colmap_localization_database(
    database_path: Path,
    base_records: dict[str, dict[str, Any]],
    query_name: str,
) -> dict[str, Any]:
    """Prove the copied DB has base references plus exactly one new query."""
    expected_references = {
        name: (int(record["imageId"]), int(record["cameraId"]))
        for name, record in base_records.items()
    }
    with sqlite3.connect(f"file:{database_path}?mode=ro", uri=True) as connection:
        rows = {
            str(name): (int(image_id), int(camera_id))
            for image_id, name, camera_id in connection.execute("SELECT image_id, name, camera_id FROM images")
        }
    for name, expected in expected_references.items():
        if rows.get(name) != expected:
            raise RuntimeError(f"localized database changed base image identity: {name}")
    extras = sorted(set(rows) - set(expected_references))
    if extras != [query_name]:
        raise RuntimeError(f"localized database is not query-only: added={extras}")
    query_image_id = rows[query_name][0]
    if query_image_id in {value[0] for value in expected_references.values()}:
        raise RuntimeError("localized query reused a base image id")
    return {
        "onlyQueryUnregistered": True,
        "queryDatabaseImageId": query_image_id,
        "databaseImageCountAfterQuery": len(rows),
    }


def parse_colmap_camera(path: Path, camera_id: int) -> dict[str, Any]:
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 5 and int(parts[0]) == camera_id:
            return {
                "model": parts[1],
                "width": int(parts[2]),
                "height": int(parts[3]),
                "parameters": [float(value) for value in parts[4:]],
            }
    raise RuntimeError(f"localized camera {camera_id} is missing")


def project_colmap_camera(camera: dict[str, Any], point: list[float]) -> tuple[float, float]:
    x, y, z = point
    if z <= 0 or not all(math.isfinite(value) for value in point):
        raise RuntimeError("registered query observation is behind its camera")
    normalized_x, normalized_y = x / z, y / z
    model = camera["model"]
    parameters = camera["parameters"]
    if model == "SIMPLE_PINHOLE":
        focal, cx, cy = parameters
        return focal * normalized_x + cx, focal * normalized_y + cy
    if model == "PINHOLE":
        focal_x, focal_y, cx, cy = parameters
        return focal_x * normalized_x + cx, focal_y * normalized_y + cy
    if model in {"SIMPLE_RADIAL", "RADIAL"}:
        focal, cx, cy, *radial = parameters
        radius_squared = normalized_x * normalized_x + normalized_y * normalized_y
        distortion = 1.0
        power = radius_squared
        for coefficient in radial:
            distortion += coefficient * power
            power *= radius_squared
        return focal * distortion * normalized_x + cx, focal * distortion * normalized_y + cy
    if model in {"OPENCV", "FULL_OPENCV"}:
        focal_x, focal_y, cx, cy, k1, k2, p1, p2, *remaining = parameters
        radius_squared = normalized_x * normalized_x + normalized_y * normalized_y
        radius_fourth = radius_squared * radius_squared
        radius_sixth = radius_fourth * radius_squared
        numerator = 1.0 + k1 * radius_squared + k2 * radius_fourth
        denominator = 1.0
        if model == "FULL_OPENCV":
            if len(remaining) != 4:
                raise RuntimeError("FULL_OPENCV camera has malformed parameters")
            k3, k4, k5, k6 = remaining
            numerator += k3 * radius_sixth
            denominator += k4 * radius_squared + k5 * radius_fourth + k6 * radius_sixth
        elif remaining:
            raise RuntimeError("OPENCV camera has malformed parameters")
        radial = numerator / denominator
        distorted_x = normalized_x * radial + 2.0 * p1 * normalized_x * normalized_y + p2 * (radius_squared + 2.0 * normalized_x * normalized_x)
        distorted_y = normalized_y * radial + p1 * (radius_squared + 2.0 * normalized_y * normalized_y) + 2.0 * p2 * normalized_x * normalized_y
        return focal_x * distorted_x + cx, focal_y * distorted_y + cy
    raise RuntimeError(f"unsupported localized camera model for quality gate: {model}")


def parse_colmap_registration_quality(
    images_path: Path,
    cameras_path: Path,
    points3d_path: Path,
    query_name: str,
) -> dict[str, Any]:
    header, point_tokens = find_colmap_query_record(images_path, query_name)
    camera_id = int(header[8])
    camera = parse_colmap_camera(cameras_path, camera_id)
    qw, qx, qy, qz = map(float, header[1:5])
    translation = [float(value) for value in header[5:8]]
    world_to_camera = quaternion_to_rotation(qw, qx, qy, qz)
    points3d: dict[int, list[float]] = {}
    for line in points3d_path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 4:
            raise RuntimeError("localized model has malformed POINTS3D data")
        points3d[int(parts[0])] = [float(value) for value in parts[1:4]]

    errors: list[float] = []
    for offset in range(0, len(point_tokens), 3):
        observed_x, observed_y = float(point_tokens[offset]), float(point_tokens[offset + 1])
        point_id = int(point_tokens[offset + 2])
        if point_id < 0:
            continue
        if point_id not in points3d:
            raise RuntimeError(f"query observation references missing point3D {point_id}")
        world = points3d[point_id]
        camera_point = [
            sum(world_to_camera[row][column] * world[column] for column in range(3)) + translation[row]
            for row in range(3)
        ]
        projected_x, projected_y = project_colmap_camera(camera, camera_point)
        errors.append(math.hypot(projected_x - observed_x, projected_y - observed_y))

    if not point_tokens or not errors:
        raise RuntimeError("localized query has no verifiable 2D-3D observations")
    ordered_errors = sorted(errors)
    middle = len(ordered_errors) // 2
    median_error = (
        ordered_errors[middle]
        if len(ordered_errors) % 2
        else (ordered_errors[middle - 1] + ordered_errors[middle]) / 2.0
    )
    query_keypoints = len(point_tokens) // 3
    inlier_ratio = len(errors) / query_keypoints
    gate_passed = (
        len(errors) >= PHOTO_MIN_GEOMETRIC_INLIERS
        and inlier_ratio >= PHOTO_MIN_GEOMETRIC_INLIER_RATIO
        and median_error <= PHOTO_MAX_MEDIAN_REPROJECTION_PX
    )
    return {
        "geometricInliers": len(errors),
        "geometricInlierRatio": inlier_ratio,
        "medianReprojectionPx": median_error,
        "maxReprojectionPx": max(errors),
        "queryKeypoints": query_keypoints,
        "inlierRatioDefinition": "registered-3d-observations/query-keypoints",
        "thresholds": {
            "minGeometricInliers": PHOTO_MIN_GEOMETRIC_INLIERS,
            "minGeometricInlierRatio": PHOTO_MIN_GEOMETRIC_INLIER_RATIO,
            "maxMedianReprojectionPx": PHOTO_MAX_MEDIAN_REPROJECTION_PX,
        },
        "gatePassed": gate_passed,
        "existingFramesFixed": True,
        "registrationImageList": [query_name],
    }


def parse_colmap_camera_fov(path: Path, camera_id: int) -> float:
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"): continue
        parts = line.split()
        if len(parts) < 5 or int(parts[0]) != camera_id: continue
        model, width, height = parts[1], float(parts[2]), float(parts[3])
        parameters = [float(value) for value in parts[4:]]
        if model in {"SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL"}: focal_y = parameters[0]
        elif model in {"PINHOLE", "OPENCV", "FULL_OPENCV"}: focal_y = parameters[1]
        else: raise RuntimeError(f"unsupported localized camera model: {model}")
        value = math.degrees(2.0 * math.atan(height / (2.0 * focal_y)))
        if not 10.0 <= value <= 150.0: raise RuntimeError(f"implausible localized camera FOV: {value}")
        return value
    raise RuntimeError(f"localized camera {camera_id} is missing")


def camera_vertical_fov(root: dict[str, Any], frame: dict[str, Any]) -> float:
    source = dict(root)
    source.update(frame)
    try:
        focal_value = source.get("fl_y")
        if focal_value is None:
            focal_value = source["fl_x"]
        focal_y = float(focal_value)
        height = float(source["h"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError("transforms.json camera intrinsics are incomplete") from exc
    value = math.degrees(2.0 * math.atan(height / (2.0 * focal_y)))
    if not 10.0 <= value <= 150.0:
        raise RuntimeError(f"implausible training camera FOV: {value}")
    return value


def find_dataparser_transform(scene_root: Path) -> dict[str, Any]:
    candidates = list((scene_root / "training").rglob("dataparser_transforms.json"))
    if not candidates:
        raise RuntimeError("training dataparser_transforms.json is missing; refusing an unnormalized Viewer pose")
    return json.loads(sorted(candidates)[-1].read_text(encoding="utf-8"))


def affine4(rows: list[list[float]] | tuple[tuple[float, ...], ...]) -> list[list[float]]:
    if len(rows) not in {3, 4} or any(len(row) != 4 for row in rows):
        raise RuntimeError("affine transform must be 3x4 or 4x4")
    output = [[float(value) for value in row] for row in rows]
    if len(output) == 3:
        output.append([0.0, 0.0, 0.0, 1.0])
    return output


def matrix4_multiply(left: list[list[float]], right: list[list[float]]) -> list[list[float]]:
    return [
        [sum(left[row][inner] * right[inner][column] for inner in range(4)) for column in range(4)]
        for row in range(4)
    ]


def inverse_rigid_transform(matrix: list[list[float]]) -> list[list[float]]:
    rotation_t = [[matrix[column][row] for column in range(3)] for row in range(3)]
    translation = [matrix[row][3] for row in range(3)]
    output = [[0.0] * 4 for _ in range(4)]
    for row in range(3):
        for column in range(3):
            output[row][column] = rotation_t[row][column]
        output[row][3] = -sum(rotation_t[row][column] * translation[column] for column in range(3))
    output[3][3] = 1.0
    return output


def pose_matrix(pose: dict[str, Any]) -> list[list[float]]:
    matrix = [[0.0] * 4 for _ in range(4)]
    for row in range(3):
        for column in range(3):
            matrix[row][column] = float(pose["rotation"][row][column])
        matrix[row][3] = float(pose["position"][row])
    matrix[3][3] = 1.0
    return matrix


def _transform_pose_to_viewer(
    pose: dict[str, Any],
    parser: dict[str, Any],
    saved_applied_transform: list[list[float]] | None = None,
) -> dict[str, Any]:
    """Map original/saved COLMAP OpenGL pose into the proven Viewer frame.

    Query poses from the selected COLMAP model are in original coordinates and
    use parser.transform directly.  transforms.json frames have already had
    applied_transform applied, so that component must be removed first.  Both
    paths then receive Nerfstudio's translation scale and the accepted
    Nerfstudio-Z-up to PlayCanvas-Y-up rotation.
    """
    combined = affine4(parser["transform"])
    if saved_applied_transform is not None:
        combined = matrix4_multiply(combined, inverse_rigid_transform(affine4(saved_applied_transform)))
    normalized = matrix4_multiply(combined, pose_matrix(pose))
    scale = float(parser.get("scale", 1.0))
    for row in range(3):
        normalized[row][3] *= scale
    viewer = matrix4_multiply(affine4(PLAYCANVAS_FROM_NERFSTUDIO), normalized)
    rotation = [[viewer[row][column] for column in range(3)] for row in range(3)]
    return {
        "position": [viewer[row][3] for row in range(3)],
        "quaternion": rotation_to_quaternion(rotation),
        "fovDegrees": 70.0,
    }


def original_pose_to_viewer(pose: dict[str, Any], parser: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw selected-model COLMAP/OpenGL query pose."""
    return _transform_pose_to_viewer(pose, parser)


def saved_pose_to_viewer(
    pose: dict[str, Any], parser: dict[str, Any], applied_transform: list[list[float]] | None
) -> dict[str, Any]:
    """Convert a transforms.json pose that is already in saved coordinates."""
    if applied_transform is None:
        raise RuntimeError("transforms.json applied_transform is missing; saved pose space is ambiguous")
    return _transform_pose_to_viewer(pose, parser, applied_transform)


def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--job-spec", required=True, type=Path); parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(); spec = json.loads(args.job_spec.read_text(encoding="utf-8")); runner = Runner(spec, dry_run=args.dry_run)
    result = runner.execute()
    if args.dry_run: print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__": raise SystemExit(main())
