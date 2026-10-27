// risky.js — High-risk bucket (10% of portfolio)
// Leveraged ETFs (3x index) + meme/momentum stocks.
// Signal threshold is much higher than medium-risk modules.
// Trailing stops are tighter (5%) since these positions move fast.
require('dotenv').config();
const axios         = require('axios');
const barsWindow = require('./barsWindow');
const riskManager   = require('./riskManager');
const reportContext = require('./reportContext');
const indicators    = require('./indicators');
const tradeJournal  = require('./tradeJournal');
const paperBroker   = require('./paperBroker');
const smartFilters  = require('./smartFilters');
const postExitTracker = require('./postExitTracker');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE      = process.env.ALPACA_BASE_URL;
const DATA_BASE = 'https://data.alpaca.markets/v2';

// ── Universe ──────────────────────────────────────────────────────────────────

// Each leveraged ETF is linked to its underlying for news sentiment context
const LEVERAGED = [
    { symbol: 'TQQQ', name: 'Nasdaq 3x Bull',   newsQuery: 'QQQ Nasdaq technology'   },
    { symbol: 'SOXL', name: 'Semis 3x Bull',     newsQuery: 'semiconductors NVDA AMD'  },
    { symbol: 'UPRO', name: 'S&P 500 3x Bull',   newsQuery: 'SPY S&P500 market'        },
    { symbol: 'LABU', name: 'Biotech 3x Bull',   newsQuery: 'biotech FDA drug approval' },
    { symbol: 'FNGU', name: 'FANG+ 3x Bull',     newsQuery: 'FAANG tech mega-cap'      },
];

const MEME = [
    { symbol: 'GME',  name: 'GameStop',    newsQuery: 'GameStop GME short squeeze' },
    { symbol: 'AMC',  name: 'AMC',         newsQuery: 'AMC entertainment short'    },
    { symbol: 'SPCE', name: 'Virgin Galactic', newsQuery: 'Virgin Galactic space'  },
    { symbol: 'CLOV', name: 'Clover Health', newsQuery: 'Clover Health CLOV'       },
];

const ALL_RISKY = [...LEVERAGED, ...MEME];
const ALL_SYMBOLS = ALL_RISKY.map(t => t.symbol);

const BULLISH = ['surge','rally','bull','gain','rise','moon','pump','breakout','buy','bullish','soar','spike','record','ath','explode','rip'];
const BEARISH = ['crash','drop','bear','loss','fall','dump','ban','hack','fraud','sell','bearish','plunge','rug','rekt','collapse','warning'];

// High threshold — only trade on exceptional conviction
const BUY_THRESHOLD  = 5;
const SELL_THRESHOLD = -4;
// 20% of the 10% bucket per trade → 2% of total portfolio per position
const TRADE_PCT = 0.20;
const TRAIL_PCT = '5'; // tighter stop for volatile positions

// ── Data helpers ──────────────────────────────────────────────────────────────

async function getSnapshots(symbols) {
    try {
        const res = await axios.get(`${DATA_BASE}/stocks/snapshots`, {
            headers: HEADERS,
            params: { symbols: symbols.join(','), feed: 'iex' },
        });
        return res.data || {};
    } catch { return {}; }
}

