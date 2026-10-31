> 此目录是 2026-09-20 导入的来源快照。统一安装、当前用途、素材与部署边界请先读仓库根目录 README 和 `docs/team/HANDOFF.md`；下文保留原项目说明。

# UNSEEN · 回忆时刻

当前产品入口是 [回忆时刻 App](https://huijian.maxxam.xyz/app)，管理入口是 [/admin](https://huijian.maxxam.xyz/admin)。本仓库负责 App 与同源代理，账号、私有回忆、空间和审核使用配套 UNSEEN canonical API。旧原型的能力说明保留在下方，不代表当前 App 的边界。

当前主流程：选自己的照片 → 用原声或文字讲述 → 保留照片与本人原话 → 保存到账号，或下载分页 PNG / 含原图原声的离线 HTML。访客草稿留在本机；同一草稿在两页冲突时另存副本，双方原话都保留。回忆可归档和恢复，选错照片可生成整理副本；公开投稿另行确认、审核和撤回。

账号支持密码登录、邮箱验证及找回密码。未绑定邮箱的账号可验证联系邮箱并申请人工恢复；管理员必须独立核实身份，申请本身不能授予账号权限。管理员入口不向普通账号开放。唯一管理员应预先验证自己的邮箱；未绑定邮箱且已无法登录时，仍需按服务器运维流程独立核验身份。

空间支持 360 全景、导入已生成的 DAP 成果、公开空间案例和 World Labs 异步任务。导入/World 历史素材留在本机并可恢复。DAP 在线推理尚未接入，自有 3DGS 仍在改进；旧活动共创和纪念册样例是历史成果，当前 App 不宣称已接通新的多人活动共创链路。

开发需要 Node 22+；首次运行 `npm ci` 安装锁定版本的构建工具 esbuild。App 服务运行仍不依赖 npm 包。改动后运行 `npm run check`，它先打包压缩 JS、保留动态分包、按原顺序合并 CSS，并生成带内容指纹的静态资源，再运行全部 App 测试。后端运行配套 canonical 仓库的 `npm run check`，覆盖完整 API、运维检查和 Book Studio。仅修改源文件不会改变已生成的 `/app-assets/`，也不会自动更新线上。

```sh
npm ci
CANONICAL_UPSTREAM=http://127.0.0.1:4300 CANONICAL_PUBLIC_ORIGIN=https://unseen.maxxam.xyz node server.mjs
npm run check
```

发布时需带上资源清单 `files` 中的完整新指纹目录，并保留已有指纹目录。`files` 同时包含源文件副本和优化包；`sourceFiles` 仅用于源码一致性检查。浏览器入口改为清单中的 `entry`，旧验收脚本不可继续写死 `/moment-app.js`。`node server.mjs` 使用预构建文件，不需要在生产服务器安装 esbuild。

隔离验收和发布证据见 [.task/mhc-fixes](.task/mhc-fixes)。测试数据与生产数据分开；真实手机、真人使用和 DAP 商业授权仍需实际证据，见 [赛前验收与演示脚本](30-MHC-赛前验收与演示-2026-09-06.md)。

<details>
<summary>历史原型说明（/、/unseen-demo、/world 等旧入口）</summary>

# 回见

从一张照片里的真实细节开始对话。AI 始终读取用户上传的清晰原图；用户每讲一轮，与回答相关的局部先显影，三轮后照片完整展开。

本机预览：[127.0.0.1:4610](http://127.0.0.1:4610/)；线上地址：[huijian.maxxam.xyz](https://huijian.maxxam.xyz/)（当前已部署；后续本地提交仍需运行发布脚本才会更新线上站点）。

UNSEEN 3.0 本分支入口：`/unseen-demo`（部署后对应 [huijian.maxxam.xyz/unseen-demo](https://huijian.maxxam.xyz/unseen-demo)）。「看看」现在只展示 `UNSEEN 官方`发布的只读案例；中间“＋”只允许相机拍摄或从本地相册选择，官方媒体不会进入个人照片状态、IndexedDB 回忆或 World Labs handoff。「我的」仍只显示当前浏览器的个人记忆。照片追问、一页回忆、本机保存、即时粒子、DAP 和 World Labs 单图/多图主链保留；自有 3DGS、活动共创、账号、云同步、分享和支付仍明确等待。

DAP 范例入口：[huijian.maxxam.xyz/unseen-dap](https://huijian.maxxam.xyz/unseen-dap)。它复用已验收的 4K 宴会厅全景、1024×512 DAP 深度图和约 0.42 米受限位移查看器；这是有限深度视差，不是自由行走的完整 3D。DAP 模型按 CC BY-NC 4.0 使用，正式商用可能需要另行授权或替换模型。

照片果冻触感 Demo：本机启动后打开 [127.0.0.1:4610/jelly](http://127.0.0.1:4610/jelly)。它在浏览器本地把单张照片变成可按压、拉伸和回弹的软体，并用 Web Audio 合成触感音效；不上传或保存照片。

World Lab 实验入口：[huijian.maxxam.xyz/world](https://huijian.maxxam.xyz/world)。默认把 2–8 张同一场景、彼此有重叠的照片交给 World Labs Marble Auto Layout，异步生成一个公开可访问的 3D Gaussian Splat 世界；单图创意补全仍作为次模式保留。2026-09-03 已用公开 11 视角城堡样例完成真实多图/单图 canary，并用 UNSEEN 旧模型验证候选方向；没有配置 World Labs API key 时会明确保持停用，不影响回见主体验。

## 现在能做什么

- 上传 JPG、PNG 或 WebP，也可以直接使用内置示例照片。
- AI 先看原图，再从画面里确实存在的具体细节提出引导问题，不让用户替它识图。
- 三轮对话渐进显影：整体逐渐清晰，被谈到的局部优先清晰。
- 照片从原图自然粒子化，并持续轻微流动；可实时调整密度、流速、离散、空间位移等 9 项参数。
- 拖动照片做 360° 旋转，能看到有厚度的真实背面；也可按住临时查看原图。
- 麦克风只做本机声音强度分析；照片和回答不在服务器持久保存。
- `/world` 默认把 2–8 张同一场景照片合成一个可探索 3D 世界，并在结果里保留设备本地的“照片入口”；单图模式仍可用。Marble 当前不返回逐张精确相机位姿，所以照片入口明确不是精确空间锚点。
- World Lab 服务端默认使用低成本 `marble-1.0-draft`，每天最多 5 次、每位访客每天 1 次，生成结果明确标注由 World Labs 提供。
- `/unseen-demo` 在照片出现后才给出后续分流；模型不可用或弃权时会明确显示备用问题，仍可用文字完成和本机保存，但不会冒充看图成功。
- `/unseen-demo` 的语音回答由浏览器语音识别转成可编辑文字，不录制、不上传、不保存音频；“听阿见读”由服务端按需调用 MiniMax TTS，失败不影响可读文字。
- `/unseen-demo` 可把当前照片经同源 IndexedDB 临时带入 `/world` 单图模式；真正提交前仍需在 World Labs 页明确勾选照片使用权、公开链接和数据处理说明。
- `/unseen-dap` 是不调用在线推理的真实 DAP 范例；桌面支持鼠标/WASD，移动端支持拖动/摇杆，位移半径受限。
- `/official-gallery/v1/` 与 `/unseen-dap/v1/` 使用不可变长缓存并支持 ETag/304；HTML、API 和未版本化动态响应继续 `no-store`。静态资源内容变化时必须同步更新目录版本或严格单一的 `?v=`。

## 跑起来

```sh
node server.mjs           # http://127.0.0.1:4610
PORT=8080 node server.mjs # 换端口
```

需要 Node 22+。没有 npm 依赖，`node_modules` 不存在，不用 install。

```sh
npm test
```

MiniMax key 默认从 `~/.config/openclaw-secrets/runtime-secrets.json` 的
`authProfiles.minimax-cn.apiKey` 读；也可以用环境变量 `MINIMAX_API_KEY` 覆盖。key 不落盘、不打日志、不进任何错误信息。

看图与 TTS 共用 `MINIMAX_API_KEY`。朗读可用 `MINIMAX_TTS_BASE_URL`、`MINIMAX_TTS_MODEL`、`MINIMAX_TTS_VOICE_ID` 覆盖默认值；公共服务另有按 Caddy 覆写来源地址计算的短窗口请求数与字符数成本闸门。没有可用 key 时静态界面、备用问题、文字回答和本机保存仍可运行。

World Lab 需要另行在 [World Labs Platform](https://platform.worldlabs.ai/) 购买 API credits 并创建密钥：

```sh
WORLDLABS_API_KEY='...' node server.mjs
```

可用 `WORLDLABS_MODEL`、`WORLDLABS_DAILY_LIMIT`、`WORLDLABS_VISITOR_DAILY_LIMIT` 调整模型和公共体验配额。Marble App credits 与 API credits 不通用；API key 只保存在服务端。

## 探针

```sh
node tools/probe.mjs           # 哪个 base URL / 模型是通的
node tools/probe-provider.mjs  # 真照片走一遍完整 provider
WORLDLABS_API_KEY='...' node tools/worldlabs-canary.mjs --mode multi --out /tmp/worldlabs-canary --name test --image image1.jpg --image image2.jpg
node tools/evaluate-worldlabs-locator.mjs --out /tmp/locator.json --pano multi:panorama.png --input photo:photo.jpg
```

World Labs canary 只从进程环境读 key，回执会脱敏；不要把 key 写入参数、仓库或产物。

实测结论（2026-08-16）：

- 官方国内域名 `https://api.minimaxi.com` 正常（三连测 200，1.9–3.9s），默认就用它；海外是
  `https://api.minimax.io`，旧域名 `https://api.minimax.chat` 同一把 key 也仍然通，可作备用
  （`MINIMAX_BASE_URL` 覆盖）。早前一次「连不上」是临时网络抽风，不是域名问题。
- `MiniMax-VL-01` 已下线（服务器回 `400 unknown model ... (2013)`），看图必须用 `MiniMax-M3`，单张 10–17s；
- 纯文本用 `MiniMax-Text-01`（`MiniMax-M2` 会把 `<think>` 推理吐进 content）。

## 结构

```
server.mjs                        node:http；根入口 + 照片对话 API + 健康检查
lib/minimax-question-provider.mjs 从 UNSEEN Book Lab 原样搬来的提问 provider
lib/provider-keys.mjs                    读 key
public/spatial-lab.html           当前回见主入口
public/spatial-lab.js             粒子场、360° 旋转、上传与三轮对话
public/spatial-lab.css            当前主体验视觉样式
public/world-lab.*                同场景多图/单图 → World Labs 3D 世界、照片入口与站内查看器
public/unseen-dap.html + v1/      DAP 深度全景范例、受限视差查看器与版本化静态资产
public/jelly.*                    照片果冻隔离实验：本地单图、软体网格、触感音效
public/unseen-demo.*              UNSEEN 柔光外壳：官方案例馆、个人单图一问一页、本机记忆、即时粒子
public/official-gallery/v1/       官方案例内容清单与版本化封面/缩略图；不承载个人数据
public/voice-input.js             浏览器显式单轮语音转写；文字可修改，音频不落盘
public/turn-voice.js              问题朗读的可取消客户端适配；失败不阻塞文字
lib/minimax-tts-provider.mjs      MiniMax TTS 服务端窄适配层
lib/tts-cost-gate.mjs             不保存原始地址的短窗口朗读成本闸门
lib/worldlabs-client.mjs          World Labs API 的服务端窄适配层
lib/worldlabs-quota.mjs           不保存原图的每日生成额度闸门
public/index.html + 旧前端模块     保留用于追溯，不再由 / 提供
photos/                           内置示例照片
tools/                            MiniMax 探针、World Labs 真实 canary 与 UNSEEN 方向评估脚本
```

主照片和对话文本会发送给 MiniMax 生成问题；服务器不持久保存照片或回答，刷新页面后本轮内容消失。浏览器目前直接支持 JPG、PNG、WebP；HEIC 需要先导出为 JPEG。

## 复用与许可

- `lib/minimax-question-provider.mjs` 源自 UNSEEN Book Lab，并在回见里继续收紧了首问前提边界；有可信事实才提具体问题，看不清就弃权并回到通用问题。
- 示例照片来自 UNSEEN 的 AI 模板空间「夏日聚会」（`~/code/unseen-assets/ai-template-space`），AI 生成，无真人肖像。
- 仓库仍保留此前的多图、zine、导出与本机合集实现以便追溯，但当前根入口不加载这些模块。

</details>
