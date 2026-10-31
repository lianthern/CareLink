#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [repoArg, sourceArg, outputArg] = process.argv.slice(2);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(repoArg ?? path.join(path.dirname(scriptPath), "../.."));
const sourceRoot = path.resolve(sourceArg ?? "/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12");
const output = outputArg ? path.resolve(outputArg) : null;
const oldManifest = JSON.parse(await readFile(path.join(repoRoot, "provenance/contract-source-manifest.json"), "utf8"));
const roleByRelativePath = new Map(oldManifest.entries.map((entry) => [entry.relativePath, entry.authorityRole]));
for (const [relativePath, role] of [
  ["C3-CONTRACT-REVISION-ACCEPTANCE.md", "c3_contract_revision_acceptance_evidence"],
  ["l3-book-lab/BOOK-LAB-CONTRACT.md", "frozen_semantic_contract"],
  ["l3-book-lab/ACTION-REGISTRY.book-lab.json", "frozen_semantic_contract"],
  ["l3-book-lab/STRING-CATALOG.book-lab.zh-CN.json", "frozen_semantic_contract"],
  ["l3-book-lab/ACTION-API-COVERAGE.book-lab.json", "frozen_semantic_contract"],
  ["l3-book-lab/STATE-MACHINES.book-lab.json", "frozen_semantic_contract"]
]) roleByRelativePath.set(relativePath, role);

const expectedPaths = [...roleByRelativePath].map(([relativePath]) => relativePath).sort();
if (expectedPaths.length !== 32) throw new Error(`expected path count drift: ${expectedPaths.length}`);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const modeString = (mode) => (mode & 0o077) === 0 ? "-rw-------" : "-rw-r--r--";
const entries = [];

for (const relativePath of expectedPaths) {
  const sourceAbsolutePath = path.join(sourceRoot, relativePath);
  const authoritativeCopy = path.posix.join("contracts/source", relativePath);
  const copyAbsolutePath = path.join(repoRoot, authoritativeCopy);
  const [sourceBytes, copyBytes, sourceStat, copyStat] = await Promise.all([
    readFile(sourceAbsolutePath),
    readFile(copyAbsolutePath),
    stat(sourceAbsolutePath),
    stat(copyAbsolutePath)
  ]);
  if (!sourceStat.isFile() || !copyStat.isFile() || !sourceBytes.equals(copyBytes)) {
    throw new Error(`source/copy mismatch: ${relativePath}`);
  }
  const digest = sha256(sourceBytes);
  entries.push({
    relativePath,
    sourceAbsolutePath,
    sourceSha256: digest,
    authoritativeCopy,
    copySha256: digest,
    bytes: sourceBytes.length,
    mode: modeString(sourceStat.mode),
    authorityRole: roleByRelativePath.get(relativePath),
    status: "byte_exact_authoritative_copy"
  });
}

const visualRoles = new Set(["product_visual_authority_original", "product_visual_contact_sheet_derived"]);
const frozenRoles = new Set(["frozen_orchestration_contract", "frozen_semantic_contract"]);
const visualEvidenceCount = entries.filter((entry) => visualRoles.has(entry.authorityRole)).length;
const frozenSemanticContractCount = entries.filter((entry) => frozenRoles.has(entry.authorityRole)).length;
const authorityEvidenceCount = entries.length - visualEvidenceCount - frozenSemanticContractCount;
if (visualEvidenceCount !== 7 || frozenSemanticContractCount !== 13 || authorityEvidenceCount !== 12) {
  throw new Error(`role count drift: frozen=${frozenSemanticContractCount} authority=${authorityEvidenceCount} visual=${visualEvidenceCount}`);
}

const manifest = {
  schemaVersion: "unseen-c4-contract-source-manifest/2",
  status: "complete",
  sourceRoot,
  copyRoot: "contracts/source",
  fileCount: entries.length,
  frozenSemanticContractCount,
  authorityEvidenceCount,
  visualEvidenceCount,
  entries
};
const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
if (output) await writeFile(output, bytes, "utf8");
else process.stdout.write(bytes);
