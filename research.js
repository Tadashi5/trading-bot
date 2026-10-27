// research.js — Automated pre-market research report generator
// Runs locally inside the bot. Fetches macro data, index trends, earnings,
// crypto sentiment, and congressional activity, then writes a structured
// report + signals to reports/ for reportContext.js to consume.
require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const mexc = require('./services/mexc');
// Lazy-loaded to avoid circular dep (politicoScanner → stocks → politicoScanner)
let _politico = null;
function getPolitico() { if (!_politico) _politico = require('./politicoScanner'); return _politico; }
// Lazy-loaded to avoid loading asian.js on startup (heavy Yahoo Finance fetcher)
let _asianPaper = null;
function getAsianPaper() { if (!_asianPaper) _asianPaper = require('./asianPaperTrader'); return _asianPaper; }
let _asian = null;
function getAsian() { if (!_asian) _asian = require('./asian'); return _asian; }

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const FMP_KEY      = process.env.FMP_API_KEY;
const REPORTS_DIR  = path.join(__dirname, 'reports');
const DATA_DIR     = require('./dataDir');

const WATCHLIST = [
    'TSLA','NVDA','AMD','MSTR','COIN','SPY','AAPL','META','AMZN',
    'GOOGL','MSFT','NFLX','PLTR','GME','AMC','SOFI','RIVN','ARM',
    'SMCI','BABA','UBER','SNAP','RBLX','HOOD','IONQ',
];

const BULLISH_WORDS = ['surge','rally','bull','gain','rise','buy','upgrade','beat','record','bullish','soar','strong','growth','positive'];
const BEARISH_WORDS = ['crash','drop','bear','loss','fall','sell','downgrade','miss','fraud','bearish','plunge','weak','recession','negative','warning'];

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function fetchFearGreed() {
    try {
        const res = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 8000 });
        const d = res.data.data[0];
        return { value: parseInt(d.value), label: d.value_classification };
    } catch { return { value: 50, label: 'Neutral' }; }
}

async function fetchIndexQuotes() {
    // Use Yahoo Finance for SPY, QQQ, DIA, VIX
    const symbols = ['SPY','QQQ','DIA','^VIX'];
    try {
        const encoded = symbols.map(s => encodeURIComponent(s)).join(',');
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encoded}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 }
        );
        const out = {};
        for (const q of (res.data?.quoteResponse?.result || [])) {
            out[q.symbol.replace('^', '')] = {
                price:  q.regularMarketPrice,
                change: q.regularMarketChangePercent?.toFixed(2),
                name:   q.shortName || q.symbol,
            };
        }
        return out;
    } catch { return {}; }
}

async function fetchCryptoData() {
    try {
        const [priceRes, fgRes] = await Promise.all([
            axios.get('https://api.coingecko.com/api/v3/global', { timeout: 8000 }),
            axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 8000 }),
        ]);
        const g = priceRes.data.data;
        return {
            btcDominance:   g.market_cap_percentage?.btc?.toFixed(1) || '?',
            totalMarketCap: (g.total_market_cap?.usd / 1e12)?.toFixed(2) || '?',
            change24h:      g.market_cap_change_percentage_24h_usd?.toFixed(2) || '0',
            fearGreed:      parseInt(fgRes.data.data[0].value),
            fearLabel:      fgRes.data.data[0].value_classification,
        };
    } catch { return { btcDominance: '?', totalMarketCap: '?', change24h: '0', fearGreed: 50, fearLabel: 'Neutral' }; }
}

