// paperBroker.js — Self-contained paper-trading engine. Every stream keeps its own
// cash + positions ledger here instead of routing orders to a real broker, so the
// P&L reflects OUR fills and OUR fee model (fees.js) rather than Alpaca's paper quirks.
//
// When you're ready for real money, swap the buy()/sell() internals for exchange calls.
// Nothing else in the codebase needs to change — this is the seam.
//
// CASH ACCOUNTING (exact, fee-consistent):
//   buy:  cash -= (qty*price + buyFee)      position.feesPaid += buyFee
//   sell: cash += (qty*price - sellFee)
//   netPnl = gross - sellFee - (share of buyFee for the qty sold)
// A full round-trip therefore moves cash by exactly netPnl. Verified in paperBroker.test.js.
'use strict';

const fs   = require('fs');
const path = require('path');
const fees = require('./fees');

const DATA_DIR = require('./dataDir');
const file = stream => path.join(DATA_DIR, `paper-${stream}.json`);

// Every stream starts with the SAME capital so their returns are directly comparable
// head-to-head. Don't re-scale one without re-scaling all, or the leaderboard lies.
const START = 10000;
const STARTING_CASH = {
    stocks: START,
    crypto: START,
    risky:  START,
};

const norm = s => String(s || '').replace(/[\/\s]/g, '').toUpperCase();
const r2   = n => Math.round(n * 100) / 100;

function blank(stream) {
    const cash = STARTING_CASH[stream] ?? 10000;
    return {
        stream,
        cash,
        startingCash: cash,
        positions: {},        // normSymbol -> { symbol, qty, avgPrice, feesPaid, highWater }
        closed: [],
        totalFees: 0,
        createdAt: new Date().toISOString(),
    };
}

function load(stream) {
    try {
        const s = JSON.parse(fs.readFileSync(file(stream), 'utf8'));
        // tolerate older/partial files
        s.positions = s.positions || {};
        s.closed    = s.closed || [];
        s.totalFees = s.totalFees || 0;
        return s;
    } catch { return blank(stream); }
}

function save(state) {
    try { fs.writeFileSync(file(state.stream), JSON.stringify(state, null, 2)); }
    catch (e) { console.log(`[PaperBroker] save failed (${state.stream}): ${e.message}`); }
}

// ── Orders ───────────────────────────────────────────────────────────────────

// Buy by notional ($) or explicit qty. Returns {success, qty, price, fee, error}.
function buy(stream, symbol, { notional, qty, price }) {
    if (!(price > 0)) return { success: false, error: 'no price' };
    const state = load(stream);

    let q = qty != null ? qty : (notional != null ? notional / price : 0);
    if (!(q > 0)) return { success: false, error: 'qty must be > 0' };

    const cost = q * price;
    const fee  = fees.estimate(stream, { notional: cost });

    if (cost + fee > state.cash) {
        // Scale down to what cash allows rather than failing silently on rounding.
        const affordable = state.cash - fee;
        if (!(affordable > 0)) return { success: false, error: `insufficient cash ($${r2(state.cash)})` };
        q = affordable / price;
    }
    const finalCost = q * price;
    const finalFee  = fees.estimate(stream, { notional: finalCost });
    if (finalCost + finalFee > state.cash + 1e-9) return { success: false, error: 'insufficient cash' };

    const key = norm(symbol);
    const p = state.positions[key] || { symbol, qty: 0, avgPrice: 0, feesPaid: 0, highWater: price };
    const newQty = p.qty + q;
    // avgPrice stays the MARKET average; fees tracked separately so entry price is honest
    p.avgPrice  = (p.qty * p.avgPrice + finalCost) / newQty;
    p.qty       = newQty;
    p.feesPaid += finalFee;
    p.highWater = Math.max(p.highWater || 0, price);
    p.symbol    = symbol;
    state.positions[key] = p;

    state.cash      -= (finalCost + finalFee);
    state.totalFees += finalFee;
    save(state);
    return { success: true, qty: q, price, fee: finalFee, notional: finalCost };
}

