#!/usr/bin/env node
// resetAllStreams.js — Put every stream back to the same $10k starting line so their
// returns are directly comparable, and archive (never delete) what came before.
//
//   node resetAllStreams.js            # dry run — shows what WOULD change
//   node resetAllStreams.js --confirm  # actually reset
//
// Archives land in ./archive/<timestamp>/ so nothing is ever lost.
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = require('./dataDir');
const CONFIRM  = process.argv.includes('--confirm');
const START    = 10000;

const STATE_FILES = [
    'paper-stocks.json', 'paper-crypto.json', 'paper-risky.json',
    'options-paper.json', 'pump-experiment.json',
    'boring-etf-paper.json', 'asian-paper.json',
    'trade-journal.json',
    'crypto-highwater.json', 'stock-highwater.json',
];

function readJson(f) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; }
}

// ── Show what's there now ────────────────────────────────────────────────────
console.log('\n' + '='.repeat(72));
console.log(CONFIRM ? 'RESETTING ALL STREAMS TO $10,000' : 'DRY RUN — nothing will change (pass --confirm to apply)');
console.log('='.repeat(72) + '\n');

console.log('CURRENT STATE');
console.log('-'.repeat(72));
const before = {};
for (const [label, file, valueFn] of [
    ['stocks',     'paper-stocks.json',    s => s?.cash],
    ['crypto',     'paper-crypto.json',    s => s?.cash],
    ['risky',      'paper-risky.json',     s => s?.cash],
    ['options',    'options-paper.json',   s => s?.cash],
    ['pump',       'pump-experiment.json', s => s?.balance],
    ['boring-etf', 'boring-etf-paper.json',s => s?.cash],
    ['asia',       'asian-paper.json',     s => s?.balance],
]) {
    const s = readJson(file);
    const cash = valueFn(s);
    before[label] = cash;
    const start = s?.startingCash ?? s?.startingBalance;
    console.log(`  ${label.padEnd(11)} cash ${cash != null ? ('$' + Number(cash).toFixed(2)).padStart(12) : '        (none)'}   started at ${start != null ? '$' + start : '—'}`);
}
const j = readJson('trade-journal.json');
console.log(`  ${'journal'.padEnd(11)} ${(j?.closedTrades || []).length} closed trades, ${(j?.trades || []).length} open`);

if (!CONFIRM) {
    console.log('\nWould archive the above, then set EVERY stream to $' + START.toLocaleString() + '.');
    console.log('Re-run with --confirm to apply.\n');
    process.exit(0);
}

// ── Archive ──────────────────────────────────────────────────────────────────
const stamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const archive = path.join(DATA_DIR, 'archive', stamp);
fs.mkdirSync(archive, { recursive: true });

let archived = 0;
for (const f of STATE_FILES) {
    const src = path.join(DATA_DIR, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(archive, f));
    archived++;
}
console.log(`\nArchived ${archived} state file(s) → archive/${stamp}/`);

// ── Reset ────────────────────────────────────────────────────────────────────
console.log('\nRESETTING');
console.log('-'.repeat(72));

const paperBroker = require('./paperBroker');
for (const s of ['stocks', 'crypto', 'risky']) {
    paperBroker.reset(s, START);
    console.log(`  ${s.padEnd(11)} → $${START.toLocaleString()}`);
}

require('./optionsPaperTrader').resetPaper(START);
console.log(`  ${'options'.padEnd(11)} → $${START.toLocaleString()}`);

require('./pumpExperiment').resetExperiment();
console.log(`  ${'pump'.padEnd(11)} → $${START.toLocaleString()}`);

require('./boringEtfTrader').resetPaper(START);
console.log(`  ${'boring-etf'.padEnd(11)} → $${START.toLocaleString()}`);

require('./asianPaperTrader').resetPaper(START);
console.log(`  ${'asia'.padEnd(11)} → $${START.toLocaleString()}`);

// Journal: fresh, but keep the learned weights (hard-won signal calibration)
const weights = j?.weights || {};
fs.writeFileSync(path.join(DATA_DIR, 'trade-journal.json'), JSON.stringify({
    trades: [], closedTrades: [], orphaned: [], stats: {}, weights,
}, null, 2));
console.log(`  ${'journal'.padEnd(11)} → cleared (learned weights preserved)`);

// High-water marks must go, or stale peaks would instantly trigger trailing exits
for (const f of ['crypto-highwater.json', 'stock-highwater.json']) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) { fs.writeFileSync(p, '{}'); console.log(`  ${f.replace('.json','').padEnd(11)} → cleared`); }
}

console.log('\n' + '='.repeat(72));
console.log(`All 7 streams now start level at $${START.toLocaleString()} each ($${(START * 7).toLocaleString()} total).`);
console.log(`Rollback: copy files from archive/${stamp}/ back into ${DATA_DIR}`);
console.log('='.repeat(72) + '\n');
