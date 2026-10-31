# v8 P0：完整室内长视频 → 可缩放、平视、正常行走的整间房间

人类状态页：[GitHub Issue #9](https://github.com/maxi-max-dev/max-agent-bridge/issues/9)

本轮不是给 v7 再堆训练步数。Max 的真实视觉复验已推翻“v7 是完整教室”的说法：v7 只是一条俯拍、狭长的轨迹切片。v8 先修 Viewer 的基本交互，再换成真正覆盖整间大房间的长视频，只跑一次 7k 完整性 canary。

输出 `scene.sog` 是可以自由看的 3D 场景，不是预先录好的成品视频；本轮额外回传一段短 Viewer 漫游录屏，方便 Max 在不操作 Viewer 时快速验收。

## 4060 Agent 唯一入口

在 Windows PowerShell 执行：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-full-room-meetingroom-2026-09-03-v8" `
  -State "RECEIVED_VERIFIED" `
  -Message "v8 full-room long-video and Viewer correction task received; research canary only, production off."
```

然后完整阅读本文件、[`SOURCE-EVIDENCE.md`](SOURCE-EVIDENCE.md)、[`ACCEPTANCE.md`](ACCEPTANCE.md) 和 `TASK.json`，自行连续执行。Max 不需要手抄后续命令。

工作目录仍是 WSL ext4：

```text
/home/max/src/unseen-3dgs-sceneworker
```

不得在 Git checkout、Windows `/mnt/c` 或 iCloud 中处理/训练。一次只能有一个 GPU job。不得覆盖 v1–v7 的任何输入、checkpoint、SOG、manifest 或报告。

## 先纠正 v7 的验收口径

在任何新训练前，把 v7 标为：

```text
TECHNICAL_PIPELINE_PASS / USER_FULL_ROOM_FAIL / TRAJECTORY_SLICE_ONLY
```

已知事实必须进入 v8 报告：

- v7 输入确实是视频，但只有 `17.884533s`，且原画面持续俯向桌椅；
- v7 Viewer 没有滚轮/触控板缩放实现；
- `moveSpeed=0.15`，E2E 只验证了约 `0.106` 的极小移动；
- v7 XZ 导航盒约 `0.64 × 2.19`，不是完整房间；
- 首/中/末相机 Y 约为 `+0.496/-0.022/-0.472`，直接把拍摄姿态带入行走造成斜视/高度漂移感；
- v7 的高 PSNR 只证明相邻平滑视频帧容易重放，不能证明房间完整。

不要删除或覆盖 v7。它仍可作为 Viewer 修复前后的回归夹具。

## Phase A：不动 GPU，先修现有 Viewer

在当前 4060 WSL 项目中复用 v7 已集成的 Viewer，不重写渲染器。先补测试，再实现：

1. 鼠标滚轮、触控板滚动和可见的 `+ / −` 按钮都能调整 FOV；范围固定 `30°–90°`，显示当前 FOV/倍率，`0` 键恢复默认。
2. `WASD` 是水平地面移动；进入 free-walk 的第一帧必须保持 yaw、把 pitch/roll 归零、切到固定 median eye height，不能沿俯视相机方向做“镜头推拉”。
3. 正常速度按场景尺度计算，1 秒应有肉眼明显位移；`Shift` 冲刺为正常速度的 `3×`，UI 显示当前档位。
4. 鼠标拖动只改变 yaw/pitch，roll 始终为 0；pitch 限制 `[-75°, +75°]`。
5. 照片锚点继续恢复原始完整 XYZ/quaternion/FOV，但 UI 明确标为“照片机位”；“自由行走”按钮返回平视 walk pose。两种模式不能混为一谈。
6. 移动边界来自相机轨迹的二维凸包加小幅 buffer，不再用会放行未观测角落的简单轴对齐大矩形。

先在 v7 旧 SOG 上完成 [`ACCEPTANCE.md`](ACCEPTANCE.md) 的 Viewer E2E。这里不允许启动训练。修复必须兼容 v6/v7 manifest；新增字段要更新 JSON schema 和测试。

## Phase B：下载并走一次真实的长视频本机上传

素材是 Tanks and Temples 官方 `Meetingroom.mp4`：4K、`370.370s`、`4,271,432,079` bytes、MD5 `5beeb4e21ca5b8fda31235cf15972393`。它是普通透视相机的连续重建视频，不是等距柱状 360° 视频。许可只按这次本地非商业研究/个人实验使用，禁止把原视频、帧或衍生场景发布、部署或接入商业生产。

先确保 v6 intake 仍精确绑定 `127.0.0.1`、状态为 `READY`、`trainingStartsAutomatically=false`。然后执行任务内冻结脚本：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-full-room-meetingroom-2026-09-03-v8\inputs\scripts\windows\Submit-V8Meetingroom.ps1" -ConfirmResearchCanary
```

脚本会：

- 用出站 HTTPS 可续传下载官方 4.27 GB 文件；
- 先按 bytes + 官方 MD5 验证；
- 用 WSL 已有 `ffmpeg` 生成完整 `370.37s`、`1600×900`、低于 2 GiB 的 H.264 本机上传副本；
- 通过 `127.0.0.1` 上传到 intake 并再次核 bytes/SHA256；
- 保留两个本机文件，只有显式传 `-DeleteOfficialAfterUpload` / `-DeletePreparedAfterUpload` 才删除；
- 不启动训练、不安装软件、不改防火墙、不开放端口。

Google Drive 返回限流/HTML、bytes/MD5 不符、磁盘不足或转码失败时提交 `BLOCKED`；不得改用未知镜像。成功后以脱敏 intake jobId 提交 `RUNNING` receipt。

## Phase C：整段 1 fps 处理，先证明它真是一间房

复用 v7 的 intake 校验、确定性抽帧、COLMAP、Nerfstudio 数据生成和报告代码，做成通用 v8 入口。不要从零写训练流水线。

- 从 Phase B 的显式 intake jobId 解析 source；拒绝路径逃逸、symlink 和按“最新目录”猜输入。
- 使用完整 `370.37s`，按 `1 fps` 确定性抽帧，预期约 `371` 帧，最大 `1600×900`；不可截成短片。
- 单相机 `SIMPLE_RADIAL`，新建隔离 database，先跑 COLMAP；GPU 在 SfM/覆盖 gate 前必须保持空闲。
- 输出 `12` 个等时间段安全缩略图 contact sheet。人工和机器报告都必须明确地面、中部、上墙/天花板是否可见。
- 从实际 camera centers 计算：注册率、12 段时间覆盖、PCA 平面第二/第一特征值比、二维凸包面积、轨迹长度/房间对角线、相机高度漂移和平均 camera-up。
- 把平均 camera-up 对齐为世界 `+Y`；自由行走高度用相机高度中位数。照片锚点仍保留原始姿态。

硬门见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。未过就停止，不得启动 GPU，也不得降低门槛或删帧掩盖。

## Phase D：只跑一次 7k 完整性 canary

只允许一次从头 `splatfacto` 7k；没有 15k/30k、没有 resume、没有自动降分辨率。继续复用已验证的 v6 regularized profile、COLMAP sparse points、camera optimizer off 和单 GPU job guard。

记录实际命令、step、wall time、峰值 VRAM、OOM、checkpoint SHA、训练/held-out 指标和 6 个覆盖方向的同位置渲染。指标不得只从相邻帧取样；held-out 至少跨 12 个时间段。

最终从 7k 导出一次 PLY → SH2 SOG；若 SH2 工具链真实失败才允许回退 SH1。大文件只留 WSL ext4。

生成 `viewer/tandt-meetingroom-v8.scene.json`，场景 `sceneRevisionId=tandt-meetingroom-r001`。Viewer 必须包含：

- 明确的“自由行走”和“照片机位”模式；
- 滚轮/触控板/按钮缩放、FOV 显示、正常/冲刺速度；
- 平视 start pose、median eye height、凸包边界、顶视轨迹图；
- 至少 3 个源照片锚点；
- 中央 walk pose 的前/后/左/右/上/下六方向验收按钮，确保上半墙和天花板不是空洞。

只绑定 `127.0.0.1`，端口 `8765–8775`。完成后保持 Viewer 与 intake 运行，供 Max 直接试。

## 回传

回传到：

```text
results/from-4060/unseen-3dgs-full-room-meetingroom-2026-09-03-v8/
  V8-REPORT.md
  V8-RESULT.json
  REPORT-FILES.json
  fixes/*.patch
  logs/（脱敏的 source/intake/SfM/coverage/train/SOG/Viewer 摘要）
  v7-viewer-before-after.jpg
  full-room-contact-sheet.jpg
  camera-footprint.png
  viewer-overview.png
  direction-front.jpg
  direction-back.jpg
  direction-left.jpg
  direction-right.jpg
  direction-up.jpg
  direction-down.jpg
  viewer-walkthrough-v8.mp4
```

`viewer-walkthrough-v8.mp4` 只能是 10–20 秒、≤15 MB 的 Viewer 屏幕录制，演示缩放、平视走动、冲刺、抬头看天花板；它不是源视频，也不能包含桌面通知、账号、路径或 token。

严禁回传官方原视频、转码副本、371 帧、完整 source thumbnails、COLMAP database、checkpoint、PLY、SOG、work、`.env`、token。报告第一屏写 Viewer URL、是否仍运行、Max 应先试哪四个动作；未实测字段一律 `null/PENDING`。

## 停止条件

- v7 Viewer E2E 任一核心交互失败；
- 官方视频许可未确认、下载校验不符或本地磁盘不足；
- intake 非 loopback 或会自动训练；
- SfM、时间覆盖、二维轨迹、上墙/天花板 gate 任一失败；
- 检测到另一 GPU job、7k OOM 或真实 SOG 无法加载；
- Viewer 仍像俯拍镜头推拉、不能明显缩放/行走，或上方向渲染为空。

失败时提交 `FAILED`/`BLOCKED` 和证据，不换素材、不追加训练。生产 API/数据库/租约/token、付费 API、端口映射仍全部禁止。
