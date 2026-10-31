# v13 验收合同

## A. 冻结基线

- [ ] v11 精确为 `PANORAMIC_POSEFIX_ACCEPTED_7K` / `360roam-base-posefix-r001`，v12 精确为 `PHOTO_RELOCALIZATION_PARTIAL_2_OF_3`。
- [ ] v11 的 450 train / 90 held-out、SOG、Viewer 与 dataparser transform 原样复用；未重下载、重训、续训或覆盖。
- [ ] 三张 query 与 v12 完全相同；query 2 未被替换，train/val split 未改。
- [ ] 五项通过门槛与 v12 完全相同；未降低门槛。
- [ ] v13 官方定位只运行一次；没有看结果后改 ratio、association radius、观察数或其他参数再挑最好成绩。

## B. 多视角 training-only 描述库

- [ ] 参考几何来自冻结 v12 training-only map；不使用作者 PLY 或 v11 SOG 几何。
- [ ] 描述仅从 horizontal training images 建立，`usesHeldOutImages=false`。
- [ ] reference/query 均为 RootSIFT；每 landmark 最多 6 个观察。
- [ ] ratio test runner-up 属于不同 landmark；报告含 training images、descriptor entries、multi-view landmarks 与 mean/max descriptors。
- [ ] query 真值 pose 在估计完成前未参与建图、关联、描述、匹配、PnP、初值或参数选择。

## C. 三张照片定位

- [ ] 每图 PnP inliers `>=20`、inlier ratio `>=10%`、median reprojection `<=3.5px`。
- [ ] 每图 position error `<=0.15 × scene extent`、rotation error `<=15°`。
- [ ] 3/3 才能进入 Viewer；2/3 必须记 `PARTIAL`，1/3 或 0/3 必须记 `FAILED`。
- [ ] 报告逐项对照 v12 的 query keypoints/matches/inliers，但没有把“matches 增加”替代最终 pose 门槛。

## D. Viewer 真回位

- [ ] 新建 v13 manifest，不覆盖 v11；三个按钮读取 v13 `estimatedC2wOpenGL`，不读取 held-out 真值。
- [ ] estimated dataset pose 经过 v11 实际 dataparser transform/scale，没有 identity 或手写 eye-height 覆盖。
- [ ] 三个按钮从 free-walk 后返回三个不同估计机位；`SOG ready`、walk/zoom 正常、console/page error 为 0。
- [ ] 三张并排图真实展示 query 和 localized render 并标注误差/inliers；没有用真值 render 冒充定位结果。
- [ ] Viewer 只监听 loopback，无防火墙、端口转发、LAN 或公网变更。

## E. 结果与安全

- [ ] 只有 Phase A 3/3 + Phase B 全通过才写 `PHOTO_RELOCALIZATION_MULTIVIEW_ACCEPTED_3_OF_3`。
- [ ] 未实测字段保持 `null/PENDING`；Mac synthetic test 不写成 4060 结果。
- [ ] 回传严格符合 allowlist；没有原图、单独 query、源 panorama、views、pose source、feature map、descriptor、checkpoint、PLY、SOG、work、token、`.env`。
- [ ] GPU/7k/30k、生产、付费 API、素材下载、SOG/checkpoint 写入均为 0。
