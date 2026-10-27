#!/usr/bin/env node
// resetToTenK.js — One-shot: reset the three kept streams (crypto, ETF core, options
// wheel) to a clean $10,000 each. Run: node resetToTenK.js
'use strict';
const paperBroker = require('./paperBroker');
const boringEtf    = require('./boringEtfTrader');
const optionsLab   = require('./optionsPaperTrader');

const before = {
    crypto: paperBroker.getAccount('crypto').portfolioValue,
    etf: boringEtf.getState().portfolioValue,
    options: optionsLab.getState().portfolioValue,
};

paperBroker.reset('crypto', 10000);
boringEtf.resetPaper(10000);
optionsLab.resetPaper(10000);

const after = {
    crypto: paperBroker.getAccount('crypto').portfolioValue,
    etf: boringEtf.getState().portfolioValue,
    options: optionsLab.getState().portfolioValue,
};

console.log('Reset complete:');
for (const k of Object.keys(before)) console.log(`  ${k.padEnd(8)} $${before[k]} -> $${after[k]}`);
