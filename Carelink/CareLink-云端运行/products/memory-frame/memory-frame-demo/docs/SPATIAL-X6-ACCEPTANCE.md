# X6 时光舱资源主机与初始视角兼容

2026-09-24，独立 `codex/spatial-x6-host`，从 `main 35c915e` 开始。前轮 `aacdaf3` 经 `git cherry main codex/family-spatial-import` 确认为等价已合入，不重复合并。公网目前仍为 0.4.8；本任务不部署、不推公开、不创建云家庭或云导入，不修改相框展示 UI。

## 真实复现

用户提供的两条作品网页由生产 `createNetwork().page()` 直接读取；不是依据截图结论放行。两页场景 ID 与链接匹配、公开状态 `isPrivate:0`，输出各有唯一 SOG、相机 JSON、另一 ZIP 和两个视频：

| 用户样例 | 作品 ID | 实际资源主机 | 修复前解析 |
| --- | --- | --- | --- |
| X5 | `GS3DCdc6f602157154a7493f6321edb5d8851` | `insta360-app-hz.oss-cn-hangzhou.aliyuncs.com` | 通过 |
| X6 | `GS3DCbe874841cac0465d87c237792df5e037` | `p1-app.insta360.com` | `unsupported_asset_host` |

直接原因是已核实的 X6 官方作品资源主机不在精确列表内，错误发生在真正下载模型之前。此次仅增加 `p1-app.insta360.com`；不接受 `*.insta360.com`、`p2-app`、其子域/相似域名，也不将资源主机当分享页入口。

## 边界与检查

仅 `.sog` 与可选 `.json` 可从两个精确资源主机读取。HTTPS/TLS、每次连接检查全部 DNS 答案并固定 IP、逐跳协议/主机/文件类型检查、时间/实际字节/头部大小上限、SOG v2/ZIP/纹理校验、家庭配额和私有存储保持不变。外链不获得 CloudBase 自有桶的 VPC DNS 例外。查看器仍按 4 MiB 分段，每段鉴权，完成后验证整文件 SHA-256。

新增 `spatial-x6-host.test.js` 5 项：精确 CDN 和 JSON 正例；两受信主机互相跳转仍每跳解析并固定 IP；HTTP/私网/元数据/非支持主机和文件类型跳转拒绝；全 DNS 答案、混合私网与重绑定拒绝；实际/声明字节限制、内容编码与已取消请求。连同导入、读取、下载、UI、链接与导航共 **73 项通过**，无跳过。

`spatial-http-browser.test.js` 增加仅允许 `x5` / `x6` 两个用户授权样例的显式开关。两次实测都使用 `mkdtemp` + `new LocalStore(dir)`、本地动态端口和独立 Chrome 配置；服务、浏览器和临时模型均在结束后清理。第一次未知主机失败为安全夹具，随后重试读取真实作品。没有云内容写入，也没有持久化或输出供应商签名 URL。

| 实际本地 HTTP + Chrome 软件渲染 | X5 | X6 |
| --- | --- | --- |
| 私有导入字节 | 16,324,085 | 16,442,297 |
| 校验格式 | SOG v2，100万 splats，SH3 | SOG v2，100万 splats，SH3 |
| 解包 / 解码预算字节 | 16,323,137 / 27,932,160 | 16,441,349 / 27,932,160 |
| 相机 JSON 数值/矩阵校验 | 通过 | 通过 |
| 家人 / 相框读取 | 各4段，通过完整摘要 | 各4段，通过完整摘要 |
| 双端 PlayCanvas | ready，复位/方向键/关闭通过 | ready，复位/方向键/关闭通过 |

SHA-256：X5 `93224a51c0385145c747f3d7033907678f20ac3f251f30f7c61a61f1ffb0a630`；X6 `b9126c4b4f3169f1cb66e728f3e20b26f1b4719b0dec0d2bfbf172306512825a`。这证明完整模型和相机数据可读取/解码，不是仅看到 ZIP 文件头。

