import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../services/api/src/database.mjs";

process.umask(0o077);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tool = path.join(repositoryRoot, "infra/integration/production-package.mjs");
const temporary = await mkdtemp(path.join(tmpdir(), "unseen-production-package-test-"));
const output = path.join(temporary, "release");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function detachAndDeleteLocalBranch(repository) {
  const branch = execFileSync("git", ["branch", "--show-current"],
    { cwd: repository, encoding: "utf8" }).trim();
  execFileSync("git", ["switch", "--detach"], { cwd: repository, stdio: "ignore" });
  if (branch === "") return Object.freeze({ branchDeleted: false, branch: null });
  execFileSync("git", ["branch", "-D", branch], { cwd: repository, stdio: "ignore" });
  return Object.freeze({ branchDeleted: true, branch });
}

try {
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }), "",
    "production package verification requires a clean candidate checkout");
  const built = JSON.parse(execFileSync(process.execPath, [tool, "build"], { cwd: repositoryRoot,
    env: { ...process.env, UNSEEN_PRODUCTION_PACKAGE_DIR: output }, encoding: "utf8" }).trim());
  assert.equal(built.status, "PRODUCTION_PACKAGE_CREATED");
  const nonGitCwd = path.join(temporary, "non-git-cwd");
  await mkdir(nonGitCwd, { mode: 0o700 });
  const verified = JSON.parse(execFileSync(process.execPath, [path.join(output, "VERIFY.mjs"), "verify"], {
    cwd: nonGitCwd, env: { ...process.env, UNSEEN_PRODUCTION_PACKAGE_DIR: output }, encoding: "utf8" }).trim());
  assert.equal(verified.status, "PRODUCTION_PACKAGE_VERIFIED");
  assert.equal(verified.releaseClaim, "NO_GO");
  const manifest = JSON.parse(await readFile(path.join(output, "PACKAGE-MANIFEST.json"), "utf8"));
  const rendererEvidencePath = "release-evidence/renderer/dedicated-service/machine-summary.json";
  const declaredRendererEvidence = execFileSync("git", ["show",
    `2286c3fbbd9c71d1d384edfbb078e785e1b52354:${rendererEvidencePath}`], { cwd: repositoryRoot });
  const candidateRendererEvidence = await readFile(path.join(repositoryRoot, rendererEvidencePath));
  assert.ok(candidateRendererEvidence.equals(declaredRendererEvidence));
  assert.equal(sha256(declaredRendererEvidence),
    "1a7fd73e7ce74012c813263a3bf2e429f04a05c98658b7ae15b00631643cc8d6");
  const systemd255EvidencePath =
    "release-evidence/renderer/dedicated-service/systemd255-property-fix/machine-summary.json";
  const declaredSystemd255Evidence = execFileSync("git", ["show",
    `259832e96c5e0edad9c1a5c5f5c6c092c56e7ae4:${systemd255EvidencePath}`], { cwd: repositoryRoot });
  const candidateSystemd255Evidence = await readFile(path.join(repositoryRoot, systemd255EvidencePath));
  assert.ok(candidateSystemd255Evidence.equals(declaredSystemd255Evidence));
  assert.equal(sha256(declaredSystemd255Evidence),
    "40f3ed9ccc5dd6350a636768d46279d6d004b20775d0770e9168ab7b54633e18");
  const systemd255IpDenyEvidencePath =
    "release-evidence/renderer/dedicated-service/systemd255-ip-deny-fix/machine-summary.json";
  const declaredSystemd255IpDenyEvidence = execFileSync("git", ["show",
    `8fb24ce1eb900307a4b1aa5b355f3f7eb45ba185:${systemd255IpDenyEvidencePath}`],
  { cwd: repositoryRoot });
  const candidateSystemd255IpDenyEvidence = await readFile(path.join(repositoryRoot,
    systemd255IpDenyEvidencePath));
  assert.ok(candidateSystemd255IpDenyEvidence.equals(declaredSystemd255IpDenyEvidence));
  assert.equal(sha256(declaredSystemd255IpDenyEvidence),
    "33f84b714baed915a287eef36b86f270faab0b8791b976fb28464ccd7f70967b");
  const durableControlEvidencePath =
    "release-evidence/renderer/dedicated-service/cold-readiness-diagnostics-20260815.json";
  const declaredDurableControlEvidence = execFileSync("git", ["show",
    `66eaa54edc00dada194867d649deb8e80ce45cfa:${durableControlEvidencePath}`], { cwd: repositoryRoot });
  const candidateDurableControlEvidence = await readFile(path.join(repositoryRoot, durableControlEvidencePath));
  assert.ok(candidateDurableControlEvidence.equals(declaredDurableControlEvidence));
  assert.equal(sha256(declaredDurableControlEvidence),
    "75b251afd69d5660807d44e05a37e7eeb0b84721137fc42bd0c453337da0ac00");
  const rendererControlTargetFailurePath =
    "release-evidence/r0/target-deployment-candidate9c-renderer-failure-20260815T061208Z/MACHINE-EVIDENCE.json";
  const declaredRendererControlTargetFailure = execFileSync("git", ["show",
    `dd3a7fac439ad67abaa6292eaf0e7a0b71db460c:${rendererControlTargetFailurePath}`],
  { cwd: repositoryRoot });
  const candidateRendererControlTargetFailure = await readFile(path.join(repositoryRoot,
    rendererControlTargetFailurePath));
  assert.ok(candidateRendererControlTargetFailure.equals(declaredRendererControlTargetFailure));
  assert.equal(sha256(declaredRendererControlTargetFailure),
    "56d357c4dc50fdf4e69e6ff44c9f20c038ef280beb27f52f82ad35fad5d2ba36");
  const rendererSnapAdapterEvidencePath =
    "release-evidence/renderer/dedicated-service/chromium-snap-headless-adapter/machine-summary.json";
  const declaredRendererSnapAdapterEvidence = execFileSync("git", ["show",
    `28964fd946037cd8a2c9f65e6fa896edafca4b92:${rendererSnapAdapterEvidencePath}`],
  { cwd: repositoryRoot });
  const candidateRendererSnapAdapterEvidence = await readFile(path.join(repositoryRoot,
    rendererSnapAdapterEvidencePath));
  assert.ok(candidateRendererSnapAdapterEvidence.equals(declaredRendererSnapAdapterEvidence));
  assert.equal(sha256(declaredRendererSnapAdapterEvidence),
    "2f7bdbe7a4793ac75467979b4111ec37077c2423cbc20e5eb0823fd2ca26b3e0");
  const rendererSnapCacheEvidencePath =
    "release-evidence/renderer/dedicated-service/snapd-cache-hardlink-topology/machine-summary.json";
  const declaredRendererSnapCacheEvidence = execFileSync("git", ["show",
    `d1acca2fdd5965db5cd611baa7377b138734119c:${rendererSnapCacheEvidencePath}`],
  { cwd: repositoryRoot });
  const candidateRendererSnapCacheEvidence = await readFile(path.join(repositoryRoot,
    rendererSnapCacheEvidencePath));
  assert.ok(candidateRendererSnapCacheEvidence.equals(declaredRendererSnapCacheEvidence));
  assert.equal(sha256(declaredRendererSnapCacheEvidence),
    "83638c095ac7737edc53303416cb3b0d36f9f8ea0defca27fb47ada504f13e77");
  const rendererSnapDanglingEvidencePath =
    "release-evidence/renderer/dedicated-service/snap-canonical-dangling-symlinks/fixed-review-followup.json";
  const declaredRendererSnapDanglingEvidence = execFileSync("git", ["show",
    `f9eaa6a2cc54ce80f8f234f6c468525e7ffd850d:${rendererSnapDanglingEvidencePath}`],
  { cwd: repositoryRoot });
  const candidateRendererSnapDanglingEvidence = await readFile(path.join(repositoryRoot,
    rendererSnapDanglingEvidencePath));
  assert.ok(candidateRendererSnapDanglingEvidence.equals(declaredRendererSnapDanglingEvidence));
  assert.equal(sha256(declaredRendererSnapDanglingEvidence),
    "22b9dc0ce87571dda3cb0b40699c16e2086d307b7963ae00e74cb83d0b3495ee");
  const rendererSnapCacheFailurePath =
    "release-evidence/r0/target-deployment-candidate48a-renderer-snap-hardlink-p1-20260815T104618Z/" +
    "MACHINE-EVIDENCE.json";
  const declaredRendererSnapCacheFailure = execFileSync("git", ["show",
    `87687c956770a409f040ec15c5bbbf9f93aa70a9:${rendererSnapCacheFailurePath}`],
  { cwd: repositoryRoot });
  const candidateRendererSnapCacheFailure = await readFile(path.join(repositoryRoot,
    rendererSnapCacheFailurePath));
  assert.ok(candidateRendererSnapCacheFailure.equals(declaredRendererSnapCacheFailure));
  assert.equal(sha256(declaredRendererSnapCacheFailure),
    "96a6372d2f4eb61609920f936feb6346edb565ba2c653d462ec0b96e1c27f380");
  const rendererRouteStaticEvidencePath =
    "release-evidence/r0/target-renderer-route1-static-adapter-policy-candidate09f-20260815T091250Z/" +
    "MACHINE-EVIDENCE.json";
  const declaredRendererRouteStaticEvidence = execFileSync("git", ["show",
    `4ca1eb309320a3a3a16331f2a013c6c08d254488:${rendererRouteStaticEvidencePath}`],
  { cwd: repositoryRoot });
  const candidateRendererRouteStaticEvidence = await readFile(path.join(repositoryRoot,
    rendererRouteStaticEvidencePath));
  assert.ok(candidateRendererRouteStaticEvidence.equals(declaredRendererRouteStaticEvidence));
  assert.equal(sha256(declaredRendererRouteStaticEvidence),
    "883f36b86b89b8f68534eb3e9f58f7a00ed35e2baee026c454c8552e593a9411");
  const immutableMarker = "REQUIRED_IMMUTABLE_RELEASE_COMMIT";
  const candidateValueMarker = "REQUIRED_CANDIDATE_COMMIT_FROM_PACKAGE_MANIFEST";
  function renderReleaseArtifacts(unitTemplate, productionEnvTemplate, commit) {
    assert.match(commit, /^[a-f0-9]{40}$/u, "render_candidate_invalid");
    assert.ok(!immutableMarker.includes(candidateValueMarker) && !candidateValueMarker.includes(immutableMarker),
      "render_markers_overlap");
    assert.equal((unitTemplate.match(new RegExp(immutableMarker, "gu")) ?? []).length, 1,
      "unit_release_marker_missing");
    assert.equal((productionEnvTemplate.match(new RegExp(immutableMarker, "gu")) ?? []).length, 1,
      "env_release_marker_missing");
    assert.equal((productionEnvTemplate.match(new RegExp(candidateValueMarker, "gu")) ?? []).length, 1,
      "env_candidate_marker_missing");
    const unit = unitTemplate.replace(immutableMarker, commit);
    const env = productionEnvTemplate.replace(immutableMarker, commit).replace(candidateValueMarker, commit);
    assert.doesNotMatch(`${unit}\n${env}`,
      /REQUIRED_IMMUTABLE_RELEASE_COMMIT|REQUIRED_CANDIDATE_COMMIT_FROM_PACKAGE_MANIFEST/u,
      "release_render_leftover");
    assert.match(unit, new RegExp(`^WorkingDirectory=/opt/unseen/releases/${commit}$`, "mu"));
    assert.match(env, new RegExp(`^UNSEEN_PRODUCTION_CANDIDATE_COMMIT=${commit}$`, "mu"));
    assert.match(env, new RegExp(`^UNSEEN_BOOK_WORKTREE=/opt/unseen/releases/${commit}$`, "mu"));
    return { unit, env };
  }
  const packagedUnit = await readFile(path.join(output, "unseen.service.example"), "utf8");
  const packagedRendererUnit = await readFile(path.join(output, "unseen-book-renderer.service.example"), "utf8");
  const packagedRendererSocket = await readFile(path.join(output, "unseen-book-renderer.socket.example"), "utf8");
  const packagedRendererTmpfiles = await readFile(path.join(output, "unseen-book-renderer.tmpfiles.example"), "utf8");
  const packagedEnv = await readFile(path.join(output, "production.env.example"), "utf8");
  const packagedRunbook = await readFile(path.join(output, "README.md"), "utf8");
  const renderedRelease = renderReleaseArtifacts(packagedUnit, packagedEnv, manifest.candidateCommit);
  assert.match(renderedRelease.unit,
    /^ReadWritePaths=.*\/var\/lib\/unseen\/renderer-spool(?:\s|$)/mu);
  assert.match(renderedRelease.unit,
    /^UnsetEnvironment=NODE_OPTIONS NODE_PATH PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_PROFILE GCONV_PATH BASH_ENV ENV PYTHONPATH PYTHONHOME PERL5OPT RUBYOPT OPENSSL_CONF OPENSSL_MODULES SSLKEYLOGFILE$/mu);
  assert.match(renderedRelease.unit,
    /^ExecStartPre=\/usr\/bin\/node infra\/integration\/production-package\.mjs preflight \/etc\/unseen\/production\.env$/mu);
  assert.equal((packagedRendererUnit.match(new RegExp(immutableMarker, "gu")) ?? []).length, 1);
  const renderedRendererUnit = packagedRendererUnit.replace(immutableMarker, manifest.candidateCommit);
  assert.match(renderedRendererUnit,
    new RegExp(`^WorkingDirectory=/opt/unseen/releases/${manifest.candidateCommit}$`, "mu"));
  assert.doesNotMatch(renderedRendererUnit, /REQUIRED_IMMUTABLE_RELEASE_COMMIT/u);
  assert.match(renderedRendererUnit, /^PrivateNetwork=true$/mu);
  assert.match(renderedRendererUnit, /^RestrictAddressFamilies=AF_UNIX$/mu);
  assert.doesNotMatch(renderedRendererUnit, /^EnvironmentFile=/mu);
  assert.match(renderedRendererUnit,
    /^UnsetEnvironment=NODE_OPTIONS NODE_PATH PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_PROFILE GCONV_PATH BASH_ENV ENV PYTHONPATH PYTHONHOME PERL5OPT RUBYOPT OPENSSL_CONF OPENSSL_MODULES SSLKEYLOGFILE$/mu);
  assert.match(renderedRendererUnit,
    /^ExecStartPre=\/usr\/bin\/sha256sum --strict --check --status \/run\/unseen\/approvals\/node-runtime\.sha256$/mu);
  assert.match(renderedRendererUnit,
    /^ExecStartPre=\/opt\/unseen\/runtime\/node-v22\.23\.2-linux-x64\/bin\/node infra\/integration\/book-lab\/renderer-service\.mjs --verify$/mu);
  assert.match(renderedRendererUnit,
    /^ExecStart=\/opt\/unseen\/runtime\/node-v22\.23\.2-linux-x64\/bin\/node infra\/integration\/book-lab\/renderer-service\.mjs$/mu);
  assert.doesNotMatch(renderedRendererUnit, /(?:ExecStart|ExecStartPre)=(?:\/usr\/bin\/node|\/usr\/bin\/env|node\s)/u);
  assert.match(renderedRendererUnit,
    /^ReadOnlyPaths=\/opt\/unseen\/runtime\/node-v22\.23\.2-linux-x64 .*\/run\/unseen\/approvals\/node-runtime\.sha256$/mu);
  assert.match(packagedRendererSocket, /^ListenStream=\/run\/unseen-renderer\/render\.sock$/mu);
  assert.match(packagedRendererTmpfiles,
    /^d \/var\/lib\/unseen\/renderer-spool\/results\/control 2750 unseen-renderer unseen-render-ipc -$/mu);
  assert.match(packagedRunbook, /DURABLE_CONTROL_ACCEPTANCE_MARKER_REQUIRED_FOR_RENDER_RESUME/u);
  assert.match(packagedRunbook,
    /CUPS_TARGET_GATE=BOTH_NOT_FOUND_RC4_OR_BOTH_INSTALLED_INACTIVE_DISABLED_MASKED_AND_ZERO_LISTENERS/u);
  assert.match(packagedRunbook,
    /NODE_RUNTIME_TARGET_GATE=PINNED_NODE_22_23_2_SIGNED_SHASUMS_AND_EXACT_BINARY/u);
  assert.match(packagedRunbook,
    /CHROMIUM_SNAP_ADAPTER_GATE=REVISION_3507_EXACT14_EMPTY_ENV_FIXED_ARGV_FULL_TREE_HASH/u);
  assert.match(packagedRunbook, /releaseDecision=NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED/u);
  assert.match(packagedRunbook, /SNAPD_CACHE_HARDLINK_GATE=ARCHIVE_ONLY_OR_EXACT_SHA3_384_CACHE_LINK/u);
  assert.match(packagedRunbook, /49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5/u);
  assert.match(packagedRunbook,
    /snap_archive_dac=root:root:0600 source=TARGET_OBSERVED_EVIDENCE_87687C956770A409F040EC15C5BBBF9F93AA70A9/u);
  assert.match(packagedRunbook,
    /snap_cache_dir_dac=root:root:0700 source=SNAPD_SOURCE_POLICY_93A01322CDC0AD70AFCD641FF31FCF7BF070F144/u);
  assert.match(packagedRunbook, /7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913/u);
  assert.match(packagedRunbook, /f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5/u);
  assert.equal(manifest.artifacts.some((entry) => entry.path.endsWith(".snap")), false);
  assert.match(packagedRunbook, /node_archive_sha=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307/u);
  assert.doesNotMatch(renderedRelease.env, /[a-f0-9]{40}_FROM_PACKAGE_MANIFEST/u,
    "candidate_marker_suffix_collision");
  assert.throws(() => renderReleaseArtifacts(packagedUnit,
    packagedEnv.replace(immutableMarker, "REQUIRED_CANDIDATE_COMMIT"), manifest.candidateCommit),
  /env_release_marker_missing|render_markers_overlap|release_render_leftover/u);
  assert.deepEqual(manifest.releaseBlockers, [
    "core_visible_facts_and_question_provider_not_authorized",
    "legal_privacy_notice_approvals_missing",
    "final_candidate_deployment_secret_decoder_operator_and_provider_acceptance_missing"
  ]);
  assert.deepEqual(manifest.profiles.staging, {
    id: "local_staging_fixture", coreProductCommit: manifest.coreProductCommit,
    bookFixtureCommit: manifest.bookCommit, featureFlagBookLab: false, fixtureOnly: true, productionInput: false
  });
  assert.equal(manifest.profiles.production.integrated8CCommit,
    "a16f7fdda14759429fd22054506f198980805e9d");
  assert.equal(manifest.profiles.production.rendererProfile, "production");
  assert.equal(manifest.profiles.production.rendererDedicatedService,
    "unseen-book-renderer-dedicated-service/v1");
  assert.equal(manifest.profiles.production.rendererDedicatedServiceDefaultEnabled, false);
  assert.equal(manifest.profiles.production.rendererNetworkNamespace, "SYSTEMD_PRIVATE_NETWORK");
  assert.equal(manifest.profiles.production.rendererIpc, "FILESYSTEM_AF_UNIX_AND_PRIVATE_SPOOL");
  assert.equal(manifest.profiles.production.rendererTargetAcceptance, "REQUIRED_NOT_INCLUDED");
  assert.equal(manifest.profiles.production.rendererBrowserAdapter,
    "candidate-owned-fixed-headless-snap-3507/v1");
  assert.equal(manifest.profiles.production.rendererBrowserDistributionEmbedded, false);
  assert.equal(manifest.profiles.production.rendererBrowserReleaseDecision,
    "NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED");
  assert.equal(manifest.profiles.production.rendererBrowserAdapterAcceptedCommit,
    "28964fd946037cd8a2c9f65e6fa896edafca4b92");
  assert.equal(manifest.profiles.production.rendererBrowserAdapterFocusedCases, 43);
  assert.equal(manifest.profiles.production.rendererBrowserAdapterEnvironmentEntryCount, 14);
  assert.equal(manifest.profiles.production.rendererBrowserTreeManifestSha256,
    "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913");
  assert.equal(manifest.profiles.production.rendererBrowserResourceManifestSha256,
    "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5");
  assert.equal(manifest.profiles.production.rendererCanonicalDanglingSymlinkAcceptedCommit,
    "f9eaa6a2cc54ce80f8f234f6c468525e7ffd850d");
  assert.equal(manifest.profiles.production.rendererCanonicalDanglingSymlinkFocusedCases, 45);
  assert.equal(manifest.profiles.production.rendererSnapCacheHardlinkAcceptedCommit,
    "d1acca2fdd5965db5cd611baa7377b138734119c");
  assert.equal(manifest.profiles.production.rendererSnapCacheHardlinkFocusedCases, 44);
  assert.equal(manifest.profiles.production.dedicatedRendererAcceptedCommit,
    "2286c3fbbd9c71d1d384edfbb078e785e1b52354");
  assert.equal(manifest.profiles.production.rendererSystemd255FixAcceptedCommit,
    "259832e96c5e0edad9c1a5c5f5c6c092c56e7ae4");
  assert.equal(manifest.profiles.production.rendererSystemd255IpDenyFixAcceptedCommit,
    "8fb24ce1eb900307a4b1aa5b355f3f7eb45ba185");
  assert.equal(manifest.profiles.production.rendererDurableControlAcceptedCommit,
    "66eaa54edc00dada194867d649deb8e80ce45cfa");
  assert.equal(manifest.profiles.production.temporaryAccessUiAcceptedCommit,
    "488923cfebb995f50c0eab73a31da74cd6b03493");
  assert.equal(manifest.profiles.production.publicCoreUiEvidenceCommit,
    "09ce09c170bbd4b5992a3a1b016e814be2013486");
  assert.equal(manifest.profiles.production.publicCoreUiObservedCandidateCommit,
    "45380ecd77315fcc95f3e445353f8abdc6c77603");
  assert.equal(manifest.profiles.production.publicCoreUiFinalCandidateDeployed, false);
  assert.equal(manifest.profiles.production.fixtureFallback, false);
  assert.equal(manifest.profiles.production.smtpOtpDefaultEnabled, false);
  assert.equal(manifest.profiles.production.smtpOtpDeployableUnderCurrentPrivateBetaUnit, false);
  assert.equal(manifest.profiles.production.questionProviderCapabilityExposed, true);
  assert.equal(manifest.profiles.production.questionProviderConfigured, false);
  assert.equal(manifest.profiles.production.visibleFactsApproved, false);
  assert.equal(manifest.profiles.production.factsProviderAcceptanceEnabled, false);
  assert.equal(manifest.profiles.production.factsProviderAcceptanceSchema,
    "unseen-core-facts-question-provider-acceptance/1");
  assert.equal(manifest.profiles.production.macCodexPrivateWorkerEvidenceClass, "PRIVATE_TEST_PROOF");
  assert.equal(manifest.profiles.production.macCodexPrivateWorkerProductionTransport, false);
  assert.equal(manifest.profiles.production.macCodexPrivateWorkerFactsExtraction, false);
  assert.equal(manifest.profiles.production.privateAiQueueDefaultEnabled, false);
  assert.equal(manifest.profiles.production.privateAiCompositionDefaultEnabled, false);
  assert.equal(manifest.profiles.production.privateAiTransportDeployed, false);
  assert.equal(manifest.profiles.production.privateAiCaddyBodyCapBytes, 32768);
  assert.equal(manifest.profiles.production.privateAiCaddyBodyCapStatus,
    "ACCEPTED_CODE_ONLY_NOT_DEPLOYED");
  assert.equal(manifest.profiles.production.deploymentContractStatus,
    "ACCEPTED_CODE_ONLY_NOT_DEPLOYED");
  assert.equal(manifest.profiles.production.activeReleaseAuthority,
    "LOADED_UNIT_PROCESS_CWD_DETACHED_HEAD_TREE_CLEAN");
  assert.equal(manifest.profiles.production.caddyPermissionContract,
    "SEALED_0600_LIVE_AND_ROLLBACK_0640");
  assert.equal(manifest.profiles.production.orderedMigrations, 10);
  assert.equal(manifest.profiles.production.productionCaddyApplicationAuthAndCsp, true);
  assert.equal(manifest.profiles.production.bookPrivateFactsBoundary,
    "BOOK_PRIVATE_NOT_CORE_PUBLIC_OR_AUTO_BOOK");
  assert.equal(manifest.profiles.production.privateAiQueuedUiEvidence,
    "DETERMINISTIC_BROWSER_EVIDENCE_NOT_PRODUCTION_INPUT");
  assert.equal(manifest.profiles.production.decoderRuntimeAuthenticity,
    "HASH_BOUND_TARGET_ACCEPTANCE_REQUIRED");
  assert.deepEqual(manifest.acceptedEvidence.uiV2, {
    commit: "d049a85d63abad0db06c96d3cd5671bd56567dc6", status: "ACCEPTED"
  });
  assert.deepEqual(manifest.acceptedEvidence.dedicatedRenderer, {
    commit: "2286c3fbbd9c71d1d384edfbb078e785e1b52354",
    codeCommit: "30dca550ac73301457e9bff087a56ab112be7e61",
    status: "CODE_GATES_PASS_TARGET_ACCEPTANCE_REQUIRED",
    defaultOff: true,
    productionEnabled: false,
    targetAcceptance: "REQUIRED_NOT_INCLUDED",
    focusedCases: 29,
    evidence: manifest.acceptedEvidence.dedicatedRenderer.evidence
  });
  assert.deepEqual(manifest.acceptedEvidence.dedicatedRenderer.evidence, {
    path: "release-evidence/renderer/dedicated-service/machine-summary.json",
    sha256: "1a7fd73e7ce74012c813263a3bf2e429f04a05c98658b7ae15b00631643cc8d6"
  });
  assert.deepEqual(manifest.acceptedEvidence.rendererSystemd255Fix, {
    commit: "259832e96c5e0edad9c1a5c5f5c6c092c56e7ae4",
    codeCommit: "5ed65ec33eee0228c8d814bdf207674ddb4b5cbc",
    status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
    defaultOff: true,
    targetRetryRequired: true,
    focusedCases: 29,
    evidence: {
      path: "release-evidence/renderer/dedicated-service/systemd255-property-fix/machine-summary.json",
      sha256: "40f3ed9ccc5dd6350a636768d46279d6d004b20775d0770e9168ab7b54633e18"
    }
  });
  assert.deepEqual(manifest.acceptedEvidence.rendererSystemd255IpDenyFix, {
    commit: "8fb24ce1eb900307a4b1aa5b355f3f7eb45ba185",
    evidenceCommit: "f596bb760115943e73c68fcb06d35c3f396240dd",
    codeCommit: "8d894e8f96600e19206b0246cb4f95861200720b",
    status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
    defaultOff: true,
    targetRetryRequired: true,
    focusedCases: 29,
    evidence: {
      path: systemd255IpDenyEvidencePath,
      sha256: "33f84b714baed915a287eef36b86f270faab0b8791b976fb28464ccd7f70967b"
    }
  });
  assert.deepEqual(manifest.acceptedEvidence.rendererDurableControl, {
    commit: "66eaa54edc00dada194867d649deb8e80ce45cfa",
    codeCommit: "72a7a96a0279e3a1ec922ff777175ad4d63edc45",
    status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
    defaultOff: true,
    targetRetryRequired: true,
    focusedCases: 41,
    evidence: {
      path: durableControlEvidencePath,
      sha256: "75b251afd69d5660807d44e05a37e7eeb0b84721137fc42bd0c453337da0ac00"
    },
    historicalTargetFailure: {
      commit: "dd3a7fac439ad67abaa6292eaf0e7a0b71db460c",
      status: "HISTORICAL_TARGET_REJECTED_SUPERSEDED_BY_ACCEPTED_COLD_READINESS_FIX",
      evidence: {
        path: rendererControlTargetFailurePath,
        sha256: "56d357c4dc50fdf4e69e6ff44c9f20c038ef280beb27f52f82ad35fad5d2ba36"
      }
    }
  });
  assert.deepEqual(manifest.acceptedEvidence.rendererSnapAdapter, {
    commit: "28964fd946037cd8a2c9f65e6fa896edafca4b92",
    codeCommit: "c181a0a92c3907e8db87e235adfc78b0fe2d3896",
    status: "CODE_GATES_PASS_TARGET_EXECUTION_NOT_RUN",
    defaultOff: true,
    targetAcceptanceRequired: true,
    environmentEntryCount: 14,
    treeManifestSha256: "7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913",
    resourceManifestSha256: "f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5",
    canonicalDanglingSymlinkPolicySha256: "3c3f99c6d62feffb90a873bc245930045a1e42bdc0c3b1e5c2a763208586b128",
    runtimeReachability: "ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE",
    canonicalDanglingSymlinkFix: {
      commit: "f9eaa6a2cc54ce80f8f234f6c468525e7ffd850d",
      codeCommit: "004b05f6549540c93044a5b8f16ae8d939afeb44",
      status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
      defaultOff: true,
      targetRetryRequired: true,
      focusedCases: 45,
      evidence: {
        path: rendererSnapDanglingEvidencePath,
        sha256: "22b9dc0ce87571dda3cb0b40699c16e2086d307b7963ae00e74cb83d0b3495ee"
      },
      historicalRejectedCommits: [
        "21b34bf141f5fafb48d8cc08eaa89850f6931bd3",
        "e46723f91157ac80a5dcd8c91206ea8272a98cc8"
      ],
      historicalTargetFailure: {
        commit: "11b869b9cfb41c5fedbaafda9533974b7873b3b9",
        status: "HISTORICAL_TARGET_REJECTED_SUPERSEDED_BY_ACCEPTED_CANONICAL_DANGLING_SYMLINK_FIX",
        evidence: {
          path: "release-evidence/r0/target-deployment-candidateb314-renderer-browser-tree-p1-20260815T113717Z/" +
            "MACHINE-EVIDENCE.json",
          sha256: "abd5c42940378b2799f4af12933982492435164c70bfe0fa29d90affed38953a"
        }
      }
    },
    archiveLinkPolicySha256: "49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5",
    archiveLinkStates: ["ARCHIVE_ONLY", "ARCHIVE_AND_SNAPD_SHA3_CACHE"],
    evidence: {
      path: rendererSnapAdapterEvidencePath,
      sha256: "2f7bdbe7a4793ac75467979b4111ec37077c2423cbc20e5eb0823fd2ca26b3e0"
    },
    staticInput: {
      commit: "4ca1eb309320a3a3a16331f2a013c6c08d254488",
      path: rendererRouteStaticEvidencePath,
      sha256: "883f36b86b89b8f68534eb3e9f58f7a00ed35e2baee026c454c8552e593a9411"
    },
    targetDiagnostics: [
      {
        commit: "7a7b3fa7a9b354020f59212efb8e9805bde4f1ea",
        path: "release-evidence/r0/target-renderer-static-resource-closure-candidate09f-20260815T085301Z/" +
          "MACHINE-EVIDENCE.json",
        sha256: "810d25b7df4cd6a8e8195784457de13fa2d58cefac9547bdeca49a9ca8a105f6"
      },
      {
        commit: "2e2f11491a0b89c00327c58a04c5c006a7899611",
        path: "release-evidence/r0/target-renderer-s35-adaptive-candidate09f-20260815T084020Z/" +
          "MACHINE-EVIDENCE.json",
        sha256: "a3fcb1b0825495cb9cb1c73c1686c50a7a2caeebb2df64b1c1e1222a6133000f"
      },
      {
        commit: "af9e73eb0da622c3c75bebcf1bf29b8121c8ead7",
        path: "release-evidence/r0/target-renderer-s3-v4-candidate09f-20260815T082828Z/MACHINE-EVIDENCE.json",
        sha256: "f1daa0389beb69f8d05b892a11b863563647f1eca7d721be10c8cb124c0cf053"
      }
    ],
    externalReleaseGates: [
      "CHROMIUM_ASSERTION_SIGNATURE_NOT_INDEPENDENTLY_VERIFIED",
      "CHROMIUM_LICENSE_DECLARATION_UNAPPROVED",
      "CHROMIUM_SECURITY_REVIEW_REQUIRED",
      "TARGET_SYNTHETIC_RENDER_AND_NETWORK_ACCEPTANCE_NOT_RUN"
    ]
  });
  assert.deepEqual(manifest.acceptedEvidence.rendererSnapCacheHardlink, {
    commit: "d1acca2fdd5965db5cd611baa7377b138734119c",
    codeCommit: "2e7a2276f233b973fa17e4c05120772d17381c93",
    status: "CODE_GATES_PASS_TARGET_RETRY_REQUIRED",
    defaultOff: true,
    targetRetryRequired: true,
    focusedCases: 44,
    cacheMutationPerformed: false,
    evidence: {
      path: rendererSnapCacheEvidencePath,
      sha256: "83638c095ac7737edc53303416cb3b0d36f9f8ea0defca27fb47ada504f13e77"
    },
    historicalTargetFailure: {
      commit: "87687c956770a409f040ec15c5bbbf9f93aa70a9",
      status: "HISTORICAL_TARGET_REJECTED_SUPERSEDED_BY_ACCEPTED_NLINK_POLICY_FIX",
      evidence: {
        path: rendererSnapCacheFailurePath,
        sha256: "96a6372d2f4eb61609920f936feb6346edb565ba2c653d462ec0b96e1c27f380"
      }
    }
  });
  assert.deepEqual(manifest.acceptedEvidence.temporaryAccessUi, {
    commit: "488923cfebb995f50c0eab73a31da74cd6b03493",
    codeCommit: "4e5fd762d4bc53bc1713b675eaa4027e6f787105",
    status: "ACCEPTED_TEMPORARY_ACCESS_DISCLOSURE",
    productionInput: false,
    temporaryAccessBanner: true,
    faviconAsset: true,
    machineChecks: manifest.acceptedEvidence.temporaryAccessUi.machineChecks,
    browser: manifest.acceptedEvidence.temporaryAccessUi.browser
  });
  assert.deepEqual(manifest.acceptedEvidence.publicCoreUi, {
    commit: "09ce09c170bbd4b5992a3a1b016e814be2013486",
    status: "PASS_PUBLIC_CORE_UI_TARGET_MILESTONE_NOT_CORE_OPERABLE_BETA",
    observedCandidateCommit: "45380ecd77315fcc95f3e445353f8abdc6c77603",
    finalCandidateDeployed: false,
    publicCoreUiServed: true,
    otpEnabled: false,
    bookEnabled: false,
    privateAiEnabled: false,
    evidence: manifest.acceptedEvidence.publicCoreUi.evidence
  });
  assert.equal(manifest.acceptedEvidence.uiActionClosure.commit,
    "3478ae390445d83bb9230c26c4c8b8ffe50e6e62");
  assert.equal(manifest.acceptedEvidence.uiActionClosure.codeCommit,
    "49efe3ec6a407eb0a75f5be6d8c404d4c8acef17");
  assert.equal(manifest.acceptedEvidence.uiActionClosure.status, "ACCEPTED_FIXTURE_ONLY");
  assert.equal(manifest.acceptedEvidence.uiActionClosure.productionInput, false);
  assert.equal(manifest.acceptedEvidence.uiCopyActionClosure.commit,
    "c071018bf450ab347056931f98264a0c2e2176d4");
  assert.equal(manifest.acceptedEvidence.uiCopyActionClosure.codeCommit,
    "74adfba49cb15eba3be3db91b10545a16c76db43");
  assert.equal(manifest.acceptedEvidence.uiCopyActionClosure.baseCandidate,
    "4028310f02feb3e0d992c8ea56403cf4764d86c8");
  assert.equal(manifest.acceptedEvidence.uiCopyActionClosure.status, "ACCEPTED_FIXTURE_ONLY");
  assert.equal(manifest.acceptedEvidence.uiCopyActionClosure.productionInput, false);
  assert.equal(manifest.acceptedEvidence.uiCopyActionClosure.visibleControlsDirectlyExercised, 44);
  assert.equal(manifest.acceptedEvidence.uiCopyActionClosure.coreEmptyErrorBranches,
    "DETERMINISTIC_FIXTURE_BROWSER_EVIDENCE");
  assert.equal(manifest.acceptedEvidence.uiCoreStates.commit,
    "951363b6031ec3d9e1f29785c8e22d3939b7302d");
  assert.equal(manifest.acceptedEvidence.uiCoreStates.testCommit,
    "2f85856eb5d2753c2ef7d68175ecafa45f001ee0");
  assert.equal(manifest.acceptedEvidence.uiCoreStates.baseCandidate,
    "e16dd93eaacce4ad8fe1fd25930277638e795f96");
  assert.equal(manifest.acceptedEvidence.uiCoreStates.status, "ACCEPTED_TEST_ONLY_FIXTURE_EVIDENCE");
  assert.equal(manifest.acceptedEvidence.uiCoreStates.marker, "TEST_ONLY_FIXTURE_FAULTS");
  assert.equal(manifest.acceptedEvidence.uiCoreStates.testOnlyCases, 12);
  assert.equal(manifest.acceptedEvidence.uiCoreStates.productionFaultCoverage, false);
  assert.equal(manifest.acceptedEvidence.uiCoreStates.productionInput, false);
  assert.equal(manifest.acceptedEvidence.uiCoreStates.productBytesChanged, false);
  assert.deepEqual(manifest.acceptedEvidence.publicFoundation, {
    commit: "fb2f2b947a6e80d1a0a02b0c6f4e0d2f964c7c4a",
    status: "ACCEPTED_TARGET_OBSERVATION",
    productionInput: false,
    evidence: manifest.acceptedEvidence.publicFoundation.evidence
  });
  assert.equal(manifest.acceptedEvidence.smtpOtp.commit,
    "ba9a049ac9ce328c8bac23b88a3fbaadd48ea9ec");
  assert.equal(manifest.acceptedEvidence.smtpOtp.codeCommit,
    "81f2c42abb2cfd5731eaeac2df5573db67d88e07");
  assert.equal(manifest.acceptedEvidence.smtpOtp.status, "ACCEPTED_DEFAULT_OFF");
  assert.equal(manifest.acceptedEvidence.smtpOtp.defaultEnabled, false);
  assert.equal(manifest.acceptedEvidence.smtpOtp.deployableUnderCurrentPrivateBetaUnit, false);
  assert.equal(manifest.acceptedEvidence.questionProviderOffline.commit,
    "fdfa68e68f1931179122c111cf483c83f7a060d4");
  assert.equal(manifest.acceptedEvidence.questionProviderOffline.capabilityCommit,
    "c76ee298e7a9566506252e291e3dfe050c4a3a9f");
  assert.equal(manifest.acceptedEvidence.questionProviderOffline.uiCommit,
    "69ae472e79715851226e0025bd49035479b837b4");
  assert.equal(manifest.acceptedEvidence.questionProviderOffline.status, "ACCEPTED");
  assert.equal(manifest.acceptedEvidence.questionProviderOffline.productFixtureAdded, false);
  assert.equal(manifest.acceptedEvidence.questionProviderOffline.browserEvidenceProductionInput, false);
  assert.equal(manifest.acceptedEvidence.macCodexPrivateWorker.commit,
    "94f778095567332711401be10b56074065732466");
  assert.equal(manifest.acceptedEvidence.macCodexPrivateWorker.codeCommit,
    "6652bc406f90038bdc83ab8777898c7e711991ad");
  assert.equal(manifest.acceptedEvidence.macCodexPrivateWorker.evidenceClass, "PRIVATE_TEST_PROOF");
  assert.equal(manifest.acceptedEvidence.macCodexPrivateWorker.productionEnabled, false);
  assert.equal(manifest.acceptedEvidence.macCodexPrivateWorker.productionTransport, false);
  assert.equal(manifest.acceptedEvidence.macCodexPrivateWorker.factsExtraction, false);
  assert.equal(manifest.acceptedEvidence.macCodexPrivateWorker.productionInput, false);
  assert.deepEqual(manifest.acceptedEvidence.privateAiQueue, {
    commit: "73a7c9df7ed11136d2fe9bf776d058d8e88e1237",
    codeCommit: "4209d552fd79f679ed821fcacb741f5095945fcb",
    status: "ACCEPTED_DEFAULT_OFF", productionEnabled: false, productionTransport: false,
    evidence: manifest.acceptedEvidence.privateAiQueue.evidence
  });
  assert.equal(manifest.acceptedEvidence.privateAiTransport.commit,
    "1ad67378f169057b506987eee96f51b2699a5a22");
  assert.equal(manifest.acceptedEvidence.privateAiTransport.codeCommit,
    "3114a1f89c6542550f3fe19b51fee3a04aadea61");
  assert.equal(manifest.acceptedEvidence.privateAiTransport.fixCommit,
    "3c9a1cca8289d82b660928f9e1a14ea94270ef71");
  assert.equal(manifest.acceptedEvidence.privateAiTransport.fixCodeCommit,
    "497de1c239d5d4686ca7d048b1e8a575d7cf4526");
  assert.equal(manifest.acceptedEvidence.privateAiTransport.status, "ACCEPTED_DEFAULT_OFF_NOT_DEPLOYED");
  assert.equal(manifest.acceptedEvidence.privateAiTransport.evidenceClass,
    "PRIVATE_BETA_TRANSPORT_IMPLEMENTATION");
  assert.equal(manifest.acceptedEvidence.privateAiTransport.liveProofClass, "PRIVATE_TEST_PROOF");
  assert.equal(manifest.acceptedEvidence.privateAiTransport.subscriptionBoundary,
    "CHATGPT_SUBSCRIPTION_PRIVATE_TEST_NOT_OPENAI_API");
  assert.equal(manifest.acceptedEvidence.privateAiTransport.commercialSla, false);
  assert.equal(manifest.acceptedEvidence.privateAiTransport.productionEnabled, false);
  assert.equal(manifest.acceptedEvidence.privateAiTransport.productionTransport, false);
  assert.equal(manifest.acceptedEvidence.privateAiTransport.factsExtraction, false);
  assert.equal(manifest.acceptedEvidence.privateAiTransport.productionInput, false);
  assert.deepEqual(manifest.acceptedEvidence.bookPrivateFacts, {
    commit: "5ea82de266b1ec07122ed34bf5219069bfa3b18d",
    codeCommit: "deaf767777144c38b045e8265fb7f6e5a4f8de69",
    status: "ACCEPTED_PRIVATE_BOOK_FACTS", defaultOff: true, coreMutation: false,
    publicFacts: false, autoBook: false, productionInput: false,
    evidence: manifest.acceptedEvidence.bookPrivateFacts.evidence
  });
  assert.equal(manifest.acceptedEvidence.privateAiComposition.commit,
    "437de71f569027dd9639bad462988ece80d635f9");
  assert.equal(manifest.acceptedEvidence.privateAiComposition.codeCommit,
    "8329b5c3be36a5691be457e64d50eb2387180335");
  assert.equal(manifest.acceptedEvidence.privateAiComposition.status, "ACCEPTED_DEFAULT_OFF");
  assert.equal(manifest.acceptedEvidence.privateAiComposition.productionEnabled, false);
  assert.equal(manifest.acceptedEvidence.privateAiComposition.productionTransport, false);
  assert.equal(manifest.acceptedEvidence.privateAiComposition.credentialCreated, false);
  assert.equal(manifest.acceptedEvidence.privateAiComposition.productionInput, false);
  assert.equal(manifest.acceptedEvidence.privateAiQueuedUi.commit,
    "7348da9c20b34e587df0f1f008632861b633699f");
  assert.equal(manifest.acceptedEvidence.privateAiQueuedUi.codeCommit,
    "df127bf313559fec1054bf2fed85a086c32a1c78");
  assert.equal(manifest.acceptedEvidence.privateAiQueuedUi.status,
    "ACCEPTED_DETERMINISTIC_BROWSER_EVIDENCE");
  assert.equal(manifest.acceptedEvidence.privateAiQueuedUi.productionInput, false);
  assert.equal(manifest.acceptedEvidence.privateAiQueuedUi.productFixtureAdded, false);
  assert.equal(manifest.acceptedEvidence.privateAiQueuedUi.browserCases, 4);
  assert.deepEqual(manifest.acceptedEvidence.privateAiCaddyBodyCap, {
    commit: "14bda3b447137cdd83b614ca01ee633c91467c09",
    codeCommit: "a3c47c8500207bd6dbd2440ad9a10f5430e1b3b9",
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
    evidence: manifest.acceptedEvidence.privateAiCaddyBodyCap.evidence,
    historicalRejectedCommit: "721382f5d1b677595117a266b5ee889644e923a1",
    historicalRejectedStatus: "HISTORICAL_REJECTED_SUPERSEDED_BY_ACCEPTED_CODE_FIX",
    historicalRejectedEvidence: manifest.acceptedEvidence.privateAiCaddyBodyCap.historicalRejectedEvidence
  });
  assert.deepEqual(manifest.acceptedEvidence.deploymentContract, {
    commit: "a4faa79f64aaaf29fe17265c0717aaf8cbc0b806",
    codeCommit: "9db936bdf7e1f56ec10f57bc9627be91b32ff603",
    status: "ACCEPTED_CODE_ONLY_NOT_DEPLOYED",
    acceptedChain: "ALREADY_LINEAR_ON_STAGE5",
    productionDeployed: false,
    productionInput: false,
    activeAuthority: "LOADED_UNIT_PROCESS_CWD_DETACHED_HEAD_TREE_CLEAN",
    unitRenderMarker: "REQUIRED_IMMUTABLE_RELEASE_COMMIT",
    candidateValueMarker: "REQUIRED_CANDIDATE_COMMIT_FROM_PACKAGE_MANIFEST",
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
      acceptedBodyCapCommit: "14bda3b447137cdd83b614ca01ee633c91467c09"
    },
    evidence: manifest.acceptedEvidence.deploymentContract.evidence,
    historicalRejectedEvidenceCommits: [
      "7d73fb980ed74d49de1cb27f92a4d61af2f97615",
      "6d0cb2f1342bcc88383dfff3371d567d704b579f"
    ],
    historicalRejectedStatus: "HISTORICAL_REJECTED_SUPERSEDED",
    historicalDeploymentFailure: {
      commit: "022c464d624e9aeeaa9623439e1495b2c7f4bd3f",
      status: "HISTORICAL_ROLLED_BACK_P1_FIXED_CODE_ONLY_NOT_DEPLOYED",
      productionDeployed: false,
      fixedP1: [
        "ACTIVE_RELEASE_ALIAS_STALE_AND_CAN_MISREPORT_DEPLOYED_CANDIDATE",
        "CADDY_SYSTEMD_RELOAD_PERMISSION_MISMATCH_BLOCKS_ACCEPTED_BODY_CAP_ACTIVATION"
      ],
      evidence: manifest.acceptedEvidence.deploymentContract.historicalDeploymentFailure.evidence
    }
  });
  assert.equal(manifest.acceptedEvidence.browserA11y.commit,
    "97ae5ba600a5cd5e6102e5064206a64988c9f45c");
  assert.equal(manifest.acceptedEvidence.browserA11y.testedInputCommit,
    "09076727051411eeb9274a26663f6ccd168378c3");
  assert.equal(manifest.acceptedEvidence.browserA11y.browserExecutedCandidateCommit,
    "09076727051411eeb9274a26663f6ccd168378c3");
  assert.equal(manifest.acceptedEvidence.browserA11y.postEvidenceCandidateBrowserExecuted, false);
  assert.equal(manifest.acceptedEvidence.browserA11y.currentCandidateCoverage, false);
  assert.equal(manifest.acceptedEvidence.browserA11y.coverageScope, "STALE_APPLICABLE_PRODUCT_TREE");
  assert.equal(manifest.acceptedEvidence.browserA11y.coverageOfProductTree.currentCandidateCommit,
    manifest.candidateCommit);
  assert.equal(manifest.acceptedEvidence.browserA11y.formalPerformanceVerdict,
    "INDETERMINATE_PROFILE_UNDERSPECIFIED_FAIL_CLOSED");
  assert.equal(manifest.acceptedEvidence.browserA11y.releaseBoundary,
    "NAMED_MACOS_PATHS_ONLY_NEEDS_REVIEW");
  assert.equal(manifest.acceptedEvidence.inventory.commit,
    "7f1f2396133235b38e9f2beaee5df588d17f9b0d");
  assert.equal(manifest.acceptedEvidence.inventory.testedInputCommit,
    "1cc1615cd9c05ed515711dcd50f5aff62b4238db");
  assert.equal(manifest.acceptedEvidence.inventory.inventoryGeneratedCandidateCommit,
    "1cc1615cd9c05ed515711dcd50f5aff62b4238db");
  assert.equal(manifest.acceptedEvidence.inventory.fullRepositoryCandidateCoverage, false);
  assert.equal(manifest.acceptedEvidence.inventory.currentCandidateCoverage, false);
  assert.equal(manifest.acceptedEvidence.inventory.coverageScope, "STALE_APPLICABLE_PRODUCT_TREE");
  assert.equal(manifest.acceptedEvidence.inventory.coverageOfProductTree.currentCandidateCommit,
    manifest.candidateCommit);
  assert.equal(manifest.acceptedEvidence.inventory.coverageOfProductTree.kind,
    "STALE_APPLICABLE_PRODUCT_TREE");
  assert.deepEqual(manifest.acceptedEvidence.browserA11y.coverageOfProductTree.entries
    .filter((entry) => !entry.matches).map((entry) => entry.path), ["apps/web", "services/api"]);
  assert.deepEqual(manifest.acceptedEvidence.inventory.coverageOfProductTree.entries
    .filter((entry) => !entry.matches).map((entry) => entry.path), [
      "apps/web", "infra/integration/book-lab", "packages/book-lab-web", "packages/book-renderer", "services/api",
      "services/book-lab"
    ]);
  assert.equal(manifest.acceptedEvidence.inventory.reviewState, "needs_review");
  assert.equal(manifest.acceptedEvidence.inventory.inventory.sha256,
    "e94ae7afabffd9bde8a88539d56bdaeac56f22ea7e7958b6e9c20dd4c64869f8");
  for (const evidence of [manifest.acceptedEvidence.browserA11y.checksumManifest,
    manifest.acceptedEvidence.browserA11y.chrome, manifest.acceptedEvidence.browserA11y.firefox,
    manifest.acceptedEvidence.inventory.verification, manifest.acceptedEvidence.inventory.inventory,
    manifest.acceptedEvidence.uiActionClosure.machineChecks, manifest.acceptedEvidence.uiActionClosure.browser,
    manifest.acceptedEvidence.uiCopyActionClosure.machineChecks,
    manifest.acceptedEvidence.uiCopyActionClosure.browser,
    manifest.acceptedEvidence.uiCoreStates.machineChecks, manifest.acceptedEvidence.uiCoreStates.browser,
    manifest.acceptedEvidence.publicFoundation.evidence, manifest.acceptedEvidence.smtpOtp.evidence,
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
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.evidence,
    manifest.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkFix.historicalTargetFailure.evidence]) {
    assert.match(evidence.sha256, /^[a-f0-9]{64}$/u);
  }
  const bundleHeads = execFileSync("git", ["bundle", "list-heads", path.join(output, "source.bundle")],
    { encoding: "utf8" });
  assert.match(bundleHeads, new RegExp(`^${manifest.bookCommit} refs/unseen-production-package/book-`, "mu"));

  const envTemplate = await readFile(path.join(repositoryRoot, "config/rc/production.env.example"), "utf8");
  let decoderOverrides = {};
  function renderEnv(overrides = {}) {
    const effective = { ...decoderOverrides, ...overrides };
    const unused = new Set(Object.keys(effective));
    const rendered = envTemplate.split("\n").map((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
      if (!match || !Object.hasOwn(effective, match[1])) return line;
      unused.delete(match[1]);
      return `${match[1]}=${effective[match[1]]}`;
    }).join("\n");
    assert.deepEqual([...unused], []);
    return rendered;
  }

  const decoderRoot = path.join(temporary, "decoder-runtime");
  await mkdir(decoderRoot, { mode: 0o700 });
  async function writeDecoder(program, label = "trusted") {
    const filename = path.join(decoderRoot, `${program}-${label}`);
    const bytes = `#!/bin/sh\nexit 97 # ${program}-${label} must never execute during preflight\n`;
    await writeFile(filename, bytes, { mode: 0o700 });
    await chmod(filename, 0o700);
    return filename;
  }
  async function decoderValues(program, filename) {
    const prefix = `UNSEEN_${program.toUpperCase()}`;
    return {
      [`${prefix}_PATH`]: filename,
      [`${prefix}_SHA256`]: sha256(await readFile(filename))
    };
  }
  const ffmpegPath = await writeDecoder("ffmpeg");
  const ffprobePath = await writeDecoder("ffprobe");
  decoderOverrides = {
    ...await decoderValues("ffmpeg", ffmpegPath),
    ...await decoderValues("ffprobe", ffprobePath)
  };

  const disabledTrap = path.join(temporary, "disabled-acceptance-trap.json");
  await symlink(path.join(temporary, "must-not-be-opened"), disabledTrap);
  const envFile = path.join(temporary, "production.env");
  await writeFile(envFile, renderEnv({ UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_FILE: disabledTrap }), { mode: 0o600 });
  const preflight = spawnSync(process.execPath, [tool, "preflight"], { cwd: repositoryRoot,
    env: { ...process.env, UNSEEN_PRODUCTION_ENV_FILE: envFile }, encoding: "utf8" });
  assert.equal(preflight.status, 2);
  const result = JSON.parse(preflight.stdout.trim());
  assert.equal(result.status, "NO_GO");
  assert.equal(result.productionReady, false);
  assert.equal(result.integrated8C, "a16f7fdda14759429fd22054506f198980805e9d");
  assert.equal(result.featureFlagBookLab, false);
  assert.equal(result.questionProviderConfigured, false);
  assert.equal(result.visibleFactsApproved, false);
  assert.equal(result.factsProviderAcceptanceEnabled, false);
  assert.equal(result.acceptanceValidation, "DISABLED");
  assert.equal(result.acceptanceReceiptRead, false);
  assert.equal(result.providerSecretRead, false);
  assert.equal(result.providerNetworkRequests, 0);
  assert.equal(result.decoderRuntimeValidation, "HASH_BOUND_NOT_EXECUTED");
  assert.equal(result.decoderProcessExecutions, 0);
  assert.equal(result.decoderVersionBuildValidation, "TARGET_ACCEPTANCE_REQUIRED");
  assert.equal(result.decoderNetworkBoundary, "TARGET_ACCEPTANCE_REQUIRED");
  assert.deepEqual(result.decoderRuntime.map(({ program, path: filename }) => [program, filename]), [
    ["ffmpeg", ffmpegPath], ["ffprobe", ffprobePath]
  ]);
  assert.ok(result.decoderRuntime.every(({ executed }) => executed === false));
  assert.deepEqual(result.releaseBlockers, manifest.releaseBlockers);

  async function runEnvironmentCase(label, mutate, { packaged = false, mode = 0o600 } = {}) {
    const filename = path.join(temporary, `environment-${label}.env`);
    await writeFile(filename, mutate(renderEnv()), { mode });
    await chmod(filename, mode);
    return spawnSync(process.execPath, [packaged ? path.join(output, "VERIFY.mjs") : tool, "preflight"], {
      cwd: packaged ? nonGitCwd : repositoryRoot,
      env: { ...process.env, UNSEEN_PRODUCTION_ENV_FILE: filename }, encoding: "utf8"
    });
  }
  const nodeOptions = await runEnvironmentCase("node-options",
    (text) => `${text}\nNODE_OPTIONS=--import=/tmp/attacker.mjs\n`, { packaged: true });
  assert.equal(nodeOptions.status, 1);
  assert.match(nodeOptions.stderr, /production_preflight_env_unknown:NODE_OPTIONS/u);
  const inlineSecret = await runEnvironmentCase("inline-secret",
    (text) => `${text}\nUNSEEN_BOOK_LAB_ETAG_SECRET=must-not-load\n`);
  assert.equal(inlineSecret.status, 1);
  assert.match(inlineSecret.stderr, /production_preflight_inline_secret_forbidden:UNSEEN_BOOK_LAB_ETAG_SECRET/u);
  const duplicate = await runEnvironmentCase("duplicate",
    (text) => `${text}\nUNSEEN_API_HOST=127.0.0.1\n`);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /production_preflight_env_duplicate:UNSEEN_API_HOST/u);
  const control = await runEnvironmentCase("control",
    (text) => text.replace("UNSEEN_API_HOST=127.0.0.1", "UNSEEN_API_HOST=127.0.0.1\t"));
  assert.equal(control.status, 1);
  assert.match(control.stderr, /production_preflight_env_control_invalid/u);
  const wrongDac = await runEnvironmentCase("wrong-dac", (text) => text, { mode: 0o640 });
  assert.equal(wrongDac.status, 1);
  assert.match(wrongDac.stderr, /production_preflight_env_file_permissions_invalid/u);

  const packagedPreflight = spawnSync(process.execPath, [path.join(output, "VERIFY.mjs"), "preflight"], {
    cwd: nonGitCwd,
    env: { ...process.env, UNSEEN_DECODER_ENV_TRAP: "must-not-reach-child",
      UNSEEN_PRODUCTION_ENV_FILE: envFile }, encoding: "utf8"
  });
  assert.equal(packagedPreflight.status, 2, packagedPreflight.stderr);
  assert.equal(JSON.parse(packagedPreflight.stdout).decoderRuntimeValidation, "HASH_BOUND_NOT_EXECUTED");

  let decoderNegativeCases = 0;
  async function runDecoderCase(label, overrides, extraEnv = {}) {
    decoderNegativeCases += 1;
    const filename = path.join(decoderRoot, `${label}.env`);
    await writeFile(filename, renderEnv(overrides), { mode: 0o600 });
    return spawnSync(process.execPath, [tool, "preflight"], { cwd: repositoryRoot,
      env: { ...process.env, UNSEEN_DECODER_ENV_TRAP: "must-not-reach-child", ...extraEnv,
        UNSEEN_PRODUCTION_ENV_FILE: filename }, encoding: "utf8" });
  }

  assert.equal((await runDecoderCase("relative-path", { UNSEEN_FFMPEG_PATH: "ffmpeg" })).status, 1);
  assert.equal((await runDecoderCase("missing-binary",
    { UNSEEN_FFMPEG_PATH: path.join(decoderRoot, "missing-ffmpeg") })).status, 1);
  const linkedDecoder = path.join(decoderRoot, "ffmpeg-link");
  await symlink(ffmpegPath, linkedDecoder);
  assert.equal((await runDecoderCase("symlink", { UNSEEN_FFMPEG_PATH: linkedDecoder })).status, 1);
  const nonExecutable = path.join(decoderRoot, "ffmpeg-nonexec");
  await cp(ffmpegPath, nonExecutable);
  await chmod(nonExecutable, 0o600);
  assert.equal((await runDecoderCase("nonexec", { UNSEEN_FFMPEG_PATH: nonExecutable })).status, 1);
  const writableDecoder = path.join(decoderRoot, "ffmpeg-writable");
  await cp(ffmpegPath, writableDecoder);
  await chmod(writableDecoder, 0o722);
  assert.equal((await runDecoderCase("writable", { UNSEEN_FFMPEG_PATH: writableDecoder })).status, 1);
  assert.equal((await runDecoderCase("binary-hash-drift",
    { UNSEEN_FFMPEG_SHA256: "00".repeat(32) })).status, 1);
  assert.equal((await runDecoderCase("ffprobe-hash-drift",
    { UNSEEN_FFPROBE_SHA256: "00".repeat(32) })).status, 1);
  const replacedDecoder = await writeDecoder("ffmpeg", "replacement-original");
  const replacementValues = await decoderValues("ffmpeg", replacedDecoder);
  await writeFile(replacedDecoder, await readFile(ffmpegPath), { mode: 0o700 });
  await chmod(replacedDecoder, 0o700);
  assert.equal((await runDecoderCase("binary-replacement", replacementValues)).status, 1);

  const shadowRoot = path.join(decoderRoot, "path-shadow");
  const shadowMarker = path.join(decoderRoot, "path-shadow-executed");
  await mkdir(shadowRoot, { mode: 0o700 });
  for (const program of ["ffmpeg", "ffprobe"]) {
    const shadow = path.join(shadowRoot, program);
    await writeFile(shadow, `#!/bin/sh\nprintf shadow > '${shadowMarker}'\nexit 97\n`, { mode: 0o700 });
    await chmod(shadow, 0o700);
  }
  const shadowEnv = path.join(decoderRoot, "path-shadow.env");
  await writeFile(shadowEnv, renderEnv(), { mode: 0o600 });
  const shadowResult = spawnSync(process.execPath, [tool, "preflight"], { cwd: repositoryRoot,
    env: { ...process.env, PATH: shadowRoot, UNSEEN_PRODUCTION_ENV_FILE: shadowEnv }, encoding: "utf8" });
  assert.equal(shadowResult.status, 2, shadowResult.stderr);
  await assert.rejects(readFile(shadowMarker), { code: "ENOENT" });

  let maliciousListenerRequests = 0;
  const listener = createServer((request, response) => {
    maliciousListenerRequests += 1;
    response.writeHead(204).end();
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const listenerPort = listener.address().port;
  const maliciousMarker = path.join(decoderRoot, "malicious-executed");
  const maliciousDecoder = path.join(decoderRoot, "ffmpeg-malicious-hash-matched");
  await writeFile(maliciousDecoder, `#!/bin/sh\nprintf executed > '${maliciousMarker}'\n` +
    `/usr/bin/curl --silent --max-time 1 http://127.0.0.1:${listenerPort}/decoder-probe >/dev/null 2>&1\n` +
    "exit 0\n", { mode: 0o700 });
  await chmod(maliciousDecoder, 0o700);
  const maliciousEnv = path.join(decoderRoot, "malicious.env");
  await writeFile(maliciousEnv, renderEnv(await decoderValues("ffmpeg", maliciousDecoder)), { mode: 0o600 });
  const maliciousResult = spawnSync(process.execPath, [path.join(output, "VERIFY.mjs"), "preflight"], {
    cwd: nonGitCwd, env: { ...process.env, UNSEEN_PRODUCTION_ENV_FILE: maliciousEnv }, encoding: "utf8"
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  assert.equal(maliciousResult.status, 2, maliciousResult.stderr);
  assert.equal(JSON.parse(maliciousResult.stdout).decoderProcessExecutions, 0);
  await assert.rejects(readFile(maliciousMarker), { code: "ENOENT" });
  assert.equal(maliciousListenerRequests, 0);

  const acceptanceRoot = path.join(temporary, "acceptance");
  await mkdir(acceptanceRoot, { mode: 0o700 });
  const providerSecret = path.join(acceptanceRoot, "provider.secret");
  await writeFile(providerSecret, "synthetic-structure-only\n", { mode: 0o600 });
  const legalReceiptSha256 = "77".repeat(32);
  const now = Date.now();
  const receipt = {
    schema: "unseen-core-facts-question-provider-acceptance/1",
    status: "STRUCTURE_ONLY",
    candidateCommit: manifest.candidateCommit,
    accepted8CCommit: "a16f7fdda14759429fd22054506f198980805e9d",
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    visibleFacts: {
      schemaId: "unseen-visible-facts/1",
      photoId: "photo-structure-01",
      contentHash: "11".repeat(32),
      placementSnapshotHash: "22".repeat(32),
      factsHash: "33".repeat(32),
      policyHash: "44".repeat(32),
      approvalVersion: "facts-policy-v1",
      currentness: "current",
      revokedAt: null
    },
    provider: {
      adapterProtocolId: "unseen-question-provider/1",
      endpoint: "https://api.openai.com/",
      region: "external-region-1",
      modelVersion: "structure-model-v1",
      promptHash: "55".repeat(32),
      policyHash: "66".repeat(32),
      timeoutMs: 10_000,
      requestMaxBytes: 65_536,
      responseMaxBytes: 65_536,
      tlsMinimum: "TLSv1.3",
      redirectPolicy: "deny",
      dnsPolicy: "public_dns_only",
      egressPolicy: "exact_https_endpoint_only",
      secretFile: providerSecret
    },
    legalReceiptSha256
  };

  async function runAcceptance(label, value = receipt, options = {}) {
    const receiptPath = path.join(acceptanceRoot, `${label}.json`);
    const bytes = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
    if (options.symlinkReceipt) {
      const target = path.join(acceptanceRoot, `${label}.target.json`);
      await writeFile(target, bytes, { mode: 0o600 });
      await symlink(target, receiptPath);
    } else if (!options.missingReceipt) {
      await writeFile(receiptPath, bytes, { mode: options.receiptMode ?? 0o600 });
      await chmod(receiptPath, options.receiptMode ?? 0o600);
    }
    const caseEnv = path.join(acceptanceRoot, `${label}.env`);
    await writeFile(caseEnv, renderEnv({
      UNSEEN_CORE_FACTS_PROVIDER_ENABLED: "true",
      UNSEEN_PRODUCTION_CANDIDATE_COMMIT: options.candidateCommit ?? manifest.candidateCommit,
      UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_FILE: receiptPath,
      UNSEEN_CORE_FACTS_PROVIDER_ACCEPTANCE_SHA256: options.expectedHash ?? sha256(bytes),
      UNSEEN_LEGAL_PRIVACY_APPROVAL_SHA256: options.legalHash ?? legalReceiptSha256
    }), { mode: 0o600 });
    return spawnSync(process.execPath, [tool, "preflight"], { cwd: repositoryRoot,
      env: { ...process.env, UNSEEN_PRODUCTION_ENV_FILE: caseEnv }, encoding: "utf8" });
  }

  const structureOnly = await runAcceptance("structure-only");
  assert.equal(structureOnly.status, 2, structureOnly.stderr);
  const structureResult = JSON.parse(structureOnly.stdout.trim());
  assert.equal(structureResult.status, "NO_GO");
  assert.equal(structureResult.productionReady, false);
  assert.equal(structureResult.questionProviderConfigured, false);
  assert.equal(structureResult.visibleFactsApproved, false);
  assert.equal(structureResult.factsProviderAcceptanceEnabled, true);
  assert.equal(structureResult.acceptanceValidation, "STRUCTURE_ONLY");
  assert.equal(structureResult.acceptanceReceiptRead, true);
  assert.equal(structureResult.providerSecretRead, false);
  assert.equal(structureResult.providerNetworkRequests, 0);

  const mutations = [
    ["missing-key", (copy) => { delete copy.schema; }],
    ["extra-key", (copy) => { copy.extra = true; }],
    ["candidate", (copy) => { copy.candidateCommit = "88".repeat(32); }],
    ["accepted-8c", (copy) => { copy.accepted8CCommit = "99".repeat(32); }],
    ["expired", (copy) => { copy.expiresAt = new Date(now - 1_000).toISOString(); }],
    ["currentness", (copy) => { copy.visibleFacts.currentness = "stale"; }],
    ["revoked", (copy) => { copy.visibleFacts.revokedAt = new Date(now - 1_000).toISOString(); }],
    ["facts-schema", (copy) => { copy.visibleFacts.schemaId = "unseen-visible-facts/2"; }],
    ["facts-hash", (copy) => { copy.visibleFacts.factsHash = "malformed"; }],
    ["http", (copy) => { copy.provider.endpoint = "http://api.openai.com/"; }],
    ["userinfo", (copy) => { copy.provider.endpoint = "https://user@api.openai.com/"; }],
    ["query", (copy) => { copy.provider.endpoint = "https://api.openai.com/?x=1"; }],
    ["fragment", (copy) => { copy.provider.endpoint = "https://api.openai.com/#x"; }],
    ["private-ip", (copy) => { copy.provider.endpoint = "https://10.0.0.1/"; }],
    ["loopback-ip", (copy) => { copy.provider.endpoint = "https://127.0.0.1/"; }],
    ["redirect", (copy) => { copy.provider.redirectPolicy = "follow"; }],
    ["tls", (copy) => { copy.provider.tlsMinimum = "TLSv1.2"; }],
    ["dns", (copy) => { copy.provider.dnsPolicy = "system_default"; }],
    ["egress", (copy) => { copy.provider.egressPolicy = "any_https"; }],
    ["secret-path", (copy) => { copy.provider.secretFile = "relative.secret"; }],
    ["placeholder", (copy) => { copy.provider.modelVersion = "REQUIRED_MODEL"; }]
  ];
  for (const [label, mutate] of mutations) {
    const copy = structuredClone(receipt);
    mutate(copy);
    const rejected = await runAcceptance(label, copy);
    assert.equal(rejected.status, 1, `${label}:${rejected.stdout}:${rejected.stderr}`);
  }
  assert.equal((await runAcceptance("malformed-json", "{")).status, 1);
  assert.equal((await runAcceptance("REQUIRED_receipt", receipt)).status, 1);
  assert.equal((await runAcceptance("package-candidate", receipt,
    { candidateCommit: "00".repeat(20) })).status, 1);
  assert.equal((await runAcceptance("hash-mismatch", receipt, { expectedHash: "00".repeat(32) })).status, 1);
  assert.equal((await runAcceptance("legal-binding", receipt, { legalHash: "00".repeat(32) })).status, 1);
  assert.equal((await runAcceptance("missing-receipt", receipt, { missingReceipt: true })).status, 1);
  assert.equal((await runAcceptance("receipt-symlink", receipt, { symlinkReceipt: true })).status, 1);
  assert.equal((await runAcceptance("receipt-permissions", receipt, { receiptMode: 0o644 })).status, 1);

  const missingSecretReceipt = structuredClone(receipt);
  missingSecretReceipt.provider.secretFile = path.join(acceptanceRoot, "missing.secret");
  assert.equal((await runAcceptance("missing-secret", missingSecretReceipt)).status, 1);
  const looseSecret = path.join(acceptanceRoot, "loose.secret");
  await writeFile(looseSecret, "synthetic\n", { mode: 0o644 });
  await chmod(looseSecret, 0o644);
  const looseSecretReceipt = structuredClone(receipt);
  looseSecretReceipt.provider.secretFile = looseSecret;
  assert.equal((await runAcceptance("secret-permissions", looseSecretReceipt)).status, 1);
  const secretTarget = path.join(acceptanceRoot, "secret.target");
  const secretLink = path.join(acceptanceRoot, "secret.link");
  await writeFile(secretTarget, "synthetic\n", { mode: 0o600 });
  await symlink(secretTarget, secretLink);
  const linkedSecretReceipt = structuredClone(receipt);
  linkedSecretReceipt.provider.secretFile = secretLink;
  assert.equal((await runAcceptance("secret-symlink", linkedSecretReceipt)).status, 1);

  const databasePath = path.join(temporary, "data", "unseen.sqlite");
  await mkdir(path.dirname(databasePath), { mode: 0o700 });
  const database = openDatabase(databasePath);
  const expected = (await readdir(path.join(repositoryRoot, "services/api/db/migrations")))
    .filter((name) => name.endsWith(".sql")).sort().map((name) => name.slice(0, -4));
  assert.deepEqual(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    .map((row) => row.version), expected);
  database.close();
  const reopened = openDatabase(databasePath);
  assert.deepEqual(reopened.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    .map((row) => row.version), expected);
  assert.equal(Object.values(reopened.prepare("PRAGMA quick_check").get())[0], "ok");
  reopened.close();

  const missingRequiredOutput = path.join(temporary, "missing-required-release");
  await cp(output, missingRequiredOutput, { recursive: true });
  const missingManifestPath = path.join(missingRequiredOutput, "PACKAGE-MANIFEST.json");
  const missingManifest = JSON.parse(await readFile(missingManifestPath, "utf8"));
  missingManifest.artifacts = missingManifest.artifacts.filter((entry) => entry.path !== "README.md");
  await writeFile(missingManifestPath, `${JSON.stringify(missingManifest, null, 2)}\n`, { mode: 0o600 });
  await rm(path.join(missingRequiredOutput, "README.md"));
  const missingRequired = spawnSync(process.execPath, [path.join(missingRequiredOutput, "VERIFY.mjs"), "verify"], {
    env: { ...process.env, UNSEEN_PRODUCTION_PACKAGE_DIR: missingRequiredOutput }, encoding: "utf8" });
  assert.notEqual(missingRequired.status, 0);
  assert.match(missingRequired.stderr, /production_package_artifacts_invalid/u);

  const byteTamperedOutput = path.join(temporary, "byte-tampered-release");
  await cp(output, byteTamperedOutput, { recursive: true });
  const tamperedReadme = path.join(byteTamperedOutput, "README.md");
  await writeFile(tamperedReadme, `${await readFile(tamperedReadme, "utf8")}tampered\n`, { mode: 0o600 });
  const byteTampered = spawnSync(process.execPath, [path.join(byteTamperedOutput, "VERIFY.mjs"), "verify"], {
    env: { ...process.env, UNSEEN_PRODUCTION_PACKAGE_DIR: byteTamperedOutput }, encoding: "utf8" });
  assert.notEqual(byteTampered.status, 0);
  assert.match(byteTampered.stderr, /production_package_byte_mismatch/u);

  async function semanticMutation(label, artifact, mutate, expectedError) {
    const mutatedOutput = path.join(temporary, `semantic-${label}`);
    await cp(output, mutatedOutput, { recursive: true });
    const artifactPath = path.join(mutatedOutput, artifact);
    const mutatedText = mutate(await readFile(artifactPath, "utf8"));
    await writeFile(artifactPath, mutatedText, { mode: 0o600 });
    await chmod(artifactPath, 0o600);
    const manifestPath = path.join(mutatedOutput, "PACKAGE-MANIFEST.json");
    const mutatedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const record = mutatedManifest.artifacts.find((entry) => entry.path === artifact);
    assert.ok(record, `${label}:artifact_missing`);
    record.bytes = Buffer.byteLength(mutatedText);
    record.sha256 = sha256(Buffer.from(mutatedText));
    await writeFile(manifestPath, `${JSON.stringify(mutatedManifest, null, 2)}\n`, { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const result = spawnSync(process.execPath, [path.join(mutatedOutput, "VERIFY.mjs"), "verify"], {
      env: { ...process.env, UNSEEN_PRODUCTION_PACKAGE_DIR: mutatedOutput }, encoding: "utf8" });
    assert.notEqual(result.status, 0, `${label}:unexpected_pass`);
    assert.match(result.stderr, expectedError, label);
  }

  async function manifestSemanticMutation(label, mutate, expectedError) {
    const mutatedOutput = path.join(temporary, `manifest-semantic-${label}`);
    await cp(output, mutatedOutput, { recursive: true });
    const manifestPath = path.join(mutatedOutput, "PACKAGE-MANIFEST.json");
    const mutatedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    mutate(mutatedManifest);
    await writeFile(manifestPath, `${JSON.stringify(mutatedManifest, null, 2)}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [path.join(mutatedOutput, "VERIFY.mjs"), "verify"], {
      env: { ...process.env, UNSEEN_PRODUCTION_PACKAGE_DIR: mutatedOutput }, encoding: "utf8" });
    assert.notEqual(result.status, 0, `${label}:unexpected_pass`);
    assert.match(result.stderr, expectedError, label);
  }

  await manifestSemanticMutation("renderer-browser-dangling-policy-field", (value) => {
    value.acceptedEvidence.rendererSnapAdapter.canonicalDanglingSymlinkPolicySha256 = "0".repeat(64);
  }, /production_package_renderer_snap_adapter_evidence_invalid/u);
  await manifestSemanticMutation("renderer-browser-dangling-reachability-field", (value) => {
    value.acceptedEvidence.rendererSnapAdapter.runtimeReachability = "REACHABLE";
  }, /production_package_renderer_snap_adapter_evidence_invalid/u);

  await semanticMutation("legacy-alias", "unseen.service.example",
    (text) => text.replace("/opt/unseen/releases/REQUIRED_IMMUTABLE_RELEASE_COMMIT", "/opt/unseen/core"),
    /production_package_legacy_active_release_alias/u);
  await semanticMutation("missing-marker", "unseen.service.example",
    (text) => text.replace("REQUIRED_IMMUTABLE_RELEASE_COMMIT", "a".repeat(40)),
    /production_package_release_marker_missing/u);
  await semanticMutation("api-unit-dangerous-env-unset", "unseen.service.example",
    (text) => text.replace("UnsetEnvironment=NODE_OPTIONS ", "UnsetEnvironment="),
    /production_package_service_env_boundary_invalid/u);
  await semanticMutation("api-unit-preflight-env-path", "unseen.service.example",
    (text) => text.replace("preflight /etc/unseen/production.env", "preflight /tmp/attacker.env"),
    /production_package_service_env_boundary_invalid/u);
  await semanticMutation("renderer-cups-gate", "README.md",
    (text) => text.replace("BOTH_NOT_FOUND_RC4_OR_BOTH_INSTALLED_INACTIVE_DISABLED_MASKED_AND_ZERO_LISTENERS",
      "ANY_INACTIVE_STATE"), /production_package_renderer_cups_contract_invalid/u);
  await semanticMutation("renderer-node-usr-bin", "unseen-book-renderer.service.example",
    (text) => text.replace("/opt/unseen/runtime/node-v22.23.2-linux-x64/bin/node", "/usr/bin/node"),
    /production_package_renderer_node_runtime_contract_invalid/u);
  await semanticMutation("renderer-node-path-lookup", "unseen-book-renderer.service.example",
    (text) => text.replace("ExecStart=/opt/unseen/runtime/node-v22.23.2-linux-x64/bin/node",
      "Environment=PATH=/tmp\nExecStart=/usr/bin/env node"),
    /production_package_renderer_node_runtime_contract_invalid/u);
  await semanticMutation("renderer-node-checksum-preflight", "unseen-book-renderer.service.example",
    (text) => text.replace("/run/unseen/approvals/node-runtime.sha256", "/tmp/node-runtime.sha256"),
    /production_package_renderer_node_runtime_contract_invalid/u);
  await semanticMutation("renderer-node-archive-pin", "README.md",
    (text) => text.replace("node_archive_sha=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
      `node_archive_sha=${"0".repeat(64)}`),
    /production_package_renderer_node_runtime_contract_invalid/u);
  await semanticMutation("renderer-node-bwrap-mount", "README.md",
    (text) => text.replace(",\\\"$node_runtime_root\\\"]", "]"),
    /production_package_renderer_node_runtime_contract_invalid/u);
  await semanticMutation("renderer-browser-current-alias", "README.md",
    (text) => text.replace('numeric_snap_root="/snap/chromium/3507"',
      'numeric_snap_root="/snap/chromium/current"'),
    /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-license-go", "README.md",
    (text) => text.replace("releaseDecision=NO_GO_LICENSE_AND_SECURITY_REVIEW_REQUIRED",
      "releaseDecision=GO"), /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-same-count-tree-drift", "README.md",
    (text) => text.replace("7e3c4a35732680526d72c725face4b2fd09fa984524d5b37a2e4f4a940705913",
      "0".repeat(64)), /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-same-count-resource-drift", "README.md",
    (text) => text.replace("f557978f70848227c01dfd4484110c1e24492d82f5e6becb61aa4b8b6c6285a5",
      "0".repeat(64)), /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-snap-cache-policy-drift", "README.md",
    (text) => text.replace("49d8cec790a4cb3c6abfaf589bc6d37b8dc5e9ae007d0afbb8dc06f8b8aceac5",
      "0".repeat(64)), /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-dangling-policy-drift", "README.md",
    (text) => text.replace("3c3f99c6d62feffb90a873bc245930045a1e42bdc0c3b1e5c2a763208586b128",
      "0".repeat(64)), /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-dangling-absolute-target-drift", "README.md",
    (text) => text.replace("usr/bin/xdg-email -> /usr/bin/xdg-open", "usr/bin/xdg-email -> /usr/bin/other"),
    /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-dangling-relative-target-drift", "README.md",
    (text) => text.replace("usr/share/groff/site-tmac -> ../../../etc/groff",
      "usr/share/groff/site-tmac -> ../../../etc/other"),
  /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-dangling-resolution-weakened", "README.md",
    (text) => text.replace("unresolved with exact `ENOENT`", "unresolved or present"),
    /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-dangling-source-metadata-weakened", "README.md",
    (text) => text.replace("exact root:root mode 0777 with nlink 1", "exact root:gid12 mode 0777 with nlink 1"),
    /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-dangling-source-hashes-weakened", "README.md",
    (text) => text.replace("path and target SHA-256", "target names"),
    /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-dangling-reachability-weakened", "README.md",
    (text) => text.replace("runtimeReachability=ABSENT_NOT_IN_ARGV_RESOURCE_OR_LOADER_CLOSURE",
      "runtimeReachability=REACHABLE"), /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("renderer-browser-snap-cache-path-drift", "README.md",
    (text) => text.replace("/var/lib/snapd/cache/77155504d7c5fdfa516545da086bd3f31fa6f6283901e93885cbb39366ae55bea" +
      "834c4042bebfc870a0330904df04c07", "/var/lib/snapd/cache/wrong"),
  /production_package_renderer_browser_adapter_contract_invalid/u);
  await semanticMutation("suffix-collision", "production.env.example",
    (text) => text.replace("REQUIRED_IMMUTABLE_RELEASE_COMMIT", "REQUIRED_CANDIDATE_COMMIT"),
    /production_package_release_marker_missing/u);
  await semanticMutation("sealed-backup-mode", "README.md",
    (text) => text.replace("install -o root -g root -m 0600 /etc/caddy/Caddyfile",
      "install -o root -g caddy -m 0640 /etc/caddy/Caddyfile"),
    /production_package_caddy_permission_contract_invalid:production/u);
  await semanticMutation("live-install-mode", "README.md",
    (text) => text.replaceAll("install -o root -g caddy -m 0640", "install -o root -g root -m 0600"),
    /production_package_caddy_permission_contract_invalid:production/u);
  await semanticMutation("rollback-live-mode", "README.md", (text) => {
    const needle = "install -o root -g caddy -m 0640";
    const index = text.lastIndexOf(needle);
    assert.notEqual(index, -1);
    return `${text.slice(0, index)}install -o root -g root -m 0600${text.slice(index + needle.length)}`;
  }, /production_package_caddy_permission_contract_invalid:production/u);
  await semanticMutation("generic-caddy", "Caddyfile.example",
    (text) => text.replace("@private_ai path /__internal/private-ai/v1/*", "@private_ai_disabled path /disabled/*"),
    /production_package_caddy_template_invalid/u);
  await semanticMutation("production-outer-basic-auth", "Caddyfile.example",
    (text) => text.replace("\thandle {\n\t\treverse_proxy", "\thandle {\n\t\tbasicauth {\n" +
      "\t\t\tREQUIRED_BASIC_AUTH_USERNAME REQUIRED_BCRYPT_HASH\n\t\t}\n\t\treverse_proxy"),
    /production_package_caddy_template_invalid/u);
  await semanticMutation("production-global-csp", "Caddyfile.example",
    (text) => text.replace("\t\tStrict-Transport-Security \"max-age=31536000\"",
      "\t\tStrict-Transport-Security \"max-age=31536000\"\n" +
      "\t\tContent-Security-Policy \"default-src 'none'\""),
    /production_package_caddy_template_invalid/u);

  await writeFile(path.join(output, "unexpected.txt"), "not declared\n", { mode: 0o600 });
  const tampered = spawnSync(process.execPath, [path.join(output, "VERIFY.mjs"), "verify"], {
    env: { ...process.env, UNSEEN_PRODUCTION_PACKAGE_DIR: output }, encoding: "utf8" });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /production_package_files_invalid/u);

  const freshClone = path.join(temporary, "fresh-clone");
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", repositoryRoot, freshClone]);
  assert.equal(execFileSync("git", ["status", "--porcelain"],
    { cwd: freshClone, encoding: "utf8" }), "");
  const firstDetach = detachAndDeleteLocalBranch(freshClone);
  if (firstDetach.branchDeleted) {
    const localBranches = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { cwd: freshClone, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    assert.equal(localBranches.includes(firstDetach.branch), false);
  }
  const alreadyDetached = detachAndDeleteLocalBranch(freshClone);
  assert.deepEqual(alreadyDetached, { branchDeleted: false, branch: null });
  assert.equal(execFileSync("git", ["branch", "--show-current"],
    { cwd: freshClone, encoding: "utf8" }).trim(), "");
  const freshBookRefs = execFileSync("git", ["for-each-ref", "--contains", manifest.bookCommit,
    "--format=%(refname)", "refs/heads", "refs/remotes"], { cwd: freshClone, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  assert.ok(freshBookRefs.length > 0 && freshBookRefs.every((ref) => ref.startsWith("refs/remotes/")));
  const freshOutput = path.join(temporary, "fresh-clone-release");
  const freshBuilt = JSON.parse(execFileSync(process.execPath,
    [path.join(freshClone, "infra/integration/production-package.mjs"), "build"], { cwd: freshClone,
      env: { ...process.env, UNSEEN_PRODUCTION_PACKAGE_DIR: freshOutput }, encoding: "utf8" }).trim());
  assert.equal(freshBuilt.status, "PRODUCTION_PACKAGE_CREATED");
  process.stdout.write(`${JSON.stringify({ schema: "unseen-production-package-verification/1", status: "PASS",
    candidateCommit: manifest.candidateCommit, releaseClaim: manifest.releaseClaim,
    portableBundleVerified: true, standaloneNonGitCwdVerified: true, exactBookCommitBundled: true,
    missingRequiredArtifactRejected: true, byteTamperRejected: true,
    legacyActiveAliasRejected: true, releaseMarkerMissingRejected: true,
    markerSuffixCollisionRejected: true, renderedUnitAndEnvExactCommitBound: true,
    sealedBackupModeRejected: true, liveCaddyModeRejected: true, rollbackCaddyModeRejected: true,
    packagedCaddyBoundaryRejectedWhenTampered: true,
    productionOuterBasicAuthRejected: true, productionGlobalCspRejected: true,
    productionApplicationAuthAndCspBoundaryBound: true,
    extraFileRejected: true, freshCloneRemoteOnlyRefs: true, standardFreshCloneBuilt: true,
    detachedHeadBranchDeleteSkipped: true,
    productionPreflight: "NO_GO",
    integrated8CProfileVerified: true, stagingFixtureSeparated: true,
    acceptedUiV2Bound: true, acceptedUiActionClosureBound: true, acceptedUiCopyActionClosureBound: true,
    acceptedUiCoreStatesBound: true,
    uiActionClosureProductionInput: false, uiCopyActionClosureProductionInput: false,
    uiCopyActionVisibleControls: 44,
    uiCopyActionCoreEmptyErrorBranches: "DETERMINISTIC_FIXTURE_BROWSER_EVIDENCE",
    uiCoreStatesTestOnlyCases: 12, uiCoreStatesProductionFaultCoverage: false,
    uiCoreStatesProductionInput: false, uiCoreStatesProductBytesChanged: false,
    acceptedPublicFoundationBound: true, acceptedSmtpOtpDefaultOffBound: true,
    acceptedQuestionProviderOfflineBound: true, acceptedPrivateWorkerTestProofBound: true,
    acceptedPrivateAiQueueDefaultOffBound: true, acceptedPrivateAiTransportDefaultOffBound: true,
    acceptedBookPrivateFactsBound: true, acceptedPrivateAiCompositionDefaultOffBound: true,
    acceptedPrivateAiQueuedUiDeterministicBrowserEvidenceBound: true,
    acceptedPrivateAiCaddyBodyCapCodeOnlyBound: true,
    historicalRejectedShadowTransportPreserved: true,
    acceptedDeploymentContractCodeOnlyBound: true,
    historicalRejectedDeploymentEvidenceSuperseded: true,
    historicalDeploymentFailureP1FixedCodeOnlyNotDeployed: true,
    acceptedBrowserA11yStaleProductTreeBound: true,
    acceptedInventoryStaleProductTreeBound: true, inventoryReviewState: "needs_review",
    browserCurrentCandidateProductTreeCoverage: false, inventoryCurrentCandidateProductTreeCoverage: false,
    postEvidenceCandidateBrowserExecuted: false, fullRepositoryInventoryCoverage: false,
    smtpOtpDefaultEnabled: false, smtpOtpDeployableUnderCurrentPrivateBetaUnit: false,
    questionProviderCapabilityExposed: true, productionQuestionProviderConfigured: false,
    productionVisibleFactsApproved: false, privateWorkerEvidenceClass: "PRIVATE_TEST_PROOF",
    privateWorkerProductionTransport: false, privateWorkerFactsExtraction: false,
    disabledAcceptanceFileReads: 0, disabledProviderSecretReads: 0, providerNetworkRequests: 0,
    decoderRuntimeValidation: "HASH_BOUND_NOT_EXECUTED", decoderProcessExecutions: 0,
    decoderVersionBuildValidation: "TARGET_ACCEPTANCE_REQUIRED",
    decoderNetworkBoundary: "TARGET_ACCEPTANCE_REQUIRED",
    absoluteDecoderPaths: true, decoderPathFallbackRejected: true, decoderSymlinkRejected: true,
    decoderNonExecutableRejected: true, decoderBinaryHashBound: true,
    decoderPathShadowRejected: true, decoderBinaryReplacementRejected: true,
    hashMatchedMaliciousBinaryNotExecuted: true, maliciousBinaryMarkerAbsent: true,
    maliciousListenerRequests, decoderNegativeCases,
    strictFactsProviderReceipt: true, structureOnlyReceiptCannotRelease: true,
    acceptanceNegativeCases: mutations.length + 11,
    databaseInitialization: true, orderedMigrations: expected.length, migrationReopenIdempotent: true,
    sqliteQuickCheck: "ok", externalNetworkRequests: 0 })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
