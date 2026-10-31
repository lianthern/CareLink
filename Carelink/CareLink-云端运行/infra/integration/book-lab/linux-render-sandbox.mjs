import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildRendererChildSeccomp, rendererChildSeccompHash } from "./linux-child-seccomp.mjs";
import { rendererAppArmorProfileHash } from "./linux-apparmor-profile.mjs";
import { CHROMIUM_SNAP_ADAPTER_POLICY_SHA256, CHROMIUM_SNAP_BROWSER, CHROMIUM_SNAP_ROOT,
  chromiumSnapAdapterImplementationHash } from "./chromium-snap-headless-adapter.mjs";
import { validateRendererAcceptanceReceipt } from "./renderer-ipc-protocol.mjs";
import { rendererImplementationHash, rendererVerifierBuildHash,
  verifyChromiumSnapCanonicalDanglingSymlinks } from "./renderer-target-verifier.mjs";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function pinnedExecutable(record, label) {
  const stat = lstatSync(record.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !(stat.mode & 0o111) ||
    stat.uid !== 0 || (stat.mode & 0o022) !== 0 ||
    sha256(readFileSync(record.path)) !== record.sha256) throw new Error(`renderer_${label}_pin_drift`);
}

function directoryArguments(destination) {
  const entries = [];
  let current = path.dirname(destination);
  while (current !== "/" && current !== ".") {
    entries.push(current);
    current = path.dirname(current);
  }
  return entries.reverse().flatMap((entry) => ["--dir", entry]);
}

export function buildLinuxRenderSandboxArguments({ receipt, repositoryRoot, temporaryRoot, seccompFd = 3 }) {
  validateRendererAcceptanceReceipt(receipt);
  if (repositoryRoot !== `/opt/unseen/releases/${receipt.candidateCommit}` ||
    temporaryRoot !== "/var/lib/unseen/renderer-spool/work" ||
    !receipt.readOnlyMounts.some((entry) => receipt.browser.path.startsWith(`${entry}/`)) ||
    !receipt.readOnlyMounts.some((entry) => receipt.node.path.startsWith(`${entry}/`))) {
    throw new Error("renderer_sandbox_path_binding_invalid");
  }
  const mounts = [...new Set([...receipt.readOnlyMounts, repositoryRoot])];
  if (mounts.some((entry) => entry === "/" || temporaryRoot === entry || temporaryRoot.startsWith(`${entry}/`))) {
    throw new Error("renderer_sandbox_mount_invalid");
  }
  const arguments_ = ["--die-with-parent", "--new-session", "--unshare-user", "--disable-userns",
    "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--share-net", "--cap-drop", "ALL",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/dev/shm"];
  const created = new Set();
  for (const mount of mounts) {
    for (const argument of directoryArguments(mount)) {
      if (argument === "--dir") continue;
      if (!created.has(argument)) { arguments_.push("--dir", argument); created.add(argument); }
    }
    arguments_.push("--ro-bind", mount, mount);
  }
  for (const argument of directoryArguments(temporaryRoot)) {
    if (argument === "--dir") continue;
    if (!created.has(argument)) { arguments_.push("--dir", argument); created.add(argument); }
  }
  arguments_.push("--bind", temporaryRoot, temporaryRoot, "--seccomp", String(seccompFd), "--chdir",
    repositoryRoot, "--setenv", "HOME", "/nonexistent", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "C.UTF-8", "--");
  return Object.freeze(arguments_);
}

export function prepareLinuxRenderSandbox({ receipt, repositoryRoot, temporaryRoot, workId = null }) {
  validateRendererAcceptanceReceipt(receipt);
  if (workId !== null && !/^[a-f0-9]{64}$/u.test(workId)) throw new Error("renderer_work_id_invalid");
  if (rendererImplementationHash(repositoryRoot) !== receipt.rendererBuildHash) {
    throw new Error("renderer_build_pin_drift");
  }
  if (rendererVerifierBuildHash() !== receipt.targetVerification.verifierBuildHash) {
    throw new Error("renderer_target_verifier_pin_drift");
  }
  if (rendererAppArmorProfileHash() !== receipt.appArmor.sha256) throw new Error("renderer_apparmor_pin_drift");
  if (receipt.browser.path !== CHROMIUM_SNAP_BROWSER || receipt.browserDistribution.numericRoot !== CHROMIUM_SNAP_ROOT ||
    receipt.browserAdapter.implementationSha256 !== chromiumSnapAdapterImplementationHash() ||
    receipt.browserAdapter.policySha256 !== CHROMIUM_SNAP_ADAPTER_POLICY_SHA256) {
    throw new Error("renderer_browser_adapter_pin_drift");
  }
  verifyChromiumSnapCanonicalDanglingSymlinks(receipt.browserDistribution.numericRoot);
  pinnedExecutable(receipt.node, "node");
  pinnedExecutable(receipt.bwrap, "bwrap");
  pinnedExecutable(receipt.browser, "browser");
  if (rendererChildSeccompHash() !== receipt.seccomp.sha256) throw new Error("renderer_seccomp_pin_drift");
  const prefix = Object.freeze(buildLinuxRenderSandboxArguments({ receipt, repositoryRoot, temporaryRoot,
    seccompFd: 3 }));
  const seccompPath = path.join(temporaryRoot, `.renderer-seccomp-${workId === null ? "" : `${workId}-`}${randomUUID()}`);
  let seccompFd;
  try {
    writeFileSync(seccompPath, buildRendererChildSeccomp(), { flag: "wx", mode: 0o600 });
    seccompFd = openSync(seccompPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (seccompFd !== undefined) try { closeSync(seccompFd); } catch {}
    try { unlinkSync(seccompPath); } catch {}
    throw error;
  }
  return Object.freeze({
    command: receipt.bwrap.path,
    prefix,
    browserPath: receipt.browser.path,
    enforcement: "systemd-private-network+filesystem-af-unix+bwrap+seccomp/v1",
    kernelNetworkSandbox: true,
    extraStdio: Object.freeze([seccompFd]),
    close() {
      try { closeSync(seccompFd); } catch {}
      try { unlinkSync(seccompPath); } catch {}
    }
  });
}

export function verifyLinuxRenderSandbox(options) {
  const sandbox = prepareLinuxRenderSandbox(options);
  sandbox.close();
  return Object.freeze({ status: "TARGET_PINS_VERIFIED_NOT_RENDER_ACCEPTANCE", profile: receiptProfile(options),
    seccompSha256: rendererChildSeccompHash(), appArmorSha256: rendererAppArmorProfileHash() });
}

function receiptProfile(options) { return options.receipt.profile; }
