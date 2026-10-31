import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "../..");
const command = process.argv[2];
const packageRoot = path.resolve(process.env.UNSEEN_PRODUCTION_PACKAGE_DIR ?? path.dirname(scriptPath));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const staticFiles = new Map([
  ["config/rc/production.env.example", "production.env.example"],
  ["ops/release/unseen.service.example", "unseen.service.example"],
  ["ops/release/unseen-book-renderer.service.example", "unseen-book-renderer.service.example"],
  ["ops/release/unseen-book-renderer.socket.example", "unseen-book-renderer.socket.example"],
  ["ops/release/unseen-book-renderer.sysusers.example", "unseen-book-renderer.sysusers.example"],
  ["ops/release/unseen-book-renderer.tmpfiles.example", "unseen-book-renderer.tmpfiles.example"],
  ["ops/release/Caddyfile.example", "Caddyfile.example"],
  ["runbooks/release/PRODUCTION-DEPLOYMENT.md", "README.md"],
  ["infra/integration/production-package.mjs", "VERIFY.mjs"]
]);
const artifactNames = ["source.bundle", ...staticFiles.values()].sort();
const releaseMarker = "REQUIRED_IMMUTABLE_RELEASE_COMMIT";
const candidateValueMarker = "REQUIRED_CANDIDATE_COMMIT_FROM_PACKAGE_MANIFEST";
const immutableReleaseRoot = "/opt/unseen/releases";
const accepted8CCommit = "a16f7fdda14759429fd22054506f198980805e9d";
const integrated8CEvidencePath = "release-evidence/book-lab/8c-real-seam/verification.json";
const acceptedUiV2Commit = "d049a85d63abad0db06c96d3cd5671bd56567dc6";
const acceptedUiActionClosureCommit = "3478ae390445d83bb9230c26c4c8b8ffe50e6e62";
const acceptedUiActionClosureCodeCommit = "49efe3ec6a407eb0a75f5be6d8c404d4c8acef17";
const acceptedUiCopyActionCommit = "c071018bf450ab347056931f98264a0c2e2176d4";
const acceptedUiCopyActionCodeCommit = "74adfba49cb15eba3be3db91b10545a16c76db43";
const acceptedUiCopyActionBaseCommit = "4028310f02feb3e0d992c8ea56403cf4764d86c8";
const acceptedUiCoreStatesCommit = "951363b6031ec3d9e1f29785c8e22d3939b7302d";
const acceptedUiCoreStatesTestCommit = "2f85856eb5d2753c2ef7d68175ecafa45f001ee0";
const acceptedUiCoreStatesBaseCommit = "e16dd93eaacce4ad8fe1fd25930277638e795f96";
const acceptedBrowserA11yCommit = "97ae5ba600a5cd5e6102e5064206a64988c9f45c";
const acceptedInventoryCommit = "7f1f2396133235b38e9f2beaee5df588d17f9b0d";
const currentRefreshTestedInputCommit = "09076727051411eeb9274a26663f6ccd168378c3";
const inventoryTestedInputCommit = "1cc1615cd9c05ed515711dcd50f5aff62b4238db";
const browserEvidencePath = "release-evidence/r0/browser-a11y/SHA256SUMS";
const browserChromeEvidencePath = "release-evidence/r0/browser-a11y/CHROME-MACOS-MAIN-CHAIN-A11Y.json";
const browserFirefoxEvidencePath = "release-evidence/r0/browser-a11y/FIREFOX-MACOS.json";
const inventoryVerificationPath = "release-evidence/r0/inventory/VERIFICATION.json";
const inventoryPath = "release-evidence/r0/inventory/RELEASE-INVENTORY.json";
const uiActionClosureChecksPath = "release-evidence/local-operable/ui-v2-action-closure/MACHINE-CHECKS.json";
const uiActionClosureBrowserPath =
  "release-evidence/local-operable/ui-v2-action-closure/CHROME-DESKTOP-MOBILE.json";
const uiCopyActionChecksPath =
  "release-evidence/local-operable/ui-v2-copy-action-matrix/MACHINE-CHECKS.json";
const uiCopyActionBrowserPath =
  "release-evidence/local-operable/ui-v2-copy-action-matrix/CHROME-DESKTOP-MOBILE.json";
const uiCoreStatesChecksPath = "release-evidence/local-operable/ui-v2-core-states/MACHINE-CHECKS.json";
const uiCoreStatesBrowserPath = "release-evidence/local-operable/ui-v2-core-states/CHROME-CORE-STATES.json";
const acceptedPublicFoundationCommit = "fb2f2b947a6e80d1a0a02b0c6f4e0d2f964c7c4a";
const publicFoundationEvidencePath = "release-evidence/r0/private-beta/PUBLIC-FOUNDATION.json";
const acceptedSmtpCommit = "ba9a049ac9ce328c8bac23b88a3fbaadd48ea9ec";
const acceptedSmtpCodeCommit = "81f2c42abb2cfd5731eaeac2df5573db67d88e07";
const smtpEvidencePath = "release-evidence/otp-smtp-adapter/DEFAULT-OFF-SMTP.json";
const acceptedProviderOfflineCommit = "fdfa68e68f1931179122c111cf483c83f7a060d4";
const acceptedQuestionCapabilityCommit = "c76ee298e7a9566506252e291e3dfe050c4a3a9f";
const acceptedQuestionOfflineUiCommit = "69ae472e79715851226e0025bd49035479b837b4";
const providerOfflineChecksPath = "release-evidence/local-operable/bl01-provider-offline/MACHINE-CHECKS.json";
const providerOfflineBrowserPath = "release-evidence/local-operable/bl01-provider-offline/verification.json";
const acceptedPrivateWorkerCommit = "94f778095567332711401be10b56074065732466";
const acceptedPrivateWorkerCodeCommit = "6652bc406f90038bdc83ab8777898c7e711991ad";
const privateWorkerChecksPath = "release-evidence/provider/mac-codex-private-worker/MACHINE-CHECKS.json";
const privateWorkerRuntimePath = "release-evidence/provider/mac-codex-private-worker/RUNTIME-BINDING.json";
const privateWorkerLiveProofPath = "release-evidence/provider/mac-codex-private-worker/LIVE-SUBSCRIPTION-PROOF.json";
const acceptedPrivateAiQueueCommit = "73a7c9df7ed11136d2fe9bf776d058d8e88e1237";
const acceptedPrivateAiQueueCodeCommit = "4209d552fd79f679ed821fcacb741f5095945fcb";
const privateAiQueueEvidencePath = "release-evidence/private-ai-queue/machine-summary.json";
const acceptedPrivateAiTransportCommit = "1ad67378f169057b506987eee96f51b2699a5a22";
const acceptedPrivateAiTransportCodeCommit = "3114a1f89c6542550f3fe19b51fee3a04aadea61";
const acceptedPrivateAiTransportFixCommit = "3c9a1cca8289d82b660928f9e1a14ea94270ef71";
const acceptedPrivateAiTransportFixCodeCommit = "497de1c239d5d4686ca7d048b1e8a575d7cf4526";
const privateAiTransportEvidencePath =
  "release-evidence/provider/mac-codex-private-worker/REMOTE-PULL-MATRIX.json";
const privateAiRemoteLiveEvidencePath =
  "release-evidence/provider/mac-codex-private-worker/REMOTE-LIVE-E2E.json";
const privateAiRetirementEvidencePath =
  "release-evidence/provider/mac-codex-private-worker/LEGACY-WORKER-RETIREMENT.json";
const acceptedBookPrivateFactsCommit = "5ea82de266b1ec07122ed34bf5219069bfa3b18d";
const acceptedBookPrivateFactsCodeCommit = "deaf767777144c38b045e8265fb7f6e5a4f8de69";
const bookPrivateFactsEvidencePath = "release-evidence/book-lab/book-private-facts/verification.json";
const acceptedPrivateAiCompositionCommit = "437de71f569027dd9639bad462988ece80d635f9";
const acceptedPrivateAiCompositionCodeCommit = "8329b5c3be36a5691be457e64d50eb2387180335";
const privateAiCompositionEvidencePath = "release-evidence/private-ai-composition/machine-summary.json";
const acceptedPrivateAiQueuedUiCommit = "7348da9c20b34e587df0f1f008632861b633699f";
const acceptedPrivateAiQueuedUiCodeCommit = "df127bf313559fec1054bf2fed85a086c32a1c78";
const privateAiQueuedUiChecksPath =
  "release-evidence/local-operable/private-ai-queued-offline/MACHINE-CHECKS.json";
const privateAiQueuedUiBrowserPath =
  "release-evidence/local-operable/private-ai-queued-offline/verification.json";
const acceptedPrivateAiCaddyBodyCapCommit = "14bda3b447137cdd83b614ca01ee633c91467c09";
const acceptedPrivateAiCaddyBodyCapCodeCommit = "a3c47c8500207bd6dbd2440ad9a10f5430e1b3b9";
const privateAiCaddyBodyCapEvidencePath =
  "release-evidence/r0/private-ai-caddy-body-cap/machine-summary.json";
const historicalShadowTransportCommit = "721382f5d1b677595117a266b5ee889644e923a1";
const historicalShadowTransportEvidencePath =
  "release-evidence/r0/shadow-transport-acceptance-20260814T183925Z/MACHINE-EVIDENCE.json";
const acceptedDeploymentContractCommit = "a4faa79f64aaaf29fe17265c0717aaf8cbc0b806";
const acceptedDeploymentContractCodeCommit = "9db936bdf7e1f56ec10f57bc9627be91b32ff603";
const deploymentContractEvidencePath =
  "release-evidence/r0/deployment-active-release-contract/MACHINE-EVIDENCE.json";
const historicalRejectedActiveReleaseEvidenceCommit = "7d73fb980ed74d49de1cb27f92a4d61af2f97615";
const historicalRejectedPortableReleaseEvidenceCommit = "6d0cb2f1342bcc88383dfff3371d567d704b579f";
const historicalDeploymentFailureCommit = "022c464d624e9aeeaa9623439e1495b2c7f4bd3f";
const historicalDeploymentFailureEvidencePath =
  "release-evidence/r0/candidate-7d2-deployment-attempt-20260814T192158Z/MACHINE-EVIDENCE.json";
const acceptedDedicatedRendererCommit = "2286c3fbbd9c71d1d384edfbb078e785e1b52354";
const acceptedDedicatedRendererCodeCommit = "30dca550ac73301457e9bff087a56ab112be7e61";
const dedicatedRendererEvidencePath = "release-evidence/renderer/dedicated-service/machine-summary.json";
const acceptedDedicatedRendererEvidenceSha256 =
  "1a7fd73e7ce74012c813263a3bf2e429f04a05c98658b7ae15b00631643cc8d6";
const acceptedRendererSystemd255FixCommit = "259832e96c5e0edad9c1a5c5f5c6c092c56e7ae4";
const acceptedRendererSystemd255FixCodeCommit = "5ed65ec33eee0228c8d814bdf207674ddb4b5cbc";
const rendererSystemd255FixEvidencePath =
  "release-evidence/renderer/dedicated-service/systemd255-property-fix/machine-summary.json";
const acceptedRendererSystemd255FixEvidenceSha256 =
  "40f3ed9ccc5dd6350a636768d46279d6d004b20775d0770e9168ab7b54633e18";
const acceptedRendererSystemd255IpDenyFixCommit = "8fb24ce1eb900307a4b1aa5b355f3f7eb45ba185";
const acceptedRendererSystemd255IpDenyFixEvidenceCommit = "f596bb760115943e73c68fcb06d35c3f396240dd";
const acceptedRendererSystemd255IpDenyFixCodeCommit = "8d894e8f96600e19206b0246cb4f95861200720b";
const rendererSystemd255IpDenyFixEvidencePath =
  "release-evidence/renderer/dedicated-service/systemd255-ip-deny-fix/machine-summary.json";
const acceptedRendererSystemd255IpDenyFixEvidenceSha256 =
  "33f84b714baed915a287eef36b86f270faab0b8791b976fb28464ccd7f70967b";
const acceptedRendererDurableControlCommit = "66eaa54edc00dada194867d649deb8e80ce45cfa";
const acceptedRendererDurableControlCodeCommit = "72a7a96a0279e3a1ec922ff777175ad4d63edc45";
const rendererDurableControlEvidencePath =
  "release-evidence/renderer/dedicated-service/cold-readiness-diagnostics-20260815.json";
const acceptedRendererDurableControlEvidenceSha256 =
  "75b251afd69d5660807d44e05a37e7eeb0b84721137fc42bd0c453337da0ac00";
const historicalRendererControlTargetFailureCommit = "dd3a7fac439ad67abaa6292eaf0e7a0b71db460c";
const historicalRendererControlTargetFailurePath =
  "release-evidence/r0/target-deployment-candidate9c-renderer-failure-20260815T061208Z/MACHINE-EVIDENCE.json";
const historicalRendererControlTargetFailureSha256 =
  "56d357c4dc50fdf4e69e6ff44c9f20c038ef280beb27f52f82ad35fad5d2ba36";
const acceptedRendererSnapAdapterCommit = "28964fd946037cd8a2c9f65e6fa896edafca4b92";
const acceptedRendererSnapAdapterCodeCommit = "c181a0a92c3907e8db87e235adfc78b0fe2d3896";
const rendererSnapAdapterEvidencePath =
  "release-evidence/renderer/dedicated-service/chromium-snap-headless-adapter/machine-summary.json";
const acceptedRendererSnapAdapterEvidenceSha256 =
  "2f7bdbe7a4793ac75467979b4111ec37077c2423cbc20e5eb0823fd2ca26b3e0";
const acceptedRendererSnapCacheCommit = "d1acca2fdd5965db5cd611baa7377b138734119c";
const acceptedRendererSnapCacheCodeCommit = "2e7a2276f233b973fa17e4c05120772d17381c93";
const rendererSnapCacheEvidencePath =
  "release-evidence/renderer/dedicated-service/snapd-cache-hardlink-topology/machine-summary.json";
const acceptedRendererSnapCacheEvidenceSha256 =
  "83638c095ac7737edc53303416cb3b0d36f9f8ea0defca27fb47ada504f13e77";
const acceptedRendererSnapDanglingCommit = "f9eaa6a2cc54ce80f8f234f6c468525e7ffd850d";
const acceptedRendererSnapDanglingCodeCommit = "004b05f6549540c93044a5b8f16ae8d939afeb44";
const rendererSnapDanglingEvidencePath =
  "release-evidence/renderer/dedicated-service/snap-canonical-dangling-symlinks/fixed-review-followup.json";
const acceptedRendererSnapDanglingEvidenceSha256 =
  "22b9dc0ce87571dda3cb0b40699c16e2086d307b7963ae00e74cb83d0b3495ee";
const historicalRendererSnapDanglingRejectedCommits = Object.freeze([
  "21b34bf141f5fafb48d8cc08eaa89850f6931bd3",
  "e46723f91157ac80a5dcd8c91206ea8272a98cc8"
]);
const historicalRendererSnapDanglingFailureCommit = "11b869b9cfb41c5fedbaafda9533974b7873b3b9";
const historicalRendererSnapDanglingFailurePath =
  "release-evidence/r0/target-deployment-candidateb314-renderer-browser-tree-p1-20260815T113717Z/" +
  "MACHINE-EVIDENCE.json";
const historicalRendererSnapDanglingFailureSha256 =
  "abd5c42940378b2799f4af12933982492435164c70bfe0fa29d90affed38953a";
const historicalRendererSnapCacheFailureCommit = "87687c956770a409f040ec15c5bbbf9f93aa70a9";
const historicalRendererSnapCacheFailurePath =
  "release-evidence/r0/target-deployment-candidate48a-renderer-snap-hardlink-p1-20260815T104618Z/" +
  "MACHINE-EVIDENCE.json";
const historicalRendererSnapCacheFailureSha256 =
  "96a6372d2f4eb61609920f936feb6346edb565ba2c653d462ec0b96e1c27f380";
const rendererRouteStaticCommit = "4ca1eb309320a3a3a16331f2a013c6c08d254488";
const rendererRouteStaticEvidencePath =
  "release-evidence/r0/target-renderer-route1-static-adapter-policy-candidate09f-20260815T091250Z/" +
  "MACHINE-EVIDENCE.json";
const rendererRouteStaticEvidenceSha256 =
  "883f36b86b89b8f68534eb3e9f58f7a00ed35e2baee026c454c8552e593a9411";
const rendererRouteTargetDiagnostics = Object.freeze([
  Object.freeze({
    commit: "7a7b3fa7a9b354020f59212efb8e9805bde4f1ea",
    path: "release-evidence/r0/target-renderer-static-resource-closure-candidate09f-20260815T085301Z/" +
      "MACHINE-EVIDENCE.json",
    sha256: "810d25b7df4cd6a8e8195784457de13fa2d58cefac9547bdeca49a9ca8a105f6"
  }),
  Object.freeze({
    commit: "2e2f11491a0b89c00327c58a04c5c006a7899611",
    path: "release-evidence/r0/target-renderer-s35-adaptive-candidate09f-20260815T084020Z/" +
      "MACHINE-EVIDENCE.json",
    sha256: "a3fcb1b0825495cb9cb1c73c1686c50a7a2caeebb2df64b1c1e1222a6133000f"
  }),
  Object.freeze({
    commit: "af9e73eb0da622c3c75bebcf1bf29b8121c8ead7",
    path: "release-evidence/r0/target-renderer-s3-v4-candidate09f-20260815T082828Z/MACHINE-EVIDENCE.json",
    sha256: "f1daa0389beb69f8d05b892a11b863563647f1eca7d721be10c8cb124c0cf053"
  })
]);
const acceptedTemporaryAccessUiCommit = "488923cfebb995f50c0eab73a31da74cd6b03493";
const acceptedTemporaryAccessUiCodeCommit = "4e5fd762d4bc53bc1713b675eaa4027e6f787105";
const temporaryAccessUiChecksPath =
  "release-evidence/local-operable/public-core-ui-temporary-access/MACHINE-CHECKS.json";
const temporaryAccessUiBrowserPath =
  "release-evidence/local-operable/public-core-ui-temporary-access/browser.json";
const acceptedPublicCoreUiCommit = "09ce09c170bbd4b5992a3a1b016e814be2013486";
const publicCoreUiEvidencePath =
  "release-evidence/r0/public-core-ui-target-20260814T232050Z/MACHINE-EVIDENCE.json";
const browserProductPaths = ["apps/web", "config/rc/local-staging.json", "infra/integration/local-operable.mjs",
  "infra/integration/local-staging.mjs", "packages/viewer", "services/api"];
const inventoryProductPaths = [...browserProductPaths, "infra/integration/book-lab", "packages/book-lab-web",
  "packages/book-renderer", "services/book-lab"].sort();
const requiredBlockers = [
  "core_visible_facts_and_question_provider_not_authorized",
  "legal_privacy_notice_approvals_missing",
  "final_candidate_deployment_secret_decoder_operator_and_provider_acceptance_missing"
];

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function git(args, cwd = repositoryRoot, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...options }).trim();
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function exists(filename) {
  try { await lstat(filename); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function fileRecord(root, relative) {
  const filename = path.join(root, relative);
  const info = await lstat(filename);
  invariant(info.isFile() && !info.isSymbolicLink(), `production_package_file_invalid:${relative}`);
  const bytes = await readFile(filename);
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes), mode: info.mode & 0o777 };
}

async function privateTree(root, expectedFiles) {
  const rootInfo = await lstat(root);
  invariant(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && (rootInfo.mode & 0o777) === 0o700,
    "production_package_root_permissions_invalid");
  const actual = (await readdir(root)).sort();
  invariant(JSON.stringify(actual) === JSON.stringify([...expectedFiles].sort()), "production_package_files_invalid");
  for (const relative of actual) {
    const info = await lstat(path.join(root, relative));
    invariant(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600,
      `production_package_permissions_invalid:${relative}`);
  }
}

function rejectLegacyActiveAlias(texts) {
  const activeAliasPatterns = [
    /WorkingDirectory=\/opt\/unseen\/core(?:\/|$)/mu,
    /UNSEEN_BOOK_WORKTREE=\/opt\/unseen\/core(?:\s|$)/mu,
    /git clone [^\n]* \/opt\/unseen\/core(?:\s|$)/mu,
    /node \/opt\/unseen\/core\//mu
  ];
  invariant(texts.every((text) => activeAliasPatterns.every((pattern) => !pattern.test(text))),
    "production_package_legacy_active_release_alias");
}

function verifyCaddyPermissionContract(runbook, label) {
  invariant(runbook.includes("install -o root -g root -m 0600 /etc/caddy/Caddyfile") &&
    (runbook.match(/install -o root -g caddy -m 0640/gu) ?? []).length >= 2 &&
    runbook.includes("getent group caddy") &&
    runbook.includes("sudo -u caddy test -r /etc/caddy/Caddyfile") &&
    runbook.includes("caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile") &&
    runbook.includes("systemctl reload caddy") && runbook.includes("systemctl is-active --quiet caddy"),
  `production_package_caddy_permission_contract_invalid:${label}`);
}

function verifyActiveReleaseRunbook(runbook, label) {
  invariant(runbook.includes(`${immutableReleaseRoot}/$candidate_commit`) &&
    runbook.includes("rev-parse HEAD") && runbook.includes("rev-parse 'HEAD^{tree}'") &&
    runbook.includes("rev-parse --abbrev-ref HEAD") && runbook.includes("status --porcelain") &&
    runbook.includes("ActiveState=active") && runbook.includes("MainPID") &&
    runbook.includes("ControlGroup") && runbook.includes("systemctl show") &&
    runbook.includes("/proc/$MainPID/cwd") && runbook.includes("readlink -f") &&
    (runbook.includes("/proc/$main_pid/cgroup") || runbook.includes("/proc/$api_pid/cgroup")) &&
    runbook.includes("/opt/unseen/core") && runbook.includes("never active-release evidence"),
  `production_package_active_release_contract_invalid:${label}`);
}

function verifyCaddyTemplate(caddy) {
  invariant(caddy.startsWith("REQUIRED_DOMAIN {") &&
    !caddy.includes("basicauth") &&
    !caddy.includes("REQUIRED_BASIC_AUTH_USERNAME") &&
    !caddy.includes("REQUIRED_BCRYPT_HASH") &&
    !caddy.includes("Content-Security-Policy") &&
    !caddy.includes("default-src 'none'") &&
    /@private_ai_body_rejected\s*\{\s*path \/__internal\/private-ai\/v1\/\*\s*method POST\s*expression `\{http\.request\.header\.Content-Length\} == "" \|\| int\(\{http\.request\.header\.Content-Length\}\) > 32768`\s*\}/u.test(caddy) &&
    /handle @private_ai_body_rejected\s*\{\s*header\s*\{\s*Content-Type application\/json\s*Cache-Control "private, no-store, max-age=0"\s*X-Unseen-Protocol unseen-private-ai-pull\/1\s*\}\s*respond "" 413\s*\}/u.test(caddy) &&
    caddy.includes("@private_ai path /__internal/private-ai/v1/*") &&
    /request_body\s*\{\s*max_size 32KiB\s*\}/u.test(caddy) &&
    (caddy.match(/reverse_proxy 127\.0\.0\.1:4282/gu) ?? []).length === 2 &&
    (caddy.match(/header_up Host \{host\}/gu) ?? []).length === 2 &&
    (caddy.match(/header_up X-Forwarded-Proto https/gu) ?? []).length === 2 &&
    !caddy.includes("X-Forwarded-Proto {scheme}") &&
    caddy.indexOf("handle @private_ai_body_rejected") < caddy.indexOf("handle @private_ai {") &&
    caddy.indexOf("handle @private_ai {") < caddy.lastIndexOf("handle {"),
  "production_package_caddy_template_invalid");
}

