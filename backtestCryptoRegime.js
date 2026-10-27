// backtestCryptoRegime.js — Should the crypto regime be a single BTC switch (current)
// or per-coin? Compares 3 strategies on an equal-weight basket of the liquid watchlist
// coins, measuring RETURN and MAX DRAWDOWN over the full available daily history.
//
//   buy&hold     — always hold the basket
//   btc-global   — hold ALL coins only when BTC > BTC's 200-MA, else cash (CURRENT)
//   per-coin     — hold each coin only when THAT coin > its own 200-MA, else its sleeve is cash
//
// Run: node backtestCryptoRegime.js
'use strict';
const axios = require('axios');
const { indicators: { SMA } } = require('./strategyLibrary');

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'LINK', 'AVAX', 'DOGE'];
const BASE  = 'https://data-api.binance.vision';
const FEE   = 0.001;      // 0.1% per side on each switch
const BUFFER = 0.02;      // 2% hysteresis, same as the live regimeFilter

async function daily(sym, limit = 1000) {
    const r = await axios.get(`${BASE}/api/v3/klines`, { params: { symbol: sym + 'USDT', interval: '1d', limit }, timeout: 15000 });
    return r.data.map(k => ({ t: k[0], close: +k[4] }));
}

function maxDD(equity) {
    let peak = -Infinity, mdd = 0;
    for (const e of equity) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; }
    return mdd * 100;
}

// hysteresis regime signal for one series: true=hold, false=cash
function regimeSignals(close, sma) {
    const sig = new Array(close.length).fill(false);
    let on = false;
    for (let i = 0; i < close.length; i++) {
        if (sma[i] == null) { sig[i] = false; continue; }
        if (!on && close[i] > sma[i] * (1 + BUFFER)) on = true;
        else if (on && close[i] < sma[i] * (1 - BUFFER)) on = false;
        sig[i] = on;
    }
    return sig;
}

(async () => {
    console.log('\nFetching daily history for', COINS.join(', '), '...');
    const data = {};
    for (const c of COINS) { try { data[c] = await daily(c); } catch { console.log('  ✗ '+c); } }
    const have = Object.keys(data);

    // align to the shortest common length (from the end)
    const minLen = Math.min(...have.map(c => data[c].length));
    const start = 200;                        // need 200d for the MA
    if (minLen <= start + 30) { console.log('Not enough overlapping history.'); return; }

    // precompute closes + SMA + signals per coin, trimmed to common length
    const coin = {};
    for (const c of have) {
        const series = data[c].slice(-minLen);
        const close = series.map(x => x.close);
        const sma = SMA(close, 200);
        coin[c] = { close, sma, sig: regimeSignals(close, sma) };
    }
    const btcSig = coin['BTC'] ? coin['BTC'].sig : null;
    const days = minLen - start;
    const from = new Date(data['BTC'].slice(-minLen)[start].t).toISOString().slice(0, 10);
    const to   = new Date(data['BTC'].slice(-minLen)[minLen - 1].t).toISOString().slice(0, 10);

    // simulate an equal-weight basket: each coin gets 1/N of capital, rebalanced daily by
    // its own sleeve. Returns {ret, mdd, pctIn}. `mode` picks the hold signal per coin/day.
    function run(mode) {
        const N = have.length;
        // each sleeve tracks units held + cash
        const sleeve = {};
        for (const c of have) sleeve[c] = { cash: 1 / N, units: 0, inPos: false };
        const eq = [];
        let daysInSum = 0;
        for (let i = start; i < minLen; i++) {
            let inCount = 0;
            for (const c of have) {
                const px = coin[c].close[i];
                const want = mode === 'hold' ? true
                           : mode === 'btc'  ? (btcSig ? btcSig[i] : true)
                           : coin[c].sig[i];               // per-coin
                const s = sleeve[c];
                if (want && !s.inPos) { s.units = s.cash * (1 - FEE) / px; s.cash = 0; s.inPos = true; }
                else if (!want && s.inPos) { s.cash = s.units * px * (1 - FEE); s.units = 0; s.inPos = false; }
                if (s.inPos) inCount++;
            }
            let total = 0;
            for (const c of have) { const s = sleeve[c]; total += s.cash + s.units * coin[c].close[i]; }
            eq.push(total);
            daysInSum += inCount / N;
        }
        const ret = (eq[eq.length - 1] / eq[0] - 1) * 100;
        return { ret, mdd: maxDD(eq), pctIn: daysInSum / eq.length * 100 };
    }

    const hold = run('hold'), btc = run('btc'), per = run('per');

    console.log(`\n${'═'.repeat(78)}`);
    console.log(`CRYPTO REGIME COMPARISON — equal-weight basket of ${have.length} coins`);
    console.log(`${days} days (${from} → ${to})`);
    console.log('═'.repeat(78));
    console.log('  Strategy                    Return    MaxDrawdown   %TimeInMarket');
    console.log('  ' + '─'.repeat(70));
    const fmt = v => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`.padStart(7);
    console.log(`  Buy & Hold (no filter)      ${fmt(hold.ret)}     ${fmt(-hold.mdd)}         100%`);
    console.log(`  BTC-global switch (CURRENT) ${fmt(btc.ret)}     ${fmt(-btc.mdd)}         ${btc.pctIn.toFixed(0)}%`);
    console.log(`  Per-coin 200-MA             ${fmt(per.ret)}     ${fmt(-per.mdd)}         ${per.pctIn.toFixed(0)}%`);
    console.log('  ' + '─'.repeat(70));
    const best = [['Buy&Hold', hold], ['BTC-global', btc], ['Per-coin', per]].sort((a, b) => b[1].ret - a[1].ret)[0];
    const lowestDD = [['Buy&Hold', hold], ['BTC-global', btc], ['Per-coin', per]].sort((a, b) => a[1].mdd - b[1].mdd)[0];
    console.log(`\n  Best return: ${best[0]} (${fmt(best[1].ret)})`);
    console.log(`  Lowest drawdown: ${lowestDD[0]} (${fmt(-lowestDD[1].mdd)})`);
    console.log(`  → Per-coin vs BTC-global: return ${(per.ret - btc.ret >= 0 ? '+' : '')}${(per.ret - btc.ret).toFixed(0)}pts, drawdown ${(per.mdd - btc.mdd >= 0 ? '+' : '')}${(per.mdd - btc.mdd).toFixed(0)}pts\n`);
})();
