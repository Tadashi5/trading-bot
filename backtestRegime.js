// backtestRegime.js — Does a 200-day MA regime filter beat buy-and-hold over a FULL
// cycle (incl. the 2022 bear)? Rule: long when close > SMA200, cash when below.
// Measures return AND max drawdown. Run: node backtestRegime.js
'use strict';
const axios = require('axios');
const { indicators } = require('./strategyLibrary');
const { SMA } = indicators;
const FEE = 0.001;
const BASES = ['https://data-api.binance.vision', 'https://api.binance.com'];

async function fetchBTC(total = 2000) {           // ~5.5yr daily → captures 2021 top, 2022 bear, recovery
    for (let b = 0; b < BASES.length; b++) {
        try {
            let all = [], endTime = Date.now();
            while (all.length < total) {
                const res = await axios.get(`${BASES[b]}/api/v3/klines`,
                    { params: { symbol: 'BTCUSDT', interval: '1d', limit: 1000, endTime }, timeout: 15000 });
                const batch = res.data || [];
                if (!batch.length) break;
                all = batch.concat(all); endTime = batch[0][0] - 1;
                if (batch.length < 1000) break;
            }
            if (all.length) {
                const seen = new Set(), c = [];
                for (const k of all.sort((a, b) => a[0] - b[0])) { if (seen.has(k[0])) continue; seen.add(k[0]); c.push({ t: k[0], close: +k[4] }); }
                return c.slice(-total);
            }
        } catch { /* next */ }
    }
    return null;
}
async function fetchYahoo(symbol, range = '10y') {
    try {
        const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`,
            { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const r = res.data?.chart?.result?.[0];
        const ts = r?.timestamp || [], cl = r?.indicators?.quote?.[0]?.close || [];
        const c = [];
        for (let i = 0; i < ts.length; i++) if (cl[i] != null) c.push({ t: ts[i] * 1000, close: cl[i] });
        return c.length > 400 ? c : null;
    } catch { return null; }
}

function maxDrawdown(equity) {
    let peak = -Infinity, mdd = 0;
    for (const e of equity) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; }
    return mdd * 100;
}

function run(candles, { buffer = 0 } = {}) {
    const close = candles.map(x => x.close);
    const sma = SMA(close, 200);
    const start = 200;
    // Buy & hold
    const bhEq = [];
    const bhQty = 1 / close[start];
    for (let i = start; i < close.length; i++) bhEq.push(bhQty * close[i]);
    const bhRet = (bhEq[bhEq.length - 1] / bhEq[0] - 1) * 100;

    // 200-MA regime: long when close > sma*(1+buffer up), flat when close < sma*(1-buffer)
    let cash = 1, coins = 0, inPos = false, switches = 0, daysIn = 0;
    const eq = [];
    for (let i = start; i < close.length; i++) {
        const px = close[i];
        const upLine = sma[i] * (1 + buffer), dnLine = sma[i] * (1 - buffer);
        if (!inPos && px > upLine) { coins = cash * (1 - FEE) / px; cash = 0; inPos = true; switches++; }
        else if (inPos && px < dnLine) { cash = coins * px * (1 - FEE); coins = 0; inPos = false; switches++; }
        if (inPos) daysIn++;
        eq.push(cash + coins * px);
    }
    const ret = (eq[eq.length - 1] / eq[0] - 1) * 100;
    return { bhRet, bhMDD: maxDrawdown(bhEq), ret, mdd: maxDrawdown(eq), switches, pctIn: daysIn / eq.length * 100 };
}

(async () => {
    const assets = [];
    console.log('\nFetching full-cycle daily history...');
    const btc = await fetchBTC(2000); if (btc) assets.push(['BTC', btc]);
    const spy = await fetchYahoo('SPY', '10y'); if (spy) assets.push(['SPY', spy]);
    const qqq = await fetchYahoo('QQQ', '10y'); if (qqq) assets.push(['QQQ', qqq]);

    for (const [name, c] of assets) {
        const days = Math.round((c[c.length - 1].t - c[200].t) / 86400000);
        console.log(`\n${'═'.repeat(74)}`);
        console.log(`${name} — full cycle, ${days} days (${new Date(c[200].t).toISOString().slice(0,10)} → ${new Date(c[c.length-1].t).toISOString().slice(0,10)})`);
        console.log('═'.repeat(74));
        const pure = run(c, { buffer: 0 });
        const buf  = run(c, { buffer: 0.02 });
        console.log('  Method                    Return    MaxDrawdown   Switches  %TimeInMkt');
        console.log('  ──────────────────────────────────────────────────────────────────────');
        console.log(`  Buy & Hold                ${fmt(pure.bhRet)}     ${fmt(-pure.bhMDD)}        —         100%`);
        console.log(`  200-MA regime (pure)      ${fmt(pure.ret)}     ${fmt(-pure.mdd)}       ${String(pure.switches).padStart(3)}       ${pure.pctIn.toFixed(0)}%`);
        console.log(`  200-MA regime (2% buffer) ${fmt(buf.ret)}     ${fmt(-buf.mdd)}       ${String(buf.switches).padStart(3)}       ${buf.pctIn.toFixed(0)}%`);
        const best = buf.ret > pure.ret ? buf : pure;
        const verdict = best.ret >= pure.bhRet
            ? `BEATS hold on return AND cuts drawdown ${(pure.bhMDD - best.mdd).toFixed(0)}pts`
            : `trails hold on return by ${(pure.bhRet - best.ret).toFixed(0)}pts BUT cuts drawdown ${(pure.bhMDD - best.mdd).toFixed(0)}pts`;
        console.log(`  → ${verdict}`);
    }
    console.log('\n  Drawdown = worst peak-to-trough loss. The regime filter\'s job is to slash it.\n');
})();
function fmt(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`.padStart(7); }
