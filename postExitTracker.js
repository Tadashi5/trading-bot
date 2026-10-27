// postExitTracker.js — Post-exit follow-up tracking and learning
//
// After every position closes, monitors what the price does at +4h / +24h / +72h / +7d.
// At each checkpoint captures price drift AND an indicator/media snapshot so we can
// answer: "Did we sell too early? What changed in the market after we exited?"
//
// On final completion:
//   "Missed runner" (+8% drift): signals that were POSITIVE at exit → boosted
//     (they were saying "hold" and were right — next time we'll hold longer)
//   "Good exit"    (-5% drift): signals that were NEGATIVE at exit → boosted
//     (they correctly predicted the fall)
//   Within ±5%: neutral — no weight adjustment (noise)
//
// Standalone — does NOT import tradeJournal to avoid circular deps.
// tradeJournal.recordExit() calls postExitTracker.schedule() after closing a trade.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const DATA_DIR = require('./dataDir');

const FOLLOWUPS_PATH = path.join(DATA_DIR, 'exit-followups.json');
const WEIGHTS_PATH   = path.join(DATA_DIR, 'learned-weights.json');

// ── Checkpoint schedule (hours after exit) ───────────────────────────────────
// +4h  → catches fast crypto/MEXC pump windows — these close in hours
// +24h → most valuable: overnight gaps, next-day catalyst follow-through
// +72h → medium-term: did the thesis have legs or was it a spike?
// +7d  → final: after this, too many unrelated events confound the signal
const CHECKPOINTS_H = [4, 24, 72, 168];

// ── Learning thresholds ───────────────────────────────────────────────────────
const MISSED_RUNNER_THRESHOLD =  8;   // +8% after exit = left money on table
const GOOD_EXIT_THRESHOLD     = -5;   // -5% after exit = dodged a bullet
const EARLY_WIN_THRESHOLD     = -15;  // -15% at any checkpoint → stop tracking early
const LEARN_RATE              = 0.03;
const MIN_W = 0.2;
const MAX_W = 3.0;

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFollowups() {
    try { return JSON.parse(fs.readFileSync(FOLLOWUPS_PATH, 'utf8')); }
    catch { return { pending: [], completed: [] }; }
}

function saveFollowups(f) {
    fs.writeFileSync(FOLLOWUPS_PATH, JSON.stringify(f, null, 2));
}

function loadWeights() {
    try { return JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8')); }
    catch { return {}; }
}

function saveWeights(w) {
    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(w, null, 2));
}

// ── Option symbol parser ──────────────────────────────────────────────────────
// For option contracts like AAPL240315C00170000 → track the UNDERLYING stock
// since the contract itself expires, but the thesis lives on in the underlying.

function parseOptionUnderlying(symbol) {
    const m = symbol.match(/^([A-Z]+)\d{6}[CP]\d{8}$/);
    return m ? { underlying: m[1], isOption: true } : { underlying: symbol, isOption: false };
}

// ── Schedule follow-up after a trade closes ──────────────────────────────────
// Called by tradeJournal.recordExit(). Receives the closed trade object.

function schedule(trade) {
    if (!trade || !trade.symbol || trade.exitPrice == null) return;

    const followups = loadFollowups();
    const now = new Date(trade.exitTime || Date.now());

    // For options contracts, track the underlying stock price (contract expires)
    const { underlying, isOption } = parseOptionUnderlying(trade.symbol);

    const entry = {
        id:              trade.id || `${trade.symbol}-${Date.now()}`,
        symbol:          trade.symbol,
        trackSymbol:     underlying,            // what we actually price-check
        isOption,
        optType:         trade.optType || null, // 'call' | 'put' | null
        strategy:        trade.strategy || 'unknown',
        exitPrice:       trade.exitPrice,
        exitTime:        trade.exitTime || new Date().toISOString(),
        exitReason:      trade.exitReason || trade.reason || '',
        exitSignals:     trade.signals || {},   // signal map at the moment of exit
        side:            trade.side || 'buy',
        pnlPct:          trade.pnlPct || null,
        checkpoints: CHECKPOINTS_H.map(h => ({
            hoursAfter:  h,
            dueAt:       new Date(now.getTime() + h * 3_600_000).toISOString(),
            status:      'pending',
            price:       null,
            drift:       null,
            snapshot:    null,       // { rsi, macdBullish, newsScore, trend, note }
            checkedAt:   null,
        })),
        verdict:         null,   // 'missed_runner' | 'good_exit' | 'neutral'
        maxDrift:        null,
        completed:       false,
    };

    followups.pending.push(entry);
    saveFollowups(followups);
    console.log(`[PostExit] Scheduled follow-up for ${trade.symbol} → checkpoints at +4h/24h/72h/7d`);
}

