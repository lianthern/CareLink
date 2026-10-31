# v9 验收合同

## A. v8 Viewer 修复保持通过（无 GPU）

- [ ] 24 个 Python tests、v7 legacy E2E 和 v8 regression E2E 全通过。
- [ ] FOV button/wheel delta、30°–90° clamp、0 键恢复仍通过。
- [ ] free-walk pitch/roll≈0、median-height、normal displacement、sprint ratio `2.7–3.3×`、三 anchor 精确回位仍通过。
- [ ] Viewer/schema 对 v6/v7 manifest 向后兼容，Chromium page/console errors 为 0。

## B. 轻量来源与 known-pose 输入门（GPU 前）

- [ ] 下载只用冻结 Hugging Face revision URL；`169,378,633` bytes；SHA256 `2e1f86fd7b25314fbc0361b42f16bf77ee222ac50294777995e8ab737aee8d33`。
- [ ] 下载、解压、准备全部位于 WSL ext4；没有 `/mnt/c` 训练数据、安装、上传、firewall/port change。
- [ ] tar 只有 376 个允许 member；无绝对路径、`..`、symlink、hardlink、额外文件。
- [ ] `371` 张 JPEG 全为 `980×543`；`images.bin` 注册 `371/371`；单 `PINHOLE`；`points3D=124162`。
- [ ] `sparse_2/0` camera 为 `980×543`，参数是原 camera 的精确 1/2；image/points model 复制后可读。
- [ ] 12 bins 全覆盖；4060 重算 `lambda2/lambda1 >=0.15`、hull area >0、`trajectoryLength/hullDiameter >=2.0`。
- [ ] 12 格人工检查至少 `8/12` 见地面、`8/12` 见上墙或灯/屋梁/天花板；camera footprint 覆盖两个平面方向。

## C. 7k 与产物

- [ ] B 全过后才启动 GPU；整机同时最多一个 GPU job。
- [ ] 仅一次 from-scratch 7k，step `6999`；无 resume、15k、30k、第二次训练或自动降分辨率。
- [ ] load 3D points=true、camera optimizer=off、random init=false；记录真实命令/版本/wall time/VRAM/OOM/checkpoint SHA。
- [ ] held-out 跨至少 12 bins，记录 mean/min PSNR、SSIM、LPIPS；未测字段为 `null`。
- [ ] PLY→SOG Gaussian 数一致、roundtrip 通过；优先 SH2，SH1 fallback 有真实失败证据。
- [ ] scene/model/revision 只用 v9 新路径，不覆盖 v1–v8。

## D. 用户完整房间门

- [ ] start 为平视 free-walk，roll≤0.5°，移动不改变 Y；Viewer 只监听 `127.0.0.1`。
- [ ] zoom、normal walk、3× sprint、拖动和 look-up 可同时使用，UI 显示 FOV/速度/mode。
- [ ] center 的 front/back/left/right/up/down 六方向都有有效场景；up 能辨认灯、屋梁或天花板，不是空洞。
- [ ] 沿凸包内两个方向明显行走再返回，不出现整屏纸片撕裂；局部浮点如实写限制。
- [ ] 三个分散 photo anchors 精确回位，再切 free-walk 会恢复平视。
- [ ] 10–20 秒、≤15MB Viewer 录屏真实展示 zoom → normal → sprint → look up，无账号/通知/token/敏感路径。
- [ ] `V9-REPORT.md` 第一屏给出实际 Viewer URL、是否仍运行、Max 四步试用顺序和诚实限制。

最终只能是 `FULL_ROOM_CANARY_ACCEPTED`、`TECHNICAL_PASS_USER_GATE_FAIL`、`FAILED` 或 `BLOCKED`。不能再用高 PSNR、单张截图、微小位移或 source contact sheet 冒充可走完整房间。
