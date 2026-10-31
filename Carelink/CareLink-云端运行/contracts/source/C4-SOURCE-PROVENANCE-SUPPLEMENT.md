# C4 source provenance supplement

Date: 2026-08-13 (Australia/Brisbane)  
Status: PASS; Track 0L pre-bootstrap blocker cleared. This is a non-semantic provenance clarification, not a product/API/security contract change.

## Recovered authority

The original inventory command was recovered from:

`/Users/max/.codex/sessions/2026/08/13/rollout-2026-08-13T00-03-38-019ff649-2b0c-7d61-a7c8-b0b9e4db956e.jsonl`

- UTC timestamp: `2026-08-12T14:31:38.070Z`
- call id: `call_mEMWzsdl4Y4P28QaLBztXw4z`
- exact include, exclude, path, sort, line and aggregate rules are frozen in the machine-readable baseline below.

## Frozen machine evidence

- Baseline: `technical/EVIDENCE/c4-source-manifest-baseline.json`
  - SHA-256: `0ce863dd54ca485bea2c5acdf3a1cdaa2a1dd8b6376f1cb182a70f54f7b93d05`
- Read-only verifier: `technical/EVIDENCE/verify_c4_source_manifest.py`
  - SHA-256: `cc05a051f126606ffc62803fac2dd559994c085438b9b25318302ebad81754f4`

Independent reconstruction and the verifier both produce:

| Scope | Files | SHA-256 |
|---|---:|---|
| formal Web historical source fingerprint | 130 | `2542c7b71425bd7946a707d353cdfd3f2be31a17079df6aa151513d24fbe2b50` |
| recovered historical source fingerprint | 174 | `a8d1901e45d39fc1eaa4f28905887a2ab451dafdab7d3b64f475537d0976e915` |
| recovered backend fingerprint | 13 | `9b1c489ad18ea6278d1c6c770610e5e0500315c63c8a24858d1e7dfcd783934e` |

Run from the contract root:

```zsh
python3 technical/EVIDENCE/verify_c4_source_manifest.py
```

Expected terminator: `C4_SOURCE_MANIFEST_OK`.

## C4 interpretation

1. These three fingerprints prove the identity of the source selections used by the 2026-08-13 inventory. They are immutable historical fingerprints.
2. The 130/174 selections are not complete import allowlists: static media and other non-source files may be outside the historical extension set.
3. Track 0L must separately create a safe-import inventory covering every included and excluded file, reason, byte count, source hash, relative target path and target hash. It must not infer that all historical-tree files are safe to import.
4. Track 0L must run the verifier before import and again before its freeze commit. Any count, entry or aggregate drift stops bootstrap.
5. The eight C3 frozen files were not modified. `c3_contract_gate.py` was rerun after adding this supplement and returned `ERRORS=0`; a new desktop C3 semantic review is not required.

## Exact credential exclusion ruling

Both historical source roots contain the byte-identical file `tools/android-webview-harness/build/test-debug.keystore` (2,658 bytes; SHA-256 `5949ce9805e8b32a5bdde5d307df00d6358e96c5938b9c2d781fa235f09e40ae`). Regardless of its disposable debug purpose, a keystore is a private-key container. Track 0L must classify these two occurrences as `forbidden_credential_build_artifact`: record only source root, relative path, byte count, mode, hash and exclusion reason; never copy, decrypt, inspect contents or print certificate/key material. No source-side deletion or mutation is authorized. This exact exclusion clears the stop gate; any other credential-shaped path/hash remains a new stop condition.

The recovered source also contains exactly two known signed object-storage policy records under `artifacts/policy-backups/`: `s4-20260802T071754Z-c54868db3b8f.space.json` (14,958 bytes; SHA-256 `c54868db3b8f3ee3264489facfd6f804d7171980982565a6f0e518a8a88fa8be`) and `stressexp1-20260802T071800Z-c7c7f4eb5042.space.json` (3,948 bytes; SHA-256 `c7c7f4eb50424a7636bd559ab605512e7548a5f8d5fb0175a28df93c72dd6cdb`). The prior inventory establishes that these records contain AccessKeyId, policy and signature fields; expiry does not make signed credential material safe to commit. Track 0L must classify both as `forbidden_signed_policy_artifact`, record metadata only, and exclude the complete `artifacts/policy-backups/` directory if its inventory contains only these two exact entries. It must not parse or print field values, copy, delete or mutate either record. Any credential-shaped file outside these exact paths remains a new stop condition.

