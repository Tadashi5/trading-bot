// newsHub.js — One news feed for every symbol the bot trades or learns from.
//
// The universe is derived from the live scanners (stocks WATCHLIST + crypto COINS +
// risky ALL_SYMBOLS), so it can never drift out of sync with what's actually traded.
// Each symbol gets a sentiment score using the SAME bullish/bearish word lists the
// scanners score with — so what you read here is what biases the bot's decisions.
//
// Refreshed on a cron (not per-request): 62 symbols × a request each would burn the
// free NewsAPI tier in minutes and silently return 0-sentiment for every ticker.
'use strict';

require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const paperBroker = require('./paperBroker');
const DATA_DIR  = require('./dataDir');
const CACHE_FILE = path.join(DATA_DIR, 'news-cache.json');

// Same word lists the scanners use — keep these in step with stocks.js / crypto.js
const BULLISH = ['beat','surge','rally','bull','gain','rise','breakthrough','upgrade','buy','bullish',
                 'soar','record','high','moon','pump','breakout','adoption','spike','ath','explode','rip'];
const BEARISH = ['miss','crash','drop','bear','loss','fall','downgrade','sell','bearish','lawsuit','fraud',
                 'investigation','recall','dump','ban','hack','liquidat','plunge','rug','rekt','collapse','warning'];

const REFRESH_MS = 30 * 60 * 1000;   // 30 min — matches the scanners' news TTL
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cache = load();
function load() {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
    catch { return { items: [], updatedAt: null, refreshing: false }; }
}
function save() {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
}

// ── Universe: whatever the scanners actually trade ───────────────────────────
function universe() {
    const out = [];
    try {
        const { WATCHLIST } = require('./stocks');
        for (const t of WATCHLIST) out.push({ symbol: t, query: t + ' stock', kind: 'stock', stream: 'stocks' });
    } catch {}
    try {
        const { COINS } = require('./crypto');
        for (const c of COINS) out.push({ symbol: c.symbol, query: c.name, kind: 'crypto', stream: 'crypto', name: c.name });
    } catch {}
    try {
        const risky = require('./risky');
        for (const t of risky.ALL_SYMBOLS) {
            if (out.some(o => o.symbol === t)) continue;      // GME/AMC also sit in the stocks list
            out.push({ symbol: t, query: t + ' stock', kind: 'stock', stream: 'risky' });
        }
    } catch {}
    // Asia's watchlist is built dynamically from Yahoo scans, so there's no static list
    // to pull. Its OPEN POSITIONS are the part worth reading news on — include those,
    // searching by company name since "6954.T" returns nothing useful.
    try {
        const asia = require('./asianPaperTrader').getState();
        // Positions are keyed BY symbol; the value carries no `symbol` field.
        for (const [sym, p] of Object.entries(asia.positions || {})) {
            if (out.some(o => o.symbol === sym)) continue;
            out.push({ symbol: sym, query: p.name || sym, kind: 'stock', stream: 'asia', name: p.name });
        }
    } catch {}
    return out;
}

function sentiment(articles) {
    let score = 0;
    for (const a of articles) {
        const t = `${a.title} ${a.description || ''}`.toLowerCase();
        for (const w of BULLISH) if (t.includes(w)) score++;
        for (const w of BEARISH) if (t.includes(w)) score--;
    }
    return score;
}

// ── Sources ──────────────────────────────────────────────────────────────────
// Three providers, each covering the others' blind spots:
//   1. Alpaca/Benzinga — professional financial wire, SYMBOL-TAGGED and BATCHABLE
//      (one request returns ~50 articles across ~79 symbols). US equities + crypto.
//      Free with the Alpaca keys we already hold. Blind spot: non-US listings.
//   2. Yahoo Finance RSS — no key, and the only source that handles international
//      tickers directly (9984.T, LLOY.L, RIO.AX, 1810.HK all return real news).
//   3. Google News RSS — last resort, searched by company name.
// NewsAPI is no longer called: its free tier rate-limits into silent 0-sentiment,
// which is exactly the failure mode that hid broken signals for weeks.
//
// Every source records success/failure in `health` so a silently-dead provider is
// visible on the dashboard instead of quietly returning nothing.
const UA = { 'User-Agent': 'Mozilla/5.0' };
const ALPACA_HEADERS = {
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};

// CryptoPanic is crypto-only and needs a free key. Absent a key it reports `disabled`,
// NOT `failing` — "we never asked" must never look like "the source is broken".
const CP_KEY  = process.env.CRYPTOPANIC_KEY || '';
const CP_BASE = process.env.CRYPTOPANIC_BASE || 'https://cryptopanic.com/api/v1/posts/';

