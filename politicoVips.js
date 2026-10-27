// politicoVips.js — Track top 5 congressional buyers, chart performance, validated auto-buy
require('dotenv').config();
const axios       = require('axios');
const fs          = require('fs');
const path        = require('path');
const stocks      = require('./stocks');
const riskManager = require('./riskManager');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE         = process.env.ALPACA_BASE_URL;
const VIP_COUNT    = 5;
const DATA_DIR     = require('./dataDir');
const VIP_FILE     = path.join(DATA_DIR, 'politico-vips.json');
const FRESHNESS    = 30;         // extended: 30 days (disclosures can be delayed)
const MAX_RSI      = 80;         // loosened: allow up to 80 RSI (was 70 — too tight)
const MAX_DIP      = -10;        // loosened: allow -10% dip (was -5% — too tight)
const BUY_SIZE_PCT   = 0.12;     // 12% of portfolio per validated VIP trade (increased from 4%)
const MAX_NOTIONAL   = 500;      // hard cap — never spend more than $500 on a single VIP trade
// REMOVED: MIN_NEWS gate — politicians trade on insider knowledge, not news

// ── State ─────────────────────────────────────────────────────────────────────

function loadState() {
    try { return JSON.parse(fs.readFileSync(VIP_FILE, 'utf8')); }
    catch {
        const s = { vips: {}, autoBuys: {}, lastUpdate: null };
        fs.writeFileSync(VIP_FILE, JSON.stringify(s, null, 2));
        return s;
    }
}
function saveState(s) { fs.writeFileSync(VIP_FILE, JSON.stringify(s, null, 2)); }

// ── Rebuild autoBuys from Alpaca order history (survives deploys) ─────────────
// Called once on first scan if autoBuys is empty. Queries 60 days of orders so
// we never re-buy a ticker we've already ordered — even after a fresh deploy.

let _autoBuysBootstrapped = false;

async function bootstrapAutoBuys(state) {
    if (_autoBuysBootstrapped) return;
    _autoBuysBootstrapped = true;

    if (Object.keys(state.autoBuys).length > 0) return; // already has data

    try {
        // Fetch closed + all orders from last 60 days
        const [closedRes, posRes] = await Promise.all([
            axios.get(`${BASE}/orders?status=all&limit=500&direction=desc`, { headers: HEADERS }),
            axios.get(`${BASE}/positions`, { headers: HEADERS }),
        ]);

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 60);

        const recentOrders = (closedRes.data || []).filter(o =>
            o.side === 'buy' && new Date(o.created_at) >= cutoff
        );

        // Build a set of tickers we've already ordered recently
        const orderedTickers = new Set(recentOrders.map(o => o.symbol.toUpperCase()));
        const heldTickers    = new Set((posRes.data || []).map(p => p.symbol.toUpperCase()));

        // For all VIP trades in state, if the ticker was recently ordered or held,
        // mark the autoBuys key so we don't re-buy
        for (const [name, vip] of Object.entries(state.vips)) {
            for (const trade of (vip.trades || [])) {
                const key = `${name}:${trade.ticker}:${trade.date}`;
                if (!state.autoBuys[key]) {
                    const ticker = trade.ticker.toUpperCase();
                    if (heldTickers.has(ticker)) {
                        state.autoBuys[key] = { date: new Date().toISOString(), notional: 0, reason: 'bootstrap:held' };
                    } else if (orderedTickers.has(ticker)) {
                        state.autoBuys[key] = { date: new Date().toISOString(), notional: 0, reason: 'bootstrap:ordered' };
                    }
                }
            }
        }

        // Also mark any ticker ordered in last 14 days (freshness window) as attempted
        // so brand-new VIP trades for those tickers won't double-fire
        for (const o of recentOrders) {
            const daysSince = Math.floor((Date.now() - new Date(o.created_at)) / 86400000);
            if (daysSince <= FRESHNESS) {
                // Synthetic key to block same-ticker buys in the VIP fresh window
                const syntheticKey = `__bootstrap__:${o.symbol.toUpperCase()}:recent`;
                state.autoBuys[syntheticKey] = { date: o.created_at, notional: parseFloat(o.notional || 0), reason: 'bootstrap:recent-order' };
            }
        }

        saveState(state);
        const total = Object.keys(state.autoBuys).length;
        console.log(`[Politico VIP] Bootstrap: marked ${total} autoBuys from Alpaca history`);
    } catch (err) {
        console.log(`[Politico VIP] Bootstrap warning: ${err.message}`);
    }
}

