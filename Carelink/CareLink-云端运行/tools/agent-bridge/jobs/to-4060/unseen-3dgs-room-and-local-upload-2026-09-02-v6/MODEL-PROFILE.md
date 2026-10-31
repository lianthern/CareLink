# v6 冻结模型与输入合同

## 模型决定

本轮继续使用已经在 Max 的 RTX 4060 Laptop 上实测成功的 Nerfstudio `splatfacto` 标准配置（Nerfstudio 1.1.5 / gsplat 1.4.0），不切换 `splatfacto-big`、原始 Graphdeco 训练器或新的研究模型。

冻结参数：

```bash
ns-train splatfacto \
  --max-num-iterations 7000 \
  --steps-per-save 2000 \
  --steps-per-eval-image 100000 \
  --steps-per-eval-all-images 100000 \
  --vis tensorboard \
  --pipeline.model.use-scale-regularization True \
  --pipeline.model.random-init False \
  nerfstudio-data \
  --load-3D-points True \
  --orientation-method up \
  --center-method poses \
  --auto-scale-poses True
```

原因不是“理论上最好”，而是它已经在这台 8GB 4060 上完成了真实 7k、PLY 导出、SOG 转换和浏览器显示；本轮瓶颈是场景覆盖与用户输入，不是模型名。

## 较大预制场景

- 主 fixture：TUM RGB-D `freiburg1/room`
- 官方下载：`https://cvg.cit.tum.de/rgbd/dataset/freiburg1/rgbd_dataset_freiburg1_room.tgz`
- 官方页面标注：48.90 秒、15.989 米轨迹、约 0.83GB。
- 许可：TUM RGB-D 数据默认 CC BY 4.0；报告中保留数据集名称、作者/机构和官方链接。
- 采样：2.5Hz、最多 120 帧，覆盖完整序列；不得沿用 5Hz 后只截取前半段。
- 位姿：复用 v4 已验证的 TUM ground-truth known-pose adapter 和 fr1 标定；adapter 必须把采样频率与最大帧数变成真实 CLI 参数。
- 训练：只允许一次 7k preview。30k 仍禁止，直到 room Viewer 视觉门通过并由 Max 明确同意。

## Max 自己的视频

- 输入入口只绑定 `127.0.0.1`，直接落 WSL ext4；不经 GitHub/iCloud/生产。
- 上传只做容器签名、大小、时长、ffprobe、SHA256 与本地 job 元数据；不得自动抽帧或训练。
- 真视频第一轮仍使用 `splatfacto` 7k，但必须先完成独立 SfM gate：注册率、相机内参合理性、轨迹连通、三张锚点和稀疏点云视觉检查。
- 默认输入建议：60–120 秒，2fps 起步，最多 180 帧，图像宽度不超过 1600；先 `SIMPLE_RADIAL`/顺序匹配，失败时按已实现的 v3 候选合同排查，禁止无界反复训练。
