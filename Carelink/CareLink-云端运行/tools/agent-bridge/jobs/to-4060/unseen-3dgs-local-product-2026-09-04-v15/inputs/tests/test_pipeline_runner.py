#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, json, sqlite3, struct, sys, tempfile, unittest
from pathlib import Path
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]; SCRIPT=ROOT/"product/pipeline_runner.py"
SPEC=importlib.util.spec_from_file_location("pipeline_runner",SCRIPT); assert SPEC and SPEC.loader
MODULE=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(MODULE)
# Explicit Mac-only boundary; production has no CLI/environment bypass and
# requires the locked jsonschema distribution.
MODULE._SCHEMA_VALIDATOR_FOR_TESTS=lambda _value,_schema_name: None

class PipelineTests(unittest.TestCase):
    def test_runner_validates_job_and_result_before_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); source=root/"source.mp4"; source.write_bytes(b"source")
            spec={"kind":"scene_preview","jobId":"job-test","scene":{"id":"s","revision_id":"s-r001","display_name":"room.mp4","duration_seconds":60},
                  "inputPath":str(source),"inputSha256":MODULE.sha256(source),"productRoot":str(root/"product"),"workDir":str(root/"work"),
                  "progressPath":str(root/"work/progress.json"),"resultPath":str(root/"work/result.json")}
            observed=[]
            with mock.patch.object(MODULE,"_SCHEMA_VALIDATOR_FOR_TESTS",lambda _value,name: observed.append(name)):
                result=MODULE.Runner(spec,dry_run=True).execute()
            self.assertEqual(observed[0],"job.schema.json")
            self.assertIn("result.schema.json",observed)
            self.assertEqual(result["status"],"dry-run")

            def reject_result(_value,name):
                if name == "result.schema.json":
                    raise RuntimeError("synthetic result contract rejection")

            with mock.patch.object(MODULE,"_SCHEMA_VALIDATOR_FOR_TESTS",reject_result):
                runner=MODULE.Runner(spec,dry_run=False)
                with self.assertRaisesRegex(RuntimeError,"synthetic result contract rejection"):
                    runner.finish_result({"status":"ready"})
            self.assertFalse(Path(spec["resultPath"]).exists())

    def test_scene_dry_run_reuses_expected_toolchain(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); source=root/"source.mp4"; source.write_bytes(b"test-source")
            spec={"kind":"scene_preview","jobId":"job-test","scene":{"id":"s","revision_id":"s-r001","display_name":"room.mp4","duration_seconds":60},
                  "inputPath":str(source),"inputSha256":MODULE.sha256(source),"productRoot":str(root/"product"),"workDir":str(root/"work"),
                  "progressPath":str(root/"work/progress.json"),"resultPath":str(root/"work/result.json")}
            result=MODULE.Runner(spec,dry_run=True).execute(); flat=[" ".join(command) for command in result["commands"]]
            self.assertEqual(result["sceneRevisionId"], "s-r001")
            self.assertTrue(any("v360=input=equirect:output=flat" in row for row in flat))
            self.assertTrue(any("colmap feature_extractor" in row and "--ImageReader.camera_model PINHOLE" in row and "--ImageReader.camera_params 429.619011" in row for row in flat))
            self.assertTrue(any("colmap feature_extractor" in row and "--SiftExtraction.use_gpu 0" in row for row in flat))
            self.assertTrue(any("colmap exhaustive_matcher" in row and "--SiftMatching.use_gpu 0" in row for row in flat))
            self.assertTrue(any("colmap mapper" in row and "--Mapper.ba_refine_focal_length 0" in row for row in flat))
            self.assertTrue(any("ns-process-data images" in row and "--skip-image-processing --skip-colmap" in row for row in flat))
            self.assertTrue(any("ns-train splatfacto" in row and "--max-num-iterations 7000" in row for row in flat))
            self.assertTrue(any("--pipeline.datamanager.dataparser.eval-mode all" in row for row in flat))
            self.assertFalse(any("--load-dir" in row or "--load-step" in row for row in flat))
            self.assertTrue(any("splat-transform -g cpu -H 1 -i 2" in row for row in flat))
            self.assertTrue(any("scene.incomplete.sog --info json null" in row for row in flat))
            self.assertFalse(any("npx --yes" in row for row in flat))
            self.assertFalse(any(row.endswith("splat.ply " + str(root/"product/scenes/s-r001/viewer/assets/scene.sog")) for row in flat))

    def test_colmap_pose_and_dataparser_transform(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/"images.txt"
            path.write_text("# model\n7 1 0 0 0 1 2 3 4 query.jpg\n0 0 -1\n",encoding="utf-8")
            pose=MODULE.parse_colmap_query_pose(path,"query.jpg")
            self.assertEqual(pose["position"],[-1.0,-2.0,-3.0])
            transformed=MODULE.original_pose_to_viewer(pose,{"transform":[[1,0,0,1],[0,1,0,2],[0,0,1,3]],"scale":.5})
            self.assertEqual(transformed["position"],[0.0,0.0,0.0]); self.assertAlmostEqual(sum(v*v for v in transformed["quaternion"]),1.0)
            cameras=Path(temporary)/"cameras.txt"; cameras.write_text("4 SIMPLE_RADIAL 1920 1080 1000 960 540 0\n",encoding="utf-8")
            self.assertAlmostEqual(MODULE.parse_colmap_camera_fov(cameras,4),56.738092586,places=6)

    def test_saved_transform_removes_applied_component_once_then_maps_to_viewer(self):
        original={"rotation":[[1,0,0],[0,1,0],[0,0,1]],"position":[1,2,3]}
        applied=[[1,0,0,0],[0,0,1,0],[0,-1,0,0]]
        saved={"rotation":[[1,0,0],[0,0,1],[0,-1,0]],"position":[1,3,-2]}
        parser={"transform":[[1,0,0,0],[0,1,0,0],[0,0,1,0]],"scale":1}
        from_saved=MODULE.saved_pose_to_viewer(saved,parser,applied)
        from_original=MODULE.original_pose_to_viewer(original,parser)
        self.assertEqual(from_saved["position"],from_original["position"])
        for left,right in zip(from_saved["quaternion"],from_original["quaternion"]): self.assertAlmostEqual(left,right)

    def test_v14_final_01_golden_coordinate_chain(self):
        # Frozen from v14 VIEWER-POSE-CHAIN.json. Keeping the full chain here
        # catches loss of the PlayCanvas left multiplication as well as T/scale
        # order regressions without relying on another payload at test time.
        estimated_c2w=[
            [-0.8478692161394501,-0.016377229275690908,-0.5299524305862989,1.027104064832915],
            [0.5301032584538996,-0.0065634557709605135,-0.8479076933398477,3.627714678867376],
            [0.010408059359582778,-0.9998443415900271,0.014246574703180248,0.013797947184951703],
            [0.0,0.0,0.0,1.0],
        ]
        parser={
            "transform":[
                [0.5353361368179321,-0.8445731401443481,0.01055041141808033,-0.06810395419597626],
                [-0.8445731401443481,-0.5350964069366455,0.019176432862877846,-0.02399967424571514],
                [-0.01055041141808033,-0.019176432862877846,-0.9997602701187134,-0.0005489611066877842],
            ],
            "scale":0.18098333537863337,
        }
        pose={"rotation":[row[:3] for row in estimated_c2w[:3]],"position":[row[3] for row in estimated_c2w[:3]]}
        actual=MODULE.original_pose_to_viewer(pose,parser)
        expected_position=[-0.467295866,-0.017147555,0.512612978]
        expected_quaternion=[-0.006512024,0.975060129,0.002419723,0.221832108]
        for left,right in zip(actual["position"],expected_position): self.assertAlmostEqual(left,right,places=8)
        for left,right in zip(actual["quaternion"],expected_quaternion): self.assertAlmostEqual(left,right,places=8)

    def test_projection_rename_map_preserves_time_and_direction_after_nerfstudio_rename(self):
        paths=[Path("t0001_up.jpg"),Path("t0000_front_right.jpg"),Path("t0000_back.jpg")]
        mapping=MODULE.projection_identity_map(paths)
        self.assertEqual(mapping["t0000_back.jpg"],{"sourceName":"t0000_back.jpg","timeIndex":0,"direction":"back"})
        directions,times=MODULE.registered_projection_coverage(
            [{"file_path":"./images/t0000_back.jpg"},{"file_path":"./images/t0001_up.jpg"}],mapping
        )
        self.assertEqual(directions,{"back","up"}); self.assertEqual(times,{0,1})

    def test_crash_partial_projection_is_discarded_without_a_stage_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); marker=root/"stages/project.json"
            train=root/"projected/train"; held=root/"projected/held-out"
            train.mkdir(parents=True); held.mkdir(parents=True)
            corrupt=train/"t0000_front.jpg"; corrupt.write_bytes(b"truncated-jpeg")
            stale=held/"t0013_up.jpg"; stale.write_bytes(b"partial")
            self.assertTrue(MODULE.reset_uncommitted_projection_outputs(marker,(train,held)))
            self.assertEqual(list(train.iterdir()),[])
            self.assertEqual(list(held.iterdir()),[])

            marker.parent.mkdir(parents=True); marker.write_text("{}",encoding="utf-8")
            preserved=train/"t0000_front.jpg"; preserved.write_bytes(b"validated-stage-owned")
            self.assertFalse(MODULE.reset_uncommitted_projection_outputs(marker,(train,held)))
            self.assertEqual(preserved.read_bytes(),b"validated-stage-owned")

    def test_largest_connected_colmap_model_is_selected_not_directory_zero(self):
        with tempfile.TemporaryDirectory() as temporary:
            sparse=Path(temporary)
            for name,count in (("0",2),("2",72),("3",48)):
                model=sparse/name; model.mkdir()
                (model/"cameras.bin").write_bytes(b"camera")
                (model/"images.bin").write_bytes(struct.pack("<Q",count)+b"payload")
                (model/"points3D.bin").write_bytes(b"points")
            selected,counts=MODULE.select_largest_colmap_model(sparse)
            self.assertEqual(selected.name,"2"); self.assertEqual(counts,{"0":2,"2":72,"3":48})

    def test_newest_photo_anchor_is_the_viewer_default(self):
        manifest={"photoAnchors":[{"id":"start"},{"id":"photo-old"}]}
        newest={"id":"photo-new","position":[1,2,3]}
        MODULE.prioritize_photo_anchor(manifest,newest)
        self.assertEqual(manifest["photoAnchors"],[newest,{"id":"start"},{"id":"photo-old"}])
        self.assertEqual(manifest["defaultPhotoAnchorId"],"photo-new")

    def test_photo_registration_is_query_only_and_fixes_training_gauge(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); source=root/"photo.jpg"; source.write_bytes(b"photo")
            scene_root=root/"product/scenes/s-r001"; model=scene_root/"processed/colmap/sparse/0"; model.mkdir(parents=True)
            (scene_root/"processed/colmap/database.db").write_bytes(b"db")
            (scene_root/"stages").mkdir(); (scene_root/"stages/process.json").write_text(json.dumps({"colmapModel":"colmap/sparse/0"}),encoding="utf-8")
            viewer=scene_root/"viewer"
            spec={"kind":"photo_localize","jobId":"photo-test","scene":{"id":"s","revision_id":"s-r001","result":{"status":"ready","viewerRoot":str(viewer)}},
                  "inputPath":str(source),"inputSha256":MODULE.sha256(source),"productRoot":str(root/"product"),"workDir":str(root/"work"),
                  "progressPath":str(root/"work/progress.json"),"resultPath":str(root/"work/result.json")}
            result=MODULE.Runner(spec,dry_run=True).execute(); flat=[" ".join(command) for command in result["commands"]]
            self.assertEqual(result["sceneRevisionId"], "s-r001")
            feature_extractor=next(row for row in flat if "colmap feature_extractor" in row)
            self.assertIn("query-list.txt",feature_extractor)
            self.assertIn("--SiftExtraction.use_gpu 0",feature_extractor)
            matcher=next(row for row in flat if "colmap exhaustive_matcher" in row)
            self.assertIn("--SiftMatching.use_gpu 0",matcher)
            registrator=next(row for row in flat if "colmap image_registrator" in row)
            self.assertNotIn("--Mapper.image_list_path",registrator)
            self.assertIn("--Mapper.fix_existing_images 1",registrator)
            self.assertNotIn("--Mapper.fix_existing_frames",registrator)
            self.assertIn("--Mapper.abs_pose_min_num_inliers 20",registrator)
            self.assertIn("--Mapper.abs_pose_min_inlier_ratio 0.1",registrator)
            self.assertIn("--Mapper.abs_pose_max_error 3.5",registrator)
            registered_converters=[
                row for row in flat
                if "colmap model_converter" in row and "/registered --output_path" in row
            ]
            self.assertEqual(len(registered_converters),1)

    def test_existing_result_reuse_requires_full_job_identity(self):
        spec = {
            "kind": "photo_localize",
            "inputSha256": "a" * 64,
            "scene": {"revision_id": "s-r001"},
        }
        good = {
            "status": "ready",
            "kind": "photo_localize",
            "inputSha256": "a" * 64,
            "sceneRevisionId": "s-r001",
        }
        self.assertIs(MODULE.validate_reusable_result(good, spec), good)
        for key in ("status", "kind", "inputSha256", "sceneRevisionId"):
            bad = dict(good)
            bad[key] = "wrong"
            with self.assertRaisesRegex(RuntimeError, "existing result contract mismatch"):
                MODULE.validate_reusable_result(bad, spec)

    def test_existing_scene_result_does_not_skip_stage_revalidation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            result_path = root / "work/result.json"
            result_path.parent.mkdir(parents=True)
            spec = {
                "kind": "scene_preview",
                "jobId": "job-test",
                "scene": {"id": "s", "revision_id": "s-r001", "display_name": "room.mp4", "duration_seconds": 60},
                "inputPath": str(source),
                "inputSha256": MODULE.sha256(source),
                "productRoot": str(root / "product"),
                "workDir": str(root / "work"),
                "progressPath": str(root / "work/progress.json"),
                "resultPath": str(result_path),
            }
            result_path.write_text(json.dumps({
                "status": "ready",
                "kind": "scene_preview",
                "inputSha256": spec["inputSha256"],
                "sceneRevisionId": "s-r001",
                "forgedShortcut": True,
            }), encoding="utf-8")
            result = MODULE.Runner(spec, dry_run=True).execute()
            self.assertEqual(result["status"], "dry-run")
            self.assertNotIn("forgedShortcut", result)
            self.assertGreater(len(result["commands"]), 1)

    def test_colmap_is_cpu_only_in_r3_and_splat_tool_never_network_falls_back(self):
        with mock.patch.dict(MODULE.os.environ,{},clear=True):
            self.assertEqual(MODULE.colmap_gpu_value({}),"0")
        self.assertEqual(MODULE.colmap_gpu_value({"colmapUseGpu":False}),"0")
        with self.assertRaisesRegex(RuntimeError,"unsupported"):
            MODULE.colmap_gpu_value({"colmapUseGpu":True})
        with self.assertRaisesRegex(RuntimeError,"unsupported"):
            MODULE.colmap_gpu_value({"colmapUseGpu":"auto"})
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); source=root/"source.mp4"; source.write_bytes(b"source")
            spec={"kind":"scene_preview","jobId":"job-test","scene":{"id":"s","revision_id":"s-r001"},
                  "inputPath":str(source),"inputSha256":MODULE.sha256(source),"productRoot":str(root/"product"),"workDir":str(root/"work"),
                  "progressPath":str(root/"work/progress.json"),"resultPath":str(root/"work/result.json")}
            missing=[root/"missing/splat-transform"]
            with self.assertRaisesRegex(RuntimeError,"pinned splat-transform executable is missing"):
                MODULE.Runner(spec,dry_run=False).splat_transform_command(missing)
            dry_command=MODULE.Runner(spec,dry_run=True).splat_transform_command(missing)
            self.assertEqual(dry_command,[str(missing[0])])
            self.assertNotIn("--yes",dry_command)

    def test_reference_gauge_requires_only_query_and_unchanged_training_poses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); base=root/"base-images.txt"; registered=root/"registered-images.txt"
            base.write_text(
                "# Image list\n"
                "1 1 0 0 0 1 2 3 4 t0000_front.jpg\n0 0 -1\n"
                "2 0.9238795325 0 0.3826834324 0 -2 1 4 4 t0000_right.jpg\n1 2 -1\n",
                encoding="utf-8",
            )
            registered.write_text(
                "# Image list\n"
                "1 1 0 0 0 1 2 3 4 t0000_front.jpg\n0 0 -1\n"
                "2 0.9238795325 0 0.3826834324 0 -2 1 4 4 t0000_right.jpg\n1 2 -1\n"
                "3 1 0 0 0 0 0 0 5 query.jpg\n3 4 99\n",
                encoding="utf-8",
            )
            gauge=MODULE.validate_colmap_reference_gauge(base,registered,"query.jpg")
            self.assertEqual(gauge["referenceFramesCompared"],2)
            self.assertEqual(
                MODULE.validate_reference_frame_contract(2,gauge,{"baseReferenceImages":2}),
                2,
            )
            self.assertTrue(gauge["existingFramesFixed"])
            self.assertTrue(gauge["onlyQueryAdded"])
            self.assertAlmostEqual(gauge["maxReferenceRotationDelta"],0.0)
            self.assertAlmostEqual(gauge["maxReferencePositionDelta"],0.0)
            registered.write_text(
                registered.read_text(encoding="utf-8").replace(
                    "1 1 0 0 0 1 2 3 4 t0000_front.jpg",
                    "1 1 0 0 0 1.001 2 3 4 t0000_front.jpg",
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError,"changed the training-map gauge"):
                MODULE.validate_colmap_reference_gauge(base,registered,"query.jpg")
            with self.assertRaisesRegex(RuntimeError,"counts disagree"):
                MODULE.validate_reference_frame_contract(2,gauge,{"baseReferenceImages":3})

    def test_localization_database_is_pruned_to_base_model_then_adds_only_query(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); model=root/"images.txt"; database=root/"database.db"
            model.write_text(
                "1 1 0 0 0 0 0 0 10 t0000_front.jpg\n0 0 -1\n"
                "2 1 0 0 0 1 0 0 11 t0000_right.jpg\n0 0 -1\n",
                encoding="utf-8",
            )
            records=MODULE.parse_colmap_image_poses(model)
            with sqlite3.connect(database) as connection:
                connection.executescript(
                    "CREATE TABLE cameras(camera_id INTEGER PRIMARY KEY);"
                    "CREATE TABLE images(image_id INTEGER PRIMARY KEY, name TEXT, camera_id INTEGER);"
                    "CREATE TABLE keypoints(image_id INTEGER PRIMARY KEY, data BLOB);"
                    "CREATE TABLE descriptors(image_id INTEGER PRIMARY KEY, data BLOB);"
                    "CREATE TABLE matches(pair_id INTEGER PRIMARY KEY, data BLOB);"
                    "CREATE TABLE two_view_geometries(pair_id INTEGER PRIMARY KEY, data BLOB);"
                )
                connection.executemany("INSERT INTO cameras VALUES (?)",[(10,),(11,),(12,)])
                connection.executemany(
                    "INSERT INTO images VALUES (?,?,?)",
                    [(1,"t0000_front.jpg",10),(2,"t0000_right.jpg",11),(3,"unregistered-training.jpg",12)],
                )
                connection.executemany("INSERT INTO keypoints VALUES (?,?)",[(1,b"a"),(2,b"b"),(3,b"c")])
                connection.executemany("INSERT INTO descriptors VALUES (?,?)",[(1,b"a"),(2,b"b"),(3,b"c")])
                kept_pair=MODULE.COLMAP_MAX_IMAGE_ID*1+2
                rejected_pairs=[MODULE.COLMAP_MAX_IMAGE_ID*1+3,MODULE.COLMAP_MAX_IMAGE_ID*2+3]
                connection.executemany("INSERT INTO matches VALUES (?,?)",[(kept_pair,b"keep"),*((value,b"drop") for value in rejected_pairs)])
                connection.executemany("INSERT INTO two_view_geometries VALUES (?,?)",[(kept_pair,b"keep"),*((value,b"drop") for value in rejected_pairs)])
            evidence=MODULE.prune_colmap_database_to_model(database,records)
            self.assertEqual(evidence["removedNonModelImages"],1)
            self.assertEqual(evidence["removedOutOfModelPairRows"],4)
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT image_id,name FROM images ORDER BY image_id").fetchall(),[(1,"t0000_front.jpg"),(2,"t0000_right.jpg")])
                self.assertEqual(connection.execute("SELECT image_id FROM keypoints ORDER BY image_id").fetchall(),[(1,),(2,)])
                self.assertEqual(connection.execute("SELECT pair_id FROM matches").fetchall(),[(kept_pair,)])
                connection.execute("INSERT INTO cameras VALUES (13)")
                connection.execute("INSERT INTO images VALUES (4,'query.jpg',13)")
            isolated=MODULE.validate_colmap_localization_database(database,records,"query.jpg")
            self.assertTrue(isolated["onlyQueryUnregistered"])
            self.assertEqual(isolated["queryDatabaseImageId"],4)
            self.assertEqual(isolated["databaseImageCountAfterQuery"],3)

    def test_registration_quality_gate_parses_reprojection_statistics(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); images=root/"images.txt"; cameras=root/"cameras.txt"; points=root/"points3D.txt"
            triples=[]; point_rows=[]
            for point_id in range(1,21):
                x=((point_id-1)%5-2)/10; y=((point_id-1)//5-2)/10
                triples.extend([str(500*x+500),str(500*y+500),str(point_id)])
                point_rows.append(f"{point_id} {x} {y} 1 255 255 255 0")
            images.write_text("1 1 0 0 0 0 0 0 2 query.jpg\n"+" ".join(triples)+"\n",encoding="utf-8")
            cameras.write_text("2 SIMPLE_RADIAL 1000 1000 500 500 500 0\n",encoding="utf-8")
            points.write_text("\n".join(point_rows)+"\n",encoding="utf-8")
            quality=MODULE.parse_colmap_registration_quality(images,cameras,points,"query.jpg")
            self.assertTrue(quality["gatePassed"])
            self.assertEqual(quality["geometricInliers"],20)
            self.assertEqual(quality["geometricInlierRatio"],1.0)
            self.assertAlmostEqual(quality["medianReprojectionPx"],0.0)
            self.assertEqual(quality["thresholds"],{"minGeometricInliers":20,"minGeometricInlierRatio":0.1,"maxMedianReprojectionPx":3.5})
            diluted=[*triples]
            for _ in range(181): diluted.extend(["0","0","-1"])
            images.write_text("1 1 0 0 0 0 0 0 2 query.jpg\n"+" ".join(diluted)+"\n",encoding="utf-8")
            self.assertFalse(MODULE.parse_colmap_registration_quality(images,cameras,points,"query.jpg")["gatePassed"])

    def test_stage_invalidation_cascades_and_sog_publish_is_atomic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); stages=root/"stages"; stages.mkdir()
            for name in MODULE.STAGE_ORDER: (stages/f"{name}.json").write_text("{}",encoding="utf-8")
            (stages/"train.intent.json").write_text("{}",encoding="utf-8")
            MODULE.invalidate_stage_markers(stages,"process")
            self.assertTrue((stages/"extract.json").is_file()); self.assertTrue((stages/"project.json").is_file())
            self.assertFalse((stages/"process.json").exists()); self.assertFalse((stages/"train.json").exists()); self.assertFalse((stages/"export.json").exists())
            self.assertFalse((stages/"train.intent.json").exists())
            lineage=MODULE.stage_lineage("train","abc")
            self.assertTrue(MODULE.stage_lineage_matches(lineage,"train","abc"))
            self.assertFalse(MODULE.stage_lineage_matches(lineage,"train","changed"))
            destination=root/"scene.sog"; destination.write_bytes(b"last-known-good")
            empty=root/"empty.incomplete.sog"; empty.write_bytes(b"")
            with self.assertRaises(RuntimeError): MODULE.publish_nonempty_file(empty,destination)
            self.assertEqual(destination.read_bytes(),b"last-known-good")
            staged=root/"scene.incomplete.sog"; staged.write_bytes(b"validated-new")
            MODULE.publish_nonempty_file(staged,destination)
            self.assertEqual(destination.read_bytes(),b"validated-new"); self.assertFalse(staged.exists())

    def test_invalid_training_tree_is_quarantined_before_resume_can_see_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); training=root/"training"; checkpoint=training/"scene/splatfacto/preview-7000/nerfstudio_models/step-000006999.ckpt"
            checkpoint.parent.mkdir(parents=True); checkpoint.write_bytes(b"hash-mismatch")
            quarantined=MODULE.quarantine_generated_tree(training)
            self.assertIsNotNone(quarantined)
            assert quarantined is not None
            self.assertFalse(training.exists())
            self.assertEqual(
                (quarantined/"scene/splatfacto/preview-7000/nerfstudio_models/step-000006999.ckpt").read_bytes(),
                b"hash-mismatch",
            )
            self.assertIsNone(MODULE.latest_checkpoint_step(checkpoint.parent))

    def test_crashed_training_safely_resumes_from_matching_intent_and_loadable_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); training=root/"training"; export=root/"export"; processed=root/"processed"
            checkpoint=training/"scene/splatfacto/preview-7000/nerfstudio_models/step-000004000.ckpt"
            checkpoint.parent.mkdir(parents=True); checkpoint.write_bytes(b"serialized-checkpoint")
            config=checkpoint.parent.parent/"config.yml"; config.write_text("method: splatfacto\n",encoding="utf-8")
            command_template=MODULE.training_command_template(processed,training,"scene")
            expected=MODULE.training_intent_contract("process-lineage",command_template,training,checkpoint.parent,config)
            intent=root/"stages/train.intent.json"; MODULE.write_json(intent,expected)
            attempt=MODULE.prepare_training_attempt(
                intent,expected,training,export,checkpoint.parent,
                checkpoint_loader=lambda _path:{"step":4000,"pipeline":{},"optimizers":{},"scalers":{}},
            )
            self.assertEqual(attempt["resumeStep"],4000)
            self.assertEqual(attempt["remainingIterations"],2999)
            self.assertEqual(attempt["resumeCheckpoint"]["sha256"],MODULE.sha256(checkpoint))
            self.assertIsNone(attempt["trainingQuarantine"]); self.assertTrue(checkpoint.is_file())
            self.assertEqual(json.loads(intent.read_text(encoding="utf-8")),expected)
            command=MODULE.materialize_training_command(command_template,2999,checkpoint.parent,4000)
            flat=" ".join(command)
            self.assertIn("--max-num-iterations 2999",flat)
            self.assertIn(f"--load-dir {checkpoint.parent} --load-step 4000",flat)

    def test_tampered_checkpoint_is_quarantined_and_restarts_from_zero(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); training=root/"training"; export=root/"export"; processed=root/"processed"
            checkpoint=training/"scene/splatfacto/preview-7000/nerfstudio_models/step-000004000.ckpt"
            checkpoint.parent.mkdir(parents=True); checkpoint.write_bytes(b"tampered-checkpoint")
            config=checkpoint.parent.parent/"config.yml"; config.write_text("method: splatfacto\n",encoding="utf-8")
            command_template=MODULE.training_command_template(processed,training,"scene")
            expected=MODULE.training_intent_contract("process-lineage",command_template,training,checkpoint.parent,config)
            intent=root/"stages/train.intent.json"; MODULE.write_json(intent,expected)
            attempt=MODULE.prepare_training_attempt(
                intent,expected,training,export,checkpoint.parent,
                checkpoint_loader=lambda _path:{"step":3999,"pipeline":{},"optimizers":{},"scalers":{}},
            )
            self.assertIsNone(attempt["resumeStep"]); self.assertEqual(attempt["remainingIterations"],7000)
            self.assertIsNone(attempt["resumeCheckpoint"])
            self.assertTrue(attempt["recoveryReason"].startswith("checkpoint-validation-failed:"))
            quarantine=attempt["trainingQuarantine"]; self.assertIsNotNone(quarantine)
            assert quarantine is not None
            self.assertFalse(training.exists())
            self.assertEqual(
                (quarantine/"scene/splatfacto/preview-7000/nerfstudio_models/step-000004000.ckpt").read_bytes(),
                b"tampered-checkpoint",
            )
            command=MODULE.materialize_training_command(command_template,7000,checkpoint.parent,None)
            self.assertNotIn("--load-dir"," ".join(command))

    def test_unmarked_partial_training_and_export_are_quarantined(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); training=root/"training"; export=root/"export"; processed=root/"processed"
            checkpoint=training/"scene/splatfacto/preview-7000/nerfstudio_models/step-000004000.ckpt"
            checkpoint.parent.mkdir(parents=True); checkpoint.write_bytes(b"untrusted")
            export.mkdir(); (export/"splat.ply").write_bytes(b"derived")
            config=checkpoint.parent.parent/"config.yml"
            template=MODULE.training_command_template(processed,training,"scene")
            expected=MODULE.training_intent_contract("process-lineage",template,training,checkpoint.parent,config)
            intent=root/"stages/train.intent.json"
            attempt=MODULE.prepare_training_attempt(intent,expected,training,export,checkpoint.parent)
            self.assertIsNone(attempt["resumeStep"]); self.assertEqual(attempt["remainingIterations"],7000)
            self.assertEqual(attempt["recoveryReason"],"intent-missing")
            self.assertIsNotNone(attempt["trainingQuarantine"]); self.assertIsNotNone(attempt["exportQuarantine"])
            self.assertFalse(training.exists()); self.assertFalse(export.exists())
            self.assertEqual(json.loads(intent.read_text(encoding="utf-8")),expected)

    def test_changed_train_intent_lineage_quarantines_even_a_loadable_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); training=root/"training"; export=root/"export"; processed=root/"processed"
            checkpoint=training/"scene/splatfacto/preview-7000/nerfstudio_models/step-000004000.ckpt"
            checkpoint.parent.mkdir(parents=True); checkpoint.write_bytes(b"otherwise-loadable")
            config=checkpoint.parent.parent/"config.yml"; config.write_text("method: splatfacto\n",encoding="utf-8")
            template=MODULE.training_command_template(processed,training,"scene")
            expected=MODULE.training_intent_contract("current-process-lineage",template,training,checkpoint.parent,config)
            stale=MODULE.training_intent_contract("old-process-lineage",template,training,checkpoint.parent,config)
            intent=root/"stages/train.intent.json"; MODULE.write_json(intent,stale)
            loader_called=False
            def loader(_path):
                nonlocal loader_called
                loader_called=True
                return {"step":4000,"pipeline":{},"optimizers":{},"scalers":{}}
            attempt=MODULE.prepare_training_attempt(
                intent,expected,training,export,checkpoint.parent,checkpoint_loader=loader
            )
            self.assertFalse(loader_called)
            self.assertEqual(attempt["recoveryReason"],"intent-mismatch")
            self.assertIsNone(attempt["resumeStep"]); self.assertEqual(attempt["remainingIterations"],7000)
            self.assertIsNotNone(attempt["trainingQuarantine"]); self.assertFalse(training.exists())
            self.assertEqual(json.loads(intent.read_text(encoding="utf-8")),expected)

    def test_training_oom_classification_ignores_prior_attempt_log_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); source=root/"source.mp4"; source.write_bytes(b"source")
            spec={"workDir":str(root/"work"),"progressPath":str(root/"work/progress.json"),
                  "resultPath":str(root/"work/result.json"),"inputPath":str(source),"scene":{},"colmapUseGpu":False}
            runner=MODULE.Runner(spec); log=root/"work/train.log"; checkpoints=root/"checkpoints"
            log.parent.mkdir(parents=True); log.write_text("CUDA out of memory from prior attempt\n",encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError,r"command exited 7"):
                runner.run_training(
                    [sys.executable,"-c","import sys; print('fresh unrelated failure'); sys.exit(7)"],
                    log=log,checkpoint_dir=checkpoints,
                )
            with self.assertRaisesRegex(RuntimeError,r"CUDA OOM"):
                runner.run_training(
                    [sys.executable,"-c","import sys; print('CUDA out of memory in current attempt'); sys.exit(7)"],
                    log=log,checkpoint_dir=checkpoints,
                )

    def test_train_marker_and_scene_result_bind_checkpoint_size_and_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); config=root/"config.yml"; checkpoints=root/"nerfstudio_models"
            config.write_text("method: splatfacto\n",encoding="utf-8"); checkpoints.mkdir()
            checkpoint=checkpoints/"step-000006999.ckpt"; checkpoint.write_bytes(b"verified-checkpoint")
            marker={
                **MODULE.stage_lineage("train","process-marker-sha"),
                "trainIntentSha256":"a"*64,
                "iterations":7000,
                "evalMode":"all",
                "configSha256":MODULE.sha256(config),
                "finalCheckpointBytes":checkpoint.stat().st_size,
                "finalCheckpointSha256":MODULE.sha256(checkpoint),
            }
            self.assertTrue(MODULE.training_marker_matches(marker,"process-marker-sha","a"*64,config,checkpoints))
            self.assertFalse(MODULE.training_marker_matches(marker,"process-marker-sha","b"*64,config,checkpoints))
            self.assertEqual(
                MODULE.checkpoint_result_evidence(marker),
                {"checkpointBytes":len(b"verified-checkpoint"),"checkpointSha256":MODULE.sha256(checkpoint)},
            )
            checkpoint.write_bytes(b"tampered-checkpoint")
            self.assertFalse(MODULE.training_marker_matches(marker,"process-marker-sha","a"*64,config,checkpoints))
            invalid=dict(marker); invalid["finalCheckpointSha256"]="PENDING"
            with self.assertRaisesRegex(RuntimeError,"valid final checkpoint SHA256"):
                MODULE.checkpoint_result_evidence(invalid)

if __name__=="__main__": unittest.main()
