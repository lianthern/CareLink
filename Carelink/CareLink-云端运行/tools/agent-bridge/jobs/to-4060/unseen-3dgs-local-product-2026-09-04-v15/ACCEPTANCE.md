# v15 验收合同

本文件随不可变 payload 一起冻结，因此这里的候选状态描述的是**构建时刻**，不是 GitHub Release 已存在的证明。`TASK.json.publishedAt` 同样是任务合同与资产字节的冻结时间；真正可下发必须由接收器现场证明 private Release、tag target、asset SHA256 和完整 manifest 全部一致。

## Mac 发布门（当前）

- [x] 87 个产品/状态机/恢复/Viewer/照片回位/Windows 合同测试与 15 个 Release 构建/校验测试通过，共 102 个。
- [x] 全部 Python 源码 compile、219 个 JSON、GitHub Actions YAML、Viewer JavaScript、Linux Bash `bash -n` 与 `shellcheck` 通过。
- [x] 原 PoC 的 `./scripts/run.sh preview --dry-run` 与 `quality --dry-run` 都完整展开；仅 Mac 不具备的 Linux/CUDA doctor 项明确失败，不冒充实跑。
- [x] 官方 360Roam HTTPS 分享的冻结 60 文件远端清单重新读取通过；没有下载或提交素材。
- [x] 本机 UI 在临时 loopback 实际启动并检查：上传、任务、Worker 状态、场景与照片回位入口可见，只监听 `127.0.0.1`。
- [x] loopback、CSRF、2:1 视频、扩展名/签名、WSL `/mnt` 拒绝有测试。
- [x] queued→leased→running→uploading→ready，lease expiry/requeue、幂等和单 worker lock 已实现。
- [x] scene runner 的 dry-run 命令图包含 FFmpeg v360、COLMAP exhaustive、Splatfacto 7k、PLY→SOG。
- [x] 产品同端口提供 ready Viewer；目录穿越拒绝；重复视频复用 sceneRevision；失败 scene 重试恢复 queued；最新照片成为 Viewer 默认回位锚点。
- [x] 生产 adapter 默认关闭；没有 token/生产地址/防火墙动作。
- [x] payload 预算固定为 4096 文件、32 MiB/文件、128 MiB 总量；构建、Windows 接收、Linux 安装三端逐字节校验同一 flat manifest，并扫描媒体/秘密/路径穿越。Windows 接收在同一独占 ZIP 句柄内完成哈希、预检和有界解压，拒绝 reparse/junction，且完整绑定 working/HEAD/tag 三方 TASK blob。
- [x] 接收器只在 receipt 成功后返回唯一 typed run；启动器绑定该次 `runRoot/payloadRoot/.bridge-receipt.json`，没有“扫描最新目录”或旧包 fallback。
- [x] v15 GitHub receipt 全远端账本按不可变 commit 校验，严格执行主链与 `RECEIVED_VERIFIED/RUNNING/UPLOADING → BLOCKED|FAILED → RUNNING` 恢复链；同状态只允许 exact idempotent，`COMPLETED` 为终态。
- [ ] Release commit 必须先通过 GitHub Windows runner 的 Windows PowerShell Desktop 5.1 parser、Windows contract tests 与 launcher 成功/失败运行时 harness 才可发布；4060 上的 Task Scheduler/WSL/CUDA 真执行仍为 `PENDING_WINDOWS/PENDING_4060`。

## 4060 集成 canary 门

- [ ] doctor 确认插电/独显/MUX/禁止睡眠（人工项）及 WSL 可见 RTX 4060、>=30 GiB ext4、工具链齐全。
- [ ] Windows 唯一入口启动 UI+worker；`ss`/日志证明只监听 `127.0.0.1`。
- [ ] 从 v11 已核验的公开 panorama bytes 生成 MP4；产品不接触 author poses，经过真实 HTTP 上传入口。
- [ ] 未知位姿 SfM 注册 >=270/450 views，覆盖至少 6 个方向；实际数字、模型数、最大 connected model 记录。
- [ ] 只跑一个 7k GPU preview；记录 wall time、peak VRAM、step、OOM、checkpoint/PLY/SOG size+SHA。
- [ ] SOG 在新 viewer 中 ready；能缩放、平视走动且六方向空间关系可辨，0 console/page error。
- [ ] 杀掉 worker/重启后 job 不丢；过期 lease 自动回收；重复 start 不产生新 jobId。
- [ ] 27 个留出透视视图从未进入 SfM/训练，并完成至少 3 个 truth-free 回位 smoke；不能用作者 pose 当答案。
- [ ] 所有安全回传文件大小/SHA 可复算，无禁传媒体/秘密/绝对隐私路径。

GitHub 的 Windows PowerShell 5.1 parser 与 mock runtime harness 证明控制脚本在真实 PS5.1 下的语法、typed result 和 fail-closed 调度语义，但不等于 4060 的 WSL/CUDA 真机通过。发布者必须等该 Release commit 的 Linux 与 Windows CI 都为 green 后再创建 R3 Release；4060 真机数值仍只能来自 receipt/report。

v15 终态只能是 `LOCAL_PRODUCT_READY_FOR_NEW_INPUT` 或仍在迭代的 `RUNNING_*`。一次 SfM/训练/定位失败不是整个目标终点；继续按证据修复。即使 v15 全过，整体成品仍需一份从未参与开发的新真实 360 视频和三张真正不同的实拍照片。

## 尚未执行的真实数值

| 指标 | 当前值 |
|---|---:|
| Windows doctor | `PENDING_WINDOWS` |
| RTX 4060/CUDA | `PENDING_4060` |
| unknown-pose registered views | `null` |
| 7k wall seconds | `null` |
| peak VRAM MiB | `null` |
| OOM | `null` |
| checkpoint / PLY / SOG | `null` |
| Viewer FPS / errors | `null` |
| restart/offline recovery | `PENDING_4060` |
| three held-out localizations | `PENDING_4060` |
