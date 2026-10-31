# unseen 记忆相框：字体来源、许可与验收

本次从 `180b4df` 开始，在独立分支 `codex/self-hosted-sans` 调整字体。只涉及网页入口、共享 CSS、字体资源和本说明；未改历史原稿、业务 JS、3D 渲染/下载/鉴权，也未部署。

## 字体与来源

页面主字体为 **Unseen Sans**，是 Adobe **Source Han Sans SC（思源黑体，简体中文语言版）2.005R** 的自托管 WOFF2 字符分片。字形没有重新设计；保留原字重轴 250–900，现有正文 400、按钮 600 和强调 700 使用同一套字形。

- [Adobe 官方发布 2.005R](https://github.com/adobe-fonts/source-han-sans/releases/tag/2.005R)
- 固定上游提交：`6c709ca72d3d7c46ab42ebecc1a26e7d69595a37`
- [官方原始 WOFF2（CFF2）](https://raw.githubusercontent.com/adobe-fonts/source-han-sans/6c709ca72d3d7c46ab42ebecc1a26e7d69595a37/Variable/WOFF2/OTF/SourceHanSansSC-VF.otf.woff2)
- 原文件 SHA-256：`085cc88c530b9c434165ab926f81608a55b24e60e05719f3d41340ac45d9c62f`
- [固定版本官方许可证](https://github.com/adobe-fonts/source-han-sans/blob/6c709ca72d3d7c46ab42ebecc1a26e7d69595a37/LICENSE.txt)
- 许可证 SHA-256：`fcac737e761ec63dbfbdce11030a1780161920d80315edba9c8beff1c2bac5a2`

## 许可留存与命名

官方字体采用 SIL Open Font License 1.1，允许依照其中条件使用、修改并随软件嵌入或再分发。原版权声明、完整许可文本原样保留在 [字体目录 LICENSE.txt](../server/public/assets/fonts/unseen-sans/LICENSE.txt)，也随网页静态资源一起分发。每片字体还保留版权、商标、作者、厂商、许可说明与许可链接的名称表记录。

官方保留名称为 `Source`。由于分片属于修改版本，网页 CSS family、字体内部的家族名、完整名、唯一 ID、PostScript 名和可变字重实例的 PostScript 名均使用 `Unseen Sans` / `UnseenSans`，不使用保留名称作为修改版主名称。原作者名称仅用于来源和版权说明。修改后的字体继续受 OFL 1.1 约束，不单独出售，也不将字体改为项目私有许可。以上记录是本项目遵循官方许可的依据，不构成零法律风险保证。

已从当前部署源码删除原 `assets/handwriting.woff2` 及其加载/样式引用；Git 历史和 `reference/memory-frame-v4.html` 保持不变。

## 覆盖与加载

保留完整官方 SC 版的 **44,853 个 cmap 字符和 33 个 Unicode 变体序列**，各分片普通字符范围不重叠，合并后与上游完全一致。并非仅提取现有页面文字：用户录入的姓名、故事、繁体、扩展汉字等，只要上游字体支持，就仍有对应分片。上游不支持的更罕见字符及 emoji 交由系统回退；这里的完整覆盖指上游字符集，不代表全部 Unicode 汉字。

`ui` 分片集中当前界面用字与基本拉丁字符，其余字符每 1,024 个分片。`unicode-range` 让浏览器按当前文字选择资源，各分片共用可变字重，不需为 400/600/700 分别下载。文件名带内容摘要。所有 `src` 都是同源相对地址，无运行时外部字体 CDN、无远程字体请求，也不预加载整套字库。字体样式单独通过 `<link>` 加载，避免 CSS `@import` 串行发现。

所有字面设置使用共享 `--font-sans`，顺序为 Unseen Sans、已安装的思源/Noto 中文无衬线、苹方、微软雅黑、系统 UI、通用无衬线。`font-display: swap` 在下载期间立即显示回退字体；不支持可变 CFF2 WOFF2 的旧环境继续回退。替换了品牌、标题、头像、统计数字、日间/夜间时钟的手写声明；登录、对话框、输入框、按钮、文件选择按钮和 3D 外层 UI 继承同一字体。3D 独立样式中原有 `font: inherit` 无需修改。原字号、配色、页面顺序及布局规则保留，仅为原手写字体的几个位置明确行高。

当前共 **45 个 WOFF2 文件、15,933,092 字节（约 15.2 MiB）**；`ui` 分片含 685 个字符、246,520 字节（240.7 KiB），最大扩展分片 664,224 字节（648.7 KiB），字体 CSS 35,953 字节。这是资源的静态字节数，不是实际浏览器流量测试结果。首屏只用当前 UI 文字时可命中 `ui` 分片；已有故事或用户输入可能加载更多分片。

具体资源大小、每片 Unicode 范围与 SHA-256 见 [manifest.json](../server/public/assets/fonts/unseen-sans/manifest.json)。字体目录资源将随既有服务的静态目录部署，服务已有 `font/woff2` MIME 和 `font-src 'self'` CSP，无需修改服务或放宽策略。目录中的 `.gitattributes` 保证二进制字体与许可证原字节不被 Git 换行转换破坏。

## 重建

正常安装、运行和部署直接使用已提交的字体资源，不依赖 Python 或外网字体服务。只有需要重新分片时，才在本项目忽略的 `.tools/` 中准备独立 Python 环境，安装 `fonttools==4.62.1` 与 `brotli==1.2.0`，然后从项目目录执行：

```powershell
.tools/font-build/Scripts/python.exe scripts/build-fonts.py
```

脚本下载固定上游文件并核对 SHA-256，保留原许可证，扫描公共 UI 源码构建首屏分片，生成其余字符分片与 CSS、清单；保存后重读每片，检查 cmap、变体序列、保留名称、版权许可元数据与字重轴。应在无其他字体构建并行运行时执行；重建后审查清单和旧文件，删除不再引用的历史分片，再提交。

## 本次验证（2026-09-23）

- 按根目录与服务端的 `pnpm-lock.yaml` 分别执行 `pnpm install --frozen-lockfile`，成功，无锁文件改动。
- `app.js`、`account-auth.js`、`family-experience.js` 的 `node --check` 通过。
- 既有账号 UI、家人端生命周期、历史 UI、空间 UI 测试 **28 项通过，0 失败**；没有为字体写镜像实现单测。129 项完整回归是此前的基线，本次未重跑全部。
- 45 个分片保存后均通过字体解析、名称/许可元数据、250–900 字重轴检查；其 cmap 与变体序列合并后等于上游完整字符集，无缺失或重复普通字符范围。单独重建 `ui` 分片的 SHA-256 与清单一致，验证可复现性。
- 使用 tinycss2 1.4.0 解析共享、3D 和生成的字体 CSS，全部通过；剔除字体声明后与基线共享 CSS 的其余规则逐项相等。HTML 解析确认字体样式在页面样式前加载。此为静态结构核对，不是浏览器布局验收。
- 隔离本地服务（独立临时数据目录、系统分配端口）完成 **53 项 HTTP 检查**：45 片字体与本地字节、SHA-256 一致，MIME 为 `font/woff2`；CSS、完整许可证和清单可访问；`/`、`/family`、`/frame` 均包含新字体入口；现有同源 CSP 保持有效；旧手写字体返回 404。没有创建家庭，没有触及公网配额，检查后服务已关闭。
- 只读调用浏览器枚举，仍返回 `Browsers: Error: nodeRepl.fetch request failed`；没有关闭或覆盖用户页面。**本次浏览器字体实际加载、手机布局、截图、点击、真人录音及 GPU 均未验收**。静态与 HTTP 结果不能替代这些验收。

集成后需在真实浏览器的家人登录、首页/中央加号/我的、各弹窗，以及相框普通/大字/夜间模式确认中文字体、长姓名换行、时钟和按钮不裁切；另检查 3D 外层控制文字。还需用网络面板确认首屏按需下载、断网回退、现有记忆和新输入文字触发相应分片，并在手机/微信上验证可变字体兼容性。