// ── Identify top 5 ───────────────────────────────────────────────────────────

function identifyVips(topPoliticians) {
    return topPoliticians.slice(0, VIP_COUNT).map(p => ({
        name:    p.name,
        party:   p.party   || '?',
        chamber: p.chamber || '?',
    }));
}

// ── Record new trades for VIPs ────────────────────────────────────────────────

function extractVipTrades(rawTrades, vipNames) {
    const nameSet = new Set(vipNames.map(n => n.toLowerCase()));
    const cutoff  = new Date();
    cutoff.setDate(cutoff.getDate() - 45);

    return rawTrades.filter(t => {
        if (!/buy|purchase/i.test(t.txType)) return false;
        const name = t.politician
            ? `${t.politician.firstName} ${t.politician.lastName}`.trim().toLowerCase()
            : '';
        if (!nameSet.has(name)) return false;
        return new Date(t.txDate || t.pubDate || 0) >= cutoff;
    }).map(t => ({
        politician: `${t.politician.firstName} ${t.politician.lastName}`.trim(),
        ticker:     (t.issuer?.issuerTicker || '').replace(/:US$/i, '').trim(),
        date:       t.txDate || t.pubDate || '',
        pubDate:    t.pubDate || t.txDate || '',
        value:      t.value || 0,
    })).filter(t => t.ticker && t.ticker !== 'N/A' && t.ticker.length <= 6);
}

// ── Validation pipeline (simplified — removed sentiment gate) ────────────────

async function validateTrade(ticker, txDate) {
    const reasons = [];

    // 1. Freshness — trade must be disclosed within 14 days (relaxed from 7)
    const daysSince = Math.floor((Date.now() - new Date(txDate).getTime()) / (86400000));
    if (daysSince > FRESHNESS) {
        reasons.push(`stale (${daysSince}d ago)`);
        return { valid: false, reasons };
    }

    // 2. Stock price + daily change
    const snapshots = await stocks.getSnapshots([ticker]);
    const snap      = snapshots[ticker];
    const price     = snap?.latestTrade?.p || snap?.dailyBar?.c || null;
    const prevClose = snap?.prevDailyBar?.c || null;
    const change    = price && prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

    if (!price) {
        reasons.push('no price data');
        return { valid: false, reasons, price: null };
    }

    if (change < MAX_DIP) {
        reasons.push(`freefall (${change.toFixed(1)}% today)`);
        return { valid: false, reasons, price };
    }

    // 3. RSI — don't buy overbought
    const rsiMap = await stocks.getBatchRSI([ticker]);
    const rsi    = rsiMap[ticker] ?? null;
    if (rsi !== null && rsi > MAX_RSI) {
        reasons.push(`overbought RSI ${rsi}`);
        return { valid: false, reasons, price, rsi };
    }

    // NOTE: Sentiment gate removed — politicians often trade BEFORE news breaks.
    // The follow-up research system in politicoScanner.js will check sentiment
    // 3 and 7 days later to catch the insider edge.

    return { valid: true, reasons: ['all checks passed'], price, rsi, change };
}