function verifyProductionDeploymentContract(unit, rendererUnit, env, runbook) {
  rejectLegacyActiveAlias([unit, rendererUnit, env, runbook]);
  invariant(unit.includes("EnvironmentFile=/etc/unseen/production.env\n") &&
    unit.includes("EnvironmentFile=/run/unseen/production.secrets\n") &&
    unit.includes("UnsetEnvironment=NODE_OPTIONS NODE_PATH PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_PROFILE GCONV_PATH BASH_ENV ENV PYTHONPATH PYTHONHOME PERL5OPT RUBYOPT OPENSSL_CONF OPENSSL_MODULES SSLKEYLOGFILE\n") &&
    unit.includes("ExecStartPre=/usr/local/bin/node infra/integration/production-package.mjs preflight /etc/unseen/production.env\n"),
  "production_package_service_env_boundary_invalid");
  invariant(unit.includes(`WorkingDirectory=${immutableReleaseRoot}/${releaseMarker}`) &&
    env.includes(`UNSEEN_PRODUCTION_CANDIDATE_COMMIT=${candidateValueMarker}`) &&
    env.includes(`UNSEEN_BOOK_WORKTREE=${immutableReleaseRoot}/${releaseMarker}`) &&
    !releaseMarker.includes(candidateValueMarker) && !candidateValueMarker.includes(releaseMarker),
  "production_package_release_marker_missing");
  invariant(runbook.includes(
    "CUPS_TARGET_GATE=BOTH_NOT_FOUND_RC4_OR_BOTH_INSTALLED_INACTIVE_DISABLED_MASKED_AND_ZERO_LISTENERS"),
  "production_package_renderer_cups_contract_invalid");
  invariant(env.includes("UNSEEN_CHROMIUM_PATH=/snap/chromium/3507/usr/lib/chromium-browser/chrome\n") &&
    ["CHROMIUM_SNAP_ADAPTER_GATE=REVISION_3507_EXACT14_EMPTY_ENV_FIXED_ARGV_FULL_TREE_HASH",
      "numeric_snap_root=\"/snap/chromium/3507\"", "assertionSignatureVerified=false",
      "licenseDeclaration=UNDECLARED_IN_CANONICAL_ASSERTION_AND_LOCAL_META",
      "securityReview=REQUIRED_NOT_INCLUDED", "releaseDecision=NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED",
      "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913",
      "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5",
      "SNAPD_CACHE_HARDLINK_GATE=ARCHIVE_ONLY_OR_EXACT_SHA3_384_CACHE_LINK",
      "/var/lib/snapd/cache/77155504d7c5fdfa516545da086bd3f31fa6f6283901e93885cbb39366ae55bea" +
        "834c4042bebfc870a0330904df04c07",
      "49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5",
      "snap_archive_dac=root:root:0600 source=TARGET_OBSERVED_EVIDENCE_87687C956770A409F040EC15C5BBBF9F93AA70A9",
      "snap_cache_dir_dac=root:root:0700 source=SNAPD_SOURCE_POLICY_93A01322CDC0AD70AFCD641FF31FCF7BF070F144",
      "CHROMIUM_CANONICAL_DANGLING_SYMLINK_POLICY=" +
        "3c3f99c6d62feffb90a873bc245930045a1e42bdc0c3b1e5c2a763208586b128",
      "usr/bin/xdg-email -> /usr/bin/xdg-open",
      "usr/share/groff/site-tmac -> ../../../etc/groff",
      "unresolved with exact `ENOENT`",
      "exact root:root mode 0777 with nlink 1",
      "path and target SHA-256",
      "runtimeReachability=ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE",
      "package intentionally contains no snap artifact"].every((needle) => runbook.includes(needle)),
  "production_package_renderer_browser_adapter_contract_invalid");
  invariant(rendererUnit.includes(
    "ExecStartPre=/usr/bin/sha256sum --strict --check --status /run/unseen/approvals/node-runtime.sha256\n") &&
    rendererUnit.includes("ExecStartPre=/opt/unseen/runtime/node-v22.23.2-linux-x64/bin/node " +
      "infra/integration/book-lab/renderer-service.mjs --verify\n") &&
    rendererUnit.includes("ExecStart=/opt/unseen/runtime/node-v22.23.2-linux-x64/bin/node " +
      "infra/integration/book-lab/renderer-service.mjs\n") &&
    rendererUnit.includes("ReadOnlyPaths=/opt/unseen/runtime/node-v22.23.2-linux-x64 " +
      "/opt/unseen/runtime/sources/node-v22.23.2 " +
      "/opt/unseen/runtime/trust/node-release-keys-b28073028e6d6855cfb53bf7fa0137599c01f967.kbx " +
      "/run/unseen/approvals/book-renderer-acceptance.json " +
      "/run/unseen/approvals/book-renderer-acceptance.sha256 /run/unseen/approvals/node-runtime.sha256\n") &&
    !/(?:ExecStart|ExecStartPre)=(?:\/usr\/bin\/node|\/usr\/bin\/env|node\s)/u.test(rendererUnit) &&
    !/^Environment=(?:PATH|NODE_OPTIONS|NODE_PATH)=/mu.test(rendererUnit) &&
    ["NODE_RUNTIME_TARGET_GATE=PINNED_NODE_22_23_2_SIGNED_SHASUMS_AND_EXACT_BINARY",
      "node_runtime_root=/opt/unseen/runtime/node-v22.23.2-linux-x64",
      "node_executable_sha=3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327",
      "node_archive_sha=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
      "node_archive_bytes=31058332",
      "node_shasums_asc_sha=cfcf12eb3146d641be185d08ca018166b98495b1d8e5f7f94ab77f9965b651d2",
      "node_release_keys_commit=b28073028e6d6855cfb53bf7fa0137599c01f967",
      "node_keyring_sha=6030d4e0cd53330acf2ab68acd455b7ca98bb5d5975376f0b7c0892308ba2d57",
      "node_keyring_bytes=95960",
      "node_archive_url=https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz",
      "node_shasums_url=https://nodejs.org/dist/v22.23.2/SHASUMS256.txt.asc",
      "UNSEEN_BOOK_RENDERER_READ_ONLY_MOUNTS_JSON=\"[\\\"/usr\\\",\\\"/lib\\\",\\\"/lib64\\\"," +
        "\\\"/etc/fonts\\\",\\\"$numeric_snap_root\\\",\\\"$node_runtime_root\\\"]\"",
      "/usr/bin/gpgv --keyring \"$node_stage/release-keys.kbx\" --output \"$node_stage/SHASUMS256.txt\"",
      "/usr/bin/sha256sum --strict --check --status /run/unseen/approvals/node-runtime.sha256"
    ].every((needle) => runbook.includes(needle)),
  "production_package_renderer_node_runtime_contract_invalid");
  verifyCaddyPermissionContract(runbook, "production");
  verifyActiveReleaseRunbook(runbook, "production");
}

function verifyPrivateBetaDeploymentContract(apiUnit, webUnit, runbook) {
  rejectLegacyActiveAlias([apiUnit, webUnit, runbook]);
  invariant(apiUnit.includes(`WorkingDirectory=${immutableReleaseRoot}/${releaseMarker}`) &&
    webUnit.includes(`WorkingDirectory=${immutableReleaseRoot}/${releaseMarker}/apps/web`),
  "production_package_private_beta_release_marker_missing");
  verifyCaddyPermissionContract(runbook, "private_beta");
  verifyActiveReleaseRunbook(runbook, "private_beta");
}

async function verifyPackagedDeploymentContract(root) {
  const [unit, rendererUnit, env, runbook, caddy] = await Promise.all([
    readFile(path.join(root, "unseen.service.example"), "utf8"),
    readFile(path.join(root, "unseen-book-renderer.service.example"), "utf8"),
    readFile(path.join(root, "production.env.example"), "utf8"),
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "Caddyfile.example"), "utf8")
  ]);
  verifyProductionDeploymentContract(unit, rendererUnit, env, runbook);
  verifyCaddyTemplate(caddy);
}

