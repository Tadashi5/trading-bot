// mexcPaperTrader.js — Aggressive simulated paper trading for MEXC alt/meme/defi
// Hunts hot movers from the ENTIRE MEXC exchange, not just a fixed watchlist.
// Bridges overlapping coins to Alpaca for real paper trades.
require('dotenv').config();
const axios        = require('axios');
const fs           = require('fs');
const path         = require('path');
const mexc            = require('./services/mexc');
const tradeJournal    = require('./tradeJournal');
const reportContext   = require('./reportContext');
const postExitTracker = require('./postExitTracker');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;

const DATA_DIR   = require('./dataDir');
const STATE_FILE = path.join(DATA_DIR, 'mexc-paper.json');

// ── Alpaca-supported crypto (can be real paper-traded) ──────────────────────
const ALPACA_CRYPTO = new Set([
    'BTC/USD','ETH/USD','SOL/USD','XRP/USD','ADA/USD','AVAX/USD','LINK/USD',
    'LTC/USD','BCH/USD','DOT/USD','MATIC/USD','UNI/USD','AAVE/USD','MKR/USD',
    'GRT/USD','CRV/USD','SUSHI/USD','YFI/USD','XTZ/USD','BAT/USD',
    'DOGE/USD','SHIB/USD','PEPE/USD','BONK/USD','WIF/USD','FLOKI/USD',
    'NEAR/USD','ATOM/USD','APT/USD','SUI/USD','INJ/USD','FET/USD',
    'COMP/USD','SNX/USD','DYDX/USD','ENS/USD','1INCH/USD',
]);

function mexcToAlpaca(mexcSymbol) {
    const base = mexcSymbol.replace('USDT', '');
    const alpacaSym = `${base}/USD`;
    return ALPACA_CRYPTO.has(alpacaSym) ? alpacaSym : null;
}

// Stablecoins and wrapped tokens to skip
const SKIP_COINS = new Set(['USDT','USDC','BUSD','DAI','TUSD','FDUSD','WBTC','WETH','STETH','BTCB']);

