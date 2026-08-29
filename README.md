# 📈 Stock Research & Projection (NSE/BSE)

A **static website** for researching Indian stocks. It pulls **real market data**, runs proper
technical analysis, produces a **transparent Bullish/Neutral/Bearish signal** with a scored rationale,
and shows **probabilistic price projections** for the next ~5 weeks and ~5 months.

> ⚠️ **Not investment advice.** No tool can reliably predict stock prices. The projections here are
> *statistical scenarios* derived from each stock's own historical drift and volatility — they will be
> wrong whenever the future differs from the past. Use for research and learning only.

## What it does

- **Real data** for NSE (`.NS`) and BSE (`.BO`) tickers.
  - Uses your **Alpha Vantage** free API key if you add one (⚙︎ Data source), otherwise falls back to a
    **keyless Yahoo Finance** source via a public CORS proxy — so it works out of the box.
- **Technical analysis**: SMA 20/50/200, EMA, RSI(14), MACD, Bollinger Bands, 52-week range,
  annualized volatility, recent returns.
- **Transparent signal**: 8 weighted factors, each shown with its own +/- contribution and a plain-English
  reason. No black box — you see exactly *why* it leans up or down.
- **Probabilistic projection**: a log-normal (Geometric Brownian Motion) model produces bear (10th %),
  base (median), and bull (90th %) price cones per week and per month, plus the modeled probability the
  price is above today's. A drift toggle (Historical / Half / Zero) lets you be more conservative.
- **Reads the world** (context layer):
  - **News, results & filings** via Google News RSS, with a lightweight headline-sentiment scan that
    feeds back into the signal as an extra weighted factor (so it *reads* the news, not just lists it).
  - **Market backdrop**: Nifty 50, Sensex, India VIX, USD/INR, Brent crude — plus a VIX-based risk note.
  - **Fundamentals & earnings**: P/E, forward P/E, EPS, PEG, market cap, dividend yield, margins, ROE,
    analyst mean target (cross-checked vs current price), and the last 4 quarters' EPS-vs-estimate surprises.
  - **Reddit discussions**: best-effort retail-chatter feed.

### Honest limits of the context layer (verified live)

| Data | Status | Notes |
|---|---|---|
| News headlines | ✅ Keyless | Google News RSS via CORS proxy |
| Macro backdrop | ✅ Keyless | Yahoo quotes via CORS proxy |
| Fundamentals & earnings | 🔑 **Needs Alpha Vantage key** | No reliable keyless source — Yahoo now requires an auth crumb. Free tier = 25 calls/day. |
| Company filings | ⚠️ Via news | No free CORS-accessible BSE/NSE filings API; surfaced through news headlines. Verify on official disclosures. |
| Reddit | ⚠️ Best-effort | Reddit blocks anonymous access (HTTP 403) intermittently; falls back to an "open on Reddit" link. |

The context feeds load **asynchronously and independently** — the core price analysis renders immediately
and never waits on (or breaks because of) a slow/blocked feed.

## Live dashboard

The landing page is an **interactive dashboard**:

- **⏰ Live clock** — current date & time to the second (updates every second).
- **📡 Live market data** — Nifty 50, Sensex, Bank Nifty, India VIX, USD/INR, Brent crude; auto-refreshes every 60s.
- **📈 Top gainers / 📉 Top losers** — from the scheduled screener.
- **🤖 AI breakout watchlist** — a transparent quantitative screener that ranks the stock universe for breakout
  setups (near 52-week highs, above key moving averages, momentum + volume surge, tight consolidation), showing
  the scored reasons for each pick. **Refreshed every 4 hours.**
- **⭐ My watchlist** — add your own tickers; saved in your browser's localStorage.

Clicking any stock anywhere on the dashboard runs the full research analysis for it.

### Why a GitHub Action powers the movers & watchlist

Batch-fetching a 60+ stock universe from the browser through public CORS proxies **fails** (rate-limited,
~0/6 success in testing). So a scheduled **GitHub Action** (`.github/workflows/refresh-market-data.yml`) runs
`scripts/screener.mjs` server-side — where there's no CORS limit and the full scan takes <1s — and commits the
result to `data/market.json`. The static site just reads that JSON. **The cron *is* the 4-hour refresh.**

To trigger it manually: repo → **Actions** tab → **Refresh market data** → **Run workflow**. It also runs
automatically every 4 hours once the repo has Actions enabled.

> **The "AI watchlist" is an algorithm, not a live LLM.** A static site can't run a server-side model, and
> embedding an API key in public code would be a security hole. The screener is fully transparent — every pick
> shows why it scored highly. A high score flags a *pattern*, which can fail; it is not a recommendation.

## Run locally

It's a static site — just serve the folder:

```bash
cd ~/Desktop/stock-research
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly via `file://` won't work because it uses JS modules — use a local server.)

## Deploy to GitHub Pages

1. Create a new empty repo on GitHub (e.g. `stock-research`).
2. Push this folder:
   ```bash
   git remote add origin https://github.com/<you>/stock-research.git
   git branch -M main
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` / `root`.
4. Your site goes live at `https://<you>.github.io/stock-research/`.

## Add an Alpha Vantage key (optional, more reliable)

Get a free key at <https://www.alphavantage.co/support/#api-key> (takes ~30s), then click **⚙︎ Data source**
in the app and paste it. It's stored only in your browser's `localStorage`. Without a key the app uses the
keyless Yahoo fallback, which can occasionally be rate-limited by the public CORS proxies.

## How the projection math works

Under Geometric Brownian Motion, `ln(S_t / S₀)` is normally distributed with mean `(μ − σ²/2)·t` and
standard deviation `σ·√t`, where `μ` and `σ` are the daily drift and volatility estimated from the last
~252 trading days. Percentile bands are therefore closed-form (no random simulation), which makes the
output reproducible. Bands widen with `√t`, honestly reflecting compounding uncertainty.

## Files

```
index.html          markup + layout
css/styles.css      dark theme
js/data.js          real-data fetching (Alpha Vantage + Yahoo fallback)
js/indicators.js    SMA/EMA/RSI/MACD/Bollinger/volatility math
js/signal.js        transparent weighted signal scoring
js/projection.js    log-normal probabilistic projection
js/app.js           UI orchestration + Chart.js rendering
```

## Limitations (read these)

- Purely **technical + statistical**. It does **not** read news, earnings, filings, or macro data.
- Projections assume returns behave like the recent past — they cannot anticipate shocks, gaps, or regime changes.
- Keyless data depends on third-party CORS proxies that may be down; add an API key for reliability.
- Corporate actions (splits/bonus) are handled by using adjusted close where the source provides it.
