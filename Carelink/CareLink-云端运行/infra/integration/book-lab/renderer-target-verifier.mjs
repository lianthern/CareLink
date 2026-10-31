import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync,
  realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHROMIUM_SNAP_ADAPTER_POLICY, CHROMIUM_SNAP_ADAPTER_POLICY_SHA256, CHROMIUM_SNAP_ADAPTER_SCHEMA,
  CHROMIUM_SNAP_BROWSER, CHROMIUM_SNAP_DISTRIBUTION_SCHEMA, CHROMIUM_SNAP_ROOT,
  chromiumSnapAdapterImplementationHash } from "./chromium-snap-headless-adapter.mjs";
import { rendererAppArmorProfileHash } from "./linux-apparmor-profile.mjs";
import { rendererChildSeccompHash } from "./linux-child-seccomp.mjs";
import { canonicalJson, exact, validateRendererAcceptanceReceipt } from "./renderer-ipc-protocol.mjs";

export const RENDERER_TARGET_VERIFICATION_SCHEMA = "unseen-book-renderer-target-verification/1";
const verifierPath = fileURLToPath(import.meta.url);
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const RELEASE_MARKER = "REQUIRED_IMMUTABLE_RELEASE_COMMIT";
const SERVICE_TEMPLATE_SHA256 = "322f4e5e07e71c1e639884e0d0cdd5cd679cfa9a3b9596c7181ed84b2411e117";
const SOCKET_TEMPLATE_SHA256 = "ef98f668dbf9711e76e560e7e0fc061bdbe628ede15b234858bf7e2ba0258476";
export const CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY = Object.freeze({
  schema: "unseen-chromium-snap-canonical-dangling-symlinks/1",
  entries: Object.freeze([
    Object.freeze({ relative: "usr/bin/xdg-email",
      pathSha256: "dee8007a503c1a1e1c71825dbf95f69a1291fa9212b811e1a1d4a65b1bae8c5e",
      target: "/usr/bin/xdg-open",
      targetSha256: "79738e9a5637b0b9bddd9f476650c24bf76c21bb07e3724f1b496b5f1b7eb2df",
      targetClass: "ABSOLUTE", uid: 0, gid: 0, mode: 0o777, nlink: 1 }),
    Object.freeze({ relative: "usr/share/groff/site-tmac",
      pathSha256: "742444591fad324f5bd10d20935f0f8f15f41d4b559275e7c85bcdfe8b03dd85",
      target: "../../../etc/groff",
      targetSha256: "731ff7aea7c4d7460cce046e077c0a41718d6fabdfd4ecb47dc3d7bf781f85f4",
      targetClass: "RELATIVE_PARENT", uid: 0, gid: 0, mode: 0o777, nlink: 1 })
  ]),
  resolution: "EXACT_ENOENT_ONLY",
  parentDac: "ROOT_OWNED_NONSYMLINK_NO_GROUP_WORLD_WRITE",
  stability: "LSTAT_READLINK_BEFORE_AFTER_REOPEN_SAME_INODE",
  runtimeReachability: "ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE"
});
export const CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY_SHA256 = sha256(canonicalJson(
  CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY));
const CHROMIUM_SNAP = Object.freeze({
  name: "chromium",
  snapId: "XKEcBqPM06H1Z7zGOdG5fbICuf8NWK5R",
  revision: 3507,
  version: "151.0.7922.108",
  arch: "amd64",
  numericRoot: CHROMIUM_SNAP_ROOT,
  browserPath: CHROMIUM_SNAP_BROWSER,
  archivePath: "/var/lib/snapd/snaps/chromium_3507.snap",
  archiveSha256: "cf10676bdf7a3b4d14201fd6004ec5c8c137ee7365779133cba7c1d39263fae0",
  archiveSha3384: "77155504d7c5fdfa516545da086bd3f31fa6f6283901e93885cbb39366ae55bea834c4042bebfc870a0330904df04c07",
  archiveBytes: 202_833_920,
  assertionSha256: "1835e6aed1d9a03ea7b42f44d01feac6fd81e2e7d72a4e27d0c97f742bdad94c",
  snapDeclarationSha256: "f405bbc39c1ba0036c25f9b0a3f8df50fb1f43a94a489bc76fe1b8d956bce080",
  signingAccountKeySha256: "a1182464402e4e7c8ee10650eb2ec247ffd2496216c9a4f3d40eac39a928b340",
  assertionsRoot: "/var/lib/snapd/assertions/asserts-v0",
  metaSha256: "eca508d9238f611e2ca4757da991e9c7624a1f3eff499936e73a38d0652b0aa0",
  officialLauncherSha256: "fd5dec09e3f53f1bf0c5cd52eafc39de8bff954bd2b4aeae1850faa0cc97e166",
  officialLauncherBytes: 6_365,
  launchpadCommit: "c7d4a5ffee0e71a3888a69f56892957cdfb8c919",
  launchpadTree: "5ced77dd54c618cc398943f587847c62473a0457",
  launchpadManifestSha256: "4e344dc0081b3bcccdb47640c4c4c8300a4f3fa0e6f1d7609e08257bf797e92a",
  treeEntryCount: 683,
  treeRegularFileCount: 591,
  treeSymlinkCount: 27,
  treeRegularBytes: 446_326_676,
  resourceCount: 224,
  treeManifestSha256: "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913",
  resourceManifestSha256: "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5",
  canonicalDanglingSymlinkCount: 2,
  canonicalDanglingSymlinkPolicySha256: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY_SHA256,
  runtimeReachability: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.runtimeReachability
});
export const RENDERER_NODE_RUNTIME = Object.freeze({
  version: "v22.23.2",
  executablePath: "/opt/unseen/runtime/node-v22.23.2-linux-x64/bin/node",
  executableSha256: "3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327",
  archiveUrl: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz",
  archivePath: "/opt/unseen/runtime/sources/node-v22.23.2/node-v22.23.2-linux-x64.tar.xz",
  archiveSha256: "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
  archiveBytes: 31_058_332,
  signedShasumsUrl: "https://nodejs.org/dist/v22.23.2/SHASUMS256.txt.asc",
  signedShasumsPath: "/opt/unseen/runtime/sources/node-v22.23.2/SHASUMS256.txt.asc",
  signedShasumsSha256: "cfcf12eb3146d641be185d08ca018166b98495b1d8e5f7f94ab77f9965b651d2",
  releaseKeyringUrl: "https://raw.githubusercontent.com/nodejs/release-keys/" +
    "b28073028e6d6855cfb53bf7fa0137599c01f967/gpg/pubring.kbx",
  releaseKeyringPath: "/opt/unseen/runtime/trust/node-release-keys-b28073028e6d6855cfb53bf7fa0137599c01f967.kbx",
  releaseKeyringSha256: "6030d4e0cd53330acf2ab68acd455b7ca98bb5d5975376f0b7c0892308ba2d57",
  releaseKeyringBytes: 95_960,
  releaseKeysCommit: "b28073028e6d6855cfb53bf7fa0137599c01f967",
  checksumPinPath: "/run/unseen/approvals/node-runtime.sha256"
});
const buildPaths = [
  "infra/integration/book-lab/chromium-snap-headless-adapter.mjs",
  "infra/integration/book-lab/linux-apparmor-profile.mjs",
  "infra/integration/book-lab/linux-child-seccomp.mjs",
  "infra/integration/book-lab/linux-render-sandbox.mjs",
  "infra/integration/book-lab/network-deny.mjs",
  "infra/integration/book-lab/render-worker-adapter.mjs",
  "infra/integration/book-lab/renderer-client.mjs",
  "infra/integration/book-lab/renderer-ipc-protocol.mjs",
  "infra/integration/book-lab/renderer-service.mjs"
];

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha3384(bytes) { return createHash("sha3-384").update(bytes).digest("hex"); }