// ── State management ────────────────────────────────────────────────────────

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch {
        const s = {
            balance: 1000,
            startingBalance: 1000,
            positions: {},
            closedTrades: [],
            stats: { wins: 0, losses: 0, totalPnl: 0, trades: 0 },
            alpacaBridged: {},
            lastScan: null,
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
        return s;
    }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Alpaca bridge ───────────────────────────────────────────────────────────

async function alpacaBuy(symbol, notional) {
    try {
        await axios.post(`${BASE}/orders`, {
            symbol, side: 'buy', type: 'market',
            time_in_force: 'gtc', notional: notional.toFixed(2),
        }, { headers: HEADERS });
        return { success: true, notional };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

async function alpacaSell(symbol, qty) {
    try {
        await axios.post(`${BASE}/orders`, {
            symbol, qty: String(qty), side: 'sell', type: 'market',
            time_in_force: 'gtc',
        }, { headers: HEADERS });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

// ── Fetch a single coin price directly from MEXC ────────────────────────────

async function fetchSinglePrice(sym) {
    try {
        const res = await axios.get(`https://api.mexc.com/api/v3/ticker/price?symbol=${sym}USDT`, { timeout: 6000 });
        return parseFloat(res.data.price) || 0;
    } catch { return 0; }
}

// ── Fetch ALL hot movers from MEXC ──────────────────────────────────────────
// This is the key difference — scan the entire exchange for pumping coins

async function fetchHotMovers() {
    try {
        const res = await axios.get('https://api.mexc.com/api/v3/ticker/24hr', { timeout: 15000 });
        return res.data
            .filter(t => {
                if (!t.symbol.endsWith('USDT')) return false;
                const base = t.symbol.replace('USDT', '');
                if (SKIP_COINS.has(base)) return false;
                const vol = parseFloat(t.quoteVolume);
                if (vol < 50000) return false; // min $50K volume — cast a wide net
                return true;
            })
            .map(t => ({
                symbol: t.symbol,
                displaySymbol: t.symbol.replace('USDT', ''),
                price: parseFloat(t.lastPrice),
                change: parseFloat(t.priceChangePercent),
                volume: parseFloat(t.quoteVolume),
                high: parseFloat(t.highPrice),
                low: parseFloat(t.lowPrice),
                category: 'hot-mover',
            }));
    } catch { return []; }
}

// ── Aggressive scoring for hot movers ───────────────────────────────────────
// Uses learned weights from tradeJournal so MEXC signal importance evolves over time.
// Keys are MEXC-specific so they track separately from US stocks weights.

function scoreCoin(coin) {
    const change = coin.change || 0;
    const vol    = coin.volume || 0;

    const nearHigh = (coin.high > 0 && coin.price > 0) ? (coin.price / coin.high) : 0.5;

    const signals = {
        // Momentum tiers — priceMomentum value maps to the original tier points
        mexcMomentum: change >= 50 ? 8 : change >= 30 ? 6 : change >= 20 ? 5
                    : change >= 10 ? 3 : change >= 5 ? 2 : change >= 2 ? 1
                    : change < -10 ? -3 : change < -5 ? -2 : 0,

        // Volume conviction
        mexcVolume: vol > 200_000_000 ? 3 : vol > 50_000_000 ? 2 : vol > 10_000_000 ? 1 : 0,

        // Near 24h high = momentum still intact
        mexcNearHigh: nearHigh > 0.95 ? 1 : nearHigh < 0.70 ? -2 : 0,
    };

    return tradeJournal.applyWeights(signals);
}

// ── Dynamic take-profit based on momentum ──────────────────────────────────

function getExitThresholds(entryMomentum) {
    // Bigger pumps get wider take-profit targets
    if (entryMomentum >= 50) return { tp: 40, sl: -12 };  // 50%+ pump → ride to +40%, wide stop
    if (entryMomentum >= 30) return { tp: 25, sl: -10 };  // 30%+ pump → +25% target
    if (entryMomentum >= 20) return { tp: 20, sl: -8 };   // 20%+ pump → +20% target
    if (entryMomentum >= 10) return { tp: 15, sl: -8 };   // 10%+ pump → +15% target
    return { tp: 10, sl: -6 };                              // smaller moves → tighter
}

// ── Size based on conviction (score) ────────────────────────────────────────

function getPositionSize(score, balance) {
    // Higher score = bigger bet. Sizes trimmed after the strategy ran -10.7%
    // at a 24% win rate — smaller bets cut the bleed while we tune entries.
    if (score >= 8) return balance * 0.12;  // max conviction: 12%
    if (score >= 6) return balance * 0.10;  // strong: 10%
    if (score >= 5) return balance * 0.07;  // solid: 7%
    return balance * 0.05;                   // base: 5%
}

// Minimum 24h momentum to even consider a buy. The whole premise is "hot movers"
// — without this gate, high-volume majors (XRP/SOL/ETH) score 3 on volume alone
// while flat or falling, then drift into the stop. Require a real pump.
// Raised from 5% to 15% to avoid chasing coins at peak momentum
const MIN_MOMENTUM_PCT = 15;

// ── Main scan ───────────────────────────────────────────────────────────────

async function scan(mexcData) {
    if (!mexcData) return { simTrades: [], bridgedTrades: [], stats: {} };

    const state = loadState();
    const simTrades = [];
    const bridgedTrades = [];
    const log = [];

    // Get Alpaca cash for bridge trades
    let alpacaCash = 0;
    try {
        const accRes = await axios.get(`${BASE}/account`, { headers: HEADERS });
        alpacaCash = parseFloat(accRes.data.cash);
    } catch {}

    // ── Fetch ALL hot movers from entire MEXC exchange ───────────────────
    let hotMovers = [];
    try {
        hotMovers = await fetchHotMovers();
    } catch (err) {
        console.log(`[MEXC Paper] Hot movers fetch error: ${err.message}`);
    }

    // Also include watchlist coins
    const watchlistCoins = [
        ...(mexcData.meme || []),
        ...(mexcData.alt || []),
        ...(mexcData.defi || []),
    ];

    // Build price map from all sources
    const priceMap = {};
    for (const coin of [...watchlistCoins, ...hotMovers]) {
        const sym = coin.displaySymbol || coin.symbol?.replace('USDT', '');
        if (sym) priceMap[sym] = coin.price;
    }

    // ── Check existing positions for exits ──────────────────────────────────
    for (const [sym, pos] of Object.entries(state.positions)) {
        let currentPrice = priceMap[sym];

        // If coin dropped out of the hot-mover price map (volume died), fetch it directly
        if (!currentPrice) {
            currentPrice = await fetchSinglePrice(sym);
        }

        // Still no price? Coin may be dead/delisted — close the position immediately
        if (!currentPrice || currentPrice <= 0) {
            console.log(`[MEXC Paper] ${sym} price unavailable — force-closing as dead coin`);
            const pnlDollar = pos.qty * (0 - pos.entryPrice);
            state.stats.losses++;
            state.stats.totalPnl = parseFloat((state.stats.totalPnl + pnlDollar).toFixed(2));
            state.stats.trades++;
            state.closedTrades.push({
                symbol: sym, category: pos.category,
                entryPrice: pos.entryPrice, exitPrice: 0,
                qty: pos.qty, entryDate: pos.entryDate,
                exitDate: new Date().toISOString(),
                pnlPct: -100,
                pnlDollar: parseFloat(pnlDollar.toFixed(2)),
                entryMomentum: pos.entryMomentum,
                reason: 'dead coin — no price data',
            });
            simTrades.push({ symbol: sym, side: 'sell', price: 0, pnlPct: -100, reason: 'dead coin' });
            delete state.positions[sym];
            continue;
        }

        // Save current price into state so dashboard always shows correct P&L
        pos.currentPrice = currentPrice;

        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const thresholds = getExitThresholds(pos.entryMomentum || 10);

        let shouldExit = false;
        let reason = '';

        // HARD FLOOR: liquidate any position down more than 12% immediately
        if (pnlPct <= -12) {
            shouldExit = true;
            reason = `hard-floor stop -12%`;
        }

        if (pnlPct >= thresholds.tp) {
            shouldExit = true;
            reason = `take-profit +${thresholds.tp}%`;
        } else if (pnlPct <= thresholds.sl) {
            shouldExit = true;
            reason = `stop-loss ${thresholds.sl}%`;
        } else if (pnlPct >= thresholds.tp * 0.7 && pnlPct < thresholds.tp) {
            // Near target — tighten stop to +3% (lock in some profit)
            if (pnlPct > 3 && ((currentPrice - pos.highWatermark) / pos.highWatermark * 100) < -5) {
                shouldExit = true;
                reason = `trailing stop (peaked then dropped 5%)`;
            }
        }

        // Update high watermark
        if (!pos.highWatermark || currentPrice > pos.highWatermark) {
            pos.highWatermark = currentPrice;
        }

        // ── Scale-in: average UP into winners ──────────────────────────────
        // +15% → add 50% more, +25% → add 50% more again (max 2 top-ups)
        if (!shouldExit) {
            const scaleIns = pos.scaleIns || 0;
            const origNotional = pos.entryPrice * (pos.origQty || pos.qty);
            const addSize = origNotional * 0.5; // 50% of original position

            if (scaleIns < 2 && state.balance > addSize && addSize >= 5) {
                const nextThreshold = scaleIns === 0 ? 15 : 25;
                if (pnlPct >= nextThreshold) {
                    const addQty = addSize / currentPrice;
                    // Recalc average entry
                    const totalCost = pos.entryPrice * pos.qty + currentPrice * addQty;
                    const totalQty = pos.qty + addQty;
                    if (!pos.origQty) pos.origQty = pos.qty; // preserve original qty for sizing
                    pos.qty = totalQty;
                    pos.entryPrice = totalCost / totalQty;
                    pos.scaleIns = scaleIns + 1;
                    state.balance -= addSize;

                    log.push(`SCALE-IN ${sym} +${nextThreshold}% → added $${addSize.toFixed(0)} (top-up ${scaleIns + 1}/2)`);
                    simTrades.push({ symbol: sym, side: 'scale-in', price: currentPrice, notional: addSize, topUp: scaleIns + 1 });
                }
            }
        }

        if (shouldExit) {
            const pnlDollar = pos.qty * (currentPrice - pos.entryPrice);

            state.balance += pos.qty * currentPrice;
            state.closedTrades.push({
                symbol: sym,
                category: pos.category,
                entryPrice: pos.entryPrice,
                exitPrice: currentPrice,
                qty: pos.qty,
                entryDate: pos.entryDate,
                exitDate: new Date().toISOString(),
                pnlPct: parseFloat(pnlPct.toFixed(2)),
                pnlDollar: parseFloat(pnlDollar.toFixed(2)),
                entryMomentum: pos.entryMomentum,
                reason,
            });

            if (pnlDollar > 0) state.stats.wins++;
            else state.stats.losses++;
            state.stats.totalPnl = parseFloat((state.stats.totalPnl + pnlDollar).toFixed(2));
            state.stats.trades++;

            log.push(`CLOSE ${sym} ${reason}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ($${pnlDollar.toFixed(2)})`);

            // Sell Alpaca bridge position too
            if (state.alpacaBridged[sym]) {
                const alpacaSym = mexcToAlpaca(sym + 'USDT');
                if (alpacaSym) {
                    const result = await alpacaSell(alpacaSym, state.alpacaBridged[sym].qty);
                    if (result.success) {
                        log.push(`ALPACA SELL ${alpacaSym} (bridged)`);
                        tradeJournal.recordExit(alpacaSym, currentPrice, `MEXC sim ${reason}`);
                    }
                    delete state.alpacaBridged[sym];
                }
            }

            simTrades.push({ symbol: sym, side: 'sell', price: currentPrice, pnlPct, reason });
            delete state.positions[sym];
        }
    }

    // ── Score ALL hot movers + watchlist coins, buy the best ─────────────
    const posCount = Object.keys(state.positions).length;
    const MAX_POSITIONS = 20;
    const MAX_BUY_PER_SCAN = 8;
    let buyCount = 0;

    // Merge hot movers with watchlist (dedupe by symbol)
    const seenSymbols = new Set();
    const allCandidates = [];

    // Hot movers first (these are the pumping coins from entire exchange)
    for (const coin of hotMovers) {
        const sym = coin.displaySymbol;
        if (seenSymbols.has(sym) || state.positions[sym]) continue;
        seenSymbols.add(sym);
        allCandidates.push(coin);
    }
    // Then watchlist
    for (const coin of watchlistCoins) {
        const sym = coin.displaySymbol;
        if (seenSymbols.has(sym) || state.positions[sym]) continue;
        seenSymbols.add(sym);
        allCandidates.push(coin);
    }

    // Score and sort — best opportunities first
    const scored = allCandidates
        .map(coin => {
            const change = coin.change || 0;
            const vol    = coin.volume || 0;
            const nearHigh = (coin.high > 0 && coin.price > 0) ? (coin.price / coin.high) : 0.5;
            const signals = {
                mexcMomentum: change >= 50 ? 8 : change >= 30 ? 6 : change >= 20 ? 5
                            : change >= 10 ? 3 : change >= 5 ? 2 : change >= 2 ? 1
                            : change < -10 ? -3 : change < -5 ? -2 : 0,
                mexcVolume:   vol > 200_000_000 ? 3 : vol > 50_000_000 ? 2 : vol > 10_000_000 ? 1 : 0,
                mexcNearHigh: nearHigh > 0.95 ? 1 : nearHigh < 0.70 ? -2 : 0,
            };
            return { ...coin, score: tradeJournal.applyWeights(signals), signals };
        })
        // Must have real upward momentum AND a solid score — not just high volume
        // Also skip coins too close to their 24h peak (avoid buying at peak)
        .filter(c => {
            const nearHigh = (c.high > 0 && c.price > 0) ? (c.price / c.high) : 0.5;
            return c.score >= 4 && (c.change || 0) >= MIN_MOMENTUM_PCT && nearHigh < 0.95;
        })
        .sort((a, b) => b.score - a.score);

    for (const coin of scored) {
        if (buyCount >= MAX_BUY_PER_SCAN) break;
        if (posCount + buyCount >= MAX_POSITIONS) break;

        const sym = coin.displaySymbol;
        if (!sym || !coin.price || coin.price <= 0) continue;

        // Size based on conviction
        const simNotional = getPositionSize(coin.score, state.balance);
        if (simNotional < 5) continue;

        const qty = simNotional / coin.price;
        state.positions[sym] = {
            qty,
            entryPrice: coin.price,
            entryDate: new Date().toISOString(),
            category: coin.category || 'unknown',
            score: coin.score,
            entryMomentum: coin.change,
            highWatermark: coin.price,
            signals: coin.signals || {},  // saved for online learning
        };
        state.balance -= simNotional;

        const pStr = coin.price < 0.001 ? coin.price.toFixed(8) : coin.price < 1 ? coin.price.toFixed(4) : coin.price.toFixed(2);
        log.push(`BUY ${sym} score=${coin.score} +${coin.change.toFixed(0)}% @ $${pStr} — $${simNotional.toFixed(0)} (${coin.category})`);
        simTrades.push({ symbol: sym, side: 'buy', price: coin.price, score: coin.score, change: coin.change, category: coin.category, notional: simNotional });
        buyCount++;

        // Bridge to Alpaca if supported
        const alpacaSym = mexcToAlpaca(sym + 'USDT');
        if (alpacaSym && alpacaCash > 50 && !state.alpacaBridged[sym]) {
            // Bridge size scales with score too
            const bridgeNotional = Math.min(alpacaCash * (coin.score >= 6 ? 0.05 : 0.03), 150);
            const result = await alpacaBuy(alpacaSym, bridgeNotional);
            if (result.success) {
                state.alpacaBridged[sym] = {
                    alpacaSymbol: alpacaSym,
                    notional: bridgeNotional,
                    qty: (bridgeNotional / coin.price).toFixed(6),
                    date: new Date().toISOString(),
                };
                alpacaCash -= bridgeNotional;

                tradeJournal.recordEntry({
                    symbol: alpacaSym, side: 'buy', qty: parseFloat((bridgeNotional / coin.price).toFixed(6)),
                    price: coin.price, strategy: 'mexc-bridge', tier: 'MEDIUM', score: coin.score,
                    signals: coin.signals || { mexcMomentum: 0, mexcVolume: 0, mexcNearHigh: 0 },
                    reason: `MEXC hot mover: ${sym} +${coin.change.toFixed(0)}% score ${coin.score.toFixed(2)}`,
                });

                bridgedTrades.push({ symbol: sym, alpacaSymbol: alpacaSym, notional: bridgeNotional, score: coin.score, change: coin.change });
                log.push(`ALPACA BRIDGE ${alpacaSym} $${bridgeNotional.toFixed(0)} (+${coin.change.toFixed(0)}%)`);
            }
        }
    }

    // Trim closed trades
    if (state.closedTrades.length > 200) state.closedTrades = state.closedTrades.slice(-200);

    // Update stats
    const closed = state.closedTrades;
    state.stats.winRate = closed.length > 0 ? parseFloat((state.stats.wins / closed.length * 100).toFixed(1)) : 0;
    state.stats.avgReturn = closed.length > 0
        ? parseFloat((closed.reduce((s, t) => s + t.pnlPct, 0) / closed.length).toFixed(2)) : 0;

    // Portfolio value
    let positionsValue = 0;
    for (const [sym, pos] of Object.entries(state.positions)) {
        const current = priceMap[sym] || pos.entryPrice;
        positionsValue += pos.qty * current;
    }
    state.stats.portfolioValue = parseFloat((state.balance + positionsValue).toFixed(2));
    state.stats.totalReturn = parseFloat(((state.stats.portfolioValue / state.startingBalance - 1) * 100).toFixed(2));

    // ── Post-exit follow-up checks ───────────────────────────────────────────
    {
        const mexcPriceMap    = {};
        const mexcSnapshotMap = {};
        for (const [sym, price] of Object.entries(priceMap)) {
            if (price && price > 0) mexcPriceMap[sym] = price;
        }
        // Build lightweight snapshots from scored candidate data
        for (const coin of scored) {
            const sym = coin.displaySymbol;
            if (!sym) continue;
            mexcSnapshotMap[sym] = {
                priceMomentum: coin.change ?? null,
                volume:        coin.volume != null
                    ? (coin.volume > 50_000_000 ? 'high' : coin.volume > 5_000_000 ? 'medium' : 'low')
                    : null,
            };
        }
        postExitTracker.processDue(mexcPriceMap, ['mexc-paper', 'mexc-bridge'], mexcSnapshotMap);
    }

    // Online learning from open MEXC paper positions (every scan, not just on close)
    const mexcOpenForLearning = Object.entries(state.positions).map(([sym, pos]) => {
        const cur = priceMap[sym] || pos.currentPrice || pos.entryPrice;
        const pnlPct = ((cur - pos.entryPrice) / pos.entryPrice) * 100;
        return { symbol: sym, currentPnlPct: pnlPct, signals: pos.signals || {} };
    }).filter(p => p.signals && Object.keys(p.signals).length > 0);
    if (mexcOpenForLearning.length > 0) tradeJournal.learnFromOpenTrades(mexcOpenForLearning);

    state.lastScan = new Date().toISOString();
    saveState(state);

    if (log.length) log.forEach(l => console.log(`[MEXC Paper] ${l}`));

    return {
        simTrades,
        bridgedTrades,
        stats: state.stats,
        positions: Object.entries(state.positions).map(([sym, pos]) => {
            const current = priceMap[sym] || pos.entryPrice;
            const pnlPct = ((current - pos.entryPrice) / pos.entryPrice) * 100;
            return {
                symbol: sym, category: pos.category,
                entryPrice: pos.entryPrice, currentPrice: current,
                pnlPct: parseFloat(pnlPct.toFixed(2)),
                pnlDollar: parseFloat((pos.qty * (current - pos.entryPrice)).toFixed(2)),
                entryDate: pos.entryDate,
                entryMomentum: pos.entryMomentum,
                score: pos.score,
            };
        }),
        closedRecent: closed.slice(-10),
        hotMoversScanned: scored.length,
        balance: state.balance,
        log,
    };
}

// ── Get current state for dashboard ─────────────────────────────────────────

function getState() {
    const state = loadState();
    // Enrich positions with pnlPct using stored currentPrice (saved each scan)
    const enriched = {};
    for (const [sym, pos] of Object.entries(state.positions || {})) {
        const cur = pos.currentPrice || pos.entryPrice || 0;
        const pnlPct = pos.entryPrice > 0 ? ((cur - pos.entryPrice) / pos.entryPrice) * 100 : 0;
        enriched[sym] = { ...pos, currentPrice: cur, pnlPct: parseFloat(pnlPct.toFixed(2)) };
    }
    return {
        balance: state.balance,
        startingBalance: state.startingBalance,
        positions: enriched,
        stats: state.stats,
        closedRecent: (state.closedTrades || []).slice(-10),
        alpacaBridged: state.alpacaBridged,
        lastScan: state.lastScan,
    };
}

// ── Manual buy/sell for dashboard ──────────────────────────────────────────

async function manualBuy(symbol, notional) {
    const state = loadState();
    const sym = symbol.toUpperCase().replace('USDT', '');
    if (notional > state.balance) return { success: false, error: `Insufficient balance ($${state.balance.toFixed(2)} available)` };
    if (notional < 1) return { success: false, error: 'Minimum $1' };

    // Fetch current price + 24h change for proper TP/SL
    let price, change = 0;
    try {
        const res = await axios.get(`https://api.mexc.com/api/v3/ticker/24hr?symbol=${sym}USDT`, { timeout: 5000 });
        price = parseFloat(res.data.lastPrice);
        change = parseFloat(res.data.priceChangePercent) || 0;
    } catch {
        return { success: false, error: `Could not fetch price for ${sym}` };
    }
    if (!price || price <= 0) return { success: false, error: `Invalid price for ${sym}` };

    const qty = notional / price;
    const score = scoreCoin({ change, volume: 0, high: price, low: price, price });

    if (state.positions[sym]) {
        // Average into existing position
        const pos = state.positions[sym];
        const totalCost = pos.entryPrice * pos.qty + price * qty;
        const totalQty = pos.qty + qty;
        pos.entryPrice = totalCost / totalQty;
        pos.qty = totalQty;
        pos.highWatermark = Math.max(pos.highWatermark || 0, price);
    } else {
        state.positions[sym] = {
            qty, entryPrice: price,
            entryDate: new Date().toISOString(),
            category: 'manual', score,
            entryMomentum: change, highWatermark: price,
        };
    }
    state.balance -= notional;
    saveState(state);
    console.log(`[MEXC Paper] MANUAL BUY ${sym} $${notional.toFixed(2)} @ $${price}`);
    return { success: true, symbol: sym, price, qty, notional, newBalance: state.balance };
}

async function manualSell(symbol, pctToSell = 100) {
    const state = loadState();
    const sym = symbol.toUpperCase().replace('USDT', '');
    const pos = state.positions[sym];
    if (!pos) return { success: false, error: `No position in ${sym}` };

    let price;
    try {
        const res = await axios.get(`https://api.mexc.com/api/v3/ticker/price?symbol=${sym}USDT`, { timeout: 5000 });
        price = parseFloat(res.data.price);
    } catch {
        return { success: false, error: `Could not fetch price for ${sym}` };
    }

    const sellQty = pos.qty * (Math.min(pctToSell, 100) / 100);
    const proceeds = sellQty * price;
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const pnlDollar = sellQty * (price - pos.entryPrice);

    state.balance += proceeds;

    if (pctToSell >= 100) {
        state.closedTrades.push({
            symbol: sym, category: pos.category,
            entryPrice: pos.entryPrice, exitPrice: price,
            qty: pos.qty, entryDate: pos.entryDate,
            exitDate: new Date().toISOString(),
            pnlPct: parseFloat(pnlPct.toFixed(2)),
            pnlDollar: parseFloat(pnlDollar.toFixed(2)),
            reason: 'manual sell',
        });
        if (pnlDollar > 0) state.stats.wins++; else state.stats.losses++;
        state.stats.totalPnl = parseFloat((state.stats.totalPnl + pnlDollar).toFixed(2));
        state.stats.trades++;
        delete state.positions[sym];
    } else {
        pos.qty -= sellQty;
    }

    saveState(state);
    console.log(`[MEXC Paper] MANUAL SELL ${sym} ${pctToSell}% @ $${price} → ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`);
    return { success: true, symbol: sym, price, soldQty: sellQty, proceeds, pnlPct, pnlDollar, newBalance: state.balance };
}

function resetPaper(startingBalance = 1000) {
    const fresh = {
        balance: startingBalance,
        startingBalance,
        positions: {},
        closedTrades: [],
        stats: { wins: 0, losses: 0, totalPnl: 0, trades: 0 },
        alpacaBridged: {},
        lastScan: null,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2));
    console.log(`[MEXC Paper] Account reset — starting balance $${startingBalance}`);
    return { success: true, startingBalance, message: `Paper account reset to $${startingBalance}` };
}

module.exports = { scan, getState, manualBuy, manualSell, resetPaper };
