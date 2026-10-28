# 定投导航仪（bfzsdt）

「百分之四定投法」基金定投辅助工具 —— Cloudflare Workers 一体化部署版。
按固定跌幅信号加仓、按回本信号止盈离场，把「跌 4% 买一笔」的纪律变成可执行的每日待办。

在线体验（数据为演示账号，请勿填入真实持仓）：<https://dingtou-worker.bfzs.workers.dev>

---

## 一、这是什么

「百分之四定投法」的核心规则：

1. **触发**：净值较上一笔成交价下跌 4%（即跌到上一笔的 96%）时，买入下一笔；
2. **加码**：每下一笔的买入金额是上一笔的 1.8 倍，共 10 笔一轮；
3. **止盈**：持仓整体反弹 5% 即回本，反弹达到止盈目标（默认 20%）时清仓离场，等待下一轮。

本工具把上述规则落成三件事：

- **算清楚**：实时计算每只基金的理想阶梯表（触发价 / 买入金额 / 累计成本 / 剧本亏损锁线）；
- **提醒到**：净值刷新后自动判定六态信号（触发买入 / 可以离场 / 已投满……），列表置顶排序，可选邮件推送；
- **兜住底**：按真实持仓实算回本价，实际成交价偏离阶梯价时精算修正买入金额，避免「涨了 5% 却回不了本」。

> 本工具只做记录与计算，不代客理财、不提供投资建议。基金有风险，决策请独立作出。

## 二、功能特性

- **六态信号引擎**：未建仓 / 触发买入 / 本轮已止盈离场 / 建议止盈离场 / 10 笔已投满 / 净值异常，首页卡片按信号优先级排序
- **理想阶梯表**：以首笔成交价为起点，推算 10 笔的触发价、金额、累计成本与「剧本亏损锁线」（最大浮亏上限）
- **双加仓模式**：
  - `ideal`（默认）：按理想阶梯表内金额买入，适合成交价接近阶梯价的场景；
  - `actual`：按「5% 回本」约束精算买入金额（成交价偏离越深，加码越多），偏离时自动覆盖表内金额
- **回本测算卡**：输入实际成交价，实时反推「从该价买入多少，才能涨 5% 回本」，支持偏离场景的金额决策
- **真实持仓口径**：回本价 = 总成本 ÷ 总份额（非经验法则的「最新价 × 1.05」），支持部分减仓后的剩余持仓
- **多账户隔离**：一个密码下可建多个账户（如「主力 / 实验」），数据互不可见
- **每日净值刷新**：对接东方财富公开接口，支持手动单只 / 全部刷新，并内置定时任务每日 00:05（北京）自动刷新全部账户；净值日期按北京时间归属
- **数据自主**：JSON 导入 / 导出（含全量账户），数据永远属于你自己
- **信号邮件推送**：配置 Webhook 后，新加仓 / 止盈信号自动推送（异步、失败静默，不阻塞页面）
- **LLM 上下文导出**：`/api/llm-context` 一键导出当前持仓与信号的文本快照，方便让 AI 帮你解读
- **移动端适配**：单文件 SPA，375px 起可用，首页卡片、回本测算卡均为小屏优先布局

## 三、技术架构

一体化部署：**一个 Cloudflare Worker 同时承担 API 后端与前端静态资源托管**，同域同源，无需 CORS、无需独立服务器、无数据库运维。

```
浏览器（public/index.html，vanilla JS SPA）
   │  同域请求 /api/*
   ▼
Cloudflare Worker（worker.js）  ◄── Cron Trigger（每日 00:05 北京 = 16:05 UTC，自动刷新净值）
   ├── 门禁：会话 Cookie（dt_session，7 天有效，SHA-256 令牌）
   ├── API：/api/state · /api/funds · /api/records · /api/reductions · /api/settings …
   ├── 计算：信号引擎 / 阶梯表 / 回本精算（纯函数，与前端公式一致）
   ├── 外部依赖：东方财富净值接口 · 用户自配 Webhook（信号推送）
   └── 存储：KV namespace STORE
         ├── "store"    整份账户数据（accounts / fundsByAccount / currentAccount）
         ├── "settings" 加仓模式 + Webhook 地址
         └── "auth:*"   密码哈希 / 会话（KV 原生 TTL）
```

设计要点：

