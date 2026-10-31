import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const exactBookMachines = ["bookAuthorization", "bookDraft", "bookVersion", "memoryInterview", "renderArtifact"];
const sourcePaths = {
  core: {
    action: "contracts/source/product-ui/ACTION-REGISTRY.json",
    strings: "contracts/source/product-ui/STRING-CATALOG.zh-CN.json",
    tokens: "contracts/source/product-ui/DESIGN-TOKENS.json",
    coverage: "contracts/source/technical/ACTION-API-COVERAGE.json",
    canonical: "contracts/source/technical/CANONICAL-STATE-AND-API.md"
  },
  bookLab: {
    contract: "contracts/source/l3-book-lab/BOOK-LAB-CONTRACT.md",
    action: "contracts/source/l3-book-lab/ACTION-REGISTRY.book-lab.json",
    strings: "contracts/source/l3-book-lab/STRING-CATALOG.book-lab.zh-CN.json",
    coverage: "contracts/source/l3-book-lab/ACTION-API-COVERAGE.book-lab.json",
    states: "contracts/source/l3-book-lab/STATE-MACHINES.book-lab.json"
  }
};

const expected = {
  core: { actions: 90, refs: 360, phases: 810, canonicalMutations: 59, coverageMutations: 59, cas: 47, technical: 8, internal: 2 },
  bookLab: { actions: 20, refs: 80, phases: 180, canonicalMutations: 15, coverageMutations: 15, cas: 8, technical: 0, internal: 2, stateMachines: 5 },
  aggregate: { actions: 110, refs: 440, phases: 990, canonicalMutations: 74, coverageMutations: 74, cas: 55, technical: 8, internal: 4 }
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const rendered = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sorted = (values) => [...values].sort();
const sameSet = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const stableSetHash = (values) => sha256(`${JSON.stringify(sorted(values))}\n`);

async function sourceManifestIndex() {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "provenance/contract-source-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== "unseen-c4-contract-source-manifest/2") throw new Error("contract source manifest v2 required");
  return new Map(manifest.entries.map((entry) => [entry.authoritativeCopy, entry]));
}

async function loadFrozen(relative, manifestIndex, parse = true) {
  const entry = manifestIndex.get(relative);
  if (!entry) throw new Error(`source absent from provenance: ${relative}`);
  const value = await readFile(path.join(repoRoot, relative));
  if (value.length !== entry.bytes || sha256(value) !== entry.copySha256 || entry.copySha256 !== entry.sourceSha256) {
    throw new Error(`frozen source drift: ${relative}`);
  }
  return parse ? JSON.parse(value.toString("utf8")) : value.toString("utf8");
}

function projectRegistry(actions) {
  return [...actions].sort((left, right) => left.id.localeCompare(right.id)).map((entry) => ({
    actionId: entry.id,
    sourceEntry: entry.entry,
    sourceRoute: entry.route,
    sourceReturnTarget: entry.returnTarget,
    sourceActor: entry.actor
  }));
}

function projectCoverage(actions) {
  return [...actions].sort((left, right) => left.actionId.localeCompare(right.actionId)).map((entry) => ({
    actionId: entry.actionId,
    sourceEntry: entry.sourceEntry,
    sourceRoute: entry.sourceRoute,
    sourceReturnTarget: entry.sourceReturnTarget,
    sourceActor: entry.sourceActor
  }));
}

function coverageMutationSet(coverage) {
  const output = new Set();
  const add = (entry) => {
    if (mutationMethods.has(entry?.method) && typeof entry?.endpoint === "string" && entry.endpoint.startsWith("/")) {
      output.add(`${entry.method} ${entry.endpoint}`);
    }
  };
  for (const action of coverage.actions ?? []) {
    add(action);
    for (const step of action.workflowSteps ?? []) add(step);
  }
  for (const operation of coverage.technicalOperationCoverage ?? []) add(operation);
  return output;
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

function validateNamespace(name, sources, counts, canonicalMutations, extraActionSet = []) {
  const ids = sources.action.actions.map((entry) => entry.id);
  const catalogIds = Object.keys(sources.strings.actions);
  const coverageIds = sources.coverage.actions.map((entry) => entry.actionId);
  const phasePairs = Object.values(sources.strings.actions).reduce((total, phases) => total + Object.keys(phases).length, 0);
  const coverageMutations = coverageMutationSet(sources.coverage);
  const casFields = name === "core"
    ? sources.coverage.versionCasDictionary.allowedFields
    : Object.keys(sources.coverage.versionCasDictionary);
  const technical = sources.coverage.technicalOperationCoverage ?? [];
  const internal = sources.coverage.internalOperationCoverage ?? [];

  if (ids.length !== counts.actions || new Set(ids).size !== counts.actions) throw new Error(`${name} action count/set drift`);
  if (!sameSet(ids, catalogIds) || !sameSet(ids, coverageIds)) throw new Error(`${name} action reference set drift`);
  if (sources.action.phases.length !== 9 || sources.strings.phaseOrder.length !== 9 || phasePairs !== counts.phases) throw new Error(`${name} phase drift`);
  if (JSON.stringify(projectRegistry(sources.action.actions)) !== JSON.stringify(projectCoverage(sources.coverage.actions))) throw new Error(`${name} source projection drift`);
  if (ids.length * 4 !== counts.refs) throw new Error(`${name} source reference count drift`);
  if (canonicalMutations.size !== counts.canonicalMutations || coverageMutations.size !== counts.coverageMutations || !sameSet(canonicalMutations, coverageMutations)) throw new Error(`${name} mutation set drift`);
  if (casFields.length !== counts.cas || new Set(casFields).size !== counts.cas) throw new Error(`${name} CAS drift`);
  if (technical.length !== counts.technical || internal.length !== counts.internal) throw new Error(`${name} operation count drift`);
  if (extraActionSet.some((id) => new Set(ids).has(id))) throw new Error(`${name} action namespace overlap`);
  if (name === "bookLab") {
    for (const action of sources.coverage.actions) {
      if (action.method === "GET" && action.replayClass !== "not_applicable") throw new Error(`bookLab query replayClass drift: ${action.actionId}`);
      if (mutationMethods.has(action.method) && !["ordinary_dto", "completed_state"].includes(action.replayClass)) throw new Error(`bookLab mutation replayClass drift: ${action.actionId}`);
    }
    if (internal.some((entry) => entry.replayClass !== "completed_state")) throw new Error("bookLab internal replayClass drift");
  }
  return {
    ids,
    phasePairs,
    canonicalMutations,
    coverageMutations,
    casFields,
    technical,
    internal,
    sourceProjection: projectRegistry(sources.action.actions),
    coverageProjection: projectCoverage(sources.coverage.actions)
  };
}

export async function generate(outputRoot = path.join(repoRoot, "packages/contracts/generated")) {
  const manifestIndex = await sourceManifestIndex();
  const core = {
    action: await loadFrozen(sourcePaths.core.action, manifestIndex),
    strings: await loadFrozen(sourcePaths.core.strings, manifestIndex),
    tokens: await loadFrozen(sourcePaths.core.tokens, manifestIndex),
    coverage: await loadFrozen(sourcePaths.core.coverage, manifestIndex),
    canonical: await loadFrozen(sourcePaths.core.canonical, manifestIndex, false)
  };
  const bookLab = {
    contract: await loadFrozen(sourcePaths.bookLab.contract, manifestIndex, false),
    action: await loadFrozen(sourcePaths.bookLab.action, manifestIndex),
    strings: await loadFrozen(sourcePaths.bookLab.strings, manifestIndex),
    coverage: await loadFrozen(sourcePaths.bookLab.coverage, manifestIndex),
    states: await loadFrozen(sourcePaths.bookLab.states, manifestIndex)
  };

  const coreResult = validateNamespace("core", core, expected.core, markdownMutationSet(core.canonical));
  const bookResult = validateNamespace("bookLab", bookLab, expected.bookLab, markdownMutationSet(bookLab.contract), coreResult.ids);
  const machineNames = Object.keys(bookLab.states.machines ?? {});
  if (!sameSet(machineNames, exactBookMachines) || machineNames.length !== expected.bookLab.stateMachines) throw new Error("bookLab state-machine drift");
  if (!sameSet(Object.keys(bookLab.states.actionTransitionCoverage ?? {}), bookResult.ids)) throw new Error("bookLab state action coverage drift");
  if (bookLab.coverage.actions.some((entry) => mutationMethods.has(entry.method) && !entry.endpoint.startsWith("/v2-labs/"))) throw new Error("bookLab mutation namespace drift");
  if (!sameSet(
    bookResult.internal.map((entry) => `${entry.operationId}|${entry.endpoint}`),
    ["QUESTION_PROCESSOR|internal:book-lab-question-processor", "BOOK_RENDER_PROCESSOR|internal:book-lab-render-processor"]
  )) throw new Error("bookLab internal operation set drift");

  const namespaceCounts = {
    core: {
      actions: coreResult.ids.length,
      actionSourceReferenceChecks: coreResult.ids.length * 4,
      stringPhasePairs: coreResult.phasePairs,
      canonicalHttpMutationUniqueEndpoints: coreResult.canonicalMutations.size,
      coverageMutationUniqueEndpoints: coreResult.coverageMutations.size,
      versionCasDictionaryFields: coreResult.casFields.length,
      technicalOperationEntries: coreResult.technical.length,
      internalOperationEntries: coreResult.internal.length
    },
    bookLab: {
      actions: bookResult.ids.length,
      actionSourceReferenceChecks: bookResult.ids.length * 4,
      stringPhasePairs: bookResult.phasePairs,
      canonicalHttpMutationUniqueEndpoints: bookResult.canonicalMutations.size,
      coverageMutationUniqueEndpoints: bookResult.coverageMutations.size,
      versionCasDictionaryFields: bookResult.casFields.length,
      technicalOperationEntries: bookResult.technical.length,
      internalOperationEntries: bookResult.internal.length,
      stateMachineEntries: machineNames.length
    }
  };
  const counts = {
    actions: namespaceCounts.core.actions + namespaceCounts.bookLab.actions,
    actionSourceReferenceChecks: namespaceCounts.core.actionSourceReferenceChecks + namespaceCounts.bookLab.actionSourceReferenceChecks,
    stringPhasePairs: namespaceCounts.core.stringPhasePairs + namespaceCounts.bookLab.stringPhasePairs,
    canonicalHttpMutationUniqueEndpoints: namespaceCounts.core.canonicalHttpMutationUniqueEndpoints + namespaceCounts.bookLab.canonicalHttpMutationUniqueEndpoints,
    coverageMutationUniqueEndpoints: namespaceCounts.core.coverageMutationUniqueEndpoints + namespaceCounts.bookLab.coverageMutationUniqueEndpoints,
    versionCasDictionaryFields: namespaceCounts.core.versionCasDictionaryFields + namespaceCounts.bookLab.versionCasDictionaryFields,
    technicalOperationEntries: namespaceCounts.core.technicalOperationEntries + namespaceCounts.bookLab.technicalOperationEntries,
    internalOperationEntries: namespaceCounts.core.internalOperationEntries + namespaceCounts.bookLab.internalOperationEntries
  };
  const expectedAggregate = {
    actions: expected.aggregate.actions,
    actionSourceReferenceChecks: expected.aggregate.refs,
    stringPhasePairs: expected.aggregate.phases,
    canonicalHttpMutationUniqueEndpoints: expected.aggregate.canonicalMutations,
    coverageMutationUniqueEndpoints: expected.aggregate.coverageMutations,
    versionCasDictionaryFields: expected.aggregate.cas,
    technicalOperationEntries: expected.aggregate.technical,
    internalOperationEntries: expected.aggregate.internal
  };
  if (JSON.stringify(counts) !== JSON.stringify(expectedAggregate)) throw new Error(`aggregate count drift: ${JSON.stringify(counts)}`);

  const sourceIndex = Object.fromEntries(
    Object.entries({ ...sourcePaths.core, ...Object.fromEntries(Object.entries(sourcePaths.bookLab).map(([key, value]) => [`bookLab.${key}`, value])) })
      .map(([name, relative]) => [name, { path: relative, sha256: manifestIndex.get(relative).copySha256 }])
  );
  const contractIndex = {
    schemaVersion: "unseen-contracts-generated-index/2",
    generatedFromOnly: sourceIndex,
    namespaceCounts,
    counts,
    setHashes: {
      coreActionIds: stableSetHash(coreResult.ids),
      bookLabActionIds: stableSetHash(bookResult.ids),
      aggregateActionIds: stableSetHash([...coreResult.ids, ...bookResult.ids]),
      coreSourceProjection: sha256(`${JSON.stringify(coreResult.sourceProjection)}\n`),
      coreCoverageProjection: sha256(`${JSON.stringify(coreResult.coverageProjection)}\n`),
      bookLabSourceProjection: sha256(`${JSON.stringify(bookResult.sourceProjection)}\n`),
      bookLabCoverageProjection: sha256(`${JSON.stringify(bookResult.coverageProjection)}\n`),
      bookLabStateMachines: stableSetHash(machineNames)
    },
    breakpoints: {
      mobileMax: core.tokens.breakpoint.mobileMax,
      desktopMin: core.tokens.breakpoint.desktopMin
    }
  };
  const bookIndex = {
    schemaVersion: "unseen-book-lab-contracts-generated-index/1",
    generatedFromOnly: Object.fromEntries(Object.entries(sourcePaths.bookLab).map(([name, relative]) => [name, { path: relative, sha256: manifestIndex.get(relative).copySha256 }])),
    counts: namespaceCounts.bookLab,
    setHashes: {
      actionIds: stableSetHash(bookResult.ids),
      sourceProjection: sha256(`${JSON.stringify(bookResult.sourceProjection)}\n`),
      coverageProjection: sha256(`${JSON.stringify(bookResult.coverageProjection)}\n`),
      stateMachines: stableSetHash(machineNames)
    }
  };

  const generatedFiles = {
    "action-registry.json": core.action,
    "string-catalog.zh-CN.json": core.strings,
    "design-tokens.json": core.tokens,
    "action-api-coverage.json": core.coverage,
    "canonical-enums.json": {
      schemaVersion: "unseen-canonical-enums-generated/1",
      allowedValues: core.coverage.allowedValues,
      canonicalEnums: core.coverage.canonicalEnums,
      canonicalMappings: core.coverage.canonicalMappings
    },
    "contract-index.json": contractIndex,
    "book-lab/action-registry.json": bookLab.action,
    "book-lab/string-catalog.zh-CN.json": bookLab.strings,
    "book-lab/action-api-coverage.json": bookLab.coverage,
    "book-lab/state-machines.json": bookLab.states,
    "book-lab/contract-index.json": bookIndex
  };

  for (const [filename, value] of Object.entries(generatedFiles)) {
    const target = path.join(outputRoot, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rendered(value), "utf8");
  }
  return { outputRoot, files: Object.keys(generatedFiles).sort(), contractIndex };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await generate(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  process.stdout.write(`${JSON.stringify({ files: result.files, namespaceCounts: result.contractIndex.namespaceCounts, counts: result.contractIndex.counts })}\n`);
}
