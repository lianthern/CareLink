# v7 验收合同

当前状态：`PENDING_4060`

只有以下项目全部有 4060 本机证据时，Mac 才能把 v7 标成完成。

## 1. 上传与输入

- PowerShell 输入 bytes/SHA 与 `TASK.json` 一致、Windows parser errors = 0。
- v6 intake 为 `127.0.0.1`，HTTP 200，auto-train=false。
- frozen Pexels asset bytes `12,273,501`、SHA256 `b4dca2e…04ce6`。
- 真实完成一次 Windows → loopback intake → WSL ext4 上传，状态为 `UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW`。
- Windows 临时副本默认删除；GitHub 禁止文件计数为 0。

## 2. SfM gate

- 105 个唯一帧，首/中/末覆盖完整 17.884533s。
- 单个主模型 registered `>=100/105`，且必须包含 `frame_0001`、`frame_0053`、`frame_0105`。
- points `>=6,500`，observations `>=120,000`，mean track `>=10`，mean reprojection `<=1.5px`。
- 单相机低自由度、方形像素；focal length ratio 位于 `[0.5, 2.0]`，principal point 距画面中心每轴不超过 5%，`abs(k)<=0.5`。
- 相机中心连续、相邻零位移为 0、max step 不超过 median step 的 2.5 倍；去畸变首/中/末无强鱼眼和弯曲直线。

## 3. 训练与 best checkpoint

- 一次只跑一个 GPU job，训练血统只有一条。
- 7k 恰好一次从头训练；15k/30k 只能 resume，输入/输出 checkpoint SHA 和 step 连续性可审计。
- 30k 只有 7k 与 15k gates 都通过后才可执行。
- OOM = 0；所有时间、VRAM、checkpoint size/hash 来自实测。
- 7k 硬门槛：三 training photo anchors 每张 PSNR `>=20`、SSIM `>=0.78`、LPIPS `<=0.30`；held-out mean PSNR `>=18`、SSIM `>=0.65`、LPIPS `<=0.40`。
- later stage 依 README 的非回退 + 实质改善规则替代前一阶段；最终 best stage 是 7k、15k 或 30k 之一，不强制选最大步数。

## 4. SOG 与 Viewer

- best checkpoint 的 PLY/SOG 有真实 Gaussian count、SH degree、bytes、SHA256 和 roundtrip 验证。
- `sceneRevisionId=pexels-classroom-5735358-r001`；start/bounds/anchors 均由实际 cameras 生成。
- Windows Viewer 真实加载 SOG，状态 `SOG ready`，bind 仅 `127.0.0.1`。
- 三张照片按钮各自恢复 XYZ/quaternion/FOV：position error `<=1e-5`、quaternion error `<=1e-5`、FOV error `<=1e-6`。
- 中间机位可以有界移动并回到锚点；0 console errors。
- 四张安全截图能辨认课桌、椅子和墙面空间关系；移动时没有大片纸片化撕裂。若观感仍只是“模糊但能认”，状态最多为 `COMPLETED_WITH_LIMITATIONS`，不能写 production-ready。

## 5. 回传与安全

- `V7-REPORT.md`、`V7-RESULT.json`、`REPORT-FILES.json`、必要 patch/log 与四张安全截图完整且 hash 自洽。
- 不含视频、frames、checkpoint、PLY/SOG、COLMAP database、完整 work、私密素材、`.env` 或 token。
- production connections = 0、paid API calls = 0、firewall/portproxy changes = 0。
- 最终 Viewer 与 intake 是否仍运行、实际 URL、Max 的三个照片按钮写在报告第一屏。
