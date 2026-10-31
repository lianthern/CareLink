# UNSEEN 产品 / UI 来源真值

状态：**Core视觉真源 + L3 Book Lab UI revision candidate**
裁决日期：2026-08-13（Australia/Brisbane）  
适用范围：本轮正式App的产品模型、IA、Markdown线框与UI方向；同时约束独立L3 Book Lab BL01–BL06。它不等于视觉终稿或本次revision已通过施工批准。

## 结论

真正可追溯的早期美术母版，是 Max 在 Claude Desktop 人类消息中直接附带的 **6 张 WebP**。在 `2026-07-25 02:14:43.252 +10:00`，Max 已明确说它们来自“美术的那个队友”，并拍板“先用他这一版 UI”；六图于 9 分 40 秒后的 `02:24:23.703 +10:00` 进入新施工会话；24 分钟后又被 `/Users/max/code/spatial-memory/DESIGN-UNSEEN.md` 记录为“Max 的美术队友出的 Demo UI 图，共 6 张”，并随 commit `f354503` 落成执行规格；再于 commit `7b72627` 被用于“美术刷皮”。

**正式 V11 是 2026-08-07 的后续正式实现与历史产品证据，不是视觉母版。** 当前未把它证明为六图的直接版本谱系；它可以证明哪些 UI、流程和故障曾真实存在，不能反向覆盖六张原图，也不能替本轮正式 App 决定 IA。

## 本轮权威顺序

1. **2026-08-13 当前委派中的 Max / 总控最新裁决**：一个 App、一个 Space；未登录首页只“打开空间”；登录后“我的空间”；外部只有查看 / 上传，管理来自 Membership；空间顶层按能力投影 `[查看][上传][管理]`，查看内再分相册 / 现场；自动定位、位置编辑、`depth_limited_parallax / walkable3d` 分级按最新合同执行；照片语义只作定位成功后的可关闭异步注脚，不改核心 IA、不进 v1.0 闸门。
2. **六张原始 WebP 及其原始人类会话 record**：决定品牌气质、视觉母题与可继承的界面语言。
3. **`DESIGN-UNSEEN.md` 在 commit `f354503` 中的首版**：证明六图身份，并提供对六图的当时解读；它是派生规格，不高于原图。
4. **后续 Git / PRD / V11 / 各平台截图**：只证明历史实现、技术状态、问题与被尝试过的方向。

若 2–4 与第 1 项冲突，按第 1 项；若派生 token 与原图实观冲突，回到原图，不以二手规格压过实图。

照片语义注脚的 durable 产品真源：`/Users/max/Library/Mobile Documents/iCloud~md~obsidian/Documents/MaxNotes/🚀项目/AdventureX-2026/UNSEEN-项目总纲-2026-07-30.md:9-72`。它只约束定位成功后的异步层，不改变六图的视觉来源裁决。

## 原始证据链

### E0 · Max 先明确归属并授权采用（最早直接声称）

- 文件：`/Users/max/.claude/projects/-/f506cf64-86e8-4789-8bf6-74a51f9007df.jsonl`
- JSONL record：第 226 条
- UUID：`0a28eb8c-cd0f-406e-905a-8fff0551258f`
- 时间：`2026-07-24T16:14:43.252Z`；布里斯班时间 `2026-07-25 02:14:43.252 +10:00`
- 字段：`type=user`、`origin.kind=human`、`message.role=user`
- Max 原话中的关键事实：美术队友做了 Demo 图片；虽然“不觉得很惊艳”，但决定“先用他这一版 UI”，并要求新执行者依据这版 UI 调整整体 Demo。

这条记录是目前最早的**直接归属 + 采用授权**；它不含图片字节。E1 是 9 分 40 秒后的最早像素原件，两条必须合看。

### E1 · 人类消息内嵌六图（最直接）

- 文件：`/Users/max/.claude/projects/-/810f7c97-f7e4-4612-81fc-cf05a6127ce5.jsonl`
- JSONL record：第 3 条
- 时间：`2026-07-24T16:24:23.703Z`；布里斯班时间 `2026-07-25 02:24:23.703 +10:00`
- 字段：`type=user`、`origin.kind=human`、`message.role=user`
- 内容：6 个 `image` block，全部 `media_type=image/webp`；随后 1 个文字 block
- 会话文件 birth time：`2026-07-25 02:24:23 +10:00`，与 record 时间一致
- 核验结果：从 base64 解出的六份字节与本目录 `evidence/ref-1.webp`…`ref-6.webp` **逐字节相等**

