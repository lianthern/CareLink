# 2026-09-24 最新私有交接说明

当前 `codex/trtc-free-integration` 已整合实际在线 **0.4.9** 和 TRTC 受限桥接，完整本地 **578/578、零跳过**。TRTC 部署尝试因 CloudBase CLI 的 `AI_REALTIME_TTS_JSON` 环境值类型错误失败；随后官方 SCF 和公网读回确认原 0.4.9 及原配置未变，实时仍关闭。AppID/签名密钥已在本地私有草稿；控制凭据、免费额度、房间权限、云 Timer 及真人通话未完成。以根目录 `AGENT-HANDOFF.md` 最新段和完整私有包 `00-START-HERE.md` 为准；下面的 551/0.4.8 与旧缺项为历史。用户现要求交给具有浏览器权限的 AI 接手，并实现云服务不依赖原电脑常开。

# unseen 记忆相框：开发入口

**2026-09-24 TRTC 免费接入准备**：用户要求按免费方案继续；独立分支新增受限 hy3 SSE 桥接和真正可取消的传输，完整本地551/551零跳过，独立插话竞态复审已闭环。账号权益/四项凭据与房间配置仍缺，浏览器连接和CLI权限受阻；没有开通、付费或部署，公网仍为下述0.4.8且实时关闭。详见 [免费接入](memory-frame-demo/docs/TRTC-FREE-ACTIVATION.md)。

**最新0.4.8已整合部署（2026-09-24）**：Windows设备源码、确认后照片首问与影石作品自动导入已完成，独立流程/3D/整体审查完成。应用512/512、公开含设备536/536零跳过；真云8资源、事件鉴权与幂等、一次真实视觉首问及既有双账号17记忆/模型4段只读复核通过。Kevin绑定保留但现场硬件未验；TRTC仍关闭。GitHub更新9f1d687，193文件脱敏。详见 [本轮验收](memory-frame-demo/docs/RELEASE-048-ACCEPTANCE.md)。下方待整合/旧版本状态为历史。

**2026-09-24影石时光舱修复待整合**：中央＋ → 3D 空间可识别分享整段文字，寄出后自动导入，失败显示原因并可重试；未放宽资源域名。460项回归及真实样例双端 Chrome 软件渲染通过，原公网既有模型只读复验通过；未部署，公网仍0.4.7。见 [本轮说明](memory-frame-demo/docs/SPATIAL-LINK-ACCEPTANCE.md)。

**2026-09-24新到MVP包已审查**：不覆盖当前0.4.7；Windows上报器源码已获得并通过6项原测试+6组当前服务本地HTTP兼容验证。包内前后端属于旧0.4.5基底，保留原独立令牌与Kevin绑定。见[审查结论与接线](memory-frame-demo/docs/MVP-UPDATE-REVIEW.md)。原RAR含私有资料，不入公开仓库；实体摄像头仍待现场验收。

