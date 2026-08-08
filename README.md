# 定投导航仪

基于 **4% 定投策略**（每份净值下跌 4% 买入一份，10 份为一周期）的基金定投辅助工具。自动抓取东方财富净值、记录买入、追踪持仓盈亏，并提示下一次买入 / 止盈 / 反弹信号。

> ⚠️ **架构已迁移**：本项目当前运行在 **Cloudflare Workers + KV + 静态资源** 一体化部署上，后端是 `worker.js`、前端是 `public/index.html`、数据存 KV。
> 旧的 `server.py`（Flask 本地版）**已弃用，不再维护**，请勿再为它同步改动。

---

## 一、核心策略

- 首笔买入作为起点。
- 下一次买入目标价 = 上一笔买入成交净值 × **0.96**。
- 当前净值 ≤ 目标价 → 提示「**触发买入**」。
- 当前净值 > 最后买入价 → 提示「**底部反弹**」（持仓仍亏为绿色，已盈利为橙色）。
- 当前收益率达到止盈目标 → 优先提示「**触发止盈**」（默认 20%，可改）。
- 一个完整周期按 **10 份** 买入进度展示。

### 信号类型

| 信号 | 条件 | 颜色 |
| --- | --- | --- |
| 触发买入 | 当前净值 ≤ 最后买入价 × 0.96 | 绿色 |
| 底部反弹（仍亏损） | 当前净值 > 最后买入价 且持仓整体亏损 | 绿色 tag |
| 底部反弹（已盈利） | 当前净值 > 最后买入价 且持仓整体盈利 | 橙色 |
| 补仓需跌 | 当前净值在目标买入价和最后买入价之间 | 灰色 |
| 触发止盈 | 收益率达到止盈目标 | 红色 |
| 请同步数据 | 净值数据无效 | 灰色 |
| 未记录初始价 | 没有买入记录 | 灰色 |

### 建议金额递进（后段加速）

每追加一份买入，下一笔建议金额依「已买入份数」从下方档位递增（**唯一定义在 `worker.js` 的 `getNextBuyAmount`**，前端不抄表）：

```js
const amounts = [10, 15, 20, 25, 30, 40, 55, 70, 95, 120];
```

| 已买入份数 | 建议金额 | 已买入份数 | 建议金额 |
| --- | --- | --- | --- |
| 0 | 10 元 | 5 | 40 元 |
| 1 | 15 元 | 6 | 55 元 |
| 2 | 20 元 | 7 | 70 元 |
| 3 | 25 元 | 8 | 95 元 |
| 4 | 30 元 | 9 份及以上 | 120 元 |

跌得越深投得越多，跑满 10 份累计投入 **480 元**。买入弹窗会**自动预填**该建议金额，并标注「建议 N 元」。

---

## 二、功能概览

| 功能 | 说明 |
| --- | --- |
| 多账户管理 | 创建多个定投账户，独立管理基金数据 |
| 基金添加 | 输入基金代码，后端调用东方财富获取基金名称和最新净值 |
| 买入记录 | 记录买入时间、成交净值、金额和份额（份额自动按 金额÷净值 计算） |
| 定投信号 | 按 4% 策略计算下次买入目标与信号（买入 / 止盈 / 补仓 / 底部反弹） |
| 进度追踪 | 10 份进度点显示当前买入进度 |
| 盈亏计算 | 后端计算总投入、总市值、总盈亏、收益率与年化收益 |
| 止盈目标 | 首笔买入时设置，可随时修改（`/api/stop-profit`） |
| 减仓（落袋） | 独立 `reductions` 数组，按平均成本法调持仓成本/份额，并展示已实现收益；**不计入买入份数** |
| 止盈悬浮窗 | 首页顶部悬浮提示「N 只基金达到止盈目标」，可一键定位 |
| 基金备注 | 为每只基金添加备注（≤200 字） |
| 导入导出 | 当前账户 JSON 备份恢复；`/api/import-all` 可一键导入整个 store |
| 访问密码门禁 | Worker 级鉴权，保护数据与应用界面（见下文） |

---

## 三、技术架构与部署

