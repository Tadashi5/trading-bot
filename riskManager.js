// riskManager.js — Position sizing, drawdown limits, daily loss caps
require('dotenv').config();
const axios = require('axios');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;

// ── Risk Limits ──────────────────────────────────────────────────────────────
const RISK_LIMITS = {
    MAX_DAILY_LOSS:         -200,      // Stop trading if down $200 in a day
    MAX_POSITION_SIZE:      400,       // No single trade >$400
    MAX_OPEN_POSITIONS:     10,        // Don't hold >10 simultaneous
    MAX_DRAWDOWN_PCT:       15,        // Alert if drawdown >15%
    MIN_WIN_RATE_THRESHOLD: 30,        // If win rate drops below this, investigate
    STOP_LOSS_PCT:          -3,        // Auto exit at -3%
    PROFIT_TAKING_PCT:      5,         // Take profits at +5%
    MAX_HOLD_DAYS:          10,        // Close positions after 10 days max
};

// ── Daily Loss Tracker ───────────────────────────────────────────────────────

class DailyLossTracker {
    constructor() {
        this.todayStart = new Date().toISOString().split('T')[0];
        this.dailyPnl = 0;
        this.tradesToday = 0;
    }

    addTrade(pnl) {
        const today = new Date().toISOString().split('T')[0];
        if (today !== this.todayStart) {
            // New day, reset
            this.todayStart = today;
            this.dailyPnl = 0;
            this.tradesToday = 0;
        }
        this.dailyPnl += pnl;
        this.tradesToday++;
    }

    shouldStopTrading() {
        return this.dailyPnl <= RISK_LIMITS.MAX_DAILY_LOSS;
    }

    getStatus() {
        return {
            dailyPnl: parseFloat(this.dailyPnl.toFixed(2)),
            tradesToday: this.tradesToday,
            maxLoss: RISK_LIMITS.MAX_DAILY_LOSS,
            shouldStop: this.shouldStopTrading(),
            percentToStop: Math.abs(this.dailyPnl / RISK_LIMITS.MAX_DAILY_LOSS * 100),
        };
    }
}

// ── Position Sizing Calculator ───────────────────────────────────────────────

function calculatePositionSize(baseSize, currentOpenPositions, winRate, vixLevel) {
    let size = baseSize;
    const positionCount = currentOpenPositions || 0;
    const concentrationFactor = Math.max(0.3, 1 - (positionCount / RISK_LIMITS.MAX_OPEN_POSITIONS) * 0.5);
    size *= concentrationFactor;

    const winRateFactor = winRate < 35 ? 0.6 : winRate < 40 ? 0.8 : 1.0;
    size *= winRateFactor;

    const vixFactor = vixLevel > 25 ? 0.5 : vixLevel > 20 ? 0.75 : 1.0;
    size *= vixFactor;

    size = Math.min(size, RISK_LIMITS.MAX_POSITION_SIZE);
    return parseFloat(size.toFixed(2));
}

// ── Position Exit Manager ────────────────────────────────────────────────────

function shouldExitPosition(unrealizedPnlPct, entryDaysAgo, stopLossPct, profitTakePct) {
    const reasons = [];
    if (unrealizedPnlPct <= stopLossPct) {
        reasons.push(`stop-loss (${unrealizedPnlPct.toFixed(2)}% ≤ ${stopLossPct}%)`);
    }
    if (unrealizedPnlPct >= profitTakePct) {
        reasons.push(`profit-taking (${unrealizedPnlPct.toFixed(2)}% ≥ ${profitTakePct}%)`);
    }
    if (entryDaysAgo >= RISK_LIMITS.MAX_HOLD_DAYS) {
        reasons.push(`max-hold (${entryDaysAgo}d ≥ ${RISK_LIMITS.MAX_HOLD_DAYS}d)`);
    }
    return { shouldExit: reasons.length > 0, reasons };
}

