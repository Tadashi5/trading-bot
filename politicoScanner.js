require('dotenv').config();
const axios        = require('axios');
const fs           = require('fs');
const path         = require('path');
const politicoVips = require('./politicoVips');
const stocks       = require('./stocks');
const politicoResearch = require('./politicoResearch');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;


const HOT_THRESHOLD   = 2;     // 2+ politicians buying same ticker = HOT (was 3)
const BIG_TRADE_MIN   = 15000; // $15K+ = deep research + learn (was $50K)
const LOOKBACK_DAYS   = 30;
const BUY_SIZE_PCT    = 0.15;  // 15% of cash per hot signal (increased from 8%)
const FOLLOW_SIZE_PCT = 0.08;  // 8% of cash per big-money follow (increased from 3%)
const MAX_NOTIONAL    = 600;   // hard cap — never spend more than $600 on a single Politico trade
const DATA_DIR        = require('./dataDir');
const SIGNALS_FILE    = path.join(DATA_DIR, 'politico-signals.json');
const FOLLOWUP_FILE   = path.join(DATA_DIR, 'politico-followups.json');

// ── Signal state ──────────────────────────────────────────────────────────────

function loadState() {
    try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); }
    catch {
        const s = { autoTraded: {}, followMoney: {}, tradeFeed: [], lastScan: null, lastResult: null };
        fs.writeFileSync(SIGNALS_FILE, JSON.stringify(s, null, 2));
        return s;
    }
}
function saveState(s) { fs.writeFileSync(SIGNALS_FILE, JSON.stringify(s, null, 2)); }

// ── Follow-up research state (tracks trades for delayed re-check) ────────────

function loadFollowups() {
    try { return JSON.parse(fs.readFileSync(FOLLOWUP_FILE, 'utf8')); }
    catch { return { pending: [], completed: [], learnings: [] }; }
}
function saveFollowups(f) { fs.writeFileSync(FOLLOWUP_FILE, JSON.stringify(f, null, 2)); }

// ── Congressional trade fetcher (Quiver Quant public API) ────────────────────
// Capitol Trades migrated to a client-side rendered Next.js app in 2026 and no
// longer embeds trade JSON in HTML. Quiver Quant provides the same STOCK Act
// disclosure data via a clean public REST API — no key required.

// Congressional trades via FMP's /stable/ endpoints (senate + house). The old
// QuiverQuant free endpoint was locked behind auth (401) around Jun 2026 — which froze
// the feed for ~2 months without any error surfacing. FMP's /stable/ works with the
// existing FMP_API_KEY (the legacy /api/v4/ variants are deprecated → 403).
async function fetchChamber(chamber) {
    const key = process.env.FMP_API_KEY;
    if (!key) return [];
    try {
        const url = `https://financialmodelingprep.com/stable/${chamber}-latest?apikey=${key}`;
        const res = await axios.get(url, { timeout: 12000 });
        const raw = Array.isArray(res.data) ? res.data : [];
        return raw
            // equities only — skip bonds / municipal / treasury (they carry a symbol too)
            .filter(t => t.symbol && !/bond|municipal|treasury|note/i.test(t.assetType || ''))
            .map(t => {
                const m = String(t.amount || '').match(/\$([\d,]+)\s*-\s*\$([\d,]+)/);
                const value = m
                    ? (parseInt(m[1].replace(/,/g, '')) + parseInt(m[2].replace(/,/g, ''))) / 2
                    : 0;
                return {
                    txType: /purchase|buy/i.test(t.type || '') ? 'buy' : 'sell',
                    issuer: { issuerTicker: String(t.symbol).replace(/:US$/i, '').trim().toUpperCase() },
                    politician: {
                        firstName: t.firstName || '',
                        lastName:  t.lastName || '',
                        party:     '',                       // FMP doesn't provide party
                        chamber,
                    },
                    txDate:  t.transactionDate || '',
                    pubDate: t.disclosureDate  || '',
                    value,
                };
            });
    } catch (err) {
        console.log(`[Politico] FMP ${chamber} fetch error: ${err.response?.status || err.message}`);
        return [];
    }
}

async function scrapeTrades() {
    const [senate, house] = await Promise.all([fetchChamber('senate'), fetchChamber('house')]);
    const all = [...senate, ...house];
    if (!all.length) console.log('[Politico] FMP returned no congressional trades (check FMP_API_KEY / plan)');
    return all;
}

// ── Quick stock research (news + price context) ──────────────────────────────

