#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
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
            matrix = MODULE.virtual_face_c2w_opengl(MODULE.identity4(), yaw, pitch) if hasattr(MODULE, "identity4") else MODULE.virtual_face_c2w_opengl([
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ], yaw, pitch)
            rotation = [row[:3] for row in matrix[:3]]
            self.assertAlmostEqual(MODULE.determinant3(rotation), 1.0, places=9)
            for column in range(3):
                norm = math.sqrt(sum(rotation[row][column] ** 2 for row in range(3)))
                self.assertAlmostEqual(norm, 1.0, places=9)

    def test_opencv_source_to_opengl_face_center_rays(self) -> None:
        identity = [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
        # Nerfstudio/OpenGL looks along local -Z. The source panorama is
        # OpenCV: +X right, +Y down, +Z forward.
        front = MODULE.virtual_face_c2w_opengl(identity, 0.0, 0.0)
        front_forward = [-front[row][2] for row in range(3)]
        self.assertAlmostEqual(front_forward[0], 0.0, places=9)
        self.assertAlmostEqual(front_forward[1], 0.0, places=9)
        self.assertAlmostEqual(front_forward[2], 1.0, places=9)
        right = MODULE.virtual_face_c2w_opengl(identity, 90.0, 0.0)
        right_forward = [-right[row][2] for row in range(3)]
        self.assertAlmostEqual(right_forward[0], 1.0, places=9)
        self.assertAlmostEqual(right_forward[1], 0.0, places=9)
        self.assertAlmostEqual(right_forward[2], 0.0, places=9)
        up = MODULE.virtual_face_c2w_opengl(identity, 0.0, 90.0)
        up_forward = [-up[row][2] for row in range(3)]
        self.assertAlmostEqual(up_forward[0], 0.0, places=9)
        self.assertAlmostEqual(up_forward[1], -1.0, places=9)
        self.assertAlmostEqual(up_forward[2], 0.0, places=9)

    def test_face_pose_preserves_camera_center(self) -> None:
        pose = [
            [1.0, 0.0, 0.0, 1.5],
            [0.0, 1.0, 0.0, -2.0],
            [0.0, 0.0, 1.0, 0.25],
            [0.0, 0.0, 0.0, 1.0],
        ]
        for _, yaw, pitch in MODULE.FACE_SPECS:
            face = MODULE.virtual_face_c2w_opengl(pose, yaw, pitch)
            self.assertEqual([face[row][3] for row in range(3)], [1.5, -2.0, 0.25])

    def test_dynamic_nadir_is_excluded(self) -> None:
        self.assertNotIn("down", [name for name, _, _ in MODULE.FACE_SPECS])
        self.assertEqual(len(MODULE.FACE_SPECS), 9)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for the pixel-ray contract test")
    def test_ffmpeg_face_centres_match_pose_rays(self) -> None:
        width, height = 720, 360
        identity = [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "direction.ppm"
            pixels = bytearray()
            for y in range(height):
                latitude = math.pi / 2.0 - (y + 0.5) * math.pi / height
                for x in range(width):
                    longitude = (x + 0.5) * 2.0 * math.pi / width - math.pi
                    direction = (
                        math.sin(longitude) * math.cos(latitude),
                        -math.sin(latitude),
                        math.cos(longitude) * math.cos(latitude),
                    )
                    pixels.extend(round((value + 1.0) * 127.5) for value in direction)
            source.write_bytes(f"P6\n{width} {height}\n255\n".encode("ascii") + pixels)
            for name, yaw, pitch in MODULE.FACE_SPECS:
                output = Path(directory) / f"{name}.ppm"
                subprocess.run([
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    "-i", str(source), "-vf",
                    f"v360=input=equirect:output=flat:yaw={yaw}:pitch={pitch}:h_fov=100:v_fov=100:w=101:h=101:interp=nearest",
                    "-frames:v", "1", "-pix_fmt", "rgb24", str(output),
                ], check=True)
                raw = output.read_bytes()
                header_end = raw.find(b"\n255\n") + len(b"\n255\n")
                centre = header_end + (50 * 101 + 50) * 3
                pixel_ray = [(raw[centre + index] / 127.5) - 1.0 for index in range(3)]
                norm = math.sqrt(sum(value * value for value in pixel_ray))
                pixel_ray = [value / norm for value in pixel_ray]
                face = MODULE.virtual_face_c2w_opengl(identity, yaw, pitch)
                pose_ray = [-face[row][2] for row in range(3)]
                dot = max(-1.0, min(1.0, sum(a * b for a, b in zip(pixel_ray, pose_ray))))
                self.assertLess(math.degrees(math.acos(dot)), 2.0, name)


if __name__ == "__main__":
    unittest.main()
