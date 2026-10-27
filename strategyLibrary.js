// strategyLibrary.js — Indicators + the 12 tournament strategies.
// Shared by the backtester (backtestStrategies.js) and the live 4h BTC tournament.
//
// Each strategy is a pure function(candles) -> Array<0|1>, where element i is the
// position to HOLD after acting on candle i's close (1 = long BTC, 0 = flat/cash).
// Strategies are long/flat only — the fair comparison to buy-and-hold.
//
// candles: [{ open, high, low, close, vol }]  (ascending, oldest first)

'use strict';

// ── Indicator primitives (array in → array out, null until warmed up) ─────────

function SMA(vals, p) {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
        sum += vals[i];
        if (i >= p) sum -= vals[i - p];
        if (i >= p - 1) out[i] = sum / p;
    }
    return out;
}

function EMA(vals, p) {
    const out = new Array(vals.length).fill(null);
    const k = 2 / (p + 1);
    let ema = null, seed = 0;
    for (let i = 0; i < vals.length; i++) {
        if (i < p - 1) { seed += vals[i]; continue; }
        if (i === p - 1) { seed += vals[i]; ema = seed / p; out[i] = ema; continue; }
        ema = vals[i] * k + ema * (1 - k);
        out[i] = ema;
    }
    return out;
}

// Wilder RSI
function RSI(closes, p) {
    const out = new Array(closes.length).fill(null);
    let avgG = 0, avgL = 0;
    for (let i = 1; i < closes.length; i++) {
        const ch = closes[i] - closes[i - 1];
        const g = ch > 0 ? ch : 0;
        const l = ch < 0 ? -ch : 0;
        if (i <= p) {
            avgG += g; avgL += l;
            if (i === p) {
                avgG /= p; avgL /= p;
                out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
            }
        } else {
            avgG = (avgG * (p - 1) + g) / p;
            avgL = (avgL * (p - 1) + l) / p;
            out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
        }
    }
    return out;
}

function MACD(closes, fast = 12, slow = 26, sig = 9) {
    const ef = EMA(closes, fast), es = EMA(closes, slow);
    const macd = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
    // signal = EMA of the (non-null) macd line
    const firstIdx = macd.findIndex(v => v != null);
    const signal = new Array(closes.length).fill(null);
    if (firstIdx !== -1) {
        const slice = macd.slice(firstIdx).map(v => v == null ? 0 : v);
        const sigSlice = EMA(slice, sig);
        for (let i = 0; i < sigSlice.length; i++) signal[firstIdx + i] = sigSlice[i];
    }
    return { macd, signal };
}

