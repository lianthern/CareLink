# v10 验收合同

## A. 真实 360 来源门（GPU 前）

- [ ] 只从 360Roam 作者 share 下载 `base`；不得换不明镜像或上传别处中转。
- [ ] `pose_c2w.json` 为 `66,048` bytes / SHA256 `8e46d6ffc867b8544e2066634a6ee3f7f2f0a1e04d5a7a486fc67c98a8d330a2`。
- [ ] 60 张选中全景合计 `674,276,821` bytes，逐项匹配 `inputs/source-manifest.json` 的 path/bytes/SHA256。
- [ ] 60 张全为 `6080×3040` 2:1 JPEG；没有 HTML、缩略图、单点图片或普通透视视频冒充。
- [ ] 50 train + 10 val 端点覆盖；位姿源总数 148 + 50 = 198，4×4 矩阵均有限且为 proper rotation。
- [ ] 不下载、不读取、不复制、不上传作者 `scene.ply`；`usesAuthorScenePly=false`。
- [ ] 所有数据与 work 位于 `/home/max/src/...` WSL ext4；没有 `/mnt/c`、iCloud 或 GitHub 训练数据。

## B. 360→pinhole 适配门（GPU 前）

- [ ] 精确生成 600 张 `1024×1024` JPEG；每源图 8 horizontal overlap + up + down，FOV 100°。
- [ ] `transforms.json` 精确为 500 train + 100 val，split 不相交且 Nerfstudio 实际读取一致。
- [ ] 每源图十个虚拟相机共享完全相同 translation，旋转正交且 determinant≈1。
- [ ] 12 段 contact sheet 至少 10/12 见地面、10/12 见上墙/灯/梁/天花板。
- [ ] `up`/`down` 朝向正确；camera footprint 具有非零移动范围，不是原地旋转。
- [ ] 不安装、不上传、不改 firewall、不开放 LAN/公网端口、不调用生产/付费 API。

## C. 一次 7k preview

- [ ] A/B 全过且没有其他 GPU job 后才提交 `RUNNING`。
- [ ] 恰好一次 from-scratch 7k，step `0–6999`；Splatfacto、scale regularization、camera optimizer off。
- [ ] 明确 `random-init=True`、`load-3D-points=False`；没有 PLY/sparse points 偷渡。
- [ ] 记录真实命令、版本、wall time、peak VRAM、exit、OOM、checkpoint bytes/SHA。
- [ ] held-out 为冻结的 100 个虚拟视图；记录 mean/min PSNR、SSIM、LPIPS，未测字段为 null。
- [ ] 导出 PLY→SOG→PLY，Gaussian 数一致；大文件只留 WSL ext4。

## D. 7k 用户空间门

- [ ] Viewer 只监听 `127.0.0.1`；start 平视、roll≤0.5°、移动不改变眼高。
- [ ] zoom、normal walk、3× sprint、drag look 都有效，UI 显示 FOV/速度/mode。
- [ ] 同一中心 front/back/left/right/up/down 都有可辨认室内内容，up 有顶梁/灯，down 有地面。
- [ ] 沿 footprint 两个方向明显行走，遮挡关系随位置变化；不是整张照片放大/平移。
- [ ] 能走后返回，不能穿出有相机支撑的安全边界；局部浮点/接缝如实记录。
- [ ] 10–20 秒、≤15MB 录屏真实展示 zoom → walk → sprint → look up/down。

## E. 30k quality 门

- [ ] 只有 C/D 全过、7k 无 OOM、SOG roundtrip 通过后才允许。
- [ ] 从 7k 同一 lineage continuation 到 30k；不得第二次 from scratch。
- [ ] 单独记录 30k 增量时间/VRAM/指标/产物 hash，并和 7k 同机位截图对比。
- [ ] 若 7k 用户门失败则 30k 禁止；不能用更长训练掩盖适配/位姿问题。

## F. 回传与诚实状态

- [ ] 回传 V10 report/result、文件清单、patch、脱敏日志、小图和 ≤15MB 录屏。
- [ ] 不回传源全景、位姿、600 训练图、checkpoint、PLY、SOG、work、token、`.env` 或私密内容。
- [ ] 报告明确写“移动 360 JPEG 序列 + 作者位姿”，不写成“原始 MP4/X6 入口已打通”。
- [ ] 照片回位不在 v10 范围。

最终状态只能是 `PANORAMIC_CANARY_ACCEPTED_7K`、`PANORAMIC_CANARY_ACCEPTED_30K`、`TECHNICAL_PASS_USER_GATE_FAIL`、`FAILED` 或 `BLOCKED`。
