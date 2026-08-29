// app.js — UI orchestration: fetch -> compute indicators -> signal -> projection -> render.
import { fetchHistory, getApiKey, setApiKey, getPreferYahoo, setPreferYahoo } from './data.js';
import { sma, ema, rsi, macd, bollinger, logReturns, annualizedVol, fiftyTwoWeek } from './indicators.js';
import { computeSignal } from './signal.js';
import { estimateParams, project, weeklyHorizons, monthlyHorizons } from './projection.js';
import { fetchNews, scoreHeadlines, fetchFundamentals, fetchMacro, macroRiskNote, fetchReddit } from './context.js';
import { initDashboard } from './dashboard.js';

const QUICK = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'ITC', 'TATAMOTORS', 'WIPRO', 'BAJFINANCE'];
const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

let state = {
  rows: null, exchange: 'NS', ticker: '', meta: null, source: '',
  range: '1y', drift: 'full', analysis: null,
};
let charts = {};

// ---------- tiny DOM builder (textContent-only, no innerHTML → XSS-safe) ----------
function h(tag, opts = {}, children = []) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
  if (opts.on) for (const [k, v] of Object.entries(opts.on)) el.addEventListener(k, v);
  for (const c of [].concat(children)) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const els = {
  form: $('searchForm'), ticker: $('tickerInput'), exchange: $('exchangeSelect'),
  quickPicks: $('quickPicks'), results: $('results'), loader: $('loader'), loaderText: $('loaderText'),
  errorBox: $('errorBox'),
  stockName: $('stockName'), lastPrice: $('lastPrice'), priceChange: $('priceChange'), asOf: $('asOf'),
  signalBadge: $('signalBadge'), signalText: $('signalText'), signalScore: $('signalScore'),
  verdictSummary: $('verdictSummary'), rationaleList: $('rationaleList'),
  indicatorGrid: $('indicatorGrid'), weeksTable: $('weeksTable'), monthsTable: $('monthsTable'),
  rangeToggle: $('rangeToggle'), driftToggle: $('driftToggle'),
  settingsBtn: $('settingsBtn'), settingsDrawer: $('settingsDrawer'), closeDrawer: $('closeDrawer'),
  apiKeyInput: $('apiKeyInput'), saveKeyBtn: $('saveKeyBtn'), clearKeyBtn: $('clearKeyBtn'),
  preferYahoo: $('preferYahoo'),
  macroGrid: $('macroGrid'), macroNote: $('macroNote'),
  fundamentalsBody: $('fundamentalsBody'),
  newsList: $('newsList'), newsSentimentBadge: $('newsSentimentBadge'),
  redditBody: $('redditBody'),
};

// ---------- Quick picks ----------
QUICK.forEach((t) => {
  els.quickPicks.appendChild(h('span', {
    class: 'qp-chip', text: t,
    on: { click: () => { els.ticker.value = t; els.form.requestSubmit(); } },
  }));
});

// ---------- Settings drawer ----------
els.settingsBtn.onclick = () => {
  els.apiKeyInput.value = getApiKey();
  els.preferYahoo.checked = getPreferYahoo();
  els.settingsDrawer.classList.remove('hidden');
};
els.closeDrawer.onclick = () => els.settingsDrawer.classList.add('hidden');
els.saveKeyBtn.onclick = () => { setApiKey(els.apiKeyInput.value); flash(els.saveKeyBtn, 'Saved ✓'); };
els.clearKeyBtn.onclick = () => { setApiKey(''); els.apiKeyInput.value = ''; flash(els.clearKeyBtn, 'Cleared'); };
els.preferYahoo.onchange = () => setPreferYahoo(els.preferYahoo.checked);
function flash(btn, msg) { const old = btn.textContent; btn.textContent = msg; setTimeout(() => (btn.textContent = old), 1200); }

// ---------- Toggles ----------
els.rangeToggle.querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    els.rangeToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.range = b.dataset.range;
    if (state.rows) { renderPriceChart(); renderRsiChart(); renderMacdChart(); }
  };
});
els.driftToggle.querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    els.driftToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.drift = b.dataset.drift;
    if (state.analysis) renderProjection();
  };
});