function stochastic(highs, lows, closes, kP = 14, dP = 3) {
    const n = closes.length;
    const kRaw = new Array(n).fill(null);
    for (let i = kP - 1; i < n; i++) {
        let hh = -Infinity, ll = Infinity;
        for (let j = i - kP + 1; j <= i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
        kRaw[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    }
    // %K smoothed by SMA(dP) is common "slow" — use raw %K and %D = SMA(kRaw, dP)
    const kValid = kRaw.map(v => v == null ? 0 : v);
    const d = SMA(kValid, dP).map((v, i) => kRaw[i] == null ? null : v);
    return { k: kRaw, d };
}

function bollinger(closes, p = 20, mult = 2) {
    const mid = SMA(closes, p);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = p - 1; i < closes.length; i++) {
        let sq = 0;
        for (let j = i - p + 1; j <= i; j++) sq += (closes[j] - mid[i]) ** 2;
        const sd = Math.sqrt(sq / p);
        upper[i] = mid[i] + mult * sd;
        lower[i] = mid[i] - mult * sd;
    }
    return { mid, upper, lower };
}

function ATR(highs, lows, closes, p = 14) {
    const n = closes.length;
    const tr = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (i === 0) { tr[i] = highs[i] - lows[i]; continue; }
        tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    const out = new Array(n).fill(null);
    let atr = 0;
    for (let i = 1; i <= p; i++) atr += tr[i];
    atr /= p;
    out[p] = atr;
    for (let i = p + 1; i < n; i++) { atr = (atr * (p - 1) + tr[i]) / p; out[i] = atr; }
    return out;
}

function supertrend(highs, lows, closes, p = 10, mult = 3) {
    const n = closes.length;
    const atr = ATR(highs, lows, closes, p);
    const dir = new Array(n).fill(null);   // 1 = uptrend (long), -1 = downtrend
    const fUpper = new Array(n).fill(null);
    const fLower = new Array(n).fill(null);
    let prevDir = 1;
    for (let i = 0; i < n; i++) {
        if (atr[i] == null) continue;
        const hl2 = (highs[i] + lows[i]) / 2;
        const bUp = hl2 + mult * atr[i];
        const bLo = hl2 - mult * atr[i];
        if (fUpper[i - 1] == null) { fUpper[i] = bUp; fLower[i] = bLo; dir[i] = 1; prevDir = 1; continue; }
        fUpper[i] = (bUp < fUpper[i - 1] || closes[i - 1] > fUpper[i - 1]) ? bUp : fUpper[i - 1];
        fLower[i] = (bLo > fLower[i - 1] || closes[i - 1] < fLower[i - 1]) ? bLo : fLower[i - 1];
        if (closes[i] > fUpper[i - 1]) prevDir = 1;
        else if (closes[i] < fLower[i - 1]) prevDir = -1;
        dir[i] = prevDir;
    }
    return dir;
}

function ichimoku(highs, lows, closes) {
    const n = closes.length;
    const midOver = (period) => {
        const out = new Array(n).fill(null);
        for (let i = period - 1; i < n; i++) {
            let hh = -Infinity, ll = Infinity;
            for (let j = i - period + 1; j <= i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
            out[i] = (hh + ll) / 2;
        }
        return out;
    };
    const tenkan = midOver(9);
    const kijun = midOver(26);
    const spanB52 = midOver(52);
    // Cloud "in front" of candle i = spans computed 26 candles ago
    const cloudA = new Array(n).fill(null);
    const cloudB = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        const s = i - 26;
        if (s >= 0 && tenkan[s] != null && kijun[s] != null) cloudA[i] = (tenkan[s] + kijun[s]) / 2;
        if (s >= 0 && spanB52[s] != null) cloudB[i] = spanB52[s];
    }
    return { tenkan, kijun, cloudA, cloudB };
}

function rollingVWAP(highs, lows, closes, vols, p = 20) {
    const n = closes.length;
    const out = new Array(n).fill(null);
    for (let i = p - 1; i < n; i++) {
        let pv = 0, vv = 0;
        for (let j = i - p + 1; j <= i; j++) {
            const tp = (highs[j] + lows[j] + closes[j]) / 3;
            pv += tp * vols[j]; vv += vols[j];
        }
        out[i] = vv > 0 ? pv / vv : closes[i];
    }
    return out;
}

function highestHigh(arr, i, p) { let h = -Infinity; for (let j = i - p; j < i; j++) if (arr[j] > h) h = arr[j]; return h; }
function lowestLow(arr, i, p)  { let l = Infinity;  for (let j = i - p; j < i; j++) if (arr[j] < l) l = arr[j]; return l; }
const crossUp   = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDown = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];

// ── Generic stateful runner: enter/exit predicates → position array ───────────
function runStateful(n, enter, exit) {
    const pos = new Array(n).fill(0);
    let inPos = false;
    for (let i = 0; i < n; i++) {
        if (!inPos && enter(i)) inPos = true;
        else if (inPos && exit(i)) inPos = false;
        pos[i] = inPos ? 1 : 0;
    }
    return pos;
}

// ── The 12 strategies ─────────────────────────────────────────────────────────

