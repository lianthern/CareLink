# C4 bootstrap 治理档案

这里是 2026-08-13「C4 bootstrap 冻结基线」留下的治理文档，2026-08-19 从仓库根目录挪进来归档。**只作历史记录，不再是任何变更闸门。**

- `FREEZE-MANIFEST.json` / `FREEZE-MANIFEST.schema.json`：当年的冻结清单与其 schema。
- `C4-PROGRESS.md` / `C4-BLOCKED.md` / `C4-EVIDENCE.md`：当年的进度、阻塞与证据记录。

## 为什么挪走

那套流程（revision / freeze / provenance 三类关卡）是围绕「main 冻结、任何改动都要走 controller RFC」设计的。实际开发早已不是这个形态：主线在 `cc/beta-5` 上跑了 500 多个 commit，冻结关卡只剩每次 `npm test` 都要交的税。2026-08-19 把 beta 线转正为 main 时一并退役。

## 遗留引用说明

`scripts/gates/` 下的脚本按「默认保留」纪律一个都没删，但已从 `build` / `test` / `check` 链路里摘掉：

- `check-freeze-manifest.mjs`、`check-freeze-manifest.test.mjs`、`check-freeze-manifest.synthetic.test.mjs` 仍按老路径读根目录的 `FREEZE-MANIFEST.json`。文件已挪到本目录，这些脚本直接跑会 ENOENT——它们不再被任何 npm script 调用，属于休眠代码，保留只为留档。
- `check-revision-contract.mjs`、`runtime-revision-contract.mjs`、`check-provenance.mjs`、`path-order.mjs` 同理，休眠但保留。
- `check-format.mjs` 是**仍然生效**的关卡，它对这几个文件的路径引用已同步更新到 `archive/c4-bootstrap/` 下，所以归档后的文件仍受格式检查保护。

现在真正生效的关卡只有：`contracts:check`（防生成物被手改）、`format:check`、`secret:scan`、`backend:baseline`。

`contracts/source/` 是同一时期的历史合同文档，同样不再是变更闸门。
