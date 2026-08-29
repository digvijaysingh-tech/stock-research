// data.js — fetches REAL daily price history for NSE/BSE tickers.
// Strategy: Alpha Vantage (if key present & not preferring Yahoo) -> Yahoo Finance (keyless, via CORS proxy).
// Returns a normalized array: [{ date: 'YYYY-MM-DD', close: Number, high, low, volume }, ...] ascending by date.

const LS_KEY = 'sr_av_key';
const LS_PREFER_YAHOO = 'sr_prefer_yahoo';

// Public CORS proxies tried in order for the keyless Yahoo path.
// (Browsers block Yahoo's endpoint cross-origin; these relay the request.)
const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
];

// Reusable: fetch a URL through the CORS-proxy chain, returning the first success.
// asJson=true parses JSON; otherwise returns text. Throws if all proxies fail.
export async function fetchViaProxy(url, asJson = false) {
  let lastErr;
  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(url));
      if (!res.ok) { lastErr = new Error(`proxy HTTP ${res.status}`); continue; }
      const txt = await res.text();
      if (!txt || txt.length < 10) { lastErr = new Error('empty response'); continue; }
      return asJson ? JSON.parse(txt) : txt;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all proxies failed');
}

export function getApiKey() {
  return (localStorage.getItem(LS_KEY) || '').trim();
}
export function setApiKey(k) {
  if (k) localStorage.setItem(LS_KEY, k.trim());
  else localStorage.removeItem(LS_KEY);
}
export function getPreferYahoo() {
  return localStorage.getItem(LS_PREFER_YAHOO) === '1';
}
export function setPreferYahoo(v) {
  localStorage.setItem(LS_PREFER_YAHOO, v ? '1' : '0');
}

// Alpha Vantage uses ".BSE" suffix for Bombay; NSE symbols often work with ".BSE" too,
// but the reliable free path for Indian equities is Yahoo. We still try AV when a key exists.
function alphaSymbol(ticker, exchange) {
  // Alpha Vantage supports "RELIANCE.BSE"; NSE coverage is spotty on the free tier.
  return `${ticker}.BSE`;
}

// Yahoo symbol: RELIANCE.NS (NSE) or RELIANCE.BO (BSE)
function yahooSymbol(ticker, exchange) {
  return `${ticker}.${exchange}`;
}

async function fetchAlphaVantage(ticker, exchange) {
  const key = getApiKey();
  if (!key) throw new Error('no-key');
  const sym = alphaSymbol(ticker, exchange);
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(sym)}&outputsize=full&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const json = await res.json();
  if (json.Note || json.Information) throw new Error('Alpha Vantage rate limit or notice: ' + (json.Note || json.Information));
  const series = json['Time Series (Daily)'];
  if (!series) throw new Error('Alpha Vantage returned no series (symbol may be unsupported on free tier)');
  const rows = Object.entries(series).map(([date, o]) => ({
    date,
    close: parseFloat(o['4. close']),
    high: parseFloat(o['2. high']),
    low: parseFloat(o['3. low']),
    volume: parseFloat(o['5. volume']),
  }));
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, source: 'Alpha Vantage' };
}

async function fetchYahoo(ticker, exchange) {
  const sym = yahooSymbol(ticker, exchange);
  // 5 years of daily candles.
  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d`;

  let lastErr;
  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(base));
      if (!res.ok) { lastErr = new Error(`proxy HTTP ${res.status}`); continue; }
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) { lastErr = new Error('Yahoo returned no chart data'); continue; }
      const ts = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      const adj = result.indicators?.adjclose?.[0]?.adjclose;
      const rows = [];
      for (let i = 0; i < ts.length; i++) {
        const close = (adj && adj[i] != null) ? adj[i] : q.close?.[i];
        if (close == null) continue;
        rows.push({
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          close,
          high: q.high?.[i] ?? close,
          low: q.low?.[i] ?? close,
          volume: q.volume?.[i] ?? 0,
        });
      }
      if (!rows.length) { lastErr = new Error('Yahoo series empty'); continue; }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      const meta = result.meta || {};
      return { rows, source: 'Yahoo Finance', meta };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Yahoo proxies failed');
}

// Main entry. onStatus(msg) reports progress to the UI.
export async function fetchHistory(ticker, exchange, onStatus = () => {}) {
  ticker = ticker.trim().toUpperCase();
  const preferYahoo = getPreferYahoo();
  const hasKey = !!getApiKey();

  const attempts = [];
  if (!preferYahoo && hasKey) attempts.push(['Alpha Vantage', () => fetchAlphaVantage(ticker, exchange)]);
  attempts.push(['Yahoo Finance', () => fetchYahoo(ticker, exchange)]);
  if (preferYahoo && hasKey) attempts.push(['Alpha Vantage', () => fetchAlphaVantage(ticker, exchange)]);

  let lastErr;
  for (const [name, fn] of attempts) {
    try {
      onStatus(`Fetching from ${name}…`);
      const out = await fn();
      if (out.rows.length < 60) throw new Error(`${name}: only ${out.rows.length} data points — need more history`);
      return out;
    } catch (e) {
      lastErr = e;
      onStatus(`${name} failed (${e.message}). Trying next source…`);
    }
  }
  throw new Error(
    `Could not fetch data for ${ticker}.${exchange}. ` +
    `Last error: ${lastErr?.message || 'unknown'}. ` +
    `Tip: check the ticker symbol, try the other exchange, add an Alpha Vantage key, ` +
    `or a public CORS proxy may be temporarily down.`
  );
}