// Sell qty, or the whole position when qty is omitted / 'all'.
function sell(stream, symbol, { qty, price, reason } = {}) {
    if (!(price > 0)) return { success: false, error: 'no price' };
    const state = load(stream);
    const key = norm(symbol);
    const p = state.positions[key];
    if (!p || !(p.qty > 0)) return { success: false, error: 'no position' };

    const q = (qty == null || qty === 'all') ? p.qty : Math.min(qty, p.qty);
    if (!(q > 0)) return { success: false, error: 'qty must be > 0' };

    const proceeds = q * price;
    const sellFee  = fees.estimate(stream, { notional: proceeds });

    const gross       = (price - p.avgPrice) * q;
    const buyFeeShare = p.feesPaid * (q / p.qty);
    const netPnl      = gross - sellFee - buyFeeShare;

    state.cash      += (proceeds - sellFee);
    state.totalFees += sellFee;

    const record = {
        symbol: p.symbol, qty: q,
        entryPrice: r2(p.avgPrice), exitPrice: r2(price),
        grossPnl: r2(gross),
        fees: r2(sellFee + buyFeeShare),
        pnl: r2(netPnl),
        pnlPct: r2((price / p.avgPrice - 1) * 100),
        reason: reason || 'sell',
        exitTime: new Date().toISOString(),
    };
    state.closed.push(record);
    if (state.closed.length > 500) state.closed = state.closed.slice(-500);

    p.qty      -= q;
    p.feesPaid -= buyFeeShare;
    if (p.qty <= 1e-9) delete state.positions[key];
    else state.positions[key] = p;

    save(state);
    return { success: true, qty: q, price, fee: sellFee, pnl: r2(netPnl), record };
}

// ── Reads ────────────────────────────────────────────────────────────────────

// Persist the latest marks so /data endpoints report true portfolio value between
// scans. Without this, positions fall back to cost basis and unrealized P&L reads 0.
function markToMarket(stream, priceMap = {}) {
    const state = load(stream);
    let touched = 0;
    for (const [k, v] of Object.entries(priceMap)) {
        const p = state.positions[norm(k)];
        if (p && v > 0) { p.lastPrice = v; if (v > (p.highWater || 0)) p.highWater = v; touched++; }
    }
    if (touched) save(state);
    return touched;
}

// priceMap: { SYMBOL: currentPrice } — accepts raw or normalized symbols.
function getPositions(stream, priceMap = {}) {
    const state = load(stream);
    const px = {};
    for (const [k, v] of Object.entries(priceMap)) if (v > 0) px[norm(k)] = v;

    return Object.entries(state.positions).map(([key, p]) => {
        const cur = px[key] || p.lastPrice || p.avgPrice;
        const marketValue = p.qty * cur;
        const costBasis   = p.qty * p.avgPrice;
        return {
            symbol: p.symbol,
            qty: p.qty,
            avgEntryPrice: r2(p.avgPrice),
            currentPrice: r2(cur),
            marketValue: r2(marketValue),
            costBasis: r2(costBasis),
            unrealizedPl: r2(marketValue - costBasis),
            unrealizedPlpc: costBasis > 0 ? r2((marketValue / costBasis - 1) * 100) : 0,
            highWater: p.highWater,
            feesPaid: r2(p.feesPaid),
        };
    });
}

function getAccount(stream, priceMap = {}) {
    const state = load(stream);
    const positions = getPositions(stream, priceMap);
    const positionsValue = positions.reduce((s, p) => s + p.marketValue, 0);
    const portfolioValue = state.cash + positionsValue;
    const realizedPnl = state.closed.reduce((s, t) => s + (t.pnl || 0), 0);
    return {
        stream,
        cash: r2(state.cash),
        startingCash: state.startingCash,
        positionsValue: r2(positionsValue),
        portfolioValue: r2(portfolioValue),
        totalReturn: r2((portfolioValue / state.startingCash - 1) * 100),
        realizedPnl: r2(realizedPnl),
        totalFees: r2(state.totalFees),
        openPositions: positions.length,
        closedTrades: state.closed.length,
    };
}

// High-water mark, used by the Chandelier / trailing exits.
function updateHighWater(stream, symbol, price) {
    const state = load(stream);
    const p = state.positions[norm(symbol)];
    if (!p) return null;
    if (!(p.highWater > 0) || price > p.highWater) { p.highWater = price; save(state); }
    return p.highWater;
}

function getState(stream) { return load(stream); }

function reset(stream, startingCash) {
    const s = blank(stream);
    if (startingCash != null) { s.cash = startingCash; s.startingCash = startingCash; }
    save(s);
    console.log(`[PaperBroker] ${stream} reset to $${s.startingCash}`);
    return s;
}

module.exports = {
    buy, sell, getPositions, getAccount, updateHighWater, markToMarket, getState, reset,
    STARTING_CASH, norm,
};
