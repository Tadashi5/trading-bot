// optionsPaperTrader.js — ISOLATED $10k wheel-strategy paper trader.
//
// The real-account wheel can't run on $1k (a cash-secured put needs strike×100 —
// $20k+ for mega-caps). This is a quarantined $10k sandbox that simulates the
// full wheel with REAL Alpaca option data: real contracts, real premiums (the
// bid you'd actually collect). If a real quote isn't available for a contract it
// SKIPS rather than inventing a premium — so the viability test stays honest.
//
// Isolated: own $10k ledger, own P&L, never in the portfolio/KPI totals.
//
// Cycle:  sell cash-secured put → expire worthless (keep premium) OR get assigned
//         → hold shares, sell covered call → called away (profit) or keep premium.
require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const fees  = require('./fees');

const DATA_DIR   = require('./dataDir');
const STATE_FILE = path.join(DATA_DIR, 'options-paper.json');

const TRADE_BASE = process.env.ALPACA_BASE_URL;                 // paper trading API (contracts)
const DATA_API   = 'https://data.alpaca.markets/v1beta1';       // option market data (quotes)
const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};

const STARTING_BALANCE = 10000;  // equal-capital baseline — every stream starts at $10k
                                 // so cross-stream returns are directly comparable
const OTM_PCT          = 0.90;   // sell puts ~10% out of the money
const DTE_MIN          = 7;      // 7–21 days to expiry — quick enough to cycle, real enough to matter
const DTE_MAX          = 21;
const MAX_CONCURRENT   = 6;

// Cheap, liquid, optionable names — affordable CSPs at a $10k account size.
const UNIVERSE = ['NIO', 'SOFI', 'F', 'PLUG', 'VALE', 'RIG', 'XPEV', 'PLTR', 'BAC', 'AAL', 'CCL', 'NEM'];

// ── State ──────────────────────────────────────────────────────────────────────