// ---------- Submit ----------
els.form.onsubmit = async (e) => {
  e.preventDefault();
  const ticker = els.ticker.value.trim().toUpperCase();
  if (!ticker) return;
  state.ticker = ticker;
  state.exchange = els.exchange.value;
  await runAnalysis();
};

function showLoader(msg) { els.loaderText.textContent = msg || 'Fetching market data…'; els.loader.classList.remove('hidden'); els.errorBox.classList.add('hidden'); }
function hideLoader() { els.loader.classList.add('hidden'); }
function showError(msg) { els.errorBox.textContent = msg; els.errorBox.classList.remove('hidden'); hideLoader(); }

async function runAnalysis() {
  showLoader('Fetching market data…');
  els.results.classList.add('hidden');
  try {
    const { rows, source, meta } = await fetchHistory(state.ticker, state.exchange, (m) => (els.loaderText.textContent = m));
    state.rows = rows; state.source = source; state.meta = meta || null;
    computeAll();
    hideLoader();
    els.results.classList.remove('hidden');
    els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Load the "reads the world" context asynchronously — never blocks core analysis.
    loadContext();
  } catch (err) {
    showError(err.message);
  }
}

// ---------- Context (news / fundamentals / macro / reddit) ----------
// Each feed is independent and best-effort: one failing never breaks the others.
async function loadContext() {
  const name = state.meta?.shortName || state.meta?.longName || state.ticker;
  setPlaceholder(els.macroGrid, 'Loading market backdrop…');
  setPlaceholder(els.fundamentalsBody, 'Loading fundamentals…');
  setPlaceholder(els.newsList, 'Loading news…', 'li');
  setPlaceholder(els.redditBody, 'Loading Reddit discussions…');

  // News first — it feeds back into the signal score.
  fetchNews(state.ticker, name)
    .then((items) => { const s = scoreHeadlines(items); renderNews(items, s); rescoreWithNews(s); })
    .catch(() => renderFeedError(els.newsList, 'Could not load news (a CORS proxy may be down). Try again shortly.', 'li'));

  fetchMacro()
    .then(renderMacro)
    .catch(() => renderFeedError(els.macroGrid, 'Could not load market backdrop right now.'));

  fetchFundamentals(state.ticker)
    .then(renderFundamentals)
    .catch(() => renderFeedError(els.fundamentalsBody, 'Could not load fundamentals.'));

  fetchReddit(state.ticker, name)
    .then(renderReddit)
    .catch(() => renderReddit({ available: false, reason: 'blocked', browseLink: `https://www.reddit.com/search/?q=${encodeURIComponent(state.ticker)}` }));
}

function setPlaceholder(el, msg, childTag) {
  clear(el);
  const node = childTag === 'li' ? h('li', { class: 'muted small', text: msg }) : h('p', { class: 'muted small', text: msg });
  el.appendChild(node);
}
function renderFeedError(el, msg, childTag) { setPlaceholder(el, msg, childTag); }

// ---------- Compute ----------
function computeAll() {
  const rows = state.rows;
  const closes = rows.map((r) => r.close);
  const n = closes.length;
  const price = closes[n - 1];
  const prev = closes[n - 2];

  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const e20 = ema(closes, 20);
  const rsiArr = rsi(closes, 14);
  const macdObj = macd(closes);
  const boll = bollinger(closes, 20, 2);
  const rets = logReturns(closes);
  const annVol = annualizedVol(rets.slice(-252));
  const week52 = fiftyTwoWeek(rows);
  const recentReturn20 = n > 21 ? (price / closes[n - 21] - 1) : null;
  const last = (arr) => arr[arr.length - 1];

  const sigContext = {
    price,
    sma20: last(s20), sma50: last(s50), sma200: last(s200),
    rsiVal: last(rsiArr),
    macdVal: last(macdObj.macd), macdSignal: last(macdObj.signal), macdHist: last(macdObj.hist),
    boll: { upper: last(boll.upper), lower: last(boll.lower), mid: last(boll.mid) },
    week52, annVol, recentReturn20, newsSentiment: null,
  };
  const sig = computeSignal(sigContext);

  const { mu, sigma, nReturns } = estimateParams(closes, 252);
  state.analysis = { closes, price, prev, s20, s50, s200, e20, rsiArr, macdObj, boll, annVol, week52, recentReturn20, sig, mu, sigma, nReturns, sigContext };

  renderHeadline();
  renderSignal();
  renderIndicators();
  renderPriceChart();
  renderRsiChart();
  renderMacdChart();
  renderProjection();
}