// ── Process due checkpoints ───────────────────────────────────────────────────
// Called from each market scanner during its normal scan cycle.
//
//   priceMap:    { [symbol]: currentPrice }
//   strategies:  ['stocks', 'crypto', ...] — only process these strategies
//   snapshotMap: { [symbol]: { rsi, macdBullish, macdCrossover, newsScore, trend, note } }
//                optional — enriches checkpoint records for the !missed analysis

function processDue(priceMap, strategies, snapshotMap = {}) {
    const followups = loadFollowups();
    const now = Date.now();
    let changed = false;

    for (const entry of followups.pending) {
        if (entry.completed) continue;
        if (strategies && strategies.length && !strategies.includes(entry.strategy)) continue;

        // Use trackSymbol (underlying for options, symbol otherwise)
        const sym = entry.trackSymbol || entry.symbol;
        const currentPrice = priceMap[sym];
        if (!currentPrice || currentPrice <= 0) continue;

        // For options: interpret drift based on optType
        // call → positive drift = missed runner; put → negative drift = missed runner
        const rawDrift = (currentPrice - entry.exitPrice) / entry.exitPrice * 100;
        const effectiveDrift = entry.isOption && entry.optType === 'put' ? -rawDrift : rawDrift;

        for (const cp of entry.checkpoints) {
            if (cp.status !== 'pending') continue;
            if (new Date(cp.dueAt).getTime() > now) continue;

            cp.status    = 'done';
            cp.checkedAt = new Date().toISOString();
            cp.price     = parseFloat(currentPrice.toFixed(4));
            cp.drift     = parseFloat(effectiveDrift.toFixed(2));
            cp.snapshot  = buildSnapshot(sym, snapshotMap, currentPrice, entry.exitPrice);
            changed = true;

            if (entry.maxDrift === null || effectiveDrift > entry.maxDrift) {
                entry.maxDrift = parseFloat(effectiveDrift.toFixed(2));
            }

            if (effectiveDrift >= MISSED_RUNNER_THRESHOLD) {
                const snapshotNote = cp.snapshot?.note || '';
                console.log(`[PostExit] ⚠️  MISSED RUNNER: ${entry.symbol} +${effectiveDrift.toFixed(1)}% at +${cp.hoursAfter}h | exit reason: "${entry.exitReason}" | ${snapshotNote}`);
            } else if (effectiveDrift <= GOOD_EXIT_THRESHOLD) {
                console.log(`[PostExit] ✅ GOOD EXIT: ${entry.symbol} ${effectiveDrift.toFixed(1)}% at +${cp.hoursAfter}h — dodged the drop`);
            }

            // Early termination: if confirmed a solid dodge (price tanked >15%), stop remaining checks
            if (effectiveDrift <= EARLY_WIN_THRESHOLD) {
                console.log(`[PostExit] ${entry.symbol} early-complete — price dropped ${effectiveDrift.toFixed(1)}%, marking remaining checkpoints done`);
                for (const rem of entry.checkpoints) {
                    if (rem.status === 'pending') {
                        rem.status = 'skipped';
                        rem.drift  = effectiveDrift;
                    }
                }
                break;
            }
        }

        // All checkpoints resolved (done or skipped)?
        const allResolved = entry.checkpoints.every(cp => cp.status !== 'pending');
        if (allResolved) {
            entry.completed = true;
            entry.verdict   = determineVerdict(entry);
            adjustWeights(entry);
            followups.completed.push({ ...entry });
            console.log(`[PostExit] ${entry.symbol} complete — verdict: ${entry.verdict} | max drift: ${entry.maxDrift?.toFixed(1)}%`);
            changed = true;
        }
    }

    // Remove completed from pending list
    followups.pending = followups.pending.filter(e => !e.completed);

    // Cap completed history at 200 (enough for meaningful stats, bounded memory)
    if (followups.completed.length > 200) {
        followups.completed = followups.completed.slice(-200);
    }

    if (changed) saveFollowups(followups);
    return changed;
}

// ── Build a rich checkpoint snapshot ─────────────────────────────────────────
// Assembles both the passed-in indicators AND a human-readable note for Discord.

