// model.js — Logistic regression ML model
// Inputs: momentum, volumeSpike, sentiment, volatility, regimeBias
// Output: probability (0–1) via sigmoid
const fs   = require('fs');
const path = require('path');

const DATA_DIR     = require('../../dataDir');
const WEIGHTS_PATH = path.join(DATA_DIR, 'ml-weights.json');

// Default weights (trained over time via RL feedback)
const DEFAULT_WEIGHTS = {
    momentum:    2.5,
    volumeSpike: 0.8,
    sentiment:   1.8,
    volatility:  -3.0,   // high vol = less likely to trade
    regimeBias:  1.5,
    bias:        -0.1,   // intercept
};

function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}

function loadWeights() {
    try {
        return JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
    } catch {
        return { ...DEFAULT_WEIGHTS };
    }
}

function saveWeights(weights) {
    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(weights, null, 2));
}

function predict(features, regimeBias) {
    const w = loadWeights();

    const z = w.momentum    * features.momentum
            + w.volumeSpike * (features.volumeSpike - 1)  // normalize: 1 = normal
            + w.sentiment   * features.sentiment
            + w.volatility  * features.volatility
            + w.regimeBias  * regimeBias
            + w.bias;

    return parseFloat(sigmoid(z).toFixed(4));
}

// Online gradient update (stochastic gradient descent)
function update(features, regimeBias, target, learningRate = 0.01) {
    const w = loadWeights();
    const p = predict(features, regimeBias);
    const error = target - p;
    const gradient = error * p * (1 - p); // derivative of sigmoid * error

    w.momentum    += learningRate * gradient * features.momentum;
    w.volumeSpike += learningRate * gradient * (features.volumeSpike - 1);
    w.sentiment   += learningRate * gradient * features.sentiment;
    w.volatility  += learningRate * gradient * features.volatility;
    w.regimeBias  += learningRate * gradient * regimeBias;
    w.bias        += learningRate * gradient;

    // Clamp weights to prevent explosion
    for (const key of Object.keys(w)) {
        w[key] = parseFloat(Math.max(-10, Math.min(10, w[key])).toFixed(4));
    }

    saveWeights(w);
    return w;
}

module.exports = { predict, update, loadWeights, saveWeights, sigmoid };
