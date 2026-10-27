// backtestExitMethods.js — Compare 4 exit methods on how well they capture the top
// of a run. Same 20-day breakout entry + uniform -8% hard stop for all, so ONLY the
// trailing/top-exit logic differs. Yahoo daily OHLCV (3yr). Run: node backtestExitMethods.js
//
//   fixed      — current: 10% trail from highest close
//   chandelier — exit when close < peakHigh - 3×ATR (volatility-adaptive)
//   ema        — exit on close below the rising 20-EMA (structure break)
//   volTighten — wide 15% trail, but tighten to 5% when a down day comes on high volume
'use strict';
const axios = require('axios');
const { indicators } = require('./strategyLibrary');
const { ATR, EMA, SMA } = indicators;

const FEE = 0.001, CAPITAL = 1000, HARD_STOP = -8, BREAKOUT = 20;
const US = ['TSLA','NVDA','AMD','MSTR','COIN','SPY','AAPL','META','AMZN','GOOGL',
            'MSFT','NFLX','PLTR','GME','AMC','SOFI','RIVN','ARM','SMCI','BABA',
            'UBER','SNAP','RBLX','HOOD','IONQ'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOHLCV(symbol) {
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3y`,
            { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const q = res.data?.chart?.result?.[0]?.indicators?.quote?.[0];
        if (!q) return null;
        const c = [];
        for (let i = 0; i < (q.close || []).length; i++) {
            if (q.close[i] == null) continue;
            c.push({ close: q.close[i], high: q.high[i] ?? q.close[i], low: q.low[i] ?? q.close[i], vol: q.volume[i] ?? 0 });
        }
        return c.length > 250 ? c : null;
    } catch { return null; }
}

function hh(arr, i, p) { let h = -Infinity; for (let j = i - p; j < i; j++) if (arr[j] > h) h = arr[j]; return h; }

function simulate(c, method) {
    const close = c.map(x => x.close), high = c.map(x => x.high), low = c.map(x => x.low), vol = c.map(x => x.vol);
    const atr = ATR(high, low, close, 14), ema20 = EMA(close, 20), avgVol = SMA(vol, 20);
    let cash = CAPITAL, sh = 0, inPos = false, entry = 0, hhClose = 0, peakHigh = 0;
    let trades = 0, wins = 0, sumGiveback = 0;

    for (let i = BREAKOUT; i < c.length; i++) {
        const px = close[i];
        if (!inPos) {
            if (px > hh(high, i, BREAKOUT)) { sh = cash * (1 - FEE) / px; cash = 0; inPos = true; entry = px; hhClose = px; peakHigh = high[i]; }
        } else {
            if (px > hhClose) hhClose = px;
            if (high[i] > peakHigh) peakHigh = high[i];
            const upl = (px - entry) / entry * 100;
            let exit = false;
            if (upl <= HARD_STOP) exit = true;                                       // uniform hard stop
            else if (method === 'fixed')      exit = px <= hhClose * 0.90;
            else if (method === 'chandelier') exit = atr[i] != null && px < peakHigh - 3 * atr[i];
            else if (method === 'ema')        exit = ema20[i] != null && px < ema20[i];
            else if (method === 'volTighten') {
                const down = px < close[i - 1];
                const bigVol = avgVol[i] != null && vol[i] > 1.5 * avgVol[i];
                const trail = (down && bigVol) ? 0.05 : 0.15;
                exit = px <= hhClose * (1 - trail);
            }
            if (exit) {
                cash = sh * px * (1 - FEE); sh = 0; inPos = false; trades++;
                if (px > entry) wins++;
                sumGiveback += (peakHigh - px) / peakHigh * 100;
            }
        }
    }
    const last = close[close.length - 1];
    const eq = cash + sh * last * (inPos ? (1 - FEE) : 1);
    if (inPos) { trades++; if (last > entry) wins++; sumGiveback += (peakHigh - last) / peakHigh * 100; }
    return { ret: (eq / CAPITAL - 1) * 100, bh: (last / close[BREAKOUT] - 1) * 100, trades, wins, giveback: trades ? sumGiveback / trades : 0 };
}

(async () => {
    console.log('\nFetching US watchlist OHLCV (Yahoo daily, 3yr)...');
    const data = {};
    for (const s of US) { const c = await fetchOHLCV(s); if (c) data[s] = c; process.stdout.write(c ? '.' : 'x'); await sleep(120); }
    const names = Object.keys(data);
    console.log(`\nGot ${names.length}/${US.length} names.\n`);

    const methods = ['fixed', 'chandelier', 'ema', 'volTighten'];
    const labels = { fixed: 'FIXED 10% trail (CURRENT)', chandelier: 'CHANDELIER (peak - 3×ATR)', ema: 'EMA-20 break', volTighten: 'VOLUME-TIGHTEN trail' };

    const agg = {};
    for (const m of methods) agg[m] = { ret: 0, bh: 0, trades: 0, wins: 0, giveback: 0, n: 0 };
    for (const s of names) {
        for (const m of methods) {
            const r = simulate(data[s], m);
            agg[m].ret += r.ret; agg[m].bh += r.bh; agg[m].trades += r.trades;
            agg[m].wins += r.wins; agg[m].giveback += r.giveback; agg[m].n++;
        }
    }

    console.log('═'.repeat(86));
    console.log('EXIT METHOD COMPARISON — same breakout entry + -8% stop, only the top-exit differs');
    console.log('═'.repeat(86));
    console.log('  Method                       AvgRet   vsHold   Trades  WinRate   GiveBack-from-peak');
    console.log('  ────────────────────────────────────────────────────────────────────────────────');
    const rows = methods.map(m => {
        const a = agg[m];
        return { m, ret: a.ret / a.n, edge: (a.ret - a.bh) / a.n, trades: a.trades / a.n, wr: a.wins / a.trades * 100, gb: a.giveback / a.n };
    }).sort((x, y) => y.ret - x.ret);
    for (const r of rows) {
        console.log(`  ${labels[r.m].padEnd(28)} ` +
            `${(r.ret>=0?'+':'')+r.ret.toFixed(0)+'%'}`.padStart(7) + '  ' +
            `${(r.edge>=0?'✓+':'')+r.edge.toFixed(0)}`.padStart(7) + '  ' +
            `${r.trades.toFixed(1)}`.padStart(6) + '   ' +
            `${r.wr.toFixed(0)}%`.padStart(5) + '     ' +
            `${r.gb.toFixed(1)}% below peak`);
    }
    console.log('  ────────────────────────────────────────────────────────────────────────────────');
    console.log(`  Buy & Hold avg: +${(agg.fixed.bh/agg.fixed.n).toFixed(0)}%   |   GiveBack = avg % below the run's peak at exit (lower = exits closer to top)`);
    console.log(`\n  Winner by return: ${labels[rows[0].m]} (+${rows[0].ret.toFixed(0)}% avg, ${rows[0].gb.toFixed(1)}% below peak)\n`);
})();