const STRATEGIES = {
    emaCross(c) {
        const close = c.map(x => x.close);
        const f = EMA(close, 20), s = EMA(close, 50);
        return runStateful(c.length, i => crossUp(f, s, i), i => crossDown(f, s, i));
    },

    ichimoku(c) {
        const close = c.map(x => x.close), high = c.map(x => x.high), low = c.map(x => x.low);
        const { tenkan, kijun, cloudA, cloudB } = ichimoku(high, low, close);
        return runStateful(c.length,
            i => cloudA[i] != null && cloudB[i] != null && tenkan[i] != null && kijun[i] != null &&
                 close[i] > cloudA[i] && close[i] > cloudB[i] && tenkan[i] > kijun[i],
            i => kijun[i] != null && close[i] < kijun[i]);
    },

    nDayHigh(c) {  // "52-week high" adapted: 180-period high entry, 90-period low exit
        const close = c.map(x => x.close);
        return runStateful(c.length,
            i => i >= 180 && close[i] > highestHigh(close, i, 180),
            i => i >= 90 && close[i] < lowestLow(close, i, 90));
    },

    turtle(c) {  // Donchian 20 entry / 10 exit
        const high = c.map(x => x.high), low = c.map(x => x.low), close = c.map(x => x.close);
        return runStateful(c.length,
            i => i >= 20 && close[i] > highestHigh(high, i, 20),
            i => i >= 10 && close[i] < lowestLow(low, i, 10));
    },

    macd(c) {
        const close = c.map(x => x.close);
        const { macd, signal } = MACD(close);
        return runStateful(c.length, i => crossUp(macd, signal, i), i => crossDown(macd, signal, i));
    },

    stochTrend(c) {  // stochastic oversold cross up, filtered by price > EMA200
        const close = c.map(x => x.close), high = c.map(x => x.high), low = c.map(x => x.low);
        const { k, d } = stochastic(high, low, close, 14, 3);
        const ema200 = EMA(close, 200);
        return runStateful(c.length,
            i => k[i] != null && d[i] != null && ema200[i] != null &&
                 crossUp(k, d, i) && k[i] < 30 && close[i] > ema200[i],
            i => k[i] != null && d[i] != null && crossDown(k, d, i) && k[i] > 70);
    },

    goldenCross(c) {
        const close = c.map(x => x.close);
        const s50 = SMA(close, 50), s200 = SMA(close, 200);
        return runStateful(c.length, i => crossUp(s50, s200, i), i => crossDown(s50, s200, i));
    },

    vwapReversion(c) {  // buy ≥2% below rolling VWAP, exit back at/above VWAP
        const close = c.map(x => x.close), high = c.map(x => x.high), low = c.map(x => x.low), vol = c.map(x => x.vol);
        const vwap = rollingVWAP(high, low, close, vol, 20);
        return runStateful(c.length,
            i => vwap[i] != null && close[i] <= vwap[i] * 0.98,
            i => vwap[i] != null && close[i] >= vwap[i]);
    },

    rsi2(c) {  // Connors RSI-2 dip buy, filter SMA200, exit close > SMA5
        const close = c.map(x => x.close);
        const r = RSI(close, 2), s200 = SMA(close, 200), s5 = SMA(close, 5);
        return runStateful(c.length,
            i => r[i] != null && s200[i] != null && r[i] < 10 && close[i] > s200[i],
            i => s5[i] != null && close[i] > s5[i]);
    },

    bollinger(c) {  // buy at/below lower band, exit at middle band
        const close = c.map(x => x.close);
        const { mid, lower } = bollinger(close, 20, 2);
        return runStateful(c.length,
            i => lower[i] != null && close[i] <= lower[i],
            i => mid[i] != null && close[i] >= mid[i]);
    },

    rsiMeanRev(c) {  // RSI14 < 30 buy, > 70 sell
        const close = c.map(x => x.close);
        const r = RSI(close, 14);
        return runStateful(c.length,
            i => r[i] != null && r[i] < 30,
            i => r[i] != null && r[i] > 70);
    },

    supertrend(c) {
        const close = c.map(x => x.close), high = c.map(x => x.high), low = c.map(x => x.low);
        const dir = supertrend(high, low, close, 10, 3);
        return runStateful(c.length,
            i => dir[i] === 1 && dir[i - 1] === -1,
            i => dir[i] === -1 && dir[i - 1] === 1);
    },
};

const STRATEGY_META = {
    emaCross:      { name: 'EMA Cross (20/50)',        family: 'trend' },
    ichimoku:      { name: 'Ichimoku Cloud Breakout',  family: 'trend' },
    nDayHigh:      { name: 'N-Day High Momentum',      family: 'trend' },
    turtle:        { name: 'Turtle Breakout (20/10)',  family: 'trend' },
    macd:          { name: 'MACD Crossover',           family: 'momentum' },
    stochTrend:    { name: 'Stochastic + Trend Filter',family: 'momentum' },
    goldenCross:   { name: 'Golden Cross (50/200)',    family: 'trend' },
    vwapReversion: { name: 'VWAP Reversion',           family: 'meanrev' },
    rsi2:          { name: 'RSI-2 Dip Buy',            family: 'meanrev' },
    bollinger:     { name: 'Bollinger Reversion',      family: 'meanrev' },
    rsiMeanRev:    { name: 'RSI Mean Reversion',       family: 'meanrev' },
    supertrend:    { name: 'Supertrend (10,3)',        family: 'trend' },
};

module.exports = {
    STRATEGIES, STRATEGY_META,
    indicators: { SMA, EMA, RSI, MACD, stochastic, bollinger, ATR, supertrend, ichimoku, rollingVWAP },
};
