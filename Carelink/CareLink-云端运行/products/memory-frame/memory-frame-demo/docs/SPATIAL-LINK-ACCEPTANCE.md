# 影石时光舱分享链接导入修复

> 总控整合状态：已纳入并部署 0.4.8，GitHub 已更新；最终范围见 [0.4.8 发布验收](RELEASE-048-ACCEPTANCE.md)。下文“本任务未部署”描述独立任务当时的操作边界。

2026-09-24，独立分支 `codex/family-spatial-import`，基线 `e245000`。本轮只处理已生成的影石作品分享链接；未部署、未推公开仓库，公网仍为 0.4.7。摄像头、AI 对话和旧 UNSEEN 服务不在改动范围。

## 已复现的问题与修复

- 原前端会把带 fragment、空白或反斜线的部分地址判断为可导入，而服务端严格拒绝。现在浏览器和后端共用 `public/spatial-link.js` 的规则；只允许 HTTPS、精确分享主机和作品路径，无凭据、自定义端口或 fragment。界面说明如何重新复制链接。
- 原入口不能处理“分享标题 + 作品链接”的复制文字；会在发送时收到笼统的 HTTPS 格式错误。现在只从含**一个完整合法作品链接**的分享文字中提取规范地址，去掉跟踪参数；多链接、相似域名和不完整作品 ID 不猜测修复。已有消息的原链接保持兼容。
- 原流程寄出仅保存链接，还需再找“导入空间”。现在按钮明确为“寄出并导入空间”，保存后自动启动既有 `spatialImport`，并滚动到进度卡。轮询失败时提示待同步后手动导入；未完成或旧记录仍可手动导入/重试。
- 模型文件、普通视频、时光舱特效视频、其他网站/路由有不同提示；仅保存来源链接不会显示成导入成功。帮助中说明从影石 App 选择作品的“网页链接分享”。
- 后端保留安全错误代码和失败阶段，区分未知资源域名、DNS 失败/超时/不安全地址、分享私有或失效、页面结构变化、无唯一 SOG、资源失效及无效重定向。普通网络/SDK 原始错误仍不返回，供应商签名地址不持久化或输出。原云存储 DNS 诊断兼容保留，仍不进入公开状态。

尚未收到用户本次具体失败链接或报错，不能把上述已复现问题说成该未知作品的确定根因。

## 域名与格式结论

本轮重新读取 [既有用户授权样例](3DGS-HANDOFF.md) 的真实页面：场景 ID 匹配、公开状态有效，输出包含 SOG、相机 JSON、另一 ZIP 和两个 MP4；资源均使用既有精确主机 `insta360-app-hz.oss-cn-hangzhou.aliyuncs.com`。实际完整导入与两端观看成功。因此没有新增域名或放宽 DNS/跳转策略的依据。

分享页仍只接受 `app.insta360.com/3dspace/detail/GS3DC<32 hex>`，模型和可选相机分别只读取已核实主机的 `.sog` / `.json`。逐跳检查、全 DNS 答案校验、固定连接 IP、大小/时间/解压限制、私有落库和每段会话权限检查均保持。旧环境的精确 COS VPC 例外没有扩大到外部分享资源。

[PlayCanvas 官方 SOG 文档](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/)说明 bundled SOG 使用 ZIP 容器；这里的格式校验只接收受限 SOG v2 的元数据与纹理结构，**并不意味着可以导入任意 ZIP**。分享页的另一个 ZIP、PLY/SPZ 文件和本地上传均不在本入口支持范围。

