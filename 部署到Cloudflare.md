# 部署到 Cloudflare（Workers + 静态资源一体化 · 免费方案）

本方案把原 Flask 后端（`server.py`）改写为无依赖的 Cloudflare Workers（`worker.js`），用 KV 替代本地 `data/store.json`，前端 `index.html` 通过 Cloudflare 的 **Static Assets** 与 Worker **同域部署**。一次 `wrangler deploy` 同时发布前后端，同源访问、无需 CORS、无需单独管理 Pages。三者全部在免费额度内。

> 本地运行不受影响：`server.py` 从 `public/` 提供页面，照常可用（API_BASE 同源留空）。

## 项目结构
```
定投助手python/
├── server.py          # 本地后端（Flask），从 public/ 提供前端
├── worker.js          # Cloudflare 版后端（替代 server.py）
├── wrangler.toml      # 部署配置：KV 绑定 STORE + 静态资源目录 public/
├── public/
│   └── index.html      # 前端页面（含智能 API_BASE：Cloudflare 域自动指向 Worker，本地走同源）
└── data/store.json     # 本地数据（仅本地用，不会上传到 Cloudflare）
```

## 一、准备
1. 注册 Cloudflare 账号（免费，无需信用卡）。
2. 安装 Wrangler：`npm install -g wrangler`
3. 登录：`wrangler login`（浏览器授权；PowerShell 若报脚本禁止，先 `Set-ExecutionPolicy -Scope Process Bypass`）

## 二、创建 KV 命名空间
```bash
wrangler kv namespace create dingtou_store
```
复制输出的 `id = "..."`。

## 三、填写 wrangler.toml
`account_id` 可删（用默认登录账号）；填入 KV 的 id，并确认已声明静态资源：
```toml
name = "dingtou-worker"
main = "worker.js"
compatibility_date = "2026-08-07"

[[kv_namespaces]]
binding = "STORE"
id = "上面创建的_KV_id"

[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*"]
```
> 静态目录必须是专门的 `public/`，绝不能填 `.`（否则 server.py、本地 data 等会被公开暴露）。

## 四、一键部署（前后端同域）
```bash
wrangler deploy
```
成功后终端给出唯一地址：
```
https://dingtou-worker.<你的子域>.workers.dev
```
这个地址**同时**提供前端页面和 `/api/*` 后端，同源。

## 五、验证
浏览器打开 Worker 地址本身（不是 /api）：
- 页面正常显示 → 前端静态资源 OK
- `https://<地址>/api/state` 返回 JSON → 后端 + KV OK
- `https://<地址>/api/fund-data?code=006759` 返回基金名 → 东财抓取 OK（最关键）

## 六、迁移现有数据（可选）
本地 `data/store.json` 的 6 个真实账户默认不会自动过去。两种做法：
- 在 Cloudflare 版里重新添加基金（净值自动抓，历史买入记录需补录）；
- 或写一次性脚本，用 `/api/import-all` 把本地 `store.json` 灌进 KV。

## 七、排错
- **添加基金失败**：先开 `/api/fund-data?code=006759`。若东财返回空/报错 → 东财封了 Cloudflare 机房 IP，此方案不适合，改回国内轻量云跑 `server.py`。
- **页面 404 / 接口 404**：确认 `wrangler.toml` 的 `assets.directory` 指向 `./public` 且 `public/index.html` 存在，重新 `wrangler deploy`。
- **写入偶发报错**：免费 KV 同 key 限 1 次/秒写入、最终一致。个人低频无碍。
- **中国大陆访问慢**：Cloudflare 在大陆无节点，属预期。

## 免费额度
- Workers：10 万请求/天、10ms CPU/请求
- KV：10 万读/天、1,000 写/天、1GB 存储
- 静态资源（Assets）：随 Workers 免费托管

对个人定投工具完全够用。