async function researchTicker(ticker) {
    try {
        const [snapshots, news] = await Promise.all([
            stocks.getSnapshots([ticker]),
            stocks.getNews(ticker),
        ]);
        const snap  = snapshots[ticker];
        const price = snap?.latestTrade?.p || snap?.dailyBar?.c || null;
        const prev  = snap?.prevDailyBar?.c || null;
        const change = price && prev ? ((price - prev) / prev * 100) : 0;
        const sentiment = stocks.newsSentiment(news);
        // Dollar volume (price × shares). Was never returned before, which made the
        // VIP-follow "low volume" gate reject EVERY trade (undefined < 1M). That bug
        // is why politico executed 0 auto-trades despite finding 90% politicians.
        const shareVol = snap?.dailyBar?.v || snap?.prevDailyBar?.v || 0;
        const volume = price ? price * shareVol : 0;
        const headlines = (news || []).slice(0, 5).map(n => ({
            title: n.headline || n.title || '',
            date:  n.created_at || n.publishedAt || '',
        }));
        return { price, change: parseFloat(change.toFixed(2)), sentiment, volume, headlines };
    } catch { return { price: null, change: 0, sentiment: 0, volume: 0, headlines: [] }; }
}

// ── Analysis ──────────────────────────────────────────────────────────────────

function analyzeTrades(trades) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

    const recentBuys = trades.filter(t => {
        if (!/buy|purchase/i.test(t.txType)) return false;
        return new Date(t.txDate || t.pubDate || 0) >= cutoff;
    });

    const recentSells = trades.filter(t => {
        if (!/sell/i.test(t.txType)) return false;
        return new Date(t.txDate || t.pubDate || 0) >= cutoff;
    });

    // ticker → { politicians: Set, trades: [], latestDate }
    const tickerMap = {};
    const polMap    = {};
    const allTrades = []; // full trade feed

    for (const t of [...recentBuys, ...recentSells]) {
        const ticker = (t.issuer?.issuerTicker || '').replace(/:US$/i, '').trim();
        if (!ticker || ticker === 'N/A' || ticker.length > 6) continue;

        const name    = t.politician ? `${t.politician.firstName} ${t.politician.lastName}`.trim() : 'Unknown';
        const party   = t.politician?.party   || '';
        const chamber = t.politician?.chamber || '';
        const date    = t.txDate || t.pubDate || '';
        const side    = /buy|purchase/i.test(t.txType) ? 'buy' : 'sell';
        const value   = t.value || 0;

        allTrades.push({ ticker, politician: name, party, chamber, date, side, value });

        // Only buys count for hot signals
        if (side === 'buy') {
            if (!tickerMap[ticker]) tickerMap[ticker] = { politicians: new Set(), trades: [], latestDate: '' };
            tickerMap[ticker].politicians.add(name);
            tickerMap[ticker].trades.push({ politician: name, date, value });
            if (date > tickerMap[ticker].latestDate) tickerMap[ticker].latestDate = date;

            if (!polMap[name]) polMap[name] = { name, party, chamber, buys: [], tickers: new Set() };
            polMap[name].buys.push({ ticker, date, value });
            polMap[name].tickers.add(ticker);
        }
    }

    // Hot signals: 3+ unique politicians buying same ticker (lowered from 5)
    const hotSignals = Object.entries(tickerMap)
        .filter(([, d]) => d.politicians.size >= HOT_THRESHOLD)
        .map(([ticker, d]) => ({
            ticker,
            count:       d.politicians.size,
            politicians: [...d.politicians],
            latestDate:  d.latestDate,
            totalValue:  d.trades.reduce((s, t) => s + (t.value || 0), 0),
        }))
        .sort((a, b) => b.count - a.count);

    // Big money trades: any single trade >= $50K
    const bigMoney = allTrades
        .filter(t => t.side === 'buy' && t.value >= BIG_TRADE_MIN)
        .sort((a, b) => b.value - a.value);

    // Top 20 politicians by buy activity
    const topPoliticians = Object.values(polMap)
        .sort((a, b) => b.buys.length - a.buys.length)
        .slice(0, 20)
        .map(p => {
            const sorted = [...p.buys].sort((a, b) => b.date.localeCompare(a.date));
            return {
                name:       p.name,
                party:      p.party,
                chamber:    p.chamber,
                buyCount:   p.buys.length,
                tickers:    [...p.tickers].slice(0, 6).join(', '),
                latestBuy:  sorted[0]?.ticker   || '—',
                latestDate: sorted[0]?.date     || '—',
                totalValue: p.buys.reduce((s, b) => s + (b.value || 0), 0),
            };
        });

    return { hotSignals, bigMoney, topPoliticians, recentBuyCount: recentBuys.length, allTrades };
}

// ── Alpaca helpers ────────────────────────────────────────────────────────────

async function getAccount() {
    try {
        const [posRes, accRes] = await Promise.all([
            axios.get(`${BASE}/positions`, { headers: HEADERS }),
            axios.get(`${BASE}/account`,   { headers: HEADERS }),
        ]);
        return { positions: posRes.data, cash: parseFloat(accRes.data.cash) };
    } catch { return { positions: [], cash: 0 }; }
}

