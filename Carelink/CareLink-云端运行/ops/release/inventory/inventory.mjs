#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const schema = "unseen-release-inventory/1";
const commitPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const placeholderPattern = /(UNKNOWN|PLACEHOLDER|CHANGEME|REQUIRED_|\bTODO\b|\bTBD\b)/iu;
const mediaPattern = /\.(?:png|jpe?g|webp|avif|gif|svg|woff2?|ttf|otf|mp4|mov|webm|mp3|wav|m4a|aac|flac|wasm)$/iu;
const lockPattern = /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/u;
const runtimeTextPattern = /^(?:apps\/web|packages\/(?:viewer|book-renderer|book-lab-web))\/.*\.(?:css|html|js|mjs)$/u;
const releaseBlockers = [
  "chromium_node_runtime_license_security_review_missing",
  "ffmpeg_gpl_and_recursive_codec_review_missing",
  "media_people_venue_commercial_modification_redistribution_rights_missing",
  "system_font_embedding_redistribution_and_missing_glyph_review_missing",
  "vendor_qr_version_recursive_license_provenance_review_missing"
];

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    stdio: options.stdio,
    ...options
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function canonical(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function exactObject(value, keys, code) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code);
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), code);
}

function rejectPlaceholders(value) {
  if (typeof value === "string") invariant(!placeholderPattern.test(value), "inventory_placeholder_or_unknown_rejected");
  else if (Array.isArray(value)) value.forEach(rejectPlaceholders);
  else if (value && typeof value === "object") Object.values(value).forEach(rejectPlaceholders);
}

function parseTree(candidateCommit) {
  const raw = git(["ls-tree", "-r", "-z", "-l", "--full-tree", candidateCommit], { encoding: "buffer" });
  return raw.toString("utf8").split("\0").filter(Boolean).map((line) => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\s+(-|\d+)\t([\s\S]+)$/u.exec(line);
    invariant(match, "inventory_git_tree_entry_invalid");
    const entry = { mode: match[1], type: match[2], oid: match[3], bytes: match[4] === "-" ? null : Number(match[4]), path: match[5] };
    invariant(entry.type === "blob", `inventory_non_blob_rejected:${entry.path}`);
    invariant(entry.mode !== "120000", `inventory_symlink_rejected:${entry.path}`);
    invariant(["100644", "100755"].includes(entry.mode), `inventory_file_mode_rejected:${entry.path}`);
    return entry;
  }).sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function blob(entry) {
  const bytes = git(["cat-file", "blob", entry.oid], { encoding: "buffer" });
  invariant(bytes.length === entry.bytes, `inventory_git_blob_size_mismatch:${entry.path}`);
  return bytes;
}

function gitLocator(candidateCommit, relativePath, fragment = "") {
  return `git:${candidateCommit}:${relativePath}${fragment}`;
}

function fileRecord(candidateCommit, entry) {
  const bytes = blob(entry);
  return {
    path: entry.path,
    bytes: bytes.length,
    sha256: sha256(bytes),
    gitBlobOid: entry.oid,
    mode: entry.mode,
    provenanceSourceLocator: gitLocator(candidateCommit, entry.path)
  };
}

function workspaceRegex(pattern) {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]+")}/package\\.json$`, "u");
}

function dependencyRows(manifest) {
  const groups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  return groups.flatMap((group) => Object.entries(manifest[group] ?? {}).map(([name, specifier]) => ({ group, name, specifier })))
    .sort((left, right) => `${left.group}:${left.name}`.localeCompare(`${right.group}:${right.name}`, "en"));
}

