// adaptiveTuner.js — System-level self-learning for the WHOLE bot (same pattern
// as the Pump Lab's self-calibration): each stream is audited against ground
// truth, and its entry gates auto-adjust — bounded both ways — with every change
// logged and reported. No more silent misconfiguration waiting for a human to ask.
//
//   STOCKS  — ground truth: watchlist movers (≥3% days). If the market moved and
//             we placed 0 trades → the score gate loosens. If we trade but lose
//             (<30% WR) → it tightens back.
//   POLITICO — ground truth: qualifying VIPs exist (≥minAccuracy, ≥3 trades). If
//             they exist and we copied nothing in 24h → gates loosen (accuracy
//             cutoff, volume floor, sentiment floor). If copies lose → tighten.
//   ASIA    — has its own per-market learning loop already; monitored here for
//             the health report only (flagged if it goes silent for 3+ days).
//
// Reads state FILES directly (no module cycles). Calibration is persisted and
// consumed by smartFilters (stocks gate) and politicoScanner (VIP gates).
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const DATA_DIR = require('./dataDir');

const CALIB_FILE = path.join(DATA_DIR, 'adaptive-calibration.json');
const DEFAULTS = {
    stocks:   { minScoreDelta: 0 },                                        // applied on top of timeOfDayFilter
    politico: { minAccuracy: 70, minDollarVol: 1000000, sentimentFloor: -3 },
    pumplab:  { volDeathRatio: 0.7 },                                      // exit when vol drops below this × baseline
    events:   [],
    lastTunedAt: null,
};
const BOUNDS = {
    stocks:   { minScoreDelta: [-2, 2] },
    politico: { minAccuracy: [60, 85], minDollarVol: [250000, 2000000], sentimentFloor: [-5, -2] },
    pumplab:  { volDeathRatio: [0.60, 0.95] },  // 0.6 = exit EARLY when vol drops, 0.95 = exit LATE (loose)
};

function getCalib() {
    try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')) }; }
    catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
function saveCalib(c) { fs.writeFileSync(CALIB_FILE, JSON.stringify(c, null, 2)); }
function readJson(file) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return null; }
}
const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
const within24h = (iso) => iso && (Date.now() - new Date(iso).getTime()) < 86400000;

// ── The daily tune ────────────────────────────────────────────────────────────
// lastData = the server's latest bot-scan payload (gives us today's stock moves).

