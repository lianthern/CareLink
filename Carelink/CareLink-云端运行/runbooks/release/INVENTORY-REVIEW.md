# Release inventory review

This inventory is offline mechanical evidence for fixed candidate
`8675d244b9657a3cdc6cb809b75a57a6c7e92a34`. It does not approve a license,
media right, font use, redistribution, security exception, deployment, or
production release. Its release claim is deliberately `NO_GO`.

## Generate and verify

Run from a clean checkout containing the inventory tool. The target file must
not already exist.

```sh
node ops/release/inventory/inventory.mjs generate \
  --candidate 8675d244b9657a3cdc6cb809b75a57a6c7e92a34 \
  --output /absolute/private/path/RELEASE-INVENTORY.json

node ops/release/inventory/inventory.mjs verify \
  --inventory /absolute/private/path/RELEASE-INVENTORY.json
```

Generation reads the fixed Git tree and local runtime files only. It makes no
network request. The JSON omits wall-clock time so the same candidate and
runtime installation produce identical bytes in a fresh clone. Never edit the
JSON by hand: regenerate it for a new candidate or runtime installation.

The verifier fails closed on a missing or extra discovered file, byte/hash
drift, package manifest or lock drift, a tracked/input symlink, runtime binary
replacement, duplicate component ID, non-canonical JSON, placeholder/unknown
review state, or any attempt to turn unresolved review into `GO`.

## Human sign-off still required

| Area | Required owners | Minimum evidence before a release controller may reconsider `NO_GO` |
|---|---|---|
| QR vendor bundle | Security, Legal, Release Engineering | Exact `qrcode` and embedded `dijkstrajs` versions; upstream source; recursive license/notice and security disposition. The present MIT notice alone is not recursive approval. |
| FFmpeg / ffprobe | Media Engineering, Security, Legal, Release Engineering | Exact deployment hashes; GPL-enabled build and linked codec obligations; recursive source/license/notices; redistribution decision; vulnerability disposition. |
| Node / Chromium | Security, Legal, Release Engineering | Exact deployment hashes/build identity; recursive runtime licenses/notices; vulnerability disposition; Chromium build/source evidence not exposed by `--version`. |
| Media assets | Product, Legal, Release Engineering | Per-asset source plus people, venue, commercial-use, modification, and redistribution rights bound to the recorded SHA-256. Historical imports, fixtures, references, and screenshots are not cleared by being non-runtime. |
| Fonts | Design, Legal, Release Engineering | Exact production resolution/embedding or system-fallback basis; redistribution/subset terms where applicable; Chinese missing-glyph rendering evidence. No font file is bundled in this candidate. |

Any signed review receipt must bind the candidate commit, inventory SHA-256,
reviewer/owner, scope, decision, issue/expiry time where relevant, exception
owner/expiry where relevant, and the precise evidence locators. A mechanical
hash match cannot replace these approvals.

## Scope and handoff

The inventory covers every tracked package manifest (workspace and explicitly
classified historical non-workspace manifests), dependency lock, the recursive
vendored QR modules visible in the bundle, every tracked image/audio/video/font/
Wasm asset, system-font references, Node embedded versions, executable runtime
binaries, and recursively resolved Mach-O libraries. macOS dyld shared-cache
links are recorded as `system_managed_not_addressable`; they remain review
items rather than fabricated file hashes.

This work does not modify or validate the production package, application,
contracts, root lockfile, live staging, cloud state, user data, or third-party
deployment. The release controller remains the sole go/no-go owner.