// ---------- Render: headline ----------
function renderHeadline() {
  const a = state.analysis;
  const name = state.meta?.shortName || state.meta?.longName || `${state.ticker} (${state.exchange})`;
  els.stockName.textContent = `${name} · ${state.ticker}.${state.exchange}`;
  els.lastPrice.textContent = '₹' + INR.format(a.price);
  const chg = a.price - a.prev;
  const pct = (chg / a.prev) * 100;
  const up = chg >= 0;
  els.priceChange.textContent = `${up ? '▲' : '▼'} ${up ? '+' : ''}${INR.format(chg)} (${up ? '+' : ''}${pct.toFixed(2)}%)`;
  els.priceChange.className = 'price-change ' + (up ? 'up' : 'down');
  els.asOf.textContent = `as of ${state.rows[state.rows.length - 1].date} · source: ${state.source}`;
}

// ---------- Render: signal + verdict ----------
function renderSignal() {
  const { sig } = state.analysis;
  els.signalBadge.className = 'signal-badge ' + sig.klass;
  els.signalText.textContent = sig.verdict;
  els.signalScore.textContent = `score ${sig.score > 0 ? '+' : ''}${sig.score} / 100`;

  const dir = sig.verdict === 'BULLISH' ? 'lean up' : sig.verdict === 'BEARISH' ? 'lean down' : 'be range-bound / mixed';
  const conf = Math.abs(sig.score) >= 55 ? 'strong' : Math.abs(sig.score) >= 25 ? 'moderate' : 'weak';
  els.verdictSummary.textContent =
    `Based on ${sig.factors.length} technical factors, the weight of evidence is ${sig.verdict.toLowerCase()} ` +
    `(${conf} conviction). Over the coming weeks the indicators ${dir}. This stock's realized volatility is ` +
    `${sig.volNote} (${(sig.annVol * 100).toFixed(0)}% annualized) — which is why the projection cones below ` +
    `${sig.annVol > 0.4 ? 'fan out widely' : 'are relatively contained'}. The signal is only as good as these ` +
    `inputs and cannot see news, earnings, or macro shocks.`;

  clear(els.rationaleList);
  [...sig.factors].sort((x, y) => Math.abs(y.points) - Math.abs(x.points)).forEach((f) => {
    const cls = f.points > 1 ? 'pos' : f.points < -1 ? 'neg' : 'neu';
    const sign = f.points > 0 ? '+' : '';
    els.rationaleList.appendChild(h('li', {}, [
      h('span', { class: `tag ${cls}`, text: `${f.label} ${sign}${f.points.toFixed(0)}` }),
      h('span', { text: f.reason }),
    ]));
  });
}