export const CHROMIUM_SNAP_ARCHIVE_LINK_POLICY = Object.freeze({
  schema: "unseen-snapd-cache-hardlink-policy/1",
  archivePath: CHROMIUM_SNAP.archivePath,
  cacheDirectory: "/var/lib/snapd/cache",
  cacheKeySha3384: CHROMIUM_SNAP.archiveSha3384,
  archiveUid: 0,
  archiveGid: 0,
  archiveMode: 0o600,
  cacheDirectoryUid: 0,
  cacheDirectoryGid: 0,
  cacheDirectoryMode: 0o700,
  allowedStates: Object.freeze(["ARCHIVE_ONLY", "ARCHIVE_AND_SNAPD_SHA3_CACHE"]),
  fileDacSource: "TARGET_OBSERVED_EVIDENCE_87687C956770A409F040EC15C5BBBF9F93AA70A9",
  cacheDirectoryDacSource: "SNAPD_SOURCE_POLICY_93A01322CDC0AD70AFCD641FF31FCF7BF070F144",
  ancestorDacSource: "ROOT_OWNED_NONSYMLINK_NO_GROUP_WORLD_WRITE",
  stabilityPolicy: "O_NOFOLLOW_FSTAT_BEFORE_AFTER_REOPEN_SAME_INODE"
});
export const CHROMIUM_SNAP_ARCHIVE_LINK_POLICY_SHA256 = sha256(canonicalJson(
  CHROMIUM_SNAP_ARCHIVE_LINK_POLICY));

const STABLE_STAT_FIELDS = Object.freeze(["dev", "ino", "nlink", "uid", "gid", "mode", "size", "mtimeNs",
  "ctimeNs"]);

function sameStableStat(left, right) {
  return STABLE_STAT_FIELDS.every((field) => left[field] === right[field]);
}

const chromiumDanglingSymlinks = new Map(CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.entries
  .map((entry) => [entry.relative, entry]));

function checkedStableParentDirectories(filename, boundary, expectedUid) {
  const normalizedBoundary = path.resolve(boundary);
  let current = path.dirname(filename);
  if (current !== normalizedBoundary && !current.startsWith(`${normalizedBoundary}${path.sep}`)) {
    throw new Error("renderer_target_browser_tree_invalid");
  }
  while (true) {
    try {
      const stat = lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(expectedUid) ||
        Number(stat.mode & 0o7777n) & 0o022) throw new Error("renderer_target_browser_tree_invalid");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === normalizedBoundary) return;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("renderer_target_browser_tree_invalid");
    current = parent;
  }
}

function checkedCanonicalSourceObservation(filename, relative, entry, sourceMetadata = entry) {
  const stat = lstatSync(filename, { bigint: true });
  const target = readlinkSync(filename);
  if (!stat.isSymbolicLink() || stat.uid !== BigInt(sourceMetadata.uid) ||
    stat.gid !== BigInt(sourceMetadata.gid) || Number(stat.mode & 0o7777n) !== sourceMetadata.mode ||
    stat.nlink !== BigInt(sourceMetadata.nlink) || relative !== entry.relative ||
    sha256(relative) !== entry.pathSha256 || target !== entry.target || sha256(target) !== entry.targetSha256) {
    throw new Error("renderer_target_browser_tree_invalid");
  }
  return { stat, target };
}