### 架构

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 后端 | Cloudflare Worker（`worker.js`） | 鉴权 + RESTful API + 策略计算 + 静态资源路由 |
| 前端 | 原生 HTML/CSS/JavaScript（`public/index.html`） | 移动端优先适配，无框架 |
| 数据存储 | Cloudflare KV（`STORE` 绑定） | 账户、基金、买入记录等全部存 KV（键 `store`） |
| 基金数据 | 东方财富 `pingzhongdata` 脚本接口 | Worker 端 `fetch` 并解析 |
| 部署 | 一体化（Worker + Static Assets 同域） | 同源访问，无需 CORS |

### 目录结构

```text
定投助手python/
├── worker.js              # Cloudflare Worker 后端（认证 + API + 策略计算 + 路由）
├── public/
│   └── index.html         # 前端单页应用（唯一前端文件，会被部署到线上）
│   └── index - 副本.html   # 本地备份副本，不参与部署
│   └── 备份1.html          # 本地备份，不参与部署
├── wrangler.toml          # Cloudflare 部署配置
├── data/
│   └── store.json         # ⚠️ 已弃用的本地数据（server.py 时代），仅作参考
├── server.py              # ⚠️ 已弃用，不再维护
├── 部署到Cloudflare.md      # 部署与运维笔记
├── 项目功能总结.md          # 功能 / 流程 / 数据 / 接口的详细文档
├── backup_20260807/       # 历史备份目录
├── bfzs.zip / index.zip   # 历史压缩包
└── .workbuddy/            # 项目记忆（AI 工作记录，非运行所需）
```

### 部署步骤

```bash
# 1. 安装并登录 wrangler（一次性）
npm install -g wrangler
wrangler login          # 浏览器授权你的 Cloudflare 账号

# 2. 部署（在项目根目录执行；会自动上传 public/ 前端并发布 worker.js）
wrangler deploy

# 3. 部署后访问：
#    https://dingtou-worker.<你的子域>.workers.dev
```

`wrangler.toml` 关键配置：
- `main = "worker.js"`，KV 绑定 `STORE`（namespace id: `f88edeb10743499b88324298364e6db6`）
- `[assets]`：`directory = "./public"`、`binding = "ASSETS"`、`not_found_handling = "single-page-application"`、`run_worker_first = true`（**必须**，否则 Worker 无法拦截未登录访问）
- `preview_urls = false`（关闭版本预览地址，减少对外入口）

> 🌐 **国内访问提示**：`workers.dev` 域名 Cloudflare 在大陆无节点，国内用户需挂梯子访问。若不可接受，需迁移到国内轻量云（届时架构会变，需另行评估）。

---

## 四、访问密码门禁（安全）

应用层带 Worker 级鉴权，数据与界面均受保护。

**机制**
- 密码以 **SHA-256 哈希** 存 KV 键 `auth:pwd`（与业务数据同命名空间，独立前缀不冲突）。
- 登录成功签发会话 Cookie `dt_session`（`HttpOnly` + `SameSite=Lax` + `Secure`，有效期 7 天），会话记录存 `auth:sess:<uuid>`。
- 未登录时：API 请求返回 **401 JSON**；非 API 请求（页面）返回**内置登录/设置页**（不会泄露 `index.html`）。
- 前端 `api()` 捕获 401 会自动刷新回登录页。

**首次设置密码**
部署后若 KV 中尚无密码，首个访问者会在设置页设密码（至少 6 位）。建议部署后立刻设置强密码；或部署前预置：

```bash
# 计算密码的 SHA-256 哈希
node -e "const c=require('crypto');console.log(c.createHash('sha256').update('你的密码').digest('hex'))"

# 写入 KV（即时生效，无需重新部署）
wrangler kv key put --namespace-id=f88edeb10743499b88324298364ebs6 "auth:pwd" "<上面的哈希>"
```

**改密 / 登出**：通过前端头部 🔒「账号安全」抽屉操作（`/api/change-password`、`/api/logout`）。
> 注：改密失败等业务错误返回 **400**（非 401），不会误触发前端跳登录页。

---

## 五、数据存储结构

