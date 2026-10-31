# C4 Track 0L blockers

Current status: no unresolved blocker. Controller acceptance and final branch/worktree readback are complete. No module work began from the superseded candidate commit.

Resolved stop gates retained in provenance:

- source-manifest reconstruction and machine verifier;
- two exact forbidden Android debug keystores;
- two exact forbidden signed policy records;
- two exact synthetic backend test fixtures, admitted only by file/value/transport fingerprints;
- one exact high-entropy migration path reference whose complete historical operator prompt is excluded.

Any drift from those exact rulings is a new stop condition.

Known non-blocking limitation: `FREEZE-MANIFEST.json` uses the symbolic starting commit `SELF`; the stable resolver is `git log -1 --format=%H -- FREEZE-MANIFEST.json`. Literal self-embedding is cryptographically impossible because changing the manifest changes the commit hash.
