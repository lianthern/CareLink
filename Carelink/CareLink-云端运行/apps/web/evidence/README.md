# Track 2 验收证据

生成日期：2026-08-14（Australia/Brisbane）。所有证据由 `apps/web/**` 内脚本在本地生成；没有部署、生产云写入、真实凭证、fixture fallback 或预期外网请求。

## 结果摘要

- 冻结覆盖：90 个产品动作、19 个 P01–P18/P09B entry、每动作九态；机器映射见 `action-coverage.json`。
- Transport：58 个冻结 HTTP mutation 全部有 byte-stable request builder；一次性外部 invitation exchange 单独严格构建。全部 mutation/read URL 精确测试，无 `{placeholder}` 或双斜线，CAS/notice/idempotency/reauth 缺失时 fetch 前失败。
- Node：43/43 通过，覆盖 action request、canonical reads、receipt recovery 错误码、purpose-bound reauth、File upload、fixture 状态机、media notice v2 fail-closed 和 Track 4 真实公共入口契约。
- Production 浏览器：HttpApiAdapter + 同源严格 canonical API + ProductionViewerAdapter；console error 0、exception 0、正常路径 HTTP 4xx/5xx 0、failed request 0、意外外网 0。
- 浏览器 UI：横向溢出 0、小于 44px 的可见交互目标 0、无名交互控件 0、可见图片缺失 alt 0、键盘/焦点失败 0、每页可见 primary CTA 超过 1 的状态 0、runner orphan 0。
- 上传：观察到真实 PUT 37989 bytes、SHA-256 与 exact one-time ticket；随后 commit、batch/receipt/item/placement route re-read 完成。
- 身份：登录、上传回执绑定和 AUTH.LOGOUT_ALL reauth 均在严格 server 中验证 challengeId/purpose；正式 DOM 输入无预填。
- 媒体 identity：篡改 photo-5 bytes 后相册不渲染、Viewer 不 focus/return；正确 bytes 通过完整 photo/panorama/placement revision identity。
- 照片处理说明：`/notices/media?spaceId=…` 只消费真实 nested `mediaNotice` / `currentConsent`，从中派生 exact v2 / `fe33ba9…` / policy identity 与 server `consentEventId`；本地 copy canonical hash 同时绑定 `fe33ba9…`。旧 `80c…` notice hash、同版本错误 hash、错误 policy/currentConsent、顶层 mock 形状、copy drift、malformed 或跨 Space 状态稳定拒绝且产生 0 consent。页面逐字使用 Track 6A `photo_upload.zh-CN.2` candidate；正式发布仍须外部法务批准，本证据不代表批准。
- 现场照片入口：Track 2 不在 canvas 上绘制或推算空间光点；画布外列表只包含 confirmed placement，按钮以完整 identity 调用 Track 4 `focusPose()`，不确定/场外/失败状态不会出现为回位入口。
- 法律路由：production `/privacy`、`/terms` 仅使用冻结 catalog 的暂时不可用状态；customer DOM 对“本机/验收/候选/发布前/审批”施工词反向断言为 0。

`browser-acceptance.json` 保存完整步骤、路由 GET、method/path/body/关键 headers、截图、几何、AX、异常与 cleanup metadata。

## 断点与几何

同一 deterministic review state 分别截图：

- mobile IA：320/390/430/768/959/960/1247。
- desktop IA：1248/1280/1440。

1248/1280/1440 的 page 宽均为 1184px、review card 宽均为 936px、文本 line-wrap hash 均为 `2648086574:1`；左边距为 32/48/128px，仅外留白变化。200% zoom 无横溢；reduced-motion 生效；真实 AX tree 无 unnamed control。

## 截图

主链：

- `screenshots/mobile-390-home-production.png`
- `screenshots/mobile-390-album-production.png`
- `screenshots/mobile-390-media-notice-v2.png`
- `screenshots/mobile-390-batch-receipt-production.png`
- `screenshots/mobile-390-placement-real-viewer.png`
- `screenshots/mobile-390-scene-real-viewer.png`

临界与桌面同状态：

- `screenshots/breakpoint-320-owner-review.png`
- `screenshots/breakpoint-390-owner-review.png`
- `screenshots/breakpoint-430-owner-review.png`
- `screenshots/breakpoint-768-owner-review.png`
- `screenshots/breakpoint-959-owner-review.png`
- `screenshots/breakpoint-960-owner-review.png`
- `screenshots/breakpoint-1247-owner-review.png`
- `screenshots/breakpoint-1248-owner-review.png`
- `screenshots/breakpoint-1280-owner-review.png`
- `screenshots/breakpoint-1440-owner-review.png`

## 六图视觉核对

- ref-1：正式首页采用冻结共光主图、暖白空间、照片主导构图；caption 只描述图片，不作为产品口号。
- ref-2：相册保持媒体优先、非等高节奏，但不复刻角色选择或旧工作台 IA。
- ref-3：桌面管理使用冻结 wide/narrow 轴与任务聚焦的侧栏，没有时间线、工程指标或模板化 dashboard。
- ref-4/ref-5：手机保持单列、少按钮、唯一主动作；空间顶层只有查看/上传/管理，查看内部只有相册/现场。
- ref-6：三圆白心作为轻量标识；主 CTA 保持粉金渐变、深酒红文字。

页面只使用冻结 tokens。唯一布局断点是 1248px，不形成第三套；focus/contrast/touch target/reduced motion 均有运行态证据。

## 未关闭的集成门槛

- Track 4 `focusPose()` 永久 pending 反例已在 clean `b5d54f9` 修复并由 `5c32fb9` 保留：不可环视时稳定 reject `spherical_view_unavailable`。Track 2 的 1800ms bounded wait 仍只返回失败，不伪造成功；原始 DTO、phase/renderMode/capability 与修复核对见 [`TRACK4-FOCUS-PENDING-REPRO.md`](./TRACK4-FOCUS-PENDING-REPRO.md)。
- 本次 headless 证据证明真实 Track 4 public entry、scene-context、canvas/诚实降级及 retry/return 接缝，不宣称完成 GPU 可见浏览器的完整 360/yaw 认证。Track 4 clean commit 与 Track 5 合并后仍须在可用 GPU/可见浏览器复验。
- Track 1A clean `4e0c64e` 的 scene-context 仍缺总控已拍板的 `photoAssetId/photoAssetVersion/photoRawSha256`，且 panorama media 是一次性 header capability；Track 4 clean `5c32fb9` 的唯一 public DTO 只能接收 URL/revision/sha，无法传该 header。Track 2 对两者 fail-closed，不会把无法读取的资源交给 Viewer；精确证据见 [`TRACK1A-VIEWER-INTEGRATION-GAP.md`](./TRACK1A-VIEWER-INTEGRATION-GAP.md)。Track 1A/4 对齐并由 Track 5 复跑前是集成 NO-GO。
- 隐私说明与服务条款没有发布文本；6A/政策/法律审批替换前为 release NO-GO。
