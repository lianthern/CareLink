# v15：UNSEEN 本机空间工厂（产品化整合）

这次把已有 PoC 收进一个普通人可用的入口，而不是再交一组散命令：浏览器上传 2:1 室内移动 360 视频，持久队列自动完成抽帧、全景投影、未知位姿 COLMAP、7k Splatfacto、PLY/SOG 和本机 Viewer；场景 ready 后，同一页面直接出现“打开可漫游场景”，也可以上传新照片并用 training-only COLMAP map 做 truth-free 回位。

## 三层状态，不混淆

1. **现在可运行的隔离产品 canary**：loopback UI、SQLite 队列、单 GPU worker、53 个 ERP 时间帧、450 个训练透视视图、27 个留出视图、未知位姿 SfM、7k preview、SOG/Viewer、普通照片上传与 COLMAP registration。
2. **已经实现但默认关闭的常驻 scaffold**：systemd unit 和 Windows 登录任务模板；登录任务即使显式安装也保持 disabled。preview 成功且 Max 同意后才启用。
3. **仍未接通的生产 adapter**：`production_adapter.py` 只有 fail-closed contract。真实生产 private-AI route 目前没有 SceneWorker 所需的多小时可续租 lease、sceneRevisionId 绑定与 artifact upload；本任务不猜接口、不连接、不部署。

## 已复用的真实工作

- v6 的流式 loopback 上传、CSRF、媒体签名/ffprobe、WSL ext4 边界；
- 原 SceneWorker 的 `queued → leased → running → uploading → ready/failed`、TTL/heartbeat/idempotency/single-flight/retry；
- v11 的 FFmpeg `v360` 九个 100° 重叠透视方向和已接受 Viewer；
- 原 PoC 的 Nerfstudio Splatfacto 7k、gaussian export、PlayCanvas `splat-transform` SOG；
- v14 的 training-only / query-truth-free 回位原则。产品 photo runner 使用场景自己的 COLMAP map，不读取 held-out truth。

## 恢复规则

- SQLite/WAL 是本机真源；机器离线时 queued job 保留。
- 180 秒 lease，每 5 秒 heartbeat。进程消失后 expired lease 自动回到 queued；最多 3 次 attempt。
- 每个场景按 `extract/project/process/train/export` 写完成标记；重启后复用完成阶段和现有 2k/4k/6k checkpoint 文件。当前 Nerfstudio 版本的“训练中断后从 checkpoint 续到相同步数”必须由 4060 实测确认，未确认不得写 PASS。
- OS `flock` 保证即使误开两个 worker，也只能有一个 GPU worker。
- 相同 scene/photo 内容使用相同 idempotency key；重复点击不会创建第二份 GPU job。显式重试复用同一 jobId。
- 同一视频重复上传复用同一 sceneRevisionId；失败场景可在页面重试，完成阶段不重复跑。
- server 或 worker 单独退出时，启动脚本只补起缺失进程并做真实 HTTP health check，不会因为另一进程还活着就误报整体已启动。
- OOM：记录并 failed，不暗改分辨率/模型后伪装同一血统。之后只能以明确的新 revision/profile 处理。
- 升级安装：覆盖 app/runner/venv 之前先停止经 PID 与命令行确认属于本产品的 server/worker；SQLite、媒体、checkpoint 不删。安装后启动新进程并重新做 API/worker/Windows-host loopback 健康检查，禁止新旧版本混跑。

## Viewer 与照片回位

Viewer 由产品服务器在同一个 `127.0.0.1:8780` 下提供，不需要 Max 再开终端或手抄 `http.server` 命令。静态文件请求限定在该场景自己的 Viewer 根目录。每次新照片定位成功后，它会成为 Viewer 的第一个/默认照片锚点，因此“Return to source frame”返回刚上传照片的估计位姿，而不是初始相机；旧锚点仍保留在本地 manifest 中。

## 隐私与网络

训练媒体、照片、frame、SOG/PLY/checkpoint 全部只在 `/home/max/unseen-local-product`。Web 只绑定 `127.0.0.1`；不开放 LAN/公网端口，不写 token，不调用付费 API或生产 API。清理必须明确指定 `scene-id` 并传 `--confirm-delete`；清理不可恢复。

Private Release 的外层 ZIP 大小/SHA 只是第一层。`TASK.json` 还绑定 flat ZIP 内 `MANIFEST.json` 的 SHA 与文件数；Windows 接收器、Windows 安装入口和 WSL 安装器逐项复算全部发布文件，并拒绝漏项、多余文件、symlink/reparse point 或路径穿越。运行报告继续绑定 Release tag target commit、asset、payload manifest 与安装后 runtime fingerprint。

自动 canary 只生成待人工视觉验收的两份脱敏报告。4060 Agent 必须使用 `Publish-V15-VisualAcceptance.ps1` 的结构化开关完成走动、缩放、水平、六方向、三锚点与零错误门；脚本复核全部自动证据并只允许提交 `V15-RESULT.json`、`V15-REPORT.md`，不能靠手改一句 PASS 发布。

systemd 文件仅为 `systemctl --user` 模板，Windows Task Scheduler 模板也在注册时保持 disabled。两者都不自动安装或启用；只可在真实 preview 成功且 Max 同意后启用，禁止复制 systemd unit 到 `/etc` 或用 root 常驻。

## 本版本不是最终宣称

Mac 端只验证了静态代码、HTTP/队列 mock、恢复/幂等和命令图。CUDA、真实未知位姿 SfM、7k、Viewer 和新照片回位目前均为 `PENDING_4060`。只有 v15 集成 canary 通过，才进入一份全新真实上传视频 + 至少三张真正不同照片的最终门；后者通过以前，整体目标不结束。
