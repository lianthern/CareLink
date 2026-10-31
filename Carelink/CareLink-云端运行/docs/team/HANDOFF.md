# 队友从这里开始

这是 `maxi-max-dev/unseen` 的统一团队仓库。只需要先获得这个私有仓库的权限，就能取得主站、后端、处理工具和演示源代码。

AI 记忆相框 0.5.6 独立运行，见 [相框开发说明](../../products/memory-frame/README.md)。完整目录关系见 [项目地图](PROJECT-MAP.md)。

## 第一次使用

1. Max 在 [仓库权限页](https://github.com/maxi-max-dev/unseen/settings/access) 添加队友的 GitHub 用户名；队友接受邀请。
2. 安装 Git 和 Node.js；本次验证版本为 22.23.1，已记录在根目录 `.nvmrc`。需要跑后端的照片解码测试时，还需要 ffmpeg/ffprobe。
3. 拉取默认 main 分支并安装：

```sh
git clone https://github.com/maxi-max-dev/unseen.git
cd unseen
npm ci
npm run dev
```

打开终端给出的 `/app-v2` 地址，通常是 `http://127.0.0.1:4610/app-v2`。停止时按 Ctrl-C，App 和后端会一起退出。

端口被占用时，用 `UNSEEN_TEAM_PORT=0 npm run dev` 分配空闲端口。Windows PowerShell 对应 `$env:UNSEEN_TEAM_PORT='0'; npm run dev`。每个 checkout 的本地数据保存在 `.local/team/`，不会提交到 Git。

## 本地能运行什么

- App 页面、内置案例、canonical API、SQLite 和本地照片存储。
- 本地账号验证使用后端的测试验证码输出，不发送真实邮件或短信。
- 默认定位是测试 fixture；真实 CLIP、GPU 重建、远程 Worker 与付费模型没有由这个启动命令启用。
- MiniMax、World Labs 等外部服务默认关闭，也不会读取 Max 的 OpenClaw 密钥文件。需要测试真实提供商时，显式设置自己的环境变量，再设置 `UNSEEN_TEAM_ENABLE_PROVIDERS=1`。
- 示例中旧活动的固定访客令牌已换成无效占位符；新建自己的本地活动并生成邀请后再测试账号流程。

例如在自己的终端中设置 `MINIMAX_API_KEY` 后执行 `UNSEEN_TEAM_ENABLE_PROVIDERS=1 npm run dev`。不要把真实密钥写进命令示例、提交、截图或任务记录。真实 World Labs 生成仍需要额外的账户和生成配置。

## 目录入口

| 你要改什么 | 目录 |
| --- | --- |
| 当前 UNSEEN App / 回忆时刻 / 照片场景 | `apps/huijian/` |
| 账号、活动、照片、权限、存储与任务 | `services/api/`、`services/jobs/` |
| 定位与 CLIP sidecar | `services/locator/` |
| 成书、相册和共享组件 | `services/book-lab/`、`packages/`、`apps/book-lab-web/` |
| RTX 4060 / WSL 处理流程、源码和既有任务回执 | `tools/agent-bridge/` |
| 空间展厅、路线说明、影片页等 | `demos/` |
| 旧版站点与早期实现 | `archive/unseen-classic/`、`archive/unseen-demo/`、原有 `imports/` |
| 运维与已有部署说明 | `ops/`、`runbooks/` |
| 草稿、实验过程、原素材、旧分支和未提交修改 | [总档案](../../ARCHIVE.md) |

Agent Bridge 是原仓库的 UNSEEN 范围快照，保留不可变任务、结果和任务合同。原有 4060 接收器仍使用原 Bridge 的 GitHub Release / Issue；这次没有切换它的自动投递目标。不要根据快照中的状态表推断 GPU 任务现在正在运行。

## 演示与较大素材

`npm run assets` 列出可选文件。普通 Git checkout 不包含这批影片、SOG、GLB、体素数据。清单固定了来源提交、路径、大小和 SHA256。

```sh
gh auth login
npm run assets -- fetch spaces-gallery
python3 -m http.server 8080 --bind 127.0.0.1 --directory demos/spaces-gallery
```

打开 `http://127.0.0.1:8080/`。下载器只下载指定模块；已有文件不一致时会停止，下载完成后会检查哈希。

原下载器仍沿用原仓库来源，私有来源需要相应权限。清单中的 53 个素材条目在本次总档案中均找到了同 SHA256 的原件，包括原先仅有本地来源的 `live-events` 模型。Max 可以用 `python3 scripts/archive/archive.py find 文件SHA256` 找到记录，再按 [归档说明](../../ARCHIVE.md) 取回并提供需要的素材。恢复完整加密档案需要独立密钥；日常代码协作不需要分享这把密钥。`demos/routes/` 的原本机软链接已转换为真实素材文件，拉取后即可静态预览。

`demos/film/` 是已发布的 V6 影片入口源码；本机发现的其他剪辑、设备素材、路演工程和模型权重从总档案按需取回，不随普通 Git clone 下载。

## 检查与协作

```sh
npm run app:check   # App 构建和现有测试
npm run team:check  # 真实启动 App + 后端，检查代理、页面、隔离与退出
npm run check      # 根目录完整既有检查，加上 App 和整合检查
```

`team:check` 需要先运行 `app:build` 或 `app:check`。Python 处理工具的检查见 [`MIGRATION-20260920.md`](MIGRATION-20260920.md)，GPU 训练不能由这些单元测试代替。

每位队友或 Agent 为每项任务使用自己的分支和工作目录，提交后通过 PR 汇合。修改同一功能时先在任务记录里说明范围。任务的目标、主要结论、验证结果和产物链接写在 [`docs/work/`](../work/README.md)，无需把每次工具调用复制进 Git。

## 发布与备份边界

这次是源码交接，不是生产环境迁移。服务器仍运行原 App / core release，原仓库及其他设备工作目录也保留。原 App 部署脚本中的独立仓库假设需要按新路径重新演练后才能切生产；不要直接把新分支 SHA 填入旧部署命令。

GitHub 的代码提交与原件归档是两条独立记录：代码随分支推送，大原件以加密附件保存在同仓库 Release，并由目录索引。已建立的日期快照不覆盖未来变动，也不包含其他设备尚未同步回本机的文件和服务器当前数据库。本次没有修复服务器备份或配置自动同步。
