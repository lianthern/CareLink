# Production unblock handoff

This is an evidence-only handoff for production candidate
`b3145804b4356b1e823783d3f0e9d0b0399bf0ee` (tree
`6a9be92b1615605aca40ec1848bb357bd10760ec`) and private package
`production-b3145804b435`. It does not change the product candidate, rebuild the
package, authenticate an external approval, or make a post-evidence browser,
inventory, final-candidate deployment, provider, or decoder-execution claim.

The package manifest is SHA-256
`568ba3e1f9852f7fba44975bbe49ede107711710b3675e8e7e83e62d15259c03` and
`source.bundle` is SHA-256
`2124249c6224ebc786933f20921660e1647579c819f809bff33a2c5e1c8187cb`.
Its release claim remains `NO_GO`, `productionReady=false`, with exactly these
external blockers:

1. `core_visible_facts_and_question_provider_not_authorized`
2. `legal_privacy_notice_approvals_missing`
3. `final_candidate_deployment_secret_decoder_operator_and_provider_acceptance_missing`

The machine-readable companion is
`release-evidence/r0/PRODUCTION-UNBLOCK-HANDOFF.json`. It is a link and hash
index, not an acceptance receipt; its fixed kind is
`LINK_AND_HASH_INDEX_NOT_ACCEPTANCE_RECEIPT`. Its validator checks only fixed
links, hashes, commands, candidate binding, and the unchanged `NO_GO` boundary.
It never opens an external receipt or secret, performs no network operation,
and does not decide authenticity, legal sufficiency, provider authorization,
or operator authority.

## 1. Core visible facts and question provider

Owner input still required:

- approved visible facts bound to exact `photoId`, content, placement snapshot,
  facts and policy hashes, approval version, currentness, and revocation state;
- the selected real image-understanding model/provider and its authorized real
  production adapter, authentication, endpoint and private secret;
- an authorized real provider declaration bound to an existing adapter protocol,
  one public-DNS HTTPS endpoint, region/model/prompt/policy identity, limits,
  TLS/redirect/DNS/egress policy, and an external private secret file;
- a current receipt bound to this package candidate, accepted 8C
  `a16f7fdda14759429fd22054506f198980805e9d`, and the independently delivered
  Legal/Privacy record SHA-256.

Authoritative existing references:

- `infra/integration/production-package.mjs` implements strict schema
  `unseen-core-facts-question-provider-acceptance/1` and the package preflight;
- `config/rc/production.env.example` names the non-secret configuration and
  private receipt/secret locations;
- `runbooks/release/PRODUCTION-DEPLOYMENT.md` documents the exact fail-closed
  validation boundary;
- `release-evidence/local-operable/stage-rc/PRODUCTION-PACKAGE-ACCEPTANCE-VALIDATOR.json`
  records the structural counterexamples and zero-read/zero-network flag-off
  behavior;
- `release-evidence/book-lab/8c-real-seam/verification.json` records the accepted
  seam and the still-missing production inputs.

After the owner has placed an externally supplied receipt and secret through
the approved private channel, the existing target command is:

```sh
UNSEEN_PRODUCTION_ENV_FILE=/etc/unseen/production.env \
  node /opt/unseen/releases/b3145804b4356b1e823783d3f0e9d0b0399bf0ee/infra/integration/production-package.mjs preflight
```

This command proves only strict structure, candidate/hash/file binding and the
declared fail-closed policy. With the provider disabled it reads neither the
receipt nor secret and performs zero provider network operations. With it
enabled, even an `APPROVED` or `STRUCTURE_ONLY` status cannot configure a real
provider, approve facts, change `productionReady=false`, or clear `NO_GO`.
Stage5 implements no vendor adapter or authentication protocol; a structure
receipt cannot substitute for that missing real seam and authorization.

## 2. Legal and Privacy notices

Owner input still required:

- a dated genuine human decision resolving all six decision-input groups in the
  existing review packet;
- approval of the exact nine notice purposes, versions, content hashes, and
  customer copy in the fixed notice candidate;
- exact production Book collection notice version/hash/copy and grant notice
  version/hash;
