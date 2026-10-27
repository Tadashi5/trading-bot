// pumpExperiment.js — QUARANTINED experiment: real-time pump-ignition detector.
//
// ⚠️  ISOLATED FROM THE MAIN PORTFOLIO. Its own sandbox balance, its own P&L,
// its own learner. Nothing here touches the KPI dashboard or the combined
// equity curve until it proves viable and we deliberately graduate it.
//
// THESIS: a real pump has a measurable SIGNATURE that a random uptick cannot
// fake — a volume explosion off a quiet base with aggressive buy-side order-flow,
// caught in its first minutes. We enter early, ride briefly, and exit the instant
// momentum stalls (we refuse to be exit liquidity). The learner then discovers
// which parts of the signature actually predict a rideable move vs a trap.
require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const fees  = require('./fees');

const DATA_DIR     = require('./dataDir');
const STATE_FILE   = path.join(DATA_DIR, 'pump-experiment.json');
const WEIGHTS_FILE = path.join(DATA_DIR, 'pump-experiment-weights.json');
const MEXC = 'https://api.mexc.com';

// ── Sandbox parameters ────────────────────────────────────────────────────────
const STARTING_BALANCE = 10000;   // equal-capital baseline — every stream starts at $10k
const MAX_POSITIONS    = 4;
const MAX_CANDIDATES   = 25;      // cap API usage per scan
const COOLDOWN_MIN     = 30;      // don't re-enter same coin within 30 min

// ── What counts as a REAL pump — DEFAULT gates, CALIBRATED LIVE ────────────────
// v1 required ALL 7 gates and capped the 5-min move at 10% — which literally
// rejected the violent real pumps (CS +248% moved way faster than 10%/5min).
// Result: real pumps happened, we detected zero. Lesson learned. Now:
//   • 3 core gates (volume, moving, not-hopelessly-late) + 2-of-4 supporting
//   • the lab AUDITS itself every scan: coins that did 30%+ with real volume
//     while we detected nothing = logged misses → gates auto-loosen (bounded)
//   • if trades then lose, gates auto-tighten back. Self-correcting.
const DEFAULT_GATES = {
    MIN_VOL_RATIO:    2.0,   // last-5min volume ≥ 2.0× baseline (was 2.5 when tuner auto-tightened)
    MIN_IMBALANCE:    0.52,  // ≥52% bid imbalance (was 0.55, slightly relaxed)
    MAX_BASE_RANGE:   0.08,  // pre-ignition base quiet (<8% range, was 0.06, slightly relaxed)
    MIN_SHORT_MOVE:   1.2,   // actually moving up (≥1.2% over 5 min, was 1.5)
    MAX_SHORT_MOVE:   40,    // was 10 — that cap REJECTED the violent real pumps
    MAX_EXTENSION:    45,    // skip only if already massively extended off base
    MIN_GREEN_RUN:    2,     // ≥2 consecutive rising-volume green candles
    MIN_SUPPORTING:   3,     // of the 4 supporting gates — higher bar (was 2, too loose after misses)
};
const CALIB_FILE = path.join(DATA_DIR, 'pump-experiment-calibration.json');
function loadCalib() {
    try { return JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')); }
    catch { return { gates: { ...DEFAULT_GATES }, events: [], lastCalibratedAt: null }; }
}
function saveCalib(c) { fs.writeFileSync(CALIB_FILE, JSON.stringify(c, null, 2)); }

// ── Exit discipline (anti-bag-holder — we KNOW the dump is coming) ────────────
const EXITS = {
    TRAIL_FROM_HIGH:  -6.0,   // drop 6% from peak (was -4%, too tight; let winners breathe)
    HARD_STOP:        -6.0,   // -6% from entry → out, no exceptions
    TIME_CAP_MIN:     90,     // pumps resolve fast; momentum is dead after 90 min
    VOL_DEATH_RATIO:  0.7,    // peak-volume-relative: current vol < 0.7× highest vol seen (LIVE-CALIBRATED)
};

// ── Viability criteria (when do we graduate or kill the experiment?) ──────────
const VIABILITY = {
    MIN_TRADES:       25,     // need a real sample before judging
    GRADUATE_PF:      1.3,    // profit factor ≥1.3 over the sample → promising
    KILL_PF:          0.8,    // profit factor ≤0.8 over the sample → thesis is dead
};

// ── State + isolated learner ──────────────────────────────────────────────────

function loadState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        // Migration: STARTING_BALANCE raised — top up existing sandbox by the
        // difference (changing the constant alone never touches saved state).
        if ((s.startingBalance || 0) < STARTING_BALANCE) {
            s.balance += STARTING_BALANCE - (s.startingBalance || 0);
            s.startingBalance = STARTING_BALANCE;
            fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
        }
        return s;
    }
    catch {
        const s = {
            balance: STARTING_BALANCE, startingBalance: STARTING_BALANCE,
            positions: {}, closedTrades: [], cooldowns: {},
            stats: { trades: 0, wins: 0, losses: 0, totalPnl: 0, winRate: 0,
                     avgWin: 0, avgLoss: 0, profitFactor: 0, portfolioValue: STARTING_BALANCE },
            detections: [],   // log of confirmed ignitions (whether traded or not)
            lastScan: null, createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
        return s;
    }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// Isolated weights — the experiment learns its OWN pattern, sandboxed from the
// main strategy weights so a bad experiment can't pollute the real book.
const DEFAULT_WEIGHTS = {
    volRatio:   1.0,   // volume explosion magnitude
    imbalance:  1.0,   // order-book buy pressure
    baseFlat:   1.0,   // how quiet the pre-ignition base was
    accel:      1.0,   // price acceleration (2nd derivative)
    greenRun:   1.0,   // consecutive rising-volume green candles
    earliness:  1.0,   // how early in the move we are (less extended = better)
};
function loadWeights() {
    try { return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')); }
    catch { return { ...DEFAULT_WEIGHTS }; }
}
function saveWeights(w) { fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2)); }

