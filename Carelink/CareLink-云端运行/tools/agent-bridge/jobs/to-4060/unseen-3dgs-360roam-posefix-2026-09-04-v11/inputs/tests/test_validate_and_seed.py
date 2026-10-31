#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import cv2
import numpy as np


SCRIPT_ROOT = Path(__file__).parents[1] / "scripts/linux"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PREPARE = load_module("prepare_v11", SCRIPT_ROOT / "prepare_360roam_base.py")
SEED = load_module("seed_v11", SCRIPT_ROOT / "validate_and_seed.py")


class PoseImageGateMathTests(unittest.TestCase):
    def test_known_pose_epipolar_and_triangulation(self) -> None:
        source1 = [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
        source2 = [row[:] for row in source1]
        source2[0][3] = 0.25
        frame1 = {"transform_matrix": PREPARE.virtual_face_c2w_opengl(source1, 0.0, 0.0)}
        frame2 = {"transform_matrix": PREPARE.virtual_face_c2w_opengl(source2, 0.0, 0.0)}
        intrinsics = np.array([[500.0, 0.0, 256.0], [0.0, 500.0, 256.0], [0.0, 0.0, 1.0]])
        world_point = np.array([0.4, -0.15, 3.0, 1.0])
        projection1, _, _ = SEED.projection(frame1, intrinsics)
        projection2, _, _ = SEED.projection(frame2, intrinsics)
        pixel1_h = projection1 @ world_point
        pixel2_h = projection2 @ world_point
        pixel1 = (pixel1_h[:2] / pixel1_h[2]).reshape(1, 2)
        pixel2 = (pixel2_h[:2] / pixel2_h[2]).reshape(1, 2)
        fmatrix = SEED.fundamental(frame1, frame2, intrinsics)
        error = SEED.sampson_distance(fmatrix, pixel1, pixel2)
        self.assertLess(float(error[0]), 1e-8)
        homogeneous = cv2.triangulatePoints(projection1, projection2, pixel1.T, pixel2.T)
        reconstructed = homogeneous[:3, 0] / homogeneous[3, 0]
        np.testing.assert_allclose(reconstructed, world_point[:3], atol=1e-6)


if __name__ == "__main__":
    unittest.main()