- an independently delivered Legal/Privacy approval record and SHA-256 in the
  owning team's authoritative format.

Authoritative existing references:

- `policy-inputs/notices.zh-CN.v1.json`, SHA-256
  `8cf08d9c139ebeb53e9bb9c0a148f272595d3d17b420d27835e2608db0add099`;
- `runbooks/drafts/NOTICE-APPROVAL-PACKET.zh-CN.v1.json`, SHA-256
  `ae0749ad6a502ad4ccaf6273738fc91942d5a1b66ccefb46aed50a273eceecb4`;
- `tests/security-contract/validate.mjs`, which validates artifact integrity;
- `config/rc/production.env.example`, which names the notice values and external
  approval file/hash inputs.

Run the existing mechanical integrity check with:

```sh
node tests/security-contract/validate.mjs
```

The current correct result is artifact integrity only, `NO_GO`, and zero human
approvals. Stage5 defines no Legal/Privacy approval-receipt schema and does not
authenticate or parse an external legal record. The production preflight only
cross-binds its independently delivered SHA-256 through the facts/provider
receipt; a matching hash proves byte identity, not signer authority or legal
sufficiency. Its schema authority remains
`owner_supplied_not_defined_by_stage5`.

## 3. Target server, domain, TLS, secrets, decoders, and operators

The target is purchased and provisioned. The accepted historical observation
`release-evidence/r0/private-beta/PUBLIC-FOUNDATION.json` at commit
`fb2f2b947a6e80d1a0a02b0c6f4e0d2f964c7c4a` records China Hong Kong, Ubuntu
24.04.4 LTS, 2 vCPU/2 GiB/50 GiB, the selected `unseen.maxxam.xyz` subdomain,
validated DNS/TLS, backup/restore, and the initial honestly labelled public
status page. The later accepted observation
`release-evidence/r0/public-core-ui-target-20260814T232050Z/MACHINE-EVIDENCE.json`
at commit `09ce09c170bbd4b5992a3a1b016e814be2013486` records that candidate
`45380ecd77315fcc95f3e445353f8abdc6c77603` serves the real Core Web UI behind
temporary BasicAuth, with no fixture activation, no user-data acceptance, and
OTP, Book, and private AI still off. Neither observation is production
acceptance, and neither claims final package candidate
`b3145804b4356b1e823783d3f0e9d0b0399bf0ee` is deployed or Core-operable.

The corrected current-active observation
`release-evidence/r0/target-deployment-candidate48a-renderer-snap-hardlink-p1-20260815T104618Z/MACHINE-EVIDENCE.json`
at commit `87687c956770a409f040ec15c5bbbf9f93aa70a9`, SHA-256
`96a6372d2f4eb61609920f936feb6346edb565ba2c653d462ec0b96e1c27f380`,
binds the loaded systemd units, active process cgroups and `/proc` working
directories to clean candidate
`48a3841c91d0f74fa6d51c1e292a27e1d3a2aab6` (tree
`b81b7216f621c9af37733102921be6d74dafac0b`), with DB quick-check `ok`, ten
migrations, zero accounts/photos/private-AI jobs, unchanged active Caddy, and
Book/private AI still off. Its renderer preacceptance stopped before a render
because the verifier rejected the normal snapd-cache hardlink topology, and
renderer-only cleanup completed without cache mutation. The exact policy fix is
independently accepted at code `2e7a2276f233b973fa17e4c05120772d17381c93`
and evidence `d1acca2fdd5965db5cd611baa7377b138734119c`, with 44 focused
gates in
`release-evidence/renderer/dedicated-service/snapd-cache-hardlink-topology/machine-summary.json`.
It accepts only the pinned same-inode cache topology and preserves fail-closed
ownership, mode, bytes, hashes, revision and no-mutation checks. Target synthetic
render/network acceptance remains required. This is accepted code evidence,
not a target retry. The observed active candidate is
deliberately not the final package candidate
`b3145804b4356b1e823783d3f0e9d0b0399bf0ee`; the latter remains not deployed.

No post-purchase target facts remain missing. Exact acceptance still required:

