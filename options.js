// options.js — Directional options buying (calls & puts)
// Entry is gated by: research report → earnings blackout → IV rank → MACD/trend → RSI
// Management: hard stop at -40%, auto-close worthless contracts, trailing stop on entry
require('dotenv').config();
const axios         = require('axios');
const reportContext   = require('./reportContext');
const tradeJournal    = require('./tradeJournal');
const wheel           = require('./wheel');
const indicators      = require('./indicators');
const smartFilters    = require('./smartFilters');
const postExitTracker = require('./postExitTracker');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;

const WATCHLIST = [
    'TSLA','NVDA','AMD','MSTR','COIN','SPY','AAPL','META','AMZN',
    'GOOGL','MSFT','NFLX','PLTR','GME','AMC','SOFI','RIVN','ARM',
    'SMCI','BABA','UBER','SNAP','RBLX','HOOD','IONQ'
];

// Stocks too cheap for meaningful options — skip to avoid far-OTM traps
const MIN_STOCK_PRICE = 5;

// Hard stop for existing long options positions — cut at -40%
// Options don't "dip and recover" like stocks: if a call/put drops 40% the thesis is wrong
const OPTIONS_HARD_STOP = -40;

// IV rank ceiling for BUYING options — don't buy overpriced premium
// High IV rank = expensive options = you overpay for the bet
// (Opposite of wheel.js which wants HIGH IV to sell expensive premium)
const MAX_IV_RANK_BUY = 60;

// ── Parse Alpaca option symbol e.g. AAPL240315C00170000 ───────────────────────

function parseOptionSymbol(symbol) {
    const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, underlying, dateStr, type] = match;
    const year  = 2000 + parseInt(dateStr.slice(0, 2));
    const month = parseInt(dateStr.slice(2, 4)) - 1;
    const day   = parseInt(dateStr.slice(4, 6));
    const expiry = new Date(year, month, day);
    const daysToExpiry = Math.floor((expiry - new Date()) / (1000 * 60 * 60 * 24));
    return { underlying, expiry, type, daysToExpiry };
}

// ── Alpaca helpers ────────────────────────────────────────────────────────────

async function getCurrentPrice(symbol) {
    try {
        const res = await axios.get(
            `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${symbol}&feed=iex`,
            { headers: HEADERS }
        );
        const snap = res.data[symbol];
        return snap?.latestTrade?.p || snap?.dailyBar?.c || null;
    } catch { return null; }
}

async function getOptionContracts(symbol, type, currentPrice = null) {
    try {
        // Minimum 7 days to expiry — avoids theta-decay trash in the last week
        const expMin = new Date();
        expMin.setDate(expMin.getDate() + 7);
        const expMax = new Date();
        expMax.setDate(expMax.getDate() + 45); // up to 45 days for better liquidity

        const res = await axios.get(`${BASE}/options/contracts`, {
            headers: HEADERS,
            params: {
                underlying_symbols: symbol,
                expiration_date_gte: expMin.toISOString().split('T')[0],
                expiration_date_lte: expMax.toISOString().split('T')[0],
                type,
                limit: 30,
                status: 'active',
            },
        });

        let contracts = res.data.option_contracts || [];

        // CRITICAL: only trade near-the-money strikes (within 10% of current price)
        // Prevents buying AMC $20 calls when AMC trades at $1.34
        if (currentPrice && contracts.length > 0) {
            const nearATM = contracts.filter(c => {
                const strike = parseFloat(c.strike_price);
                return strike > 0 && Math.abs(strike - currentPrice) / currentPrice <= 0.10;
            });
            if (nearATM.length > 0) contracts = nearATM;
            else return []; // no near-ATM strikes — skip entirely
        }

        return contracts;
    } catch { return []; }
}

// LIVE OPTION TRADING RETIRED. The isolated, fee-aware Options Lab
// (optionsPaperTrader.js) is the wheel now — it prices off real Alpaca option quotes
// but settles into its own ledger. This module keeps its SCANNER (which feeds the
// dashboard's options signals); it no longer sends orders anywhere.
const OPTIONS_LIVE_TRADING = false;