## Exact synthetic test-fixture ruling

The redacted all-tree scan found credential-named string literals in exactly two recovered backend unit-test files. Two independent structural reviews and a local `node --test` run establish that these literals are synthetic test inputs, not usable credentials:

- `backend/test/oss-v1.test.js` (2,593 bytes; SHA-256 `d8f8e617c8c4619d25232b89fdcf00cd02f0e7995c19ac078e8f34d5e93df1ed`) uses `node:test` and an injected async transport; it imports no `http`, `https`, `net`, `tls` or `child_process` module and does not call a global fetch. Its exact redacted fixture fingerprints are:
  - lines 13 and 46, `accessKeyId`, 9 bytes, value SHA-256 `539b3ed57456a8c8822ef9152c97e409cdb1626e1731cc2bef9c96c1d82520d4`;
  - lines 14 and 47, `accessKeySecret`, 13 bytes, value SHA-256 `894e01a8315fcc4199bed8138560585d3ebdd0b4a2e295e47d730dc45061d12b`.
- `backend/test/service.test.js` (9,496 bytes; SHA-256 `6f2b1ee3ed01151c7cd1b4ff564bf873098ff0e3511755c5eda5db255f963713`) uses `node:test`, constructs `FakeOss`, and injects it into the service; it imports no network or child-process module and does not call fetch. Its exact redacted fixture fingerprints are:
  - line 26, `accessKeyId`, 14 bytes, value SHA-256 `f3e9bc9cd861a577b1a52762ef634b27973c65f6ec58a57fde9f53b5456bb43d`;
  - line 27, `accessKeySecret`, 37 bytes, value SHA-256 `0ef2e06f0f7dcc8957ad8fb972536ebe3219936e52eeb753d33f8111f9ac9c64`;
  - line 28, `tokenSecret`, 45 bytes, value SHA-256 `41b90ca30b0b35597991051d001d6e9d8953d9834e3203408032e36d7aa75db5`;
  - line 29, `spaceIdSecret`, 45 bytes, value SHA-256 `efe4c5fe999e55e6ccd0f82c786448e7f203b42bb58cf9894711731f7f4ee5d3`;
  - line 30, `hostKeySecret`, 45 bytes, value SHA-256 `b0eb7cfcd7d1a4d9b1c9108139a3af9a7fe4b7eaedd37147049f48f7788ce072`;
  - line 31, `rateLimitSecret`, 45 bytes, value SHA-256 `3f5cf65c01c5fcf67629abd66f0dc219e62f836ad8fe53bd0570ee367c826b35`.

The IDs do not match the Aliyun, AWS or STS access-key shapes checked by the scan; the remaining values are consumed only by the isolated test transport or local `FakeOss`. Running the two unchanged test files produced 10/10 passing tests with no cloud or external network access. Track 0L may classify only these exact file hashes and exact value fingerprints as `non_sensitive_synthetic_test_fixture` and import the unchanged files as local baseline tests. The exception is invalid if either file hash, line/key/length, value hash, import graph or transport behavior changes. It does not permit logging the literal values or suppressing a new secret finding elsewhere; any other credential-shaped path or unmatched value remains a stop condition.

## Exact historical prompt-path ruling

The redacted entropy scan also flagged one 54-byte ASCII sequence at line 70 of recovered-source `prompts/h5-upload-first-v20-final-blockers-20260802.md` (11,313 bytes; mode `0600`; file SHA-256 `e824690df0131340818fba2047f5d193e1453e0ac86fee8152a35a1a873cc47f`). The sequence has value SHA-256 `573ef87d9d232501641d11e7196cb428a4c9867ee54c4b096d6baa5b68939aeb`.

Structural verification without reproducing the sequence establishes that it begins with `supabase/migrations/`, consists of three slash-separated filename-safe segments, contains a five-digit migration ordinal and the word `storage`, is immediately followed by `.sql`, contains no credential word, and appears exactly once across both designated source roots. Its surrounding prose instructs creating a local forward-only migration mirror; no runtime, build, test or import code reads this historical `prompts/` document. It is therefore classified only for this exact file/value hash as `non_sensitive_migration_path_reference`, not as a credential.

The document itself is an historical operator prompt rather than product or backend source. Track 0L must classify the complete file as `excluded_historical_operator_prompt`, preserve only path/bytes/mode/hash/reason in the safe-import inventory, and not copy it into the new repository. Any hash or structural-context change invalidates this ruling; no other high-entropy literal is cleared by analogy.
