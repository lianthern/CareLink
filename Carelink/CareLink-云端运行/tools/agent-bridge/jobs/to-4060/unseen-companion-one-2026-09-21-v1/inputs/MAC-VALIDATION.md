# v0.1 验证记录

2026-09-20，当前 Mac、本地 Node.js、已安装的 Google Chrome。没有 C1 实机，也没有 Windows 实机。

## 已验证的软件行为

`npm test`：5 项通过。

- 40 个相机保持焦平面锚点固定，前后物体的视差方向相反。
- 网格 40 个独立区域不重叠，PNG 左上角为视图 0。
- 缺失/非法校准、非全屏或尺寸不匹配时不进入交织输出。
- RGB 子像素视图选择、负相位回绕符合已读取的算法。
- 与官方 `Salted__` 文件格式兼容的合成校准能在本机解析，错误文件会拒绝。

`npm run test:browser`：3 个场景通过。

- 单视角随滑轨变化；深度 0% 为不随观察位置改变的平面基线；导出 PNG 为 4320×4800，完整 40 个视角像素哈希各不相同，各格存在实际内容。Retina DPR=2 下验证了离屏渲染尺寸。
- 错误校准文件被拒绝并停用旧参数；错误尺寸全屏阻止输出；模拟 1440×2560、DPR=1 下交织 shader 实际编译运行，没有 WebGL shader 错误。这里使用的合成参数**不是设备校准，更不是硬件测试**。
- 自包含 GLB 导入成功，带外部引用的 GLB 拒绝；移动布局无横向溢出；测试记录未填写的字段保持“尚未确认”。

桌面和移动截图已人工查看，PNG 已生成：

- `artifacts/lab-desktop.png`
- `artifacts/lab-quilt.png`
- `artifacts/lab-mobile.png`（包含外部资源拒绝的测试状态）
- `artifacts/standard-quilt.png`（可带到 Windows 的静态测试内容）
- `artifacts/synthetic-interleave-NOT-HARDWARE-TEST.png`（仅着色器冒烟测试，不是实际设备效果）

## 到货后仍需验证

当前订单修订版、Windows 主机与接线、官方 CubeStage 样例、本机校准参数、操作系统/屏幕像素一一映射、正确视序、重影与清晰度、舒适视区。浏览器模拟原生尺寸不能替代这些实机结果。

尚未测试 3DGS、大型纹理场景或实时动画性能，也未把此实验接入 UNSEEN 生产应用。

## 可移交包

`dist/Companion-One-Lab-v0.1.zip` 包含源代码、许可证、启动器、最小 Three.js 运行依赖和标准 Quilt PNG。已解压到另一个目录，以独立端口启动本地服务，页面及全部浏览器运行依赖返回 HTTP 200，未重新安装依赖。此检查运行于 Mac；Windows 启动脚本与实际显卡仍未实机测试。Windows 需要预先安装 Node.js 22 或更新版本。
