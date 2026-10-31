# v7 素材与 COLMAP Mac 预检

预检时间：2026-09-03（Mac，COLMAP 4.1.1 CPU）

## 选择结论

选择 Pexels `5735358` 教室移动视频作为 v7 唯一训练输入。它不是依赖标题判断：完整文件已下载并校验，抽取 105 帧后跑过实际 SIFT + exhaustive matching + mapper。

| 项目 | 结果 |
|---|---:|
| 视频 | H.264 1920×1080，30000/1001 fps |
| 时长 | 17.884533 s |
| bytes | 12,273,501 |
| SHA256 | `b4dca2e138b475d5168bde72e61fe54beab9820b90aca1b22a4fe3739ea04ce6` |
| 抽帧 | 105，6 fps，最大宽 1280 |
| 注册 | **105/105** |
| Points | 8,026 |
| Observations | 165,125 |
| Mean track | 20.573760 |
| Mean reprojection | 1.026420 px |
| Camera | SIMPLE_RADIAL, 1280×720, f 1072.494661, cx 640, cy 360, k -0.0358097 |

按文件名顺序解析 COLMAP cameras，轨迹首/中/末全部不同，104 个相邻 step 没有零位移；归一化前 path length 为 `12.164918`、median adjacent step `0.116969`、max adjacent step `0.155997`。这些是任意 COLMAP 尺度，只用于证明轨迹连续且没有单纯原地横摇，不能冒充米。

顺序匹配只形成 2–3 帧小模型；exhaustive matching 才得到覆盖全时段的 105 帧主模型。因此 v7 冻结 exhaustive，不让 4060 重复试错。

## 被淘汰的候选

- Pexels `13008039` 学校走廊：22.4s、110 帧。顺序和 exhaustive 都只注册 `2/110`，不允许启动 GPU。
- Pexels `35190645` 砖拱走廊：画面有真实前进，但只有 9.7s 且为 2160×3840 竖屏，覆盖不足。
- Pexels `12820367` 现代办公室：大面积玻璃反射且主要为横摇，视差弱。
- 其他教室候选 `5734745`、`20421536`：约 9–10s，基本是固定机位横摇。

## 结论边界

Mac 预检证明“这段视频能够稳定恢复完整相机轨迹”，不证明 RTX 4060 的 7k/15k/30k 时间、VRAM、最终 PLY/SOG、Viewer 观感或照片回位；这些字段必须由 v7 真机结果填写。