注意：该条文字让执行者读取 Demo 建造书并开工，也提到可找 Codex 做可见桌面美术；图片归属已由 E0 在 9 分 40 秒前直接说明，E2 又在同夜落盘规格中复核了一次。

### E2 · 同夜设计规格明确归属（身份说明）

- 文件：`/Users/max/code/spatial-memory/DESIGN-UNSEEN.md`
- 首次落盘：commit `f354503131cc390782291bf5be078a99d325a3d7`
- 作者时间：`2026-07-25T02:48:21+10:00`
- 首版第 3–5 行原义：来源是 Max 的美术队友 Demo UI 图、共 6 张、由 Max 在对话里直接投递；文件把图翻译成六幕 Demo 的设计参数
- 第 13–18 行逐张描述与六张实图一一对应；不存在“拿别组图误配六张描述”的迹象

### E3 · 进入实际实现（派生关系）

- `f354503` 同时新增 `DESIGN-UNSEEN.md` 与 `web/demo.html`；commit message 明写“皮肤按美术基准图 UNSEEN 走”。
- commit `7b72627bc7a4d3c317043ee4f540877affe7d992`
- 作者时间：`2026-07-25T03:05:58+10:00`
- commit title：`美术刷皮:logo 白心改成三圆真交集 + 罗盘重做 + 光场分层`
- 这证明三圆白心、暖光与胶片感在原图之后进入实现；它们仍是**派生实现**，不是新的母版。

### E4 · 两张高度对应的高清净边变体（次级证据）

- `/Users/max/Library/Mobile Documents/iCloud~md~obsidian/Documents/MaxNotes/🚀项目/AdventureX-2026/现场素材-照片录音/Image_20260726114649_1302_3544.png`
  - 1672×940；SHA-256 `c8aae9ff504c435013a50ac5a21f74451d78b365cd01f96b36f34ac73380bfa8`
  - birth / mtime：`2026-07-26 13:58:43 +10:00`
  - 实图为 ref-4 的净边高清版本；本轮可复跑 SIFT 单应关系核验 inlier `2302 / 2512 = 91.640%`
- `/Users/max/Library/Mobile Documents/iCloud~md~obsidian/Documents/MaxNotes/🚀项目/AdventureX-2026/现场素材-照片录音/Image_20260726114650_1303_3544.png`
  - 1672×941；SHA-256 `482300ab3414b143ae3f28fd8feac545cad4afb290c911601a7f55d6949dcace`
  - birth / mtime：`2026-07-26 13:58:49 +10:00`
  - 实图为 ref-5 的净边高清版本；本轮可复跑 SIFT 单应关系核验 inlier `2528 / 2719 = 92.975%`

单应匹配与实图观察证明二者分别是 ref-4 / ref-5 的高度对应高清净边版本；“同源”是结合实图的合理推断，不是对生成谱系的独立证明。它们落盘时间比 E1 晚约 35 小时 34 分，且无文档 / Claude 引用、作者或生成软件元数据。因此可用于后续视觉细节观察，**不能替换最早 WebP，也不能反推生成来源**。

## 六张源图清单

Contact sheet：`/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/contact-sheet-labeled.png`

| # | 绝对路径 | 尺寸 | SHA-256 | 本轮允许继承的事实 |
|---|---|---:|---|---|
| 1 | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/ref-1.webp` | 856×1516 | `bdb33edbd148578f22f56d23a3b3aa6b90617303c19605339078119aa4cf45df` | 暖金现场、被忽略视角、光斑 / 胶片作为情绪母题；不等于每页铺光斑 |
| 2 | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/ref-2.webp` | 1640×922 | `56fe68ea1d7465f92d87b3f5e53a30368ee503d5c97ed43c480ff7cf2073c59d` | 媒体第一、照片时间关系、权限可见；不继承复杂桌面故事播放器 IA |
| 3 | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/ref-3.webp` | 1636×922 | `7e4685acfad73f12cdabff676ec5ee668420fe9a529937a66d5e2d4408816055` | 桌面管理可利用宽屏、Review 是主人任务；不把多轨 Studio 暴露给普通人 |
| 4 | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/ref-4.webp` | 1526×898 | `d8e83572553ef0e54c515ed85af9ff29f68421fa6e9d5ff631eb1c6da4f82a77` | 手机任务卡、清楚回执、照片补全共同记忆；不把百分比和积分自动带入正式首版 |
| 5 | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/ref-5.webp` | 1560×920 | `497b5c2cb21b3f7734369047a949456efaa4b0ad83ca3de817e48d2e4c8802c1` | 简洁手机节奏、创建 / 邀请、最近空间；身份不再由用户手选，改由 token/capability 投影 |
| 6 | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/ref-6.webp` | 1488×1428 | `6b3a43279307142f3c1f92dd1304744fd7fb10d348c1229e15edc03f77d91226` | 三视角交叠、中央白心 Logo；作为品牌签名，不到处复制成装饰 |

