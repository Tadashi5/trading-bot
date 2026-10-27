// fees.js — Realistic real-world trading-cost model, applied to paper P&L so the
// numbers reflect what you'd actually net after commissions, spreads and slippage.
//
// One place to tune every cost assumption. Rates are PER SIDE (charged on both the
// buy and the sell). Edit SCHEDULE to match your real brokers. Defaults reflect
// 2026 retail reality for the brokers discussed (Alpaca US, IBKR global, a CHESS
// broker for the ASX ETF core, MEXC for the pump experiment).
'use strict';

const SCHEDULE = {
    // Alpaca charges $0 commission on US stocks; real cost is regulatory fees +
    // slippage on the fill (a few basis points on liquid large-caps).
    us_stock:    { pct: 0.0003, slippagePct: 0.0002, flat: 0, perContract: 0, min: 0 },

    // Alpaca crypto ~0.15% fee tier + spread markup. This one actually bites.
    us_crypto:   { pct: 0.0015, slippagePct: 0.0005, flat: 0, perContract: 0, min: 0 },

    // Alpaca options: $0 commission, but OCC + exchange + regulatory ≈ $0.04/contract.
    options:     { pct: 0, slippagePct: 0, flat: 0, perContract: 0.04, min: 0 },

    // IBKR global equities ≈ 8 bps + FX conversion + slippage on thinner names.
    asia_stock:  { pct: 0.0008, slippagePct: 0.0010, flat: 0, perContract: 0, min: 0 },

    // ASX ETF core. A weekly DCA split 4 ways = 4 trades/wk, so flat brokerage bites
    // hard — real debt-recyclers use low-cost AUTO-INVEST (Pearler ~free/$1.50, Vanguard
    // Personal Investor $0 on own funds). Modeled at $2/trade. Raise to ~$9.50 if you'd
    // use a full-service CHESS broker like Selfwealth/CommSec instead.
    etf_asx:     { pct: 0, slippagePct: 0.0005, flat: 2.00, perContract: 0, min: 0 },

    // MEXC spot ~0.1% taker + spread.
    mexc_crypto: { pct: 0.0010, slippagePct: 0.0010, flat: 0, perContract: 0, min: 0 },

    // Pump micro-caps: fee is small, but SLIPPAGE is brutal (~1.5%/side) on illiquid
    // low-caps — this is the honest cost that usually kills a pump edge.
    pump:        { pct: 0.0010, slippagePct: 0.0150, flat: 0, perContract: 0, min: 0 },
};

// Map a stream's strategy tag → cost class.
const STRATEGY_CLASS = {
    stocks: 'us_stock', politico: 'us_stock', risky: 'us_stock', 'ml-pipeline': 'us_stock',
    crypto: 'us_crypto', 'mexc-bridge': 'mexc_crypto', 'asia-paper': 'asia_stock',
    options: 'options', pumplab: 'pump', boring: 'etf_asx',
};

function classFor(key) {
    return SCHEDULE[key] ? key : (STRATEGY_CLASS[key] || 'us_stock');
}

// One-side cost for a fill. { notional } for %-based, { contracts } for options.
function estimate(strategyOrClass, { notional = 0, contracts = 0 } = {}) {
    const c = SCHEDULE[classFor(strategyOrClass)];
    if (!c) return 0;
    let fee = 0;
    if (c.flat)        fee += c.flat;
    if (c.perContract) fee += c.perContract * contracts;
    if (c.pct)         fee += notional * c.pct;
    if (c.slippagePct) fee += notional * c.slippagePct;
    if (c.min)         fee = Math.max(fee, c.min);
    return Math.round(fee * 10000) / 10000;
}

// Convenience: round-trip (buy + sell) cost given entry & exit notionals.
function roundTrip(strategyOrClass, entryNotional, exitNotional, contracts = 0) {
    return estimate(strategyOrClass, { notional: entryNotional, contracts }) +
           estimate(strategyOrClass, { notional: exitNotional, contracts });
}

module.exports = { estimate, roundTrip, SCHEDULE, STRATEGY_CLASS, classFor };