// ---------- Render: indicators ----------
function renderIndicators() {
  const a = state.analysis;
  const last = (arr) => arr[arr.length - 1];
  const rsiVal = last(a.rsiArr);
  const cells = [
    ['Last price', '₹' + INR.format(a.price), ''],
    ['SMA 20', fmtOrDash(last(a.s20)), pos(a.price, last(a.s20))],
    ['SMA 50', fmtOrDash(last(a.s50)), pos(a.price, last(a.s50))],
    ['SMA 200', fmtOrDash(last(a.s200)), pos(a.price, last(a.s200))],
    ['RSI (14)', rsiVal != null ? rsiVal.toFixed(1) : '—', rsiNote(rsiVal)],
    ['52w high', fmtOrDash(a.week52.high), ''],
    ['52w low', fmtOrDash(a.week52.low), ''],
    ['Annualized vol', (a.annVol * 100).toFixed(1) + '%', a.annVol > 0.4 ? 'high' : 'normal'],
    ['~1M return', a.recentReturn20 != null ? (a.recentReturn20 * 100).toFixed(1) + '%' : '—', ''],
    ['Data points', a.closes.length + ' days', ''],
  ];
  clear(els.indicatorGrid);
  cells.forEach(([label, val, note]) => {
    const noteCls = note === 'above' || note === 'high' ? 'up' : note === 'below' ? 'down' : 'muted';
    els.indicatorGrid.appendChild(h('div', { class: 'indicator' }, [
      h('div', { class: 'ind-label', text: label }),
      h('div', { class: 'ind-value', text: val }),
      note ? h('div', { class: `ind-note ${noteCls}`, text: note }) : null,
    ]));
  });
}
function fmtOrDash(v) { return v != null ? '₹' + INR.format(v) : '—'; }
function pos(price, ma) { return ma == null ? '' : price > ma ? 'above' : 'below'; }
function rsiNote(v) { if (v == null) return ''; if (v >= 70) return 'overbought'; if (v <= 30) return 'oversold'; return 'neutral'; }

// ---------- Charts ----------
function sliceByRange() {
  const rows = state.rows;
  const map = { '6mo': 126, '1y': 252, '2y': 504, '5y': 1260 };
  const days = map[state.range] || 252;
  const start = Math.max(0, rows.length - days);
  return { rows: rows.slice(start), start };
}
function destroy(name) { if (charts[name]) { charts[name].destroy(); delete charts[name]; } }

const GRID = 'rgba(255,255,255,0.06)';
const TICK = '#8b949e';
function baseOpts(extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: TICK, boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: TICK, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: GRID } },
      y: { ticks: { color: TICK, font: { size: 10 } }, grid: { color: GRID } },
    },
    ...extra,
  };
}

function renderPriceChart() {
  destroy('price');
  const a = state.analysis;
  const { rows, start } = sliceByRange();
  const labels = rows.map((r) => r.date);
  const sl = (arr) => arr.slice(start);
  charts.price = new Chart($('priceChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Close', data: sl(a.closes), borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.08)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.1 },
        { label: 'SMA 20', data: sl(a.s20), borderColor: '#3fb950', pointRadius: 0, borderWidth: 1.3 },
        { label: 'SMA 50', data: sl(a.s50), borderColor: '#d29922', pointRadius: 0, borderWidth: 1.3 },
        { label: 'SMA 200', data: sl(a.s200), borderColor: '#f85149', pointRadius: 0, borderWidth: 1.3 },
      ],
    },
    options: baseOpts(),
  });
}

function renderRsiChart() {
  destroy('rsi');
  const a = state.analysis;
  const { rows, start } = sliceByRange();
  charts.rsi = new Chart($('rsiChart'), {
    type: 'line',
    data: { labels: rows.map((r) => r.date), datasets: [{ label: 'RSI', data: a.rsiArr.slice(start), borderColor: '#bc8cff', pointRadius: 0, borderWidth: 1.6 }] },
    options: baseOpts({
      scales: {
        x: { ticks: { color: TICK, maxTicksLimit: 6, font: { size: 10 } }, grid: { color: GRID } },
        y: { min: 0, max: 100, ticks: { color: TICK, stepSize: 25, font: { size: 10 } }, grid: { color: GRID } },
      },
      plugins: { legend: { display: false } },
    }),
  });
}

