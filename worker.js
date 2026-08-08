// 定投导航仪 - Cloudflare Workers 版本（替代 server.py）
// 存储：Cloudflare KV（绑定名 STORE，键名 "store" 存整份 store 对象）
// 部署：wrangler deploy（需先在 wrangler.toml 填 account_id 与 KV namespace id）
// 策略：4% 定投（每份跌 4% 买入），10 份周期，与当前 server.py 逻辑一致

const KV_KEY = "store";

/* ---------------- 工具函数 ---------------- */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function nowIso() {
  return new Date().toISOString();
}
function toFloat(v, def = 0.0) {
  try {
    if (v === null || v === undefined || v === "") return def;
    const n = parseFloat(v);
    return isNaN(n) ? def : n;
  } catch {
    return def;
  }
}
function toInt(v, def = 0) {
  try {
    if (v === null || v === undefined || v === "") return def;
    return parseInt(parseFloat(v), 10);
  } catch {
    return def;
  }
}
function generateColor(name) {
  let h = 0;
  for (const ch of name) {
    h = ch.codePointAt(0) + ((h << 5) - h);
  }
  const hue = Math.abs(h % 360);
  return `hsl(${hue}, 70%, 55%)`;
}

/* ---------------- 存储层（KV 替代本地文件） ---------------- */
function defaultStore() {
  const main = "主力";
  return {
    accounts: [{ name: main, color: generateColor(main), createdAt: nowIso() }],
    currentAccount: main,
    fundsByAccount: { [main]: [] },
  };
}
async function loadStore(env) {
  let store;
  const raw = await env.STORE.get(KV_KEY);
  if (!raw) {
    store = defaultStore();
    await saveStore(env, store);
    return store;
  }
  try {
    store = JSON.parse(raw);
  } catch {
    store = defaultStore();
    await saveStore(env, store);
    return store;
  }
  if (!Array.isArray(store.accounts) || store.accounts.length === 0) {
    store.accounts = defaultStore().accounts;
  }
  if (!store.currentAccount) store.currentAccount = store.accounts[0].name;
  if (typeof store.fundsByAccount !== "object" || store.fundsByAccount === null) {
    store.fundsByAccount = {};
  }
  for (const acc of store.accounts) {
    const n = acc.name;
    if (n && !(n in store.fundsByAccount)) store.fundsByAccount[n] = [];
  }
  if (!(store.currentAccount in store.fundsByAccount)) {
    store.currentAccount = store.accounts[0].name;
  }
  return store;
}
async function saveStore(env, store) {
  await env.STORE.put(KV_KEY, JSON.stringify(store));
}
function currentFunds(store) {
  const acc = store.currentAccount;
  if (!(acc in store.fundsByAccount)) store.fundsByAccount[acc] = [];
  return store.fundsByAccount[acc];
}

