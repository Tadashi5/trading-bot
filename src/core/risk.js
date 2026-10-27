// risk.js — Position sizing and drawdown kill switch

const MAX_RISK_PCT = 0.02;     // 2% of capital per trade
const KILL_DRAWDOWN = -0.05;   // halt at 5% drawdown

let peakEquity = 0;

function size(capital, volatility) {
    if (volatility <= 0) return 0;
    const riskAmount = capital * MAX_RISK_PCT;
    // Position size = risk / volatility (as fraction of price)
    const posSize = riskAmount / volatility;
    return parseFloat(posSize.toFixed(2));
}

function checkKillSwitch(currentEquity, startingEquity) {
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const drawdown = (currentEquity - peakEquity) / peakEquity;

    if (drawdown < KILL_DRAWDOWN) {
        return { halt: true, drawdown: parseFloat(drawdown.toFixed(4)), reason: `Drawdown ${(drawdown * 100).toFixed(1)}% exceeds limit` };
    }
    return { halt: false, drawdown: parseFloat(drawdown.toFixed(4)) };
}

function reset(equity) { peakEquity = equity; }

module.exports = { size, checkKillSwitch, reset, MAX_RISK_PCT, KILL_DRAWDOWN };