function renderMacdChart() {
  destroy('macd');
  const a = state.analysis;
  const { rows, start } = sliceByRange();
  const hist = a.macdObj.hist.slice(start);
  charts.macd = new Chart($('macdChart'), {
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        { type: 'bar', label: 'Histogram', data: hist, backgroundColor: hist.map((v) => (v >= 0 ? 'rgba(63,185,80,0.5)' : 'rgba(248,81,73,0.5)')) },
        { type: 'line', label: 'MACD', data: a.macdObj.macd.slice(start), borderColor: '#58a6ff', pointRadius: 0, borderWidth: 1.5 },
        { type: 'line', label: 'Signal', data: a.macdObj.signal.slice(start), borderColor: '#d29922', pointRadius: 0, borderWidth: 1.5 },
      ],
    },
    options: baseOpts(),
  });
}

// ---------- Projection ----------
function driftScale() { return state.drift === 'full' ? 1 : state.drift === 'half' ? 0.5 : 0; }

function renderProjection() {
  const a = state.analysis;
  const scale = driftScale();
  const wk = project(a.price, a.mu, a.sigma, weeklyHorizons(5), scale);
  const mo = project(a.price, a.mu, a.sigma, monthlyHorizons(5), scale);
  renderProjChart(a, mo);
  renderProjTable(els.weeksTable, wk, a.price, 'Week');
  renderProjTable(els.monthsTable, mo, a.price, 'Month');
}

function renderProjChart(a, mo) {
  destroy('proj');
  const histTail = a.closes.slice(-60);
  const histLabels = state.rows.slice(-60).map((r) => r.date);
  const projLabels = mo.map((_, i) => `+${i + 1}mo`);
  const labels = [...histLabels, ...projLabels];
  const nHist = histTail.length;
  const anchor = a.price;
  const pad = (arr) => [...new Array(nHist - 1).fill(null), ...arr];
  const cone = (key) => pad([anchor, ...mo.map((m) => m[key])]);

  charts.proj = new Chart($('projChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'History', data: [...histTail, ...new Array(mo.length).fill(null)], borderColor: '#c9d1d9', pointRadius: 0, borderWidth: 2 },
        { label: 'Bull (90th %)', data: cone('bull'), borderColor: 'rgba(63,185,80,0.9)', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.4, fill: '+1', backgroundColor: 'rgba(63,185,80,0.06)' },
        { label: 'P75', data: cone('p75'), borderColor: 'rgba(63,185,80,0.35)', pointRadius: 0, borderWidth: 1, fill: '+1', backgroundColor: 'rgba(88,166,255,0.05)' },
        { label: 'Base (median)', data: cone('base'), borderColor: '#58a6ff', pointRadius: 0, borderWidth: 2.2, fill: '+1', backgroundColor: 'rgba(88,166,255,0.05)' },
        { label: 'P25', data: cone('p25'), borderColor: 'rgba(248,81,73,0.35)', pointRadius: 0, borderWidth: 1, fill: '+1', backgroundColor: 'rgba(248,81,73,0.05)' },
        { label: 'Bear (10th %)', data: cone('bear'), borderColor: 'rgba(248,81,73,0.9)', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.4 },
      ],
    },
    options: baseOpts(),
  });
}

function renderProjTable(tableEl, proj, S0, unitLabel) {
  clear(tableEl);
  const thead = h('thead', {}, [h('tr', {}, [
    h('th', { text: 'Horizon' }), h('th', { text: 'Bear (10%)' }),
    h('th', { text: 'Base (median)' }), h('th', { text: 'Bull (90%)' }), h('th', { text: 'P(up vs today)' }),
  ])]);
  const f = (v) => '₹' + INR.format(v);
  const fp = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const pct = (v) => (v / S0 - 1) * 100;
  const cell = (cls, price, p) => h('td', { class: cls }, [
    document.createTextNode(f(price)), h('br'), h('span', { class: 'small', text: fp(pct(price)) }),
  ]);
  const body = h('tbody', {}, proj.map((p, i) => h('tr', {}, [
    h('td', { text: `${unitLabel} ${i + 1}` }),
    cell('bear', p.bear, p),
    cell('base-col', p.base, p),
    cell('bull', p.bull, p),
    h('td', { text: `${(p.pUp * 100).toFixed(0)}%` }),
  ])));
  tableEl.appendChild(thead);
  tableEl.appendChild(body);
}

