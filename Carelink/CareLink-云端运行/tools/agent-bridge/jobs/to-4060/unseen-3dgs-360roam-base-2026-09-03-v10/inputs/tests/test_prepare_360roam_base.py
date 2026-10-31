#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/linux/prepare_360roam_base.py"
SPEC = importlib.util.spec_from_file_location("prepare_360roam_base", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AdapterMathTests(unittest.TestCase):
    def test_even_selection_includes_endpoints(self) -> None:
        self.assertEqual(MODULE.evenly_spaced_indices(148, 50)[0], 0)
        self.assertEqual(MODULE.evenly_spaced_indices(148, 50)[-1], 147)
        self.assertEqual(len(set(MODULE.evenly_spaced_indices(148, 50))), 50)
        self.assertEqual(MODULE.evenly_spaced_indices(50, 10)[-1], 49)

    def test_face_rotations_are_proper(self) -> None:
        for _, yaw, pitch in MODULE.FACE_SPECS:
            matrix = MODULE.face_rotation(yaw, pitch)
            rotation = [row[:3] for row in matrix[:3]]
            self.assertAlmostEqual(MODULE.determinant3(rotation), 1.0, places=9)
            for column in range(3):
                norm = math.sqrt(sum(rotation[row][column] ** 2 for row in range(3)))
                self.assertAlmostEqual(norm, 1.0, places=9)

    def test_yaw_right_and_pitch_up_match_opengl_camera_axes(self) -> None:
        # OpenGL view direction is local -Z.
        right = MODULE.face_rotation(90.0, 0.0)
        right_forward = [-right[row][2] for row in range(3)]
        self.assertAlmostEqual(right_forward[0], 1.0, places=9)
        self.assertAlmostEqual(right_forward[1], 0.0, places=9)
        self.assertAlmostEqual(right_forward[2], 0.0, places=9)
        up = MODULE.face_rotation(0.0, 90.0)
        up_forward = [-up[row][2] for row in range(3)]
        self.assertAlmostEqual(up_forward[0], 0.0, places=9)
        self.assertAlmostEqual(up_forward[1], 1.0, places=9)
        self.assertAlmostEqual(up_forward[2], 0.0, places=9)

    def test_face_pose_preserves_camera_center(self) -> None:
        pose = [
            [1.0, 0.0, 0.0, 1.5],
            [0.0, 1.0, 0.0, -2.0],
            [0.0, 0.0, 1.0, 0.25],
            [0.0, 0.0, 0.0, 1.0],
        ]
        for _, yaw, pitch in MODULE.FACE_SPECS:
            face = MODULE.mat4_multiply(pose, MODULE.face_rotation(yaw, pitch))
            self.assertEqual([face[row][3] for row in range(3)], [1.5, -2.0, 0.25])


if __name__ == "__main__":
    unittest.main()