let health = {};
const resetHealth = () => { health = {
    alpaca: { ok: 0, fail: 0, articles: 0, error: null },
    yahoo:  { ok: 0, fail: 0, articles: 0, error: null },
    google: { ok: 0, fail: 0, articles: 0, error: null },
    cryptopanic: CP_KEY
        ? { ok: 0, fail: 0, articles: 0, error: null }
        : { ok: 0, fail: 0, articles: 0, error: null, disabled: true, note: 'set CRYPTOPANIC_KEY to enable' },
}; };
resetHealth();

// Alpaca covers US equities and crypto. Non-US listings (.T/.L/.AX/.HK) are not tagged.
function alpacaSymbol(u) {
    if (u.kind === 'crypto') return u.symbol.replace('/', '');   // BTC/USD → BTCUSD
    if (/\.(T|L|AX|HK|SS|SZ)$/i.test(u.symbol)) return null;
    return u.symbol;
}

// ONE request per ~40 symbols instead of one per symbol. Returns Map<symbol, articles[]>.
async function fetchAlpacaBatch(symbols) {
    const out = new Map();
    if (!process.env.ALPACA_KEY_ID || !symbols.length) return out;
    const CHUNK = 40;
    for (let i = 0; i < symbols.length; i += CHUNK) {
        const chunk = symbols.slice(i, i + CHUNK);
        try {
            const r = await axios.get('https://data.alpaca.markets/v1beta1/news', {
                headers: ALPACA_HEADERS,
                params: { symbols: chunk.join(','), limit: 50 },
                timeout: 12000,
            });
            const news = r.data?.news || [];
            health.alpaca.ok++; health.alpaca.articles += news.length;
            for (const a of news) {
                const art = {
                    title: a.headline, description: a.summary || '',
                    url: a.url, source: a.source || 'Benzinga',
                    publishedAt: a.created_at || null, via: 'alpaca',
                };
                for (const s of (a.symbols || [])) {
                    if (!chunk.includes(s)) continue;            // ignore co-tagged extras
                    if (!out.has(s)) out.set(s, []);
                    out.get(s).push(art);
                }
            }
        } catch (e) {
            health.alpaca.fail++;
            health.alpaca.error = e.response?.status ? `HTTP ${e.response.status}` : e.message;
        }
        await sleep(120);
    }
    return out;
}

