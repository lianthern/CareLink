# Core Local Operable

This is the loopback-only Stage L build. It runs the accepted local API, production Web adapter, accepted Viewer, persistent SQLite/filesystem media, and the visibly labelled deterministic locator fixture. It does not deploy, publish, contact cloud services, or claim real locator quality.

From the integration worktree, start it with one command:

```sh
UNSEEN_LOCAL_DATA_DIR=/tmp/unseen-local-operable node infra/integration/local-operable.mjs
```

Open the `origin` printed in the `LOCAL_OPERABLE_READY` JSON line. Port 4173 is preferred; if another process already owns it, the launcher chooses a free loopback port and reports the actual URL. Do not assume that a response on port 4173 belongs to this runtime. Every response from this runtime carries `x-unseen-local-operable: true` and `x-unseen-runtime-id: unseen-stage-l-local-operable-v1`.

The local OTP is printed only to the terminal and stored in the mode-0600 mailbox under the selected local data directory. Stop with Ctrl-C; clean shutdown evidence is written to `SHUTDOWN.json`.

To replay the fixed owner/participant acceptance chain against a running origin:

```sh
node tests/e2e/local-operable.e2e.mjs --base-url http://127.0.0.1:ACTUAL_PORT --evidence "$PWD/release-evidence/local-operable"
```

The checked candidate used a fresh data directory and returned `Core Local Operable = PASS`. The evidence set includes the isolated-browser trace, cache/site-data reopen proof, browser/network diagnostics, database/media checksums, three screenshots, request ledger, and clean shutdown record. Fixture disclosure is exact: `本地定位 fixture：high / 需要确认 / failed`.
