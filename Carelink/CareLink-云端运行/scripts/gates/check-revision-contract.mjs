#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [repoArg, bookArg] = process.argv.slice(2);
const repoRoot = path.resolve(repoArg ?? "/Users/max/code/unseen-worktrees/root-maintenance");
const coreRoot = path.join(repoRoot, "contracts/source");
const bookRoot = path.resolve(bookArg ?? "/tmp/unseen-book-lab-contract-draft");
const failures = [];

const expected = {
  core: { actions: 90, refs: 360, phases: 810, canonicalMutations: 59, coverageMutations: 59, cas: 47, technical: 8, internal: 2 },
  book: { actions: 20, refs: 80, phases: 180, canonicalMutations: 15, coverageMutations: 15, cas: 8, technical: 0, internal: 2, states: 5 },
  aggregate: { actions: 110, refs: 440, phases: 990, canonicalMutations: 74, coverageMutations: 74, cas: 55, technical: 8, internal: 4 }
};

const exactBookMachines = [
  "bookAuthorization",
  "bookDraft",
  "bookVersion",
  "memoryInterview",
  "renderArtifact"
];
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const requiredOperationFields = new Set([
  "authorization",
  "requestSchema",
  "successDTO",
  "stableErrors",
  "idempotency",
  "replayClass",
  "ifMatchOrVersion"
]);

