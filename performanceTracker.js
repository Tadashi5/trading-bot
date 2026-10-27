// performanceTracker.js — Time-series performance snapshots across all markets
//
// Records an hourly snapshot of every strategy's portfolio value + the journal's
// win/loss state to a persistent file. This is what lets you SEE whether tweaks
// help over weeks/months — equity curve, drawdown, and per-strategy trend, rather
// than just a single live number.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const DATA_DIR = require('./dataDir');
const spyBenchmark = require('./spyBenchmark');

const HISTORY_PATH = path.join(DATA_DIR, 'performance-history.json');
const MAX_POINTS   = 4000; // hourly ≈ 5.5 months of history

function load() {
    // Initialize SPY benchmark cache on first load
    spyBenchmark.initializeCache();
    try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); }
    catch { return { snapshots: [] }; }
}

// Update SPY prices periodically (async, non-blocking)
setImmediate(() => spyBenchmark.updateLatestPrice().catch(() => {}));

function save(h) {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(h));
}

// ── Record a snapshot ─────────────────────────────────────────────────────────
// data = {
//   alpacaEquity, asianValue, mexcValue,
//   totalClosed, winRate, totalPnl   (from journal)
// }
function snapshot(data) {
    if (!data) return;
    const h = load();

    // Only snapshot once per day at market close
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const lastSnapshot = h.snapshots[h.snapshots.length - 1];
    if (lastSnapshot) {
        const lastDay = lastSnapshot.t.split('T')[0];
        if (lastDay === today) return lastSnapshot; // Already snapshotted today
    }

    const prev = h.snapshots[h.snapshots.length - 1] || {};

    // Carry forward last known value when a source fetch fails — a transient
    // null must not be read as $0 (which would fake a huge drawdown in the curve).
    const carry = (val, key) => (val == null ? (prev[key] ?? null) : round(val));

    const alpacaEquity = carry(data.alpacaEquity, 'alpacaEquity');
    const asianValue   = carry(data.asianValue,   'asianValue');
    // MEXC retired — never carried forward, never included in combined.
    const mexcValue    = null;

    // Combined only sums the live series (Alpaca + Asia). MEXC is excluded.
    const combined = [alpacaEquity, asianValue]
        .filter(v => v != null)
        .reduce((s, v) => s + v, 0);

    // Calculate SPY equity curve — use the starting portfolio value as the initial investment
    // This shows what the same dollar amount invested in SPY on day 1 would be worth now
    const nowTime = now.getTime();
    let spyEquity = null;
    if (combined > 0) {
        // First snapshot: use the combined value itself as the starting point
        // Subsequent snapshots: use the starting value from the first snapshot
        const startingCombined = h.snapshots.length > 0 && h.snapshots[0].combined
            ? h.snapshots[0].combined
            : combined;
        spyEquity = round(spyBenchmark.getSPYEquity(nowTime, startingCombined));
    }

    const point = {
        t:            new Date().toISOString(),
        alpacaEquity,
        asianValue,
        mexcValue,
        combined:     round(combined),
        spyEquity,    // New: S&P 500 benchmark at same initial investment as combined
        totalClosed:  data.totalClosed ?? null,
        winRate:      data.winRate ?? null,
        totalPnl:     round(data.totalPnl),
        unrealizedPnl: data.unrealizedPnl ? round(data.unrealizedPnl) : null,  // Open position P&L
        totalWithOpen: (data.totalPnl && data.unrealizedPnl) ? round(data.totalPnl + data.unrealizedPnl) : null,  // Closed + open total
    };
    h.snapshots.push(point);
    if (h.snapshots.length > MAX_POINTS) h.snapshots = h.snapshots.slice(-MAX_POINTS);
    save(h);
    return point;
}

function round(v) {
    return v == null ? null : parseFloat(Number(v).toFixed(2));
}

// ── Queries ─────────────────────────────────────────────────────────────────

function getHistory(limit = 720) {
    return load().snapshots.slice(-limit);
}

// Per-series drawdown + change since first/24h-ago point
function recalculateSPYEquity() {
    // Recalculate SPY equity for all existing snapshots with updated SPY prices
    const h = load();
    if (h.snapshots.length === 0) return;

    const first = h.snapshots[0];
    const startingCombined = first.combined || 3000;

    h.snapshots.forEach(snap => {
        const now = new Date(snap.t).getTime();
        snap.spyEquity = round(spyBenchmark.getSPYEquity(now, startingCombined));
    });

    save(h);
}

function getSummary() {
    // Recalculate SPY values with latest prices
    recalculateSPYEquity();

    const snaps = load().snapshots;
    if (snaps.length < 2) {
        return { points: snaps.length, note: 'Building history — need 2+ snapshots' };
    }

    const first = snaps[0];
    const last  = snaps[snaps.length - 1];

    // Find a point ~24h ago for daily change
    const dayAgoTs = Date.now() - 24 * 3600 * 1000;
    const dayAgo = snaps.find(s => new Date(s.t).getTime() >= dayAgoTs) || first;

    const series = ['alpacaEquity', 'asianValue', 'mexcValue', 'combined', 'spyEquity'];
    const out = { points: snaps.length, since: first.t, latest: last.t };

    for (const key of series) {
        const startVal = first[key];
        const dayVal   = dayAgo[key];
        const curVal   = last[key];
        if (curVal == null) { out[key] = null; continue; }

        // Max drawdown across the whole series
        let peak = -Infinity, maxDD = 0;
        for (const s of snaps) {
            const v = s[key];
            if (v == null) continue;
            if (v > peak) peak = v;
            if (peak > 0) {
                const dd = (peak - v) / peak * 100;
                if (dd > maxDD) maxDD = dd;
            }
        }

        out[key] = {
            current:      curVal,
            changeAll:    startVal ? parseFloat(((curVal / startVal - 1) * 100).toFixed(2)) : null,
            change24h:    dayVal   ? parseFloat(((curVal / dayVal   - 1) * 100).toFixed(2)) : null,
            maxDrawdown:  parseFloat(maxDD.toFixed(2)),
        };
    }

    // Add comparison metrics: bot vs S&P 500
    if (out.combined && out.spyEquity) {
        const botReturn = out.combined.changeAll || 0;
        const spyReturn = out.spyEquity.changeAll || 0;
        const outperformance = parseFloat((botReturn - spyReturn).toFixed(2));
        out.comparison = {
            botReturn,
            spyReturn,
            outperformance, // Positive = beating SPY
            beatsSpy: outperformance > 0,
        };
    }

    return out;
}

// Wipe the equity-curve history for a clean restart (e.g. after retiring a
// strategy). The real track record lives in the trade journal; this only
// clears the visualization series.
function reset() {
    try { fs.unlinkSync(HISTORY_PATH); } catch {}
    return { success: true, cleared: true };
}

module.exports = { snapshot, getHistory, getSummary, reset };
