// rlAgent.js — Q-learning reinforcement learning agent
// States: bucketed features → Actions: BUY, SELL, HOLD
// Learns from trade PnL outcomes
const fs   = require('fs');
const path = require('path');

const DATA_DIR     = require('../../dataDir');
const Q_TABLE_PATH = path.join(DATA_DIR, 'q-table.json');

const ACTIONS = ['BUY', 'SELL', 'HOLD'];
const ALPHA   = 0.1;   // learning rate
const GAMMA   = 0.95;  // discount factor
const EPSILON = 0.1;   // exploration rate (decays over time)

let qTable = {};
let totalUpdates = 0;

function loadQTable() {
    try {
        const data = JSON.parse(fs.readFileSync(Q_TABLE_PATH, 'utf8'));
        qTable = data.table || {};
        totalUpdates = data.totalUpdates || 0;
    } catch {
        qTable = {};
        totalUpdates = 0;
    }
}

function saveQTable() {
    fs.writeFileSync(Q_TABLE_PATH, JSON.stringify({ table: qTable, totalUpdates }, null, 2));
}

// Discretize continuous features into state buckets
function getState(features, regime) {
    const momBucket = features.momentum > 0.02 ? 'high_pos' :
                      features.momentum > 0.005 ? 'low_pos' :
                      features.momentum < -0.02 ? 'high_neg' :
                      features.momentum < -0.005 ? 'low_neg' : 'flat';

    const volBucket = features.volumeSpike > 2.5 ? 'spike' :
                      features.volumeSpike > 1.5 ? 'high' :
                      features.volumeSpike < 0.5 ? 'dead' : 'normal';

    const sentBucket = features.sentiment > 0.3 ? 'bull' :
                       features.sentiment < -0.3 ? 'bear' : 'neutral';

    return `${momBucket}|${volBucket}|${sentBucket}|${regime}`;
}

function getQValues(state) {
    if (!qTable[state]) {
        qTable[state] = { BUY: 0, SELL: 0, HOLD: 0 };
    }
    return qTable[state];
}

// Choose action: epsilon-greedy
function chooseAction(features, regime) {
    const state = getState(features, regime);
    const qValues = getQValues(state);

    // Decaying epsilon
    const eps = Math.max(0.01, EPSILON * Math.exp(-totalUpdates / 1000));

    if (Math.random() < eps) {
        // Explore: random action
        return ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
    }

    // Exploit: best Q-value
    let best = 'HOLD', bestQ = -Infinity;
    for (const action of ACTIONS) {
        if (qValues[action] > bestQ) {
            bestQ = qValues[action];
            best = action;
        }
    }
    return best;
}

// Update Q-value after trade outcome
function update(prevFeatures, prevRegime, action, reward, nextFeatures, nextRegime) {
    const state = getState(prevFeatures, prevRegime);
    const nextState = getState(nextFeatures, nextRegime);

    const qValues = getQValues(state);
    const nextQValues = getQValues(nextState);

    // Max Q for next state
    const maxNextQ = Math.max(nextQValues.BUY, nextQValues.SELL, nextQValues.HOLD);

    // Q-learning update
    qValues[action] = qValues[action] + ALPHA * (reward + GAMMA * maxNextQ - qValues[action]);
    qValues[action] = parseFloat(qValues[action].toFixed(4));

    totalUpdates++;

    // Save periodically (every 10 updates)
    if (totalUpdates % 10 === 0) saveQTable();
}

// Convert PnL to reward signal
function pnlToReward(pnlPct) {
    if (pnlPct > 5)  return 1.0;   // great trade
    if (pnlPct > 2)  return 0.5;
    if (pnlPct > 0)  return 0.2;
    if (pnlPct > -2) return -0.2;
    if (pnlPct > -5) return -0.5;
    return -1.0;                    // terrible trade
}

function getStats() {
    return {
        statesExplored: Object.keys(qTable).length,
        totalUpdates,
        epsilon: Math.max(0.01, EPSILON * Math.exp(-totalUpdates / 1000)).toFixed(3),
    };
}

// Initialize on load
loadQTable();

module.exports = { chooseAction, update, pnlToReward, getState, getStats, loadQTable, saveQTable };
