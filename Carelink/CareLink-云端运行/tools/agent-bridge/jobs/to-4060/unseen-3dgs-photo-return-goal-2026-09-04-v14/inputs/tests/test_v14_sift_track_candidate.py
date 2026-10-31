#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
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


BUILDER = load("v14_sift_track_builder", LINUX / "build_v14_sift_track_index.py")
LOCATOR = load("v14_sift_track_locator", LINUX / "localize_v14_sift_track.py")
RETRIEVAL = load("v14_verified_retrieval", LINUX / "localize_v14_verified_retrieval.py")


class SiftTrackCandidateTests(unittest.TestCase):
    def test_root_sift_is_finite_and_unit_l2(self) -> None:
        descriptors = np.asarray([[0.0] * 127 + [4.0], list(range(128))], dtype=np.float32)
        rooted = BUILDER.root_sift(descriptors)
        self.assertTrue(np.isfinite(rooted).all())
        np.testing.assert_allclose(np.linalg.norm(rooted, axis=1), np.ones(2), atol=1e-6)

    def test_global_retrieval_descriptor_is_stable_under_gamma(self) -> None:
        rng = np.random.default_rng(3)
        image = rng.integers(0, 256, (240, 320), dtype=np.uint8)
        table = np.asarray([round(((value / 255.0) ** 1.1) * 255.0) for value in range(256)], dtype=np.uint8)
        changed = cv2.LUT(image, table)
        first = LOCATOR.global_descriptor(image)
        second = LOCATOR.global_descriptor(changed)
        self.assertGreater(float(first @ second), 0.98)

    def test_known_pose_epipolar_filter_accepts_consistent_points(self) -> None:
        matrix = np.asarray([[500.0, 0.0, 320.0], [0.0, 500.0, 240.0], [0.0, 0.0, 1.0]])
        c2w_a_cv = np.eye(4)
        c2w_b_cv = np.eye(4)
        c2w_b_cv[0, 3] = 0.7
        frame_a = {"transformMatrixOpenGL": (c2w_a_cv @ BUILDER.CV_TO_GL).tolist()}
        frame_b = {"transformMatrixOpenGL": (c2w_b_cv @ BUILDER.CV_TO_GL).tolist()}
        rng = np.random.default_rng(7)
        world = np.column_stack([
            rng.uniform(-1.0, 1.0, 40),
            rng.uniform(-0.7, 0.7, 40),
            rng.uniform(4.0, 8.0, 40),
        ])

        def project(c2w_cv: np.ndarray) -> np.ndarray:
            rotation = c2w_cv[:3, :3].T
            translation = -rotation @ c2w_cv[:3, 3]
            camera = (rotation @ world.T + translation[:, None]).T
            return np.column_stack([
                matrix[0, 0] * camera[:, 0] / camera[:, 2] + matrix[0, 2],
                matrix[1, 1] * camera[:, 1] / camera[:, 2] + matrix[1, 2],
            ])

        points_a = project(c2w_a_cv)
        points_b = project(c2w_b_cv)
        fundamental = BUILDER.fundamental_from_poses(frame_a, frame_b, matrix)
        consistent = BUILDER.sampson_errors(fundamental, points_a, points_b)
        self.assertLess(float(np.max(consistent)), 1e-8)
        recovered, valid, reprojection_sum = BUILDER.triangulate_pair(
            frame_a, frame_b, points_a.astype(np.float32), points_b.astype(np.float32), matrix
        )
        self.assertTrue(valid.all())
        self.assertLess(float(np.max(reprojection_sum)), 1e-3)
        np.testing.assert_allclose(recovered, world, atol=2e-5)
        points_b[0, 1] += 30.0
        inconsistent = BUILDER.sampson_errors(fundamental, points_a, points_b)
        self.assertGreater(float(inconsistent[0]), BUILDER.MAX_SAMPSON_ERROR_PX2)

    def test_spatial_quota_deduplicates_query_and_point(self) -> None:
        query = np.asarray([[10.0, 10.0], [11.0, 11.0], [90.0, 90.0]], dtype=np.float32)
        points = np.asarray([[1.0, 2.0, 3.0], [1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float32)
        rows = [(0, 0, 0.1, 1), (0, 2, 0.2, 1), (1, 1, 0.3, 1), (2, 2, 0.4, 1)]
        selected = LOCATOR.spatial_quota(rows, query, points, 100, 100)
        self.assertEqual([(row[0], row[1]) for row in selected], [(0, 0), (2, 2)])

    def test_synthetic_pnp_recovers_pose(self) -> None:
        matrix = np.asarray([[700.0, 0.0, 320.0], [0.0, 700.0, 240.0], [0.0, 0.0, 1.0]])
        rng = np.random.default_rng(19)
        points = np.column_stack([
            rng.uniform(-2.2, 2.2, 120),
            rng.uniform(-1.5, 1.5, 120),
            rng.uniform(4.0, 12.0, 120),
        ]).astype(np.float32)
        rvec = np.asarray([0.025, -0.04, 0.015], dtype=np.float64)
        tvec = np.asarray([0.20, -0.12, 0.08], dtype=np.float64)
        pixels, _ = cv2.projectPoints(points, rvec, tvec, matrix, None)
        pixels = pixels.reshape(-1, 2).astype(np.float32)
        pixels += rng.normal(0.0, 0.15, pixels.shape).astype(np.float32)
        rows = [(index, index, float(index) / 1000.0, 0) for index in range(len(points))]
        result = LOCATOR.solve_pose(rows, pixels, points, matrix, 640, 480)
        self.assertIsNotNone(result)
        assert result is not None
        self.assertGreaterEqual(result["geometricInliers"], 60)
        self.assertLess(result["medianReprojectionPx"], 0.5)
        expected_rotation, _ = cv2.Rodrigues(rvec)
        expected_c2w = np.eye(4)
        expected_c2w[:3, :3] = expected_rotation.T
        expected_c2w[:3, 3] = -expected_rotation.T @ tvec
        expected_c2w = expected_c2w @ LOCATOR.CV_TO_GL
        np.testing.assert_allclose(result["estimatedC2wOpenGL"], expected_c2w, atol=3e-3)

    def test_retrieval_reports_reprojection_for_returned_pose(self) -> None:
        matrix = np.asarray([[500.0, 0.0, 160.0], [0.0, 500.0, 120.0], [0.0, 0.0, 1.0]])
        rng = np.random.default_rng(29)
        points = np.column_stack([
            rng.uniform(-1.0, 1.0, 80),
            rng.uniform(-0.8, 0.8, 80),
            rng.uniform(4.0, 9.0, 80),
        ])
        query = np.column_stack([
            matrix[0, 0] * points[:, 0] / points[:, 2] + matrix[0, 2],
            matrix[1, 1] * points[:, 1] / points[:, 2] + matrix[1, 2],
        ])
        correct_pose = RETRIEVAL.CV_TO_GL.copy()
        correct = RETRIEVAL.fixed_pose_reprojection(
            correct_pose, points, query, matrix, list(range(len(points)))
        )
        self.assertIsNotNone(correct)
        assert correct is not None
        self.assertEqual(correct["geometricInliers"], len(points))
        self.assertLess(correct["medianReprojectionPx"], 1e-6)
        wrong_pose = correct_pose.copy()
        wrong_pose[0, 3] = 3.0
        wrong = RETRIEVAL.fixed_pose_reprojection(
            wrong_pose, points, query, matrix, list(range(len(points)))
        )
        self.assertIsNone(wrong)

    def test_candidate_cli_reads_only_challenge_query_and_index(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            challenge_root = root / "challenge"
            query_dir = challenge_root / "queries"
            index_dir = root / "index"
            query_dir.mkdir(parents=True)
            index_dir.mkdir()
            rng = np.random.default_rng(23)
            image = rng.integers(0, 256, (240, 320), dtype=np.uint8)
            query_path = query_dir / "final-01.jpg"
            self.assertTrue(cv2.imwrite(str(query_path), image, [cv2.IMWRITE_JPEG_QUALITY, 96]))
            decoded = cv2.imread(str(query_path), cv2.IMREAD_GRAYSCALE)
            sift = cv2.SIFT_create(
                nfeatures=LOCATOR.QUERY_FEATURES,
                contrastThreshold=0.004,
                edgeThreshold=24,
            )
            keypoints, descriptors = sift.detectAndCompute(decoded, None)
            pixels = np.asarray([keypoint.pt for keypoint in keypoints], dtype=np.float32)
            descriptors = LOCATOR.root_sift(descriptors)
            self.assertGreater(len(pixels), 100)
            focal = 280.0
            depths = rng.uniform(4.0, 10.0, len(pixels)).astype(np.float32)
            points = np.column_stack([
                (pixels[:, 0] - 160.0) * depths / focal,
                (pixels[:, 1] - 120.0) * depths / focal,
                depths,
            ]).astype(np.float32)
            query_sha = hashlib.sha256(query_path.read_bytes()).hexdigest()
            challenge = {
                "schemaVersion": "1.0",
                "challengeId": LOCATOR.CHALLENGE_ID,
                "queryGroundTruthIncluded": False,
                "intrinsics": {"w": 320, "h": 240, "flX": focal, "flY": focal, "cx": 160.0, "cy": 120.0},
                "queryVariants": [{"runId": "final-01", "path": "queries/final-01.jpg", "sha256": query_sha}],
            }
            challenge_path = challenge_root / "challenge.json"
            challenge_path.write_text(json.dumps(challenge), encoding="utf-8")
            arrays = {
                "points3d.npy": points,
                "descriptors.npy": descriptors,
                "reference-ids.npy": np.zeros(len(points), dtype=np.int32),
                "reference-keypoints.npy": pixels,
                "quality.npy": np.zeros(len(points), dtype=np.float32),
            }
            files = {}
            for name, values in arrays.items():
                path = index_dir / name
                np.save(path, values, allow_pickle=False)
                files[name] = {
                    "bytes": path.stat().st_size,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            index = {
                "schemaVersion": "1.0",
                "challengeId": LOCATOR.CHALLENGE_ID,
                "challengeManifestSha256": hashlib.sha256(challenge_path.read_bytes()).hexdigest(),
                "queryImagesOpened": 0,
                "queryGroundTruthRead": False,
                "references": [{
                    "referenceId": 0,
                    "centre": [0.0, 0.0, 0.0],
                    "globalDescriptor": LOCATOR.global_descriptor(decoded).tolist(),
                    "transformMatrixOpenGL": LOCATOR.CV_TO_GL.tolist(),
                }],
                "files": files,
            }
            (index_dir / "INDEX.json").write_text(json.dumps(index), encoding="utf-8")
            report_path = root / "estimate.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(LINUX / "localize_v14_sift_track.py"),
                    "--challenge-manifest", str(challenge_path),
                    "--query", str(query_path),
                    "--index-dir", str(index_dir),
                    "--report", str(report_path),
                    "--run-id", "final-01",
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertFalse(report["groundTruthRead"])
            self.assertGreaterEqual(report["geometricInliers"], 20)
            self.assertLess(report["medianReprojectionPx"], 0.5)
            np.testing.assert_allclose(report["estimatedC2wOpenGL"], LOCATOR.CV_TO_GL, atol=3e-3)

            retrieval_report_path = root / "retrieval-estimate.json"
            retrieval = subprocess.run(
                [
                    sys.executable,
                    str(LINUX / "localize_v14_verified_retrieval.py"),
                    "--challenge-manifest", str(challenge_path),
                    "--query", str(query_path),
                    "--index-dir", str(index_dir),
                    "--report", str(retrieval_report_path),
                    "--run-id", "final-01",
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(retrieval.returncode, 0, retrieval.stderr)
            retrieval_report = json.loads(retrieval_report_path.read_text(encoding="utf-8"))
            self.assertEqual(retrieval_report["method"], "content-verified-nearest-training-camera-v1")
            self.assertFalse(retrieval_report["groundTruthRead"])
            self.assertGreaterEqual(retrieval_report["geometricInliers"], 20)
            self.assertLess(retrieval_report["medianReprojectionPx"], 0.5)
            np.testing.assert_allclose(
                retrieval_report["estimatedC2wOpenGL"], LOCATOR.CV_TO_GL, atol=1e-7
            )


if __name__ == "__main__":
    unittest.main()
