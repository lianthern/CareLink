# 统一仓库迁移记录 · 2026-09-20

本页记录开发代码整合的范围。随后增加的草稿、实验、原素材、完整 Git 历史和未提交修改归档见 [总档案](../../ARCHIVE.md)；下方“省略”指没有放入开发源码目录，不表示这些资料被删除。

## 版本与范围

整合分支：`codex/unseen-team-monorepo-20260920`。核心基线是 `4594de9a153d3c191ce3fe86796c2384326b3f7f`，包含核查时在生产运行的 core `c89e112b4536d830c8e88324e94c74e012fbc649`。App 来源为生产对应的 `8c4905420dc11d356f60f00951b3a352de664791`。

这是源码快照导入。核心 Git 历史保留在当前仓库；其他模块的完整历史保留在原仓库，通过来源提交回查。没有合并源仓库中的未提交修改，没有覆盖本机 `unseen/main` 上的修改。

机器可读入口：[`sources.json`](../../provenance/team-monorepo-20260920/sources.json)。同目录的各模块 JSON 逐文件记录导入前的 SHA256 和省略原因；这些是来源指纹，不是改造后文件的校验清单。

| 模块 | 来源 | 目标 |
| --- | --- | --- |
| 当前 App | `maxi-max-dev/huijian` | `apps/huijian/` |
| UNSEEN 设备处理与实验 | `maxi-max-dev/max-agent-bridge` | `tools/agent-bridge/` |
| 空间展厅 | `maxi-max-dev/unseen-ui-preview` 的服务器优化分支 | `demos/spaces-gallery/` |
| 旧版站点 | `maxi-max-dev/unseen-classic` | `archive/unseen-classic/` |
| V6 影片页 | `maxi-max-dev/unseen-film` | `demos/film/` |
| 照片交互实验 | `maxi-max-dev/unseen-photo-jelly` | `demos/photo-jelly/` |
| 早期回见 Demo | `maxi-max-dev/huijian-demo` | `demos/huijian/` |
| 早期 UNSEEN Demo | `maxi-max-dev/unseen-demo` | `archive/unseen-demo/` |
| ModelScope 展示入口 | `modelscope.cn/studios/maximax/Unseen` | `demos/modelscope/` |
| 路线说明页 | 本机 `unseen-routes` 快照 | `demos/routes/` |
| 空间活动演示 | 本机 `unseen-live-events/public` 快照 | `demos/live-events/` |

## 为独立使用做的适配

- App 纳入根目录 npm workspace 与 lockfile，原 App lockfile 作为来源记录保留。
- 增加本地双进程启动、独立状态目录、环境变量隔离与成对停止；默认关闭外部模型提供商。
- App 的密钥读取模块改名为 `provider-keys.mjs`，支持仅从显式环境变量取值。
- 不重复提交旧版本的 App 构建目录；从源码生成当前 bundle。保留测试依赖的资源收据。
- 原 App 测试中的跨仓库 `git show` 依赖改为经过比对的固定 SHA256。
- 移除内嵌的旧活动访客令牌，测试中的模拟凭证添加明确的 `not-a-real` 标记。
- 秘钥扫描继续覆盖新模块，仅保留一个不含凭证的处理工具配置例外和一个不可变任务中的精确模拟 token 例外。
- 本机路线页引用的 DAP 素材软链接转换为实际文件，避免队友遇到绝对路径失效。

## 省略的内容

历史 `.task/` 截图及执行证据、个人工具设置、无关的 MiniMax H3 设备任务、classic 的 OSS 数据快照、旧版内嵌离线大包没有重新复制；原仓库仍保留这些材料。

较大演示素材见 [`optional-assets.json`](../../provenance/optional-assets.json)。本次不包含所有设备上的未提交草稿、生产数据库、完整服务器数据、模型权重或所有影片工程，因此不能称为“全量备份已完成”。

## 检查命令

根目录执行 `npm ci`、`npm run app:check`、`npm run team:check`、`npm run check`。

处理工具在 `tools/agent-bridge/` 执行：

```sh
python3 -B scripts/verify_bridge.py
python3 -B -m unittest discover -s tests -p 'test_*.py'
python3 -B -m unittest discover -s jobs/to-4060/unseen-3dgs-local-product-2026-09-04-v15/inputs/tests -p 'test_*.py'
```

实际结果记在 [`VALIDATION-20260920.md`](VALIDATION-20260920.md)。这些检查不代表 Windows / RTX 4060 实机重跑，也不代表生产发布已完成。