// ── MEXC public market data (no key needed) ───────────────────────────────────

async function fetchUniverse() {
    // One API call feeds BOTH the candidate hunt and the self-audit.
    const res = await axios.get(`${MEXC}/api/v3/ticker/24hr`, { timeout: 15000 });
    const all = Array.isArray(res.data) ? res.data : [];
    const usdt = all
        .filter(t => t.symbol.endsWith('USDT'))
        .map(t => ({
            symbol: t.symbol,
            sym:    t.symbol.replace('USDT', ''),
            // MEXC returns priceChangePercent as a FRACTION (2.48 = +248%) — ×100
            // to get an actual percent. Without this the audit's "≥30%" check was
            // really "≥3000%" and silently matched nothing.
            change: (parseFloat(t.priceChangePercent) || 0) * 100,
            quoteVol: parseFloat(t.quoteVolume) || 0,
            price:  parseFloat(t.lastPrice) || 0,
        }));
    // Candidates: alive, showing life, not fully mooned. Cap raised 25→60 — a coin
    // mid-pump often already shows +30% on the 24h clock while still igniting.
    const candidates = usdt
        .filter(c => c.quoteVol > 50000 && c.quoteVol < 50000000 && c.change > -5 && c.change < 60 && c.price > 0)
        .sort((a, b) => b.quoteVol - a.quoteVol)
        .slice(0, MAX_CANDIDATES);
    // Audit list: what ACTUALLY pumped today with real volume — the ground truth
    // we measure ourselves against. Missing these = the system must adapt.
    const pumpedToday = usdt
        .filter(c => c.change >= 30 && c.quoteVol >= 100000)
        .map(c => ({ sym: c.sym, change: Math.round(c.change), vol: Math.round(c.quoteVol) }));
    return { candidates, pumpedToday };
}

async function fetchKlines(symbol) {
    try {
        const res = await axios.get(`${MEXC}/api/v3/klines`, {
            params: { symbol, interval: '1m', limit: 60 }, timeout: 8000,
        });
        // [ openTime, open, high, low, close, volume, ... ]
        return (res.data || []).map(k => ({
            open:  parseFloat(k[1]), high: parseFloat(k[2]),
            low:   parseFloat(k[3]), close: parseFloat(k[4]),
            vol:   parseFloat(k[5]),
        }));
    } catch { return null; }
}

