#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import unittest

import cv2
import numpy as np


LINUX = Path(__file__).resolve().parents[1] / "scripts" / "linux"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


LOCATOR = load("v14_aliked_lightglue_locator", LINUX / "localize_v14_aliked_lightglue.py")


class AlikedLightGlueCandidateTests(unittest.TestCase):
    def test_nearest_track_association_obeys_radius(self) -> None:
        learned = np.asarray([[10.0, 10.0], [22.0, 19.0], [80.0, 80.0]], dtype=np.float32)
        tracks = np.asarray([[10.5, 9.5], [20.0, 20.0], [40.0, 40.0]], dtype=np.float32)
        indices, distances = LOCATOR.nearest_track_associations(learned, tracks, 3.0)
        np.testing.assert_array_equal(indices, np.asarray([0, 1, -1]))
        self.assertTrue(np.isfinite(distances[:2]).all())
        self.assertTrue(np.isinf(distances[2]))

    def test_balanced_retrieval_keeps_each_view(self) -> None:
        query = np.zeros(144, dtype=np.float32)
        query[0] = 1.0
        references = []
        for view_index, view in enumerate(("front", "right", "back")):
            for item in range(40):
                descriptor = np.zeros(144, dtype=np.float32)
                descriptor[0] = 1.0 - 0.01 * view_index - 0.0001 * item
                references.append({
                    "referenceId": len(references),
                    "virtualView": view,
                    "globalDescriptor": descriptor.tolist(),
                })
        selected = LOCATOR.retrieve_balanced(references, query)
        views = {references[index]["virtualView"] for index in selected}
        self.assertEqual(views, {"front", "right", "back"})

    def test_dependency_paths_default_to_same_work_tree(self) -> None:
        old_values = {name: os.environ.pop(name, None) for name in (
            "V14_LIGHTGLUE_ROOT", "V14_KORNIA_ROOT", "TORCH_HOME"
        )}
        try:
            index_dir = Path("/home/max/src/worker/work/v14-photo-return-goal/index/aliked-lightglue-v1")
            lightglue, kornia, torch_home = LOCATOR.dependency_paths(index_dir)
            work = Path("/home/max/src/worker/work/v14-photo-return-goal").resolve()
            self.assertEqual(lightglue, work / "deps/LightGlue-eb42fee")
            self.assertEqual(kornia, work / "deps/kornia-v0.6.12")
            self.assertEqual(torch_home, work / "deps/torch-cache")
        finally:
            for name, value in old_values.items():
                if value is not None:
                    os.environ[name] = value

    def test_synthetic_pnp_recovers_pose(self) -> None:
        matrix = np.asarray([[700.0, 0.0, 320.0], [0.0, 700.0, 240.0], [0.0, 0.0, 1.0]])
        rng = np.random.default_rng(91)
        points = np.column_stack([
            rng.uniform(-2.0, 2.0, 150),
            rng.uniform(-1.4, 1.4, 150),
            rng.uniform(4.0, 11.0, 150),
        ]).astype(np.float32)
        rvec = np.asarray([0.03, -0.05, 0.02], dtype=np.float64)
        tvec = np.asarray([0.18, -0.10, 0.06], dtype=np.float64)
        pixels, _ = cv2.projectPoints(points, rvec, tvec, matrix, None)
        pixels = pixels.reshape(-1, 2).astype(np.float32)
        pixels += rng.normal(0.0, 0.12, pixels.shape).astype(np.float32)
        rows = [(index, index, float(index) / 1000.0, 0) for index in range(len(points))]
        result = LOCATOR.solve_pose(rows, pixels, points, matrix, 640, 480)
        self.assertIsNotNone(result)
        assert result is not None
        self.assertGreaterEqual(result["geometricInliers"], 80)
        self.assertLess(result["medianReprojectionPx"], 0.5)
        expected_rotation, _ = cv2.Rodrigues(rvec)
        expected = np.eye(4)
        expected[:3, :3] = expected_rotation.T
        expected[:3, 3] = -expected_rotation.T @ tvec
        expected = expected @ LOCATOR.CV_TO_GL
        np.testing.assert_allclose(result["estimatedC2wOpenGL"], expected, atol=3e-3)


if __name__ == "__main__":
    unittest.main()