async function migrations() {
  const root = path.join(repositoryRoot, "services/api/db/migrations");
  const names = (await readdir(root)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  invariant(names.length > 0, "production_package_migrations_missing");
  return Promise.all(names.map(async (name) => {
    const bytes = await readFile(path.join(root, name));
    return { version: name.slice(0, -4), bytes: bytes.length, sha256: sha256(bytes) };
  }));
}

async function verifyBundle(root, manifest) {
  const bundle = path.join(root, "source.bundle");
  const temporary = await mkdtemp(path.join(tmpdir(), "unseen-package-verify-"));
  try {
    const verifier = path.join(temporary, "verifier.git");
    execFileSync("git", ["init", "--quiet", "--bare", verifier]);
    const verified = spawnSync("git", ["bundle", "verify", bundle], { cwd: verifier, encoding: "utf8" });
    invariant(verified.status === 0, "production_package_bundle_invalid");
    const clone = path.join(temporary, "source");
    execFileSync("git", ["clone", "--quiet", bundle, clone]);
    const [privateApiUnit, privateWebUnit, privateRunbook] = [
      "infra/integration/private-beta-deployment/unseen-private-beta-api.service",
      "infra/integration/private-beta-deployment/unseen-private-beta-web.service",
      "runbooks/release/PRIVATE-BETA-DEPLOYMENT.md"
    ].map((relative) => execFileSync("git", ["show", `${manifest.candidateCommit}:${relative}`],
      { cwd: clone, encoding: "utf8" }));
    verifyPrivateBetaDeploymentContract(privateApiUnit, privateWebUnit, privateRunbook);
    for (const commit of [manifest.candidateCommit, manifest.coreProductCommit, manifest.bookCommit,
      manifest.profiles.production.integrated8CCommit, manifest.acceptedEvidence.uiV2.commit,
      manifest.acceptedEvidence.uiActionClosure.commit, manifest.acceptedEvidence.uiActionClosure.codeCommit,
      manifest.acceptedEvidence.uiCopyActionClosure.commit,
      manifest.acceptedEvidence.uiCopyActionClosure.codeCommit,
      manifest.acceptedEvidence.uiCoreStates.commit,
      manifest.acceptedEvidence.uiCoreStates.testCommit,
      manifest.acceptedEvidence.uiCoreStates.baseCandidate,
      manifest.acceptedEvidence.browserA11y.testedInputCommit,
      manifest.acceptedEvidence.inventory.testedInputCommit,
      manifest.acceptedEvidence.browserA11y.commit, manifest.acceptedEvidence.inventory.commit,
      manifest.acceptedEvidence.publicFoundation.commit,
      manifest.acceptedEvidence.smtpOtp.commit, manifest.acceptedEvidence.smtpOtp.codeCommit,
      manifest.acceptedEvidence.questionProviderOffline.commit,
      manifest.acceptedEvidence.questionProviderOffline.capabilityCommit,
      manifest.acceptedEvidence.questionProviderOffline.uiCommit,
      manifest.acceptedEvidence.macCodexPrivateWorker.commit,
      manifest.acceptedEvidence.macCodexPrivateWorker.codeCommit,
      manifest.acceptedEvidence.privateAiQueue.commit,
      manifest.acceptedEvidence.privateAiQueue.codeCommit,
      manifest.acceptedEvidence.privateAiTransport.commit,
      manifest.acceptedEvidence.privateAiTransport.codeCommit,
      manifest.acceptedEvidence.privateAiTransport.fixCommit,
      manifest.acceptedEvidence.privateAiTransport.fixCodeCommit,
      manifest.acceptedEvidence.bookPrivateFacts.commit,
      manifest.acceptedEvidence.bookPrivateFacts.codeCommit,
      manifest.acceptedEvidence.privateAiComposition.commit,
      manifest.acceptedEvidence.privateAiComposition.codeCommit,
      manifest.acceptedEvidence.privateAiQueuedUi.commit,
      manifest.acceptedEvidence.privateAiQueuedUi.codeCommit,
      manifest.acceptedEvidence.privateAiCaddyBodyCap.commit,
      manifest.acceptedEvidence.privateAiCaddyBodyCap.codeCommit,
      manifest.acceptedEvidence.privateAiCaddyBodyCap.historicalRejectedCommit,
      manifest.acceptedEvidence.deploymentContract.commit,
      manifest.acceptedEvidence.deploymentContract.codeCommit,
      ...manifest.acceptedEvidence.deploymentContract.historicalRejectedEvidenceCommits,
      manifest.acceptedEvidence.deploymentContract.historicalDeploymentFailure.commit,
      manifest.acceptedEvidence.dedicatedRenderer.commit,
      manifest.acceptedEvidence.dedicatedRenderer.codeCommit,
      manifest.acceptedEvidence.rendererSystemd255Fix.commit,
      manifest.acceptedEvidence.rendererSystemd255Fix.codeCommit,
      manifest.acceptedEvidence.rendererSystemd255IpDenyFix.commit,
      manifest.acceptedEvidence.rendererSystemd255IpDenyFix.evidenceCommit,
      manifest.acceptedEvidence.rendererSystemd255IpDenyFix.codeCommit,
      manifest.acceptedEvidence.rendererDurableControl.commit,
      manifest.acceptedEvidence.rendererDurableControl.codeCommit,
      manifest.acceptedEvidence.rendererDurableControl.historicalTargetFailure.commit,
      manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.commit,
      manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.codeCommit,
      ...manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.historicalRejectedCommits,
      manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.historicalTargetFailure.commit,
      manifest.acceptedEvidence.temporaryAccessUi.commit,
      manifest.acceptedEvidence.temporaryAccessUi.codeCommit,
      manifest.acceptedEvidence.publicCoreUi.commit]) {
      execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: clone, stdio: "ignore" });
    }
    for (const commit of [manifest.profiles.production.integrated8CCommit, manifest.acceptedEvidence.uiV2.commit,
      manifest.acceptedEvidence.uiActionClosure.commit, manifest.acceptedEvidence.uiActionClosure.codeCommit,
      manifest.acceptedEvidence.uiCopyActionClosure.commit,
      manifest.acceptedEvidence.uiCopyActionClosure.codeCommit,
      manifest.acceptedEvidence.uiCoreStates.commit,
      manifest.acceptedEvidence.uiCoreStates.testCommit,
      manifest.acceptedEvidence.browserA11y.commit, manifest.acceptedEvidence.inventory.commit,
      manifest.acceptedEvidence.publicFoundation.commit,
      manifest.acceptedEvidence.smtpOtp.commit, manifest.acceptedEvidence.smtpOtp.codeCommit,
      manifest.acceptedEvidence.questionProviderOffline.commit,
      manifest.acceptedEvidence.questionProviderOffline.capabilityCommit,
      manifest.acceptedEvidence.questionProviderOffline.uiCommit,
      manifest.acceptedEvidence.macCodexPrivateWorker.commit,
      manifest.acceptedEvidence.macCodexPrivateWorker.codeCommit,
      manifest.acceptedEvidence.privateAiQueue.commit,
      manifest.acceptedEvidence.privateAiQueue.codeCommit,
      manifest.acceptedEvidence.privateAiTransport.commit,
      manifest.acceptedEvidence.privateAiTransport.codeCommit,
      manifest.acceptedEvidence.privateAiTransport.fixCommit,
      manifest.acceptedEvidence.privateAiTransport.fixCodeCommit,
      manifest.acceptedEvidence.bookPrivateFacts.commit,
      manifest.acceptedEvidence.bookPrivateFacts.codeCommit,
      manifest.acceptedEvidence.privateAiComposition.commit,
      manifest.acceptedEvidence.privateAiComposition.codeCommit,
      manifest.acceptedEvidence.privateAiQueuedUi.commit,
      manifest.acceptedEvidence.privateAiQueuedUi.codeCommit,
      manifest.acceptedEvidence.privateAiCaddyBodyCap.commit,
      manifest.acceptedEvidence.privateAiCaddyBodyCap.codeCommit,
      manifest.acceptedEvidence.privateAiCaddyBodyCap.historicalRejectedCommit,
      manifest.acceptedEvidence.deploymentContract.commit,
      manifest.acceptedEvidence.deploymentContract.codeCommit,
      ...manifest.acceptedEvidence.deploymentContract.historicalRejectedEvidenceCommits,
      manifest.acceptedEvidence.deploymentContract.historicalDeploymentFailure.commit,
      manifest.acceptedEvidence.dedicatedRenderer.commit,
      manifest.acceptedEvidence.dedicatedRenderer.codeCommit,
      manifest.acceptedEvidence.rendererSystemd255Fix.commit,
      manifest.acceptedEvidence.rendererSystemd255Fix.codeCommit,
      manifest.acceptedEvidence.rendererSystemd255IpDenyFix.commit,
      manifest.acceptedEvidence.rendererSystemd255IpDenyFix.evidenceCommit,
      manifest.acceptedEvidence.rendererSystemd255IpDenyFix.codeCommit,
      manifest.acceptedEvidence.rendererDurableControl.commit,
      manifest.acceptedEvidence.rendererDurableControl.codeCommit,
      manifest.acceptedEvidence.rendererDurableControl.historicalTargetFailure.commit,
      manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.commit,
      manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.codeCommit,
      ...manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.historicalRejectedCommits,
      manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.historicalTargetFailure.commit,
      manifest.acceptedEvidence.temporaryAccessUi.commit,
      manifest.acceptedEvidence.temporaryAccessUi.codeCommit,
      manifest.acceptedEvidence.publicCoreUi.commit]) {
      execFileSync("git", ["merge-base", "--is-ancestor", commit, manifest.candidateCommit],
        { cwd: clone, stdio: "ignore" });
    }
    const integratedEvidence = execFileSync("git", ["show",
      `${manifest.candidateCommit}:${manifest.profiles.production.evidence.path}`], { cwd: clone });
    invariant(sha256(integratedEvidence) === manifest.profiles.production.evidence.sha256,
      "production_package_integrated_8c_evidence_mismatch");
    for (const evidence of [manifest.acceptedEvidence.browserA11y.checksumManifest,
      manifest.acceptedEvidence.browserA11y.chrome,
      manifest.acceptedEvidence.browserA11y.firefox,
      manifest.acceptedEvidence.inventory.verification,
      manifest.acceptedEvidence.inventory.inventory,
      manifest.acceptedEvidence.uiActionClosure.machineChecks,
      manifest.acceptedEvidence.uiActionClosure.browser,
      manifest.acceptedEvidence.uiCopyActionClosure.machineChecks,
      manifest.acceptedEvidence.uiCopyActionClosure.browser,
      manifest.acceptedEvidence.uiCoreStates.machineChecks,
      manifest.acceptedEvidence.uiCoreStates.browser,
      manifest.acceptedEvidence.publicFoundation.evidence,
      manifest.acceptedEvidence.smtpOtp.evidence,
      manifest.acceptedEvidence.questionProviderOffline.machineChecks,
      manifest.acceptedEvidence.questionProviderOffline.browser,
      manifest.acceptedEvidence.macCodexPrivateWorker.machineChecks,
      manifest.acceptedEvidence.macCodexPrivateWorker.runtimeBinding,
      manifest.acceptedEvidence.macCodexPrivateWorker.liveProof,
      manifest.acceptedEvidence.privateAiQueue.evidence,
      manifest.acceptedEvidence.privateAiTransport.transport,
      manifest.acceptedEvidence.privateAiTransport.liveProof,
      manifest.acceptedEvidence.privateAiTransport.retirement,
      manifest.acceptedEvidence.bookPrivateFacts.evidence,
      manifest.acceptedEvidence.privateAiComposition.evidence,
      manifest.acceptedEvidence.privateAiQueuedUi.machineChecks,
      manifest.acceptedEvidence.privateAiQueuedUi.browser,
      manifest.acceptedEvidence.privateAiCaddyBodyCap.evidence,
      manifest.acceptedEvidence.privateAiCaddyBodyCap.historicalRejectedEvidence,
      manifest.acceptedEvidence.deploymentContract.evidence,
      manifest.acceptedEvidence.deploymentContract.historicalDeploymentFailure.evidence,
      manifest.acceptedEvidence.dedicatedRenderer.evidence,
      manifest.acceptedEvidence.rendererSystemd255Fix.evidence,
      manifest.acceptedEvidence.rendererSystemd255IpDenyFix.evidence,
      manifest.acceptedEvidence.rendererDurableControl.evidence,
      manifest.acceptedEvidence.rendererDurableControl.historicalTargetFailure.evidence,
      manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.evidence,
      manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.historicalTargetFailure.evidence,
      manifest.acceptedEvidence.temporaryAccessUi.machineChecks,
      manifest.acceptedEvidence.temporaryAccessUi.browser,
      manifest.acceptedEvidence.publicCoreUi.evidence]) {
      const bytes = execFileSync("git", ["show", `${manifest.candidateCommit}:${evidence.path}`], { cwd: clone });
      invariant(sha256(bytes) === evidence.sha256,
        `production_package_accepted_evidence_mismatch:${evidence.path}`);
    }
    const dedicatedAtCandidate = execFileSync("git", ["show",
      `${manifest.candidateCommit}:${dedicatedRendererEvidencePath}`], { cwd: clone });
    const dedicatedAtDeclaredCommit = execFileSync("git", ["show",
      `${manifest.acceptedEvidence.dedicatedRenderer.commit}:${dedicatedRendererEvidencePath}`], { cwd: clone });
    invariant(dedicatedAtCandidate.equals(dedicatedAtDeclaredCommit) &&
      sha256(dedicatedAtDeclaredCommit) === acceptedDedicatedRendererEvidenceSha256 &&
      manifest.acceptedEvidence.dedicatedRenderer.evidence.sha256 === acceptedDedicatedRendererEvidenceSha256,
    "production_package_dedicated_renderer_declared_blob_mismatch");
    const systemd255AtCandidate = execFileSync("git", ["show",
      `${manifest.candidateCommit}:${rendererSystemd255FixEvidencePath}`], { cwd: clone });
    const systemd255AtDeclaredCommit = execFileSync("git", ["show",
      `${manifest.acceptedEvidence.rendererSystemd255Fix.commit}:${rendererSystemd255FixEvidencePath}`],
    { cwd: clone });
    invariant(systemd255AtCandidate.equals(systemd255AtDeclaredCommit) &&
      sha256(systemd255AtDeclaredCommit) === acceptedRendererSystemd255FixEvidenceSha256 &&
      manifest.acceptedEvidence.rendererSystemd255Fix.evidence.sha256 ===
        acceptedRendererSystemd255FixEvidenceSha256,
    "production_package_renderer_systemd255_fix_declared_blob_mismatch");
    const systemd255IpDenyAtCandidate = execFileSync("git", ["show",
      `${manifest.candidateCommit}:${rendererSystemd255IpDenyFixEvidencePath}`], { cwd: clone });
    const systemd255IpDenyAtDeclaredCommit = execFileSync("git", ["show",
      `${manifest.acceptedEvidence.rendererSystemd255IpDenyFix.commit}:${rendererSystemd255IpDenyFixEvidencePath}`],
    { cwd: clone });
    invariant(systemd255IpDenyAtCandidate.equals(systemd255IpDenyAtDeclaredCommit) &&
      sha256(systemd255IpDenyAtDeclaredCommit) === acceptedRendererSystemd255IpDenyFixEvidenceSha256 &&
      manifest.acceptedEvidence.rendererSystemd255IpDenyFix.evidence.sha256 ===
        acceptedRendererSystemd255IpDenyFixEvidenceSha256,
    "production_package_renderer_systemd255_ip_deny_fix_declared_blob_mismatch");
    const durableControlAtCandidate = execFileSync("git", ["show",
      `${manifest.candidateCommit}:${rendererDurableControlEvidencePath}`], { cwd: clone });
    const durableControlAtDeclaredCommit = execFileSync("git", ["show",
      `${manifest.acceptedEvidence.rendererDurableControl.commit}:${rendererDurableControlEvidencePath}`],
    { cwd: clone });
    invariant(durableControlAtCandidate.equals(durableControlAtDeclaredCommit) &&
      sha256(durableControlAtDeclaredCommit) === acceptedRendererDurableControlEvidenceSha256 &&
      manifest.acceptedEvidence.rendererDurableControl.evidence.sha256 ===
        acceptedRendererDurableControlEvidenceSha256,
    "production_package_renderer_durable_control_declared_blob_mismatch");
    const targetFailureAtCandidate = execFileSync("git", ["show",
      `${manifest.candidateCommit}:${historicalRendererControlTargetFailurePath}`], { cwd: clone });
    const targetFailureAtDeclaredCommit = execFileSync("git", ["show",
      `${manifest.acceptedEvidence.rendererDurableControl.historicalTargetFailure.commit}:` +
      historicalRendererControlTargetFailurePath], { cwd: clone });
    invariant(targetFailureAtCandidate.equals(targetFailureAtDeclaredCommit) &&
      sha256(targetFailureAtDeclaredCommit) === historicalRendererControlTargetFailureSha256 &&
      manifest.acceptedEvidence.rendererDurableControl.historicalTargetFailure.evidence.sha256 ===
        historicalRendererControlTargetFailureSha256,
    "production_package_renderer_control_target_failure_declared_blob_mismatch");
    for (const [label, coverage, testedInputCommit] of [
      ["browser", manifest.acceptedEvidence.browserA11y.coverageOfProductTree, currentRefreshTestedInputCommit],
      ["inventory", manifest.acceptedEvidence.inventory.coverageOfProductTree, inventoryTestedInputCommit]
    ]) {
      invariant(coverage.kind === "STALE_APPLICABLE_PRODUCT_TREE" &&
        coverage.currentCandidateCommit === manifest.candidateCommit &&
        coverage.testedInputCommit === testedInputCommit && coverage.entries.some((entry) => !entry.matches),
      `production_package_${label}_product_tree_coverage_commit_invalid`);
      for (const entry of coverage.entries) {
        const testedObject = execFileSync("git", ["rev-parse", `${testedInputCommit}:${entry.path}`],
          { cwd: clone, encoding: "utf8" }).trim();
        const candidateObject = execFileSync("git", ["rev-parse", `${manifest.candidateCommit}:${entry.path}`],
          { cwd: clone, encoding: "utf8" }).trim();
        invariant(entry.testedObjectId === testedObject && entry.currentObjectId === candidateObject &&
          entry.matches === (testedObject === candidateObject),
        `production_package_${label}_product_tree_coverage_mismatch:${entry.path}`);
      }
    }
    const migrationInventory = await Promise.all(manifest.migrations.map(async (entry) => {
      const bytes = execFileSync("git", ["show", `${manifest.candidateCommit}:services/api/db/migrations/${entry.version}.sql`],
        { cwd: clone });
      return { version: entry.version, bytes: bytes.length, sha256: sha256(bytes) };
    }));
    invariant(JSON.stringify(migrationInventory) === JSON.stringify(manifest.migrations),
      "production_package_migration_inventory_mismatch");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyPackage(root = packageRoot) {
  const manifest = JSON.parse(await readFile(path.join(root, "PACKAGE-MANIFEST.json"), "utf8"));
  invariant(manifest?.schema === "unseen-production-package/1" && manifest.releaseClaim === "NO_GO" &&
    manifest.productionReady === false, "production_package_manifest_invalid");
  invariant(JSON.stringify(manifest.releaseBlockers) === JSON.stringify(requiredBlockers),
    "production_package_blockers_invalid");
  invariant(manifest.acceptedEvidence?.uiV2?.commit === acceptedUiV2Commit &&
    manifest.acceptedEvidence.uiV2.status === "ACCEPTED" &&
    manifest.acceptedEvidence.uiActionClosure?.commit === acceptedUiActionClosureCommit &&
    manifest.acceptedEvidence.uiActionClosure.codeCommit === acceptedUiActionClosureCodeCommit &&
    manifest.acceptedEvidence.uiActionClosure.status === "ACCEPTED_FIXTURE_ONLY" &&
    manifest.acceptedEvidence.uiActionClosure.productionInput === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.uiActionClosure.machineChecks?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.uiActionClosure.browser?.sha256) &&
    manifest.acceptedEvidence.uiCopyActionClosure?.commit === acceptedUiCopyActionCommit &&
    manifest.acceptedEvidence.uiCopyActionClosure.codeCommit === acceptedUiCopyActionCodeCommit &&
    manifest.acceptedEvidence.uiCopyActionClosure.baseCandidate === acceptedUiCopyActionBaseCommit &&
    manifest.acceptedEvidence.uiCopyActionClosure.status === "ACCEPTED_FIXTURE_ONLY" &&
    manifest.acceptedEvidence.uiCopyActionClosure.productionInput === false &&
    manifest.acceptedEvidence.uiCopyActionClosure.visibleControlsDirectlyExercised === 44 &&
    manifest.acceptedEvidence.uiCopyActionClosure.coreEmptyErrorBranches ===
      "DETERMINISTIC_FIXTURE_BROWSER_EVIDENCE" &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.uiCopyActionClosure.machineChecks?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.uiCopyActionClosure.browser?.sha256) &&
    manifest.acceptedEvidence.uiCoreStates?.commit === acceptedUiCoreStatesCommit &&
    manifest.acceptedEvidence.uiCoreStates.testCommit === acceptedUiCoreStatesTestCommit &&
    manifest.acceptedEvidence.uiCoreStates.baseCandidate === acceptedUiCoreStatesBaseCommit &&
    manifest.acceptedEvidence.uiCoreStates.status === "ACCEPTED_TEST_ONLY_FIXTURE_EVIDENCE" &&
    manifest.acceptedEvidence.uiCoreStates.marker === "TEST_ONLY_FIXTURE_FAULTS" &&
    manifest.acceptedEvidence.uiCoreStates.testOnlyCases === 12 &&
    manifest.acceptedEvidence.uiCoreStates.productionFaultCoverage === false &&
    manifest.acceptedEvidence.uiCoreStates.productionInput === false &&
    manifest.acceptedEvidence.uiCoreStates.productBytesChanged === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.uiCoreStates.machineChecks?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.uiCoreStates.browser?.sha256) &&
    manifest.acceptedEvidence.publicFoundation?.commit === acceptedPublicFoundationCommit &&
    manifest.acceptedEvidence.publicFoundation.status === "ACCEPTED_TARGET_OBSERVATION" &&
    manifest.acceptedEvidence.publicFoundation.productionInput === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.publicFoundation.evidence?.sha256) &&
    manifest.acceptedEvidence.smtpOtp?.commit === acceptedSmtpCommit &&
    manifest.acceptedEvidence.smtpOtp.codeCommit === acceptedSmtpCodeCommit &&
    manifest.acceptedEvidence.smtpOtp.status === "ACCEPTED_DEFAULT_OFF" &&
    manifest.acceptedEvidence.smtpOtp.defaultEnabled === false &&
    manifest.acceptedEvidence.smtpOtp.deployableUnderCurrentPrivateBetaUnit === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.smtpOtp.evidence?.sha256) &&
    manifest.acceptedEvidence.questionProviderOffline?.commit === acceptedProviderOfflineCommit &&
    manifest.acceptedEvidence.questionProviderOffline.capabilityCommit === acceptedQuestionCapabilityCommit &&
    manifest.acceptedEvidence.questionProviderOffline.uiCommit === acceptedQuestionOfflineUiCommit &&
    manifest.acceptedEvidence.questionProviderOffline.status === "ACCEPTED" &&
    manifest.acceptedEvidence.questionProviderOffline.productFixtureAdded === false &&
    manifest.acceptedEvidence.questionProviderOffline.browserEvidenceProductionInput === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.questionProviderOffline.machineChecks?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.questionProviderOffline.browser?.sha256) &&
    manifest.acceptedEvidence.macCodexPrivateWorker?.commit === acceptedPrivateWorkerCommit &&
    manifest.acceptedEvidence.macCodexPrivateWorker.codeCommit === acceptedPrivateWorkerCodeCommit &&
    manifest.acceptedEvidence.macCodexPrivateWorker.evidenceClass === "PRIVATE_TEST_PROOF" &&
    manifest.acceptedEvidence.macCodexPrivateWorker.productionEnabled === false &&
    manifest.acceptedEvidence.macCodexPrivateWorker.productionTransport === false &&
    manifest.acceptedEvidence.macCodexPrivateWorker.factsExtraction === false &&
    manifest.acceptedEvidence.macCodexPrivateWorker.productionInput === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.macCodexPrivateWorker.machineChecks?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.macCodexPrivateWorker.runtimeBinding?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.macCodexPrivateWorker.liveProof?.sha256) &&
    manifest.acceptedEvidence.browserA11y?.commit === acceptedBrowserA11yCommit &&
    manifest.acceptedEvidence.browserA11y.testedInputCommit === currentRefreshTestedInputCommit &&
    manifest.acceptedEvidence.browserA11y.browserExecutedCandidateCommit === currentRefreshTestedInputCommit &&
    manifest.acceptedEvidence.browserA11y.postEvidenceCandidateBrowserExecuted === false &&
    manifest.acceptedEvidence.browserA11y.currentCandidateCoverage === false &&
    manifest.acceptedEvidence.browserA11y.coverageScope === "STALE_APPLICABLE_PRODUCT_TREE" &&
    manifest.acceptedEvidence.browserA11y.formalPerformanceVerdict ===
      "INDETERMINATE_PROFILE_UNDERSPECIFIED_FAIL_CLOSED" &&
    manifest.acceptedEvidence.browserA11y.releaseBoundary === "NAMED_MACOS_PATHS_ONLY_NEEDS_REVIEW" &&
    manifest.acceptedEvidence.inventory?.commit === acceptedInventoryCommit &&
    manifest.acceptedEvidence.inventory.testedInputCommit === inventoryTestedInputCommit &&
    manifest.acceptedEvidence.inventory.inventoryGeneratedCandidateCommit === inventoryTestedInputCommit &&
    manifest.acceptedEvidence.inventory.fullRepositoryCandidateCoverage === false &&
    manifest.acceptedEvidence.inventory.currentCandidateCoverage === false &&
    manifest.acceptedEvidence.inventory.coverageScope === "STALE_APPLICABLE_PRODUCT_TREE" &&
    manifest.acceptedEvidence.inventory.reviewState === "needs_review" &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.browserA11y.checksumManifest?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.browserA11y.chrome?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.browserA11y.firefox?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.inventory.verification?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.inventory.inventory?.sha256),
  "production_package_accepted_evidence_invalid");
  invariant(manifest.acceptedEvidence.privateAiQueue?.commit === acceptedPrivateAiQueueCommit &&
    manifest.acceptedEvidence.privateAiQueue.codeCommit === acceptedPrivateAiQueueCodeCommit &&
    manifest.acceptedEvidence.privateAiQueue.status === "ACCEPTED_DEFAULT_OFF" &&
    manifest.acceptedEvidence.privateAiQueue.productionEnabled === false &&
    manifest.acceptedEvidence.privateAiQueue.productionTransport === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.privateAiQueue.evidence?.sha256),
  "production_package_private_ai_queue_evidence_invalid");
  invariant(manifest.acceptedEvidence.privateAiTransport?.commit === acceptedPrivateAiTransportCommit &&
    manifest.acceptedEvidence.privateAiTransport.codeCommit === acceptedPrivateAiTransportCodeCommit &&
    manifest.acceptedEvidence.privateAiTransport.fixCommit === acceptedPrivateAiTransportFixCommit &&
    manifest.acceptedEvidence.privateAiTransport.fixCodeCommit === acceptedPrivateAiTransportFixCodeCommit &&
    manifest.acceptedEvidence.privateAiTransport.status === "ACCEPTED_DEFAULT_OFF_NOT_DEPLOYED" &&
    manifest.acceptedEvidence.privateAiTransport.evidenceClass === "PRIVATE_BETA_TRANSPORT_IMPLEMENTATION" &&
    manifest.acceptedEvidence.privateAiTransport.liveProofClass === "PRIVATE_TEST_PROOF" &&
    manifest.acceptedEvidence.privateAiTransport.subscriptionBoundary ===
      "CHATGPT_SUBSCRIPTION_PRIVATE_TEST_NOT_OPENAI_API" &&
    manifest.acceptedEvidence.privateAiTransport.commercialSla === false &&
    manifest.acceptedEvidence.privateAiTransport.productionEnabled === false &&
    manifest.acceptedEvidence.privateAiTransport.productionTransport === false &&
    manifest.acceptedEvidence.privateAiTransport.factsExtraction === false &&
    manifest.acceptedEvidence.privateAiTransport.productionInput === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.privateAiTransport.transport?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.privateAiTransport.liveProof?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.privateAiTransport.retirement?.sha256),
  "production_package_private_ai_transport_evidence_invalid");
  invariant(manifest.acceptedEvidence.bookPrivateFacts?.commit === acceptedBookPrivateFactsCommit &&
    manifest.acceptedEvidence.bookPrivateFacts.codeCommit === acceptedBookPrivateFactsCodeCommit &&
    manifest.acceptedEvidence.bookPrivateFacts.status === "ACCEPTED_PRIVATE_BOOK_FACTS" &&
    manifest.acceptedEvidence.bookPrivateFacts.defaultOff === true &&
    manifest.acceptedEvidence.bookPrivateFacts.coreMutation === false &&
    manifest.acceptedEvidence.bookPrivateFacts.publicFacts === false &&
    manifest.acceptedEvidence.bookPrivateFacts.autoBook === false &&
    manifest.acceptedEvidence.bookPrivateFacts.productionInput === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.bookPrivateFacts.evidence?.sha256),
  "production_package_book_private_facts_evidence_invalid");
  invariant(manifest.acceptedEvidence.privateAiComposition?.commit === acceptedPrivateAiCompositionCommit &&
    manifest.acceptedEvidence.privateAiComposition.codeCommit === acceptedPrivateAiCompositionCodeCommit &&
    manifest.acceptedEvidence.privateAiComposition.status === "ACCEPTED_DEFAULT_OFF" &&
    manifest.acceptedEvidence.privateAiComposition.productionEnabled === false &&
    manifest.acceptedEvidence.privateAiComposition.productionTransport === false &&
    manifest.acceptedEvidence.privateAiComposition.credentialCreated === false &&
    manifest.acceptedEvidence.privateAiComposition.productionInput === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.privateAiComposition.evidence?.sha256),
  "production_package_private_ai_composition_evidence_invalid");
  invariant(manifest.acceptedEvidence.privateAiQueuedUi?.commit === acceptedPrivateAiQueuedUiCommit &&
    manifest.acceptedEvidence.privateAiQueuedUi.codeCommit === acceptedPrivateAiQueuedUiCodeCommit &&
    manifest.acceptedEvidence.privateAiQueuedUi.status === "ACCEPTED_DETERMINISTIC_BROWSER_EVIDENCE" &&
    manifest.acceptedEvidence.privateAiQueuedUi.productionInput === false &&
    manifest.acceptedEvidence.privateAiQueuedUi.productFixtureAdded === false &&
    manifest.acceptedEvidence.privateAiQueuedUi.browserCases === 4 &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.privateAiQueuedUi.machineChecks?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.privateAiQueuedUi.browser?.sha256),
  "production_package_private_ai_queued_ui_evidence_invalid");
  invariant(manifest.acceptedEvidence.privateAiCaddyBodyCap?.commit === acceptedPrivateAiCaddyBodyCapCommit &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.codeCommit === acceptedPrivateAiCaddyBodyCapCodeCommit &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.status === "ACCEPTED_CODE_ONLY_NOT_DEPLOYED" &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.productionDeployed === false &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.productionInput === false &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.exactRequestBytes === 32768 &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.missingContentLengthOrChunkedStatus === 413 &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.oversizeStatus === 413 &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.protocolHeader === "unseen-private-ai-pull/1" &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.cacheControl === "private, no-store, max-age=0" &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.contentType === "application/json" &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.upstreamRequestsForRejectedBodies === 0 &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.historicalRejectedCommit === historicalShadowTransportCommit &&
    manifest.acceptedEvidence.privateAiCaddyBodyCap.historicalRejectedStatus ===
      "HISTORICAL_REJECTED_SUPERSEDED_BY_ACCEPTED_CODE_FIX" &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.privateAiCaddyBodyCap.evidence?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.privateAiCaddyBodyCap.historicalRejectedEvidence?.sha256),
  "production_package_private_ai_caddy_body_cap_evidence_invalid");
  invariant(manifest.acceptedEvidence.deploymentContract?.commit === acceptedDeploymentContractCommit &&
    manifest.acceptedEvidence.deploymentContract.codeCommit === acceptedDeploymentContractCodeCommit &&
    manifest.acceptedEvidence.deploymentContract.status === "ACCEPTED_CODE_ONLY_NOT_DEPLOYED" &&
    manifest.acceptedEvidence.deploymentContract.acceptedChain === "ALREADY_LINEAR_ON_STAGE5" &&
    manifest.acceptedEvidence.deploymentContract.productionDeployed === false &&
    manifest.acceptedEvidence.deploymentContract.productionInput === false &&
    manifest.acceptedEvidence.deploymentContract.activeAuthority ===
      "LOADED_UNIT_PROCESS_CWD_DETACHED_HEAD_TREE_CLEAN" &&
    manifest.acceptedEvidence.deploymentContract.unitRenderMarker === releaseMarker &&
    manifest.acceptedEvidence.deploymentContract.candidateValueMarker === candidateValueMarker &&
    manifest.acceptedEvidence.deploymentContract.renderMarkersNonOverlapping === true &&
    JSON.stringify(manifest.acceptedEvidence.deploymentContract.caddyPermissions) === JSON.stringify({
      sealedBackup: "root:root:0600", liveInstall: "root:caddy:0640", liveRollback: "root:caddy:0640"
    }) && manifest.acceptedEvidence.deploymentContract.orderedMigrations === 10 &&
    manifest.acceptedEvidence.deploymentContract.productionCaddy?.outerAuth === "ABSENT_APPLICATION_OWNED" &&
    manifest.acceptedEvidence.deploymentContract.productionCaddy.globalCsp === "ABSENT_APPLICATION_OWNED" &&
    manifest.acceptedEvidence.deploymentContract.productionCaddy.cookieAndBearerForwarded === true &&
    manifest.acceptedEvidence.deploymentContract.productionCaddy.upstreamCspAndContentPreserved === true &&
    manifest.acceptedEvidence.deploymentContract.productionCaddy.acceptedBodyCapCommit ===
      acceptedPrivateAiCaddyBodyCapCommit &&
    JSON.stringify(manifest.acceptedEvidence.deploymentContract.historicalRejectedEvidenceCommits) ===
      JSON.stringify([historicalRejectedActiveReleaseEvidenceCommit,
        historicalRejectedPortableReleaseEvidenceCommit]) &&
    manifest.acceptedEvidence.deploymentContract.historicalRejectedStatus ===
      "HISTORICAL_REJECTED_SUPERSEDED" &&
    manifest.acceptedEvidence.deploymentContract.historicalDeploymentFailure?.commit ===
      historicalDeploymentFailureCommit &&
    manifest.acceptedEvidence.deploymentContract.historicalDeploymentFailure.status ===
      "HISTORICAL_ROLLED_BACK_P1_FIXED_CODE_ONLY_NOT_DEPLOYED" &&
    manifest.acceptedEvidence.deploymentContract.historicalDeploymentFailure.productionDeployed === false &&
    JSON.stringify(manifest.acceptedEvidence.deploymentContract.historicalDeploymentFailure.fixedP1) ===
      JSON.stringify(["ACTIVE_RELEASE_ALIAS_STALE_AND_CAN_MISREPORT_DEPLOYED_CANDIDATE",
        "CADDY_SYSTEMD_RELOAD_PERMISSION_MISMATCH_BLOCKS_ACCEPTED_BODY_CAP_ACTIVATION"]) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.deploymentContract.evidence?.sha256) &&
    /^[a-f0-9]{64}$/u.test(
      manifest.acceptedEvidence.deploymentContract.historicalDeploymentFailure.evidence?.sha256),
  "production_package_deployment_contract_evidence_invalid");
  invariant(manifest.acceptedEvidence.dedicatedRenderer?.commit === acceptedDedicatedRendererCommit &&
    manifest.acceptedEvidence.dedicatedRenderer.codeCommit === acceptedDedicatedRendererCodeCommit &&
    manifest.acceptedEvidence.dedicatedRenderer.status ===
      "CODE_GATES_PASS_TARGET_ACCEPTANCE_REQUIRED" &&
    manifest.acceptedEvidence.dedicatedRenderer.defaultOff === true &&
    manifest.acceptedEvidence.dedicatedRenderer.productionEnabled === false &&
    manifest.acceptedEvidence.dedicatedRenderer.targetAcceptance === "REQUIRED_NOT_INCLUDED" &&
    manifest.acceptedEvidence.dedicatedRenderer.focusedCases === 29 &&
    manifest.acceptedEvidence.dedicatedRenderer.evidence?.path === dedicatedRendererEvidencePath &&
    manifest.acceptedEvidence.dedicatedRenderer.evidence.sha256 === acceptedDedicatedRendererEvidenceSha256,
  "production_package_dedicated_renderer_evidence_invalid");
  invariant(manifest.acceptedEvidence.rendererSystemd255Fix?.commit === acceptedRendererSystemd255FixCommit &&
    manifest.acceptedEvidence.rendererSystemd255Fix.codeCommit === acceptedRendererSystemd255FixCodeCommit &&
    manifest.acceptedEvidence.rendererSystemd255Fix.status === "CODE_GATES_PASS_TARGET_RETRY_REQUIRED" &&
    manifest.acceptedEvidence.rendererSystemd255Fix.defaultOff === true &&
    manifest.acceptedEvidence.rendererSystemd255Fix.targetRetryRequired === true &&
    manifest.acceptedEvidence.rendererSystemd255Fix.focusedCases === 29 &&
    manifest.acceptedEvidence.rendererSystemd255Fix.evidence?.path === rendererSystemd255FixEvidencePath &&
    manifest.acceptedEvidence.rendererSystemd255Fix.evidence.sha256 ===
      acceptedRendererSystemd255FixEvidenceSha256,
  "production_package_renderer_systemd255_fix_evidence_invalid");
  invariant(manifest.acceptedEvidence.rendererSystemd255IpDenyFix?.commit ===
      acceptedRendererSystemd255IpDenyFixCommit &&
    manifest.acceptedEvidence.rendererSystemd255IpDenyFix.evidenceCommit ===
      acceptedRendererSystemd255IpDenyFixEvidenceCommit &&
    manifest.acceptedEvidence.rendererSystemd255IpDenyFix.codeCommit ===
      acceptedRendererSystemd255IpDenyFixCodeCommit &&
    manifest.acceptedEvidence.rendererSystemd255IpDenyFix.status ===
      "CODE_GATES_PASS_TARGET_RETRY_REQUIRED" &&
    manifest.acceptedEvidence.rendererSystemd255IpDenyFix.defaultOff === true &&
    manifest.acceptedEvidence.rendererSystemd255IpDenyFix.targetRetryRequired === true &&
    manifest.acceptedEvidence.rendererSystemd255IpDenyFix.focusedCases === 29 &&
    manifest.acceptedEvidence.rendererSystemd255IpDenyFix.evidence?.path ===
      rendererSystemd255IpDenyFixEvidencePath &&
    manifest.acceptedEvidence.rendererSystemd255IpDenyFix.evidence.sha256 ===
      acceptedRendererSystemd255IpDenyFixEvidenceSha256,
  "production_package_renderer_systemd255_ip_deny_fix_evidence_invalid");
  invariant(manifest.acceptedEvidence.rendererDurableControl?.commit ===
      acceptedRendererDurableControlCommit &&
    manifest.acceptedEvidence.rendererDurableControl.codeCommit ===
      acceptedRendererDurableControlCodeCommit &&
    manifest.acceptedEvidence.rendererDurableControl.status ===
      "CODE_GATES_PASS_TARGET_RETRY_REQUIRED" &&
    manifest.acceptedEvidence.rendererDurableControl.defaultOff === true &&
    manifest.acceptedEvidence.rendererDurableControl.targetRetryRequired === true &&
    manifest.acceptedEvidence.rendererDurableControl.focusedCases === 41 &&
    manifest.acceptedEvidence.rendererDurableControl.evidence?.path ===
      rendererDurableControlEvidencePath &&
    manifest.acceptedEvidence.rendererDurableControl.evidence.sha256 ===
      acceptedRendererDurableControlEvidenceSha256 &&
    manifest.acceptedEvidence.rendererDurableControl.historicalTargetFailure?.commit ===
      historicalRendererControlTargetFailureCommit &&
    manifest.acceptedEvidence.rendererDurableControl.historicalTargetFailure.status ===
      "HISTORICAL_TARGET_REJECTED_SUPERSEDED_BY_ACCEPTED_COLD_READINESS_FIX" &&
    manifest.acceptedEvidence.rendererDurableControl.historicalTargetFailure.evidence?.path ===
      historicalRendererControlTargetFailurePath &&
    manifest.acceptedEvidence.rendererDurableControl.historicalTargetFailure.evidence.sha256 ===
      historicalRendererControlTargetFailureSha256,
  "production_package_renderer_durable_control_evidence_invalid");
  invariant(manifest.acceptedEvidence.rendererSnapAdapter?.commit === acceptedRendererSnapAdapterCommit &&
    manifest.acceptedEvidence.rendererSnapAdapter.codeCommit === acceptedRendererSnapAdapterCodeCommit &&
    manifest.acceptedEvidence.rendererSnapAdapter.status === "CODE_GATES_PASS_TARGET_EXECUTION_NOT_RUN" &&
    manifest.acceptedEvidence.rendererSnapAdapter.defaultOff === true &&
    manifest.acceptedEvidence.rendererSnapAdapter.targetAcceptanceRequired === true &&
    manifest.acceptedEvidence.rendererSnapAdapter.environmentEntryCount === 14 &&
    manifest.acceptedEvidence.rendererSnapAdapter.treeManifestSha256 ===
      "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913" &&
    manifest.acceptedEvidence.rendererSnapAdapter.resourceManifestSha256 ===
      "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5" &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkPolicySha256 ===
      "3c3f99c6d62feffb90a873bc245930045a1e42bdc0c3b1e5c2a763208586b128" &&
    manifest.acceptedEvidence.rendererSnapAdapter.runtimeReachability ===
      "ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE" &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix?.commit ===
      acceptedRendererSnapDanglingCommit &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.codeCommit ===
      acceptedRendererSnapDanglingCodeCommit &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.status ===
      "CODE_GATES_PASS_TARGET_RETRY_REQUIRED" &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.defaultOff === true &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.targetRetryRequired === true &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.focusedCases === 45 &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.evidence?.path ===
      rendererSnapDanglingEvidencePath &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.evidence.sha256 ===
      acceptedRendererSnapDanglingEvidenceSha256 &&
    JSON.stringify(manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix
      .historicalRejectedCommits) === JSON.stringify(historicalRendererSnapDanglingRejectedCommits) &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.historicalTargetFailure?.commit ===
      historicalRendererSnapDanglingFailureCommit &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.historicalTargetFailure.evidence.path ===
      historicalRendererSnapDanglingFailurePath &&
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.historicalTargetFailure.evidence.sha256 ===
      historicalRendererSnapDanglingFailureSha256 &&
    manifest.acceptedEvidence.rendererSnapAdapter.evidence?.path === rendererSnapAdapterEvidencePath &&
    manifest.acceptedEvidence.rendererSnapAdapter.evidence.sha256 ===
      acceptedRendererSnapAdapterEvidenceSha256 &&
    manifest.acceptedEvidence.rendererSnapAdapter.staticInput?.commit === rendererRouteStaticCommit &&
    manifest.acceptedEvidence.rendererSnapAdapter.staticInput.path === rendererRouteStaticEvidencePath &&
    manifest.acceptedEvidence.rendererSnapAdapter.staticInput.sha256 === rendererRouteStaticEvidenceSha256 &&
    JSON.stringify(manifest.acceptedEvidence.rendererSnapAdapter.targetDiagnostics) ===
      JSON.stringify(rendererRouteTargetDiagnostics) &&
    JSON.stringify(manifest.acceptedEvidence.rendererSnapAdapter.externalReleaseGates) === JSON.stringify([
      "CHROMIUM_ASSERTION_SIGNATURE_NOT_INDEPENDENTLY_VERIFIED",
      "CHROMIUM_LICENSE_DECLARATION_UNAPPROVED",
      "CHROMIUM_SECURITY_REVIEW_REQUIRED",
      "TARGET_SYNTHETIC_RENDER_AND_NETWORK_ACCEPTANCE_NOT_RUN"
    ]), "production_package_renderer_snap_adapter_evidence_invalid");
  invariant(manifest.acceptedEvidence.rendererSnapCacheHardlink?.commit === acceptedRendererSnapCacheCommit &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.codeCommit === acceptedRendererSnapCacheCodeCommit &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.status === "CODE_GATES_PASS_TARGET_RETRY_REQUIRED" &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.defaultOff === true &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.targetRetryRequired === true &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.focusedCases === 44 &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.cacheMutationPerformed === false &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.evidence?.path === rendererSnapCacheEvidencePath &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.evidence.sha256 ===
      acceptedRendererSnapCacheEvidenceSha256 &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.historicalTargetFailure?.commit ===
      historicalRendererSnapCacheFailureCommit &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.historicalTargetFailure.evidence.path ===
      historicalRendererSnapCacheFailurePath &&
    manifest.acceptedEvidence.rendererSnapCacheHardlink.historicalTargetFailure.evidence.sha256 ===
      historicalRendererSnapCacheFailureSha256,
  "production_package_renderer_snap_cache_evidence_invalid");
  invariant(manifest.acceptedEvidence.temporaryAccessUi?.commit === acceptedTemporaryAccessUiCommit &&
    manifest.acceptedEvidence.temporaryAccessUi.codeCommit === acceptedTemporaryAccessUiCodeCommit &&
    manifest.acceptedEvidence.temporaryAccessUi.status === "ACCEPTED_TEMPORARY_ACCESS_DISCLOSURE" &&
    manifest.acceptedEvidence.temporaryAccessUi.productionInput === false &&
    manifest.acceptedEvidence.temporaryAccessUi.temporaryAccessBanner === true &&
    manifest.acceptedEvidence.temporaryAccessUi.faviconAsset === true &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.temporaryAccessUi.machineChecks?.sha256) &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.temporaryAccessUi.browser?.sha256),
  "production_package_temporary_access_ui_evidence_invalid");
  invariant(manifest.acceptedEvidence.publicCoreUi?.commit === acceptedPublicCoreUiCommit &&
    manifest.acceptedEvidence.publicCoreUi.status ===
      "PASS_PUBLIC_CORE_UI_TARGET_MILESTONE_NOT_CORE_OPERABLE_BETA" &&
    manifest.acceptedEvidence.publicCoreUi.observedCandidateCommit ===
      "45380ecd77315fcc95f3e445353f8abdc6c77603" &&
    manifest.acceptedEvidence.publicCoreUi.finalCandidateDeployed === false &&
    manifest.acceptedEvidence.publicCoreUi.publicCoreUiServed === true &&
    manifest.acceptedEvidence.publicCoreUi.otpEnabled === false &&
    manifest.acceptedEvidence.publicCoreUi.bookEnabled === false &&
    manifest.acceptedEvidence.publicCoreUi.privateAiEnabled === false &&
    /^[a-f0-9]{64}$/u.test(manifest.acceptedEvidence.publicCoreUi.evidence?.sha256),
  "production_package_public_core_ui_evidence_invalid");
  invariant(manifest.profiles?.staging?.id === "local_staging_fixture" &&
    manifest.profiles.staging.coreProductCommit === manifest.coreProductCommit &&
    manifest.profiles.staging.bookFixtureCommit === manifest.bookCommit &&
    manifest.profiles.staging.featureFlagBookLab === false && manifest.profiles.staging.fixtureOnly === true &&
    manifest.profiles.staging.productionInput === false, "production_package_staging_profile_invalid");
  invariant(manifest.profiles?.production?.id === "integrated_book_lab_8c" &&
    manifest.profiles.production.integrated8CCommit === accepted8CCommit &&
    manifest.profiles.production.featureFlagDefault === false &&
    manifest.profiles.production.fixtureFallback === false &&
    manifest.profiles.production.smtpOtpDefaultEnabled === false &&
    manifest.profiles.production.smtpOtpDeployableUnderCurrentPrivateBetaUnit === false &&
    manifest.profiles.production.questionProviderCapabilityExposed === true &&
    manifest.profiles.production.questionProviderConfigured === false &&
    manifest.profiles.production.visibleFactsApproved === false &&
    manifest.profiles.production.factsProviderAcceptanceEnabled === false &&
    manifest.profiles.production.factsProviderAcceptanceSchema === acceptanceSchema &&
    manifest.profiles.production.macCodexPrivateWorkerEvidenceClass === "PRIVATE_TEST_PROOF" &&
    manifest.profiles.production.macCodexPrivateWorkerProductionTransport === false &&
    manifest.profiles.production.macCodexPrivateWorkerFactsExtraction === false &&
    manifest.profiles.production.privateAiQueueDefaultEnabled === false &&
    manifest.profiles.production.privateAiCompositionDefaultEnabled === false &&
    manifest.profiles.production.privateAiTransportDeployed === false &&
    manifest.profiles.production.privateAiCaddyBodyCapBytes === 32768 &&
    manifest.profiles.production.privateAiCaddyBodyCapStatus === "ACCEPTED_CODE_ONLY_NOT_DEPLOYED" &&
    manifest.profiles.production.deploymentContractStatus === "ACCEPTED_CODE_ONLY_NOT_DEPLOYED" &&
    manifest.profiles.production.activeReleaseAuthority ===
      "LOADED_UNIT_PROCESS_CWD_DETACHED_HEAD_TREE_CLEAN" &&
    manifest.profiles.production.caddyPermissionContract === "SEALED_0600_LIVE_AND_ROLLBACK_0640" &&
    manifest.profiles.production.orderedMigrations === 10 &&
    manifest.profiles.production.productionCaddyApplicationAuthAndCsp === true &&
    manifest.profiles.production.bookPrivateFactsBoundary === "BOOK_PRIVATE_NOT_CORE_PUBLIC_OR_AUTO_BOOK" &&
    manifest.profiles.production.privateAiQueuedUiEvidence ===
      "DETERMINISTIC_BROWSER_EVIDENCE_NOT_PRODUCTION_INPUT" &&
    manifest.profiles.production.decoderRuntimeAuthenticity === "HASH_BOUND_TARGET_ACCEPTANCE_REQUIRED" &&
    manifest.profiles.production.rendererDedicatedService === "unseen-book-renderer-dedicated-service/v1" &&
    manifest.profiles.production.rendererDedicatedServiceDefaultEnabled === false &&
    manifest.profiles.production.rendererNetworkNamespace === "SYSTEMD_PRIVATE_NETWORK" &&
    manifest.profiles.production.rendererIpc === "FILESYSTEM_AF_UNIX_AND_PRIVATE_SPOOL" &&
    manifest.profiles.production.rendererTargetAcceptance === "REQUIRED_NOT_INCLUDED" &&
    manifest.profiles.production.dedicatedRendererAcceptedCommit === acceptedDedicatedRendererCommit &&
    manifest.profiles.production.rendererSystemd255FixAcceptedCommit === acceptedRendererSystemd255FixCommit &&
    manifest.profiles.production.rendererSystemd255IpDenyFixAcceptedCommit ===
      acceptedRendererSystemd255IpDenyFixCommit &&
    manifest.profiles.production.rendererDurableControlAcceptedCommit ===
      acceptedRendererDurableControlCommit &&
    manifest.profiles.production.temporaryAccessUiAcceptedCommit === acceptedTemporaryAccessUiCommit &&
    manifest.profiles.production.publicCoreUiEvidenceCommit === acceptedPublicCoreUiCommit &&
    manifest.profiles.production.publicCoreUiObservedCandidateCommit ===
      "45380ecd77315fcc95f3e445353f8abdc6c77603" &&
    manifest.profiles.production.publicCoreUiFinalCandidateDeployed === false &&
    manifest.profiles.production.rendererProfile === "production" &&
    manifest.profiles.production.rendererBrowserAdapter ===
      "candidate-owned-fixed-headless-snap-3507/v1" &&
    manifest.profiles.production.rendererBrowserDistributionEmbedded === false &&
    manifest.profiles.production.rendererBrowserReleaseDecision ===
      "NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED" &&
    manifest.profiles.production.lifecycleEntrypoint ===
      "infra/integration/book-lab/deployment-entrypoint.mjs" &&
    manifest.profiles.production.evidence?.path === integrated8CEvidencePath &&
    /^[a-f0-9]{64}$/u.test(manifest.profiles.production.evidence.sha256),
  "production_package_integrated_8c_profile_invalid");
  invariant(JSON.stringify(manifest.artifacts?.map((entry) => entry.path)) === JSON.stringify(artifactNames),
    "production_package_artifacts_invalid");
  await privateTree(root, ["PACKAGE-MANIFEST.json", ...artifactNames]);
  const actual = await Promise.all(manifest.artifacts.map((entry) => fileRecord(root, entry.path)));
  invariant(JSON.stringify(actual) === JSON.stringify(manifest.artifacts), "production_package_byte_mismatch");
  await verifyPackagedDeploymentContract(root);
  await verifyBundle(root, manifest);
  return manifest;
}

