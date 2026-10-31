import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { binaryNameCompare } from "./path-order.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(process.env.UNSEEN_PROVENANCE_ROOT ?? path.join(path.dirname(scriptPath), "../.."));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalAuthorityRoot = "/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12";
const importSourceRoots = {
  formal_web: "/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-panorama-rebuild",
  recovered_backend: "/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild"
};

async function allFiles(root, prefix = "") {
  const output = [];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => binaryNameCompare(left.name, right.name));
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await allFiles(absolute, relative));
    else if (entry.isFile()) output.push(relative);
    else throw new Error(`unsupported filesystem entry: ${relative}`);
  }
  return output.sort(binaryNameCompare);
}

const inventoryPath = path.join(repoRoot, "provenance/safe-import-inventory.json");
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
if (inventory.schemaVersion !== "unseen-c4-safe-import-inventory/1" || inventory.status !== "complete") {
  throw new Error("safe-import inventory schema/status drift");
}

const expectedImportedFiles = [];
const inventorySources = new Set();
const inventoryFilesByScope = Object.fromEntries(Object.keys(importSourceRoots).map((scope) => [scope, []]));
let included = 0;
let excluded = 0;
for (const entry of inventory.entries) {
  const sourceKey = `${entry.scope}\0${entry.sourceRelativePath}`;
  if (inventorySources.has(sourceKey)) throw new Error(`duplicate inventory source: ${entry.scope}:${entry.sourceRelativePath}`);
  inventorySources.add(sourceKey);
  if (entry.sourceRoot !== importSourceRoots[entry.scope]) throw new Error(`inventory source root drift: ${entry.scope}:${entry.sourceRelativePath}`);
  const expectedSource = path.resolve(importSourceRoots[entry.scope], entry.sourceRelativePath);
  if (path.resolve(entry.sourceRoot, entry.sourceRelativePath) !== expectedSource || !expectedSource.startsWith(`${entry.sourceRoot}${path.sep}`)) {
    throw new Error(`inventory source escaped root: ${entry.scope}:${entry.sourceRelativePath}`);
  }
  const [sourceStat, sourceBytes] = await Promise.all([stat(expectedSource), readFile(expectedSource)]);
  if (!sourceStat.isFile() || sourceStat.size !== entry.bytes || sha256(sourceBytes) !== entry.sourceSha256) {
    throw new Error(`inventory source byte drift: ${entry.scope}:${entry.sourceRelativePath}`);
  }
  inventoryFilesByScope[entry.scope].push(entry.sourceRelativePath);
  if (entry.status === "included") {
    included += 1;
    if (!entry.targetRelativePath || entry.targetSha256 !== entry.sourceSha256) {
      throw new Error(`included provenance shape drift: ${entry.scope}:${entry.sourceRelativePath}`);
    }
    const target = path.resolve(repoRoot, entry.targetRelativePath);
    if (!target.startsWith(`${path.join(repoRoot, "imports")}${path.sep}`)) {
      throw new Error(`import target escaped imports/: ${entry.targetRelativePath}`);
    }
    const targetStat = await stat(target);
    const targetBytes = await readFile(target);
    if (!targetStat.isFile() || targetStat.size !== entry.bytes || sha256(targetBytes) !== entry.sourceSha256) {
      throw new Error(`import byte drift: ${entry.targetRelativePath}`);
    }
    expectedImportedFiles.push(entry.targetRelativePath.replace(/^imports\//, ""));
  } else if (entry.status === "excluded") {
    excluded += 1;
    if (entry.targetRelativePath !== null || entry.targetSha256 !== null) {
      throw new Error(`excluded entry acquired a target: ${entry.scope}:${entry.sourceRelativePath}`);
    }
  } else {
    throw new Error(`unknown import status: ${entry.status}`);
  }
}
if (included !== 357 || excluded !== 178 || inventory.entries.length !== 535) {
  throw new Error(`safe-import count drift: ${included}/${excluded}/${inventory.entries.length}`);
}
for (const [scope, sourceRoot] of Object.entries(importSourceRoots)) {
  const actual = await allFiles(sourceRoot);
  const expected = inventoryFilesByScope[scope].sort(binaryNameCompare);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`inventory source file set drift: ${scope}`);
  }
}
if (JSON.stringify(await allFiles(path.join(repoRoot, "imports"))) !== JSON.stringify(expectedImportedFiles.sort(binaryNameCompare))) {
  throw new Error("imports contain missing or unmanifested files");
}

