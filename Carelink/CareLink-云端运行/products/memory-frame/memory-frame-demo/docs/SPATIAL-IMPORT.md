# 影石空间模型导入与私有读取

**2026-09-24 X6补充待整合**：新提供的X6作品真实使用精确资源主机 `p1-app.insta360.com`，已补兼容并保留原全部网络/分段边界；初始视角从固定优先 up 改为第一组有效 center/up 中更接近水平者，X5原姿态不变。77项定向和两样例本地双端软件渲染通过，未部署/云导入。见 [X6验收](SPATIAL-X6-ACCEPTANCE.md)。下面“只有一个资源主机”和固定 up 优先均为历史规则。

**2026-09-24补充**：链接识别、错误阶段/代码、真实样例浏览器及云只读证据见 [最新修复验收](SPATIAL-LINK-ACCEPTANCE.md)。本轮没有扩域名；`state.messages[].spatial` 在失败时新增 `failureStage` / `errorCode`，旧字段保持兼容。下面日期和测试数量为历史记录。

2026-09-23，Windows 本地实现和验证；尚未部署本轮云端版本。

## API 与任务生命周期

`spatialImport {id: messageId}` 仅允许本家庭家人端调用，返回 `{spatial}`。它保持当前 HTTP 请求直到导入成功或失败；前端应独立等待这个请求并继续用 `state` 轮询阶段。它不依赖 HTTP 响应后继续运行的后台任务，也不需要把模型放进原照片/录音的 base64 上传通道。

`state.messages[].spatial` 只含 `id,status,stage,progress,error,sourceURL,sourceTitle,provider,bytes,digest,updatedAt`。阶段是离散的解析、下载、校验、存储检查点，百分比不是逐字节估算。普通 `state` 不下载模型。租约过期的 `queued/importing` 对客户端显示 `failed/expired`，点击重试可接管。

`spatialAsset {id: messageId}` 允许本家庭家人和相框主动取得 `{url,bytes,digest,chunkBytes:4194304,format:'sog',sourceURL,sourceTitle,provider,view?}`。`view` 是经过数值、尺寸和旋转矩阵验证的初始相机 `{position,forward,up,fov}`。辅助 JSON 不可用时回退到查看器自动取景；不保存整条相机轨迹。

家庭独立的 `sp_<room>` 文档原子保存任务、租约、配额预留、私有文件 ID 和校验值。CAS 同时完成配额预留与抢占；同家庭同场景跨消息复用，不同家庭互相独立。重复请求不增加下载。每个工作代次有随机 fencing token，更新必须同时满足代次和未过期租约；每个代次使用独立文件名，旧工作不能覆盖或删除新文件。

导入网络、流式私有上传和校验共享 105 秒 AbortSignal 预算；租约 135 秒，失败落库与清理留至请求起点后 130 秒。CloudBase 专用客户端使用 5 秒请求超时，并在 CAS 重试间检查 deadline。SDK 的数据库/凭据内部请求没有 AbortSignal，其超时也不等于绝对墙钟上限，因此极端 SDK 挂起仍可能由现有 150 秒云函数上限终止；此时持久租约到期后可恢复。本轮没有把本地速度推断为云端时限验收。

本地 `LocalStore` 支持单服务进程；同数据目录不能由多个独立本地进程并发写入。测试用共享 store 验证并发工作代次，用重新加载 store 验证进程重启。CloudStore 使用数据库 CAS 支持多实例抢占。两种运行方式都要求发起导入的请求保持活动，不把进程常驻或云函数响应后执行当作保障。

## 安全与存储边界

