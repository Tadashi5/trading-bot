// regimeFilter.js — 200-day MA market-regime detector (risk-on / risk-off).
// Backtest (backtestRegime.js): on BTC a 2%-buffer 200-MA filter turned +53%/-77%DD
// buy-and-hold into +163%/-32%DD. Crypto uses it as a HARD switch (block new longs +
// raise cash in risk-off); stocks use it SOFT (block new longs only — US equities grind
// up, so holding through shallow dips wins). Fails safe to risk-on if data is missing.
'use strict';
const axios = require('axios');
const fs   = require('fs');
const path = require('path');
const { indicators: { SMA } } = require('./strategyLibrary');

const DATA_DIR = require('./dataDir');
const STATE    = path.join(DATA_DIR, 'regime-state.json');
const BUFFER   = 0.02;   // 2% hysteresis — flip off below MA·0.98, on above MA·1.02 (cuts whipsaws)

let cache = load();
function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { crypto: null, stocks: null, updatedAt: null }; } }
function save() { try { fs.writeFileSync(STATE, JSON.stringify(cache, null, 2)); } catch {} }

async function dailyCloses(kind) {
    try {
        if (kind === 'crypto') {
            const res = await axios.get('https://data-api.binance.vision/api/v3/klines',
                { params: { symbol: 'BTCUSDT', interval: '1d', limit: 300 }, timeout: 12000 });
            return (res.data || []).map(k => +k[4]);
        } else {
            const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=2y',
                { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            return (res.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(x => x != null);
        }
    } catch { return null; }
}

// Hysteresis decision — keep prior state unless price clears the buffered band
function decide(prev, price, sma) {
    if (!sma || !price) return prev;
    const wasOn = prev ? prev.riskOn : price > sma;
    let on = wasOn;
    if (wasOn && price < sma * (1 - BUFFER)) on = false;
    else if (!wasOn && price > sma * (1 + BUFFER)) on = true;
    return {
        riskOn: on,
        price: +price.toFixed(2),
        sma200: +sma.toFixed(2),
        pctFromMA: +((price / sma - 1) * 100).toFixed(1),
        since: (prev && prev.riskOn === on && prev.since) ? prev.since : new Date().toISOString(),
    };
}

async function refresh() {
    for (const kind of ['crypto', 'stocks']) {
        const closes = await dailyCloses(kind);
        if (closes && closes.length > 200) {
            const sma = SMA(closes, 200);
            cache[kind] = decide(cache[kind], closes[closes.length - 1], sma[sma.length - 1]);
        }
    }
    cache.updatedAt = new Date().toISOString();
    save();
    return cache;
}

// Fail-safe: unknown → risk-on (never freeze trading on a data hiccup)
function getRegime(kind) {
    return cache[kind] || { riskOn: true, note: 'no data yet — default risk-on', pctFromMA: null };
}

function all() { return cache; }

module.exports = { refresh, getRegime, all };
