#!/usr/bin/env python3
"""Read-only gate for the runtime erratum + L3 Book Lab contract revision."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path


BASE = Path(os.environ.get("C3_CONTRACT_ROOT", Path(__file__).resolve().parents[2]))
PRODUCT = BASE / "product-ui"
TECH = BASE / "technical"
BOOK = Path(os.environ.get("C3_BOOK_CONTRACT_ROOT", BASE / "l3-book-lab"))
MUTATION_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
REQUIRED_OPERATION_FIELDS = {
    "authorization",
    "requestSchema",
    "successDTO",
    "stableErrors",
    "idempotency",
    "replayClass",
    "ifMatchOrVersion",
}
EXPECTED_BOOK_CAS = {
    "memory_interviews.version",
    "memory_question_jobs.version",
    "personal_memories.version",
    "memory_books.version",
    "book_contribution_grants.version",
    "book_draft_versions.version",
    "book_render_jobs.version",
    "book_version_access_controls.version",
}
EXPECTED_BOOK_MACHINES = {
    "memoryInterview",
    "bookAuthorization",
    "bookDraft",
    "bookVersion",
    "renderArtifact",
}
errors: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def value_at(document: dict, dotted_path: object) -> object:
    if not isinstance(dotted_path, str):
        return None
    value: object = document
    for key in dotted_path.split("."):
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    return value


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mutation_set_from_markdown(text: str) -> set[str]:
    output: set[str] = set()
    for pattern in (
        r"^\| `(POST|PUT|PATCH|DELETE) (/[^`]+)` \|",
        r"^- `(POST|PUT|PATCH|DELETE) (/[^`]+)`",
    ):
        output.update(
            f"{match.group(1)} {match.group(2)}"
            for match in re.finditer(pattern, text, re.MULTILINE)
        )
    return output


def operation_refs(coverage: dict) -> list[tuple[str, str, dict]]:
    output: list[tuple[str, str, dict]] = []

    def add(item: dict, source: str) -> None:
        method = item.get("method")
        endpoint = item.get("endpoint")
        if method in MUTATION_METHODS and isinstance(endpoint, str) and endpoint.startswith("/"):
            output.append((f"{method} {endpoint}", source, item))

    for action in coverage.get("actions", []):
        add(action, f"action:{action.get('actionId', '?')}")
        for step in action.get("workflowSteps", []):
            add(step, f"workflow:{action.get('actionId', '?')}:{step.get('operationId', '?')}")
    for operation in coverage.get("technicalOperationCoverage", []):
        add(operation, f"technical:{operation.get('operationId', '?')}")
    return output


def operation_gaps(coverage: dict) -> list[tuple[str, list[str]]]:
    gaps: list[tuple[str, list[str]]] = []

    def inspect(item: dict, source: str) -> None:
        missing = sorted(REQUIRED_OPERATION_FIELDS - set(item))
        if missing:
            gaps.append((source, missing))

    for action in coverage.get("actions", []):
        if action.get("method") in MUTATION_METHODS | {"WORKFLOW"}:
            inspect(action, f"action:{action.get('actionId', '?')}")
        for step in action.get("workflowSteps", []):
            if step.get("method") in MUTATION_METHODS:
                inspect(step, f"workflow:{action.get('actionId', '?')}:{step.get('operationId', '?')}")
    for operation in coverage.get("technicalOperationCoverage", []):
        inspect(operation, f"technical:{operation.get('operationId', '?')}")
    for operation in coverage.get("internalOperationCoverage", []):
        inspect(operation, f"internal:{operation.get('operationId', '?')}")
    return gaps


def source_projection(registry: list[dict], coverage: list[dict]) -> tuple[list[dict], list[dict]]:
    left = [
        {
            "actionId": item["id"],
            "sourceEntry": item["entry"],
            "sourceRoute": item["route"],
            "sourceReturnTarget": item["returnTarget"],
            "sourceActor": item["actor"],
        }
        for item in sorted(registry, key=lambda item: item["id"])
    ]
    right = [
        {
            "actionId": item["actionId"],
            "sourceEntry": item["sourceEntry"],
            "sourceRoute": item["sourceRoute"],
            "sourceReturnTarget": item["sourceReturnTarget"],
            "sourceActor": item["sourceActor"],
        }
        for item in sorted(coverage, key=lambda item: item["actionId"])
    ]
    return left, right


core_registry_path = PRODUCT / "ACTION-REGISTRY.json"
core_catalog_path = PRODUCT / "STRING-CATALOG.zh-CN.json"
core_tokens_path = PRODUCT / "DESIGN-TOKENS.json"
core_coverage_path = TECH / "ACTION-API-COVERAGE.json"
core_canonical_path = TECH / "CANONICAL-STATE-AND-API.md"
core_flow_path = TECH / "CORE-FLOW-CONTRACT.md"
core_release_path = TECH / "RELEASE-READINESS-CONTRACT.md"
core_registry_doc = read_json(core_registry_path)
core_catalog = read_json(core_catalog_path)
core_tokens = read_json(core_tokens_path)
core_coverage = read_json(core_coverage_path)
core_canonical = core_canonical_path.read_text()
core_flow = core_flow_path.read_text()
core_release = core_release_path.read_text()

for key, path in (
    ("actionRegistry", core_registry_path),
    ("stringCatalog", core_catalog_path),
    ("designTokens", core_tokens_path),
):
    snapshot = core_coverage["sourceSnapshot"][key]
    check(sha256(path) == snapshot["sha256"], f"core source hash drift: {key}")
    check(path.stat().st_size == snapshot["bytes"], f"core source byte drift: {key}")

core_registry = core_registry_doc["actions"]
core_actions = core_coverage["actions"]
core_ids = [item["id"] for item in core_registry]
core_coverage_ids = [item["actionId"] for item in core_actions]
core_catalog_ids = list(core_catalog["actions"])
check(len(core_ids) == len(set(core_ids)) == 90, "core registry must contain 90 unique actions")
check(len(core_coverage_ids) == len(set(core_coverage_ids)) == 90, "core coverage must contain 90 unique actions")
check(set(core_ids) == set(core_coverage_ids) == set(core_catalog_ids), "core action-set drift")
check(source_projection(core_registry, core_actions)[0] == source_projection(core_registry, core_actions)[1], "core source projection drift")
core_phase_pairs = sum(len(phases) for phases in core_catalog["actions"].values())
check(len(core_registry_doc["phases"]) == len(core_catalog["phaseOrder"]) == 9 and core_phase_pairs == 810, "core phase count drift")

core_canonical_mutations = mutation_set_from_markdown(core_canonical)
core_refs = operation_refs(core_coverage)
core_coverage_mutations = {endpoint for endpoint, _, _ in core_refs}
check(len(core_canonical_mutations) == len(core_coverage_mutations) == 59, "core mutation count drift")
check(core_canonical_mutations == core_coverage_mutations, "core canonical/coverage mutation-set drift")
check(not operation_gaps(core_coverage), f"core operation gaps: {operation_gaps(core_coverage)}")

dictionary_section = core_canonical.split("### 4.2 集合字段")[0].split("### 4.1 唯一 Version/CAS Dictionary", 1)[1]
core_canonical_cas = set(re.findall(r"`([a-z][a-z0-9_]*\.(?:version|sessionEpoch|placementAuthorizationVersion))`", dictionary_section))
core_coverage_cas = set(core_coverage["versionCasDictionary"]["allowedFields"])
check(
    len(core_canonical_cas) == 55
    and len(core_coverage_cas) == 47
    and core_coverage_cas.isdisjoint(EXPECTED_BOOK_CAS)
    and core_canonical_cas == core_coverage_cas | EXPECTED_BOOK_CAS,
    "core/book CAS dictionary partition drift",
)
check(len(core_coverage.get("technicalOperationCoverage", [])) == 8, "core technical operation count drift")
core_internal = core_coverage.get("internalOperationCoverage", [])
check(len(core_internal) == 2, "core internal operation count drift")
check({item.get("operationId") for item in core_internal} == {"CAMPAIGN.SWEEP_EXPIRATIONS", "IDENTITY.REKEY_EQUIVALENCES"}, "core internal operation set drift")

core_security = core_coverage["summary"]["securityCoverage"]
for key, value in {
    "versionCasDictionaryFields": 47,
    "technicalOperationEntries": 8,
    "internalOperationEntries": 2,
    "canonicalHttpMutationUniqueEndpoints": 59,
    "coverageMutationUniqueEndpoints": 59,
    "canonicalHttpMutationSetEqualityMissing": 0,
    "canonicalHttpMutationSetEqualityOrphan": 0,
    "internalOperationGaps": 0,
}.items():
    check(core_security.get(key) == value, f"core security summary drift: {key}")

def by_action(action_id: str) -> dict:
    return next((item for item in core_actions if item.get("actionId") == action_id), {})


def by_operation(operation_id: str) -> dict:
    return next(
        (
            item
            for item in core_coverage.get("technicalOperationCoverage", []) + core_internal
            if item.get("operationId") == operation_id
        ),
        {},
    )


def contains_all(value: object, fragments: tuple[str, ...]) -> bool:
    return isinstance(value, str) and all(fragment in value for fragment in fragments)


# Runtime remediation A–D: A media, B identity, C support, D deletion.
rekey = by_operation("IDENTITY.REKEY_EQUIVALENCES")
check(
    rekey.get("endpoint") == "internal:identity-equivalence-rekey"
    and rekey.get("coverageKind") == "internal_exclusive_transaction"
    and rekey.get("replayClass") == "completed_state"
    and contains_all(rekey.get("authorization"), ("identity-namespace exclusive lease", "least-privilege KMS decrypt/encrypt role"))
    and contains_all(rekey.get("idempotency"), ("decrypt every active normalized-identity envelope", "atomically switch all rows or write none"))
    and contains_all(rekey.get("ifMatchOrVersion"), ("exclusive loaded-version full-table transaction", "rolls back every row")),
    "runtime B identity full-table rekey drift",
)
check(
    contains_all(core_canonical, ("内部操作`IDENTITY.REKEY_EQUIVALENCES`", "identity namespace排他lease", "零部分写"))
    and contains_all(core_canonical, ("normalizedIdentifierCiphertext", "normalizedIdentifierEnvelopeKeyId", "normalizedIdentifierEnvelopeFormat", "独立`k_identity_envelope`", "AAD精确绑定"))
    and contains_all(core_flow, ("旧`k_equivalence` collision-key epoch/material", "整表stage→计数/唯一性校验→原子swap"))
    and contains_all(core_release, ("旧`k_equivalence` collision-key epoch/material", "排他整表stage/verify/atomic-swap")),
    "runtime B cross-document drift",
)

support = by_action("SUPPORT.SUBMIT_SAFETY_LEAD")
zero_write_rows = "rate/dedupe/audit/idempotency/case/session/credential/actor"
check(
    support.get("requestSchema") == "CreateSupportCaseRequest{category,description}; contact, targetObjectId, photoId, spaceId and every other unknown field are unsupported_field"
    and contains_all(support.get("authorization"), ("before any durable write", zero_write_rows))
    and contains_all(support.get("ifMatchOrVersion"), ("full database before/after snapshot", zero_write_rows, "any other durable row")),
    "runtime C support zero-durable-write drift",
)
check(
    contains_all(core_flow, ("数据库前后快照", zero_write_rows, "全部零新增、零改变"))
    and contains_all(core_release, ("数据库前后快照", zero_write_rows, "全部零新增、零改变")),
    "runtime C cross-document drift",
)

account_delete = by_action("ACCOUNT.DELETE_REQUEST")
check(
    account_delete.get("replayClass") == "credential_reissue"
    and contains_all(account_delete.get("authorization"), ("presented reauth-grant credential family", "sole idempotency principal/scope", "never the Account or account-session principal", "Completed-replay-only branch: no live account authority is required", "original consumed reauth credential family", "idempotency_records.responseRef", "createdByIdempotencyRecordId"))
    and contains_all(account_delete.get("idempotency"), ("presented exact-purpose reauth-grant credential family", "never Account/account-session principal", "same deletion_status_sessions.version", "without rerunning deletion"))
    and contains_all(account_delete.get("ifMatchOrVersion"), ("createdByIdempotencyRecordId", "zero deletion/account/business-state transition")),
    "runtime D deletion reauth-family scope drift",
)
check(
    contains_all(account_delete.get("successDTO"), ("__Host-unseen_deletion_status", "clears __Host-unseen_account", "raw credential never appears in body")),
    "runtime D deletion status-cookie drift",
)
deletion_status = by_action("DELETION.OPEN_STATUS")
check(
    contains_all(deletion_status.get("authorization"), ("exact live __Host-unseen_deletion_status session", "bound to this deletionRequestId", "cross-request"))
    and contains_all(deletion_status.get("ifMatchOrVersion"), ("deletion_status_sessions.version", "no increment")),
    "runtime D deletion status-read drift",
)
check(
    contains_all(core_canonical, ("唯一特例是`ACCOUNT.DELETE_REQUEST`", "presented reauth-grant credential family", "禁止首次按Account或account-session principal建记录"))
    and contains_all(core_flow, ("原始已消费reauth credential family", "零删除/account重执行"))
    and contains_all(core_release, ("原始已消费reauth credential family", "禁止重跑删除或恢复account authority")),
    "runtime D cross-document drift",
)

scene = by_action("PHOTO.RETURN_TO_SCENE")
panorama_read = by_operation("VIEWER.PANORAMA_MEDIA.READ")
photo_read = by_operation("VIEWER.PHOTO_MEDIA.READ")
check(
    contains_all(scene.get("successDTO"), (
        "panorama{url=/v1/viewer/spaces/{sid}/panorama-revisions/{rid}/media,revisionId,assetId,assetVersion,sha256",
        "photoMedia{url=/v1/viewer/spaces/{sid}/photos/{pid}/media,assetId,assetVersion,sha256",
        "each media response ETag must equal its DTO sha256 before decode",
    ))
    and contains_all(scene.get("authorization"), ("one mutually exclusive account/external effective-view branch", "visible photo", "placement=confirmed on current panorama revision", "sceneReadiness=ready"))
    and contains_all(panorama_read.get("authorization"), ("exactly one current account or external effective-view session branch", "sceneReadiness=ready", "sceneMode=rotation360", "spaces.currentPanoramaRevisionId=rid", "ready and non-retired"))
    and contains_all(panorama_read.get("ifMatchOrVersion"), ("exact assetId+assetVersion", "response ETag must equal the DTO sha256", "observed bytes <= 33,554,432"))
    and contains_all(photo_read.get("authorization"), ("exactly one current account or external effective-view session branch", "photos.viewerSafeAssetId", "same-Space", "bound to that photo", "EXIF/GPS-stripped", "confirmed placement on the current panorama"))
    and contains_all(photo_read.get("ifMatchOrVersion"), ("exact viewer-safe assetId+assets.version", "response ETag must equal the DTO sha256"))
    and contains_all(panorama_read.get("idempotency"), ("side-effect free", "never create or consume"))
    and contains_all(photo_read.get("idempotency"), ("side-effect free", "never create or consume")),
    "runtime A viewer asset/predicate drift",
)
check(
    contains_all(core_canonical, ("revisionId, assetId, assetVersion, sha256", "assetId, assetVersion, sha256", "revision ready且未retired"))
    and contains_all(core_flow, ("viewer panorama/photo媒体只经同源session-auth", "v1 panorama上限固定32 MiB"))
    and contains_all(core_release, ("scene-context必须冻结panorama与viewer-safe photo derivative各自的`assetId + assetVersion + sha256", "客户端在解码前逐字比对响应ETag", "33,554,432 bytes", "33,554,433 bytes")),
    "runtime A cross-document drift",
)

receipt_recovery = next((item for item in core_actions if item["actionId"] == "BATCH.RECOVER_FROM_ACCOUNT"), {})
check("receipt_recovery_unavailable" in receipt_recovery.get("stableErrors", []) and "recovery_unavailable" not in receipt_recovery.get("stableErrors", []), "receipt recovery error drift")
check(core_tokens.get("breakpoint") == {"mobileMax": 1247, "desktopMin": 1248} and "mobile `<=1247px`、desktop `>=1248px`" in core_release_path.read_text(), "responsive breakpoint drift")
check("只允许遗弃grant写`bootstrapExpiredAt`并把pending减一次" in core_flow, "core abandoned grant regression missing")

book_contract_path = BOOK / "BOOK-LAB-CONTRACT.md"
book_registry_path = BOOK / "ACTION-REGISTRY.book-lab.json"
book_catalog_path = BOOK / "STRING-CATALOG.book-lab.zh-CN.json"
book_coverage_path = BOOK / "ACTION-API-COVERAGE.book-lab.json"
book_state_path = BOOK / "STATE-MACHINES.book-lab.json"
book_contract = book_contract_path.read_text()
book_registry_doc = read_json(book_registry_path)
book_catalog = read_json(book_catalog_path)
book_coverage = read_json(book_coverage_path)
book_state = read_json(book_state_path)
book_registry = book_registry_doc["actions"]
book_actions = book_coverage["actions"]
book_ids = [item["id"] for item in book_registry]
book_coverage_ids = [item["actionId"] for item in book_actions]
book_catalog_ids = list(book_catalog["actions"])
book_state_action_ids = list(book_state["actionTransitionCoverage"])
check(len(book_ids) == len(set(book_ids)) == 20, "book registry must contain 20 unique actions")
check(len(book_coverage_ids) == len(set(book_coverage_ids)) == 20, "book coverage must contain 20 unique actions")
check(set(book_ids) == set(book_coverage_ids) == set(book_catalog_ids) == set(book_state_action_ids), "book action-set drift")
check(set(core_ids).isdisjoint(book_ids), "core/book action ID overlap")
check(source_projection(book_registry, book_actions)[0] == source_projection(book_registry, book_actions)[1], "book source projection drift")
book_phase_pairs = sum(len(phases) for phases in book_catalog["actions"].values())
check(len(book_registry_doc["phases"]) == len(book_catalog["phaseOrder"]) == 9 and book_phase_pairs == 180, "book phase count drift")
check(all(isinstance(value, str) and value.strip() for phases in book_catalog["actions"].values() for value in phases.values()), "book empty/non-string phase")
for action in book_actions:
    if action.get("method") == "GET":
        check(action.get("replayClass") == "not_applicable", f"book query replayClass drift: {action['actionId']}")
    elif action.get("method") in MUTATION_METHODS:
        check(action.get("replayClass") in {"ordinary_dto", "completed_state"}, f"book mutation replayClass drift: {action['actionId']}")
        check(action.get("replayClass") not in {"safe_read", "safe_same_result"}, f"book mutation uses forbidden replayClass: {action['actionId']}")

book_canonical_mutations = mutation_set_from_markdown(book_contract)
book_refs = operation_refs(book_coverage)
book_coverage_mutations = {endpoint for endpoint, _, _ in book_refs}
check(len(book_canonical_mutations) == len(book_coverage_mutations) == 15, "book mutation count drift")
check(book_canonical_mutations == book_coverage_mutations, "book canonical/coverage mutation-set drift")
check(all(endpoint.split(" ", 1)[1].startswith("/v2-labs/") for endpoint in book_coverage_mutations), "book mutation outside /v2-labs/**")
check(not book_coverage.get("technicalOperationCoverage"), "book technical operations must be zero")
book_internal = book_coverage.get("internalOperationCoverage", [])
check(len(book_internal) == 2, "book internal operation count drift")
check(
    {(item.get("operationId"), item.get("endpoint")) for item in book_internal}
    == {
        ("QUESTION_PROCESSOR", "internal:book-lab-question-processor"),
        ("BOOK_RENDER_PROCESSOR", "internal:book-lab-render-processor"),
    },
    "book internal operation set drift",
)
book_http_coverage = dict(book_coverage)
book_http_coverage["internalOperationCoverage"] = []
check(not operation_gaps(book_http_coverage), f"book HTTP operation gaps: {operation_gaps(book_http_coverage)}")
book_internal_required = {
    "operationId",
    "endpoint",
    "kind",
    "consumes",
    "inputRows",
    "authorization",
    "idempotency",
    "ifMatchOrVersion",
    "successEvents",
    "failureEvents",
    "forbidden",
}
check(
    all(not (book_internal_required - set(item)) for item in book_internal),
    "book internal operation field gap",
)
check(all(item.get("replayClass") == "completed_state" for item in book_internal), "book internal replayClass drift")
book_cas = set(book_coverage["versionCasDictionary"])
check(book_cas == EXPECTED_BOOK_CAS, f"book CAS dictionary drift: {sorted(book_cas)}")

book_machines = book_state["machines"]
check(set(book_machines) == EXPECTED_BOOK_MACHINES, f"book state-machine set drift: {sorted(book_machines)}")
book_enum_locks = book_registry_doc.get("equalityLock", {}).get("stateEnumEquality", [])
check(len(book_enum_locks) == len(EXPECTED_BOOK_MACHINES), f"book state-enum lock count drift: {len(book_enum_locks)}")
for lock in book_enum_locks:
    schema_path = lock.get("schemaPath")
    machine_path = lock.get("machinePath")
    schema_states = value_at(book_coverage, schema_path)
    machine_states = value_at(book_state, machine_path)
    label = f"{schema_path or '?'}<->{machine_path or '?'}"
    check(lock.get("comparison") == "exact_set", f"book state-enum comparison drift: {label}:{lock.get('comparison')}")
    check(
        isinstance(schema_states, list) and isinstance(machine_states, list),
        f"book state-enum path missing: {label}",
    )
    if isinstance(schema_states, list) and isinstance(machine_states, list):
        check(set(schema_states) == set(machine_states), f"book state-enum exact-set drift: {label}")

for machine_name, machine in book_machines.items():
    states = set(machine.get("states", []))
    check(machine.get("initial") in states, f"book machine initial absent: {machine_name}")
    check(set(machine.get("terminal", [])) <= states, f"book machine terminal absent: {machine_name}")
    for transition in machine.get("transitions", []):
        check(set(transition.get("from", [])) <= states, f"book machine transition from absent: {machine_name}")
        check(transition.get("to") in states, f"book machine transition to absent: {machine_name}")

frozen_book_manifest = book_coverage.get("schemaDefinitions", {}).get("FrozenBookManifest", {})
check(
    "title" in frozen_book_manifest.get("required", [])
    and "locked current BookDraft" in frozen_book_manifest.get("properties", {}).get("title", "")
    and "including exact title" in frozen_book_manifest.get("properties", {}).get("manifestHash", ""),
    "book frozen manifest title/hash drift",
)
check(
    "required `FrozenBookManifest.title`" in book_contract
    and "manifestHash` 覆盖精确冻结书名" in book_contract
    and "manifestHash为省略自身manifestHash字段后的canonical manifest SHA-256并覆盖title" in core_canonical,
    "book frozen title cross-document drift",
)

for action in book_actions:
    if action.get("method") in MUTATION_METHODS:
        check("Idempotency-Key required" in action.get("idempotency", ""), f"book idempotency missing: {action['actionId']}")
        check("If-Match" in action.get("ifMatchOrVersion", "") or "If-None-Match" in action.get("ifMatchOrVersion", ""), f"book CAS missing: {action['actionId']}")
check(book_coverage.get("summary", {}).get("apiCoverage") == {"queryActions": 5, "mutationActions": 15, "mutationEndpoints": 15, "mutationSetMissing": 0, "mutationSetOrphan": 0}, "book API summary drift")

aggregate = {
    "actions": len(core_ids) + len(book_ids),
    "sourceRefs": len(core_ids) * 4 + len(book_ids) * 4,
    "phases": core_phase_pairs + book_phase_pairs,
    "canonicalMutations": len(core_canonical_mutations) + len(book_canonical_mutations),
    "coverageMutations": len(core_coverage_mutations) + len(book_coverage_mutations),
    "cas": len(core_coverage_cas) + len(book_cas),
    "technical": len(core_coverage["technicalOperationCoverage"]) + len(book_coverage.get("technicalOperationCoverage", [])),
    "internal": len(core_internal) + len(book_internal),
}
check(aggregate == {"actions": 110, "sourceRefs": 440, "phases": 990, "canonicalMutations": 74, "coverageMutations": 74, "cas": 55, "technical": 8, "internal": 4}, f"aggregate drift: {aggregate}")

contract_text = "\n".join(path.read_text(errors="ignore") for path in (core_canonical_path, core_flow_path, core_release_path, book_contract_path))
for pattern in (
    r"AKIA[0-9A-Z]{16}",
    r"AIza[0-9A-Za-z_-]{30,}",
    r"sk-[A-Za-z0-9_-]{20,}",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
):
    check(re.search(pattern, contract_text) is None, f"possible secret pattern matched: {pattern}")

print(f"CORE ACTIONS={len(core_ids)} SOURCE_REFS={len(core_ids) * 4} PHASES={core_phase_pairs} MUTATIONS={len(core_canonical_mutations)} CAS={len(core_coverage_cas)} TECHNICAL={len(core_coverage['technicalOperationCoverage'])} INTERNAL={len(core_internal)}")
print(f"BOOK ACTIONS={len(book_ids)} SOURCE_REFS={len(book_ids) * 4} PHASES={book_phase_pairs} MUTATIONS={len(book_canonical_mutations)} CAS={len(book_cas)} TECHNICAL={len(book_coverage.get('technicalOperationCoverage', []))} INTERNAL={len(book_internal)} MACHINES={len(book_machines)}")
print("AGGREGATE " + " ".join(f"{key.upper()}={value}" for key, value in aggregate.items()))
print(f"ERRORS={len(errors)}")
for error in errors:
    print(f"FAIL {error}")
sys.exit(1 if errors else 0)