实际检查 X6 初始截图后发现另一个体验问题：旧逻辑优先 `_cam1_up`，该样例会主要朝向天花板，而 `_cam1_center` 已接近水平。该问题不阻断导入，与域名兼容分开处理；不能把数值校验通过等同于视角合适。视角修复与最终截图证据在后续节记录。

## 独立的初始视角修复

主机兼容已单独提交 `3f813ff492fd7419ef142d6e264b6ff74ac55331`。第二个提交只调整 `parseCamera` 的有界通用选择，不根据作品 ID、设备型号或资源主机做分支：

- 先保留原有限制并验证所有候选的位置、3×3 旋转矩阵、正交性、内参及视角范围；新增正行列式检查，拒绝“正交但镜像”的矩阵。
- 在第一组可用的 `cam1_center` / `cam1_up` 拍摄位置中，根据已验证的 forward 向量选择相对模型 Y 轴更接近水平的视角；角度相同优先 center。不会跳到后面帧中另一处位置，只为了找到更小倾角。
- 没有这些命名时回退到第一个有效姿态；没有有效姿态时仍返回 undefined，让既有查看器自动取景。原始相机 up 向量和 FOV 继续使用，不硬编码模型坐标或变造位姿。

相机 JSON 当前协议是**旋转矩阵**，不是 quaternion。4 项 deterministic 测试覆盖水平/倾斜拍摄、乱序候选、同角度 tie、多帧不跳位、缺失命名及 fallback，以及缺失/四元数形状/奇异/镜像/非数值旋转和位置/FOV/数量越界。合并前述网络与 3D 回归共 **77/77 通过，无跳过**；没有重跑与本修改无关的完整业务测试。

最终各用一次真实下载完成 X5、X6 双端浏览器复验，随后临时模型删除；截图逐张检查：

| 最终初始画面 | 旧选择绝对倾角 | 新选择绝对倾角 | 观察 |
| --- | --- | --- | --- |
| X5 | 19.77° | 19.77° | view 数据与旧规则完全相同，原房间画面保留 |
| X6 | 47.75° | 2.76° | 从主要仰看天花板改为看到房间主体，手机尺寸和相框尺寸均可见 |

两次均实际验证自动导入/失败后重试、完整模型和相机校验、两端各 4 段及整文件摘要、家人端复位/方向键、双端关闭、撤销后读取拒绝；未生成新格式、未新增云模型。脱敏参数、日志/截图摘要见 [验证报告](SPATIAL-X6-VERIFICATION.json)。截图中的用户作品只保留在本地忽略目录，不放公开包。

## 复跑与证据位置

在 `memory-frame-demo` 设置本机 `AI_UX_PLAYWRIGHT` / `AI_UX_CHROME` 后：

```powershell
$env:SPATIAL_REAL_SHARE='1'
$env:SPATIAL_REAL_SCENE='x6' # x5 可复验原作品
node --test test/spatial-http-browser.test.js
node --test test/spatial-x6-host.test.js test/spatial-import.test.js test/spatial-range.test.js test/spatial-download.test.js test/spatial-ui.test.js test/spatial-link.test.js test/spatial-viewer-navigation.test.js
```

本 worktree 忽略目录 `.tools/spatial-x6-before.json` 为修复前脱敏主机检查；`.tools/spatial-x6-safety.log`、`.tools/spatial-x6-browser.log`、`.tools/spatial-x5-current.log` 为本轮结果；`.tools/spatial-x6/`、`.tools/spatial-x5-current/` 存实际查看器截图，不进 Git 或公开包。Chrome 使用 SwiftShader 软件渲染；不冒称实体手机/iPad、硬件 GPU、云端导入或微信验收。

最终视角修复后的结果在 `.tools/spatial-camera-safety.log`、`.tools/spatial-x5-level.log`、`.tools/spatial-x6-level.log`，对应最终截图在 `.tools/spatial-x5-level/`、`.tools/spatial-x6-level/`；可与上面的旧视角截图比较。复跑全部本轮定向测试时在命令中加 `test/spatial-camera.test.js`。
