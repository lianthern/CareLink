# UNSEEN C3-contract 追加勘误验收

日期：2026-08-13（Australia/Brisbane）  
勘误：`receipt-recovery-error-alignment`  
状态：**ACCEPTED（P0=0、P1=0、P2=0）**

本文件是追加证据，不修改、替换或冒充原 `C3-CLAUDE-DESKTOP-ACCEPTANCE.md`。原文件继续只证明旧 coverage hash `19350434648f257e16dede9ec75ea2a7341f2e4c4d2f959f586e3865955192d6` 的冻结前验收。

## 唯一合同语义修正

`technical/ACTION-API-COVERAGE.json` 的 `BATCH.RECOVER_FROM_ACCOUNT.stableErrors` 中：

```diff
- recovery_unavailable
+ receipt_recovery_unavailable
```

修正后的 coverage SHA-256：`0d8476eb33b2409fed24383f64e9d54d4f851a91f77be83884daca57adfe7756`。未改 canonical SHA-256：`63d797509ef77cc670fc4737623a53865bfdd2600d64f51a6b11293132d9b7bb`；其 §5.4 第 451 行原本已经冻结 `receipt_recovery_unavailable`，因此这是派生 coverage 向 canonical 对齐。

动作 ID、route、actor、authorization、request/success schema、idempotency、replay、CAS 与计数均不变：90 actions、360 source checks、810 phase pairs、59↔59 HTTP mutations、6 technical + 1 internal operation。`recovery_window_closed` 仍且仅用于 `BATCH_BINDING.REQUEST_CODE` 与 `BATCH_BINDING.CONFIRM` 两个 OTP 步骤。

## 独立验收

### Codex C2 erratum red-team

- 绑定 clean commit：`bbf23afbf13e4f8009f560778f996537a1b2e039`
- 结论：PASS，P0=0、P1=0、P2=0
- 独立归档：`/tmp/unseen-c2-bbf23af.Rm7gQc`
- 物理负测：把 coverage 还原成旧枚举后，freeze gate 以 `FREEZE_CONTRACT_HASH` 拒绝；在内部哈希一致的语义负测中，以 `FREEZE_RECEIPT_RECOVERY_ERROR` 拒绝。

### Claude Code desktop C3 erratum review

- 桌面会话：`local_c191787b-0c95-4172-b7ce-31dac89df3c0`
- Claude Code 桌面 GUI；Opus 5；Effort Max；Fast mode off
- 绑定 clean commit：`bbf23afbf13e4f8009f560778f996537a1b2e039`
- 初审结论：PASS，P0=0、P1=0、P2=3
- P2-1：提交不只是单串，还包含对应派生产物、冻结锚点、freeze gate 与负测加固。`bbf23af` 的完整 8-file 范围是：
  1. `contracts/source/technical/ACTION-API-COVERAGE.json`（唯一合同语义修正）；
  2. `packages/contracts/generated/action-api-coverage.json`（派生产物）；
  3. `packages/contracts/generated/contract-index.json`（派生索引/哈希）；
  4. `FREEZE-MANIFEST.json`（新 coverage 与 provenance 锚点）；
  5. `provenance/contract-source-manifest.json`（权威副本哈希锚点）；
  6. `scripts/contracts/generate.mjs`（coverage source hash pin；其无关尾空行差异在闭合提交中恢复）；
  7. `scripts/gates/check-freeze-manifest.mjs`（语义门禁）；
  8. `scripts/gates/check-freeze-manifest.test.mjs`（旧枚举负测）。
- P2-2：`scripts/contracts/generate.mjs` 的无关末尾空行差异已恢复，最终勘误提交不再包含该差异。
- P2-3：外部 `technical/EVIDENCE/c3_contract_gate.py` 原先不检查该枚举。现已新增 canonical/coverage 对齐与 OTP scope 两项断言；修订脚本 SHA-256 为 `70bcaf5f404a501a0b746d205c40124c7729f43c4d409cbb7cb823f88868c344`，旧枚举负测为 `ERRORS=1 / exit=1`。

上述三项 P2 的闭合候选绑定 clean commit `68d5fd4fcb7335a14d07d20f021acf93b8892b1b`，并已完成两路独立只读复核：

- Codex closure red-team：PASS，P0=0、P1=0、P2=0；独立归档 `/tmp/unseen-c2-closure-68d5fd.9cXyCB`。
- Claude Code desktop follow-up：PASS，P0=0、P1=0、P2=0；同一桌面会话 `local_c191787b-0c95-4172-b7ce-31dac89df3c0`，Opus 5、Effort Max、Fast mode off。

本次状态晋级只记录上述已完成裁决，不再修改合同语义或三项闭合内容。

## 门禁与边界

修订后 `npm run check`、`npm run contracts:diff-clean`、外部 `c3_contract_gate.py` 与旧枚举反例均已实际运行。旧 C3 验收文件保持 byte-exact，不把新 hash 伪装成旧审查已覆盖。

本勘误只允许恢复受影响模块施工，不表示 Track 1A、Track 2、Track 4、Integration、Release、部署或生产云通过。