- 只接受 `https://app.insta360.com/3dspace/detail/GS3DC<32 hex>`，可有末尾斜线及分享参数。消息原始 `link` 保留兼容；导入来源另存去查询串的规范分享 URL。
- 供应商资源目前只允许精确主机 `insta360-app-hz.oss-cn-hangzhou.aliyuncs.com`。只读 `.sog` 和可选 `.json`，不提供任意代理。每次重定向重新校验协议、主机和路径；每次 TLS 连接都解析全部 DNS 结果、拒绝内网/保留/映射地址，并把检查过的 IP 固定到该连接的 lookup，禁止连接池复用与 DNS 重绑定。
- 分享页最多 2 MiB；单模型 64 MiB；辅助 JSON 1 MiB；最多 3 次重定向；DNS 8 秒；网络空闲 15 秒；辅助相机还受独立 10 秒预算约束。检查 Content-Length 和实际流量，拒绝内容编码压缩。原始供应商签名 URL 只在任务内存中使用，不写文档、数据库、日志或 API 错误。
- 仅支持本轮核验的 SOG v2：最多 2,000,000 splats、SH 0–3、6 或 8 个预期文件。按 ZIP central directory 读取尺寸，支持 stored/deflate 和 data descriptor；拒绝 ZIP64、多卷、尾部注释（与查看器兼容）、加密、符号链接、重名、路径穿越、额外文件、重叠/间隙记录、CRC 错误以及元数据中外部文件引用。
- 单条目最多 32 MiB，解压合计最多 128 MiB，压缩比最多 100；meta.json 最多 64 KiB。验证 lossless WebP 容器、版本、纹理尺寸一致性、splat/SH 容量和总 RGBA 纹理尺寸预算 128 MiB。服务器不执行 WebP 像素解码，因此容器和 CRC 通过不替代浏览器解码与真实视觉验收。
- 每家庭最多 10 个模型，私有存储总额 256 MiB。正在导入的任务按 64 MiB 预留，CAS 防止并发突破限制；待清理的未提交文件也占预留。失败释放已清理的预留，清理失败保留文件 ID 以便重试先清理。软删除只移出消息列表：完成的模型及其配额保留，未来同家庭重加该场景可复用。
- 下载先流式写到私有临时文件，校验后流式写入 LocalStore 私有 media 或 CloudBase 私有存储。上传前持久化待提交文件 ID；正常失败或过期工作主动清理自身文件。进程强制终止可留下 OS 临时下载文件，部署运维应保留临时目录回收策略；这类文件不会通过 HTTP 静态目录公开。
- CloudBase SDK 的现有 `uploadFile` 流式 PUT 未暴露可中断总预算，因此这里只用其已认证的上传元数据，使用可中断 HTTPS PUT 传输。SDK 返回的云存储 URL 必须 HTTPS，不跟随重定向；一般主机仍要求 DNS 为公网地址。下述精确绑定的本环境 COS 存储通道允许腾讯官方 VPC 路由。供应商签名 URL 与云存储签名 URL 都不返回前端。

模型读取使用同源 `/spatial-media/<HMAC capability>`，有效期 120 秒；签名绑定家庭、消息、会话与当前模型摘要。读取重新检查会话有效性/撤销状态、家庭、消息软删除和 ready 状态。超时后由查看器重新调用 `spatialAsset`。响应为 `private, no-store`，关闭连接会中止上游流。短期 URL 是访问凭据，不应另行公开分享。

可选相机优先取第一个有效的 `_cam1_up`，其次 `_cam1_center`，最后其它有效相机。采用原始 position、旋转第三列 forward、第二列反号 up；垂直 FOV 从 height/fy 计算并限制在 35–75 度。此规则来自本样例实际画面验证，不保存样例坐标常量。

## 已运行的验证

`node --test test/*.test.js`：43 项全部通过，无跳过。新增 23 项覆盖 URL/DNS/重定向与重绑定、下载限额、SOG 容器和元数据负测、家庭鉴权和隔离、并发去重、配额预留、失败重试、租约重启/过期/fencing、过期/撤销/篡改读取、删除时的工作中止与软删除复用、删除 CAS 与 ready 提交冲突、跨删除代次的清理保护，以及私有存储失败清理。原照片、原声、配对、收据、AI 并发保护 20 项继续通过。

云上传和读取的专项测试为 stub 合同测试：验证元数据到请求头的映射、非 2xx、HTTP 200 XML 错误、HTTPS 降级拒绝、请求中断和流量限制。未登录/写入真实 CloudBase，不能作为云部署验收证据。

真实用户授权样例通过默认网络模块完成端到端导入：本地端口 8792，约 2.3 秒得到 ready；文件 16,324,085 bytes，SHA-256 `93224a51c0385145c747f3d7033907678f20ac3f251f30f7c61a61f1ffb0a630`；SOG v2、1,000,000 splats、SH3，ZIP 展开 16,323,137 bytes，RGBA 纹理预算 27,932,160 bytes。相框会话取得私有模型并 HTTP 200 读回相同字节/摘要；可选首个向上相机参数成功保留。持久记录未含供应商签名字段或资源主机。

实际浏览器渲染、整合界面和最终发布边界由总控及查看器任务另行验收；本模块的合成小模型只用于结构与故障测试。

## 2026-09-23 云端 COS 路由修复

真实云端导入已经完成分享解析、模型下载与容器校验，在 storing 阶段被公网 DNS 检查拒绝。只在私有导入记录中保存的脱敏诊断确认：失败来自已认证 CloudBase 上传元数据返回的本环境 COS 主机，IPv4 答案属于 link-local；不是用户分享链接解析失败。