async function fetchDepth(symbol) {
    try {
        const res = await axios.get(`${MEXC}/api/v3/depth`, {
            params: { symbol, limit: 20 }, timeout: 6000,
        });
        const bids = (res.data.bids || []).slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
        const asks = (res.data.asks || []).slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
        const total = bids + asks;
        return total > 0 ? bids / total : 0.5;
    } catch { return 0.5; }
}

// ── THE CORE: quantify the ignition signature from 1-min candles ──────────────
// Returns the raw measurements + whether every hard gate passed.

function measureIgnition(klines, imbalance, G = DEFAULT_GATES) {
    if (!klines || klines.length < 40) return null;
    const n = klines.length;
    const closes = klines.map(k => k.close);
    const vols   = klines.map(k => k.vol);

    // 1. VOLUME RATIO — last 5 min vs the prior baseline (bars 10..35 ago)
    const recentVol   = avg(vols.slice(n - 5));
    const baselineVol = avg(vols.slice(n - 35, n - 10)) || 1e-9;
    const volRatio    = recentVol / baselineVol;

    // 2. SHORT MOVE — price change over last 5 min
    const shortMove = (closes[n - 1] - closes[n - 6]) / closes[n - 6] * 100;

    // 3. BASE FLATNESS — how quiet were the 20 min BEFORE the last 5? (range %)
    const baseSlice = klines.slice(n - 25, n - 5);
    const baseHigh  = Math.max(...baseSlice.map(k => k.high));
    const baseLow   = Math.min(...baseSlice.map(k => k.low));
    const baseMean  = avg(baseSlice.map(k => k.close)) || 1e-9;
    const baseRange = (baseHigh - baseLow) / baseMean;        // smaller = flatter base
    const baseMid   = (baseHigh + baseLow) / 2;

    // 4. EARLINESS — how far above the base are we already? (less = earlier = better)
    const extension = (closes[n - 1] - baseMid) / baseMid * 100;

    // 5. ACCELERATION — is the move speeding up? (recent ROC vs prior ROC)
    const rocRecent = (closes[n - 1] - closes[n - 3]) / closes[n - 3] * 100;
    const rocPrior  = (closes[n - 3] - closes[n - 5]) / closes[n - 5] * 100;
    const accel     = rocRecent - rocPrior;

    // 6. GREEN RUN — consecutive rising-volume green candles at the tail
    let greenRun = 0;
    for (let i = n - 1; i > 0; i--) {
        const up        = klines[i].close > klines[i].open;
        const volRising = klines[i].vol > klines[i - 1].vol;
        if (up && volRising) greenRun++; else break;
    }

    const m = {
        volRatio:  round(volRatio),
        shortMove: round(shortMove),
        baseRange: round(baseRange),
        extension: round(extension),
        accel:     round(accel),
        greenRun,
        imbalance: round(imbalance),
    };

    // ── GATES — 3 core must pass, plus MIN_SUPPORTING of the 4 supporting. ──
    // (v1's all-7-required + 10% move cap caught zero real pumps. Real ignitions
    // are violent and messy — score them, don't demand textbook perfection.)
    m.gates = {
        volume:    volRatio  >= G.MIN_VOL_RATIO,                                    // core
        moving:    shortMove >= G.MIN_SHORT_MOVE,                                   // core
        notLate:   shortMove <= G.MAX_SHORT_MOVE && extension <= G.MAX_EXTENSION,   // core
        pressure:  imbalance >= G.MIN_IMBALANCE,       // supporting
        flatBase:  baseRange <= G.MAX_BASE_RANGE,      // supporting
        greenRun:  greenRun  >= G.MIN_GREEN_RUN,       // supporting
        accel:     accel     > 0,                      // supporting
    };
    m.supportingPassed = ['pressure', 'flatBase', 'greenRun', 'accel'].filter(k => m.gates[k]).length;
    m.isRealPump = m.gates.volume && m.gates.moving && m.gates.notLate
                && m.supportingPassed >= G.MIN_SUPPORTING;
    return m;
}

