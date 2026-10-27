#!/usr/bin/env node
// auditProfitability.js — Honest audit of whether the bot makes money net of fees.
// Answers: vs buy-and-hold, after real costs, which streams actually profit?
// Run: node auditProfitability.js
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const fees = require('./fees');

const DATA_DIR = require('./dataDir');
const JOURNAL_PATH = path.join(DATA_DIR, 'trade-journal.json');

function loadJournal() {
    try { return JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')); } catch { return { closedTrades: [], stats: {} }; }
}

async function fetchHoldBenchmark(symbol, startDate, endDate) {
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=10y`,
            { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const q = res.data?.chart?.result?.[0]?.indicators?.quote?.[0];
        const ts = res.data?.chart?.result?.[0]?.timestamp || [];
        if (!q || !q.close) return null;

        const closes = [];
        for (let i = 0; i < ts.length; i++) {
            const t = new Date(ts[i] * 1000);
            if (t >= startDate && t <= endDate && q.close[i] != null) {
                closes.push({ t, close: q.close[i] });
            }
        }
        return closes.length > 1 ? closes : null;
    } catch { return null; }
}

function calcBenchmarkReturn(closes) {
    if (!closes || closes.length < 2) return 0;
    return (closes[closes.length - 1].close / closes[0].close - 1) * 100;
}

(async () => {
    const journal = loadJournal();
    const closed = journal.closedTrades || [];

    console.log('\n' + '═'.repeat(90));
    console.log('PROFIT AUDIT — Bot Profitability vs Buy-and-Hold (Net of Real-World Fees)');
    console.log('═'.repeat(90));

    if (!closed.length) {
        console.log('⚠️  No closed trades yet. Run the bot for a few days and check back.\n');
        return;
    }

    // Group trades by strategy
    const byStrategy = {};
    let totalPnL = 0, totalFees = 0, totalTrades = 0, totalWins = 0;

    for (const t of closed) {
        const strat = t.strategy || 'unknown';
        if (!byStrategy[strat]) byStrategy[strat] = { trades: [], pnl: 0, fees: 0 };
        byStrategy[strat].trades.push(t);
        byStrategy[strat].pnl += (t.pnl || 0);
        byStrategy[strat].fees += (t.fees || 0);
        totalPnL += (t.pnl || 0);
        totalFees += (t.fees || 0);
        totalTrades += 1;
        if ((t.pnl || 0) > 0) totalWins += 1;
    }

    console.log(`\n📊 TRADES CLOSED: ${totalTrades} | WINS: ${totalWins} | WIN RATE: ${(totalWins / totalTrades * 100).toFixed(1)}%\n`);

    console.log('STREAM PERFORMANCE (Net of Fees)');
    console.log('─'.repeat(90));
    console.log('Strategy       Trades  P&L (net)   Fees Paid   Avg/trade   Win%  Status');
    console.log('─'.repeat(90));

    const rows = Object.entries(byStrategy).map(([name, data]) => {
        const wins = data.trades.filter(t => (t.pnl || 0) > 0).length;
        const avg = data.pnl / data.trades.length;
        const wr = wins / data.trades.length * 100;
        const status = data.pnl > 0 ? '✓ PROFIT' : data.pnl < 0 ? '✗ LOSS' : '— BREAK-EVEN';
        return {
            name, pnl: data.pnl, fees: data.fees, trades: data.trades.length,
            avg, wr, status, wins
        };
    }).sort((a, b) => b.pnl - a.pnl);

    for (const r of rows) {
        console.log(
            `${r.name.padEnd(14)} ${String(r.trades).padStart(6)} ` +
            `${(r.pnl >= 0 ? '$' : '$') + r.pnl.toFixed(0).padStart(9)} ` +
            `$${r.fees.toFixed(0).padStart(7)} ` +
            `$${r.avg.toFixed(2).padStart(8)} ` +
            `${r.wr.toFixed(0).padStart(4)}% ` +
            r.status
        );
    }

    console.log('─'.repeat(90));
    const totalStatus = totalPnL > 0 ? '✓ NET PROFIT' : totalPnL < 0 ? '✗ NET LOSS' : '— BREAK-EVEN';
    console.log(
        `${'TOTAL'.padEnd(14)} ${String(totalTrades).padStart(6)} ` +
        `${(totalPnL >= 0 ? '$' : '$') + totalPnL.toFixed(0).padStart(9)} ` +
        `$${totalFees.toFixed(0).padStart(7)} ` +
        `$${(totalPnL / totalTrades).toFixed(2).padStart(8)} ` +
        `${(totalWins / totalTrades * 100).toFixed(0).padStart(4)}% ` +
        totalStatus
    );

    // Benchmark vs hold
    console.log('\n' + '═'.repeat(90));
    console.log('VS BUY-AND-HOLD BENCHMARK');
    console.log('═'.repeat(90));

    const tradeDates = closed.map(t => {
        const d = t.entryTime ? new Date(t.entryTime) : null;
        return d;
    }).filter(d => d).sort((a, b) => a - b);

    if (tradeDates.length > 0) {
        const minDate = tradeDates[0];
        const maxDate = tradeDates[tradeDates.length - 1];
        const daysTrading = (maxDate - minDate) / 86400000;

        console.log(`\nTrading period: ${minDate.toISOString().slice(0, 10)} to ${maxDate.toISOString().slice(0, 10)} (${daysTrading.toFixed(0)} days)`);

        // SPY benchmark (US stocks)
        const spyBench = await fetchHoldBenchmark('SPY', minDate, maxDate);
        const spyReturn = spyBench ? calcBenchmarkReturn(spyBench) : null;

        // BTC benchmark (crypto)
        try {
            const res = await axios.get('https://api.binance.com/api/v3/klines', {
                params: { symbol: 'BTCUSDT', interval: '1d', limit: 1000, endTime: maxDate.getTime() },
                timeout: 5000
            });
            const btcCandles = (res.data || []).filter(k => k[0] >= minDate.getTime()).map(k => ({
                t: k[0],
                close: parseFloat(k[4])
            }));
            const btcReturn = btcCandles.length > 1 ? (btcCandles[btcCandles.length - 1].close / btcCandles[0].close - 1) * 100 : null;

            if (spyReturn !== null) {
                const verdict = totalPnL > 0 && totalPnL / totalTrades * totalTrades > spyReturn ? '✓ BEAT SPY' : '✗ trails SPY';
                console.log(`SPY buy-and-hold:  ${spyReturn.toFixed(2).padStart(8)}% ${verdict}`);
            }
            if (btcReturn !== null) {
                const verdict = totalPnL > 0 && totalPnL / totalTrades * totalTrades > btcReturn ? '✓ BEAT BTC' : '✗ trails BTC';
                console.log(`BTC buy-and-hold:  ${btcReturn.toFixed(2).padStart(8)}% ${verdict}`);
            }
        } catch { /* BTC fetch optional */ }
    }

    // Summary verdict
    console.log('\n' + '═'.repeat(90));
    if (totalPnL > 0) {
        console.log(`✓ BOT IS PROFITABLE: +$${totalPnL.toFixed(2)} net (after ${totalTrades} trades, $${totalFees.toFixed(2)} fees paid)`);
        console.log('  Decision: OK to scale — monitor for drawdown and regime switches.');
    } else if (totalPnL < 0) {
        console.log(`✗ BOT IS LOSING: -$${Math.abs(totalPnL).toFixed(2)} net (after ${totalTrades} trades, $${totalFees.toFixed(2)} fees paid)`);
        console.log('  Decision: Do NOT scale. Debug entries/exits before real money.');
    } else {
        console.log(`— BOT BREAKS EVEN: $${totalPnL.toFixed(2)} (after ${totalTrades} trades, $${totalFees.toFixed(2)} fees paid)`);
        console.log('  Decision: Not viable yet. Need clear edge.');
    }
    console.log('\n' + '═'.repeat(90) + '\n');
})();