function tune(lastData) {
    const calib = getCalib();
    // Faster tuning: every 2h (not 12h) so we catch losses early and can pause
    const minInterval = 2 * 3600 * 1000;
    if (calib.lastTunedAt && (Date.now() - new Date(calib.lastTunedAt).getTime()) < minInterval) {
        return { skipped: true };
    }
    const journal = readJson('trade-journal.json') || { trades: [], closedTrades: [] };
    const changes = [];
    const paused = calib.paused || {};

    // ── STOCKS ────────────────────────────────────────────────────────────────
    const stockClosed = (journal.closedTrades || []).filter(t => t.strategy === 'stocks');
    const stockRecent = stockClosed.slice(-15);
    const stockWins   = stockRecent.filter(t => (t.pnl || 0) > 0).length;
    const stockTrades24h = [...(journal.trades || []), ...(journal.closedTrades || [])]
        .filter(t => t.strategy === 'stocks' && within24h(t.entryTime)).length;
    const movers = (lastData?.stocks || []).filter(s => Math.abs(parseFloat(s.change) || 0) >= 3).length;

    if (movers >= 4 && stockTrades24h === 0) {
        // Market moved, scanner did nothing → gate is too tight. Loosen.
        const prev = calib.stocks.minScoreDelta;
        calib.stocks.minScoreDelta = clamp(prev - 0.5, BOUNDS.stocks.minScoreDelta);
        if (calib.stocks.minScoreDelta !== prev)
            changes.push(`STOCKS loosened — ${movers} watchlist movers ≥3% but 0 entries in 24h → score gate ${calib.stocks.minScoreDelta >= 0 ? '+' : ''}${calib.stocks.minScoreDelta}`);
    } else if (stockRecent.length >= 10 && stockWins / stockRecent.length < 0.30) {
        // Trading but losing → tighten back.
        const prev = calib.stocks.minScoreDelta;
        calib.stocks.minScoreDelta = clamp(prev + 0.5, BOUNDS.stocks.minScoreDelta);
        if (calib.stocks.minScoreDelta !== prev)
            changes.push(`STOCKS tightened — ${(stockWins / stockRecent.length * 100).toFixed(0)}% WR over ${stockRecent.length} → score gate +${calib.stocks.minScoreDelta}`);
    }

    // ── POLITICO ──────────────────────────────────────────────────────────────
    let qualifyingVips = 0;
    try {
        const vips = require('./politicoVips').getVipData().vips || {};
        qualifyingVips = Object.values(vips).filter(v =>
            (v.stats?.winRate || 0) >= calib.politico.minAccuracy && (v.stats?.totalTrades || 0) >= 3).length;
    } catch {}
    const polSignals = readJson('politico-signals.json') || {};
    const copies24h = Object.values(polSignals.followMoney || {})
        .filter(f => f.type === 'vip-follow' && within24h(f.date)).length;
    const polClosed = (journal.closedTrades || []).filter(t => t.strategy === 'politico').slice(-12);
    const polWins   = polClosed.filter(t => (t.pnl || 0) > 0).length;

    if (qualifyingVips >= 1 && copies24h === 0) {
        // Proven politicians exist and we copied nothing → gates too strict. Loosen.
        const p = calib.politico, before = JSON.stringify(p);
        p.minAccuracy   = clamp(p.minAccuracy - 5, BOUNDS.politico.minAccuracy);
        p.minDollarVol  = clamp(Math.round(p.minDollarVol / 2), BOUNDS.politico.minDollarVol);
        p.sentimentFloor = clamp(p.sentimentFloor - 1, BOUNDS.politico.sentimentFloor); // more negative = looser
        if (JSON.stringify(p) !== before)
            changes.push(`POLITICO loosened — ${qualifyingVips} qualifying VIP(s), 0 copies in 24h → accuracy≥${p.minAccuracy}%, vol≥$${(p.minDollarVol / 1e6).toFixed(2)}M, sentiment≥${p.sentimentFloor}`);
    } else if (polClosed.length >= 8 && polWins / polClosed.length < 0.30) {
        const p = calib.politico, before = JSON.stringify(p);
        p.minAccuracy  = clamp(p.minAccuracy + 5, BOUNDS.politico.minAccuracy);
        p.minDollarVol = clamp(p.minDollarVol * 2, BOUNDS.politico.minDollarVol);
        if (JSON.stringify(p) !== before)
            changes.push(`POLITICO tightened — ${(polWins / polClosed.length * 100).toFixed(0)}% WR over ${polClosed.length} copies → accuracy≥${p.minAccuracy}%, vol≥$${(p.minDollarVol / 1e6).toFixed(1)}M`);
    }

    // ── PUMP LAB ──────────────────────────────────────────────────────────────
    // Audit: if we're exiting on volume drop, are we exiting TOO LATE (at losses)?
    // If so, tighten volDeathRatio so we bail earlier next time.
    const pumpState = readJson('pump-experiment.json') || { closedTrades: [] };
    const volDeathExits = (pumpState.closedTrades || [])
        .filter(t => t.reason === 'volume died' && within24h(t.exitTime))
        .slice(-20);  // look at last 20 exits only
    if (volDeathExits.length >= 5) {
        const avgPnlPct = volDeathExits.reduce((s, t) => s + (t.pnlPct || 0), 0) / volDeathExits.length;
        if (avgPnlPct < 0.5) {  // volume-death exits are losing or barely breaking even
            // Tighten volDeathRatio: smaller = exit earlier when vol drops
            const prev = calib.pumplab?.volDeathRatio || 0.7;
            calib.pumplab = calib.pumplab || {};
            calib.pumplab.volDeathRatio = clamp(prev - 0.05, BOUNDS.pumplab.volDeathRatio);
            if (calib.pumplab.volDeathRatio !== prev)
                changes.push(`PUMP LAB tightened — volume-death exits averaging ${avgPnlPct.toFixed(1)}% (lossy) → volDeathRatio ${calib.pumplab.volDeathRatio.toFixed(2)} (exit EARLIER when vol drops)`);
        } else if (avgPnlPct > 3) {
            // Volume-death exits are consistently good — can relax a bit
            const prev = calib.pumplab?.volDeathRatio || 0.7;
            calib.pumplab = calib.pumplab || {};
            calib.pumplab.volDeathRatio = clamp(prev + 0.03, BOUNDS.pumplab.volDeathRatio);
            if (calib.pumplab.volDeathRatio !== prev)
                changes.push(`PUMP LAB loosened — volume-death exits averaging ${avgPnlPct.toFixed(1)}% (healthy) → volDeathRatio ${calib.pumplab.volDeathRatio.toFixed(2)}`);
        }
    }

    // ── CIRCUIT BREAKER — Pause streams losing badly ────────────────────────────
    const allClosed = [...(journal.closedTrades || [])];
    // pause key → journal strategy name ('asia' journals as 'asia-paper')
    const streamMap = { stocks: 'stocks', politico: 'politico', asia: 'asia-paper' };
    for (const [stream, strategyName] of Object.entries(streamMap)) {
        const streamTrades = allClosed.filter(t => t.strategy === strategyName).slice(-20);
        if (streamTrades.length >= 10) {
            const wins = streamTrades.filter(t => (t.pnl || 0) > 0).length;
            const wr = wins / streamTrades.length;
            if (wr < 0.30 && !paused[stream]) {
                // Auto-pause: this stream is losing badly
                paused[stream] = { at: new Date().toISOString(), wr: (wr * 100).toFixed(0) };
                changes.push(`⚠️ CIRCUIT BREAKER: ${stream.toUpperCase()} paused (${(wr * 100).toFixed(0)}% WR on last ${streamTrades.length})`);
            } else if (wr > 0.45 && paused[stream]) {
                // Resume: performance recovered
                delete paused[stream];
                changes.push(`✓ ${stream.toUpperCase()} resumed (${(wr * 100).toFixed(0)}% WR)`);
            }
        } else if (paused[stream]) {
            // DEADLOCK GUARD: a paused stream needs WR>45% to resume, but it can't earn
            // any WR while paused — so a pause set on now-stale data (e.g. pre-reset trades)
            // traps it forever. If there's no longer a ≥10-trade sample justifying the pause,
            // clear it and give the stream a clean slate.
            delete paused[stream];
            changes.push(`✓ ${stream.toUpperCase()} unpaused — stale pause cleared (only ${streamTrades.length} recent trades, can't justify it)`);
        }
    }
    calib.paused = paused;

    if (changes.length) {
        for (const c of changes) calib.events.push({ at: new Date().toISOString(), change: c });
        if (calib.events.length > 60) calib.events = calib.events.slice(-60);
    }
    calib.lastTunedAt = new Date().toISOString();
    saveCalib(calib);
    changes.forEach(c => console.log(`[Tuner] 🔧 ${c}`));
    return { skipped: false, changes };
}

