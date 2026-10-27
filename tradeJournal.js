// tradeJournal.js — Trade logging, outcome tracking, and adaptive weight learning
// Saves every trade with full context, tracks P&L, and adjusts signal weights
// based on historical win/loss patterns.
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const postExitTracker = require('./postExitTracker');

const fees         = require('./fees');
const DATA_DIR     = require('./dataDir');
const JOURNAL_PATH = path.join(DATA_DIR, 'trade-journal.json');
const WEIGHTS_PATH = path.join(DATA_DIR, 'learned-weights.json');

// ── Default signal weights (evolve over time) ───────────────────────────────

const DEFAULT_WEIGHTS = {
    // ── US stocks / options ────────────────────────────────────────────────
    newsSentiment:    1.0,
    rsi:              1.0,
    macdCrossover:    1.0,
    macdBullish:      1.0,
    emaTrend:         1.0,
    bollingerBand:    1.0,
    bollingerSqueeze: 1.0,
    stochastic:       1.0,
    atr:              1.0,
    reportBias:       1.0,
    congressBuy:      1.0,
    congressVip:      1.0,   // VIP politician trade signal
    congressBigMoney: 1.0,   // $50K+ single trade signal
    fearGreed:        1.0,
    volume:           1.0,
    // ── Crypto (Alpaca) ────────────────────────────────────────────────────
    priceMomentum:    1.0,   // 24h change tier score
    // ── Asian paper trader ─────────────────────────────────────────────────
    dayChange:        1.0,   // % day change score
    newsScore:        1.0,   // raw news sentiment for Asian tickers
    mktBias:          1.0,   // overall market directional bias
    // ── MEXC paper trader ──────────────────────────────────────────────────
    mexcMomentum:     1.0,   // % pump tier score
    mexcVolume:       1.0,   // USDT volume tier score
    mexcNearHigh:     1.0,   // proximity to 24h high
    // ── ML pipeline (src/main.js) ──────────────────────────────────────────
    momentum:         1.0,   // ML momentum feature
    volumeSpike:      1.0,   // ML volume-spike feature
    sentiment:        1.0,   // ML sentiment feature
};

// ── Learning trigger state ────────────────────────────────────────────────────
let lastLearnTime = 0;          // epoch ms — 0 means never learned
let consecutiveLosses = 0;      // resets on a win

// ── State management ─────────────────────────────────────────────────────────