数据全部存于 KV 键 `store`（JSON）。

### store 顶层

```json
{
  "accounts": [],
  "currentAccount": "主力",
  "fundsByAccount": { "主力": [] }
}
```

### 账户对象

```json
{ "name": "主力", "color": "hsl(120, 70%, 55%)", "createdAt": "2026-06-02T00:00:00.000Z" }
```

### 基金对象

```json
{
  "code": "006759",
  "name": "基金名称",
  "currentPrice": 1.2345,
  "jzrq": "2026-06-02",
  "records": [],
  "stopProfitTarget": 20,
  "remark": "",
  "reductions": []
}
```

| 字段 | 说明 |
| --- | --- |
| `code` | 基金代码 |
| `name` | 基金名称 |
| `currentPrice` | 最新净值 |
| `jzrq` | 最新净值日期 |
| `records` | 买入记录数组 |
| `stopProfitTarget` | 止盈目标（%） |
| `remark` | 基金备注（≤200 字） |
| `reductions` | 减仓记录数组（落袋，独立核算） |

### 买入记录

```json
{ "buyTime": "2026-06-02", "price": 1.2345, "amount": 1000, "shares": 810.04 }
```

### 减仓记录

```json
{ "reduceTime": "2026-06-02", "price": 1.5, "shares": 100, "amount": 150 }
```

---

## 六、API 接口

所有接口均位于 Worker 域下（同源），鉴权接口除外见 §四。

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/state` | GET | 获取账户、当前账户、基金列表与后端计算结果 |
| `/api/accounts` | POST | 新增账户 |
| `/api/accounts?name=账户名` | DELETE | 删除账户 |
| `/api/current-account` | POST | 切换当前账户 |
| `/api/fund-data?code=基金代码` | GET | 查询基金基础信息（含首档建议金额 `nextAmount`） |
| `/api/funds` | POST | 新增基金并保存首笔买入 |
| `/api/funds?code=基金代码` | DELETE | 删除基金 |
| `/api/remark` | POST | 更新基金备注 |
| `/api/records` | POST | 追加买入记录 |
| `/api/records?code=基金代码&index=序号` | DELETE | 删除买入记录 |
| `/api/stop-profit` | POST | 修改止盈目标 |
| `/api/reductions` | POST | 新增减仓记录 |
| `/api/reductions?code=基金代码&index=序号` | DELETE | 删除减仓记录 |
| `/api/refresh` | POST | 刷新单只基金净值 |
| `/api/refresh-all` | POST | 批量刷新当前账户基金 |
| `/api/export` | GET | 导出当前账户数据 |
| `/api/import` | POST | 导入当前账户数据 |
| `/api/import-all` | POST | 一键导入整个 store（含账户结构） |
| `/api/login` | POST | 登录（校验密码，签发会话） |
| `/api/setup` | POST | 首次无密码时设置密码 |
| `/api/logout` | POST | 退出登录（吊销会话） |
| `/api/change-password` | POST | 修改密码（原密码 + 新密码） |

---

## 七、维护约定（⚠️ 重要）

1. **只改云端版本**：所有改动只改 `worker.js` / `public/index.html` / `wrangler.toml`，改完在本机执行 `wrangler deploy` 生效。`server.py` 与 `data/store.json` 已弃用，仅作历史参考，不要再为它们同步改动。
2. **金额档位唯一来源**：建议金额序列只在 `worker.js` 的 `getNextBuyAmount` 定义一处，改序列只改这一行，前端切勿硬编码档位表。
3. **真实账户数据尚未迁移**：本地 `data/store.json` 中的真实账户（6 个）尚未导入 KV，目前线上 KV 是空的「主力」账户。迁移前线上无历史数据。
4. **东方财富接口风险**：`pingzhongdata` 是页面脚本资源而非稳定 API，若其变量名/格式调整，净值解析会失败；离线时只能用已保存数据。

---

## 八、相关文档

- `部署到Cloudflare.md` — 部署、KV 密码预置、会话踢下线等运维细节。
- `项目功能总结.md` — 页面流程、交互规则、数据结构、外部接口解析的详细文档。
