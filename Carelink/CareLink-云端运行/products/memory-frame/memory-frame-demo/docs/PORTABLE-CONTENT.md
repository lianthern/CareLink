# 现有内容导出与本地恢复

`scripts/portable-content.mjs` 用于把当前家庭中仍可见的消息、人物、回执，以及消息引用的照片、音频和已就绪 3D 模型，整理为独立 LocalStore 预览数据。不会注册或创建云家庭，不调用 AI，不发消息、不上传、不触发模型导入。云登录/退出及服务本身的授权/在线时间更新不属于内容写入。

这是可见内容快照，不是完整云数据库备份：不包含已删除消息、未被可见消息引用的文件、内部 AI 请求/候选、历史在线状态、正在进行的通话、有效云会话或浏览器里的临时聊天草稿。来源系统当前无法读取的内容不能凭空恢复。普通照片/音频使用登录后 API 返回的媒体地址下载；3D 只能经 `/spatial-media/` 原有权限通道读取，每段最多 4 MiB，验证 206、范围、长度和完整 SHA-256；不使用模型存储签名 URL 绕过会话校验。

## 命令

在 `memory-frame-demo` 目录运行，使用 Node 20.19 或本项目已验证的 Node 24。脚本仅使用项目模块和 Node 内置库；本机不需登录云 CLI。

```powershell
node scripts/portable-content.mjs export <已有私有账号JSON的绝对路径> <仓库之外不存在的新目录>
node scripts/portable-content.mjs verify <已有导出目录>
```

云地址固定为既有 `memory-frame-demo-d7djiee0702b6c` 环境。凭据输入支持 `{credentials:[{username,password}, ...]}` 或 `{accounts:[{username,password}, ...],familyUrl}`，要求两个已有账号同家庭；不会使用输入文件已有的 token。账号文件路径作为参数，不把密码放进命令行。输出目录必须新建且不在此工作区内，脚本拒绝覆盖已有目录；失败的半成品没有 `content-summary.json` 中的 `passed:true`，不得作为完成包发出。

标准输出只包含脱敏数量与摘要；错误不回显原始响应、账号密码、token 或临时媒体地址。再次 `verify` 会生成新的临时验证副本，不修改种子数据，不访问云服务。

## 交付目录与 schema v1

```text
portable-content-<日期>/
  snapshot.json
  content-summary.json
  seed-data/
    records.json
    media/<SHA-256>.<png|jpg|wav|sog>
  private-access/
    local-preview-accounts.json
    LOCAL-PREVIEW-LOGIN.txt
  verification/
    RESTORE-VERIFICATION.json
```

- `snapshot.json`：`schemaVersion=1`，`room:{id,name}`、完整分页的 `messages`、`people`、可见消息的 `receipts`、`media`、`models`、无会话标识的 `memberRoster`、时间与导出边界。消息保留 ID、父消息、照片/音频 ID、名称、标题、文字、转写、编辑结果、人物/年份/地点卡片、创建/更新时间、原空间分享链接；移除临时图片/音频 URL、云 author 会话标识和内部 AI 租约。
- `media[]`：`{id,type,mime,bytes,sha256,file}`，其中 `type` 是 `image/audio`，`file` 为 `seed-data/media` 下的文件名。不同消息与父子回复共用原媒体 ID；相同字节在磁盘去重。
- `models[]`：`{format,sourceURL,sourceTitle,provider,bytes,digest,view?,file,messageIds,parts}`。`parts` 只保留 Range、响应码、Content-Range、长度，不含访问 URL。原公开来源链接保留，导出的模型字节可离线从本地服务读取。
- `seed-data/records.json`：现有 LocalStore 格式的 `_id → record` 映射，只包含 `room/roomRegistry/message/person/receipt/file/spatial/account`。每次新建本地分页签名、模型签名和账号凭据；没有 session、invite、download 或旧云账号授权记录。局部字段 `author/owner` 为 `portable-import`，不是有效会话。
- `private-access/local-preview-accounts.json`：`{schemaVersion:1,scope:'local-preview-only',room:{id,name},accounts:[{username,password,nickname,role}]}`。账号为 `preview-owner`、`preview-family`，每次生成新随机密码。仅用于本地服务；密码只写到私有交付文件，不输出或入 Git。
- `content-summary.json`：云读取范围、记录/文件数量、字节量、内容摘要、退出验证、`passed`。`referencedMedia` 是媒体 ID 数；`uniqueMediaFiles` 与 `mediaBytes` 为照片/音频去重后的磁盘数量和大小。模型按场景计数。
- `verification/RESTORE-VERIFICATION.json`：真实隔离本地 HTTP 双账号登录与内容比较、各媒体摘要、各账号模型完整下载与分段证据、退出失效、种子未改、已停服务。不是浏览器点击、音频播放或 GPU 渲染证据。

## 启动与验证隔离

最终便携包应把 `seed-data` 复制到一次新的本地运行目录，再显式注入 `new LocalStore(运行目录)` 或使用仅本地启动器，绑定 `127.0.0.1`。不要把云配置加载到默认本地预览进程，不让两个服务共用数据目录，也不要直接运行并修改交付种子。

恢复核验同样在导出目录之外创建一次性的 `portable-verify-*` 目录，真实启动 `createApp` HTTP 服务，使用新账号读取完整历史，对比所有保留字段、人物和回执，下载照片/音频并验证摘要，两种本地角色分别按原权限分段协议下载模型。验证完撤销自己的本地会话、停止 HTTP 服务，核对种子 `records.json` 字节未变，并仅删除本次新建的临时目录。最终种子内不会混入验证登录、媒体访问签名或临时会话。

对包含内容与账号的交付包应作为私有文件交接，不把快照、媒体、账号或真实部署配置提交 Git。服务器与云访问方式由最终包的私有访问说明补充；本脚本不导出 CLI、浏览器或其他应用认证目录。

本次代码验证：`node --test test/portable-content.test.js`。包含数据脱敏/关联保留、写操作拒绝，以及实际 HTTP 双账号/媒体/4 MiB 模型分段恢复测试。具体云内容数量与本次真实恢复结果以交付目录的两份验证 JSON 为准。