/* ---------------- 定投策略计算（4% / 10 份） ---------------- */
function getNextBuyAmount(count) {
  const amounts = [10, 15, 20, 25, 30, 40, 55, 70, 95, 120];
  if (count >= amounts.length) return amounts[amounts.length - 1];
  return amounts[count];
}
function calculateProfit(fund) {
  const records = fund.records || [];
  const currentPrice = toFloat(fund.currentPrice);
  if (!records.length || currentPrice <= 0) {
    return { totalCost: 0, totalShares: 0, totalValue: 0, profit: 0, profitPercent: 0, realizedProfit: 0, buyShares: 0 };
  }
  const buyCost = records.reduce((s, r) => s + toFloat(r.amount), 0);
  const buyShares = records.reduce((s, r) => s + toFloat(r.shares), 0);
  // 减仓：按平均成本法从持仓份额与持仓成本中扣除，不影响买入进程（records 数量不变）
  let cost = buyCost;
  let shares = buyShares;
  let realized = 0;
  for (const r of (fund.reductions || [])) {
    let s = toFloat(r.shares);
    if (s <= 0 || shares <= 0) continue;
    if (s > shares) s = shares;
    const avg = shares > 0 ? cost / shares : 0;
    const costRemoved = s * avg;
    cost -= costRemoved;
    shares -= s;
    realized += toFloat(r.amount) - costRemoved;
  }
  const totalCost = cost;
  const totalShares = shares;
  const totalValue = totalShares * currentPrice;
  const profit = totalValue - totalCost;
  return {
    totalCost,
    totalShares,
    totalValue,
    profit,
    profitPercent: totalCost > 0 ? (profit / totalCost) * 100 : 0,
    realizedProfit: realized,
    buyShares,
  };
}
function calculateAnnualizedReturn(fund) {
  const records = fund.records || [];
  if (!records.length || toFloat(fund.currentPrice) <= 0) return "--";
  const profit = calculateProfit(fund);
  if (profit.totalCost <= 0 || profit.totalValue <= 0) return "--";
  const firstBuyTime = records[0].buyTime;
  if (!firstBuyTime) return "--";
  let start;
  try {
    start = new Date(firstBuyTime.slice(0, 10) + "T00:00:00");
  } catch {
    return "--";
  }
  const days = (Date.now() - start.getTime()) / 86400000;
  if (days <= 0) return "--";
  let annualized;
  try {
    annualized = (Math.pow(profit.totalValue / profit.totalCost, 365 / days) - 1) * 100;
  } catch {
    return "--";
  }
  if (!Number.isFinite(annualized)) return "--";
  const sign = annualized >= 0 ? "+" : "";
  return `${sign}${annualized.toFixed(2)}%`;
}
function calculateNextTarget(fund) {
  const records = fund.records || [];
  if (!records.length) {
    return { text: "待录入", price: null, amount: getNextBuyAmount(0) };
  }
  const lastPrice = toFloat(records[records.length - 1].price);
  const target = lastPrice * 0.96;
  const amount = getNextBuyAmount(records.length);
  return { text: `${target.toFixed(4)} (${amount}元)`, price: target, amount };
}
function calculateTheoretical(fund) {
  const records = fund.records || [];
  if (!records.length) return "--";
  const firstPrice = toFloat(records[0].price);
  if (firstPrice <= 0) return "--";
  return (firstPrice * Math.pow(0.96, records.length)).toFixed(4);
}
function getFirstBuyChange(fund) {
  const records = fund.records || [];
  const currentPrice = toFloat(fund.currentPrice);
  if (!records.length || currentPrice <= 0) return 0;
  const firstPrice = toFloat(records[0].price);
  if (firstPrice <= 0) return 0;
  return ((currentPrice - firstPrice) / firstPrice) * 100;
}
function signalFor(fund) {
  const records = fund.records || [];
  if (!records.length) {
    return { label: "未记录初始价", level: "gray", sortKey: [2, 0, 999] };
  }
  const profit = calculateProfit(fund);
  const stopTarget = toFloat(fund.stopProfitTarget, 20);
  if (profit.profitPercent >= stopTarget) {
    return {
      label: `触发止盈 (收益${profit.profitPercent.toFixed(2)}%)`,
      level: "red",
      sortKey: [3, 0, -profit.profitPercent],
    };
  }
  const currentPrice = toFloat(fund.currentPrice);
  if (currentPrice <= 0) {
    return { label: "请同步数据", level: "gray", sortKey: [2, 0, 999] };
  }
  const lastPrice = toFloat(records[records.length - 1].price);
  const nextPrice = lastPrice * 0.96;
  const gap = ((currentPrice - nextPrice) / currentPrice) * 100;
  if (currentPrice <= nextPrice) {
    return {
      label: `触发买入 (超跌${Math.abs(gap).toFixed(2)}%)`,
      level: "green",
      sortKey: [0, 0, -Math.abs(gap)],
    };
  }
  if (currentPrice > lastPrice) {
    const rebound = ((currentPrice - lastPrice) / lastPrice) * 100;
    const tagLevel = profit.profit < 0 ? "green" : "orange";
    return { label: `底部反弹 ${rebound.toFixed(2)}%`, level: "orange", tagLevel, sortKey: [2, 0, rebound] };
  }
  return { label: `补仓需跌 ${gap.toFixed(2)}%`, level: "gray", sortKey: [1, 0, gap] };
}
function enrichFund(fund) {
  const out = { ...fund };
  out.records = Array.isArray(fund.records) ? [...fund.records] : [];
  const profit = calculateProfit(fund);
  return {
    ...out,
    summary: {
      profit,
      annualized: calculateAnnualizedReturn(fund),
      nextTarget: calculateNextTarget(fund),
      theoretical: calculateTheoretical(fund),
      firstBuyChange: getFirstBuyChange(fund),
      signal: signalFor(fund),
      recordCount: out.records.length,
    },
  };
}
function cmpKey(x, y) {
  x = x || [2, 0, 999];
  y = y || [2, 0, 999];
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
function sortFundsForView(funds) {
  const enriched = funds.map(enrichFund);
  enriched.sort((a, b) => cmpKey(a.summary.signal.sortKey, b.summary.signal.sortKey));
  return enriched;
}

/* ---------------- 东方财富抓取 ---------------- */
async function fetchFundData(code) {
  if (!/^\d{6}$/.test(code || "")) {
    return { success: false, message: "基金代码必须是 6 位数字" };
  }
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?_=${Date.now()}`;
  let text;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    text = await resp.text();
  } catch (exc) {
    return { success: false, message: "请求失败: " + (exc && exc.message ? exc.message : String(exc)) };
  }
  const nameMatch = text.match(/fS_name\s*=\s*"([^"]+)"/);
  const trendMatch = text.match(/Data_netWorthTrend\s*=\s*\[([\s\S]*?)\];/);
  if (!nameMatch) {
    return { success: false, message: "未找到基金名称" };
  }
  let latestNav = 0;
  let latestDate = todayStr();
  if (trendMatch) {
    const yValues = [...trendMatch[1].matchAll(/"y"\s*:\s*([\d.]+)/g)].map((m) => toFloat(m[1]));
    const xValues = [...trendMatch[1].matchAll(/"x"\s*:\s*(\d+)/g)].map((m) => toInt(m[1]));
    if (yValues.length) latestNav = yValues[yValues.length - 1];
    if (xValues.length) {
      let ts = xValues[xValues.length - 1];
      if (ts > 9999999999) ts = ts / 1000;
      try {
        latestDate = new Date(ts * 1000).toISOString().slice(0, 10);
      } catch {
        latestDate = todayStr();
      }
    }
  }
  // nextAmount：新基金首笔的建议金额，避免前端另行硬编码档位表
  return { success: true, code, name: nameMatch[1], dwjz: latestNav, jzrq: latestDate, nextAmount: getNextBuyAmount(0) };
}

function normalizeRecord(data) {
  const price = toFloat(data.price);
  if (price <= 0) throw new Error("请输入有效价格");
  return {
    buyTime: data.buyTime || todayStr(),
    price,
    amount: toFloat(data.amount),
    shares: toFloat(data.shares),
  };
}
function findFund(store, code) {
  for (const fund of currentFunds(store)) {
    if (fund.code === code) return fund;
  }
  return null;
}

/* ---------------- HTTP 辅助 ---------------- */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function cors(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return resp;
}
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/* ---------------- 访问密码门禁 ---------------- */
// 密码以 SHA-256 哈希存于 KV 键 "auth:pwd"；登录后签发会话 Cookie（HttpOnly+Secure，7 天）
// 未登录时：API 返回 401，其余请求返回登录/设置页，从而保护数据与界面
const SESSION_TTL = 7 * 24 * 3600; // 秒
const COOKIE_NAME = "dt_session";

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text || "");
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function readSessionId(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp("(?:^|;\\s*)" + COOKIE_NAME + "=([^;]+)"));
  return m ? m[1] : null;
}
async function isAuthed(request, env) {
  const id = readSessionId(request);
  if (!id) return false;
  const raw = await env.STORE.get("auth:sess:" + id);
  if (!raw) return false;
  try {
    const s = JSON.parse(raw);
    if (!s.exp || s.exp < Date.now()) {
      await env.STORE.delete("auth:sess:" + id);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function makeSession(env) {
  const id = crypto.randomUUID();
  const exp = Date.now() + SESSION_TTL * 1000;
  await env.STORE.put("auth:sess:" + id, JSON.stringify({ exp }));
  return id;
}
function attachSessionCookie(response, id) {
  response.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL}`
  );
  return response;
}
function clearSessionCookie(response) {
  response.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`
  );
  return response;
}
async function handleLogin(request, env) {
  const data = await readJson(request);
  const hash = await env.STORE.get("auth:pwd");
  if (!hash) return json({ success: false, message: "密码尚未设置，请先设置访问密码" }, 400);
  const inputHash = await sha256Hex(data.password || "");
  if (inputHash !== hash) return json({ success: false, message: "密码错误" }, 401);
  const id = await makeSession(env);
  return attachSessionCookie(json({ success: true }), id);
}
async function handleSetup(request, env) {
  const existing = await env.STORE.get("auth:pwd");
  if (existing) return json({ success: false, message: "密码已设置，请使用修改密码功能" }, 403);
  const data = await readJson(request);
  const pw = (data.password || "").toString();
  if (pw.length < 6) return json({ success: false, message: "密码至少 6 位" }, 400);
  await env.STORE.put("auth:pwd", await sha256Hex(pw));
  const id = await makeSession(env);
  return attachSessionCookie(json({ success: true }), id);
}
async function handleLogout(request, env) {
  const id = readSessionId(request);
  if (id) await env.STORE.delete("auth:sess:" + id);
  return clearSessionCookie(json({ success: true }));
}
async function handleChangePassword(request, env) {
  const data = await readJson(request);
  const hash = await env.STORE.get("auth:pwd");
  if (!hash) return json({ success: false, message: "密码未设置" }, 400);
  const oldHash = await sha256Hex(data.oldPassword || "");
  if (oldHash !== hash) return json({ success: false, message: "原密码错误" }, 400);
  const pw = (data.newPassword || "").toString();
  if (pw.length < 6) return json({ success: false, message: "新密码至少 6 位" }, 400);
  await env.STORE.put("auth:pwd", await sha256Hex(pw));
  return json({ success: true });
}
function serveLoginPage(setup) {
  const setupJs = setup ? "true" : "false";
  const title = setup ? "设置访问密码" : "请输入访问密码";
  const subtitle = setup
    ? "首次使用，请设置一个访问密码（至少 6 位）"
    : "定投导航仪需要验证后才能使用";
  const submitText = setup ? "设置并进入" : "进入";
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>定投导航仪</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background: linear-gradient(135deg,#eef2ff,#f5f3ff); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  .card { width: 340px; max-width: 90vw; background:#fff; border-radius:18px; padding:28px 24px;
    box-shadow: 0 10px 40px rgba(79,70,229,.15); }
  h1 { font-size:20px; margin:0 0 6px; color:#1f2330; }
  p.sub { font-size:13px; color:#6b7280; margin:0 0 20px; }
  label { display:block; font-size:13px; color:#374151; margin-bottom:6px; }
  input { width:100%; padding:12px 14px; border:1px solid #e5e7eb; border-radius:10px; font-size:15px; outline:none; }
  input:focus { border-color:#6366f1; box-shadow:0 0 0 3px rgba(99,102,241,.15); }
  button { width:100%; margin-top:16px; padding:12px; border:0; border-radius:10px; font-size:15px; font-weight:600;
    background: linear-gradient(135deg,#6366f1,#8b5cf6); color:#fff; cursor:pointer; }
  button:active { transform: translateY(1px); }
  .err { color:#e5484d; font-size:13px; min-height:18px; margin:10px 0 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p class="sub">${subtitle}</p>
    <label for="pw">访问密码</label>
    <input id="pw" type="password" placeholder="请输入密码" autocomplete="current-password">
    <button id="submit">${submitText}</button>
    <p class="err" id="err"></p>
  </div>
<script>
  const setup = ${setupJs};
  const endpoint = setup ? "/api/setup" : "/api/login";
  const submitText = ${JSON.stringify(submitText)};
  const pw = document.getElementById("pw");
  const err = document.getElementById("err");
  const submit = document.getElementById("submit");
  pw.focus();
  async function doLogin() {
    const password = pw.value;
    if (!password) { err.textContent = "请输入密码"; return; }
    submit.disabled = true; submit.textContent = "验证中…";
    try {
      const res = await fetch(endpoint, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ password }) });
      const data = await res.json();
      if (data.success) { location.href = "/"; }
      else { err.textContent = data.message || "验证失败"; submit.disabled = false; submit.textContent = submitText; }
    } catch (e) {
      err.textContent = "网络错误，请重试"; submit.disabled = false; submit.textContent = submitText;
    }
  }
  submit.addEventListener("click", doLogin);
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
</script>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/* ---------------- 路由 ---------------- */
async function handle(path, method, url, request, env) {
  if (path === "/api/state" && method === "GET") {
    const store = await loadStore(env);
    const funds = currentFunds(store);
    const counts = {};
    for (const acc of store.accounts) {
      const n = acc.name;
      counts[n] = (store.fundsByAccount[n] || []).length;
    }
    return json({
      success: true,
      accounts: store.accounts,
      currentAccount: store.currentAccount,
      funds: sortFundsForView(funds),
      fundCounts: counts,
    });
  }

  if (path === "/api/accounts" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const name = (data.name || "").trim();
    if (!name) return json({ success: false, message: "请输入账户名称" }, 400);
    if (store.accounts.some((a) => (a.name || "").toLowerCase() === name.toLowerCase())) {
      return json({ success: false, message: "账户名称已存在" }, 400);
    }
    const account = { name, color: generateColor(name), createdAt: nowIso() };
    store.accounts.push(account);
    store.currentAccount = name;
    store.fundsByAccount[name] = [];
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/accounts" && method === "DELETE") {
    const name = decodeURIComponent(url.searchParams.get("name") || "");
    const store = await loadStore(env);
    if (store.accounts.length <= 1) return json({ success: false, message: "至少保留一个账户" }, 400);
    const idx = store.accounts.findIndex((a) => a.name === name);
    if (idx < 0) return json({ success: false, message: "账户不存在" }, 404);
    store.accounts.splice(idx, 1);
    if (name in store.fundsByAccount) delete store.fundsByAccount[name];
    if (store.currentAccount === name) store.currentAccount = store.accounts[0].name;
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/current-account" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const name = (data.name || "").trim();
    if (!store.accounts.some((a) => a.name === name)) {
      return json({ success: false, message: "账户不存在" }, 404);
    }
    store.currentAccount = name;
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/fund-data" && method === "GET") {
    const code = (url.searchParams.get("code") || "").trim();
    return json(await fetchFundData(code));
  }

  if (path === "/api/funds" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const code = (data.code || "").trim();
    const funds = currentFunds(store);
    if (funds.some((f) => f.code === code)) return json({ success: false, message: "该基金已存在" }, 400);
    const fetched = await fetchFundData(code);
    if (!fetched.success) return json(fetched, 400);
    let record;
    try {
      record = normalizeRecord(data);
    } catch (e) {
      return json({ success: false, message: e.message }, 400);
    }
    const fund = {
      code,
      name: fetched.name,
      currentPrice: fetched.dwjz,
      jzrq: fetched.jzrq,
      records: [record],
      reductions: [],
      stopProfitTarget: toInt(data.stopProfitTarget, 20),
      remark: "",
    };
    funds.unshift(fund);
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/funds" && method === "DELETE") {
    const code = url.searchParams.get("code") || "";
    const store = await loadStore(env);
    const funds = currentFunds(store);
    const idx = funds.findIndex((f) => f.code === code);
    if (idx < 0) return json({ success: false, message: "基金不存在" }, 404);
    funds.splice(idx, 1);
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/remark" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const code = (data.code || "").trim();
    const fund = findFund(store, code);
    if (!fund) return json({ success: false, message: "基金不存在" }, 404);
    fund.remark = (data.remark || "").slice(0, 200);
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/records" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const code = (data.code || "").trim();
    const fund = findFund(store, code);
    if (!fund) return json({ success: false, message: "基金不存在" }, 404);
    let record;
    try {
      record = normalizeRecord(data);
    } catch (e) {
      return json({ success: false, message: e.message }, 400);
    }
    if (!Array.isArray(fund.records)) fund.records = [];
    fund.records.push(record);
    if (fund.records.length === 1) fund.stopProfitTarget = toInt(data.stopProfitTarget, 20);
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/records" && method === "DELETE") {
    const code = url.searchParams.get("code") || "";
    const index = toInt(url.searchParams.get("index") || "-1", -1);
    const store = await loadStore(env);
    const fund = findFund(store, code);
    if (!fund) return json({ success: false, message: "基金不存在" }, 404);
    const records = fund.records || [];
    if (index < 0 || index >= records.length) return json({ success: false, message: "记录不存在" }, 404);
    records.splice(index, 1);
    fund.records = records;
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/stop-profit" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const code = (data.code || "").trim();
    const fund = findFund(store, code);
    if (!fund) return json({ success: false, message: "基金不存在" }, 404);
    let target = toInt(data.stopProfitTarget, 20);
    if (target <= 0) target = 20;
    fund.stopProfitTarget = target;
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/reductions" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const code = (data.code || "").trim();
    const fund = findFund(store, code);
    if (!fund) return json({ success: false, message: "基金不存在" }, 404);
    const price = toFloat(data.price);
    const shares = toFloat(data.shares);
    if (price <= 0) return json({ success: false, message: "请输入有效减仓净值" }, 400);
    if (shares <= 0) return json({ success: false, message: "请输入有效减仓份额" }, 400);
    const buyShares = (fund.records || []).reduce((s, r) => s + toFloat(r.shares), 0);
    const reduceShares = (fund.reductions || []).reduce((s, r) => s + toFloat(r.shares), 0);
    const held = buyShares - reduceShares;
    if (shares > held + 1e-9) {
      return json({ success: false, message: "减仓份额超过当前持仓 (" + held.toFixed(2) + " 份)" }, 400);
    }
    const reduction = {
      reduceTime: data.reduceTime || todayStr(),
      price,
      shares,
      amount: shares * price,
    };
    if (!Array.isArray(fund.reductions)) fund.reductions = [];
    fund.reductions.push(reduction);
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/reductions" && method === "DELETE") {
    const code = url.searchParams.get("code") || "";
    const index = toInt(url.searchParams.get("index") || "-1", -1);
    const store = await loadStore(env);
    const fund = findFund(store, code);
    if (!fund) return json({ success: false, message: "基金不存在" }, 404);
    const reductions = fund.reductions || [];
    if (index < 0 || index >= reductions.length) {
      return json({ success: false, message: "减仓记录不存在" }, 404);
    }
    reductions.splice(index, 1);
    fund.reductions = reductions;
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/refresh" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const code = (data.code || "").trim();
    const fund = findFund(store, code);
    if (!fund) return json({ success: false, message: "基金不存在" }, 404);
    const fetched = await fetchFundData(code);
    if (!fetched.success) return json(fetched, 400);
    fund.name = fetched.name;
    fund.currentPrice = fetched.dwjz;
    fund.jzrq = fetched.jzrq;
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/refresh-all" && method === "POST") {
    const store = await loadStore(env);
    for (const fund of currentFunds(store)) {
      const fetched = await fetchFundData(fund.code);
      if (fetched.success) {
        fund.name = fetched.name;
        fund.currentPrice = fetched.dwjz;
        fund.jzrq = fetched.jzrq;
      }
    }
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/export" && method === "GET") {
    const store = await loadStore(env);
    return json({
      success: true,
      data: { account: store.currentAccount, funds: currentFunds(store), exportedAt: nowIso() },
    });
  }

  if (path === "/api/import" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const funds = data.funds;
    if (!Array.isArray(funds)) return json({ success: false, message: "文件格式不正确" }, 400);
    for (const fund of funds) {
      if (!Array.isArray(fund.records)) fund.records = [];
      for (const record of fund.records) {
        if (!record.buyTime) record.buyTime = "";
      }
      if (!Array.isArray(fund.reductions)) fund.reductions = [];
    }
    store.fundsByAccount[store.currentAccount] = funds;
    await saveStore(env, store);
    return json({ success: true });
  }

  if (path === "/api/import-all" && method === "POST") {
    const data = await readJson(request);
    const store = await loadStore(env);
    const accounts = data.accounts;
    const fundsByAccount = data.fundsByAccount;
    if (!Array.isArray(accounts) || !accounts.length) {
      return json({ success: false, message: "账户数据格式不正确" }, 400);
    }
    if (typeof fundsByAccount !== "object" || fundsByAccount === null) {
      return json({ success: false, message: "基金数据格式不正确" }, 400);
    }
    store.accounts = accounts;
    store.fundsByAccount = fundsByAccount;
    for (const accFunds of Object.values(fundsByAccount)) {
      if (!Array.isArray(accFunds)) continue;
      for (const fund of accFunds) {
        if (!Array.isArray(fund.records)) fund.records = [];
        if (!Array.isArray(fund.reductions)) fund.reductions = [];
      }
    }
    store.currentAccount = data.currentAccount || accounts[0].name;
    await saveStore(env, store);
    return json({ success: true });
  }

  return json({ success: false, message: "接口不存在" }, 404);
}

/* ---------------- 入口 ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 认证相关接口（无需登录即可访问）
    if (path === "/api/login" && method === "POST") return handleLogin(request, env);
    if (path === "/api/setup" && method === "POST") return handleSetup(request, env);
    if (path === "/api/logout" && method === "POST") return handleLogout(request, env);
    if (path === "/api/change-password" && method === "POST") return handleChangePassword(request, env);

    // 统一门禁：未登录时拦截一切
    const authed = await isAuthed(request, env);
    if (!authed) {
      if (path.startsWith("/api/")) {
        if (method === "OPTIONS") return cors(new Response(null, { status: 204 }));
        return cors(json({ success: false, message: "未登录或无权限" }, 401));
      }
      const hasPwd = !!(await env.STORE.get("auth:pwd"));
      return serveLoginPage(!hasPwd);
    }

    // 已登录：API 走业务逻辑，其余交给同域静态资源（index.html）
    if (path.startsWith("/api/")) {
      if (method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }
      try {
        const resp = await handle(path, method, url, request, env);
        return cors(resp);
      } catch (e) {
        return cors(
          json({ success: false, message: "服务器错误: " + (e && e.message ? e.message : String(e)) }, 500)
        );
      }
    }
    // 静态前端（同源，无需 CORS）
    return env.ASSETS.fetch(request);
  },
};
