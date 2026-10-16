// 定投导航仪 - Cloudflare Workers 版本（替代 server.py）
// 存储：Cloudflare KV（绑定名 STORE，键名 "store" 存整份 store 对象）
// 部署：wrangler deploy（需先在 wrangler.toml 填 account_id 与 KV namespace id）
// 策略：4% 定投（每份跌 4% 买入），10 份周期，与当前 server.py 逻辑一致

const KV_KEY = "store";
const SETTINGS_KEY = "settings";

/* ---------------- 策略参数（与 PHP 版默认值一致） ----------------
   LOSS_COEF  折损系数：净值跌到上一笔的 96% 触发下一笔买入
   ADD_MULT   理想剧本亏损锁线公式的分母参数（limit = (1-LOSS)/(ADD_MULT-LOSS)）
   MAX_LEVEL  单轮层级上限（10 笔）
   BASE_SEQ   基准加仓序列（首投 ¥10 口径），按每只基金首投金额等比缩放 */
const LOSS_COEF = 0.96;
const ADD_MULT = 1.8;
const MAX_LEVEL = 10;
const BASE_SEQ = [10, 10, 10, 20, 40, 72, 129, 233, 419, 755];
/* 回本系数：下一笔买入价 P 满足「买完后从 P 上涨 5% 即回本」（经验法则，实际模式用） */
const REBOUND_COEF = 1.05;
const REBOUND_GAP = REBOUND_COEF - 1; // 0.05
/* 加仓模式：ideal=理想阶梯（上一笔×0.96，默认）；actual=实际 5% 回本约束反推买入价 */
const ADD_MODES = ["ideal", "actual"];
function normalizeAddMode(m) {
  return ADD_MODES.includes(m) ? m : "ideal";
}

/* ---------------- 工具函数 ---------------- */
/* 按 Asia/Shanghai 输出 YYYY-MM-DD。
   Workers 运行时是 UTC：本地 getter 会把北京时间 0-8 点算成前一天；
   净值时间戳（东财返回）按北京日历归属，直接用 toISOString 也会偏一天。
   故所有"日期"口径统一走本函数。 */
function shanghaiDateStr(d) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(d);
    let y = "", m = "", day = "";
    for (const p of parts) {
      if (p.type === "year") y = p.value;
      else if (p.type === "month") m = p.value;
      else if (p.type === "day") day = p.value;
    }
    return `${y}-${m}-${day}`;
  } catch {
    return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
}
function todayStr() {
  return shanghaiDateStr(new Date());
}
function nowIso() {
  return new Date().toISOString();
}
/* 买入份额截断到 2 位小数：不四舍五入，直接舍弃（与 PHP 版 shares_floor2 同规则）。
   +1e-9 用于消除二进制浮点噪声（如 1.15*100 = 114.99999999999999），不改变截断语义。 */