完整绝对路径见上表；字节数见 `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/README.md`；校验表见同目录 `SHA256SUMS`。

## 派生历史与降级

| 日期 | 证据 | 正确定位 |
|---|---|---|
| 2026-07-25 02:14 +10 | Max 人类 record：美术队友 Demo UI，拍板先用这一版 | 最早直接归属与采用授权 |
| 2026-07-25 02:24 +10 | 新施工会话的人类 record 六图 | **最早像素可证的母版原件** |
| 2026-07-25 02:48 +10 | `f354503` / `DESIGN-UNSEEN.md` | 母版的首个文字 / token 翻译 |
| 2026-07-25 03:05 +10 | `7b72627` “美术刷皮” | 六幕 Demo 派生皮肤 |
| 2026-07-30 | `UNSEEN-三平台统一产品与交互合同-2026-07-30.md` | 当时把秒哒定为母版；被 2026-08-13 当前裁决取代 |
| 2026-08-07 | 灵光正式 V11，`artifactVersion=11` | 历史正式实现；用于诊断，不作母版 |
| 2026-08-11 | `UNSEEN-V11-产品体验复跑报告-2026-08-11.md` | 证明 V11 视觉模型冲突、核心动作埋深、桌面仅窄手机列等历史问题 |
| 2026-08-13 | 当前产品重启 | 回到六图气质，重做正式 App 产品 / UI 架构 |

V11 的保留价值：它能证明正式环境曾支持核心 360，也能暴露产品入口、错误态、内容可信度和响应式问题。V11 的非权威部分：首页 IA、档案馆、Demo 中心、AI 婚礼层级、混合皮肤、全部具体页面布局。

## 找到与未找到

### 已锁定

- Max 在六图上传前的直接归属与采用授权。
- 六图原始字节、record 时间、human origin、文件 hash、尺寸、实图内容。
- 同夜 `DESIGN-UNSEEN.md` 的明确归属及逐图描述。
- 两个紧随其后的 Git commit 与派生关系。

### 不再冒充证据

- `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/UNSEEN-原始参考图`：空目录。其 birth time 为 `2026-07-25 17:04:26 +10:00`，只能证明曾创建目录，不能证明目录里曾有哪张图。
- `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 2/UNSEEN-原始参考图/01-emotional-light.webp` 至 `06-three-circles-heart-logo.webp`：六图 exact-hash 副本，mtime `2026-07-25 17:04:26 +10:00`；其 README 明写来自 E1 会话。它是可靠的当日后续提取副本，但比 E1 晚约 14 小时 40 分，不能反过来当最早原件。该目录的 `07-functional-reference-machine-timeline.webp` 来自另一会话，仅为机器时间轴功能参考，不属于六图品牌母版。
- `/tmp/unseen-origin-ref.9hlCrd/*`：本轮临时解图位置；可用于交叉校验，但 `/tmp` 不是长久真源。
- 正式 V11 截图：派生历史，不能填补原图。

### 仍未知但不阻塞本轮

- 六图由美术队友使用何种 AI 模型、prompt、种子或后期工具生成，现有证据没有说明。
- 是否存在比这条 record 更早的队友私聊 / 源文件 / Figma 工程，当前未取得一手载体；因此本裁决准确措辞是“**目前最早且已闭环核验的美术母版原件**”，不是声称它们是创作过程中的绝对第一份文件。
- ref-4 / ref-5 已找到高度对应的高清净边变体；ref-1 / ref-2 / ref-3 / ref-6 尚未找到对应高清净边源文件。两张变体本身也缺来源平台、prompt 与生成元数据。

## 可复跑命令

### 1. 只读核对 record，不打印 base64

