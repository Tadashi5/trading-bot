// endOfDay.js — Post-market close report generator
// Runs after market close. Summarizes the day's activity, P&L, signals that fired,
// what worked vs failed, and triggers learning weight adjustment.
require('dotenv').config();
const axios        = require('axios');
const fs           = require('fs');
const path         = require('path');
const tradeJournal = require('./tradeJournal');
const indicators   = require('./indicators');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE        = process.env.ALPACA_BASE_URL;
const REPORTS_DIR = path.join(__dirname, 'reports');

async function generate() {
    console.log('[EOD] Generating end-of-day report...');
    const now = new Date();

    // ── Fetch account + positions ────────────────────────────────────────────
    let account = {}, positions = [];
    try {
        const [accRes, posRes] = await Promise.all([
            axios.get(`${BASE}/account`, { headers: HEADERS }),
            axios.get(`${BASE}/positions`, { headers: HEADERS }),
        ]);
        account = accRes.data;
        positions = posRes.data;
    } catch (err) {
        console.error('[EOD] Failed to fetch account:', err.message);
    }

    const portfolioValue = parseFloat(account.portfolio_value || 0);
    const cash           = parseFloat(account.cash || 0);
    const dayPL          = parseFloat(account.equity || 0) - parseFloat(account.last_equity || 0);
    const dayPLpct       = parseFloat(account.last_equity || 1) > 0
        ? ((dayPL / parseFloat(account.last_equity)) * 100).toFixed(2)
        : '0.00';

    // ── Today's trades from journal ──────────────────────────────────────────
    const todayStr = now.toISOString().split('T')[0];
    const allOpen  = tradeJournal.getOpenTrades();
    const recent   = tradeJournal.getRecentClosed(100);

    // Filter to today's entries and exits
    const todayEntries = allOpen.filter(t => t.entryTime?.startsWith(todayStr));
    const todayClosed  = recent.filter(t => t.exitTime?.startsWith(todayStr));

    const todayBuys    = todayEntries.length + todayClosed.filter(t => t.entryTime?.startsWith(todayStr)).length;
    const todaySells   = todayClosed.length;
    const todayPnl     = todayClosed.reduce((s, t) => s + (t.pnl || 0), 0);
    const todayWins    = todayClosed.filter(t => t.pnl > 0).length;
    const todayLosses  = todayClosed.filter(t => t.pnl <= 0).length;
    const todayWinRate = todayClosed.length > 0 ? ((todayWins / todayClosed.length) * 100).toFixed(1) : 'N/A';

    // ── Analyze what signals worked today ────────────────────────────────────
    const signalPerformance = {};
    for (const trade of todayClosed) {
        const signals = trade.signals || {};
        const isWin = trade.pnl > 0;
        for (const [key, value] of Object.entries(signals)) {
            if (typeof value !== 'number' || value === 0) continue;
            if (!signalPerformance[key]) signalPerformance[key] = { winFires: 0, lossFires: 0, totalValue: 0 };
            if (isWin) signalPerformance[key].winFires++;
            else signalPerformance[key].lossFires++;
            signalPerformance[key].totalValue += value;
        }
    }

    // Best and worst signals today
    const signalEntries = Object.entries(signalPerformance);
    const bestSignals = signalEntries
        .filter(([_, s]) => s.winFires > s.lossFires)
        .sort((a, b) => (b[1].winFires - b[1].lossFires) - (a[1].winFires - a[1].lossFires))
        .slice(0, 3)
        .map(([k, s]) => `${k} (${s.winFires}W/${s.lossFires}L)`);

    const worstSignals = signalEntries
        .filter(([_, s]) => s.lossFires > s.winFires)
        .sort((a, b) => (b[1].lossFires - b[1].winFires) - (a[1].lossFires - a[1].winFires))
        .slice(0, 3)
        .map(([k, s]) => `${k} (${s.winFires}W/${s.lossFires}L)`);

    // ── Strategy breakdown for today ─────────────────────────────────────────
    const stratToday = {};
    for (const t of todayClosed) {
        const s = t.strategy || 'unknown';
        if (!stratToday[s]) stratToday[s] = { trades: 0, wins: 0, pnl: 0 };
        stratToday[s].trades++;
        if (t.pnl > 0) stratToday[s].wins++;
        stratToday[s].pnl += t.pnl || 0;
    }

    // ── Current positions summary ────────────────────────────────────────────
    const topWinners = positions
        .map(p => ({ symbol: p.symbol, pnlPct: parseFloat(p.unrealized_plpc) * 100 }))
        .sort((a, b) => b.pnlPct - a.pnlPct);
    const winners = topWinners.filter(p => p.pnlPct > 0).slice(0, 5);
    const losers  = topWinners.filter(p => p.pnlPct < 0).slice(-5).reverse();

    // ── Trigger learning ─────────────────────────────────────────────────────
    const stats = tradeJournal.getStats();
    let learningNote = '';
    if (stats.closedTotal >= 1) {
        const newWeights = tradeJournal.learnWeights();
        if (newWeights) {
            learningNote = 'Weights updated from every closed trade.';
            // Find most changed weights
            const defaultW = 1.0;
            const changes = Object.entries(newWeights)
                .map(([k, v]) => ({ signal: k, weight: v, diff: Math.abs(v - defaultW) }))
                .sort((a, b) => b.diff - a.diff)
                .slice(0, 3);
            if (changes.length) {
                learningNote += ' Top adjustments: ' + changes.map(c =>
                    `${c.signal}=${c.weight.toFixed(2)}${c.weight > 1 ? '↑' : '↓'}`
                ).join(', ');
            }
        }
    } else {
        learningNote = `Awaiting first closed trade to start learning.`;
    }

    // ── Build markdown report ────────────────────────────────────────────────
    const dayColor = dayPL >= 0 ? '🟢' : '🔴';
    const markdown = `# End-of-Day Report
*Generated: ${now.toISOString().slice(0, 16)} UTC*

## ${dayColor} Day Summary
- **Portfolio Value:** $${portfolioValue.toFixed(2)}
- **Cash Available:** $${cash.toFixed(2)}
- **Day P&L:** ${dayPL >= 0 ? '+' : ''}$${dayPL.toFixed(2)} (${dayPLpct}%)

## Today's Trading Activity
- **Buys:** ${todayBuys} | **Sells:** ${todaySells}
- **Closed P&L:** ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)}
- **Win Rate:** ${todayWinRate}% (${todayWins}W / ${todayLosses}L)

${Object.keys(stratToday).length ? '### By Strategy\n' + Object.entries(stratToday).map(([s, d]) =>
    `- **${s.toUpperCase()}**: ${d.trades} trades, ${d.wins} wins, ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}`
).join('\n') : ''}

## Signal Analysis
${bestSignals.length ? `### ✅ Best Signals Today\n${bestSignals.map(s => `- ${s}`).join('\n')}` : '- No standout winners today'}