- **无框架依赖**：前端为单文件 vanilla JS，构建产物即源码，`wrangler deploy` 一把梭；
- **计算前后同源**：阶梯表、回本价、精算金额均在服务端计算后下发，前端展示与本地微调（回本测算卡）使用同一公式；
- **金额精度**：所有金额按「分」为最小单位运算，`Math.round(x * 100) / 100` 统一收口，不使用浮点累加；
- **时区**：Workers 运行时为 UTC，净值日期与记录日期一律按 `Asia/Shanghai` 归属，避免 0-8 点差一天。

## 四、目录结构

```
bfzsdt/
├── worker.js            # 后端 + 静态托管 + KV 读写 + 定时任务（单文件，1267 行）
├── public/
│   └── index.html       # 前端 SPA（结构 + 样式 + 逻辑，单文件）
├── wrangler.toml        # Workers 配置（Worker 名 / KV 绑定 / 静态资源 / 定时任务 cron）
├── .gitignore           # 忽略 data/、.wrangler/、备份包、AI 工作记忆等
└── README.md
```

## 五、快速开始

### 前置条件

- Node.js ≥ 18
- Cloudflare 账号（免费套餐即可，KV 有每日免费额度，个人使用绰绰有余）

### 部署（约 5 分钟）

```bash
# 1. 克隆仓库
git clone https://github.com/aigamehtml/bfzsdt.git
cd bfzsdt

# 2. 登录 Cloudflare（会打开浏览器授权）
npx wrangler login

# 3. 创建 KV namespace，并把返回的 id 填进 wrangler.toml
npx wrangler kv namespace create dingtou_store
# 输出形如：id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# → 编辑 wrangler.toml，替换 [[kv_namespaces]] 下的 id 值

# 4. 部署（自动上传 public/ 前端 + worker.js）
npx wrangler deploy
```

部署完成后访问 `https://dingtou-worker.<你的子域>.workers.dev`，首次打开会要求**设置访问密码**（至少 6 位，哈希后存于 KV，不明文传输）。

> `wrangler.toml` 已关闭版本预览地址（`preview_urls = false`），对外只有 workers.dev 一个入口。

### 本地开发

```bash
npx wrangler dev          # 本地起服务（默认 http://localhost:8787）
```

本地产生的 `.wrangler/` 与 `data/` 已在 `.gitignore` 中，不会误提交。

## 六、使用说明

### 记一笔买入

1. 首页点「+ 添加基金」，输入基金代码（如 `018490`），自动拉取名称与净值；
2. 填首笔成交信息（成交价 / 份额 / 金额 / 日期），保存即建仓；
3. 之后每次触发信号，在基金详情页「记下一笔」录入实际成交信息。

### 六态信号

首页每张卡片带信号标签，列表按信号优先级排序：

| 信号 | 含义 | 操作建议 |
|------|------|----------|
| 触发买入 | 现价 ≤ 上一笔 × 0.96 | 按下一笔金额买入（详情页可见精算金额） |
| 建议止盈 | 整体收益达到止盈目标（默认 20%） | 记一笔卖出结算，本轮离场 |
| 本轮已止盈离场 | 已清仓，等待下一轮 | 清空买入记录后重新建仓 |
| 10 笔已投满 | 单轮 10 笔全部买入 | 持有等待止盈反弹 |
| 未建仓 | 尚无买入记录 | 录第一笔开始 |
| 净值异常 | 净值数据拉取失败 / 为 0 | 点「刷新数据」重试 |

### 双加仓模式（设置页切换）

| 模式 | 金额口径 | 适用场景 |
|------|----------|----------|
| `ideal` 理想阶梯 | 表内序列金额（原始 10 档固定） | 成交价贴近阶梯价 |
| `actual` 实际回本 | 「5% 回本」精算金额，与表内金额取大 | 实付价偏离阶梯价（滑点 / 手动择时） |

> 两种模式下**触发价永远是理想阶梯价**（上一笔 × 0.96）——触发价只是「信号线」，实付价必然偏离；
> `actual` 模式修正的是**金额**，不是价格。

### 回本测算卡（基金详情页）

> 位置：详情页**最底部**（与「加仓计算表」一起排在最后）；详情页顶部信息卡下方有「📊 加仓计算表 / 🧮 5% 回本测算」两个横向按钮，点击可直接跳到对应卡片（跳转后目标卡会闪一下便于定位，滚动偏移已避开吸顶标题栏）。

输入你的**实际成交价**，实时计算：

- 以该价买入多少金额，才能做到「从该价涨 5% 恰好回本」；
- 若表内金额已足够，提示「表内金额已足够」；若不足，给出需加码的金额。