function requireExactPathAbsent(filename) {
  try { lstatSync(filename, { bigint: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("renderer_target_browser_tree_invalid");
}

function checkedCanonicalDanglingSymlink(root, entry, absoluteRoot = "/", testOnlyAfterFirstCheck = null,
  testOnlySourceMetadata = null) {
  try {
    const sourceMetadata = testOnlySourceMetadata ?? entry;
    const filename = path.join(root, ...entry.relative.split("/"));
    const relative = path.relative(root, filename).split(path.sep).join("/");
    if (relative !== entry.relative) {
      throw new Error("renderer_target_browser_tree_invalid");
    }
    checkedStableParentDirectories(filename, root, sourceMetadata.uid);
    const before = checkedCanonicalSourceObservation(filename, relative, entry, sourceMetadata);
    const targetPath = entry.targetClass === "ABSOLUTE" ?
      path.join(absoluteRoot, ...entry.target.slice(1).split("/")) :
      path.resolve(path.dirname(filename), entry.target);
    const targetBoundary = entry.targetClass === "ABSOLUTE" ? absoluteRoot : root;
    const targetUid = entry.targetClass === "ABSOLUTE" && absoluteRoot === "/" ? 0 : sourceMetadata.uid;
    if (entry.targetClass === "ABSOLUTE" && (!path.isAbsolute(entry.target) ||
      path.normalize(entry.target) !== entry.target || path.resolve(absoluteRoot) !== absoluteRoot) ||
      entry.targetClass === "RELATIVE_PARENT" &&
        (path.isAbsolute(entry.target) || targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`))) {
      throw new Error("renderer_target_browser_tree_invalid");
    }
    checkedStableParentDirectories(targetPath, targetBoundary, targetUid);
    requireExactPathAbsent(targetPath);
    testOnlyAfterFirstCheck?.(entry, filename, targetPath);
    const after = checkedCanonicalSourceObservation(filename, relative, entry, sourceMetadata);
    checkedStableParentDirectories(targetPath, targetBoundary, targetUid);
    requireExactPathAbsent(targetPath);
    const reopened = checkedCanonicalSourceObservation(filename, relative, entry, sourceMetadata);
    checkedStableParentDirectories(targetPath, targetBoundary, targetUid);
    requireExactPathAbsent(targetPath);
    if (!sameStableStat(before.stat, after.stat) || !sameStableStat(before.stat, reopened.stat) ||
      after.target !== before.target || reopened.target !== before.target) {
      throw new Error("renderer_target_browser_tree_invalid");
    }
    return Object.freeze({ relative: entry.relative, target: entry.target, targetClass: entry.targetClass });
  } catch {
    throw new Error("renderer_target_browser_tree_invalid");
  }
}

export function verifyChromiumSnapCanonicalDanglingSymlinks(root = CHROMIUM_SNAP_ROOT, expectedUid = 0) {
  if (expectedUid !== 0) {
    throw new Error("renderer_target_browser_tree_invalid");
  }
  const entries = CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.entries.map((entry) =>
    checkedCanonicalDanglingSymlink(root, entry));
  return Object.freeze({ schema: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.schema,
    sha256: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY_SHA256, count: entries.length,
    runtimeReachability: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.runtimeReachability });
}

export function verifyChromiumSnapCanonicalDanglingSymlinksForTest(root, expectedUid, absoluteRoot,
  testOnlyAfterFirstCheck = null, testOnlySourceMetadata = null) {
  if (!path.isAbsolute(root) || !path.isAbsolute(absoluteRoot) || path.normalize(absoluteRoot) !== absoluteRoot ||
    !Number.isSafeInteger(expectedUid) || expectedUid < 0 ||
    testOnlyAfterFirstCheck !== null && typeof testOnlyAfterFirstCheck !== "function" ||
    !testOnlySourceMetadata || testOnlySourceMetadata.uid !== expectedUid ||
    !["gid", "mode", "nlink"].every((field) => Number.isSafeInteger(testOnlySourceMetadata[field]))) {
    throw new Error("renderer_target_browser_tree_invalid");
  }
  const entries = CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.entries.map((entry) =>
    checkedCanonicalDanglingSymlink(root, entry, absoluteRoot, testOnlyAfterFirstCheck, testOnlySourceMetadata));
  return Object.freeze({ schema: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.schema,
    sha256: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY_SHA256, count: entries.length,
    runtimeReachability: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.runtimeReachability });
}

export function validateChromiumSnapDanglingSymlinkObservationForTest(value, index = 0) {
  const entry = CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.entries[index];
  if (entry === undefined || !value || typeof value !== "object") {
    throw new Error("renderer_target_browser_tree_invalid");
  }
  const stat = { isSymbolicLink: () => value.type === "symlink", uid: BigInt(value.uid), gid: BigInt(value.gid),
    mode: BigInt(value.mode), nlink: BigInt(value.nlink) };
  if (!stat.isSymbolicLink() || stat.uid !== BigInt(entry.uid) || stat.gid !== BigInt(entry.gid) ||
    Number(stat.mode & 0o7777n) !== entry.mode || stat.nlink !== BigInt(entry.nlink) ||
    value.relative !== entry.relative || sha256(value.relative) !== entry.pathSha256 ||
    value.target !== entry.target || sha256(value.target) !== entry.targetSha256) {
    throw new Error("renderer_target_browser_tree_invalid");
  }
  return true;
}

function checkedPolicyDirectory(filename, { expectedUid, expectedGid, exactMode = null }) {
  const stat = lstatSync(filename, { bigint: true });
  const mode = Number(stat.mode & 0o7777n);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(expectedUid) ||
    stat.gid !== BigInt(expectedGid) || mode & 0o022 || exactMode !== null && mode !== exactMode) {
    throw new Error("renderer_target_browser_archive_invalid");
  }
}

function checkedArchiveFileDescriptor(filename, policy) {
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(descriptor, { bigint: true });
  if (!stat.isFile() || stat.uid !== BigInt(policy.expectedUid) || stat.gid !== BigInt(policy.expectedGid) ||
    Number(stat.mode & 0o7777n) !== policy.fileMode || stat.size !== BigInt(policy.expectedBytes) ||
    stat.nlink < 1n || stat.nlink > 2n) {
    closeSync(descriptor);
    throw new Error("renderer_target_browser_archive_invalid");
  }
  return { descriptor, stat };
}

function requireAbsentPath(filename) {
  let descriptor = null;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("renderer_target_browser_archive_invalid");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  throw new Error("renderer_target_browser_archive_invalid");
}

function measureSnapdArchiveLinkTopology(policy, testOnlyAfterRead = null) {
  try {
    if (!/^[a-f0-9]{96}$/u.test(policy.expectedSha3384) || path.dirname(policy.cachePath) !== policy.cacheDirectory ||
      path.basename(policy.cachePath) !== policy.expectedSha3384) {
      throw new Error("renderer_target_browser_archive_invalid");
    }
    for (const directory of policy.ancestorDirectories) checkedPolicyDirectory(directory, policy);
    checkedPolicyDirectory(policy.cacheDirectory, { ...policy, exactMode: policy.cacheDirectoryMode });
    const archive = checkedArchiveFileDescriptor(policy.archivePath, policy);
    let cache = null;
    try {
      if (archive.stat.nlink === 2n) {
        cache = checkedArchiveFileDescriptor(policy.cachePath, policy);
        if (cache.stat.nlink !== 2n || cache.stat.dev !== archive.stat.dev || cache.stat.ino !== archive.stat.ino ||
          !sameStableStat(cache.stat, archive.stat)) throw new Error("renderer_target_browser_archive_invalid");
      } else requireAbsentPath(policy.cachePath);
      const bytes = readFileSync(archive.descriptor);
      testOnlyAfterRead?.();
      const archiveAfter = fstatSync(archive.descriptor, { bigint: true });
      const cacheAfter = cache === null ? null : fstatSync(cache.descriptor, { bigint: true });
      if (!sameStableStat(archive.stat, archiveAfter) || cache !== null &&
        (!sameStableStat(cache.stat, cacheAfter) || cacheAfter.dev !== archiveAfter.dev ||
          cacheAfter.ino !== archiveAfter.ino) || bytes.length !== policy.expectedBytes ||
        sha256(bytes) !== policy.expectedSha256 || sha3384(bytes) !== policy.expectedSha3384) {
        throw new Error("renderer_target_browser_archive_invalid");
      }
      const archiveReopened = checkedArchiveFileDescriptor(policy.archivePath, policy);
      let cacheReopened = null;
      try {
        if (!sameStableStat(archiveAfter, archiveReopened.stat)) {
          throw new Error("renderer_target_browser_archive_invalid");
        }
        if (cache !== null) {
          cacheReopened = checkedArchiveFileDescriptor(policy.cachePath, policy);
          if (!sameStableStat(cacheAfter, cacheReopened.stat) || cacheReopened.stat.dev !== archiveReopened.stat.dev ||
            cacheReopened.stat.ino !== archiveReopened.stat.ino) {
            throw new Error("renderer_target_browser_archive_invalid");
          }
        } else requireAbsentPath(policy.cachePath);
      } finally {
        if (cacheReopened !== null) closeSync(cacheReopened.descriptor);
        closeSync(archiveReopened.descriptor);
      }
      for (const directory of policy.ancestorDirectories) checkedPolicyDirectory(directory, policy);
      checkedPolicyDirectory(policy.cacheDirectory, { ...policy, exactMode: policy.cacheDirectoryMode });
      return Object.freeze({ schema: "unseen-snapd-cache-link-topology/1",
        state: cache === null ? "ARCHIVE_ONLY" : "ARCHIVE_AND_SNAPD_SHA3_CACHE",
        linkCount: Number(archiveAfter.nlink), policySha256: policy.policySha256 });
    } finally {
      if (cache !== null) closeSync(cache.descriptor);
      closeSync(archive.descriptor);
    }
  } catch (error) {
    if (error?.message === "renderer_target_browser_archive_invalid") throw error;
    throw new Error("renderer_target_browser_archive_invalid");
  }
}

export function measureSnapdArchiveLinkTopologyForTest(policy, testOnlyAfterRead = null) {
  return measureSnapdArchiveLinkTopology(policy, testOnlyAfterRead);
}

function checkedFile(filename, options = {}) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
    options.executable === true && !(stat.mode & 0o111) ||
    options.rootOwned === true && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) {
    throw new Error("renderer_target_file_invalid");
  }
  const bytes = readFileSync(filename);
  return { path: filename, sha256: sha256(bytes), bytes: bytes.length };
}

function checkedExactFile(filename, { expectedUid, expectedGid = null, mode, sha256: expectedSha256,
  bytes: expectedBytes = null, executable = false }) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== expectedUid ||
    expectedGid !== null && stat.gid !== expectedGid || (stat.mode & 0o7777) !== mode ||
    executable && !(stat.mode & 0o111)) throw new Error("renderer_target_node_runtime_invalid");
  const contents = readFileSync(filename);
  if (sha256(contents) !== expectedSha256 || expectedBytes !== null && contents.length !== expectedBytes) {
    throw new Error("renderer_target_node_runtime_invalid");
  }
  return Object.freeze({ path: filename, sha256: expectedSha256, bytes: contents.length, contents });
}

function checkedParentDirectories(paths, expectedUid, boundary) {
  for (const directory of new Set(paths.flatMap((filename) => {
    const parents = [];
    let current = path.dirname(filename);
    while (current !== path.dirname(boundary)) {
      if (current !== boundary && !(boundary === "/" ? current.startsWith("/") :
        current.startsWith(`${boundary}/`))) {
        throw new Error("renderer_target_node_runtime_parent_invalid");
      }
      parents.push(current);
      if (current === boundary) break;
      current = path.dirname(current);
    }
    return parents;
  }))) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
      throw new Error("renderer_target_node_runtime_parent_invalid");
    }
  }
}

function keyChromiumResource(relative) {
  const base = path.posix.basename(relative);
  return relative.includes("/locales/") && base.endsWith(".pak") ||
    new Set(["resources.pak", "icudtl.dat", "snapshot_blob.bin", "v8_context_snapshot.bin",
      "chrome_crashpad_handler"]).has(base);
}

export function measureChromiumSnapTree(root = CHROMIUM_SNAP_ROOT, expectedUid = 0) {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    throw new Error("renderer_target_browser_tree_invalid");
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== expectedUid ||
    (rootStat.mode & 0o022) !== 0) throw new Error("renderer_target_browser_tree_invalid");
  const rootReal = realpathSync(root);
  const entries = [];
  const canonicalDanglingSymlinks = new Set();
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const filename = path.join(directory, name);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      if (!relative || relative.startsWith("../") || relative.includes("\0")) {
        throw new Error("renderer_target_browser_tree_invalid");
      }
      const stat = lstatSync(filename);
      if (stat.uid !== expectedUid || stat.isFile() && (stat.nlink !== 1 || (stat.mode & 0o022) !== 0) ||
        stat.isDirectory() && (stat.mode & 0o022) !== 0) {
        throw new Error("renderer_target_browser_tree_invalid");
      }
      let type;
      let symlinkTarget = null;
      let fileBytes = null;
      let fileSha256 = null;
      if (stat.isFile()) {
        type = "file";
        const bytes = readFileSync(filename);
        fileBytes = bytes.length;
        fileSha256 = sha256(bytes);
      } else if (stat.isDirectory()) {
        type = "directory";
      } else if (stat.isSymbolicLink()) {
        type = "symlink";
        symlinkTarget = readlinkSync(filename);
        if (typeof symlinkTarget !== "string" || symlinkTarget.length < 1 || symlinkTarget.length > 1_024 ||
          /[\u0000-\u001f\u007f]/u.test(symlinkTarget)) throw new Error("renderer_target_browser_tree_invalid");
        const danglingPolicyEntry = chromiumDanglingSymlinks.get(relative);
        if (danglingPolicyEntry !== undefined) {
          if (expectedUid !== 0) throw new Error("renderer_target_browser_tree_invalid");
          checkedCanonicalDanglingSymlink(root, danglingPolicyEntry);
          canonicalDanglingSymlinks.add(relative);
        } else {
          let resolved;
          try { resolved = realpathSync(filename); }
          catch { throw new Error("renderer_target_browser_tree_invalid"); }
          if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) {
            throw new Error("renderer_target_browser_tree_invalid");
          }
        }
      } else throw new Error("renderer_target_browser_tree_invalid");
      entries.push({ relative, type, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, nlink: stat.nlink,
        symlinkTarget, fileBytes, fileSha256 });
      if (entries.length > 200_000) throw new Error("renderer_target_browser_tree_invalid");
      if (type === "directory") walk(filename);
    }
  }
  walk(root);
  entries.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const resources = entries.filter((entry) => entry.type === "file" && keyChromiumResource(entry.relative));
  return Object.freeze({ treeManifestSha256: sha256(canonicalJson(entries)), treeEntryCount: entries.length,
    treeRegularFileCount: entries.filter((entry) => entry.type === "file").length,
    treeSymlinkCount: entries.filter((entry) => entry.type === "symlink").length,
    treeRegularBytes: entries.reduce((total, entry) => total + (entry.fileBytes ?? 0), 0),
    resourceManifestSha256: sha256(canonicalJson(resources)), resourceCount: resources.length,
    canonicalDanglingSymlinkCount: canonicalDanglingSymlinks.size,
    canonicalDanglingSymlinkPolicySha256: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY_SHA256,
    runtimeReachability: CHROMIUM_SNAP_DANGLING_SYMLINK_POLICY.runtimeReachability });
}

function findAssertion(root, expectedHash) {
  let found = null;
  let seen = 0;
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const filename = path.join(directory, name);
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        throw new Error("renderer_target_browser_assertion_invalid");
      }
      if (stat.isDirectory()) walk(filename);
      else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error("renderer_target_browser_assertion_invalid");
        seen += 1;
        if (seen > 20_000) throw new Error("renderer_target_browser_assertion_invalid");
        if (sha256(readFileSync(filename)) === expectedHash) {
          if (found !== null) throw new Error("renderer_target_browser_assertion_invalid");
          found = filename;
        }
      } else throw new Error("renderer_target_browser_assertion_invalid");
    }
  }
  walk(root);
  if (found === null) throw new Error("renderer_target_browser_assertion_invalid");
}

export function measureChromiumSnapDistribution() {
  const archiveLinkTopology = measureSnapdArchiveLinkTopology({
    archivePath: CHROMIUM_SNAP.archivePath,
    cacheDirectory: CHROMIUM_SNAP_ARCHIVE_LINK_POLICY.cacheDirectory,
    cachePath: path.join(CHROMIUM_SNAP_ARCHIVE_LINK_POLICY.cacheDirectory, CHROMIUM_SNAP.archiveSha3384),
    expectedSha256: CHROMIUM_SNAP.archiveSha256,
    expectedSha3384: CHROMIUM_SNAP.archiveSha3384,
    expectedBytes: CHROMIUM_SNAP.archiveBytes,
    expectedUid: CHROMIUM_SNAP_ARCHIVE_LINK_POLICY.archiveUid,
    expectedGid: CHROMIUM_SNAP_ARCHIVE_LINK_POLICY.archiveGid,
    fileMode: CHROMIUM_SNAP_ARCHIVE_LINK_POLICY.archiveMode,
    cacheDirectoryMode: CHROMIUM_SNAP_ARCHIVE_LINK_POLICY.cacheDirectoryMode,
    ancestorDirectories: ["/", "/var", "/var/lib", "/var/lib/snapd", "/var/lib/snapd/snaps"],
    policySha256: CHROMIUM_SNAP_ARCHIVE_LINK_POLICY_SHA256
  });
  findAssertion(CHROMIUM_SNAP.assertionsRoot, CHROMIUM_SNAP.assertionSha256);
  findAssertion(CHROMIUM_SNAP.assertionsRoot, CHROMIUM_SNAP.snapDeclarationSha256);
  findAssertion(CHROMIUM_SNAP.assertionsRoot, CHROMIUM_SNAP.signingAccountKeySha256);
  const meta = checkedFile(path.join(CHROMIUM_SNAP.numericRoot, "meta/snap.yaml"), { rootOwned: true });
  const launcher = checkedFile(path.join(CHROMIUM_SNAP.numericRoot, "bin/chromium.launcher"), { rootOwned: true });
  if (meta.sha256 !== CHROMIUM_SNAP.metaSha256 || launcher.sha256 !== CHROMIUM_SNAP.officialLauncherSha256 ||
    launcher.bytes !== CHROMIUM_SNAP.officialLauncherBytes) {
    throw new Error("renderer_target_browser_metadata_invalid");
  }
  verifyChromiumSnapCanonicalDanglingSymlinks(CHROMIUM_SNAP.numericRoot);
  const tree = measureChromiumSnapTree(CHROMIUM_SNAP.numericRoot);
  for (const field of ["treeEntryCount", "treeRegularFileCount", "treeSymlinkCount", "treeRegularBytes",
    "resourceCount", "treeManifestSha256", "resourceManifestSha256", "canonicalDanglingSymlinkCount",
    "canonicalDanglingSymlinkPolicySha256", "runtimeReachability"]) {
    if (tree[field] !== CHROMIUM_SNAP[field]) throw new Error("renderer_target_browser_tree_invalid");
  }
  return Object.freeze({ schema: CHROMIUM_SNAP_DISTRIBUTION_SCHEMA, name: CHROMIUM_SNAP.name,
    snapId: CHROMIUM_SNAP.snapId, revision: CHROMIUM_SNAP.revision, version: CHROMIUM_SNAP.version,
    arch: CHROMIUM_SNAP.arch, numericRoot: CHROMIUM_SNAP.numericRoot, archivePath: CHROMIUM_SNAP.archivePath,
    archiveSha256: CHROMIUM_SNAP.archiveSha256, archiveSha3384: CHROMIUM_SNAP.archiveSha3384,
    archiveBytes: CHROMIUM_SNAP.archiveBytes, archiveLinkTopology,
    assertionSha256: CHROMIUM_SNAP.assertionSha256,
    snapDeclarationSha256: CHROMIUM_SNAP.snapDeclarationSha256,
    signingAccountKeySha256: CHROMIUM_SNAP.signingAccountKeySha256,
    assertionSignatureVerified: false, metaSha256: CHROMIUM_SNAP.metaSha256,
    officialLauncherSha256: CHROMIUM_SNAP.officialLauncherSha256,
    officialLauncherBytes: CHROMIUM_SNAP.officialLauncherBytes,
    launchpadCommit: CHROMIUM_SNAP.launchpadCommit, launchpadTree: CHROMIUM_SNAP.launchpadTree,
    launchpadManifestSha256: CHROMIUM_SNAP.launchpadManifestSha256, ...tree,
    licenseDeclaration: "UNDECLARED_IN_CANONICAL_ASSERTION_AND_LOCAL_META",
    securityReview: "REQUIRED_NOT_INCLUDED", releaseDecision: "NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED" });
}

function measureChromiumSnapAdapter() {
  return Object.freeze({ ...CHROMIUM_SNAP_ADAPTER_POLICY,
    implementationSha256: chromiumSnapAdapterImplementationHash(),
    policySha256: CHROMIUM_SNAP_ADAPTER_POLICY_SHA256 });
}

export function validateNodeRuntimeTarget({ runtime = RENDERER_NODE_RUNTIME, expectedUid = 0, expectedIpcGid,
  processExecPath = process.execPath, commandRunner = runTargetCommand, parentBoundary = "/" }) {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0 || !Number.isSafeInteger(expectedIpcGid) ||
    expectedIpcGid < 1 || processExecPath !== runtime.executablePath) {
    throw new Error("renderer_target_node_runtime_invalid");
  }
  checkedParentDirectories([runtime.executablePath, runtime.archivePath, runtime.signedShasumsPath,
    runtime.releaseKeyringPath, runtime.checksumPinPath], expectedUid, parentBoundary);
  checkedExactFile(runtime.executablePath, { expectedUid, mode: 0o755, sha256: runtime.executableSha256,
    executable: true });
  checkedExactFile(runtime.archivePath, { expectedUid, mode: 0o644, sha256: runtime.archiveSha256,
    bytes: runtime.archiveBytes });
  checkedExactFile(runtime.signedShasumsPath, { expectedUid, mode: 0o644,
    sha256: runtime.signedShasumsSha256 });
  checkedExactFile(runtime.releaseKeyringPath, { expectedUid, mode: 0o644,
    sha256: runtime.releaseKeyringSha256, bytes: runtime.releaseKeyringBytes });
  const checksumBytes = Buffer.from(`${runtime.executableSha256}  ${runtime.executablePath}\n`);
  checkedExactFile(runtime.checksumPinPath, { expectedUid, expectedGid: expectedIpcGid, mode: 0o640,
    sha256: sha256(checksumBytes), bytes: checksumBytes.length });
  if (!readFileSync(runtime.checksumPinPath).equals(checksumBytes)) {
    throw new Error("renderer_target_node_runtime_invalid");
  }
  const versionResult = commandRunner(runtime.executablePath, ["--version"]);
  validateTargetCommandResult(versionResult, [0], "renderer_target_node_runtime_invalid");
  if (versionResult.stdout !== `${runtime.version}\n` || versionResult.stderr !== "") {
    throw new Error("renderer_target_node_runtime_invalid");
  }
  const signatureResult = commandRunner("/usr/bin/gpgv", ["--keyring", runtime.releaseKeyringPath,
    "--output", "-", runtime.signedShasumsPath]);
  validateTargetCommandResult(signatureResult, [0], "renderer_target_node_runtime_signature_invalid");
  const expectedLine = `${runtime.archiveSha256}  ${path.basename(runtime.archivePath)}`;
  if (signatureResult.stdout.split("\n").filter((line) => line === expectedLine).length !== 1) {
    throw new Error("renderer_target_node_runtime_signature_invalid");
  }
  const checksumPinSha256 = sha256(checksumBytes);
  return Object.freeze({
    node: { path: runtime.executablePath, sha256: runtime.executableSha256, version: runtime.version },
    nodeDistribution: { schema: "unseen-node-runtime-distribution/1", archiveUrl: runtime.archiveUrl,
      archivePath: runtime.archivePath, archiveSha256: runtime.archiveSha256, archiveBytes: runtime.archiveBytes,
      signedShasumsUrl: runtime.signedShasumsUrl, signedShasumsPath: runtime.signedShasumsPath,
      signedShasumsSha256: runtime.signedShasumsSha256, releaseKeyringUrl: runtime.releaseKeyringUrl,
      releaseKeyringPath: runtime.releaseKeyringPath, releaseKeyringSha256: runtime.releaseKeyringSha256,
      releaseKeyringBytes: runtime.releaseKeyringBytes, releaseKeysCommit: runtime.releaseKeysCommit,
      verificationMethod: "gpgv-pinned-keyring+signed-shasums+sha256sum/v1",
      checksumPinPath: runtime.checksumPinPath, checksumPinSha256 }
  });
}

function runTargetCommand(commandPath, args, options = {}) {
  return spawnSync(commandPath, args, { cwd: options.cwd, encoding: "utf8", timeout: 15_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
}

function command(commandPath, args, options = {}) {
  const result = runTargetCommand(commandPath, args, options);
  validateTargetCommandResult(result, options.allowedStatuses ?? [0], options.code);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export function validateTargetCommandResult(result, allowedStatuses = [0], code = "renderer_target_command_failed") {
  if (!result || result.error || !Number.isSafeInteger(result.status) || !allowedStatuses.includes(result.status) ||
    typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new Error(code);
  return result;
}

function executablePin(filename, args) {
  const pin = checkedFile(filename, { executable: true, rootOwned: true });
  const version = command(filename, args);
  if (!version || version.length > 240) throw new Error("renderer_target_version_invalid");
  return { path: pin.path, sha256: pin.sha256, version };
}

function git(repositoryRoot, args) {
  return execFileSync("git", ["-c", `safe.directory=${repositoryRoot}`, ...args], { cwd: repositoryRoot, encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } }).trim();
}

export function rendererVerifierBuildHash() { return sha256(readFileSync(verifierPath)); }

export function rendererImplementationHash(repositoryRoot) {
  const rendererFiles = readdirSync(path.join(repositoryRoot, "packages/book-renderer/src"))
    .filter((name) => name.endsWith(".mjs")).sort()
    .map((name) => `packages/book-renderer/src/${name}`);
  const records = [...buildPaths, ...rendererFiles].map((relative) => ({ relative,
    sha256: checkedFile(path.join(repositoryRoot, relative)).sha256 }));
  return sha256(canonicalJson(records));
}

function fontInventory() {
  const names = command("/usr/bin/fc-list", ["--format=%{file}\n"]).split("\n").filter(Boolean);
  const files = [...new Set(names.map((name) => realpathSync(name)))].sort();
  if (files.length < 1) throw new Error("renderer_target_fonts_invalid");
  const records = files.map((filename) => ({ path: filename,
    sha256: checkedFile(filename, { rootOwned: true }).sha256 }));
  return { sha256: sha256(canonicalJson(records)), count: records.length };
}

function pdfTools() {
  const records = [["/usr/bin/pdftotext", ["-v"]], ["/usr/bin/pdfinfo", ["-v"]]].map(([filename, args]) => {
    const pin = checkedFile(filename, { executable: true, rootOwned: true });
    const version = command(filename, args);
    if (!version) throw new Error("renderer_target_pdf_tools_invalid");
    return { path: filename, sha256: pin.sha256, version };
  });
  return { sha256: sha256(canonicalJson(records)), count: records.length };
}

function propertyMap(output, expectedKeys, omittedDefaults = {}) {
  if (typeof output !== "string") throw new Error("renderer_target_systemd_properties_invalid");
  const records = new Map();
  for (const line of output.split("\n").filter(Boolean)) {
    const separator = line.indexOf("=");
    if (separator < 1 || records.has(line.slice(0, separator))) {
      throw new Error("renderer_target_systemd_properties_invalid");
    }
    records.set(line.slice(0, separator), line.slice(separator + 1));
  }
  for (const [key, value] of Object.entries(omittedDefaults)) {
    if (!expectedKeys.includes(key)) throw new Error("renderer_target_systemd_properties_invalid");
    if (!records.has(key)) records.set(key, value);
  }
  if (records.size !== expectedKeys.length || expectedKeys.some((key) => !records.has(key))) {
    throw new Error("renderer_target_systemd_properties_invalid");
  }
  return records;
}

function exactSet(value, expected) {
  return value.split(/\s+/u).filter(Boolean).sort().join("\0") === [...expected].sort().join("\0");
}

export function validateSystemdUnitSources(servicePath, socketPath, templateRoot, candidateCommit) {
  if (!COMMIT.test(candidateCommit) || !path.isAbsolute(templateRoot)) {
    throw new Error("renderer_target_systemd_unit_invalid");
  }
  const serviceTemplate = readFileSync(path.join(templateRoot,
    "ops/release/unseen-book-renderer.service.example"));
  const socketTemplate = readFileSync(path.join(templateRoot,
    "ops/release/unseen-book-renderer.socket.example"));
  if (sha256(serviceTemplate) !== SERVICE_TEMPLATE_SHA256 || sha256(socketTemplate) !== SOCKET_TEMPLATE_SHA256) {
    throw new Error("renderer_target_systemd_template_invalid");
  }
  const source = serviceTemplate.toString("utf8");
  if (source.split(RELEASE_MARKER).length !== 2 || source.replace(RELEASE_MARKER, candidateCommit)
    .includes("REQUIRED_")) throw new Error("renderer_target_systemd_unit_invalid");
  const expectedService = Buffer.from(source.replace(RELEASE_MARKER, candidateCommit));
  if (!readFileSync(servicePath).equals(expectedService) || !readFileSync(socketPath).equals(socketTemplate)) {
    throw new Error("renderer_target_systemd_unit_invalid");
  }
}

export function validateSystemdProperties(serviceOutput, socketOutput, { servicePath, socketPath,
  repositoryRoot }) {
  const serviceKeys = ["Id", "Names", "TriggeredBy", "User", "Group", "WorkingDirectory", "FragmentPath", "DropInPaths", "Restart",
    "RestartUSec", "TimeoutStartUSec", "TimeoutStopUSec", "UMask", "NoNewPrivileges", "PrivateNetwork",
    "EnvironmentFiles", "UnsetEnvironment",
    "IPAddressDeny", "RestrictAddressFamilies", "AppArmorProfile", "CapabilityBoundingSet",
    "AmbientCapabilities", "SystemCallArchitectures", "RestrictNamespaces", "LockPersonality",
    "MemoryDenyWriteExecute", "RestrictRealtime", "RestrictSUIDSGID", "RemoveIPC", "PrivateDevices",
    "PrivateTmp", "ProtectClock", "ProtectControlGroups", "ProtectHome", "ProtectHostname",
    "ProtectKernelLogs", "ProtectKernelModules", "ProtectKernelTunables", "ProtectSystem", "ReadWritePaths",
    "ReadOnlyPaths", "MemoryMax", "MemorySwapMax", "CPUQuotaPerSecUSec", "TasksMax", "LimitNOFILE",
    "OOMPolicy", "StandardInput", "StandardOutput", "StandardError"];
  const socketKeys = ["Id", "Names", "Triggers", "FragmentPath", "DropInPaths", "Listen", "SocketUser", "SocketGroup", "SocketMode",
    "DirectoryMode", "RemoveOnStop", "Accept"];
  const service = propertyMap(serviceOutput, serviceKeys, { EnvironmentFiles: "" });
  const socket = propertyMap(socketOutput, socketKeys);
  const exactService = { Id: "unseen-book-renderer.service", User: "unseen-renderer", Group: "unseen-render-ipc", WorkingDirectory: repositoryRoot,
    FragmentPath: servicePath, DropInPaths: "", Restart: "on-failure", RestartUSec: "5s",
    TimeoutStartUSec: "2min", TimeoutStopUSec: "5s", UMask: "0027", PrivateNetwork: "yes",
    EnvironmentFiles: "",
    RestrictAddressFamilies: "AF_UNIX", AppArmorProfile: "unseen-book-renderer",
    CapabilityBoundingSet: "", AmbientCapabilities: "", SystemCallArchitectures: "native",
    MemoryDenyWriteExecute: "no", ProtectSystem: "strict",
    ReadWritePaths: "/var/lib/unseen/renderer-spool", MemoryMax: "805306368",
    MemorySwapMax: "0", CPUQuotaPerSecUSec: "1.500000s", TasksMax: "256", LimitNOFILE: "1024",
    OOMPolicy: "stop", StandardInput: "null", StandardOutput: "journal", StandardError: "journal" };
  for (const [key, value] of Object.entries(exactService)) {
    if (service.get(key) !== value) throw new Error("renderer_target_systemd_properties_invalid");
  }
  if (!exactSet(service.get("Names"), ["unseen-book-renderer.service"]) ||
    !exactSet(service.get("TriggeredBy"), ["unseen-book-renderer.socket"]) ||
    !exactSet(service.get("IPAddressDeny"), ["0.0.0.0/0", "::/0"])) {
    throw new Error("renderer_target_systemd_properties_invalid");
  }
  for (const key of ["NoNewPrivileges", "LockPersonality", "RestrictRealtime", "RestrictSUIDSGID", "RemoveIPC",
    "PrivateDevices", "PrivateTmp", "ProtectClock", "ProtectControlGroups", "ProtectHome", "ProtectHostname",
    "ProtectKernelLogs", "ProtectKernelModules", "ProtectKernelTunables"]) {
    if (service.get(key) !== "yes") throw new Error("renderer_target_systemd_properties_invalid");
  }
  if (!exactSet(service.get("RestrictNamespaces"), ["user", "mnt", "pid", "ipc", "uts"])) {
    throw new Error("renderer_target_systemd_properties_invalid");
  }
  if (!exactSet(service.get("UnsetEnvironment"), ["NODE_OPTIONS", "NODE_PATH", "PATH", "LD_PRELOAD",
    "LD_LIBRARY_PATH", "LD_AUDIT", "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_PROFILE", "GCONV_PATH", "BASH_ENV",
    "ENV", "PYTHONPATH", "PYTHONHOME", "PERL5OPT", "RUBYOPT", "OPENSSL_CONF", "OPENSSL_MODULES",
    "SSLKEYLOGFILE"]) ||
    !exactSet(service.get("ReadOnlyPaths"), ["/opt/unseen/runtime/node-v22.23.2-linux-x64",
      "/opt/unseen/runtime/sources/node-v22.23.2",
      "/opt/unseen/runtime/trust/node-release-keys-b28073028e6d6855cfb53bf7fa0137599c01f967.kbx",
      "/run/unseen/approvals/book-renderer-acceptance.json",
      "/run/unseen/approvals/book-renderer-acceptance.sha256", "/run/unseen/approvals/node-runtime.sha256"])) {
    throw new Error("renderer_target_systemd_properties_invalid");
  }
  const exactSocket = { Id: "unseen-book-renderer.socket", FragmentPath: socketPath, DropInPaths: "",
    Listen: "/run/unseen-renderer/render.sock (Stream)",
    SocketUser: "unseen-renderer",
    SocketGroup: "unseen-render-ipc", RemoveOnStop: "yes", Accept: "no" };
  for (const [key, value] of Object.entries(exactSocket)) {
    if (socket.get(key) !== value) throw new Error("renderer_target_systemd_properties_invalid");
  }
  if (!exactSet(socket.get("Names"), ["unseen-book-renderer.socket"]) ||
    !exactSet(socket.get("Triggers"), ["unseen-book-renderer.service"])) {
    throw new Error("renderer_target_systemd_properties_invalid");
  }
  for (const [key, value] of [["SocketMode", 0o660], ["DirectoryMode", 0o2750]]) {
    if (!/^(?:0o)?[0-7]{3,5}$/u.test(socket.get(key)) || Number.parseInt(socket.get(key).replace(/^0o/u, ""), 8) !== value) {
      throw new Error("renderer_target_systemd_properties_invalid");
    }
  }
  return Object.freeze({ service, socket });
}

function systemdMeasurement(servicePath, socketPath, repositoryRoot, candidateCommit) {
  const serviceSha256 = checkedFile(servicePath, { rootOwned: true }).sha256;
  const socketSha256 = checkedFile(socketPath, { rootOwned: true }).sha256;
  validateSystemdUnitSources(servicePath, socketPath, repositoryRoot, candidateCommit);
  const serviceKeys = "Id,Names,TriggeredBy,User,Group,WorkingDirectory,FragmentPath,DropInPaths,Restart,RestartUSec,TimeoutStartUSec," +
    "TimeoutStopUSec,UMask,NoNewPrivileges,PrivateNetwork,IPAddressDeny,RestrictAddressFamilies,AppArmorProfile," +
    "EnvironmentFiles,UnsetEnvironment," +
    "CapabilityBoundingSet,AmbientCapabilities,SystemCallArchitectures,RestrictNamespaces,LockPersonality," +
    "MemoryDenyWriteExecute,RestrictRealtime,RestrictSUIDSGID,RemoveIPC,PrivateDevices,PrivateTmp,ProtectClock," +
    "ProtectControlGroups,ProtectHome,ProtectHostname,ProtectKernelLogs,ProtectKernelModules,ProtectKernelTunables," +
    "ProtectSystem,ReadWritePaths,ReadOnlyPaths,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec,TasksMax,LimitNOFILE," +
    "OOMPolicy,StandardInput,StandardOutput,StandardError";
  const serviceProperties = command("/usr/bin/systemctl", ["show", "unseen-book-renderer.service", "--no-pager",
    `--property=${serviceKeys}`]);
  const socketProperties = command("/usr/bin/systemctl", ["show", "unseen-book-renderer.socket", "--no-pager",
    "--property=Id,Names,Triggers,FragmentPath,DropInPaths,Listen,SocketUser,SocketGroup,SocketMode,DirectoryMode,RemoveOnStop,Accept"]);
  validateSystemdProperties(serviceProperties, socketProperties, { servicePath, socketPath, repositoryRoot });
  const properties = `${serviceProperties}\n${socketProperties}`;
  const effectivePropertiesSha256 = sha256(properties.split("\n").filter(Boolean).sort().join("\n"));
  return { sha256: sha256(canonicalJson({ serviceSha256, socketSha256, effectivePropertiesSha256 })),
    serviceSha256, socketSha256, effectivePropertiesSha256 };
}

function principalMeasurements() {
  const passwd = checkedFile("/etc/passwd", { rootOwned: true });
  const groupFile = checkedFile("/etc/group", { rootOwned: true });
  const users = readFileSync(passwd.path, "utf8").split("\n").filter(Boolean).map((line) => line.split(":"));
  const groups = readFileSync(groupFile.path, "utf8").split("\n").filter(Boolean).map((line) => line.split(":"));
  const apiRecords = users.filter((record) => record[0] === "unseen" && record.length === 7);
  const rendererRecords = users.filter((record) => record[0] === "unseen-renderer" && record.length === 7);
  const groupRecords = groups.filter((record) => record[0] === "unseen-render-ipc" && record.length === 4);
  if (apiRecords.length !== 1 || rendererRecords.length !== 1 || groupRecords.length !== 1) {
    throw new Error("renderer_target_principals_invalid");
  }
  const apiUid = Number(apiRecords[0][2]);
  const rendererUid = Number(rendererRecords[0][2]);
  const rendererGid = Number(rendererRecords[0][3]);
  const ipcGid = Number(groupRecords[0][2]);
  if (![apiUid, rendererUid, rendererGid, ipcGid].every((value) => Number.isSafeInteger(value) && value > 0) ||
    apiUid === rendererUid) throw new Error("renderer_target_principals_invalid");
  return { apiUid, rendererUid, rendererGid, ipcGid, apiUser: "unseen", rendererUser: "unseen-renderer",
    ipcGroup: "unseen-render-ipc" };
}

function procCupsListeners() {
  let count = 0;
  for (const filename of ["/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp", "/proc/net/udp6"]) {
    const lines = readFileSync(filename, "utf8").trim().split("\n");
    if (lines.length < 1 || !lines[0].includes("local_address")) throw new Error("renderer_target_cups_probe_invalid");
    for (const line of lines.slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 4 || !/^[0-9A-F]+:[0-9A-F]{4}$/u.test(fields[1])) {
        throw new Error("renderer_target_cups_probe_invalid");
      }
      if (fields[1].endsWith(":0277")) count += 1;
    }
  }
  return count;
}

const cupsUnits = Object.freeze(["cups.service", "cups.socket"]);
const cupsProperties = Object.freeze(["Id", "LoadState", "ActiveState", "SubState", "UnitFileState", "FragmentPath"]);

function cupsResult(result, statuses) {
  validateTargetCommandResult(result, statuses, "renderer_target_cups_probe_invalid");
  if (result.stderr !== "") throw new Error("renderer_target_cups_probe_invalid");
  return result.stdout;
}

export function validateCupsTargetProbe({ showResults, activeResults, listenerResult = null,
  listenerCount = null, unixSocketPresent = false }) {
  if (!Array.isArray(showResults) || !Array.isArray(activeResults) || showResults.length !== cupsUnits.length ||
    activeResults.length !== cupsUnits.length || typeof unixSocketPresent !== "boolean" ||
    (listenerResult === null) === (listenerCount === null)) {
    throw new Error("renderer_target_cups_probe_invalid");
  }
  const states = showResults.map((result, index) => {
    let values;
    try { values = propertyMap(cupsResult(result, [0]), cupsProperties); }
    catch { throw new Error("renderer_target_cups_probe_invalid"); }
    if (values.get("Id") !== cupsUnits[index] || values.get("ActiveState") !== "inactive" ||
      values.get("SubState") !== "dead") throw new Error("renderer_target_cups_probe_invalid");
    const absent = values.get("LoadState") === "not-found" && values.get("UnitFileState") === "" &&
      values.get("FragmentPath") === "";
    const installed = (values.get("LoadState") === "loaded" && values.get("UnitFileState") === "disabled" ||
      values.get("LoadState") === "masked" && values.get("UnitFileState") === "masked") &&
      path.isAbsolute(values.get("FragmentPath"));
    if (!absent && !installed) throw new Error("renderer_target_cups_probe_invalid");
    const active = activeResults[index];
    cupsResult(active, [absent ? 4 : 3]);
    if (!/^inactive\n?$/u.test(active.stdout)) throw new Error("renderer_target_cups_probe_invalid");
    return absent ? "absent" : "installed";
  });
  if (new Set(states).size !== 1) throw new Error("renderer_target_cups_probe_invalid");
  let listeners;
  if (listenerResult !== null) {
    const output = cupsResult(listenerResult, [0]);
    listeners = output.trim() === "" ? 0 : 1;
  } else {
    if (!Number.isSafeInteger(listenerCount) || listenerCount < 0) {
      throw new Error("renderer_target_cups_probe_invalid");
    }
    listeners = listenerCount;
  }
  const totalListeners = listeners + Number(unixSocketPresent);
  if (totalListeners !== 0) throw new Error("renderer_target_cups_probe_invalid");
  return { connected: false, gate: "deny-and-verify", serviceActive: false, listenerCount: 0 };
}

function cupsMeasurement(listenerSource) {
  const showResults = cupsUnits.map((unit) => runTargetCommand("/usr/bin/systemctl", ["show", unit, "--no-pager",
    `--property=${cupsProperties.join(",")}`]));
  const activeResults = cupsUnits.map((unit) => runTargetCommand("/usr/bin/systemctl", ["is-active", unit]));
  let unixSocketPresent = false;
  try {
    if (!lstatSync("/run/cups/cups.sock").isSocket()) throw new Error("renderer_target_cups_probe_invalid");
    unixSocketPresent = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return validateCupsTargetProbe({ showResults, activeResults, unixSocketPresent,
    ...(listenerSource === "proc" ? { listenerCount: procCupsListeners() } :
      { listenerResult: runTargetCommand("/usr/bin/ss", ["-H", "-lntup", "sport", "=", ":631"]) }) });
}

export function measureRendererTarget({ repositoryRoot, browserPath, browserDistribution = null, browserAdapter = null,
  servicePath = "/etc/systemd/system/unseen-book-renderer.service",
  socketPath = "/etc/systemd/system/unseen-book-renderer.socket",
  appArmorPath = "/etc/apparmor.d/unseen-book-renderer",
  appArmorProfilesPath = "/sys/kernel/security/apparmor/profiles", appArmorSelfProfilePath = null,
  cupsListenerSource = "ss" }) {
  if (git(repositoryRoot, ["status", "--porcelain"])) throw new Error("renderer_target_candidate_dirty");
  const repositoryStat = lstatSync(repositoryRoot);
  if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink() || repositoryStat.uid !== 0 ||
    (repositoryStat.mode & 0o022) !== 0) throw new Error("renderer_target_candidate_permissions_invalid");
  const candidateCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const candidateTree = git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  if (!COMMIT.test(candidateCommit) || !COMMIT.test(candidateTree)) throw new Error("renderer_target_candidate_invalid");
  const appArmorSource = checkedFile(appArmorPath, { rootOwned: true });
  const loaded = appArmorSelfProfilePath === null ? readFileSync(appArmorProfilesPath, "utf8").split("\n")
    .some((line) => line.startsWith("unseen-book-renderer ")) :
    readFileSync(appArmorSelfProfilePath, "utf8").startsWith("unseen-book-renderer ");
  if (!loaded) throw new Error("renderer_target_apparmor_not_loaded");
  const principals = principalMeasurements();
  const nodeRuntime = validateNodeRuntimeTarget({ expectedIpcGid: principals.ipcGid });
  if (browserPath !== CHROMIUM_SNAP_BROWSER) throw new Error("renderer_target_browser_path_invalid");
  return Object.freeze({ schema: "unseen-book-renderer-target-measurements/1", candidateCommit, candidateTree,
    rendererBuildHash: rendererImplementationHash(repositoryRoot),
    ...nodeRuntime,
    browser: executablePin(browserPath, ["--version"]),
    browserDistribution: browserDistribution ?? measureChromiumSnapDistribution(),
    browserAdapter: browserAdapter ?? measureChromiumSnapAdapter(),
    bwrap: executablePin("/usr/bin/bwrap", ["--version"]),
    appArmor: { profile: "unseen-book-renderer", sha256: appArmorSource.sha256, loaded },
    fonts: fontInventory(), pdfTools: pdfTools(), systemd: systemdMeasurement(servicePath, socketPath,
      repositoryRoot, candidateCommit),
    cups: cupsMeasurement(cupsListenerSource), principals });
}

function measurementProjection(measurements) {
  exact(measurements, ["schema", "candidateCommit", "candidateTree", "rendererBuildHash", "node",
    "nodeDistribution", "browser", "browserDistribution", "browserAdapter", "bwrap", "appArmor", "fonts", "pdfTools", "systemd", "cups", "principals"],
  "renderer_target_measurements_invalid");
  if (measurements.schema !== "unseen-book-renderer-target-measurements/1") {
    throw new Error("renderer_target_measurements_invalid");
  }
  return { candidateCommit: measurements.candidateCommit, candidateTree: measurements.candidateTree,
    rendererBuildHash: measurements.rendererBuildHash, node: measurements.node,
    nodeDistribution: measurements.nodeDistribution, browser: measurements.browser,
    browserDistribution: measurements.browserDistribution, browserAdapter: measurements.browserAdapter,
    bwrap: measurements.bwrap,
    appArmor: measurements.appArmor, fonts: measurements.fonts, pdfTools: measurements.pdfTools,
    systemd: measurements.systemd, cups: measurements.cups, principals: measurements.principals };
}

export function buildRendererAcceptanceReceipt(measurements, readOnlyMounts) {
  const projection = measurementProjection(measurements);
  if (projection.principals.apiUid === projection.principals.rendererUid) {
    throw new Error("renderer_target_principals_invalid");
  }
  if (projection.appArmor.sha256 !== rendererAppArmorProfileHash() || projection.appArmor.loaded !== true) {
    throw new Error("renderer_target_apparmor_invalid");
  }
  const measurementsHash = sha256(canonicalJson(measurements));
  const receipt = { schema: "unseen-book-renderer-acceptance/1",
    profile: "unseen-book-renderer-dedicated-service/v1", ...projection,
    seccomp: { schema: "unseen-book-renderer-child-seccomp/1",
      sha256: rendererChildSeccompHash(),
      deniedSocketFamilies: ["AF_INET", "AF_INET6", "AF_NETLINK", "AF_PACKET"],
      deniedSyscalls: ["mount", "pivot_root", "setns", "umount2", "unshare", "clone3"] },
    readOnlyMounts, targetVerification: { schema: RENDERER_TARGET_VERIFICATION_SCHEMA,
      verifierBuildHash: rendererVerifierBuildHash(), measurementsHash } };
  return validateRendererAcceptanceReceipt(receipt);
}

export function verifyRendererTargetAcceptance({ receipt, repositoryRoot, measurements }) {
  validateRendererAcceptanceReceipt(receipt);
  const actual = measurements ?? measureRendererTarget({ repositoryRoot, browserPath: receipt.browser.path });
  const expected = buildRendererAcceptanceReceipt(actual, receipt.readOnlyMounts);
  if (receipt.targetVerification.verifierBuildHash !== rendererVerifierBuildHash() ||
    rendererImplementationHash(repositoryRoot) !== receipt.rendererBuildHash ||
    !SHA256.test(receipt.targetVerification.measurementsHash) ||
    canonicalJson(expected) !== canonicalJson(receipt)) throw new Error("renderer_target_acceptance_drift");
  return Object.freeze({ status: "TARGET_MEASUREMENTS_VERIFIED_NOT_RENDER_ACCEPTANCE",
    candidateCommit: receipt.candidateCommit, candidateTree: receipt.candidateTree,
    receiptMeasurementsHash: receipt.targetVerification.measurementsHash });
}

export function verifyRendererRuntimeTargetState({ receipt, repositoryRoot, measurements }) {
  const actual = measurements ?? measureRendererTarget({ repositoryRoot, browserPath: receipt.browser.path,
    appArmorSelfProfilePath: "/proc/self/attr/current", cupsListenerSource: "proc" });
  const result = verifyRendererTargetAcceptance({ receipt, repositoryRoot, measurements: actual });
  return Object.freeze({ ...result, status: "RUNTIME_TARGET_STATE_VERIFIED" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === verifierPath) {
  const repositoryRoot = process.argv[3];
  if (process.argv[2] !== "--measure" || !path.isAbsolute(repositoryRoot)) throw new Error("renderer_target_cli_invalid");
  const measurements = measureRendererTarget({ repositoryRoot, browserPath: process.env.UNSEEN_CHROMIUM_PATH });
  const receipt = buildRendererAcceptanceReceipt(measurements,
    JSON.parse(process.env.UNSEEN_BOOK_RENDERER_READ_ONLY_MOUNTS_JSON));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
