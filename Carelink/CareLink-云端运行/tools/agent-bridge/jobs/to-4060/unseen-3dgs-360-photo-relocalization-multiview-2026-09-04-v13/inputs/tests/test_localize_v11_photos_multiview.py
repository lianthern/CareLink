#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import math
from pathlib import Path
from types import SimpleNamespace
import unittest

import cv2
import numpy as np


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "linux" / "localize_v11_photos_multiview.py"
SPEC = importlib.util.spec_from_file_location("v13_localizer", SCRIPT)
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
    def test_root_sift_is_normalized_and_nonnegative(self) -> None:
        raw = np.array([[0.0, 1.0, 3.0], [4.0, 0.0, 5.0]], dtype=np.float32)
        rooted = MODULE.root_sift(raw)
        self.assertIsNotNone(rooted)
        self.assertTrue(np.all(rooted >= 0.0))
        np.testing.assert_allclose(np.sum(np.square(rooted), axis=1), np.ones(2), atol=1e-6)

    def test_ratio_runner_up_must_be_a_different_landmark(self) -> None:
        landmarks = np.array([7, 7, 9], dtype=np.int32)
        neighbours = [
            SimpleNamespace(trainIdx=0, distance=0.10),
            SimpleNamespace(trainIdx=1, distance=0.11),
            SimpleNamespace(trainIdx=2, distance=0.30),
        ]
        selected = MODULE.choose_distinct_landmark_match(neighbours, landmarks, 0.82)
        self.assertEqual(selected, (7, 0.10, 0.30))

    def test_ratio_rejects_ambiguous_different_landmarks(self) -> None:
        landmarks = np.array([7, 7, 9], dtype=np.int32)
        neighbours = [
            SimpleNamespace(trainIdx=0, distance=0.10),
            SimpleNamespace(trainIdx=1, distance=0.11),
            SimpleNamespace(trainIdx=2, distance=0.12),
        ]
        self.assertIsNone(MODULE.choose_distinct_landmark_match(neighbours, landmarks, 0.82))

    def test_queries_and_acceptance_thresholds_are_identical_to_v12(self) -> None:
        faces = (
            "front", "front_right", "right", "back_right",
            "back", "back_left", "left", "front_left", "up",
        )
        val = [
            frame(f"images/val_{panorama:02d}__{face_name}.jpg", f"v{panorama:02d}.jpg", face_name)
            for panorama in range(10)
            for face_name in faces
        ]
        selected = MODULE.V12.select_queries(val)
        self.assertEqual(
            [(row["source_panorama"], row["virtual_view"]) for row in selected],
            [("v01.jpg", "front"), ("v05.jpg", "right"), ("v08.jpg", "left")],
        )
        self.assertEqual(MODULE.V12.MIN_PNP_INLIERS, 20)
        self.assertEqual(MODULE.V12.MIN_PNP_INLIER_RATIO, 0.10)
        self.assertEqual(MODULE.V12.MAX_MEDIAN_REPROJECTION_PX, 3.5)
        self.assertEqual(MODULE.V12.MAX_TRANSLATION_ERROR_SCENE_FRACTION, 0.15)
        self.assertEqual(MODULE.V12.MAX_ROTATION_ERROR_DEGREES, 15.0)

    def test_synthetic_pnp_recovers_pose_with_outliers(self) -> None:
        rng = np.random.default_rng(13)
        intrinsics = np.array([[700.0, 0.0, 512.0], [0.0, 700.0, 512.0], [0.0, 0.0, 1.0]])
        object_points = rng.uniform([-2.0, -1.5, 4.0], [2.0, 1.5, 9.0], size=(120, 3)).astype(np.float32)
        expected_rvec = np.array([0.08, -0.12, 0.04], dtype=np.float64)
        expected_tvec = np.array([0.35, -0.15, 0.5], dtype=np.float64)
        projected, _ = cv2.projectPoints(object_points, expected_rvec, expected_tvec, intrinsics, None)
        image_points = projected.reshape(-1, 2)
        image_points += rng.normal(0.0, 0.25, size=image_points.shape)
        image_points[:10] = rng.uniform([0.0, 0.0], [1024.0, 1024.0], size=(10, 2))
        result = MODULE.V12.solve_pnp_correspondences(
            object_points, image_points.astype(np.float32), intrinsics
        )
        self.assertIsNotNone(result)
        estimated_rvec, estimated_tvec, inliers, errors = result
        expected_rotation, _ = cv2.Rodrigues(expected_rvec)
        estimated_rotation, _ = cv2.Rodrigues(estimated_rvec)
        self.assertGreaterEqual(len(inliers), 100)
        self.assertLess(float(np.median(errors)), 1.0)
        self.assertLess(MODULE.V12.rotation_error_degrees(estimated_rotation, expected_rotation), 0.2)
        self.assertLess(float(np.linalg.norm(estimated_tvec.reshape(3) - expected_tvec)), 0.03)


if __name__ == "__main__":
    unittest.main()
