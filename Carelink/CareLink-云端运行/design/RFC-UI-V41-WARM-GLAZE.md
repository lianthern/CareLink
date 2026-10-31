# RFC · UI v4.1「暖釉」token 偏离记录（2026-08-16）

## 授权链
1. 验收总控会话转述 Max 口头指示：以 spatial-memory 7-25 最早模板为基准「稍微简化一下」，全权授权。
2. 转述不作为冻结 token 偏离依据；主脑会话就此直接询问 Max 本人，**Max 于 2026-08-16 在会话内明确选择「上暖釉 v4.1」**（三选项含保持合同版与先看对比页，均被放弃），并知悉此选择即批准 token 偏离。
3. C4 冻结的 `contracts/source/product-ui/DESIGN-TOKENS.json` 本体**不改**；偏离只落在 `apps/web/src/styles.css` 的消费层。正式 re-freeze 由总控按 UI-SYSTEM-SPEC §11 流程补办。

## 基准来源
spatial-memory@f1a8eb6（2026-07-25）`DESIGN-UNSEEN.md` + portal/show 实页。该规格与冻结 tokens 同源（2026-07-24/25 六张参考图），差异为暖度与光层。

## 偏离清单（styles.css :root）
| token | 冻结值 | v4.1 值 | 依据 |
|---|---|---|---|
| --canvas | #FFF9F7 | #FFF6F1（页面底改三段暖洗 #FFF3F1→#FFF7EE→#FFEFE3） | DESIGN-UNSEEN §1 |
| --pink | #FF96B2 | #FF7FA8 | 同上 |
| --gold | #FFD678 | #FFC981 | 同上 |
| --ink | #321722 | #3E2430（深梅） | 同上 |
| --ink-muted | #725F66 | #5C3B48 | 同上（对比更高，安全方向） |
| --ink-subtle | #9A868D | #9A7C86 | 同上 |
| --border | #E9DDDA | #F2DCDA（仅装饰线） | §3「细边」 |
| --primary | 100deg #FF96B2→#FFD678 | 100deg #FF7FA8→#FFC981 | §3 |
| --halo | 旧粉金 rgba | 新粉金 rgba 同步 | §4 |

**不动**（无障碍证据表载荷项）：--burgundy #461528（focus/主 CTA 字与边）、--border-strong #A57E75、danger 组、全部 darkViewer 组。

## 主 CTA 折中（代替 7-25 规格的白字）
7-25 规格为渐变满填+白字；白字在金端 #FFC981 对比 ≈1.47:1，违反 WCAG 2.2。v4.1 取：**渐变满填 + burgundy 字 + 保留 1px burgundy 边**（合同 §2 结构不变，仅渐变端点色变）。复核：#461528 对 #FF7FA8 与 #FFC981 对比均 >6:1，focus outline #461528 对两端 >6:1，PASS 方向不变。

## 新增光层（增量，不改结构）
1. `.bokeh-layer`：8-10 个 blur 光斑（粉/金/白，opacity .12-.35）缓慢漂移；`prefers-reduced-motion` 静止；每页至多一处（沿用合同 §2 光晕纪律），v4.1 只上首页与 /open 落地页。
2. `.text-grad`：display 强调行渐变字（-webkit-background-clip:text），只用于首页 h1 第二行与 /open 落地标题，正文与功能文字禁用。
3. 照片署名条：相册卡与胶片条可选底部渐变署名条（上传者/方位），数据缺失不渲染——7-25 照片墙模板母题。
4. 胶片齿孔带：**简化掉**（Max 口径「稍微简化一下」；留待 v4.2 评估）。

## 验收红线（不变）
apps/web npm test 64 pass / 1 skip；每页至多一个主 CTA；200% zoom / 320px / reduced-motion；对比复核上表。
