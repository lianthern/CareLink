# 0.4.7 Link 2 云驻足邀请与比赛源码

2026-09-23，原 CloudBase 环境已更新到 **0.4.7**，运行代码 `5772f48b1c09c43616d4ad4df2b2a586be703f1b`。原家人/相框地址不变，未修改旧 UNSEEN 服务、DNS、角色、套餐或实时语音开关。

## 实现与审查

- 后端 `ef388f7`：独立传感器令牌绑定家庭和指定相框会话，owner 签发/轮换/撤销，CloudStore CAS 幂等与单调序号，持久限流及短时清理。
- 前端 `78b5220`：现有轮询下发，持久去重、可见/照片/录音/播放/AI/通话等门禁，固定触发照片，老人确认后调用 `MemoryAI.open(id)`。家人设置增加令牌管理。独立复审发现并修复慢 state 响应延长 TTL，以及旧录音授权迟到时的资源泄漏。
- 总控先核对 `git cherry`，确认均为新补丁后合入独立 `codex/presence-cloud-integration`。3D 的权限、分段、摘要和 SSRF 边界保持原实现。
- 15秒是事件下发有效期。去重通常60秒、最多90秒；有界文档的机会清理与冻结期间物理残留限制见 [后端协议](PRESENCE-CLOUD-API.md)，不声称严格物理删除SLA。

## 证据分类

1. **整合源码完整回归：454/454通过，零失败、零跳过。** 使用本机 Playwright 与 Chrome，包含旧业务和新功能。原始日志在集成 worktree 忽略目录 `.tools/presence-full-test.log`。
2. **浏览器实际本地 HTTP：** Node HTTP、隔离 LocalStore、Chrome 完成 owner UI 签发、实际合成PNG上传、sensor POST、目标/非目标隔离、下一轮询邀请、刷新去重、固定照片确认及撤销关闭。API未替换，AI能力为本地替身，未调用供应商。详情见 [前端验收](PRESENCE-FRAME-ACCEPTANCE.md)。总控实际查看横竖屏截图。
3. **并发和SDK：** 生产 CloudStore CAS 配合替代数据库传输验证多worker冲突；真实SDK离线序列化验证空数组覆盖，避免嵌套对象残留。它们不是云网络证据。
4. **真实公网 HTTP：** 2026-09-23 22:37（北京时间）开始，复用既有家庭、账号及测试相框。health为0.4.7/cloudbase，7个静态资源与本地字节一致；三次并发同eventId返回同seq，重复和过期重试不续期；只有目标frame收到；owner/family无事件；原token轮换失效、旧事件不能借新token复活、非法headCount拒绝、撤销停止下发。前后12条记忆内容摘要一致，没有创建家庭、上传媒体、调用模型或启动实时语音。临时验证传感器已撤销、两个临时账号会话已退出。见 [脱敏JSON](PRESENCE-CLOUD-VERIFICATION.json)。预检时10条、正式验收时12条是既有家庭内容随时间的状态，不归因于本轮写入。
5. **公开包独立验证：** 168文件，167条清单字节校验通过；Git暂存区字节与工作文件逐项一致。公开包全量454/454，零跳过。模式扫描与本机真实私有配置/账号/会话逐值比对均为零命中。移除原Git历史、私有数据、旧交付文档及完整UNSEEN；旧测试凭据替换，演示照片换为代码生成PNG，保留第三方许可。公开历史只有本次README初始化与完整源码两个新提交，启动bootstrap保留可执行位。

真实 Windows Link 2、对方 uploader 进程、实体 iPad、真人录音和 GPU 尚未在本轮操作验证，不能用上述测试替代。下载目录只有对接方的两份交接文档，没有采集器源码/二进制。

## 接口交付

- URL：`POST https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/api`。
- `action:presenceReport`，成功HTTP200，响应 `{accepted:true,eventId,seq}`，Windows协议无需改动。
- 建议实际设备标识 `living-room-link2`；目标家庭复用既有测试家庭。
- **实际设备已绑定（2026-09-24）：** 用户指定Kevin，已由owner签发`living-room-link2`并真实API读回active/targetAvailable有效；检查时Kevin页面离线。本轮没有发送模拟事件，不把绑定成功当作硬件联调成功。
- 令牌与目标会话最晚于北京时间2026-09-30 18:40:03到期，退出/停用会提前失效。真实令牌以本机下载目录的私有配置包单独交付，不写到本文件或公开仓库。临时云验收令牌已撤销，不可作为现场令牌。
- 用户确认每台相框分别绑定外置摄像头，现有接口每家庭支持8个不同标识，各自绑定一个目标。参见[增加摄像头与连接步骤](EXTERNAL-CAMERA-SETUP.md)。本次仅增加绑定与说明，应用代码、已部署版本和公开源码快照未改变，未重跑此前454项业务回归。
- 对方启动后按eventId核对 Windows `captured/uploaded`、云函数 `[presence]` 与网页控制台 `[presence]`，保持 `/frame` 前台、有照片、非夜间时钟且空闲。事件不自动开麦。
- 已打开的家人/相框页面需刷新一次加载0.4.7；现有配对会话保留。

## 公开交付

用户已将目标明确为 GitHub。公开仓库：[maxi-max-dev/unseen-memory-frame](https://github.com/maxi-max-dev/unseen-memory-frame)，远端main提交 `3c3b808c28f7f5cd872082c7119afaeb16fc5417`。两次Git HTTPS上传因连接重置失败，随后通过GitHub官方Git Data API完成上传；168个blob逐个与本地Git摘要相同，文件树一致为 `437e9279bea2b57a4ee7226f7e60737a9a28a8ae`。为满足空仓库API条件先提交同一份脱敏README，再以普通快进更新提交完整文件树；没有强推或旧仓库历史。

本机源码快照提交 `01d51c841436237763c7901dd6e8bacf73ec8bb1`（相同文件树），目录 `D:/CodexData-20260923/Projects/unseenframe-public-release/unseen-memory-frame-0.4.7`。本地提交与远端提交因README初始化父提交不同而不同，不能据此误判文件不一致。

已用未登录网页读取器打开GitHub仓库，页面显示Public、main、两个提交与完整README/目录；GitHub API也确认PUBLIC和main。匿名Node直读raw域名发生网络失败，不将它称为raw下载验收；公开可见及文件树摘要核验均已有证据。

源码ZIP：同一交付父目录下 `unseen-memory-frame-public-0.4.7.zip`，由该新仓库的Git提交生成，不含`.git`、依赖、数据或日志。SHA-256：`26e7d1f576ae64d45888869bd89bb2466d81c06f952a7efd90550f0eb50598ec`。
