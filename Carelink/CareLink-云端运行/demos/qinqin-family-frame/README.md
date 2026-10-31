# UNSEEN Frame

一个打开就能玩的家庭相框交互演示。默认进入老人相框，示例照片、人物头像和留言已经准备好；切到“家属手机”可以选本机照片、写留言，或回到相框查看回复。

## 本地运行

```bash
python3 -m http.server 4173
```

打开 <http://localhost:4173/>。这是 plain HTML / CSS / JS，不需要 npm 依赖或构建步骤。

## 可以体验什么

- 老人相框：大照片、上一张 / 留言 / 下一张、设备朗读、语音找人和大号联系人按钮。
- 家属手机：选择本机照片、压缩后发送、关联当前照片写留言；相框回复会回到手机端。
- 提醒状态：黄色代表新照片，蓝色代表新留言，绿色代表模拟来电，优先级为来电 > 留言 > 照片。
- 演示工具：触发新照片、新留言、模拟来电、同屏查看两端或重置演示。
- 回复支持文字和本机录音；浏览器不支持麦克风时仍可直接写字。
- 两个同源标签页通过 `localStorage` / `BroadcastChannel` 同步本机演示数据，所有留言带 `photoId` 关联照片。
- “真实账号 / 空间”链接进入 <https://unseen.maxxam.xyz/app-v2#family-frame>，不会在此演示里新建鉴权或接入真实数据。

## 诚实边界

这是 UNSEEN Frame 的本机演示模式。示例照片、人物、提醒和通话都只是演示内容；通话弹层明确标注不会拨出真实电话，语音朗读明确使用当前设备。上传照片、文字、录音和已读状态只保存在当前浏览器，清除演示会移除 `unseen-frame-demo:v1`。

页面使用本地 `assets/` 素材，不依赖外链图片或付费服务，并支持键盘聚焦与 `prefers-reduced-motion`。

## 演示素材来源

以下图片来自 Unsplash，沿用原演示的公开素材，不包含用户私人照片：

- `family-living.jpg` — https://images.unsplash.com/photo-1511895426328-dc8714191300?w=1200&q=82&auto=format&fit=crop
- `child-garden.jpg` — https://images.unsplash.com/photo-1472162072942-cd5147eb3902?w=1200&q=82&auto=format&fit=crop
- `family-table.jpg` — https://images.unsplash.com/photo-1494386346843-e12284507169?w=1200&q=82&auto=format&fit=crop
- `flowers.jpg` — https://images.unsplash.com/photo-1490750967868-88aa4486c946?w=1200&q=82&auto=format&fit=crop
- `avatar-grandson.jpg` — https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=256&q=85&auto=format&fit=crop&crop=faces
- `avatar-daughter.jpg` — https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=256&q=85&auto=format&fit=crop&crop=faces
- `avatar-granddaughter.jpg` — https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=256&q=85&auto=format&fit=crop&crop=faces
