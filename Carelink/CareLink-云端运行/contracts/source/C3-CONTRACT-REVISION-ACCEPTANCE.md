# UNSEEN runtime + L3 Book Lab 合同修订验收

日期：2026-08-13（Australia/Brisbane）

状态：`PASS · C2 P0=0/P1=0 · desktop C3 P0=0/P1=0 · post-local P2=3`
最终固定 C3 候选：`e33bea21650748ce9c0863efe80e675f3e5c04d3`

本文件是 `runtime remediation A–D + L3 Book Lab + effective-revision Freeze/编排` 的联合验收收据。它不修改或冒充历史 `C2-CODEX-ACCEPTANCE.md`、`C3-CLAUDE-DESKTOP-ACCEPTANCE.md` 或 `C3-CONTRACT-ERRATUM-ACCEPTANCE.md`，也不代表 Local Operable、Core R0、Book Lab MVE、发行、部署或生产云通过。

## 1. 固定对象

| 字段 | 固定值 |
|---|---|
| candidate commit | `e33bea21650748ce9c0863efe80e675f3e5c04d3` |
| candidate tree | `b65f2c9fbd1d4adf9e416f92ffc81b8499cf2266` |
| single parent | `f09f0ce9b622a6fcad0c05614bbe06b229ffb572` |
| review range | `f09f0ce9b622a6fcad0c05614bbe06b229ffb572..e33bea21650748ce9c0863efe80e675f3e5c04d3` |
| changed paths | `40` |
| independent binary diff SHA-256 | `463626e38919bba12062a997cfc64addbe464fbaa540b8df00af1bb061edf55a` |

该候选在桌面 C3 前后均为单亲、clean。原 28-file revision 候选在 `cd01736a0f7e319bc973a2d93d99026189d8695d` 已通过；之后 Track 8B 暴露 frozen title 唯一 P1，因此以相同 parent 原子重建为 40-file 候选。相对前一 effective revision `0154405bbbc36bf6d6618e6c51337c0f9f6ee6e7`，本次窄勘误恰好只改以下六个文件：

```text
contracts/source/C3-CONTRACT-REVISION-ACCEPTANCE.md
contracts/source/l3-book-lab/ACTION-API-COVERAGE.book-lab.json
contracts/source/l3-book-lab/BOOK-LAB-CONTRACT.md
contracts/source/technical/CANONICAL-STATE-AND-API.md
contracts/source/technical/EVIDENCE/c3_contract_gate.py
scripts/gates/check-revision-contract.mjs
```

## 2. Codex C2 revision

最终结论：`PASS · P0=0 · P1=0 · P2=0`。

Codex scope-locked C2 对 Runtime A–D、Book persistence/DTO/state/CAS、Local Operable/Track 8 编排和 Freeze v2 做了独立合同交叉验收。最后关闭的同源问题是 `memory_interviews` 11 态唯一真值、`PersonalMemory.status/interviewVersion` 投影、START/SKIP absent 原子建行、四个用户状态动作与 question processor 的双表 CAS。最终 gate-only closure 没有改变任何动作、API、状态、CAS 字典或权限语义。

固定计数：

```text
Core:      actions90 / refs360 / phases810 / mutations59↔59 / CAS47 / technical8 / internal2
Book Lab:  actions20 / refs80  / phases180 / mutations15↔15 / CAS8  / technical0 / internal2 / machines5
Aggregate: actions110 / refs440 / phases990 / mutations74↔74 / CAS55 / technical8 / internal4
```

## 3. Desktop Claude Code C3 revision

- 运行方式：Claude Code desktop GUI；会话 `local_61984ae1-9daf-4ab5-ad66-aaa02fe766f2`。
- 模型：`Opus 5`；Effort `Max`；Fast mode `off`。
- 首轮 checkpoint：`/tmp/unseen-c3-revision-fdb3efe/`。
- 窄复验 checkpoint：`/tmp/unseen-c3-revision-cd01736/`。
- 首轮固定对象：commit `fdb3efe815e864f93e38202dbcb58fab1335cdb9`、tree `ce98f9fbf1e27d2ac55ea7304188acd0ebc58b61`、parent `f09f0ce9b622a6fcad0c05614bbe06b229ffb572`、28 paths、clean。
- 首轮结论：`FAIL · P0=0 · P1=1 · post-local P2=3`；完整报告 SHA-256 `c17729a18339840c94e589dc3008969c430568b02543c3aa8cfd58cf57e51a08`。
- 唯一 P1：Book registry 已声明五组 `equalityLock.stateEnumEquality`，但 JS/Python 两门只验状态机内部自洽，没有逐组比较 DTO enum 与 machine states。
- 最小关闭：两门都读取恰好五个 lock，解析 `schemaPath` / `machinePath`，要求 `comparison=exact_set` 并逐项比较集合；未改合同正文。
- 窄复验固定对象：commit `cd01736a0f7e319bc973a2d93d99026189d8695d`、tree `ff165f1c61e59e199288ce7e331ddc0befb76d77`、同一单亲、28 paths、clean；相对首轮只有上述两文件。
- 窄复验结论：`PASS · P0=0 · P1=0 · post-local P2=3`；最终报告 SHA-256 `0ad94d1d4b0b6f6f30a71657a0922bdab6f54c4eff4d21811b35833b96a22fab`。
- 最终 gate：`ERRORS=0`。

独立负测逐台对 `memoryInterview / bookAuthorization / bookDraft / bookVersion / renderArtifact` 做 machine-only consistent rename；十次门禁运行（五台 × JS/Python）均只以 `state-enum exact-set drift` 失败，每次恰好一个 error。当前五对全部通过。

