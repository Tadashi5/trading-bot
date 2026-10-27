// backtestAsiaExits.js — Isolate WHAT clips Asia winners: take-profit vs trailing stop.
// Fetches the Asia watchlist once, then runs the same momentum entry through several
// exit configs + an exit-reason breakdown. Run: node backtestAsiaExits.js
'use strict';
const axios = require('axios');
const FEE = 0.001, CAPITAL = 1000, MIN_CHG = 2.5;

const ASIA = [
    ['BHP.AX','au'],['CBA.AX','au'],['CSL.AX','au'],['NAB.AX','au'],['RIO.AX','au'],
    ['FMG.AX','au'],['WDS.AX','au'],['REA.AX','au'],['XRO.AX','au'],['WOW.AX','au'],
    ['7203.T','jp'],['6758.T','jp'],['9984.T','jp'],['8306.T','jp'],['6861.T','jp'],
    ['7974.T','jp'],['8035.T','jp'],['6954.T','jp'],['4063.T','jp'],['6098.T','jp'],
    ['0700.HK','cn'],['9988.HK','cn'],['3690.HK','cn'],['1810.HK','cn'],
    ['HSBA.L','uk'],['SHEL.L','uk'],['AZN.L','uk'],['ULVR.L','uk'],
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchDaily(symbol) {
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3y`,
            { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const q = res.data?.chart?.result?.[0]?.indicators?.quote?.[0];
        if (!q) return null;
        const out = [];
        for (let i = 0; i < (q.close || []).length; i++) if (q.close[i] != null) out.push(q.close[i]);
        return out.length > 150 ? out : null;
    } catch { return null; }
}

// cfg: { tp, sl, trail, arm, dead }  — tp/sl in %, trail = pullback-from-high %, dead = flat-days exit (0=off)
// returns { ret, bh, trades, reasons:{tp,sl,trail,dead,end} }
function runCoin(close, cfg) {
    let cash = CAPITAL, sh = 0, inPos = false, entry = 0, high = 0, held = 0, trades = 0;
    const reasons = { tp: 0, sl: 0, trail: 0, dead: 0, end: 0 };
    for (let i = 1; i < close.length; i++) {
        const px = close[i];
        const chg = (close[i] / close[i - 1] - 1) * 100;
        if (!inPos) {
            if (chg >= MIN_CHG) { sh = cash * (1 - FEE) / px; cash = 0; inPos = true; entry = px; high = px; held = 0; }
        } else {
            held++; if (px > high) high = px;
            const upl = (px - entry) / entry * 100;
            const offHigh = (px - high) / high * 100;
            let why = null;
            if (upl >= cfg.tp) why = 'tp';
            else if (upl <= cfg.sl) why = 'sl';
            else if (upl > cfg.arm && offHigh <= -cfg.trail) why = 'trail';
            else if (cfg.dead && held >= cfg.dead && upl < 2 && upl > cfg.sl) why = 'dead';
            if (why) { cash = sh * px * (1 - FEE); sh = 0; inPos = false; trades++; reasons[why]++; }
        }
    }
    const last = close[close.length - 1];
    const eq = cash + sh * last * (inPos ? (1 - FEE) : 1);
    if (inPos) { trades++; reasons.end++; }
    return { ret: (eq / CAPITAL - 1) * 100, bh: (last / close[1] - 1) * 100, trades, reasons };
}

function evalConfig(data, cfg) {
    let sS = 0, sB = 0, n = 0, tr = 0;
    const R = { tp: 0, sl: 0, trail: 0, dead: 0, end: 0 };
    for (const [sym, mkt] of ASIA) {
        if (!data[sym]) continue;
        const t = { ...cfg, tp: cfg.tpByMkt ? cfg.tpByMkt[mkt] : cfg.tp };
        const r = runCoin(data[sym], t);
        sS += r.ret; sB += r.bh; n++; tr += r.trades;
        for (const k in R) R[k] += r.reasons[k];
    }
    return { avgRet: sS / n, avgEdge: (sS - sB) / n, avgTrades: tr / n, reasons: R };
}

(async () => {
    console.log('\nFetching Asia watchlist once (3yr daily)...');
    const data = {};
    for (const [s] of ASIA) { const c = await fetchDaily(s); if (c) data[s] = c; process.stdout.write(c ? '.' : 'x'); await sleep(120); }
    console.log(`\nGot ${Object.keys(data).length}/${ASIA.length} coins.\n`);

    // Baseline (current deployed) with per-market TP
    const baseTP = { au: 8, jp: 8, cn: 12, uk: 8 };

    const configs = [
        ['CURRENT (tp 8/12, trail 3/4, dead 10)',  { tpByMkt: baseTP, sl: -5, trail: 3, arm: 1, dead: 10 }],
        ['NO take-profit (trail 3 only)',           { tp: 9999,        sl: -5, trail: 3, arm: 1, dead: 10 }],
        ['NO trailing stop (tp only)',              { tpByMkt: baseTP, sl: -5, trail: 9999, arm: 1, dead: 10 }],
        ['WIDE trail 8, keep tp',                   { tpByMkt: baseTP, sl: -5, trail: 8, arm: 1, dead: 10 }],
        ['LET IT RUN (no tp, trail 12, no dead)',   { tp: 9999,        sl: -8, trail: 12, arm: 1, dead: 0 }],
        ['LET IT RUN (no tp, trail 20, no dead)',   { tp: 9999,        sl: -10, trail: 20, arm: 1, dead: 0 }],
    ];

    console.log('═'.repeat(84));
    console.log('EXIT CONFIG                              AvgRet   vsHold   Trades   Exit reasons (tp/trail/sl/dead)');
    console.log('─'.repeat(84));
    for (const [label, cfg] of configs) {
        const r = evalConfig(data, cfg);
        const tot = r.reasons.tp + r.reasons.trail + r.reasons.sl + r.reasons.dead + r.reasons.end || 1;
        const pct = k => `${Math.round(r.reasons[k] / tot * 100)}%`;
        console.log(
            `${label.padEnd(40)} ` +
            `${(r.avgRet>=0?'+':'')+r.avgRet.toFixed(0)+'%'}`.padStart(7) + '  ' +
            `${(r.avgEdge>=0?'✓+':'')+r.avgEdge.toFixed(0)}`.padStart(7) + '  ' +
            `${r.avgTrades.toFixed(0)}`.padStart(6) + '   ' +
            `tp ${pct('tp')}  trail ${pct('trail')}  sl ${pct('sl')}  dead ${pct('dead')}`
        );
    }
    console.log('─'.repeat(84));
    console.log('AvgRet = strategy return; vsHold = edge over buy-and-hold; lower/negative edge = worse than holding.\n');
})();