async function fetchNews(query, pageSize = 5) {
    // Try NewsAPI first, fallback to GNews (free, no localhost restriction)
    try {
        const res = await axios.get(
            `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=${pageSize}&apiKey=${NEWS_API_KEY}`,
            { timeout: 8000 }
        );
        if (res.data.articles?.length) return res.data.articles;
    } catch {}

    // Fallback: GNews free tier (10 req/day, no key needed for basic)
    try {
        const res = await axios.get(
            `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&max=${pageSize}&lang=en&apikey=${process.env.GNEWS_API_KEY || 'none'}`,
            { timeout: 8000 }
        );
        return (res.data.articles || []).map(a => ({ title: a.title, description: a.description }));
    } catch {}

    // Fallback 2: Google News RSS (always free, no key)
    try {
        const res = await axios.get(
            `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const titles = (res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || [])
            .slice(0, pageSize)
            .map(t => ({ title: t.replace(/<title><!\[CDATA\[|\]\]><\/title>/g, ''), description: '' }));
        return titles;
    } catch {}

    return [];
}

function scoreSentiment(articles) {
    let score = 0;
    articles.forEach(a => {
        const t = `${a.title} ${a.description || ''}`.toLowerCase();
        BULLISH_WORDS.forEach(w => { if (t.includes(w)) score++; });
        BEARISH_WORDS.forEach(w => { if (t.includes(w)) score--; });
    });
    return score;
}

async function fetchEarningsThisWeek() {
    // Try FMP API for earnings calendar
    if (!FMP_KEY) return [];
    try {
        const now   = new Date();
        const fri   = new Date(now);
        fri.setDate(fri.getDate() + (5 - fri.getDay() + 7) % 7);
        const from  = now.toISOString().split('T')[0];
        const to    = fri.toISOString().split('T')[0];
        const res   = await axios.get(
            `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`,
            { timeout: 10000 }
        );
        const all = res.data || [];
        return all.filter(e => WATCHLIST.includes(e.symbol)).map(e => ({
            symbol: e.symbol,
            date:   e.date,
            time:   e.time || '?', // bmo = before market open, amc = after market close
        }));
    } catch { return []; }
}

async function fetchMexcIntel() {
    try {
        const [watchlist, movers] = await Promise.all([
            mexc.scanWatchlist(),
            mexc.getTopMovers(10),
        ]);
        // Summarise meme/alt/defi momentum
        const memeAvg = watchlist.meme?.length ? watchlist.meme.reduce((s, c) => s + c.change, 0) / watchlist.meme.length : 0;
        const altAvg  = watchlist.alt?.length  ? watchlist.alt.reduce((s, c) => s + c.change, 0) / watchlist.alt.length   : 0;
        const defiAvg = watchlist.defi?.length  ? watchlist.defi.reduce((s, c) => s + c.change, 0) / watchlist.defi.length : 0;

        // Hot meme coins (>10% in 24h)
        const hotMemes = (watchlist.meme || []).filter(c => c.change > 10).sort((a, b) => b.change - a.change);
        // Bleeding memes (<-10%)
        const bleedMemes = (watchlist.meme || []).filter(c => c.change < -10).sort((a, b) => a.change - b.change);
        // Hot alts
        const hotAlts = (watchlist.alt || []).filter(c => c.change > 5).sort((a, b) => b.change - a.change);
        // Hot defi
        const hotDefi = (watchlist.defi || []).filter(c => c.change > 5).sort((a, b) => b.change - a.change);

        return {
            memeAvg: memeAvg.toFixed(2),
            altAvg: altAvg.toFixed(2),
            defiAvg: defiAvg.toFixed(2),
            hotMemes, bleedMemes, hotAlts, hotDefi,
            gainers: movers.gainers || [],
            losers: movers.losers || [],
            meme: watchlist.meme || [],
            alt: watchlist.alt || [],
            defi: watchlist.defi || [],
        };
    } catch { return { memeAvg: '0', altAvg: '0', defiAvg: '0', hotMemes: [], bleedMemes: [], hotAlts: [], hotDefi: [], gainers: [], losers: [], meme: [], alt: [], defi: [] }; }
}

async function fetchCongressionalActivity() {
    try {
        const res = await axios.get(
            'https://www.capitoltrades.com/trades?pageSize=50&page=1',
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                },
                timeout: 15000,
                decompress: true,
            }
        );
        const html = res.data.replace(/\\"/g, '"');
        const re = /"txType":"(?:buy|sell)"/g;
        let count = 0, buys = 0, tickers = {};
        let m;
        while ((m = re.exec(html)) !== null) {
            count++;
            // Try to extract ticker
            let depth = 0, start = m.index;
            for (let i = m.index; i >= 0; i--) {
                if (html[i] === '}') depth++;
                else if (html[i] === '{') { if (depth === 0) { start = i; break; } depth--; }
            }
            depth = 0; let end = start;
            for (let i = start; i < html.length; i++) {
                if (html[i] === '{') depth++;
                else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
            }
            try {
                const obj = JSON.parse(html.slice(start, end));
                if (/buy|purchase/i.test(obj.txType)) {
                    buys++;
                    const ticker = (obj.issuer?.issuerTicker || '').replace(/:US$/i, '').trim();
                    if (ticker && ticker.length <= 6) tickers[ticker] = (tickers[ticker] || 0) + 1;
                }
            } catch {}
        }
        // Top tickers by congressional buy count
        const sorted = Object.entries(tickers).sort((a, b) => b[1] - a[1]).slice(0, 10);
        return { totalTrades: count, buys, topTickers: sorted.map(([t, c]) => ({ ticker: t, count: c })) };
    } catch { return { totalTrades: 0, buys: 0, topTickers: [] }; }
}

// ── Report generation ─────────────────────────────────────────────────────────

async function generate() {
    console.log('[Research] Generating pre-market report...');

    const [fearGreed, indices, crypto, macroNews, marketNews, cryptoNews, earnings, congress, mexcIntel, asianScan] = await Promise.all([
        fetchFearGreed(),
        fetchIndexQuotes(),
        fetchCryptoData(),
        fetchNews('Federal Reserve inflation economy GDP', 10),
        fetchNews('stock market S&P Nasdaq earnings', 10),
        fetchNews('Bitcoin Ethereum crypto blockchain', 8),
        fetchEarningsThisWeek(),
        fetchCongressionalActivity(),
        fetchMexcIntel(),
        getAsian().scan().catch(() => null),
    ]);

    // Score each section
    const macroScore  = scoreSentiment(macroNews);
    const marketScore = scoreSentiment(marketNews);
    const cryptoScore = scoreSentiment(cryptoNews);

    // ── Determine signals ────────────────────────────────────────────────────

    // Overall sentiment
    const totalScore = macroScore + marketScore;
    const sentiment  = totalScore >= 3 ? 'bullish' : totalScore <= -3 ? 'bearish' : 'neutral';

    // Crypto view — blend news score with MEXC meme/alt momentum
    const memeBoost = parseFloat(mexcIntel.memeAvg) > 5 ? 2 : parseFloat(mexcIntel.memeAvg) < -5 ? -2 : 0;
    const altBoost  = parseFloat(mexcIntel.altAvg) > 3 ? 1 : parseFloat(mexcIntel.altAvg) < -3 ? -1 : 0;
    const adjustedCryptoScore = cryptoScore + memeBoost + altBoost;
    const cryptoView = adjustedCryptoScore >= 2 ? 'bullish' : adjustedCryptoScore <= -2 ? 'bearish' : 'neutral';

    // VIX view
    const vix = indices.VIX?.price || 20;
    const vixView = vix > 30 ? 'high' : vix > 22 ? 'elevated' : vix < 14 ? 'low' : 'normal';

    // EOD feedback loop — load yesterday's end-of-day signals to seed watchlist/avoid
    const watchlist = [];
    const avoid     = [];
    try {
        const eodPath = path.join(REPORTS_DIR, 'eod-latest.json');
        if (fs.existsSync(eodPath)) {
            const eod = JSON.parse(fs.readFileSync(eodPath, 'utf8'));
            const worstSignals = eod?.signals?.worstSignals || [];
            const bestSignals  = eod?.signals?.bestSignals  || [];
            for (const ticker of worstSignals) {
                if (!avoid.includes(ticker)) avoid.push(ticker);
            }
            for (const ticker of bestSignals) {
                if (!avoid.includes(ticker) && !watchlist.includes(ticker)) watchlist.push(ticker);
            }
            if (worstSignals.length || bestSignals.length) {
                console.log(`[Research] EOD feedback: +watchlist ${bestSignals.join(',') || 'none'}, +avoid ${worstSignals.join(',') || 'none'}`);
            }
        }
    } catch (e) {
        console.warn('[Research] Could not load eod-latest.json:', e.message);
    }

    // Check individual ticker sentiment for watchlist stocks
    const tickerChecks = await Promise.all(
        WATCHLIST.map(async ticker => {
            const news = await fetchNews(ticker, 3);
            const score = scoreSentiment(news);
            return { ticker, score };
        })
    );

    for (const { ticker, score } of tickerChecks) {
        if (score >= 2) watchlist.push(ticker);
        if (score <= -2) avoid.push(ticker);
    }

    // Congressional favorites get a watchlist boost
    for (const { ticker, count } of congress.topTickers) {
        if (count >= 3 && !watchlist.includes(ticker) && !avoid.includes(ticker)) {
            watchlist.push(ticker);
        }
    }

    // ── Enrich with live politico scanner data ──────────────────────────────
    let politicoIntel = { hotSignals: [], bigMoney: [], polScores: {}, followups: [], tradeFeed: [], learnings: [] };
    try {
        const { learnings, scores, completed } = getPolitico().getFollowupLearnings();
        const sigState = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'politico-signals.json'), 'utf8'));
        const lastResult = sigState.lastResult || {};
        politicoIntel = {
            hotSignals:  lastResult.hotSignals || [],
            bigMoney:    lastResult.bigMoney || [],
            polScores:   scores || {},
            followups:   completed || [],
            tradeFeed:   lastResult.tradeFeed || [],
            learnings:   learnings || [],
        };

        // Hot signals (3+ politicians) → add to watchlist
        for (const sig of politicoIntel.hotSignals) {
            if (!watchlist.includes(sig.ticker) && !avoid.includes(sig.ticker)) {
                watchlist.push(sig.ticker);
            }
        }

        // Big money ($50K+) from accurate politicians → watchlist
        for (const trade of politicoIntel.bigMoney) {
            const ps = politicoIntel.polScores[trade.politician];
            const isAccurate = !ps || ps.total < 3 || ps.winRate >= 50;
            if (isAccurate && !watchlist.includes(trade.ticker) && !avoid.includes(trade.ticker)) {
                watchlist.push(trade.ticker);
            }
        }

        // Politicians with bad track records selling a ticker → avoid
        for (const trade of politicoIntel.tradeFeed) {
            if (trade.side === 'sell') {
                const ps = politicoIntel.polScores[trade.politician];
                const isAccurate = ps && ps.total >= 3 && ps.winRate >= 50;
                if (isAccurate && !avoid.includes(trade.ticker)) {
                    avoid.push(trade.ticker);
                }
            }
        }

        // Follow-up insider wins → boost sector sentiment
        const recentWins = politicoIntel.learnings.filter(l => l.verdict === 'insider_win').slice(-10);
        for (const win of recentWins) {
            if (!watchlist.includes(win.ticker) && !avoid.includes(win.ticker)) {
                watchlist.push(win.ticker);
            }
        }

        console.log(`[Research] Politico intel: ${politicoIntel.hotSignals.length} hot, ${politicoIntel.bigMoney.length} big$, ${Object.keys(politicoIntel.polScores).length} scored politicians`);
    } catch (e) {
        console.warn('[Research] Could not load politico intel:', e.message);
    }

    // ── Build markdown report ────────────────────────────────────────────────

    const spy = indices.SPY;
    const qqq = indices.QQQ;
    const now = new Date();

    const summary = `Market is ${sentiment}. `
        + `SPY ${spy ? (parseFloat(spy.change) >= 0 ? '+' : '') + spy.change + '%' : 'N/A'}, `
        + `VIX at ${vix.toFixed ? vix.toFixed(1) : vix} (${vixView}). `
        + `Crypto ${cryptoView} (BTC dom ${crypto.btcDominance}%). `
        + `F&G: ${fearGreed.value} (${fearGreed.label}). `
        + (watchlist.length ? `Favor: ${watchlist.join(', ')}. ` : '')
        + (avoid.length ? `Avoid: ${avoid.join(', ')}.` : '');

    const earningsSection = earnings.length
        ? earnings.map(e => `- **${e.symbol}** — ${e.date} (${e.time === 'bmo' ? 'pre-market' : e.time === 'amc' ? 'after-close' : e.time})`).join('\n')
        : '- No watchlist earnings this week';

    // Build rich congressional section from politico intel
    const congressBasic = congress.topTickers.length
        ? congress.topTickers.slice(0, 8).map(t => `- **$${t.ticker}** — ${t.count} congressional buys`).join('\n')
        : '- No significant congressional activity';

    const hotSignalLines = politicoIntel.hotSignals.length
        ? politicoIntel.hotSignals.slice(0, 5).map(s => `- **$${s.ticker}** — ${s.count} politicians (${(s.politicians||[]).slice(0,3).join(', ')})`).join('\n')
        : '';

    const bigMoneyLines = politicoIntel.bigMoney.length
        ? politicoIntel.bigMoney.slice(0, 8).map(t => {
            const ps = politicoIntel.polScores[t.politician];
            const acc = ps && ps.total >= 3 ? ` [${ps.winRate}% accuracy]` : '';
            return `- **$${t.ticker}** — $${(t.value/1000).toFixed(0)}K by ${t.politician}${acc}`;
        }).join('\n')
        : '';

    const insiderWins = politicoIntel.learnings.filter(l => l.verdict === 'insider_win').slice(-5);
    const insiderLines = insiderWins.length
        ? insiderWins.map(l => `- **$${l.ticker}** ${l.priceMove > 0 ? '+' : ''}${l.priceMove.toFixed(1)}% after ${l.politician} ${l.side}`).join('\n')
        : '';

    const congressSection = [
        congressBasic,
        hotSignalLines ? `\n**Hot Signals (3+ politicians buying):**\n${hotSignalLines}` : '',
        bigMoneyLines ? `\n**Big Money ($50K+ trades):**\n${bigMoneyLines}` : '',
        insiderLines ? `\n**Recent Insider Wins (follow-up confirmed):**\n${insiderLines}` : '',
    ].filter(Boolean).join('\n');

    const macroHeadlines = macroNews.slice(0, 5).map(a => `- ${a.title}`).join('\n');
    const marketHeadlines = marketNews.slice(0, 5).map(a => `- ${a.title}`).join('\n');
    const cryptoHeadlines = cryptoNews.slice(0, 5).map(a => `- ${a.title}`).join('\n');

    const markdown = `# Pre-Market Research Report
*Generated: ${now.toISOString().slice(0, 16)} UTC*

## Summary
${summary}

## Market Sentiment: **${sentiment.toUpperCase()}**
- Fear & Greed Index: **${fearGreed.value}** (${fearGreed.label})
- Overall news score: macro ${macroScore >= 0 ? '+' : ''}${macroScore} / market ${marketScore >= 0 ? '+' : ''}${marketScore}

## Major Indices
| Index | Price | Change |
|-------|-------|--------|
| SPY | ${spy?.price || '—'} | ${spy?.change || '—'}% |
| QQQ | ${qqq?.price || '—'} | ${qqq?.change || '—'}% |
| DIA | ${indices.DIA?.price || '—'} | ${indices.DIA?.change || '—'}% |
| VIX | ${vix} | ${vixView} |

## VIX View: **${vixView.toUpperCase()}**
VIX at ${vix}. ${vix > 25 ? 'Elevated volatility — tighten stops, reduce position sizes.' : vix < 15 ? 'Low vol environment — good for premium selling (wheel/CSPs).' : 'Normal range — standard positioning.'}

## Crypto: **${cryptoView.toUpperCase()}**
- BTC Dominance: ${crypto.btcDominance}%
- Total Market Cap: $${crypto.totalMarketCap}T (24h: ${crypto.change24h}%)
- Crypto Fear & Greed: ${crypto.fearGreed} (${crypto.fearLabel})
- News score: ${cryptoScore >= 0 ? '+' : ''}${cryptoScore}

## Earnings This Week (Watchlist)
${earningsSection}

## Congressional Trading Activity
${congressSection}
Total: ${congress.buys} buys out of ${congress.totalTrades} trades tracked

## Macro Headlines
${macroHeadlines || '- No major macro news'}

## Market Headlines
${marketHeadlines || '- No major market news'}

## Crypto Headlines
${cryptoHeadlines || '- No major crypto news'}

## MEXC Alt/Meme/DeFi Intel
**Sector Averages (24h):** Meme ${mexcIntel.memeAvg}% | Alt ${mexcIntel.altAvg}% | DeFi ${mexcIntel.defiAvg}%

### 🚀 Top MEXC Gainers
${mexcIntel.gainers.slice(0, 8).map(g => `- **${g.displaySymbol}** $${g.price < 1 ? g.price.toFixed(4) : g.price.toFixed(2)} (+${g.change.toFixed(1)}%)`).join('\n') || '- No data'}

### 📉 Top MEXC Losers
${mexcIntel.losers.slice(0, 5).map(l => `- **${l.displaySymbol}** $${l.price < 1 ? l.price.toFixed(4) : l.price.toFixed(2)} (${l.change.toFixed(1)}%)`).join('\n') || '- No data'}

### 🐸 Hot Meme Coins (>10% 24h)
${mexcIntel.hotMemes.length ? mexcIntel.hotMemes.slice(0, 6).map(c => `- **${c.displaySymbol}** +${c.change.toFixed(1)}% ($${c.price < 1 ? c.price.toFixed(6) : c.price.toFixed(2)})`).join('\n') : '- No meme coins pumping >10%'}

### ⚠️ Bleeding Memes (<-10% 24h)
${mexcIntel.bleedMemes.length ? mexcIntel.bleedMemes.slice(0, 5).map(c => `- **${c.displaySymbol}** ${c.change.toFixed(1)}%`).join('\n') : '- No major meme dumps'}

### 💎 Hot Alts & DeFi (>5% 24h)
${[...mexcIntel.hotAlts, ...mexcIntel.hotDefi].slice(0, 8).map(c => `- **${c.displaySymbol}** +${c.change.toFixed(1)}% (${c.category})`).join('\n') || '- No standout moves'}

## 🌏 Global Markets (International Paper Trader)
${(() => {
    try {
        const intel = getAsianPaper().getIntel(asianScan);
        const mktLines = Object.entries(intel.mktSummary).map(([k, m]) => {
            const chg  = m.change != null ? `${m.change >= 0 ? '+' : ''}${m.change}%` : '—';
            const sig  = m.signal === 'BULLISH' ? '📈' : m.signal === 'BEARISH' ? '📉' : '➡️';
            const lrn  = m.learnTrades >= 3 ? ` [learned: ${m.learnWinRate}% win, avg ${m.learnAvgReturn >= 0 ? '+' : ''}${m.learnAvgReturn}%]` : '';
            return `- **${m.flag} ${m.name}** ${sig} ${chg} | News: ${m.newsScore >= 0 ? '+' : ''}${m.newsScore} | Signals: ${m.bullish}▲ ${m.bearish}▼${lrn}`;
        }).join('\n');

        const pf = intel.portfolio;
        const portfolioLine = `**Paper Portfolio:** $${pf.portfolioValue || 2000} (${(pf.totalReturn || 0) >= 0 ? '+' : ''}${pf.totalReturn || 0}% total) | Win rate: ${pf.winRate || 0}% on ${pf.trades || 0} trades`;

        const posLines = intel.openPositions.length
            ? intel.openPositions.map(p => `- ${p.symbol} (${p.name}) ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}% [${p.market.toUpperCase()}]`).join('\n')
            : '- No open positions';

        const topStocksLine = intel.topStocks.length
            ? intel.topStocks.map(s => `${s.symbol} ${s.winRate}%WR ${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn}% avg (${s.trades}t)`).join(' | ')
            : 'insufficient data';

        return `${mktLines}\n\n${portfolioLine}\n\n**Open Positions:**\n${posLines}\n\n**Best Stocks Learned:** ${topStocksLine}`;
    } catch { return '- International data unavailable'; }
})()}

## Signals
- **Watchlist (favor):** ${watchlist.length ? watchlist.join(', ') : 'none'}
- **Avoid (de-risk):** ${avoid.length ? avoid.join(', ') : 'none'}
`;

    const signals = {
        sentiment,
        cryptoView,
        vixView,
        watchlist,
        avoid,
        summary,
        mexc: {
            memeAvg: mexcIntel.memeAvg,
            altAvg: mexcIntel.altAvg,
            defiAvg: mexcIntel.defiAvg,
            hotMemes: mexcIntel.hotMemes.slice(0, 5).map(c => c.displaySymbol),
            hotAlts: mexcIntel.hotAlts.slice(0, 5).map(c => c.displaySymbol),
            hotDefi: mexcIntel.hotDefi.slice(0, 5).map(c => c.displaySymbol),
        },
        congress: {
            hotTickers:  politicoIntel.hotSignals.map(s => s.ticker),
            bigMoney:    politicoIntel.bigMoney.slice(0, 10).map(t => ({ ticker: t.ticker, politician: t.politician, value: t.value })),
            insiderWins: insiderWins.length,
            totalLearnings: politicoIntel.learnings.length,
            topPoliticians: Object.entries(politicoIntel.polScores)
                .filter(([, s]) => s.total >= 3)
                .sort((a, b) => b[1].winRate - a[1].winRate)
                .slice(0, 5)
                .map(([name, s]) => ({ name, winRate: s.winRate, avgMove: s.avgMove })),
        },
    };

    // ── Save report ──────────────────────────────────────────────────────────

    const dateDir = path.join(REPORTS_DIR, now.toISOString().split('T')[0]);
    if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });

    const stamp  = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const mdPath = path.join(dateDir, `pre-market-${stamp}.md`);
    fs.writeFileSync(mdPath, markdown);

    // Write latest.json for reportContext.js to pick up
    const record = {
        type:       'pre-market',
        sourceTime: now.toISOString(),
        signals,
        mdPath:     mdPath.replace(__dirname, ''),
    };
    fs.writeFileSync(path.join(REPORTS_DIR, 'latest.json'), JSON.stringify(record, null, 2));
    fs.writeFileSync(path.join(REPORTS_DIR, 'pre-market-latest.json'), JSON.stringify(record, null, 2));

    console.log(`[Research] Report saved: ${mdPath}`);
    console.log(`[Research] Sentiment: ${sentiment} | Crypto: ${cryptoView} | VIX: ${vixView}`);
    if (watchlist.length) console.log(`[Research] Watchlist: ${watchlist.join(', ')}`);
    if (avoid.length)     console.log(`[Research] Avoid: ${avoid.join(', ')}`);

    return { markdown, signals, path: mdPath };
}

module.exports = { generate };