function loadJournal() {
    try { return JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')); }
    catch { return { trades: [], closedTrades: [], stats: {} }; }
}

function saveJournal(j) {
    fs.writeFileSync(JOURNAL_PATH, JSON.stringify(j, null, 2));
}

function loadWeights() {
    try { return JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8')); }
    catch { return { ...DEFAULT_WEIGHTS }; }
}

function saveWeights(w) {
    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(w, null, 2));
}

// ── Record a trade entry ─────────────────────────────────────────────────────

function recordEntry(trade) {
    // trade: { symbol, side, qty, price, strategy, tier, score, signals, indicators, reason }
    const journal = loadJournal();
    const entry = {
        id:         `${trade.symbol}-${Date.now()}`,
        symbol:     trade.symbol,
        side:       trade.side || 'buy',
        qty:        trade.qty || 0,
        entryPrice: trade.price,
        entryTime:  new Date().toISOString(),
        strategy:   trade.strategy || 'unknown',   // stocks, crypto, options, wheel, risky, politico
        tier:       trade.tier || 'MEDIUM',         // LOW, MEDIUM, HIGH
        score:      trade.score || 0,
        signals:    trade.signals || {},            // { news: 2, rsi: -1, macd: 1.5, ... }
        indicators: trade.indicators || {},         // full indicator snapshot
        reason:     trade.reason || '',
        status:     'open',
        exitPrice:  null,
        exitTime:   null,
        pnl:        null,
        pnlPct:     null,
    };
    journal.trades.push(entry);
    saveJournal(journal);
    return entry.id;
}

// ── Record a trade exit ──────────────────────────────────────────────────────

function closeTradeInPlace(trade, exitPrice, reason) {
    trade.exitPrice = exitPrice;
    trade.exitTime  = new Date().toISOString();
    trade.reason    = reason || trade.reason;
    trade.status    = 'closed';
    const gross = trade.side === 'buy'
        ? (exitPrice - trade.entryPrice) * trade.qty
        : (trade.entryPrice - exitPrice) * trade.qty;
    // Real-world cost: round-trip commission + spread + slippage (see fees.js).
    // Deducted so the journal P&L — and the whole-bot readiness KPI — is NET of fees.
    const fee = fees.roundTrip(trade.strategy, trade.entryPrice * trade.qty, exitPrice * trade.qty);
    trade.grossPnl = parseFloat(gross.toFixed(2));
    trade.fees     = parseFloat(fee.toFixed(2));
    trade.pnl      = parseFloat((gross - fee).toFixed(2));
    trade.pnlPct   = trade.side === 'buy'
        ? parseFloat(((exitPrice / trade.entryPrice - 1) * 100).toFixed(2))
        : parseFloat(((trade.entryPrice / exitPrice - 1) * 100).toFixed(2));
}

const normSym = s => String(s || '').replace('/', '').toUpperCase();

function recordExit(symbol, exitPrice, reason) {
    const journal = loadJournal();
    // A sell closes the WHOLE position — which may be several DCA'd entries
    // (ladder buys, repeated entries). Close every open entry for this symbol;
    // closing only the newest left the rest stranded as "open" forever.
    // Symbols are normalized: "SOL/USD" and "SOLUSD" are the same position.
    const key = normSym(symbol);
    const matches = journal.trades.filter(t => t.status === 'open' && normSym(t.symbol) === key);
    if (!matches.length) return null;

    let aggregatePnl = 0;
    for (const t of matches) {
        closeTradeInPlace(t, exitPrice, reason);
        aggregatePnl += t.pnl;
        journal.closedTrades.push({ ...t });
    }
    journal.trades = journal.trades.filter(t => t.status === 'open');
    const trade = matches[matches.length - 1];

    // Update stats
    updateStats(journal);
    saveJournal(journal);

    // Track consecutive losses (on the position as a whole)
    if (aggregatePnl > 0) {
        consecutiveLosses = 0;
    } else {
        consecutiveLosses++;
    }

    // Time-based learning: every 30 minutes regardless of trade count
    const now = Date.now();
    const thirtyMin = 30 * 60 * 1000;
    const triggerByTime = journal.closedTrades.length >= 5 && (now - lastLearnTime) >= thirtyMin;
    // Also trigger immediately after 3 consecutive losses
    const triggerByLosses = consecutiveLosses >= 3 && journal.closedTrades.length >= 5;

    if (triggerByTime || triggerByLosses) {
        lastLearnTime = now;
        consecutiveLosses = 0; // reset after learning
        learnWeights(journal);
    }

    // Schedule post-exit follow-up (tracks what price does at +4h/24h/72h/7d)
    postExitTracker.schedule(trade);

    return trade;
}

// ── Reconciliation — close journal entries whose position vanished ───────────
// Alpaca-side exits (trailing-stop fills, manual sells) never told the journal,
// so entries piled up as "open" forever (6,400+ at one point). Each scan now
// closes any open entry whose symbol is no longer held, at the current price.

function reconcile(strategy, heldSymbols, priceMap) {
    const journal = loadJournal();
    const held = new Set((heldSymbols || []).map(normSym));
    const prices = {};
    for (const [k, v] of Object.entries(priceMap || {})) if (v > 0) prices[normSym(k)] = v;

    let closedCount = 0, orphanCount = 0;
    if (!journal.orphaned) journal.orphaned = [];
    for (const t of journal.trades) {
        if (t.status !== 'open' || t.strategy !== strategy) continue;
        const key = normSym(t.symbol);
        if (held.has(key)) continue;          // still held — genuinely open
        const px = prices[key];
        if (px) {
            closeTradeInPlace(t, px, 'reconciled — position closed externally (stop fill / manual sell)');
            journal.closedTrades.push({ ...t });
            closedCount++;
        } else if ((Date.now() - new Date(t.entryTime).getTime()) > 3 * 86400000) {
            // Not held, no price source, entry >3 days old — unresolvable. Park it
            // as orphaned rather than fabricating a P&L that would pollute stats.
            t.status = 'orphaned';
            journal.orphaned.push({ ...t });
            orphanCount++;
        }
    }
    if (closedCount || orphanCount) {
        journal.trades = journal.trades.filter(t => t.status === 'open');
        if (journal.orphaned.length > 500) journal.orphaned = journal.orphaned.slice(-500);
        updateStats(journal);
        saveJournal(journal);
        if (orphanCount) console.log(`[Journal] Parked ${orphanCount} unresolvable stale entrie(s) as orphaned (${strategy})`);
    }
    return closedCount;
}

// One-time cleanup: massive backlog of stranded entries from before fixes.
// Mark all open entries older than 5 days as orphaned (unresolvable) — aggressive.
function purgeAncientOrphans() {
    const journal = loadJournal();
    if (!journal.orphaned) journal.orphaned = [];
    const cutoff = Date.now() - 5 * 86400000;  // 5 days old (aggressive)
    const ancient = journal.trades.filter(t => t.status === 'open' && new Date(t.entryTime).getTime() < cutoff);
    for (const t of ancient) {
        t.status = 'orphaned';
        journal.orphaned.push(t);
    }
    if (ancient.length) {
        journal.trades = journal.trades.filter(t => t.status === 'open');
        if (journal.orphaned.length > 500) journal.orphaned = journal.orphaned.slice(-500);
        updateStats(journal);
        saveJournal(journal);
        console.log(`[Journal] Purged ${ancient.length} ancient orphaned entries (>5 days old, unresolvable)`);
    }
    return ancient.length;
}

// One-time repair for the duplicate-import bug (BROKER_STRATEGIES was missing
// 'reconciled', so every scan re-imported the same broker positions). Collapses
// duplicate OPEN entries to one per symbol, and drops the phantom duplicate CLOSED
// entries those imports produced — they multiplied a handful of real broker exits
// into ~86 fake losses. Safe to run repeatedly; a no-op once clean.
function dedupeReconciled() {
    const journal = loadJournal();
    let openRemoved = 0, closedRemoved = 0;

    // OPEN: keep the earliest entry per (strategy, symbol) for broker-imported trades
    const seenOpen = new Map();
    const keptOpen = [];
    for (const t of journal.trades) {
        if (t.status !== 'open' || !BROKER_STRATEGIES.has(t.strategy)) { keptOpen.push(t); continue; }
        const key = `${t.strategy}|${normSym(t.symbol)}`;
        const prior = seenOpen.get(key);
        if (!prior) { seenOpen.set(key, t); keptOpen.push(t); continue; }
        // duplicate — keep whichever entered first
        if (new Date(t.entryTime) < new Date(prior.entryTime)) {
            keptOpen[keptOpen.indexOf(prior)] = t;
            seenOpen.set(key, t);
        }
        openRemoved++;
    }

    // CLOSED: drop exact-duplicate reconciled exits (same symbol/prices/pnl)
    const seenClosed = new Set();
    const keptClosed = [];
    for (const t of journal.closedTrades || []) {
        if (t.strategy !== 'reconciled') { keptClosed.push(t); continue; }
        const sig = `${normSym(t.symbol)}|${t.entryPrice}|${t.exitPrice}|${t.pnl}`;
        if (seenClosed.has(sig)) { closedRemoved++; continue; }
        seenClosed.add(sig);
        keptClosed.push(t);
    }

    if (openRemoved || closedRemoved) {
        journal.trades = keptOpen;
        journal.closedTrades = keptClosed;
        updateStats(journal);
        saveJournal(journal);
        console.log(`[Journal] Deduped broker imports — removed ${openRemoved} duplicate open, ${closedRemoved} phantom closed entries`);
    }
    return { openRemoved, closedRemoved };
}

// Every stream now trades through paperBroker, so nothing should ever land in the
// 'reconciled' (Alpaca broker-import) bucket again. Drop any strays — left alone they
// hang open forever and their eventual closes corrupt the streams' P&L baseline.
function purgeBrokerImports() {
    const journal = loadJournal();
    const before = journal.trades.length;
    journal.trades = journal.trades.filter(t => !(t.strategy === 'reconciled' || t.reconciled));
    const removed = before - journal.trades.length;
    if (removed) {
        updateStats(journal);
        saveJournal(journal);
        console.log(`[Journal] Purged ${removed} legacy broker-import entrie(s) — all streams are paper-traded now`);
    }
    return removed;
}

// ── Stats computation ────────────────────────────────────────────────────────

function updateStats(journal) {
    const closed = journal.closedTrades;
    if (!closed.length) { journal.stats = {}; return; }

    const wins   = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl <= 0);

    journal.stats = {
        totalTrades: closed.length,
        wins:        wins.length,
        losses:      losses.length,
        winRate:     parseFloat((wins.length / closed.length * 100).toFixed(1)),
        totalPnl:    parseFloat(closed.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2)),
        totalFees:   parseFloat(closed.reduce((s, t) => s + (t.fees || 0), 0).toFixed(2)),
        avgWin:      wins.length  ? parseFloat((wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length).toFixed(2)) : 0,
        avgLoss:     losses.length ? parseFloat((losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length).toFixed(2)) : 0,
        byStrategy:  strategyBreakdown(closed),
        byTier:      tierBreakdown(closed),
        lastUpdated: new Date().toISOString(),
    };
}

