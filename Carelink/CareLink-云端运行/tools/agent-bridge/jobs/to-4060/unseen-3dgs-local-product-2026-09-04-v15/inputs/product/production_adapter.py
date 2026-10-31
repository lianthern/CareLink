#!/usr/bin/env python3
"""Fail-closed contract for a future Hong Kong SceneWorker lease adapter.

The inspected production private-AI pull route handles short image-analysis
jobs. It does not yet provide renewable multi-hour scene leases, artifact
upload, or sceneRevisionId binding, so this adapter MUST remain disabled.
"""
from dataclasses import dataclass
from typing import Protocol

@dataclass(frozen=True)
class Lease:
    job_id: str
    scene_revision_id: str
    expires_at: str
    payload_sha256: str

class LeaseAdapter(Protocol):
    def lease(self) -> Lease | None: ...
    def heartbeat(self, lease: Lease, progress: float, stage: str) -> None: ...
    def begin_upload(self, lease: Lease, artifact_sha256: str, artifact_bytes: int) -> str: ...
    def complete(self, lease: Lease, upload_id: str) -> None: ...
    def fail(self, lease: Lease, retryable: bool, code: str) -> None: ...

class DisabledProductionAdapter:
    def __init__(self, *_args, **_kwargs):
        raise RuntimeError("production SceneWorker adapter is contract-pending and disabled; local/mock mode only")
