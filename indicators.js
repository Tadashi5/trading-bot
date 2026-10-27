// indicators.js — Technical indicators: MACD, EMA, Bollinger Bands, ATR
// Fetches daily bars from Alpaca and computes indicators for any symbol batch.
require('dotenv').config();
const axios = require('axios');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const DATA_BASE = 'https://data.alpaca.markets/v2';

// ── Bar fetching ──────────────────────────────────────────────────────────────

async function getDailyBars(symbols, limit = 210) {
    // Need 200+ bars for EMA(200). Alpaca's bars endpoint returns 0 bars when given
    // ONLY a limit — it needs an explicit start/end window. Without this, EVERY indicator
    // (RSI/MACD/EMA/Bollinger/ATR) silently returned empty and contributed 0 to scoring.
    // end is 20 min back to respect the free IEX feed's 15-min-delay restriction.
    try {
        // Alpaca returns bars OLDEST-first and truncates to `limit` from the start — so a
        // low limit gives ancient bars, not recent ones. Size the WINDOW to ~limit trading
        // days and set the API limit high so we get every bar up to NOW, then compute on the
        // tail. end is 20 min back to respect the free IEX feed's 15-min-delay restriction.
        const end = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        const calDays = Math.ceil(limit * 1.5) + 15;            // calendar days ⊃ `limit` trading days
        const start = new Date(Date.now() - calDays * 86400000).toISOString();
        const res = await axios.get(`${DATA_BASE}/stocks/bars`, {
            headers: HEADERS,
            params: { symbols: symbols.join(','), timeframe: '1Day', start, end, limit: 10000, feed: 'iex' },
        });
        return res.data.bars || {};
    } catch { return {}; }
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function sma(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((s, v) => s + v, 0) / period;
}

function ema(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let em = sma(values.slice(0, period), period);
    for (let i = period; i < values.length; i++) {
        em = values[i] * k + em * (1 - k);
    }
    return em;
}

function stdDev(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    const mean = slice.reduce((s, v) => s + v, 0) / period;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    return Math.sqrt(variance);
}

// ── Indicator calculations ────────────────────────────────────────────────────

function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d; else losses -= d;
    }
    if (losses === 0) return 100;
    return parseFloat((100 - 100 / (1 + (gains / period) / (losses / period))).toFixed(1));
}

function calcMACD(closes) {
    // MACD = EMA(12) - EMA(26), Signal = EMA(9) of MACD line
    if (closes.length < 35) return null;
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    if (ema12 === null || ema26 === null) return null;

    // Build MACD line history for signal calculation
    const macdLine = [];
    const k12 = 2 / 13, k26 = 2 / 27;
    let e12 = sma(closes.slice(0, 12), 12);
    let e26 = sma(closes.slice(0, 26), 26);
    for (let i = 26; i < closes.length; i++) {
        e12 = closes[i] * k12 + e12 * (1 - k12);
        e26 = closes[i] * k26 + e26 * (1 - k26);
        macdLine.push(e12 - e26);
    }

    const macd   = macdLine[macdLine.length - 1];
    const signal = ema(macdLine, 9);
    const histogram = signal !== null ? macd - signal : 0;

    return {
        macd:      parseFloat(macd.toFixed(3)),
        signal:    signal !== null ? parseFloat(signal.toFixed(3)) : null,
        histogram: parseFloat(histogram.toFixed(3)),
        bullish:   histogram > 0,     // MACD above signal = bullish momentum
        crossover: macdLine.length >= 2 && macdLine[macdLine.length - 2] < (signal || 0) && macd > (signal || 0),
    };
}

function calcEMAs(closes) {
    return {
        ema20:  closes.length >= 20  ? parseFloat(ema(closes, 20).toFixed(2))  : null,
        ema50:  closes.length >= 50  ? parseFloat(ema(closes, 50).toFixed(2))  : null,
        ema200: closes.length >= 200 ? parseFloat(ema(closes, 200).toFixed(2)) : null,
    };
}