function strategyBreakdown(trades) {
    const groups = {};
    for (const t of trades) {
        const s = t.strategy || 'unknown';
        if (!groups[s]) groups[s] = { trades: 0, wins: 0, pnl: 0 };
        groups[s].trades++;
        if (t.pnl > 0) groups[s].wins++;
        groups[s].pnl = parseFloat((groups[s].pnl + (t.pnl || 0)).toFixed(2));
    }
    for (const s of Object.keys(groups)) {
        groups[s].winRate = parseFloat((groups[s].wins / groups[s].trades * 100).toFixed(1));
    }
    return groups;
}

function tierBreakdown(trades) {
    const groups = {};
    for (const t of trades) {
        const tier = t.tier || 'MEDIUM';
        if (!groups[tier]) groups[tier] = { trades: 0, wins: 0, pnl: 0 };
        groups[tier].trades++;
        if (t.pnl > 0) groups[tier].wins++;
        groups[tier].pnl = parseFloat((groups[tier].pnl + (t.pnl || 0)).toFixed(2));
    }
    for (const tier of Object.keys(groups)) {
        groups[tier].winRate = parseFloat((groups[tier].wins / groups[tier].trades * 100).toFixed(1));
    }
    return groups;
}

// ── Online learning from open trades ─────────────────────────────────────────
// Called every scan with current prices. Uses unrealised P&L as an interim
// reward signal — don't wait for close. Small learn rate (0.01) so open-trade
// nudges don't override the stronger closed-trade signal (0.05).

