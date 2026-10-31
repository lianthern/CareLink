# 小信 CareLink 全套 VI / V1.0

先打开 **index.html** 浏览，或阅读 **CareLink-VI-Manual.pdf**（25 页）。

## 文件夹

- 01-brand：4 款已转曲字标、连接标识、曲线、纹样、16 个功能图标和 SVG sprite。
- 02-character：已选定稿参考、3D 透明主形象、2D 透明主形象、三视图、12 表情概念总表。
- 03-applications：到家套装、周边、数字体验 3 张应用效果图。
- 04-templates：3 款海报、A4 周记录卡、A5 联系卡、A4 信纸、服务联系卡，共 7 款可编辑 SVG。
- 05-design-tokens：JSON、CSS 设计参数。
- 06-guidelines：文字规范、目录、检查记录、生成提示词说明、资产清单。

## 使用提示

主形象用 PNG，字标和功能图标优先用 SVG。SVG 字标已转曲；其他 SVG 模板保留可编辑文字。
排版模板通过相对路径引用角色 PNG，请保留整个目录结构。index.html 为离线页面，无需联网或安装依赖。
浏览器通常可直接预览 SVG；如设计软件提示缺图，重新链接 02-character/04-master-2d-transparent.png 即可。
角色和应用效果图为生成式设计资产；转曲字标、辅助图形、图标与模板为矢量资产。
三视图为建模参考，包装为外观概念。未含 3D 模型、生产刀版、角色逐点矢量重绘、独立表情拆分或已开发终端。
本包是以用户选定形象建立的 CareLink 项目 VI 设计方案，不是信达官方已发布的企业品牌手册。
完整用法与交付边界见 06-guidelines/brand-guidelines.md。
