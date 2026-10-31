# Mac Codex private pull-worker evidence

The original `6652bc4` / `94f7780` files remain the accepted `PRIVATE_TEST_PROOF` history. `REMOTE-PULL-MATRIX.json`
records the later default-off HTTPS pull implementation at code commit `bcd9fc4`; it does not rewrite the earlier
proof or claim that the Hong Kong endpoint, token, launchd agent, or Book private-facts ingestion is deployed.

The live proof used Codex CLI 0.147.0 with ChatGPT subscription login. It did not inspect, copy or persist the auth
file and did not use an OpenAI API key. The project test photo and adversarial image were copied to 0600 temporary
files, metadata-stripped, bounded, and removed in `finally`. Model answer text, image bytes, canary value, stdout and
stderr were not persisted. The checked-in JSON contains only counts, event/item names, usage and hashes.

Before either image could be resolved or read, the proof bound a direct native executable (no `PATH` lookup) to its
regular-file owner/group/mode/SHA-256 and exact version, then completed a strict-config, no-image schema dry-run.
Deterministic negatives prove hash, symlink, version and dry-run tool-event drift all fail before the image resolver.

The new runner produces one or two model-visible facts plus one optional question under exact prompt/policy hashes.
The server remains authoritative for source/currentness binding and public/Book authorization. ChatGPT login stays
on Max's Mac; this is still not the OpenAI API or a commercial SLA.

Reproduce deterministic tests without consuming subscription quota:

```sh
node --test tests/e2e/mac-codex-private-worker/*.test.mjs
```

`REMOTE-LIVE-E2E.json` records the single final local-TLS queue -> real Codex image -> terminal callback run. Do not
rerun it for routine acceptance. If a new Codex binary/model/prompt/policy is intentionally accepted, the opt-in
command for one replacement non-private image is:

```sh
UNSEEN_RUN_CODEX_SUBSCRIPTION_REMOTE_LIVE=1 node tests/e2e/mac-codex-private-worker/remote-live.verify.mjs
```