function learnFromOpenTrades(openPositions) {
    // openPositions: [{ symbol, currentPnlPct, signals: {key: value, ...} }]
    if (!openPositions || openPositions.length === 0) return;

    const weights  = loadWeights();
    const RATE     = 0.01;   // softer than closed-trade rate of 0.05
    const MIN_W    = 0.2;
    const MAX_W    = 3.0;
    let   updated  = false;

    for (const pos of openPositions) {
        const pnl     = pos.currentPnlPct || 0;
        const signals = pos.signals || {};
        if (Math.abs(pnl) < 0.5) continue; // ignore noise — only learn when clearly winning/losing

        const direction = pnl > 0 ? 1 : -1; // winning → reward signals that fired; losing → penalise

        for (const [key, value] of Object.entries(signals)) {
            if (weights[key] === undefined) continue;
            if (typeof value !== 'number' || value === 0) continue;

            // If signal was positive and trade is winning → nudge up; losing → nudge down
            const agree  = Math.sign(value) === direction;
            const nudge  = agree ? RATE * Math.abs(value) : -RATE * Math.abs(value);
            weights[key] = parseFloat(Math.max(MIN_W, Math.min(MAX_W, weights[key] + nudge)).toFixed(3));
            updated = true;
        }
    }

    if (updated) {
        saveWeights(weights);
        console.log('[Journal] Online weights updated from', openPositions.length, 'open trades');
    }
    return weights;
}

