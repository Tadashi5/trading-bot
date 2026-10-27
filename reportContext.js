// Shared helper: reads latest research signals to bias trading decisions
const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, 'reports');
const LATEST = path.join(REPORTS_DIR, 'latest.json');

const EMPTY = {
    sentiment: 'neutral',
    vixView: 'normal',
    watchlist: [],
    avoid: [],
    sectorBias: {},
    cryptoView: 'neutral',
    summary: '',
    sourceType: null,
    sourceTime: null,
};

function getLatest() {
    try {
        if (!fs.existsSync(LATEST)) return EMPTY;
        const raw = JSON.parse(fs.readFileSync(LATEST, 'utf8'));
        // Stale if older than 8 hours
        const ageMs = Date.now() - new Date(raw.sourceTime || 0).getTime();
        if (ageMs > 8 * 3600 * 1000) return { ...EMPTY, summary: '(report stale)' };
        return { ...EMPTY, ...(raw.signals || {}), sourceType: raw.label || raw.type, market: raw.market, sourceTime: raw.sourceTime };
    } catch { return EMPTY; }
}

// Apply ticker-level score bias
// watchlist: +1.5 score boost
// avoid: -2 score penalty
// bullish sentiment + watchlist match: +2 total
function biasScore(ticker, baseScore) {
    const ctx = getLatest();
    let bias = 0;
    let reasons = [];
    if (ctx.watchlist?.map(t => t.toUpperCase()).includes((ticker || '').toUpperCase())) {
        bias += 1.5;
        reasons.push('watchlist');
    }
    if (ctx.avoid?.map(t => t.toUpperCase()).includes((ticker || '').toUpperCase())) {
        bias -= 2;
        reasons.push('avoid');
    }
    if (ctx.sentiment === 'bullish') { bias += 0.5; reasons.push('bull-sent'); }
    if (ctx.sentiment === 'bearish') { bias -= 0.5; reasons.push('bear-sent'); }
    return { biased: baseScore + bias, bias, reasons };
}

// Crypto-specific bias (BTC/ETH/SOL etc)
function biasCryptoScore(symbol, baseScore) {
    const ctx = getLatest();
    let bias = 0;
    let reasons = [];
    if (ctx.cryptoView === 'bullish') { bias += 0.7; reasons.push('crypto-bull'); }
    if (ctx.cryptoView === 'bearish') { bias -= 0.7; reasons.push('crypto-bear'); }
    if (ctx.watchlist?.map(t => t.toUpperCase()).includes((symbol || '').toUpperCase())) {
        bias += 1; reasons.push('watchlist');
    }
    return { biased: baseScore + bias, bias, reasons };
}

// Trailing stop tightening based on VIX view
// elevated/high → tighter stop (lower trail %), low → looser
function adjustTrailPercent(basePercent) {
    const ctx = getLatest();
    if (ctx.vixView === 'high' || ctx.vixView === 'elevated') return Math.max(5, basePercent - 3);
    if (ctx.vixView === 'low') return basePercent + 2;
    return basePercent;
}

module.exports = { getLatest, biasScore, biasCryptoScore, adjustTrailPercent };
