# Track 8B renderer evidence

Status: `fixture-backed package evidence only`; not Core integration, Book MVE, R0, deployment, or production readiness.

- Frozen fixture hash: `063008322c996202e989ef0f12545e6935e025e058ede555f013c57f28146d5f`
- Frozen title: `共光以后`
- Frozen manifest hash: `a497b7c837b943809cc8a82971107278963dec56fe1a77a09150cf1929c3a102`
- HTML SHA-256: `b06786fd229bee4721d31532a2a17c8d88f6d9dc0adb47466b1d6b38aeb9d7cd`
- PDF SHA-256: `a4ce30c3d156707e81f1b7069a7c30af9f6860e426f46494fce8a3ebebcd598a`
- HTML and PDF expose the same `bookId/versionId/title/manifestHash`, snapshot hashes, page count, ordered page IDs, source IDs and display-photo IDs. See `render-receipt.json`.
- Two independent local prints are byte-equal after the PDF `CreationDate` and `ModDate` are canonically bound to the manifest `frozenAt`; content is printed from the exact persisted HTML bytes.

Reproduce:

```bash
node --test packages/book-renderer/tests/*.test.mjs
node packages/book-renderer/src/cli.mjs /tmp/unseen-book-preview
```

The renderer rejects remote resource references, active script, missing/invalid frozen title, a missing cover display asset, an unexpected closing display asset, cross-book or cross-version AuthorizedMemoryText, mismatched page/text provenance, changed source/text/asset hashes, unknown local assets, more than 16/fewer than 12 pages, and text that cannot fit without clipping. It never reads live PersonalMemory, AnswerSubmission, SceneNote, grant, draft, network, model, or Core service state.

`pdfinfo`, `pdffonts`, `pdftotext -layout`, and a 16-page `pdftoppm` visual review confirm the PDF has 16 square pages, embeds STSong CID/Type 3 subsets, preserves extractable Chinese text, and visibly renders every Chinese title/question/answer without missing-glyph boxes or clipping.