- deploy and verify the final candidate package without changing its bytes;
- deploy the accepted code-only Caddy boundary, then repeat the target-side
  exact 32 KiB, missing-Content-Length/chunked, and oversize matrix before any
  private-AI enablement;
- privately deliver the required service secrets and configure the default-off
  OTP/provider seams without recording their values here;
- keep the private-AI queue, Mac pull worker and Book-private composition flag
  off until the server has only the worker-token hash, the Mac has the plaintext
  token only in its private `0600` file, the exact HTTPS origin/trust and
  model/prompt/policy bindings are configured, and launchd plus Hong Kong HTTPS
  disconnect/reconnect/restart/duplicate/reclaim acceptance has passed;
- provide target-operator decoder execution and egress evidence bound to the
  packaged binary hashes and exact build/configuration output;
- install and measure the accepted dedicated renderer service on the target;
  its 44 focused snap-cache/control code gates, accepted systemd 255 property fix,
  and accepted IP-deny fix pass, but a target retry remains required and Book
  remains default-off;
- complete the real provider authorization described in lane 1.

The blocker
`final_candidate_deployment_secret_decoder_operator_and_provider_acceptance_missing`
names only those remaining acceptances. It does not say the server, domain, DNS,
or TLS foundation is absent. Real image model/provider selection remains in lane
1 above.

Authoritative existing references:

- `config/rc/production.env.example`, `ops/release/unseen.service.example`,
  `ops/release/Caddyfile.example`, and
  `runbooks/release/PRODUCTION-DEPLOYMENT.md`;
- `release-evidence/local-operable/stage-rc/PRODUCTION-PACKAGE-DECODER-RUNTIME.json`;
- `release-evidence/r0/private-beta/PUBLIC-FOUNDATION.json`, SHA-256
  `12de9e106a1fff701b4d84e4e1c010ad45ab87abf4fa256bb84a8b6d1b793fa2`;
- `release-evidence/r0/public-core-ui-target-20260814T232050Z/MACHINE-EVIDENCE.json`,
  SHA-256 `c4546702d135a6ccdaba66dd0c200a04778c776b6765a1d00cc1cbe713a5db82`;
- `release-evidence/renderer/dedicated-service/machine-summary.json`, which
  records accepted default-off code gates and the unfulfilled target checks;
- `release-evidence/renderer/dedicated-service/systemd255-property-fix/machine-summary.json`,
  which records accepted code fix `5ed65ec33eee0228c8d814bdf207674ddb4b5cbc`
  and target-retry-required evidence `259832e96c5e0edad9c1a5c5f5c6c092c56e7ae4`;
- `runbooks/release/PRIVATE-AI-PULL-WORKER.md`,
  `release-evidence/provider/mac-codex-private-worker/REMOTE-PULL-MATRIX.json`,
  and `release-evidence/private-ai-composition/machine-summary.json` document
  the default-off private transport, its non-production subscription boundary,
  and the target acceptance still required;
- `infra/integration/private-beta-deployment/Caddyfile` and
  `release-evidence/r0/private-ai-caddy-body-cap/machine-summary.json` bind the
  accepted exact 32768-byte code-only fix. The earlier
  `release-evidence/r0/shadow-transport-acceptance-20260814T183925Z/MACHINE-EVIDENCE.json`
  remains historical rejected evidence; it is not rewritten as a pass and the
  accepted fix is not claimed deployed. Its fixed handoff classification is
  `HISTORICAL_REJECTED_SUPERSEDED_BY_ACCEPTED_CODE_FIX`;
- `release-evidence/r0/deployment-active-release-contract/MACHINE-EVIDENCE.json`
  binds accepted code/evidence `9db936bdf7e1f56ec10f57bc9627be91b32ff603` /
  `a4faa79f64aaaf29fe17265c0717aaf8cbc0b806`: loaded-unit and process-cwd
  authority, non-overlapping render markers, sealed Caddy backup `0600`, live
  and rollback Caddy `0640`, ten migrations, application-owned production auth
  and CSP, and the accepted 32768-byte boundary. Earlier evidence commits
  `7d73fb980ed74d49de1cb27f92a4d61af2f97615` and
  `6d0cb2f1342bcc88383dfff3371d567d704b579f` are historical rejected inputs
  superseded by that accepted contract;