const contractManifestPath = path.join(repoRoot, "provenance/contract-source-manifest.json");
const contractManifest = JSON.parse(await readFile(contractManifestPath, "utf8"));
if (
  contractManifest.schemaVersion !== "unseen-c4-contract-source-manifest/2"
  || contractManifest.status !== "complete"
  || contractManifest.fileCount !== 32
  || contractManifest.frozenSemanticContractCount !== 13
  || contractManifest.authorityEvidenceCount !== 12
  || contractManifest.visualEvidenceCount !== 7
  || contractManifest.entries.length !== 32
) {
  throw new Error("contract authority count/schema drift");
}
if (contractManifest.sourceRoot !== canonicalAuthorityRoot || contractManifest.copyRoot !== "contracts/source") {
  throw new Error("contract authority root drift");
}
const authorityRoot = path.resolve(contractManifest.sourceRoot);
const relativeSeen = new Set();
const copySeen = new Set();
const sourceSeen = new Set();
for (const entry of contractManifest.entries) {
  if (relativeSeen.has(entry.relativePath) || copySeen.has(entry.authoritativeCopy) || sourceSeen.has(entry.sourceAbsolutePath)) {
    throw new Error(`duplicate contract authority entry: ${entry.relativePath}`);
  }
  relativeSeen.add(entry.relativePath);
  copySeen.add(entry.authoritativeCopy);
  sourceSeen.add(entry.sourceAbsolutePath);

  const expectedSource = path.resolve(authorityRoot, entry.relativePath);
  const source = path.resolve(entry.sourceAbsolutePath);
  const copy = path.resolve(repoRoot, entry.authoritativeCopy);
  if (source !== expectedSource || !copy.startsWith(`${path.join(repoRoot, "contracts/source")}${path.sep}`)) {
    throw new Error(`contract authority path drift: ${entry.relativePath}`);
  }
  const [sourceStat, copyStat, sourceBytes, copyBytes] = await Promise.all([
    stat(source),
    stat(copy),
    readFile(source),
    readFile(copy)
  ]);
  const sourceHash = sha256(sourceBytes);
  const copyHash = sha256(copyBytes);
  if (
    !sourceStat.isFile()
    || !copyStat.isFile()
    || sourceStat.size !== entry.bytes
    || copyStat.size !== entry.bytes
    || sourceHash !== entry.sourceSha256
    || copyHash !== entry.copySha256
    || sourceHash !== copyHash
    || !sourceBytes.equals(copyBytes)
  ) {
    throw new Error(`contract authority byte drift: ${entry.relativePath}`);
  }
}

const visualRoles = new Set(["product_visual_authority_original", "product_visual_contact_sheet_derived"]);
const frozenRoles = new Set(["frozen_orchestration_contract", "frozen_semantic_contract"]);
const visualCount = contractManifest.entries.filter((entry) => visualRoles.has(entry.authorityRole)).length;
const frozenCount = contractManifest.entries.filter((entry) => frozenRoles.has(entry.authorityRole)).length;
if (visualCount !== 7 || frozenCount !== 13 || contractManifest.entries.length - visualCount - frozenCount !== 12) {
  throw new Error("contract authority role partition drift");
}

const actualContractFiles = await allFiles(path.join(repoRoot, "contracts/source"));
const expectedContractFiles = contractManifest.entries
  .map((entry) => entry.authoritativeCopy.replace(/^contracts\/source\//, ""))
  .sort();
if (JSON.stringify(actualContractFiles) !== JSON.stringify(expectedContractFiles)) {
  throw new Error("contract authority file set drift");
}

const verifier = spawnSync(
  "python3",
  [path.join(repoRoot, "contracts/source/technical/EVIDENCE/verify_c4_source_manifest.py")],
  { cwd: path.join(repoRoot, "contracts/source"), encoding: "utf8" }
);
if (verifier.status !== 0 || !verifier.stdout.includes("C4_SOURCE_MANIFEST_OK")) {
  process.stderr.write(verifier.stdout);
  process.stderr.write(verifier.stderr);
  throw new Error("historical source manifest verifier failed");
}

process.stdout.write(`${JSON.stringify({
  status: "PROVENANCE_OK",
  contractSources: 32,
  frozenSemanticContracts: 13,
  authorityEvidence: 12,
  visualEvidence: 7,
  generatedFilesExpected: 11,
  inventorySha256: sha256(await readFile(inventoryPath)),
  contractSourceManifestSha256: sha256(await readFile(contractManifestPath)),
  included,
  excluded,
  historicalSourceManifest: "C4_SOURCE_MANIFEST_OK"
})}\n`);
