// projection.js — probabilistic price projection using a Geometric Brownian Motion (log-normal) model.
//
// We estimate daily drift (mu) and daily volatility (sigma) from historical log returns, then project
// forward analytically. Under GBM, ln(S_t / S_0) ~ Normal( (mu - sigma^2/2) * t , sigma^2 * t ).
// So the percentile bands at horizon t are closed-form — no Monte Carlo needed, and they're reproducible.
//
// This is a STATISTICAL SCENARIO tool, not a predictor. The bands widen with sqrt(time), which honestly
// reflects how uncertainty compounds. Drift can be scaled down (half/zero) for a conservative view.

import { logReturns, mean, stddev } from './indicators.js';

// Inverse normal CDF (Acklam's algorithm) — for percentile bands.
function normInv(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= phigh) {
    q = p - 0.5; r = q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// Estimate daily mu & sigma from the most recent `lookback` trading days.
export function estimateParams(closes, lookback = 252) {
  const recent = closes.slice(-Math.min(lookback, closes.length));
  const rets = logReturns(recent);
  return { mu: mean(rets), sigma: stddev(rets), nReturns: rets.length };
}

// Project bands at a list of horizons (in trading days).
// driftScale: 1 = full historical drift, 0.5 = half, 0 = zero-drift (pure diffusion).
// Returns array of { days, base, bear, bull, p25, p75, pUp } where prices are absolute.
export function project(S0, mu, sigma, horizonsDays, driftScale = 1) {
  const effMu = mu * driftScale;
  return horizonsDays.map((t) => {
    const drift = (effMu - 0.5 * sigma * sigma) * t; // log-space mean
    const sd = sigma * Math.sqrt(t);                 // log-space std dev
    const band = (pct) => S0 * Math.exp(drift + sd * normInv(pct));
    // Probability the price is above today's price at horizon t:
    // P(ln(S_t/S0) > 0) = 1 - Phi( -drift / sd )  -> using normCdf
    const pUp = 1 - normCdf(-drift / sd);
    return {
      days: t,
      base: S0 * Math.exp(drift),   // median (geometric)
      bear: band(0.10),
      bull: band(0.90),
      p25: band(0.25),
      p75: band(0.75),
      pUp,
    };
  });
}

// Standard normal CDF via erf approximation
function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

// Weekly horizons (5 trading days each) and monthly (21 trading days each)
export function weeklyHorizons(n = 5) {
  return Array.from({ length: n }, (_, i) => (i + 1) * 5);
}
export function monthlyHorizons(n = 5) {
  return Array.from({ length: n }, (_, i) => (i + 1) * 21);
}