// ── Drawdown Calculator ──────────────────────────────────────────────────────

function calculateDrawdown(snapshots) {
    if (snapshots.length < 2) return { current: 0, max: 0, alert: false };
    const combined = snapshots.map(s => s.combined || 0);
    let peak = combined[0];
    let maxDD = 0;
    let currentDD = 0;

    for (let i = 0; i < combined.length; i++) {
        if (combined[i] > peak) peak = combined[i];
        const dd = peak > 0 ? ((peak - combined[i]) / peak * 100) : 0;
        if (dd > maxDD) maxDD = dd;
        if (i === combined.length - 1) currentDD = dd;
    }
    return {
        current: parseFloat(currentDD.toFixed(2)),
        max: parseFloat(maxDD.toFixed(2)),
        alert: currentDD > RISK_LIMITS.MAX_DRAWDOWN_PCT,
    };
}

// ── Check All Risk Conditions ────────────────────────────────────────────────

function evaluateRiskStatus(stats) {
    const alerts = [];
    const warnings = [];

    if (stats.dailyLoss <= RISK_LIMITS.MAX_DAILY_LOSS) {
        alerts.push(`🚨 DAILY LOSS: $${stats.dailyLoss.toFixed(2)} ≤ ${RISK_LIMITS.MAX_DAILY_LOSS}`);
    }
    if (stats.openPositions > RISK_LIMITS.MAX_OPEN_POSITIONS) {
        warnings.push(`⚠️ Open positions: ${stats.openPositions} > ${RISK_LIMITS.MAX_OPEN_POSITIONS}`);
    }
    if (stats.winRate < RISK_LIMITS.MIN_WIN_RATE_THRESHOLD) {
        warnings.push(`⚠️ Win rate: ${stats.winRate}% < ${RISK_LIMITS.MIN_WIN_RATE_THRESHOLD}%`);
    }
    if (stats.drawdown && stats.drawdown.alert) {
        warnings.push(`⚠️ Drawdown: ${stats.drawdown.current}% > ${RISK_LIMITS.MAX_DRAWDOWN_PCT}%`);
    }

    return {
        safe: alerts.length === 0,
        alerts,
        warnings,
        shouldPauseNewEntries: alerts.length > 0 || stats.winRate < RISK_LIMITS.MIN_WIN_RATE_THRESHOLD,
    };
}

// ── Capital allocation across risk tiers ─────────────────────────────────────
// Splits free capital into high/medium/low risk budgets so each strategy sizes
// within its share. (Restored interface — crypto/stocks/risky/politico all call
// getStatus + sizeFor; without them the whole bot scan throws.)
const TIER_WEIGHTS = { high: 0.15, medium: 0.50, low: 0.35 };

function getStatus(portfolioValue, positions = []) {
    const pv = parseFloat(portfolioValue) || 0;
    const deployed = (positions || []).reduce((s, p) =>
        s + Math.abs(parseFloat(p.market_value) || 0), 0);
    const free = Math.max(0, pv - deployed);
    const r2 = v => parseFloat(v.toFixed(2));
    return {
        portfolioValue: r2(pv),
        deployed: r2(deployed),
        free: r2(free),
        available: {
            high:   r2(free * TIER_WEIGHTS.high),
            medium: r2(free * TIER_WEIGHTS.medium),
            low:    r2(free * TIER_WEIGHTS.low),
        },
    };
}

// Notional for one trade: a fraction (pct) of that tier's available budget.
function sizeFor(tier, riskStatus, pct) {
    const avail = riskStatus?.available?.[tier] ?? 0;
    const size = avail * (parseFloat(pct) || 0);
    return parseFloat(Math.max(0, size).toFixed(2));
}

module.exports = {
    RISK_LIMITS,
    DailyLossTracker,
    calculatePositionSize,
    shouldExitPosition,
    calculateDrawdown,
    evaluateRiskStatus,
    getStatus,
    sizeFor,
};
