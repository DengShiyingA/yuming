# 域名查询

查询域名能不能注册的本地工具。覆盖 IANA 根区全部 1400+ 后缀（.com、.cn、.io、.co.uk、.中国……），直接问注册局，不经过任何第三方查询服务。

- **准**：先查注册局的 RDAP，再查 WHOIS，最后才用 DNS 兜底；能识别白金保留、品牌保护屏蔽、释放期（Dropzone）等“看着空着、其实买不了”的情况
- **快**：自动识别背后是哪家注册局（GoDaddy 一家就管约 200 个后缀），按各家承受能力并行查询，不容易被限流
- **好挑**：每个域名打 S/A/B/C/D 等级，可按等级排序、筛选，甚至查询前就只查高等级的
- **能蹲**：关注想要的已注册域名，被释放时弹通知
- **零依赖**：只需 Node.js ≥ 20.11，不用 `npm install`

> An open-source, dependency-free domain availability checker covering every TLD in the IANA root zone. It queries registries directly (RDAP → WHOIS → DNS), detects reserved / premium / drop-catch states, grades names, and watches domains for release. UI is in Chinese.

## 快速开始

```bash
git clone https://github.com/DengShiyingA/yuming.git && cd yuming
npm start               # 打开 http://localhost:3000
```

| 命令 | 说明 |
|---|---|
| `PORT=8080 npm start` | 换端口 |
| `HOST=0.0.0.0 npm start` | 允许局域网访问。默认只允许本机，防止别人用你的 IP 查询、改你的关注列表 |
| `DEBUG=1 npm start` | 打印每次 RDAP 请求的状态码，排查限流用 |
| `npm test` | 离线回归测试（不联网，几秒钟） |

## 功能

### 查域名
- 输入完整域名（`abc.com`）只查这一个；只输入名字（`abc`）则按后缀组批量查：热门 / 国家地区 / 通用及新后缀 / 全部 / 自定义
- 自定义后缀面板支持搜索后缀或国家中文名（搜“日本”出 .jp），可手动添加 `.co.jp` 这类二级后缀
- 多个域名用空格、逗号或换行分隔；查询链接可分享（`?q=abc`）

### 短域名
输入字母池（如 `abcxyz`）、选长度（1–6），自动生成全部组合去查。查询前可以先筛：
- **只要好读的**：能拆成拼音，或有元音且没有一长串辅音
- **辅音元音交替**：bok、tavi 这种最顺口的结构（26 个字母取 3 位：17576 → 2730 个）
- **只查等级**：只查 S 级 / A 级及以上 / B 级及以上

页面会先显示要查多少次、预计多久，单次上限 20000 次。

### 等级
每个结果都有 0–100 分和 S/A/B/C/D 等级（S ≥ 85，A ≥ 72，B ≥ 58，C ≥ 45），只看名字和后缀：长度（权重最大）、字符组成、好不好读（拼音或英文）、叠字规律、易混淆字符（l/1、o/0）、后缀热度。规则在 [`public/grade.js`](public/grade.js)，点开结果能看到每项加减分。这是经验规则，不代表市场估价。

### 结果
- 状态筛选（可注册 / 已注册 / 其他）和等级筛选可叠加；可按等级排序
- 复制可注册的域名、导出 CSV（Excel 直接打开不乱码）
- 刷新或误关页面后自动恢复；中途停止或被限流没确认的，点“重试未确认”接着查；短时限流的会在冷却后自动补查
- 查询中显示“已查 x/y · 剩余约 z”

### 关注
点结果右侧的 ☆，把想要的已注册域名加入关注。服务端每 30 分钟重查一次，变成可注册或进入释放期时弹浏览器通知；面板里能看到到期时间（已过期多少天）和状态变化记录。只在服务开着时检查。

## 状态说明

| 状态 | 含义 |
|---|---|
| 可注册 | 注册局明确说没有这个域名 |
| 可能可注册 | 注册局没给答案（限流或没有公开接口），DNS 也查不到记录。下单前请确认 |
| 已注册 | 注册局有记录，或 DNS 里存在 |
| 保留/受限 | 注册局保留、白金域名、品牌保护屏蔽（如 DPML），普通人买不了 |
| 释放期·需申请 | 刚过期删除，只能通过注册商申请或竞拍 |
| 疑似保留/溢价 | 1–2 个字符的名字，接口区分不了保留和溢价，请到注册商确认 |
| 无法确定 | 各种方式都没拿到结果，稍后重试 |

