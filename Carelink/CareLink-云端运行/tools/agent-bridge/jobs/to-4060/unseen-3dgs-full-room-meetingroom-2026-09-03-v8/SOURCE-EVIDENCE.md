# v8 素材证据：Tanks and Temples Meetingroom

检查时间：`2026-09-03T03:55:00Z`

## 官方证据

- 官方下载页：<https://www.tanksandtemples.org/download/>
- 官方许可页：<https://www.tanksandtemples.org/license/>
- 官方下载器源码：<https://raw.githubusercontent.com/IntelVCL/TanksAndTemples/master/python_toolbox/download_t2_dataset.py>
- 下载器内 `Meetingroom.mp4` Google Drive ID：`0B-ePgl6HF260V3BFSFFTZFJwSWc`
- 官方 `video_set_md5.chk`：`Meetingroom.mp4 = 5beeb4e21ca5b8fda31235cf15972393`

官方页面明确说明每个 scene 提供用于 3D reconstruction 的高分辨率视频；training data 中包含 `Meeting room`。页面还说明抽样 image set 来自 `29.97 fps` 原视频，并给出 COLMAP reconstruction 作为参考。

许可页面同时出现 CC BY 4.0 表述与更严格的“仅非商业研究、不得向第三方提供数据”条款。v8 采取更严格边界：只在 Max 自有 4060 上进行一次非商业研究/个人实验，不把素材、帧、SOG 或模型发布、部署、外传或接生产。未来商业链路必须换成 Max 自摄或取得明确商业授权的素材。

## 实际远程媒体探测

对官方 Drive 文件做只读 `ffprobe`：

| 字段 | 值 |
|---|---:|
| bytes | `4,271,432,079` |
| duration | `370.370000s` |
| codec | H.264 |
| resolution | `3840×2160` |
| frame rate | `30000/1001` |
| nominal bit rate | `92,263,025 bps` |

在 `0s`、`60s`、`120s` 远程抽取的最小必要帧显示：同一大型会议/宴会房间的不同位置；画面同时包含地面、桌椅、门窗、立柱、四周上墙、屋顶横梁、灯具和天花板，地平/垂直线明显比 v7 平直。它通过“值得交给 4060 做完整 SfM”的人工预筛，但 Mac 没有下载 4.27 GB 全片，也没有预先伪造 COLMAP 成绩。

## 尚未验证

- 完整 371 帧实际注册率：`PENDING_4060`
- 全时段 camera trajectory PCA/凸包：`PENDING_4060`
- RTX 4060 7k 时间/显存：`PENDING_4060`
- SOG 上墙/天花板完整性：`PENDING_4060`
- Viewer FPS、缩放与漫游体验：`PENDING_4060`

这些值不得从官网、v7 或 Mac 抽帧推断。
