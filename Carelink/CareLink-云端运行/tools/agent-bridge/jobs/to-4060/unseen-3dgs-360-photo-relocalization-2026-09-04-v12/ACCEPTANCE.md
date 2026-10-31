# v12 验收合同

## A. 父场景冻结

- [ ] v11 报告状态精确为 `PANORAMIC_POSEFIX_ACCEPTED_7K`，sceneRevision 精确为 `360roam-base-posefix-r001`。
- [ ] 复用 v11 的 450 train / 90 held-out、SOG、Viewer 和实际 dataparser transform；没有覆盖或修改 v11 资产。
- [ ] 没有重下源素材，没有训练/续训 7k 或 30k，GPU optimization runs 精确为 0。
- [ ] 作者 PLY、v10 checkpoint/PLY/SOG 均未使用。

## B. 无真值泄漏的照片定位

- [ ] 三张 query 按冻结规则确定，均在 val 且不在 train；没有根据结果换图。
- [ ] reference 3D feature map 只由 training images + training poses 自建，至少 2,000 点。
- [ ] `usesHeldOutImages=false`、`usesAuthorScenePly=false`、`usesV11SogGeometry=false`。
- [ ] 每张 query 的 ground-truth pose 在估计完成前未进入建图、检索、匹配、PnP 或初值。
- [ ] 三张均有 `>=20` PnP inliers、`>=10%` inlier ratio、median reprojection `<=3.5px`。
- [ ] 三张均满足 position error `<=0.15 × scene extent` 与 rotation error `<=15°`。
- [ ] 正式结果只跑一次；没有调低门槛或挑选最好一次。

## C. Viewer 真回位

- [ ] v12 scene manifest 与 v11 分离，三个按钮使用定位器输出的 estimated pose，不复制 held-out ground truth。
- [ ] estimated dataset pose 通过 v11 实际 dataparser transform/scale 转换，没有手写 identity/eye-height 覆盖。
- [ ] 三个 query 从 free-walk 后分别返回三个不同估计机位；`SOG ready`，zoom/walk 保留，console/page error 为 0。
- [ ] 三张并排图真实展示 query 与 localized Viewer render，并标注误差和 inliers；没有用 ground-truth render 冒充估计结果。
- [ ] Viewer 只监听 loopback，没有防火墙、端口转发、LAN 或公网变更。

## D. 结果与安全

- [ ] 3/3 才能写 `PHOTO_RELOCALIZATION_ACCEPTED_3_OF_3`；2/3 必须写 `PARTIAL`；其余写 `FAILED/BLOCKED`。
- [ ] 所有未实测字段为 `null/PENDING`，未把 synthetic test 写成 4060 真机结果。
- [ ] 回传仅含合同 allowlist；无原图、单独 query、源 panorama、views、pose source、feature map、descriptor、checkpoint、PLY、SOG、work、token、`.env`。
- [ ] 生产、付费 API 与 GPU 训练调用均为 0。
