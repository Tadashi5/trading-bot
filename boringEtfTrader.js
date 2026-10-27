// boringEtfTrader.js — Buy-and-hold DCA simulator for "boring" index ETFs.
//
// This is the DEBT-RECYCLING CORE simulation. Unlike the active paper traders,
// it NEVER sells on momentum. It dollar-cost-averages a fixed amount into a
// target allocation of low-cost AU/global index ETFs on a weekly schedule,
// holds forever, and tracks the things that matter for debt recycling:
//   • Franked dividends (the tax-deductibility engine)
//   • Total return vs simply holding cash in an offset/HISA
//   • Average cost, units accumulated, time in market
//
// Prices: Yahoo Finance (same source asian.js uses for .AX symbols).
require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const fees  = require('./fees');

const DATA_DIR   = require('./dataDir');
const STATE_FILE = path.join(DATA_DIR, 'boring-etf-paper.json');

// ── Strategy parameters ───────────────────────────────────────────────────────
const STARTING_CASH   = 10000;   // FIXED starting capital — buy-and-hold, no top-ups.
const MODEL           = 'holdv2';// state-model version; bumping it migrates old (deposit-based) state
const HISA_RATE       = 0.045;   // 4.5% benchmark — what cash would earn in offset/HISA

// Boring core — low-cost, broad index ETFs + GOLD. Backtest (backtestDualMomentum.js)
// showed adding an uncorrelated gold sleeve improved return/drawdown across every
// diversified portfolio — it's the clearest free diversification win, so ~20% gold now.
// Yields/franking are approximate, used only to SIMULATE income; franking matters for AU
// debt recycling because franked dividends carry tax credits.
const WATCHLIST = {
    'A200.AX': { name: 'Betashares Australia 200', target: 0.35, yield: 0.038, franking: 0.75 },
    'VGS.AX':  { name: 'Vanguard Global Shares',   target: 0.30, yield: 0.018, franking: 0.00 },
    'GOLD.AX': { name: 'Global X Physical Gold',   target: 0.20, yield: 0.000, franking: 0.00 },
    'VAS.AX':  { name: 'Vanguard Australian Shares',target: 0.10, yield: 0.036, franking: 0.75 },
    'VGE.AX':  { name: 'Vanguard Emerging Markets', target: 0.05, yield: 0.028, franking: 0.00 },
};

// ── State ──────────────────────────────────────────────────────────────────────

function blankState() {
    return {
        model: MODEL,
        cash: STARTING_CASH,
        startingCash: STARTING_CASH,
        invested: 0,                 // total $ deployed into ETFs (from the fixed start, never external)
        positions: {},               // symbol -> { units, costBasis, lastPrice, name }
        dividends: { received: 0, frankingCredits: 0, history: [] },
        contributions: [],           // log of each deploy (internal only)
        equityHistory: [],           // daily { t, system, benchmark } for the comparison chart
        lastDcaDate: null,
        lastDivAccrual: null,
        createdAt: new Date().toISOString(),
    };
}

function loadState() {
    let s;
    try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { s = blankState(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); return s; }
    // Migration: the old model injected $500/week of EXTERNAL cash, so its value/chart was
    // inflated by deposits. New model is a fixed $10k buy-and-hold. Reset once to a clean
    // start so P&L reflects ONLY market gains from the starting capital.
    if (s.model !== MODEL) {
        console.log('[Boring ETF] Migrating to fixed-$10k buy-and-hold (was deposit-based) — resetting to clean start');
        s = blankState();
        fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
    }
    return s;
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Price fetch (Yahoo Finance, same as asian.js) ────────────────────────────

async function fetchPrice(symbol) {
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const closes = res.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
        const valid = closes.filter(c => c != null);
        return valid.length ? valid[valid.length - 1] : null;
    } catch {
        return null;
    }
}

// ── Dividend accrual ──────────────────────────────────────────────────────────
// Accrue dividends daily based on annual yield, so the sim reflects the income
// that makes debt recycling work. Franking credits tracked separately for tax.

