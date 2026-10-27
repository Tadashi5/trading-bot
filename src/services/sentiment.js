// sentiment.js — News sentiment scoring powered by ingestion layer
// Uses the real data ingestion service as primary source
const path = require('path');
let ingestion;
try { ingestion = require(path.join(__dirname, '..', '..', 'services', 'ingestion')); } catch {}

const BULLISH = ['beat','surge','upgrade','record','buy','rally','bullish','gain','soar','breakthrough','growth','strong','profit','rise','outperform'];
const BEARISH = ['crash','miss','downgrade','fraud','lawsuit','sell','bearish','drop','plunge','weak','recession','warning','loss','fall','underperform'];

function scoreText(text) {
    if (!text) return 0;
    const lower = text.toLowerCase();
    let s = 0;
    BULLISH.forEach(w => { if (lower.includes(w)) s += 1; });
    BEARISH.forEach(w => { if (lower.includes(w)) s -= 1; });
    return s;
}

function score(articles) {
    if (!articles || !articles.length) return 0;

    // Filter out articles older than 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = articles.filter(a => {
        const ts = a.publishedAt || a.pubDate || a.published_at || a.date || null;
        if (!ts) return true; // no date info — include by default
        return new Date(ts).getTime() >= cutoff;
    });
    if (!recent.length) return 0;

    let total = 0;
    for (let i = 0; i < recent.length; i++) {
        const a = recent[i];
        const text = `${a.headline || a.title || ''} ${a.summary || a.description || ''}`;
        let articleScore = scoreText(text);

        // Recency weight: newer articles matter more
        const recencyWeight = 1 / (1 + i * 0.3);
        total += articleScore * recencyWeight;
    }

    // Normalize to -1 to +1
    const maxPossible = recent.length * 3;
    const normalized = maxPossible > 0 ? total / maxPossible : 0;
    return parseFloat(Math.max(-1, Math.min(1, normalized)).toFixed(3));
}

async function fetchAndScore(symbol) {
    // Primary: use ingestion layer
    if (ingestion) {
        try {
            const { articles } = await ingestion.ingestAll();
            const structured = ingestion.getStructuredEvents(articles);
            const symbolEvents = structured[symbol];
            if (symbolEvents && symbolEvents.events.length > 0) {
                return { score: score(symbolEvents.events), articleCount: symbolEvents.events.length, source: 'ingestion' };
            }
            // Fallback: score all articles mentioning the symbol via text search
            const relevant = articles.filter(a =>
                a.headline.toUpperCase().includes(symbol) ||
                a.summary.toUpperCase().includes(symbol)
            );
            if (relevant.length > 0) {
                return { score: score(relevant), articleCount: relevant.length, source: 'ingestion-text' };
            }
        } catch {}
    }

    // Fallback: direct Google News RSS fetch
    const axios = require('axios');
    let articles = [];
    try {
        const res = await axios.get(
            `https://news.google.com/rss/search?q=${encodeURIComponent(symbol)}&hl=en-US&gl=US&ceid=US:en`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const titles = (res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || []).slice(0, 5);
        articles = titles.map(t => ({ headline: t.replace(/<title><!\[CDATA\[|\]\]><\/title>/g, ''), summary: '' }));
    } catch {}

    return { score: score(articles), articleCount: articles.length, source: 'rss-fallback' };
}

module.exports = { score, fetchAndScore, scoreText };