## 工作原理

1. **RDAP**：注册局官方 JSON 接口，按 [IANA bootstrap](https://data.iana.org/rdap/dns.json) 自动找到每个后缀的服务器。404 = 不存在，200 = 已注册（带注册商、到期时间）。只接受 HTTP/2 的（如 TWNIC）会自动切换。
2. **WHOIS**（43 端口）：没有 RDAP 或 RDAP 被限流时使用，服务器地址从 whois.iana.org 自动获取。只有看到明确的注册记录才判“已注册”，看不懂的回复不猜。
3. **DNS**（DoH，Cloudflare / Google）：前两步都拿不到时兜底，结果会注明原因。

**限流处理**：很多后缀其实是同一家注册局（Identity Digital 约 450 个、GoDaddy 约 200 个、CentralNic 约 90 个），共用一个限流额度。程序通过 DNS 的 CNAME 识别出真实后端，按后端限速：前端每家最多同时 3 个请求，服务端按各家承受能力自适应调节节奏（被限流就放慢，成功就逐步提速）。长时间封禁会记下解封时间，期间直接用 DNS 判断，不再白白重试。

**缓存**：注册局给出的结果存在 `.cache/results.json`，重启也保留。已注册的 24 小时（30 天内到期的 1 小时），保留/溢价 24 小时，可注册和释放期 1 小时；靠 DNS 判断的不缓存。

## 接口

| 接口 | 说明 |
|---|---|
| `GET /api/check?domain=abc.com` | 查询一个域名。`&fresh` 跳过缓存，`&raw` 附带 WHOIS 原文 |
| `GET /api/tlds` | IANA 全部后缀 |
| `POST /api/backends` | 请求体 `["com","io"]`，返回每个后缀对应的注册局后端 |
| `POST /api/estimate` | 请求体 `{"com":100,"io":50}`，返回预计耗时和最慢的注册局 |
| `GET /api/watch` | 关注列表；`POST /api/watch?domain=` 添加，`DELETE` 移除 |
| `POST /api/watch/check` | 立即检查全部关注 |
| `GET /api/debug` | 各注册局后端当前的并发、排队和请求间隔 |

## 目录

```
server.js            HTTP 服务和接口
lib/check.js         查询核心：RDAP / WHOIS / DNS、限流、缓存、耗时预估
lib/watch.js         关注列表和定时检查
public/index.html    页面结构和样式
public/app.js        页面逻辑
public/grade.js      域名等级评分（浏览器和测试共用）
test/run.mjs         离线回归测试
test/fixtures/whois  各注册局的真实 WHOIS 回复样本和期望结果
.cache/              运行时数据（后缀列表、缓存、关注列表等），不进仓库
```

## 测试

`npm test` 用 [`test/fixtures/whois/`](test/fixtures/whois) 里的真实回复样本（未注册、已注册、白金保留、释放期、品牌屏蔽、日本 JPRS 格式、限流、停服……）检查 WHOIS 识别规则，并检查等级评分的关键例子，不联网。遇到新的回复格式时，把原文存成 `.txt`，在 `expected.json` 里写上应该判成什么，再改规则。样本里的个人联系方式已替换为占位内容。

## 已知限制

- **溢价和保留区分不了**：RDAP 对注册局保留的名字也返回 404，和真正空闲的一样。WHOIS 里写明的（如 .io 白金域名）能识别；其余以注册商下单页为准。
- **有的后缀只能靠 DNS**：.es、.gr、.vn、.ph 等没有公开查询接口；gTLD 的 WHOIS 也在陆续停服。
- **注册局会限流**：Identity Digital（.info、.vip、.pro、.club 等）对“查不到的域名”限得很严，超限会封 IP 约 24 小时。程序已经主动放慢，但一次查上千个它的后缀仍可能触发。
- 关注列表只在服务开着时检查。

## 合理使用

本工具直接访问各注册局的公开 RDAP / WHOIS 服务。这些服务大多在使用条款里限制大批量自动查询，程序已按各家节奏限速，请用于个人查询，不要拿来大规模扫描或转售数据。

## 许可证

[MIT](LICENSE)