async function placeOptionOrder(symbol, side, qty = 1) {
    if (!OPTIONS_LIVE_TRADING) return { success: false, simulated: true, error: 'live option trading retired — see Options Lab' };
    try {
        await axios.post(`${BASE}/orders`, {
            symbol, qty, side, type: 'market',
            time_in_force: 'day', order_class: 'simple',
        }, { headers: HEADERS });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

async function placeOptionTrailingStop(symbol, qty, daysToExpiry) {
    const trailPercent = process.env.TRAIL_PERCENT || '20';
    if (!OPTIONS_LIVE_TRADING) return { success: false, simulated: true, trailPercent };
    // GTC while contract has life, day if expiring today
    const tif = daysToExpiry <= 1 ? 'day' : 'gtc';
    try {
        await axios.post(`${BASE}/orders`, {
            symbol, qty, side: 'sell',
            type: 'trailing_stop',
            time_in_force: tif,
            trail_percent: trailPercent,
        }, { headers: HEADERS });
        return { success: true, trailPercent };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan() {
    // Time-of-day filter: skip new buys in the last 60 min of trading (after 3:00 PM ET = 19:00 UTC)
    const nowUtc = new Date();
    const utcHour = nowUtc.getUTCHours();
    const utcMin  = nowUtc.getUTCMinutes();
    const optionsTimeBlocked = utcHour > 19 || (utcHour === 19 && utcMin >= 0);
    if (optionsTimeBlocked) {
        console.log(`[Options] Skipping buys — within 60 min of close (${utcHour}:${String(utcMin).padStart(2, '0')} UTC)`);
    }

    const results = [];

    // ── PART 1: Manage existing long option positions ────────────────────────
    const posRes = await axios.get(`${BASE}/positions`, { headers: HEADERS });
    const optionPositions = posRes.data.filter(p => p.asset_class === 'us_option');

    for (const pos of optionPositions) {
        const parsed = parseOptionSymbol(pos.symbol);
        if (!parsed) continue;

        // Skip short (sold) options — those belong to wheel.js and must not be touched here
        if (pos.side === 'short' || parseFloat(pos.qty) < 0) continue;

        const { underlying, type, daysToExpiry } = parsed;
        const unrealizedPct = parseFloat(pos.unrealized_plpc) * 100;
        const currentBid    = parseFloat(pos.current_price) || 0;

        // AUTO-CLOSE: worthless or near-worthless long options (bid ≤ $0.02 or down ≥ 95%)
        // Don't hold a dying contract to expiry — get out now and redeploy capital
        if (currentBid <= 0.02 || unrealizedPct <= -95) {
            try {
                await axios.delete(`${BASE}/positions/${pos.symbol}`, { headers: HEADERS });
                console.log(`[Options] Auto-closed dead option ${pos.symbol} (${unrealizedPct.toFixed(0)}%, bid $${currentBid})`);
            } catch (err) {
                // May already be expired — log and move on
                console.log(`[Options] Could not close ${pos.symbol}: ${err.response?.data?.message || err.message}`);
            }
            results.push({
                ticker: underlying, signal: 'CLOSE WORTHLESS',
                contract: pos.symbol, unrealizedPct: unrealizedPct.toFixed(2),
                action: { success: true, reason: 'auto-closed worthless option' },
            });
            continue;
        }

        // HARD STOP at -40%: directional thesis is wrong — cut it, don't average down
        if (unrealizedPct <= OPTIONS_HARD_STOP) {
            const qty = Math.abs(parseFloat(pos.qty));
            try {
                await axios.post(`${BASE}/orders`, {
                    symbol: pos.symbol, qty, side: 'sell',
                    type: 'market', time_in_force: 'day', order_class: 'simple',
                }, { headers: HEADERS });
                tradeJournal.recordExit(
                    pos.symbol,
                    parseFloat(pos.current_price),
                    `Options hard stop ${OPTIONS_HARD_STOP}% (${unrealizedPct.toFixed(0)}%)`
                );
                console.log(`[Options] Hard stop ${pos.symbol} at ${unrealizedPct.toFixed(0)}%`);
                results.push({
                    ticker: underlying, signal: 'HARD STOP',
                    contract: pos.symbol, unrealizedPct: unrealizedPct.toFixed(2),
                    action: { success: true },
                });
            } catch (err) {
                console.log(`[Options] Hard stop failed ${pos.symbol}: ${err.response?.data?.message || err.message}`);
            }
            continue;
        }

        results.push({
            ticker: underlying,
            signal: 'HOLD',
            contract: pos.symbol,
            unrealizedPct: unrealizedPct.toFixed(2),
            daysToExpiry,
            action: null,
        });
    }

    // ── PART 2: New signal scan — multi-gate entry system ────────────────────
    // All gates must pass before we spend premium capital on a new contract.
    // Order: report → earnings → IV rank → MACD/trend → RSI → execute

    // Online learning from open option positions (runs every scan, before any time gate)
    const optOpenForLearning = optionPositions
        .filter(p => p.side !== 'short' && parseFloat(p.qty) > 0)
        .map(p => {
            const unrealizedPct = parseFloat(p.unrealized_plpc) * 100;
            const journalEntry = tradeJournal.getOpenTrades().find(t => t.symbol === p.symbol && t.strategy === 'options');
            return { symbol: p.symbol, currentPnlPct: unrealizedPct, signals: journalEntry?.signals || {} };
        })
        .filter(p => p.signals && Object.keys(p.signals).length > 0);
    if (optOpenForLearning.length > 0) tradeJournal.learnFromOpenTrades(optOpenForLearning);

    // Post-exit follow-up: use underlying prices from the WATCHLIST snapshot
    // techMap is populated later (after time-gate), so use a quick price fetch here
    // We reuse any prices already available from optionPositions
    {
        const optUnderlyingPrices = {};
        for (const pos of optionPositions) {
            const parsed = parseOptionSymbol(pos.symbol);
            if (parsed?.underlying) {
                const cp = parseFloat(pos.current_price) || 0;
                if (cp > 0) optUnderlyingPrices[parsed.underlying] = cp;
            }
        }
        postExitTracker.processDue(optUnderlyingPrices, ['options'], {});
    }

    if (optionsTimeBlocked) return results; // manage only, no new entries

    // GATE 1: Research report (primary conviction source)
    // Skip all new entries if the report is stale (>6 h old) or has no signals
    const report    = reportContext.getLatest();
    const reportAgeH = report.sourceTime
        ? (Date.now() - new Date(report.sourceTime).getTime()) / 3_600_000
        : Infinity;
    const reportFresh = reportAgeH < 6;

    if (!reportFresh) {
        console.log(`[Options] Research report stale (${reportAgeH.toFixed(1)}h old) — skipping new entries`);
        return results;
    }

    const watchlistUp = (report.watchlist || []).map(t => t.toUpperCase());
    const avoidList   = (report.avoid   || []).map(t => t.toUpperCase());

    if (watchlistUp.length === 0 && avoidList.length === 0) {
        console.log('[Options] Research report has no watchlist or avoid signals — skipping new entries');
        return results;
    }

    // Batch-fetch technical data for the full watchlist (one round-trip each)
    const [techMap, ivMap, upcomingEarnings] = await Promise.all([
        indicators.analyze(WATCHLIST),
        smartFilters.getIVRank(WATCHLIST),
        smartFilters.getUpcomingEarnings(WATCHLIST),
    ]);

    // Wheel conflict check: skip tickers the wheel already has exposure on
    const wheelActive = wheel.getActiveTickers();
    if (wheelActive.size) {
        console.log(`[Options] Wheel active on: ${[...wheelActive].join(', ')} — skipping for directional bets`);
    }

    // Don't double up on tickers we already have a long option on
    const existingUnderlyings = new Set(
        optionPositions
            .filter(p => p.side === 'long' && parseFloat(p.qty) > 0)
            .map(p => parseOptionSymbol(p.symbol)?.underlying)
            .filter(Boolean)
    );

    for (const ticker of WATCHLIST) {
        // Wheel conflict
        if (wheelActive.has(ticker)) continue;

        // Already have an options position in this underlying
        if (existingUnderlyings.has(ticker)) continue;

        // ── Gate 1: Report must flag this ticker ────────────────────────────
        const onWatchlist = watchlistUp.includes(ticker);
        const onAvoid     = avoidList.includes(ticker);
        if (!onWatchlist && !onAvoid) continue; // not flagged — no edge, skip

        if (onWatchlist && onAvoid) {
            // Conflicting signals — don't bet when the report disagrees with itself
            console.log(`[Options] ${ticker} on both watchlist and avoid — contradictory, skipping`);
            continue;
        }

        const optType = onWatchlist ? 'call' : 'put';

        // ── Gate 2: Earnings blackout (≤3 days to earnings = skip) ──────────
        const earningsCheck = smartFilters.earningsFilter(ticker, upcomingEarnings);
        if (!earningsCheck.safe) {
            console.log(`[Options] ${ticker} blocked — ${earningsCheck.reason}`);
            results.push({ ticker, signal: 'SKIP (earnings)', reason: earningsCheck.reason });
            continue;
        }

        // ── Gate 3: IV rank — don't buy overpriced premium ──────────────────
        // We WANT low IV when buying (cheaper). If IV rank > 60% premium is too rich.
        const ivData  = ivMap[ticker];
        const ivRank  = ivData?.ivRank ?? null;
        if (ivRank !== null && ivRank > MAX_IV_RANK_BUY) {
            console.log(`[Options] ${ticker} skipped — IV rank ${ivRank}% too expensive (>${MAX_IV_RANK_BUY}%)`);
            results.push({ ticker, signal: 'SKIP (IV too high)', reason: `IV rank ${ivRank}%`, optType });
            continue;
        }

        // ── Gate 4: Technical confirmation (MACD + trend + RSI) ────────────
        const tech  = techMap[ticker];
        const rsi   = tech?.rsi   ?? null;
        const macd  = tech?.macd  ?? null;
        const trend = tech?.trend ?? 'unknown';

        // RSI extremes: overbought blocks calls, oversold blocks puts
        if (optType === 'call' && rsi !== null && rsi > 70) {
            console.log(`[Options] ${ticker} CALL blocked — RSI overbought (${rsi})`);
            results.push({ ticker, signal: 'SKIP (RSI overbought)', rsi, optType });
            continue;
        }
        if (optType === 'put' && rsi !== null && rsi < 30) {
            console.log(`[Options] ${ticker} PUT blocked — RSI oversold (${rsi})`);
            results.push({ ticker, signal: 'SKIP (RSI oversold)', rsi, optType });
            continue;
        }

        // MACD + trend alignment
        let techConfirmed = false;
        let techReason    = '';

        if (optType === 'call') {
            // Need: MACD bullish (histogram > 0) OR fresh crossover, AND not in downtrend
            const macdBull = macd?.bullish || macd?.crossover;
            if (macdBull && trend !== 'downtrend') {
                techConfirmed = true;
                techReason = `MACD ${macd?.crossover ? 'crossover' : 'bullish'}, trend=${trend}`;
            } else {
                techReason = `MACD ${macd ? (macd.bullish ? 'bullish' : 'bearish') : 'n/a'}, trend=${trend}`;
            }
        } else {
            // PUT: need MACD bearish (histogram < 0) and downtrend or sideways
            const macdBear = macd && !macd.bullish;
            if (trend === 'downtrend') {
                techConfirmed = true;
                techReason = `trend=downtrend, MACD=${macd ? (macd.bullish ? 'bullish' : 'bearish') : 'n/a'}`;
            } else if (macdBear && trend !== 'uptrend') {
                techConfirmed = true;
                techReason = `MACD bearish, trend=${trend}`;
            } else {
                techReason = `MACD ${macd ? (macd.bullish ? 'bullish' : 'bearish') : 'n/a'}, trend=${trend} — not bearish enough for PUT`;
            }
        }

        if (!techConfirmed) {
            console.log(`[Options] ${ticker} ${optType.toUpperCase()} blocked — tech not aligned: ${techReason}`);
            results.push({ ticker, signal: 'SKIP (tech)', optType, reason: techReason, rsi, trend });
            continue;
        }

        // ── All gates passed — compute weighted conviction score ─────────────
        // Uses learned weights so the journal can teach us which signals matter most
        const optSignals = {
            newsSentiment:  onWatchlist ? 1 : -1,
            ivRank:         ivRank !== null ? (ivRank < 30 ? 1 : ivRank > 50 ? -1 : 0) : 0,
            rsi:            optType === 'call'
                                ? (rsi !== null ? (rsi < 45 ? 1 : rsi > 60 ? -1 : 0) : 0)
                                : (rsi !== null ? (rsi > 55 ? 1 : rsi < 40 ? -1 : 0) : 0),
            macdBullish:    macd?.bullish  ? (optType === 'call' ? 1 : -1) : (optType === 'put' ? 1 : -1),
            macdCrossover:  macd?.crossover ? 1 : 0,
        };
        const optScore = tradeJournal.applyWeights(optSignals);

        // ── Find and buy a contract ───────────────────────────────────────────
        const stockPrice = await getCurrentPrice(ticker);

        if (!stockPrice || stockPrice < MIN_STOCK_PRICE) {
            console.log(`[Options] ${ticker} skipped — price $${stockPrice?.toFixed(2) || 'unknown'} < $${MIN_STOCK_PRICE}`);
            continue;
        }

        const contracts = await getOptionContracts(ticker, optType, stockPrice);
        if (contracts.length === 0) {
            console.log(`[Options] ${ticker} — no near-ATM ${optType} contracts (7–45 dte, within 10% of $${stockPrice.toFixed(2)})`);
            results.push({ ticker, signal: 'SKIP (no ATM contracts)', optType });
            continue;
        }

        // Prefer highest open interest (most liquid), then filter for minimum bid
        contracts.sort((a, b) => (b.open_interest || 0) - (a.open_interest || 0));
        const liquid = contracts.filter(c => parseFloat(c.last_price || 0) >= 0.10);

        if (liquid.length === 0) {
            console.log(`[Options] ${ticker} ${optType} — all near-ATM contracts have bid < $0.10 (no lottery tickets)`);
            results.push({ ticker, signal: 'SKIP (no liquid)', optType });
            continue;
        }

        const contract  = liquid[0];
        const parsed2   = parseOptionSymbol(contract.symbol);
        const dte       = parsed2?.daysToExpiry ?? 21;
        const strikePct = Math.abs(parseFloat(contract.strike_price) - stockPrice) / stockPrice * 100;
        const signal    = optType === 'call' ? 'BUY CALL' : 'BUY PUT';

        const action = await placeOptionOrder(contract.symbol, 'buy', 1);

        if (action.success) {
            tradeJournal.recordEntry({
                symbol:   contract.symbol,
                side:     'buy',
                qty:      1,
                price:    parseFloat(contract.last_price || 0),
                strategy: 'options',
                tier:     'MEDIUM',
                score:    optScore, // weighted conviction score from learned weights
                signals:  optSignals,
                indicators: { rsi, trend, macdBullish: macd?.bullish, macdCrossover: macd?.crossover, ivRank, dte, strikePct: parseFloat(strikePct.toFixed(1)) },
                reason: `${signal} ${ticker} | score=${optScore.toFixed(2)} | report=${onWatchlist ? 'watchlist' : 'avoid'} | ${techReason} | IV=${ivRank ?? '?'}% | dte=${dte} | strike=${contract.strike_price} (${strikePct.toFixed(1)}% from $${stockPrice.toFixed(2)})`,
            });
            action.trailingStop = await placeOptionTrailingStop(contract.symbol, 1, dte);
        }

        console.log(
            `[Options] ${signal} ${contract.symbol} | dte=${dte} bid=$${contract.last_price}` +
            ` strike=${strikePct.toFixed(1)}% from price | ${techReason} | IV=${ivRank ?? '?'}%`
        );

        results.push({
            ticker,
            signal,
            optType,
            contract:   contract.symbol,
            action,
            tech:       { rsi, trend, macdBullish: macd?.bullish, macdCrossover: macd?.crossover },
            ivRank,
            reportBias: onWatchlist ? 'watchlist' : 'avoid',
            strikePct:  parseFloat(strikePct.toFixed(1)),
            dte,
        });
    }

    // Enrich post-exit follow-up checks with full indicator snapshots (now techMap is available)
    {
        const richPrices    = {};
        const richSnapshots = {};
        for (const ticker of WATCHLIST) {
            const tech  = techMap[ticker];
            const price = await getCurrentPrice(ticker).catch(() => null);
            if (price) {
                richPrices[ticker]    = price;
                richSnapshots[ticker] = {
                    rsi:          tech?.rsi   ?? null,
                    macdBullish:  tech?.macd?.bullish   ?? null,
                    macdCrossover:tech?.macd?.crossover ?? null,
                    trend:        tech?.trend ?? null,
                    newsScore:    null, // not fetched in options scan
                };
            }
        }
        if (Object.keys(richPrices).length > 0) {
            postExitTracker.processDue(richPrices, ['options'], richSnapshots);
        }
    }

    return results;
}

module.exports = { scan };