function parseRss(xml, fallbackSource, via, limit = 5) {
    return xml.split('<item>').slice(1, limit + 1).map(it => {
        const title = (it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
        const url   = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
        const date  = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || null;
        const src   = (it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || fallbackSource;
        const d = date ? new Date(date) : null;
        return {
            title: title.replace(/&amp;/g, '&').trim(), description: '',
            url: url.trim(), source: src,
            publishedAt: d && !isNaN(d) ? d.toISOString() : null,
            via,
        };
    }).filter(a => a.title && a.url);
}

// Handles international tickers directly — the reason Asia coverage works at all.
async function fetchYahooRss(symbol) {
    try {
        const r = await axios.get(
            `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
            { timeout: 9000, headers: UA });
        const arts = parseRss(r.data, 'Yahoo Finance', 'yahoo');
        health.yahoo.ok++; health.yahoo.articles += arts.length;
        return arts;
    } catch (e) {
        health.yahoo.fail++;
        health.yahoo.error = e.response?.status ? `HTTP ${e.response.status}` : e.message;
        return [];
    }
}

async function fetchGoogleRss(query) {
    try {
        const r = await axios.get(
            `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
            { timeout: 9000, headers: UA });
        const arts = parseRss(r.data, 'Google News', 'google');
        health.google.ok++; health.google.articles += arts.length;
        return arts;
    } catch (e) {
        health.google.fail++;
        health.google.error = e.response?.status ? `HTTP ${e.response.status}` : e.message;
        return [];
    }
}

// CryptoPanic — crypto-only, keyed. Ticker is the bare base symbol (BTC/USD → BTC).
// No-op when no key is set; the `disabled` flag in health keeps it off the failure list.
async function fetchCryptoPanic(baseSymbol) {
    if (!CP_KEY) return [];
    try {
        const r = await axios.get(CP_BASE, {
            params: { auth_token: CP_KEY, currencies: baseSymbol, public: 'true', kind: 'news' },
            timeout: 9000, headers: UA,
        });
        const arts = (r.data?.results || []).slice(0, 5).map(p => ({
            title: p.title, description: '',
            url: p.url || p.source?.url || '',
            source: p.source?.title || 'CryptoPanic',
            publishedAt: p.published_at || p.created_at || null,
            via: 'cryptopanic',
        })).filter(a => a.title && a.url);
        health.cryptopanic.ok++; health.cryptopanic.articles += arts.length;
        return arts;
    } catch (e) {
        health.cryptopanic.fail++;
        health.cryptopanic.error = e.response?.status ? `HTTP ${e.response.status}` : e.message;
        return [];
    }
}

// Same story often lands from two providers — collapse on the normalized headline.
function dedupe(articles) {
    const seen = new Set(), out = [];
    for (const a of articles) {
        const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(a);
    }
    return out;
}

// Back-compat shim for tests: single-symbol lookup via the RSS path.
async function fetchArticles(query) { return fetchGoogleRss(query); }

// Which symbols do we currently hold? Those headlines matter most.
function heldSet() {
    const held = new Set();
    for (const s of ['stocks', 'crypto', 'risky']) {
        try { for (const p of paperBroker.getPositions(s)) held.add(paperBroker.norm(p.symbol)); } catch {}
    }
    // Asia keeps its own ledger, not paperBroker's — and keys positions by symbol
    try {
        const asia = require('./asianPaperTrader').getState();
        for (const sym of Object.keys(asia.positions || {})) held.add(paperBroker.norm(sym));
    } catch {}
    return held;
}

async function refresh() {
    if (cache.refreshing) return cache;
    cache.refreshing = true;
    resetHealth();

    const uni = universe();
    const held = heldSet();
    const items = [];

    // 1. One batched sweep of Alpaca/Benzinga covers most US symbols up front.
    const batchable = uni.map(alpacaSymbol).filter(Boolean);
    const batched = await fetchAlpacaBatch(batchable);

    // 2. Fill the gaps per symbol: Yahoo (handles intl tickers), then Google by name.
    for (const u of uni) {
        const aSym = alpacaSymbol(u);
        let articles = (aSym && batched.get(aSym)) || [];

        if (articles.length < 2) {
            articles = articles.concat(await fetchYahooRss(u.symbol));
            await sleep(120);
        }
        if (articles.length === 0) {
            articles = await fetchGoogleRss(u.query);
            await sleep(120);
        }
        // Crypto gets an extra, crypto-native source when a key is set (no-op otherwise).
        if (u.kind === 'crypto' && CP_KEY) {
            const base = u.symbol.replace('/', '').replace(/USD.?$/, '');   // BTC/USD → BTC
            articles = articles.concat(await fetchCryptoPanic(base));
            await sleep(120);
        }

        articles = dedupe(articles);
        if (!articles.length) continue;

        const score = sentiment(articles);
        items.push({
            symbol: u.symbol,
            name: u.name || u.symbol,
            kind: u.kind,
            stream: u.stream,
            held: held.has(paperBroker.norm(u.symbol)),
            score,
            signal: score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral',
            sources: [...new Set(articles.map(a => a.via))],
            headlines: articles.slice(0, 4),
        });
    }

    // Held positions first, then strongest sentiment, then most headlines
    items.sort((a, b) =>
        (b.held - a.held) ||
        (Math.abs(b.score) - Math.abs(a.score)) ||
        (b.headlines.length - a.headlines.length));

    cache = { items, updatedAt: new Date().toISOString(), refreshing: false, health };
    save();
    const h = health;
    console.log(`[News] Refreshed ${items.length}/${uni.length} symbols (${items.filter(i => i.held).length} held) — ` +
        `alpaca ${h.alpaca.articles}a/${h.alpaca.fail}f · yahoo ${h.yahoo.articles}a/${h.yahoo.fail}f · google ${h.google.articles}a/${h.google.fail}f` +
        (CP_KEY ? ` · cryptopanic ${h.cryptopanic.articles}a/${h.cryptopanic.fail}f` : ` · cryptopanic off`));
    return cache;
}

function getNews() {
    const stale = !cache.updatedAt || (Date.now() - new Date(cache.updatedAt).getTime()) > REFRESH_MS * 2;
    const items = cache.items || [];
    const bySource = {};
    for (const i of items) for (const s of (i.sources || [])) bySource[s] = (bySource[s] || 0) + 1;

    return {
        items,
        updatedAt: cache.updatedAt,
        stale,
        health: cache.health || null,     // per-provider ok/fail — a dead source is visible
        bySource,                         // how many symbols each provider actually covered
        counts: {
            total: items.length,
            held: items.filter(i => i.held).length,
            bullish: items.filter(i => i.signal === 'bullish').length,
            bearish: items.filter(i => i.signal === 'bearish').length,
        },
    };
}

module.exports = { refresh, getNews, universe, REFRESH_MS,
                   _fetchArticles: fetchArticles, _sentiment: sentiment,
                   _fetchAlpacaBatch: fetchAlpacaBatch, _fetchYahooRss: fetchYahooRss,
                   _fetchCryptoPanic: fetchCryptoPanic, _alpacaSymbol: alpacaSymbol,
                   _dedupe: dedupe, _cpEnabled: () => !!CP_KEY };
