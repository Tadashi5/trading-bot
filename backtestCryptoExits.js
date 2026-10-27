// backtestCryptoExits.js — Validate/tune the crypto exit logic (crypto.js) on the
// bot's REAL coin list. Entry = momentum proxy (24h change ≥ threshold, mirroring the
// priceMomentum score component); exits = the deployed take-profit / trail-from-high.
// Compares vs buy-and-hold per coin and grid-searches TP/trail. Run: node backtestCryptoExits.js
'use strict';
const axios = require('axios');

const FEE = 0.001, CAPITAL = 1000, ENTER_THRESH = 3;   // enter when prior 24h change ≥ 3%
const BASES = ['https://data-api.binance.vision', 'https://api.binance.com'];

// Bot's crypto watchlist → Binance USDT symbols (memes flagged for the tighter exit set)
const COINS = [
    ['BTCUSDT', 0], ['ETHUSDT', 0], ['SOLUSDT', 0], ['XRPUSDT', 0], ['ADAUSDT', 0],
    ['AVAXUSDT', 0], ['LINKUSDT', 0], ['LTCUSDT', 0], ['BCHUSDT', 0], ['DOTUSDT', 0],
    ['UNIUSDT', 0], ['AAVEUSDT', 0], ['MKRUSDT', 0], ['GRTUSDT', 0], ['CRVUSDT', 0],
    ['XTZUSDT', 0], ['DOGEUSDT', 1], ['SHIBUSDT', 1], ['PEPEUSDT', 1], ['BONKUSDT', 1],
    ['WIFUSDT', 1], ['FLOKIUSDT', 1],
];

async function fetchDaily(symbol, total = 1000) {
    for (let b = 0; b < BASES.length; b++) {
        try {
            let all = [], endTime = Date.now();
            while (all.length < total) {
                const res = await axios.get(`${BASES[b]}/api/v3/klines`,
                    { params: { symbol, interval: '1d', limit: 1000, endTime }, timeout: 12000 });
                const batch = res.data || [];
                if (!batch.length) break;
                all = batch.concat(all); endTime = batch[0][0] - 1;
                if (batch.length < 1000) break;
            }
            if (all.length) {
                const seen = new Set(), c = [];
                for (const k of all.sort((a, b) => a[0] - b[0])) {
                    if (seen.has(k[0])) continue; seen.add(k[0]);
                    c.push({ close: +k[4], high: +k[2], low: +k[3] });
                }
                return c.slice(-total);
            }
        } catch { /* try next base */ }
    }
    return null;
}

// Run the momentum-entry + exit strategy over one coin's daily closes.
function runCoin(candles, { tp, trail, arm, hardStop }) {
    let cash = CAPITAL, coins = 0, inPos = false, entry = 0, high = 0, trades = 0, wins = 0;
    for (let i = 1; i < candles.length; i++) {
        const px = candles[i].close;
        const chg = (candles[i].close / candles[i - 1].close - 1) * 100;
        if (!inPos) {
            if (chg >= ENTER_THRESH) { coins = cash * (1 - FEE) / px; cash = 0; inPos = true; entry = px; high = px; }
        } else {
            if (px > high) high = px;
            const upl = (px - entry) / entry * 100;
            const offHigh = (px - high) / high * 100;
            let exit = null;
            if (upl >= tp) exit = 'tp';
            else if (hardStop && upl <= -hardStop) exit = 'stop';
            else if (upl > arm && offHigh <= -trail) exit = 'trail';
            if (exit) { cash = coins * px * (1 - FEE); coins = 0; inPos = false; trades++; if (px > entry) wins++; }
        }
    }
    const last = candles[candles.length - 1].close;
    const eq = cash + coins * last * (inPos ? (1 - FEE) : 1);
    if (inPos) { trades++; if (last > entry) wins++; }
    return { ret: (eq / CAPITAL - 1) * 100, trades, wins, bh: (last / candles[1].close - 1) * 100 };
}

