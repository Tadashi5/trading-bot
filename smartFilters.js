// smartFilters.js — Advanced filters for better trade prediction
// 1. Volume spike detection
// 2. Multi-timeframe confirmation (1hr bars)
// 3. Correlation filter (market-wide crash detection)
// 4. Partial profit-taking (smart exits)
// 5. Options IV rank (for wheel strategy)
// 6. Earnings avoidance (don't enter before earnings)
require('dotenv').config();
const axios = require('axios');
const barsWindow = require('./barsWindow');
const fs    = require('fs');
const path  = require('path');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE      = process.env.ALPACA_BASE_URL;
const DATA_BASE = 'https://data.alpaca.markets/v2';
const FMP_KEY   = process.env.FMP_API_KEY;

// State for partial profit tracking
const DATA_DIR          = require('./dataDir');
const PROFIT_STATE_PATH = path.join(DATA_DIR, 'profit-state.json');

function loadProfitState() {
    try { return JSON.parse(fs.readFileSync(PROFIT_STATE_PATH, 'utf8')); }
    catch { return {}; }
}
function saveProfitState(state) {
    fs.writeFileSync(PROFIT_STATE_PATH, JSON.stringify(state, null, 2));
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. VOLUME SPIKE DETECTION
// ══════════════════════════════════════════════════════════════════════════════
// Unusual volume (today vs 20-day average) signals institutional interest.
// Returns a score bonus for high volume.

async function getVolumeSpikes(symbols) {
    try {
        const res = await axios.get(`${DATA_BASE}/stocks/bars`, {
            headers: HEADERS,
            params: { symbols: symbols.join(','), timeframe: '1Day', ...barsWindow(21, '1Day'), limit: 10000, feed: 'iex' },
        });
        const results = {};
        for (const [sym, bars] of Object.entries(res.data.bars || {})) {
            if (!bars || bars.length < 21) { results[sym] = { spike: false, ratio: 1 }; continue; }
            const todayVol = bars[bars.length - 1].v;
            const avgVol = bars.slice(0, -1).reduce((s, b) => s + b.v, 0) / 20;
            const ratio = avgVol > 0 ? todayVol / avgVol : 1;
            results[sym] = {
                spike: ratio >= 2.5,        // 2.5x+ average = significant spike
                ratio: parseFloat(ratio.toFixed(2)),
                todayVol,
                avgVol: Math.round(avgVol),
            };
        }
        return results;
    } catch { return {}; }
}

function volumeBias(volumeData) {
    if (!volumeData) return 0;
    if (volumeData.ratio >= 4)   return 2;   // massive spike — major event
    if (volumeData.ratio >= 2.5) return 1.5; // significant institutional activity
    if (volumeData.ratio >= 1.8) return 0.5; // above average interest
    if (volumeData.ratio < 0.5)  return -0.5; // dead volume — avoid
    return 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. MULTI-TIMEFRAME CONFIRMATION (1-hour bars)
// ══════════════════════════════════════════════════════════════════════════════
// Checks short-term (1hr) trend alignment with daily signal.
// If daily says BUY but hourly is dumping, skip.

async function getHourlyTrend(symbols) {
    try {
        const res = await axios.get(`${DATA_BASE}/stocks/bars`, {
            headers: HEADERS,
            params: { symbols: symbols.join(','), timeframe: '1Hour', ...barsWindow(20, '1Hour'), limit: 10000, feed: 'iex' },
        });
        const results = {};
        for (const [sym, bars] of Object.entries(res.data.bars || {})) {
            if (!bars || bars.length < 10) { results[sym] = { trend: 'unknown', confirmed: true }; continue; }
            const closes = bars.map(b => b.c);
            const price = closes[closes.length - 1];

            // EMA(8) and EMA(20) on hourly
            const ema8  = emaCalc(closes, 8);
            const ema20 = emaCalc(closes, Math.min(20, closes.length));

            // Recent momentum: last 3 bars direction
            const last3 = closes.slice(-3);
            const shortMomentum = last3[2] > last3[0] ? 'up' : last3[2] < last3[0] ? 'down' : 'flat';

            let trend = 'sideways';
            if (ema8 && ema20 && price > ema8 && ema8 > ema20) trend = 'up';
            if (ema8 && ema20 && price < ema8 && ema8 < ema20) trend = 'down';

            results[sym] = { trend, shortMomentum, ema8, ema20, price };
        }
        return results;
    } catch { return {}; }
}

function emaCalc(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let em = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < values.length; i++) {
        em = values[i] * k + em * (1 - k);
    }
    return parseFloat(em.toFixed(4));
}

// Returns -2 to +1 based on whether short-term confirms or contradicts
function timeframeBias(hourly, dailySignal) {
    if (!hourly || hourly.trend === 'unknown') return 0;

    if (dailySignal === 'BUY') {
        if (hourly.trend === 'down' && hourly.shortMomentum === 'down') return -2; // contradicts — don't buy into selling
        if (hourly.trend === 'up' && hourly.shortMomentum === 'up') return 1;      // confirms — go
        if (hourly.trend === 'down') return -1;                                     // mild contradiction
    }
    if (dailySignal === 'SELL') {
        if (hourly.trend === 'up' && hourly.shortMomentum === 'up') return 1;      // bouncing — maybe hold
        if (hourly.trend === 'down') return -1;                                     // confirms sell
    }
    return 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. CORRELATION FILTER (market-wide crash detection)
// ══════════════════════════════════════════════════════════════════════════════
// If SPY is down >2% AND most watchlist stocks are red, it's a macro event.
// Don't buy dips in a market crash — wait for stabilization.

async function getMarketCorrelation(snapshots, watchlist) {
    const changes = [];
    let spyChange = 0;

    for (const sym of watchlist) {
        const snap = snapshots[sym];
        const price = snap?.latestTrade?.p || snap?.dailyBar?.c || null;
        const prev  = snap?.prevDailyBar?.c || null;
        if (price && prev) {
            const chg = ((price - prev) / prev) * 100;
            changes.push(chg);
            if (sym === 'SPY') spyChange = chg;
        }
    }

    if (changes.length < 5) return { crash: false, breadth: 0, spyChange: 0 };

    const redCount = changes.filter(c => c < -1).length;
    const breadth  = redCount / changes.length; // 0 to 1 (1 = everything red)
    const avgChange = changes.reduce((s, c) => s + c, 0) / changes.length;

    return {
        crash:     spyChange < -2 && breadth > 0.7,    // SPY down 2%+ and 70%+ of stocks red
        selloff:   spyChange < -1 && breadth > 0.6,    // mild selloff
        breadth:   parseFloat(breadth.toFixed(2)),
        spyChange: parseFloat(spyChange.toFixed(2)),
        avgChange: parseFloat(avgChange.toFixed(2)),
        redCount,
        total:     changes.length,
    };
}

function correlationFilter(correlation) {
    if (!correlation) return { block: false, reason: null };
    if (correlation.crash) return { block: true, reason: `Market crash: SPY ${correlation.spyChange}%, ${(correlation.breadth*100).toFixed(0)}% red` };
    if (correlation.selloff) return { block: false, reason: `Selloff warning: SPY ${correlation.spyChange}%`, penalty: -1.5 };
    return { block: false, reason: null, penalty: 0 };
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. PARTIAL PROFIT-TAKING (smart exits)
// ══════════════════════════════════════════════════════════════════════════════
// Sell 50% at +15%, let the rest ride with a tighter trailing stop.
// Sell another 25% at +30%. Final 25% rides with a breakeven stop.

const PROFIT_TIERS = [
    { pct: 15, sellPortion: 0.50, label: 'Take 50% at +15%' },
    { pct: 30, sellPortion: 0.50, label: 'Take 50% of remainder at +30%' }, // 50% of remaining = 25% of original
];

async function checkPartialProfits(positions) {
    const state = loadProfitState();
    const actions = [];

    for (const pos of positions) {
        const sym = pos.symbol;
        const unrealPct = parseFloat(pos.unrealized_plpc) * 100;
        const qty = parseFloat(pos.qty);
        const mktValue = parseFloat(pos.market_value);

        if (!state[sym]) state[sym] = { tiersTaken: [] };

        for (const tier of PROFIT_TIERS) {
            if (unrealPct >= tier.pct && !state[sym].tiersTaken.includes(tier.pct)) {
                const sellQty = Math.floor(qty * tier.sellPortion);
                if (sellQty < 1) continue;

                actions.push({
                    symbol: sym,
                    action: 'partial_sell',
                    qty: sellQty,
                    reason: tier.label,
                    unrealPct: unrealPct.toFixed(1),
                    tier: tier.pct,
                });
                state[sym].tiersTaken.push(tier.pct);
            }
        }

        // Clean up state for closed positions
        if (qty <= 0 && state[sym]) delete state[sym];
    }

    saveProfitState(state);
    return actions;
}

// Partial profit-take against our own fee-aware ledger (paperBroker), not a broker API.
// Needs the fill price — a partial sell without one can't be priced or costed.
function executePartialSell(symbol, qty, price) {
    if (!(price > 0)) return { success: false, error: 'no price for partial sell' };
    const r = require('./paperBroker').sell('stocks', symbol, { qty, price, reason: 'partial profit-take' });
    return r.success ? { success: true, symbol, qty, price, fee: r.fee, pnl: r.pnl } : { success: false, error: r.error };
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. OPTIONS IV RANK (for wheel strategy)
// ══════════════════════════════════════════════════════════════════════════════
// IV Rank = where current IV sits relative to past year's range.
// High IV rank (>50%) = expensive premiums = good time to sell puts/calls.
// Low IV rank (<30%) = cheap premiums = bad time for wheel.

async function getIVRank(symbols) {
    // Use Alpaca options snapshots for current IV, or approximate from ATR/price
    const results = {};
    try {
        // Approximate IV from historical volatility (ATR-based proxy)
        const res = await axios.get(`${DATA_BASE}/stocks/bars`, {
            headers: HEADERS,
            params: { symbols: symbols.join(','), timeframe: '1Day', ...barsWindow(252, '1Day'), limit: 10000, feed: 'iex' },
        });
        for (const [sym, bars] of Object.entries(res.data.bars || {})) {
            if (!bars || bars.length < 30) { results[sym] = null; continue; }

            // Calculate 20-day historical volatility (annualized)
            const returns = [];
            for (let i = 1; i < bars.length; i++) {
                returns.push(Math.log(bars[i].c / bars[i - 1].c));
            }
            const recent20 = returns.slice(-20);
            const mean20 = recent20.reduce((s, r) => s + r, 0) / 20;
            const variance20 = recent20.reduce((s, r) => s + (r - mean20) ** 2, 0) / 19;
            const hvCurrent = Math.sqrt(variance20) * Math.sqrt(252) * 100; // annualized %

            // Calculate rolling 20-day HV for the past year to get the rank
            const hvHistory = [];
            for (let i = 20; i <= returns.length; i++) {
                const window = returns.slice(i - 20, i);
                const m = window.reduce((s, r) => s + r, 0) / 20;
                const v = window.reduce((s, r) => s + (r - m) ** 2, 0) / 19;
                hvHistory.push(Math.sqrt(v) * Math.sqrt(252) * 100);
            }

            if (hvHistory.length < 10) { results[sym] = null; continue; }

            const minHV = Math.min(...hvHistory);
            const maxHV = Math.max(...hvHistory);
            const ivRank = maxHV > minHV ? ((hvCurrent - minHV) / (maxHV - minHV)) * 100 : 50;

            results[sym] = {
                ivRank:    parseFloat(ivRank.toFixed(1)),
                hvCurrent: parseFloat(hvCurrent.toFixed(1)),
                hvHigh:    parseFloat(maxHV.toFixed(1)),
                hvLow:     parseFloat(minHV.toFixed(1)),
                favorable: ivRank > 50, // good for premium selling
            };
        }
    } catch {}
    return results;
}

function wheelIVFilter(ivData) {
    if (!ivData) return { ok: true, reason: 'no IV data' };
    if (ivData.ivRank < 25) return { ok: false, reason: `IV rank too low (${ivData.ivRank}%) — cheap premiums, skip` };
    if (ivData.ivRank > 80) return { ok: true, reason: `Excellent IV rank (${ivData.ivRank}%) — rich premiums`, bonus: 1 };
    if (ivData.ivRank > 50) return { ok: true, reason: `Good IV rank (${ivData.ivRank}%)`, bonus: 0.5 };
    return { ok: true, reason: `Moderate IV rank (${ivData.ivRank}%)` };
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. EARNINGS AVOIDANCE
// ══════════════════════════════════════════════════════════════════════════════
// Don't enter new positions within 3 days of earnings. Gaps kill stops.

let earningsCache = { data: [], fetchedAt: 0 };

async function getUpcomingEarnings(symbols) {
    // Cache for 6 hours
    if (Date.now() - earningsCache.fetchedAt < 6 * 3600 * 1000 && earningsCache.data.length) {
        return earningsCache.data;
    }

    if (!FMP_KEY) return [];

    try {
        const now = new Date();
        const future = new Date(now);
        future.setDate(future.getDate() + 7); // look ahead 7 days
        const from = now.toISOString().split('T')[0];
        const to   = future.toISOString().split('T')[0];

        const res = await axios.get(
            `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`,
            { timeout: 10000 }
        );
        const all = res.data || [];
        earningsCache = {
            data: all.filter(e => symbols.includes(e.symbol)),
            fetchedAt: Date.now(),
        };
        return earningsCache.data;
    } catch { return []; }
}

function earningsFilter(symbol, earnings) {
    const now = new Date();
    const found = earnings.find(e => e.symbol === symbol);
    if (!found) return { safe: true, daysUntil: null };

    const earningsDate = new Date(found.date);
    const diffDays = (earningsDate - now) / (1000 * 60 * 60 * 24);

    if (diffDays >= 0 && diffDays <= 3) {
        return {
            safe: false,
            daysUntil: Math.ceil(diffDays),
            date: found.date,
            time: found.time || '?',
            reason: `Earnings in ${Math.ceil(diffDays)} day${diffDays > 1 ? 's' : ''} (${found.date}) — avoid new entries`,
        };
    }
    return { safe: true, daysUntil: diffDays > 0 ? Math.ceil(diffDays) : null };
}

// ══════════════════════════════════════════════════════════════════════════════
// COMBINED PRE-TRADE CHECK
// ══════════════════════════════════════════════════════════════════════════════
// Run all filters before executing a buy. Returns { allow, reasons, adjustments }

function preTradCheck({ symbol, score, volumeData, hourlyData, correlation, earnings, dailySignal }) {
    const reasons = [];
    let adjustment = 0;
    let blocked = false;

    // 1. Volume
    const vBias = volumeBias(volumeData);
    if (vBias !== 0) {
        adjustment += vBias;
        if (vBias > 0) reasons.push(`Volume spike ${volumeData.ratio}x avg (+${vBias})`);
        if (vBias < 0) reasons.push(`Dead volume (${volumeData.ratio}x avg)`);
    }

    // 2. Multi-timeframe
    const tfBias = timeframeBias(hourlyData, dailySignal || 'BUY');
    if (tfBias !== 0) {
        adjustment += tfBias;
        if (tfBias < 0) reasons.push(`Hourly contradicts: ${hourlyData?.trend} trend, ${hourlyData?.shortMomentum} momentum`);
        if (tfBias > 0) reasons.push(`Hourly confirms: ${hourlyData?.trend} trend`);
    }

    // 3. Correlation / crash
    const corrResult = correlationFilter(correlation);
    if (corrResult.block) {
        blocked = true;
        reasons.push(corrResult.reason);
    } else if (corrResult.penalty) {
        adjustment += corrResult.penalty;
        reasons.push(corrResult.reason);
    }

    // 6. Earnings
    const earningsResult = earningsFilter(symbol, earnings || []);
    if (!earningsResult.safe) {
        blocked = true;
        reasons.push(earningsResult.reason);
    }

    return {
        allow:      !blocked,
        adjustment: parseFloat(adjustment.toFixed(1)),
        blocked,
        reasons,
        details: { volumeData, hourlyData, correlation, earningsResult },
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// DRAWDOWN PROTECTION (bonus)
// ══════════════════════════════════════════════════════════════════════════════
// If portfolio is down >5% today, halt new trades.

function drawdownCheck(account) {
    const equity = parseFloat(account.equity || 0);
    const lastEquity = parseFloat(account.last_equity || equity);
    if (lastEquity <= 0) return { halt: false, drawdown: 0 };

    const drawdown = ((equity - lastEquity) / lastEquity) * 100;
    return {
        halt: drawdown < -5,
        warning: drawdown < -3,
        drawdown: parseFloat(drawdown.toFixed(2)),
        reason: drawdown < -5 ? `Portfolio down ${drawdown.toFixed(1)}% today — halting new trades` :
                drawdown < -3 ? `Portfolio down ${drawdown.toFixed(1)}% — proceed with caution` : null,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. SECTOR ROTATION
// ══════════════════════════════════════════════════════════════════════════════
// Track which sectors are leading. Favor stocks in hot sectors.

const SECTOR_MAP = {
    'TSLA': 'auto', 'RIVN': 'auto',
    'NVDA': 'semis', 'AMD': 'semis', 'SMCI': 'semis', 'ARM': 'semis', 'IONQ': 'semis',
    'AAPL': 'tech', 'META': 'tech', 'GOOGL': 'tech', 'MSFT': 'tech', 'SNAP': 'tech', 'RBLX': 'tech',
    'AMZN': 'consumer', 'NFLX': 'consumer', 'UBER': 'consumer', 'BABA': 'consumer',
    'MSTR': 'crypto', 'COIN': 'crypto',
    'PLTR': 'defense', 'SOFI': 'fintech', 'HOOD': 'fintech',
    'GME': 'meme', 'AMC': 'meme',
    'SPY': 'index',
    'TQQQ': 'leveraged', 'SOXL': 'leveraged', 'UPRO': 'leveraged', 'LABU': 'leveraged', 'FNGU': 'leveraged',
};

function getSectorRotation(snapshots, watchlist) {
    const sectorPerf = {};
    for (const sym of watchlist) {
        const sector = SECTOR_MAP[sym] || 'other';
        const snap = snapshots[sym];
        const price = snap?.latestTrade?.p || snap?.dailyBar?.c || null;
        const prev  = snap?.prevDailyBar?.c || null;
        if (!price || !prev) continue;
        const chg = ((price - prev) / prev) * 100;
        if (!sectorPerf[sector]) sectorPerf[sector] = [];
        sectorPerf[sector].push(chg);
    }

    // Average change per sector
    const sectorAvg = {};
    for (const [sector, changes] of Object.entries(sectorPerf)) {
        sectorAvg[sector] = parseFloat((changes.reduce((s, c) => s + c, 0) / changes.length).toFixed(2));
    }

    // Rank sectors
    const ranked = Object.entries(sectorAvg).sort((a, b) => b[1] - a[1]);
    const hotSectors = ranked.filter(([_, avg]) => avg > 1).map(([s]) => s);
    const coldSectors = ranked.filter(([_, avg]) => avg < -1).map(([s]) => s);

    return { sectorAvg, ranked, hotSectors, coldSectors };
}

function sectorBias(symbol, sectorData) {
    if (!sectorData) return 0;
    const sector = SECTOR_MAP[symbol] || 'other';
    if (sectorData.hotSectors.includes(sector)) return 1;   // hot sector bonus
    if (sectorData.coldSectors.includes(sector)) return -1; // cold sector penalty
    return 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// 8. SUPPORT / RESISTANCE LEVELS (Pivot Points)
// ══════════════════════════════════════════════════════════════════════════════
// Classic pivot: P = (H + L + C) / 3, S1 = 2P - H, R1 = 2P - L

async function getPivotLevels(symbols) {
    try {
        const res = await axios.get(`${DATA_BASE}/stocks/bars`, {
            headers: HEADERS,
            params: { symbols: symbols.join(','), timeframe: '1Day', ...barsWindow(2, '1Day'), limit: 10000, feed: 'iex' },
        });
        const results = {};
        for (const [sym, bars] of Object.entries(res.data.bars || {})) {
            if (!bars || bars.length < 1) { results[sym] = null; continue; }
            const prev = bars[bars.length - 1]; // most recent completed bar
            const H = prev.h, L = prev.l, C = prev.c;
            const P = (H + L + C) / 3;
            results[sym] = {
                pivot: parseFloat(P.toFixed(2)),
                r1: parseFloat((2 * P - L).toFixed(2)),
                r2: parseFloat((P + (H - L)).toFixed(2)),
                s1: parseFloat((2 * P - H).toFixed(2)),
                s2: parseFloat((P - (H - L)).toFixed(2)),
            };
        }
        return results;
    } catch { return {}; }
}

function pivotBias(price, pivots) {
    if (!pivots || !price) return 0;
    // Near support = good buy zone, near resistance = risky buy
    const distToS1 = ((price - pivots.s1) / price) * 100;
    const distToR1 = ((pivots.r1 - price) / price) * 100;

    if (distToS1 < 1) return 1.5;    // very near support — good entry
    if (distToS1 < 2) return 0.5;    // approaching support
    if (distToR1 < 1) return -1.5;   // very near resistance — risky entry
    if (distToR1 < 2) return -0.5;   // approaching resistance
    return 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// 9. TIME-OF-DAY FILTER
// ══════════════════════════════════════════════════════════════════════════════
// First 30min and last 30min have highest volume/movement.
// Mid-day (11:30-2:00) is noise — reduce position sizing or skip low-conviction.

function timeOfDayFilter() {
    const now = new Date();
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false,
        hour: '2-digit', minute: '2-digit' });
    const [h, m] = etStr.split(':').map(Number);
    const mins = h * 60 + m;

    const OPEN = 9 * 60 + 30;
    const FIRST_30 = OPEN + 30;
    const LUNCH_START = 11 * 60 + 30;
    const LUNCH_END = 14 * 60;
    const LAST_30 = 15 * 60 + 30;
    const CLOSE = 16 * 60;

    // Thresholds tuned to the actual score distribution: signals cluster near 0,
    // so a gate of 5-6 effectively froze the scanner (it almost never fired). The
    // earlier raise to 5-6 was a misdiagnosis — the bad win rate was the politico
    // copies, not the scanner. Restored to reachable levels, still keeping opening/
    // midday choppy periods stricter than calm normal/closing hours.
    // Adaptive gate: the tuner audits daily (market moved + we didn't trade →
    // loosen; trading but losing → tighten) and adjusts this delta, bounded ±2.
    let delta = 0;
    try { delta = require('./adaptiveTuner').getCalib().stocks.minScoreDelta || 0; } catch {}
    const ms = (base) => Math.max(1, base + delta);

    if (mins >= OPEN && mins < FIRST_30) {
        return { period: 'opening', quality: 'high', note: 'Opening volatility — strong signals only', minScore: ms(4) };
    }
    if (mins >= LAST_30 && mins < CLOSE) {
        return { period: 'closing', quality: 'high', note: 'Power hour — good for momentum plays', minScore: ms(3) };
    }
    if (mins >= LUNCH_START && mins < LUNCH_END) {
        return { period: 'midday', quality: 'low', note: 'Lunch lull — skip low-conviction trades', minScore: ms(4) };
    }
    return { period: 'normal', quality: 'medium', note: 'Normal hours', minScore: ms(3) };
}

// ══════════════════════════════════════════════════════════════════════════════
// 10. DRAWDOWN PROTECTION (enhanced)
// ══════════════════════════════════════════════════════════════════════════════
// Already have basic drawdown check above. Add position-level max loss.
// If a single position is down >25%, force close to prevent further damage.

async function checkMaxLossPositions(positions) {
    const forceClose = [];
    for (const pos of positions) {
        const unrealPct = parseFloat(pos.unrealized_plpc) * 100;
        if (unrealPct < -25) {
            forceClose.push({
                symbol: pos.symbol,
                unrealPct: unrealPct.toFixed(1),
                qty: pos.qty,
                reason: `Max loss triggered: ${pos.symbol} down ${unrealPct.toFixed(1)}%`,
            });
        }
    }
    return forceClose;
}

module.exports = {
    // Individual fetchers
    getVolumeSpikes,
    getHourlyTrend,
    getMarketCorrelation,
    checkPartialProfits,
    executePartialSell,
    getIVRank,
    wheelIVFilter,
    getUpcomingEarnings,
    earningsFilter,
    getPivotLevels,
    checkMaxLossPositions,
    // Bias functions
    volumeBias,
    timeframeBias,
    correlationFilter,
    sectorBias,
    getSectorRotation,
    pivotBias,
    timeOfDayFilter,
    // Combined
    preTradCheck,
    drawdownCheck,
    // Constants
    PROFIT_TIERS,
    SECTOR_MAP,
};