// ── Health report — every stream, one honest summary ─────────────────────────

function getHealth() {
    const calib = getCalib();
    const journal = readJson('trade-journal.json') || { trades: [], closedTrades: [] };
    const all = [...(journal.trades || []), ...(journal.closedTrades || [])];
    const streams = {};
    const paused = calib.paused || {};

    const stock24 = all.filter(t => t.strategy === 'stocks' && within24h(t.entryTime)).length;
    const stockRecent = all.filter(t => t.strategy === 'stocks').slice(-15);
    const stockWR = stockRecent.length > 0 ? (stockRecent.filter(t => (t.pnl || 0) > 0).length / stockRecent.length * 100).toFixed(0) : 'N/A';
    streams.stocks = {
        entries24h: stock24,
        winRate: stockWR,
        paused: paused.stocks ? `YES (${paused.stocks.wr}% WR)` : 'no',
        gateDelta: calib.stocks.minScoreDelta,
        status: paused.stocks ? `🛑 PAUSED — will resume when WR > 45%` : (stock24 > 0 ? '✓ trading' : '⏸ no entries in 24h'),
    };

    const polSignals = readJson('politico-signals.json') || {};
    const cop24 = Object.values(polSignals.followMoney || {}).filter(f => f.type === 'vip-follow' && within24h(f.date)).length;
    const polClosed = all.filter(t => t.strategy === 'politico').slice(-12);
    const polWR = polClosed.length > 0 ? (polClosed.filter(t => (t.pnl || 0) > 0).length / polClosed.length * 100).toFixed(0) : 'N/A';
    streams.politico = {
        copies24h: cop24,
        winRate: polWR,
        paused: paused.politico ? `YES (${paused.politico.wr}% WR)` : 'no',
        gates: calib.politico,
        status: paused.politico ? `🛑 PAUSED — will resume when WR > 45%` : (cop24 > 0 ? '✓ copying VIPs' : '⏸ no copies in 24h'),
    };

    const asia = readJson('asian-paper.json') || {};
    const asiaLast = (asia.closedTrades || []).slice(-1)[0];
    const asiaSilentDays = asiaLast?.exitDate ? Math.floor((Date.now() - new Date(asiaLast.exitDate).getTime()) / 86400000) : null;
    const asiaWR = asia.stats?.winRate ?? null;
    streams.asia = {
        winRate: asiaWR,
        paused: paused.asia ? `YES (${paused.asia.wr}% WR)` : 'no',
        status: paused.asia ? `🛑 PAUSED — will resume when WR > 45%` : ((asiaSilentDays != null && asiaSilentDays >= 3) ? `⚠️ silent ${asiaSilentDays} days` : '✓ own learning loop active'),
    };

    const pumplab = readJson('pump-experiment.json') || { closedTrades: [] };
    const pump24h = (pumplab.closedTrades || []).filter(t => within24h(t.exitTime)).length;
    streams.pumplab = {
        exits24h: pump24h,
        volDeathRatio: calib.pumplab?.volDeathRatio ?? 0.7,
        status: pump24h > 0 ? `✓ exiting on volume drop at ${(calib.pumplab?.volDeathRatio ?? 0.7).toFixed(2)}×` : '⏸ no exits in 24h',
    };

    // ── ENTRY/EXIT FLOW AUDIT — a stream that buys but never sells is broken,
    // not patient. (Crypto did exactly this for weeks: broken trailing stops +
    // a symbol mismatch meant zero sells ever, and nothing flagged it.)
    const warnings = [];
    for (const strat of ['crypto', 'stocks', 'options', 'risky']) {
        const open   = (journal.trades || []).filter(t => t.strategy === strat).length;
        const closed = (journal.closedTrades || []).filter(t => t.strategy === strat).length;
        if (strat === 'crypto') {
            streams.crypto = {
                openEntries: open, closedEver: closed,
                status: (open >= 3 && closed === 0) ? '⚠️ BUYS BUT NEVER SELLS — exit logic not firing' : (open + closed > 0 ? '✓ entries and exits both flowing' : '⏸ inactive'),
            };
        }
        if (open >= 5 && closed === 0) warnings.push(`${strat.toUpperCase()}: ${open} open entries, ZERO exits ever — exit path is likely broken`);
    }

    // ── JOURNAL INTEGRITY — stranded "open" entries skew every win-rate stat
    const openCount = (journal.trades || []).length;
    if (openCount > 300) warnings.push(`JOURNAL: ${openCount} open entries — likely stranded (externally-closed positions never reconciled)`);

    return {
        streams,
        warnings: warnings.length ? warnings : null,
        journal: { openEntries: openCount, closedTrades: (journal.closedTrades || []).length },
        recentCalibrations: calib.events.slice(-8).reverse(),
        lastTunedAt: calib.lastTunedAt,
        pausedStreams: Object.keys(paused).length > 0 ? paused : null,
        tuneInterval: '2 hours (was 12h)',
    };
}

module.exports = { getCalib, tune, getHealth };