function buildSnapshot(sym, snapshotMap, currentPrice, exitPrice) {
    const raw = snapshotMap[sym] || {};
    const drift = ((currentPrice - exitPrice) / exitPrice * 100).toFixed(1);

    const parts = [];
    if (raw.rsi != null)         parts.push(`RSI ${raw.rsi}`);
    if (raw.macdBullish != null) parts.push(`MACD ${raw.macdBullish ? '▲bullish' : '▼bearish'}`);
    if (raw.trend != null)       parts.push(`trend=${raw.trend}`);
    if (raw.newsScore != null)   parts.push(`news ${raw.newsScore >= 2 ? '📰+' : raw.newsScore <= -2 ? '📰-' : '📰~'}${raw.newsScore}`);
    if (raw.fearGreed != null)   parts.push(`FG=${raw.fearGreed}`);
    if (raw.volume != null)      parts.push(`vol=${raw.volume}`);

    return {
        rsi:          raw.rsi        ?? null,
        macdBullish:  raw.macdBullish ?? null,
        macdCrossover:raw.macdCrossover ?? null,
        trend:        raw.trend      ?? null,
        newsScore:    raw.newsScore  ?? null,
        fearGreed:    raw.fearGreed  ?? null,
        volume:       raw.volume     ?? null,
        note:         parts.length ? `${drift}% since exit — ${parts.join(', ')}` : `${drift}% since exit`,
    };
}

// ── Verdict ───────────────────────────────────────────────────────────────────

function determineVerdict(entry) {
    if (entry.maxDrift >= MISSED_RUNNER_THRESHOLD)  return 'missed_runner';
    if (entry.maxDrift <= GOOD_EXIT_THRESHOLD)       return 'good_exit';
    return 'neutral';
}

// ── Weight learning from verdict ──────────────────────────────────────────────
// Missed runner: signals POSITIVE at exit → boost (they said "hold" and were right)
//               signals NEGATIVE at exit → slight penalty (false sell signal)
// Good exit:    signals NEGATIVE at exit → boost (correctly predicted the fall)
//               signals POSITIVE at exit → slight penalty (false hold signal)
//
// Scale the nudge by how large the drift was — a +20% miss teaches harder than +9%.

function adjustWeights(entry) {
    const signals = entry.exitSignals || {};
    const verdict = entry.verdict;
    if (verdict === 'neutral') return;
    if (!Object.keys(signals).length) return;

    const weights = loadWeights();
    if (!Object.keys(weights).length) return;

    // Scale factor: bigger misses / better exits → stronger learning signal
    const magnitude = Math.min(Math.abs(entry.maxDrift ?? 0) / 10, 2.0); // 0–2x multiplier
    let updated = false;

    for (const [key, value] of Object.entries(signals)) {
        if (weights[key] === undefined) continue;
        if (typeof value !== 'number' || value === 0) continue;

        let nudge = 0;

        if (verdict === 'missed_runner') {
            // We left money on table — positive signals at exit were saying "hold"
            if (value > 0) {
                nudge = +LEARN_RATE * magnitude * Math.min(Math.abs(value), 3);
            } else {
                nudge = -LEARN_RATE * magnitude * 0.5; // penalise false-sell signals gently
            }
        } else if (verdict === 'good_exit') {
            // Price dropped after we sold — negative signals at exit were right
            if (value < 0) {
                nudge = +LEARN_RATE * magnitude * Math.min(Math.abs(value), 3);
            } else {
                nudge = -LEARN_RATE * magnitude * 0.3; // penalise false-hold signals gently
            }
        }

        if (nudge !== 0) {
            weights[key] = parseFloat(
                Math.max(MIN_W, Math.min(MAX_W, weights[key] + nudge)).toFixed(3)
            );
            updated = true;
        }
    }

    if (updated) {
        saveWeights(weights);
        console.log(`[PostExit] Weights adjusted after ${verdict} on ${entry.symbol} (maxDrift ${entry.maxDrift?.toFixed(1)}%)`);
    }
}

// ── Public query functions ─────────────────────────────────────────────────────

function getMissedRunners(limit = 10) {
    const f = loadFollowups();
    return f.completed
        .filter(e => e.verdict === 'missed_runner')
        .slice(-limit)
        .reverse();
}

function getGoodExits(limit = 5) {
    const f = loadFollowups();
    return f.completed
        .filter(e => e.verdict === 'good_exit')
        .slice(-limit)
        .reverse();
}

function getPending() {
    return loadFollowups().pending;
}

function getStats() {
    const f   = loadFollowups();
    const c   = f.completed;
    const missed  = c.filter(e => e.verdict === 'missed_runner');
    const good    = c.filter(e => e.verdict === 'good_exit');
    const neutral = c.filter(e => e.verdict === 'neutral');

    // Average money left on table for misses
    const avgMiss = missed.length
        ? parseFloat((missed.reduce((s, e) => s + (e.maxDrift || 0), 0) / missed.length).toFixed(1))
        : 0;

    return {
        pending:       f.pending.length,
        completed:     c.length,
        missedRunners: missed.length,
        goodExits:     good.length,
        neutral:       neutral.length,
        avgMissedDrift: avgMiss,
        exitAccuracy:  c.length > 0
            ? parseFloat(((good.length / c.length) * 100).toFixed(1))
            : null,
    };
}

module.exports = {
    schedule,
    processDue,
    getMissedRunners,
    getGoodExits,
    getPending,
    getStats,
};