// ── Weight learning ──────────────────────────────────────────────────────────
// Analyzes closed trades to see which signals correlate with wins vs losses.
// Nudges weights up for signals that appear in winning trades and down for losers.

function learnWeights(journal) {
    const closed = journal.closedTrades;
    if (closed.length < 5) return; // reduced from 20 — start learning earlier

    const weights = loadWeights();
    const signalCorrelation = {};

    // Initialize correlation tracking
    for (const key of Object.keys(DEFAULT_WEIGHTS)) {
        signalCorrelation[key] = { winSum: 0, winCount: 0, loseSum: 0, loseCount: 0 };
    }

    // Analyze each closed trade's signals
    for (const trade of closed) {
        const signals = trade.signals || {};
        const isWin = trade.pnl > 0;

        for (const [key, value] of Object.entries(signals)) {
            if (signalCorrelation[key] === undefined) continue;
            if (typeof value !== 'number') continue;

            if (isWin) {
                signalCorrelation[key].winSum += value;
                signalCorrelation[key].winCount++;
            } else {
                signalCorrelation[key].loseSum += value;
                signalCorrelation[key].loseCount++;
            }
        }
    }

    // Adjust weights: signals that are more positive in wins get boosted
    const LEARN_RATE = 0.05; // small nudges
    const MIN_WEIGHT = 0.2;
    const MAX_WEIGHT = 3.0;

    for (const [key, corr] of Object.entries(signalCorrelation)) {
        if (corr.winCount < 3 && corr.loseCount < 3) continue; // not enough data

        const avgWin  = corr.winCount  ? corr.winSum / corr.winCount   : 0;
        const avgLose = corr.loseCount ? corr.loseSum / corr.loseCount : 0;

        // If this signal averages higher in wins than losses, nudge weight up
        const diff = avgWin - avgLose;
        const nudge = Math.sign(diff) * Math.min(Math.abs(diff) * LEARN_RATE, 0.1);

        weights[key] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weights[key] + nudge));
        weights[key] = parseFloat(weights[key].toFixed(3));
    }

    saveWeights(weights);
    console.log('[Journal] Weights updated:', JSON.stringify(weights));
    return weights;
}

// ── Broker reconciliation ─────────────────────────────────────────────────────
// The journal can drift out of sync with Alpaca: positions opened before the
// journal existed, or closed by broker-side trailing stops the bot never saw.
// This imports untracked broker positions and closes journal trades the broker
// no longer holds — so the US market actually feeds P&L + learning.

// MUST include 'reconciled' — stratForAsset() files broker stock positions under it.
// Leaving it out made the import dedup-check below never match, so every scan
// re-imported the same broker positions as fresh open entries (13 symbols × 5 copies),
// and the close-pass skipped them entirely. Both bugs share this one Set.
const BROKER_STRATEGIES = new Set(['stocks', 'crypto', 'options', 'risky', 'mexc-bridge', 'ml-pipeline', 'reconciled']);

function normSymbol(s) {
    return String(s || '').toUpperCase().replace(/[\/\s]/g, '');
}

