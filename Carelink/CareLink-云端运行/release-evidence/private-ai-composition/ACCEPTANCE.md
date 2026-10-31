# Private AI composition acceptance

- Evidence time: `2026-08-15T03:32:16+10:00` (AEST)
- Integrated base: `95d1151e7be72d5a487384b0fb915c5d90fbfde3`
- Base tree: `3aaf3a47`
- Code checkpoint: `8329b5c3be36a5691be457e64d50eb2387180335`
- Branch: `integration/private-ai-composition`
- Release state: **DEFAULT OFF / NOT DEPLOYED / NO LIVE CREDENTIALS**

## Accepted composition

The checkpoint composes the accepted private queue, Mac worker protocol and Book private-facts
seam without changing the public contracts or product UI packages. A single-flight dispatcher
first reconciles Core and Book source state, applies authorization/revocation intents, enqueues
eligible work and delivers at most one durable result event per cycle. An exactly committed
Book `model_unavailable` transition is acknowledged as delivered; other consumer failures keep
the A outbox retryable.

Repeated authorization and revocation are true write-free no-ops. A current authorization is
bound to the viewer-safe photo, content, placement and Core source version. Delete,
withdrawal, placement drift, asset/content drift or source-version drift creates a Book
source-revocation transition, tombstones the A authorization, cancels inaccessible work and
removes the ready question, private model facts and their hashes from the current Book view.
The stable state is `question_source_revoked` / `question_failed`, requiring explicit
regeneration. Confirmed user text and existing public grants are not automatically mutated.

The deployment entrypoint requires Book whenever private AI is enabled, passes the accepted
model/prompt/policy pins, runs one initial composition cycle before listening, starts no private
timer when default-off and closes the composition before both persistent stores. Same-origin
Book responses expose only the frozen observation enum `disabled|online|offline`.

The dedicated Caddy matcher exposes only `/__internal/private-ai/v1/*` to the loopback API,
limits request bodies to 32 KiB, preserves the public Host and sets
`X-Forwarded-Proto: https`. It is ordered before the Basic Auth/static fallback so the private
worker's own authentication remains authoritative. No Mac or development port is opened.

## Machine evidence

Commands run from `/Users/max/code/unseen-worktrees/private-ai-composition`:

```text
node --test --test-reporter=spec services/api/tests/private-ai-job-queue.test.mjs services/book-lab/tests/memory-question.test.mjs tests/e2e/book-lab/deployment-lifecycle.verify.mjs tests/e2e/book-lab/private-ai-composition.verify.mjs
node tests/e2e/private-beta-deployment.verify.mjs
npm --workspace services/api test
npm --workspace services/book-lab test
npm run contracts:check
npm run provenance:check
npm run format:check
npm run secret:scan
npm run backend:baseline
git diff --check
git diff --exit-code -- packages/contracts/generated
```

Results:

- Focused A/C/composition/lifecycle tests: `44/44 PASS`.
- Private-beta Caddy/env/runbook verifier: `PRIVATE_BETA_DEPLOYMENT_EVIDENCE_OK`.
- API workspace: `125/125 PASS`.
- Book workspace: `80/80 PASS`.
- Contract generation: `CONTRACT_GENERATION_CLEAN` (11 files).
- Provenance: `PROVENANCE_OK` (357 included, 178 excluded).
- Format: `FORMAT_OK`.
- Secret scan: `SECRET_SCAN_CLEAN` (926 files, zero findings).
- Backend network-guard baseline: `10/10 PASS`, `BACKEND_FAKE_OSS_BASELINE_OK`.
- Generated contracts and whitespace diff: clean.

The real focused seam creates a viewer-safe placed Core photo, starts a notice-bound Book
question job, composes it into A, completes the strict private worker DTO, delivers it into C,
then changes the Core photo version and verifies that the current question is removed,
`question_source_revoked` is durable and the authorization is inactive.

## Inherited repository evidence

`npm run check` reaches and then fails `freeze:check` with
`FREEZE_TRACK8_REGISTRATION`. The identical failure was reproduced in the clean exact-base
worktree `/Users/max/code/unseen-worktrees/5-stage-rc-next` at `95d1151e`; D1 does not touch
the freeze manifest or governed contracts.

The accepted B worker suite currently reports `18/21 PASS` on both this checkpoint and the
clean exact base. The same inherited failures are the processed/retry expectation in the two
Book queue/provider cases and the missing expired-lease status expectation. D1 does not touch
B worker files and does not treat those failures as a composition regression; they remain a
separate B-owner test-baseline item before private-AI enablement.

## Enablement inputs and rollback

Private AI remains off until the operator installs a new random worker token as a server hash
file and a Mac-only `0600` plaintext file, supplies all Book secrets/notices/paths and the
accepted model/prompt/policy pins, installs the Mac launchd worker, validates/reloads the Caddy
route, and completes the separate packages-only queued/offline/regeneration UI checkpoint.
No token, launchd service, live server, DNS record or public route was created or changed here.

Narrow rollback is to set `UNSEEN_PRIVATE_AI_WORKER_ENABLED=false`, restart the API, stop the
Mac worker and, if network rollback is needed, remove only the dedicated Caddy handle after
validating the prior config. Book/Core editing and export stay online. Queue, authorization,
fact and outbox rows are not manually deleted; data rollback uses the verified pre-enable
snapshot.
