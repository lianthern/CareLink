# v7 P0：公开视频本机上传 → 教室 3DGS → 三照片回位

人类状态页：[GitHub Issue #8](https://github.com/maxi-max-dev/max-agent-bridge/issues/8)

本轮完成定义只有一个：在 Max 的 RTX 4060 Laptop 上，把一段已经通过 Mac COLMAP 预检的公开教室移动视频真正送进 v6 本机上传入口，生成一份比 v6 更清楚、可在本机 Viewer 行走的教室 `scene.sog`，再用三张源照片按钮验证能否准确回到拍摄机位。

这是一段普通透视相机的连续室内移动视频，不是等距柱状 360° 视频。它有真实视差，适合当前 perspective/COLMAP 流水线；不要把单张全景图或未经展开的 360° 视频冒充可走 3D 输入。360° 相机模型是后续独立适配任务。

## 4060 Agent 唯一入口

在 Windows PowerShell 执行：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-public-classroom-quality-2026-09-03-v7" `
  -State "RECEIVED_VERIFIED" `
  -Message "v7 public classroom upload-to-scene task received; production remains off and 30k is gated."
```

然后完整阅读本文件、[`MAC-PREFLIGHT.md`](MAC-PREFLIGHT.md) 和 [`ACCEPTANCE.md`](ACCEPTANCE.md)。工作目录仍是 WSL ext4：

```text
/home/max/src/unseen-3dgs-sceneworker
```

不得在 iCloud、Windows NTFS `/mnt/c` 或 Git checkout 内训练。不要重新下载 v1 Release，不要覆盖 v1–v6 的数据、模型、SOG 或 Viewer manifest。

## 冻结素材

- 页面：[Pexels — A Clean and Well-lit Classroom](https://www.pexels.com/video/a-clean-and-well-lit-classroom-5735358/)
- 许可：[Pexels License](https://www.pexels.com/license/)
- 冻结 HTTPS 文件：`https://videos.pexels.com/video-files/5735358/5735358-hd_1920_1080_30fps.mp4`
- bytes：`12,273,501`
- SHA256：`b4dca2e138b475d5168bde72e61fe54beab9820b90aca1b22a4fe3739ea04ce6`
- ffprobe：H.264，`1920×1080`，`30000/1001 fps`，`17.884533 s`

只接受这组 bytes + SHA256。下载结果不符就 `BLOCKED`，不能换另一个同名压缩版本。

## Phase A：走一次真实的本机上传路径

先确认 v6 intake 的 `http://127.0.0.1:8780/api/health` 返回 `READY`、bind 精确为 `127.0.0.1`、`trainingStartsAutomatically=false`。若服务已停，复用 v6 `Start-Local-VideoIntake.ps1` 启动；不得改防火墙或增加端口转发。

检查本任务冻结 PowerShell 输入的 bytes/SHA256 与 `TASK.json.inputs` 完全一致，然后执行：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-public-classroom-quality-2026-09-03-v7\inputs\scripts\windows\Submit-V7PublicClassroom.ps1" -ConfirmPublicCanary
```

此脚本明确得到确认后才会：从 Pexels HTTPS 下载冻结公开视频、校验 bytes/SHA256、通过 `127.0.0.1` PUT 到 v6 intake、再次校验 intake 回应，然后删除 Windows 临时副本。它不会启动训练，也不会开放端口。必须记录返回的 `local-*` intake jobId；之后只从该 job 的 WSL `intake.json` 解析 source 路径，不允许按“最新目录”猜。

通过后提交 `RUNNING` receipt，message 包含脱敏后的 intake jobId 和 `UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW`。不要在 GitHub 回传视频或原始文件名日志。

## Phase B：把 v3 修复泛化成可复用视频处理器

复用已经集成到 WSL 项目的 v3 SfM 修复代码，不从零重写训练流水线。实现一个通用的 v7 入口（文件名可按现有项目规范选择），必须接受显式 `--intake-job-id`、`--scene-revision-id`、`--max-frames`、`--max-width` 和 `--dry-run`，并满足：

1. 从 intake metadata 定位 `source.mp4`；验证 frozen SHA256/bytes/时长，拒绝目录逃逸和 symlink。
2. 单次确定性抽帧：全长 `17.884533s`，`105` 帧，最大宽 `1280`，JPEG qscale `2`。帧目录必须有不可变 contract，不能静默复用另一组帧。
3. 新建隔离 COLMAP database；单相机 `SIMPLE_RADIAL`、方形像素、exhaustive matching。不要回到 v1 的高自由度 `OPENCV` 内参。
4. 只选择覆盖完整时间序列的单一最大模型；然后复用 v3 已验证的 `ns-process-data images --skip-colmap --colmap-model-path ... --num-downscales 0` 路径生成 Nerfstudio 数据。
5. 处理、训练、导出和 Viewer 输出全部位于 `v7`/`pexels-classroom-5735358-r001` 独立路径。发现既有 training marker 就停止，不能覆盖后重跑。

Mac 已以 COLMAP 4.1.1 CPU 做过预检：最大模型注册 `105/105`、`8,026` points、`165,125` observations、mean track `20.573760`、mean reprojection `1.026420px`，单相机 `SIMPLE_RADIAL 1280×720 f=1072.494661 cx=640 cy=360 k=-0.0358097`。4060 的结果不必逐位相同，但必须通过 [`ACCEPTANCE.md`](ACCEPTANCE.md) 的 SfM gate。若失败，只允许核对实际 COLMAP 3.7 CLI 后修正兼容参数；不允许换视频、放宽 gate 或启动 GPU。

先补齐单测：路径/metadata 拒绝、确定性抽帧 contract、COLMAP summary 解析、全时间覆盖 gate、已有输出拒绝、dry-run 不产生训练 marker。静态检查和测试通过后才继续。

## Phase C：一条 checkpoint 血统的 7k → 15k → 条件式 30k

继续使用 v6 已冻结的标准 Nerfstudio `splatfacto` profile；不要换 `splatfacto-big`，不要开随机初始化，不要并行训练。输入是通过 Phase B 的 COLMAP sparse points + cameras。

最多三次训练进程，但只能是一条 checkpoint 血统：

1. `7k preview`：唯一一次从头训练，终点 step 6999。
2. `15k refinement`：只有 7k 的 SfM、训练、三照片、held-out 和视觉 gate 全通过才允许；必须从 7k checkpoint 恢复，首个新 step 大于 6999。
3. `30k quality`：只有 15k 不回退且至少一项质量指标有实质改善才允许；必须从 15k checkpoint 恢复，首个新 step 大于 14999。

每阶段记录实际命令、输入 checkpoint SHA、输出 checkpoint SHA、起止 step、wall time、峰值 VRAM、OOM、训练/评估指标和同机位渲染。恢复参数必须以本机 `ns-train --help`/实际版本为准，不可猜 CLI。OOM 时停止并回传，不自动降分辨率或再开一条训练血统。

15k 或 30k 只有在以下条件下才能替代上一阶段：所有硬门槛仍通过，任何单锚点没有 PSNR 下降超过 `0.5dB`、SSIM 下降超过 `0.03` 或 LPIPS 上升超过 `0.03`，并且 mean PSNR `+0.25dB`、mean SSIM `+0.01`、mean LPIPS `-0.01` 至少满足一项。否则保留上一阶段为 best，停止追加。

最终只能从实际通过的 7k/15k/30k 中选择一个 best checkpoint。不要为了“跑满”而选择更差的 30k。

## Phase D：做成能看的场景并验证照片回位

只对 best checkpoint 执行一次最终 PLY → SOG。优先保留 SH2；如果当前 `splat-transform`/Viewer 不支持或显存/内存失败，才退到已验证 SH1，并在对比报告中说明画质损失。必须记录 raw PLY、SOG 的 Gaussians、SH degree、bytes、SHA256 和 roundtrip 指标；大文件只留在 WSL ext4。

生成 `viewer/pexels-classroom-v7.scene.json`：

- `sceneRevisionId = pexels-classroom-5735358-r001`；
- start pose、导航边界和 `frame_0001`/`frame_0053`/`frame_0105` 三个照片锚点都从实际 training cameras + dataparser transform 程序化生成；
- 每个照片按钮显示对应源图的安全缩略图；点击后恢复完整 XYZ、quaternion 和 FOV；
- 自由行走模式可移动，但 photo-anchor 模式不得被全局 eye height 改写。

在 Windows 本机浏览器打开：

```text
http://127.0.0.1:8765/?scene=./pexels-classroom-v7.scene.json
```

若端口变化，只能在 `8765`–`8775` 内绑定 `127.0.0.1`。依次点三张照片，保存每个 source thumbnail 与 Viewer render 的并排对照；再从中间机位做一次有界 WASD 移动并回到照片。要求 `SOG ready`、没有控制台错误、三次回位误差通过 gate、课桌/椅子/墙面关系连续且移动时没有大片纸片化撕裂。FPS 只能写 sample，不宣传为 benchmark。

完成后保持最终 Viewer 和 v6 intake 运行，供 Max 在 4060 Windows 上直接体验。

## 回传

回传到：

```text
results/from-4060/unseen-3dgs-public-classroom-quality-2026-09-03-v7/
  V7-REPORT.md
  V7-RESULT.json
  REPORT-FILES.json
  fixes/*.patch
  logs/（脱敏后的上传、SfM、测试、训练血统、评估、SOG、Viewer E2E 摘要）
  viewer-overview.png
  anchor-0001-compare.jpg
  anchor-0053-compare.jpg
  anchor-0105-compare.jpg
```

报告第一屏必须写：实际 Viewer URL、best stage、总墙钟时间、是否仍在运行、Max 现在该点哪三个按钮。所有未实测字段为 `null`/`PENDING`，不能填 0 冒充。

严禁回传视频、105 原始帧、完整 source thumbnail、checkpoint、PLY、SOG、COLMAP database、完整 work、`.env`、token 或任何私密素材。

## 停止条件

- frozen 素材 hash 不符；
- intake 不是 loopback 或 auto-train 不为 false；
- SfM gate 任一失败；
- 7k 硬门槛失败；
- OOM、磁盘不足或检测到另一个 GPU job；
- Viewer 无法加载真实 SOG或三照片不能精确回位。

以上情况如实提交 `BLOCKED`/`FAILED`，不要盲目追加训练或换素材。生产 API、数据库、租约、token、付费 API、端口映射仍全部禁止。
