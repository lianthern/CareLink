#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import unittest

import cv2
import numpy as np


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "linux" / "localize_v11_photos.py"
SPEC = importlib.util.spec_from_file_location("v12_localizer", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def frame(path: str, panorama: str, face: str) -> dict:
    return {
        "file_path": path,
        "source_panorama": panorama,
        "virtual_view": face,
        "transform_matrix": np.eye(4).tolist(),
    }


class ContractTests(unittest.TestCase):
    def test_frozen_query_selection_is_disjoint_and_deterministic(self) -> None:
        faces = (
            "front", "front_right", "right", "back_right",
            "back", "back_left", "left", "front_left", "up",
        )
        val = [
            frame(f"images/val_{panorama:02d}__{face_name}.jpg", f"v{panorama:02d}.jpg", face_name)
            for panorama in range(10)
            for face_name in faces
        ]
        selected = MODULE.select_queries(val)
        self.assertEqual(
            [(row["source_panorama"], row["virtual_view"]) for row in selected],
            [("v01.jpg", "front"), ("v05.jpg", "right"), ("v08.jpg", "left")],
        )

    def test_split_overlap_is_rejected(self) -> None:
        names = [f"images/train_{index:03d}.jpg" for index in range(450)]
        val = [f"images/val_{index:03d}.jpg" for index in range(90)]
        val[0] = names[0]
        all_names = list(dict.fromkeys(names + val))
        transforms = {
            "frames": [frame(name, f"p{index}.jpg", "front") for index, name in enumerate(all_names)],
            "train_filenames": names,
            "val_filenames": val,
        }
        with self.assertRaisesRegex(ValueError, "query leakage"):
            MODULE.validate_and_index(transforms)

    def test_synthetic_pnp_recovers_pose(self) -> None:
        rng = np.random.default_rng(12)
        intrinsics = np.array([[700.0, 0.0, 512.0], [0.0, 700.0, 512.0], [0.0, 0.0, 1.0]])
        object_points = rng.uniform([-2.0, -1.5, 4.0], [2.0, 1.5, 9.0], size=(120, 3)).astype(np.float32)
        expected_rvec = np.array([0.08, -0.12, 0.04], dtype=np.float64)
        expected_tvec = np.array([0.35, -0.15, 0.5], dtype=np.float64)
        projected, _ = cv2.projectPoints(object_points, expected_rvec, expected_tvec, intrinsics, None)
        image_points = projected.reshape(-1, 2)
        image_points += rng.normal(0.0, 0.25, size=image_points.shape)
        image_points[:10] = rng.uniform([0.0, 0.0], [1024.0, 1024.0], size=(10, 2))
        result = MODULE.solve_pnp_correspondences(object_points, image_points.astype(np.float32), intrinsics)
        self.assertIsNotNone(result)
        estimated_rvec, estimated_tvec, inliers, errors = result
        expected_rotation, _ = cv2.Rodrigues(expected_rvec)
        estimated_rotation, _ = cv2.Rodrigues(estimated_rvec)
        self.assertGreaterEqual(len(inliers), 100)
        self.assertLess(float(np.median(errors)), 1.0)
        self.assertLess(MODULE.rotation_error_degrees(estimated_rotation, expected_rotation), 0.2)
        self.assertLess(float(np.linalg.norm(estimated_tvec.reshape(3) - expected_tvec)), 0.03)

    def test_rotation_error(self) -> None:
        angle = math.radians(10.0)
        rotated = np.array([
            [math.cos(angle), 0.0, math.sin(angle)],
            [0.0, 1.0, 0.0],
            [-math.sin(angle), 0.0, math.cos(angle)],
        ])
        self.assertAlmostEqual(MODULE.rotation_error_degrees(np.eye(3), rotated), 10.0, places=7)


if __name__ == "__main__":
    unittest.main()
