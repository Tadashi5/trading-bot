// backtestDualMomentum.js — Is a disciplined momentum-rotation allocation better than
// what we have? Tests the one approach with robust out-of-sample evidence (dual momentum,
// à la Antonacci) against buy-and-hold baselines, on assets the bot can actually trade.
//
// Rule (monthly rebalance): rank assets by 6-month return. Hold the single strongest —
// but ONLY if its own return is positive (absolute momentum = the regime gate). Else cash.
// This is the multi-asset generalization of the 200-MA switch that already made crypto win.
// Measures CAGR, max drawdown, and return/drawdown ratio (what matters for debt recycling).
'use strict';
const axios = require('axios');

const LOOKBACK = 126;   // ~6 trading months
const CASH_YIELD_ANNUAL = 0.045;

async function yahoo(sym) {
    const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=10y`,
        { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const res = r.data?.chart?.result?.[0];
    const ts = res?.timestamp || [], cl = res?.indicators?.quote?.[0]?.close || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) if (cl[i] != null) out.push({ t: ts[i] * 1000, c: cl[i] });
    return out;
}
async function btc() {
    const bases = ['https://data-api.binance.vision', 'https://api.binance.com'];
    for (const b of bases) {
        try {
            let all = [], end = Date.now();
            while (all.length < 2500) {
                const r = await axios.get(`${b}/api/v3/klines`, { params: { symbol: 'BTCUSDT', interval: '1d', limit: 1000, endTime: end }, timeout: 15000 });
                const batch = r.data || []; if (!batch.length) break;
                all = batch.concat(all); end = batch[0][0] - 1;
                if (batch.length < 1000) break;
            }
            const seen = new Set(), c = [];
            for (const k of all.sort((a, b) => a[0] - b[0])) { if (seen.has(k[0])) continue; seen.add(k[0]); c.push({ t: k[0], c: +k[4] }); }
            return c;
        } catch {}
    }
    return [];
}

function maxDD(eq) { let peak = -Infinity, mdd = 0; for (const e of eq) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; } return mdd * 100; }
function cagr(eq, days) { return (Math.pow(eq[eq.length - 1] / eq[0], 365 / days) - 1) * 100; }

(async () => {
    console.log('\nFetching 10y daily data (SPY, QQQ, GLD, TLT, BTC)...');
    const raw = {
        SPY: await yahoo('SPY'), QQQ: await yahoo('QQQ'),
        GLD: await yahoo('GLD'), TLT: await yahoo('TLT'), BTC: await btc(),
    };
    const names = Object.keys(raw).filter(k => raw[k].length > 500);

    // align on a common daily date grid (use SPY's trading days; forward-fill others)
    const spy = raw.SPY;
    const idx = {}; for (const n of names) { idx[n] = new Map(raw[n].map(b => [new Date(b.t).toISOString().slice(0, 10), b.c])); }
    const dates = spy.map(b => new Date(b.t).toISOString().slice(0, 10));
    const px = {}; for (const n of names) { px[n] = []; let last = null; for (const d of dates) { const v = idx[n].get(d) ?? last; last = v; px[n].push(v); } }

    const start = LOOKBACK;
    const dayspan = Math.round((spy[spy.length - 1].t - spy[start].t) / 86400000);
    const from = dates[start], to = dates[dates.length - 1];

    // ── Strategy sims (rebalance monthly = every ~21 trading days) ─────────────
    const REBAL = 21;
    const dailyCash = Math.pow(1 + CASH_YIELD_ANNUAL, 1 / 252) - 1;

    function holdBasket(weights) {   // static buy&hold, daily rebalanced to weights
        const eq = [1];
        for (let i = start + 1; i < dates.length; i++) {
            let r = 0;
            for (const [n, w] of Object.entries(weights)) if (px[n][i - 1]) r += w * (px[n][i] / px[n][i - 1] - 1);
            eq.push(eq[eq.length - 1] * (1 + r));
        }
        return eq;
    }

    function dualMomentum(universe, { topN = 1, safe = 'CASH' } = {}) {
        const eq = [1];
        let held = null;   // current holding
        for (let i = start + 1; i < dates.length; i++) {
            if ((i - start) % REBAL === 1) {
                // rank by 6-mo return; keep only positive-momentum (absolute) names
                const ranked = universe
                    .map(n => ({ n, m: px[n][i - 1] / px[n][i - 1 - LOOKBACK] - 1 }))
                    .filter(x => isFinite(x.m))
                    .sort((a, b) => b.m - a.m);
                const top = ranked.slice(0, topN).filter(x => x.m > 0).map(x => x.n);
                held = top.length ? top : (safe === 'TLT' && px.TLT ? ['TLT'] : null);
            }
            let r;
            if (!held) r = dailyCash;
            else r = held.reduce((s, n) => s + (px[n][i] / px[n][i - 1] - 1), 0) / held.length;
            eq.push(eq[eq.length - 1] * (1 + r));
        }
        return eq;
    }

    // regime-gated single asset: hold when above its own 200-MA, else cash (what crypto does)
    function regimeHold(sym) {
        const eq = [1]; const c = px[sym];
        for (let i = start + 1; i < dates.length; i++) {
            const sma = c.slice(i - 200, i).reduce((s, v) => s + v, 0) / 200;
            const on = c[i - 1] > sma;
            eq.push(eq[eq.length - 1] * (1 + (on ? (c[i] / c[i - 1] - 1) : dailyCash)));
        }
        return eq;
    }
    // diversified hold, but the BTC sleeve is regime-gated (tames its crash drawdown)
    function diversifiedRegimeCrypto(weights) {
        const eq = [1];
        for (let i = start + 1; i < dates.length; i++) {
            let r = 0;
            for (const [n, w] of Object.entries(weights)) {
                if (!px[n][i - 1]) continue;
                if (n === 'BTC') {
                    const sma = px.BTC.slice(i - 200, i).reduce((s, v) => s + v, 0) / 200;
                    r += w * (px.BTC[i - 1] > sma ? (px.BTC[i] / px.BTC[i - 1] - 1) : dailyCash);
                } else r += w * (px[n][i] / px[n][i - 1] - 1);
            }
            eq.push(eq[eq.length - 1] * (1 + r));
        }
        return eq;
    }

    const strategies = {
        'SPY buy&hold':                 holdBasket({ SPY: 1 }),
        'Equal-weight all (hold)':      holdBasket(Object.fromEntries(names.map(n => [n, 1 / names.length]))),
        'Diversified no-BTC (SPY/QQQ/GLD/TLT)': holdBasket({ SPY: 0.3, QQQ: 0.3, GLD: 0.2, TLT: 0.2 }),
        'Diversified + 15% BTC (hold)': holdBasket({ SPY: 0.3, QQQ: 0.25, GLD: 0.2, TLT: 0.1, BTC: 0.15 }),
        'Diversified + 15% BTC (regime-gated)': diversifiedRegimeCrypto({ SPY: 0.3, QQQ: 0.25, GLD: 0.2, TLT: 0.1, BTC: 0.15 }),
        'BTC regime-gated (solo)':      regimeHold('BTC'),
        'Dual-mom top1 (→cash)':        dualMomentum(names, { topN: 1, safe: 'CASH' }),
        'Dual-mom top2 (→cash)':        dualMomentum(names, { topN: 2, safe: 'CASH' }),
    };

    console.log(`\n${'═'.repeat(80)}`);
    console.log(`ALLOCATION BACKTEST — ${dayspan} days (${from} → ${to}), monthly rebalance, net of ~cash yield`);
    console.log('═'.repeat(80));
    console.log('  Strategy                              CAGR    MaxDD    Return/DD  Finalx');
    console.log('  ' + '─'.repeat(74));
    const rows = Object.entries(strategies).map(([name, eq]) => {
        const c = cagr(eq, dayspan), dd = maxDD(eq), mult = eq[eq.length - 1];
        return { name, c, dd, ratio: dd ? c / dd : 0, mult };
    });
    for (const r of rows) {
        console.log(`  ${r.name.padEnd(36)} ${(r.c>=0?'+':'')+r.c.toFixed(1)+'%'}`.padEnd(46) +
            `  ${(-r.dd).toFixed(0)}%`.padStart(7) + `   ${r.ratio.toFixed(2)}`.padStart(9) + `   ${r.mult.toFixed(2)}x`.padStart(9));
    }
    console.log('  ' + '─'.repeat(74));
    const byRatio = [...rows].sort((a, b) => b.ratio - a.ratio);
    console.log(`\n  Best return/drawdown (what matters for debt recycling): ${byRatio[0].name} (${byRatio[0].ratio.toFixed(2)})`);
    console.log(`  Best raw CAGR: ${[...rows].sort((a,b)=>b.c-a.c)[0].name}`);
    console.log('');
})();