// RETIRED. Congressional disclosures lag up to 45 days under the STOCK Act, so the
// information is stale before it is public and there is no edge left to copy. Live
// record: 11 trades, 18% win rate. New buys are off; sells still run so any open
// position can unwind. Flip to true only with evidence the lag has closed.
const POLITICO_BUYS_ENABLED = false;

async function placeOrder(ticker, notional) {
    // Exit paths call this with a NEGATIVE notional. It used to post side:'buy'
    // regardless, so every politico sell was rejected and positions never closed.
    const side = notional < 0 ? 'sell' : 'buy';
    if (side === 'buy' && !POLITICO_BUYS_ENABLED) {
        return { success: false, error: 'politico retired — new buys disabled' };
    }
    try {
        await axios.post(`${BASE}/orders`, {
            symbol: ticker, side, type: 'market',
            time_in_force: 'day', notional: Math.abs(notional).toFixed(2),
        }, { headers: HEADERS });
        return { success: true, notional };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

// ── Cross-reference with open positions ───────────────────────────────────────

function crossReference(hotSignals, positions) {
    const posMap = {};
    for (const p of positions) posMap[p.symbol.toUpperCase()] = p;
    return hotSignals.map(s => {
        const pos = posMap[s.ticker.toUpperCase()];
        return {
            ...s,
            inPortfolio:  !!pos,
            unrealizedPct: pos ? (parseFloat(pos.unrealized_plpc) * 100).toFixed(2) : null,
            marketValue:   pos ? parseFloat(pos.market_value).toFixed(2) : null,
        };
    });
}

// ── Follow-up research: re-check trades 3 and 7 days later ──────────────────

async function runFollowups() {
    const followups = loadFollowups();
    const now = Date.now();
    const results = [];

    const stillPending = [];
    for (const item of followups.pending) {
        const elapsed = (now - new Date(item.tradeDate).getTime()) / 86400000;
        const checkAt = item.nextCheckDays;

        if (elapsed >= checkAt) {
            // Time to re-check this trade
            const research = await researchTicker(item.ticker);
            const priceChange = item.entryPrice && research.price
                ? ((research.price - item.entryPrice) / item.entryPrice * 100).toFixed(2)
                : null;

            const result = {
                ticker:       item.ticker,
                politician:   item.politician,
                tradeDate:    item.tradeDate,
                checkDay:     checkAt,
                checkedAt:    new Date().toISOString(),
                entryPrice:   item.entryPrice,
                currentPrice: research.price,
                priceChange:  priceChange ? parseFloat(priceChange) : null,
                sentiment:    research.sentiment,
                headlines:    research.headlines,
                side:         item.side,
                value:        item.value,
            };
            results.push(result);
            followups.completed.push(result);

            // Schedule next check: 3 → 7 → 30 → 180 days
            if (checkAt === 3) {
                stillPending.push({ ...item, nextCheckDays: 7 });
            } else if (checkAt === 7) {
                stillPending.push({ ...item, nextCheckDays: 30 });
            } else if (checkAt === 30) {
                stillPending.push({ ...item, nextCheckDays: 180 });
            }
            // else: 180-day check is final, don't re-queue

            // Record learnings at key checkpoints
            if (priceChange !== null && [7, 30, 180].includes(checkAt)) {
                followups.learnings.push({
                    ticker:       item.ticker,
                    politician:   item.politician,
                    side:         item.side,
                    value:        item.value,
                    priceMove:    parseFloat(priceChange),
                    direction:    parseFloat(priceChange) > 0 ? 'up' : 'down',
                    verdict:      item.side === 'buy' && parseFloat(priceChange) > 0 ? 'insider_win'
                                : item.side === 'sell' && parseFloat(priceChange) < 0 ? 'insider_win'
                                : 'no_edge',
                    checkDays:    checkAt,
                    date:         new Date().toISOString(),
                });
            }
        } else {
            stillPending.push(item);
        }
    }

    followups.pending = stillPending;
    // Trim completed/learnings to last 200 entries
    if (followups.completed.length > 200) followups.completed = followups.completed.slice(-200);
    if (followups.learnings.length > 100) followups.learnings = followups.learnings.slice(-100);
    saveFollowups(followups);
    return results;
}

// ── Follow high-win-rate politicians with validation ────────────────────────
// Copy trades from politicians with 70%+ accuracy, but only if stock passes
// our research filters (sentiment, fundamentals, momentum).

async function followVipPoliticians(polScores, heldSet, cash, positions) {
    const vipData = politicoVips.getVipData();
    const vips = vipData.vips || {};
    const state = loadState();
    const result = { copied: 0, skipped: 0, copies: [], sells: 0, cobuys: 0 };

    if (!cash || cash < 200) return result;

    // Adaptive gates: the tuner loosens these when qualified VIPs exist but we
    // copy nothing, and tightens them back if the copies lose. Bounded.
    let tcal = { minAccuracy: 70, minDollarVol: 1000000, sentimentFloor: -3 };
    try { tcal = require('./adaptiveTuner').getCalib().politico; } catch {}

    const highWinners = Object.entries(vips)
        .filter(([name, data]) => {
            const stats = data.stats || {};
            return stats.winRate >= tcal.minAccuracy && stats.totalTrades >= 3;
        })
        .sort((a, b) => b[1].stats.winRate - a[1].stats.winRate);

    console.log(`[Politico] Scanning ${highWinners.length} high-accuracy politicians (${tcal.minAccuracy}%+ win rate)`);

    // 1. BUILD CO-BUY MAP — detect when 2+ VIPs buy same stock
    const cobuys = {};
    for (const [politician, data] of highWinners) {
        const trades = (data.trades || [])
            .filter(t => t.side === 'buy' || t.type === 'buy')
            .slice(0, 5);
        for (const trade of trades) {
            if (!trade.ticker) continue;
            if (!cobuys[trade.ticker]) cobuys[trade.ticker] = [];
            cobuys[trade.ticker].push({ politician, accuracy: data.stats.winRate });
        }
    }

    // 2. PROCESS BUYS
    for (const [politician, data] of highWinners) {
        const trades = (data.trades || [])
            .filter(t => t.side === 'buy' || t.type === 'buy')
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 5);

        for (const trade of trades) {
            const ticker = trade.ticker;
            if (!ticker || heldSet.has(ticker.toUpperCase())) continue;

            const key = `vip:${politician}:${ticker}:${trade.date}`;
            if (state.followMoney[key]) continue;

            // Research the stock
            const research = await researchTicker(ticker);
            const sentiment = research.sentiment || 0;
            const change = research.change || 0;

            // Validation gates (thresholds live-calibrated by adaptiveTuner)
            const failedGates = [];
            if (sentiment < tcal.sentimentFloor) failedGates.push(`very bad sentiment (${sentiment})`);
            if (change < -30) failedGates.push(`down >30% (${change}%)`);
            if (!research.volume || research.volume < tcal.minDollarVol) failedGates.push(`low volume ($${((research.volume || 0) / 1e6).toFixed(2)}M < $${(tcal.minDollarVol / 1e6).toFixed(2)}M)`);

            if (failedGates.length > 0) {
                console.log(`[Politico] VIP ${politician}:${ticker} skipped — ${failedGates.join(', ')}`);
                result.skipped++;
                continue;
            }

            // 3. DYNAMIC SIZING based on:
            // - Politician's accuracy (70% → 80% = size up)
            // - Trade size they used (conviction signal)
            // - Co-buy count (2+ politicians = mega conviction, size up 1.5x)
            let baseSizing = FOLLOW_SIZE_PCT;
            let sizeMultiplier = 1;

            // Accuracy multiplier: 70%=0.9x, 85%=1.1x, 95%=1.3x
            const accuracyMultiplier = 0.7 + (data.stats.winRate - 70) / 250;
            sizeMultiplier *= accuracyMultiplier;

            // Trade size signal: if they bought >$100K, they're confident → size up
            if (trade.value > 100000) sizeMultiplier *= 1.2;

            // Co-buy multiplier: each additional VIP buying same stock = 1.3x
            const cobuyCounts = cobuys[ticker] ? cobuys[ticker].length : 0;
            if (cobuyCounts >= 2) {
                sizeMultiplier *= (1 + (cobuyCounts - 1) * 0.3);
                result.cobuys++;
            }

            const notional = Math.min(cash * baseSizing * sizeMultiplier, MAX_NOTIONAL);
            console.log(`[Politico] VIP FOLLOW: ${politician} (${data.stats.winRate}% acc) bought ${ticker}${cobuyCounts >= 2 ? ` [CO-BUY x${cobuyCounts}]` : ''} — copying $${notional.toFixed(0)}`);

            const orderResult = await placeOrder(ticker, notional);
            if (orderResult.success) {
                state.followMoney[key] = {
                    date:       new Date().toISOString(),
                    politician: politician,
                    value:      trade.value || 0,
                    notional:   orderResult.notional,
                    research:   { sentiment, change },
                    type:       'vip-follow',
                    accuracy:   data.stats.winRate,
                    party:      data.party,
                    sector:     research.sector,
                };
                saveState(state);

                // Record in the journal as 'politico' so it's tracked properly and
                // never re-imported as a reconciled orphan (the bug we just cleaned up).
                try {
                    require('./tradeJournal').recordEntry({
                        symbol: ticker, side: 'buy',
                        qty: research.price ? orderResult.notional / research.price : 0,
                        price: research.price, strategy: 'politico',
                        tier: data.stats.winRate >= 85 ? 'HIGH' : 'MEDIUM',
                        score: data.stats.winRate,
                        signals: { congressVip: 2, congressBuy: 1, congressBigMoney: trade.value > 100000 ? 1 : 0 },
                        reason: `VIP follow: ${politician} (${data.stats.winRate}% acc)${cobuyCounts >= 2 ? ` co-buy×${cobuyCounts}` : ''}`,
                    });
                } catch {}

                result.copies.push({
                    ticker,
                    politician,
                    value: trade.value,
                    notional: orderResult.notional,
                    success: true,
                    type: 'vip-follow',
                    sentiment,
                    accuracy: data.stats.winRate,
                    cobuys: cobuyCounts >= 2 ? cobuyCounts : null,
                });
                result.copied++;

                scheduleFollowup(ticker, politician, 'buy', trade.value, research.price);
            } else {
                result.copies.push({
                    ticker,
                    politician,
                    success: false,
                    error: orderResult.error,
                    type: 'vip-follow',
                });
                result.skipped++;
            }
        }

        // 4. PROCESS SELLS — exit if VIP dumps it
        const sells = (data.trades || [])
            .filter(t => t.side === 'sell' || t.type === 'sell')
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 10);

        for (const sell of sells) {
            const ticker = sell.ticker;
            if (!ticker) continue;

            // Check if we hold this from a VIP copy
            const key = `vip:${politician}:${ticker}`;
            const ourCopy = Object.entries(state.followMoney).find(([k]) => k.startsWith(key));

            if (ourCopy && heldSet.has(ticker.toUpperCase())) {
                console.log(`[Politico] VIP EXIT: ${politician} sold ${ticker} — exiting our copy`);
                const exitResult = await placeOrder(ticker, -ourCopy[1].notional);
                if (exitResult.success) {
                    result.sells++;
                    console.log(`[Politico] Exited ${ticker} on VIP sell signal`);
                }
            }
        }
    }

    return result;
}

