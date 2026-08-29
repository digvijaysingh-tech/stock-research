// context.js — the "reads the world" layer: news, headline sentiment, fundamentals,
// earnings, macro backdrop, and Reddit discussions. All fetched client-side.
//
// HONEST LIMITS (verified live):
//  - News & macro: keyless via Google News RSS / Yahoo (through CORS proxy). Reliable.
//  - Fundamentals & earnings: need an Alpha Vantage key (Yahoo now requires an auth crumb).
//  - Filings: no free CORS-accessible India-filings API — surfaced through news headlines.
//  - Reddit: blocks anonymous access (HTTP 403) intermittently; best-effort with graceful fallback.

import { fetchViaProxy, getApiKey } from './data.js';

// ---------------- News (Google News RSS) ----------------
// RSS is XML; we use DOMParser (browser) to extract items safely — no innerHTML.
export async function fetchNews(ticker, companyName) {
  const query = `${companyName || ticker} stock NSE`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const xml = await fetchViaProxy(url, false);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const items = [...doc.querySelectorAll('item')].slice(0, 12).map((it) => {
    const title = it.querySelector('title')?.textContent || '';
    const link = it.querySelector('link')?.textContent || '';
    const pubDate = it.querySelector('pubDate')?.textContent || '';
    // Google News titles are "Headline - Source"
    const dash = title.lastIndexOf(' - ');
    return {
      title: dash > 0 ? title.slice(0, dash) : title,
      source: dash > 0 ? title.slice(dash + 3) : '',
      link,
      date: pubDate ? pubDate.slice(0, 16) : '',
    };
  });
  return items;
}

// ---------------- Headline sentiment (lightweight lexicon) ----------------
const POS = ['surge','soar','jump','rally','gain','rise','profit','beat','upgrade','record','high','strong','growth','buy','outperform','bullish','wins','order','deal','expansion','boost','top','robust','recovery','dividend','bonus'];
const NEG = ['fall','drop','plunge','slump','loss','miss','downgrade','low','weak','decline','sell','underperform','bearish','cut','probe','fraud','fine','penalty','lawsuit','concern','warn','crash','slide','debt','stake sale','resign'];

export function scoreHeadlines(items) {
  if (!items.length) return { score: 0, pos: 0, neg: 0, neutral: 0, n: 0 };
  let pos = 0, neg = 0;
  for (const it of items) {
    const t = it.title.toLowerCase();
    let s = 0;
    for (const w of POS) if (t.includes(w)) s++;
    for (const w of NEG) if (t.includes(w)) s--;
    it.sentiment = s > 0 ? 'pos' : s < 0 ? 'neg' : 'neu';
    if (s > 0) pos++; else if (s < 0) neg++;
  }
  const neutral = items.length - pos - neg;
  // Net score in [-1, 1]
  const score = (pos - neg) / items.length;
  return { score, pos, neg, neutral, n: items.length };
}

// ---------------- Fundamentals + Earnings (Alpha Vantage) ----------------
export async function fetchFundamentals(ticker) {
  const key = getApiKey();
  if (!key) return { available: false, reason: 'no-key' };
  const sym = `${ticker}.BSE`;
  try {
    const [ov, ea] = await Promise.all([
      fetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(sym)}&apikey=${key}`).then((r) => r.json()),
      fetch(`https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(sym)}&apikey=${key}`).then((r) => r.json()),
    ]);
    if (ov.Note || ov.Information) return { available: false, reason: 'rate-limit' };
    if (!ov.Symbol && !ov.Name) return { available: false, reason: 'unsupported' };
    const quarters = (ea.quarterlyEarnings || []).slice(0, 4).map((q) => ({
      date: q.fiscalDateEnding,
      reported: num(q.reportedEPS),
      estimated: num(q.estimatedEPS),
      surprisePct: num(q.surprisePercentage),
    }));
    return {
      available: true,
      name: ov.Name,
      sector: ov.Sector,
      industry: ov.Industry,
      pe: num(ov.PERatio),
      forwardPe: num(ov.ForwardPE),
      eps: num(ov.EPS),
      pegRatio: num(ov.PEGRatio),
      marketCap: num(ov.MarketCapitalization),
      dividendYield: num(ov.DividendYield),
      profitMargin: num(ov.ProfitMargin),
      roe: num(ov.ReturnOnEquityTTM),
      analystTarget: num(ov.AnalystTargetPrice),
      week52High: num(ov['52WeekHigh']),
      week52Low: num(ov['52WeekLow']),
      quarters,
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

// ---------------- Macro backdrop (Yahoo, keyless via proxy) ----------------
const MACRO = [
  { key: 'nifty', label: 'Nifty 50', sym: '^NSEI' },
  { key: 'sensex', label: 'Sensex', sym: '^BSESN' },
  { key: 'vix', label: 'India VIX', sym: '^INDIAVIX' },
  { key: 'usdinr', label: 'USD/INR', sym: 'INR=X' },
  { key: 'crude', label: 'Crude (Brent)', sym: 'BZ=F' },
];

export async function fetchMacro() {
  const out = [];
  await Promise.all(MACRO.map(async (m) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.sym)}?range=5d&interval=1d`;
      const j = await fetchViaProxy(url, true);
      const r = j?.chart?.result?.[0];
      const price = r?.meta?.regularMarketPrice;
      const prevClose = r?.meta?.chartPreviousClose ?? r?.meta?.previousClose;
      if (price != null) {
        const chgPct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
        out.push({ ...m, price, chgPct });
      }
    } catch { /* skip this macro item */ }
  }));
  // Preserve declared order
  return MACRO.map((m) => out.find((o) => o.key === m.key)).filter(Boolean);
}

// Turn VIX into a plain-English risk note
export function macroRiskNote(macro) {
  const vix = macro.find((m) => m.key === 'vix');
  if (!vix) return null;
  if (vix.price > 20) return { level: 'elevated', text: `India VIX at ${vix.price.toFixed(1)} — market fear is elevated; expect wider swings.` };
  if (vix.price > 14) return { level: 'moderate', text: `India VIX at ${vix.price.toFixed(1)} — moderate volatility regime.` };
  return { level: 'calm', text: `India VIX at ${vix.price.toFixed(1)} — market volatility is low/complacent.` };
}

// ---------------- Reddit (best-effort; graceful fallback) ----------------
export async function fetchReddit(ticker, companyName) {
  const searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(ticker)}&sort=new&limit=8&restrict_sr=&t=month`;
  const browseLink = `https://www.reddit.com/search/?q=${encodeURIComponent(ticker + ' OR ' + (companyName || ''))}&sort=new`;
  try {
    const j = await fetchViaProxy(searchUrl, true);
    const posts = (j?.data?.children || [])
      .map((c) => c.data)
      .filter((d) => d && d.title)
      .slice(0, 6)
      .map((d) => ({
        title: d.title,
        subreddit: 'r/' + d.subreddit,
        score: d.score,
        comments: d.num_comments,
        link: 'https://www.reddit.com' + d.permalink,
      }));
    if (posts.length) return { available: true, posts, browseLink };
    return { available: false, reason: 'no-posts', browseLink };
  } catch (e) {
    // Reddit frequently blocks anonymous/proxied access — degrade gracefully.
    return { available: false, reason: 'blocked', browseLink };
  }
}
