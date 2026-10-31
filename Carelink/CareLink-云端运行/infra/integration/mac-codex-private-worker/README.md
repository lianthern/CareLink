# Mac Codex subscription private worker — default-off private Beta adapter

This directory is the Mac-only pull worker for Max's private friends Beta. It is not the OpenAI API, does not offer
a commercial SLA, consumes Max's logged-in Codex subscription, and is disabled in the checked-in configuration. It
opens no listener or Mac port. The only network direction is Mac -> `https://unseen.maxxam.xyz`.

## Fixed boundary

- Protocol: `unseen-private-ai-pull/1` at `/__internal/private-ai/v1`.
- Every request uses the exact configured HTTPS origin and hostname. Redirects and cross-origin paths are rejected.
- TLS uses the system CA set or an explicit private CA file; either may additionally pin the certificate SPKI.
- The bearer token is read for each request from an absolute `O_NOFOLLOW` regular file owned by the configured uid
  with mode 0400 or 0600. It is never accepted from argv, JSON, the environment, a URL, or a log.
- The server lease contains no photo owner, placement, consent, or other source identifier. A contextual v2
  follow-up lease does contain the preceding question, 1–2 model-visible facts, and at most 500 characters of the
  user's latest answer; an initial lease carries no answer. The server owns source bindings and rechecks
  currentness on lease, image, complete, and fail.
- The Codex analyzer consumes that v2 context in an explicitly untrusted quoted-data block, re-inspects the image,
  and uses the preceding exchange only to avoid repetition and ask a natural next question. It does not silently
  downgrade a contextual lease to the initial-question prompt.
- The worker accepts only one active lease. A job must retain more time than the pinned Codex/preprocess/kill/cleanup
  budget. Mac sleep, network loss, subscription quota, or process death leaves the server lease to retry.
- A downloaded JPEG/PNG must match its leased MIME, exact byte length, SHA-256, ETag, and pixel ceiling. It is fsynced
  to a 0600 file inside a 0700 temporary directory, then the accepted runner rechecks it, downsizes it, converts it
  to PNG, and copies only rendering-safe chunks. EXIF, GPS, and text chunks do not reach Codex. Temporary files are
  truncated, fsynced, and removed in `finally`.
- Codex is resolved by an absolute native executable path and pinned owner/group/mode/SHA-256/version. A no-image
  strict-schema dry run passes before the worker leases or downloads an image, and the fingerprint is checked again
  immediately before the real invocation.
- The invocation remains `--ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only` with
  strict config, no shell, browser, computer use, agents, web, apps, skills, plugins, hooks, MCP, or workspace tools.
  JSONL accepts only the known thread/turn events and an `agent_message`; any tool or unknown event fails closed.
- The model returns one or two objective Chinese visible facts and one optional Chinese question. It may not identify
  people or infer sensitive attributes, relationships, intentions, or emotions. Image text is data, not instruction.
  The exact output is server-private draft material; Book authorization and public facts remain separate.
- Diagnostics contain only a finite event, replay boolean, and stable failure code. No image, token, auth material,
  DTO, visible fact, question, user answer, stdout, or stderr is logged. Remaining subscription quota is not exposed
  by Codex CLI and stays `UNKNOWN_NOT_EXPOSED`.

Codex 0.147.0 rejects the newer documented `tools.view_image=false` key under strict config. This pinned and tested
runtime therefore retains its version-valid `features.view_image=false`; upgrading Codex requires a new dry-run,
runtime hash, config compatibility proof, and image smoke before changing the pin.

## Files

- `codex-exec.mjs`: accepted runtime preflight, sandboxed image invocation, structured output, TERM -> bounded KILL.
- `https-transport.mjs`: exact HTTPS/TLS/token boundary and private image tempfile lifecycle.
- `remote-pull.mjs`: strict wire DTOs, lease budget, complete/fail replay, concurrency one, jittered polling.
- `daemon.mjs`: default-off config loader and signal-aware long-running process.
- `config.example.json`: current pinned Mac runtime, model, prompt/policy hashes, and disabled switch; no secret.
- `com.maxxam.unseen.private-ai-worker.plist.example`: launchd template with `KeepAlive`, `NetworkState`, and
  `ThrottleInterval`; stdout/stderr go to `/dev/null`.

## Enable only after the server endpoint is accepted

1. Copy this directory and `config.example.json` into private, immutable local paths outside the repository. Keep the
   config owned by Max and not group/other-writable.
2. Create a random worker token in an absolute private file, mode 0600. Install only its SHA-256 on the server; never
   copy the token into the repo, plist, config, shell argv, evidence, or MaxNotes.
3. Verify the config's Codex path, uid/gid/mode, executable SHA-256, exact version, selected model, modelVersion,
   promptHash, and policyHash against the accepted server configuration. Keep `enabled:false` until all values match.
4. Replace only the two `__ABSOLUTE_...__` plist placeholders, run `plutil -lint`, install the plist in Max's user
   LaunchAgents directory with mode 0600, and set `enabled:true` in the private config.
5. Use `launchctl bootstrap` for Max's GUI domain. Do not use sudo, install a system daemon, open a firewall port, or
   expose Ollama/Codex/a local HTTP service.
6. Confirm the server records a lease and exact terminal replay. Mac sleep/offline must leave the photo saved and
   the job queued/retry; Core, upload, location, Viewer, and Book editing/export remain independent.

To stop, use `launchctl bootout` for the installed user plist. To rotate the token, boot out the worker, atomically
replace the 0600 token file and server hash, then bootstrap again. This does not read, copy, delete, or modify Codex
login files.

## Deterministic verification

```sh
node --test tests/e2e/mac-codex-private-worker/*.test.mjs
plutil -lint infra/integration/mac-codex-private-worker/com.maxxam.unseen.private-ai-worker.plist.example
UNSEEN_PRIVATE_AI_WORKER_CONFIG="$PWD/infra/integration/mac-codex-private-worker/config.example.json" \
  node infra/integration/mac-codex-private-worker/daemon.mjs
```

The last command must exit 0 without network or Codex activity because the checked-in example is disabled. The live
subscription smoke is opt-in, uses only a non-private project image, and must not be repeated during routine tests.