// ---------- Render: news ----------
function renderNews(items, sentiment) {
  clear(els.newsList);
  if (!items.length) { setPlaceholder(els.newsList, 'No recent news found.', 'li'); els.newsSentimentBadge.textContent = ''; return; }
  // Sentiment badge
  const cls = sentiment.score > 0.1 ? 'pos' : sentiment.score < -0.1 ? 'neg' : 'neu';
  const word = cls === 'pos' ? 'Positive' : cls === 'neg' ? 'Negative' : 'Mixed';
  els.newsSentimentBadge.className = 'news-sentiment ' + cls;
  els.newsSentimentBadge.textContent = `News tone: ${word} (${sentiment.pos}▲ / ${sentiment.neg}▼ of ${sentiment.n})`;

  items.forEach((it) => {
    const dotCls = it.sentiment || 'neu';
    const link = h('a', { text: it.title, attrs: { href: it.link, target: '_blank', rel: 'noopener noreferrer' } });
    const meta = h('div', { class: 'n-meta', text: [it.source, it.date].filter(Boolean).join(' · ') });
    els.newsList.appendChild(h('li', {}, [
      h('span', { class: `news-dot ${dotCls}` }),
      h('div', {}, [link, meta]),
    ]));
  });
}

// Re-run the signal with the news sentiment folded in, and re-render the verdict.
function rescoreWithNews(sentiment) {
  const a = state.analysis;
  if (!a) return;
  a.sigContext.newsSentiment = sentiment;
  a.sig = computeSignal(a.sigContext);
  renderSignal();
}

// ---------- Render: macro ----------
function renderMacro(macro) {
  clear(els.macroGrid);
  if (!macro.length) { setPlaceholder(els.macroGrid, 'Market backdrop unavailable right now.'); return; }
  macro.forEach((m) => {
    const up = (m.chgPct ?? 0) >= 0;
    const chgTxt = m.chgPct != null ? `${up ? '▲ +' : '▼ '}${m.chgPct.toFixed(2)}%` : '—';
    els.macroGrid.appendChild(h('div', { class: 'macro-item' }, [
      h('div', { class: 'm-label', text: m.label }),
      h('div', { class: 'm-price', text: INR.format(m.price) }),
      h('div', { class: `m-chg ${up ? 'up' : 'down'}`, text: chgTxt }),
    ]));
  });
  const note = macroRiskNote(macro);
  els.macroNote.textContent = note ? note.text : '';
}

