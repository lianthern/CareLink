# v8 验收合同

任何 P0 hard gate 失败都必须停止；不能用 PSNR、截图好看或“脚本返回 0”覆盖用户体验失败。

## A. v7 Viewer 回归修复（不跑 GPU）

- [ ] manifest/schema/tests 向后兼容 v6/v7。
- [ ] 可见 `+ / −` 控件、鼠标滚轮/触控板和键盘快捷键都能缩放；E2E 分别证明 FOV 至少变化 `5°`，并在 `30°–90°` 正确 clamp。
- [ ] `0` 恢复 manifest 默认 FOV，UI 数字与真实 camera FOV 一致。
- [ ] 从 v7 中段照片机位进入 free-walk 后：yaw 连续；`abs(pitch) <= 0.5°`；`abs(roll) <= 0.5°`；Y 等于 median walk height（误差 `<=1e-5`）。
- [ ] v7 normal 模式按住 W `1.0s` 的 XZ 位移至少为旧短边的 `25%`，且不越凸包边界；不得只测 `>0.005`。
- [ ] sprint/normal 实测位移比在 `2.7–3.3`。
- [ ] 拖动视角后 roll 仍 `<=0.5°`，pitch clamp 生效；向前走不改变 Y。
- [ ] 三个 photo-anchor 仍恢复原始 XYZ/quaternion/FOV；回到 free-walk 时再次平视。
- [ ] Chromium E2E 零 page/console error；截图展示 zoom UI、walk/sprint 状态和顶视边界。

## B. 官方素材与本机上传

- [ ] 来源只允许 `Meetingroom.mp4` 官方 Drive ID `0B-ePgl6HF260V3BFSFFTZFJwSWc`。
- [ ] 原文件：`4,271,432,079` bytes，MD5 `5beeb4e21ca5b8fda31235cf15972393`。
- [ ] ffprobe：H.264，`3840×2160`，`30000/1001 fps`，`370.370s`（时长容差 `0.05s`）。
- [ ] 本机转码副本：完整时长 `370.370s ±0.75s`、`1600×900`、H.264、无音频、`<2 GiB`；记录动态 bytes/SHA256，不预填。
- [ ] intake 精确 `127.0.0.1:8780–8789`、`READY`、`trainingStartsAutomatically=false`。
- [ ] intake 返回 bytes/SHA256 等于转码副本，状态 `UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW`，训练仍未启动。
- [ ] 下载/转码/上传日志脱敏；原视频和副本不进 GitHub。

## C. 完整房间 SfM/覆盖 gate（GPU 前）

- [ ] 全 `370.37s` 按 `1fps` 取样，帧数在 `369–372`；首末时间戳覆盖至少 `99%` 时长。
- [ ] 12 个等时间 bin 每个至少有一张注册相机；最大单模型注册率 `>=90%`。
- [ ] 单相机 `SIMPLE_RADIAL`；mean reprojection error `<=1.5px`；mean observations/image `>=300`；mean track length `>=3.0`。
- [ ] camera centers 的平面 PCA `lambda2/lambda1 >=0.15`，排除单线推拉。
- [ ] 平面凸包面积为正；`trajectoryLength / hullDiameter >=2.0`，排除只站在原地缩放/摇镜头。
- [ ] 12 格 contact sheet 至少 `8/12` 同时可见上墙或天花板，且至少 `8/12` 可见地面；人工结论逐格记录，不用模型臆测。
- [ ] 计算平均 camera-up、world-up 对齐矩阵、相机高度中位数和 P5/P95；不得直接沿用 v7 的固定 `Rx(-90°)` 而不验证。
- [ ] 生成顶视 camera footprint；人工确认轨迹覆盖房间两个平面方向，而不是狭长条。

若官方原始抽样本身无法通过某个数值门，保留真实值并 `BLOCKED`，不得删掉失败时间段、改阈值或换模型后继续 GPU。

## D. 7k / SOG

- [ ] 仅一次从头 7k，step 终点 `6999`；无第二个 GPU job、无 resume、无 15k/30k。
- [ ] random init=false、load 3D points=true、camera optimizer=off；记录实际命令和版本。
- [ ] 记录 wall time、peak VRAM、OOM、checkpoint SHA；未测字段为 `null`。
- [ ] held-out 覆盖至少 12 个时间 bin，报告 mean/min PSNR、SSIM、LPIPS；不得只抽相邻帧。
- [ ] PLY→SOG Gaussian 数一致，SOG roundtrip 通过；优先 SH2，回退 SH1 必须有真实失败证据。
- [ ] scene/manifest/revision 全部是 `tandt-meetingroom-r001`，不覆盖 v7。

## E. 完整房间 Viewer 用户门

- [ ] 真实 SOG `ready`，无 console error；只监听 `127.0.0.1`。
- [ ] start pose 为平视 walk pose，不是某张俯斜照片机位；roll `<=0.5°`。
- [ ] normal W `2s` 有明显平移，Shift sprint 可感知；运动不是只改 FOV。
- [ ] 缩放、行走、拖动抬头可同时使用；UI 显示 FOV 和速度档。
- [ ] 同一中心 walk point 的 front/back/left/right/up/down 六图都能看到有效场景；`direction-up.jpg` 必须包含可辨认横梁/灯/天花板，不得是大片空洞或纯背景色。
- [ ] 从中心走向两个不同方向再返回，场景没有整屏纸片撕裂；局部浮点允许如实标限制。
- [ ] 三个照片锚点精确回位，切回 free-walk 后恢复平视。
- [ ] 10–20s、`<=15MB` 的安全 Viewer 录屏真实展示：zoom in/out → normal walk → sprint → look up；不是源视频重编码。
- [ ] `V8-REPORT.md` 第一屏提供实际 Viewer URL、是否仍运行、Max 的四步试用顺序和限制。

用户门结论只能是：

- `FULL_ROOM_CANARY_ACCEPTED`：上述全部通过；或
- `TECHNICAL_PASS_USER_GATE_FAIL`：能加载但仍不像完整可走房间；或
- `FAILED/BLOCKED`。

不得再把微小位移、窄轨迹或相邻帧高 PSNR写成“完整空间通过”。
