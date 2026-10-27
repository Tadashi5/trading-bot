// asianPaperTrader.js — Internal paper trader for AU 🇦🇺 / JP 🇯🇵 / CN 🇭🇰 / UK 🇬🇧 markets
// Prices sourced every 15 min via asian.js (Yahoo Finance / FMP).
// Integrates with tradeJournal (central P&L ledger + weight learning) and
// reportContext (pre-market report biases entry thresholds and stop sizes).
require('dotenv').config();
const fs           = require('fs');
const path         = require('path');
const axios        = require('axios');
const fees            = require('./fees');
const tradeJournal    = require('./tradeJournal');
const reportContext   = require('./reportContext');
const postExitTracker = require('./postExitTracker');
const { indicators: TA } = require('./strategyLibrary');

const DATA_DIR       = require('./dataDir');
const STATE_FILE     = path.join(DATA_DIR, 'asian-paper.json');
const LEARNINGS_FILE = path.join(DATA_DIR, 'asian-paper-learnings.json');
const STARTING_BALANCE = 10000;  // equal-capital baseline — every stream starts at $10k
const CHANDELIER_MULT  = 3;   // exit when price < peak − 3×ATR (backtest: beat fixed-% trail)

// Daily ATR from Yahoo for the Chandelier trailing exit. Symbols are already Yahoo
// format (BHP.AX, 7203.T). Returns null on any failure → exit falls back to fixed trail.
const _atrCache = new Map();   // symbol → { atr, t } (5-min TTL; scans are 15-min anyway)
async function fetchDailyATR(symbol, period = 14) {
    const hit = _atrCache.get(symbol);
    if (hit && Date.now() - hit.t < 300000) return hit.atr;
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2mo`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const q = res.data?.chart?.result?.[0]?.indicators?.quote?.[0];
        if (!q) return null;
        const H = [], L = [], C = [];
        for (let i = 0; i < (q.close || []).length; i++) {
            if (q.close[i] == null) continue;
            H.push(q.high[i] ?? q.close[i]); L.push(q.low[i] ?? q.close[i]); C.push(q.close[i]);
        }
        if (C.length < period + 2) return null;
        const atr = TA.ATR(H, L, C, period);
        const last = atr[atr.length - 1];
        const val = (last && last > 0) ? last : null;
        _atrCache.set(symbol, { atr: val, t: Date.now() });
        return val;
    } catch { return null; }
}

// ── Base trading parameters (adjusted live by reportContext) ──────────────────
// REVISED: Asia was bleeding on 45% WR × 10% positions = too aggressive for unproven strategy
// Tighten entry, reduce size, cut scan buy rate until strategy proves itself (get to 55%+ WR)
const MAX_POSITIONS     = 12;        // reduced from 15 (prevent over-exposure)
const MAX_BUY_PER_SCAN  = 3;         // reduced from 5 (fewer entries per scan)
const POSITION_SIZE_PCT = 0.05;      // reduced from 0.10 (smaller bets while learning)
const MIN_CHANGE_BUY    = 2.5;       // increased from 1.5% (require more momentum)
const MIN_SCORE         = 3;         // increased from 2 (tighter scoring gate)

// Per-market base thresholds (tp/sl tightened in high-VIX environments).
// Backtested (backtestAsiaExits.js, 3yr): the old tp 8/12 + trail 3/4 + itchy
// dead-money exit forced ~35 churny trades/name for +3% while stocks ran far higher.
// Take-profit and trail only ever clip WINNERS (they protect no downside — the
// stop-loss does that), so they're widened hard to let winners run. Decomposition
// showed "let it run" (wide trail, no early TP) lifted returns +3% → +39% and cut
// trades 35 → 6. TP kept as a high blow-off cap; trail widened; stop-loss unchanged.
const BASE_THRESHOLDS = {
    au: { tp: 20, sl: -5, trail: 10 },
    jp: { tp: 20, sl: -5, trail: 10 },
    cn: { tp: 28, sl: -7, trail: 12 },
    uk: { tp: 20, sl: -5, trail: 10 },
};

// ── State ─────────────────────────────────────────────────────────────────────

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch {
        const s = {
            balance: STARTING_BALANCE, startingBalance: STARTING_BALANCE,
            positions: {}, closedTrades: [],
            stats: { wins: 0, losses: 0, totalPnl: 0, trades: 0,
                     winRate: 0, avgReturn: 0, portfolioValue: STARTING_BALANCE, totalReturn: 0 },
            lastScan: null,
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
        return s;
    }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Per-market learnings (win rates, avg return, hot sectors) ────────────────

function loadLearnings() {
    try { return JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8')); }
    catch { return { markets: {}, stocks: {}, lastUpdated: null }; }
}
function saveLearnings(l) { fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(l, null, 2)); }

function updateLearnings(closedTrade) {
    const l = loadLearnings();
    const mkt = closedTrade.market;
    const sym = closedTrade.symbol;

    if (!l.markets[mkt]) l.markets[mkt] = { trades: 0, wins: 0, totalReturn: 0, avgReturn: 0, winRate: 0 };
    if (!l.stocks[sym])  l.stocks[sym]  = { name: closedTrade.name, market: mkt, trades: 0, wins: 0, totalReturn: 0, avgReturn: 0, winRate: 0 };

    for (const target of [l.markets[mkt], l.stocks[sym]]) {
        target.trades++;
        if (closedTrade.pnlPct > 0) target.wins++;
        target.totalReturn = parseFloat((target.totalReturn + closedTrade.pnlPct).toFixed(2));
        target.avgReturn   = parseFloat((target.totalReturn / target.trades).toFixed(2));
        target.winRate     = parseFloat((target.wins / target.trades * 100).toFixed(1));
    }

    l.lastUpdated = new Date().toISOString();
    saveLearnings(l);
    return l;
}

// Best performing markets/stocks based on learnings
function getMarketBias(learnings) {
    const bias = {};
    for (const [mkt, s] of Object.entries(learnings.markets || {})) {
        if (s.trades >= 5) {
            // Markets with ≥60% win rate → small score boost
            bias[mkt] = s.winRate >= 60 ? 1 : s.winRate <= 35 ? -1 : 0;
        }
    }
    return bias;
}

// ── Report-context-aware thresholds ──────────────────────────────────────────

function getThresholds(market) {
    const report = reportContext.getLatest();
    const base   = { ...BASE_THRESHOLDS[market] || BASE_THRESHOLDS.au };

    // High VIX → tighten stops (don't let winners turn into losers)
    if (report.vixView === 'high') {
        base.tp    = Math.max(5, base.tp - 2);
        base.sl    = Math.min(-3, base.sl + 2);
        base.trail = Math.max(2, base.trail - 1);
    } else if (report.vixView === 'elevated') {
        base.sl    = Math.min(-4, base.sl + 1);
    } else if (report.vixView === 'low') {
        // Low vol → let winners run a bit further
        base.tp    += 2;
        base.trail += 1;
    }

    return base;
}

function getMinChange(report) {
    if (report.sentiment === 'bearish') return 2.5;  // raise bar in bad markets
    if (report.sentiment === 'bullish') return 1.2;  // relax bar in good markets
    return MIN_CHANGE_BUY;
}

// ── Signal scoring ────────────────────────────────────────────────────────────

function scoreStock(stock, marketNewsScore, reportBias, marketLearnBias) {
    let score = 0;
    const ch = stock.change || 0;

    if      (ch >= 4)   score += 5;
    else if (ch >= 3)   score += 4;
    else if (ch >= 2)   score += 3;
    else if (ch >= 1.5) score += 2;
    else if (ch >= 1)   score += 1;
    if      (ch <= -2)  score -= 3;
    else if (ch <= -1)  score -= 1;

    if      (marketNewsScore > 2)  score += 2;
    else if (marketNewsScore > 0)  score += 1;
    else if (marketNewsScore < -2) score -= 2;
    else if (marketNewsScore < 0)  score -= 1;

    // Global sentiment bias from pre-market report
    score += reportBias;

    // Per-market learning bias (are we good at trading this market?)
    score += (marketLearnBias || 0);

    return score;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan(asianData) {
    if (!asianData) return null;

    const state     = loadState();
    const learnings = loadLearnings();
    const report    = reportContext.getLatest();
    const trades    = [];
    const log       = [];

    // Report-driven adjustments
    const reportBias = report.sentiment === 'bullish' ? 1 : report.sentiment === 'bearish' ? -1 : 0;
    const minChange  = getMinChange(report);
    const mktBias    = getMarketBias(learnings);

    if (report.sourceType) {
        log.push(`Report bias: ${report.sentiment} (${report.sourceType}) | VIX: ${report.vixView} | minChange: ${minChange}%`);
    }

    // Build price map
    const priceMap = {};
    for (const mkt of ['au', 'jp', 'cn', 'uk']) {
        const data = asianData[mkt];
        if (!data?.stocks) continue;
        for (const s of data.stocks) {
            if (s.price) priceMap[s.symbol] = { price: s.price, change: s.change, market: mkt, name: s.name };
        }
    }

    // ── Online learning from current open positions ──────────────────────────
    // Feed unrealised P&L back into weights every scan — don't wait for close
    const openForLearning = Object.entries(state.positions).map(([sym, pos]) => {
        const cur    = priceMap[sym]?.price || pos.lastPrice || pos.entryPrice;
        const pnlPct = ((cur - pos.entryPrice) / pos.entryPrice) * 100;
        return { symbol: sym, currentPnlPct: pnlPct, signals: pos.signals || {} };
    }).filter(p => p.signals && Object.keys(p.signals).length > 0);
    if (openForLearning.length > 0) tradeJournal.learnFromOpenTrades(openForLearning);

    // ── Exit check ───────────────────────────────────────────────────────────
    for (const [sym, pos] of Object.entries(state.positions)) {
        const snap = priceMap[sym];
        const currentPrice = snap?.price || pos.lastPrice || pos.entryPrice;
        pos.lastPrice = currentPrice;

        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const T = getThresholds(pos.market);

        if (!pos.highWatermark || currentPrice > pos.highWatermark) pos.highWatermark = currentPrice;

        let shouldExit = false, reason = '';

        const ageHours = (Date.now() - new Date(pos.entryDate).getTime()) / 3600000;

        // HOLD MODE (2026-09-18). The old take-profit (+20-28%) and 14-day dead-money exits
        // were CLIPPING WINNERS: real trades showed avg win +$1 vs avg loss -$11, and a
        // 90-day buy&hold of the same names made +10.6% while this stream lost money. So we
        // now LET WINNERS RUN — the only sells are the protective stop-loss and the
        // Chandelier trailing (which exits only on a real reversal from the peak). No more
        // capping gains at +20% or dumping flat positions that could become the next +64%.
        if (pnlPct <= T.sl)  { shouldExit = true; reason = `stop-loss ${T.sl}%`; }
        else if (pos.highWatermark > 0 && pnlPct >= 1) {
            // Chandelier trailing exit: price < peak − 3×ATR (volatility-adaptive — rides
            // calm trends, tightens at volatile tops). Falls back to the fixed % trail if
            // the ATR fetch fails, so a data hiccup can never leave a position unmanaged.
            const atr = await fetchDailyATR(sym);
            const fromPeak = ((currentPrice - pos.highWatermark) / pos.highWatermark) * 100;
            if (atr) {
                const chandStop = pos.highWatermark - CHANDELIER_MULT * atr;
                if (currentPrice < chandStop) { shouldExit = true; reason = `chandelier (price < peak−3×ATR, ${fromPeak.toFixed(1)}% off peak)`; }
            } else if (fromPeak <= -T.trail) {
                shouldExit = true; reason = `trailing stop (${fromPeak.toFixed(1)}% from peak, ATR unavailable)`;
            }
        }
        // (take-profit + dead-money exits removed — they were the winner-clippers)

        if (shouldExit) {
            // Real-world cost: IBKR-style commission + FX + slippage on both legs (fees.js)
            const fee = fees.roundTrip('asia-paper', pos.qty * pos.entryPrice, pos.qty * currentPrice);
            const pnlDollar = pos.qty * (currentPrice - pos.entryPrice) - fee;
            state.balance += pos.qty * currentPrice - fee;

            const closedRecord = {
                symbol: sym, name: pos.name, market: pos.market,
                entryPrice: pos.entryPrice, exitPrice: currentPrice,
                qty: pos.qty, entryDate: pos.entryDate,
                exitDate: new Date().toISOString(),
                pnlPct:    parseFloat(pnlPct.toFixed(2)),
                pnlDollar: parseFloat(pnlDollar.toFixed(2)),
                fees:      parseFloat(fee.toFixed(2)),
                reason,
            };
            state.closedTrades.push(closedRecord);

            if (pnlDollar > 0) state.stats.wins++; else state.stats.losses++;
            state.stats.totalPnl = parseFloat((state.stats.totalPnl + pnlDollar).toFixed(2));
            state.stats.trades++;

            // ── Learning: update per-market and per-stock win rates ──────────
            updateLearnings(closedRecord);

            // ── Journal: record exit in central trade ledger ─────────────────
            tradeJournal.recordExit(sym, currentPrice, `asia-paper ${reason}`);

            log.push(`CLOSE ${sym} (${pos.name}) ${reason}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ($${pnlDollar.toFixed(2)}) [${pos.market.toUpperCase()}]`);
            trades.push({ symbol: sym, name: pos.name, side: 'sell', price: currentPrice, pnlPct, reason, market: pos.market });
            delete state.positions[sym];
        }
    }

    // ── Entry scan ───────────────────────────────────────────────────────────
    const posCount = Object.keys(state.positions).length;
    let buyCount   = 0;

    const candidates = [];
    for (const mkt of ['au', 'jp', 'cn', 'uk']) {
        const data = asianData[mkt];
        if (!data?.stocks) continue;
        const newsScore = data.newsScore || 0;
        for (const s of data.stocks) {
            if (!s.price || s.price <= 0) continue;
            if (state.positions[s.symbol]) continue;
            if ((s.change || 0) < minChange) continue;
            const score = scoreStock(s, newsScore, reportBias, mktBias[mkt] || 0);
            if (score < MIN_SCORE) continue;
            candidates.push({ ...s, market: mkt, newsScore, score });
        }
    }

    candidates.sort((a, b) => b.score - a.score);

    // Circuit breaker — tuner pauses this stream when WR collapses (exits still run above)
    let asiaPaused = false;
    try { asiaPaused = !!require('./adaptiveTuner').getCalib().paused?.asia; } catch {}
    if (asiaPaused && candidates.length) {
        console.log(`[Asian Paper] ${candidates.length} candidate(s) skipped — circuit breaker: stream paused (low win rate)`);
        candidates.length = 0;
    }

    for (const c of candidates) {
        if (buyCount >= MAX_BUY_PER_SCAN) break;
        if (posCount + buyCount >= MAX_POSITIONS) break;

        const notional = state.balance * POSITION_SIZE_PCT;
        if (notional < 5 || state.balance < notional) continue;

        const qty = notional / c.price;
        const entrySignals = { dayChange: c.change, newsScore: c.newsScore, reportBias, mktBias: mktBias[c.market] || 0 };
        state.positions[c.symbol] = {
            qty, entryPrice: c.price, lastPrice: c.price,
            highWatermark: c.price, entryDate: new Date().toISOString(),
            market: c.market, name: c.name, score: c.score, entryChange: c.change,
            signals: entrySignals,
        };
        state.balance -= notional;

        // ── Journal: record entry in central trade ledger ────────────────────
        tradeJournal.recordEntry({
            symbol:     c.symbol,
            side:       'buy',
            qty,
            price:      c.price,
            strategy:   'asia-paper',
            tier:       'MEDIUM',
            score:      c.score,
            signals:    entrySignals,
            reason:     `[${c.market.toUpperCase()}] ${c.name} +${c.change.toFixed(1)}% score=${c.score}`,
        });

        log.push(`BUY ${c.symbol} (${c.name}) score=${c.score} +${c.change.toFixed(1)}% @ ${c.price.toFixed(2)} — $${notional.toFixed(0)} [${c.market.toUpperCase()}]`);
        trades.push({ symbol: c.symbol, name: c.name, side: 'buy', price: c.price, score: c.score, change: c.change, notional, market: c.market });
        buyCount++;
    }

    // ── Stats ────────────────────────────────────────────────────────────────
    let positionsValue = 0;
    for (const [sym, pos] of Object.entries(state.positions)) {
        const cur = priceMap[sym]?.price || pos.lastPrice || pos.entryPrice;
        positionsValue += pos.qty * cur;
    }

    const closed = state.closedTrades;
    state.stats.winRate        = closed.length > 0 ? parseFloat((state.stats.wins / closed.length * 100).toFixed(1)) : 0;
    state.stats.avgReturn      = closed.length > 0 ? parseFloat((closed.reduce((s, t) => s + t.pnlPct, 0) / closed.length).toFixed(2)) : 0;
    state.stats.portfolioValue = parseFloat((state.balance + positionsValue).toFixed(2));
    state.stats.totalReturn    = parseFloat(((state.stats.portfolioValue / state.startingBalance - 1) * 100).toFixed(2));

    if (state.closedTrades.length > 300) state.closedTrades = state.closedTrades.slice(-300);

    state.lastScan = new Date().toISOString();
    saveState(state);

    if (log.length) log.forEach(l => console.log(`[Asia Paper] ${l}`));
    const flag  = { au: '🇦🇺', jp: '🇯🇵', cn: '🇨🇳', uk: '🇬🇧' };
    const posStr = Object.entries(state.positions).map(([s, p]) => `${flag[p.market] || ''}${s}`).join(' ');
    console.log(`[Asia Paper] ${Object.keys(state.positions).length} pos | cash $${state.balance.toFixed(0)} | portfolio $${state.stats.portfolioValue} | ${state.stats.totalReturn >= 0 ? '+' : ''}${state.stats.totalReturn}%${posStr ? ' — ' + posStr : ''}`);

    const scanResult = {
        trades, stats: state.stats,
        positions: Object.entries(state.positions).map(([sym, pos]) => {
            const cur    = priceMap[sym]?.price || pos.lastPrice || pos.entryPrice;
            const pnlPct = ((cur - pos.entryPrice) / pos.entryPrice) * 100;
            return {
                symbol: sym, name: pos.name, market: pos.market,
                entryPrice: pos.entryPrice, currentPrice: cur,
                pnlPct: parseFloat(pnlPct.toFixed(2)),
                pnlDollar: parseFloat((pos.qty * (cur - pos.entryPrice)).toFixed(2)),
                entryDate: pos.entryDate, score: pos.score, entryChange: pos.entryChange,
            };
        }),
        closedRecent: closed.slice(-10),
        balance: state.balance,
        learnings,
        log,
    };

    // ── Post-exit follow-up checks (uses priceMap already built this scan) ───
    {
        const asianPriceMap    = {};
        const asianSnapshotMap = {};
        for (const [sym, snap] of Object.entries(priceMap)) {
            if (snap?.price > 0) {
                asianPriceMap[sym] = snap.price;
                asianSnapshotMap[sym] = {
                    newsScore:     snap.newsScore ?? null,
                    priceMomentum: snap.dayChange ?? null,
                };
            }
        }
        postExitTracker.processDue(asianPriceMap, ['asia-paper'], asianSnapshotMap);
    }

    return scanResult;
}

// ── Intel for research report ─────────────────────────────────────────────────
// Called by research.js to embed international market performance in the report

function getIntel(asianData) {
    const state     = loadState();
    const learnings = loadLearnings();

    // Market-level summary from asian scan
    const mktSummary = {};
    const flags = { au: '🇦🇺', jp: '🇯🇵', cn: '🇨🇳', uk: '🇬🇧' };
    const names  = { au: 'ASX', jp: 'Nikkei', cn: 'HSI', uk: 'FTSE' };

    for (const mkt of ['au', 'jp', 'cn', 'uk']) {
        const data = asianData?.[mkt];
        if (!data) continue;
        const bullish = (data.stocks || []).filter(s => s.signal === 'BULLISH').length;
        const bearish = (data.stocks || []).filter(s => s.signal === 'BEARISH').length;
        const learn   = learnings.markets[mkt];
        mktSummary[mkt] = {
            flag:      flags[mkt],
            name:      names[mkt],
            change:    data.index?.change ?? null,
            newsScore: data.newsScore || 0,
            bullish, bearish,
            signal:    data.index?.change > 0.5 ? 'BULLISH' : data.index?.change < -0.5 ? 'BEARISH' : 'NEUTRAL',
            learnWinRate: learn?.winRate ?? null,
            learnTrades:  learn?.trades  ?? 0,
            learnAvgReturn: learn?.avgReturn ?? null,
        };
    }

    // Top open positions
    const openPositions = Object.entries(state.positions || {}).map(([sym, pos]) => ({
        symbol: sym, name: pos.name, market: pos.market,
        pnlPct: pos.entryPrice > 0 ? parseFloat(((pos.lastPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1)) : 0,
    }));

    // Best-performing stocks learned
    const topStocks = Object.entries(learnings.stocks || {})
        .filter(([, s]) => s.trades >= 3)
        .sort((a, b) => b[1].winRate - a[1].winRate)
        .slice(0, 5)
        .map(([sym, s]) => ({ symbol: sym, name: s.name, market: s.market, winRate: s.winRate, avgReturn: s.avgReturn, trades: s.trades }));

    return {
        mktSummary,
        portfolio: state.stats,
        openPositions,
        topStocks,
        learnings,
    };
}

// ── State for dashboard ───────────────────────────────────────────────────────

function getState() {
    const state = loadState();
    const enriched = {};
    for (const [sym, pos] of Object.entries(state.positions || {})) {
        const cur    = pos.lastPrice || pos.entryPrice || 0;
        const pnlPct = pos.entryPrice > 0 ? ((cur - pos.entryPrice) / pos.entryPrice) * 100 : 0;
        enriched[sym] = {
            ...pos, currentPrice: cur,
            pnlPct: parseFloat(pnlPct.toFixed(2)),
            // was missing entirely — the UI's P&L $ column showed $0.00 for every position
            pnlDollar: parseFloat((pos.qty * (cur - pos.entryPrice)).toFixed(2)),
        };
    }
    return {
        balance: state.balance, startingBalance: state.startingBalance,
        positions: enriched, stats: state.stats,
        closedRecent: (state.closedTrades || []).slice(-10),
        lastScan: state.lastScan,
        learnings: loadLearnings(),
    };
}

function resetPaper(startingBalance = STARTING_BALANCE) {
    const fresh = {
        balance: startingBalance, startingBalance,
        positions: {}, closedTrades: [],
        stats: { wins: 0, losses: 0, totalPnl: 0, trades: 0,
                 winRate: 0, avgReturn: 0, portfolioValue: startingBalance, totalReturn: 0 },
        lastScan: null,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2));
    console.log(`[Asia Paper] Account reset — starting balance $${startingBalance}`);
    return { success: true, startingBalance, message: `Asia paper account reset to $${startingBalance}` };
}

module.exports = { scan, getState, getIntel, resetPaper };
