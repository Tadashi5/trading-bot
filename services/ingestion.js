// ingestion.js — Real Data Ingestion Layer
// Combines: APIs (Finnhub, NewsAPI) + RSS (Yahoo, Google) + Scraping (CNBC, MW, Investing)
// Normalizes all into unified schema, deduplicates, caches, groups by symbol
const axios = require('axios');
const crypto = require('crypto');
const tickerExtractor = require('./tickerExtractor');
const scraper = require('./scraper');

// ── In-Memory Cache ─────────��────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = {
    api: 120000,     // 2 min
    rss: 180000,     // 3 min
    scrape: 300000,  // 5 min
};

function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > entry.ttl) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data, ttl) {
    cache.set(key, { data, time: Date.now(), ttl });
    // Prune old entries periodically
    if (cache.size > 200) {
        const now = Date.now();
        for (const [k, v] of cache) {
            if (now - v.time > v.ttl) cache.delete(k);
        }
    }
}

// ── Normalization ─────────────────────���───────────────────────────��──────────
function normalize(headline, summary, source, url, timestamp, type) {
    const id = crypto.createHash('md5').update(`${source}:${headline}`).digest('hex').slice(0, 12);
    const symbols = tickerExtractor.extract(`${headline} ${summary}`);
    return {
        id,
        symbols,
        headline: headline.trim(),
        summary: (summary || '').trim().slice(0, 300),
        source,
        timestamp: timestamp || new Date().toISOString(),
        url: url || '',
        type,
    };
}

// ── Deduplication ─────────────────────��──────────────────���───────────────────
function deduplicate(articles) {
    const seen = new Set();
    return articles.filter(a => {
        if (seen.has(a.id)) return false;
        // Also check headline similarity (first 50 chars)
        const key = a.headline.toLowerCase().slice(0, 50);
        if (seen.has(key)) return false;
        seen.add(a.id);
        seen.add(key);
        return true;
    });
}

// ═══���═════════════════════════════════��════════════════════════════════════════
// SOURCE: Finnhub API (news + company events)
// ═══════════════════════════════════════════════��══════════════════════════════
async function fetchFinnhub(symbol) {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) return [];

    const cacheKey = `finnhub:${symbol}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
        const res = await axios.get(
            `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${getDateStr(-3)}&to=${getDateStr(0)}&token=${key}`,
            { timeout: 8000 }
        );
        const articles = (res.data || []).slice(0, 10).map(a => normalize(
            a.headline, a.summary, 'Finnhub', a.url, new Date(a.datetime * 1000).toISOString(), 'api'
        ));
        setCache(cacheKey, articles, CACHE_TTL.api);
        return articles;
    } catch { return []; }
}

async function fetchFinnhubGeneral() {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) return [];

    const cacheKey = 'finnhub:general';
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
        const res = await axios.get(
            `https://finnhub.io/api/v1/news?category=general&token=${key}`,
            { timeout: 8000 }
        );
        const articles = (res.data || []).slice(0, 15).map(a => normalize(
            a.headline, a.summary, 'Finnhub', a.url, new Date(a.datetime * 1000).toISOString(), 'api'
        ));
        setCache(cacheKey, articles, CACHE_TTL.api);
        return articles;
    } catch { return []; }
}