${worstSignals.length ? `### ❌ Worst Signals Today\n${worstSignals.map(s => `- ${s}`).join('\n')}` : '- No clear losers today'}

## Open Positions (${positions.length})
${winners.length ? `### Top Winners\n${winners.map(p => `- **${p.symbol}** — +${p.pnlPct.toFixed(1)}%`).join('\n')}` : '- No open winners'}

${losers.length ? `### Biggest Losers\n${losers.map(p => `- **${p.symbol}** — ${p.pnlPct.toFixed(1)}%`).join('\n')}` : '- No open losers'}

## 🧠 Learning System
- **Total closed trades:** ${stats.closedTotal || 0}
- **Overall win rate:** ${stats.winRate || 0}%
- **Lifetime P&L:** $${stats.totalPnl?.toFixed(2) || '0.00'}
- **Status:** ${learningNote}

## Tomorrow's Notes
${todayPnl < 0 ? '- ⚠️ Negative day — review if stop losses are tight enough' : '- ✅ Profitable day — maintain current approach'}
${worstSignals.length ? `- Consider reducing weight on: ${worstSignals.join(', ')}` : ''}
${winners.length >= 3 ? '- Strong momentum — watch for continuation plays' : ''}
- Open positions to monitor: ${positions.length > 0 ? positions.slice(0, 8).map(p => p.symbol).join(', ') : 'none'}
`;

    // ── Save report ──────────────────────────────────────────────────────────
    const dateDir = path.join(REPORTS_DIR, todayStr);
    if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });

    const stamp  = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const mdPath = path.join(dateDir, `end-of-day-${stamp}.md`);
    fs.writeFileSync(mdPath, markdown);

    // Save as latest EOD for dashboard consumption
    const record = {
        type:       'end-of-day',
        sourceTime: now.toISOString(),
        signals: {
            dayPL:          parseFloat(dayPL.toFixed(2)),
            dayPLpct:       parseFloat(dayPLpct),
            todayTrades:    todayBuys + todaySells,
            todayWinRate:   todayWinRate,
            todayPnl:       parseFloat(todayPnl.toFixed(2)),
            bestSignals,
            worstSignals,
            positionCount:  positions.length,
            learningNote,
        },
        mdPath: mdPath.replace(__dirname, ''),
    };
    fs.writeFileSync(path.join(REPORTS_DIR, 'eod-latest.json'), JSON.stringify(record, null, 2));

    console.log(`[EOD] Report saved: ${mdPath}`);
    console.log(`[EOD] Day P&L: ${dayPL >= 0 ? '+' : ''}$${dayPL.toFixed(2)} | Trades: ${todayBuys + todaySells} | Win rate: ${todayWinRate}%`);
    if (learningNote) console.log(`[EOD] Learning: ${learningNote}`);

    return { markdown, signals: record.signals, path: mdPath };
}

module.exports = { generate };
