require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const reportContext   = require('./reportContext');
const regimeFilter    = require('./regimeFilter');
const tradeJournal    = require('./tradeJournal');
const postExitTracker = require('./postExitTracker');
const paperBroker     = require('./paperBroker');

const HEADERS = {
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;

// Alpaca returns crypto positions as "SOLUSD" but orders use "SOL/USD".
// Comparing them raw NEVER matches — which made the bot re-buy the same coin
// every 5-min scan (it thought it held nothing) and never run position logic.
const norm = s => String(s || '').replace('/', '').toUpperCase();

// High-water marks for the SOFTWARE trailing stop. Alpaca does not support
// trailing_stop orders on crypto (those API calls were silently failing since
// day one), so exits must be managed here.
const HIGHS_FILE = path.join(require('./dataDir'), 'crypto-highwater.json');
function loadHighs() { try { return JSON.parse(fs.readFileSync(HIGHS_FILE, 'utf8')); } catch { return {}; } }
function saveHighs(h) { fs.writeFileSync(HIGHS_FILE, JSON.stringify(h, null, 2)); }

// Exit rules: bank real profits, protect gains once meaningfully up.
// Backtested on the full watchlist (backtestCryptoExits.js, Jul 2023–Jul 2026):
// a +15% take-profit clipped the fat-tail winners (BTC/SOL/PEPE ran 2–4× further),
// and looser TP monotonically improved returns. Trailing stop does the real work;
// the fixed TP is set high so it only catches genuine blow-off tops. Memes stay
// tight — they round-trip to zero (BONK -88%, WIF -86%), so protect gains fast.
const CRYPTO_EXITS = {
    TAKE_PROFIT:      25,   // +25% → sell (was 15, too tight — capped winners). Memes: 10%
    TAKE_PROFIT_MEME: 10,
    TRAIL_FROM_HIGH:  -10,  // once up >2%, drop 10% from high-water → sell (was -8; let winners breathe)
    TRAIL_MEME:       -5,   // memes dump fast — tighter trail justified by crash risk
    TRAIL_ARM_AT:     2,    // trail only arms after +2% so entry noise can't stop us out
    CHANDELIER_MULT:  3,    // majors: exit when price < peak - 3×ATR (volatility-adaptive)
};

// Chandelier exit needs ATR — backtest (backtestExitMethods.js) showed an ATR-trail
// captured +108% vs the fixed 10% trail's +77% on the same entries, because it gives
// winners room in calm trends and auto-tightens when volatility spikes at tops.
const { indicators: TA } = require('./strategyLibrary');
async function fetchDailyATR(coinSymbol, period = 14) {
    try {
        const base = coinSymbol.split('/')[0];
        const res = await axios.get('https://data-api.binance.vision/api/v3/klines', {
            params: { symbol: base + 'USDT', interval: '1d', limit: period + 8 }, timeout: 8000,
        });
        const k = res.data || [];
        if (k.length < period + 2) return null;
        const atr = TA.ATR(k.map(x => +x[2]), k.map(x => +x[3]), k.map(x => +x[4]), period);
        const last = atr[atr.length - 1];
        return (last && last > 0) ? last : null;
    } catch { return null; }
}

// 28 coins — majors, alts, DeFi, and high-volatility memes for "go off" plays
const COINS = [
    // ── Majors ─────────────────────────────────────────────────────────────
    { id: 'bitcoin',     symbol: 'BTC/USD',   name: 'Bitcoin'  },
    { id: 'ethereum',    symbol: 'ETH/USD',   name: 'Ethereum' },
    { id: 'solana',      symbol: 'SOL/USD',   name: 'Solana'   },
    { id: 'ripple',      symbol: 'XRP/USD',   name: 'XRP'      },
    { id: 'cardano',     symbol: 'ADA/USD',   name: 'ADA'      },
    { id: 'avalanche-2', symbol: 'AVAX/USD',  name: 'AVAX'     },
    { id: 'chainlink',   symbol: 'LINK/USD',  name: 'LINK'     },
    { id: 'litecoin',    symbol: 'LTC/USD',   name: 'Litecoin' },
    { id: 'bitcoin-cash',symbol: 'BCH/USD',   name: 'BCH'      },
    { id: 'polkadot',    symbol: 'DOT/USD',   name: 'Polkadot' },
    { id: 'matic-network', symbol: 'MATIC/USD', name: 'Polygon' },

    // ── DeFi / Utility ─────────────────────────────────────────────────────
    { id: 'uniswap',     symbol: 'UNI/USD',   name: 'Uniswap'  },
    { id: 'aave',        symbol: 'AAVE/USD',  name: 'Aave'     },
    { id: 'maker',       symbol: 'MKR/USD',   name: 'Maker'    },
    { id: 'the-graph',   symbol: 'GRT/USD',   name: 'Graph'    },
    { id: 'curve-dao-token', symbol: 'CRV/USD', name: 'Curve'  },
    { id: 'sushi',       symbol: 'SUSHI/USD', name: 'Sushi'    },
    { id: 'yearn-finance', symbol: 'YFI/USD', name: 'Yearn'    },
    { id: 'tezos',       symbol: 'XTZ/USD',   name: 'Tezos'    },
    { id: 'basic-attention-token', symbol: 'BAT/USD', name: 'BAT' },

    // ── Memes / High-vol "go off" plays ────────────────────────────────────
    { id: 'dogecoin',    symbol: 'DOGE/USD',  name: 'Dogecoin' },
    { id: 'shiba-inu',   symbol: 'SHIB/USD',  name: 'SHIB'     },
    { id: 'pepe',        symbol: 'PEPE/USD',  name: 'PEPE'     },
    { id: 'bonk',        symbol: 'BONK/USD',  name: 'BONK'     },
    { id: 'dogwifhat',   symbol: 'WIF/USD',   name: 'WIF'      },
    { id: 'floki',       symbol: 'FLOKI/USD', name: 'FLOKI'    },
    { id: 'mog-coin',    symbol: 'MOG/USD',   name: 'MOG'      },
    { id: 'official-trump', symbol: 'TRUMP/USD', name: 'TRUMP' },
];

const MEME_COINS = new Set(['DOGE/USD','SHIB/USD','PEPE/USD','BONK/USD','WIF/USD','FLOKI/USD','MOG/USD','TRUMP/USD']);

const BULLISH = ['surge','rally','bull','gain','rise','moon','pump','breakout','adoption','buy','bullish','soar','spike','ath'];
const BEARISH = ['crash','drop','bear','loss','fall','dump','ban','hack','fraud','liquidat','sell','bearish','plunge','rug'];

async function getPrices() {
    const ids = COINS.map(c => c.id).join(',');
    const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`);
    return res.data;
}

// Our coins are "BTC/USD"; Binance's pair is "BTCUSDT" (base + USDT). The old code
// stripped the slash to "BTCUSD" — a tiny obscure market ($0.3M for BTC) that failed
// the 50M volume floor, so EVERY major got skipped. Memes ("DOGEUSD") 400'd → null.
// Also: api.binance.com is geo-blocked on fly.io's US region; the .vision mirror isn't.
const binancePair = symbol => symbol.split('/')[0] + 'USDT';
const BINANCE_BASES = ['https://data-api.binance.vision', 'https://api.binance.com'];
async function binanceGet(path) {
    for (const base of BINANCE_BASES) {
        try { return (await axios.get(base + path, { timeout: 8000 })).data; }
        catch { /* try next mirror */ }
    }
    return null;
}

async function getBinanceVolume(symbol) {
    const data = await binanceGet(`/api/v3/ticker/24hr?symbol=${binancePair(symbol)}`);
    if (!data || data.quoteVolume == null) return null;
    return { volume: parseFloat(data.quoteVolume) };
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

function sentiment(articles) {
    let score = 0;
    articles.forEach(a => {
        const text = `${a.title} ${a.description || ''}`.toLowerCase();
        BULLISH.forEach(w => { if (text.includes(w)) score++; });
        BEARISH.forEach(w => { if (text.includes(w)) score--; });
    });
    return score;
}

async function getFearGreed() {
    try {
        const res = await axios.get('https://api.alternative.me/fng/?limit=1');
        return res.data.data[0];
    } catch { return null; }
}

// Orders execute against our own fee-aware ledger (paperBroker), not a broker API.
// Fills are at the live market price we already fetched for signals, minus the
// modelled spread/slippage in fees.js. Swap paperBroker for an exchange to go live.
function placeOrder(symbol, side, qty, price) {
    const res = side === 'buy'
        ? paperBroker.buy('crypto',  symbol, { qty: parseFloat(qty), price })
        : paperBroker.sell('crypto', symbol, { qty: parseFloat(qty), price });
    return { ...res, symbol, side, qty };
}

// priceMap: { 'BTC/USD': 64000, ... } — used to mark positions to market
function getPositions(priceMap = {}) {
    return paperBroker.getPositions('crypto', priceMap).map(p => ({
        symbol: p.symbol,
        qty: String(p.qty),
        avg_entry_price: String(p.avgEntryPrice),
        current_price: String(p.currentPrice),
        market_value: String(p.marketValue),
        unrealized_pl: String(p.unrealizedPl),
        unrealized_plpc: String(p.unrealizedPlpc / 100),   // Alpaca-shaped: fraction
        highWater: p.highWater,
    }));
}

// Ladder tiers: checked deepest first, larger buys at deeper dips (best value)
// Freefall thresholds: shallower tiers are more conservative about today's price action
const LADDER_TIERS = [
    { dip: 50, pct: 0.05, minSentiment: -3, freefallLimit: -20, label: '50%' },
    { dip: 35, pct: 0.04, minSentiment: -3, freefallLimit: -20, label: '35%' },
    { dip: 25, pct: 0.03, minSentiment: -2, freefallLimit: -15, label: '25%' },
    { dip: 15, pct: 0.02, minSentiment: -1, freefallLimit: -10, label: '15%' },
];
const ladderLevels = new Map(); // symbol -> Set of triggered tiers
let startingCapital = null;

async function scan(riskStatus) {
    // Time-of-day filter: skip buys between 12am-6am ET (04:00-10:00 UTC) — thin liquidity
    const nowUtc = new Date();
    const utcHour = nowUtc.getUTCHours();
    const cryptoTimeBlocked = utcHour >= 4 && utcHour < 10;
    if (cryptoTimeBlocked) {
        console.log(`[Crypto] Skipping buys — thin liquidity hours (${utcHour}:${String(nowUtc.getUTCMinutes()).padStart(2,'0')} UTC)`);
    }

    const results = [];
    const prices = await getPrices();
    // Mark our ledger to the live market before reading positions/equity
    const priceMap = {};
    for (const c of COINS) { const p = prices[c.id]?.usd; if (p > 0) priceMap[c.symbol] = p; }
    paperBroker.markToMarket('crypto', priceMap);
    const positions = getPositions(priceMap);
    const held = positions.map(p => norm(p.symbol));   // normalized: "SOLUSD" === "SOL/USD"
    const account = paperBroker.getAccount('crypto', priceMap);
    const cash = account.cash;
    // Cap position sizing if medium-risk budget is exhausted
    const mediumAvail = riskStatus?.available?.medium ?? Infinity;

    // 200-MA regime — HARD switch for crypto: risk-off blocks new longs AND raises
    // cash on flat/losing positions (crypto bears are catastrophic; being in cash wins).
    const cryptoRiskOn = regimeFilter.getRegime('crypto').riskOn;
    if (!cryptoRiskOn) console.log('[Crypto] ⚠️ Regime RISK-OFF (BTC < 200-day MA) — no new longs, raising cash');

    // Per-scan buy counters for diversification cap
    let scanBuyCount = 0;
    let scanMemeBuyCount = 0;
    const MAX_SCAN_BUYS = 3;
    const MAX_MEME_BUYS = 2;

    if (startingCapital === null) {
        // Ladder tiers size off the stream's own sandbox, not a broker account
        startingCapital = account.startingCash;
        console.log(`Starting capital set to $${startingCapital.toFixed(2)}`);
    }

    const fearGreed = await getFearGreed();
    const fearGreedValue = fearGreed ? parseInt(fearGreed.value) : 50;

    for (const coin of COINS) {
        const data = prices[coin.id];
        if (!data) continue;

        const price = data.usd;
        const change = data.usd_24h_change ?? 0;
        const news = await getNews(coin.name);
        const newsScore = sentiment(news);
        const volume = await getBinanceVolume(coin.symbol);

        // Volume floor: skip illiquid coins. Lowered 50M → 10M now that the volume
        // fetch actually works — 50M excluded liquid names (DOGE $40M, PEPE $25M, ADA
        // $18M); 10M still filters the truly thin (<$1M: SUSHI/YFI/BAT) for paper-fill realism.
        const VOLUME_FLOOR = 10_000_000;
        if (volume && volume.volume < VOLUME_FLOOR) {
            console.log(`[Crypto] ${coin.symbol} skipped — 24h volume $${(volume.volume / 1e6).toFixed(1)}M < ${VOLUME_FLOOR / 1e6}M floor`);
            continue;
        }

        const hasPosition = held.includes(norm(coin.symbol));
        const pos = positions.find(p => norm(p.symbol) === norm(coin.symbol));
        const unrealizedPct = pos ? parseFloat(pos.unrealized_plpc) * 100 : 0;

        // Reset triggered tiers once position recovers above -2% (tighter to prevent re-laddering loops)
        if (ladderLevels.has(coin.symbol) && unrealizedPct > -2) {
            ladderLevels.delete(coin.symbol);
        }

        // Build named signal map and apply learned weights
        // Weights start at 1.0 and evolve via tradeJournal.learnWeights() over time
        const signalMap = {
            priceMomentum: change > 7 ? 4 : change > 3 ? 2 : change < -7 ? -4 : change < -3 ? -2 : 0,
            newsSentiment: newsScore,
            fearGreed:     fearGreedValue > 60 ? 1 : fearGreedValue < 30 ? -1 : 0,
            volume:        volume?.volume > 1_000_000_000 ? 1 : 0,
        };
        let score = tradeJournal.applyWeights(signalMap);

        // Apply research-report bias (crypto view + watchlist match)
        const cryptoBias = reportContext.biasCryptoScore(coin.symbol, score);
        score = cryptoBias.biased;
        const researchBias = cryptoBias.bias;
        const researchReasons = cryptoBias.reasons;

        let signal = 'HOLD';
        let action = null;
        let ladderTier = null;

        // ── EXIT MANAGEMENT (software — Alpaca has no trailing stops for crypto) ──
        // Take-profit banks winners; software trail protects gains from round-tripping.
        // Before this existed the stream had literally never sold anything.
        let exited = false;
        if (hasPosition && pos && price) {
            const highs = loadHighs();
            const hwKey = norm(coin.symbol);
            if (!highs[hwKey] || price > highs[hwKey]) { highs[hwKey] = price; saveHighs(highs); }
            const peakHigh   = highs[hwKey];
            const offHighPct = (price - peakHigh) / peakHigh * 100;
            const isMemePos  = MEME_COINS.has(coin.symbol);
            const tp    = isMemePos ? CRYPTO_EXITS.TAKE_PROFIT_MEME : CRYPTO_EXITS.TAKE_PROFIT;
            const trail = isMemePos ? CRYPTO_EXITS.TRAIL_MEME       : CRYPTO_EXITS.TRAIL_FROM_HIGH;

            let exitReason = null;
            if (unrealizedPct >= tp) {
                exitReason = `take-profit +${unrealizedPct.toFixed(1)}%`;
            } else if (!cryptoRiskOn && unrealizedPct < CRYPTO_EXITS.TRAIL_ARM_AT) {
                // Regime risk-off → raise cash on anything not meaningfully winning.
                // Strong winners keep riding the chandelier below; flat/losers go to cash.
                exitReason = `regime risk-off — to cash (${unrealizedPct.toFixed(1)}%)`;
            } else if (unrealizedPct > CRYPTO_EXITS.TRAIL_ARM_AT) {
                // Majors → Chandelier (ATR-adaptive). Memes → fixed tight trail (their
                // ATR is huge; a 3×ATR stop would give back their whole move). If the
                // ATR fetch fails, majors fall back to the fixed % trail — never break exits.
                const atr = isMemePos ? null : await fetchDailyATR(coin.symbol);
                if (atr) {
                    const chandStop = peakHigh - CRYPTO_EXITS.CHANDELIER_MULT * atr;
                    if (price < chandStop)
                        exitReason = `chandelier (price < peak−3×ATR, banked +${unrealizedPct.toFixed(1)}%)`;
                } else if (offHighPct <= trail) {
                    exitReason = `trail ${offHighPct.toFixed(1)}% off high (banked +${unrealizedPct.toFixed(1)}%)`;
                }
            }

            if (exitReason) {
                signal = 'SELL';
                action = await placeOrder(coin.symbol, 'sell', pos.qty, price);
                if (action.success) {
                    tradeJournal.recordExit(coin.symbol, price, exitReason);
                    delete highs[hwKey]; saveHighs(highs);
                    ladderLevels.delete(coin.symbol);
                    exited = true;
                    console.log(`[Crypto] 💰 SOLD ${coin.symbol} — ${exitReason}`);
                }
            }
        }

        if (!exited)
        if (score >= 3 && !hasPosition && cash > 100 && mediumAvail > 100 && !cryptoTimeBlocked && cryptoRiskOn) {
            // Diversification cap: max 3 buys total, max 2 meme buys per scan
            const isMeme = MEME_COINS.has(coin.symbol);
            if (scanBuyCount >= MAX_SCAN_BUYS) {
                console.log(`[Crypto] ${coin.symbol} skipped — scan buy cap (${MAX_SCAN_BUYS}) reached`);
                signal = 'HOLD';
            } else if (isMeme && scanMemeBuyCount >= MAX_MEME_BUYS) {
                console.log(`[Crypto] ${coin.symbol} skipped — meme buy cap (${MAX_MEME_BUYS}) reached`);
                signal = 'HOLD';
            } else {
            // Spread check: fetch Binance bid/ask; skip if spread > 1% (same pair/mirror fix as volume)
            let spreadBlocked = false;
            const book = await binanceGet(`/api/v3/ticker/bookTicker?symbol=${binancePair(coin.symbol)}`);
            if (book) {
                const bid = parseFloat(book.bidPrice);
                const ask = parseFloat(book.askPrice);
                if (ask > 0 && bid > 0) {
                    const spread = (ask - bid) / ask;
                    if (spread > 0.01) {
                        console.log(`[Crypto] ${coin.symbol} skipped — spread too wide (${(spread * 100).toFixed(3)}%)`);
                        spreadBlocked = true;
                    }
                }
            }

            if (!spreadBlocked) {
            const sizePct = Math.min(0.02 + (score - 3) * 0.01, 0.06);
            const rawNotional = cash * sizePct;
            const notional = Math.min(rawNotional, mediumAvail);
            const qty = (notional / price).toFixed(6);
            signal = 'BUY';
            action = await placeOrder(coin.symbol, 'buy', qty, price);
            if (action.success) {
                tradeJournal.recordEntry({
                    symbol: coin.symbol, side: 'buy', qty: parseFloat(qty), price,
                    strategy: 'crypto', tier: 'MEDIUM', score,
                    signals: signalMap,
                    indicators: null,
                    reason: `Score ${score.toFixed(2)} (momentum ${signalMap.priceMomentum}, news ${newsScore}, research ${researchBias})`,
                });
                // NOTE: no Alpaca trailing stop — unsupported for crypto (the old
                // call failed silently on every buy). Exits are software-managed above.
                scanBuyCount++;
                if (MEME_COINS.has(coin.symbol)) scanMemeBuyCount++;
            }
            } // end !spreadBlocked
            } // end cap else
        } else if (hasPosition && cash > 50) {
            // Find deepest untriggered ladder tier that passes quality filters
            const triggered = ladderLevels.get(coin.symbol) || new Set();
            const extremeFear = fearGreedValue < 25;
            const extremeGreed = fearGreedValue > 75;

            for (const tier of LADDER_TIERS) {
                if (unrealizedPct > -tier.dip) continue;               // dip not deep enough yet
                if (triggered.has(tier.dip)) continue;                 // already bought this tier
                if (change < tier.freefallLimit) continue;             // collapsing today — skip this tier
                if (newsScore < tier.minSentiment) continue;           // fundamental problem, skip
                if (extremeGreed && newsScore < 1) continue;           // greedy market — require positive signal
                ladderTier = tier;
                break;
            }
            if (ladderTier !== null) {
                const qty = ((startingCapital * ladderTier.pct) / price).toFixed(6);
                signal = 'LADDER';
                action = await placeOrder(coin.symbol, 'buy', qty, price);
                if (action.success) {
                    triggered.add(ladderTier.dip);
                    ladderLevels.set(coin.symbol, triggered);
                    action.ladderTier = ladderTier.label;
                    action.ladderPct = ladderTier.pct * 100;
                }
            } else if (score <= -3) {
                signal = 'SELL';
                action = await placeOrder(coin.symbol, 'sell', pos.qty, price);
                if (action.success) tradeJournal.recordExit(coin.symbol, price, `Score ${score} — bearish`);
            }
        } else if (score <= -3 && hasPosition) {
            signal = 'SELL';
            action = await placeOrder(coin.symbol, 'sell', pos.qty, price);
            if (action.success) tradeJournal.recordExit(coin.symbol, price, `Score ${score} — bearish`);
        }

        results.push({
            name: coin.name,
            symbol: coin.symbol,
            price,
            change: change.toFixed(2),
            sentiment: newsScore,
            score,
            researchBias,
            researchReasons,
            signal,
            action,
            ladderTier,
            unrealizedPct: pos ? unrealizedPct.toFixed(2) : null,
            fearGreed: fearGreed ? `${fearGreed.value} (${fearGreed.value_classification})` : 'N/A'
        });
    }

    // ── Post-exit follow-up checks ───────────────────────────────────────────
    const cryptoPriceMap = {};
    const cryptoSnapshotMap = {};
    for (const r of results) {
        cryptoPriceMap[r.symbol] = r.price;
        cryptoSnapshotMap[r.symbol] = {
            newsScore:  r.sentiment ?? null,
            fearGreed:  fearGreedValue,
            priceMomentum: r.change != null ? parseFloat(r.change) : null,
        };
    }
    postExitTracker.processDue(cryptoPriceMap, ['crypto', 'mexc-bridge'], cryptoSnapshotMap);

    // Reconcile: close any journal entries for crypto sold outside this scan
    // (manual sells, or the years of entries stranded by the symbol mismatch)
    try {
        const n = tradeJournal.reconcile('crypto', positions.map(p => p.symbol), cryptoPriceMap);
        if (n) console.log(`[Crypto] Journal reconcile — closed ${n} stale open entrie(s)`);
    } catch (e) { console.log(`[Crypto] Reconcile error: ${e.message}`); }

    // Online learning from open crypto positions (every scan, not just on close)
    const cryptoOpenForLearning = results
        .filter(r => r.unrealizedPct !== null)
        .map(r => {
            const journalEntry = tradeJournal.getOpenTrades().find(t => t.symbol === r.symbol && t.strategy === 'crypto');
            return { symbol: r.symbol, currentPnlPct: parseFloat(r.unrealizedPct), signals: journalEntry?.signals || {} };
        })
        .filter(p => p.signals && Object.keys(p.signals).length > 0);
    if (cryptoOpenForLearning.length > 0) tradeJournal.learnFromOpenTrades(cryptoOpenForLearning);

    return { results, cash };
}

module.exports = { scan, COINS, MEME_COINS };