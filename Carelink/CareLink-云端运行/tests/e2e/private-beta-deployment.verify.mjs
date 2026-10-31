import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const releaseMarker = "REQUIRED_IMMUTABLE_RELEASE_COMMIT";
const releaseRoot = "/opt/unseen/releases";
const exactKeys = (value, keys, label) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}:object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label}:keys`);
};

function renderUnit(template, expectedWorkingDirectory, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/u, "candidate_commit_invalid");
  assert.equal((template.match(new RegExp(releaseMarker, "gu")) ?? []).length, 1, "release_marker_missing");
  assert.doesNotMatch(template, /WorkingDirectory=\/opt\/unseen\/core/u, "legacy_release_alias");
  const rendered = template.replace(releaseMarker, commit);
  assert.doesNotMatch(rendered, /REQUIRED_IMMUTABLE_RELEASE_COMMIT|\/opt\/unseen\/core/u,
    "release_render_incomplete");
  assert.match(rendered, new RegExp(`^WorkingDirectory=${expectedWorkingDirectory}$`, "mu"));
  return rendered;
}

function assertActiveRelease(binding) {
  assert.equal(binding.activeState, "active", "active_state_mismatch");
  for (const process of [binding.api, binding.web]) {
    assert.ok(Number.isSafeInteger(process.mainPid) && process.mainPid > 0, "main_pid_invalid");
    assert.match(process.controlGroup, /^\/system\.slice\/[a-z0-9@_.-]+\.service$/u,
      "control_group_invalid");
    assert.equal(process.procControlGroup, process.controlGroup, "process_cgroup_mismatch");
    assert.equal(process.unitWorkingDirectory, process.procCwd, "process_cwd_mismatch");
  }
  assert.equal(binding.api.procCwd, binding.releaseDirectory, "api_release_mismatch");
  assert.equal(binding.web.procCwd, `${binding.releaseDirectory}/apps/web`, "web_release_mismatch");
  assert.equal(binding.head, binding.expectedCommit, "release_head_mismatch");
  assert.equal(binding.tree, binding.expectedTree, "release_tree_mismatch");
  assert.equal(binding.detached, true, "release_not_detached");
  assert.equal(binding.clean, true, "release_dirty");
}

function verifyCaddyPermissionContract(text) {
  assert.match(text, /install -o root -g root -m 0600 \/etc\/caddy\/Caddyfile/u,
    "sealed_backup_mode_invalid");
  assert.ok((text.match(/install -o root -g caddy -m 0640/gu) ?? []).length >= 2,
    "live_or_rollback_mode_invalid");
  assert.match(text, /getent group caddy/u, "caddy_group_unchecked");
  assert.match(text, /sudo -u caddy test -r \/etc\/caddy\/Caddyfile/u,
    "caddy_service_read_unchecked");
  assert.match(text, /systemctl reload caddy/u, "caddy_reload_missing");
}

function verifyMigrationContract(text) {
  assert.match(text, /exactly 10 migrations/u, "migration_count_copy_invalid");
  assert.doesNotMatch(text, /all nine migrations/u, "stale_migration_count");
  assert.ok(text.includes("test \"$(sudo -u unseen sqlite3 /var/lib/unseen/private-beta/core-data/unseen.sqlite") &&
    text.includes("'PRAGMA quick_check;')\" = ok"), "migration_quick_check_not_fail_closed");
  assert.ok(text.includes("'SELECT count(*) FROM schema_migrations;')\" -eq 10"),
    "migration_count_not_fail_closed");
}

function replaceLast(text, search, replacement) {
  const index = text.lastIndexOf(search);
  assert.notEqual(index, -1);
  return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
}

const [evidenceText, env, apiUnit, webUnit, caddy, status, runbook] = await Promise.all([
  read("release-evidence/r0/private-beta/PUBLIC-FOUNDATION.json"),
  read("config/rc/private-beta.env.example"),
  read("infra/integration/private-beta-deployment/unseen-private-beta-api.service"),
  read("infra/integration/private-beta-deployment/unseen-private-beta-web.service"),
  read("infra/integration/private-beta-deployment/Caddyfile"),
  read("infra/integration/private-beta-deployment/status.html"),
  read("runbooks/release/PRIVATE-BETA-DEPLOYMENT.md")
]);
const evidence = JSON.parse(evidenceText);

exactKeys(evidence, ["schema", "kind", "observedAt", "claimBoundary", "package", "target", "runtime",
  "smoke", "networkBoundary", "core", "backup", "openP1", "nonClaims", "claudeReview"], "evidence");
assert.equal(evidence.schema, "unseen-private-beta-public-foundation/1");
assert.equal(evidence.kind, "TARGET_OBSERVATION_NOT_PRODUCTION_ACCEPTANCE");
assert.deepEqual(evidence.claimBoundary, {
  stage5EvidenceBaseCommit: "d3365f3e079c494a02f6dcd38fd0f30266189c97",
  deployedCandidateCommit: "1f66aef3244f59bbf0f65375d7176a63b2ae89db",
  postEvidenceCommitDeployed: false,
  releaseClaim: "NO_GO",
  productionReady: false,
  coreOperableBeta: false,
  fixtureOrFallbackEnabled: false,
  aiProviderEnabled: false,
  bookEnabled: false
});
assert.equal(evidence.core.healthHttpWithApprovedHost, 503);
assert.equal(evidence.core.healthStatus, "degraded");
assert.equal(evidence.core.otpDeliveryConfigured, false);
assert.equal(evidence.core.otpDeliveryReady, false);
assert.equal(evidence.core.otpDeliveryProvider, "unconfigured");
assert.equal(evidence.core.sqliteQuickCheck, "ok");
assert.equal(evidence.core.schemaMigrationCount, 9);
assert.equal(evidence.backup.verify, "PASS");
assert.equal(evidence.backup.alternateTargetRestore, "PASS");
assert.equal(evidence.backup.snapshotDatabaseSha256, evidence.backup.restoredDatabaseSha256);
assert.equal(evidence.backup.restoredTreeOwnedByServiceIdentity, true);
assert.equal(evidence.backup.liveDataOverwritten, false);
assert.deepEqual(evidence.networkBoundary, {
  authorizedTargetNetworkPurposes: [
    "operating_system_package_install",
    "node_runtime_download_and_hash_check",
    "acme_certificate_issuance",
    "dns_tls_and_https_smoke"
  ],
  applicationProviderRequests: 0,
  aiProviderRequests: 0,
  fixtureRequests: 0,
  authorizationHeaderRecorded: false,
  credentialMaterialRecorded: false,
  imageBytesRecorded: false
});
assert.deepEqual(evidence.openP1, [
  "REAL_OTP_DELIVERY_ADAPTER_AND_PROVIDER_CREDENTIAL_REQUIRED_FOR_CORE_OPERABLE_BETA",
  "BOOK_LINUX_DECODER_OPERATOR_EGRESS_ACCEPTANCE_REQUIRED_BEFORE_BOOK_ENABLEMENT"
]);

for (const text of [evidenceText, env, apiUnit, webUnit, caddy, status, runbook]) {
  assert.doesNotMatch(text,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9_-]{16,}\b/u);
}
assert.doesNotMatch(evidenceText, /password|bcrypt|privateKey|credentialValue|secretValue/iu);
assert.match(env, /UNSEEN_BOOK_LAB_ENABLED=false/u);
assert.match(env, /UNSEEN_PRIVATE_AI_WORKER_ENABLED=false/u);
assert.match(env, /UNSEEN_CORE_FACTS_PROVIDER_ENABLED=false/u);
assert.match(env, /UNSEEN_WEB_LOCAL_API=0/u);
assert.match(env, /UNSEEN_WEB_TEST=0/u);
assert.match(env, /UNSEEN_WEB_LOCAL_DETERMINISTIC_LOCATOR=0/u);
assert.match(env, /UNSEEN_WEB_UI_PRODUCTIZATION_FIXTURE=0/u);
assert.doesNotMatch(env, /246810|local_fixture_only/u);

for (const unit of [apiUnit, webUnit]) {
  assert.match(unit, /User=unseen/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /ProtectSystem=strict/u);
  assert.match(unit, /IPAddressDeny=any/u);
  assert.match(unit, /IPAddressAllow=localhost/u);
  assert.doesNotMatch(unit, /0\.0\.0\.0|ExecStartPre=.*production-package.*preflight/u);
}
assert.match(apiUnit, /^WorkingDirectory=\/opt\/unseen\/releases\/REQUIRED_IMMUTABLE_RELEASE_COMMIT$/mu);
assert.match(webUnit,
  /^WorkingDirectory=\/opt\/unseen\/releases\/REQUIRED_IMMUTABLE_RELEASE_COMMIT\/apps\/web$/mu);
const syntheticCommit = "a".repeat(40);
const syntheticTree = "b".repeat(40);
const releaseDirectory = `${releaseRoot}/${syntheticCommit}`;
renderUnit(apiUnit, releaseDirectory, syntheticCommit);
renderUnit(webUnit, `${releaseDirectory}/apps/web`, syntheticCommit);
assert.throws(() => renderUnit(apiUnit.replace(releaseMarker, syntheticCommit), releaseDirectory, syntheticCommit),
  /release_marker_missing/u);
assert.throws(() => renderUnit(apiUnit.replace(`${releaseRoot}/${releaseMarker}`, "/opt/unseen/core"),
  releaseDirectory, syntheticCommit), /release_marker_missing|legacy_release_alias/u);

const activeBinding = {
  activeState: "active", releaseDirectory, expectedCommit: syntheticCommit, expectedTree: syntheticTree,
  api: { mainPid: 101, controlGroup: "/system.slice/unseen-private-beta-api.service",
    procControlGroup: "/system.slice/unseen-private-beta-api.service",
    unitWorkingDirectory: releaseDirectory, procCwd: releaseDirectory },
  web: { mainPid: 102, controlGroup: "/system.slice/unseen-private-beta-web.service",
    procControlGroup: "/system.slice/unseen-private-beta-web.service",
    unitWorkingDirectory: `${releaseDirectory}/apps/web`, procCwd: `${releaseDirectory}/apps/web` },
  head: syntheticCommit, tree: syntheticTree, detached: true, clean: true
};
assert.doesNotThrow(() => assertActiveRelease(activeBinding));
for (const mutate of [
  (value) => { value.api.procCwd = "/opt/unseen/core"; },
  (value) => { value.head = "c".repeat(40); },
  (value) => { value.tree = "d".repeat(40); },
  (value) => { value.clean = false; },
  (value) => { value.web.procControlGroup = "/system.slice/other.service"; }
]) {
  const invalid = structuredClone(activeBinding);
  mutate(invalid);
  assert.throws(() => assertActiveRelease(invalid));
}

verifyCaddyPermissionContract(runbook);
assert.throws(() => verifyCaddyPermissionContract(runbook.replace(
  "install -o root -g root -m 0600 /etc/caddy/Caddyfile",
  "install -o root -g caddy -m 0640 /etc/caddy/Caddyfile")), /sealed_backup_mode_invalid/u);
assert.throws(() => verifyCaddyPermissionContract(replaceLast(runbook,
  "install -o root -g caddy -m 0640", "install -o root -g root -m 0600")),
  /live_or_rollback_mode_invalid/u);
assert.throws(() => verifyCaddyPermissionContract(runbook.replaceAll(
  "sudo -u caddy test -r /etc/caddy/Caddyfile", "test -r /etc/caddy/Caddyfile")),
  /caddy_service_read_unchecked/u);
verifyMigrationContract(runbook);
assert.throws(() => verifyMigrationContract(runbook.replace("-eq 10", "-eq 9")),
  /migration_count_not_fail_closed/u);
assert.throws(() => verifyMigrationContract(runbook.replace("-eq 10", "-eq 11")),
  /migration_count_not_fail_closed/u);
assert.match(caddy, /^REQUIRED_PRIVATE_BETA_DOMAIN \{/u);
assert.match(caddy, /REQUIRED_BASIC_AUTH_USERNAME REQUIRED_BCRYPT_HASH/u);
assert.match(caddy, /Strict-Transport-Security/u);
assert.match(caddy, /Content-Security-Policy/u);
assert.match(caddy, /Cache-Control "private, no-store, max-age=0"/u);
assert.match(caddy, /Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\)"/u);
assert.match(caddy, /X-Robots-Tag "noindex, nofollow"/u);
assert.match(caddy, /@private_ai_body_rejected\s*\{\s*path \/__internal\/private-ai\/v1\/\*\s*method POST\s*expression `\{http\.request\.header\.Content-Length\} == "" \|\| int\(\{http\.request\.header\.Content-Length\}\) > 32768`\s*\}/u);
assert.match(caddy, /handle @private_ai_body_rejected\s*\{\s*header\s*\{\s*Content-Type application\/json\s*X-Unseen-Protocol unseen-private-ai-pull\/1\s*\}\s*respond "" 413\s*\}/u);
assert.match(caddy, /@private_ai path \/__internal\/private-ai\/v1\/\*/u);
assert.match(caddy, /request_body\s*\{\s*max_size 32KiB\s*\}/u);
assert.match(caddy, /reverse_proxy 127\.0\.0\.1:4282/u);
assert.match(caddy, /header_up Host \{host\}/u);
assert.match(caddy, /header_up X-Forwarded-Proto https/u);
assert.ok(caddy.indexOf("handle @private_ai_body_rejected") < caddy.indexOf("handle @private_ai {"));
assert.ok(caddy.indexOf("handle @private_ai {") < caddy.indexOf("basicauth"));
assert.equal((caddy.match(/reverse_proxy/gu) ?? []).length, 1);
assert.doesNotMatch(caddy, /maxxam\.xyz|43\.132\./u);

assert.match(status, /基础入口已上线/u);
assert.match(status, /等待真实邮箱验证码服务接通/u);
assert.match(status, /不使用样本、fixture 或模拟 AI 数据/u);
assert.match(status, /暂未启用，不会用 fallback 代替/u);
assert.doesNotMatch(status, /<a\b|<button\b|<form\b|<script\b|src=|href=/iu);
assert.match(runbook, /not a Core-operable Beta/u);
assert.match(runbook, /has no\s+real `OtpDeliveryPort`/u);
assert.match(runbook, /Track 1B adapter change/u);
assert.match(runbook, /Do not add a local fixed code/u);

process.stdout.write("PRIVATE_BETA_DEPLOYMENT_EVIDENCE_OK\n");