function packageManifests(candidateCommit, tree) {
  const rootEntry = tree.find((entry) => entry.path === "package.json");
  invariant(rootEntry, "inventory_root_manifest_missing");
  const rootManifest = JSON.parse(blob(rootEntry));
  invariant(Array.isArray(rootManifest.workspaces), "inventory_root_workspaces_invalid");
  const matchers = rootManifest.workspaces.map(workspaceRegex);
  return tree.filter((entry) => entry.path.endsWith("package.json")).map((entry) => {
    const bytes = blob(entry);
    const manifest = JSON.parse(bytes);
    const workspaceMember = entry.path === "package.json" || matchers.some((matcher) => matcher.test(entry.path));
    invariant(typeof manifest.name === "string" && manifest.name.length > 0, `inventory_package_name_missing:${entry.path}`);
    return {
      componentId: `npm-manifest:${entry.path}`,
      path: entry.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      gitBlobOid: entry.oid,
      name: manifest.name,
      version: typeof manifest.version === "string" ? manifest.version : null,
      private: manifest.private === true,
      declaredLicense: typeof manifest.license === "string" ? manifest.license : null,
      workspaceMember,
      scope: workspaceMember ? "root_or_workspace" : "historical_non_workspace",
      declaredDependencies: dependencyRows(manifest),
      licenseProvenanceSourceLocator: typeof manifest.license === "string" ? gitLocator(candidateCommit, entry.path, "#license") : null,
      provenanceSourceLocator: gitLocator(candidateCommit, entry.path),
      reviewState: "needs_review",
      commercialEligibility: "blocked_pending_human_approval"
    };
  });
}

function lockfiles(candidateCommit, tree) {
  return tree.filter((entry) => lockPattern.test(entry.path)).map((entry) => {
    const bytes = blob(entry);
    const record = {
      componentId: `dependency-lock:${entry.path}`,
      path: entry.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      gitBlobOid: entry.oid,
      format: path.basename(entry.path),
      provenanceSourceLocator: gitLocator(candidateCommit, entry.path),
      reviewState: "needs_review"
    };
    if (entry.path.endsWith("package-lock.json")) {
      const parsed = JSON.parse(bytes);
      record.lockfileVersion = parsed.lockfileVersion;
      record.packageRecords = Object.entries(parsed.packages ?? {}).map(([packagePath, value]) => ({
        packagePath,
        name: typeof value.name === "string" ? value.name : null,
        version: typeof value.version === "string" ? value.version : null,
        resolved: typeof value.resolved === "string" ? value.resolved : null,
        integrity: typeof value.integrity === "string" ? value.integrity : null,
        link: value.link === true
      })).sort((left, right) => left.packagePath.localeCompare(right.packagePath, "en"));
    }
    return record;
  });
}