// ── Monitor VIP positions for early exit or weight boosting ──────────────────
// Check if our VIP copies are winning/losing. Exit early if down 10%, boost
// weights if up 5%+ to create positive feedback loop.

async function monitorVipPositions(positions) {
    const state = loadState();
    const journal = require('./tradeJournal');
    const weights = journal.loadWeights();
    let exited = 0, boosted = 0;

    for (const [key, vipTrade] of Object.entries(state.followMoney)) {
        if (vipTrade.type !== 'vip-follow') continue;

        const ticker = key.split(':')[2];
        const pos = positions.find(p => p.symbol.toUpperCase() === ticker.toUpperCase());

        if (!pos) continue; // not currently held

        const unrealizedPct = parseFloat(pos.unrealized_plpc) || 0;

        // 5. UNREALIZED MONITORING: Exit early if down >10%
        if (unrealizedPct < -10) {
            console.log(`[Politico Monitor] ${ticker} down ${unrealizedPct}% from VIP copy — exiting`);
            try {
                await placeOrder(ticker, -Math.abs(vipTrade.notional));
                exited++;
                console.log(`[Politico Monitor] Exited ${ticker} on unrealized loss`);
            } catch (e) {
                console.log(`[Politico Monitor] Failed to exit ${ticker}: ${e.message}`);
            }
        }

        // 6. BOOST CONGRESSIONAL WEIGHTS when VIP picks are working
        // If up 5%+, boost congressBuy/congressVip/congressBigMoney
        if (unrealizedPct >= 5) {
            const WEIGHT_BOOST = 0.02; // +0.02 per winning VIP pick
            const accuracy = vipTrade.accuracy || 70;

            weights.congressBuy = Math.min(3.0, weights.congressBuy + WEIGHT_BOOST);
            weights.congressVip = Math.min(3.0, weights.congressVip + WEIGHT_BOOST * 1.5);
            weights.congressBigMoney = Math.min(3.0, weights.congressBigMoney + WEIGHT_BOOST);

            boosted++;
            console.log(`[Politico Monitor] ${ticker} up ${unrealizedPct}% — boosted congress weights → ${weights.congressVip.toFixed(3)}`);
        }
    }

    if (boosted > 0) {
        weights.congressBuy = parseFloat(weights.congressBuy.toFixed(3));
        weights.congressVip = parseFloat(weights.congressVip.toFixed(3));
        weights.congressBigMoney = parseFloat(weights.congressBigMoney.toFixed(3));
        journal.saveWeights(weights);
    }

    return { exited, boosted };
}