公式（服务端 `actualBuyAmount` 与前端同源）：

```
令 (cost + X) / (shares + X/P) = 1.05 × P
⟹ X = (cost − 1.05 × P × shares) / 0.05
```

其中 `cost` / `shares` 为当前真实持仓成本与份额，`P` 为输入的成交价。`X ≤ 0` 表示持仓已满足，无需加码。

### 多账户

设置页可新建 / 删除账户，首页顶部切换。账户间数据隔离，删除账户会同时删除其下基金数据（不可恢复，慎用）。

### 数据刷新与备份

- 「刷新数据」逐只更新净值；「全部刷新」一次更新当前账户全部基金；
- 设置页「导出数据」下载 JSON（含全部账户）；「导入数据」支持单账户 / 全量两种格式；
- **建议定期导出备份**：KV 中的数据仅存于 Cloudflare，本地留一份最稳妥。

### 定时任务（自动刷新净值）

已内置 Cron Trigger：每日 **00:05（北京）** 自动刷新全部账户的基金净值。定时任务只刷净值，**不做信号推送**——信号推送改由打开看板（`GET /api/state`）时按需触发（见下方「信号邮件推送」）。

- 配置在 `wrangler.toml`：`[triggers] crons = ["5 16 * * *"]`
- **Cron 一律按 UTC 执行，无时区配置项**：北京 = UTC+8，故 UTC 16:05 = 北京次日 00:05
- 每天执行（含周末）：周末基金公司不更新净值，刷新结果与上一交易日一致，无副作用
- 想改成其他时间，改 `crons` 数组即可；改动后需**最多 15 分钟**才在全网生效
- `wrangler deploy` 会用配置里的数组整体替换线上已有的 cron

**行为与可靠性设计**：
- 遍历**全部账户**（不只是当前账户），逐只刷新；单只基金拉取失败只记错误，不影响其他基金
- 官方未承诺 Cron 失败重试（`controller.noRetry()` 存在但重试策略无文档），故按「失败即丢失、下个周期补」设计：任务自身幂等，异常内部兜底并记录，不向外抛出
- 每次执行结果写入 KV 键 `cron:last`，便于自查（官方无失败告警）

**本地测试**：

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&format=json"
# 返回 {"outcome":"ok","noRetry":false}
```

**线上排查**：

```bash
npx wrangler tail dingtou-worker --format pretty        # 实时日志
npx wrangler kv key get --binding=STORE cron:last       # 最近一次执行结果
```

也可在 Cloudflare 面板 → 该 Worker → Settings → Trigger Events → View events 查看最近 100 次调用。

### 信号邮件推送

设置页填入 Webhook 地址（Zoho Mail webhook，`http(s)://` 开头），保存后可发一封测试邮件验证。配置后，每次打开首页检测到**新的**加仓 / 止盈信号即自动推送（异步执行、失败静默，不影响页面）；同一信号（按「信号类型 + 净值日期」去重）只推一次，不会反复轰炸。**定时任务只负责刷新净值，不再触发推送**。接口契约：POST JSON（`subject` / `content` / `summary` / `message`），成功判据为 HTTP 200 且响应体含 `"code":200`。

### LLM 上下文

访问 `https://<你的域名>/api/llm-context?format=text`（需先登录）可拿到当前持仓、信号、精算金额的纯文本快照，粘贴给任意 AI 助手即可解读。

## 七、API 一览

