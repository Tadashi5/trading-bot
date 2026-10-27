#!/usr/bin/env node
// streamAudit.js — Which streams are actually making/losing money?
// Separates reconciled positions (broker hand-me-downs) from real bot trades.
// Run: node streamAudit.js
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = require('./dataDir');
const JOURNAL_PATH = path.join(DATA_DIR, 'trade-journal.json');

function loadJournal() {
    try { return JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')); } catch { return { trades: [] }; }
}

(async () => {
    const journal = loadJournal();
    const trades = journal.trades || [];

    // Separate reconciled (broker hand-me-downs) from bot-initiated (our entries)
    const botInitiated = trades.filter(t => !t.reconciled && t.status === 'closed');
    const reconciled = trades.filter(t => t.reconciled);
    const openOurs = trades.filter(t => !t.reconciled && t.status === 'open');

    console.log('\n' + '═'.repeat(90));
    console.log('STREAM AUDIT — Which Streams Actually Make Money?');
    console.log('═'.repeat(90));

    console.log(`\n📊 POSITION SUMMARY`);
    console.log(`   Reconciled (broker, tracking only): ${reconciled.length}`);
    console.log(`   Open (our entries, not yet closed): ${openOurs.length}`);
    console.log(`   Closed (our entries, cycled exit):  ${botInitiated.length}\n`);

    if (botInitiated.length === 0) {
        console.log('⚠️  NO COMPLETED BOT TRADES YET\n');
        console.log('The bot has entered ' + openOurs.length + ' positions but hasn\'t exited any yet.');
        console.log('Possible issues:');
        console.log('  • Exit logic (take-profit, trailing stop, regime filter) not firing');
        console.log('  • Positions are winning/flat and waiting for exit conditions');
        console.log('  • Streams not enabled (crypto, stocks, options, politico, pump)');
        console.log('  • Circuit breaker paused streams due to low win rate');
        console.log('\nRun again in 1-2 weeks when more positions close. For now:\n');
    }

    // Group bot-initiated closed trades by strategy
    const byStrategy = {};
    for (const t of botInitiated) {
        const s = t.strategy || 'unknown';
        if (!byStrategy[s]) byStrategy[s] = { closed: [], pnl: 0, fees: 0, wins: 0 };
        byStrategy[s].closed.push(t);
        byStrategy[s].pnl += (t.pnl || 0);
        byStrategy[s].fees += (t.fees || 0);
        if ((t.pnl || 0) > 0) byStrategy[s].wins++;
    }

    console.log('STREAMS: BOT-INITIATED CLOSED TRADES (These count!)');
    console.log('─'.repeat(90));
    console.log('Stream        Closed  P&L (net)  Fees Paid   Win%  Status          Verdict');
    console.log('─'.repeat(90));

    const strategies = ['crypto', 'stocks', 'politico', 'options', 'asia-paper', 'pump', 'boring'];
    const streams = [];
    for (const s of strategies) {
        if (byStrategy[s]) {
            const data = byStrategy[s];
            const wr = data.closed.length > 0 ? (data.wins / data.closed.length * 100).toFixed(0) : '—';
            const status = data.pnl > 0 ? '✓ PROFIT' : data.pnl < 0 ? '✗ LOSS' : '— BREAK-EVEN';
            const verdict = data.pnl > 0 ? 'YES' : data.pnl < 0 ? 'NO' : 'WAIT';
            console.log(
                s.padEnd(13) + ' ' +
                String(data.closed.length).padStart(6) + '  ' +
                (data.pnl >= 0 ? '$' : '−$') + Math.abs(data.pnl).toFixed(2).padStart(8) + '  ' +
                '$' + data.fees.toFixed(0).padStart(7) + '  ' +
                String(wr).padStart(4) + '%  ' +
                status.padEnd(15) + ' ' +
                verdict
            );
            streams.push({ name: s, ...data });
        }
    }

    // Show streams with NO bot-initiated trades
    console.log('─'.repeat(90));
    for (const s of strategies) {
        if (!byStrategy[s] && openOurs.length > 0) {
            const open = openOurs.filter(t => t.strategy === s).length;
            if (open > 0) {
                console.log(
                    s.padEnd(13) + ' ' +
                    '    0  ' +
                    '      —        ' +
                    '      —      ' +
                    '    — ' +
                    '— NO EXITS YET   ' +
                    'WATCH'
                );
            }
        }
    }

    // Verdict
    console.log('\n' + '═'.repeat(90));
    console.log('VERDICT: Which Streams Will Make Money?');
    console.log('═'.repeat(90));

    for (const s of streams.sort((a, b) => b.pnl - a.pnl)) {
        const makes = s.pnl > 0 ? 'YES ✓' : s.pnl < 0 ? 'NO ✗' : 'MAYBE';
        console.log(`\n${s.name.toUpperCase()}: ${makes}`);
        if (s.closed.length > 0) {
            console.log(`  • ${s.closed.length} closed trades, +$${s.pnl.toFixed(2)} net (fees: $${s.fees.toFixed(2)})`);
            console.log(`  • Win rate: ${(s.wins / s.closed.length * 100).toFixed(0)}%`);
            const avg = s.pnl / s.closed.length;
            console.log(`  • Avg/trade: $${avg.toFixed(2)}`);
        }
    }

    if (openOurs.length > 0) {
        console.log(`\n⏳ WAITING TO EXIT: ${openOurs.length} open bot-initiated positions`);
        const byStrat = {};
        for (const t of openOurs) {
            const s = t.strategy || 'unknown';
            byStrat[s] = (byStrat[s] || 0) + 1;
        }
        for (const [s, count] of Object.entries(byStrat)) {
            console.log(`  • ${s}: ${count} open (monitor exits over next week)`);
        }
    }

    console.log('\n' + '═'.repeat(90) + '\n');
})();