腾讯[创建请求概述](https://cloud.tencent.com/document/product/436/31315)明确同地域腾讯云服务可经内部 DNS 访问 COS，并给出 `169.254.0.47` 的 VPC 示例；[DNS 配置说明](https://intl.cloud.tencent.com/document/product/436/40778)说明同地域 COS 源站的 `169.254.0.x` 路由。本修复仅让专用 CloudBase 存储通道使用该路由：

- 必须来自已认证 SDK 上传/下载元数据；CloudStore 显式传入当前环境 ID，调用方不能通过 HTTP 参数覆盖。
- `cloud://<env>.<bucket>/memory-demo/spatial/<key>.sog` 必须匹配当前环境、对象前缀和受限文件名。HTTPS 主机必须精确匹配该桶的 `<bucket>.cos.<region>.myqcloud.com`，URL 对象路径也必须与文件 ID 一致；上传还必须与本次生成的 cloudPath 一致。
- 仅上述匹配通道额外接受 `169.254.0.1–254`，显式拒绝腾讯元数据地址 `169.254.0.23`。其他 link-local、私网、共享地址、loopback、映射 IPv6、保留地址仍拒绝；只要一个 DNS 答案不合规，整个解析失败。
- TLS 主机/证书校验保持开启，检查结果固定到单次连接的 lookup，禁止连接池复用、重定向、HTTP 降级；流式字节上限、DNS/空闲超时和 AbortSignal 保持有效。读取通过 SDK 已有 `urlType:'COS_URL'` 取得桶源站签名 URL。
- 用户分享页、影石模型和辅助相机仍使用完全不变的公网 DNS 与精确主机策略，不能利用这个存储例外。

安全诊断只含 operation、hostname、地址 family/类别计数，没有 IP、路径、query、文件 ID 或密钥；可写入私有 `storageDiagnostic` 便于未启用日志服务时定位，不进入公开 API，下一次导入尝试自动清空。

新增合同测试覆盖绑定桶的 VPC PUT/GET、固定 IP、TLS 未降级、错环境/桶/对象/主机拒绝、元数据地址与混合 DNS 答案拒绝、外链规则未放宽、诊断私有且重试清空。真实云端修复后的完整传输与摘要校验由总控另行记录。

## 0.4.1 私有模型分段传输

真实云端已经成功将 16,324,085 字节样例导入私有存储，但完整读取被云函数网关的 6 MB 响应限制拦截。腾讯[Web 函数限制说明](https://cloud.tencent.com/document/product/583/56124)规定 Response body 不得超过 6 MB。因此每次同源读取最多 4 MiB，为网关编码留下空间。

- `spatialAsset.chunkBytes` 固定为 `4194304`。模型大于此值时，客户端串行发送 `Range: bytes=start-end`，每块长度不超过 chunkBytes；在原签名有效期内可复用同一 URL。
- 成功分段响应为 `206`，带精确 `Content-Range: bytes start-end/total`、`Content-Length`、`Accept-Ranges: bytes` 和 `Cache-Control: private, no-store`。客户端必须校验这些边界，再拼接完整文件并校验 SHA-256。
- 只接受单一、闭区间范围。多段、后缀、开放范围、非安全整数、越界及超过 4 MiB 均返回 `416`，附 `Content-Range: bytes */total`。大模型不带 Range 返回 `413`；不超过 4 MiB 的模型仍可无 Range 返回 `200`。HEAD 使用相同范围规则且没有响应体。
- 每个请求先重新验证 HMAC、家庭、会话/账号撤销状态、消息可见性和当前摘要，再解析范围。过期或撤销仍返回 `404`；没有向浏览器提供 COS 直签 URL。
- 云端向 COS 发送对应 Range，只接受 `206`、精确 Content-Range、精确 Content-Length 和实际响应字节数。忽略 Range、错误总长度、压缩编码、重定向或多/少字节均失败。本地文件也使用显式 start/end，完整小文件亦绑定元数据上限。
- 关闭客户端请求会中止上游当前块，保留既有 DNS、TLS、超时和流式传输限制。健康接口版本为 `0.4.1`。

`spatial-range.test.js` 包含真实本地 HTTP 传输：超过 6 MB 的文件分块拼接及摘要一致、小文件兼容、错误范围、账号/相框逐块撤销、消息删除与签名过期、COS 206 合同负测和客户端取消。合成文件仅验证传输，不冒称 SOG 渲染或真实云端网关验收。
