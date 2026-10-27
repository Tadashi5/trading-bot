require('dotenv').config();
const express = require('express');
const crypto = require('./crypto');
const options = require('./options');
const stocks = require('./stocks');
const asian = require('./asian');
const discord = require('./discordBot');
const wheel       = require('./wheel');
const risky       = require('./risky');
const riskManager = require('./riskManager');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const reportContext  = require('./reportContext');
const politico       = require('./politicoScanner');
const politicoVips   = require('./politicoVips');
const research       = require('./research');
const researchGen    = require('./researchGenerator');
const regimeFilter   = require('./regimeFilter');
const newsHub        = require('./newsHub');
const tradeJournal   = require('./tradeJournal');
const paperBroker    = require('./paperBroker');
const mexcPaper      = require('./mexcPaperTrader');
const asianPaper     = require('./asianPaperTrader');
const boringEtf      = require('./boringEtfTrader');
// Pump Lab deleted — micro-cap lottery, guaranteed slow bleed after real slippage.
const optionsLab     = require('./optionsPaperTrader');
const adaptiveTuner  = require('./adaptiveTuner');
const endOfDay       = require('./endOfDay');
const mlPipeline     = require('./src/main');
const ingestion      = require('./services/ingestion');
const ibkr           = require('./services/ibkr');
const mexc           = require('./services/mexc');
const perfTracker    = require('./performanceTracker');