function accrueDividends(state, priceMap) {
    const now = new Date();
    const last = state.lastDivAccrual ? new Date(state.lastDivAccrual) : null;
    if (last) {
        const daysElapsed = (now - last) / 86400000;
        if (daysElapsed < 1) return; // accrue at most once a day
    }
    const daysSince = last ? Math.min(7, (now - last) / 86400000) : 1;

    for (const [sym, pos] of Object.entries(state.positions)) {
        const meta = WATCHLIST[sym];
        if (!meta || !pos.units) continue;
        const price = priceMap[sym] || pos.lastPrice || pos.costBasis;
        const marketValue = pos.units * price;
        const dailyDiv = marketValue * meta.yield / 365 * daysSince;
        const franking = dailyDiv * meta.franking * (0.30 / 0.70); // gross-up at 30% company tax

        state.dividends.received += dailyDiv;
        state.dividends.frankingCredits += franking;
        state.cash += dailyDiv; // dividends reinvested into cash buffer (DRP-style next DCA)
    }
    state.lastDivAccrual = now.toISOString();
}

// ── DCA buy — invest WEEKLY_DCA across target allocation ─────────────────────

async function runDca(state, priceMap) {
    // Deploy AVAILABLE cash toward the target allocation, then hold. No weekly external
    // top-up any more — this is a fixed-starting-capital buy-and-hold. On the first scan
    // it invests the $10k across the target weights; after that cash only trickles in from
    // reinvested dividends (DRP-style), which get deployed here. No external money, ever.
    const investable = state.cash - 20;             // reserve ~$20 for brokerage on the batch
    if (investable < 50) return null;               // below this, just hold (avoids micro-deploys)

    const log = [];
    let deployed = 0;

    for (const [sym, meta] of Object.entries(WATCHLIST)) {
        const price = priceMap[sym];
        if (!price) continue;

        const alloc = investable * meta.target;
        if (alloc < 1) continue;

        const units = alloc / price;
        const pos = state.positions[sym] || { units: 0, costBasis: 0, name: meta.name };
        const newUnits = pos.units + units;
        // weighted avg cost
        pos.costBasis = newUnits > 0
            ? ((pos.units * pos.costBasis) + (units * price)) / newUnits
            : price;
        pos.units = newUnits;
        pos.lastPrice = price;
        pos.name = meta.name;
        state.positions[sym] = pos;

        // Real-world brokerage on each buy (flat auto-invest fee — see fees.js)
        const fee = fees.estimate('boring', { notional: alloc });
        state.cash -= (alloc + fee);
        state.invested += alloc;
        state.fees = parseFloat(((state.fees || 0) + fee).toFixed(2));
        deployed += alloc;
        log.push(`${sym} +${units.toFixed(2)}u @ $${price.toFixed(2)} ($${alloc.toFixed(0)}, fee $${fee.toFixed(2)})`);
    }

    if (deployed > 0) {
        state.contributions.push({ date: new Date().toISOString(), amount: deployed, detail: log });
        state.lastDcaDate = new Date().toISOString();
        return { deployed, log };
    }
    return null;
}

function portfolioMarketValue(state, priceMap) {
    let total = 0;
    for (const [sym, pos] of Object.entries(state.positions)) {
        const price = (priceMap && priceMap[sym]) || pos.lastPrice || pos.costBasis;
        total += pos.units * price;
    }
    return total;
}

// ── Main scan — refresh prices, accrue dividends, run weekly DCA ─────────────

