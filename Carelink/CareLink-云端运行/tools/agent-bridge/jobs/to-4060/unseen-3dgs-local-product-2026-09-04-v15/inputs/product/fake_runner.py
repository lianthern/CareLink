#!/usr/bin/env python3
"""Deterministic no-GPU runner used only by local state-machine tests."""
import argparse, hashlib, json, os, time
from pathlib import Path

parser=argparse.ArgumentParser(); parser.add_argument("--job-spec",required=True,type=Path); args=parser.parse_args()
spec=json.loads(args.job_spec.read_text(encoding="utf-8")); progress=Path(spec["progressPath"]); result=Path(spec["resultPath"])
for stage,value in (("fake prepare",.2),("fake run",.6),("fake export",.9)):
    temporary=progress.with_suffix(".tmp"); temporary.write_text(json.dumps({"stage":stage,"progress":value})+"\n"); os.replace(temporary,progress); time.sleep(.05)
payload={"schemaVersion":"1.0","status":"ready","kind":spec["kind"],"sceneRevisionId":spec["scene"]["revision_id"],"inputSha256":spec["inputSha256"],"fake":True}
if spec["kind"] == "scene_preview":
    viewer=Path(spec["productRoot"])/"scenes"/spec["scene"]["revision_id"]/"viewer"
    (viewer/"assets").mkdir(parents=True,exist_ok=True)
    (viewer/"index.html").write_text("<!doctype html><title>fake viewer</title>",encoding="utf-8")
    (viewer/"scene.json").write_text(json.dumps({"sceneRevisionId":spec["scene"]["revision_id"]})+"\n",encoding="utf-8")
    (viewer/"assets/scene.sog").write_bytes(b"fake-sog")
    payload["viewerRoot"]=str(viewer)
temporary=result.with_suffix(".tmp"); temporary.write_text(json.dumps(payload,indent=2)+"\n"); os.replace(temporary,result)