function sharesFloor2(v) {
  return Math.floor(v * 100 + 1e-9) / 100;
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
/* 加仓序列：基准 BASE_SEQ 按该基金首投金额 / 10 等比缩放（与 PHP add_seq 同规则） */
function addSeq(fund) {
  const records = fund.records || [];
  const initial = records.length ? toFloat(records[0].amount) : 10;
  const factor = (initial > 0 ? initial : 10) / 10;
  return BASE_SEQ.map((x) => Math.round(x * factor * 100) / 100);
}

/* 第 count 笔（0 起）的建议金额；超过序列长度取最后一档 */
function getNextBuyAmountFor(fund, count) {
  const seq = addSeq(fund);
  if (count < 0) count = 0;
  if (count >= seq.length) return seq[seq.length - 1];
  return seq[count];
}

/* 新基金首档建议金额（首投口径 ¥10，无缩放） */
function getNextBuyAmount() {
  return BASE_SEQ[0];
}

/* 理想轨迹（剧本预演）：以本轮首笔成交净值为 P0（未建仓用当前净值），
   每层恰跌 4% 成交：mv = mv*0.96 + add_i，亏损率逐层收敛到 limit。 */
function idealTrack(fund) {
  const records = fund.records || [];
  const p0 = records.length ? toFloat(records[0].price)
    : (toFloat(fund.currentPrice) > 0 ? toFloat(fund.currentPrice) : null);
  if (p0 === null || p0 <= 0) return null;
  const seq = addSeq(fund);
  const rows = [];
  let cost = 0;
  let mv = 0;
  let price = p0;
  for (let i = 0; i < seq.length; i++) {
    const add = seq[i];
    if (i === 0) {
      mv = add;
    } else {
      price = price * LOSS_COEF;
      mv = mv * LOSS_COEF + add;
    }
    cost += add;
    rows.push({
      n: i + 1,
      add: Math.round(add * 100) / 100,
      trigger: Math.round(price * 10000) / 10000,
      cost: Math.round(cost * 100) / 100,
      mv: Math.round(mv * 100) / 100,
      lossPct: cost > 0 ? Math.round((cost - mv) / cost * 10000) / 100 : 0,
    });
  }
  return {
    p0: Math.round(p0 * 10000) / 10000,
    rows,
    total: Math.round(cost * 100) / 100,
    limit: Math.round((1 - LOSS_COEF) / (ADD_MULT - LOSS_COEF) * 10000) / 100,
  };
}
/* 实际回本计算（非理想剧本，按真实持仓实算）。
   经验法则「最新买入价 × 1.05 回本」只在理想剧本中后段成立（第 4 层起），
   现实中成交价不在严格 -4% 上，唯一准确的口径是平均成本：回本价 = 成本 ÷ 份额。 */
function breakevenInfo(fund) {
  const profit = calculateProfit(fund);
  const cur = toFloat(fund.currentPrice);
  const cost = profit.totalCost;
  const shares = profit.totalShares;
  if (cost <= 0 || shares <= 0) return null; // 无持仓（首笔前/已离场）
  const bePrice = cost / shares;
  const gapPct = cur > 0 ? (bePrice - cur) / cur * 100 : null; // 正=还差这么多才回本，负=已回本
  return {
    price: Math.round(bePrice * 10000) / 10000,
    gapPct: gapPct === null ? null : Math.round(gapPct * 100) / 100,
  };
}
/* 实际模式下一笔买入金额：成交价不可预知（触发价只是信号线，实付价必然偏离），
   若仍按表内固定金额买入，从实付价涨 5% 回不了本。令「以价格 P 买入金额 X 后，
   从 P 上涨 5% 恰好回本」反推金额：
     (cost + X) / (shares + X/P) = 1.05·P
     ⟹ cost + X = 1.05·P·shares + 1.05·X
     ⟹ X = (cost − 1.05·P·shares) / 0.05
   X ≤ 0 表示当前持仓已满足「涨 5% 回本」，无需修正（返回 null，按表内金额即可）。 */
function actualBuyAmount(fund, price) {
  const profit = calculateProfit(fund);
  const cost = profit.totalCost;
  const shares = profit.totalShares;
  const p = toFloat(price);
  if (cost <= 0 || shares <= 0 || !(p > 0)) return null;
  const x = (cost - REBOUND_COEF * p * shares) / REBOUND_GAP;
  if (!(x > 0)) return null;
  return Math.round(x * 100) / 100;
}
/* 下一笔买入价：永远取理想阶梯价（上一笔 × 0.96，与 PHP 对齐）。
   触发价只是信号线——实付价必然偏离，所以实际模式修正的是金额（见 correctedNextAmount），不是价格。 */
function nextBuyPrice(fund) {
  const records = fund.records || [];
  const lastPrice = records.length ? toFloat(records[records.length - 1].price) : null;
  if (lastPrice === null || !(lastPrice > 0)) return null;
  return lastPrice * LOSS_COEF;
}
/* 下一笔买入金额（按模式）：
   ideal  = 表内序列金额；actual = 「5% 回本」精算金额与表内金额取大（偏离越深加码越多）。
   refPrice 为精算参考价（成交价未知，默认当前净值；净值缺失时回退理想触发价）。 */
function correctedNextAmount(fund, mode, refPrice) {
  const records = fund.records || [];
  if (records.length >= MAX_LEVEL) return null; // 投满无下一笔
  const base = getNextBuyAmountFor(fund, records.length);
  if (normalizeAddMode(mode) !== "actual") return base;
  const ref = (toFloat(refPrice) > 0) ? toFloat(refPrice) : nextBuyPrice(fund);
  const x = actualBuyAmount(fund, ref);
  return (x !== null && x > base) ? x : base;
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
function calculateNextTarget(fund, mode) {
  const records = fund.records || [];
  if (!records.length) {
    return { text: "待录入", price: null, amount: getNextBuyAmount() };
  }
  const lastPrice = toFloat(records[records.length - 1].price);
  /* 投满 / 已离场：没有下一笔 */
  if (records.length >= MAX_LEVEL || calculateProfit(fund).totalShares <= 0) {
    return { text: "--", price: lastPrice * LOSS_COEF, amount: null };
  }
  const amount = correctedNextAmount(fund, mode, toFloat(fund.currentPrice));
  const target = nextBuyPrice(fund);
  const tag = normalizeAddMode(mode) === "actual" ? "回本精算 " : "";
  return { text: `${target.toFixed(4)} (${tag}${amount}元)`, price: target, amount };
}
function calculateTheoretical(fund) {
  const records = fund.records || [];
  if (!records.length) return "--";
  const firstPrice = toFloat(records[0].price);
  if (firstPrice <= 0) return "--";
  return (firstPrice * Math.pow(LOSS_COEF, records.length)).toFixed(4);
}
function getFirstBuyChange(fund) {
  const records = fund.records || [];
  const currentPrice = toFloat(fund.currentPrice);
  if (!records.length || currentPrice <= 0) return 0;
  const firstPrice = toFloat(records[0].price);
  if (firstPrice <= 0) return 0;
  return ((currentPrice - firstPrice) / firstPrice) * 100;
}
/* 信号状态机（6 态，与 PHP fund_state 对齐；判定优先级从上到下）：
   init        待建仓：无买入记录
   stale       请同步数据：净值无效（兜底，防脏数据出错误信号）
   resting     待重开：买过但持仓份额已减光（止盈离场）
   take_profit 触发止盈：收益率 ≥ 止盈目标
   exhausted   弹药用尽：已买满 MAX_LEVEL 笔且止盈前
   add         触发买入：现价 ≤ 下一笔买入价（理想阶梯价 = 上一笔×0.96；加仓模式只改金额，不改信号线）
   holding     持有中：其余（现价高于上一笔为「底部反弹」，否则「持有中」）

   排序（sortKey 三元素 [组号, 0, 组内值]，cmpKey 逐元素升序）：
   组 0 止盈（收益率高的在前）｜组 1 触发买入（超跌幅度大的在前，跌得越深越紧急）
   组 2 持有中（距触发买入越近越前）｜组 3 弹药用尽｜组 4 沉底（待重开/待建仓/请同步） */
function signalFor(fund) {
  const records = fund.records || [];
  if (!records.length) {
    return { state: "init", label: "待建仓", level: "gray", sortKey: [4, 0, 999] };
  }
  const profit = calculateProfit(fund);
  const currentPrice = toFloat(fund.currentPrice);
  if (currentPrice <= 0) {
    return { state: "stale", label: "请同步数据", level: "gray", sortKey: [4, 0, 999] };
  }
  if (profit.totalShares <= 0) {
    return { state: "resting", label: "待重开", level: "gray", sortKey: [4, 0, 998] };
  }
  const stopTarget = toFloat(fund.stopProfitTarget, 20);
  if (profit.profitPercent >= stopTarget) {
    return { state: "take_profit", label: `触发止盈 (收益${profit.profitPercent.toFixed(2)}%)`, level: "red", sortKey: [0, 0, -profit.profitPercent] };
  }
  const lastPrice = toFloat(records[records.length - 1].price);
  if (records.length >= MAX_LEVEL) {
    return { state: "exhausted", label: "弹药用尽", level: "gray", sortKey: [3, 0, 999] };
  }
  const nextPrice = nextBuyPrice(fund);
  const dropPct = (currentPrice - nextPrice) / currentPrice * 100; // 超跌幅度（相对现价）
  const gapPct = (currentPrice - nextPrice) / lastPrice * 100;   // 距触发还差（相对上一笔，PHP 口径）
  if (currentPrice <= nextPrice) {
    return { state: "add", label: `触发买入 (超跌${Math.abs(dropPct).toFixed(2)}%)`, level: "green", sortKey: [1, 0, -Math.abs(dropPct)] };
  }
  if (currentPrice > lastPrice) {
    const rebound = ((currentPrice - lastPrice) / lastPrice) * 100;
    const tagLevel = profit.profit < 0 ? "green" : "orange";
    return { state: "holding", label: `底部反弹 ${rebound.toFixed(2)}%`, level: "orange", tagLevel, sortKey: [2, 0, gapPct] };
  }
  return { state: "holding", label: `持有中 (距触发还差 ${gapPct.toFixed(2)}%)`, level: "gray", sortKey: [2, 0, gapPct] };
}

/* 派生状态字段（与 PHP fund_state 输出对齐，供卡片 meta 行与详情信号盒使用）。
   triggerNav 永远为理想阶梯价（信号线，与 PHP 一致）；
   nextAmount 随加仓模式变化：ideal=表内序列金额；actual=「5% 回本」精算金额（与表内取大）。 */
function fundState(fund, mode) {
  const records = fund.records || [];
  const level = records.length;
  const profit = calculateProfit(fund);
  const currentPrice = toFloat(fund.currentPrice);
  const lastPrice = level ? toFloat(records[level - 1].price) : null;
  // triggerNav 口径对齐 PHP：有上一笔就给值（纯理想阶梯，与模式无关）
  const rawTrigger = (lastPrice !== null && lastPrice > 0) ? nextBuyPrice(fund) : null;
  const triggerNav = rawTrigger !== null ? Math.round(rawTrigger * 10000) / 10000 : null;
  const stopTarget = toFloat(fund.stopProfitTarget, 20);
  const tpTargetMV = profit.totalCost > 0 ? Math.round(profit.totalCost * (1 + stopTarget / 100) * 100) / 100 : null;
  const gapPct = (currentPrice > 0 && lastPrice !== null && lastPrice > 0 && triggerNav !== null)
    ? Math.round((currentPrice - triggerNav) / lastPrice * 10000) / 100 : null;
  // nextAmount 口径：未建仓也给首档金额（seq[0]），投满为 null；actual 模式为回本精算金额
  const nextAmount = correctedNextAmount(fund, mode, currentPrice);
  const baseAmount = level < MAX_LEVEL ? getNextBuyAmountFor(fund, level) : null;
  // 精算参考价：成交价未知，默认当前净值；净值缺失回退理想触发价（前端可按真实成交价重算）
  const reboundRef = (currentPrice > 0) ? currentPrice : (rawTrigger !== null ? Math.round(rawTrigger * 10000) / 10000 : null);
  return {
    level,
    refNav: lastPrice,
    actualCost: profit.totalCost > 0 ? Math.round(profit.totalCost * 100) / 100 : null,
    actualShares: profit.totalShares > 0 ? Math.round(profit.totalShares * 10000) / 10000 : null,
    // marketValue 口径对齐 PHP：无持仓（份额为 0）时给 null，不给 0
    marketValue: (currentPrice > 0 && profit.totalShares > 0) ? Math.round(profit.totalValue * 100) / 100 : null,
    returnRate: profit.totalCost > 0 ? Math.round(profit.profitPercent * 100) / 100 : null,
    nextAmount,
    baseAmount,
    reboundRef,
    triggerNav,
    tpTargetMV,
    gapPct,
    // 实际回本（平均成本法，与模式无关，始终展示真实口径）
    breakeven: breakevenInfo(fund),
  };
}
function enrichFund(fund, mode) {
  const out = { ...fund };
  out.records = Array.isArray(fund.records) ? [...fund.records] : [];
  const profit = calculateProfit(fund);
  return {
    ...out,
    summary: {
      profit,
      annualized: calculateAnnualizedReturn(fund),
      nextTarget: calculateNextTarget(fund, mode),
      theoretical: calculateTheoretical(fund),
      firstBuyChange: getFirstBuyChange(fund),
      signal: signalFor(fund),
      state: fundState(fund, mode),
      ideal: idealTrack(fund),
      recordCount: out.records.length,
    },
  };
}
function cmpKey(x, y) {
  x = x || [4, 0, 999];
  y = y || [4, 0, 999];
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
function sortFundsForView(funds, mode) {
  const enriched = funds.map((f) => enrichFund(f, mode));
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
        latestDate = shanghaiDateStr(new Date(ts * 1000));
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
  const amount = toFloat(data.amount);
  if (amount < 1) throw new Error("买入金额至少 1 元");
  /* 份额以服务端计算为准（金额 ÷ 净值），截断到 2 位小数，不采信前端传值 */
  return {
    buyTime: data.buyTime || todayStr(),
    price,
    amount,
    shares: sharesFloor2(amount / price),
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

/* ---------------- 设置 / 通知 / AI 分析 ---------------- */
async function loadSettings(env) {
  try {
    const raw = await env.STORE.get(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return typeof s === "object" && s !== null ? s : {};
    }
  } catch { /* 落到默认空配置 */ }
  return {};
}
async function saveSettings(env, settings) {
  await env.STORE.put(SETTINGS_KEY, JSON.stringify(settings));
}
function maskUrl(url) {
  const s = String(url || "");
  if (s.length <= 12) return s;
  return s.slice(0, 8) + "****" + s.slice(-6);
}
/* Zoho Mail webhook 推送（与 PHP 版契约一致：POST JSON，成功判据 HTTP 200 且响应体含 "code":200） */
async function notifyZoho(env, subject, html) {
  const url = (await loadSettings(env)).zohoWebhookUrl;
  if (!url) return false;
  const plain = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject,
        content: html,
        summary: plain.slice(0, 80),
        message: plain,
      }),
    });
    const text = await resp.text();
    return resp.status === 200 && text.includes('"code":200');
  } catch {
    return false;
  }
}
/* 信号变化推送：add / take_profit 且 notified_signal 未记录过时推一次（防轰炸）。
   funds 为 enrichFund 后的副本；notifiedSignal 回写到 store 原始对象上再整体保存。 */