async function getNews(query) {
    try {
        const res = await axios.get(`https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=5&apiKey=${process.env.NEWS_API_KEY}`, { timeout: 8000 });
        if (res.data.articles?.length) return res.data.articles;
    } catch {}
    try {
        const res = await axios.get(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        return (res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || []).slice(0, 5).map(t => ({ title: t.replace(/<title><!\[CDATA\[|\]\]><\/title>/g, ''), description: '' }));
    } catch { return []; }
}

async function getStocktwits(symbol) {
    try {
        const res = await axios.get(`https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`);
        const msgs = res.data.messages || [];
        let bull = 0, bear = 0;
        msgs.forEach(m => {
            if (m.entities?.sentiment?.basic === 'Bullish') bull++;
            if (m.entities?.sentiment?.basic === 'Bearish') bear++;
        });
        return bull - bear;
    } catch { return 0; }
}

function newsSentiment(articles) {
    let score = 0;
    articles.forEach(a => {
        const t = `${a.title} ${a.description || ''}`.toLowerCase();
        BULLISH.forEach(w => { if (t.includes(w)) score++; });
        BEARISH.forEach(w => { if (t.includes(w)) score--; });
    });
    return score;
}

async function getFearGreed() {
    try {
        const res = await axios.get('https://api.alternative.me/fng/?limit=1');
        return parseInt(res.data.data[0].value);
    } catch { return 50; }
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

// Orders execute against our own fee-aware ledger (paperBroker), not a broker API.
function placeOrder(symbol, side, notional, price) {
    const res = side === 'buy'
        ? paperBroker.buy('risky',  symbol, { notional, price })
        : paperBroker.sell('risky', symbol, { price, reason: 'risky exit' });
    return { ...res, notional };
}

// No resting orders in the paper ledger — exits are evaluated each scan.
function placeTrailingStop() { return { success: true, trailPercent: TRAIL_PCT, simulated: true }; }

function getRiskyPositions(priceMap = {}) {
    return paperBroker.getPositions('risky', priceMap).map(p => ({
        symbol: p.symbol,
        qty: String(p.qty),
        avg_entry_price: String(p.avgEntryPrice),
        current_price: String(p.currentPrice),
        market_value: String(p.marketValue),
        unrealized_pl: String(p.unrealizedPl),
        unrealized_plpc: String(p.unrealizedPlpc / 100),
        asset_class: 'us_equity',
    }));
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan(riskStatus) {
    // Time-of-day filter: skip buys in the last 30 minutes of trading (after 3:30pm ET = 19:30 UTC)
    const nowUtc = new Date();
    const utcHour = nowUtc.getUTCHours();
    const utcMin  = nowUtc.getUTCMinutes();
    const riskyTimeBlocked = utcHour > 19 || (utcHour === 19 && utcMin >= 30);
    if (riskyTimeBlocked) {
        console.log(`[Risky] Skipping buys — within 30 min of close (${utcHour}:${String(utcMin).padStart(2,'0')} UTC)`);
    }

    const available = riskStatus?.available?.high ?? 0;
    if (available < 100) {
        console.log(`[Risky] High-risk bucket full ($${available.toFixed(0)} avail) — skipping`);
        return [];
    }

    const [fearGreed, snapshots, rsiMap, indData, volumeData, earnings] = await Promise.all([
        getFearGreed(),
        getSnapshots(ALL_SYMBOLS),
        getBatchRSI(ALL_SYMBOLS),
        indicators.analyze(ALL_SYMBOLS),
        smartFilters.getVolumeSpikes(ALL_SYMBOLS),
        smartFilters.getUpcomingEarnings(ALL_SYMBOLS),
    ]);

    // Mark our ledger to market before reading positions
    const markMap = {};
    for (const s of ALL_SYMBOLS) {
        const p = snapshots[s]?.latestTrade?.p || snapshots[s]?.dailyBar?.c;
        if (p > 0) markMap[s] = p;
    }
    paperBroker.markToMarket('risky', markMap);
    const positions = getRiskyPositions(markMap);
    const held      = new Set(positions.map(p => p.symbol));

    const results = [];

    for (const ticker of ALL_RISKY) {
        const snap      = snapshots[ticker.symbol];
        const price     = snap?.latestTrade?.p || snap?.dailyBar?.c || null;
        const prevClose = snap?.prevDailyBar?.c || null;
        const change    = price && prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
        const rsi       = rsiMap[ticker.symbol] ?? null;
        const hasPos    = held.has(ticker.symbol);
        const pos       = positions.find(p => p.symbol === ticker.symbol);
        const unrealPct = pos ? parseFloat(pos.unrealized_plpc) * 100 : 0;

        let signal = 'HOLD';
        let action = null;

        // Hard -8% stop for leveraged ETFs
        const isLeveraged = LEVERAGED.some(e => e.symbol === ticker.symbol);
        if (isLeveraged && hasPos && unrealPct < -8) {
            signal = 'SELL';
            action = placeOrder(ticker.symbol, 'sell', null, price);
            if (action.success) tradeJournal.recordExit(ticker.symbol, price, `Hard stop -8% (leveraged ETF, unrealized ${unrealPct.toFixed(2)}%)`);
            results.push({ ticker: ticker.symbol, name: ticker.name, type: 'leveraged', price: price ? parseFloat(price).toFixed(2) : null, change: change.toFixed(2), score: 0, rsi, newsScore: 0, twitsScore: 0, signal, action, unrealizedPct: unrealPct.toFixed(2), headline: null });
            continue;
        }

        const [news, twits] = await Promise.all([
            getNews(ticker.newsQuery),
            getStocktwits(ticker.symbol),
        ]);
        const newsScore = newsSentiment(news);

        // Technical indicators
        const ind = indData[ticker.symbol] || null;
        const indBias = ind ? indicators.indicatorBias(ind) : 0;

        let score = newsScore + twits
            + (change > 10 ? 5 : change > 5 ? 3 : change < -10 ? -5 : change < -5 ? -3 : 0)
            + (fearGreed > 65 ? 1 : fearGreed < 25 ? -2 : 0)
            + indBias;

        // RSI gate — refuse to chase overbought, slight bonus on oversold dip
        if (rsi !== null) {
            if (rsi > 75) score -= 3;
            else if (rsi > 70) score -= 2;
            if (rsi < 30) score += 1;
        }

        // Research report context bias
        const biased = reportContext.biasScore(ticker.symbol, score);
        score = biased.biased;

        if (score >= BUY_THRESHOLD && !hasPos && !riskyTimeBlocked) {
            // Earnings + volume check (skip correlation for risky — they're meant to be volatile)
            const earningsOk = smartFilters.earningsFilter(ticker.symbol, earnings);
            const volSpike = smartFilters.volumeBias(volumeData[ticker.symbol]);
            score += volSpike;

            if (!earningsOk.safe) {
                signal = 'BLOCKED';
                action = { blocked: true, reasons: [earningsOk.reason] };
            } else {
                // Spread check: fetch bid/ask snapshot; skip if spread > 0.5%
                let spreadBlocked = false;
                try {
                    const snapRes = await axios.get(`${DATA_BASE}/stocks/quotes/latest`, {
                        headers: HEADERS,
                        params: { symbols: ticker.symbol, feed: 'iex' },
                    });
                    const q = snapRes.data?.quotes?.[ticker.symbol];
                    if (q && q.ap > 0 && q.bp > 0) {
                        const spread = (q.ap - q.bp) / q.ap;
                        if (spread > 0.005) {
                            console.log(`[Risky] ${ticker.symbol} skipped — spread too wide (${(spread * 100).toFixed(3)}%)`);
                            spreadBlocked = true;
                        }
                    }
                } catch { /* spread check optional */ }

                const notional = riskManager.sizeFor('high', riskStatus, TRADE_PCT);
                if (notional > 50 && !spreadBlocked) {
                    signal = 'BUY';
                    action = placeOrder(ticker.symbol, 'buy', notional, price);
                    if (action.success) {
                        const qty = notional / price;
                        tradeJournal.recordEntry({
                            symbol: ticker.symbol, side: 'buy', qty, price,
                            strategy: 'risky', tier: 'HIGH', score,
                            signals: { newsSentiment: newsScore, volume: twits, volumeSpike: volSpike, rsi: rsi !== null ? (rsi < 30 ? 1 : rsi > 70 ? -2 : 0) : 0 },
                            indicators: ind,
                            reason: `Score ${score} (news ${newsScore}, ind ${indBias}, vol ${volSpike})`,
                        });
                        action.trailingStop = placeTrailingStop();
                    }
                }
            }
        } else if (score <= SELL_THRESHOLD && hasPos) {
            signal = 'SELL';
            action = placeOrder(ticker.symbol, 'sell', null, price);
            if (action.success) tradeJournal.recordExit(ticker.symbol, price, `Score ${score} — bearish`);
        }

        results.push({
            ticker:       ticker.symbol,
            name:         ticker.name,
            type:         LEVERAGED.find(e => e.symbol === ticker.symbol) ? 'leveraged' : 'meme',
            price:        price ? parseFloat(price).toFixed(2) : null,
            change:       change.toFixed(2),
            score,
            rsi,
            newsScore,
            twitsScore:   twits,
            signal,
            action,
            unrealizedPct: pos ? unrealPct.toFixed(2) : null,
            headline:     news[0]?.title || null,
        });
    }

    // ── Post-exit follow-up checks (leveraged ETF / meme positions) ──────────
    {
        const riskyPriceMap    = {};
        const riskySnapshotMap = {};
        for (const r of results) {
            if (!r.price) continue;
            riskyPriceMap[r.ticker] = parseFloat(r.price);
            riskySnapshotMap[r.ticker] = {
                rsi:       r.rsi ?? null,
                newsScore: r.newsScore ?? null,
            };
        }
        postExitTracker.processDue(riskyPriceMap, ['risky'], riskySnapshotMap);
    }

    return results;
}

module.exports = { scan, ALL_SYMBOLS };