const app = express();
app.use(express.json({ limit: '5mb' }));

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const HEADERS = {
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;

app.use(express.static(path.join(__dirname, 'Public')));

// DEBUG: Check environment variables
app.get('/debug/env', (req, res) => {
    res.json({
        ALPACA_KEY_ID: process.env.ALPACA_KEY_ID ? `SET (${process.env.ALPACA_KEY_ID.slice(-6)})` : 'NOT SET',
        ALPACA_SECRET_KEY: process.env.ALPACA_SECRET_KEY ? `SET (length: ${process.env.ALPACA_SECRET_KEY.length})` : 'NOT SET',
        ALPACA_BASE_URL: process.env.ALPACA_BASE_URL || 'NOT SET',
        NODE_ENV: process.env.NODE_ENV,
    });
});

const PIN = process.env.DASHBOARD_PIN || '1234';
function authCheck(req, res, next) {
    if (req.query.pin === PIN) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

const tradeLogs = [];
function log(msg) {
    const entry = { time: new Date().toLocaleTimeString(), msg };
    tradeLogs.unshift(entry);
    if (tradeLogs.length > 50) tradeLogs.pop();
    console.log(`[${entry.time}] ${msg}`);
}

// Persist the last bot scan to disk so the BOT tab loads INSTANTLY on a cold
// start instead of grinding through a full re-scan (every ticker = news +
// sentiment + indicators). Especially important while the US market is closed,
// when the scan data is stale anyway and there's no point re-fetching live.
const BOT_CACHE_FILE = require('path').join(require('./dataDir'), 'last-bot-scan.json');
function loadBotCache() {
    try { return JSON.parse(fs.readFileSync(BOT_CACHE_FILE, 'utf8')); } catch { return null; }
}
function saveBotCache(d) {
    try { fs.writeFileSync(BOT_CACHE_FILE, JSON.stringify(d)); } catch {}
}

let lastData = loadBotCache();   // seed from disk so /data serves immediately after restart
let lastAsiaData = null;
let lastPoliticoData = null;
let lastWheelData = null;
let lastRiskyData = null;
let lastMexcData = null;

// Streams are all paper-traded now — drop any legacy Alpaca broker imports
try {
    tradeJournal.purgeBrokerImports();
} catch (e) { console.log(`[Startup] Purge broker imports error: ${e.message}`); }

// Repair the duplicate broker-import bug before anything reads the journal
try {
    const { openRemoved, closedRemoved } = tradeJournal.dedupeReconciled();
    if (openRemoved || closedRemoved) console.log(`[Startup] Deduped broker imports: -${openRemoved} open, -${closedRemoved} phantom closed`);
} catch (e) { console.log(`[Startup] Dedupe error: ${e.message}`); }

// Clear stale circuit-breaker pauses on boot. A pause needs WR>45% to lift, but a
// paused stream can't trade to earn any WR — so a pause set on now-deleted data (e.g.
// pre-reset trades) traps it forever. Drop any pause not backed by ≥10 recent trades.
try {
    const cfile = require('path').join(require('./dataDir'), 'adaptive-calibration.json');
    const c = JSON.parse(fs.readFileSync(cfile, 'utf8'));
    if (c.paused && Object.keys(c.paused).length) {
        const j = JSON.parse(fs.readFileSync(path.join(require('./dataDir'), 'trade-journal.json'), 'utf8'));
        const closed = j.closedTrades || [];
        const map = { stocks: 'stocks', politico: 'politico', asia: 'asia-paper' };
        let cleared = [];
        for (const stream of Object.keys(c.paused)) {
            const recent = closed.filter(t => t.strategy === (map[stream] || stream)).slice(-20);
            if (recent.length < 10) { delete c.paused[stream]; cleared.push(stream); }
        }
        if (cleared.length) { fs.writeFileSync(cfile, JSON.stringify(c, null, 2)); console.log(`[Startup] Cleared stale circuit-breaker pause(s): ${cleared.join(', ')}`); }
    }
} catch (e) { console.log(`[Startup] Pause-clear error: ${e.message}`); }

// One-time cleanup: purge ancient orphans from journal backlog
try {
    const purged = tradeJournal.purgeAncientOrphans();
    if (purged) console.log(`[Startup] Cleaned ${purged} ancient orphaned journal entries`);
} catch (e) { console.log(`[Startup] Purge error: ${e.message}`); }

// Nuclear option: if >1000 open entries, they're unresolvable backlog — clear them
try {
    const journalPath = path.join(require('./dataDir'), 'trade-journal.json');
    const j = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if ((j.trades || []).length > 1000) {
        console.log(`[Startup] NUCLEAR: Clearing ${(j.trades || []).length} unresolvable backlog entries`);
        j.trades = [];
        j.orphaned = j.orphaned ? j.orphaned.slice(-500) : [];
        fs.writeFileSync(journalPath, JSON.stringify(j, null, 2));
    }
} catch (e) { console.log(`[Startup] Nuclear cleanup error: ${e.message}`); }

// Reset Pump Lab calibration to defaults so it re-learns from revised gates
try {
    const pumpCalibPath = path.join(require('./dataDir'), 'pump-experiment-calibration.json');
    fs.unlinkSync(pumpCalibPath);
    console.log(`[Startup] Reset Pump Lab calibration (will re-learn from new DEFAULT_GATES)`);
} catch (e) { /* file may not exist */ }

// Prime the 200-MA regime filter on boot, then refresh hourly (regime is a daily signal)
regimeFilter.refresh()
    .then(r => log(`📊 Regime — crypto ${r.crypto?.riskOn ? 'RISK-ON' : 'RISK-OFF'} (${r.crypto?.pctFromMA ?? '?'}% vs 200MA) | stocks ${r.stocks?.riskOn ? 'RISK-ON' : 'RISK-OFF'} (${r.stocks?.pctFromMA ?? '?'}% vs 200MA)`))
    .catch(() => {});

// Automated self-audit — probes every data source + stream so silent failures surface
// loudly instead of quietly rotting. Runs ~15 min after boot, then weekly (Mon 13:00 UTC).
const systemAudit = require('./systemAudit');
const runAudit = () => systemAudit.run()
    .then(r => { log(`🔍 System audit: ${r.verdict} (${r.summary})`);
        r.checks.filter(c => c.status === 'FAIL').forEach(c => log(`   ✗ ${c.name}: ${c.detail}`)); })
    .catch(e => log(`System audit error: ${e.message}`));
setTimeout(runAudit, 15 * 60 * 1000);
cron.schedule('0 13 * * 1', runAudit);   // every Monday 13:00 UTC
cron.schedule('7 * * * *', () => regimeFilter.refresh().catch(() => {}));

// News for every symbol the bot trades/learns from. Refreshed on a schedule, never
// per-request — 60 symbols on demand would exhaust the free NewsAPI tier immediately.
// First run is delayed so it doesn't compete with the boot-time scans.
cron.schedule('*/30 * * * *', () => newsHub.refresh().catch(e => log(`News refresh error: ${e.message}`)));
setTimeout(() => newsHub.refresh().catch(e => log(`News warm-up error: ${e.message}`)), 45000);

async function runScan() {
    console.log('Starting scan...');
    try {
        log('Scanning crypto markets...');
        // Risk budget is sized off OUR OWN paper ledgers now, not an Alpaca account.
        // (The old Alpaca reconcile also ran here; it kept re-importing that account's
        // legacy positions into the journal, which polluted every stream's P&L.)
        const riskAccounts = ['stocks', 'crypto', 'risky'].map(s => paperBroker.getAccount(s));
        const scanPortfolioValue = riskAccounts.reduce((s, a) => s + a.portfolioValue, 0);
        const riskPositions = ['stocks', 'crypto', 'risky']
            .flatMap(s => paperBroker.getPositions(s))
            .map(p => ({ market_value: p.marketValue }));
        const riskStatus = riskManager.getStatus(scanPortfolioValue, riskPositions);

        const { results: cryptoResults } = await crypto.scan(riskStatus);
        cryptoResults.forEach(r => {
            if (r.action?.success) {
                if (r.signal === 'LADDER') log(`✓ LADDER IN ${r.symbol} at -${r.action.ladderTier} tier (${r.action.ladderPct}% of capital, down ${Math.abs(r.unrealizedPct)}% from entry)`);
                else log(`✓ ${r.signal} ${r.symbol}`);
                if (r.action.trailingStop?.success) log(`✓ Trailing stop set at ${r.action.trailingStop.trailPercent}% for ${r.symbol}`);
                if (r.action.trailingStop?.error) log(`✗ Trailing stop failed for ${r.symbol}: ${r.action.trailingStop.error}`);
            }
            if (r.action?.error) log(`✗ ${r.symbol}: ${r.action.error}`);
        });

        log('Scanning options...');
        const optResults = await options.scan();
        optResults.forEach(r => {
            if (r.action?.success) log(`✓ ${r.signal} ${r.contract}`);
            if (r.action?.error) log(`✗ ${r.ticker}: ${r.action.error}`);
        });

        // STOCKS STREAM RETIRED (2026-10-27) — active US stock-picking lost in a rising
        // market (−$112 realized, 24% win rate). The evidence says hold, don't trade.
        // Capital belongs in the Boring ETF core, not a signal-trading loop.
        const stockResults = [];

        const fearRes = await axios.get('https://api.alternative.me/fng/?limit=1');
        const fg = fearRes.data.data[0];

        // Account = OUR paper ledgers (stocks + crypto), not the retired Alpaca account.
        // Reading Alpaca here showed its leftover $187 cash instead of the $20k sandbox.
        const stocksAcct = paperBroker.getAccount('stocks');
        const cryptoAcct = paperBroker.getAccount('crypto');

        lastData = {
            account: {
                cash:      (stocksAcct.cash + cryptoAcct.cash).toFixed(2),
                portfolio: (stocksAcct.portfolioValue + cryptoAcct.portfolioValue).toFixed(2),
                pl:        (stocksAcct.realizedPnl + cryptoAcct.realizedPnl).toFixed(2),
            },
            paperAccounts: { stocks: stocksAcct, crypto: cryptoAcct },
            fearGreed: { value: fg.value, label: fg.value_classification },
            crypto: cryptoResults,
            options: optResults,
            stocks: stockResults,
            lastScan: new Date().toLocaleTimeString(),
            logs: tradeLogs,
            research: reportContext.getLatest(),
        };
        saveBotCache(lastData);   // persist so the BOT tab loads instantly next cold start

        log('Scan complete. Next scan in 5 minutes.');
    } catch (err) {
        console.log('Scan error:', err.message);
        log(`Error: ${err.message}`);
    }
}

// ── Research reports endpoint ─────────────────────────────────────────────
// Remote routines POST their structured report+signals here so the local bot
// can save them and use the signals to bias trading decisions.
app.post('/reports', authCheck, (req, res) => {
    try {
        const { type, market, markdown, signals } = req.body;
        if (!type || !markdown) return res.status(400).json({ error: 'type + markdown required' });

        // market can be 'usa', 'lse', 'asx', 'nikkei', 'hk', 'crypto', etc.
        const mkt = (market || 'usa').toLowerCase().replace(/\s+/g, '-');
        const label = `${type}-${mkt}`;

        const now = new Date();
        const dateDir = path.join(REPORTS_DIR, now.toISOString().split('T')[0]);
        if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });

        const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
        const mdPath = path.join(dateDir, `${label}-${stamp}.md`);
        fs.writeFileSync(mdPath, markdown);

        const record = { type, market: mkt, label, sourceTime: now.toISOString(), signals: signals || {}, mdPath: mdPath.replace(__dirname, '') };
        fs.writeFileSync(path.join(REPORTS_DIR, 'latest.json'), JSON.stringify(record, null, 2));
        fs.writeFileSync(path.join(REPORTS_DIR, `${label}-latest.json`), JSON.stringify(record, null, 2));

        log(`📊 Research report received (${label}) — ${signals?.summary || 'no summary'}`);
        if (signals?.watchlist?.length) log(`  → Watchlist: ${signals.watchlist.join(', ')}`);
        if (signals?.avoid?.length) log(`  → Avoid: ${signals.avoid.join(', ')}`);

        res.json({ success: true, savedTo: mdPath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reports/latest', authCheck, (req, res) => {
    try {
        const p = path.join(REPORTS_DIR, 'latest.json');
        if (!fs.existsSync(p)) return res.json({ empty: true });
        res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reports/list', authCheck, (req, res) => {
    try {
        const days = fs.readdirSync(REPORTS_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
        const items = [];
        for (const d of days.slice(0, 14)) {
            const dayDir = path.join(REPORTS_DIR, d);
            const files = fs.readdirSync(dayDir).filter(f => f.endsWith('.md')).sort();
            for (const f of files) items.push({ date: d, file: f, path: `/reports/file?date=${d}&file=${f}` });
        }
        res.json({ items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reports/file', authCheck, (req, res) => {
    try {
        const { date, file } = req.query;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[\w.-]+\.md$/.test(file)) {
            return res.status(400).json({ error: 'invalid params' });
        }
        const p = path.join(REPORTS_DIR, date, file);
        if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
        res.type('text/plain').send(fs.readFileSync(p, 'utf8'));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/data', authCheck, (req, res) => {
    if (!lastData) return res.json({ loading: true, logs: tradeLogs });
    // Scanner results may be a cached snapshot (markets closed → no fresh scan), but the
    // ACCOUNT must always read live from our ledger. The disk cache predates the paper
    // broker, so serving its `account` showed the retired Alpaca balance.
    try {
        const stocksAcct = paperBroker.getAccount('stocks');
        const cryptoAcct = paperBroker.getAccount('crypto');
        res.json({
            ...lastData,
            account: {
                cash:      (stocksAcct.cash + cryptoAcct.cash).toFixed(2),
                portfolio: (stocksAcct.portfolioValue + cryptoAcct.portfolioValue).toFixed(2),
                pl:        (stocksAcct.realizedPnl + cryptoAcct.realizedPnl).toFixed(2),
            },
            paperAccounts: { stocks: stocksAcct, crypto: cryptoAcct },
        });
    } catch { res.json(lastData); }
});

app.get('/data/asia', authCheck, (req, res) => {
    if (lastAsiaData) {
        res.json(lastAsiaData);
    } else {
        res.json({ loading: true });
    }
});

// Boring ETF buy-and-hold (debt-recycling core simulation)
app.get('/data/boring/etf', authCheck, (req, res) => {
    try {
        res.json(boringEtf.getState());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Options Lab — isolated $10k wheel paper trader (real premiums), separate P&L
app.get('/data/options/lab', authCheck, (req, res) => {
    try {
        res.json(optionsLab.getState());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// System health — every stream's self-audit + recent auto-calibrations in one view
// 200-MA market regime (risk-on / risk-off) for crypto + stocks
app.get('/data/regime', authCheck, (req, res) => {
    try { res.json(regimeFilter.all()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// News for the symbols we trade or learn from (cached; refreshed every 30 min)
app.get('/data/news', authCheck, (req, res) => {
    try { res.json(newsHub.getNews()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Weekly self-audit report (last run). ?run=1 forces a fresh probe of every data source.
app.get('/data/audit', authCheck, async (req, res) => {
    try {
        const sa = require('./systemAudit');
        res.json(req.query.run ? await sa.run() : sa.getLast());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Leaderboard: every stream, same $10k start, ranked by return ──────────────
// One source of truth for the dashboard. Each stream is a fair head-to-head test:
// identical capital, identical fee treatment (fees.js), identical scoring.
app.get('/data/leaderboard', authCheck, (req, res) => {
    const row = (key, name, emoji, get) => {
        try {
            const d = get();
            if (!d) return null;
            return { key, name, emoji, ...d };
        } catch { return { key, name, emoji, value: null, error: true }; }
    };

    // pnl = TRUE profit/loss; contributed = money actually put in. These matter because
    // the ETF injects weekly DCA cash — so (value - startingCash) counts deposits as
    // "gains" and inflates the total. Always roll the total up from pnl/contributed.
    const fromBroker = (stream) => () => {
        const a = paperBroker.getAccount(stream);
        const closed = paperBroker.getState(stream).closed || [];
        const wins = closed.filter(t => (t.pnl || 0) > 0).length;
        const pnl = a.portfolioValue - a.startingCash;   // no deposits → value-start is true P&L
        return {
            value: a.portfolioValue, start: a.startingCash, contributed: a.startingCash,
            pnl: Math.round(pnl * 100) / 100, ret: a.totalReturn,
            realized: a.realizedPnl, fees: a.totalFees,
            trades: closed.length, open: a.openPositions,
            winRate: closed.length ? Math.round(wins / closed.length * 100) : null,
        };
    };

    const rows = [
        row('stocks', 'US Stocks',   '📊', fromBroker('stocks')),
        row('crypto', 'Crypto',      '₿',  fromBroker('crypto')),
        row('risky',  'High Risk',   '🎲', fromBroker('risky')),
        row('options','Options Wheel','🎯', () => {
            const o = optionsLab.getState();
            const pnl = o.portfolioValue - o.startingBalance;
            return { value: o.portfolioValue, start: o.startingBalance, contributed: o.startingBalance,
                     pnl: Math.round(pnl * 100) / 100, ret: o.totalReturn,
                     realized: o.realizedPnl, fees: o.totalFees,
                     trades: (o.closedTrades || []).length, open: o.openPositions ?? null, winRate: o.winRate ?? null };
        }),
        row('etf', 'Boring ETF', '🧱', () => {
            const e = boringEtf.getState();
            const div = e.dividends?.received || 0;
            const pnl = (e.capitalGain || 0) + div;                 // TRUE gain, excludes DCA deposits
            const contributed = e.portfolioValue - pnl;             // = starting cash + all deposits
            return { value: e.portfolioValue, start: e.startingCash, contributed: Math.round(contributed * 100) / 100,
                     pnl: Math.round(pnl * 100) / 100, ret: e.totalReturn,
                     realized: e.capitalGain, fees: e.totalFees, trades: null, open: null, winRate: null,
                     note: `+$${div.toFixed(0)} dividends · $${(e.invested||0).toFixed(0)} invested of $${contributed.toFixed(0)} in` };
        }),
        row('asia', 'Asia Markets', '🌏', () => {
            const a = asianPaper.getState();
            const s = a.stats || {};
            const value = s.portfolioValue ?? a.portfolioValue;
            const pnl = value - a.startingBalance;
            const asiaFees = (a.closedTrades || []).reduce((sum, t) => sum + (t.fees || 0), 0);
            return { value, start: a.startingBalance, contributed: a.startingBalance,
                     pnl: Math.round(pnl * 100) / 100, ret: s.totalReturn,
                     realized: s.totalPnl, fees: Math.round(asiaFees * 100) / 100, trades: s.trades, open: Object.keys(a.positions || {}).length,
                     winRate: s.winRate ?? null };
        }),
        // Pump Lab deleted — micro-cap slippage made it a guaranteed slow bleed.
    ].filter(Boolean);

    // Rank by return; unstarted streams (null) sink to the bottom
    rows.sort((a, b) => (b.ret ?? -Infinity) - (a.ret ?? -Infinity));
    const r2 = n => Math.round(n * 100) / 100;
    const totalValue       = rows.reduce((s, r) => s + (r.value || 0), 0);
    const totalContributed = rows.reduce((s, r) => s + (r.contributed || 0), 0);
    const totalPnl         = rows.reduce((s, r) => s + (r.pnl || 0), 0);
    const totalFees        = rows.reduce((s, r) => s + (r.fees || 0), 0);   // cumulative trading costs (tax)
    const totalReturn      = totalContributed ? totalPnl / totalContributed * 100 : 0;

    // ── DEBT-RECYCLING READINESS (whole portfolio) ─────────────────────────────
    // The real question: is the WHOLE portfolio earning enough, consistently, to safely
    // service borrowed money? Annualise the return and compare to a ~6% debt-cost hurdle,
    // but require a real track record (time) before ever saying "ready" — 2 good months
    // is not proof. Honest, conservative tiers.
    let daysLive = 60;
    try { const c = boringEtf.getState().createdAt; if (c) daysLive = Math.max(1, (Date.now() - new Date(c).getTime()) / 86400000); } catch {}
    const annualised = totalReturn * (365 / daysLive);
    const HURDLE = 6;                                  // ~cost of the debt you'd recycle into
    let readiness;
    if (totalPnl <= 0)            readiness = { tier: 'NOT READY',  color: 'red',   note: 'Portfolio is not profitable — do NOT risk borrowed money.' };
    else if (annualised < HURDLE) readiness = { tier: 'PROVING',   color: 'amber', note: `Profitable but ~${annualised.toFixed(0)}%/yr is below the ~${HURDLE}% debt cost.` };
    else if (daysLive < 180)      readiness = { tier: 'PROMISING',  color: 'amber', note: `Beating the ${HURDLE}% hurdle (~${annualised.toFixed(0)}%/yr) but only ${Math.round(daysLive)}d of track record — needs a full cycle.` };
    else                          readiness = { tier: 'READY (review)', color: 'green', note: `~${annualised.toFixed(0)}%/yr over ${Math.round(daysLive)}d, above the ${HURDLE}% debt cost. Review drawdown before committing.` };

    res.json({
        rows,
        totalValue: r2(totalValue),
        totalContributed: r2(totalContributed),
        totalStart: totalContributed,                     // back-compat: UI reads totalStart
        totalPnl: r2(totalPnl),                           // the honest number
        totalFees: r2(totalFees),                         // all fees paid to date — tax-deductible
        totalReturn: r2(totalReturn),
        readiness: { ...readiness, annualised: r2(annualised), daysLive: Math.round(daysLive), hurdle: HURDLE },
        equalCapital: true,
    });
});

app.get('/data/health', authCheck, (req, res) => {
    try {
        const health = adaptiveTuner.getHealth();
        res.json(health);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Retire MEXC fully: zero its paper account AND wipe the equity-curve history
// so the combined chart restarts clean without a misleading MEXC drop-off.
app.post('/data/mexc/reset', authCheck, (req, res) => {
    try {
        const result = mexcPaper.resetPaper(0);     // zero balance — no longer counted anywhere
        const perf   = require('./performanceTracker').reset();  // clean equity curve restart
        log('🔄 MEXC retired — paper account zeroed + equity curve reset for a clean restart');
        res.json({ success: true, mexc: result, perf });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Alpaca cleanup: (1) relabel orphaned congressional copies out of the stock
// scanner bucket, (2) sweep worthless dust fragments, (3) cut named losers.
app.post('/data/alpaca/cleanup', authCheck, async (req, res) => {
    const out = { relabeled: 0, dustSwept: [], losersCut: [], errors: [] };
    try {
        // 1. Relabel reconciled congressional copies: 'stocks' → 'politico'
        out.relabeled = tradeJournal.recategorizeReconciled('politico', 'stocks').moved;

        // Fetch current broker positions + open orders (orders lock share qty)
        const [posRes, ordRes] = await Promise.all([
            axios.get(`${BASE}/positions`, { headers: HEADERS, timeout: 15000 }),
            axios.get(`${BASE}/orders?status=open&limit=100`, { headers: HEADERS, timeout: 15000 }),
        ]);
        const positions = posRes.data;
        const openOrders = ordRes.data || [];

        // Cancel any open order on a target symbol so the shares become sellable
        const freeUpShares = async (sym) => {
            const blocking = openOrders.filter(o => o.symbol.toUpperCase() === sym.toUpperCase());
            for (const o of blocking) {
                try { await axios.delete(`${BASE}/orders/${o.id}`, { headers: HEADERS }); }
                catch (e) { out.errors.push(`cancel ${sym} order: ${e.response?.data?.message || e.message}`); }
            }
        };

        // Close a whole position (market order; queues if market closed, fills at open)
        const closePosition = async (sym) => {
            const held = positions.find(p => p.symbol.toUpperCase() === sym.toUpperCase());
            if (!held) return null;
            await freeUpShares(held.symbol);
            await axios.delete(`${BASE}/positions/${encodeURIComponent(held.symbol)}`, { headers: HEADERS });
            return parseFloat(held.unrealized_pl || 0);
        };

        // 2. Sweep dust — equity positions worth < $1 (worthless fragments)
        const dust = positions.filter(p =>
            p.asset_class === 'us_equity' && Math.abs(parseFloat(p.market_value || 0)) < 1);
        for (const p of dust) {
            try { await closePosition(p.symbol); out.dustSwept.push(p.symbol); }
            catch (e) { out.errors.push(`dust ${p.symbol}: ${e.response?.data?.message || e.message}`); }
        }

        // 3. Cut the congressional losers
        const losers = (req.body?.cut || ['STE', 'T', 'IBM']);
        for (const sym of losers) {
            try {
                const pnl = await closePosition(sym);
                if (pnl !== null) out.losersCut.push({ symbol: sym, pnl });
            } catch (e) { out.errors.push(`cut ${sym}: ${e.response?.data?.message || e.message}`); }
        }

        log(`🧹 Alpaca cleanup — relabeled ${out.relabeled} | dust swept ${out.dustSwept.length} | losers cut ${out.losersCut.length}`);
        res.json({ success: true, ...out });
    } catch (e) {
        res.status(500).json({ error: e.message, partial: out });
    }
});

app.get('/data/asian/paper', authCheck, (req, res) => {
    try {
        const state = asianPaper.getState();
        // Enrich positions array for frontend
        const positions = Object.entries(state.positions || {}).map(([sym, pos]) => ({
            symbol:       sym,
            name:         pos.name,
            market:       pos.market,
            entryPrice:   pos.entryPrice,
            currentPrice: pos.currentPrice || pos.entryPrice,
            pnlPct:       pos.pnlPct ?? 0,
            pnlDollar:    pos.pnlDollar ?? 0,
            entryDate:    pos.entryDate,
            score:        pos.score,
            entryChange:  pos.entryChange,
        }));
        res.json({
            balance:        state.balance,
            startingBalance: state.startingBalance,
            positions,
            stats:          state.stats,
            closedRecent:   state.closedRecent,
            lastScan:       state.lastScan,
        });
    } catch (err) {
        res.status(500).json({ error: err.message, positions: [], balance: 0 });
    }
});

app.post('/admin/reset-asian-paper', authCheck, (req, res) => {
    const startingBalance = parseFloat(req.body.startingBalance) || 2000;
    const result = asianPaper.resetPaper(startingBalance);
    log(`🔄 Asia Paper account reset to $${startingBalance}`);
    res.json(result);
});

app.get('/data/politico', authCheck, (req, res) => {
    if (lastPoliticoData) {
        res.json(lastPoliticoData);
    } else {
        res.json({ loading: true });
    }
});

app.get('/data/politico/vips', authCheck, (req, res) => {
    res.json(politicoVips.getVipData());
});

app.get('/data/politico/followups', authCheck, (req, res) => {
    res.json(politico.getFollowupLearnings());
});

app.get('/data/politico/feed', authCheck, (req, res) => {
    if (lastPoliticoData?.tradeFeed) res.json(lastPoliticoData.tradeFeed);
    else res.json([]);
});

// Lookup a congressional trade: current price, P&L since trade date, news, research
app.get('/data/politico/trade-detail', authCheck, async (req, res) => {
    const { ticker, date } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    try {
        const stocks = require('./stocks');
        const [snapshots, news, rsiMap] = await Promise.all([
            stocks.getSnapshots([ticker]),
            stocks.getNews(ticker),
            stocks.getBatchRSI([ticker]),
        ]);
        const snap = snapshots[ticker];
        const currentPrice = snap?.latestTrade?.p || snap?.dailyBar?.c || null;
        const prevClose    = snap?.prevDailyBar?.c || null;
        const todayChange  = currentPrice && prevClose ? ((currentPrice - prevClose) / prevClose * 100) : 0;

        // Try to get price at trade date from daily bars
        let tradePrice = null;
        let pnlPct = null;
        if (date) {
            try {
                const barsRes = await axios.get(`https://data.alpaca.markets/v2/stocks/${ticker}/bars`, {
                    headers: { 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY },
                    params: { timeframe: '1Day', start: date + 'T00:00:00Z', limit: 3 },
                });
                const bars = barsRes.data.bars || [];
                if (bars.length) tradePrice = bars[0].c; // close on trade date
            } catch {}
        }
        if (tradePrice && currentPrice) {
            pnlPct = ((currentPrice - tradePrice) / tradePrice * 100);
        }

        const sentiment = stocks.newsSentiment(news);
        const headlines = (news || []).slice(0, 6).map(n => ({
            title: n.headline || n.title || '',
            source: n.source || '',
            date: (n.created_at || n.publishedAt || '').slice(0, 10),
        }));

        // Get follow-up data if available
        const followupData = politico.getFollowupLearnings();
        const followups = (followupData.completed || []).filter(f => f.ticker === ticker).slice(-3);
        const polScore = (followupData.scores || {})[req.query.politician] || null;

        res.json({
            ticker,
            currentPrice,
            tradePrice,
            todayChange: parseFloat(todayChange.toFixed(2)),
            pnlPct: pnlPct !== null ? parseFloat(pnlPct.toFixed(2)) : null,
            pnlDirection: pnlPct > 0 ? 'profit' : pnlPct < 0 ? 'loss' : 'flat',
            rsi: rsiMap[ticker] ?? null,
            sentiment,
            headlines,
            followups,
            polScore,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/data/wheel', authCheck, (req, res) => {
    if (lastWheelData) {
        res.json(lastWheelData);
    } else {
        res.json({ loading: true });
    }
});

app.get('/data/risky', authCheck, (req, res) => {
    res.json(lastRiskyData || { loading: true });
});

app.get('/data/journal', authCheck, (req, res) => {
    res.json({
        stats:    tradeJournal.getStats(),
        open:     tradeJournal.getOpenTrades(),
        recent:   tradeJournal.getRecentClosed(30),
        weights:  tradeJournal.loadWeights(),
    });
});

// ── KPI Status (live trading readiness) ──────────────────────────────────────
app.get('/data/kpi', authCheck, (req, res) => {
    const kpi = tradeJournal.getKpiStatus();
    const perfTracker = require('./performanceTracker');
    const riskMgr = require('./riskManager');

    // Add drawdown info
    const history = perfTracker.getHistory(720);
    const drawdown = riskMgr.calculateDrawdown(history);

    res.json({
        ...kpi,
        drawdown,
    });
});

// ── Risk Status (alerts and warnings) ────────────────────────────────────────
app.get('/data/risk', authCheck, (req, res) => {
    const kpi = tradeJournal.getKpiStatus();
    const perfTracker = require('./performanceTracker');
    const riskMgr = require('./riskManager');

    const history = perfTracker.getHistory(720);
    const drawdown = riskMgr.calculateDrawdown(history);

    const stats = {
        dailyLoss: 0, // would need to track from closed trades
        openPositions: kpi.metrics?.openPositions || 0,
        winRate: kpi.winRate || 0,
        drawdown,
    };

    const riskStatus = riskMgr.evaluateRiskStatus(stats);
    res.json(riskStatus);
});

// ── Manual Trading (routes to our own paper ledger, fees included) ────────────

// Last traded price from Alpaca's market-data feed (data only — no orders).
async function livePrice(symbol) {
    try {
        const r = await axios.get('https://data.alpaca.markets/v2/stocks/snapshots', {
            headers: HEADERS, params: { symbols: symbol, feed: 'iex' }, timeout: 8000,
        });
        const s = r.data?.[symbol];
        return s?.latestTrade?.p || s?.dailyBar?.c || null;
    } catch { return null; }
}

app.post('/trade/buy', authCheck, async (req, res) => {
    try {
        const { symbol, amount } = req.body;
        if (!symbol || !amount) return res.status(400).json({ error: 'symbol + amount required' });
        const sym = symbol.toUpperCase();
        const price = await livePrice(sym);
        if (!price) return res.status(400).json({ error: `no live price for ${sym}` });

        const r = paperBroker.buy('stocks', sym, { notional: parseFloat(amount), price });
        if (!r.success) return res.status(400).json({ error: r.error });

        tradeJournal.recordEntry({
            symbol: sym, side: 'buy', qty: r.qty, price,
            strategy: 'stocks', tier: 'MEDIUM', score: 0,
            signals: {}, indicators: {}, reason: 'manual buy',
        });
        log(`🛒 Manual BUY ${sym} $${amount} @ $${price} (fee $${r.fee.toFixed(2)})`);
        res.json({ success: true, filled: { symbol: sym, qty: r.qty, price, fee: r.fee } });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/trade/sell', authCheck, async (req, res) => {
    try {
        const { symbol, qty, percent } = req.body;
        if (!symbol) return res.status(400).json({ error: 'symbol required' });
        const sym = symbol.toUpperCase();
        const price = await livePrice(sym);
        if (!price) return res.status(400).json({ error: `no live price for ${sym}` });

        const pos = paperBroker.getPositions('stocks').find(p => paperBroker.norm(p.symbol) === paperBroker.norm(sym));
        if (!pos) return res.status(400).json({ error: `no position in ${sym}` });

        const sellQty = qty ? Math.min(parseFloat(qty), pos.qty)
                            : pos.qty * (parseFloat(percent || 100) / 100);
        if (!(sellQty > 0)) return res.status(400).json({ error: 'nothing to sell' });

        const r = paperBroker.sell('stocks', sym, { qty: sellQty, price, reason: 'manual sell' });
        if (!r.success) return res.status(400).json({ error: r.error });

        tradeJournal.recordExit(sym, price, 'manual sell');
        log(`💰 Manual SELL ${sym} qty=${sellQty.toFixed(4)} @ $${price} → P&L $${r.pnl} (fee $${r.fee.toFixed(2)})`);
        res.json({ success: true, filled: { symbol: sym, qty: sellQty, price, fee: r.fee, pnl: r.pnl } });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/trade/cancel', authCheck, async (req, res) => {
    try {
        const { order_id } = req.body;
        if (!order_id) return res.status(400).json({ error: 'order_id required' });
        await axios.delete(`${BASE}/orders/${order_id}`, { headers: HEADERS });
        log(`❌ Cancelled order ${order_id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.response?.data?.message || err.message });
    }
});

app.post('/admin/cancel-all-orders', authCheck, async (req, res) => {
    try {
        const result = await axios.delete(`${BASE}/orders`, { headers: HEADERS });
        const cancelled = Array.isArray(result.data) ? result.data.length : '?';
        log(`🚨 Admin: cancelled all open orders (${cancelled})`);
        res.json({ success: true, cancelled });
    } catch (err) {
        res.status(400).json({ error: err.response?.data?.message || err.message });
    }
});

app.get('/data/portfolio', authCheck, async (req, res) => {
    try {
        log('📊 Fetching portfolio data...');

        const [accRes, posRes, ordRes, actRes] = await Promise.all([
            axios.get(`${BASE}/account`, { headers: HEADERS, timeout: 8000 }).catch(e => {
                log(`⚠ Account fetch failed: ${e.message}`);
                return { data: { equity: 0, cash: 0, portfolio_value: 0, buying_power: 0, last_equity: 0, pattern_day_trader: false, daytrade_count: 0, status: 'error' } };
            }),
            axios.get(`${BASE}/positions`, { headers: HEADERS, timeout: 8000 }).catch(e => {
                log(`⚠ Positions fetch failed: ${e.message}`);
                return { data: [] };
            }),
            axios.get(`${BASE}/orders?status=open&limit=50`, { headers: HEADERS, timeout: 8000 }).catch(e => {
                log(`⚠ Orders fetch failed: ${e.message}`);
                return { data: [] };
            }),
            axios.get(`${BASE}/account/activities?activity_types=FILL&direction=desc&page_size=20`, { headers: HEADERS, timeout: 8000 }).catch(e => {
                log(`⚠ Activities fetch failed: ${e.message}`);
                return { data: [] };
            }),
        ]);

        const acc = accRes.data || {};
        const positions = (posRes.data || []).map(p => ({
            symbol: p.symbol,
            qty: parseFloat(p.qty),
            side: p.side,
            avg_entry: parseFloat(p.avg_entry_price),
            current_price: parseFloat(p.current_price),
            market_value: parseFloat(p.market_value),
            unrealized_pl: parseFloat(p.unrealized_pl),
            unrealized_plpc: parseFloat(p.unrealized_plpc) * 100,
            change_today: parseFloat(p.change_today) * 100,
        }));

        const orders = (ordRes.data || []).map(o => ({
            id: o.id,
            symbol: o.symbol,
            side: o.side,
            type: o.type,
            qty: o.qty || o.notional,
            status: o.status,
            submitted_at: o.submitted_at,
            time_in_force: o.time_in_force,
            limit_price: o.limit_price,
            stop_price: o.stop_price,
        }));

        const recentFills = (actRes.data || []).map(a => ({
            symbol: a.symbol,
            side: a.side,
            qty: a.qty,
            price: a.price,
            timestamp: a.transaction_time,
        }));

        log(`✓ Portfolio data ready: ${positions.length} positions, ${orders.length} orders`);

        res.json({
            account: {
                equity: parseFloat(acc.equity || 0),
                cash: parseFloat(acc.cash || 0),
                portfolio_value: parseFloat(acc.portfolio_value || 0),
                buying_power: parseFloat(acc.buying_power || 0),
                day_pl: (parseFloat(acc.equity || 0) - parseFloat(acc.last_equity || 0)),
                day_pl_pct: (parseFloat(acc.last_equity || 0) > 0 ? ((parseFloat(acc.equity || 0) - parseFloat(acc.last_equity || 0)) / parseFloat(acc.last_equity || 0) * 100) : 0),
                pattern_day_trader: acc.pattern_day_trader || false,
                daytrade_count: acc.daytrade_count || 0,
                status: acc.status || 'unknown',
            },
            positions,
            orders,
            recentFills,
        });
    } catch (err) {
        log(`✗ Portfolio error: ${err.message}`);
        res.json({
            account: { equity: 0, cash: 0, portfolio_value: 0, buying_power: 0, day_pl: 0, day_pl_pct: 0, status: 'error' },
            positions: [],
            orders: [],
            recentFills: [],
            error: `Temporary issue: ${err.message}`
        });
    }
});

app.get('/data/stock/:symbol', authCheck, async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const fmpKey = process.env.FMP_API_KEY;

        // Fetch position from Alpaca (may 404 if not held)
        let position = null;
        try {
            const posRes = await axios.get(`${BASE}/positions/${symbol}`, { headers: HEADERS });
            position = posRes.data;
        } catch {}

        // Try FMP for quote + profile
        let quote = null, profile = null;
        if (fmpKey) {
            try {
                const r = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${fmpKey}`, { timeout: 8000 });
                if (Array.isArray(r.data) && r.data[0]) quote = r.data[0];
            } catch {}
            try {
                const r = await axios.get(`https://financialmodelingprep.com/api/v3/profile/${symbol}?apikey=${fmpKey}`, { timeout: 8000 });
                if (Array.isArray(r.data) && r.data[0]) profile = r.data[0];
            } catch {}
        }

        // Fallback: Yahoo Finance v8 chart
        if (!quote) {
            try {
                const r = await axios.get(
                    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
                    { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
                );
                const meta = r.data?.chart?.result?.[0]?.meta;
                const closes = r.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
                const highs = r.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.high || [];
                const lows = r.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.low || [];
                const volumes = r.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.volume || [];
                if (meta) {
                    const price = meta.regularMarketPrice;
                    const prevClose = closes.length >= 2 ? closes[closes.length - 2] : meta.chartPreviousClose;
                    quote = {
                        price, previousClose: prevClose,
                        change: prevClose ? price - prevClose : 0,
                        changesPercentage: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
                        dayHigh: highs.length ? highs[highs.length - 1] : null,
                        dayLow: lows.length ? lows[lows.length - 1] : null,
                        volume: volumes.length ? volumes[volumes.length - 1] : null,
                        yearHigh: meta.fiftyTwoWeekHigh, yearLow: meta.fiftyTwoWeekLow,
                        marketCap: null, pe: null, eps: null, avgVolume: null,
                    };
                }
            } catch {}
        }

        // Get news from ingestion
        let news = [];
        try {
            const { articles } = await ingestion.ingestAll();
            const structured = ingestion.getStructuredEvents(articles);
            if (structured[symbol]) news = structured[symbol].events.slice(0, 5);
        } catch {}

        res.json({
            symbol,
            quote: quote ? {
                price: quote.price, change: quote.change, changesPercentage: quote.changesPercentage,
                dayHigh: quote.dayHigh, dayLow: quote.dayLow, open: quote.open, previousClose: quote.previousClose,
                volume: quote.volume, avgVolume: quote.avgVolume, marketCap: quote.marketCap,
                pe: quote.pe, eps: quote.eps, yearHigh: quote.yearHigh, yearLow: quote.yearLow,
            } : null,
            profile: profile ? {
                name: profile.companyName, sector: profile.sector, industry: profile.industry,
                description: (profile.description || '').slice(0, 200), exchange: profile.exchangeShortName,
                beta: profile.beta, volAvg: profile.volAvg,
            } : null,
            position: position ? {
                qty: parseFloat(position.qty), avg_entry: parseFloat(position.avg_entry_price),
                current_price: parseFloat(position.current_price), unrealized_pl: parseFloat(position.unrealized_pl),
                unrealized_plpc: parseFloat(position.unrealized_plpc) * 100,
            } : null,
            news,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Stock chart endpoint ─────────────────────────────────────────────────────
app.get('/data/stock/:symbol/chart', authCheck, async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const range = req.query.range || '1mo';
        // Map range to Yahoo interval
        const intervalMap = { '1d':'5m', '5d':'15m', '1mo':'1d', '3mo':'1d', '6mo':'1d', '1y':'1wk', '5y':'1mo' };
        const interval = intervalMap[range] || '1d';
        const r = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`,
            { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const result = r.data?.chart?.result?.[0];
        if (!result) return res.json({ points: [] });
        const times = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const volumes = result.indicators?.quote?.[0]?.volume || [];
        const points = times.map((t, i) => ({ t: t * 1000, c: closes[i], v: volumes[i] })).filter(p => p.c != null);
        res.json({ symbol, range, points });
    } catch (err) {
        res.status(500).json({ error: err.message, points: [] });
    }
});

// ── Coin chart endpoint ─────────────────────────────────────────────────────
app.get('/data/coin/:symbol/chart', authCheck, async (req, res) => {
    try {
        const sym = req.params.symbol.toUpperCase().replace('USDT','');
        const pair = sym + 'USDT';
        const range = req.query.range || '1d';
        // Map range to MEXC kline intervals and limits
        const cfg = { '1h':['1m',60], '4h':['5m',48], '1d':['15m',96], '7d':['1h',168], '30d':['4h',180], '90d':['1d',90] };
        const [interval, limit] = cfg[range] || ['1h', 168];
        const r = await axios.get(`https://api.mexc.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`, { timeout: 8000 });
        const points = (r.data || []).map(k => ({ t: k[0], c: +k[4], v: +k[5] }));
        res.json({ symbol: sym, range, points });
    } catch (err) {
        res.status(500).json({ error: err.message, points: [] });
    }
});

// ── Crypto coin detail endpoint ──────────────────────────────────────────────
app.get('/data/coin/:symbol', authCheck, async (req, res) => {
    try {
        const sym = req.params.symbol.toUpperCase().replace('USDT','');
        const pair = sym + 'USDT';

        // 24hr ticker
        let ticker = null;
        try {
            const r = await axios.get(`https://api.mexc.com/api/v3/ticker/24hr?symbol=${pair}`, { timeout: 8000 });
            ticker = r.data;
        } catch {}

        // Klines for mini chart data (30 x 1h candles)
        let klines = [];
        try {
            const r = await axios.get(`https://api.mexc.com/api/v3/klines?symbol=${pair}&interval=1h&limit=30`, { timeout: 8000 });
            klines = (r.data || []).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
        } catch {}

        // Paper position
        let position = null;
        try {
            const state = mexcPaper.getState();
            const pos = (state.positions || []).find(p => p.symbol === pair);
            if (pos) {
                const curPrice = ticker ? parseFloat(ticker.lastPrice) : pos.entryPrice;
                const pl = (curPrice - pos.entryPrice) * pos.qty;
                const plPct = ((curPrice - pos.entryPrice) / pos.entryPrice) * 100;
                position = {
                    qty: pos.qty, avg_entry: pos.entryPrice, current_price: curPrice,
                    unrealized_pl: pl, unrealized_plpc: plPct, notional: pos.notional,
                    entryMomentum: pos.entryMomentum, scaleIns: pos.scaleIns || 0,
                    tp: pos.tp, sl: pos.sl, highWatermark: pos.highWatermark,
                };
            }
        } catch {}

        // CoinGecko for extra info (market cap, description) - best effort
        let geckoData = null;
        try {
            const cgMap = { BTC:'bitcoin', ETH:'ethereum', SOL:'solana', DOGE:'dogecoin', XRP:'ripple',
                ADA:'cardano', AVAX:'avalanche-2', DOT:'polkadot', LINK:'chainlink', MATIC:'matic-network',
                SHIB:'shiba-inu', PEPE:'pepe', FLOKI:'floki', WIF:'dogwifcoin', BONK:'bonk',
                UNI:'uniswap', AAVE:'aave', MKR:'maker', SUSHI:'sushi', COMP:'compound-governance-token',
                LTC:'litecoin', BCH:'bitcoin-cash', NEAR:'near', APT:'aptos', SUI:'sui',
                ARB:'arbitrum', OP:'optimism', INJ:'injective-protocol', TIA:'celestia',
                MSTR:'mstr', COIN:'coinbase', BNB:'binancecoin' };
            const id = cgMap[sym];
            if (id) {
                const r = await axios.get(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`, { timeout: 6000 });
                geckoData = {
                    name: r.data.name, marketCapRank: r.data.market_cap_rank,
                    marketCap: r.data.market_data?.market_cap?.usd,
                    totalVolume: r.data.market_data?.total_volume?.usd,
                    ath: r.data.market_data?.ath?.usd,
                    athDate: r.data.market_data?.ath_date?.usd,
                    athChange: r.data.market_data?.ath_change_percentage?.usd,
                    description: (r.data.description?.en || '').replace(/<[^>]*>/g,'').slice(0, 200),
                    categories: (r.data.categories || []).slice(0, 3),
                    image: r.data.image?.small,
                };
            }
        } catch {}

        const price = ticker ? parseFloat(ticker.lastPrice) : null;
        const change = ticker ? parseFloat(ticker.priceChangePercent) : null;
        res.json({
            symbol: sym, pair,
            quote: ticker ? {
                price, change: parseFloat(ticker.priceChange),
                changesPercentage: change,
                dayHigh: parseFloat(ticker.highPrice), dayLow: parseFloat(ticker.lowPrice),
                open: parseFloat(ticker.openPrice), volume: parseFloat(ticker.volume),
                quoteVolume: parseFloat(ticker.quoteVolume), trades: parseInt(ticker.count),
            } : null,
            profile: geckoData,
            position,
            klines,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── IBKR endpoints ───────────────────────────────────────────────────────────
app.get('/data/ibkr/status', authCheck, async (req, res) => {
    if (!ibkr.isConfigured()) return res.json({ configured: false, message: 'Set IBKR_GATEWAY_URL + IBKR_ACCOUNT_ID' });
    const auth = await ibkr.checkAuth();
    res.json({ configured: true, ...auth });
});

app.get('/data/ibkr/positions', authCheck, async (req, res) => {
    if (!ibkr.isConfigured()) return res.json({ configured: false, positions: [] });
    res.json({ positions: await ibkr.getPositions() });
});

app.get('/data/ibkr/orders', authCheck, async (req, res) => {
    if (!ibkr.isConfigured()) return res.json({ configured: false, orders: [] });
    res.json({ orders: await ibkr.getOrders() });
});

app.get('/data/ibkr/summary', authCheck, async (req, res) => {
    if (!ibkr.isConfigured()) return res.json({ configured: false });
    res.json(await ibkr.getAccountSummary() || { error: 'Failed to fetch' });
});

app.post('/trade/ibkr/buy', authCheck, async (req, res) => {
    const { symbol, qty, type, price } = req.body;
    if (!symbol || !qty) return res.status(400).json({ error: 'symbol + qty required' });
    const conid = await ibkr.resolveConid(symbol);
    if (!conid) return res.status(400).json({ error: `Could not find IBKR contract for ${symbol}` });
    const result = await ibkr.placeOrder(conid, 'BUY', qty, type === 'limit' ? 'LMT' : 'MKT', price);
    if (result.success) log(`🌏 IBKR BUY ${symbol} qty=${qty}`);
    res.json(result);
});

app.post('/trade/ibkr/sell', authCheck, async (req, res) => {
    const { symbol, qty, type, price } = req.body;
    if (!symbol || !qty) return res.status(400).json({ error: 'symbol + qty required' });
    const conid = await ibkr.resolveConid(symbol);
    if (!conid) return res.status(400).json({ error: `Could not find IBKR contract for ${symbol}` });
    const result = await ibkr.placeOrder(conid, 'SELL', qty, type === 'limit' ? 'LMT' : 'MKT', price);
    if (result.success) log(`🌏 IBKR SELL ${symbol} qty=${qty}`);
    res.json(result);
});

// ── Portfolio history (Alpaca) ───────────────────────────────────────────────
app.get('/data/portfolio-history', authCheck, async (req, res) => {
    try {
        const period = req.query.period || '1M';
        const timeframe = req.query.timeframe || '1D';
        const today = new Date().toISOString().split('T')[0];

        log(`📊 Portfolio history request: period=${period}, timeframe=${timeframe}`);

        const r = await axios.get(`${BASE}/account/portfolio/history`, {
            headers: HEADERS, timeout: 10000,
            params: { period, timeframe, date_end: today, extended_hours: true },
        });

        log(`✓ Portfolio history fetched: ${r.data.timestamp?.length || 0} points`);

        // Also fetch current account to append live data point
        try {
            const acct = await axios.get(`${BASE}/account`, { headers: HEADERS, timeout: 8000 });
            const equity = parseFloat(acct.data.equity);
            const lastEquity = parseFloat(acct.data.last_equity);
            const data = r.data;
            if (data.timestamp && data.equity) {
                const nowTs = Math.floor(Date.now() / 1000);
                const lastTs = data.timestamp[data.timestamp.length - 1] || 0;
                // If last data point is older than 4 hours, append live
                if (nowTs - lastTs > 4 * 3600) {
                    data.timestamp.push(nowTs);
                    data.equity.push(equity);
                    data.profit_loss.push(equity - lastEquity);
                    data.profit_loss_pct.push(lastEquity > 0 ? (equity - lastEquity) / lastEquity : 0);
                }
            }
            res.json(data);
        } catch (e) {
            log(`⚠ Could not fetch live account data: ${e.message}`);
            res.json(r.data);
        }
    } catch (err) {
        const errorMsg = err.response?.data?.message || err.message;
        log(`✗ Portfolio history error: ${errorMsg}`);
        // Return empty data instead of 500 so dashboard doesn't break
        res.json({
            timestamp: [Math.floor(Date.now() / 1000)],
            equity: [0],
            profit_loss: [0],
            profit_loss_pct: [0],
            error: `Alpaca API unavailable: ${errorMsg}`
        });
    }
});

// ── Combined performance history (all strategies over time) ──────────────────
app.get('/data/performance', authCheck, (req, res) => {
    try {
        res.json({
            summary: perfTracker.getSummary(),
            history: perfTracker.getHistory(parseInt(req.query.limit) || 720),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── MEXC endpoints ──────────────────────────────────────────────────────────
app.get('/data/mexc/paper', authCheck, (req, res) => {
    try {
        const state = mexcPaper.getState();
        const positions = [];

        if (state.positions && typeof state.positions === 'object') {
            for (const [sym, pos] of Object.entries(state.positions)) {
                // getState() now pre-computes currentPrice + pnlPct from stored scan data
                const currentPrice = pos.currentPrice || pos.entryPrice || 0;
                const pnlPct = pos.pnlPct != null ? pos.pnlPct
                    : (pos.entryPrice ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0);
                const qty = pos.qty || 0;
                positions.push({
                    symbol: sym, category: pos.category || 'unknown',
                    entryPrice: pos.entryPrice || 0, currentPrice,
                    qty, pnlPct: parseFloat(pnlPct.toFixed ? pnlPct.toFixed(2) : pnlPct),
                    pnlDollar: parseFloat((qty * (currentPrice - (pos.entryPrice || 0))).toFixed(2)),
                    entryDate: pos.entryDate || '', entryMomentum: pos.entryMomentum || 0, score: pos.score || 0,
                });
            }
        }

        res.json({
            positions,
            balance: state.balance || 0,
            stats: state.stats || {},
            closedRecent: state.closedRecent || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message, positions: [], balance: 0 });
    }
});

app.get('/data/mexc/scan', authCheck, async (req, res) => {
    try {
        const [watchlist, movers] = await Promise.all([
            mexc.scanWatchlist(),
            mexc.getTopMovers(10),
        ]);
        res.json({ ...watchlist, movers, configured: mexc.isConfigured() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/data/mexc/account', authCheck, async (req, res) => {
    if (!mexc.isConfigured()) return res.json({ configured: false, message: 'Set MEXC_API_KEY + MEXC_SECRET_KEY' });
    const account = await mexc.getAccount();
    const orders = await mexc.getOpenOrders();
    res.json({ configured: true, account, orders });
});

app.get('/data/mexc/ticker/:symbol', authCheck, async (req, res) => {
    const ticker = await mexc.get24hTicker(req.params.symbol.toUpperCase());
    if (!ticker) return res.status(404).json({ error: 'Not found' });
    const klines = await mexc.getKlines(req.params.symbol.toUpperCase(), '1h', 24);
    res.json({ ticker, klines });
});

app.post('/trade/mexc/buy', authCheck, async (req, res) => {
    const { symbol, amount, type, price } = req.body;
    if (!symbol || !amount) return res.status(400).json({ error: 'symbol + amount required' });
    const result = await mexc.placeOrder(symbol.toUpperCase(), 'BUY', amount, type === 'limit' ? 'LIMIT' : 'MARKET', price);
    if (result.success) log(`🪙 MEXC BUY ${symbol} $${amount}`);
    res.json(result);
});

app.post('/trade/mexc/sell', authCheck, async (req, res) => {
    const { symbol, quantity, type, price } = req.body;
    if (!symbol || !quantity) return res.status(400).json({ error: 'symbol + quantity required' });
    const result = await mexc.placeOrder(symbol.toUpperCase(), 'SELL', quantity, type === 'limit' ? 'LIMIT' : 'MARKET', price);
    if (result.success) log(`🪙 MEXC SELL ${symbol} qty=${quantity}`);
    res.json(result);
});

// ── MEXC Paper manual trades ────────────────────────────────────────────────
app.post('/trade/mexc/paper/buy', authCheck, async (req, res) => {
    const { symbol, amount } = req.body;
    if (!symbol || !amount) return res.status(400).json({ error: 'symbol + amount required' });
    const result = await mexcPaper.manualBuy(symbol, parseFloat(amount));
    if (result.success) log(`🪙 MEXC PAPER BUY ${symbol} $${amount}`);
    res.json(result);
});

app.post('/trade/mexc/paper/sell', authCheck, async (req, res) => {
    const { symbol, pct } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const result = await mexcPaper.manualSell(symbol, parseFloat(pct || 100));
    if (result.success) log(`🪙 MEXC PAPER SELL ${symbol} ${pct || 100}%`);
    res.json(result);
});

app.post('/trade/mexc/paper/liquidate', authCheck, async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const result = await mexcPaper.manualSell(symbol.toUpperCase(), 100);
    if (result.success) log(`🔥 MEXC PAPER LIQUIDATE ${symbol} 100%`);
    res.json(result);
});

app.post('/admin/reset-mexc-paper', authCheck, (req, res) => {
    const startingBalance = parseFloat(req.body.startingBalance) || 1000;
    const result = mexcPaper.resetPaper(startingBalance);
    log(`🔄 MEXC Paper account reset to $${startingBalance}`);
    res.json(result);
});

app.get('/data/ingestion', authCheck, async (req, res) => {
    try {
        const result = await ingestion.getFullIngestion();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/data/ml', authCheck, (req, res) => {
    const model = require('./src/ml/model');
    const rlAgent = require('./src/ml/rlAgent');
    res.json({
        openPositions: mlPipeline.getOpenPositions(),
        tradeLog: mlPipeline.getTradeLog(),
        halted: mlPipeline.isHalted(),
        weights: model.loadWeights(),
        rlStats: rlAgent.getStats(),
    });
});

app.post('/data/ml/reset-halt', authCheck, (req, res) => {
    mlPipeline.resetHalt();
    res.json({ success: true, halted: false });
});

app.get('/data/risk', authCheck, (req, res) => {
    // Live risk snapshot — always fresh
    try {
        axios.get(`${BASE}/account`,   { headers: HEADERS }).then(accRes =>
        axios.get(`${BASE}/positions`, { headers: HEADERS }).then(posRes => {
            const portfolioValue = parseFloat(accRes.data.portfolio_value);
            res.json(riskManager.getStatus(portfolioValue, posRes.data));
        })).catch(err => res.status(500).json({ error: err.message }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Proxy copy-trading endpoints so both dashboards are served from port 3000
app.get('/copy-data', authCheck, async (req, res) => {
    try {
        const r = await axios.get(`http://localhost:3001/data?pin=${PIN}`, { timeout: 8000 });
        res.json(r.data);
    } catch {
        res.json({ error: 'Copy trading bot is not running' });
    }
});

app.get('/copy-history', authCheck, async (req, res) => {
    try {
        const r = await axios.get(`http://localhost:3001/history?pin=${PIN}`, { timeout: 30000 });
        res.json(r.data);
    } catch {
        res.json({ error: 'Copy trading bot is not running' });
    }
});

app.get('/copy-portfolio', authCheck, async (req, res) => {
    try {
        const r = await axios.get(`http://localhost:3001/portfolio?pin=${PIN}`, { timeout: 15000 });
        res.json(r.data);
    } catch {
        res.json({ error: 'Copy trading bot is not running' });
    }
});

app.post('/copy-mirror', authCheck, async (req, res) => {
    try {
        const r = await axios.post(`http://localhost:3001/mirror?pin=${PIN}`, req.body, { timeout: 10000 });
        res.json(r.data);
    } catch {
        res.json({ error: 'Copy trading bot is not running' });
    }
});

// ── Market hours check (US Eastern time) ─────────────────────────────────────

function isMarketOpen() {
    const now = new Date();
    // Get current time components in America/New_York (handles EST/EDT automatically)
    const ny = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric',
        weekday: 'short', hour12: false,
    }).formatToParts(now);

    const parts = Object.fromEntries(ny.map(p => [p.type, p.value]));
    const day    = parts.weekday;                        // 'Mon'–'Sun'
    const hour   = parseInt(parts.hour,   10);
    const minute = parseInt(parts.minute, 10);

    if (['Sat', 'Sun'].includes(day)) return false;

    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;      // 9:30am–4:00pm ET
}

async function runPoliticoScan() {
    try {
        log('Scanning congressional trades...');
        lastPoliticoData = await politico.scan();
        const { hotSignals = [], autoTrades = [] } = lastPoliticoData;
        const { bigMoney = [], followupResults = [], tradeFeed = [] } = lastPoliticoData;
        log(`Politico scan — ${hotSignals.length} hot | ${bigMoney.length} big$ | ${autoTrades.length} auto | ${followupResults.length} followups | ${tradeFeed.length} feed`);
        if (autoTrades.length) {
            autoTrades.forEach(t => {
                if (t.success && t.type === 'hot') log(`🏛️ HOT auto-bought $${t.ticker} (${t.count} politicians, $${t.notional?.toFixed(0)})`);
                else if (t.success && t.type === 'bigmoney') log(`💰 FOLLOW $${t.ticker} (${t.politician}, $${(t.value/1000).toFixed(0)}K, copied $${t.notional?.toFixed(0)})`);
                else if (t.success && t.type === 'vip-follow') log(`🎯 VIP COPY $${t.ticker} (${t.politician} ${t.accuracy}% acc, copied $${t.notional?.toFixed(0)})${t.cobuys ? ` [CO-BUY x${t.cobuys}]` : ''}`);
                else if (!t.success) log(`✗ Politico auto-buy ${t.ticker} failed: ${t.error}`);
            });
        }

        // Monitor VIP positions for early exit & weight boosting
        try {
            const posRes = await axios.get(`${BASE}/positions`, { headers: HEADERS, timeout: 15000 });
            const monitor = await politico.monitorVipPositions(posRes.data);
            if (monitor.exited > 0 || monitor.boosted > 0) {
                log(`[Politico Monitor] Exited ${monitor.exited} | Boosted weights for ${monitor.boosted}`);
            }
        } catch (e) {
            log(`Politico monitor error: ${e.message}`);
        }

        // Trigger politico learning from follow-up data
        try { require('./tradeJournal').learnFromPolitico(); } catch {}
    } catch (err) {
        log(`Politico scan error: ${err.message}`);
    }
}

async function runBoringEtfScan() {
    try {
        const s = await boringEtf.scan();
        log(`Boring ETF — portfolio $${s.portfolioValue} | invested $${s.invested} | div $${s.dividends.received} (+$${s.dividends.frankingCredits} franking) | return ${s.totalReturn}%`);
    } catch (err) {
        log(`Boring ETF scan error: ${err.message}`);
    }
}

// QUARANTINED pump-ignition experiment — isolated sandbox, never touches portfolio/KPI
// Isolated $10k options/wheel paper trader — real premiums, separate P&L
async function runOptionsLabScan() {
    try {
        const s = await optionsLab.scan();
        const open = Object.keys(s.openPuts).length + Object.keys(s.openCalls).length;
        log(`🎯 Options Lab — $${s.portfolioValue} (${s.totalReturn}%) | premium $${s.premiumCollected} | ${s.trades} closed, ${s.winRate}% WR | ${open} open contracts`);
    } catch (err) {
        log(`Options Lab scan error: ${err.message}`);
    }
}

async function runAsianScan() {
    try {
        log('Scanning Asian markets...');
        lastAsiaData = await asian.scan();
        const ukStocksWithData = (lastAsiaData.uk?.stocks || []).filter(s => s.price).length;
        log(`Asian scan complete — ASX ${lastAsiaData.au?.index?.change ?? '?'}% · Nikkei ${lastAsiaData.jp?.index?.change ?? '?'}% · HSI ${lastAsiaData.cn?.index?.change ?? '?'}% · FTSE ${lastAsiaData.uk?.index?.change ?? '?'}% (${ukStocksWithData}/${lastAsiaData.uk?.stocks?.length ?? 0} UK stocks with data)`);
        // Run paper trader on fresh price data
        try {
            const paperResult = await asianPaper.scan(lastAsiaData);
            if (paperResult) lastAsiaData.paper = paperResult;
        } catch (pe) {
            log(`Asia paper trader error: ${pe.message}`);
        }
    } catch (err) {
        log(`Asian scan error: ${err.message}`);
    }
}

async function runRiskyScan() {
    try {
        log('Scanning high-risk positions...');
        const [accountRes, posRes] = await Promise.all([
            axios.get(`${BASE}/account`,   { headers: HEADERS }),
            axios.get(`${BASE}/positions`, { headers: HEADERS }),
        ]);
        const portfolioValue = parseFloat(accountRes.data.portfolio_value);
        const riskStatus     = riskManager.getStatus(portfolioValue, posRes.data);
        const results        = await risky.scan(riskStatus);
        lastRiskyData        = { riskStatus, results, scannedAt: new Date().toLocaleTimeString() };

        const signals = results.filter(r => r.signal !== 'HOLD');
        if (signals.length) {
            signals.forEach(r => log(`🎲 ${r.signal} ${r.ticker} [${r.type}] score ${r.score} RSI ${r.rsi ?? 'N/A'}`));
        } else {
            log(`Risky scan done — no signals | high avail: $${riskStatus.available.high.toFixed(0)}`);
        }
    } catch (err) {
        log(`Risky scan error: ${err.message}`);
    }
}

async function runWheelScan() {
    try {
        log('Running wheel strategy scan...');
        lastWheelData = await wheel.scan();
        const active = lastWheelData.results.filter(r => r.contract || r.stage === 2);
        log(`Wheel scan complete — ${active.length} active positions | all-time premium: $${lastWheelData.totalPremium.toFixed(2)}`);
        active.forEach(r => {
            const c = r.contract;
            if (c) log(`  🎡 ${r.ticker} [${r.market.toUpperCase()}] Stage ${r.stage} | ${c.type.toUpperCase()} ${c.symbol} | strike $${c.strike} | exp ${c.expiry}`);
        });
    } catch (err) {
        log(`Wheel scan error: ${err.message}`);
    }
}

async function runMexcScan() {
    try {
        log('Scanning MEXC alt/meme/defi...');
        const [watchlist, movers] = await Promise.all([
            mexc.scanWatchlist(),
            mexc.getTopMovers(10),
        ]);
        lastMexcData = { ...watchlist, movers, configured: mexc.isConfigured(), scannedAt: new Date().toISOString() };
        const hotMemes = (watchlist.meme || []).filter(c => c.change > 10);
        log(`MEXC scan done — ${(watchlist.meme||[]).length} meme | ${(watchlist.alt||[]).length} alt | ${(watchlist.defi||[]).length} defi${hotMemes.length ? ` | ${hotMemes.map(c=>c.displaySymbol+' +'+c.change.toFixed(0)+'%').join(', ')}` : ''}`);

        // ── RETIRED: the old MEXC momentum paper-trader is no longer run. ──
        // Its 24h-momentum thesis had no edge (-$64 over weeks). The crypto
        // experiment now lives ONLY in the isolated Pump Lab. The market scan
        // above stays (it feeds the ALT/DEFI info tab); no P&L is generated here.
    } catch (err) {
        log(`MEXC scan error: ${err.message}`);
    }
}

async function runPerfSnapshot() {
    try {
        let alpacaEquity = null;
        let alpacaUnrealized = 0;
        try {
            const acc = await axios.get(`${BASE}/account`, { headers: HEADERS, timeout: 15000 });
            alpacaEquity = parseFloat(acc.data.equity);

            // Calculate unrealized P&L from current positions
            const posRes = await axios.get(`${BASE}/positions`, { headers: HEADERS, timeout: 15000 });
            alpacaUnrealized = posRes.data.reduce((sum, p) => {
                const unrealizedPl = parseFloat(p.unrealized_pl || 0);
                return sum + unrealizedPl;
            }, 0);
        } catch (e) { log(`Perf snapshot: Alpaca equity fetch failed (${e.message}) — carrying forward`); }

        let asianValue = null;
        try { asianValue = asianPaper.getState().stats?.portfolioValue ?? null; } catch {}
        // MEXC retired — no longer included in combined equity.

        const jstats = tradeJournal.getStats();
        const totalUnrealized = alpacaUnrealized + (tradeJournal.calculateUnrealizedPnl() || 0);
        const point = perfTracker.snapshot({
            alpacaEquity, asianValue, mexcValue: null,
            totalClosed: jstats.closedTotal,
            winRate:     jstats.winRate,
            totalPnl:    jstats.totalPnl,
            unrealizedPnl: totalUnrealized,
        });
        if (point) log(`📈 Perf snapshot — combined $${point.combined} (Alpaca $${point.alpacaEquity} · Asia $${point.asianValue})${totalUnrealized ? ` | unrealized $${totalUnrealized.toFixed(2)}` : ''}`);
    } catch (err) {
        log(`Perf snapshot error: ${err.message}`);
    }
}

async function runResearch() {
    try {
        log('Generating research report...');
        const result = await research.generate();
        log(`📊 Research report generated — ${result.signals.sentiment} | crypto: ${result.signals.cryptoView} | VIX: ${result.signals.vixView}`);
        if (result.signals.watchlist?.length) log(`  → Watchlist: ${result.signals.watchlist.join(', ')}`);
        if (result.signals.avoid?.length)     log(`  → Avoid: ${result.signals.avoid.join(', ')}`);
    } catch (err) {
        log(`Research report error: ${err.message}`);
    }
}

// ── Dead options sweeper ─────────────────────────────────────────────────────
// Closes worthless LONG options (bid ≤ $0.02 or down ≥ 95%).
// ONLY targets long positions (qty > 0, side === 'long') — never touches the
// wheel strategy's SHORT puts/calls (qty < 0, side === 'short') which are
// intentionally short and managed separately by wheel.js.
async function sweepDeadOptions() {
    try {
        const posRes = await axios.get(`${BASE}/positions`, { headers: HEADERS });
        const dead = posRes.data.filter(p =>
            p.asset_class === 'us_option' &&
            p.side === 'long' &&                          // ← only sweep bought options
            parseFloat(p.qty) > 0 &&                     // ← never touch short wheel positions
            (parseFloat(p.current_price) <= 0.02 || parseFloat(p.unrealized_plpc) <= -0.95)
        );
        if (!dead.length) return;
        log(`🧹 Found ${dead.length} dead options — sweeping...`);
        for (const pos of dead) {
            try {
                await axios.delete(`${BASE}/positions/${encodeURIComponent(pos.symbol)}`, { headers: HEADERS });
                log(`🗑️ Closed dead option ${pos.symbol} (${(parseFloat(pos.unrealized_plpc)*100).toFixed(0)}%)`);
            } catch (err) {
                // Likely already expired or no bid — Alpaca will auto-expire, ignore
                log(`⚠️ Can't close ${pos.symbol}: ${err.response?.data?.message || err.message}`);
            }
        }
    } catch (err) {
        log(`Dead-options sweep error: ${err.message}`);
    }
}

// ── Startup sweep: close any MEXC paper positions already deep in the red ───
// Catches positions that went bad while the server was offline
async function sweepStaleMexcPositions() {
    try {
        const state = mexcPaper.getState();
        if (!state.positions || !Object.keys(state.positions).length) return;
        let swept = 0;
        for (const [sym, pos] of Object.entries(state.positions)) {
            // Only check positions that have a stored currentPrice (set by scan)
            if (!pos.currentPrice || !pos.entryPrice) continue;
            const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
            if (pnlPct <= -12) {
                log(`🔥 Startup sweep: closing ${sym} at ${pnlPct.toFixed(1)}% (stale loss)`);
                await mexcPaper.manualSell(sym, 100).catch(() => {});
                swept++;
            }
        }
        if (swept) log(`🧹 Swept ${swept} underwater MEXC paper positions at startup`);
    } catch (err) {
        log(`Startup sweep error: ${err.message}`);
    }
}

app.listen(3000, '0.0.0.0', () => {
    console.log('Dashboard running at http://localhost:3000');
    console.log('Press Ctrl+C to stop.');
    sweepDeadOptions();          // ← close any -100% worthless options immediately
    sweepStaleMexcPositions();   // ← close any already-busted MEXC paper positions
    runResearch();               // generate report immediately on startup
    // STRIPPED BACK (2026-10-27) to only what the evidence says works: the Boring ETF
    // buy-and-hold core, crypto with its regime filter (runScan — stocks inside it is
    // now a no-op), and the Options Wheel. Asia, High Risk, and active stock-picking are
    // retired — all lost money actively trading a market that rose. Boring compounding
    // for debt recycling beats clever trading that doesn't work.
    runScan();                  // crypto only now (stocks neutered above)
    runBoringEtfScan();
    runOptionsLabScan();
    setTimeout(runPerfSnapshot, 60 * 1000); // first perf snapshot ~1 min after boot (let scans populate)
    discord.init(() => lastData, () => lastAsiaData, () => lastPoliticoData, () => lastWheelData, () => lastRiskyData, () => lastMexcData, () => mlPipeline);

    // ML/RL pipeline RETIRED — 3 live trades, 0% win rate, -$4.36. No demonstrated
    // edge and it competes for the same capital as the streams that do work. Its
    // read-only endpoints stay up so the existing data remains inspectable.
    // mlPipeline.run().catch(err => log(`[ML] Pipeline error: ${err.message}`));
    log('🤖 ML/RL trading pipeline DISABLED (retired — 0% win rate over 3 trades)');
});

setInterval(() => { if (isMarketOpen()) runScan();    else log('Market closed — skipping scan.'); }, 5  * 60 * 1000);
setInterval(() => { if (isMarketOpen()) runOptionsLabScan();                                       }, 15 * 60 * 1000); // isolated $10k wheel sim
setInterval(() => { if (isMarketOpen()) sweepDeadOptions();                                        }, 60 * 60 * 1000); // hourly
setInterval(runBoringEtfScan, 6 * 60 * 60 * 1000); // boring ETF buy-and-hold core
// RETIRED streams (lost money actively trading): runRiskyScan, runAsianScan, runPoliticoScan.
// Pump Lab schedulers DELETED (see boot block above) — no more ignition scans or exit sweeps.
// Adaptive tuner — daily-ish self-calibration of every stream's gates against
// ground truth (self-limits to once per 12h internally). Logs every change.
const runTune = () => { try { const r = adaptiveTuner.tune(lastData); if (r.changes?.length) r.changes.forEach(c => log(`🔧 Tuner: ${c}`)); } catch (e) { log(`Tuner error: ${e.message}`); } };
setTimeout(runTune, 10 * 60 * 1000);               // first tune ~10 min after boot (let scans populate)
setInterval(runTune, 12 * 60 * 60 * 1000);
setInterval(runPerfSnapshot, 60 * 60 * 1000);  // hourly equity-curve snapshot across all markets

// Pre-open scan for crypto at the US open (Asia/risky pre-open scans retired with those streams)
cron.schedule('15 13 * * 1-5', () => { log('📸 Pre-open scan: NYSE'); runScan(); });

// Pre-market research report generator (ingests news, generates signals, posts to /reports)
// Runs at 13:00 UTC (9:00 AM ET, 1:00 PM Sydney) weekdays so it's ready for US/EU market opens
cron.schedule('0 13 * * 1-5', async () => {
    log('📰 Generating pre-market research report from news feeds...');
    try {
        const report = await researchGen.generateReport();
        if (report) log(`✓ Research report ready: ${report.signals.summary}`);
    } catch (e) { log(`Research generation error: ${e.message}`); }
});

// Research runs every 4 hours 24/7 — covers crypto overnight + pre-market for all global exchanges
cron.schedule('0 1,5,9,13,17,21 * * *', () => {
    log('📊 Scheduled research refresh');
    runResearch();
});

// Daily wheel summary logged at market close (4:05pm ET = 20:05 UTC during EDT)
cron.schedule('5 20 * * 1-5', () => {
    log(wheel.dailySummary());
});

// Daily market close (4:00pm ET = 20:00 UTC weekdays) — Update SPY price and take performance snapshot
cron.schedule('0 20 * * 1-5', async () => {
    try {
        const spyBenchmark = require('./spyBenchmark');
        await spyBenchmark.updateLatestPrice();
        log('✓ SPY price updated for today');

        // Take daily performance snapshot & learn from open positions
        const journal = require('./tradeJournal');
        const alpaca = require('./stocks');
        const asianPaper = require('./asianPaperTrader');
        const mexc = require('./services/mexc');
        const perfTracker = require('./performanceTracker');

        try {
            const alpacaEquity = alpaca.getPortfolioValue();
            const asianValue = asianPaper.getPortfolioValue();
            // MEXC retired — excluded from combined equity.
            const unrealizedPnl = journal.calculateUnrealizedPnl() || 0;

            const snap = perfTracker.snapshot({
                alpacaEquity,
                asianValue,
                mexcValue: null,
                totalClosed: journal.getStats().totalClosed,
                winRate: journal.getStats().winRate,
                totalPnl: journal.getStats().totalPnl,
                unrealizedPnl,
            });

            if (snap) log(`📊 Daily snapshot: Bot $${snap.combined} | SPY $${snap.spyEquity}${unrealizedPnl ? ` | unrealized $${unrealizedPnl.toFixed(2)}` : ''}`);

            // Daily learning from open positions — faster feedback than waiting for closes
            try {
                const posRes = await axios.get(`${BASE}/positions`, { headers: HEADERS, timeout: 15000 });
                const openPositions = posRes.data.map(p => ({
                    symbol: p.symbol,
                    currentPnlPct: parseFloat(p.unrealized_plpc) || 0,
                    signals: {}, // signals are stored in journal, but this learns from live P&L magnitude
                }));
                if (openPositions.length > 0) {
                    journal.learnFromOpenTrades(openPositions);
                }
            } catch (learnErr) {
                log(`Daily open-position learning skipped: ${learnErr.message}`);
            }
        } catch (e) {
            log(`⚠ Daily snapshot error: ${e.message}`);
        }
    } catch (err) {
        log(`✗ Market close update failed: ${err.message}`);
    }
});

// End-of-day report (4:30pm ET = 20:30 UTC weekdays) — summarize, learn, save
cron.schedule('30 20 * * 1-5', async () => {
    try {
        const result = await endOfDay.generate();
        log(`✓ EOD report generated — Day P&L: $${result.signals.dayPL} | Win rate: ${result.signals.todayWinRate}%`);
    } catch (err) {
        log(`✗ EOD report failed: ${err.message}`);
    }
});