function check(condition, message) {
  if (!condition) failures.push(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function bytes(relative) {
  return readFile(path.join(coreRoot, relative));
}

async function jsonAt(root, filename) {
  return JSON.parse(await readFile(path.join(root, filename), "utf8"));
}

function sorted(values) {
  return [...values].sort();
}

function sameSet(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function valueAt(document, dottedPath) {
  if (typeof dottedPath !== "string") return undefined;
  return dottedPath.split(".").reduce(
    (value, key) => (
      value && typeof value === "object" && Object.hasOwn(value, key) ? value[key] : undefined
    ),
    document
  );
}

function operationSet(coverage) {
  const refs = [];
  const add = (item, source) => {
    if (mutationMethods.has(item?.method) && typeof item?.endpoint === "string" && item.endpoint.startsWith("/")) {
      refs.push({ key: `${item.method} ${item.endpoint}`, source, item });
    }
  };
  for (const action of coverage.actions ?? []) {
    add(action, `action:${action.actionId}`);
    for (const step of action.workflowSteps ?? []) add(step, `workflow:${action.actionId}:${step.operationId ?? "?"}`);
  }
  for (const operation of coverage.technicalOperationCoverage ?? []) add(operation, `technical:${operation.operationId}`);
  return { refs, unique: new Set(refs.map((entry) => entry.key)) };
}

function markdownMutationSet(text) {
  const output = new Set();
  for (const pattern of [
    /^\| `(POST|PUT|PATCH|DELETE) (\/[^`]+)` \|/gm,
    /^- `(POST|PUT|PATCH|DELETE) (\/[^`]+)`/gm
  ]) {
    for (const match of text.matchAll(pattern)) output.add(`${match[1]} ${match[2]}`);
  }
  return output;
}

function sourceProjection(registry, coverage) {
  const left = [...registry].sort((a, b) => a.id.localeCompare(b.id)).map((entry) => ({
    actionId: entry.id,
    sourceEntry: entry.entry,
    sourceRoute: entry.route,
    sourceReturnTarget: entry.returnTarget,
    sourceActor: entry.actor
  }));
  const right = [...coverage].sort((a, b) => a.actionId.localeCompare(b.actionId)).map((entry) => ({
    actionId: entry.actionId,
    sourceEntry: entry.sourceEntry,
    sourceRoute: entry.sourceRoute,
    sourceReturnTarget: entry.sourceReturnTarget,
    sourceActor: entry.sourceActor
  }));
  return { left, right };
}

function operationGaps(coverage) {
  const gaps = [];
  const inspect = (operation, label) => {
    const missing = [...requiredOperationFields].filter((field) => !Object.hasOwn(operation, field));
    if (missing.length) gaps.push([label, missing]);
  };
  for (const action of coverage.actions ?? []) {
    if (mutationMethods.has(action.method) || action.method === "WORKFLOW") inspect(action, `action:${action.actionId}`);
    for (const step of action.workflowSteps ?? []) if (mutationMethods.has(step.method)) inspect(step, `workflow:${action.actionId}:${step.operationId ?? "?"}`);
  }
  for (const operation of coverage.technicalOperationCoverage ?? []) inspect(operation, `technical:${operation.operationId ?? "?"}`);
  for (const operation of coverage.internalOperationCoverage ?? []) inspect(operation, `internal:${operation.operationId ?? "?"}`);
  return gaps;
}

const coreRegistryBytes = await bytes("product-ui/ACTION-REGISTRY.json");
const coreCatalogBytes = await bytes("product-ui/STRING-CATALOG.zh-CN.json");
const coreTokensBytes = await bytes("product-ui/DESIGN-TOKENS.json");
const coreRegistryDoc = JSON.parse(coreRegistryBytes);
const coreCatalog = JSON.parse(coreCatalogBytes);
const coreCoverage = await jsonAt(path.join(coreRoot, "technical"), "ACTION-API-COVERAGE.json");
const coreCanonical = await readFile(path.join(coreRoot, "technical/CANONICAL-STATE-AND-API.md"), "utf8");
const requiredBookPersistenceFragments = [
  "status(eligible/question_queued/question_ready/question_failed/draft/followup_queued/followup_ready/confirmed/skipped/withdrawal_pending/withdrawn)",
  "PersonalMemory.status/interviewVersion`逐字投影同一snapshot的`memory_interviews.status/version",
  "status(empty/editing/preview_queued/preview_ready/preview_failed/stale/freeze_checking/frozen)",
  "status(rendering/available/render_failed/withdrawal_affected/superseded)",
  "status(queued/rendering_html/html_ready/rendering_pdf/verifying/available/failed/revoked/purged)",
  "unique(spaceId,photoId,contributorPrincipalId)",
  "START必须在一个serializable事务创建`memory_interviews(status=question_queued,version=1) + personal_memories(version=1, head/confirmed/currentRevision均null) + memory_question_jobs(version=1)`",
  "SKIP必须在一个serializable事务创建`memory_interviews(status=skipped,version=1) + personal_memories(version=1, head/confirmed/currentRevision均null)`且不建question job",
  "| `render_artifacts` |",
  "versionId(unique FK)、draftVersionId nullable provenance",
  "| `immutable_frozen_book_manifests` |",
  "| `immutable_authorized_memory_text_snapshots` |",
  "| `immutable_frozen_book_assets` |"
];
check(requiredBookPersistenceFragments.every((fragment) => coreCanonical.includes(fragment)), "core/book persistence-state mapping drift");

const coreRegistry = coreRegistryDoc.actions;
const coreIds = coreRegistry.map((entry) => entry.id);
const coreCoverageIds = coreCoverage.actions.map((entry) => entry.actionId);
const coreCatalogIds = Object.keys(coreCatalog.actions);
const coreProjection = sourceProjection(coreRegistry, coreCoverage.actions);
const corePhases = Object.values(coreCatalog.actions).reduce((total, phases) => total + Object.keys(phases).length, 0);
const coreCanonicalMutations = markdownMutationSet(coreCanonical);
const coreOperations = operationSet(coreCoverage);
const coreCas = coreCoverage.versionCasDictionary.allowedFields;
const coreTechnical = coreCoverage.technicalOperationCoverage ?? [];
const coreInternal = coreCoverage.internalOperationCoverage ?? [];

check(coreIds.length === expected.core.actions && new Set(coreIds).size === expected.core.actions, "core action count/uniqueness drift");
check(sameSet(coreIds, coreCoverageIds) && sameSet(coreIds, coreCatalogIds), "core registry/catalog/coverage action set drift");
check(JSON.stringify(coreProjection.left) === JSON.stringify(coreProjection.right), "core source projection drift");
check(coreIds.length * 4 === expected.core.refs, "core source reference count drift");
check(coreRegistryDoc.phases.length === 9 && coreCatalog.phaseOrder.length === 9 && corePhases === expected.core.phases, "core phase count drift");
check(coreCanonicalMutations.size === expected.core.canonicalMutations, `core canonical mutation count ${coreCanonicalMutations.size}`);
check(coreOperations.unique.size === expected.core.coverageMutations, `core coverage mutation count ${coreOperations.unique.size}`);
check(sameSet(coreCanonicalMutations, coreOperations.unique), "core canonical/coverage mutation set drift");
check(coreCas.length === expected.core.cas && new Set(coreCas).size === expected.core.cas, `core CAS count ${coreCas.length}`);
check(coreTechnical.length === expected.core.technical, `core technical operation count ${coreTechnical.length}`);
check(coreInternal.length === expected.core.internal, `core internal operation count ${coreInternal.length}`);
check(operationGaps(coreCoverage).length === 0, `core operation contract gaps ${JSON.stringify(operationGaps(coreCoverage))}`);
for (const [key, sourceBytes] of [["actionRegistry", coreRegistryBytes], ["stringCatalog", coreCatalogBytes], ["designTokens", coreTokensBytes]]) {
  const snapshot = coreCoverage.sourceSnapshot[key];
  check(snapshot.sha256 === sha256(sourceBytes) && snapshot.bytes === sourceBytes.length, `core ${key} snapshot drift`);
}

const bookRegistryDoc = await jsonAt(bookRoot, "ACTION-REGISTRY.book-lab.json");
const bookCatalog = await jsonAt(bookRoot, "STRING-CATALOG.book-lab.zh-CN.json");
const bookCoverage = await jsonAt(bookRoot, "ACTION-API-COVERAGE.book-lab.json");
const bookState = await jsonAt(bookRoot, "STATE-MACHINES.book-lab.json");
const bookContract = await readFile(path.join(bookRoot, "BOOK-LAB-CONTRACT.md"), "utf8");

const bookRegistry = bookRegistryDoc.actions;
const bookIds = bookRegistry.map((entry) => entry.id);
const bookCoverageIds = bookCoverage.actions.map((entry) => entry.actionId);
const bookCatalogIds = Object.keys(bookCatalog.actions);
const bookStateActionIds = Object.keys(bookState.actionTransitionCoverage ?? {});
const bookProjection = sourceProjection(bookRegistry, bookCoverage.actions);
const bookPhases = Object.values(bookCatalog.actions).reduce((total, phases) => total + Object.keys(phases).length, 0);
const bookCanonicalMutations = markdownMutationSet(bookContract);
const bookOperations = operationSet(bookCoverage);
const bookCas = Object.keys(bookCoverage.versionCasDictionary ?? {});
const bookTechnical = bookCoverage.technicalOperationCoverage ?? [];
const bookInternal = bookCoverage.internalOperationCoverage ?? [];
const bookMachines = Object.keys(bookState.machines ?? {});

for (const action of bookCoverage.actions) {
  if (action.method === "GET") check(action.replayClass === "not_applicable", `book query replayClass ${action.actionId}:${action.replayClass}`);
  else if (mutationMethods.has(action.method)) {
    check(["ordinary_dto", "completed_state"].includes(action.replayClass), `book mutation replayClass ${action.actionId}:${action.replayClass}`);
    check(!["safe_read", "safe_same_result"].includes(action.replayClass), `book forbidden mutation replayClass ${action.actionId}:${action.replayClass}`);
  }
}

check(bookIds.length === expected.book.actions && new Set(bookIds).size === expected.book.actions, "book action count/uniqueness drift");
check(sameSet(bookIds, bookCoverageIds) && sameSet(bookIds, bookCatalogIds) && sameSet(bookIds, bookStateActionIds), "book registry/catalog/coverage/state action set drift");
check(JSON.stringify(bookProjection.left) === JSON.stringify(bookProjection.right), "book source projection drift");
check(bookIds.length * 4 === expected.book.refs, "book source reference count drift");
check(bookRegistryDoc.phases.length === 9 && bookCatalog.phaseOrder.length === 9 && bookPhases === expected.book.phases, "book phase count drift");
check(new Set(coreIds.filter((id) => new Set(bookIds).has(id))).size === 0, "core/book action overlap");
check(bookCanonicalMutations.size === expected.book.canonicalMutations, `book canonical mutation count ${bookCanonicalMutations.size}; BOOK-LAB-CONTRACT needs an independent endpoint inventory`);
check(bookOperations.unique.size === expected.book.coverageMutations, `book coverage mutation count ${bookOperations.unique.size}`);
check(sameSet(bookCanonicalMutations, bookOperations.unique), "book canonical/coverage mutation set drift");
check(bookCas.length === expected.book.cas && new Set(bookCas).size === expected.book.cas, `book CAS count ${bookCas.length}`);
check(bookTechnical.length === expected.book.technical, `book technical operation count ${bookTechnical.length}`);
check(bookInternal.length === expected.book.internal, `book internal operation count ${bookInternal.length}`);
const bookHttpCoverage = structuredClone(bookCoverage);
bookHttpCoverage.internalOperationCoverage = [];
check(operationGaps(bookHttpCoverage).length === 0, `book HTTP operation contract gaps ${JSON.stringify(operationGaps(bookHttpCoverage))}`);
const bookInternalSet = new Set(bookInternal.map((entry) => `${entry.operationId}|${entry.endpoint}`));
check(sameSet(bookInternalSet, new Set([
  "QUESTION_PROCESSOR|internal:book-lab-question-processor",
  "BOOK_RENDER_PROCESSOR|internal:book-lab-render-processor"
])), `book internal operation set ${JSON.stringify(sorted(bookInternalSet))}`);
const bookInternalRequired = ["operationId", "endpoint", "kind", "consumes", "inputRows", "authorization", "idempotency", "ifMatchOrVersion", "successEvents", "failureEvents", "forbidden"];
check(bookInternal.every((entry) => bookInternalRequired.every((field) => Object.hasOwn(entry, field))), "book internal operation field gap");
check(bookInternal.every((entry) => entry.replayClass === "completed_state"), `book internal replayClass ${JSON.stringify(bookInternal.map((entry) => [entry.operationId, entry.replayClass]))}`);
check(bookMachines.length === expected.book.states && sameSet(bookMachines, exactBookMachines), `book state-machine set ${JSON.stringify(sorted(bookMachines))}`);

const bookEnumLocks = bookRegistryDoc.equalityLock?.stateEnumEquality ?? [];
check(bookEnumLocks.length === expected.book.states, `book state-enum lock count ${bookEnumLocks.length}`);
for (const lock of bookEnumLocks) {
  const schemaStates = valueAt(bookCoverage, lock.schemaPath);
  const machineStates = valueAt(bookState, lock.machinePath);
  const label = `${lock.schemaPath ?? "?"}<->${lock.machinePath ?? "?"}`;
  check(lock.comparison === "exact_set", `book state-enum comparison drift ${label}:${lock.comparison}`);
  check(Array.isArray(schemaStates) && Array.isArray(machineStates), `book state-enum path missing ${label}`);
  if (Array.isArray(schemaStates) && Array.isArray(machineStates)) {
    check(sameSet(new Set(schemaStates), new Set(machineStates)), `book state-enum exact-set drift ${label}`);
  }
}

const bookActionById = new Map(bookCoverage.actions.map((entry) => [entry.actionId, entry]));
for (const actionId of ["MEMORY.SAVE_ANSWER_DRAFT", "MEMORY.REQUEST_FOLLOWUP", "MEMORY.CONFIRM", "MEMORY.WITHDRAW"]) {
  const action = bookActionById.get(actionId);
  const request = bookCoverage.schemaDefinitions?.[action?.requestSchema];
  check(action?.ifMatchOrVersion?.includes("memory_interviews.version") && action.ifMatchOrVersion.includes("personal_memories.version"), `book ${actionId} dual memory CAS drift`);
  check(request?.required?.includes("interviewIfMatchVersion") && request?.properties?.interviewIfMatchVersion?.includes("memory_interviews.version"), `book ${actionId} interview precondition drift`);
}
const personalMemorySchema = bookCoverage.schemaDefinitions?.PersonalMemory;
check(personalMemorySchema?.required?.includes("interviewVersion") && personalMemorySchema?.properties?.interviewVersion?.includes("memory_interviews.version"), "book PersonalMemory interview version projection drift");
const frozenBookManifestSchema = bookCoverage.schemaDefinitions?.FrozenBookManifest;
check(
  frozenBookManifestSchema?.required?.includes("title")
    && frozenBookManifestSchema?.properties?.title?.includes("locked current BookDraft")
    && frozenBookManifestSchema?.properties?.manifestHash?.includes("including exact title"),
  "book frozen manifest title/hash drift"
);
check(
  bookContract.includes("required `FrozenBookManifest.title`")
    && bookContract.includes("manifestHash` 覆盖精确冻结书名")
    && coreCanonical.includes("manifestHash为省略自身manifestHash字段后的canonical manifest SHA-256并覆盖title"),
  "book frozen title cross-document drift"
);

for (const [name, machine] of Object.entries(bookState.machines ?? {})) {
  const states = new Set(machine.states ?? []);
  check(states.has(machine.initial), `book state machine ${name} initial missing`);
  for (const terminal of machine.terminal ?? []) check(states.has(terminal), `book state machine ${name} terminal missing: ${terminal}`);
  for (const transition of machine.transitions ?? []) {
    for (const from of transition.from ?? []) check(states.has(from), `book state machine ${name} transition from missing: ${from}`);
    check(states.has(transition.to), `book state machine ${name} transition to missing: ${transition.to}`);
  }
}

const badBookNamespace = bookCoverage.actions
  .filter((entry) => mutationMethods.has(entry.method) && !entry.endpoint.startsWith("/v2-labs/"))
  .map((entry) => `${entry.method} ${entry.endpoint}`);
check(badBookNamespace.length === 0, `book mutation namespace conflicts with canonical /v2-labs/**: ${JSON.stringify(badBookNamespace)}`);

const actual = {
  core: {
    actions: coreIds.length,
    refs: coreIds.length * 4,
    phases: corePhases,
    canonicalMutations: coreCanonicalMutations.size,
    coverageMutations: coreOperations.unique.size,
    cas: coreCas.length,
    technical: coreTechnical.length,
    internal: coreInternal.length
  },
  book: {
    actions: bookIds.length,
    refs: bookIds.length * 4,
    phases: bookPhases,
    canonicalMutations: bookCanonicalMutations.size,
    coverageMutations: bookOperations.unique.size,
    cas: bookCas.length,
    technical: bookTechnical.length,
    internal: bookInternal.length,
    states: bookMachines.length
  }
};
actual.aggregate = {
  actions: actual.core.actions + actual.book.actions,
  refs: actual.core.refs + actual.book.refs,
  phases: actual.core.phases + actual.book.phases,
  canonicalMutations: actual.core.canonicalMutations + actual.book.canonicalMutations,
  coverageMutations: actual.core.coverageMutations + actual.book.coverageMutations,
  cas: actual.core.cas + actual.book.cas,
  technical: actual.core.technical + actual.book.technical,
  internal: actual.core.internal + actual.book.internal
};
for (const [key, value] of Object.entries(expected.aggregate)) check(actual.aggregate[key] === value, `aggregate ${key} ${actual.aggregate[key]}`);

process.stdout.write(`${JSON.stringify({ expected, actual, failures, errors: failures.length }, null, 2)}\n`);
process.exitCode = failures.length ? 1 : 0;