### Frozen title 窄复验

- 固定对象：commit `e33bea21650748ce9c0863efe80e675f3e5c04d3`、tree `b65f2c9fbd1d4adf9e416f92ffc81b8499cf2266`、single parent `f09f0ce9b622a6fcad0c05614bbe06b229ffb572`、40 paths、clean。
- 与前一 effective revision 的 erratum diff：恰好上述六文件。
- checkpoint：`/tmp/unseen-c3-book-title-e33bea2/`。
- 结论：`PASS · P0=0 · P1=0 · new post-local P2=0`；既有三项 post-local debt 不变。
- 最终报告 SHA-256：`1139603d36ef4400187ffec202cc47721610a2e3c2346ac3382053913d044111`。
- 五项独立负测分别删除 required title、title property、include-title hash 语义、canonical hash 语义和 Book 合同 required-title 语义；JS/Python 每次均精确以一个 `book frozen manifest title/hash drift` 拒绝，恢复后双门 PASS。

## 4. 最终机器证据

```text
npm run revision:check
  check-revision-contract.mjs: errors=0
  c3_contract_gate.py: ERRORS=0
  runtime-remediation-a-d: errors=0
  runtime tests: 5/5 PASS

node --test scripts/gates/check-freeze-manifest.synthetic.test.mjs: 8/8 PASS
node --test scripts/gates/path-order.test.mjs: 3/3 PASS
npm run format:check: FORMAT_OK files=35 parsedJson=12 syntaxChecked=16
npm run secret:scan: SECRET_SCAN_CLEAN files=424 findings=0
enum-lock negative: current PASS; five machine-only renames rejected by JS and Python
frozen-title negative: current PASS; five title/hash drifts rejected by JS and Python
```

候选阶段的旧 `FREEZE-MANIFEST.json` v1、旧 provenance、旧 6 generated 和本收据缺席是预先声明的 lifecycle pending，不是 C3 finding。它们只在本收据成立后由 controller 生成并作 effective-revision re-freeze。

## 5. Post-local debt（非阻断）

以下三项均分类为 `non_blocking_governance_or_quality`，处置为 `post_local_operable`。逐项确认：不影响 `authorization / privacy / data_consistency / real_integration_seam`，因此不阻断 C4 re-freeze 或 Local Operable。

1. `C3-P2-1-source-snapshot-prose`：`technical/ACTION-API-COVERAGE.json` 的 mtime、observed state 与 stability prose 陈旧；承重的 bytes/sha256 已与 repo/authority byte-exact 验证一致。
2. `C3-P2-2-book-draft-label`：`BOOK-LAB-CONTRACT.md` 仍含历史 `DRAFT ONLY / 未合并` 与旧 core registry hash 文案；实际 core/book action intersection 由两门实时计算并通过，冻结 hashes 绑定当前字节。
3. `C3-P2-3-orchestration-wording-format`：编排 §6.1 的 Stage L 停笔句漏写 8B、另有一处 JSON 缩进不齐；§2 已精确要求 8B 在第二波前停笔，Freeze exact track policy 与 writer cap 仍可执行且已通过。

## 6. Unknowns 与边界

- 本收据后的 32-entry provenance、11 generated 和 FREEZE v2 尚需由 controller 生成、全量验证与独立读回；本文件不自宣 C4 Complete。
- 未重开历史 C2/R2，也未重审已 PASS 的 Viewer commit `5e068e3d04263adc2f480ac9db5a3bc1f18157d7`。
- 正式 QuestionProvider、云 sandbox、真实定位数据、发布与真机证据仍由后续各自 gate 管理，不阻断合同 re-freeze 或明确标注 fixture 的 Local Operable。

## 7. C3 后允许的派生收口

从固定 C3 候选到 effective revision 只允许刷新本收据、32-entry provenance、11 个 generated 文件、`FREEZE-MANIFEST.json` v2，以及把已由 controller 登记且已有不可变 registration receipt 的 8A/8B lifecycle 从 `planned_not_created` 投影为 `existing`；不得再改语义合同或业务实现。最终 effective revision 必须仍只有 parent `f09f0ce9b622a6fcad0c05614bbe06b229ffb572`，并由 controller 在 post-commit 全量 gate 与读回通过后单独宣布 C4 Complete。

## 8. Frozen title 窄勘误（PASS）

Track 8B 独立模块验收发现一个真实 P1：原 `FrozenBookManifest` 未保存书名，导致 BL05 修改并冻结的书名无法被离线 renderer 诚实消费。修复候选把 required `title` 纳入 immutable manifest，并要求 `BOOK.FREEZE` 在同一事务锁定且核对 `memory_books.title == current book_draft_versions.title`；`manifestHash` 省略自身字段后覆盖精确书名、页面、授权原话与冻结资产。renderer 只读 frozen title，不回读 live BookDraft/当前书名；冻结后的改名只进入新 draft/version，旧版本不漂移。

Codex scope-locked C2 在 commit `6acbb588ac94a2da5ab4dfb3f93b87ab2aebd76a` 对相同产品语义给出 `PASS · P0=0 · P1=0`；桌面 Claude Code 随后从零审阅固定候选 `e33bea21650748ce9c0863efe80e675f3e5c04d3` 并给出 `PASS · P0=0 · P1=0 · new post-local P2=0`。动作数、API、状态机、CAS、权限、既有 P2 债与 Local Operable 边界均未改变。本收据仍不自宣 C4 Complete；C4 只由 post-commit 全量 gate 与 controller 读回决定。