// ════════════════════════════════════════════════════════════════════════════���═
// SOURCE: NewsAPI
// ═══════════════════���══════════════════��═══════════════════════════════���═══════
async function fetchNewsAPI(query) {
    const key = process.env.NEWS_API_KEY;
    if (!key) return [];

    const cacheKey = `newsapi:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
        const res = await axios.get(
            `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=10&language=en&apiKey=${key}`,
            { timeout: 8000 }
        );
        const articles = (res.data.articles || []).map(a => normalize(
            a.title, a.description, 'NewsAPI', a.url, a.publishedAt, 'api'
        ));
        setCache(cacheKey, articles, CACHE_TTL.api);
        return articles;
    } catch { return []; }
}

// ═════════════════════════════════════════════════════════════════════════���════
// SOURCE: Yahoo Finance RSS
// ══════════════��═════════════════════��═════════════════════════════════���═══════
async function fetchYahooRSS(symbol) {
    const cacheKey = `yahoo-rss:${symbol}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
        const res = await axios.get(
            `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const items = res.data.match(/<item>([\s\S]*?)<\/item>/g) || [];
        const articles = items.slice(0, 8).map(item => {
            const title = (item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
            const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
            const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
            const desc = (item.match(/<description>(.*?)<\/description>/) || [])[1] || '';
            return normalize(
                title.replace(/<!\[CDATA\[|\]\]>/g, ''),
                desc.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ''),
                'Yahoo Finance',
                link,
                pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
                'rss'
            );
        });
        setCache(cacheKey, articles, CACHE_TTL.rss);
        return articles;
    } catch { return []; }
}

// ════════════════════��══════════════════════════════════��══════════════════════
// SOURCE: Google News RSS
// ═══════════════════════════════════════════════════════════���══════════════════
async function fetchGoogleRSS(query) {
    const cacheKey = `google-rss:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
        const res = await axios.get(
            `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' stock market')}&hl=en-US&gl=US&ceid=US:en`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const items = res.data.match(/<item>([\s\S]*?)<\/item>/g) || [];
        const articles = items.slice(0, 8).map(item => {
            const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
            const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
            const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
            return normalize(title, '', 'Google News', link, pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(), 'rss');
        });
        setCache(cacheKey, articles, CACHE_TTL.rss);
        return articles;
    } catch { return []; }
}

// ═════════════��════════════════════════════════════════════════════��═══════════
// SOURCE: Scraper (CNBC, MarketWatch, Investing.com)
// ═════════��═════════════��═══════════════════════════════════���══════════════════
async function fetchScraped() {
    const cacheKey = 'scraper:all';
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const raw = await scraper.scrapeAll();
    const articles = raw.map(a => normalize(a.headline, a.summary, a.source, a.url, a.timestamp, 'scrape'));
    setCache(cacheKey, articles, CACHE_TTL.scrape);
    return articles;
}

// ════════════��════════════════════════════���══════════════════════════���═════════
// MAIN: Fetch all sources, normalize, deduplicate, group by symbol
// ══════════════════════════════════════════════════════════════════════════════

const WATCHLIST = [
    'TSLA', 'NVDA', 'AMD', 'MSTR', 'COIN', 'SPY', 'AAPL', 'META', 'AMZN',
    'GOOGL', 'MSFT', 'NFLX', 'PLTR', 'GME', 'AMC', 'SOFI', 'RIVN', 'ARM',
    'SMCI', 'BABA', 'UBER', 'SNAP', 'RBLX', 'HOOD', 'IONQ',
];

async function ingestAll() {
    const cacheKey = 'ingestion:all';
    const cached = getCached(cacheKey);
    if (cached) return cached;

    // Parallel fetch from all source types
    const [
        finnhubGeneral,
        newsapiMarket,
        googleRssMarket,
        googleRssCrypto,
        scraped,
        ...finnhubSymbols
    ] = await Promise.allSettled([
        fetchFinnhubGeneral(),
        fetchNewsAPI('stock market trading'),
        fetchGoogleRSS('stock market'),
        fetchGoogleRSS('crypto bitcoin'),
        fetchScraped(),
        // Fetch top 10 watchlist symbols from Finnhub individually
        ...WATCHLIST.slice(0, 10).map(s => fetchFinnhub(s)),
    ]);

    // Also fetch Yahoo RSS for top symbols
    const yahooResults = await Promise.allSettled(
        WATCHLIST.slice(0, 8).map(s => fetchYahooRSS(s))
    );

    // Collect all articles
    const allArticles = [
        ...(finnhubGeneral.status === 'fulfilled' ? finnhubGeneral.value : []),
        ...(newsapiMarket.status === 'fulfilled' ? newsapiMarket.value : []),
        ...(googleRssMarket.status === 'fulfilled' ? googleRssMarket.value : []),
        ...(googleRssCrypto.status === 'fulfilled' ? googleRssCrypto.value : []),
        ...(scraped.status === 'fulfilled' ? scraped.value : []),
        ...finnhubSymbols.flatMap(r => r.status === 'fulfilled' ? r.value : []),
        ...yahooResults.flatMap(r => r.status === 'fulfilled' ? r.value : []),
    ];

    // Deduplicate
    const unique = deduplicate(allArticles);

    // Sort by timestamp (newest first)
    unique.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const result = { articles: unique, fetchedAt: new Date().toISOString(), sourceCount: countSources(unique) };
    setCache(cacheKey, result, 60000); // 1 min cache for full ingestion
    return result;
}

// ── Group articles by symbol ─────��───────────────────────────────────────────
function getStructuredEvents(articles) {
    const bySymbol = {};

    for (const article of (articles || [])) {
        for (const symbol of article.symbols) {
            if (!bySymbol[symbol]) bySymbol[symbol] = { symbol, events: [] };
            bySymbol[symbol].events.push({
                headline: article.headline,
                summary: article.summary,
                source: article.source,
                timestamp: article.timestamp,
                type: article.type,
                url: article.url,
            });
        }
    }

    // Cap events per symbol at 15
    for (const sym of Object.keys(bySymbol)) {
        bySymbol[sym].events = bySymbol[sym].events.slice(0, 15);
    }

    return bySymbol;
}

// ── Convenience: full pipeline in one call ────────────────��──────────────────
async function getFullIngestion() {
    const { articles, fetchedAt, sourceCount } = await ingestAll();
    const structured = getStructuredEvents(articles);
    return { articles, structured, fetchedAt, sourceCount, totalArticles: articles.length };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getDateStr(daysOffset) {
    const d = new Date();
    d.setDate(d.getDate() + daysOffset);
    return d.toISOString().split('T')[0];
}

function countSources(articles) {
    const counts = {};
    for (const a of articles) {
        counts[a.source] = (counts[a.source] || 0) + 1;
    }
    return counts;
}

function getCacheStats() {
    let active = 0, expired = 0;
    const now = Date.now();
    for (const [, v] of cache) {
        if (now - v.time > v.ttl) expired++;
        else active++;
    }
    return { active, expired, total: cache.size };
}

module.exports = {
    ingestAll,
    getStructuredEvents,
    getFullIngestion,
    fetchFinnhub,
    fetchFinnhubGeneral,
    fetchNewsAPI,
    fetchYahooRSS,
    fetchGoogleRSS,
    fetchScraped,
    getCacheStats,
    WATCHLIST,
};
