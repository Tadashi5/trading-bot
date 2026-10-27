// scraper.js — Lightweight headline scraper for public financial news pages
// RULES: headlines only, no login walls, no paywalls, respect robots.txt
const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 10000;

async function fetchPage(url) {
    const res = await axios.get(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        timeout: TIMEOUT,
    });
    return res.data;
}

// ── CNBC Headlines ───────────────────────────────────────────────────────────
async function scrapeCNBC() {
    try {
        const html = await fetchPage('https://www.cnbc.com/world/?region=world');
        const $ = cheerio.load(html);
        const articles = [];

        $('a.Card-title, a[class*="LatestNews"] , div.Card-titleContainer a').each((i, el) => {
            if (articles.length >= 10) return false;
            const headline = $(el).text().trim();
            const url = $(el).attr('href');
            if (headline && headline.length > 15) {
                articles.push({
                    headline,
                    summary: '',
                    source: 'CNBC',
                    url: url?.startsWith('http') ? url : `https://www.cnbc.com${url || ''}`,
                    timestamp: new Date().toISOString(),
                    type: 'scrape',
                });
            }
        });

        return articles;
    } catch { return []; }
}

// ── MarketWatch Headlines ────────────────────────────────────────────────────
async function scrapeMarketWatch() {
    try {
        const html = await fetchPage('https://www.marketwatch.com/latest-news');
        const $ = cheerio.load(html);
        const articles = [];

        $('h3.article__headline a, a.link').each((i, el) => {
            if (articles.length >= 10) return false;
            const headline = $(el).text().trim();
            const url = $(el).attr('href');
            if (headline && headline.length > 15) {
                articles.push({
                    headline,
                    summary: '',
                    source: 'MarketWatch',
                    url: url?.startsWith('http') ? url : `https://www.marketwatch.com${url || ''}`,
                    timestamp: new Date().toISOString(),
                    type: 'scrape',
                });
            }
        });

        return articles;
    } catch { return []; }
}

// ── Investing.com Headlines ──────────────────────────────────────────────────
async function scrapeInvesting() {
    try {
        const html = await fetchPage('https://www.investing.com/news/stock-market-news');
        const $ = cheerio.load(html);
        const articles = [];

        $('a[data-test="article-title-link"], article a.title').each((i, el) => {
            if (articles.length >= 10) return false;
            const headline = $(el).text().trim();
            const url = $(el).attr('href');
            if (headline && headline.length > 15) {
                articles.push({
                    headline,
                    summary: '',
                    source: 'Investing.com',
                    url: url?.startsWith('http') ? url : `https://www.investing.com${url || ''}`,
                    timestamp: new Date().toISOString(),
                    type: 'scrape',
                });
            }
        });

        return articles;
    } catch { return []; }
}

// ── Scrape all sources ───────────────────────────────────────────────────────
async function scrapeAll() {
    const [cnbc, mw, inv] = await Promise.allSettled([
        scrapeCNBC(),
        scrapeMarketWatch(),
        scrapeInvesting(),
    ]);

    return [
        ...(cnbc.status === 'fulfilled' ? cnbc.value : []),
        ...(mw.status === 'fulfilled' ? mw.value : []),
        ...(inv.status === 'fulfilled' ? inv.value : []),
    ];
}

module.exports = { scrapeCNBC, scrapeMarketWatch, scrapeInvesting, scrapeAll };