function calcBollinger(closes, period = 20, mult = 2) {
    if (closes.length < period) return null;
    const middle = sma(closes, period);
    const sd     = stdDev(closes, period);
    const price  = closes[closes.length - 1];
    const upper  = middle + mult * sd;
    const lower  = middle - mult * sd;
    // %B = (price - lower) / (upper - lower) — 0 = at lower band, 1 = at upper band
    const pctB = (price - lower) / (upper - lower);

    return {
        upper:  parseFloat(upper.toFixed(2)),
        middle: parseFloat(middle.toFixed(2)),
        lower:  parseFloat(lower.toFixed(2)),
        pctB:   parseFloat(pctB.toFixed(3)),
        squeeze: (upper - lower) / middle < 0.04,  // bands tight = potential breakout
    };
}

function calcATR(bars, period = 14) {
    if (bars.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
        const high  = bars[i].h;
        const low   = bars[i].l;
        const prevC = bars[i - 1].c;
        const tr = Math.max(high - low, Math.abs(high - prevC), Math.abs(low - prevC));
        trs.push(tr);
    }
    // Simple ATR (average of last `period` true ranges)
    const recent = trs.slice(-period);
    return parseFloat((recent.reduce((s, v) => s + v, 0) / period).toFixed(2));
}

// ── Trend detection ───────────────────────────────────────────────────────────

function detectTrend(price, emas) {
    if (!emas.ema20 || !emas.ema50) return 'unknown';
    if (price > emas.ema20 && emas.ema20 > emas.ema50) return 'uptrend';
    if (price < emas.ema20 && emas.ema20 < emas.ema50) return 'downtrend';
    return 'sideways';
}

// ── Score adjustment from indicators ──────────────────────────────────────────
// Returns a number to add to the base score. Positive = bullish, negative = bearish.

function indicatorBias(ind) {
    if (!ind) return 0;
    let bias = 0;

    // MACD
    if (ind.macd) {
        if (ind.macd.crossover) bias += 2;           // bullish crossover = strong
        else if (ind.macd.bullish) bias += 0.5;      // above signal = mild bullish
        else bias -= 0.5;                            // below signal = mild bearish
    }

    // EMA trend
    if (ind.trend === 'uptrend') bias += 1;
    if (ind.trend === 'downtrend') bias -= 1;

    // Bollinger Bands
    if (ind.bollinger) {
        if (ind.bollinger.pctB < 0.05) bias += 1.5;  // at lower band = oversold bounce
        if (ind.bollinger.pctB > 0.95) bias -= 1.5;  // at upper band = overbought
        if (ind.bollinger.squeeze) bias += 0.5;       // squeeze = breakout coming (favor entry)
    }

    // RSI (supplement existing filter)
    if (ind.rsi !== null) {
        if (ind.rsi < 25) bias += 1;    // deeply oversold
        if (ind.rsi > 80) bias -= 1;    // deeply overbought
    }

    return parseFloat(bias.toFixed(1));
}

// ── Main batch analysis ───────────────────────────────────────────────────────

async function analyze(symbols) {
    const allBars = await getDailyBars(symbols, 210);
    const results = {};

    for (const symbol of symbols) {
        const bars = allBars[symbol];
        if (!bars || bars.length < 20) {
            results[symbol] = null;
            continue;
        }

        const closes = bars.map(b => b.c);
        const price  = closes[closes.length - 1];

        const rsi       = calcRSI(closes);
        const macd      = calcMACD(closes);
        const emas      = calcEMAs(closes);
        const bollinger = calcBollinger(closes);
        const atr       = calcATR(bars);
        const trend     = detectTrend(price, emas);

        const ind = { rsi, macd, emas, bollinger, atr, trend, price };
        ind.bias = indicatorBias(ind);

        results[symbol] = ind;
    }

    return results;
}

module.exports = { analyze, indicatorBias, calcRSI, calcMACD, calcEMAs, calcBollinger, calcATR };