// ── Analyze party/sector performance ──────────────────────────────────────────
// Track which parties and sectors perform best among our VIP copies

function analyzeVipPerformance() {
    const state = loadState();
    const followups = loadFollowups();

    const stats = {
        byParty: {},
        bySector: {},
        totalWins: 0,
        totalLosses: 0,
    };

    for (const learning of followups.learnings) {
        const vipTrade = Object.values(state.followMoney).find(
            v => v.politician === learning.politician && v.notional
        );
        if (!vipTrade) continue;

        const party = vipTrade.party || 'unknown';
        const sector = vipTrade.sector || 'unknown';
        const isWin = learning.verdict === 'insider_win';

        if (!stats.byParty[party]) stats.byParty[party] = { wins: 0, total: 0 };
        if (!stats.bySector[sector]) stats.bySector[sector] = { wins: 0, total: 0 };

        stats.byParty[party].total++;
        stats.bySector[sector].total++;
        if (isWin) {
            stats.byParty[party].wins++;
            stats.bySector[sector].wins++;
            stats.totalWins++;
        } else {
            stats.totalLosses++;
        }
    }

    // Calculate win rates
    for (const party of Object.keys(stats.byParty)) {
        stats.byParty[party].winRate = stats.byParty[party].total > 0
            ? (stats.byParty[party].wins / stats.byParty[party].total * 100).toFixed(1)
            : 0;
    }
    for (const sector of Object.keys(stats.bySector)) {
        stats.bySector[sector].winRate = stats.bySector[sector].total > 0
            ? (stats.bySector[sector].wins / stats.bySector[sector].total * 100).toFixed(1)
            : 0;
    }

    return stats;
}

