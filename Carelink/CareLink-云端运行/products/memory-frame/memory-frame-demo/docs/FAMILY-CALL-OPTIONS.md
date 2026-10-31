# 真实家庭通话：待决定的中继接入

## 当前决定：暂缓（2026-09-23）

用户已决定先放下实时语音通话，优先验收聊天与留言 Demo。以下免费/付费中继方案仅作历史研究，不再实施；无需提供账号或密钥。Cloudflare 草稿已隔离，未购买、启用或部署。


核验日期：2026-09-23。本文件是供用户审阅的接入与费用方案，未购买、创建或启用任何中继，也未修改旧 UNSEEN 资源。当前代码强制 relay；未配置可用 TURN 时语音通话保持关闭，聊天和用户另行确认的站内联系提醒可独立使用。

用户已回复“没有，先给我接入与费用方案”。这是编制方案的授权，不是采购、新建资源或启用通话的授权。

## 最新决定：优先免费托管中继

用户随后要求“可以用别的方式，免费的之类的能用就行”。因此优先适配 Cloudflare Realtime TURN，暂不采购下方的独立服务器方案。普通聊天、家庭权限、确认卡和信令继续使用原 CloudBase；只替换 TURN 凭据提供方式。

Cloudflare 官方产品页说明可以不绑信用卡开始使用，每月前 **1,000 GB** 出站流量免费，超出为 **0.05 美元/GB**。TURN 与 SFU 共用这份额度；本项目只使用 TURN，不引入 SFU 或额外收费的会议 SDK。免费额度不是无限流量，也不能把应用的通话次数限制称为供应商账单硬上限。未获得用户许可不绑定付款方式、不购买或自动启用付费。[官方产品与价格](https://www.cloudflare.com/products/turn-sfu/)、[当前计费口径](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)

接入需要用户 Cloudflare 账号的 TURN Key ID 与专用 API token。由现有服务端向官方固定接口换取短期 ICE 凭据；长期 token 不返回浏览器，继续保留双方接听、设备绑定、短时限及 relay 策略。作者已收到同一分支独立提交适配的安排，目前仍是待实施/审查状态，尚未配置真实凭据或调用。[凭据协议](https://developers.cloudflare.com/realtime/turn/generate-credentials/)

Cloudflare TURN 不运行在其中国网络，国内设备会连接境外节点；因此先完成代码与真实服务接入，再用 Wi-Fi/蜂窝两台设备验证是否实际可用，不从文档推断国内通话质量。[官方地区说明](https://developers.cloudflare.com/realtime/turn/faq/)

其他免费路径已核查：

- Metered Open Relay 提供每月 20 GB 免费 TURN，需要免费账号取凭据；其凭据管理 API 中存在免费计划不可用的接口，不能假设所有短期凭据管理能力均免费。可作为后续备选，不改用新的第三方信令体系。[免费额度](https://www.metered.ca/tools/openrelay/)、[管理 API 限制](https://www.metered.ca/docs/turn-rest-api/get-credentials-v2/)
- 仅用免费 STUN 建立浏览器直连，可以省中继流量，但双方网络无法直连时仍需要 TURN；不能把这种方式写成手机跨网保证可用。当前不为省费用放宽已审查的 relay 候选限制。[WebRTC 连接说明](https://webrtc.org/getting-started/peer-connections)

## 可复用已有服务时

优先使用用户已有且允许本项目接入的 coturn：需要可达的 TURN/TURNS 地址、对应域名的 TLS 证书、TURN REST 共享密钥，以及管理员确认的带宽和分配额度。共享密钥通过部署机器的私有配置注入，不在聊天、Git 或前端公开。现有 CloudBase 仍负责家庭权限与信令，不扩大函数执行角色。

没有新增服务器购买费不等于没有流量或运维成本；应核对现有服务合同。浏览器必须能通过指定地址分配 relay 候选，再由明确同意的两台设备验证跨网双向可闻。仅收到 SDP、ICE 或点击接听均不算完成。[WebRTC TURN 说明](https://webrtc.org/getting-started/turn-server)、[coturn 官方配置说明](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)

## 收费自建备选（当前不执行）

在用户决定允许新增独立中继资源后，可评估一台中国内地 Linux 轻量应用服务器运行 coturn；不需要新建 CloudBase 环境，也不修改旧 UNSEEN 服务。以下为核验时官方公开目录价格，未检查当前账号优惠、地域库存或实际购买页，不构成订单：

| 候选规格 | 目录价格 | 网络与额外费用边界 |
| --- | --- | --- |
| 入门型 2 核 / 2 GB / 40 GB | 35 元/月 | 2 Mbps、100 GB/月；中国内地超出包内出流量按 0.8 元/GB 计费 |
| 锐驰型 2 核 / 1 GB / 40 GB | 40 元/月 | 目录标注 200 Mbps 峰值、不限流量；峰值不等于稳定承诺带宽 |

价格来源：[腾讯云轻量应用服务器价格总览](https://cloud.tencent.com/document/product/1207/73452)；流量计算与套餐限制：[实例套餐](https://cloud.tencent.com/document/product/1207/44755)。服务器以外的域名、证书方案、备份和运维是否产生费用，应在具体资源选定后逐项确认。未申请试用或开启后付费，也不会因聊天自动选择上述套餐。

作为试验起点可比较这两个低配档位，但当前代码没有完成真实中继容量测试，不能据此承诺并发容量。若用户已有服务器，先核对其余量，避免重复购买。

## 启用前需落实的具体差额

1. 确认使用已有中继还是允许新增服务器，并确定地域、月预算与网络费用上限。
2. 确定独立中继主机和域名/证书，不修改旧 UNSEEN DNS。按 coturn 的监听与 relay 端口范围配置该主机防火墙；这属于中继资源权限，不是扩大相框 CloudBase 角色。
3. 配置 TURN REST 临时凭据、分配/带宽限额和禁止向内网等不应访问的地址转发；具体规则须与选定网络及 coturn 版本复核。应用的家庭校验不能代替中继自身访问限制。
4. 私有设置 `MEMORY_CALL_ICE_SERVERS_JSON`、`MEMORY_CALL_TURN_SECRET`，验证真实中继后再设置 `MEMORY_CALL_ENABLED=1`。应用两端只得到短期凭据，共享密钥不下发。
5. 在授权的双方设备上验证 Wi-Fi/蜂窝、麦克风授权与拒绝、双向声音、关闭/后台/退出释放，以及断网后取消状态。现有浏览器桥不可用，当前仅有本地模块/HTTP/VM 证据。

已签发的 TURN 凭据可有效至通话硬截止后 60 秒；应用退出不会令中继层凭据瞬间撤销。后台系统来电推送不包含在本次页面内 WebRTC 实现中。
