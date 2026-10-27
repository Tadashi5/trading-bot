// paperBroker.test.js — Proves the ledger is internally consistent before any
// stream trusts it with P&L. Run: node paperBroker.test.js
//
// The invariant that matters: over a full round-trip, the change in CASH must equal
// the reported net P&L. If those ever diverge, every number on the dashboard is a lie.
'use strict';

const fs   = require('fs');
const path = require('path');
const broker = require('./paperBroker');
const fees   = require('./fees');
const DATA_DIR = require('./dataDir');

const S = '__test';                       // maps to us_stock fees (0.03% + 0.02% slip / side)
const testFile = path.join(DATA_DIR, `paper-${S}.json`);
const cleanup = () => { try { fs.unlinkSync(testFile); } catch {} };

let pass = 0, fail = 0;
const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else      { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\npaperBroker invariants\n' + '─'.repeat(64));

// ── 1. Round-trip cash consistency ───────────────────────────────────────────
cleanup();
broker.reset(S, 10000);
{
    const before = broker.getAccount(S).cash;
    broker.buy(S, 'AAPL', { notional: 1000, price: 100 });
    const sellRes = broker.sell(S, 'AAPL', { price: 110, reason: 'take-profit' });
    const after = broker.getAccount(S).cash;
    const cashDelta = after - before;
    check('round-trip: cash delta === reported net P&L',
        near(cashDelta, sellRes.pnl),
        `cashΔ=${cashDelta.toFixed(4)} pnl=${sellRes.pnl}`);

    // gross should be +100 (10 shares * $10), fees subtract from it
    check('net P&L is strictly less than gross (fees bite)',
        sellRes.record.pnl < sellRes.record.grossPnl,
        `net=${sellRes.record.pnl} gross=${sellRes.record.grossPnl}`);

    const expectedFees = fees.roundTrip(S, 1000, 1100);
    check('round-trip fees match fees.js exactly',
        near(sellRes.record.fees, expectedFees),
        `got=${sellRes.record.fees} want=${expectedFees.toFixed(4)}`);
}

// ── 2. Losing trade also reconciles ──────────────────────────────────────────
cleanup(); broker.reset(S, 10000);
{
    const before = broker.getAccount(S).cash;
    broker.buy(S, 'GME', { notional: 500, price: 25 });
    const r = broker.sell(S, 'GME', { price: 20, reason: 'stop-loss' });
    const cashDelta = broker.getAccount(S).cash - before;
    check('losing round-trip: cash delta === net P&L',
        near(cashDelta, r.pnl), `cashΔ=${cashDelta.toFixed(4)} pnl=${r.pnl}`);
    check('loss is larger than raw price loss (fees add to it)',
        r.record.pnl < r.record.grossPnl);
}

// ── 3. Averaging multiple buys ───────────────────────────────────────────────
cleanup(); broker.reset(S, 10000);
{
    broker.buy(S, 'MSFT', { qty: 10, price: 100 });
    broker.buy(S, 'MSFT', { qty: 10, price: 200 });
    const pos = broker.getPositions(S)[0];
    check('avgPrice is the weighted MARKET average (fees excluded)',
        near(pos.avgEntryPrice, 150), `got ${pos.avgEntryPrice}`);
    check('qty accumulates', near(pos.qty, 20), `got ${pos.qty}`);
}

// ── 4. Partial sell allocates buy-fees proportionally ────────────────────────
cleanup(); broker.reset(S, 10000);
{
    const before = broker.getAccount(S).cash;
    broker.buy(S, 'NVDA', { qty: 10, price: 100 });
    const half = broker.sell(S, 'NVDA', { qty: 5, price: 100 });
    const posAfter = broker.getPositions(S)[0];
    check('partial sell leaves the remaining qty', near(posAfter.qty, 5), `got ${posAfter.qty}`);
    check('partial sell keeps half the buy-fee on the book',
        near(posAfter.feesPaid, fees.estimate(S, { notional: 1000 }) / 2, 0.01),
        `got ${posAfter.feesPaid}`);

    // flat price → P&L should be exactly the fees, negative
    check('flat partial sell loses exactly its fee share', half.pnl < 0 && half.pnl > -2,
        `pnl=${half.pnl}`);

    // close the rest; total cash delta must equal sum of both net P&Ls
    const rest = broker.sell(S, 'NVDA', { price: 100 });
    const cashDelta = broker.getAccount(S).cash - before;
    check('two partial sells: cash delta === sum of both net P&Ls',
        near(cashDelta, half.pnl + rest.pnl),
        `cashΔ=${cashDelta.toFixed(4)} sum=${(half.pnl + rest.pnl).toFixed(4)}`);
    check('position fully closed', broker.getPositions(S).length === 0);
}

// ── 5. Cash guard ────────────────────────────────────────────────────────────
cleanup(); broker.reset(S, 100);
{
    const r = broker.buy(S, 'BRK.A', { notional: 500, price: 50 });
    const acct = broker.getAccount(S);
    check('oversized buy is scaled to affordable size, never overdrafts',
        r.success && acct.cash >= -1e-6, `cash=${acct.cash}`);
    const r2 = broker.buy(S, 'X', { notional: 1000, price: 1e9 });
    check('unaffordable buy fails cleanly', !r2.success, r2.error);
}

// ── 6. Sell guards ───────────────────────────────────────────────────────────
cleanup(); broker.reset(S, 10000);
{
    check('sell with no position fails', !broker.sell(S, 'NOPE', { price: 10 }).success);
    check('buy with no price fails', !broker.buy(S, 'X', { notional: 10, price: 0 }).success);
}

// ── 7. Account math ──────────────────────────────────────────────────────────
cleanup(); broker.reset(S, 10000);
{
    broker.buy(S, 'SPY', { qty: 10, price: 100 });
    const acct = broker.getAccount(S, { SPY: 120 });
    check('portfolioValue === cash + positionsValue',
        near(acct.portfolioValue, acct.cash + acct.positionsValue),
        `pv=${acct.portfolioValue} cash=${acct.cash} pos=${acct.positionsValue}`);
    check('unrealized P&L reflects the mark', near(broker.getPositions(S, { SPY: 120 })[0].unrealizedPl, 200, 0.5));
    check('totalFees is tracked', acct.totalFees > 0, `fees=${acct.totalFees}`);
}

// ── 8. Symbol normalization (BTC/USD === BTCUSD) ─────────────────────────────
cleanup(); broker.reset(S, 10000);
{
    broker.buy(S, 'BTC/USD', { notional: 1000, price: 50000 });
    const r = broker.sell(S, 'BTCUSD', { price: 55000 });
    check('slashed and unslashed symbols resolve to one position', r.success, r.error);
}

// ── 9. High-water tracking (Chandelier depends on this) ──────────────────────
cleanup(); broker.reset(S, 10000);
{
    broker.buy(S, 'TSLA', { qty: 1, price: 100 });
    broker.updateHighWater(S, 'TSLA', 150);
    broker.updateHighWater(S, 'TSLA', 120);   // lower — must not regress
    check('highWater ratchets up only', broker.getPositions(S)[0].highWater === 150);
}

cleanup();
console.log('─'.repeat(64));
console.log(`${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