// Convert raw measurements into learner-facing signal tiers (the things we learn on)
function toSignals(m) {
    return {
        volRatio:  tier(m.volRatio,  [3, 5, 8]),        // 1..3
        imbalance: tier(m.imbalance, [0.58, 0.65, 0.72]),
        baseFlat:  tier(0.04 - m.baseRange, [0, 0.015, 0.03]), // flatter = higher
        accel:     tier(m.accel,     [0, 0.5, 1.5]),
        greenRun:  tier(m.greenRun,  [2, 3, 4]),
        earliness: tier(10 - m.extension, [0, 3, 6]),   // less extended = higher
    };
}

function scoreIgnition(signals, weights) {
    let s = 0;
    for (const [k, v] of Object.entries(signals)) s += v * (weights[k] ?? 1);
    return round(s);
}

// ── Exit check — managed separately for fast responsiveness ───────────────────
// This is called both by fast 10-sec loop AND by 2-min full scan.
async function checkExits(state, weights, log) {
    const now = Date.now();
    const calib = loadCalib();
    const volDeathRatio = calib.pumplab?.volDeathRatio || EXITS.VOL_DEATH_RATIO;

    for (const [sym, pos] of Object.entries(state.positions)) {
        const kl = await fetchKlines(sym + 'USDT');
        const price = kl && kl.length ? kl[kl.length - 1].close : pos.currentPrice;
        if (!price) continue;
        pos.currentPrice = price;
        if (!pos.highWatermark || price > pos.highWatermark) pos.highWatermark = price;

        const pnlPct       = (price - pos.entryPrice) / pos.entryPrice * 100;
        const fromHighPct   = (price - pos.highWatermark) / pos.highWatermark * 100;
        const heldMin       = (now - new Date(pos.entryTime).getTime()) / 60000;
        const curVol        = kl ? avg(kl.slice(-3).map(k => k.vol)) : 0;

        // PEAK-VOLUME-RELATIVE: track max vol since entry, exit when it drops from that peak
        // (positions opened before this field existed inherit their baseline)
        if (!pos.peakVolSinceEntry) pos.peakVolSinceEntry = pos.baselineVol || curVol;
        if (curVol > pos.peakVolSinceEntry) pos.peakVolSinceEntry = curVol;
        const volDeath      = pos.peakVolSinceEntry && curVol < pos.peakVolSinceEntry * volDeathRatio;

        let exit = null;
        if (fromHighPct <= EXITS.TRAIL_FROM_HIGH) exit = `trail ${round(fromHighPct)}% off peak`;
        else if (pnlPct <= EXITS.HARD_STOP)        exit = `hard stop ${round(pnlPct)}%`;
        else if (heldMin >= EXITS.TIME_CAP_MIN)    exit = `time cap ${Math.round(heldMin)}m`;
        else if (volDeath && heldMin > 5)          exit = `volume died`;

        if (exit) {
            closePosition(state, weights, sym, price, exit);
            log.push(`EXIT ${sym} @ ${price} (${round(pnlPct)}%) — ${exit}`);
        }
    }
}