function assetScope(relativePath) {
  if (relativePath.startsWith("imports/")) return "historical_import";
  if (relativePath.startsWith("contracts/")) return "contract_reference";
  if (relativePath.startsWith("release-evidence/")) return "release_evidence";
  if (/\/tests\/fixtures\//u.test(relativePath)) return "test_fixture";
  if (/\/(?:tests\/)?evidence\//u.test(relativePath)) return "test_evidence";
  if (relativePath.startsWith("apps/web/src/vendor/")) return "runtime_vendored_code";
  return "runtime_product_asset";
}

function assetKind(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if ([".woff", ".woff2", ".ttf", ".otf"].includes(extension)) return "font";
  if ([".mp4", ".mov", ".webm"].includes(extension)) return "video";
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac"].includes(extension)) return "audio";
  if (extension === ".wasm") return "wasm";
  if (relativePath.startsWith("apps/web/src/vendor/")) return "vendored_source_or_notice";
  return "image";
}

function assets(candidateCommit, tree) {
  return tree.filter((entry) => mediaPattern.test(entry.path) || entry.path.startsWith("apps/web/src/vendor/"))
    .map((entry) => ({
      componentId: `asset:${entry.path}`,
      ...fileRecord(candidateCommit, entry),
      kind: assetKind(entry.path),
      scope: assetScope(entry.path),
      rightsProvenanceSourceLocator: null,
      rightsReviewState: entry.path.startsWith("apps/web/src/vendor/") ? "not_applicable" : "needs_review",
      commercialEligibility: entry.path.startsWith("apps/web/src/vendor/") ? "license_review_required" : "blocked_pending_human_approval"
    }));
}

function vendoredComponents(candidateCommit, tree) {
  const bundleEntry = tree.find((entry) => entry.path === "apps/web/src/vendor/qrcode-renderer.js");
  const licenseEntry = tree.find((entry) => entry.path === "apps/web/src/vendor/LICENSE-qrcode.txt");
  invariant(bundleEntry && licenseEntry, "inventory_qr_vendor_pair_missing");
  const source = blob(bundleEntry).toString("utf8");
  const packageNames = new Set();
  for (const match of source.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//gu)) packageNames.add(match[1]);
  invariant(packageNames.has("qrcode") && packageNames.has("dijkstrajs"), "inventory_qr_recursive_component_discovery_invalid");
  return [...packageNames].sort().map((name) => ({
    componentId: `vendored-npm:${name}`,
    ecosystem: "npm",
    name,
    version: null,
    bundlePath: bundleEntry.path,
    bundleSha256: sha256(blob(bundleEntry)),
    declaredLicense: name === "qrcode" ? "MIT" : null,
    licenseProvenanceSourceLocator: name === "qrcode" ? gitLocator(candidateCommit, licenseEntry.path) : null,
    provenanceSourceLocator: gitLocator(candidateCommit, bundleEntry.path, `#embedded-node_modules/${name}`),
    reviewState: "needs_review",
    commercialEligibility: "blocked_pending_human_approval"
  }));
}

function fontFamilies(value, shorthand) {
  let source = value.trim();
  if (shorthand) {
    const match = /(?:^|\s)(?:\d+(?:\.\d+)?(?:px|pt|rem|em|%)|var\([^)]*\))(?:\/[^\s]+)?\s+(.+)$/u.exec(source);
    if (!match) return [];
    source = match[1];
  }
  return source.split(",").map((family) => family.trim().replace(/^['"]|['"]$/gu, ""))
    .filter((family) => family && !family.startsWith("var("));
}

function systemFonts(candidateCommit, tree) {
  const references = new Map();
  for (const entry of tree.filter((item) => runtimeTextPattern.test(item.path))) {
    const source = blob(entry).toString("utf8");
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const match of line.matchAll(/(font-family|font)\s*:\s*([^;}]+)/gu)) {
        for (const family of fontFamilies(match[2], match[1] === "font")) {
          if (!references.has(family)) references.set(family, new Set());
          references.get(family).add(gitLocator(candidateCommit, entry.path, `#L${index + 1}`));
        }
      }
      for (const match of line.matchAll(/font-family=["']([^"']+)["']/gu)) {
        for (const family of fontFamilies(match[1], false)) {
          if (!references.has(family)) references.set(family, new Set());
          references.get(family).add(gitLocator(candidateCommit, entry.path, `#L${index + 1}`));
        }
      }
    }
  }
  return [...references].map(([family, locators]) => ({
    componentId: `system-font:${family}`,
    family,
    exactResolvedPath: null,
    bundled: false,
    sourceLocators: [...locators].sort(),
    licenseProvenanceSourceLocator: null,
    reviewState: "needs_review",
    commercialEligibility: "blocked_pending_human_approval"
  })).sort((left, right) => left.componentId.localeCompare(right.componentId, "en"));
}

function commandPath(command) {
  const result = spawnSync("/usr/bin/which", [command], { encoding: "utf8" });
  invariant(result.status === 0, `inventory_runtime_binary_missing:${command}`);
  return result.stdout.trim();
}

function versionOutput(filename, args) {
  const result = spawnSync(filename, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  invariant(result.status === 0, `inventory_runtime_version_probe_failed:${filename}`);
  return `${result.stdout}${result.stderr}`.trim().replaceAll("\r\n", "\n");
}

function linkedLibraries(filename) {
  if (process.platform !== "darwin") return [];
  const result = spawnSync("/usr/bin/otool", ["-L", filename], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  invariant(result.status === 0, `inventory_runtime_link_probe_failed:${filename}`);
  const rows = result.stdout.split("\n").slice(1).map((line) => line.trim()).filter((line) => line && !line.endsWith(":"))
    .map((line) => {
      const match = /^(.*?) \((.*)\)$/u.exec(line);
      return { locator: match ? match[1] : line, versionDescriptor: match ? match[2] : null };
    });
  return [...new Map(rows.map((row) => [`${row.locator}\0${row.versionDescriptor}`, row])).values()]
    .sort((left, right) => `${left.locator}:${left.versionDescriptor}`.localeCompare(`${right.locator}:${right.versionDescriptor}`, "en"));
}

function rpaths(filename) {
  if (process.platform !== "darwin") return [];
  const result = spawnSync("/usr/bin/otool", ["-l", filename], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  invariant(result.status === 0, `inventory_runtime_rpath_probe_failed:${filename}`);
  const lines = result.stdout.split("\n");
  const paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") continue;
    const match = /^path (.+?) \(offset \d+\)$/u.exec(lines[index + 2]?.trim() ?? "");
    if (match) paths.push(match[1]);
  }
  return [...new Set(paths)].sort();
}

function expandDyld(value, ownerPath, executablePath) {
  return value.replace(/^@loader_path/u, path.dirname(ownerPath)).replace(/^@executable_path/u, path.dirname(executablePath));
}

async function resolveDyldLink(locator, ownerPath, executablePath) {
  const candidates = [];
  if (path.isAbsolute(locator)) candidates.push(locator);
  else if (locator.startsWith("@loader_path/") || locator.startsWith("@executable_path/")) {
    candidates.push(expandDyld(locator, ownerPath, executablePath));
  } else if (locator.startsWith("@rpath/")) {
    const suffix = locator.slice("@rpath/".length);
    for (const rpath of rpaths(ownerPath)) candidates.push(path.join(expandDyld(rpath, ownerPath, executablePath), suffix));
  }
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (info.isFile()) return resolved;
    } catch {}
  }
  return null;
}

async function runtimeLibraryGraph(runtimeRows) {
  if (process.platform !== "darwin") return [];
  const roots = new Set(runtimeRows.map((entry) => entry.realPath));
  const chromium = runtimeRows.find((entry) => entry.id === "chromium")?.realPath;
  const resolved = new Map();
  const unresolved = new Map();
  const visited = new Set();
  const queue = runtimeRows.map((entry) => ({ ownerPath: entry.realPath, ownerComponentId: entry.componentId,
    executablePath: entry.id === "chromium_framework" ? chromium : entry.realPath }));
  while (queue.length > 0) {
    const current = queue.shift();
    const visitKey = `${current.ownerPath}\0${current.executablePath}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    for (const link of linkedLibraries(current.ownerPath)) {
      const dependencyPath = await resolveDyldLink(link.locator, current.ownerPath, current.executablePath);
      if (dependencyPath && !roots.has(dependencyPath)) {
        const existing = resolved.get(dependencyPath) ?? { realPath: dependencyPath, parents: new Set(),
          linkLocators: new Set(), versionDescriptors: new Set(), executablePaths: new Set() };
        existing.parents.add(current.ownerComponentId);
        existing.linkLocators.add(link.locator);
        if (link.versionDescriptor) existing.versionDescriptors.add(link.versionDescriptor);
        existing.executablePaths.add(current.executablePath);
        resolved.set(dependencyPath, existing);
        queue.push({ ownerPath: dependencyPath, ownerComponentId: `runtime-library:${dependencyPath}`,
          executablePath: current.executablePath });
      } else if (!dependencyPath && !roots.has(current.ownerPath)) {
        const key = link.locator;
        const existing = unresolved.get(key) ?? { locator: key, parents: new Set(), versionDescriptors: new Set() };
        existing.parents.add(current.ownerComponentId);
        if (link.versionDescriptor) existing.versionDescriptors.add(link.versionDescriptor);
        unresolved.set(key, existing);
      } else if (!dependencyPath) {
        const key = link.locator;
        const existing = unresolved.get(key) ?? { locator: key, parents: new Set(), versionDescriptors: new Set() };
        existing.parents.add(current.ownerComponentId);
        if (link.versionDescriptor) existing.versionDescriptors.add(link.versionDescriptor);
        unresolved.set(key, existing);
      }
    }
  }
  const resolvedRows = [];
  for (const entry of resolved.values()) {
    const info = await stat(entry.realPath);
    resolvedRows.push({
      componentId: `runtime-library:${entry.realPath}`,
      resolutionState: "file_hashed",
      realPath: entry.realPath,
      bytes: info.size,
      sha256: await sha256File(entry.realPath),
      parents: [...entry.parents].sort(),
      linkLocators: [...entry.linkLocators].sort(),
      versionDescriptors: [...entry.versionDescriptors].sort(),
      linkedLibraries: linkedLibraries(entry.realPath),
      provenanceSourceFiles: await localEvidenceFiles(entry.realPath),
      reviewState: "needs_review",
      commercialEligibility: "blocked_pending_human_approval"
    });
  }
  const unresolvedRows = [...unresolved.values()].map((entry) => ({
    componentId: `runtime-link:${entry.locator}`,
    resolutionState: /^\/(?:System\/Library|usr\/lib)\//u.test(entry.locator) ? "system_managed_not_addressable" : "needs_deployment_resolution",
    realPath: null,
    bytes: null,
    sha256: null,
    parents: [...entry.parents].sort(),
    linkLocators: [entry.locator],
    versionDescriptors: [...entry.versionDescriptors].sort(),
    linkedLibraries: [],
    provenanceSourceFiles: [],
    reviewState: "needs_review",
    commercialEligibility: "blocked_pending_human_approval"
  }));
  return [...resolvedRows, ...unresolvedRows].sort((left, right) => left.componentId.localeCompare(right.componentId, "en"));
}

async function localEvidenceFiles(filename) {
  const candidates = [];
  const cellar = filename.match(/^(\/opt\/homebrew\/Cellar\/[^/]+\/[^/]+)\//u)?.[1];
  if (cellar) candidates.push(path.join(cellar, "INSTALL_RECEIPT.json"), path.join(cellar, "LICENSE"));
  const contents = filename.match(/^(.*\.app\/Contents)\//u)?.[1];
  if (contents) candidates.push(path.join(contents, "Info.plist"));
  const records = [];
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile()) continue;
      records.push({ path: candidate, realPath: resolved, bytes: info.size, sha256: await sha256File(resolved) });
    } catch {}
  }
  return records.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function binaryRecord({ id, configuredPath, args, kind, inheritedVersion = null }) {
  invariant(path.isAbsolute(configuredPath), `inventory_runtime_path_not_absolute:${id}`);
  const resolved = await realpath(configuredPath);
  const info = await stat(resolved);
  invariant(info.isFile() && (info.mode & 0o111) !== 0, `inventory_runtime_binary_not_executable:${id}`);
  const output = inheritedVersion ?? versionOutput(resolved, args);
  const configurationLine = output.split("\n").find((line) => line.startsWith("configuration: ")) ?? null;
  const buildConfiguration = id === "node" ? stable(process.config.variables) : null;
  const buildFlags = configurationLine ? configurationLine.slice("configuration: ".length).split(" ").filter(Boolean) : null;
  const gplEnabled = Array.isArray(buildFlags) && buildFlags.includes("--enable-gpl");
  return {
    componentId: `runtime-binary:${id}`,
    id,
    kind,
    configuredPath,
    realPath: resolved,
    bytes: info.size,
    sha256: await sha256File(resolved),
    versionOutput: output,
    versionOutputSha256: sha256(output),
    buildFlags,
    buildConfiguration,
    buildConfigurationSha256: buildConfiguration === null ? null : sha256(canonical(buildConfiguration)),
    linkedLibraries: linkedLibraries(resolved),
    provenanceSourceFiles: await localEvidenceFiles(resolved),
    gplEnabled,
    reviewState: "needs_review",
    commercialEligibility: "blocked_pending_human_approval"
  };
}

async function chromiumFramework(chromium, version) {
  const match = chromium.match(/^(.*\.app)\/Contents\/MacOS\/([^/]+)$/u);
  if (!match) return null;
  const framework = path.join(match[1], "Contents", "Frameworks", `${match[2]} Framework.framework`, "Versions", version,
    `${match[2]} Framework`);
  try {
    await stat(framework);
    return framework;
  } catch {
    return null;
  }
}

async function runtimeBinaries() {
  const nodePath = process.env.UNSEEN_INVENTORY_NODE_PATH ?? process.execPath;
  const ffmpegPath = process.env.UNSEEN_INVENTORY_FFMPEG_PATH ?? commandPath("ffmpeg");
  const ffprobePath = process.env.UNSEEN_INVENTORY_FFPROBE_PATH ?? commandPath("ffprobe");
  const browserCandidates = [
    process.env.UNSEEN_INVENTORY_CHROMIUM_PATH,
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  let chromiumPath = null;
  for (const candidate of browserCandidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile() && (info.mode & 0o111) !== 0) { chromiumPath = candidate; break; }
    } catch {}
  }
  invariant(chromiumPath, "inventory_runtime_binary_missing:chromium");
  const records = [
    await binaryRecord({ id: "node", configuredPath: nodePath, args: ["--version"], kind: "javascript_runtime" }),
    await binaryRecord({ id: "ffmpeg", configuredPath: ffmpegPath, args: ["-version"], kind: "media_decoder" }),
    await binaryRecord({ id: "ffprobe", configuredPath: ffprobePath, args: ["-version"], kind: "media_probe" }),
    await binaryRecord({ id: "chromium", configuredPath: chromiumPath, args: ["--version"], kind: "pdf_browser" })
  ];
  const chromiumVersion = /\b(\d+\.\d+\.\d+\.\d+)\b/u.exec(records.find((entry) => entry.id === "chromium").versionOutput)?.[1];
  const framework = chromiumVersion ? await chromiumFramework(await realpath(chromiumPath), chromiumVersion) : null;
  if (framework) records.push(await binaryRecord({ id: "chromium_framework", configuredPath: framework, args: [],
    kind: "pdf_browser_framework", inheritedVersion: records.find((entry) => entry.id === "chromium").versionOutput }));
  return records.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function runtimeComponents() {
  return Object.entries(process.versions).map(([name, version]) => ({
    componentId: `node-embedded:${name}`,
    name,
    version,
    provenanceSourceLocator: "runtime:process.versions",
    reviewState: "needs_review",
    commercialEligibility: "blocked_pending_human_approval"
  })).sort((left, right) => left.componentId.localeCompare(right.componentId, "en"));
}

function reviewItems() {
  return [
    { id: "font", owners: ["Design", "Legal", "Release Engineering"], state: "needs_review",
      requiredEvidence: ["exact deployment font resolution", "web embedding or fallback approval", "redistribution or system-font basis", "Chinese missing-glyph verification"] },
    { id: "media", owners: ["Product", "Legal", "Release Engineering"], state: "needs_review",
      requiredEvidence: ["people and venue rights", "commercial use", "modification", "redistribution", "source and asset hash"] },
    { id: "runtime", owners: ["Security", "Legal", "Release Engineering"], state: "needs_review",
      requiredEvidence: ["recursive runtime licenses and notices", "vulnerability disposition", "exact deployment binary hashes", "source obligations"] },
    { id: "vendor_qr", owners: ["Security", "Legal", "Release Engineering"], state: "needs_review",
      requiredEvidence: ["exact qrcode and dijkstrajs versions", "recursive licenses and notices", "upstream source locators", "security disposition"] }
  ];
}

function validateSemantics(inventory) {
  exactObject(inventory, ["schema", "candidate", "generator", "releaseClaim", "productionReady", "approvalState", "releaseBlockers",
    "discovery", "packageManifests", "lockfiles", "vendoredComponents", "assets", "systemFonts", "runtimeBinaries",
    "runtimeLibraries", "runtimeComponents", "reviewItems"], "inventory_top_level_shape_invalid");
  invariant(inventory.schema === schema, "inventory_schema_invalid");
  exactObject(inventory.candidate, ["commit", "tree", "sourceLocator"], "inventory_candidate_shape_invalid");
  invariant(commitPattern.test(inventory.candidate.commit) && /^[a-f0-9]{40}$/u.test(inventory.candidate.tree), "inventory_candidate_invalid");
  invariant(inventory.candidate.sourceLocator === `git:${inventory.candidate.commit}^{tree}`, "inventory_candidate_locator_invalid");
  invariant(inventory.generator === "ops/release/inventory/inventory.mjs", "inventory_generator_invalid");
  invariant(inventory.releaseClaim === "NO_GO" && inventory.productionReady === false && inventory.approvalState === "needs_review",
    "inventory_unreviewed_release_claim_rejected");
  invariant(JSON.stringify(inventory.releaseBlockers) === JSON.stringify(releaseBlockers), "inventory_release_blockers_invalid");
  rejectPlaceholders(inventory);
  const collections = [inventory.packageManifests, inventory.lockfiles, inventory.vendoredComponents, inventory.assets,
    inventory.systemFonts, inventory.runtimeBinaries, inventory.runtimeLibraries, inventory.runtimeComponents];
  const componentIds = collections.flatMap((collection) => collection.map((entry) => entry.componentId));
  invariant(componentIds.length === new Set(componentIds).size, "inventory_duplicate_component_rejected");
  for (const collection of collections) {
    for (const entry of collection) {
      if ("sha256" in entry && entry.sha256 !== null) invariant(sha256Pattern.test(entry.sha256), "inventory_sha256_invalid");
      if ("reviewState" in entry) invariant(["needs_review", "not_applicable", "reviewed"].includes(entry.reviewState),
        "inventory_review_state_invalid");
    }
  }
  invariant(inventory.assets.every((entry) => entry.rightsReviewState === "needs_review" || entry.rightsReviewState === "not_applicable"),
    "inventory_asset_rights_state_invalid");
  invariant(inventory.systemFonts.length > 0 && inventory.systemFonts.every((entry) => entry.reviewState === "needs_review" && entry.exactResolvedPath === null),
    "inventory_system_font_review_invalid");
  const ffmpeg = inventory.runtimeBinaries.find((entry) => entry.id === "ffmpeg");
  invariant(ffmpeg?.gplEnabled === true && ffmpeg.reviewState === "needs_review", "inventory_ffmpeg_gpl_review_invalid");
  invariant(inventory.reviewItems.every((entry) => entry.state === "needs_review"), "inventory_review_items_invalid");
}

export async function generateInventory(candidateCommit) {
  invariant(commitPattern.test(candidateCommit), "inventory_candidate_commit_invalid");
  git(["cat-file", "-e", `${candidateCommit}^{commit}`], { stdio: "ignore" });
  const candidateTree = git(["rev-parse", `${candidateCommit}^{tree}`]).trim();
  const tree = parseTree(candidateCommit);
  const manifestRows = packageManifests(candidateCommit, tree);
  const lockRows = lockfiles(candidateCommit, tree);
  const assetRows = assets(candidateCommit, tree);
  const vendorRows = vendoredComponents(candidateCommit, tree);
  const fontRows = systemFonts(candidateCommit, tree);
  const runtimeRows = await runtimeBinaries();
  const runtimeLibraryRows = await runtimeLibraryGraph(runtimeRows);
  const embeddedRows = runtimeComponents();
  const inventory = {
    schema,
    candidate: { commit: candidateCommit, tree: candidateTree, sourceLocator: `git:${candidateCommit}^{tree}` },
    generator: "ops/release/inventory/inventory.mjs",
    releaseClaim: "NO_GO",
    productionReady: false,
    approvalState: "needs_review",
    releaseBlockers,
    discovery: {
      trackedFiles: tree.length,
      packageManifests: manifestRows.length,
      workspacePackageManifests: manifestRows.filter((entry) => entry.workspaceMember).length,
      lockfiles: lockRows.length,
      vendoredComponents: vendorRows.length,
      assets: assetRows.length,
      bundledFonts: assetRows.filter((entry) => entry.kind === "font").length,
      systemFontFamilies: fontRows.length,
      runtimeBinaries: runtimeRows.length,
      runtimeLibraries: runtimeLibraryRows.length,
      runtimeLibrariesHashed: runtimeLibraryRows.filter((entry) => entry.resolutionState === "file_hashed").length,
      runtimeLinksNeedsDeploymentResolution: runtimeLibraryRows.filter((entry) => entry.resolutionState === "needs_deployment_resolution").length,
      runtimeSystemLinksNotAddressable: runtimeLibraryRows.filter((entry) => entry.resolutionState === "system_managed_not_addressable").length,
      runtimeEmbeddedComponents: embeddedRows.length,
      trackedSymlinks: 0,
      externalNetworkRequests: 0
    },
    packageManifests: manifestRows,
    lockfiles: lockRows,
    vendoredComponents: vendorRows,
    assets: assetRows,
    systemFonts: fontRows,
    runtimeBinaries: runtimeRows,
    runtimeLibraries: runtimeLibraryRows,
    runtimeComponents: embeddedRows,
    reviewItems: reviewItems()
  };
  validateSemantics(inventory);
  return stable(inventory);
}

export async function verifyInventory(filename) {
  const fileInfo = await lstat(filename);
  invariant(fileInfo.isFile() && !fileInfo.isSymbolicLink(), "inventory_file_symlink_rejected");
  const bytes = await readFile(filename, "utf8");
  let parsed;
  try { parsed = JSON.parse(bytes); } catch { throw new Error("inventory_json_invalid"); }
  invariant(bytes === canonical(parsed), "inventory_noncanonical_json_rejected");
  validateSemantics(parsed);
  const expected = await generateInventory(parsed.candidate.commit);
  invariant(canonical(parsed) === canonical(expected), "inventory_candidate_or_runtime_drift_rejected");
  return parsed;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];
  if (command === "generate") {
    const candidateCommit = option("--candidate");
    const output = option("--output");
    invariant(candidateCommit && output && path.isAbsolute(output), "inventory_generate_arguments_invalid");
    const inventory = await generateInventory(candidateCommit);
    await writeFile(output, canonical(inventory), { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ schema: "unseen-release-inventory-generation/1", status: "PASS", output,
      candidateCommit, inventorySha256: sha256(canonical(inventory)), releaseClaim: inventory.releaseClaim,
      components: inventory.packageManifests.length + inventory.lockfiles.length + inventory.vendoredComponents.length +
        inventory.assets.length + inventory.systemFonts.length + inventory.runtimeBinaries.length + inventory.runtimeLibraries.length +
        inventory.runtimeComponents.length })}\n`);
    return;
  }
  if (command === "verify") {
    const inventoryFile = option("--inventory");
    invariant(inventoryFile && path.isAbsolute(inventoryFile), "inventory_verify_arguments_invalid");
    const inventory = await verifyInventory(inventoryFile);
    process.stdout.write(`${JSON.stringify({ schema: "unseen-release-inventory-verification/1", status: "PASS",
      candidateCommit: inventory.candidate.commit, inventorySha256: sha256(canonical(inventory)),
      releaseClaim: inventory.releaseClaim, productionReady: inventory.productionReady,
      externalNetworkRequests: inventory.discovery.externalNetworkRequests })}\n`);
    return;
  }
  throw new Error("usage: inventory.mjs generate --candidate <commit> --output <absolute-path> | verify --inventory <absolute-path>");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
