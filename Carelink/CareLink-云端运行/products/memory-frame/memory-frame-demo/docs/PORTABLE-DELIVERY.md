# 含内容与服务器访问资料的私有交接包

用户于2026-09-23追加：由本人上传云盘，收件人应能完整打开，包括已有内容与服务器访问方式，并计划随后重置登录方式。本轮因此增加单独的私有可运行交接包；此前不含配置/内容的源码包继续作为开发历史快照。实际密码、Key、云数据与本地预览数据均不进Git，源码只保存打包与恢复工具。

## 打开与接手

- 根目录 `START-WINDOWS.cmd` 使用包内 Windows x64 Node.js 与锁文件对应的生产依赖，无需安装开发工具；仅绑定127.0.0.1。首次从 `content/seed-data` 复制独立工作数据，后续本地修改不回写线上。账号见包内 `private-access/LOCAL-PREVIEW-LOGIN.txt`。
- `OPEN-ONLINE.url` 指向当前在线0.4.5，账号和服务器步骤见 `private-access/ONLINE-AND-SERVER-ACCESS.txt`。已有文字模型hy3与识图仍在云端运行，本地内容预览没有自动接入AI或摄像头。
- 本包按用户授权附当前项目 `cloudbaserc.local.json` 及现有两个演示账号；配置包括现有服务端项目开通码、识图Key和函数资源。仅在 `private-access` 交接，启动器不读取它。没有复制浏览器/CLI登录态、原云会话、其他项目凭据或腾讯云主账号登录密码。
- 云端是上海CloudBase云函数，固定环境 `memory-frame-demo-d7djiee0702b6c`、函数 `memory-frame-demo`，不是SSH虚拟机。服务管理由接手人用获授权账号重新登录CloudBase CLI；当前配置不代表其自动获得云账户管理权限。重置后相应交接资料需更新。
- Mac/Linux可使用已有Node.js 20.19+或24 LTS执行 `sh START-MAC-LINUX.sh`；本轮实际运行验证以Windows为准，不把附启动脚本视为跨平台实测。

## 内容范围

内容导出工具只使用既有账号读其当前可见家庭内容，包含分页消息、人物/回执及关联照片、音频、3D。3D仍走原有4MiB鉴权分段及整文件摘要。不是已删除内容、其他家庭、云后台全部集合、供应商任务或原登录会话的数据库备份。

导出种子生成全新本地owner/family账号，不搬运云登录状态；内容和关联以导出快照及恢复报告为准。照片/原声音频是独立二进制文件，内容快照不依赖即将过期的签名下载链接。包内 `content/content-summary.json` 记录实际数量，`content/verification/RESTORE-VERIFICATION.json` 记录本地HTTP恢复检查。

## 可复现打包

1. 审查、提交并合并所有实现，保留干净worktree；用现有 `scripts/package-handoff.py` 生成包含源码、所有分支Git bundle、完整UNSEEN参考与脱敏证据的开发包。
2. 按当前 `server/pnpm-lock.yaml` 在仓库外独立目录安装生产依赖：`pnpm install --prod --frozen-lockfile --node-linker=hoisted --ignore-scripts`。输入依赖树必须全部为普通文件，不能依赖本机pnpm仓库链接。
3. 使用 `scripts/portable-content.mjs` 的帮助说明导出、创建本地种子并验证内容；只将确定的导出目录交给打包工具，不能直接打包 `.tools/`。
4. 运行 `scripts/package-private-delivery.py --help`，显式指定开发包、内容目录、普通文件依赖目录、Node运行时及许可、项目私有部署配置与原账号上下文、新输出目录。只有本私有交接步骤复制获授权的访问资料。
5. 检查逐文件SHA-256、ZIP内字节；再从ZIP解压到另一个干净目录，用包内运行时和启动器实际登录/读取媒体/3D并停止实例，记录结果。业务源码未改时不因打包重复整套回归；不能把校验通过当成真人语音/摄像头/GPU验收。

工具拒绝覆盖既有交付目录。`VERIFY-WINDOWS.cmd` 核验包内原始文件，后续预览生成的 `preview/data` 不在原始清单中。Git历史恢复命令和开发流程见开发包原有交接文档。

实时语音没有因打包被启用。TRTC本身也是腾讯但非必须；其他腾讯路线的证据、接线差异和未完成边界见 [腾讯语音方案](TENCENT-VOICE-OPTIONS.md)。