function reconcileWithBroker(brokerPositions = [], recentOrders = []) {
    const journal = loadJournal();
    let imported = 0, closed = 0;

    // Broker-imported positions have NO entry signal, so they must NOT land in the
    // signal-driven 'stocks' bucket (it would corrupt the scanner's win-rate). They
    // go to a neutral 'reconciled' bucket instead.
    const stratForAsset = (ac) =>
        ac === 'us_option' ? 'options'
      : ac === 'crypto'    ? 'crypto'
      : 'reconciled';

    // Normalized lookup of what the broker currently holds
    const brokerHeld = new Map();
    for (const p of brokerPositions) brokerHeld.set(normSymbol(p.symbol), p);

    // 1. IMPORT — broker positions with no matching open journal trade
    for (const p of brokerPositions) {
        const qtyNum = parseFloat(p.qty);
        const qty = Math.abs(qtyNum);
        if (!qty) continue;

        // Short options belong to the wheel strategy — don't import as long bets
        if (p.asset_class === 'us_option' && qtyNum < 0) continue;

        const already = journal.trades.some(t =>
            BROKER_STRATEGIES.has(t.strategy) &&
            t.status === 'open' &&
            normSymbol(t.symbol) === normSymbol(p.symbol));
        if (already) continue;

        // Normalize crypto to the bot's slash convention (BTCUSD → BTC/USD)
        let sym = p.symbol;
        if (p.asset_class === 'crypto' && !sym.includes('/')) {
            sym = sym.replace(/USDT$/, '/USDT').replace(/(?<!\/)USD$/, '/USD');
        }

        journal.trades.push({
            id:         `${sym}-recon-${Date.now()}-${imported}`,
            symbol:     sym,
            side:       qtyNum < 0 ? 'sell' : 'buy',
            qty,
            entryPrice: parseFloat(p.avg_entry_price) || parseFloat(p.current_price) || 0,
            entryTime:  new Date().toISOString(),
            strategy:   stratForAsset(p.asset_class),
            tier:       'MEDIUM',
            score:      0,
            signals:    {},   // unknown — P&L is tracked, but won't bias signal learning
            indicators: {},
            reason:     'reconciled from broker (pre-existing position)',
            status:     'open',
            exitPrice:  null, exitTime: null, pnl: null, pnlPct: null,
            reconciled: true,
        });
        imported++;
    }

    // 2. CLOSE — journal open broker-trades the broker no longer holds
    const stillOpen = [];
    for (const t of journal.trades) {
        if (!BROKER_STRATEGIES.has(t.strategy) || t.status !== 'open') { stillOpen.push(t); continue; }
        if (brokerHeld.has(normSymbol(t.symbol))) { stillOpen.push(t); continue; }

        // Gone from broker → closed externally (trailing stop / manual). Find the fill.
        const order = recentOrders.find(o =>
            normSymbol(o.symbol) === normSymbol(t.symbol) &&
            o.filled_avg_price && (o.side === 'sell' || parseFloat(o.filled_qty || 0) > 0));
        const exitPrice = order ? parseFloat(order.filled_avg_price) : t.entryPrice;

        t.exitPrice = exitPrice;
        t.exitTime  = order?.filled_at || new Date().toISOString();
        t.status    = 'closed';
        t.reason    = order ? 'closed at broker (reconciled fill)' : 'closed at broker (price unknown — used entry)';
        if (t.side === 'buy') {
            t.pnl    = parseFloat(((exitPrice - t.entryPrice) * t.qty).toFixed(2));
            t.pnlPct = parseFloat(((exitPrice / t.entryPrice - 1) * 100).toFixed(2));
        } else {
            t.pnl    = parseFloat(((t.entryPrice - exitPrice) * t.qty).toFixed(2));
            t.pnlPct = parseFloat(((t.entryPrice / exitPrice - 1) * 100).toFixed(2));
        }
        journal.closedTrades.push({ ...t });
        try { postExitTracker.schedule(t); } catch {}
        closed++;
    }
    journal.trades = stillOpen;

    if (imported || closed) {
        updateStats(journal);
        saveJournal(journal);
        console.log(`[Journal] Broker reconciliation — imported ${imported} position(s), closed ${closed} orphan(s)`);
    }
    return { imported, closed };
}

