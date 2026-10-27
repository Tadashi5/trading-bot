// regime.js — Market regime detector
// Classifies: BULL, BEAR, CHOP, HIGH_VOL

const BIAS = { BULL: 0.25, BEAR: -0.25, HIGH_VOL: -0.35, CHOP: 0 };

// Sliding window of recent momentums to detect regime
let momentumHistory = [];
const WINDOW = 20;

function detect(features) {
    momentumHistory.push(features.momentum);
    if (momentumHistory.length > WINDOW) momentumHistory.shift();

    const avgMomentum = momentumHistory.reduce((s, m) => s + m, 0) / momentumHistory.length;
    const vol = features.volatility;

    let regime, bias;

    if (vol > 0.04) {
        regime = 'HIGH_VOL';
        bias = BIAS.HIGH_VOL;
    } else if (avgMomentum > 0.005) {
        regime = 'BULL';
        bias = BIAS.BULL;
    } else if (avgMomentum < -0.005) {
        regime = 'BEAR';
        bias = BIAS.BEAR;
    } else {
        regime = 'CHOP';
        bias = BIAS.CHOP;
    }

    return { regime, bias, avgMomentum: parseFloat(avgMomentum.toFixed(5)) };
}

function reset() { momentumHistory = []; }

module.exports = { detect, reset, BIAS };