async function scan() {
    const state = loadState();
    const now = new Date();

    // (No weekly cash top-up — fixed $10k buy-and-hold. The $10k is deployed by runDca and
    //  then held; the only new cash is reinvested dividends.)

    // Fetch current prices
    const priceMap = {};
    for (const sym of Object.keys(WATCHLIST)) {
        const p = await fetchPrice(sym);
        if (p) {
            priceMap[sym] = p;
            if (state.positions[sym]) state.positions[sym].lastPrice = p;
        }
    }

    accrueDividends(state, priceMap);
    const dcaResult = await runDca(state, priceMap);

    // Record one equity-history point per day: our system (market value + dividends)
    // vs the boring benchmark (the same contributions earning the HISA rate).
    const today = now.toISOString().split('T')[0];
    if (!state.equityHistory) state.equityHistory = [];
    const last = state.equityHistory[state.equityHistory.length - 1];
    if (!last || last.t.split('T')[0] !== today) {
        // system = full portfolio value (ETFs + cash); benchmark = the fixed $10k in a 4.5% HISA.
        const system = portfolioMarketValue(state, priceMap) + state.cash;
        const daysLive = state.createdAt ? (now - new Date(state.createdAt).getTime()) / 86400000 : 0;
        const benchmark = state.startingCash * (1 + HISA_RATE * daysLive / 365);
        state.equityHistory.push({ t: now.toISOString(), system: round2(system), benchmark: round2(benchmark) });
        if (state.equityHistory.length > 400) state.equityHistory = state.equityHistory.slice(-400);
    }

    state.lastScan = now.toISOString();
    saveState(state);

    if (dcaResult) {
        console.log(`[Boring ETF] Weekly DCA — deployed $${dcaResult.deployed.toFixed(0)}: ${dcaResult.log.join(' | ')}`);
    }
    return getState();
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function getState() {
    const state = loadState();
    let priceMapCache = {};

    const positions = {};
    let marketValue = 0;
    let totalCost = 0;

    for (const [sym, pos] of Object.entries(state.positions || {})) {
        const price = pos.lastPrice || pos.costBasis || 0;
        const value = pos.units * price;
        const cost  = pos.units * pos.costBasis;
        const gain  = value - cost;
        const gainPct = cost > 0 ? (gain / cost * 100) : 0;
        marketValue += value;
        totalCost += cost;
        positions[sym] = {
            name: pos.name,
            units: parseFloat(pos.units.toFixed(3)),
            avgCost: parseFloat(pos.costBasis.toFixed(2)),
            currentPrice: parseFloat(price.toFixed(2)),
            marketValue: parseFloat(value.toFixed(2)),
            gain: parseFloat(gain.toFixed(2)),
            gainPct: parseFloat(gainPct.toFixed(2)),
            target: WATCHLIST[sym]?.target || 0,
            actualWeight: 0, // filled below
        };
    }

    const portfolioValue = marketValue + state.cash;
    // actual weights
    for (const sym of Object.keys(positions)) {
        positions[sym].actualWeight = marketValue > 0
            ? parseFloat((positions[sym].marketValue / marketValue * 100).toFixed(1))
            : 0;
    }

    // Fixed-capital accounting: everything measured against the $10k START, no deposits.
    // portfolioValue = market value of ETFs + cash (dividends are reinvested into cash).
    // So capitalGain (true $ P&L) and return are simply value vs the starting $10k.
    const capitalGain = portfolioValue - state.startingCash;
    const totalReturn = state.startingCash > 0 ? (capitalGain / state.startingCash * 100) : 0;

    // Benchmark: what the fixed $10k would have earned sitting in a 4.5% HISA/offset.
    const daysLive = state.createdAt
        ? (Date.now() - new Date(state.createdAt).getTime()) / 86400000
        : 0;
    const hisaReturn = state.startingCash * HISA_RATE * (daysLive / 365);

    return {
        cash: parseFloat(state.cash.toFixed(2)),
        startingCash: state.startingCash,
        invested: parseFloat(state.invested.toFixed(2)),
        marketValue: parseFloat(marketValue.toFixed(2)),
        portfolioValue: parseFloat(portfolioValue.toFixed(2)),
        totalFees: parseFloat((state.fees || 0).toFixed(2)),
        capitalGain: parseFloat(capitalGain.toFixed(2)),          // true P&L vs the $10k start
        dividends: {
            received: parseFloat(state.dividends.received.toFixed(2)),
            frankingCredits: parseFloat(state.dividends.frankingCredits.toFixed(2)),
            grossWithFranking: parseFloat((state.dividends.received + state.dividends.frankingCredits).toFixed(2)),
        },
        totalReturn: parseFloat(totalReturn.toFixed(2)),
        benchmark: {
            label: `${(HISA_RATE * 100).toFixed(1)}% HISA/offset`,
            wouldHaveEarned: parseFloat(hisaReturn.toFixed(2)),
            beatBenchmark: capitalGain > hisaReturn,
        },
        positions,
        equityHistory: state.equityHistory || [],
        daysLive: Math.floor(daysLive),
        lastScan: state.lastScan,
    };
}

function round2(v) { return v == null ? 0 : parseFloat(Number(v).toFixed(2)); }

function getPortfolioValue() {
    const s = getState();
    return s.portfolioValue;
}

function resetPaper(startingCash = STARTING_CASH) {
    const fresh = {
        cash: startingCash,
        startingCash,
        invested: 0,
        positions: {},
        dividends: { received: 0, frankingCredits: 0, history: [] },
        contributions: [],
        lastDcaDate: null,
        lastDivAccrual: null,
        createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2));
    console.log(`[Boring ETF] Account reset — starting cash $${startingCash}`);
    return { success: true, startingCash };
}

module.exports = { scan, getState, getPortfolioValue, resetPaper, WATCHLIST };
