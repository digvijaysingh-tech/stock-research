// screener.mjs — runs server-side in GitHub Actions (no CORS, fast).
// Scans a universe of NSE stocks, computes:
//   1. Top gainers / top losers (by day % change)
//   2. A transparent breakout screener ("AI watchlist") ranking stocks likely to break out.
// Writes the result to data/market.json, which the static site reads instantly.
//
// This is a QUANTITATIVE screener, not a live LLM. Every pick shows its scored reasons.
// Run: node scripts/screener.mjs

import { writeFileSync, mkdirSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };

// Nifty-100-ish universe (liquid large/mid caps). Curated to valid Yahoo .NS symbols.
const UNIVERSE = [
  'RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK','SBIN','ITC','WIPRO','BAJFINANCE','LT',
  'AXISBANK','MARUTI','SUNPHARMA','HINDUNILVR','ADANIENT','TITAN','ASIANPAINT','KOTAKBANK','HCLTECH','ONGC',
  'BHARTIARTL','NTPC','POWERGRID','NESTLEIND','ULTRACEMCO','TATASTEEL','JSWSTEEL','COALINDIA','GRASIM','TECHM',
  'ADANIPORTS','BAJAJFINSV','DRREDDY','CIPLA','BRITANNIA','EICHERMOT','HEROMOTOCO','DIVISLAB','HINDALCO','BPCL',
  'INDUSINDBK','APOLLOHOSP','TATACONSUM','BAJAJ-AUTO','SBILIFE','HDFCLIFE','DABUR','GAIL','DLF','VEDL',
  'PIDILITIND','GODREJCP','SIEMENS','PNB','BANKBARODA','ETERNAL','ADANIGREEN','ADANIPOWER','IOC','LTIMINDTREE',
  'AMBUJACEM','BEL','TRENT','VBL','CHOLAFIN','ICICIPRULI','TVSMOTOR','HAVELLS','SHREECEM',
];

const CONCURRENCY = 6;

async function fetchHistory(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?range=1y&interval=1d`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  if (!r) throw new Error('no result');
  const q = r.indicators.quote[0];
  const closes = [], vols = [], highs = [], lows = [];
  (r.timestamp || []).forEach((t, i) => {
    if (q.close[i] != null) {
      closes.push(q.close[i]);
      vols.push(q.volume[i] || 0);
      highs.push(q.high[i] ?? q.close[i]);
      lows.push(q.low[i] ?? q.close[i]);
    }
  });
  const price = r.meta.regularMarketPrice ?? closes.at(-1);
  // Day change from the last two actual closes — reliable. (meta.chartPreviousClose on a
  // 1y range is NOT the prior trading day and produces wildly wrong % changes.)
  const prev = closes.length >= 2 ? closes.at(-2) : price;
  return { sym, name: r.meta.shortName || sym, price, prev, closes, vols, highs, lows };
}

function sma(a, p) { if (a.length < p) return null; return a.slice(-p).reduce((x, y) => x + y, 0) / p; }

// Breakout score in 0..100 with transparent reasons.
function breakoutScore(d) {
  const c = d.closes;
  if (c.length < 60 || !d.price) return null;
  const price = d.price;
  const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200);
  const hi52 = Math.max(...d.highs.slice(-252));
  const lo52 = Math.min(...d.lows.slice(-252));
  const nearHigh = price / hi52;
  const volAvg = sma(d.vols, 20), volRecent = sma(d.vols, 3);
  const volSurge = volAvg ? volRecent / volAvg : 1;
  const ret20 = c.length > 21 ? price / c.at(-21) - 1 : 0;
  const w = c.slice(-20), m = w.reduce((a, b) => a + b, 0) / w.length;
  const tight = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length) / m;

  let score = 0;
  const reasons = [];
  if (s200 && price > s200) { score += 20; reasons.push('Above 200-day average (uptrend)'); }
  if (s50 && price > s50) { score += 15; reasons.push('Above 50-day average'); }
  if (s20 && price > s20) { score += 10; reasons.push('Above 20-day average'); }
  if (nearHigh > 0.97) { score += 25; reasons.push(`At ${(nearHigh * 100).toFixed(0)}% of 52-week high — breakout zone`); }
  else if (nearHigh > 0.90) { score += 15; reasons.push(`Approaching 52-week high (${(nearHigh * 100).toFixed(0)}%)`); }
  else if (nearHigh > 0.80) { score += 6; reasons.push('Building toward 52-week high'); }
  if (volSurge > 2) { score += 15; reasons.push(`Strong volume surge (${volSurge.toFixed(1)}x avg)`); }
  else if (volSurge > 1.3) { score += 8; reasons.push(`Rising volume (${volSurge.toFixed(1)}x avg)`); }
  if (ret20 > 0.10) { score += 15; reasons.push(`Strong 1-month momentum (+${(ret20 * 100).toFixed(0)}%)`); }
  else if (ret20 > 0.03) { score += 8; reasons.push(`Positive 1-month momentum (+${(ret20 * 100).toFixed(0)}%)`); }
  if (tight < 0.03 && ret20 > 0) { score += 10; reasons.push('Tight consolidation — coiled for a move'); }

  const dayChg = d.prev ? ((price - d.prev) / d.prev) * 100 : 0;
  return {
    sym: d.sym, name: d.name, price: round(price), dayChg: round(dayChg),
    score: Math.min(100, score), nearHighPct: round(nearHigh * 100), volSurge: round(volSurge, 1),
    ret1m: round(ret20 * 100), hi52: round(hi52), lo52: round(lo52), reasons,
  };
}
function round(v, dp = 2) { const f = 10 ** dp; return Math.round(v * f) / f; }

async function main() {
  const queue = [...UNIVERSE];
  const data = [];
  const failed = [];
  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      try { data.push(await fetchHistory(sym)); }
      catch (e) { failed.push(sym); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const scored = data.map(breakoutScore).filter(Boolean);

  // Gainers / losers by day change
  const byDay = [...scored].filter((s) => Number.isFinite(s.dayChg)).sort((a, b) => b.dayChg - a.dayChg);
  const gainers = byDay.slice(0, 8);
  const losers = byDay.slice(-8).reverse();

  // Breakout watchlist: top by breakout score, require a minimum quality bar
  const watchlist = [...scored]
    .filter((s) => s.score >= 55)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const payload = {
    generatedAt: new Date().toISOString(),
    universeSize: UNIVERSE.length,
    scanned: data.length,
    failed,
    gainers: gainers.map(slim),
    losers: losers.map(slim),
    watchlist, // keep full detail (reasons) for the AI watchlist
  };

  mkdirSync('data', { recursive: true });
  writeFileSync('data/market.json', JSON.stringify(payload, null, 2));
  console.log(`Wrote data/market.json — scanned ${data.length}/${UNIVERSE.length}, ${failed.length} failed, ${watchlist.length} breakout picks.`);
}

function slim(s) {
  return { sym: s.sym, name: s.name, price: s.price, dayChg: s.dayChg, ret1m: s.ret1m, nearHighPct: s.nearHighPct };
}

main().catch((e) => { console.error('Screener failed:', e); process.exit(1); });
