// dashboard.js — the interactive live dashboard: clock, live indices, gainers/losers,
// AI breakout watchlist (from data/market.json, refreshed every 4h by GitHub Actions),
// and a personal localStorage watchlist.
//
// Exposes init(onPickTicker) — onPickTicker(sym) is called when the user clicks any row,
// so app.js can run a full analysis for that stock.

import { fetchViaProxy } from './data.js';

const LS_WATCH = 'sr_watchlist';
const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

// ---- tiny DOM builder (textContent-only, XSS-safe) ----
function h(tag, opts = {}, children = []) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
  if (opts.on) for (const [k, v] of Object.entries(opts.on)) el.addEventListener(k, v);
  for (const c of [].concat(children)) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}
function clear(el) { while (el.firstChild) el.firstChild.remove(); }
const $ = (id) => document.getElementById(id);

let onPick = () => {};

export function initDashboard(onPickTicker) {
  onPick = onPickTicker || (() => {});
  startClock();
  loadLiveMarket();
  setInterval(loadLiveMarket, 60_000); // refresh live indices every 60s
  loadMarketData();                    // gainers/losers + AI watchlist from JSON
  initMyWatchlist();
}

// ---------------- Live clock (updates every second) ----------------
function startClock() {
  const timeEl = $('clockTime');
  const dateEl = $('clockDate');
  const tick = () => {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString('en-IN', { hour12: false });
    dateEl.textContent = now.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  };
  tick();
  setInterval(tick, 1000);
}

// ---------------- Live market indices (every 60s) ----------------
const LIVE = [
  { key: 'nifty', label: 'Nifty 50', sym: '^NSEI' },
  { key: 'sensex', label: 'Sensex', sym: '^BSESN' },
  { key: 'banknifty', label: 'Bank Nifty', sym: '^NSEBANK' },
  { key: 'vix', label: 'India VIX', sym: '^INDIAVIX' },
  { key: 'usdinr', label: 'USD/INR', sym: 'INR=X' },
  { key: 'crude', label: 'Brent Crude', sym: 'BZ=F' },
];

async function loadLiveMarket() {
  const grid = $('liveMarketGrid');
  const status = $('liveStatus');
  const results = [];
  await Promise.all(LIVE.map(async (m) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.sym)}?range=1d&interval=5m`;
      const j = await fetchViaProxy(url, true);
      const r = j?.chart?.result?.[0];
      const price = r?.meta?.regularMarketPrice;
      const prev = r?.meta?.chartPreviousClose ?? r?.meta?.previousClose;
      if (price != null) results.push({ ...m, price, chgPct: prev ? ((price - prev) / prev) * 100 : null });
    } catch { /* skip */ }
  }));

  if (!results.length) {
    status.textContent = '● unavailable';
    status.className = 'live-status error';
    if (!grid.childElementCount) grid.appendChild(h('p', { class: 'muted small', text: 'Live indices unavailable right now (CORS proxy may be down). Retrying in 60s…' }));
    return;
  }
  status.textContent = '● live · ' + new Date().toLocaleTimeString('en-IN', { hour12: false });
  status.className = 'live-status';

  clear(grid);
  LIVE.forEach((m) => {
    const d = results.find((x) => x.key === m.key);
    if (!d) return;
    const up = (d.chgPct ?? 0) >= 0;
    const chg = d.chgPct != null ? `${up ? '▲ +' : '▼ '}${d.chgPct.toFixed(2)}%` : '—';
    grid.appendChild(h('div', { class: 'macro-item' }, [
      h('div', { class: 'm-label', text: m.label }),
      h('div', { class: 'm-price', text: INR.format(d.price) }),
      h('div', { class: `m-chg ${up ? 'up' : 'down'}`, text: chg }),
    ]));
  });
}

// ---------------- Market data JSON (gainers/losers + AI watchlist) ----------------
async function loadMarketData() {
  try {
    // Cache-bust so we always get the latest committed refresh.
    const res = await fetch('data/market.json?t=' + Math.floor(Date.now() / 60000));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    renderMovers($('gainersList'), d.gainers || []);
    renderMovers($('losersList'), d.losers || []);
    renderAiWatchlist(d.watchlist || [], d.generatedAt);
  } catch (e) {
    renderMoversError($('gainersList'));
    renderMoversError($('losersList'));
    $('aiWatchlist').appendChild(h('p', { class: 'muted small',
      text: 'Breakout watchlist will appear once the scheduled screener has run at least once (Actions tab → "Refresh market data" → Run workflow).' }));
  }
}

function moverRow(m, opts = {}) {
  const up = (m.dayChg ?? 0) >= 0;
  const right = h('div', { class: 'm-right' }, [
    h('div', { class: 'm-price', text: '₹' + INR.format(m.price) }),
    h('div', { class: `m-chg ${up ? 'up' : 'down'}`, text: m.dayChg != null ? `${up ? '+' : ''}${m.dayChg.toFixed(2)}%` : '' }),
  ]);
  const left = h('div', {}, [
    h('div', { class: 'm-sym', text: m.sym }),
    m.name ? h('div', { class: 'm-name', text: m.name }) : null,
  ]);
  const children = [left, right];
  if (opts.removable) {
    children.push(h('button', { class: 'm-remove', text: '✕', attrs: { title: 'Remove', 'aria-label': 'Remove ' + m.sym },
      on: { click: (ev) => { ev.stopPropagation(); opts.onRemove(m.sym); } } }));
  }
  return h('div', { class: 'mover-row', on: { click: () => onPick(m.sym) } }, children);
}

function renderMovers(el, list) {
  clear(el);
  if (!list.length) { el.appendChild(h('div', { class: 'mover-empty', text: 'No data yet.' })); return; }
  list.forEach((m) => el.appendChild(moverRow(m)));
}
function renderMoversError(el) {
  clear(el);
  el.appendChild(h('div', { class: 'mover-empty', text: 'Waiting for the scheduled screener to publish data/market.json.' }));
}

function renderAiWatchlist(list, generatedAt) {
  const el = $('aiWatchlist');
  clear(el);
  const stamp = $('watchlistStamp');
  if (generatedAt) {
    const ago = timeAgo(new Date(generatedAt));
    stamp.textContent = `updated ${ago}`;
  }
  if (!list.length) {
    el.appendChild(h('p', { class: 'muted small', text: 'No breakout candidates cleared the quality bar in the latest scan.' }));
    return;
  }
  list.forEach((w, i) => {
    const head = h('div', { class: 'ai-item-head' }, [
      h('div', {}, [
        h('span', { class: 'ai-rank', text: `#${i + 1}  ` }),
        h('span', { class: 'ai-sym', text: w.sym }),
        w.name ? h('span', { class: 'm-name', text: '  ' + w.name }) : null,
      ]),
      h('span', { class: 'ai-score', text: `breakout ${w.score}/100` }),
    ]);
    const metrics = h('div', { class: 'ai-metrics',
      text: `₹${INR.format(w.price)} · ${w.nearHighPct}% of 52w high · ${w.ret1m >= 0 ? '+' : ''}${w.ret1m}% 1mo · vol ${w.volSurge}x` });
    const reasons = h('div', { class: 'ai-reasons' }, (w.reasons || []).map((r) => h('span', { class: 'ai-reason', text: r })));
    el.appendChild(h('div', { class: 'ai-item', on: { click: () => onPick(w.sym) } }, [head, metrics, reasons]));
  });
}

