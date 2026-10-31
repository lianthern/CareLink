# 当天 Demo 协作约定

> Windows 本轮 3D 的三个独立工作树已完成并合入 main；当前职责、协议、审查与 50 项合并后测试记录见 [WINDOWS-ACCEPTANCE.md](docs/WINDOWS-ACCEPTANCE.md)。下面保留原 Mac Demo 协作背景，不需要重新派发或重复实现已合并的前端、后端、AI 任务。

目标：今天交付手机家人端 + 电脑/平板相框端，跨网络真实照片/录音收发及记忆保存。用户指定 GPT-6 Astra / low 独立 worktree；此主任务负责合并、云环境和最终验证。旧 Unseen 线上服务不改。

## 文件归属

- 前端任务：`server/public/`（图片/字体素材已从原稿提取），可新增前端说明。不修改后端协议。
- 后端任务：`server/server.js`、`server/store.js`、`test/`。完善授权、持久化、并发及集成测试；保持协议兼容。
- AI 任务：`server/ai.js`、独立 AI 文档/诊断脚本。不得修改后端 HTTP 服务或前端文件。如需新增依赖，在结果中说明，由主任务合并 package.json。
- 总控：CloudBase 开通、CLI 登录与部署、依赖管理、启动脚本、最终集成。

每个任务请自主完成实现和相应测试，然后 commit 自己负责的文件。报告 commit SHA、变更文件、验证结果、真实外部依赖是否已联通。不要购买、改 DNS、修改旧云资源、读取私钥或在聊天输出凭据。不要操作主任务的 Chrome；如需 UI 验证创建自己的 IAB 标签。

## 后端契约

具体字段见 `server/server.js`，这是当前共享基线。前端同源 `POST /api`：`{action,data}`，已加入家庭后使用 `Authorization: Bearer <token>`。`GET /api/health` 返回可用性。功能包括 create/join/state/invite/upload/send/receipt/edit/person/remove/revoke/process。

- create：setupCode、name、nickname → token/role/room/name；开通码从本地 `.data/setup-code` 或环境变量读取，不放在公开网页。
- join：invite（48 位十六进制能力码）、nickname → 会话。
- invite：role=family/frame → invite；CloudBase测试域名为兼容首次访问提示页使用24小时query邀请码，其他域名写fragment。前端读取后立即清除地址中的邀请码，所有应用响应使用 `Referrer-Policy: no-referrer`。
- state：room、role、name、messages、members、people、receipts；poll 建议前台 2–3 秒，后台 15 秒，断网退避。message 包含 `_id/type/imageURL/audioURL/text/transcription/editedText/card/parent/duration/aiStatus/aiError/createdAt`。
- upload：base64 → id；最大 3MB，图片 JPEG/PNG，录音为 16kHz、单声道、PCM16 WAV、最长60秒（可用 OfflineAudioContext 解码和重采样），勿模拟麦克风。
- send：id（客户端稳定 UUID，重试复用）、image/audio（upload返回 id）、text/title/link、parent（回复所关联照片 `_id`）。家人端创建 photo，frame 创建 reply且必须有audio与parent。录音开始时固定parent；后续新消息不能改变它。
- receipt：id、played；frame 显示送达、听过状态。文本朗读明确为机器朗读；存在原声时必须播放audioURL。
- edit：id/text/title/summary/people[]/year/place；人工修订和原始转写分别保存。
- person：name/relation；人物标签可手动维护；不可把不在家人的示例角色当实际成员。
- remove：id，仅移出列表（软删除）；revoke：id（session id），owner权限。
- process：id；真实ASR+模型调用，可能60–120秒，要独立异步请求、不阻塞原声收发。尚无服务配置时必须显示真实失败，不编造转写。
- 图片、声音URL会更新；保持已开始的录音与播放器，不要每次poll重建全部DOM。

## 展示范围

保留原 HTML 的粉蓝手帐风格，参见 DESIGN.md、../reference/memory-frame-v4.html。初始空家庭，提供明确的创建/加入/相框配对路径；可用原稿照片作为标明“试用照片”的真实上传样本。手机布局与相框各自独立，不再仅同页面共享内存。

实现照片选取/压缩、文字留言、真实录音/试听/发送、双向同步、照片历史、记忆详情与原声、手工修订、人物/时间筛选、家庭邀请、设备在线、可恢复上传草稿与错误提示。空间链接真实保存并打开原提供商页面，不冒充已完成3D重建。设置文案必须对应实际行为，不能保留虚假的安全/推送承诺。

## 本机工具

Node: `/Users/max/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`
pnpm: `/Users/max/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm`
package依赖在 `server/package.json`，安装后 local start `node server/server.js`，绑定127.0.0.1:8787；各worktree换独立PORT避免冲突。上海CloudBase个人版（云数据库）已开通并部署，19.90元1个月，禁止替用户提交其他收费项。以上Node/pnpm绝对路径仅用于原Mac；Windows接手使用 START-HERE.md 的方式。
