#!/usr/bin/env node
// daily.js — The $0 once-a-day runner. Replaces the always-on Express server for the
// stripped-back bot (ETF buy-and-hold core + regime-gated crypto + options wheel).
// Runs every stream's scan ONCE, refreshes the regime, runs the self-audit, then writes
// a self-contained static dashboard to docs/index.html (served free by GitHub Pages).
// State lives in the repo's JSON files and is committed back by the GitHub Actions workflow.
//
// Run: node daily.js
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const regimeFilter = require('./regimeFilter');
const crypto       = require('./crypto');
const boringEtf    = require('./boringEtfTrader');
const optionsLab   = require('./optionsPaperTrader');
const paperBroker  = require('./paperBroker');
const riskManager  = require('./riskManager');
const systemAudit  = require('./systemAudit');

const log = (m) => console.log(`[daily] ${m}`);
const r2 = (n) => Math.round(n * 100) / 100;
const money = (v) => v == null ? '—' : '$' + Math.round(v).toLocaleString();

(async () => {
    const started = Date.now();
    log('start ' + new Date().toISOString());

    // 1. Regime (the daily signal that gates crypto)
    let regime = {};
    try { regime = await regimeFilter.refresh(); log(`regime crypto ${regime.crypto?.riskOn ? 'ON' : 'OFF'} / stocks ${regime.stocks?.riskOn ? 'ON' : 'OFF'}`); }
    catch (e) { log('regime error ' + e.message); }

    // 2. Risk budget from our own paper ledgers (crypto is the only active broker stream now)
    const riskPv = ['stocks', 'crypto', 'risky'].reduce((s, k) => { try { return s + paperBroker.getAccount(k).portfolioValue; } catch { return s; } }, 0);
    const riskStatus = riskManager.getStatus ? riskManager.getStatus(riskPv, []) : { available: { high: 0, medium: riskPv * 0.5, low: 0 } };

    // 3. Run the three kept streams once
    try { const c = await crypto.scan(riskStatus); log(`crypto scanned ${(c.results || []).length} coins`); } catch (e) { log('crypto error ' + e.message); }
    try { await boringEtf.scan(); log('etf scanned'); } catch (e) { log('etf error ' + e.message); }
    try { const o = await optionsLab.scan(); log(`options: ${Object.keys(o.openPuts || {}).length} puts, premium $${o.premiumCollected}`); } catch (e) { log('options error ' + e.message); }

    // 4. Self-audit
    let audit = { verdict: 'UNKNOWN', summary: '' };
    try {
        audit = await systemAudit.run();
        log(`audit ${audit.verdict} (${audit.summary})`);
        (audit.checks || []).filter(c => c.status !== 'PASS').forEach(c => log(`  ${c.status === 'FAIL' ? '✗' : '⚠'} ${c.name}: ${c.detail}`));
    } catch (e) { log('audit error ' + e.message); }

    // 4.5 Gold spot price — informational only (no stream trades it; you asked to track
    // it and buy physical by hand when it actually dips, not chase the all-time high).
    // No key needed: Yahoo's chart meta gives the live COMEX futures price (USD/oz),
    // same source used for the standalone gold chart. History appended to goldHistory.json
    // so the dashboard can show a trend, not just a single number.
    let gold = null;
    const goldHistFile = path.join(__dirname, 'gold-history.json');
    try {
        const r = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F', { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const meta = r.data?.chart?.result?.[0]?.meta;
        const usd = meta?.regularMarketPrice;
        if (usd > 0) {
            let aud = null;
            try {
                const ra = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/AUDUSD=X', { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                const rate = ra.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (rate > 0) aud = r2(usd / rate);
            } catch {}
            gold = { usd: r2(usd), aud, t: new Date().toISOString() };

            let hist = [];
            try { hist = JSON.parse(fs.readFileSync(goldHistFile, 'utf8')); } catch {}
            const today = gold.t.slice(0, 10);
            if (!hist.length || hist[hist.length - 1].t.slice(0, 10) !== today) hist.push(gold);
            else hist[hist.length - 1] = gold;         // multiple runs same day → update, don't duplicate
            if (hist.length > 400) hist = hist.slice(-400);
            fs.writeFileSync(goldHistFile, JSON.stringify(hist, null, 2));
            gold.history = hist;

            const ath = Math.max(...hist.map(h => h.usd));
            gold.offAth = r2((usd / ath - 1) * 100);   // 0% = at the high; negative = a real dip
            log(`gold $${gold.usd}/oz (A$${gold.aud}) — ${gold.offAth}% off recent high`);
        }
    } catch (e) { log('gold fetch error ' + e.message); }

    // 5. Build the leaderboard (active streams first, then retired)
    const rowFromBroker = (key, name, emoji, active) => {
        const a = paperBroker.getAccount(key);
        return { key, name, emoji, active, value: a.portfolioValue, start: a.startingCash,
                 pnl: r2(a.portfolioValue - a.startingCash), fees: a.totalFees, ret: a.totalReturn };
    };
    const rows = [];
    try { rows.push({ key: 'etf', name: 'Boring ETF core', emoji: '🧱', active: true, ...(() => { const e = boringEtf.getState(); return { value: e.portfolioValue, start: e.startingCash, pnl: r2(e.capitalGain), fees: e.totalFees, ret: e.totalReturn, note: `${(e.dividends?.received||0).toFixed(0)} div` }; })() }); } catch {}
    try { const o = optionsLab.getState(); rows.push({ key: 'options', name: 'Options wheel', emoji: '🎯', active: true, value: o.portfolioValue, start: o.startingBalance, pnl: r2(o.portfolioValue - o.startingBalance), fees: o.totalFees, ret: o.totalReturn }); } catch {}
    try { rows.push(rowFromBroker('crypto', 'Crypto (regime-gated)', '₿', true)); } catch {}

    const totalValue = rows.reduce((s, r) => s + (r.value || 0), 0);
    const totalStart = rows.reduce((s, r) => s + (r.start || 0), 0);
    const totalPnl   = rows.reduce((s, r) => s + (r.pnl || 0), 0);
    const totalFees  = rows.reduce((s, r) => s + (r.fees || 0), 0);
    const totalReturn = totalStart ? r2(totalPnl / totalStart * 100) : 0;

    // readiness (same spirit as the server: annualise vs a ~6% debt-cost hurdle)
    let daysLive = 60; try { const c = boringEtf.getState().createdAt; if (c) daysLive = Math.max(1, (Date.now() - new Date(c).getTime()) / 86400000); } catch {}
    const annualised = r2(totalReturn * (365 / daysLive));
    const tier = totalPnl <= 0 ? 'NOT READY' : annualised < 6 ? 'PROVING' : daysLive < 180 ? 'PROMISING' : 'READY (review)';
    const tierColor = totalPnl <= 0 ? '#f0616d' : annualised < 6 || daysLive < 180 ? '#f5a623' : '#26d07c';

    rows.sort((a, b) => (b.ret ?? -Infinity) - (a.ret ?? -Infinity));

    // 6. Write the static dashboard
    const regPill = (label, reg) => reg && reg.riskOn != null
        ? `<span style="color:${reg.riskOn ? '#26d07c' : '#f0616d'}">${label} ${reg.riskOn ? 'RISK-ON' : 'RISK-OFF'}</span> <span style="color:#888">(${reg.pctFromMA}% vs 200MA)</span>`
        : `<span style="color:#888">${label} —</span>`;
    const rowHtml = rows.map(r => `<tr>
        <td>${r.emoji} ${r.name}${r.note ? ` <span style="color:#667">· ${r.note}</span>` : ''}</td>
        <td style="text-align:right">${money(r.value)}</td>
        <td style="text-align:right;color:${r.pnl >= 0 ? '#26d07c' : '#f0616d'}">${r.pnl >= 0 ? '+' : '−'}${money(Math.abs(r.pnl))}</td>
        <td style="text-align:right">${r.ret == null ? '—' : (r.ret >= 0 ? '+' : '') + r.ret + '%'}</td>
        <td style="text-align:right;color:#888">${money(r.fees)}</td>
    </tr>`).join('');

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trading Bot — Daily</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0a0e14;color:#e6e6e6;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:16px;max-width:760px;margin:0 auto}
  h1{font-size:18px;font-weight:600;margin:0 0 4px}
  .sub{color:#8b94a3;font-size:12px;margin-bottom:16px}
  .card{background:#0f1521;border:1px solid #1e2a3a;border-radius:12px;padding:16px;margin-bottom:14px}
  .big{font-size:26px;font-weight:700}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td,th{padding:8px 6px;border-bottom:1px solid #141c28}
  th{color:#8b94a3;font-size:11px;letter-spacing:1px;text-align:left;font-weight:500}
  .muted{color:#8b94a3}
</style></head><body>
<h1>🤖 Trading Bot — lean daily</h1>
<div class="sub">Updated ${new Date().toUTCString()} · runs once a day · paper trading</div>

<div class="card" style="border-color:${tierColor}55">
  <div class="muted" style="font-size:12px">DEBT-RECYCLING READINESS — whole portfolio</div>
  <div class="big" style="color:${tierColor}">${tier}</div>
  <div style="margin-top:6px">Net P&amp;L <b style="color:${totalPnl >= 0 ? '#26d07c' : '#f0616d'}">${totalPnl >= 0 ? '+' : '−'}${money(Math.abs(totalPnl))}</b>
     · Return ${totalReturn >= 0 ? '+' : ''}${totalReturn}% · ~${annualised}%/yr vs 6% debt cost · ${Math.round(daysLive)}d</div>
</div>

<div class="card">
  <div class="muted" style="font-size:12px;margin-bottom:8px">REGIME</div>
  ${regPill('₿ Crypto', regime.crypto)}<br>${regPill('📈 Stocks', regime.stocks)}
</div>

${gold ? (() => {
    const hist = gold.history || [];
    const vals = hist.map(h => h.usd);
    const min = Math.min(...vals), max = Math.max(...vals);
    const W = 300, H = 50;
    const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1) * W).toFixed(1)},${(H - (max > min ? (v - min) / (max - min) * H : H / 2)).toFixed(1)}`).join(' ');
    const dipColor = gold.offAth <= -15 ? '#26d07c' : gold.offAth <= -8 ? '#f5a623' : '#8b94a3';
    return `<div class="card">
  <div class="muted" style="font-size:12px;margin-bottom:4px">GOLD SPOT — tracked, not traded by any stream</div>
  <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
    <span class="big">$${gold.usd.toLocaleString()}/oz</span>
    <span class="muted" style="font-size:13px">${gold.aud != null ? 'A$' + gold.aud.toLocaleString() + '/oz · ' : ''}${hist.length}d tracked</span>
  </div>
  <div style="font-size:13px;margin-top:4px;color:${dipColor}">${gold.offAth}% off recent high${gold.offAth <= -15 ? ' — notable dip' : ''}</div>
  ${vals.length > 1 ? `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:50px;margin-top:8px" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#BA7517" stroke-width="2"/></svg>` : ''}
</div>`;
})() : ''}

<div class="card">
  <div class="muted" style="font-size:12px;margin-bottom:8px">ACTIVE STREAMS</div>
  <table><thead><tr><th>Stream</th><th style="text-align:right">Value</th><th style="text-align:right">P&amp;L</th><th style="text-align:right">Return</th><th style="text-align:right">Fees</th></tr></thead>
  <tbody>${rowHtml}</tbody>
  <tfoot><tr style="font-weight:600"><td>TOTAL</td><td style="text-align:right">${money(totalValue)}</td><td style="text-align:right;color:${totalPnl >= 0 ? '#26d07c' : '#f0616d'}">${totalPnl >= 0 ? '+' : '−'}${money(Math.abs(totalPnl))}</td><td style="text-align:right">${totalReturn}%</td><td style="text-align:right;color:#888">${money(totalFees)}</td></tr></tfoot></table>
  <div class="muted" style="font-size:11px;margin-top:10px">💸 Total fees paid (tax-deductible): ${money(totalFees)} · Retired (not trading): stocks, Asia, high-risk.</div>
</div>

<div class="card">
  <div class="muted" style="font-size:12px">SELF-AUDIT · ${audit.verdict}</div>
  <div style="font-size:13px;margin-top:4px">${audit.summary || ''}</div>
  ${(audit.checks || []).filter(c => c.status !== 'PASS').map(c => `<div style="font-size:12px;color:${c.status === 'FAIL' ? '#f0616d' : '#f5a623'}">${c.status === 'FAIL' ? '✗' : '⚠'} ${c.name}: ${c.detail}</div>`).join('')}
</div>
</body></html>`;

    const docsDir = path.join(__dirname, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'index.html'), html);
    // also drop a machine-readable snapshot next to it
    fs.writeFileSync(path.join(docsDir, 'snapshot.json'), JSON.stringify({ ranAt: new Date().toISOString(), totalValue: r2(totalValue), totalPnl, totalReturn, readiness: tier, annualised, rows, audit: { verdict: audit.verdict, summary: audit.summary } }, null, 2));

    log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s — total ${money(totalValue)} (${totalReturn >= 0 ? '+' : ''}${totalReturn}%), readiness ${tier}`);
    log('dashboard → docs/index.html');
})().catch(e => { console.error('[daily] FATAL', e); process.exit(1); });