async function build() {
  invariant(path.isAbsolute(process.env.UNSEEN_PRODUCTION_PACKAGE_DIR ?? ""),
    "production_package_absolute_output_required");
  invariant(packageRoot !== path.parse(packageRoot).root && !inside(repositoryRoot, packageRoot),
    "production_package_output_unsafe");
  invariant(!(await exists(packageRoot)), "production_package_output_exists");
  invariant(git(["status", "--porcelain"]) === "", "production_package_repository_dirty");
  const candidateCommit = git(["rev-parse", "HEAD"]);
  for (const [label, commit] of [["integrated_8c", accepted8CCommit], ["ui_v2", acceptedUiV2Commit],
    ["ui_action_closure", acceptedUiActionClosureCommit],
    ["ui_copy_action_closure", acceptedUiCopyActionCommit],
    ["ui_core_states", acceptedUiCoreStatesCommit],
    ["ui_core_states_test", acceptedUiCoreStatesTestCommit],
    ["ui_core_states_base", acceptedUiCoreStatesBaseCommit],
    ["current_refresh_tested_input", currentRefreshTestedInputCommit],
    ["inventory_tested_input", inventoryTestedInputCommit],
    ["browser_a11y", acceptedBrowserA11yCommit], ["inventory", acceptedInventoryCommit],
    ["public_foundation", acceptedPublicFoundationCommit],
    ["smtp_otp", acceptedSmtpCommit], ["smtp_otp_code", acceptedSmtpCodeCommit],
    ["provider_offline", acceptedProviderOfflineCommit],
    ["question_capability", acceptedQuestionCapabilityCommit],
    ["question_offline_ui", acceptedQuestionOfflineUiCommit],
    ["mac_codex_private_worker", acceptedPrivateWorkerCommit],
    ["mac_codex_private_worker_code", acceptedPrivateWorkerCodeCommit],
    ["private_ai_queue", acceptedPrivateAiQueueCommit],
    ["private_ai_queue_code", acceptedPrivateAiQueueCodeCommit],
    ["private_ai_transport", acceptedPrivateAiTransportCommit],
    ["private_ai_transport_code", acceptedPrivateAiTransportCodeCommit],
    ["private_ai_transport_fix", acceptedPrivateAiTransportFixCommit],
    ["private_ai_transport_fix_code", acceptedPrivateAiTransportFixCodeCommit],
    ["book_private_facts", acceptedBookPrivateFactsCommit],
    ["book_private_facts_code", acceptedBookPrivateFactsCodeCommit],
    ["private_ai_composition", acceptedPrivateAiCompositionCommit],
    ["private_ai_composition_code", acceptedPrivateAiCompositionCodeCommit],
    ["private_ai_queued_ui", acceptedPrivateAiQueuedUiCommit],
    ["private_ai_queued_ui_code", acceptedPrivateAiQueuedUiCodeCommit],
    ["private_ai_caddy_body_cap", acceptedPrivateAiCaddyBodyCapCommit],
    ["private_ai_caddy_body_cap_code", acceptedPrivateAiCaddyBodyCapCodeCommit],
    ["historical_shadow_transport", historicalShadowTransportCommit],
    ["deployment_contract", acceptedDeploymentContractCommit],
    ["deployment_contract_code", acceptedDeploymentContractCodeCommit],
    ["historical_rejected_active_release_evidence", historicalRejectedActiveReleaseEvidenceCommit],
    ["historical_rejected_portable_release_evidence", historicalRejectedPortableReleaseEvidenceCommit],
    ["historical_deployment_failure", historicalDeploymentFailureCommit],
    ["dedicated_renderer", acceptedDedicatedRendererCommit],
    ["dedicated_renderer_code", acceptedDedicatedRendererCodeCommit],
    ["renderer_systemd255_fix", acceptedRendererSystemd255FixCommit],
    ["renderer_systemd255_fix_code", acceptedRendererSystemd255FixCodeCommit],
    ["renderer_systemd255_ip_deny_fix", acceptedRendererSystemd255IpDenyFixCommit],
    ["renderer_systemd255_ip_deny_fix_evidence", acceptedRendererSystemd255IpDenyFixEvidenceCommit],
    ["renderer_systemd255_ip_deny_fix_code", acceptedRendererSystemd255IpDenyFixCodeCommit],
    ["renderer_durable_control", acceptedRendererDurableControlCommit],
    ["renderer_durable_control_code", acceptedRendererDurableControlCodeCommit],
    ["renderer_control_target_failure", historicalRendererControlTargetFailureCommit],
    ["renderer_snap_adapter", acceptedRendererSnapAdapterCommit],
    ["renderer_snap_adapter_code", acceptedRendererSnapAdapterCodeCommit],
    ["renderer_snap_cache", acceptedRendererSnapCacheCommit],
    ["renderer_snap_cache_code", acceptedRendererSnapCacheCodeCommit],
    ["renderer_snap_cache_target_failure", historicalRendererSnapCacheFailureCommit],
    ["renderer_route_static", rendererRouteStaticCommit],
    ...rendererRouteTargetDiagnostics.map((entry, index) => [`renderer_route_target_diagnostic_${index}`,
      entry.commit]),
    ["temporary_access_ui", acceptedTemporaryAccessUiCommit],
    ["temporary_access_ui_code", acceptedTemporaryAccessUiCodeCommit],
    ["public_core_ui", acceptedPublicCoreUiCommit]]) {
    invariant(spawnSync("git", ["merge-base", "--is-ancestor", commit, candidateCommit],
      { cwd: repositoryRoot }).status === 0, `production_package_${label}_missing`);
  }
  const config = JSON.parse(await readFile(path.join(repositoryRoot, "config/rc/local-staging.json"), "utf8"));
  const integrated8CEvidence = await readFile(path.join(repositoryRoot, integrated8CEvidencePath));
  const browserChecksums = await readFile(path.join(repositoryRoot, browserEvidencePath));
  const browserChromeEvidence = await readFile(path.join(repositoryRoot, browserChromeEvidencePath));
  const browserFirefoxEvidence = await readFile(path.join(repositoryRoot, browserFirefoxEvidencePath));
  const inventoryVerification = await readFile(path.join(repositoryRoot, inventoryVerificationPath));
  const inventory = await readFile(path.join(repositoryRoot, inventoryPath));
  const uiActionClosureChecks = await readFile(path.join(repositoryRoot, uiActionClosureChecksPath));
  const uiActionClosureBrowser = await readFile(path.join(repositoryRoot, uiActionClosureBrowserPath));
  const uiCopyActionChecks = await readFile(path.join(repositoryRoot, uiCopyActionChecksPath));
  const uiCopyActionBrowser = await readFile(path.join(repositoryRoot, uiCopyActionBrowserPath));
  const uiCoreStatesChecks = await readFile(path.join(repositoryRoot, uiCoreStatesChecksPath));
  const uiCoreStatesBrowser = await readFile(path.join(repositoryRoot, uiCoreStatesBrowserPath));
  const publicFoundationEvidence = await readFile(path.join(repositoryRoot, publicFoundationEvidencePath));
  const smtpEvidence = await readFile(path.join(repositoryRoot, smtpEvidencePath));
  const providerOfflineChecks = await readFile(path.join(repositoryRoot, providerOfflineChecksPath));
  const providerOfflineBrowser = await readFile(path.join(repositoryRoot, providerOfflineBrowserPath));
  const privateWorkerChecks = await readFile(path.join(repositoryRoot, privateWorkerChecksPath));
  const privateWorkerRuntime = await readFile(path.join(repositoryRoot, privateWorkerRuntimePath));
  const privateWorkerLiveProof = await readFile(path.join(repositoryRoot, privateWorkerLiveProofPath));
  const privateAiQueueEvidence = await readFile(path.join(repositoryRoot, privateAiQueueEvidencePath));
  const privateAiTransportEvidence = await readFile(path.join(repositoryRoot, privateAiTransportEvidencePath));
  const privateAiRemoteLiveEvidence = await readFile(path.join(repositoryRoot, privateAiRemoteLiveEvidencePath));
  const privateAiRetirementEvidence = await readFile(path.join(repositoryRoot, privateAiRetirementEvidencePath));
  const bookPrivateFactsEvidence = await readFile(path.join(repositoryRoot, bookPrivateFactsEvidencePath));
  const privateAiCompositionEvidence = await readFile(path.join(repositoryRoot, privateAiCompositionEvidencePath));
  const privateAiQueuedUiChecks = await readFile(path.join(repositoryRoot, privateAiQueuedUiChecksPath));
  const privateAiQueuedUiBrowser = await readFile(path.join(repositoryRoot, privateAiQueuedUiBrowserPath));
  const privateAiCaddyBodyCapEvidence = await readFile(path.join(repositoryRoot,
    privateAiCaddyBodyCapEvidencePath));
  const historicalShadowTransportEvidence = await readFile(path.join(repositoryRoot,
    historicalShadowTransportEvidencePath));
  const deploymentContractEvidence = await readFile(path.join(repositoryRoot, deploymentContractEvidencePath));
  const historicalDeploymentFailureEvidence = await readFile(path.join(repositoryRoot,
    historicalDeploymentFailureEvidencePath));
  const dedicatedRendererEvidence = await readFile(path.join(repositoryRoot, dedicatedRendererEvidencePath));
  const dedicatedRendererDeclaredEvidence = execFileSync("git", ["show",
    `${acceptedDedicatedRendererCommit}:${dedicatedRendererEvidencePath}`], { cwd: repositoryRoot });
  invariant(dedicatedRendererEvidence.equals(dedicatedRendererDeclaredEvidence) &&
    sha256(dedicatedRendererDeclaredEvidence) === acceptedDedicatedRendererEvidenceSha256,
  "production_package_dedicated_renderer_declared_blob_mismatch");
  const rendererSystemd255FixEvidence = await readFile(path.join(repositoryRoot,
    rendererSystemd255FixEvidencePath));
  const rendererSystemd255FixDeclaredEvidence = execFileSync("git", ["show",
    `${acceptedRendererSystemd255FixCommit}:${rendererSystemd255FixEvidencePath}`], { cwd: repositoryRoot });
  invariant(rendererSystemd255FixEvidence.equals(rendererSystemd255FixDeclaredEvidence) &&
    sha256(rendererSystemd255FixDeclaredEvidence) === acceptedRendererSystemd255FixEvidenceSha256,
  "production_package_renderer_systemd255_fix_declared_blob_mismatch");
  const rendererSystemd255IpDenyFixEvidence = await readFile(path.join(repositoryRoot,
    rendererSystemd255IpDenyFixEvidencePath));
  const rendererSystemd255IpDenyFixDeclaredEvidence = execFileSync("git", ["show",
    `${acceptedRendererSystemd255IpDenyFixCommit}:${rendererSystemd255IpDenyFixEvidencePath}`],
  { cwd: repositoryRoot });
  invariant(rendererSystemd255IpDenyFixEvidence.equals(rendererSystemd255IpDenyFixDeclaredEvidence) &&
    sha256(rendererSystemd255IpDenyFixDeclaredEvidence) === acceptedRendererSystemd255IpDenyFixEvidenceSha256,
  "production_package_renderer_systemd255_ip_deny_fix_declared_blob_mismatch");
  const rendererDurableControlEvidence = await readFile(path.join(repositoryRoot,
    rendererDurableControlEvidencePath));
  const rendererDurableControlDeclaredEvidence = execFileSync("git", ["show",
    `${acceptedRendererDurableControlCommit}:${rendererDurableControlEvidencePath}`], { cwd: repositoryRoot });
  invariant(rendererDurableControlEvidence.equals(rendererDurableControlDeclaredEvidence) &&
    sha256(rendererDurableControlDeclaredEvidence) === acceptedRendererDurableControlEvidenceSha256,
  "production_package_renderer_durable_control_declared_blob_mismatch");
  const rendererControlTargetFailureEvidence = await readFile(path.join(repositoryRoot,
    historicalRendererControlTargetFailurePath));
  const rendererControlTargetFailureDeclaredEvidence = execFileSync("git", ["show",
    `${historicalRendererControlTargetFailureCommit}:${historicalRendererControlTargetFailurePath}`],
  { cwd: repositoryRoot });
  invariant(rendererControlTargetFailureEvidence.equals(rendererControlTargetFailureDeclaredEvidence) &&
    sha256(rendererControlTargetFailureDeclaredEvidence) === historicalRendererControlTargetFailureSha256,
  "production_package_renderer_control_target_failure_declared_blob_mismatch");
  const rendererSnapAdapterEvidence = await readFile(path.join(repositoryRoot, rendererSnapAdapterEvidencePath));
  const rendererSnapAdapterDeclaredEvidence = execFileSync("git", ["show",
    `${acceptedRendererSnapAdapterCommit}:${rendererSnapAdapterEvidencePath}`], { cwd: repositoryRoot });
  invariant(rendererSnapAdapterEvidence.equals(rendererSnapAdapterDeclaredEvidence) &&
    sha256(rendererSnapAdapterDeclaredEvidence) === acceptedRendererSnapAdapterEvidenceSha256,
  "production_package_renderer_snap_adapter_declared_blob_mismatch");
  const rendererSnapCacheEvidence = await readFile(path.join(repositoryRoot, rendererSnapCacheEvidencePath));
  const rendererSnapCacheDeclaredEvidence = execFileSync("git", ["show",
    `${acceptedRendererSnapCacheCommit}:${rendererSnapCacheEvidencePath}`], { cwd: repositoryRoot });
  invariant(rendererSnapCacheEvidence.equals(rendererSnapCacheDeclaredEvidence) &&
    sha256(rendererSnapCacheDeclaredEvidence) === acceptedRendererSnapCacheEvidenceSha256,
  "production_package_renderer_snap_cache_declared_blob_mismatch");
  const rendererSnapDanglingEvidence = await readFile(path.join(repositoryRoot, rendererSnapDanglingEvidencePath));
  const rendererSnapDanglingDeclaredEvidence = execFileSync("git", ["show",
    `${acceptedRendererSnapDanglingCommit}:${rendererSnapDanglingEvidencePath}`], { cwd: repositoryRoot });
  invariant(rendererSnapDanglingEvidence.equals(rendererSnapDanglingDeclaredEvidence) &&
    sha256(rendererSnapDanglingDeclaredEvidence) === acceptedRendererSnapDanglingEvidenceSha256,
  "production_package_renderer_snap_dangling_declared_blob_mismatch");
  const rendererSnapDanglingFailureEvidence = await readFile(path.join(repositoryRoot,
    historicalRendererSnapDanglingFailurePath));
  const rendererSnapDanglingFailureDeclaredEvidence = execFileSync("git", ["show",
    `${historicalRendererSnapDanglingFailureCommit}:${historicalRendererSnapDanglingFailurePath}`],
  { cwd: repositoryRoot });
  invariant(rendererSnapDanglingFailureEvidence.equals(rendererSnapDanglingFailureDeclaredEvidence) &&
    sha256(rendererSnapDanglingFailureDeclaredEvidence) === historicalRendererSnapDanglingFailureSha256,
  "production_package_renderer_snap_dangling_target_failure_declared_blob_mismatch");
  const rendererSnapCacheFailureEvidence = await readFile(path.join(repositoryRoot,
    historicalRendererSnapCacheFailurePath));
  const rendererSnapCacheFailureDeclaredEvidence = execFileSync("git", ["show",
    `${historicalRendererSnapCacheFailureCommit}:${historicalRendererSnapCacheFailurePath}`],
  { cwd: repositoryRoot });
  invariant(rendererSnapCacheFailureEvidence.equals(rendererSnapCacheFailureDeclaredEvidence) &&
    sha256(rendererSnapCacheFailureDeclaredEvidence) === historicalRendererSnapCacheFailureSha256,
  "production_package_renderer_snap_cache_target_failure_declared_blob_mismatch");
  const rendererRouteStaticEvidence = await readFile(path.join(repositoryRoot, rendererRouteStaticEvidencePath));
  const rendererRouteStaticDeclaredEvidence = execFileSync("git", ["show",
    `${rendererRouteStaticCommit}:${rendererRouteStaticEvidencePath}`], { cwd: repositoryRoot });
  invariant(rendererRouteStaticEvidence.equals(rendererRouteStaticDeclaredEvidence) &&
    sha256(rendererRouteStaticDeclaredEvidence) === rendererRouteStaticEvidenceSha256,
  "production_package_renderer_route_static_declared_blob_mismatch");
  const rendererRouteTargetDiagnosticEvidence = await Promise.all(rendererRouteTargetDiagnostics.map(async (entry) => {
    const bytes = await readFile(path.join(repositoryRoot, entry.path));
    const declared = execFileSync("git", ["show", `${entry.commit}:${entry.path}`], { cwd: repositoryRoot });
    invariant(bytes.equals(declared) && sha256(declared) === entry.sha256,
      "production_package_renderer_route_target_diagnostic_declared_blob_mismatch");
    return bytes;
  }));
  const temporaryAccessUiChecks = await readFile(path.join(repositoryRoot, temporaryAccessUiChecksPath));
  const temporaryAccessUiBrowser = await readFile(path.join(repositoryRoot, temporaryAccessUiBrowserPath));
  const publicCoreUiEvidence = await readFile(path.join(repositoryRoot, publicCoreUiEvidencePath));
  const chrome = JSON.parse(browserChromeEvidence);
  const firefox = JSON.parse(browserFirefoxEvidence);
  const inventoryRecord = JSON.parse(inventoryVerification);
  const actionClosureChecks = JSON.parse(uiActionClosureChecks);
  const actionClosureBrowser = JSON.parse(uiActionClosureBrowser);
  const copyActionChecks = JSON.parse(uiCopyActionChecks);
  const copyActionBrowser = JSON.parse(uiCopyActionBrowser);
  const coreStatesChecks = JSON.parse(uiCoreStatesChecks);
  const coreStatesBrowser = JSON.parse(uiCoreStatesBrowser);
  const publicFoundation = JSON.parse(publicFoundationEvidence);
  const smtp = JSON.parse(smtpEvidence);
  const offlineChecks = JSON.parse(providerOfflineChecks);
  const offlineBrowser = JSON.parse(providerOfflineBrowser);
  const workerChecks = JSON.parse(privateWorkerChecks);
  const workerRuntime = JSON.parse(privateWorkerRuntime);
  const workerLiveProof = JSON.parse(privateWorkerLiveProof);
  const privateAiQueue = JSON.parse(privateAiQueueEvidence);
  const privateAiTransport = JSON.parse(privateAiTransportEvidence);
  const privateAiRemoteLive = JSON.parse(privateAiRemoteLiveEvidence);
  const privateAiRetirement = JSON.parse(privateAiRetirementEvidence);
  const bookPrivateFacts = JSON.parse(bookPrivateFactsEvidence);
  const privateAiComposition = JSON.parse(privateAiCompositionEvidence);
  const privateAiQueuedUi = JSON.parse(privateAiQueuedUiChecks);
  const privateAiQueuedUiBrowserRecord = JSON.parse(privateAiQueuedUiBrowser);
  const privateAiCaddyBodyCap = JSON.parse(privateAiCaddyBodyCapEvidence);
  const historicalShadowTransport = JSON.parse(historicalShadowTransportEvidence);
  const deploymentContract = JSON.parse(deploymentContractEvidence);
  const historicalDeploymentFailure = JSON.parse(historicalDeploymentFailureEvidence);
  const dedicatedRenderer = JSON.parse(dedicatedRendererEvidence);
  const rendererSystemd255Fix = JSON.parse(rendererSystemd255FixEvidence);
  const rendererSystemd255IpDenyFix = JSON.parse(rendererSystemd255IpDenyFixEvidence);
  const rendererDurableControl = JSON.parse(rendererDurableControlEvidence);
  const rendererControlTargetFailure = JSON.parse(rendererControlTargetFailureEvidence);
  const rendererSnapAdapter = JSON.parse(rendererSnapAdapterEvidence);
  const rendererSnapCache = JSON.parse(rendererSnapCacheEvidence);
  const rendererSnapCacheFailure = JSON.parse(rendererSnapCacheFailureEvidence);
  const rendererSnapDangling = JSON.parse(rendererSnapDanglingEvidence);
  const rendererSnapDanglingFailure = JSON.parse(rendererSnapDanglingFailureEvidence);
  const rendererRouteStatic = JSON.parse(rendererRouteStaticEvidence);
  const rendererRouteTargetDiagnosticRecords = rendererRouteTargetDiagnosticEvidence.map((bytes) => JSON.parse(bytes));
  const temporaryAccessUi = JSON.parse(temporaryAccessUiChecks);
  const temporaryAccessUiBrowserRecord = JSON.parse(temporaryAccessUiBrowser);
  const publicCoreUi = JSON.parse(publicCoreUiEvidence);
  invariant(chrome?.claimBoundary?.productCandidate === currentRefreshTestedInputCommit &&
    chrome.claimBoundary.currentCandidateCoverage === true && chrome.claimBoundary.productionReady === false &&
    chrome.viewerDiagnostic?.formalFrozenProfileVerdict ===
      "INDETERMINATE_PROFILE_UNDERSPECIFIED_FAIL_CLOSED" &&
    firefox?.candidate?.productCommit === currentRefreshTestedInputCommit &&
    firefox.claimBoundary?.currentCandidateCoverage === true &&
    firefox.claimBoundary?.productionReady === false,
  "production_package_browser_evidence_claim_invalid");
  invariant(inventoryRecord?.candidateCommit === inventoryTestedInputCommit &&
    inventoryRecord.currentCandidateCoverage === true &&
    inventoryRecord.releaseClaim === "NO_GO" && inventoryRecord.productionReady === false &&
    inventoryRecord.inventory?.path === inventoryPath &&
    inventoryRecord.inventory.sha256 === sha256(inventory) &&
    inventoryRecord.formalReleaseSignoffsRequired?.every((entry) => entry.state === "needs_review"),
  "production_package_inventory_evidence_claim_invalid");
  invariant(actionClosureChecks?.schema === "unseen-ui-v2-action-closure-checks/1" &&
    actionClosureChecks.status === "PASS" && actionClosureChecks.codeCommit === acceptedUiActionClosureCodeCommit &&
    actionClosureChecks.fixture === true && actionClosureChecks.remainingP0?.length === 0 &&
    actionClosureChecks.remainingP1?.length === 0 &&
    actionClosureBrowser?.schema === "unseen-ui-v2-action-closure/1" &&
    actionClosureBrowser.status === "PASS" && actionClosureBrowser.commit === acceptedUiActionClosureCodeCommit &&
    actionClosureBrowser.fixture === true,
  "production_package_ui_action_closure_evidence_invalid");
  invariant(copyActionChecks?.schema === "unseen-ui-v2-copy-action-matrix-machine-checks/1" &&
    copyActionChecks.status === "PASS" && copyActionChecks.baseCandidate === acceptedUiCopyActionBaseCommit &&
    copyActionChecks.productCodeCommit === acceptedUiCopyActionCodeCommit &&
    copyActionChecks.candidateBound === true && copyActionChecks.fixtureOnly === true &&
    copyActionChecks.browser?.visibleControlsDirectlyExercised === 44 &&
    copyActionChecks.diagnostics?.externalRequests === 0 && copyActionChecks.diagnostics.externalResources === 0 &&
    copyActionBrowser?.schema === "unseen-ui-v2-copy-action-matrix/1" &&
    copyActionBrowser.status === "PASS" && copyActionBrowser.commit === acceptedUiCopyActionCodeCommit &&
    copyActionBrowser.baseCandidate === acceptedUiCopyActionBaseCommit &&
    copyActionBrowser.candidateBound === true && copyActionBrowser.fixture === true &&
    copyActionBrowser.actionMatrix?.controls?.length === 44 &&
    copyActionBrowser.actionMatrix.coreBranchBoundary?.status === "NOT_EXERCISED",
  "production_package_ui_copy_action_evidence_invalid");
  invariant(coreStatesChecks?.schema === "unseen-ui-v2-core-states-machine-checks/1" &&
    coreStatesChecks.status === "PASS" && coreStatesChecks.marker === "TEST_ONLY_FIXTURE_FAULTS" &&
    coreStatesChecks.baseCandidate === acceptedUiCoreStatesBaseCommit &&
    coreStatesChecks.testCommit === acceptedUiCoreStatesTestCommit && coreStatesChecks.testOnly === true &&
    coreStatesChecks.browser?.cases === 12 && coreStatesChecks.productBytesChanged === false &&
    coreStatesChecks.productionInput === false && coreStatesChecks.productionFaultClaim === false &&
    coreStatesBrowser?.schema === "unseen-ui-v2-core-states/1" && coreStatesBrowser.status === "PASS" &&
    coreStatesBrowser.marker === "TEST_ONLY_FIXTURE_FAULTS" && coreStatesBrowser.testOnly === true &&
    coreStatesBrowser.candidateCommit === acceptedUiCoreStatesTestCommit && coreStatesBrowser.cases?.length === 12 &&
    coreStatesBrowser.productBytesChanged === false && coreStatesBrowser.productionInput === false &&
    coreStatesBrowser.productionFaultClaim === false,
  "production_package_ui_core_states_evidence_invalid");
  invariant(publicFoundation?.schema === "unseen-private-beta-public-foundation/1" &&
    publicFoundation.kind === "TARGET_OBSERVATION_NOT_PRODUCTION_ACCEPTANCE" &&
    publicFoundation.claimBoundary?.releaseClaim === "NO_GO" &&
    publicFoundation.claimBoundary.productionReady === false &&
    publicFoundation.claimBoundary.coreOperableBeta === false &&
    publicFoundation.claimBoundary.postEvidenceCommitDeployed === false,
  "production_package_public_foundation_evidence_invalid");
  invariant(smtp?.schema === "unseen-otp-smtp-adapter-evidence/1" &&
    smtp.kind === "DEFAULT_OFF_PORTABLE_FALLBACK_NOT_DEPLOYMENT_ACCEPTANCE" &&
    smtp.input?.codeCommit === acceptedSmtpCodeCommit && smtp.implementation?.defaultEnabled === false &&
    smtp.enablement?.productionReady === false && smtp.enablement.deployableUnderCurrentPrivateBetaUnit === false,
  "production_package_smtp_evidence_invalid");
  invariant(offlineChecks?.base === acceptedQuestionCapabilityCommit && offlineChecks.productFixtureAdded === false &&
    offlineChecks.remainingP0?.length === 0 && offlineChecks.remainingP1?.length === 0 &&
    offlineBrowser?.schemaVersion === "unseen-bl01-provider-offline-browser/1" &&
    offlineBrowser.status === "PASS" && offlineBrowser.productFixtureAdded === false &&
    offlineBrowser.productionInput === false,
  "production_package_provider_offline_evidence_invalid");
  invariant(workerChecks?.base === "d3365f3e079c494a02f6dcd38fd0f30266189c97" &&
    workerChecks.productBytesChanged === false && workerChecks.productionEnabled === false &&
    workerChecks.remainingP0?.length === 0 && workerChecks.remainingP1?.length === 2 &&
    workerRuntime?.evidenceClass === "PRIVATE_TEST_PROOF" && workerRuntime.productionEnabled === false &&
    workerLiveProof?.evidenceClass === "PRIVATE_TEST_PROOF" && workerLiveProof.productionEnabled === false &&
    workerLiveProof.productionTransport === false && workerLiveProof.factsExtraction === false,
  "production_package_private_worker_evidence_invalid");
  invariant(privateAiQueue?.schema === "unseen-private-ai-queue-evidence/1" &&
    privateAiQueue.codeSha === acceptedPrivateAiQueueCodeCommit && privateAiQueue.state?.enabled === false &&
    privateAiQueue.state.deployed === false && privateAiQueue.state.releaseClaim === "NO_GO_DEFAULT_OFF" &&
    privateAiQueue.state.networkRequestsInFocusedTests === 0,
  "production_package_private_ai_queue_claim_invalid");
  invariant(privateAiTransport?.evidenceClass === "PRIVATE_BETA_TRANSPORT_IMPLEMENTATION" &&
    privateAiTransport.codeCommit === acceptedPrivateAiTransportFixCodeCommit &&
    privateAiTransport.codex?.productBoundary === "CHATGPT_SUBSCRIPTION_PRIVATE_TEST_NOT_OPENAI_API" &&
    privateAiTransport.codex.commercialSla === false &&
    privateAiTransport.externalState?.productionEnabled === false &&
    privateAiTransport.externalState.hongKongEndpointContacted === false &&
    privateAiRemoteLive?.evidenceClass === "PRIVATE_TEST_PROOF" &&
    privateAiRemoteLive.productionEnabled === false && privateAiRemoteLive.productionTransport === false &&
    privateAiRemoteLive.liveServerContacted === false && privateAiRemoteLive.resultPersisted === false &&
    privateAiRetirement?.evidenceClass === "LEGACY_TEST_ONLY_WORKER_RETIREMENT" &&
    privateAiRetirement.codeCommit === acceptedPrivateAiTransportFixCodeCommit &&
    privateAiRetirement.externalState?.deploymentChanged === false &&
    privateAiRetirement.externalState.workerEnabled === false,
  "production_package_private_ai_transport_claim_invalid");
  invariant(bookPrivateFacts?.scope === "book-private-model-visible-facts-seam" &&
    bookPrivateFacts.codeCommit === acceptedBookPrivateFactsCodeCommit && bookPrivateFacts.result === "PASS" &&
    bookPrivateFacts.publicContractDelta === false &&
    bookPrivateFacts.defaultOffUntilAuthenticatedTransport === true &&
    bookPrivateFacts.covered?.includes("no Core mutation, public fact exposure, automatic Book entry, or answer hash in audit detail"),
  "production_package_book_private_facts_claim_invalid");
  invariant(privateAiComposition?.schema === "unseen-private-ai-composition-evidence/1" &&
    privateAiComposition.codeSha === acceptedPrivateAiCompositionCodeCommit &&
    privateAiComposition.state?.enabled === false && privateAiComposition.state.deployed === false &&
    privateAiComposition.state.liveServerTouched === false &&
    privateAiComposition.state.credentialCreated === false && privateAiComposition.state.publicContractChanged === false,
  "production_package_private_ai_composition_claim_invalid");
  invariant(privateAiQueuedUi?.codeCommit === acceptedPrivateAiQueuedUiCodeCommit &&
    privateAiQueuedUi.productFixtureAdded === false && privateAiQueuedUi.productionInput === false &&
    privateAiQueuedUi.checks?.chromePrivateAiViewports?.passed === 4 &&
    privateAiQueuedUi.checks.browserDiagnosticCounts?.externalResources === 0 &&
    privateAiQueuedUiBrowserRecord?.schemaVersion === "unseen-private-ai-queued-offline-browser/1" &&
    privateAiQueuedUiBrowserRecord.status === "PASS" &&
    privateAiQueuedUiBrowserRecord.productFixtureAdded === false &&
    privateAiQueuedUiBrowserRecord.productionInput === false && privateAiQueuedUiBrowserRecord.cases?.length === 4,
  "production_package_private_ai_queued_ui_claim_invalid");
  invariant(privateAiCaddyBodyCap?.schema === "unseen-private-ai-caddy-body-cap-evidence/1" &&
    privateAiCaddyBodyCap.claim === "CODE_ONLY_NOT_DEPLOYED" &&
    privateAiCaddyBodyCap.codeCommit === acceptedPrivateAiCaddyBodyCapCodeCommit &&
    privateAiCaddyBodyCap.boundary?.exactBytesPassedToUpstream === 32768 &&
    JSON.stringify(privateAiCaddyBodyCap.boundary.oversizeBytesRejectedLocally) ===
      JSON.stringify([32769, 65536]) &&
    privateAiCaddyBodyCap.boundary.chunkedPostRejectedLocally === true &&
    privateAiCaddyBodyCap.boundary.upstreamRequestsForOversize === 0 &&
    privateAiCaddyBodyCap.boundary.oversizeStatus === 413 &&
    privateAiCaddyBodyCap.boundary.oversizeProtocolHeader === "unseen-private-ai-pull/1" &&
    privateAiCaddyBodyCap.boundary.oversizeCacheControl === "private, no-store, max-age=0" &&
    privateAiCaddyBodyCap.boundary.oversizeContentType === "application/json" &&
    privateAiCaddyBodyCap.openP0?.length === 0 && privateAiCaddyBodyCap.openP1?.length === 0,
  "production_package_private_ai_caddy_body_cap_claim_invalid");
  invariant(historicalShadowTransport?.schema === "unseen-shadow-transport-acceptance-evidence/1" &&
    historicalShadowTransport.result === "REJECTED_BEFORE_SUBSCRIPTION" &&
    historicalShadowTransport.claimBoundary?.productionReady === false &&
    historicalShadowTransport.claimBoundary.releaseClaim === "NO_GO" &&
    historicalShadowTransport.subscriptionOneShot?.started === false &&
    historicalShadowTransport.httpMatrix?.bodyLimit?.pass === false &&
    historicalShadowTransport.p1?.includes(
      "CADDY_BODY_LIMIT_IS_32000_DECIMAL_AND_RETURNS_502_OVER_LIMIT_INSTEAD_OF_REQUIRED_32768_BYTE_LIMIT_AND_413"),
  "production_package_historical_shadow_transport_claim_invalid");
  invariant(deploymentContract?.schema === "unseen-deployment-active-release-contract-evidence/1" &&
    deploymentContract.result === "PASS" &&
    deploymentContract.input?.codeCommit === acceptedDeploymentContractCodeCommit &&
    deploymentContract.claimBoundary?.productionReady === false &&
    deploymentContract.claimBoundary.targetServerTouched === false &&
    deploymentContract.claimBoundary.persistentPackageBuilt === false &&
    deploymentContract.activeReleaseContract?.unitRenderMarker === releaseMarker &&
    deploymentContract.activeReleaseContract.candidateValueMarker === candidateValueMarker &&
    deploymentContract.activeReleaseContract.renderMarkersNonOverlapping === true &&
    deploymentContract.caddyPermissionContract?.sealedBackup === "root:root:0600" &&
    deploymentContract.caddyPermissionContract.liveInstall === "root:caddy:0640" &&
    deploymentContract.caddyPermissionContract.liveRollback === "root:caddy:0640" &&
    deploymentContract.checks?.orderedMigrations === 10 &&
    deploymentContract.checks.productionOuterBasicAuthRejected === true &&
    deploymentContract.checks.productionGlobalCspRejected === true &&
    deploymentContract.checks.productionApplicationAuthAndCspBoundaryBound === true &&
    deploymentContract.checks.officialCaddyIntegration?.exactBytesPassed === 32768 &&
    deploymentContract.checks.officialCaddyIntegration.productionOuterAuth ===
      "ABSENT_APPLICATION_OWNED" &&
    deploymentContract.checks.officialCaddyIntegration.productionCookieAndBearerForwarded === true &&
    deploymentContract.checks.officialCaddyIntegration.productionUpstreamCspAndContentPreserved === true &&
    deploymentContract.resolvedCodeP1?.includes(
      "ACTIVE_RELEASE_ALIAS_STALE_AND_CAN_MISREPORT_DEPLOYED_CANDIDATE") &&
    deploymentContract.resolvedCodeP1.includes(
      "CADDY_SYSTEMD_RELOAD_PERMISSION_MISMATCH_BLOCKS_ACCEPTED_BODY_CAP_ACTIVATION"),
  "production_package_deployment_contract_claim_invalid");
  invariant(historicalDeploymentFailure?.schema === "unseen-candidate-7d2-deployment-attempt/1" &&
    historicalDeploymentFailure.result === "ROLLED_BACK_BEFORE_CADDY_ACTIVATION_AND_SHADOW" &&
    historicalDeploymentFailure.claimBoundary?.productionReady === false &&
    historicalDeploymentFailure.claimBoundary.acceptedCaddyFixActivated === false &&
    historicalDeploymentFailure.caddyAttempt?.reload === "FAIL_PERMISSION_DENIED" &&
    historicalDeploymentFailure.caddyAttempt.newConfigurationActivated === false &&
    JSON.stringify(historicalDeploymentFailure.p1) === JSON.stringify([
      "ACTIVE_RELEASE_ALIAS_STALE_AND_CAN_MISREPORT_DEPLOYED_CANDIDATE",
      "CADDY_SYSTEMD_RELOAD_PERMISSION_MISMATCH_BLOCKS_ACCEPTED_BODY_CAP_ACTIVATION"
    ]), "production_package_historical_deployment_failure_claim_invalid");
  invariant(dedicatedRenderer?.schema === "unseen-book-renderer-dedicated-service-evidence/1" &&
    dedicatedRenderer.status === "CODE_GATES_PASS_TARGET_ACCEPTANCE_REQUIRED" &&
    dedicatedRenderer.finalCodeCommit === acceptedDedicatedRendererCodeCommit &&
    dedicatedRenderer.defaultOff === true && dedicatedRenderer.liveTargetChanged === false &&
    dedicatedRenderer.openCodeP0 === 0 && dedicatedRenderer.openCodeP1 === 0 &&
    dedicatedRenderer.machineChecks?.focusedFilesystemIpcLifecycleAndTargetPins?.total === 29 &&
    dedicatedRenderer.machineChecks.focusedFilesystemIpcLifecycleAndTargetPins.passed === 29 &&
    dedicatedRenderer.machineChecks.productionPackage?.acceptanceNegativeCases === 32 &&
    dedicatedRenderer.machineChecks.targetUbuntuExecution === "NOT_RUN",
  "production_package_dedicated_renderer_claim_invalid");
  invariant(rendererSystemd255Fix?.schema === "unseen-renderer-systemd255-property-fix-evidence/1" &&
    rendererSystemd255Fix.status === "CODE_GATES_PASS_TARGET_RETRY_REQUIRED" &&
    rendererSystemd255Fix.codeCommit === acceptedRendererSystemd255FixCodeCommit &&
    rendererSystemd255Fix.fix?.onlyOmittedDefault === "EnvironmentFiles=" &&
    rendererSystemd255Fix.fix.removedNonexistentRuntimeProperty === "socket.Service" &&
    rendererSystemd255Fix.fix.unitSourceStillByteExact === true &&
    rendererSystemd255Fix.fix.socketSourceServiceDirectiveStillExact === true &&
    rendererSystemd255Fix.machineChecks?.focusedRenderer?.total === 29 &&
    rendererSystemd255Fix.machineChecks.focusedRenderer.passed === 29 &&
    rendererSystemd255Fix.machineChecks.productionPackage?.acceptanceNegativeCases === 32 &&
    rendererSystemd255Fix.defaultOff === true && rendererSystemd255Fix.liveTargetChanged === false &&
    rendererSystemd255Fix.targetCommandExecuted === false && rendererSystemd255Fix.rendererStarted === false &&
    rendererSystemd255Fix.bookEnabled === false && rendererSystemd255Fix.openCodeP0 === 0 &&
    rendererSystemd255Fix.openCodeP1 === 0,
  "production_package_renderer_systemd255_fix_claim_invalid");
  invariant(rendererSystemd255IpDenyFix?.schema === "unseen-renderer-systemd255-ip-deny-fix-evidence/1" &&
    rendererSystemd255IpDenyFix.status === "CODE_GATES_PASS_TARGET_RETRY_REQUIRED" &&
    rendererSystemd255IpDenyFix.codeCommit === acceptedRendererSystemd255IpDenyFixCodeCommit &&
    rendererSystemd255IpDenyFix.diagnosticEvidence?.mismatchCount === 1 &&
    rendererSystemd255IpDenyFix.diagnosticEvidence.property === "IPAddressDeny" &&
    rendererSystemd255IpDenyFix.diagnosticEvidence.actualSystemd255 === "0.0.0.0/0 ::/0" &&
    rendererSystemd255IpDenyFix.diagnosticEvidence.allOtherPropertiesMatched === true &&
    JSON.stringify(rendererSystemd255IpDenyFix.fix?.runtimeExactSet) ===
      JSON.stringify(["0.0.0.0/0", "::/0"]) &&
    rendererSystemd255IpDenyFix.fix.runtimeOrderIndependent === true &&
    rendererSystemd255IpDenyFix.fix.missingExtraDuplicateAliasRejected === true &&
    rendererSystemd255IpDenyFix.fix.unitTemplateChanged === false &&
    rendererSystemd255IpDenyFix.machineChecks?.focusedRenderer?.total === 29 &&
    rendererSystemd255IpDenyFix.machineChecks.focusedRenderer.passed === 29 &&
    rendererSystemd255IpDenyFix.machineChecks.productionPackage?.acceptanceNegativeCases === 32 &&
    rendererSystemd255IpDenyFix.defaultOff === true && rendererSystemd255IpDenyFix.liveTargetChanged === false &&
    rendererSystemd255IpDenyFix.rendererStartedByThisLane === false &&
    rendererSystemd255IpDenyFix.bookEnabled === false && rendererSystemd255IpDenyFix.openCodeP0 === 0 &&
    rendererSystemd255IpDenyFix.openCodeP1 === 0,
  "production_package_renderer_systemd255_ip_deny_fix_claim_invalid");
  invariant(rendererDurableControl?.schema === "unseen-book-renderer-cold-readiness-diagnostics-evidence/1" &&
    rendererDurableControl.status === "CODE_GATES_PASS_TARGET_RETEST_AND_INDEPENDENT_REVIEW_REQUIRED" &&
    rendererDurableControl.codeCommit === acceptedRendererDurableControlCodeCommit &&
    rendererDurableControl.targetFailureEvidenceCommit === historicalRendererControlTargetFailureCommit &&
    rendererDurableControl.machineChecks?.focusedDedicatedRenderer?.total === 41 &&
    rendererDurableControl.machineChecks.focusedDedicatedRenderer.passed === 41 &&
    rendererDurableControl.machineChecks.focusedDedicatedRenderer.coldReadyDelayMs === 5100 &&
    rendererDurableControl.machineChecks.focusedDedicatedRenderer.readyPreInboxCount === 0 &&
    rendererDurableControl.machineChecks.focusedDedicatedRenderer.postMarkerCancelChildSpawnCount === 0 &&
    rendererDurableControl.machineChecks.productionPackage?.acceptanceNegativeCases === 32 &&
    rendererDurableControl.bookDefaultOff === true && rendererDurableControl.liveTargetChanged === false &&
    rendererDurableControl.targetProbeRunAfterFailure === false &&
    rendererDurableControl.openCodeP0 === 0 && rendererDurableControl.openCodeP1 === 0 &&
    rendererControlTargetFailure?.schema === "unseen-target-deployment-and-renderer-evidence/1" &&
    rendererControlTargetFailure.kind ===
      "TARGET_CORE_DEPLOYMENT_PASS_RENDERER_ACCEPTANCE_REJECTED_NONSECRET_EVIDENCE" &&
    rendererControlTargetFailure.rendererTarget?.claim ===
      "NOT_DEDICATED_RENDERER_ACCEPTED_DEFAULT_OFF" &&
    rendererControlTargetFailure.rendererTarget.singleActualAttempt?.clientError ===
      "renderer_control_timeout" &&
    rendererControlTargetFailure.rendererTarget.singleActualAttempt.serviceStableError === "render_failed" &&
    rendererControlTargetFailure.rendererTarget.singleActualAttempt.durableControlAcceptanceMarkerCount === 1 &&
    JSON.stringify(rendererControlTargetFailure.openFindings?.p1) ===
      JSON.stringify(["renderer_cold_socket_activation_exceeds_production_5s_control_timeout",
        "renderer_target_render_returns_generic_render_failed_without_artifacts_or_target_diagnostic_code"]) &&
    rendererControlTargetFailure.postCleanupLiveInvariants?.activeCommit ===
      "9c0719094ccf04cfef69a0165c6a0a60485505be",
  "production_package_renderer_durable_control_claim_invalid");
  invariant(rendererSnapAdapter?.schema === "unseen-book-renderer-chromium-snap-adapter-evidence/1" &&
    rendererSnapAdapter.status === "CODE_GATES_PASS_TARGET_EXECUTION_NOT_RUN" &&
    rendererSnapAdapter.finalCodeAndTestCommit === acceptedRendererSnapAdapterCodeCommit &&
    rendererSnapAdapter.staticInput?.commit === rendererRouteStaticCommit &&
    rendererSnapAdapter.staticInput.path === rendererRouteStaticEvidencePath &&
    rendererSnapAdapter.staticInput.sha256 === rendererRouteStaticEvidenceSha256 &&
    rendererSnapAdapter.adapter?.environmentEntryCount === 14 &&
    rendererSnapAdapter.adapter.environmentInheritance === "EMPTY_ALLOWLIST_ONLY" &&
    rendererSnapAdapter.adapter.outerSandboxRequired === true &&
    rendererSnapAdapter.distribution?.treeEntryCount === 683 &&
    rendererSnapAdapter.distribution.treeManifestSha256 ===
      "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913" &&
    rendererSnapAdapter.distribution.resourceCount === 224 &&
    rendererSnapAdapter.distribution.resourceManifestSha256 ===
      "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5" &&
    rendererSnapAdapter.machineChecks?.dedicatedRenderer?.total === 43 &&
    rendererSnapAdapter.machineChecks.dedicatedRenderer.passed === 43 &&
    rendererSnapAdapter.executionBoundary?.targetUbuntuExecution === "NOT_RUN" &&
    rendererSnapAdapter.executionBoundary.bookDefaultOff === true &&
    rendererSnapAdapter.executionBoundary.productionEnabled === false &&
    JSON.stringify(rendererSnapAdapter.externalReleaseGates) === JSON.stringify([
      "CHROMIUM_ASSERTION_SIGNATURE_NOT_INDEPENDENTLY_VERIFIED",
      "CHROMIUM_LICENSE_DECLARATION_UNAPPROVED",
      "CHROMIUM_SECURITY_REVIEW_REQUIRED",
      "TARGET_SYNTHETIC_RENDER_AND_NETWORK_ACCEPTANCE_NOT_RUN"
    ]) && rendererRouteStatic?.schema ===
      "unseen-target-renderer-route1-static-adapter-policy-evidence/1" &&
    rendererRouteStatic.boundedConclusion?.status === "STATIC_ADAPTER_POLICY_INPUT_ONLY" &&
    rendererRouteStatic.boundedConclusion.adapterAccepted === false &&
    rendererRouteStatic.boundedConclusion.permitsRuntimeExecution === false &&
    rendererRouteStatic.boundedConclusion.permitsBookEnablement === false &&
    JSON.stringify(rendererRouteTargetDiagnosticRecords.map((record) => record.schema)) === JSON.stringify([
      "unseen-target-renderer-static-resource-closure-evidence/1",
      "unseen-target-renderer-s35-adaptive-evidence/1",
      "unseen-target-renderer-s3-v4-evidence/1"
    ]) && rendererRouteTargetDiagnosticRecords.every((record) =>
      JSON.stringify(record.openFindings?.p1) ===
        JSON.stringify(["renderer_target_child_nonzero_exit_candidate09f"])),
  "production_package_renderer_snap_adapter_claim_invalid");
  invariant(rendererSnapCache?.schema === "unseen-renderer-snapd-cache-hardlink-evidence/1" &&
    rendererSnapCache.status === "CODE_GATES_PASS_TARGET_RETRY_REQUIRED" &&
    rendererSnapCache.codeCommit === acceptedRendererSnapCacheCodeCommit &&
    rendererSnapCache.targetFailureInput?.commit === historicalRendererSnapCacheFailureCommit &&
    rendererSnapCache.targetFailureInput.path === historicalRendererSnapCacheFailurePath &&
    rendererSnapCache.targetFailureInput.sha256 === historicalRendererSnapCacheFailureSha256 &&
    rendererSnapCache.linkTopology?.policySha256 ===
      "49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5" &&
    JSON.stringify(rendererSnapCache.linkTopology.allowedStates) ===
      JSON.stringify(["ARCHIVE_ONLY", "ARCHIVE_AND_SNAPD_SHA3_CACHE"]) &&
    rendererSnapCache.linkTopology.cacheMutationPerformed === false &&
    rendererSnapCache.machineChecks?.dedicatedRenderer?.total === 44 &&
    rendererSnapCache.machineChecks.dedicatedRenderer.passed === 44 &&
    rendererSnapCache.executionBoundary?.targetRetry === "NOT_RUN" &&
    rendererSnapCache.executionBoundary.snapdCacheChanged === false &&
    rendererSnapCache.remainingGate === "TARGET_RENDERER_ACCEPTANCE_RETRY_REQUIRED" &&
    rendererSnapCache.releaseDecision === "NO_GO" &&
    rendererSnapCacheFailure?.candidate?.commit === "48a3841c91d0f74fa6d51c1e292a27e1d3a2aab6" &&
    rendererSnapCacheFailure.rendererTarget?.finding?.code ===
      "RENDERER_TARGET_VERIFIER_REQUIRES_NLINK1_FOR_NORMAL_SNAPD_ARCHIVE_WITH_CACHE_HARDLINK" &&
    rendererSnapCacheFailure.rendererTarget.finding.snapdCacheMutationPerformed === false &&
    rendererSnapCacheFailure.postCleanupLiveInvariants?.activeCommit ===
      "48a3841c91d0f74fa6d51c1e292a27e1d3a2aab6",
  "production_package_renderer_snap_cache_claim_invalid");
  invariant(rendererSnapDangling?.schema ===
      "unseen-renderer-snap-canonical-dangling-symlinks-fixed-review/1" &&
    rendererSnapDangling.status === "CODE_GATES_PASS_TARGET_RETRY_REQUIRED" &&
    rendererSnapDangling.codeCommit === acceptedRendererSnapDanglingCodeCommit &&
    rendererSnapDangling.supersededEvidence?.commit === historicalRendererSnapDanglingRejectedCommits[1] &&
    rendererSnapDangling.policy?.sha256 ===
      "3c3f99c6d62feffb90a873bc245930045a1e42bdc0c3b1e5c2a763208586b128" &&
    rendererSnapDangling.machineChecks?.dedicatedRenderer?.total === 45 &&
    rendererSnapDangling.machineChecks.dedicatedRenderer.passed === 45 &&
    rendererSnapDangling.executionBoundary?.targetRetry === "NOT_RUN" &&
    rendererSnapDangling.executionBoundary.snapdCacheChanged === false &&
    rendererSnapDangling.openCodeP0 === 0 && rendererSnapDangling.openCodeP1 === 0 &&
    rendererSnapDanglingFailure?.kind ===
      "TARGET_CORE_DEPLOYMENT_PASS_RENDERER_MEASUREMENT_REJECTED_NONSECRET_EVIDENCE" &&
    rendererSnapDanglingFailure.productionReady === false &&
    JSON.stringify(rendererSnapDanglingFailure.openFindings?.p1) === JSON.stringify([
      "renderer_target_tree_policy_rejects_two_unresolved_symlinks_in_the_exact_pinned_chromium_snap_revision"
    ]),
  "production_package_renderer_snap_dangling_claim_invalid");
  invariant(temporaryAccessUi?.base === acceptedPublicCoreUiCommit &&
    temporaryAccessUi.codeCommit === acceptedTemporaryAccessUiCodeCommit &&
    temporaryAccessUi.productionInput === false && temporaryAccessUi.productFixtureAdded === false &&
    temporaryAccessUi.checks?.temporaryAccessUnit?.passed === 3 &&
    temporaryAccessUi.checks.favicon?.contentType === "image/svg+xml" &&
    temporaryAccessUi.remainingP0?.length === 0 && temporaryAccessUi.remainingP1?.length === 0 &&
    temporaryAccessUiBrowserRecord?.schemaVersion === "unseen-public-core-temporary-access-browser/1" &&
    temporaryAccessUiBrowserRecord.status === "PASS" &&
    temporaryAccessUiBrowserRecord.productionInput === false &&
    temporaryAccessUiBrowserRecord.fixtureDefaultOff === true &&
    temporaryAccessUiBrowserRecord.viewports?.length === 2 &&
    temporaryAccessUiBrowserRecord.favicon?.contentType === "image/svg+xml",
  "production_package_temporary_access_ui_claim_invalid");
  invariant(publicCoreUi?.schema === "unseen-public-core-ui-target-evidence/1" &&
    publicCoreUi.result === "PASS_PUBLIC_CORE_UI_TARGET_MILESTONE_NOT_CORE_OPERABLE_BETA" &&
    publicCoreUi.claimBoundary?.candidateCommit === "45380ecd77315fcc95f3e445353f8abdc6c77603" &&
    publicCoreUi.claimBoundary.releaseClaim === "NO_GO" &&
    publicCoreUi.claimBoundary.productionReady === false &&
    publicCoreUi.claimBoundary.publicCoreUiServed === true &&
    publicCoreUi.claimBoundary.coreOperableBeta === false &&
    publicCoreUi.claimBoundary.otpEnabled === false && publicCoreUi.claimBoundary.bookEnabled === false &&
    publicCoreUi.claimBoundary.privateAiEnabled === false &&
    publicCoreUi.browserReadback?.status === "PASS_INDEPENDENT_READ_ONLY_AUDITOR",
  "production_package_public_core_ui_claim_invalid");
  function productTreeComparison(paths, testedInputCommit) {
    const entries = paths.map((relative) => {
      const testedObject = git(["rev-parse", `${testedInputCommit}:${relative}`]);
      const currentObject = git(["rev-parse", `${candidateCommit}:${relative}`]);
      return { path: relative, testedObjectId: testedObject, currentObjectId: currentObject,
        matches: currentObject === testedObject };
    });
    invariant(entries.some((entry) => !entry.matches), "production_package_stale_product_tree_expected");
    return { kind: "STALE_APPLICABLE_PRODUCT_TREE", testedInputCommit,
      currentCandidateCommit: candidateCommit, entries };
  }
  const browserCoverage = productTreeComparison(browserProductPaths, currentRefreshTestedInputCommit);
  const inventoryCoverage = productTreeComparison(inventoryProductPaths, inventoryTestedInputCommit);
  execFileSync("git", ["cat-file", "-e", `${config.inputs.bookWeb}^{commit}`],
    { cwd: repositoryRoot, stdio: "ignore" });
  const bookRefs = git(["for-each-ref", "--contains", config.inputs.bookWeb, "--format=%(refname)",
    "refs/heads", "refs/remotes"]).split("\n").filter(Boolean).sort();
  invariant(bookRefs.length > 0, "production_package_book_ref_missing");
  const parent = path.dirname(packageRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(parent, `.${path.basename(packageRoot)}.tmp-`));
  try {
    await chmod(temporary, 0o700);
    for (const [source, target] of staticFiles) {
      await cp(path.join(repositoryRoot, source), path.join(temporary, target));
      await chmod(path.join(temporary, target), 0o600);
    }
    const exactBookRef = `refs/unseen-production-package/book-${randomUUID()}`;
    execFileSync("git", ["update-ref", exactBookRef, config.inputs.bookWeb],
      { cwd: repositoryRoot, stdio: "ignore" });
    try {
      execFileSync("git", ["bundle", "create", path.join(temporary, "source.bundle"), "HEAD", exactBookRef],
        { cwd: repositoryRoot, stdio: "ignore" });
    } finally {
      execFileSync("git", ["update-ref", "-d", exactBookRef, config.inputs.bookWeb],
        { cwd: repositoryRoot, stdio: "ignore" });
    }
    await chmod(path.join(temporary, "source.bundle"), 0o600);
    const manifest = {
      schema: "unseen-production-package/1",
      createdAt: new Date().toISOString(),
      candidateCommit,
      coreProductCommit: config.inputs.coreLocal,
      bookCommit: config.inputs.bookWeb,
      node: ">=22",
      productionReady: false,
      releaseClaim: "NO_GO",
      releaseBlockers: requiredBlockers,
      acceptedEvidence: {
        uiV2: { commit: acceptedUiV2Commit, status: "ACCEPTED" },
        uiActionClosure: {
          commit: acceptedUiActionClosureCommit,
          codeCommit: acceptedUiActionClosureCodeCommit,
          status: "ACCEPTED_FIXTURE_ONLY",
          productionInput: false,
          machineChecks: { path: uiActionClosureChecksPath, sha256: sha256(uiActionClosureChecks) },
          browser: { path: uiActionClosureBrowserPath, sha256: sha256(uiActionClosureBrowser) }
        },
        uiCopyActionClosure: {
          commit: acceptedUiCopyActionCommit,
          codeCommit: acceptedUiCopyActionCodeCommit,
          baseCandidate: acceptedUiCopyActionBaseCommit,
          status: "ACCEPTED_FIXTURE_ONLY",
          productionInput: false,
          visibleControlsDirectlyExercised: 44,
          coreEmptyErrorBranches: "DETERMINISTIC_FIXTURE_BROWSER_EVIDENCE",
          machineChecks: { path: uiCopyActionChecksPath, sha256: sha256(uiCopyActionChecks) },
          browser: { path: uiCopyActionBrowserPath, sha256: sha256(uiCopyActionBrowser) }
        },
        uiCoreStates: {
          commit: acceptedUiCoreStatesCommit,
          testCommit: acceptedUiCoreStatesTestCommit,
          baseCandidate: acceptedUiCoreStatesBaseCommit,
          status: "ACCEPTED_TEST_ONLY_FIXTURE_EVIDENCE",
          marker: "TEST_ONLY_FIXTURE_FAULTS",
          testOnlyCases: 12,
          productionFaultCoverage: false,
          productionInput: false,
          productBytesChanged: false,
          machineChecks: { path: uiCoreStatesChecksPath, sha256: sha256(uiCoreStatesChecks) },
          browser: { path: uiCoreStatesBrowserPath, sha256: sha256(uiCoreStatesBrowser) }
        },
        publicFoundation: {
          commit: acceptedPublicFoundationCommit,
          status: "ACCEPTED_TARGET_OBSERVATION",
          productionInput: false,
          evidence: { path: publicFoundationEvidencePath, sha256: sha256(publicFoundationEvidence) }
        },
        smtpOtp: {
          commit: acceptedSmtpCommit,
          codeCommit: acceptedSmtpCodeCommit,
          status: "ACCEPTED_DEFAULT_OFF",
          defaultEnabled: false,
          deployableUnderCurrentPrivateBetaUnit: false,
          evidence: { path: smtpEvidencePath, sha256: sha256(smtpEvidence) }
        },
        questionProviderOffline: {
          commit: acceptedProviderOfflineCommit,
          capabilityCommit: acceptedQuestionCapabilityCommit,
          uiCommit: acceptedQuestionOfflineUiCommit,
          status: "ACCEPTED",
          productFixtureAdded: false,
          browserEvidenceProductionInput: false,
          machineChecks: { path: providerOfflineChecksPath, sha256: sha256(providerOfflineChecks) },
          browser: { path: providerOfflineBrowserPath, sha256: sha256(providerOfflineBrowser) }
        },
        macCodexPrivateWorker: {
          commit: acceptedPrivateWorkerCommit,
          codeCommit: acceptedPrivateWorkerCodeCommit,
          evidenceClass: "PRIVATE_TEST_PROOF",
          productionEnabled: false,
          productionTransport: false,
          factsExtraction: false,
          productionInput: false,
          machineChecks: { path: privateWorkerChecksPath, sha256: sha256(privateWorkerChecks) },
          runtimeBinding: { path: privateWorkerRuntimePath, sha256: sha256(privateWorkerRuntime) },
          liveProof: { path: privateWorkerLiveProofPath, sha256: sha256(privateWorkerLiveProof) }
        },
        privateAiQueue: {
          commit: acceptedPrivateAiQueueCommit,
          codeCommit: acceptedPrivateAiQueueCodeCommit,
          status: "ACCEPTED_DEFAULT_OFF",
          productionEnabled: false,
          productionTransport: false,
          evidence: { path: privateAiQueueEvidencePath, sha256: sha256(privateAiQueueEvidence) }
        },
        privateAiTransport: {
          commit: acceptedPrivateAiTransportCommit,
          codeCommit: acceptedPrivateAiTransportCodeCommit,
          fixCommit: acceptedPrivateAiTransportFixCommit,
          fixCodeCommit: acceptedPrivateAiTransportFixCodeCommit,
          status: "ACCEPTED_DEFAULT_OFF_NOT_DEPLOYED",
          evidenceClass: "PRIVATE_BETA_TRANSPORT_IMPLEMENTATION",
          liveProofClass: "PRIVATE_TEST_PROOF",
          subscriptionBoundary: "CHATGPT_SUBSCRIPTION_PRIVATE_TEST_NOT_OPENAI_API",
          commercialSla: false,
          productionEnabled: false,
          productionTransport: false,
          factsExtraction: false,
          productionInput: false,
          transport: { path: privateAiTransportEvidencePath, sha256: sha256(privateAiTransportEvidence) },
          liveProof: { path: privateAiRemoteLiveEvidencePath, sha256: sha256(privateAiRemoteLiveEvidence) },
          retirement: { path: privateAiRetirementEvidencePath, sha256: sha256(privateAiRetirementEvidence) }
        },
        bookPrivateFacts: {
          commit: acceptedBookPrivateFactsCommit,
          codeCommit: acceptedBookPrivateFactsCodeCommit,
          status: "ACCEPTED_PRIVATE_BOOK_FACTS",
          defaultOff: true,
          coreMutation: false,
          publicFacts: false,
          autoBook: false,
          productionInput: false,
          evidence: { path: bookPrivateFactsEvidencePath, sha256: sha256(bookPrivateFactsEvidence) }
        },
        privateAiComposition: {
          commit: acceptedPrivateAiCompositionCommit,
          codeCommit: acceptedPrivateAiCompositionCodeCommit,
          status: "ACCEPTED_DEFAULT_OFF",
          productionEnabled: false,
          productionTransport: false,
          credentialCreated: false,
          productionInput: false,
          evidence: { path: privateAiCompositionEvidencePath, sha256: sha256(privateAiCompositionEvidence) }
        },
        privateAiQueuedUi: {
          commit: acceptedPrivateAiQueuedUiCommit,
          codeCommit: acceptedPrivateAiQueuedUiCodeCommit,
          status: "ACCEPTED_DETERMINISTIC_BROWSER_EVIDENCE",
          productionInput: false,
          productFixtureAdded: false,
          browserCases: 4,
          machineChecks: { path: privateAiQueuedUiChecksPath, sha256: sha256(privateAiQueuedUiChecks) },
          browser: { path: privateAiQueuedUiBrowserPath, sha256: sha256(privateAiQueuedUiBrowser) }
        },
        privateAiCaddyBodyCap: {
          commit: acceptedPrivateAiCaddyBodyCapCommit,
          codeCommit: acceptedPrivateAiCaddyBodyCapCodeCommit,
          status: "ACCEPTED_CODE_ONLY_NOT_DEPLOYED",
          productionDeployed: false,
          productionInput: false,
          exactRequestBytes: 32768,
          missingContentLengthOrChunkedStatus: 413,
          oversizeStatus: 413,
          protocolHeader: "unseen-private-ai-pull/1",
          cacheControl: "private, no-store, max-age=0",
          contentType: "application/json",
          upstreamRequestsForRejectedBodies: 0,
          evidence: { path: privateAiCaddyBodyCapEvidencePath, sha256: sha256(privateAiCaddyBodyCapEvidence) },
          historicalRejectedCommit: historicalShadowTransportCommit,
          historicalRejectedStatus: "HISTORICAL_REJECTED_SUPERSEDED_BY_ACCEPTED_CODE_FIX",
          historicalRejectedEvidence: {
            path: historicalShadowTransportEvidencePath,
            sha256: sha256(historicalShadowTransportEvidence)
          }
        },
        deploymentContract: {
          commit: acceptedDeploymentContractCommit,
          codeCommit: acceptedDeploymentContractCodeCommit,
          status: "ACCEPTED_CODE_ONLY_NOT_DEPLOYED",
          acceptedChain: "ALREADY_LINEAR_ON_STAGE5",
          productionDeployed: false,
          productionInput: false,
          activeAuthority: "LOADED_UNIT_PROCESS_CWD_DETACHED_HEAD_TREE_CLEAN",
          unitRenderMarker: releaseMarker,
          candidateValueMarker,
          renderMarkersNonOverlapping: true,
          caddyPermissions: {
            sealedBackup: "root:root:0600",
            liveInstall: "root:caddy:0640",
            liveRollback: "root:caddy:0640"
          },
          orderedMigrations: 10,
          productionCaddy: {
            outerAuth: "ABSENT_APPLICATION_OWNED",
            globalCsp: "ABSENT_APPLICATION_OWNED",
            cookieAndBearerForwarded: true,
            upstreamCspAndContentPreserved: true,
            acceptedBodyCapCommit: acceptedPrivateAiCaddyBodyCapCommit
          },
          evidence: { path: deploymentContractEvidencePath, sha256: sha256(deploymentContractEvidence) },
          historicalRejectedEvidenceCommits: [historicalRejectedActiveReleaseEvidenceCommit,
            historicalRejectedPortableReleaseEvidenceCommit],
          historicalRejectedStatus: "HISTORICAL_REJECTED_SUPERSEDED",
          historicalDeploymentFailure: {
            commit: historicalDeploymentFailureCommit,
            status: "HISTORICAL_ROLLED_BACK_P1_FIXED_CODE_ONLY_NOT_DEPLOYED",
            productionDeployed: false,
            fixedP1: ["ACTIVE_RELEASE_ALIAS_STALE_AND_CAN_MISREPORT_DEPLOYED_CANDIDATE",
              "CADDY_SYSTEMD_RELOAD_PERMISSION_MISMATCH_BLOCKS_ACCEPTED_BODY_CAP_ACTIVATION"],
            evidence: {
              path: historicalDeploymentFailureEvidencePath,
              sha256: sha256(historicalDeploymentFailureEvidence)
            }
          }
        },
        dedicatedRenderer: {
          commit: acceptedDedicatedRendererCommit,
          codeCommit: acceptedDedicatedRendererCodeCommit,
          status: "CODE_GATES_PASS_TARGET_ACCEPTANCE_REQUIRED",
          defaultOff: true,
          productionEnabled: false,
          targetAcceptance: "REQUIRED_NOT_INCLUDED",
          focusedCases: 29,
          evidence: { path: dedicatedRendererEvidencePath, sha256: sha256(dedicatedRendererEvidence) }
        },
        rendererSystemd255Fix: {
          commit: acceptedRendererSystemd255FixCommit,
          codeCommit: acceptedRendererSystemd255FixCodeCommit,
          status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
          defaultOff: true,
          targetRetryRequired: true,
          focusedCases: 29,
          evidence: { path: rendererSystemd255FixEvidencePath, sha256: sha256(rendererSystemd255FixEvidence) }
        },
        rendererSystemd255IpDenyFix: {
          commit: acceptedRendererSystemd255IpDenyFixCommit,
          evidenceCommit: acceptedRendererSystemd255IpDenyFixEvidenceCommit,
          codeCommit: acceptedRendererSystemd255IpDenyFixCodeCommit,
          status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
          defaultOff: true,
          targetRetryRequired: true,
          focusedCases: 29,
          evidence: {
            path: rendererSystemd255IpDenyFixEvidencePath,
            sha256: sha256(rendererSystemd255IpDenyFixEvidence)
          }
        },
        rendererDurableControl: {
          commit: acceptedRendererDurableControlCommit,
          codeCommit: acceptedRendererDurableControlCodeCommit,
          status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
          defaultOff: true,
          targetRetryRequired: true,
          focusedCases: 41,
          evidence: {
            path: rendererDurableControlEvidencePath,
            sha256: sha256(rendererDurableControlEvidence)
          },
          historicalTargetFailure: {
            commit: historicalRendererControlTargetFailureCommit,
            status: "HISTORICAL_TARGET_REJECTED_SUPERSEDED_BY_ACCEPTED_COLD_READINESS_FIX",
            evidence: {
              path: historicalRendererControlTargetFailurePath,
              sha256: sha256(rendererControlTargetFailureEvidence)
            }
          }
        },
        rendererSnapAdapter: {
          commit: acceptedRendererSnapAdapterCommit,
          codeCommit: acceptedRendererSnapAdapterCodeCommit,
          status: "CODE_GATES_PASS_TARGET_EXECUTION_NOT_RUN",
          defaultOff: true,
          targetAcceptanceRequired: true,
          environmentEntryCount: 14,
          treeManifestSha256: "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913",
          resourceManifestSha256: "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5",
          canonicalDanglingSymlinkPolicySha256:
            "3c3f99c6d62feffb90a873bc245930045a1e42bdc0c3b1e5c2a763208586b128",
          runtimeReachability: "ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE",
          canonicalDanglingSymlinkFix: {
            commit: acceptedRendererSnapDanglingCommit,
            codeCommit: acceptedRendererSnapDanglingCodeCommit,
            status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
            defaultOff: true,
            targetRetryRequired: true,
            focusedCases: 45,
            evidence: { path: rendererSnapDanglingEvidencePath, sha256: sha256(rendererSnapDanglingEvidence) },
            historicalRejectedCommits: historicalRendererSnapDanglingRejectedCommits,
            historicalTargetFailure: {
              commit: historicalRendererSnapDanglingFailureCommit,
              status: "HISTORICAL_TARGET_REJECTED_SUPERSEDED_BY_ACCEPTED_CANONICAL_DANGLING_SYMLINK_FIX",
              evidence: {
                path: historicalRendererSnapDanglingFailurePath,
                sha256: sha256(rendererSnapDanglingFailureEvidence)
              }
            }
          },
          archiveLinkPolicySha256: "49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5",
          archiveLinkStates: ["ARCHIVE_ONLY", "ARCHIVE_AND_SNAPD_SHA3_CACHE"],
          evidence: {
            path: rendererSnapAdapterEvidencePath,
            sha256: sha256(rendererSnapAdapterEvidence)
          },
          staticInput: {
            commit: rendererRouteStaticCommit,
            path: rendererRouteStaticEvidencePath,
            sha256: sha256(rendererRouteStaticEvidence)
          },
          targetDiagnostics: rendererRouteTargetDiagnostics,
          externalReleaseGates: rendererSnapAdapter.externalReleaseGates
        },
        rendererSnapCacheHardlink: {
          commit: acceptedRendererSnapCacheCommit,
          codeCommit: acceptedRendererSnapCacheCodeCommit,
          status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
          defaultOff: true,
          targetRetryRequired: true,
          focusedCases: 44,
          cacheMutationPerformed: false,
          evidence: { path: rendererSnapCacheEvidencePath, sha256: sha256(rendererSnapCacheEvidence) },
          historicalTargetFailure: {
            commit: historicalRendererSnapCacheFailureCommit,
            status: "HISTORICAL_TARGET_REJECTED_SUPERSEDED_BY_ACCEPTED_NLINK_POLICY_FIX",
            evidence: {
              path: historicalRendererSnapCacheFailurePath,
              sha256: sha256(rendererSnapCacheFailureEvidence)
            }
          }
        },
        temporaryAccessUi: {
          commit: acceptedTemporaryAccessUiCommit,
          codeCommit: acceptedTemporaryAccessUiCodeCommit,
          status: "ACCEPTED_TEMPORARY_ACCESS_DISCLOSURE",
          productionInput: false,
          temporaryAccessBanner: true,
          faviconAsset: true,
          machineChecks: { path: temporaryAccessUiChecksPath, sha256: sha256(temporaryAccessUiChecks) },
          browser: { path: temporaryAccessUiBrowserPath, sha256: sha256(temporaryAccessUiBrowser) }
        },
        publicCoreUi: {
          commit: acceptedPublicCoreUiCommit,
          status: "PASS_PUBLIC_CORE_UI_TARGET_MILESTONE_NOT_CORE_OPERABLE_BETA",
          observedCandidateCommit: "45380ecd77315fcc95f3e445353f8abdc6c77603",
          finalCandidateDeployed: false,
          publicCoreUiServed: true,
          otpEnabled: false,
          bookEnabled: false,
          privateAiEnabled: false,
          evidence: { path: publicCoreUiEvidencePath, sha256: sha256(publicCoreUiEvidence) }
        },
        browserA11y: {
          commit: acceptedBrowserA11yCommit,
          testedInputCommit: currentRefreshTestedInputCommit,
          browserExecutedCandidateCommit: currentRefreshTestedInputCommit,
          postEvidenceCandidateBrowserExecuted: false,
          currentCandidateCoverage: false,
          coverageScope: "STALE_APPLICABLE_PRODUCT_TREE",
          coverageOfProductTree: browserCoverage,
          formalPerformanceVerdict: "INDETERMINATE_PROFILE_UNDERSPECIFIED_FAIL_CLOSED",
          releaseBoundary: "NAMED_MACOS_PATHS_ONLY_NEEDS_REVIEW",
          checksumManifest: { path: browserEvidencePath, sha256: sha256(browserChecksums) },
          chrome: { path: browserChromeEvidencePath, sha256: sha256(browserChromeEvidence) },
          firefox: { path: browserFirefoxEvidencePath, sha256: sha256(browserFirefoxEvidence) }
        },
        inventory: {
          commit: acceptedInventoryCommit,
          testedInputCommit: inventoryTestedInputCommit,
          inventoryGeneratedCandidateCommit: inventoryTestedInputCommit,
          fullRepositoryCandidateCoverage: false,
          currentCandidateCoverage: false,
          coverageScope: "STALE_APPLICABLE_PRODUCT_TREE",
          coverageOfProductTree: inventoryCoverage,
          reviewState: "needs_review",
          verification: { path: inventoryVerificationPath, sha256: sha256(inventoryVerification) },
          inventory: { path: inventoryPath, sha256: sha256(inventory) }
        }
      },
      profiles: {
        staging: {
          id: "local_staging_fixture",
          coreProductCommit: config.inputs.coreLocal,
          bookFixtureCommit: config.inputs.bookWeb,
          featureFlagBookLab: false,
          fixtureOnly: true,
          productionInput: false
        },
        production: {
          id: "integrated_book_lab_8c",
          integrated8CCommit: accepted8CCommit,
          featureFlagDefault: false,
          fixtureFallback: false,
          smtpOtpDefaultEnabled: false,
          smtpOtpDeployableUnderCurrentPrivateBetaUnit: false,
          questionProviderCapabilityExposed: true,
          questionProviderConfigured: false,
          visibleFactsApproved: false,
          factsProviderAcceptanceEnabled: false,
          factsProviderAcceptanceSchema: acceptanceSchema,
          macCodexPrivateWorkerEvidenceClass: "PRIVATE_TEST_PROOF",
          macCodexPrivateWorkerProductionTransport: false,
          macCodexPrivateWorkerFactsExtraction: false,
          privateAiQueueDefaultEnabled: false,
          privateAiCompositionDefaultEnabled: false,
          privateAiTransportDeployed: false,
          privateAiCaddyBodyCapBytes: 32768,
          privateAiCaddyBodyCapStatus: "ACCEPTED_CODE_ONLY_NOT_DEPLOYED",
          deploymentContractStatus: "ACCEPTED_CODE_ONLY_NOT_DEPLOYED",
          activeReleaseAuthority: "LOADED_UNIT_PROCESS_CWD_DETACHED_HEAD_TREE_CLEAN",
          caddyPermissionContract: "SEALED_0600_LIVE_AND_ROLLBACK_0640",
          orderedMigrations: 10,
          productionCaddyApplicationAuthAndCsp: true,
          bookPrivateFactsBoundary: "BOOK_PRIVATE_NOT_CORE_PUBLIC_OR_AUTO_BOOK",
          privateAiQueuedUiEvidence: "DETERMINISTIC_BROWSER_EVIDENCE_NOT_PRODUCTION_INPUT",
          decoderRuntimeAuthenticity: "HASH_BOUND_TARGET_ACCEPTANCE_REQUIRED",
          rendererDedicatedService: "unseen-book-renderer-dedicated-service/v1",
          rendererDedicatedServiceDefaultEnabled: false,
          rendererNetworkNamespace: "SYSTEMD_PRIVATE_NETWORK",
          rendererIpc: "FILESYSTEM_AF_UNIX_AND_PRIVATE_SPOOL",
          rendererTargetAcceptance: "REQUIRED_NOT_INCLUDED",
          rendererBrowserAdapter: "candidate-owned-fixed-headless-snap-3507/v1",
          rendererBrowserDistributionEmbedded: false,
          rendererBrowserReleaseDecision: "NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED",
          rendererBrowserAdapterAcceptedCommit: acceptedRendererSnapAdapterCommit,
          rendererBrowserAdapterFocusedCases: 43,
          rendererBrowserAdapterEnvironmentEntryCount: 14,
          rendererBrowserTreeManifestSha256:
            "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913",
          rendererBrowserResourceManifestSha256:
            "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5",
          rendererCanonicalDanglingSymlinkAcceptedCommit: acceptedRendererSnapDanglingCommit,
          rendererCanonicalDanglingSymlinkFocusedCases: 45,
          rendererSnapCacheHardlinkAcceptedCommit: acceptedRendererSnapCacheCommit,
          rendererSnapCacheHardlinkFocusedCases: 44,
          dedicatedRendererAcceptedCommit: acceptedDedicatedRendererCommit,
          rendererSystemd255FixAcceptedCommit: acceptedRendererSystemd255FixCommit,
          rendererSystemd255IpDenyFixAcceptedCommit: acceptedRendererSystemd255IpDenyFixCommit,
          rendererDurableControlAcceptedCommit: acceptedRendererDurableControlCommit,
          temporaryAccessUiAcceptedCommit: acceptedTemporaryAccessUiCommit,
          publicCoreUiEvidenceCommit: acceptedPublicCoreUiCommit,
          publicCoreUiObservedCandidateCommit: "45380ecd77315fcc95f3e445353f8abdc6c77603",
          publicCoreUiFinalCandidateDeployed: false,
          rendererProfile: "production",
          lifecycleEntrypoint: "infra/integration/book-lab/deployment-entrypoint.mjs",
          evidence: { path: integrated8CEvidencePath, sha256: sha256(integrated8CEvidence) }
        }
      },
      migrations: await migrations(),
      artifacts: await Promise.all(artifactNames.map((relative) => fileRecord(temporary, relative)))
    };
    await writeFile(path.join(temporary, "PACKAGE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 });
    const verified = await verifyPackage(temporary);
    await rename(temporary, packageRoot);
    process.stdout.write(`${JSON.stringify({ status: "PRODUCTION_PACKAGE_CREATED", packageRoot,
      candidateCommit: verified.candidateCommit, releaseClaim: verified.releaseClaim })}\n`);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

const productionEnvKeys = new Set([
  "UNSEEN_API_DB", "UNSEEN_API_HOST", "UNSEEN_API_KEYSET", "UNSEEN_API_MEDIA_ROOT", "UNSEEN_API_PORT",
  "UNSEEN_BACKUP_RETENTION_DAYS", "UNSEEN_BACKUP_TARGET", "UNSEEN_BOOK_LAB_COLLECTION_NOTICE_COPY",
  "UNSEEN_BOOK_LAB_COLLECTION_NOTICE_HASH", "UNSEEN_BOOK_LAB_COLLECTION_NOTICE_VERSION", "UNSEEN_BOOK_LAB_DB",
  "UNSEEN_BOOK_LAB_ENABLED", "UNSEEN_BOOK_LAB_GRANT_NOTICE_HASH", "UNSEEN_BOOK_LAB_GRANT_NOTICE_VERSION",
  "UNSEEN_BOOK_LAB_LOCK", "UNSEEN_BOOK_LAB_RENDER_TIMEOUT_MS", "UNSEEN_BOOK_LAB_RENDER_TMP",
  "UNSEEN_BOOK_OUTPUT_DIR", "UNSEEN_BOOK_RENDERER_ACCEPTANCE_FILE", "UNSEEN_BOOK_RENDERER_ACCEPTANCE_SHA256",
  "UNSEEN_BOOK_RENDERER_SOCKET", "UNSEEN_BOOK_RENDERER_SPOOL", "UNSEEN_BOOK_RENDERER_TRANSPORT",
  "UNSEEN_BOOK_WORKTREE", "UNSEEN_CHROMIUM_PATH", "UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_FILE",
  "UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_SHA256", "UNSEEN_CORE_FACTS_PROVIDER_ENABLED", "UNSEEN_DEPLOYMENT_ID",
  "UNSEEN_FFMPEG_PATH", "UNSEEN_FFMPEG_SHA256", "UNSEEN_FFPROBE_PATH", "UNSEEN_FFPROBE_SHA256",
  "UNSEEN_INTEGRATED_8C_COMMIT", "UNSEEN_LEGAL_PRIVACY_APPROVAL_FILE",
  "UNSEEN_LEGAL_PRIVACY_APPROVAL_SHA256", "UNSEEN_LOCATOR_PROVIDER_SECRET_FILE",
  "UNSEEN_MEDIA_PROVIDER_SECRET_FILE", "UNSEEN_ONCALL_OWNER", "UNSEEN_OTP_DELIVERY_PROVIDER",
  "UNSEEN_OTP_PROVIDER_SECRET_FILE", "UNSEEN_PRODUCTION_CANDIDATE_COMMIT", "UNSEEN_PRODUCTION_PROFILE",
  "UNSEEN_PUBLIC_ORIGIN", "UNSEEN_STAGING_BACKUP_DIR", "UNSEEN_STAGING_BOOK_PROVIDER",
  "UNSEEN_STAGING_DATA_DIR", "UNSEEN_STAGING_EXPECT_REPOSITORY_STATE",
  "UNSEEN_STAGING_EXTERNAL_EXPOSURE_ACK", "UNSEEN_STAGING_HOST", "UNSEEN_STAGING_LOCATOR_PROVIDER",
  "UNSEEN_STAGING_MEDIA_PROVIDER", "UNSEEN_STAGING_MODE", "UNSEEN_STAGING_OTP_PROVIDER",
  "UNSEEN_STAGING_PORT", "UNSEEN_STAGING_PUBLIC_ORIGIN", "UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR",
  "UNSEEN_TRACK1B_ACCEPTANCE_FILE", "UNSEEN_TRACK3B_ACCEPTANCE_FILE", "UNSEEN_SMTP_HOST", "UNSEEN_SMTP_PORT",
  "UNSEEN_SMTP_SECURITY", "UNSEEN_SMTP_USERNAME", "UNSEEN_SMTP_FROM", "UNSEEN_SMTP_CONNECT_TIMEOUT_MS",
  "UNSEEN_SMTP_SEND_TIMEOUT_MS", "UNSEEN_SMTP_TOTAL_TIMEOUT_MS"
]);

function parseEnv(bytes) {
  const values = {};
  for (const raw of bytes.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    invariant(raw === line && !/[\u0000-\u001f\u007f]/u.test(raw),
      "production_preflight_env_control_invalid");
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    invariant(match, "production_preflight_env_syntax_invalid");
    invariant(!/(?:^|_)(?:API_KEY|PASSWORD|SECRET|TOKEN)$/u.test(match[1]),
      `production_preflight_inline_secret_forbidden:${match[1]}`);
    invariant(productionEnvKeys.has(match[1]), `production_preflight_env_unknown:${match[1]}`);
    invariant(!(match[1] in values), `production_preflight_env_duplicate:${match[1]}`);
    values[match[1]] = match[2];
  }
  return values;
}

async function loadProductionEnv(filename) {
  const expectedUid = process.geteuid?.();
  const expectedGid = process.getegid?.();
  const before = await lstat(filename);
  const mode = before.mode & 0o777;
  const selfOwnedTestFile = before.uid === expectedUid && before.gid === expectedGid && mode === 0o600;
  const targetServiceFile = before.uid === 0 && before.gid === expectedGid && mode === 0o640;
  invariant(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 &&
    before.size <= 131_072 && (selfOwnedTestFile || targetServiceFile),
  "production_preflight_env_file_permissions_invalid");
  const handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    invariant(current.dev === before.dev && current.ino === before.ino && current.uid === before.uid &&
      current.gid === before.gid && current.nlink === 1 && current.mode === before.mode &&
      current.size === before.size, "production_preflight_env_file_changed");
    return parseEnv(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

const acceptanceSchema = "unseen-core-facts-question-provider-acceptance/1";
const commitPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const placeholderPattern = /(REQUIRED_|PLACEHOLDER|CHANGEME|\bTODO\b|\bTBD\b)/iu;

function exactObject(value, keys, code) {
  invariant(value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), code);
}

function strictString(value, code, pattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u) {
  invariant(typeof value === "string" && value === value.trim() && pattern.test(value) &&
    !placeholderPattern.test(value), code);
}

function strictSha256(value, code) {
  invariant(typeof value === "string" && sha256Pattern.test(value), code);
}

function strictCommit(value, code) {
  invariant(typeof value === "string" && commitPattern.test(value), code);
}

function strictTimestamp(value, code) {
  invariant(typeof value === "string" && !placeholderPattern.test(value), code);
  const timestamp = Date.parse(value);
  invariant(Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value, code);
  return timestamp;
}

function rejectPlaceholders(value) {
  if (typeof value === "string") invariant(!placeholderPattern.test(value), "production_preflight_acceptance_placeholder");
  if (Array.isArray(value)) value.forEach(rejectPlaceholders);
  else if (value && typeof value === "object") Object.values(value).forEach(rejectPlaceholders);
}

function validateVisibleFacts(value) {
  exactObject(value, ["schemaId", "photoId", "contentHash", "placementSnapshotHash", "factsHash", "policyHash",
    "approvalVersion", "currentness", "revokedAt"], "production_preflight_acceptance_visible_facts_invalid");
  invariant(value.schemaId === "unseen-visible-facts/1", "production_preflight_acceptance_visible_facts_schema_invalid");
  strictString(value.photoId, "production_preflight_acceptance_photo_invalid");
  strictSha256(value.contentHash, "production_preflight_acceptance_content_hash_invalid");
  strictSha256(value.placementSnapshotHash, "production_preflight_acceptance_placement_hash_invalid");
  strictSha256(value.factsHash, "production_preflight_acceptance_facts_hash_invalid");
  strictSha256(value.policyHash, "production_preflight_acceptance_facts_policy_hash_invalid");
  strictString(value.approvalVersion, "production_preflight_acceptance_approval_version_invalid");
  invariant(value.currentness === "current" && value.revokedAt === null,
    "production_preflight_acceptance_currentness_invalid");
}

function validateProvider(value) {
  exactObject(value, ["adapterProtocolId", "endpoint", "region", "modelVersion", "promptHash", "policyHash",
    "timeoutMs", "requestMaxBytes", "responseMaxBytes", "tlsMinimum", "redirectPolicy", "dnsPolicy",
    "egressPolicy", "secretFile"], "production_preflight_acceptance_provider_invalid");
  strictString(value.adapterProtocolId, "production_preflight_acceptance_adapter_protocol_invalid");
  strictString(value.region, "production_preflight_acceptance_region_invalid");
  strictString(value.modelVersion, "production_preflight_acceptance_model_version_invalid");
  strictSha256(value.promptHash, "production_preflight_acceptance_prompt_hash_invalid");
  strictSha256(value.policyHash, "production_preflight_acceptance_provider_policy_hash_invalid");
  for (const [name, maximum] of [["timeoutMs", 120_000], ["requestMaxBytes", 1_048_576],
    ["responseMaxBytes", 1_048_576]]) {
    invariant(Number.isSafeInteger(value[name]) && value[name] > 0 && value[name] <= maximum,
      `production_preflight_acceptance_${name}_invalid`);
  }
  invariant(value.tlsMinimum === "TLSv1.3", "production_preflight_acceptance_tls_invalid");
  invariant(value.redirectPolicy === "deny", "production_preflight_acceptance_redirect_invalid");
  invariant(value.dnsPolicy === "public_dns_only", "production_preflight_acceptance_dns_invalid");
  invariant(value.egressPolicy === "exact_https_endpoint_only", "production_preflight_acceptance_egress_invalid");
  invariant(typeof value.endpoint === "string" && value.endpoint === value.endpoint.trim() &&
    !placeholderPattern.test(value.endpoint),
    "production_preflight_acceptance_endpoint_invalid");
  const endpoint = new URL(value.endpoint);
  const hostname = endpoint.hostname.toLowerCase();
  invariant(endpoint.protocol === "https:" && (!endpoint.port || endpoint.port === "443") &&
    endpoint.pathname === "/" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
  "production_preflight_acceptance_endpoint_invalid");
  invariant(hostname.includes(".") && hostname !== "localhost" && !hostname.endsWith(".localhost") &&
    !hostname.endsWith(".local") && !hostname.includes(":") && !/^\d+\.\d+\.\d+\.\d+$/u.test(hostname),
  "production_preflight_acceptance_endpoint_public_dns_required");
  invariant(typeof value.secretFile === "string" && path.isAbsolute(value.secretFile) &&
    !placeholderPattern.test(value.secretFile), "production_preflight_acceptance_secret_path_invalid");
}

async function privateAcceptanceFile(filename, code) {
  const info = await lstat(filename);
  invariant(info.isFile() && !info.isSymbolicLink() && [0o400, 0o600].includes(info.mode & 0o777), code);
  return info;
}

async function expectedCandidateCommit() {
  const packagedManifest = path.join(path.dirname(scriptPath), "PACKAGE-MANIFEST.json");
  if (await exists(packagedManifest)) {
    const manifest = JSON.parse(await readFile(packagedManifest, "utf8"));
    strictCommit(manifest?.candidateCommit, "production_preflight_acceptance_package_candidate_invalid");
    return manifest.candidateCommit;
  }
  return git(["rev-parse", "HEAD"]);
}

async function validateFactsProviderAcceptance(values) {
  invariant(!placeholderPattern.test(values.UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_FILE) &&
    !placeholderPattern.test(values.UNSEEN_LEGAL_PRIVACY_APPROVAL_FILE),
  "production_preflight_acceptance_placeholder");
  strictCommit(values.UNSEEN_PRODUCTION_CANDIDATE_COMMIT,
    "production_preflight_acceptance_expected_candidate_invalid");
  strictSha256(values.UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_SHA256,
    "production_preflight_acceptance_expected_hash_invalid");
  strictSha256(values.UNSEEN_LEGAL_PRIVACY_APPROVAL_SHA256,
    "production_preflight_acceptance_legal_hash_invalid");
  invariant(values.UNSEEN_PRODUCTION_CANDIDATE_COMMIT === await expectedCandidateCommit(),
    "production_preflight_acceptance_package_candidate_mismatch");
  const receiptInfo = await privateAcceptanceFile(values.UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_FILE,
    "production_preflight_acceptance_file_invalid");
  invariant(receiptInfo.size > 0 && receiptInfo.size <= 65_536, "production_preflight_acceptance_file_size_invalid");
  const bytes = await readFile(values.UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_FILE);
  invariant(sha256(bytes) === values.UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_SHA256,
    "production_preflight_acceptance_hash_mismatch");
  let receipt;
  try { receipt = JSON.parse(bytes); } catch { throw new Error("production_preflight_acceptance_json_invalid"); }
  exactObject(receipt, ["schema", "status", "candidateCommit", "accepted8CCommit", "issuedAt", "expiresAt",
    "visibleFacts", "provider", "legalReceiptSha256"], "production_preflight_acceptance_receipt_invalid");
  rejectPlaceholders(receipt);
  invariant(receipt.schema === acceptanceSchema && ["APPROVED", "STRUCTURE_ONLY"].includes(receipt.status),
    "production_preflight_acceptance_schema_invalid");
  invariant(receipt.candidateCommit === values.UNSEEN_PRODUCTION_CANDIDATE_COMMIT,
    "production_preflight_acceptance_candidate_mismatch");
  invariant(receipt.accepted8CCommit === accepted8CCommit,
    "production_preflight_acceptance_8c_mismatch");
  const issuedAt = strictTimestamp(receipt.issuedAt, "production_preflight_acceptance_issued_at_invalid");
  const expiresAt = strictTimestamp(receipt.expiresAt, "production_preflight_acceptance_expires_at_invalid");
  const now = Date.now();
  invariant(issuedAt <= now && expiresAt > now && issuedAt < expiresAt,
    "production_preflight_acceptance_time_invalid");
  validateVisibleFacts(receipt.visibleFacts);
  validateProvider(receipt.provider);
  invariant(receipt.legalReceiptSha256 === values.UNSEEN_LEGAL_PRIVACY_APPROVAL_SHA256,
    "production_preflight_acceptance_legal_binding_mismatch");
  const secretInfo = await privateAcceptanceFile(receipt.provider.secretFile,
    "production_preflight_acceptance_secret_file_invalid");
  invariant(secretInfo.size > 0, "production_preflight_acceptance_secret_file_empty");
  return { receiptStatus: receipt.status, receiptSha256: sha256(bytes) };
}

function decoderFingerprint(info) {
  return [info.dev, info.ino, info.uid, info.gid, info.mode, info.size, info.mtimeMs].join(":");
}

async function validateDecoderBinary(program, values) {
  const prefix = `UNSEEN_${program.toUpperCase()}`;
  const filename = values[`${prefix}_PATH`];
  invariant(path.isAbsolute(filename) && !placeholderPattern.test(filename),
    `production_preflight_${program}_absolute_path_required`);
  strictSha256(values[`${prefix}_SHA256`], `production_preflight_${program}_sha256_invalid`);
  const before = await lstat(filename);
  const effectiveUid = process.geteuid?.();
  invariant(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= 268_435_456 &&
    (before.mode & 0o022) === 0 && [0, effectiveUid].includes(before.uid),
  `production_preflight_${program}_file_invalid`);
  try { await access(filename, fsConstants.X_OK); } catch {
    throw new Error(`production_preflight_${program}_executable_required`);
  }
  const fingerprint = decoderFingerprint(before);
  const firstBytes = await readFile(filename);
  const afterRead = await lstat(filename);
  invariant(decoderFingerprint(afterRead) === fingerprint,
    `production_preflight_${program}_binary_replaced`);
  invariant(sha256(firstBytes) === values[`${prefix}_SHA256`],
    `production_preflight_${program}_binary_hash_mismatch`);
  const finalBytes = await readFile(filename);
  const afterFinalRead = await lstat(filename);
  invariant(decoderFingerprint(afterFinalRead) === fingerprint &&
    sha256(finalBytes) === values[`${prefix}_SHA256`],
  `production_preflight_${program}_binary_replaced`);
  return { program, path: filename, sha256: values[`${prefix}_SHA256`], bytes: finalBytes.length,
    ownerUid: before.uid, mode: before.mode & 0o777, executed: false };
}

async function preflight() {
  const envFile = process.argv[3] ?? process.env.UNSEEN_PRODUCTION_ENV_FILE;
  invariant(envFile && path.isAbsolute(envFile), "production_preflight_absolute_env_file_required");
  const values = await loadProductionEnv(envFile);
  const required = ["UNSEEN_PRODUCTION_PROFILE", "UNSEEN_INTEGRATED_8C_COMMIT", "UNSEEN_BOOK_LAB_ENABLED",
    "UNSEEN_CORE_FACTS_PROVIDER_ENABLED", "UNSEEN_PRODUCTION_CANDIDATE_COMMIT",
    "UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_SHA256", "UNSEEN_LEGAL_PRIVACY_APPROVAL_SHA256",
    "UNSEEN_API_HOST", "UNSEEN_API_PORT", "UNSEEN_PUBLIC_ORIGIN", "UNSEEN_API_DB",
    "UNSEEN_API_KEYSET", "UNSEEN_API_MEDIA_ROOT", "UNSEEN_BOOK_LAB_LOCK", "UNSEEN_BOOK_LAB_DB",
    "UNSEEN_BOOK_LAB_RENDER_TMP", "UNSEEN_CHROMIUM_PATH",
    "UNSEEN_BOOK_RENDERER_TRANSPORT", "UNSEEN_BOOK_RENDERER_SOCKET", "UNSEEN_BOOK_RENDERER_SPOOL",
    "UNSEEN_BOOK_RENDERER_ACCEPTANCE_FILE", "UNSEEN_BOOK_RENDERER_ACCEPTANCE_SHA256",
    "UNSEEN_FFMPEG_PATH", "UNSEEN_FFMPEG_SHA256", "UNSEEN_FFPROBE_PATH", "UNSEEN_FFPROBE_SHA256",
    "UNSEEN_BOOK_LAB_COLLECTION_NOTICE_VERSION", "UNSEEN_BOOK_LAB_COLLECTION_NOTICE_HASH",
    "UNSEEN_BOOK_LAB_COLLECTION_NOTICE_COPY", "UNSEEN_BOOK_LAB_GRANT_NOTICE_VERSION",
    "UNSEEN_BOOK_LAB_GRANT_NOTICE_HASH",
    "UNSEEN_STAGING_MODE", "UNSEEN_STAGING_HOST", "UNSEEN_STAGING_PORT",
    "UNSEEN_STAGING_PUBLIC_ORIGIN", "UNSEEN_STAGING_EXPECT_REPOSITORY_STATE",
    "UNSEEN_STAGING_EXTERNAL_EXPOSURE_ACK",
    "UNSEEN_STAGING_DATA_DIR", "UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR", "UNSEEN_BOOK_WORKTREE",
    "UNSEEN_BOOK_OUTPUT_DIR", "UNSEEN_STAGING_BACKUP_DIR", "UNSEEN_STAGING_OTP_PROVIDER",
    "UNSEEN_STAGING_MEDIA_PROVIDER", "UNSEEN_STAGING_LOCATOR_PROVIDER", "UNSEEN_STAGING_BOOK_PROVIDER",
    "UNSEEN_OTP_PROVIDER_SECRET_FILE", "UNSEEN_MEDIA_PROVIDER_SECRET_FILE",
    "UNSEEN_LOCATOR_PROVIDER_SECRET_FILE",
    "UNSEEN_TRACK1B_ACCEPTANCE_FILE", "UNSEEN_TRACK3B_ACCEPTANCE_FILE",
    "UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_FILE",
    "UNSEEN_LEGAL_PRIVACY_APPROVAL_FILE", "UNSEEN_DEPLOYMENT_ID",
    "UNSEEN_BACKUP_RETENTION_DAYS", "UNSEEN_BACKUP_TARGET", "UNSEEN_ONCALL_OWNER"];
  const missing = required.filter((name) => !values[name]);
  invariant(missing.length === 0, `production_preflight_environment_required:${missing.join(",")}`);
  invariant(values.UNSEEN_PRODUCTION_PROFILE === "integrated_book_lab_8c" &&
    values.UNSEEN_INTEGRATED_8C_COMMIT === accepted8CCommit && values.UNSEEN_BOOK_LAB_ENABLED === "false" &&
    ["true", "false"].includes(values.UNSEEN_CORE_FACTS_PROVIDER_ENABLED) &&
    values.UNSEEN_API_HOST === "127.0.0.1" && values.UNSEEN_API_HOST === values.UNSEEN_STAGING_HOST &&
    values.UNSEEN_API_PORT === values.UNSEEN_STAGING_PORT &&
    values.UNSEEN_PUBLIC_ORIGIN === values.UNSEEN_STAGING_PUBLIC_ORIGIN &&
    values.UNSEEN_BOOK_RENDERER_TRANSPORT === "unseen-book-renderer-dedicated-service/v1" &&
    values.UNSEEN_BOOK_RENDERER_SOCKET === "/run/unseen-renderer/render.sock" &&
    values.UNSEEN_BOOK_RENDERER_SPOOL === "/var/lib/unseen/renderer-spool" &&
    values.UNSEEN_BOOK_RENDERER_ACCEPTANCE_FILE === "/run/unseen/approvals/book-renderer-acceptance.json" &&
    values.UNSEEN_CHROMIUM_PATH === "/snap/chromium/3507/usr/lib/chromium-browser/chrome" &&
    values.UNSEEN_STAGING_BOOK_PROVIDER === "integrated_8c_a16f7fdd" &&
    values.UNSEEN_STAGING_MODE === "production" && values.UNSEEN_STAGING_HOST === "127.0.0.1" &&
    values.UNSEEN_STAGING_EXPECT_REPOSITORY_STATE === "clean" &&
    values.UNSEEN_STAGING_EXTERNAL_EXPOSURE_ACK === "tls_reverse_proxy",
  "production_preflight_runtime_boundary_invalid");
  const port = Number(values.UNSEEN_STAGING_PORT);
  invariant(Number.isSafeInteger(port) && port > 0 && port < 65536, "production_preflight_port_invalid");
  const origin = new URL(values.UNSEEN_PUBLIC_ORIGIN);
  invariant(origin.protocol === "https:" && !["127.0.0.1", "localhost"].includes(origin.hostname) &&
    origin.pathname === "/" && !origin.username && !origin.password && !origin.search && !origin.hash,
  "production_preflight_origin_invalid");
  const explicitPaths = new Set(["UNSEEN_API_DB", "UNSEEN_API_KEYSET", "UNSEEN_API_MEDIA_ROOT",
    "UNSEEN_BOOK_LAB_LOCK", "UNSEEN_BOOK_LAB_DB", "UNSEEN_BOOK_LAB_RENDER_TMP", "UNSEEN_CHROMIUM_PATH",
    "UNSEEN_FFMPEG_PATH", "UNSEEN_FFPROBE_PATH", "UNSEEN_BOOK_RENDERER_SOCKET", "UNSEEN_BOOK_RENDERER_SPOOL",
    "UNSEEN_BOOK_RENDERER_ACCEPTANCE_FILE"]);
  for (const name of required.filter((name) => name.endsWith("_DIR") || name.endsWith("_FILE") ||
    name === "UNSEEN_BOOK_WORKTREE" || name === "UNSEEN_BACKUP_TARGET" || explicitPaths.has(name))) {
    invariant(path.isAbsolute(values[name]), `production_preflight_absolute_path_required:${name}`);
  }
  const durableRoots = ["UNSEEN_STAGING_DATA_DIR", "UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR",
    "UNSEEN_BOOK_OUTPUT_DIR", "UNSEEN_STAGING_BACKUP_DIR"].map((name) => path.resolve(values[name]));
  for (let left = 0; left < durableRoots.length; left += 1) {
    for (let right = left + 1; right < durableRoots.length; right += 1) {
      invariant(!inside(durableRoots[left], durableRoots[right]) && !inside(durableRoots[right], durableRoots[left]),
        "production_preflight_persistent_path_overlap");
    }
  }
  const decoderRuntime = await Promise.all([
    validateDecoderBinary("ffmpeg", values), validateDecoderBinary("ffprobe", values)
  ]);
  const acceptance = values.UNSEEN_CORE_FACTS_PROVIDER_ENABLED === "true" ?
    await validateFactsProviderAcceptance(values) : null;
  if (!values.UNSEEN_BOOK_RENDERER_ACCEPTANCE_SHA256.includes("REQUIRED_")) {
    strictSha256(values.UNSEEN_BOOK_RENDERER_ACCEPTANCE_SHA256,
      "production_preflight_renderer_acceptance_hash_invalid");
  }
  const placeholders = Object.entries(values).filter(([, value]) => value.includes("REQUIRED_")).map(([name]) => name);
  process.stdout.write(`${JSON.stringify({ schema: "unseen-production-preflight/1", status: "NO_GO",
    productionReady: false, environmentSyntax: "PASS", persistentPaths: "PASS_DISTINCT", tlsOrigin: "PASS",
    integrated8C: accepted8CCommit, featureFlagBookLab: false, questionProviderConfigured: false,
    visibleFactsApproved: false, factsProviderAcceptanceEnabled: acceptance !== null,
    acceptanceValidation: acceptance?.receiptStatus ?? "DISABLED",
    acceptanceReceiptRead: acceptance !== null, providerSecretRead: false, providerNetworkRequests: 0,
    decoderRuntimeValidation: "HASH_BOUND_NOT_EXECUTED", decoderRuntime,
    decoderProcessExecutions: 0, decoderVersionBuildValidation: "TARGET_ACCEPTANCE_REQUIRED",
    decoderNetworkBoundary: "TARGET_ACCEPTANCE_REQUIRED",
    acceptanceReceiptSha256: acceptance?.receiptSha256 ?? null, unresolvedPlaceholders: placeholders,
    releaseBlockers: requiredBlockers })}\n`);
  process.exitCode = 2;
}

if (command === "build") {
  await build();
} else if (command === "verify") {
  const manifest = await verifyPackage();
  process.stdout.write(`${JSON.stringify({ status: "PRODUCTION_PACKAGE_VERIFIED", packageRoot,
    candidateCommit: manifest.candidateCommit, releaseClaim: manifest.releaseClaim })}\n`);
} else if (command === "preflight") {
  await preflight();
} else {
  throw new Error("usage: node infra/integration/production-package.mjs build|verify|preflight");
}