function timeAgo(date) {
  const secs = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

// ---------------- Personal watchlist (localStorage) ----------------
function getWatch() {
  try { return JSON.parse(localStorage.getItem(LS_WATCH) || '[]'); } catch { return []; }
}
function setWatch(arr) { localStorage.setItem(LS_WATCH, JSON.stringify([...new Set(arr)])); }

function initMyWatchlist() {
  const form = $('watchAddForm');
  const input = $('watchAddInput');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const sym = input.value.trim().toUpperCase();
    if (!sym) return;
    setWatch([...getWatch(), sym]);
    input.value = '';
    renderMyWatchlist();
  });
  renderMyWatchlist();
}

// Fetch a light quote for each watchlist symbol (price + day change).
async function quoteOne(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?range=5d&interval=1d`;
  const j = await fetchViaProxy(url, true);
  const r = j?.chart?.result?.[0];
  const closes = (r?.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
  const price = r?.meta?.regularMarketPrice ?? closes.at(-1);
  const prev = closes.length >= 2 ? closes.at(-2) : price;
  return { sym, name: r?.meta?.shortName || sym, price, dayChg: prev ? ((price - prev) / prev) * 100 : null };
}

async function renderMyWatchlist() {
  const el = $('myWatchlist');
  const syms = getWatch();
  clear(el);
  if (!syms.length) {
    el.appendChild(h('div', { class: 'mover-empty', text: 'Your watchlist is empty. Add a ticker above, or click any stock to analyze it.' }));
    return;
  }
  // Show placeholders immediately, then fill in as quotes arrive.
  syms.forEach((sym) => {
    const row = moverRow({ sym, price: 0, dayChg: null }, { removable: true, onRemove: removeFromWatch });
    row.dataset.sym = sym;
    el.appendChild(row);
  });
  for (const sym of syms) {
    try {
      const q = await quoteOne(sym);
      const fresh = moverRow(q, { removable: true, onRemove: removeFromWatch });
      const old = el.querySelector(`[data-sym="${sym}"]`);
      if (old) { fresh.dataset.sym = sym; old.replaceWith(fresh); }
    } catch { /* leave placeholder */ }
  }
}

function removeFromWatch(sym) {
  setWatch(getWatch().filter((s) => s !== sym));
  renderMyWatchlist();
}