async function placeOrder(ticker, notional) {
    try {
        await axios.post(`${BASE}/orders`, {
            symbol: ticker, side: 'buy', type: 'market',
            time_in_force: 'day', notional: notional.toFixed(2),
        }, { headers: HEADERS });
        return { success: true, notional };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

// ── Performance update ────────────────────────────────────────────────────────

async function updatePerformance(state) {
    const allTickers = new Set();
    for (const vip of Object.values(state.vips)) {
        (vip.trades || []).forEach(t => { if (t.ticker) allTickers.add(t.ticker); });
    }
    if (!allTickers.size) return;

    const snapshots = await stocks.getSnapshots([...allTickers]);

    for (const vip of Object.values(state.vips)) {
        let wins = 0, total = 0, sumReturn = 0;

        for (const trade of (vip.trades || [])) {
            const snap  = snapshots[trade.ticker];
            const current = snap?.latestTrade?.p || snap?.dailyBar?.c || trade.currentPrice;
            if (current) trade.currentPrice = current;
            if (trade.entryPrice && trade.entryPrice > 0) {
                trade.pctReturn = parseFloat(((current - trade.entryPrice) / trade.entryPrice * 100).toFixed(2));
                total++;
                sumReturn += trade.pctReturn;
                if (trade.pctReturn > 0) wins++;
            }
        }

        vip.stats = {
            totalTrades: total,
            wins,
            winRate:   total > 0 ? parseFloat((wins / total * 100).toFixed(1)) : 0,
            avgReturn: total > 0 ? parseFloat((sumReturn / total).toFixed(2)) : 0,
        };
    }
}

// ── Historical price chart data ───────────────────────────────────────────────

function buildChartData(state) {
    const series = {};
    for (const [name, vip] of Object.entries(state.vips)) {
        const sorted = [...(vip.trades || [])]
            .filter(t => t.entryPrice && t.pctReturn != null)
            .sort((a, b) => a.date.localeCompare(b.date));

        let cumulative = 0;
        const points = sorted.map(t => {
            cumulative += t.pctReturn;
            return {
                date:   t.date?.slice(0, 10) || '?',
                ticker: t.ticker,
                ret:    t.pctReturn,
                cum:    parseFloat(cumulative.toFixed(2)),
            };
        });

        series[name] = {
            party:  vip.party,
            points,
            stats:  vip.stats,
        };
    }
    return series;
}

// ── Main orchestrator ────────────────────────────────────────────────────────

async function scanVips(rawTrades, topPoliticians) {
    const state = loadState();
    const log   = [];

    // Diagnostic logging
    if (!topPoliticians || topPoliticians.length === 0) {
        log.push(`⚠️ DIAGNOSTIC: No top politicians provided to scanVips`);
    }
    if (!rawTrades || rawTrades.length === 0) {
        log.push(`⚠️ DIAGNOSTIC: No raw trades provided to scanVips`);
    }

    // On first scan after a deploy, rebuild autoBuys from Alpaca history
    // so we never re-buy tickers we've already ordered (state file is wiped on deploy)
    await bootstrapAutoBuys(state);

    const vips = identifyVips(topPoliticians);
    const vipNames = vips.map(v => v.name);
    if (vips.length === 0) log.push(`⚠️ DIAGNOSTIC: No VIPs identified from top politicians`);
    log.push(`[VIP Scan] Tracking ${vips.length} VIPs: ${vipNames.join(', ') || 'none'}`);

    for (const v of vips) {
        if (!state.vips[v.name]) {
            state.vips[v.name] = {
                party: v.party, chamber: v.chamber,
                trades: [], stats: { totalTrades: 0, wins: 0, winRate: 0, avgReturn: 0 },
            };
            log.push(`New VIP tracked: ${v.name} (${v.party})`);
        }
    }

    for (const name of Object.keys(state.vips)) {
        state.vips[name].active = vipNames.includes(name);
    }

    const vipTrades   = extractVipTrades(rawTrades, vipNames);
    const newTrades   = [];

    for (const trade of vipTrades) {
        const vip = state.vips[trade.politician];
        if (!vip) continue;

        const exists = (vip.trades || []).some(
            t => t.ticker === trade.ticker && t.date === trade.date
        );
        if (exists) continue;

        const snapshots = await stocks.getSnapshots([trade.ticker]);
        const snap      = snapshots[trade.ticker];
        const entryPrice = snap?.latestTrade?.p || snap?.dailyBar?.c || null;

        const record = {
            ticker:       trade.ticker,
            date:         trade.date,
            pubDate:      trade.pubDate,
            entryPrice,
            currentPrice: entryPrice,
            pctReturn:    0,
            value:        trade.value,
            validated:    false,
            autoBought:   false,
            validationReasons: [],
        };

        const validation = await validateTrade(trade.ticker, trade.pubDate || trade.date);
        record.validated = validation.valid;
        record.validationReasons = validation.reasons;

        const autoBuyKey     = `${trade.politician}:${trade.ticker}:${trade.date}`;
        const bootstrapKey   = `__bootstrap__:${trade.ticker.toUpperCase()}:recent`;
        const alreadyAttempted = state.autoBuys[autoBuyKey] || state.autoBuys[bootstrapKey];

        let polPaused = false;
        try { polPaused = !!require('./adaptiveTuner').getCalib().paused?.politico; } catch {}
        if (polPaused && validation.valid && !alreadyAttempted) {
            log.push(`VIP skip ${trade.ticker}: circuit breaker — politico stream paused (low win rate)`);
        }
        if (validation.valid && !alreadyAttempted && !polPaused) {
            try {
                const [accRes, posRes] = await Promise.all([
                    axios.get(`${BASE}/account`, { headers: HEADERS }),
                    axios.get(`${BASE}/positions`, { headers: HEADERS }),
                ]);

                // Use live positions as source of truth — don't re-buy if already holding
                // (state file gets wiped on deploy; positions never lie)
                const alreadyHeld = posRes.data.some(
                    p => p.symbol.toUpperCase() === trade.ticker.toUpperCase() && parseFloat(p.qty) > 0
                );
                if (alreadyHeld) {
                    // Still mark as bought so state stays consistent
                    state.autoBuys[autoBuyKey] = { date: new Date().toISOString(), notional: 0, reason: 'already held' };
                    log.push(`VIP skip ${trade.ticker}: already holding position`);
                } else {
                    const portfolioValue = parseFloat(accRes.data.portfolio_value);
                    const riskStatus = riskManager.getStatus(portfolioValue, posRes.data);
                    const rawNotional = riskManager.sizeFor('medium', riskStatus, BUY_SIZE_PCT);
                    const notional    = Math.min(rawNotional, MAX_NOTIONAL); // hard cap per trade

                    if (notional > 50) {
                        const result = await placeOrder(trade.ticker, notional);
                        record.autoBought = result.success;
                        // Always mark as attempted — success OR failure — so we never retry
                        // the same trade. State file gets wiped on deploy but live positions
                        // check above handles that case.
                        state.autoBuys[autoBuyKey] = {
                            date:     new Date().toISOString(),
                            notional: result.success ? result.notional : 0,
                            reason:   result.success ? 'bought' : `failed: ${result.error}`,
                        };
                        if (result.success) {
                            log.push(`VIP auto-buy: ${trade.politician} -> $${trade.ticker} ($${notional.toFixed(0)})`);
                        } else {
                            log.push(`VIP auto-buy failed: ${trade.ticker} — ${result.error}`);
                        }
                    } else {
                        // Not enough capital — mark as skipped so we don't spam on every scan
                        state.autoBuys[autoBuyKey] = {
                            date: new Date().toISOString(), notional: 0, reason: 'insufficient capital',
                        };
                        log.push(`VIP skip ${trade.ticker}: medium tier full ($${notional.toFixed(0)} avail)`);
                    }
                }
            } catch (err) {
                log.push(`VIP sizing error: ${err.message}`);
                // Mark as attempted so we don't retry this exact trade next scan
                state.autoBuys[autoBuyKey] = {
                    date: new Date().toISOString(), notional: 0, reason: `error: ${err.message}`,
                };
            }
        } else if (!validation.valid) {
            log.push(`VIP ${trade.politician} -> $${trade.ticker}: skipped (${validation.reasons.join(', ')})`);
        }

        vip.trades.push(record);
        newTrades.push({ ...record, politician: trade.politician });
    }

    await updatePerformance(state);

    state.lastUpdate = new Date().toISOString();
    saveState(state);

    return { log, newTrades, chartData: buildChartData(state) };
}

// ── Public API ────────────────────────────────────────────────────────────────

function getVipData() {
    const state = loadState();
    return {
        vips:      state.vips,
        autoBuys:  state.autoBuys,
        chartData: buildChartData(state),
        lastUpdate: state.lastUpdate,
    };
}

module.exports = { scanVips, getVipData, updatePerformance };
