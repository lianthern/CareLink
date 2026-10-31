# UNSEEN 总档案

这里保存项目走过的过程：草稿、失败实验、历史代码、截图、路演工程、原照片和视频、模型、设备处理回执，以及旧分支和未提交修改。

当前开发代码直接在本仓库中。历史原件按内容去重、加密后放在**同一私有仓库的 [2026-09-20 归档附件](https://github.com/maxi-max-dev/unseen/releases/tag/unseen-archive-20260920)**。普通 clone 不会下载全部原视频与历史资料。

## 找文件

**下载或 clone 仓库后，用浏览器打开 [总档案搜索页](archive/catalog/20260920/search.html)。** 这是独立 HTML，目录内嵌，无需启动服务。GitHub 网页不会直接运行这个 HTML；可用页面右上角 Download raw file 下载后打开。

输入“路演”“照片”“3dgs”、文件名、文档标题或原目录名，可以筛选类型和来源。点击“复制取回命令”，在本仓库根目录运行。搜索范围是名称、来源和 Markdown 标题，不是所有二进制内容的全文检索。

也可以在命令行搜索：

```sh
python3 scripts/archive/archive.py find 路演
python3 scripts/archive/archive.py find "photo-scenes" --category 图片与截图
python3 scripts/archive/archive.py find "history-" --json
python3 scripts/archive/archive.py coverage
```

`--limit 0` 显示全部结果；每条记录有独立 ID。相同内容在不同目录出现，仍保留各自的来源记录。

## 取回原件

```sh
python3 scripts/archive/archive.py restore 文件ID --output .local/restored/新的文件名
```

与当前代码完全相同的文件直接从 checkout 复制。其他原件需要 Python 3.9+、GitHub CLI、age、此私有仓库的读取权限，以及单独保管的 age 恢复密钥。先用 `gh auth login` 登录自己的 GitHub 账号；macOS 可用 `brew install age gh` 安装工具。

恢复密钥默认位置为 `~/.config/unseen-archive/owner-20260920.agekey`；也可通过 `--key /自己的/恢复密钥.agekey` 指定。**密钥不在 GitHub，丢失后无法恢复加密附件。持有人应在密码管理器或另一台设备另存一份。** 代码协作邀请不需要分享此密钥；完整历史中可能有运行凭证与用户数据，原件恢复权由持有人单独管理。

工具只下载所需附件，核对加密附件 SHA256，解密后核对 ZIP、每个分块和完整文件的 SHA256。恢复必须写入一个新路径，已有文件和符号链接均不会被覆盖。大文件需要为目标文件、所需加密附件缓存，以及一个解密附件预留空间；缓存位于 `.local/archive-cache/`，会保留供后续恢复复用。

## 找旧分支与未提交修改

[Git 历史目录](archive/catalog/20260920/histories.json) 列出原仓库、refs 和对应 bundle 的文件 ID。取回 bundle 后，可以在新目录中检查：

```sh
git clone .local/restored/history-000.bundle .local/recovered-old-repository
```

这里保留的是捕获时可用的 refs、HEAD 和 reflog 可达历史。未提交普通文件另行保存；暂存和未暂存差异另存为 `working-changes` 条目。恢复 `worktree-changes.json` 可以找到原工作目录、HEAD 和相应 patch 的文件 ID。原目录删除记录在状态文件及 patch 中保留，不会通过恢复操作删除你的现有文件。

完整原路径、符号链接目标、排除目录和工作目录状态保存在加密的 `complete-capture-manifest.json`，文件 ID 为 `complete-capture-20260920`。早期的 `capture-manifest.json` 也保留为过程记录。搜索目录只公开文件元数据与少量文档标题，不包含原件正文、恢复私钥或完整运行配置。

## 本次覆盖范围

精确数字与未覆盖项见 [覆盖记录](archive/catalog/20260920/coverage.json)。本次盘点覆盖这台 Mac 上发现的 65 个 UNSEEN / HUIJIAN / spatial-memory 来源目录和 96 个注册工作目录，其中 iCloud `Unseen` 目录的 68 份项目文件已实际读取；19 份 Git 数据库另存为 bundle。

另从下载目录、其他任务目录和 iCloud 旧目录中按项目名称补查资料，记录为三个选定文件集合。这里包含迁移到 iCloud 的 `ADVX`、`ADVX 2`、`ADVX 3` 内容及其中残留的 `.git` 文件；后者按原文件保存，不冒充已验证的完整 Git bundle。旧的本机 `Documents/ADVX` 路径不存在，不代表这些迁移副本丢失。

这是一份逐文件验证的快照，各目录不是同一时刻的原子快照。可重新安装的 `node_modules`、标准虚拟环境和 Python 缓存不重复备份；依赖版本与锁文件随项目保留。部分实验目录内改名过的虚拟环境仍按原件收录。

当前服务器数据库和用户上传原件、4060 / WSL 上未同步回本机的文件，以及未挂载或未发现的目录没有被当作已备份。本机已有的服务器备份副本已按其原始日期收录。符号链接保留链接记录，扫描目录外的目标不推定存在。

## 后续资料怎么归位

- 每台设备、每位队友和每个 Agent 使用自己的分支或 worktree。
- 每个任务在 `docs/work/` 留一份记录：目的、来源版本、做了什么、验证结果、产物位置。失败实验和被替换的草稿也保留来源。
- 小型草稿、说明、实验脚本随任务分支提交；原素材、运行数据和大产物进入新的归档快照，在任务记录中放文件 ID 或附件地址。
- 日期归档是快照，不会自动收集未来文件。当前没有新建自动备份、跨设备同步或服务器备份任务。

不要把项目目录整包同步进某个正在运行的 checkout；通过分支汇合代码，通过归档目录汇合历史资料。

## 校验与格式

```sh
python3 scripts/archive/archive.py verify
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/archive -v
```

`files.jsonl.gz` 保存文件目录，`objects.json.gz` 将内容 SHA256 映射到附件分块，`packs.json` 保存 GitHub 附件 ID、尺寸及指纹。`verify` 验证目录引用的完整性；它不等于下载全部附件重新校验。实际下载恢复的验证记录见 [归档工作记录](docs/work/2026-09-20-full-archive.md)。