async function maybeNotifySignals(env, store, funds) {
  const url = (await loadSettings(env)).zohoWebhookUrl;
  if (!url) return;
  const rawByName = {};
  for (const acc of store.accounts || []) {
    for (const f of (store.fundsByAccount[acc.name] || [])) rawByName[f.code] = f;
  }
  let changed = false;
  for (const fund of funds) {
    const st = fund.summary && fund.summary.signal;
    if (!st || (st.state !== "add" && st.state !== "take_profit")) continue;
    const sigKey = `${st.state}:${fund.jzrq || ""}`;
    if (fund.notifiedSignal === sigKey) continue;
    const name = fund.name || fund.code;
    let subject, html;
    if (st.state === "add") {
      const s = fund.summary.state || {};
      subject = `【定投导航仪】${name} 触发加仓信号`;
      html = `<p>${name}（${fund.code}）已跌破加仓触发价。</p><p>建议买入：<strong>¥${s.nextAmount ?? "--"}</strong>（第 ${(s.level ?? 0) + 1} 笔）</p><p>触发价 ${s.triggerNav ?? "--"} ｜ 最新净值 ${fund.currentPrice}（${fund.jzrq || "--"}）</p><p style="color:#888">仅为策略信号提示，不构成投资建议。</p>`;
    } else {
      const s = fund.summary.state || {};
      subject = `【定投导航仪】${name} 达到止盈目标`;
      html = `<p>${name}（${fund.code}）已达止盈目标。</p><p>当前市值 ¥${s.marketValue ?? "--"} ≥ 目标 ¥${s.tpTargetMV ?? "--"}</p><p style="color:#888">仅为策略信号提示，不构成投资建议。</p>`;
    }
    if (await notifyZoho(env, subject, html)) {
      fund.notifiedSignal = sigKey;
      const raw = rawByName[fund.code];
      if (raw) raw.notifiedSignal = sigKey;
      changed = true;
    }
  }
  if (changed) await saveStore(env, store);
}
/* AI 分析上下文：全部实盘数据 + 提示词（与 PHP /llm/context 对齐） */
function buildLlmContext(store, funds, addMode) {
  const mode = normalizeAddMode(addMode);
  const modeNote = mode === "actual"
    ? "当前为「实际 5% 回本」模式：nextTriggerNav 仍为理想阶梯信号价（上一笔成交净值×0.96），但 nextAddAmount 为按「成交后从成交价上涨 5% 恰好回本」精算的金额（X=(cost−1.05·P·shares)/0.05，参考价 reboundRef 默认为当前净值，与表内金额取大），用于纠正实付价偏离阶梯价时的加仓金额；nextAddAmountBase 为理想剧本表内序列金额。"
    : "当前为「理想阶梯」模式：nextTriggerNav = 上一笔成交净值 × 0.96，nextAddAmount 为表内序列金额。";
  const list = funds.map((fund) => {
    const s = fund.summary || {};
    const st = s.state || {};
    const sig = s.signal || {};
    return {
      code: fund.code,
      name: fund.name,
      level: st.level ?? 0,
      takeProfitPct: toFloat(fund.stopProfitTarget, 20),
      refNav: st.refNav ?? null,
      currentNav: toFloat(fund.currentPrice) || null,
      navDate: fund.jzrq || null,
      actualCost: st.actualCost ?? null,
      shares: st.actualShares ?? null,
      marketValue: st.marketValue ?? null,
      returnRatePct: st.returnRate ?? null,
      signal: sig.state || null,
      nextAddAmount: st.nextAmount ?? null,
      nextAddAmountBase: st.baseAmount ?? null,
      reboundRef: st.reboundRef ?? null,
      nextTriggerNav: st.triggerNav ?? null,
      tpTargetMV: st.tpTargetMV ?? null,
      breakevenPrice: st.breakeven ? st.breakeven.price : null,
      breakevenGapPct: st.breakeven ? st.breakeven.gapPct : null,
      idealTrack: s.ideal || null,
      records: (fund.records || []).map((r) => ({ date: r.buyTime, nav: r.price, amount: r.amount, shares: r.shares })),
      reductions: (fund.reductions || []).map((r) => ({ date: r.reduceTime, nav: r.price, amount: r.amount, shares: r.shares })),
    };
  });
  const prompt = "你是一位专业的基金定投策略分析助手。用户执行「百分之四定投法」：基金净值每下跌 4% 按金字塔序列加仓一笔（首投¥10 的基准序列为 10/10/10/20/40/72/129/233/419/755，随首投金额等比缩放，上限 10 笔），通过几何加仓把浮亏锁定在约 4.76% 以内；当持仓总市值 ≥ 累计成本 × (1+止盈目标%) 时止盈离场，然后等待重开新一轮。" + modeNote + "每只基金的 breakevenPrice 为实际回本价（累计成本÷持仓份额），breakevenGapPct 为现价距回本还差的涨幅（负值表示已回本）。以下是用户全部实盘数据（JSON）：\n\n{FUNDS}\n\n请对每一只基金分别给出：① 当前状态小结（层级、浮盈亏、是否触发加仓/止盈、剩余弹药）；② 短期止盈目标建议（1–3 个月，给出具体百分比与理由）；③ 长期止盈目标建议（6–12 个月，给出具体百分比与理由）；④ 风险提示。要求：止盈目标给明确百分比，区分短期与长期逻辑，最后注明「以上仅为基于历史数据的模型演算，不构成投资建议」。";
  return {
    meta: { strategy: "百分之四定投法", account: store.currentAccount, addMode: mode, exportedAt: nowIso() },
    funds: list,
    prompt,
    text: prompt.replace("{FUNDS}", JSON.stringify(list, null, 2)),
  };
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
async function handle(path, method, url, request, env, ctx) {
  if (path === "/api/state" && method === "GET") {
    const store = await loadStore(env);
    const funds = currentFunds(store);
    const counts = {};
    for (const acc of store.accounts) {
      const n = acc.name;
      counts[n] = (store.fundsByAccount[n] || []).length;
    }
    const settings = await loadSettings(env);
    const addMode = normalizeAddMode(settings.addMode);
    const enriched = sortFundsForView(funds, addMode);
    /* 信号变化推送（配置了 webhook 才动作；不阻塞响应，失败静默） */
    try {
      const notify = maybeNotifySignals(env, store, enriched);
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(notify);
      else await notify;
    } catch { /* 推送失败不影响主流程 */ }
    return json({
      success: true,
      accounts: store.accounts,
      currentAccount: store.currentAccount,
      funds: enriched,
      fundCounts: counts,
      addMode,
    });
  }
  if (path === "/api/settings" && method === "GET") {
    const settings = await loadSettings(env);
    return json({
      success: true,
      data: {
        addMode: normalizeAddMode(settings.addMode),
        strategy: {
          lossCoef: LOSS_COEF,
          dropPct: Math.round((1 - LOSS_COEF) * 1000) / 10,
          addMult: ADD_MULT,
          maxLevel: MAX_LEVEL,
          baseSeq: BASE_SEQ.join(","),
          lossLimit: Math.round((1 - LOSS_COEF) / (ADD_MULT - LOSS_COEF) * 10000) / 100,
          reboundCoef: REBOUND_COEF,
          addModes: ADD_MODES,
          addMode: normalizeAddMode(settings.addMode),
        },
        notify: {
          configured: !!settings.zohoWebhookUrl,
          masked: settings.zohoWebhookUrl ? maskUrl(settings.zohoWebhookUrl) : "",
        },
      },
    });
  }
  if (path === "/api/settings" && method === "POST") {
    const data = await readJson(request);
    const settings = await loadSettings(env);
    const url = (data.zohoWebhookUrl === undefined ? settings.zohoWebhookUrl : String(data.zohoWebhookUrl || "").trim());
    if (url && !/^https?:\/\//.test(url)) {
      return json({ success: false, message: "Webhook 地址须以 http(s):// 开头" }, 400);
    }
    settings.zohoWebhookUrl = url || "";
    /* 加仓模式：ideal=理想阶梯；actual=实际 5% 回本约束。缺省/非法值归一为 ideal */
    if (data.addMode !== undefined) {
      if (!ADD_MODES.includes(data.addMode)) {
        return json({ success: false, message: "加仓模式仅支持 ideal / actual" }, 400);
      }
      settings.addMode = data.addMode;
    }
    await saveSettings(env, settings);
    return json({ success: true, configured: !!settings.zohoWebhookUrl, addMode: normalizeAddMode(settings.addMode) });
  }
  if (path === "/api/notify/test" && method === "POST") {
    const ok = await notifyZoho(env, "【定投导航仪】测试邮件", "<p>这是一封测试邮件。</p><p>收到说明 Webhook 配置正确，后续检测到新加仓/止盈信号时会自动推送。</p>");
    return ok
      ? json({ success: true, msg: "测试邮件已发送" })
      : json({ success: false, message: "发送失败：请检查 Webhook 地址，或服务商未返回 code:200" }, 400);
  }
  if (path === "/api/llm-context" && method === "GET") {
    const store = await loadStore(env);
    const settings = await loadSettings(env);
    const addMode = normalizeAddMode(settings.addMode);
    const enriched = currentFunds(store).map((f) => enrichFund(f, addMode));
    const out = buildLlmContext(store, enriched, addMode);
    if (url.searchParams.get("format") === "text") {
      return new Response(out.text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return json({ success: true, data: out });
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
  async fetch(request, env, ctx) {
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
        const resp = await handle(path, method, url, request, env, ctx);
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