[影石官方时光舱说明](https://onlinemanual.insta360.com/app/zh-cn/operation_tutorial/edit_function/3dgs)将网页分享与平面特效视频分享分别列出。unseen 导入已经生成的空间，不提供普通视频训练/重建。官方当前也未承诺源文件下载或离线导出 API；网页内部结构变化时可能需要适配，原分享来源入口始终保留。

## 验收证据

| 范围 | 本轮结果 | 边界 |
| --- | --- | --- |
| 完整本地回归 | 460/460，通过，零跳过/取消 | 设置真实 Chrome 路径；既有供应商/音频替身仍按原测试标注 |
| 新增真实 HTTP + Chrome 测试（默认模式） | 家人注册加入、分享文字、自动导入、未知域名提示、重试、双端打开、撤销读取通过 | 独立 LocalStore，供应商与查看器为显式替身，不算渲染证据 |
| 同一测试的真实影石模式 | 真实分享解析、下载、SOG 校验、私有落库；390×844 家人端与 1024×768 相框端实际 PlayCanvas 打开；复位、键盘、关闭及撤销通过 | Chrome SwiftShader **软件渲染**；截图已逐张检查；无手机/iPad/硬件 GPU 声明 |
| 真实模型传输 | 16,324,085 bytes，家人和相框各 4 段，逐段 206/范围/长度检查并验证完整 SHA-256 | 没有直签地址或单次大文件绕过 |
| 原公网只读复验 | 两个既有 owner/family 账号均读取 17 条记忆，同一模型各 4 段及摘要一致，前后内容摘要一致，2 个临时登录退出并失效 | 没有新家庭、媒体写入、模型导入、AI 调用或部署；见 [脱敏云报告](SPATIAL-LINK-CLOUD-VERIFICATION.json) |

真实样例 SHA-256：`93224a51c0385145c747f3d7033907678f20ac3f251f30f7c61a61f1ffb0a630`。

首次完整回归为 459 通过、1 取消：旧 30 ms 超时测试在繁忙机器上可能尚未进入下载就超时，下一次重试才触发原“第一次下载永久等待”替身。已按首次尝试完成后显式释放故障，不再用下载次数判断；业务预算未修改。复跑完整 460 项通过。

最后的共享规则长度兼容调整和 `send` 可读性整理后，补跑导入/链接/UI/真实影石浏览器 42 项，全部通过，零跳过；同时明确断言打开前没有浏览器模型下载、两端合计 8 段读取。

截图和完整日志存本 worktree 的忽略目录 `.tools/spatial-real-browser/`、`.tools/spatial-full-tests.log`、`.tools/spatial-final-tests.log`；不把用户作品截图/模型加入公开源码。测试通过 `mkdtemp` + 显式 `new LocalStore(dir)` 隔离，并关闭服务、浏览器与删除本次临时目录；不读或复用 `.data`。

## 复跑

在 `memory-frame-demo` 内，先按 `START-HERE.md` 安装服务依赖，再设置本机已安装的 Playwright/Chrome 路径：

```powershell
$env:AI_UX_PLAYWRIGHT='C:/Users/15pro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
$env:AI_UX_CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:MEMORY_CLOUDBASE_ENV=''
node --test test/*.test.js
# 以下显式允许读取交接文档中的既有授权影石样例，仍只落本地临时数据。
$env:SPATIAL_REAL_SHARE='1'
node --test test/spatial-http-browser.test.js
```

`scripts/check-spatial-readonly.mjs <私有验收上下文路径> <脱敏结果路径>` 只允许固定原公网的 login/logout/state/spatialAsset，复用文件中两个既有账号。它拒绝无 ready 模型的家庭，不会自动注册或重新导入。不要用创建家庭的部署验收脚本替代。

## 给家人的操作

1. 影石 App 打开已经生成的时光舱作品，分享 → **网页链接分享** → 复制。
2. unseen 家人端底部中央 **＋** → **3D 空间**，粘贴链接或整段分享文字。
3. 出现“已识别影石时光舱作品”后点 **寄出并导入空间**。
4. 等待“空间可观看”，家人端或相框端点 **打开空间**。失败时看卡片原因，再选择 **重试导入** 或 **查看影石来源**。

后续仅需对用户具体失败作品核验其路由/资源主机，并由总控整合发布；未知主机不自动放行。实体手机/iPad、微信、弱网和硬件 GPU 仍待现场验证。
