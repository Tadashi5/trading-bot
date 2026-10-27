// features.js — Feature engine
// Computes: momentum, volumeSpike, volatility, sentiment

function compute(tick, sentimentScore = 0) {
    const momentum    = tick.prevClose > 0 ? (tick.price - tick.prevClose) / tick.prevClose : 0;
    const volumeSpike = tick.avgVolume > 0 ? tick.volume / tick.avgVolume : 1;
    const volatility  = tick.price > 0 ? (tick.high - tick.low) / tick.price : 0;

    return {
        symbol:      tick.symbol,
        price:       tick.price,
        momentum:    parseFloat(momentum.toFixed(6)),
        volumeSpike: parseFloat(volumeSpike.toFixed(3)),
        volatility:  parseFloat(volatility.toFixed(6)),
        sentiment:   parseFloat(sentimentScore.toFixed(3)),
        timestamp:   tick.timestamp,
    };
}

module.exports = { compute };
