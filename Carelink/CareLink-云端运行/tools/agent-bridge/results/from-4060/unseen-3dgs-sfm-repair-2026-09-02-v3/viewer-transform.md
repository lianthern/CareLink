# v3 Viewer 坐标变换与验证

Viewer 的 start pose 和三个 photo anchors 均来自实际 training cameras；没有使用旧版手写位置、identity quaternion 或全局 eyeHeight 覆盖。

## 变换链

`ns-process-data` 生成的 `transforms.json` 已把 COLMAP original 坐标乘过 `applied_transform`，而 `dataparser_transforms.json` 的 `transform` 是从 original 坐标到 Nerfstudio 归一化坐标的组合矩阵。因此不能直接把两者相乘，否则会重复应用 `applied_transform`。

实际公式：

```text
saved_transform = dataparser_transform × inverse(applied_transform)
c2w_ns = saved_transform × c2w_saved
c2w_ns.translation *= dataparser_scale
c2w_playcanvas = Rx(-90°) × c2w_ns
```

SOG asset 同样设置 `rotationEuler=[-90,0,0]`，把 Nerfstudio `+Z up` 映射到 PlayCanvas `+Y up`。FOV 复现 Nerfstudio 的 OpenCV `getOptimalNewCameraMatrix(alpha=0)` 与 ROI crop，最终训练相机 vertical FOV 为 `31.624637°`。

## 三个真实锚点

| Anchor | PlayCanvas position | Quaternion xyzw | 与训练相机最大误差 |
|---|---|---|---|
| frame_00001 | `[-0.763564705,-0.010611543,-0.491222084]` | `[-0.002106638,-0.213727616,0.002004298,0.976888966]` | position `2.94e-8`, rotation matrix `4.38e-8`, FOV `9.06e-8°` |
| frame_00036 | `[-0.023307132,-0.042443054,0.240196427]` | `[0.005599306,0.182927355,-0.001802228,0.983108836]` | position `9.64e-9`, rotation matrix `8.40e-8`, FOV `9.06e-8°` |
| frame_00072 | `[0.999999996,0.114189049,-0.445690909]` | `[-0.014183183,0.566310653,-0.004234473,0.824058949]` | position `5.07e-8`, rotation matrix `4.75e-8`, FOV `9.06e-8°` |

start pose 使用 `frame_00001`，默认 photo anchor 使用 `frame_00036`。所有 72 个 training cameras 都在程序生成的 XZ 边界内。

## Viewer 实测

- 真实 SOG：`SOG ready`，截图中可辨认房间墙板、电视、门洞、桌椅；
- WASD：移动 0.1069 场景单位后仍在边界内；
- photo return：位置误差 `5.26e-9`、四元数误差 `7.76e-9`、FOV 误差 0；
- 模式：自由行走与 photo-anchor 显式区分，行走 Y 不会覆盖照片锚点 Y；
- 提示文案严格为“已回到这张照片的拍摄视角”。