// ── Apply learned weights to a score ─────────────────────────────────────────
// Takes raw signal contributions and returns a weighted score.

function applyWeights(signals) {
    const weights = loadWeights();
    let total = 0;
    for (const [key, value] of Object.entries(signals)) {
        if (typeof value !== 'number') continue;
        const w = weights[key] !== undefined ? weights[key] : 1.0;
        total += value * w;
    }
    return parseFloat(total.toFixed(2));
}

// ── Get stats for display ────────────────────────────────────────────────────

function calculateUnrealizedPnl() {
    const journal = loadJournal();
    return journal.trades.reduce((sum, trade) => {
        const unrealized = trade.unrealizedPnl ?? 0;
        return sum + unrealized;
    }, 0);
}

function calculateProfitFactor() {
    const journal = loadJournal();
    const closed = journal.closedTrades || [];

    let totalWins = 0, totalLosses = 0;
    for (const trade of closed) {
        const pnl = trade.pnl || 0;
        if (pnl > 0) totalWins += pnl;
        else if (pnl < 0) totalLosses += Math.abs(pnl);
    }

    if (totalLosses === 0) return totalWins > 0 ? 999 : 0; // no losses = perfect
    return parseFloat((totalWins / totalLosses).toFixed(2));
}

function calculateAvgWinLossRatio() {
    const journal = loadJournal();
    const closed = journal.closedTrades || [];

    const wins = closed.filter(t => (t.pnl || 0) > 0);
    const losses = closed.filter(t => (t.pnl || 0) < 0);

    if (wins.length === 0 || losses.length === 0) return 0;

    const avgWin = wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length);

    if (avgLoss === 0) return 999;
    return parseFloat((avgWin / avgLoss).toFixed(2));
}

function getKpiStatus() {
    // Calculate all KPI metrics and return Tier 1/2/3 status
    const journal = loadJournal();
    const closed = journal.closedTrades || [];

    if (closed.length === 0) {
        return {
            status: 'NO_DATA',
            winRate: 0,
            profitFactor: 0,
            realizedPnl: 0,
            realizedPnlPct: 0,
            avgWinLoss: 0,
            tier: 'UNKNOWN',
            metrics: {},
        };
    }

    const stats = journal.stats || {};
    const winRate = stats.winRate || 0;
    const totalPnl = stats.totalPnl || 0;
    const startingCapital = 3000; // $3k starting capital
    const realizedPnlPct = (totalPnl / startingCapital * 100);
    const profitFactor = calculateProfitFactor();
    const avgWinLoss = calculateAvgWinLossRatio();

    // Determine tier based on Tier 2 minimums
    const tier1Met = winRate >= 30 && profitFactor >= 1.5 && totalPnl >= 150 && avgWinLoss >= 1.0;
    const tier2Met = winRate >= 40 && profitFactor >= 2.0 && totalPnl >= 450 && avgWinLoss >= 1.2;
    const tier3Met = winRate >= 45 && profitFactor >= 2.5 && totalPnl >= 750 && avgWinLoss >= 1.5;

    return {
        status: tier3Met ? 'TIER_3' : tier2Met ? 'TIER_2' : tier1Met ? 'TIER_1' : 'NOT_READY',
        winRate: parseFloat(winRate.toFixed(1)),
        profitFactor,
        realizedPnl: parseFloat(totalPnl.toFixed(2)),
        realizedPnlPct: parseFloat(realizedPnlPct.toFixed(2)),
        avgWinLoss,
        closedTradeCount: closed.length,
        metrics: {
            tier1: { winRate: 30, profitFactor: 1.5, pnl: 150, avgWinLoss: 1.0 },
            tier2: { winRate: 40, profitFactor: 2.0, pnl: 450, avgWinLoss: 1.2 },
            tier3: { winRate: 45, profitFactor: 2.5, pnl: 750, avgWinLoss: 1.5 },
        },
    };
}