**最新0.4.7 / `5772f48`已部署（2026-09-23 22:37后）**：Link 2独立令牌、CloudBase短时幂等事件、目标相框state及确认后打开固定照片AI邀请已接入。整合与公开包各454/454零跳过，实际本地HTTP+Chrome及公网协议验证通过。2026-09-24按用户指定完成Kevin真实绑定并读回，私有连接包在下载目录；检查时Kevin页面离线，现场Link 2/iPad未验。用户确认每台相框分别绑定外置摄像头，见[连接说明](memory-frame-demo/docs/EXTERNAL-CAMERA-SETUP.md)。已公开比赛 [GitHub源码](https://github.com/maxi-max-dev/unseen-memory-frame)，仅相框主体，无原私有数据/历史/完整UNSEEN。详见 [验收与交付](memory-frame-demo/docs/PRESENCE-RELEASE-ACCEPTANCE.md)。刷新现有页面加载新版；此前便携包是历史快照。

**最新公网0.4.6 / `7e20cd3`（2026-09-23 20:05后）**：平板明确为老人相框，恢复大照片主画面和中央绿听/红说按钮；手机首页新增只读相框预览。AI语音补齐目标音频就绪与挂断未确认重试，TRTC仍未开通，文字/识图保留。集成411项通过（零跳过），公网10静态资源与既有双账号HTTP通过，无新云家庭/内容写入。见 [本轮验收](memory-frame-demo/docs/ELDER-FRAME-VOICE-ACCEPTANCE.md)。下面0.4.5与便携包为之前交付记录，便携包未因本次上线自动更新。

**最新交付（2026-09-23 19:00后）：用户自行上传含内容/访问资料的私有可运行包。** Windows解压后双击包根目录 `START-WINDOWS.cmd`，本地账号见 `private-access/LOCAL-PREVIEW-LOGIN.txt`；线上地址、既有演示账号、云函数访问与当前私有部署配置也按授权放入 `private-access`，不进Git。已有10条消息、照片/音频与3D快照可独立恢复；线上AI与离线内容预览分开。见 [便携交付](memory-frame-demo/docs/PORTABLE-DELIVERY.md)。TRTC属于腾讯但不是必需，替代路线见 [腾讯语音方案](memory-frame-demo/docs/TENCENT-VOICE-OPTIONS.md)，尚未自动换接或开通。

**最新公网为 0.4.5 / `561c6ec`（2026-09-23 18:46）。** 登录后首页家庭名下方有“和 AI 聊天 / 实时语音”；文字聊天与识图保留，窗口切换可保留临时内容。实时服务尚未开通，按钮禁用且不申请麦克风。集成全量394项通过（含隔离浏览器、接口/音频替身），公网8静态资源及既有双账号通过；无真人语音/摄像头验证。见 [最新验收](memory-frame-demo/docs/REALTIME-045-ACCEPTANCE.md)。TRTC配置与真实联调仍待处理，见 [开通方案](memory-frame-demo/docs/TRTC-SETUP-PLAN.md)。用户已暂缓夸克上传。下方0.4.4及“本轮未上线”叙述保留为历史。

**本轮新增接口另见 [摄像头与实时 AI 交付验收](memory-frame-demo/docs/CAMERA-REALTIME-ACCEPTANCE.md)。** Link 2 本地感知接口默认关闭，已有 35 项策略/生命周期测试；AI 实时语音按用户要求预留腾讯 TRTC 接入，开通和费用稍后确认。原有 hy3 文字聊天继续保留。以下 0.4.4 是已有公网部署状态，不代表本轮新接口已经上线或完成硬件验收。

**当前公网 0.4.4 / 51686dc 已上线**。文字模型 CloudBase hy3，视觉模型用户自有 MiniMax-M3；真实普通/多轮/留言候选及单/双图五项全过，61静态文件和既有双账号HTTP通过，原8条记忆未变。MiniMax最终28项定向测试通过。字体、录音转写/朗读、共享文字/照片/原声留言与站内提醒保持；真正实时语音电话按用户要求暂缓。Key已配置于服务端忽略文件，无须再索取或寻找旧服务器；未升级套餐/扩角色/新建环境。完整[勾选验收清单](memory-frame-demo/docs/DEMO-ACCEPTANCE.md)区分实现、真实接口与用户实机证据，以下旧状态只作历史。

更新：2026-09-23。Windows 接手已完成；主目录为 `D:\CodexData-20260923\Projects\unseenframe`。旧 UNSEEN 服务、资源和 DNS 不在本次修改范围。

**新 agent 先读 [当前状态与接手顺序](AGENT-HANDOFF.md)**，其中包含已完成工作、真实验收边界、后续优先级和打包恢复入口。

- [公网家人端](https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/family)
- [公网相框端](https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/frame)
- [功能与用法](memory-frame-demo/README.md)、[总控交接](memory-frame-demo/HANDOFF.md)
- [部署记录](memory-frame-demo/DEPLOYMENT.md)、[Windows 验收](memory-frame-demo/docs/WINDOWS-ACCEPTANCE.md)
- [原 Demo 顺序与完整 UNSEEN 参考](memory-frame-demo/docs/PRODUCT-REFERENCE.md)

## 本地运行

本机已验证 Node 24.19.0、Git 2.53.0、pnpm 11.19.0。云函数仍用 Nodejs20.19。

在 `memory-frame-demo` 执行：

```powershell
pnpm.cmd install --frozen-lockfile
cd server
pnpm.cmd install --frozen-lockfile
cd ..
node --test test/*.test.js
node server/server.js
```

访问 `http://127.0.0.1:8787/family` 与 `http://127.0.0.1:8787/frame`。本地持久数据在 `.data/`，创建家庭的开通码在 `.data/setup-code`。不要让多个进程共用同一数据目录；更新服务前先确认并停止本任务启动的旧进程。

家人可注册账号、重复登录，相框使用配对邀请。旧免账号邀请仍兼容。本地与公网属于不同存储，账号不通用。规则与恢复边界见 [ACCOUNTS.md](memory-frame-demo/docs/ACCOUNTS.md)。

## 更新既有公网环境

用户已完成本机腾讯云 CLI 设备授权，账号版本已更新到原公网链接。私有配置从本人接手包恢复到 `memory-frame-demo/cloudbaserc.local.json`，被 Git 忽略。不要输出或提交该文件、测试会话、开通码与供应商签名 URL。

验证代码后，在 `memory-frame-demo` 执行：

```powershell
node scripts/deploy.mjs --update
```

脚本只允许环境 `memory-frame-demo-d7djiee0702b6c`。保留开通码、`AI_MODEL=hy3`、`MemoryFrameDemoRuntime` 角色及函数资源配置；不需要新建环境、迁移数据或购买 API Key。CLI 授权过期时再运行 `node node_modules/@cloudbase/cli/bin/tcb login --flow device`。

## 分工与验证

总控负责协议、审查、合并、部署与验收，实现使用 `codex/` 分支和独立 worktree。前端、后端、3D、账号成果均已合入主线，不重复合并旧任务。

公网当前版本 `0.4.2` 已增加完整历史分页：首页与人物/时间轴可加载更早记忆，旧记录编辑、删除与媒体地址随轮询刷新。本次集成 129 项测试通过；既有两账号各 4 页读完 8 条云记忆，9 个静态资源字节一致，没有新增云家庭或记忆。见 [本轮验收](memory-frame-demo/docs/HISTORY-ACCEPTANCE.md)。

前次 0.4.1 已验证账号、照片/WAV 传输、相框回执回复及真云 3D 分段读取，本轮没有全部重做。当前浏览器枚举失败、IAB 打开超时，不能表述为新版点击流程、手机真人录音或移动 GPU 已验收。历史分页已集成，不重复实现。

Windows 恢复基线 `3d8580f`，59 项清单文件已校验。下载包与原 Mac 说明是历史证据，当前交接以最新仓库文档和源码为准。