所有 `/api/*` 业务接口未登录均返回 401（OPTIONS 预检除外）。业务接口统一返回 `{ success, ... }`。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/setup` | 首次设置访问密码 |
| POST | `/api/login` | 登录 |
| POST | `/api/logout` | 退出登录 |
| POST | `/api/change-password` | 修改密码 |
| GET | `/api/state` | 当前账户 + 基金列表（含信号、精算金额、回本信息）+ 加仓模式 |
| GET | `/api/settings` | 读取设置（加仓模式、策略参数、Webhook 脱敏地址） |
| POST | `/api/settings` | 保存设置（`addMode` 仅接受 `ideal` / `actual`，非法值 400） |
| POST | `/api/notify/test` | 发送测试推送邮件 |
| GET | `/api/llm-context` | LLM 上下文快照（`?format=text` 返回纯文本） |
| POST | `/api/accounts` | 新建账户 |
| DELETE | `/api/accounts?name=` | 删除账户（至少保留一个） |
| POST | `/api/current-account` | 切换当前账户 |
| POST | `/api/funds` | 添加基金（含首笔买入记录） |
| DELETE | `/api/funds?code=` | 删除基金 |
| GET | `/api/fund-data?code=` | 拉取单个基金净值 |
| POST | `/api/remark` | 修改基金备注（≤200 字） |
| POST | `/api/stop-profit` | 修改止盈目标（默认 20） |
| POST | `/api/records` | 记一笔买入 |
| DELETE | `/api/records?code=&index=` | 删除一笔买入 |
| POST | `/api/reductions` | 记一笔减仓（份额不得超过持仓） |
| DELETE | `/api/reductions?code=&index=` | 删除一笔减仓 |
| POST | `/api/refresh` | 刷新单个基金净值 |
| POST | `/api/refresh-all` | 刷新当前账户全部基金净值 |
| GET | `/api/export` | 导出当前账户 JSON |
| POST | `/api/import` | 导入单账户数据（覆盖当前账户） |
| POST | `/api/import-all` | 导入全量数据（账户 + 基金，整体覆盖） |

## 八、策略参数

在 `worker.js` 顶部统一定义（与 PHP 原版口径一致）：

| 参数 | 值 | 含义 |
|------|-----|------|
| `LOSS_COEF` | 0.96 | 净值跌到上一笔的 96% 触发下一笔买入（跌 4%） |
| `ADD_MULT` | 1.8 | 理想剧本亏损锁线公式的分母参数 |
| `MAX_LEVEL` | 10 | 单轮层级上限（10 笔投满） |
| `BASE_SEQ` | 10, 10, 10, 20, 40, 72, 129, 233, 419, 755 | 基准加仓序列（原始 10 档固定，不随首投金额缩放） |
| `REBOUND_COEF` | 1.05 | 回本系数：下一笔买入后从买入价涨 5% 即回本 |
| `ADD_MODES` | ideal / actual | 加仓模式：理想阶梯 / 实际 5% 回本精算 |

理想剧本亏损锁线：`limit = (1 − LOSS_COEF) / (ADD_MULT − LOSS_COEF)` = 0.04 ÷ 0.84 ≈ **4.76%**
（含义：严格按阶梯表执行时，剧本内最大浮亏约为累计成本的 4.76%，这是纪律的代价上限。）

## 九、KV 数据结构

```
STORE（KV namespace）
├── store       # { accounts: [{name,color,createdAt}], currentAccount, fundsByAccount: {账户名: [fund] } }
│               # fund = { code, name, currentPrice, jzrq, records: [...], reductions: [...],
│               #          stopProfitTarget, remark }
├── settings    # { addMode: "ideal" | "actual", zohoWebhookUrl: string }
├── auth:pwd    # 密码哈希（SHA-256 直算，无盐；个人自用工具，勿存敏感密码）
├── auth:sess:*    # 会话令牌，TTL 7 天
└── cron:last  # 定时任务最近一次执行结果（at/cron/outcome/total/ok/fail/errors）
```

## 十、安全说明

- 访问密码经哈希后存 KV，会话为 HttpOnly Cookie，7 天有效；
- 本地真实持仓数据（`data/`）已在 `.gitignore` 中排除，仓库只含代码；
- 建议为 Cloudflare API Token 授予最小权限（Workers 编辑 + KV 编辑），并**在推送后及时吊销**；
- 本项目为个人自用工具，开源仅供学习交流，请勿直接部署为公开服务（无注册体系、无多人权限模型、无审计日志）。

## 十一、常见问题

**Q：首次打开是设置密码还是登录？**
A：KV 中无 `auth:pwd` 时显示设置密码页；已设置则显示登录页。

**Q：为什么触发价在 `ideal` / `actual` 下一样？**
A：触发价是信号线（上一笔 × 0.96），双模式一致；`actual` 只改买入金额。

**Q：修改密码后旧会话还有效吗？**
A：当前实现下，修改密码**不会**吊销已登录会话——旧 Cookie 仍有效直至 7 天自然过期。如需立即失效，请重新部署后清空 KV 中的 `auth:sess:*` 键。

**Q：数据会丢吗？**
A：数据存 Cloudflare KV，服务端多地冗余；但请自行定期「导出数据」留本地备份。

---

> 合规声明：本工具为个人定投记录与计算工具，不构成投资建议；基金投资有风险，请独立决策。本项目为产品设计参考，具体实施请结合公司合规与法务要求确认。