(async () => {
    console.log('\nFetching daily history for the bot\'s crypto watchlist...');
    const data = {};
    for (const [sym] of COINS) {
        const c = await fetchDaily(sym);
        if (c && c.length > 100) data[sym] = c;
        process.stdout.write(c && c.length > 100 ? '.' : 'x');
    }
    console.log(`\nGot ${Object.keys(data).length}/${COINS.length} coins with usable history.\n`);

    // ── 1. DEPLOYED CONFIG — per-coin breakdown ──────────────────────────────
    const deployed = { tp: 15, trail: 8, arm: 2, hardStop: 0 };       // majors
    const deployedMeme = { tp: 10, trail: 5, arm: 2, hardStop: 0 };   // memes
    console.log('═'.repeat(78));
    console.log('DEPLOYED EXIT CONFIG  (majors TP+15%/trail-8%, memes TP+10%/trail-5%, arm +2%)');
    console.log('═'.repeat(78));
    console.log('  Coin        Strategy    Buy&Hold     Edge   Trades  WinRate');
    console.log('  ─────────────────────────────────────────────────────────────');
    let sStrat = 0, sBH = 0, n = 0;
    for (const [sym, meme] of COINS) {
        if (!data[sym]) continue;
        const cfg = meme ? deployedMeme : deployed;
        const r = runCoin(data[sym], cfg);
        const edge = r.ret - r.bh;
        sStrat += r.ret; sBH += r.bh; n++;
        console.log(`  ${sym.replace('USDT','').padEnd(8)} ${(r.ret>=0?'+':'')+r.ret.toFixed(0)+'%'}`.padEnd(24) +
            `${(r.bh>=0?'+':'')+r.bh.toFixed(0)+'%'}`.padStart(8) + '  ' +
            `${edge>=0?'✓':' '}${(edge>=0?'+':'')+edge.toFixed(0)}`.padStart(7) + '  ' +
            `${String(r.trades).padStart(5)}   ${r.trades?((r.wins/r.trades)*100).toFixed(0):0}%`);
    }
    console.log('  ─────────────────────────────────────────────────────────────');
    console.log(`  AVG        ${(sStrat/n>=0?'+':'')+(sStrat/n).toFixed(0)}%`.padEnd(24) +
        `${(sBH/n>=0?'+':'')+(sBH/n).toFixed(0)}%`.padStart(8) +
        `  ${((sStrat-sBH)/n>=0?'✓+':'')+((sStrat-sBH)/n).toFixed(0)} avg edge`);

    // ── 2. GRID SEARCH — is 15/8 the right pick? (majors only) ────────────────
    console.log('\n' + '═'.repeat(78));
    console.log('PARAMETER GRID (majors) — avg return across coins for each TP × trail combo');
    console.log('═'.repeat(78));
    const tps = [10, 15, 20, 25, 30], trails = [5, 8, 12, 15, 20];
    let header = '  TP\\Trail ';
    trails.forEach(t => header += `  -${t}%`.padStart(8));
    console.log(header);
    let best = { edge: -Infinity };
    for (const tp of tps) {
        let row = `  +${tp}%`.padEnd(11);
        for (const trail of trails) {
            let sS = 0, sB = 0, m = 0;
            for (const [sym, meme] of COINS) {
                if (!data[sym] || meme) continue;
                const r = runCoin(data[sym], { tp, trail, arm: 2, hardStop: 0 });
                sS += r.ret; sB += r.bh; m++;
            }
            const avg = sS / m, edge = (sS - sB) / m;
            if (edge > best.edge) best = { edge, tp, trail, avg };
            row += `${(avg>=0?'+':'')+avg.toFixed(0)}%`.padStart(8);
        }
        console.log(row);
    }
    console.log('  (cells = avg strategy return; higher = better)');
    console.log(`\n  ★ Best combo: TP +${best.tp}% / trail -${best.trail}%  →  ${best.avg.toFixed(0)}% avg return, +${best.edge.toFixed(0)}% edge vs hold`);
    console.log(`    Deployed is TP +15% / trail -8%. ${best.tp===15&&best.trail===8?'✓ deployed is optimal':'→ consider retuning'}\n`);
})();
