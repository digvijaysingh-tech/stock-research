// indicators.js — pure technical-analysis math. No I/O, easy to reason about & test.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === undefined) {
      // seed with SMA of first `period` values
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const g = ch >= 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// MACD: returns { macd, signal, hist } arrays
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  // signal = EMA of the non-null macd line
  const firstIdx = macdLine.findIndex((v) => v != null);
  const compact = macdLine.slice(firstIdx).map((v) => v ?? 0);
  const sigCompact = ema(compact, signalPeriod);
  const signal = new Array(values.length).fill(null);
  for (let i = 0; i < sigCompact.length; i++) {
    if (sigCompact[i] != null) signal[firstIdx + i] = sigCompact[i];
  }
  const hist = values.map((_, i) =>
    macdLine[i] != null && signal[i] != null ? macdLine[i] - signal[i] : null
  );
  return { macd: macdLine, signal, hist };
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

// Daily log returns
export function logReturns(values) {
  const r = [];
  for (let i = 1; i < values.length; i++) r.push(Math.log(values[i] / values[i - 1]));
  return r;
}

export function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

// Annualized volatility from daily log returns (252 trading days)
export function annualizedVol(dailyReturns) {
  return stddev(dailyReturns) * Math.sqrt(252);
}

// 52-week (approx 252 trading day) high/low
export function fiftyTwoWeek(rows) {
  const window = rows.slice(-252);
  let hi = -Infinity, lo = Infinity;
  for (const r of window) { if (r.high > hi) hi = r.high; if (r.low < lo) lo = r.low; }
  return { high: hi, low: lo };
}