// ── Schedule a trade for follow-up research ─────────────────────────────────

function scheduleFollowup(ticker, politician, side, value, entryPrice) {
    const followups = loadFollowups();
    // Don't duplicate
    const key = `${politician}:${ticker}:${new Date().toISOString().slice(0, 10)}`;
    if (followups.pending.some(f => `${f.politician}:${f.ticker}:${f.tradeDate.slice(0, 10)}` === key)) return;

    followups.pending.push({
        ticker,
        politician,
        side,
        value,
        entryPrice,
        tradeDate:     new Date().toISOString(),
        nextCheckDays: 3,  // first check after 3 days
    });
    saveFollowups(followups);
}

// ── Politician performance scoring (for learning) ────────────────────────────

function getPoliticianScores() {
    const followups = loadFollowups();
    const scores = {};

    for (const l of followups.learnings) {
        if (!scores[l.politician]) scores[l.politician] = { wins: 0, total: 0, avgMove: 0, moves: [] };
        scores[l.politician].total++;
        if (l.verdict === 'insider_win') scores[l.politician].wins++;
        scores[l.politician].moves.push(l.priceMove);
    }

    for (const [name, s] of Object.entries(scores)) {
        s.winRate = s.total > 0 ? parseFloat((s.wins / s.total * 100).toFixed(1)) : 0;
        s.avgMove = s.moves.length > 0 ? parseFloat((s.moves.reduce((a, b) => a + b, 0) / s.moves.length).toFixed(2)) : 0;
    }
    return scores;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan() {
    console.log('[Politico] Starting congressional trade scan...');
    const state = loadState();
    if (!state.followMoney) state.followMoney = {};
    if (!state.tradeFeed) state.tradeFeed = [];

    const [trades, { positions, cash }] = await Promise.all([
        scrapeTrades(),
        getAccount(),
    ]);

    if (!trades.length) {
        console.log('[Politico] No trades scraped — Capitol Trades unreachable');
        if (state.lastResult) return state.lastResult;
        return { hotSignals: [], topPoliticians: [], error: 'Capitol Trades unreachable', scannedAt: new Date().toLocaleTimeString() };
    }

    const { hotSignals, bigMoney, topPoliticians, recentBuyCount, allTrades } = analyzeTrades(trades);

    // ── Trigger deep research on all recent trades (async, non-blocking) ────────
    // This will gather sector, macro, and news context + learn patterns
    (async () => {
        for (const trade of allTrades.filter(t => t.side === 'buy').slice(0, 20)) {
            try {
                await politicoResearch.researchTrade(trade.ticker, trade.date, trade.politician, trade.value);
            } catch (e) {
                // Non-blocking — research errors don't affect scan
            }
        }
    })().catch(e => console.error('[Research] Background error:', e.message));
    const crossed = crossReference(hotSignals, positions);
    const heldSet = new Set(positions.map(p => p.symbol.toUpperCase()));
    const autoTrades = [];
    const polScores = getPoliticianScores();

    // ── Auto-trade hot signals (3+ politicians) ──────────────────────────────
    for (const sig of hotSignals) {
        const alreadyActed  = !!state.autoTraded[sig.ticker];
        const alreadyHeld   = heldSet.has(sig.ticker.toUpperCase());

        let polPaused = false;
        try { polPaused = !!require('./adaptiveTuner').getCalib().paused?.politico; } catch {}
        if (polPaused) {
            console.log(`[Politico] HOT ${sig.ticker} skipped — circuit breaker: stream paused (low win rate)`);
            continue;
        }
        if (!alreadyActed && !alreadyHeld && cash > 200) {
            // Research the ticker before buying
            const research = await researchTicker(sig.ticker);
            // Skip if sentiment is strongly negative
            if (research.sentiment < -2) {
                console.log(`[Politico] HOT ${sig.ticker} skipped — bad sentiment (${research.sentiment})`);
                continue;
            }

            const notional = Math.min(cash * BUY_SIZE_PCT, MAX_NOTIONAL);
            console.log(`[Politico] HOT SIGNAL ${sig.ticker} (${sig.count} politicians) — auto-buying $${notional.toFixed(0)}`);
            const result = await placeOrder(sig.ticker, notional);
            if (result.success) {
                state.autoTraded[sig.ticker] = {
                    date:        new Date().toISOString(),
                    count:       sig.count,
                    notional:    result.notional,
                    politicians: sig.politicians.slice(0, 5),
                    research:    { sentiment: research.sentiment, change: research.change },
                };
                autoTrades.push({ ticker: sig.ticker, count: sig.count, notional: result.notional, success: true, type: 'hot' });
                scheduleFollowup(sig.ticker, sig.politicians[0], 'buy', sig.totalValue, research.price);
                console.log(`[Politico] Auto-bought $${sig.ticker}`);
            } else {
                autoTrades.push({ ticker: sig.ticker, count: sig.count, success: false, error: result.error, type: 'hot' });
            }
        }
    }

    // ── Follow the Money: auto-copy big trades ($50K+) ───────────────────────
    for (const trade of bigMoney) {
        const key = `${trade.politician}:${trade.ticker}:${trade.date}`;
        const alreadyFollowed = !!state.followMoney[key];
        const alreadyHeld     = heldSet.has(trade.ticker.toUpperCase());

        if (!alreadyFollowed && !alreadyHeld && cash > 200) {
            // Research first
            const research = await researchTicker(trade.ticker);
            if (research.sentiment < -2) {
                console.log(`[Politico] BIG TRADE ${trade.ticker} ($${(trade.value/1000).toFixed(0)}K by ${trade.politician}) skipped — bad sentiment`);
                continue;
            }

            // Check politician's track record — boost if good, skip if terrible
            const polScore = polScores[trade.politician];
            if (polScore && polScore.total >= 3 && polScore.winRate < 30) {
                console.log(`[Politico] BIG TRADE ${trade.ticker} skipped — ${trade.politician} has ${polScore.winRate}% insider accuracy`);
                continue;
            }

            const notional = Math.min(cash * FOLLOW_SIZE_PCT, MAX_NOTIONAL);
            console.log(`[Politico] FOLLOW THE MONEY: ${trade.politician} bought $${trade.ticker} ($${(trade.value/1000).toFixed(0)}K) — copying $${notional.toFixed(0)}`);
            const result = await placeOrder(trade.ticker, notional);
            if (result.success) {
                state.followMoney[key] = {
                    date:       new Date().toISOString(),
                    politician: trade.politician,
                    value:      trade.value,
                    notional:   result.notional,
                    research:   { sentiment: research.sentiment, change: research.change },
                };
                autoTrades.push({ ticker: trade.ticker, politician: trade.politician, value: trade.value, notional: result.notional, success: true, type: 'bigmoney' });
                scheduleFollowup(trade.ticker, trade.politician, 'buy', trade.value, research.price);
                console.log(`[Politico] Copied $${trade.ticker}`);
            } else {
                autoTrades.push({ ticker: trade.ticker, politician: trade.politician, success: false, error: result.error, type: 'bigmoney' });
            }
        }
    }

    // Clear stale auto-trade flags (signal no longer hot + not holding)
    const hotSet = new Set(hotSignals.map(s => s.ticker));
    for (const ticker of Object.keys(state.autoTraded)) {
        if (!hotSet.has(ticker) && !heldSet.has(ticker.toUpperCase())) {
            delete state.autoTraded[ticker];
        }
    }

    // ── Follow high-win-rate politicians (70%+ accuracy) ────────────────────────
    let vipFollowResult = { copied: 0, skipped: 0, copies: [] };
    try {
        vipFollowResult = await followVipPoliticians(polScores, heldSet, cash, positions);
        if (vipFollowResult.copies.length) {
            console.log(`[Politico] VIP Follow: copied ${vipFollowResult.copied} trades, skipped ${vipFollowResult.skipped}`);
            for (const c of vipFollowResult.copies) {
                autoTrades.push(c);
            }
        }
    } catch (err) {
        console.log(`[Politico VIP Follow] Error: ${err.message}`);
    }

    // ── VIP tracking + validated auto-buy ────────────────────────────────────
    let vipResult = { log: [], newTrades: [], chartData: {} };
    try {
        vipResult = await politicoVips.scanVips(trades, topPoliticians);
        if (vipResult.log.length) {
            vipResult.log.forEach(l => console.log(`[Politico VIP] ${l}`));
        }
        // Schedule follow-ups for VIP trades
        for (const t of vipResult.newTrades) {
            scheduleFollowup(t.ticker, t.politician, 'buy', t.value, t.entryPrice);
        }
    } catch (err) {
        console.log(`[Politico VIP] Error: ${err.message}`);
    }

    // ── Run delayed follow-up research ───────────────────────────────────────
    let followupResults = [];
    try {
        followupResults = await runFollowups();
        if (followupResults.length) {
            console.log(`[Politico] ${followupResults.length} follow-up checks completed`);
            for (const f of followupResults) {
                console.log(`[Politico] Follow-up: ${f.ticker} (${f.politician}) — ${f.priceChange > 0 ? '+' : ''}${f.priceChange}% after ${f.checkDay}d`);
            }
        }
    } catch (err) {
        console.log(`[Politico] Follow-up error: ${err.message}`);
    }

    // ── Build trade feed (last 50 trades with tags) ──────────────────────────
    const feedItems = allTrades.slice(0, 50).map(t => {
        const isHot       = hotSignals.some(h => h.ticker === t.ticker);
        const isBigMoney  = t.value >= BIG_TRADE_MIN;
        const wasCopied   = autoTrades.some(a => a.ticker === t.ticker && a.success);
        const isVip       = (politicoVips.getVipData().vips || {})[t.politician]?.active;
        const polScore    = polScores[t.politician];

        const tags = [];
        if (isHot)      tags.push('HOT');
        if (isBigMoney) tags.push(`$${(t.value/1000).toFixed(0)}K`);
        if (isVip)      tags.push('VIP');
        if (wasCopied)  tags.push('COPIED');
        if (polScore && polScore.total >= 3) tags.push(`${polScore.winRate}% accuracy`);

        return { ...t, tags };
    });

    // Persist feed
    state.tradeFeed = feedItems;

    // Get learning insights
    const learning = politicoResearch.loadLearning();
    const learningInsights = {
        patternsDiscovered: Object.keys(learning.patterns).length,
        totalLearningEvents: learning.learnings.length,
        topPatterns: Object.entries(learning.patterns)
            .map(([pattern, entries]) => ({ pattern, count: entries.length }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 3),
    };

    const result = {
        hotSignals:      crossed,
        bigMoney:        bigMoney.slice(0, 20),
        topPoliticians,
        autoTrades,
        autoTraded:      state.autoTraded,
        followMoney:     state.followMoney,
        recentBuyCount,
        tradeCount:      trades.length,
        tradeFeed:       feedItems,
        followupResults,
        polScores,
        vipData:         politicoVips.getVipData(),
        vipNewTrades:    vipResult.newTrades,
        learningInsights,
        scannedAt:       new Date().toLocaleTimeString(),
    };

    state.lastScan   = new Date().toISOString();
    state.lastResult = result;
    saveState(state);

    console.log(`[Politico] ${hotSignals.length} hot | ${bigMoney.length} big$ | ${autoTrades.length} auto | ${followupResults.length} followups | ${feedItems.length} feed`);
    return result;
}

// ── Morning briefing snapshot ─────────────────────────────────────────────────

async function getMorningBriefing() {
    const state = loadState();
    const { positions } = await getAccount();
    const hotSignals = crossReference(state.lastResult?.hotSignals || [], positions);
    return {
        hotSignals,
        bigMoney:       state.lastResult?.bigMoney || [],
        topPoliticians: state.lastResult?.topPoliticians || [],
        autoTraded:     state.autoTraded || {},
        followMoney:    state.followMoney || {},
        lastScan:       state.lastScan,
        recentBuyCount: state.lastResult?.recentBuyCount || 0,
        tradeFeed:      state.tradeFeed || [],
        polScores:      getPoliticianScores(),
    };
}

// ── Exports for learning integration ─────────────────────────────────────────

function getFollowupLearnings() {
    const followups = loadFollowups();
    return {
        learnings:  followups.learnings || [],
        scores:     getPoliticianScores(),
        completed:  (followups.completed || []).slice(-20),
    };
}

module.exports = { scan, getMorningBriefing, getFollowupLearnings, getPoliticianScores, monitorVipPositions, analyzeVipPerformance };
