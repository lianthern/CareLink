# 空间记忆查看器

2026-09-23，Windows 本机独立验证；未部署。

## 接口和供应链

`/spatial-viewer.js` 导出 `openSpatialViewer({container,asset,refreshAsset,onClose,signal})`，**同步**返回 `{destroy,reset}`，内部延迟加载引擎和模型。UI 负责外层关闭、原链接与来源署名；查看器提供加载状态、明确失败提示、旋转、平移、缩放、复位、当前画质和可展开操作说明。支持可选 AbortSignal；主动关闭、撤销授权或页面退出时必须调用 destroy。

asset 为 `{url,bytes,digest,format:'sog',sourceURL,sourceTitle,provider,view?}`。仅接受同源模型 URL，redirect:error；流式下载限64MiB且字节数必须与asset一致，加载前核验SHA256。401/403/404/410最多调用refreshAsset一次，再使用刷新后的整个asset。90秒超时不会恢复成可用状态。服务器须给 `.mjs` 返回 JavaScript MIME，以兼容 nosniff。

使用 [PlayCanvas Engine](https://github.com/playcanvas/engine) 2.22.3（MIT），来自 npm 官方包；实际交付是ES2022 ESM裁剪构建，无CDN、WASM或额外运行时包依赖。`vendor/playcanvas-LICENSE.txt`随部署保留。

- npm integrity：`sha512-HjBbJmUqwqYk678nHu/hUniep0YgziAJ9oqwi13ye/rlDjIN2/bbmnCZexKa5IZDINSMkjqfhq+jsJhPL4wBNA==`
- 自托管构建 `vendor/playcanvas-2.22.3.mjs`：1,267,945 bytes；SHA256 `2426fc8cfdc31f4ec62d268b005a63c6da1565fc64fb8085d63e8746c0316357`。
- 原引擎的两个GSplat sorter会创建未回收的worker blob URL；本构建明确补为 `try { new Worker(url) } finally { URL.revokeObjectURL(url) }`，保留原排序逻辑。worker退出仍由引擎destroy执行。
- CSP所需：script-src `'self'`；worker-src `'self' blob:`；connect-src `'self' blob:`；img-src `'self' data: blob:`。应用的style-src保持 `'self'`，不添加unsafe-inline。查看器样式由同源CSS加载；引擎仅通过CSSOM设置canvas尺寸。此前验收harness为自身布局使用了inline style，不能把那个配置描述为主线应用策略。无需unsafe-eval或第三方脚本域名。

## 完整样例核验

使用 `3DGS-HANDOFF.md` 中用户提供的唯一影石场景，重新读取分享页而非复用签名URL；样例和临时验收页只放Git忽略的 `.tools/spatial`，不提交模型、相机轨迹或签名URL。

- 真实资源域名：`insta360-app-hz.oss-cn-hangzhou.aliyuncs.com`。
- 完整SOG：16,324,085 bytes；SHA256 `93224a51c0385145c747f3d7033907678f20ac3f251f30f7c61a61f1ffb0a630`。
- meta.version=2，generator=`splat-transform v3.1.3`，count=1,000,000；SH bands=3、palette count=65,536，scales/sh0/shN的codebook各256项。
- ZIP内8条，均stored方法0，总展开16,323,137 bytes。local header带data descriptor，尺寸为0，必须读取central directory。PlayCanvas此版不支持Zip64或带尾部comment的ZIP，应由导入端拒绝或正规化。
- `means_l.webp`、`means_u.webp`、`quats.webp`、`scales.webp`、`sh0.webp`、`shN_labels.webp`均1000×1000；`shN_centroids.webp`960×1024；均lossless VP8L；另有meta.json 15,669 bytes。
- 外部JSON为808,436 bytes、1914项采集相机数组。SOG自身足够解码，但本例必须使用相机信息才能得到可辨认初始视角。首次自动包围盒视角被场景外侧遮挡，不视为通过。

格式对照依据：[PlayCanvas SOG格式文档](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/)。具体解析和释放行为同时核对了所安装2.22.3包内SogBundleParser、GSplatSogResource及AppBase源代码。

## 初始相机与交互

后端挑选首个有效 `img_name` 以 `_cam1_up` 结尾的采集相机；不存在时按 `_cam1_center`、首个有效相机回退。这是影石采集相机命名启发式，不保证所有场景构图相同；未硬编码本例的位置。

`view={position,forward,up,fov}`：position原样；forward为rotation第三列；up为rotation第二列反号。使用原模型坐标，不再做COLMAP默认Z轴180度旋转。镜头位置放在记录位置，朝forward方向，以up为相机竖直方向。保留拍摄本身的少量倾斜。

采集FOV公式为 `2*atan(height/(2*fy))*180/PI`。本例原始90°；65°独立试验可清楚辨认会议厅，集成后端将原FOV限制到35–75°，本例75°也已验证。收窄FOV是观看构图取舍，不冒充原采集焦距。没有view时，仅按中心点5%–95%分位数包围盒拟合，作为有限回退，不能保证室内场景无外侧遮挡。

默认省电画布最长边900px；清晰模式最多1.5倍像素密度。按钮显示当前“画质：省电 / 清晰”并暴露aria-pressed。仅相机或排序改变时提交新帧。未实现碰撞、行走、漫游路径或多模型LOD；移动到稀疏或未拍到区域时可见重建缺口。

## 独立体验工作树补充

在 `codex/spatial-experience` 上对照 `reference/memory-frame-v4.html` 的mountPano（约744–763行）：原稿强调“左右滑动 看看四周”、返回、以及附着在示例图片上的记忆气泡。本轮落实真实SOG观看中的直接操作与恢复能力；气泡未具备真实模型坐标和原声关联，保持原稿参考，不伪造空间热点。

- 旋转 / 平移各有明确模式按钮及选中状态；顶部提示随模式改变。单指或鼠标左键按当前模式拖动；Shift + 拖动、鼠标右键/中键拖动随时平移。
- 双指移动中点进行平移、分合进行缩放。触点添加/移除、取消、失焦会重设手势基准并释放捕获；三指不操作相机，重合触点不会计算无限缩放。
- 平移在相机当前屏幕平面内完成，保持原始影石采集相机的倾斜方向；大小随视距、FOV和容器高度换算。平移目标限制在初始目标4倍观看半径内，减少意外丢失场景；这是观看范围限制，不是碰撞检测。
- “＋ 放大”“− 缩小”“回到起点”直接可见；复位恢复原始方向、距离和目标位置，保留已选模式及画质。操作说明可展开，解释鼠标、触屏、键盘及复位用途，不依赖自动漂移暗示。
- Tab可到场景、按钮及展开的可滚动帮助；均有可见焦点。方向键旋转，Shift + 方向键平移，加减键缩放，R / Home复位；Ctrl/Command/Alt组合保留给浏览器。Esc在整个查看器内先收起帮助并把焦点放回说明按钮，再交给外层关闭。
- 控件自动换行，最小触达区域44px；加载和错误时操作禁用并收起帮助。未改变动态加载、同源URL限制、SHA256校验、限额/超时或资源释放契约。

独立模块 `spatial-viewer-navigation.mjs` 不依赖引擎；新增6项测试检查屏幕平移的几何不变量、倾斜相机、输入映射、双指切换/重合/取消、保留浏览器快捷键，以及销毁后零监听/零捕获。与已有空间UI生命周期测试一同运行13项全部通过。测试命令：`node --test test/spatial-ui.test.js test/spatial-viewer-navigation.test.js`。这些合成指针测试不是手机实机触控证据。

真实样例复验：待本轮总控在8791严格同源CSP验收页完成后记录；不能用新增控制模块测试替代真实SOG渲染。

## 本机验证证据和边界

首轮在Windows Codex IAB真实浏览器、127.0.0.1:8791加载完整样例（该轮harness的style-src曾允许unsafe-inline，脚本/worker/连接/图片策略如上）；不是iframe、视频或静态截图。初始画面可辨认白椅、蓝地毯、红墙、投影幕；拖动确实改变角度，缩放改变空间画面，复位恢复采集视角。Windows浏览器渲染、390px宽容器适配与控件可用已检查；后者仅模拟窄容器，**不是手机实机测试，也不是触屏双指手势实机证据**。

严格样式策略补核：harness现已将布局迁至同源 `harness.css`，HTTP实测响应为 `style-src 'self'`、HTML没有style元素或style属性，harness/viewer CSS均200，引擎MIME为text/javascript。查看器子任务补核时自身IAB会话不可用；随后总控使用其可用IAB在该严格style-src配置、同源布局CSS下完成真实模型复验：截图清楚显示会议厅白椅、蓝地毯、投影幕，状态ready，activeWorker=1、activeWebGL=1，console warn/error为空。该轮关闭后DOM canvas消失；因仪表尚未刷新，不将其计作新增的零资源计数证据，下表仍是首轮独立仪表记录。此复验没有放宽应用CSP。

独立验收页仪表跟踪Worker构造/terminate、URL.createObjectURL/revokeObjectURL、WebGL context.isContextLost()、canvas数量：

| 场景 | active worker | live blob URL | active WebGL | canvas |
| --- | ---: | ---: | ---: | ---: |
| 模型显示后 | 1 | 0 | 1 | 1 |
| 显示后关闭 | 0 | 0 | 0 | 0 |
| 慢下载到1%关闭 | 0 | 0 | 0 | 0 |
| 文件不完整失败 | 0 | 0 | 0 | 1（错误容器，关闭后0） |

404及410失效地址分别验证：只refresh一次后显示真实模型。4字节截断响应显示“空间文件未完整下载”，没有未捕获异常。通过测试页模拟getContext不支持WebGL时显示更新浏览器/打开来源提示；该条是故障注入，不代表当前设备缺少WebGL。浏览器console error/warn为空。未测真实手机帧率、GPU专用显存峰值、移动Safari、微信内部浏览器、手机热量或长时间压力。

关闭顺序：AbortController中止下载，移除事件/ResizeObserver，销毁场景实体和模型Asset、App（终止排序worker并释放纹理/缓冲），再调用提前保留的GL句柄的WEBGL_lose_context。提前保留句柄很重要：PlayCanvas App.destroy会将device.gl置null。所有关键异步恢复点同时检查destroyed与signal.aborted，避免超时/关闭后重新创建场景。

## 可复现构建

在项目Git忽略目录 `.tools/spatial` 安装 `playcanvas@2.22.3`、`esbuild@0.25.12`，不改变应用package或lock。把下面脚本保存为该目录的 `build-vendor.mjs` 并在该目录运行 `node build-vendor.mjs`。依赖安装使用官方npm registry；pnpm可能提示esbuild build script被跳过，但平台包自带的可执行文件可用。

```js
import fs from 'node:fs/promises';
import * as esbuild from 'esbuild';
const base = './node_modules/playcanvas/build/playcanvas/src/';
const exports = {AppBase:'framework/app-base.js',AppOptions:'framework/app-options.js',Asset:'framework/asset/asset.js',Entity:'framework/entity.js',CameraComponentSystem:'framework/components/camera/system.js',GSplatComponentSystem:'framework/components/gsplat/system.js',GSplatHandler:'framework/handlers/gsplat.js',TextureHandler:'framework/handlers/texture.js',WebglGraphicsDevice:'platform/graphics/webgl/webgl-graphics-device.js',Color:'core/math/color.js',Vec3:'core/math/vec3.js'};
await fs.writeFile('vendor-entry.mjs',Object.entries(exports).map(([name,file])=>`export { ${name} } from '${base}${file}';`).join('\n'));
await esbuild.build({entryPoints:['vendor-entry.mjs'],bundle:true,format:'esm',target:'es2022',external:['node:worker_threads'],minify:true,outfile:'../../server/public/vendor/playcanvas-2.22.3.mjs',legalComments:'eof',banner:{js:'/*! PlayCanvas Engine 2.22.3, MIT. See playcanvas-LICENSE.txt. Worker object URLs revoked immediately after creation. */'},plugins:[{name:'revoke-worker-urls',setup(build){build.onLoad({filter:/gsplat-(?:unified-)?sorter\.js$/},async({path})=>{let contents=await fs.readFile(path,'utf8');const original='this.worker = new Worker(URL.createObjectURL(new Blob([workerSource], {\n\t\t\t\ttype: "application/javascript"\n\t\t\t})));';const replacement='const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }));\n\t\t\ttry { this.worker = new Worker(workerUrl); } finally { URL.revokeObjectURL(workerUrl); }';if(!contents.includes(original))throw Error('Worker patch mismatch: '+path);return{contents:contents.replace(original,replacement),loader:'js'}})}}]});
await fs.copyFile('node_modules/playcanvas/LICENSE','../../server/public/vendor/playcanvas-LICENSE.txt');

```
