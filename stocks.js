require('dotenv').config();
const axios = require('axios');
const barsWindow = require('./barsWindow');
const reportContext   = require('./reportContext');
const indicators      = require('./indicators');
const tradeJournal    = require('./tradeJournal');
const smartFilters    = require('./smartFilters');
const postExitTracker = require('./postExitTracker');
const paperBroker     = require('./paperBroker');

const HEADERS = {
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;
const DATA_BASE = 'https://data.alpaca.markets/v2';

// ── Chandelier exit state (software ATR-trail — backtest: +108% vs fixed 10% trail's
// +77%). Alpaca gives no peak-since-entry, so we track a high-water mark per position.
const fs   = require('fs');
const path = require('path');
const STOCK_HW_FILE  = path.join(require('./dataDir'), 'stock-highwater.json');
const CHANDELIER_MULT = 3;
function loadStockHighs() { try { return JSON.parse(fs.readFileSync(STOCK_HW_FILE, 'utf8')); } catch { return {}; } }
function saveStockHighs(h) { try { fs.writeFileSync(STOCK_HW_FILE, JSON.stringify(h, null, 2)); } catch {} }

const WATCHLIST = [
    'TSLA','NVDA','AMD','MSTR','COIN','SPY','AAPL','META','AMZN',
    'GOOGL','MSFT','NFLX','PLTR','GME','AMC','SOFI','RIVN','ARM',
    'SMCI','BABA','UBER','SNAP','RBLX','HOOD','IONQ'
];

const BULLISH = ['beat','surge','rally','bull','gain','rise','breakthrough','upgrade','buy','bullish','soar','record','high'];
const BEARISH = ['miss','crash','drop','bear','loss','fall','downgrade','sell','bearish','lawsuit','fraud','investigation','recall'];

// ── Sector map for congressional "halo" effect ──────────────────────────────
// When a politician buys NVDA, sister stocks (AMD, SMCI, ARM) also get a boost.
const SECTOR_MAP = {
    // AI / Semiconductors
    NVDA: ['AMD','SMCI','ARM','IONQ'], AMD: ['NVDA','SMCI','ARM','IONQ'],
    SMCI: ['NVDA','AMD','ARM'], ARM: ['NVDA','AMD','SMCI'], IONQ: ['NVDA','AMD'],
    // Big Tech
    AAPL: ['MSFT','GOOGL','META','AMZN'], MSFT: ['AAPL','GOOGL','META','AMZN'],
    GOOGL: ['META','MSFT','AAPL','SNAP'], META: ['GOOGL','SNAP','MSFT','RBLX'],
    AMZN: ['MSFT','GOOGL','AAPL','UBER'],
    // Streaming / Entertainment
    NFLX: ['RBLX','META'], RBLX: ['NFLX','META','SNAP'],
    // Crypto-adjacent
    MSTR: ['COIN','HOOD'], COIN: ['MSTR','HOOD'], HOOD: ['COIN','MSTR','SOFI'],
    // Meme / Retail
    GME: ['AMC'], AMC: ['GME'],
    // Fintech
    SOFI: ['HOOD','COIN'], UBER: ['RIVN','AMZN'],
    // EV / Auto
    TSLA: ['RIVN'], RIVN: ['TSLA'],
    // China / International
    BABA: [], SNAP: ['META','GOOGL','RBLX'],
    // Growth
    PLTR: ['IONQ','NVDA'],
    SPY: [],
};

// ── Cached congress data (loaded once per scan, not per ticker) ──────────────
let _congressCache = null;
let _congressCacheTime = 0;

function getCongressData() {
    const now = Date.now();
    // Cache for 60 seconds — one scan cycle reads it once
    if (_congressCache && (now - _congressCacheTime) < 60000) return _congressCache;
    try {
        const politico = require('./politicoScanner');
        const { learnings, scores } = politico.getFollowupLearnings();
        const raw = require('fs').readFileSync(
            require('path').join(__dirname, 'politico-signals.json'), 'utf8'
        );
        const state = JSON.parse(raw);
        _congressCache = {
            allTrades: (state.lastResult || {}).tradeFeed || [],
            polScores: scores || {},
        };
        _congressCacheTime = now;
    } catch {
        _congressCache = { allTrades: [], polScores: {} };
        _congressCacheTime = now;
    }
    return _congressCache;
}

// ── Get congressional trade boost for a ticker ──────────────────────────────
// Returns { directBuy, sisterBuy, congressScore, signals }
function getCongressBoost(ticker) {
    try {
        const { allTrades, polScores } = getCongressData();

        // Check if any politician recently bought this exact ticker
        const directBuys = allTrades.filter(t =>
            t.ticker === ticker && t.side === 'buy'
        );

        // Check if any politician bought a sister stock
        const sisters = SECTOR_MAP[ticker] || [];
        const sisterBuys = allTrades.filter(t =>
            sisters.includes(t.ticker) && t.side === 'buy'
        );

        let congressScore = 0;
        const signals = {};

        if (directBuys.length > 0) {
            // Weight by politician accuracy
            let bestAccuracy = 50;
            for (const buy of directBuys) {
                const ps = polScores[buy.politician];
                if (ps && ps.total >= 3) bestAccuracy = Math.max(bestAccuracy, ps.winRate);
            }
            // Direct buy: +1.5 base, up to +3 if politician has great track record
            const accuracyMult = bestAccuracy >= 60 ? 1.5 : bestAccuracy >= 50 ? 1.0 : 0.5;
            congressScore += 1.5 * accuracyMult;
            signals.congressBuy = 1.5 * accuracyMult;

            // Big money bonus
            const bigTrade = directBuys.find(t => t.value >= 50000);
            if (bigTrade) {
                congressScore += 1.0;
                signals.congressBigMoney = 1.0;
            }
        }

        if (sisterBuys.length > 0) {
            // Sister/halo effect: +0.5 per unique sister ticker bought, max +1.5
            const uniqueSisters = new Set(sisterBuys.map(t => t.ticker));
            const haloBoost = Math.min(uniqueSisters.size * 0.5, 1.5);
            congressScore += haloBoost;
            signals.congressVip = haloBoost; // reuse VIP weight for halo
        }

        // Check sells as negative signal
        const directSells = allTrades.filter(t =>
            t.ticker === ticker && t.side === 'sell'
        );
        if (directSells.length > 0) {
            congressScore -= 1.0 * directSells.length;
            signals.congressBuy = (signals.congressBuy || 0) - 1.0 * directSells.length;
        }

        return {
            directBuy:    directBuys.length,
            sisterBuy:    sisterBuys.length,
            congressScore,
            signals,
            details:      directBuys.slice(0, 3).map(t => `${t.politician} $${(t.value/1000).toFixed(0)}K`),
            sisterDetails: [...new Set(sisterBuys.map(t => t.ticker))],
        };
    } catch {
        return { directBuy: 0, sisterBuy: 0, congressScore: 0, signals: {}, details: [], sisterDetails: [] };
    }
}

// Same 4-tier ladder as crypto
const LADDER_TIERS = [
    { dip: 50, pct: 0.05, minSentiment: -3, freefallLimit: -20, label: '50%' },
    { dip: 35, pct: 0.04, minSentiment: -3, freefallLimit: -20, label: '35%' },
    { dip: 25, pct: 0.03, minSentiment: -2, freefallLimit: -15, label: '25%' },
    { dip: 15, pct: 0.02, minSentiment: -1, freefallLimit: -10, label: '15%' },
];
const ladderLevels = new Map();
let startingCapital = null;

async function getSnapshots(symbols) {
    try {
        const res = await axios.get(`${DATA_BASE}/stocks/snapshots`, {
            headers: HEADERS,
            params: { symbols: symbols.join(','), feed: 'iex' }
        });
        return res.data;
    } catch { return {}; }
}

// Per-ticker news cache — news doesn't change minute-to-minute, but the scanner
// runs every 5 min across the whole watchlist. Without caching we hammered the
// free NewsAPI tier into 429s, which zeroed out newsScore (the scanner's biggest
// signal) and helped freeze entries. 30-min TTL kills the rate-limiting.
const _newsCache = new Map();
const NEWS_TTL_MS = 30 * 60 * 1000;

async function getNews(query) {
    const cached = _newsCache.get(query);
    if (cached && (Date.now() - cached.ts) < NEWS_TTL_MS) return cached.data;

    let articles = [];
    try {
        const res = await axios.get(`https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=5&apiKey=${process.env.NEWS_API_KEY}`, { timeout: 8000 });
        if (res.data.articles?.length) articles = res.data.articles;
    } catch {}
    // Fallback: Google News RSS (also cached, so we don't hammer it either)
    if (!articles.length) {
        try {
            const res = await axios.get(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            articles = (res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || []).slice(0, 5).map(t => ({ title: t.replace(/<title><!\[CDATA\[|\]\]><\/title>/g, ''), description: '' }));
        } catch {}
    }
    // Cache even an empty result briefly so a transient failure doesn't re-hammer
    _newsCache.set(query, { data: articles, ts: Date.now() });
    return articles;
}

async function getStocktwits(symbol) {
    try {
        const res = await axios.get(`https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`);
        const messages = res.data.messages || [];
        let bull = 0, bear = 0;
        messages.forEach(m => {
            if (m.entities?.sentiment?.basic === 'Bullish') bull++;
            if (m.entities?.sentiment?.basic === 'Bearish') bear++;
        });
        return { score: bull - bear };
    } catch { return { score: 0 }; }
}

async function getFearGreed() {
    try {
        const res = await axios.get('https://api.alternative.me/fng/?limit=1');
        return res.data.data[0];
    } catch { return null; }
}

async function getBatchRSI(symbols, period = 14) {
    try {
        const res = await axios.get(`${DATA_BASE}/stocks/bars`, {
            headers: HEADERS,
            params: { symbols: symbols.join(','), timeframe: '1Day', ...barsWindow(period + 2, '1Day'), limit: 10000, feed: 'iex' },
        });
        const out = {};
        for (const [sym, bars] of Object.entries(res.data.bars || {})) {
            if (bars.length < period + 1) { out[sym] = null; continue; }
            let gains = 0, losses = 0;
            for (let i = bars.length - period; i < bars.length; i++) {
                const d = bars[i].c - bars[i - 1].c;
                if (d > 0) gains += d; else losses -= d;
            }
            out[sym] = losses === 0 ? 100 : parseFloat((100 - 100 / (1 + (gains / period) / (losses / period))).toFixed(1));
        }
        return out;
    } catch { return {}; }
}

function newsSentiment(articles) {
    let score = 0;
    articles.forEach(a => {
        const text = `${a.title} ${a.description || ''}`.toLowerCase();
        BULLISH.forEach(w => { if (text.includes(w)) score++; });
        BEARISH.forEach(w => { if (text.includes(w)) score--; });
    });
    return score;
}

// Orders execute against our own fee-aware ledger (paperBroker), not a broker API.
// Fills are at the live market price we already fetched for signals, minus the
// modelled commission/slippage in fees.js. Swap paperBroker to go live.
function placeOrder(symbol, side, notional, price) {
    const res = side === 'buy'
        ? paperBroker.buy('stocks',  symbol, { notional, price })
        : paperBroker.sell('stocks', symbol, { qty: notional / price, price });
    return { ...res, symbol, side, notional };
}

// No resting orders exist in the paper ledger — the software Chandelier (checked every
// scan) IS the exit. Kept as a no-op so the call sites and their logging stay intact.
function placeTrailingStop() { return { success: true, simulated: true, note: 'software Chandelier is the exit' }; }
function cancelOpenOrders()  { return true; }

// Liquidate the whole position cleanly at the current mark.
function closePosition(symbol, price) {
    const r = paperBroker.sell('stocks', symbol, { price, reason: 'close position' });
    return r.success ? { success: true, pnl: r.pnl } : { success: false, error: r.error };
}

// Alpaca-shaped view of our ledger so the scan body below reads unchanged.
function getStockPositions(priceMap = {}) {
    return paperBroker.getPositions('stocks', priceMap).map(p => ({
        symbol: p.symbol,
        qty: String(p.qty),
        avg_entry_price: String(p.avgEntryPrice),
        current_price: String(p.currentPrice),
        market_value: String(p.marketValue),
        unrealized_pl: String(p.unrealizedPl),
        unrealized_plpc: String(p.unrealizedPlpc / 100),   // fraction, like Alpaca
        asset_class: 'us_equity',
        highWater: p.highWater,
    }));
}

async function scan(riskStatus) {
    const results = [];

    // Cap position sizing if medium-risk budget is exhausted
    const mediumAvail = riskStatus?.available?.medium ?? Infinity;

    const fearGreed = await getFearGreed();
    const fearGreedValue = fearGreed ? parseInt(fearGreed.value) : 50;
    const extremeFear = fearGreedValue < 25;
    const extremeGreed = fearGreedValue > 75;

    const [snapshots, rsiMap, indData, volumeData, hourlyData, earnings, pivots] = await Promise.all([
        getSnapshots(WATCHLIST),
        getBatchRSI(WATCHLIST),
        indicators.analyze(WATCHLIST),
        smartFilters.getVolumeSpikes(WATCHLIST),
        smartFilters.getHourlyTrend(WATCHLIST),
        smartFilters.getUpcomingEarnings(WATCHLIST),
        smartFilters.getPivotLevels(WATCHLIST),
    ]);

    // Mark the ledger to market first, so cash/positions reflect live prices
    const markMap = {};
    for (const t of WATCHLIST) {
        const p = snapshots[t]?.latestTrade?.p || snapshots[t]?.dailyBar?.c;
        if (p > 0) markMap[t] = p;
    }
    paperBroker.markToMarket('stocks', markMap);
    const account = paperBroker.getAccount('stocks', markMap);
    const cash = account.cash;
    if (startingCapital === null) {
        startingCapital = account.startingCash;
        console.log(`Stocks: starting capital set to $${startingCapital.toFixed(2)}`);
    }

    const stockPositions = getStockPositions(markMap);
    const held = stockPositions.map(p => p.symbol);

    // Market-wide correlation check
    const correlation = await smartFilters.getMarketCorrelation(snapshots, WATCHLIST);
    // Sector rotation
    const sectorData = smartFilters.getSectorRotation(snapshots, WATCHLIST);
    // Time-of-day quality
    const timeFilter = smartFilters.timeOfDayFilter();
    // Drawdown protection. The paper ledger has no prior-day close to compare against,
    // so intraday equity == baseline (no halt). Downside is covered by the 200-MA regime
    // gate + per-position Chandelier stops; this whole-portfolio halt was Alpaca-specific.
    const drawdown = smartFilters.drawdownCheck({ equity: account.portfolioValue, last_equity: account.portfolioValue });
    if (drawdown.halt) {
        console.log(`[Stocks] ${drawdown.reason}`);
        return [{ ticker: 'HALTED', signal: 'HALT', reason: drawdown.reason }];
    }
    // Max loss position check
    const forceCloses = await smartFilters.checkMaxLossPositions(stockPositions);
    const forceClosed = new Set();
    for (const fc of forceCloses) {
        console.log(`[Stocks] FORCE CLOSE: ${fc.reason}`);
        const fcPos = stockPositions.find(p => p.symbol === fc.symbol);
        const fcPrice = markMap[fc.symbol] || parseFloat(fcPos?.current_price || 0);
        cancelOpenOrders(fc.symbol);
        closePosition(fc.symbol, fcPrice);
        forceClosed.add(fc.symbol);
        // exit at the position's live price — null here booked the entire cost as a loss
        tradeJournal.recordExit(fc.symbol, parseFloat(fcPos?.current_price || 0) || null, fc.reason);
    }

    // ── CHANDELIER EXIT — primary trailing exit (ATR-adaptive). Rides calm trends,
    // auto-tightens when volatility spikes at tops. Peak tracked per position (Alpaca
    // exposes no peak-since-entry). Cancels the resting Alpaca backstop, then liquidates.
    const stockHighs = loadStockHighs();
    for (const pos of stockPositions) {
        const sym = pos.symbol;
        if (forceClosed.has(sym)) continue;
        const price = snapshots[sym]?.latestTrade?.p || snapshots[sym]?.dailyBar?.c || parseFloat(pos.current_price);
        const atr   = indData[sym]?.atr;
        const entry = parseFloat(pos.avg_entry_price);
        if (!price || !atr || !entry) continue;                     // no ATR (off-watchlist) → Alpaca backstop handles it
        if (!stockHighs[sym] || price > stockHighs[sym]) stockHighs[sym] = price;
        const uplPct    = (price - entry) / entry * 100;
        const chandStop = stockHighs[sym] - CHANDELIER_MULT * atr;
        if (uplPct > 1 && price < chandStop) {                      // arm above +1% so entry noise can't trigger it
            cancelOpenOrders(sym);
            const r = closePosition(sym, price);
            if (r.success) {
                tradeJournal.recordExit(sym, price, `chandelier (price < peak−3×ATR, +${uplPct.toFixed(1)}%)`);
                delete stockHighs[sym];
                console.log(`[Stocks] 📉 CHANDELIER EXIT ${sym} @ $${price.toFixed(2)} (+${uplPct.toFixed(1)}%)`);
            }
        }
    }
    for (const k of Object.keys(stockHighs)) if (!held.includes(k)) delete stockHighs[k];   // prune sold-off symbols
    saveStockHighs(stockHighs);

    // Reconcile: close journal entries whose Alpaca position vanished
    // (trailing-stop fills and manual sells never told the journal — entries
    // were piling up as "open" forever and skewing stream win-rate stats)
    try {
        const priceMap = {};
        for (const t of WATCHLIST) {
            const p = snapshots[t]?.latestTrade?.p || snapshots[t]?.dailyBar?.c;
            if (p) priceMap[t] = p;
        }
        const n = tradeJournal.reconcile('stocks', stockPositions.map(p => p.symbol), priceMap);
        if (n) console.log(`[Stocks] Journal reconcile — closed ${n} stale open entrie(s)`);
    } catch (e) { console.log(`[Stocks] Reconcile error: ${e.message}`); }

    for (const ticker of WATCHLIST) {
        const snap = snapshots[ticker];
        const price = snap?.latestTrade?.p || snap?.dailyBar?.c || null;
        const prevClose = snap?.prevDailyBar?.c || null;
        const change = price && prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

        const [news, stocktwits] = await Promise.all([getNews(ticker), getStocktwits(ticker)]);
        const newsScore = newsSentiment(news);
        const rsi = rsiMap[ticker] ?? null;
        // RSI(14): penalise overbought entries, reward oversold dip-buys
        const rsiAdj = rsi === null ? 0 : rsi > 70 ? -2 : rsi < 30 ? 2 : 0;
        // Technical indicator bias (MACD, EMA trend, Bollinger, ATR)
        const ind = indData[ticker] || null;
        const indBias = ind ? indicators.indicatorBias(ind) : 0;
        // Volume spike bonus
        const volBias = smartFilters.volumeBias(volumeData[ticker]);
        // Sector rotation bonus
        const secBias = smartFilters.sectorBias(ticker, sectorData);
        // Support/Resistance
        const pivotAdj = smartFilters.pivotBias(price, pivots[ticker]);

        // Congressional trade boost (direct buy + sister/halo effect)
        const congress = getCongressBoost(ticker);
        const congressAdj = congress.congressScore;

        const rawScore = newsScore + stocktwits.score
            + (change > 7 ? 4 : change > 3 ? 2 : change < -7 ? -4 : change < -3 ? -2 : 0)
            + (fearGreedValue > 60 ? 1 : fearGreedValue < 30 ? -1 : 0)
            + rsiAdj + indBias + volBias + secBias + pivotAdj + congressAdj;

        if (congressAdj !== 0) {
            const why = congress.directBuy
                ? `direct buy by ${congress.details.join(', ')}`
                : `sister stocks ${congress.sisterDetails.join(', ')} bought`;
            console.log(`[Stocks] ${ticker} congress boost ${congressAdj > 0 ? '+' : ''}${congressAdj.toFixed(1)} — ${why}`);
        }

        // Apply learned weights from trade journal
        const signalBreakdown = {
            newsSentiment: newsScore,
            rsi: rsiAdj,
            macdCrossover: ind?.macd?.crossover ? 2 : 0,
            macdBullish: ind?.macd?.bullish ? 0.5 : -0.5,
            emaTrend: ind?.trend === 'uptrend' ? 1 : ind?.trend === 'downtrend' ? -1 : 0,
            bollingerBand: ind?.bollinger ? (ind.bollinger.pctB < 0.05 ? 1.5 : ind.bollinger.pctB > 0.95 ? -1.5 : 0) : 0,
            bollingerSqueeze: ind?.bollinger?.squeeze ? 0.5 : 0,
            fearGreed: fearGreedValue > 60 ? 1 : fearGreedValue < 30 ? -1 : 0,
            volume: stocktwits.score,
            congressBuy: congress.signals.congressBuy || 0,
            congressVip: congress.signals.congressVip || 0,
            congressBigMoney: congress.signals.congressBigMoney || 0,
        };
        const weightedScore = tradeJournal.applyWeights(signalBreakdown);

        // Apply research-report bias from latest pre-market / intraday report
        const biased = reportContext.biasScore(ticker, rawScore);
        const totalScore = biased.biased;
        const researchBias = biased.bias;
        const researchReasons = biased.reasons;

        const pos = stockPositions.find(p => p.symbol === ticker);
        const hasPosition = held.includes(ticker);
        const unrealizedPct = pos ? parseFloat(pos.unrealized_plpc) * 100 : 0;

        // Reset ladder tiers when position recovers above -5%
        if (ladderLevels.has(ticker) && unrealizedPct > -5) {
            ladderLevels.delete(ticker);
        }

        let signal = 'HOLD';
        let action = null;
        let ladderTier = null;

        // Gate on totalScore ONLY (the complete signal: news + momentum + indicators +
        // sector + pivots + congress). The old code ALSO required weightedScore >= gate,
        // but weightedScore is built from a DIFFERENT, narrower signal set (no momentum/
        // sector/pivots), so it vetoed real setups — stocks made 0 trades in 6 sessions.
        // weightedScore is still logged below for the learning loop, just not a hard gate.
        if (totalScore >= timeFilter.minScore && !hasPosition && cash > 100 && mediumAvail > 100) {
            // Smart filters: multi-timeframe, earnings, correlation, volume
            const preCheck = smartFilters.preTradCheck({
                symbol: ticker, score: totalScore,
                volumeData: volumeData[ticker], hourlyData: hourlyData[ticker],
                correlation, earnings, dailySignal: 'BUY',
            });

            if (preCheck.allow) {
                // Spread check: skip if (ask-bid)/ask > 0.5%
                let stockSpreadBlocked = false;
                try {
                    const quoteRes = await axios.get(`${DATA_BASE}/stocks/quotes/latest`, {
                        headers: HEADERS,
                        params: { symbols: ticker, feed: 'iex' },
                    });
                    const q = quoteRes.data?.quotes?.[ticker];
                    if (q && q.ap > 0 && q.bp > 0) {
                        const spread = (q.ap - q.bp) / q.ap;
                        if (spread > 0.005) {
                            console.log(`[Stocks] ${ticker} skipped — spread too wide (${(spread * 100).toFixed(3)}%)`);
                            stockSpreadBlocked = true;
                        }
                    }
                } catch { /* spread check optional */ }

                // ATR-based position sizing capped by risk budget
                let notional;
                if (ind && ind.atr && price) {
                    const atrPct = ind.atr / price;
                    const riskTarget = 0.01;
                    notional = Math.min(cash * 0.15, (cash * riskTarget) / atrPct);  // increased 8% → 15%
                } else {
                    notional = cash * 0.15;  // increased 8% → 15%
                }
                notional = Math.min(notional, mediumAvail);
                // Circuit breaker — tuner pauses this stream when WR collapses
                let streamPaused = false;
                try { streamPaused = !!require('./adaptiveTuner').getCalib().paused?.stocks; } catch {}
                // 200-MA regime — SOFT for stocks: block NEW longs below SPY's 200-day MA,
                // but never force-sell (US equities grind up; holding through dips wins).
                let stocksRiskOn = true;
                try { stocksRiskOn = require('./regimeFilter').getRegime('stocks').riskOn; } catch {}
                if (streamPaused) {
                    signal = 'PAUSED';
                    action = { blocked: true, reasons: ['circuit breaker: stocks stream paused (low win rate)'] };
                } else if (!stocksRiskOn) {
                    signal = 'REGIME-OFF';
                    action = { blocked: true, reasons: ['regime risk-off: SPY < 200-day MA — no new longs'] };
                } else if (stockSpreadBlocked) {
                    signal = 'BLOCKED';
                    action = { blocked: true, reasons: ['spread too wide'] };
                } else {
                signal = 'BUY';
                action = placeOrder(ticker, 'buy', notional, price);
                if (action.success) {
                    const qty = notional / price;
                    tradeJournal.recordEntry({
                        symbol: ticker, side: 'buy', qty, price,
                        strategy: 'stocks', tier: 'MEDIUM', score: totalScore + preCheck.adjustment,
                        signals: { ...signalBreakdown, volumeSpike: volBias, timeframe: smartFilters.timeframeBias(hourlyData[ticker], 'BUY') },
                        indicators: ind,
                        reason: `Score ${totalScore} (news ${newsScore}, ind ${indBias}, vol ${volBias}, research ${researchBias})`,
                    });
                    action.trailingStop = placeTrailingStop();
                }
                } // end !stockSpreadBlocked else
            } else {
                signal = 'BLOCKED';
                action = { blocked: true, reasons: preCheck.reasons };
            }
        } else if (hasPosition && cash > 50) {
            const triggered = ladderLevels.get(ticker) || new Set();

            for (const tier of LADDER_TIERS) {
                if (unrealizedPct > -tier.dip) continue;
                if (triggered.has(tier.dip)) continue;
                if (change < tier.freefallLimit) continue;
                if (newsScore < tier.minSentiment) continue;
                if (extremeGreed && newsScore < 1) continue;
                ladderTier = tier;
                break;
            }

            if (ladderTier) {
                const notional = startingCapital * ladderTier.pct;
                signal = 'LADDER';
                action = placeOrder(ticker, 'buy', notional, price);
                if (action.success) {
                    triggered.add(ladderTier.dip);
                    ladderLevels.set(ticker, triggered);
                    action.trailingStop = placeTrailingStop();
                    action.ladderTier = ladderTier.label;
                    action.ladderPct = ladderTier.pct * 100;
                }
            } else if (totalScore <= -3 && unrealizedPct < 8) {
                // Bail on a bearish score ONLY if not already a winner. A winner up 8%+
                // rides the Chandelier trail out at its top — don't clip it on a sentiment
                // blip (sentiment is noisy, and clipping winners is what sank this stream).
                signal = 'SELL';
                action = closePosition(ticker, price);
                if (action.success) tradeJournal.recordExit(ticker, price, `Score ${totalScore} — bearish`);
            }
        } else if (totalScore <= -3 && unrealizedPct < 8 && hasPosition) {
            signal = 'SELL';
            action = closePosition(ticker, price);
            if (action.success) tradeJournal.recordExit(ticker, price, `Score ${totalScore} — bearish`);
        }

        results.push({
            ticker,
            price: price ? price.toFixed(2) : 'N/A',
            change: change.toFixed(2),
            newsScore,
            stocktwitsScore: stocktwits.score,
            rsi,
            totalScore,
            weightedScore,
            indBias,
            indicators: ind ? { trend: ind.trend, macd: ind.macd, bollinger: ind.bollinger, atr: ind.atr } : null,
            researchBias,
            researchReasons,
            congressBoost: congressAdj !== 0 ? {
                score: congressAdj,
                directBuy: congress.directBuy,
                sisterBuy: congress.sisterBuy,
                details: congress.details,
                sisterDetails: congress.sisterDetails,
            } : null,
            signal,
            action,
            ladderTier: ladderTier?.label || null,
            unrealizedPct: pos ? unrealizedPct.toFixed(2) : null,
            headlines: news.slice(0, 1).map(a => a.title)
        });
    }

    // ── Partial profit-taking on winners ────────────────────────────────────
    const profitActions = await smartFilters.checkPartialProfits(stockPositions);
    for (const pa of profitActions) {
        const exitPrice = markMap[pa.symbol];
        if (!exitPrice) continue;                       // no live mark → don't fabricate a fill
        const result = smartFilters.executePartialSell(pa.symbol, pa.qty, exitPrice);
        if (result.success) {
            tradeJournal.recordExit(pa.symbol, exitPrice, `Partial profit: ${pa.reason}`);
            console.log(`[Stocks] Partial sell: ${pa.qty} ${pa.symbol} @ $${exitPrice} — ${pa.reason} (fee $${result.fee.toFixed(2)})`);
        }
    }

    // ── Online learning from open stock positions ────────────────────────────
    const openForLearning = results
        .filter(r => r.unrealizedPct !== null)
        .map(r => {
            const ticker = r.ticker;
            const ind    = indData[ticker];
            const journalEntry = tradeJournal.getOpenTrades().find(t => t.symbol === ticker && t.strategy === 'stocks');
            return {
                symbol:        ticker,
                currentPnlPct: parseFloat(r.unrealizedPct),
                signals:       journalEntry?.signals || {},
            };
        })
        .filter(p => p.signals && Object.keys(p.signals).length > 0);
    if (openForLearning.length > 0) tradeJournal.learnFromOpenTrades(openForLearning);

    // ── Post-exit follow-up checks ───────────────────────────────────────────
    // Build price + indicator snapshots from what we already fetched this scan
    const stockPriceMap = {};
    const stockSnapshotMap = {};
    for (const r of results) {
        if (!r.price || r.price === 'N/A') continue;
        const p = parseFloat(r.price);
        stockPriceMap[r.ticker] = p;
        stockSnapshotMap[r.ticker] = {
            rsi:          r.rsi ?? null,
            macdBullish:  r.indicators?.macd?.bullish  ?? null,
            macdCrossover:r.indicators?.macd?.crossover ?? null,
            trend:        r.indicators?.trend ?? null,
            newsScore:    r.newsScore ?? null,
        };
    }
    postExitTracker.processDue(stockPriceMap, ['stocks', 'options'], stockSnapshotMap);

    return results;
}

module.exports = { scan, getSnapshots, getNews, newsSentiment, getBatchRSI, WATCHLIST };
