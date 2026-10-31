# UNSEEN backup subsystem

Minimal automated backup for the production data set: both sqlite databases, media, non-secret
config, and an encrypted bundle of everything actually secret — run daily, kept 7 days locally,
uploaded offsite to Tencent COS. See the report this shipped with for console setup steps,
memory-limit recommendations, and the ordered install sequence; this file just indexes the pieces.

## Pipeline

```
unseen-backup.timer  (daily, 03:15 Asia/Hong_Kong)
  -> unseen-backup.service
       -> backup.sh            writes /var/backups/unseen/<UTC timestamp>/
       -> upload-to-cos.sh      -> upload-to-cos.mjs   uploads that run's files to COS
```

`restore-drill.sh` is run separately, by hand or ad hoc — it is not on the timer. It never touches
production and never decrypts the secrets bundle; it only proves the two databases are readable
and answer real queries.

## Files

| File | Purpose |
|---|---|
| `backup.sh` | Builds one timestamped local backup: sqlite `.backup`, media tar (size-guarded), config tar (secret-scanned), gpg-encrypted secrets bundle, manifest + checksums, retention pruning. |
| `restore-drill.sh` | Restores the latest (or a given) backup's databases into a `/tmp` scratch dir, verifies checksums, integrity-checks, and runs real read queries. Prints a PASS/FAIL report. |
| `upload-to-cos.mjs` | Standalone Node uploader implementing Tencent COS's v5 (HMAC-SHA1) object-API signature. `--selftest` prints the signing algorithm's intermediate values without touching the network. |
| `upload-to-cos.sh` | Loads COS credentials from a root-only env file into the process environment (never argv) and execs the uploader. |
| `unseen-backup.service` / `unseen-backup.timer` | systemd oneshot + daily timer wiring the above together. |

`../90-memory-limits.conf` (one directory up, next to `unseen-minimax-worker.service`) is the
`MemoryMax`/`MemoryHigh` drop-in for `unseen-operable.service` — not part of the backup pipeline,
but shipped in the same change because both came out of the same audit.

## Required root-only files on the server (not part of this repo)

- `/etc/unseen/backup-encryption.passphrase` — single-line gpg symmetric passphrase for the
  secrets bundle. **Must also be saved outside this server** (e.g. a password manager) — if the
  server's disk is what's lost, this file goes with it, and the encrypted offsite secrets bundle
  becomes permanently unreadable without a separately-kept copy.
- `/etc/unseen/backup-cos.env` — `UNSEEN_BACKUP_COS_SECRET_ID` / `_SECRET_KEY` / `_BUCKET` /
  `_REGION` / `_PREFIX`. Only needed for `upload-to-cos.sh`; `backup.sh` alone works without it.

## Install location

Installed to a stable path (`/opt/unseen/backup/`), deliberately outside the
`/opt/unseen/releases/<commit>` rotation that the application units use — this subsystem has no
dependency on the app's release lifecycle, and pinning it to a release directory would break it
the day that release gets cleaned up. Update it by copying a fresh checkout of this directory over
`/opt/unseen/backup/` when the scripts themselves change; it doesn't need to move on every app
deploy.