// One-time cleanup: move orphaned broker-imported (reconciled) trades out of the
// 'stocks' scanner bucket into their true home. These are the congressional/politico
// auto-buys that were imported with no signal — they were dragging the scanner's
// win rate. Relabels both open and closed trades, then recomputes stats.
function recategorizeReconciled(toStrategy = 'politico', fromStrategy = 'stocks') {
    const journal = loadJournal();
    let moved = 0;
    for (const t of [...journal.trades, ...journal.closedTrades]) {
        if (t.reconciled && t.strategy === fromStrategy) {
            t.strategy = toStrategy;
            moved++;
        }
    }
    updateStats(journal);
    saveJournal(journal);
    console.log(`[Journal] Recategorized ${moved} reconciled trade(s): ${fromStrategy} → ${toStrategy}`);
    return { moved };
}

function getStats() {
    const journal = loadJournal();
    return {
        openTrades:  journal.trades.length,
        closedTotal: journal.closedTrades.length,
        ...journal.stats,
        weights: loadWeights(),
    };
}

function getOpenTrades() {
    return loadJournal().trades;
}

function getRecentClosed(limit = 20) {
    return loadJournal().closedTrades.slice(-limit);
}

// ── Learn from politico follow-up data ───────────────────────────────────────
// Called periodically to absorb congressional trading learnings into weights.
// If politicians with good track records buy, congressBuy/congressVip/congressBigMoney
// weights get boosted. If they're consistently wrong, weights get reduced.

function learnFromPolitico() {
    try {
        const politico = require('./politicoScanner');
        const { learnings, scores } = politico.getFollowupLearnings();
        if (!learnings.length) return;

        const weights = loadWeights();
        const LEARN_RATE = 0.03;

        // Count insider wins vs no-edge
        let insiderWins = 0, total = 0;
        for (const l of learnings.slice(-50)) { // last 50 learnings
            total++;
            if (l.verdict === 'insider_win') insiderWins++;
        }

        if (total >= 5) {
            const winRate = insiderWins / total;
            // If politicians are right >60% of the time, boost congress signals
            // If <40%, reduce them
            const nudge = (winRate - 0.5) * LEARN_RATE * 2;
            weights.congressBuy      = Math.max(0.2, Math.min(3.0, weights.congressBuy + nudge));
            weights.congressVip      = Math.max(0.2, Math.min(3.0, weights.congressVip + nudge));
            weights.congressBigMoney = Math.max(0.2, Math.min(3.0, weights.congressBigMoney + nudge));

            weights.congressBuy      = parseFloat(weights.congressBuy.toFixed(3));
            weights.congressVip      = parseFloat(weights.congressVip.toFixed(3));
            weights.congressBigMoney = parseFloat(weights.congressBigMoney.toFixed(3));

            saveWeights(weights);
            console.log(`[Journal] Politico learning: ${insiderWins}/${total} insider wins (${(winRate*100).toFixed(0)}%) — congress weight → ${weights.congressBuy}`);
        }
    } catch (err) {
        console.error(`[Journal] Politico learning error: ${err.message}`);
    }
}

module.exports = {
    recordEntry,
    recordExit,
    reconcile,
    purgeAncientOrphans,
    dedupeReconciled,
    purgeBrokerImports,
    applyWeights,
    learnFromOpenTrades,
    getStats,
    getOpenTrades,
    getRecentClosed,
    learnWeights: () => learnWeights(loadJournal()),
    learnFromPolitico,
    loadWeights,
    reconcileWithBroker,
    calculateUnrealizedPnl,
    calculateProfitFactor,
    calculateAvgWinLossRatio,
    getKpiStatus,
    saveWeights,
    recategorizeReconciled,
};
