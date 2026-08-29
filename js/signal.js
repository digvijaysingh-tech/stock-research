// signal.js — turns indicators into a TRANSPARENT, scored Bullish/Neutral/Bearish signal.
// Every contributing factor is returned with its own +/- points and a human-readable reason,
// so the verdict is explainable rather than a black box.

// Each factor contributes a weighted score in [-weight, +weight]. Total normalized to -100..+100.
export function computeSignal(ctx) {
  const {
    price, sma20, sma50, sma200, rsiVal, macdVal, macdSignal, macdHist,
    boll, week52, annVol, mu, recentReturn20
  } = ctx;

  const factors = [];
  const add = (label, points, reason, weight) => factors.push({ label, points, reason, weight });

  // 1. Long-term trend: price vs SMA200 (weight 25)
  if (sma200 != null) {
    const above = price > sma200;
    const dist = ((price - sma200) / sma200) * 100;
    add('Long-term trend', above ? 25 : -25,
      `Price is ${above ? 'above' : 'below'} the 200-day average (${dist >= 0 ? '+' : ''}${dist.toFixed(1)}%). ${above ? 'Primary trend is up.' : 'Primary trend is down.'}`,
      25);
  }

  // 2. Golden/death cross: SMA50 vs SMA200 (weight 15)
  if (sma50 != null && sma200 != null) {
    const golden = sma50 > sma200;
    add('50/200 cross', golden ? 15 : -15,
      `50-day average is ${golden ? 'above' : 'below'} the 200-day (${golden ? 'golden-cross regime, bullish' : 'death-cross regime, bearish'}).`,
      15);
  }

  // 3. Short-term trend: price vs SMA20/SMA50 (weight 15)
  if (sma20 != null && sma50 != null) {
    const up = price > sma20 && sma20 > sma50;
    const down = price < sma20 && sma20 < sma50;
    const pts = up ? 15 : down ? -15 : 0;
    add('Short-term trend', pts,
      up ? 'Price > 20-day > 50-day: short-term uptrend intact.'
         : down ? 'Price < 20-day < 50-day: short-term downtrend.'
         : 'Short-term averages are mixed/flat.',
      15);
  }

  // 4. RSI momentum (weight 15)
  if (rsiVal != null) {
    let pts, reason;
    if (rsiVal >= 70) { pts = -8; reason = `RSI ${rsiVal.toFixed(0)} — overbought; upside may be stretched short-term.`; }
    else if (rsiVal <= 30) { pts = 8; reason = `RSI ${rsiVal.toFixed(0)} — oversold; a bounce is statistically more likely.`; }
    else if (rsiVal >= 55) { pts = 12; reason = `RSI ${rsiVal.toFixed(0)} — healthy bullish momentum.`; }
    else if (rsiVal <= 45) { pts = -12; reason = `RSI ${rsiVal.toFixed(0)} — weak momentum.`; }
    else { pts = 0; reason = `RSI ${rsiVal.toFixed(0)} — neutral momentum.`; }
    add('RSI (14)', pts, reason, 15);
  }

  // 5. MACD (weight 15)
  if (macdVal != null && macdSignal != null) {
    const bullish = macdVal > macdSignal;
    const strengthening = macdHist != null && macdHist > 0;
    const pts = bullish ? (strengthening ? 15 : 8) : (macdHist < 0 ? -15 : -8);
    add('MACD', pts,
      `MACD is ${bullish ? 'above' : 'below'} its signal line${strengthening ? ' and histogram is positive (momentum building)' : macdHist < 0 ? ' with negative histogram (momentum fading)' : ''}.`,
      15);
  }

  // 6. Bollinger position (weight 10)
  if (boll && boll.upper != null && boll.lower != null) {
    const range = boll.upper - boll.lower;
    const pos = range > 0 ? (price - boll.lower) / range : 0.5; // 0 = lower band, 1 = upper
    let pts, reason;
    if (pos > 0.95) { pts = -6; reason = 'Price riding the upper Bollinger band — extended.'; }
    else if (pos < 0.05) { pts = 6; reason = 'Price near lower Bollinger band — potential mean-reversion up.'; }
    else if (pos > 0.5) { pts = 5; reason = 'Price in the upper half of its Bollinger range.'; }
    else { pts = -3; reason = 'Price in the lower half of its Bollinger range.'; }
    add('Bollinger position', pts, reason, 10);
  }

  // 7. 52-week position (weight 10)
  if (week52) {
    const rng = week52.high - week52.low;
    const pos = rng > 0 ? (price - week52.low) / rng : 0.5;
    let pts, reason;
    if (pos > 0.85) { pts = 8; reason = `Near 52-week high (${(pos * 100).toFixed(0)}% of range) — strength, though watch for resistance.`; }
    else if (pos < 0.15) { pts = -8; reason = `Near 52-week low (${(pos * 100).toFixed(0)}% of range) — weakness.`; }
    else { pts = (pos - 0.5) * 12; reason = `At ${(pos * 100).toFixed(0)}% of its 52-week range.`; }
    add('52-week position', pts, reason, 10);
  }

  // 8. Recent 20-day return (weight 10)
  if (recentReturn20 != null) {
    const pct = recentReturn20 * 100;
    const pts = Math.max(-10, Math.min(10, pct * 0.8));
    add('Recent 1-month return', pts,
      `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% over the last ~month.`,
      10);
  }

  // Normalize: sum of points / sum of weights * 100
  const totalWeight = factors.reduce((a, f) => a + f.weight, 0) || 1;
  const raw = factors.reduce((a, f) => a + f.points, 0);
  const score = Math.round((raw / totalWeight) * 100);

  let verdict, klass;
  if (score >= 25) { verdict = 'BULLISH'; klass = 'bullish'; }
  else if (score <= -25) { verdict = 'BEARISH'; klass = 'bearish'; }
  else { verdict = 'NEUTRAL'; klass = 'neutral'; }

  // Volatility note colors the confidence
  const volNote = annVol != null
    ? (annVol > 0.5 ? 'high' : annVol > 0.3 ? 'moderate' : 'low')
    : 'unknown';

  return { score, verdict, klass, factors, volNote, annVol };
}
