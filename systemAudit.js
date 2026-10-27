// systemAudit.js — Automated weekly health check. Every failure this bot has had was
// SILENT: a data source dies or a stream stalls, but the app keeps running and the
// dashboard keeps showing stale numbers. This actively probes every external data source
// and every stream, and produces a PASS/WARN/FAIL report so problems surface loudly.
//
// Runs weekly via cron (server.js) → saves system-audit.json, logs a summary, and is
// served at GET /data/audit. Run manually: node systemAudit.js
'use strict';
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const DATA_DIR = require('./dataDir');

const H = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY };
const UA = { 'User-Agent': 'Mozilla/5.0' };
const ok  = (name, detail) => ({ name, status: 'PASS', detail });
const warn = (name, detail) => ({ name, status: 'WARN', detail });
const fail = (name, detail) => ({ name, status: 'FAIL', detail });

async function run() {
    const checks = [];
    const barsWindow = require('./barsWindow');

    // ── DATA SOURCES ─────────────────────────────────────────────────────────
    // Alpaca daily bars (feeds ALL technical indicators — the thing that was dead)
    try {
        const { start, end } = barsWindow(210, '1Day');
        const r = await axios.get('https://data.alpaca.markets/v2/stocks/bars',
            { headers: H, params: { symbols: 'NVDA', timeframe: '1Day', start, end, limit: 10000, feed: 'iex' }, timeout: 12000 });
        const n = r.data?.bars?.NVDA?.length || 0;
        checks.push(n >= 200 ? ok('Alpaca daily bars (indicators)', `${n} bars`)
                  : n > 0 ? warn('Alpaca daily bars (indicators)', `only ${n} bars — indicators need 200+`)
                  : fail('Alpaca daily bars (indicators)', 'EMPTY — all technical indicators dead'));
    } catch (e) { checks.push(fail('Alpaca daily bars (indicators)', `HTTP ${e.response?.status || e.message}`)); }

    // Alpaca snapshots (live prices)
    try {
        const r = await axios.get('https://data.alpaca.markets/v2/stocks/snapshots',
            { headers: H, params: { symbols: 'NVDA,AAPL', feed: 'iex' }, timeout: 10000 });
        const p = r.data?.NVDA?.latestTrade?.p || r.data?.NVDA?.dailyBar?.c;
        checks.push(p ? ok('Alpaca snapshots (prices)', `NVDA $${p}`) : fail('Alpaca snapshots (prices)', 'no price'));
    } catch (e) { checks.push(fail('Alpaca snapshots (prices)', `HTTP ${e.response?.status || e.message}`)); }

    // News — NewsAPI primary, Google RSS fallback
    let newsOk = false, newsSrc = '';
    try { const r = await axios.get('https://newsapi.org/v2/everything', { params: { q: 'NVDA', pageSize: 2, apiKey: process.env.NEWS_API_KEY }, timeout: 8000 }); if (r.data.articles?.length) { newsOk = true; newsSrc = 'NewsAPI'; } } catch {}
    if (!newsOk) { try { const r = await axios.get('https://news.google.com/rss/search?q=NVDA+stock', { timeout: 8000, headers: UA }); if ((r.data.match(/<item>/g) || []).length) { newsOk = true; newsSrc = 'Google RSS (NewsAPI rate-limited)'; } } catch {} }
    checks.push(newsOk ? (newsSrc.includes('Google') ? warn('News sentiment', `on fallback: ${newsSrc}`) : ok('News sentiment', newsSrc)) : fail('News sentiment', 'both NewsAPI and Google RSS dead'));

    // StockTwits (known-dead; track in case it revives)
    try { const r = await axios.get('https://api.stocktwits.com/api/2/streams/symbol/NVDA.json', { timeout: 8000 }); checks.push((r.data.messages || []).length ? ok('StockTwits', 'revived!') : warn('StockTwits', 'empty')); }
    catch (e) { checks.push(warn('StockTwits', `dead (HTTP ${e.response?.status}) — signal contributes 0, known`)); }

    // Fear & Greed
    try { const r = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 8000 }); checks.push(r.data?.data?.[0] ? ok('Fear & Greed', `value ${r.data.data[0].value}`) : fail('Fear & Greed', 'empty')); }
    catch (e) { checks.push(fail('Fear & Greed', e.message)); }

    // Congress trades (FMP) — INFORMATIONAL ONLY since 2026-10-27: this signal fed the
    // stocks stream, which is retired (active stock-picking lost to buy-and-hold). Demoted
    // fail→warn so a dead-signal hiccup doesn't flag the whole audit red every day.
    try {
        const r = await axios.get(`https://financialmodelingprep.com/stable/senate-latest?apikey=${process.env.FMP_API_KEY}`, { timeout: 12000 });
        const arr = Array.isArray(r.data) ? r.data : [];
        const newest = arr.map(t => t.transactionDate).filter(Boolean).sort().pop();
        const ageDays = newest ? Math.floor((Date.now() - new Date(newest)) / 86400000) : 999;
        checks.push(!arr.length ? warn('Congress trades (FMP)', 'empty — unused (stocks stream retired)')
                  : ageDays > 30 ? warn('Congress trades (FMP)', `newest trade ${ageDays}d old — unused (stocks stream retired)`)
                  : ok('Congress trades (FMP)', `${arr.length} records, newest ${ageDays}d ago`));
    } catch (e) { checks.push(warn('Congress trades (FMP)', `HTTP ${e.response?.status || e.message} — unused (stocks stream retired)`)); }

    // Binance (crypto volume + regime)
    try {
        const r = await axios.get('https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT', { timeout: 8000 });
        const v = parseFloat(r.data.quoteVolume) / 1e6;
        checks.push(v > 100 ? ok('Binance (crypto data)', `BTC vol $${v.toFixed(0)}M`) : warn('Binance (crypto data)', `low vol $${v.toFixed(1)}M`));
    } catch (e) { checks.push(fail('Binance (crypto data)', `HTTP ${e.response?.status || e.message}`)); }

    // ── STREAM HEALTH ────────────────────────────────────────────────────────
    // Circuit-breaker deadlocks (the stocks bug): paused with no recent trades = trapped
    try {
        const calib = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'adaptive-calibration.json'), 'utf8'));
        const journal = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'trade-journal.json'), 'utf8'));
        const closed = journal.closedTrades || [];
        const map = { stocks: 'stocks', politico: 'politico', asia: 'asia-paper' };
        const trapped = Object.keys(calib.paused || {}).filter(s => closed.filter(t => t.strategy === (map[s] || s)).slice(-20).length < 10);
        checks.push(trapped.length ? warn('Circuit breaker', `${trapped.join(', ')} paused with <10 recent trades (deadlock risk — cleared on next boot)`)
                                   : ok('Circuit breaker', Object.keys(calib.paused || {}).length ? 'pauses backed by data' : 'nothing paused'));
    } catch (e) { checks.push(warn('Circuit breaker', `couldn't read calib: ${e.message}`)); }

    // Learning loop — are weights evolving?
    try {
        const journal = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'trade-journal.json'), 'utf8'));
        const w = journal.weights || {};
        const moved = Object.values(w).filter(v => Math.abs(v - 1) > 0.001).length;
        checks.push(moved > 0 ? ok('Learning loop', `${moved}/${Object.keys(w).length} weights evolved`)
                              : warn('Learning loop', 'all weights at 1.0 — no closed trades to learn from yet'));
    } catch (e) { checks.push(warn('Learning loop', e.message)); }

    // ── ROLL UP ──────────────────────────────────────────────────────────────
    const fails = checks.filter(c => c.status === 'FAIL');
    const warns = checks.filter(c => c.status === 'WARN');
    const report = {
        ranAt: new Date().toISOString(),
        verdict: fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS',
        summary: `${checks.filter(c => c.status === 'PASS').length} pass, ${warns.length} warn, ${fails.length} fail`,
        checks,
    };
    try { fs.writeFileSync(path.join(DATA_DIR, 'system-audit.json'), JSON.stringify(report, null, 2)); } catch {}
    return report;
}

function getLast() {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'system-audit.json'), 'utf8')); }
    catch { return { verdict: 'UNKNOWN', summary: 'no audit run yet', checks: [] }; }
}

module.exports = { run, getLast };

// CLI
if (require.main === module) {
    run().then(r => {
        console.log(`\nSYSTEM AUDIT — ${r.verdict} (${r.summary})`);
        console.log('─'.repeat(66));
        for (const c of r.checks) {
            const icon = c.status === 'PASS' ? '✓' : c.status === 'WARN' ? '⚠' : '✗';
            console.log(`  ${icon} ${c.name.padEnd(34)} ${c.detail}`);
        }
        console.log('');
        process.exit(r.verdict === 'FAIL' ? 1 : 0);
    });
}
