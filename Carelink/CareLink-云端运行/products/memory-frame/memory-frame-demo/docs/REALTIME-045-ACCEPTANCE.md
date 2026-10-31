# 0.4.5 聊天入口与 TRTC 接入准备验收

日期：2026-09-23。运行代码 `561c6ecfd62c91f26456aa6918c9b4575f49f711` 已部署到既有腾讯云环境，健康接口返回0.4.5、cloudbase存储。后续提交仅修云验证脚本和交接证据，没有再次变更运行代码。

## 实施与复审

- UI任务 `codex/ai-chat-ux` / `a36cac1`：首页明显入口、文字切换恢复临时内容、功能重试、窄屏与键盘焦点、麦克风错误及挂断状态。作者86项通过；独立复审重复86项并另验3项原声/迟到转写/迟到麦克风边界，无P1/P2阻塞。见 [UI验收](AI-CHAT-UX-ACCEPTANCE.md)。
- 后端任务 `codex/trtc-readiness` / `7508ca3`：Flow02及显式旧01配置、开始/停止配置分离、持久TaskId及迟到/崩溃清理、默认关闭私有Timer入口、离线配置预检。作者定向74项通过，最终清理日志调整后22项复验；独立最终复审4项及三进程持久化重启/失败重试通过，无阻塞。见 [接入准备](TRTC-READINESS.md)。
- 总控独立worktree `codex/chat-release-checks`：版本0.4.5、仅复用既有家庭的云验证脚本及官方开通方案。验证脚本经过独立正常/异常/畸形私有输入与篡改静态资源测试，错误不输出私有输入。
- 合并前 `git cherry main <branch>` 核对为新补丁，保留所有既有worktree，不重复合并旧成果；3D业务代码与权限/分段/摘要边界未改。

## 集成实际执行

在主目录 `memory-frame-demo`，显式设置已有 Playwright模块、Chrome路径和截图目录后运行：

```powershell
node --test --test-timeout=60000 test/*.test.js
```

结果 **394 tests / 394 pass / 0 fail / 0 skipped**，约10.96秒。日志 `.tools/release-045-full-test.log` 将作为交付包 evidence。浏览器为独立headless Chrome153，320/390/1280三档加载实际HTML/CSS/JS，API和音频被替身截获、外部网络禁用；它证明实际浏览器点击/键盘/布局行为，不证明公网模型或真实音频。截图 `.tools/release-045-ui/`，总控另查看390px首页及作者320px首页/文字/语音截图。

离线预检实际读取原私有部署配置：`serviceEnabled=false`、`configurationReady=false`、七个核心实时配置字段missing、`networkRequests=0`；预检按设计返回2。本轮没有执行可产生模型用量的 `--probe-llm`。脱敏结果另存 `TRTC-CONFIG-VERIFICATION.json`。

## 公网实际执行

部署命令为既有 `node scripts/deploy.mjs --update`，返回0。私有配置、既有模型与运行角色保持；不新增环境、Timer、API Key或付费开关。正式复验：

```powershell
node scripts/check-realtime-deployment.mjs .tools/cloud-account-acceptance-context.json .tools/release-045-cloud-verification-final.json
```

最终 `passed:true`，脱敏结果见 [REALTIME-CLOUD-VERIFICATION.json](REALTIME-CLOUD-VERIFICATION.json)：

- 8个相关静态文件SHA-256一致，`.js/.mjs`类型正确；HTML禁止缓存、mic=self/camera禁用、默认同源CSP，摄像头模块未加载。
- 未登录访问实时能力为401；两既有账号同家庭，文字/识图配置可用、实时语音及家人通话关闭，两者当时均读9条记忆。
- 两个本次登录会话均退出，再查返回401。没有创建家庭、上传/写入/联系真人、模型调用、TRTC Start或真实设备权限申请。

初次脚本将Cache-Control要求为恰好no-store，未接受云网关追加的no-cache/must-revalidate/max-age=0，故在登录前失败。修正 `2ecc720` 只要求存在完整no-store指令，保留全部字节和权限断言，最终复验通过；不是更改页面或放宽可缓存策略。初次报告亦保留在交付证据。

## 仍需真实验证

TRTC实际账户查询使用已有CLI只读请求，返回 `AuthFailure.UnauthorizedOperation`；没有得到账户应用或免费余额。CloudBase hy3普通聊天与TRTC音频为两层，公网兼容流接口的管理员Key权限、Accept请求头及真实模型流尚未核验。受限桥接只有方案，私有Timer只有代码；均未部署。开通/费用仍按用户先前选择稍后确认，步骤及最新官方计费来源见 [TRTC-SETUP-PLAN.md](TRTC-SETUP-PLAN.md)。

真人麦克风/扬声器、手机系统键盘与微信浏览器、TRTC声音/插话/延迟/跨网、无人访问时Timer实际清理、Link2摄像头/注视、当前GPU均未验收。普通hy3/MiniMax历史真调用证据保留，本轮未重复模型调用。

夸克computer-use枚举/打开页面失败，重置后仍为nodeRepl.fetch request failed。用户后来明确“稍后处理网盘”，因此本轮只重新生成可恢复开发交接包，未上传、未生成网盘分享。包包含所有跟踪项目文件、全部分支Git bundle、完整UNSEEN参考和脱敏证据；排除配置/凭据/个人数据/依赖。最终路径、摘要、文件数、worktree审计和实际Git克隆恢复结果以交付目录 `DELIVERY-VERIFICATION.json` 为准。