- `release-evidence/r0/candidate-7d2-deployment-attempt-20260814T192158Z/MACHINE-EVIDENCE.json`
  remains the historical rolled-back target attempt. Its two P1s are fixed by
  accepted code only, not deployed, and the failed attempt is never relabelled
  as target acceptance;
- `release-evidence/renderer/dedicated-service/systemd255-ip-deny-fix/machine-summary.json`,
  which records accepted canonical CIDR handling without claiming a target
  retry or render acceptance;
- `release-evidence/r0/target-deployment-candidate48a-renderer-snap-hardlink-p1-20260815T104618Z/MACHINE-EVIDENCE.json`,
  `release-evidence/renderer/dedicated-service/snapd-cache-hardlink-topology/machine-summary.json`,
  and `release-evidence/r0/target-renderer-route1-static-adapter-policy-candidate09f-20260815T091250Z/MACHINE-EVIDENCE.json`
  bind the current active candidate, rejected renderer attempt, exact snap tree,
  accepted 44-gate snap-cache policy, remaining legal/security gates, and renderer-only
  cleanup; none is a passing target retry;
- `infra/integration/staging-snapshot.mjs`,
  `tests/e2e/server-migration.verify.mjs`, and
  `release-evidence/local-operable/staging/README.md`;
- `release-evidence/r0/inventory/VERIFICATION.json`,
  `release-evidence/r0/inventory/RELEASE-INVENTORY.json`, and
  `runbooks/release/INVENTORY-REVIEW.md`.

Existing mechanical commands include:

```sh
node /srv/unseen-release/production-b3145804b435/VERIFY.mjs verify

git clone /srv/unseen-release/production-b3145804b435/source.bundle /opt/unseen/releases/b3145804b4356b1e823783d3f0e9d0b0399bf0ee
git -C /opt/unseen/releases/b3145804b4356b1e823783d3f0e9d0b0399bf0ee switch --detach b3145804b4356b1e823783d3f0e9d0b0399bf0ee
test -z "$(git -C /opt/unseen/releases/b3145804b4356b1e823783d3f0e9d0b0399bf0ee status --porcelain)"

UNSEEN_STAGING_SNAPSHOT_ID=pre-deploy-ID \
  node --env-file=/etc/unseen/production.env infra/integration/staging-snapshot.mjs backup
UNSEEN_STAGING_SNAPSHOT_DIR=/var/backups/unseen/production/pre-deploy-ID \
  node --env-file=/etc/unseen/production.env infra/integration/staging-snapshot.mjs verify

UNSEEN_BOOK_WORKTREE=/opt/unseen/book-web \
  node tests/e2e/server-migration.verify.mjs
```

Package verification proves package bytes and Git ancestry. Snapshot and server
migration checks prove their bounded local/server-staging mechanics, not a
production deployment. Decoder preflight remains `HASH_BOUND_NOT_EXECUTED`;
version/build and network boundary remain `TARGET_ACCEPTANCE_REQUIRED`. Stage5
defines no target-operator, Track 1B, or Track 3B receipt schema and no approved
target-OS execution wrapper, so this handoff does not invent one.

The existing inventory remains `needs_review` with
`fullRepositoryCandidateCoverage=false`, and performance remains
`INDETERMINATE_PROFILE_UNDERSPECIFIED_FAIL_CLOSED`. They are unchanged subinputs
of Legal/target review, not a new blocker or a release claim.

## Verify this index

From the evidence addendum checkout, with the fixed private package still
available:

```sh
UNSEEN_PRODUCTION_PACKAGE_DIR="/absolute/private/path/production-b3145804b435" \
  node tests/e2e/production-unblock-handoff.verify.mjs
```

The command must report `PASS_LINK_HASH_INDEX_ONLY`,
`authenticityVerified=false`, `externalReceiptReads=0`, `secretReads=0`, and
`externalNetworkRequests=0`. Passing it cannot change any blocker or authorize
release. Claude Code authentication/review was cancelled by Max for this round
and is not applicable; it is not a blocker.
