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
