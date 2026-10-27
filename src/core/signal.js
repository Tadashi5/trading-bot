// signal.js — Convert ML probability to trade signal

const BUY_THRESHOLD  = 0.72;
const SELL_THRESHOLD = 0.28;

function generate(probability) {
    if (probability > BUY_THRESHOLD)  return { signal: 'BUY',  confidence: probability };
    if (probability < SELL_THRESHOLD) return { signal: 'SELL', confidence: 1 - probability };
    return { signal: 'HOLD', confidence: 0.5 };
}

module.exports = { generate, BUY_THRESHOLD, SELL_THRESHOLD };