// ---------- Render: fundamentals + earnings ----------
function renderFundamentals(f) {
  clear(els.fundamentalsBody);
  if (!f.available) {
    const msg = f.reason === 'no-key'
      ? 'Add a free Alpha Vantage API key (⚙︎ Data source) to see P/E, EPS, market cap, analyst targets and quarterly earnings. There is no reliable keyless source for Indian fundamentals.'
      : f.reason === 'rate-limit'
      ? 'Alpha Vantage rate limit hit (free tier allows 25 calls/day). Try again later.'
      : f.reason === 'unsupported'
      ? 'Fundamentals not available for this symbol on Alpha Vantage\'s free tier (Indian coverage is partial).'
      : 'Fundamentals unavailable right now.';
    els.fundamentalsBody.appendChild(h('div', { class: 'info-note', text: msg }));
    return;
  }
  const bn = (v) => v == null ? '—' : v >= 1e12 ? '₹' + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? '₹' + (v / 1e9).toFixed(2) + 'B' : '₹' + INR.format(v);
  const pctv = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';
  const numv = (v) => v == null ? '—' : INR.format(v);
  const cells = [
    ['P/E (TTM)', numv(f.pe)],
    ['Forward P/E', numv(f.forwardPe)],
    ['EPS', f.eps == null ? '—' : '₹' + numv(f.eps)],
    ['PEG', numv(f.pegRatio)],
    ['Market cap', bn(f.marketCap)],
    ['Dividend yield', f.dividendYield == null ? '—' : pctv(f.dividendYield)],
    ['Profit margin', f.profitMargin == null ? '—' : pctv(f.profitMargin)],
    ['ROE (TTM)', f.roe == null ? '—' : pctv(f.roe)],
    ['Analyst target', f.analystTarget == null ? '—' : '₹' + numv(f.analystTarget)],
  ];
  const grid = h('div', { class: 'fund-grid' });
  cells.forEach(([label, val]) => grid.appendChild(h('div', { class: 'fund-item' }, [
    h('div', { class: 'f-label', text: label }),
    h('div', { class: 'f-value', text: val }),
  ])));
  const head = h('p', { class: 'muted small', text: `${f.name || state.ticker}${f.sector ? ' · ' + f.sector : ''}${f.industry ? ' · ' + f.industry : ''}` });
  els.fundamentalsBody.appendChild(head);
  els.fundamentalsBody.appendChild(grid);

  // Analyst target vs current price — a forward-looking cross-check
  if (f.analystTarget != null && state.analysis?.price) {
    const upside = ((f.analystTarget / state.analysis.price) - 1) * 100;
    const dir = upside >= 0 ? 'above' : 'below';
    els.fundamentalsBody.appendChild(h('p', { class: 'muted small',
      text: `Analyst mean target of ₹${numv(f.analystTarget)} is ${Math.abs(upside).toFixed(1)}% ${dir} the current price — an external, fundamentals-based view to weigh against the technical signal.` }));
  }

  // Earnings surprises table
  if (f.quarters && f.quarters.length) {
    const thead = h('thead', {}, [h('tr', {}, [
      h('th', { text: 'Quarter' }), h('th', { text: 'Reported EPS' }), h('th', { text: 'Estimated EPS' }), h('th', { text: 'Surprise' }),
    ])]);
    const body = h('tbody', {}, f.quarters.map((q) => {
      const sc = q.surprisePct == null ? 'muted' : q.surprisePct >= 0 ? 'up' : 'down';
      const st = q.surprisePct == null ? '—' : `${q.surprisePct >= 0 ? '+' : ''}${q.surprisePct.toFixed(1)}%`;
      return h('tr', {}, [
        h('td', { text: q.date }),
        h('td', { text: q.reported == null ? '—' : numv(q.reported) }),
        h('td', { text: q.estimated == null ? '—' : numv(q.estimated) }),
        h('td', { class: sc, text: st }),
      ]);
    }));
    const table = h('table', { class: 'earnings-table' }, [thead, body]);
    els.fundamentalsBody.appendChild(h('h4', { class: 'section-sub', text: 'Recent quarterly earnings vs estimates' }));
    els.fundamentalsBody.appendChild(table);
  }
}

// ---------- Render: reddit ----------
function renderReddit(data) {
  clear(els.redditBody);
  if (data.available && data.posts?.length) {
    const list = h('ul', { class: 'reddit-list' });
    data.posts.forEach((p) => list.appendChild(h('li', {}, [
      h('a', { text: p.title, attrs: { href: p.link, target: '_blank', rel: 'noopener noreferrer' } }),
      h('div', { class: 'r-meta', text: `${p.subreddit} · ${p.score}↑ · ${p.comments} comments` }),
    ])));
    els.redditBody.appendChild(list);
    return;
  }
  // Graceful fallback — Reddit blocks anonymous access intermittently.
  const note = h('div', { class: 'info-note' }, [
    document.createTextNode('Reddit blocks anonymous access, so live discussions could not be loaded right now. '),
    h('a', { text: 'Open this search on Reddit →', attrs: { href: data.browseLink, target: '_blank', rel: 'noopener noreferrer' } }),
  ]);
  els.redditBody.appendChild(note);
}

// ---------- Boot ----------
els.ticker.value = 'RELIANCE';

// Initialize the live dashboard. Clicking any row/pick runs a full analysis.
initDashboard((sym) => {
  els.ticker.value = sym;
  els.exchange.value = 'NS';
  els.form.requestSubmit();
});