function loadState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        // Migration: STARTING_BALANCE raised — top up the existing ledger by the
        // difference (the constant alone only applies to a fresh state file).
        if ((s.startingBalance || 0) < STARTING_BALANCE) {
            s.cash += STARTING_BALANCE - (s.startingBalance || 0);
            s.startingBalance = STARTING_BALANCE;
            fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
        }
        return s;
    }
    catch {
        const s = {
            cash: STARTING_BALANCE, startingBalance: STARTING_BALANCE,
            reserved: 0,                 // cash locked securing open puts
            openPuts: {},                // ticker -> { strike, expiry, premium, contracts, occ }
            openCalls: {},               // ticker -> { strike, expiry, premium, occ }
            stock: {},                   // ticker -> { shares, costBasis }
            closedTrades: [], premiumCollected: 0,
            createdAt: new Date().toISOString(), lastScan: null,
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
        return s;
    }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Market data ────────────────────────────────────────────────────────────────

async function underlyingPrice(ticker) {
    try {
        const res = await axios.get(`${DATA_API.replace('/v1beta1','/v2')}/stocks/${ticker}/snapshot`, { headers: HEADERS, timeout: 8000 });
        const s = res.data;
        return s?.latestTrade?.p || s?.dailyBar?.c || s?.prevDailyBar?.c || null;
    } catch { return null; }
}

async function findContract(symbol, type, targetStrike) {
    try {
        const now = new Date();
        const gte = new Date(now.getTime() + DTE_MIN * 86400000).toISOString().split('T')[0];
        const lte = new Date(now.getTime() + DTE_MAX * 86400000).toISOString().split('T')[0];
        const res = await axios.get(`${TRADE_BASE}/options/contracts`, {
            headers: HEADERS,
            params: { underlying_symbols: symbol, type, expiration_date_gte: gte,
                      expiration_date_lte: lte, status: 'active', limit: 100 },
            timeout: 8000,
        });
        const contracts = res.data.option_contracts || [];
        if (!contracts.length) return null;
        return contracts.reduce((best, c) =>
            Math.abs(parseFloat(c.strike_price) - targetStrike) <
            Math.abs(parseFloat(best.strike_price) - targetStrike) ? c : best);
    } catch { return null; }
}

// Real premium = current bid (what you'd collect selling the option). No bid → null (skip).
async function optionBid(occSymbol) {
    try {
        const res = await axios.get(`${DATA_API}/options/quotes/latest`, {
            headers: HEADERS, params: { symbols: occSymbol }, timeout: 8000,
        });
        const q = res.data?.quotes?.[occSymbol];
        const bid = q?.bp;            // bid price per share
        return (bid && bid > 0) ? bid : null;
    } catch { return null; }
}

// ── Wheel cycle ─────────────────────────────────────────────────────────────────

async function scan() {
    const state = loadState();
    const now = new Date();
    const log = [];

    // 1. RESOLVE EXPIRED PUTS
    for (const [ticker, put] of Object.entries({ ...state.openPuts })) {
        if (new Date(put.expiry) > now) continue;
        const px = await underlyingPrice(ticker);
        if (px == null) continue;
        state.reserved -= put.strike * 100 * put.contracts;
        if (px >= put.strike) {
            // expired worthless → keep premium (a win)
            state.closedTrades.push({ ticker, type: 'put-expired', strike: put.strike,
                premium: put.premium, pnl: put.premium, exit: now.toISOString() });
            log.push(`${ticker} put expired worthless — kept $${put.premium.toFixed(0)} premium ✓`);
        } else {
            // assigned → buy 100×contracts shares at strike.
            // Cost basis = strike, NOT strike-minus-premium: the premium was already
            // booked as pnl on this trade record, so subtracting it from basis
            // counted it AGAIN when the shares were later called away (stats
            // overstated every completed wheel cycle by the put premium).
            const shares = 100 * put.contracts;
            const cost = put.strike * shares;
            state.cash -= cost;
            const prev = state.stock[ticker] || { shares: 0, costBasis: 0 };
            const newShares = prev.shares + shares;
            state.stock[ticker] = {
                shares: newShares,
                costBasis: ((prev.shares * prev.costBasis) + cost) / newShares,
                lastPrice: px,
            };
            state.closedTrades.push({ ticker, type: 'put-assigned', strike: put.strike,
                premium: put.premium, pnl: put.premium, exit: now.toISOString() });
            log.push(`${ticker} assigned ${shares}sh @ $${put.strike} (kept $${put.premium.toFixed(0)} premium)`);
        }
        delete state.openPuts[ticker];
    }

    // 2. RESOLVE EXPIRED COVERED CALLS
    for (const [ticker, call] of Object.entries({ ...state.openCalls })) {
        if (new Date(call.expiry) > now) continue;
        const px = await underlyingPrice(ticker);
        if (px == null) continue;
        const holding = state.stock[ticker];
        if (holding) holding.lastPrice = px;
        if (px >= call.strike && holding) {
            // called away → sell shares at strike (stock-side commission/slippage on exit)
            const proceeds = call.strike * holding.shares;
            const sellFee = fees.estimate('us_stock', { notional: proceeds });
            const pnl = proceeds - holding.costBasis * holding.shares + call.premium - sellFee;
            state.cash += proceeds - sellFee; state.fees = round((state.fees || 0) + sellFee);
            state.closedTrades.push({ ticker, type: 'called-away', strike: call.strike,
                premium: call.premium, pnl, fees: round(sellFee), exit: now.toISOString() });
            log.push(`${ticker} called away @ $${call.strike} — P&L $${pnl.toFixed(0)} ✓`);
            delete state.stock[ticker];
        } else {
            state.closedTrades.push({ ticker, type: 'call-expired', strike: call.strike,
                premium: call.premium, pnl: call.premium, exit: now.toISOString() });
            log.push(`${ticker} covered call expired — kept $${call.premium.toFixed(0)} premium`);
        }
        delete state.openCalls[ticker];
    }

    // 3. SELL COVERED CALLS on assigned stock that has none
    for (const [ticker, holding] of Object.entries(state.stock)) {
        if (state.openCalls[ticker] || holding.shares < 100) continue;
        const px = await underlyingPrice(ticker);
        if (!px) continue;
        holding.lastPrice = px;   // keep valuation current (portfolio was valued at cost)
        const target = parseFloat((px * (2 - OTM_PCT)).toFixed(2)); // ~10% OTM call
        const c = await findContract(ticker, 'call', target);
        if (!c) continue;
        const bid = await optionBid(c.symbol);
        if (!bid) continue;
        const contracts = Math.floor(holding.shares / 100);
        const premium = bid * 100 * contracts;
        const ccFee = fees.estimate('options', { contracts });   // OCC/exchange/reg per contract
        state.cash += premium - ccFee; state.premiumCollected += premium; state.fees = round((state.fees || 0) + ccFee);
        state.openCalls[ticker] = { strike: parseFloat(c.strike_price), expiry: c.expiration_date,
            premium, occ: c.symbol };
        log.push(`Sold ${ticker} covered call $${c.strike_price} — collected $${premium.toFixed(0)} (fee $${ccFee.toFixed(2)})`);
    }

    // 4. SELL NEW CASH-SECURED PUTS
    for (const ticker of UNIVERSE) {
        const openCount = Object.keys(state.openPuts).length + Object.keys(state.openCalls).length;
        if (openCount >= MAX_CONCURRENT) break;
        if (state.openPuts[ticker] || state.stock[ticker]) continue;
        const px = await underlyingPrice(ticker);
        if (!px) continue;
        const target = parseFloat((px * OTM_PCT).toFixed(2));
        const c = await findContract(ticker, 'put', target);
        if (!c) continue;
        const strike = parseFloat(c.strike_price);
        const freeCash = state.cash - state.reserved;
        if (freeCash < strike * 100) continue;              // can't secure even 1 contract
        const bid = await optionBid(c.symbol);
        if (!bid) continue;                                  // no real premium → skip (stay honest)
        const premium = bid * 100;
        const putFee = fees.estimate('options', { contracts: 1 });
        state.cash += premium - putFee; state.premiumCollected += premium; state.fees = round((state.fees || 0) + putFee);
        state.reserved += strike * 100;
        state.openPuts[ticker] = { strike, expiry: c.expiration_date, premium, contracts: 1, occ: c.symbol };
        log.push(`Sold ${ticker} CSP $${strike} (${c.expiration_date}) — collected $${premium.toFixed(0)} (fee $${putFee.toFixed(2)})`);
    }

    state.lastScan = now.toISOString();
    saveState(state);
    if (log.length) log.forEach(l => console.log(`[Options Lab] ${l}`));
    return getState();
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function getState() {
    const state = loadState();
    const closed = state.closedTrades || [];
    const wins   = closed.filter(t => t.pnl > 0).length;
    const realizedPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    // Value held shares at last seen MARKET price, not cost basis — valuing at
    // cost hid every unrealized move on assigned shares (a crashed stock still
    // showed full value in the portfolio number).
    const stockValue = Object.values(state.stock).reduce((s, h) => s + h.shares * (h.lastPrice || h.costBasis), 0);
    const portfolioValue = state.cash + stockValue;

    return {
        isolated: true,
        cash: round(state.cash),
        reserved: round(state.reserved),
        startingBalance: state.startingBalance,
        portfolioValue: round(portfolioValue),
        totalReturn: round((portfolioValue / state.startingBalance - 1) * 100),
        premiumCollected: round(state.premiumCollected),
        totalFees: round(state.fees || 0),
        realizedPnl: round(realizedPnl),
        trades: closed.length,
        wins,
        winRate: closed.length ? round(wins / closed.length * 100) : 0,
        openPuts: state.openPuts,
        openCalls: state.openCalls,
        stock: state.stock,
        recentClosed: closed.slice(-15).reverse(),
        daysLive: state.createdAt ? Math.floor((Date.now() - new Date(state.createdAt).getTime()) / 86400000) : 0,
        lastScan: state.lastScan,
    };
}

function getPortfolioValue() { return getState().portfolioValue; }

function resetPaper(bal = STARTING_BALANCE) {
    try { fs.unlinkSync(STATE_FILE); } catch {}
    const s = loadState(); s.cash = bal; s.startingBalance = bal; saveState(s);
    return { success: true, balance: bal };
}

function round(v) { return v == null ? null : parseFloat(Number(v).toFixed(2)); }

module.exports = { scan, getState, getPortfolioValue, resetPaper, UNIVERSE };
