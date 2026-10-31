#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest

import numpy as np


LINUX = Path(__file__).resolve().parents[1] / "scripts" / "linux"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


PREPARE = load("v14_prepare", LINUX / "prepare_fixed_query_challenge.py")
GATE = load("v14_gate", LINUX / "run_v14_final_gate.py")


class FinalGateTests(unittest.TestCase):
    def test_five_variants_are_photometric_only(self) -> None:
        image = np.arange(48 * 64 * 3, dtype=np.uint8).reshape(48, 64, 3)
        variants = PREPARE.challenge_variants(image)
        self.assertEqual([row[0] for row in variants], GATE.EXPECTED_RUN_IDS)
        self.assertEqual(len(variants), 5)
        for _, _, variant, quality in variants:
            self.assertEqual(variant.shape, image.shape)
            self.assertGreaterEqual(quality, 90)

    def test_exact_pose_passes_independent_score(self) -> None:
        expected = np.eye(4, dtype=np.float64)
        expected[:3, 3] = [1.0, 2.0, 3.0]
        score = GATE.score_pose(expected.copy(), expected, scene_extent=10.0)
        self.assertAlmostEqual(score["translationErrorSceneFraction"], 0.0)
        self.assertAlmostEqual(score["rotationErrorDegrees"], 0.0)

    def test_wrong_pose_fails_existing_position_gate(self) -> None:
        expected = np.eye(4, dtype=np.float64)
        estimated = np.eye(4, dtype=np.float64)
        estimated[0, 3] = 2.0
        score = GATE.score_pose(estimated, expected, scene_extent=10.0)
        self.assertGreater(score["translationErrorSceneFraction"], 0.15)

    def test_candidate_report_requires_truth_and_cache_attestations(self) -> None:
        estimate = {
            "schemaVersion": "1.0",
            "runId": "final-01",
            "querySha256": "a" * 64,
            "groundTruthRead": False,
            "hardcodedPoseUsed": False,
            "cachedQueryPoseUsed": False,
            "geometricInliers": 25,
            "geometricInlierRatio": 0.2,
            "medianReprojectionPx": 1.0,
            "estimatedC2wOpenGL": np.eye(4).tolist(),
        }
        pose = GATE.validate_estimate(estimate, "final-01", "a" * 64)
        np.testing.assert_allclose(pose, np.eye(4))
        estimate["groundTruthRead"] = True
        with self.assertRaisesRegex(ValueError, "truth-free"):
            GATE.validate_estimate(estimate, "final-01", "a" * 64)

    def test_index_tree_hash_detects_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "index.bin"
            path.write_bytes(b"first")
            before = GATE.tree_sha256(root)
            path.write_bytes(b"second")
            self.assertNotEqual(before, GATE.tree_sha256(root))


if __name__ == "__main__":
    unittest.main()