```bash
python3 - <<'PY'
import json
p='/Users/max/.claude/projects/-/f506cf64-86e8-4789-8bf6-74a51f9007df.jsonl'
for i,line in enumerate(open(p, encoding='utf-8'), 1):
    if i == 226:
        o=json.loads(line)
        print(i, o['timestamp'], o.get('origin'), o['message']['role'])
        print(o['message']['content'])
        break
PY

python3 - <<'PY'
import json
p='/Users/max/.claude/projects/-/810f7c97-f7e4-4612-81fc-cf05a6127ce5.jsonl'
for i,line in enumerate(open(p, encoding='utf-8'), 1):
    o=json.loads(line)
    if o.get('timestamp')=='2026-07-24T16:24:23.703Z' and o.get('type')=='user':
        print('line', i, 'origin', o.get('origin'), 'role', o['message']['role'])
        for n,b in enumerate(o['message']['content'], 1):
            s=b.get('source', {})
            print(n, b.get('type'), s.get('media_type'), len(s.get('data','')))
        break
PY
```

### 2. 在内存中解码原 record，并与交付副本逐字节核验

```bash
python3 - <<'PY'
import base64, hashlib, json, pathlib
p='/Users/max/.claude/projects/-/810f7c97-f7e4-4612-81fc-cf05a6127ce5.jsonl'
evidence=pathlib.Path('/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence')
for line in open(p, encoding='utf-8'):
    o=json.loads(line)
    if o.get('timestamp')=='2026-07-24T16:24:23.703Z' and o.get('type')=='user':
        images=[b for b in o['message']['content'] if b.get('type')=='image']
        for i,b in enumerate(images, 1):
            raw=base64.b64decode(b['source']['data'])
            saved=(evidence/f'ref-{i}.webp').read_bytes()
            print(i, hashlib.sha256(raw).hexdigest(), 'BYTE_EQUAL', raw == saved)
        break
PY
```

### 3. 核对规格与 Git 链

```bash
git -C '/Users/max/code/spatial-memory' show f354503:DESIGN-UNSEEN.md | nl -ba | sed -n '1,24p'
git -C '/Users/max/code/spatial-memory' show -s --format=fuller f354503
git -C '/Users/max/code/spatial-memory' show -s --format=fuller 7b72627
git -C '/Users/max/code/spatial-memory' show --stat --oneline f354503
git -C '/Users/max/code/spatial-memory' show --stat --oneline 7b72627
```

### 4. 核对交付副本

```bash
cd '/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence'
shasum -a 256 -c SHA256SUMS
```

### 5. 核对两张高清净边变体的画面对应关系

依赖：Python 环境中的 `opencv-python` 与 `numpy`。在本轮环境预期输出为 `2302 / 2512 / 91.640%` 和 `2528 / 2719 / 92.975%`；该结果证明高度画面对应，不单独证明生成来源。

```bash
python3 - <<'PY'
import cv2, numpy as np
pairs=[
('/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/ref-4.webp',
 '/Users/max/Library/Mobile Documents/iCloud~md~obsidian/Documents/MaxNotes/🚀项目/AdventureX-2026/现场素材-照片录音/Image_20260726114649_1302_3544.png'),
('/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-product-reboot-2026-08-12/product-ui/evidence/ref-5.webp',
 '/Users/max/Library/Mobile Documents/iCloud~md~obsidian/Documents/MaxNotes/🚀项目/AdventureX-2026/现场素材-照片录音/Image_20260726114650_1303_3544.png')]
sift=cv2.SIFT_create()
for a,b in pairs:
    A,B=cv2.imread(a,0),cv2.imread(b,0)
    ka,da=sift.detectAndCompute(A,None); kb,db=sift.detectAndCompute(B,None)
    raw=cv2.BFMatcher().knnMatch(da,db,k=2)
    good=[x for x,y in raw if x.distance < .75*y.distance]
    src=np.float32([ka[x.queryIdx].pt for x in good]).reshape(-1,1,2)
    dst=np.float32([kb[x.trainIdx].pt for x in good]).reshape(-1,1,2)
    _,mask=cv2.findHomography(src,dst,cv2.RANSAC,5.0)
    print(a.rsplit('/',1)[-1], int(mask.sum()), len(good), f'{mask.mean():.3%}')
PY
```

## 对后续工作的约束