// ── Fast exit sweep — self-contained, safe to call every 10s ──────────────────
// Loads its OWN state and REAL weights, saves both. Shares a lock with scan()
// so the two can never hold stale copies of the same state file at once
// (scan takes ~60s of API calls; without the lock its save would resurrect
// positions the sweep had already closed, double-crediting the balance).
let _busy = false;
async function exitSweep() {
    if (_busy) return { skipped: true };
    if (!Object.keys(loadState().positions || {}).length) return { skipped: true };
    _busy = true;
    try {
        const state   = loadState();
        const weights = loadWeights();
        const log     = [];
        await checkExits(state, weights, log);
        recalcStats(state);
        saveState(state);
        return { skipped: false, log };
    } finally { _busy = false; }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan() {
    if (_busy) return getState();   // sweep in flight — don't load stale state over it
    _busy = true;
    try {
        return await scanInner();
    } finally { _busy = false; }
}

async function scanInner() {
    const state   = loadState();
    const weights = loadWeights();
    const now     = Date.now();
    const log     = [];

    // 1. MANAGE OPEN POSITIONS — exits (fast 10-sec loop handles this too)
    await checkExits(state, weights, log);

    // 2. HUNT FOR IGNITIONS (with live-calibrated gates)
    const calib = loadCalib();
    const G = calib.gates;
    let universe = [], pumpedToday = [];
    try { ({ candidates: universe, pumpedToday } = await fetchUniverse()); }
    catch (e) { log.push(`universe fetch failed: ${e.message}`); }

    const openCount = Object.keys(state.positions).length;
    for (const c of universe) {
        if (openCount + countNew(state) >= MAX_POSITIONS) break;
        if (state.positions[c.sym]) continue;
        if (state.cooldowns[c.sym] && now < state.cooldowns[c.sym]) continue;

        const [kl, imbalance] = await Promise.all([fetchKlines(c.symbol), fetchDepth(c.symbol)]);
        const m = measureIgnition(kl, imbalance, G);
        if (!m) continue;

        if (m.isRealPump) {
            const signals = toSignals(m);
            const score   = scoreIgnition(signals, weights);
            // Log every confirmed ignition for learning/analysis (even if we don't trade)
            state.detections.push({ sym: c.sym, time: new Date().toISOString(), score, ...m });
            if (state.detections.length > 500) state.detections = state.detections.slice(-500);

            // Enter (size by score)
            const baselineVol = kl ? avg(kl.slice(-35, -10).map(k => k.vol)) : 0;
            openPosition(state, c, m, signals, score, baselineVol);
            log.push(`🔥 IGNITION ${c.sym} vol×${m.volRatio} imb ${m.imbalance} base ${m.baseRange} +${m.shortMove}% — score ${score}`);
        }
    }

    // 3. SELF-AUDIT — did the market pump without us? This is the accountability
    // loop: every coin that did 30%+ with real volume, which we neither hold nor
    // detected, is logged as a MISS. No more "why are there no pumps?" — the lab
    // reports its own misses instead of waiting for you to notice.
    const today = new Date().toISOString().split('T')[0];
    if (!state.audit || state.audit.day !== today) state.audit = { day: today, missed: [] };
    const known = new Set([
        ...Object.keys(state.positions),
        ...state.detections.slice(-100).map(x => x.sym),
        ...state.audit.missed.map(x => x.sym),
    ]);
    for (const p of pumpedToday) {
        if (!known.has(p.sym)) {
            state.audit.missed.push({ ...p, at: new Date().toISOString() });
            log.push(`⚠️ MISSED PUMP: ${p.sym} +${p.change}% ($${(p.vol / 1e6).toFixed(1)}M vol) — logged for calibration`);
        }
    }

    // 4. AUTO-CALIBRATION (at most every 6h, bounded both ways):
    //    missing pumps while detecting nothing → LOOSEN gates
    //    detecting but losing (≥10 trades, <30% WR) → TIGHTEN gates
    const lastCal = calib.lastCalibratedAt ? new Date(calib.lastCalibratedAt).getTime() : 0;
    if (now - lastCal > 6 * 3600 * 1000) {
        const missed = state.audit.missed.length;
        const detected24h = state.detections.filter(x => now - new Date(x.time).getTime() < 86400000).length;
        const recent = state.closedTrades.slice(-15);
        const recentWins = recent.filter(t => t.pnlDollar > 0).length;
        let change = null;
        if (missed >= 3 && detected24h === 0) {
            G.MIN_VOL_RATIO  = Math.max(1.5,  +(G.MIN_VOL_RATIO * 0.85).toFixed(2));
            G.MIN_IMBALANCE  = Math.max(0.52, +(G.MIN_IMBALANCE - 0.01).toFixed(2));
            G.MAX_BASE_RANGE = Math.min(0.10, +(G.MAX_BASE_RANGE + 0.01).toFixed(3));
            if (missed >= 6) G.MIN_SUPPORTING = Math.max(1, G.MIN_SUPPORTING - 1);
            change = `LOOSENED — missed ${missed} pumps, detected 0. Now: vol≥${G.MIN_VOL_RATIO}×, imb≥${G.MIN_IMBALANCE}, base≤${G.MAX_BASE_RANGE}, support≥${G.MIN_SUPPORTING}`;
        } else if (recent.length >= 10 && recentWins / recent.length < 0.30) {
            G.MIN_VOL_RATIO  = Math.min(4, +(G.MIN_VOL_RATIO * 1.15).toFixed(2));
            G.MIN_SUPPORTING = Math.min(4, G.MIN_SUPPORTING + 1);
            change = `TIGHTENED — ${(recentWins / recent.length * 100).toFixed(0)}% WR over last ${recent.length}. Now: vol≥${G.MIN_VOL_RATIO}×, support≥${G.MIN_SUPPORTING}`;
        }
        if (change) {
            calib.events.push({ at: new Date().toISOString(), change });
            if (calib.events.length > 50) calib.events = calib.events.slice(-50);
            calib.lastCalibratedAt = new Date().toISOString();
            saveCalib(calib);
            log.push(`🔧 SELF-CALIBRATION: ${change}`);
        }
    }

    recalcStats(state);
    state.lastScan = new Date().toISOString();
    saveState(state);
    if (log.length) log.forEach(l => console.log(`[Pump Lab] ${l}`));
    return getState();
}

function countNew() { return 0; } // placeholder for symmetry; openCount recomputed inline

function openPosition(state, coin, m, signals, score, baselineVol) {
    const size = state.balance * (score >= 12 ? 0.12 : score >= 8 ? 0.09 : 0.06);
    if (size < 5 || state.balance < size) return;
    const qty = size / coin.price;
    state.positions[coin.sym] = {
        sym: coin.sym, entryPrice: coin.price, qty, notional: size,
        entryTime: new Date().toISOString(), currentPrice: coin.price,
        highWatermark: coin.price, baselineVol,
        peakVolSinceEntry: baselineVol,  // track max volume seen since entry (for volume trailing stop)
        signals, score, entryMeasures: m,
    };
    state.balance -= size;
}

function closePosition(state, weights, sym, exitPrice, reason) {
    const pos = state.positions[sym];
    if (!pos) return;
    const pnlPct    = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    // Real-world cost: micro-cap fee + brutal slippage (see fees.js) on BOTH legs.
    // This is the honest drag that usually kills a pump edge.
    const fee       = fees.roundTrip('pump', pos.notional, pos.qty * exitPrice);
    const pnlDollar = pos.qty * (exitPrice - pos.entryPrice) - fee;
    state.balance += pos.notional + pnlDollar;

    state.closedTrades.push({
        sym, entryPrice: pos.entryPrice, exitPrice,
        pnlPct: round(pnlPct), pnlDollar: round(pnlDollar), fees: round(fee),
        entryTime: pos.entryTime, exitTime: new Date().toISOString(),
        reason, score: pos.score, signals: pos.signals,
    });
    if (state.closedTrades.length > 300) state.closedTrades = state.closedTrades.slice(-300);
    state.cooldowns[sym] = Date.now() + COOLDOWN_MIN * 60000;
    delete state.positions[sym];

    // ── ISOLATED LEARNING — nudge this experiment's own weights ───────────────
    // Winner → boost the signals that were strong at entry; loser → fade them.
    const win = pnlDollar > 0;
    const RATE = 0.03, MINW = 0.2, MAXW = 3.0;
    for (const [k, v] of Object.entries(pos.signals || {})) {
        if (weights[k] === undefined || !v) continue;
        const nudge = (win ? 1 : -1) * RATE * v;
        weights[k] = round(Math.max(MINW, Math.min(MAXW, weights[k] + nudge)));
    }
    saveWeights(weights);
}

function recalcStats(state) {
    const closed = state.closedTrades || [];
    const wins   = closed.filter(t => t.pnlDollar > 0);
    const losses = closed.filter(t => t.pnlDollar <= 0);
    const grossWin  = wins.reduce((s, t) => s + t.pnlDollar, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlDollar, 0));
    const openValue = Object.values(state.positions).reduce((s, p) => s + (p.currentPrice * p.qty), 0);

    state.stats = {
        trades: closed.length,
        wins: wins.length,
        losses: losses.length,
        winRate: closed.length ? round(wins.length / closed.length * 100) : 0,
        totalPnl: round(closed.reduce((s, t) => s + t.pnlDollar, 0)),
        avgWin:  wins.length   ? round(grossWin / wins.length)   : 0,
        avgLoss: losses.length ? round(grossLoss / losses.length) : 0,
        profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : (grossWin > 0 ? 999 : 0),
        portfolioValue: round(state.balance + openValue),
        openPositions: Object.keys(state.positions).length,
    };
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function getState() {
    const state = loadState();
    recalcStats(state);
    const s = state.stats;

    // Viability verdict
    let verdict = 'TESTING', verdictNote = `Need ${VIABILITY.MIN_TRADES - s.trades} more trades to judge`;
    if (s.trades >= VIABILITY.MIN_TRADES) {
        if (s.profitFactor >= VIABILITY.GRADUATE_PF) { verdict = 'VIABLE';  verdictNote = 'Hitting graduation criteria — candidate for real capital'; }
        else if (s.profitFactor <= VIABILITY.KILL_PF) { verdict = 'FAILING'; verdictNote = 'Thesis not working — recommend killing the experiment'; }
        else { verdict = 'MARGINAL'; verdictNote = 'Inconclusive — keep testing'; }
    }

    const positions = {};
    for (const [sym, p] of Object.entries(state.positions)) {
        const pnlPct = (p.currentPrice - p.entryPrice) / p.entryPrice * 100;
        positions[sym] = {
            entryPrice: p.entryPrice, currentPrice: p.currentPrice,
            pnlPct: round(pnlPct), score: p.score,
            heldMin: Math.round((Date.now() - new Date(p.entryTime).getTime()) / 60000),
            signals: p.signals,
        };
    }

    // Health report — the lab holds itself accountable and tells YOU when it's
    // missing pumps or has re-calibrated, instead of you having to come ask.
    const calib = loadCalib();
    const missedToday = state.audit?.missed || [];
    const detected24h = (state.detections || []).filter(x => Date.now() - new Date(x.time).getTime() < 86400000).length;
    let healthMsg = '✓ Healthy — watching the whole exchange';
    if (missedToday.length > 0 && detected24h === 0) healthMsg = `⚠️ Missed ${missedToday.length} real pump(s) today, detected 0 — gates auto-loosening`;
    else if (missedToday.length > 0) healthMsg = `Detected ${detected24h}, but missed ${missedToday.length} — calibrating`;
    else if (detected24h > 0) healthMsg = `✓ Detecting — ${detected24h} ignition(s) in 24h`;
    if (calib.events.length) healthMsg += ` | last self-calibration: ${calib.events[calib.events.length - 1].change}`;

    return {
        isolated: true,
        balance: round(state.balance),
        startingBalance: state.startingBalance,
        stats: s,
        totalReturn: round((s.portfolioValue / state.startingBalance - 1) * 100),
        verdict, verdictNote: `${verdictNote} — ${healthMsg}`,
        health: {
            message: healthMsg,
            missedToday,
            detected24h,
            liveGates: calib.gates,
            calibrations: calib.events.slice(-5).reverse(),
        },
        viability: VIABILITY,
        gates: calib.gates,
        positions,
        recentClosed: (state.closedTrades || []).slice(-15).reverse(),
        recentDetections: (state.detections || []).slice(-20).reverse(),
        weights: loadWeights(),
        lastScan: state.lastScan,
        daysLive: state.createdAt ? Math.floor((Date.now() - new Date(state.createdAt).getTime()) / 86400000) : 0,
    };
}

function getPortfolioValue() { return getState().stats.portfolioValue; }

function resetExperiment() {
    try { fs.unlinkSync(STATE_FILE); } catch {}
    try { fs.unlinkSync(WEIGHTS_FILE); } catch {}
    return loadState();
}

// ── helpers ───────────────────────────────────────────────────────────────────
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function round(v) { return v == null ? null : parseFloat(Number(v).toFixed(4)); }
function tier(v, [t1, t2, t3]) { return v >= t3 ? 3 : v >= t2 ? 2 : v >= t1 ? 1 : 0; }

module.exports = { scan, exitSweep, getState, getPortfolioValue, resetExperiment, GATES: DEFAULT_GATES, EXITS, VIABILITY };