- 视觉方向必须从六图抽取，但不复制六图中的旧页面结构。
- 标注 `[母版继承]` 与 `[本轮决策]`；两者不能混写成“原设计如此”。
- V11 可作为回归 / 反例库，不可再以“正式”二字自动升级为视觉权威。
- 最新产品 Decision 高于六图中的旧 IA：未登录首页、我的空间、Membership、`[查看][上传][管理]`、自动定位与 Scene 分级均是本轮新决策，不得反写成母版事实。
- 视觉终稿开始前仍需一次母版校准评审；本轮只给方向与 Markdown 线框。

## L3 Book Lab · BL01–BL06（2026-08-13新增授权）

Book Lab位于照片上传、定位、审核与Viewer主链之后，默认off。它必须进入本轮施工和最终E2E，但不在Core首页、顶层空间导航或普通上传流程新增入口噪声；AI失败、跳过或关闭不得改变照片入库与回现场结果。

合法入口只冻结两个feature-flag secondary slot，不得再增第三处：上传者本人在已归位照片结果/详情页看到“回答这张照片的问题”，进入BL01；当前Space owner在管理概览看到“记忆成书”，进入BL04。reviewer、viewer-only与未授权成员不显示管理入口。BL06只可通过冻结版本链接进入，并在每次read重新验证当前Core查看资格和该版本全部source grants。flag off时上述DOM、路由入口、Book API挂载与job dispatch均为零；不得在首页、全局顶栏或顶层`[查看][上传][管理]`导航增加Book项。Core Web只预留精确接缝`apps/web/src/extensions/book-lab.js`，业务页面仍归`apps/web/src/features/book-lab/**`。

| Page | Route | 手机 | 电脑 | 唯一主任务 |
|---|---|---|---|---|
| BL01 照片问题入口 | `/labs/memories/photos/:photoId` | 照片在上，一张“这张照片想问你一句”卡在下 | 左侧照片+时间/位置/方向，右侧单问题卡 | 回答这个问题；跳过为弱动作 |
| BL02 回答与确认 | `/labs/memories/:memoryId` | 最多两张问题卡，不做聊天气泡流 | 左图右文，显示你的原话与编辑确认 | 确认我的回答 |
| BL03 逐书授权 | `/labs/books/:bookId/contributions/:memoryId` | 清楚显示“只授权给这一本书”、署名方式与撤回 | 来源、原话、书名、授权范围并列 | 授权加入这本书 |
| BL04 记忆成书 | `/manage/:spaceId/book-lab` | 书封/状态卡与创建入口 | 书列表+当前素材摘要 | 创建一本记忆书 |
| BL05 书稿 | `/manage/:spaceId/book-lab/:bookId/draft` | 逐页横滑，编辑动作收在当前页 | 左侧单页大预览，右侧只改标题/删页/换展示图 | 生成或冻结当前版本 |
| BL06 数字书预览 | `/s/:spaceId/books/:bookId/versions/:versionId` | 横滑阅读、页码、返回、下载 | 居中方形页面与克制翻页 | 下载PDF |

页面不是聊天机器人、AI Studio、模板市场、自由画布、图层或时间线。每张照片固定1个初始问题，回答后最多1个可选追问。AI问题、可见事实、模型版本与用户原话视觉分层；用户确认前不得把AI内容当公共事实，v0不让AI改写用户回答。

每张入书记忆必须显示空间provenance ribbon，例如`19:42 · 舞台左侧 · 朝向舞台 · 阿远`。这条ribbon、多人署名冲突视角、逐条授权/撤回与版本来源是Book Lab的视觉签名；不另造一套皮肤。`SceneNote`仍是本人可见注脚且永不作为Book输入，即使它的作者是同一人也不得复制或迁移；只有Book Lab新建、用户确认的`personal_memory_revision`才能逐书授权进入owner书稿、HTML或PDF。

撤回是两种不同动作：撤回个人记忆会撤销其全部Book grants；“仅撤出这本书”只影响指定Book。冻结前撤回立即移出书稿；冻结后旧数字版本标为受影响并停止分发，要求生成不含该内容的新版本。界面必须说明：平台可以停止继续提供旧HTML/PDF，但无法召回用户已经下载到设备的文件。

[母版继承] 照片优先、暖光粉金、三视角交叠、手机任务卡、桌面宽屏关系与中央白心品牌签名。
[本轮决策] 单问题/最多一次追问、provenance ribbon、逐书授权、署名冲突、HTML/PDF方形数字页与冻结/撤回状态。不得把这些新决策反写成六图原设计。
