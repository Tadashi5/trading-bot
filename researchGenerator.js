// researchGenerator.js — Automatic pre-market research report generator
// Runs on schedule (default: 8am), pulls news via ingestion, generates signals,
// POSTs structured report to /reports to bias all trading decisions.
require('dotenv').config();
const axios = require('axios');
const ingestion = require('./services/ingestion');

const BASE_URL = process.env.BOT_URL || 'http://localhost:3000';
const PIN = process.env.DASHBOARD_PIN || '1234';

// Sentiment keywords (bullish/bearish indicators in news)
const BULLISH_SIGNALS = [
    'beat', 'upgrade', 'bull', 'surge', 'rally', 'growth', 'strong', 'profit',
    'earnings surprise', 'guidance raised', 'acquisition', 'partnership', 'innovation',
];
const BEARISH_SIGNALS = [
    'miss', 'downgrade', 'bear', 'plunge', 'crash', 'decline', 'weak', 'loss',
    'guidance cut', 'bankruptcy', 'lawsuit', 'recall', 'scandal',
];

// Key watchlist tickers from the bot's scanners
const BOT_WATCHLIST = [
    'TSLA', 'NVDA', 'AMD', 'MSTR', 'COIN', 'SPY', 'AAPL', 'META', 'AMZN', 'GOOGL',
    'MSFT', 'NFLX', 'PLTR', 'GME', 'AMC', 'SOFI', 'RIVN', 'ARM', 'SMCI', 'BABA',
    'UBER', 'SNAP', 'RBLX', 'HOOD', 'IONQ',
];

function scoreHeadline(headline, summary) {
    const text = `${headline} ${summary}`.toLowerCase();
    let score = 0;
    for (const word of BULLISH_SIGNALS) {
        if (text.includes(word)) score += 1;
    }
    for (const word of BEARISH_SIGNALS) {
        if (text.includes(word)) score -= 1;
    }
    return score;
}

function determineSentiment(totalScore, articleCount) {
    if (articleCount === 0) return 'neutral';
    const avgScore = totalScore / articleCount;
    if (avgScore > 0.5) return 'bullish';
    if (avgScore < -0.5) return 'bearish';
    return 'neutral';
}

async function generateReport() {
    try {
        console.log(`[ResearchGen] Generating pre-market research report...`);

        // Fetch news from ingestion
        const { articles } = await ingestion.ingestAll();
        if (!articles || articles.length === 0) {
            console.log(`[ResearchGen] No articles fetched; skipping report`);
            return null;
        }

        // Analyze sentiment across all news
        let bullishCount = 0, bearishCount = 0, neutralCount = 0;
        let watchlistMentions = {};
        let totalScore = 0;

        for (const article of articles) {
            const score = scoreHeadline(article.headline, article.summary);
            totalScore += score;

            if (score > 0) bullishCount++;
            else if (score < 0) bearishCount++;
            else neutralCount++;

            // Track which watchlist tickers appear
            for (const ticker of BOT_WATCHLIST) {
                if (`${article.headline} ${article.summary}`.toUpperCase().includes(ticker)) {
                    watchlistMentions[ticker] = (watchlistMentions[ticker] || 0) + 1;
                }
            }
        }

        // Determine overall sentiment
        const sentiment = determineSentiment(totalScore, articles.length);

        // Pick top tickers by mention frequency as "watchlist" (favor these)
        const topWatchlist = Object.entries(watchlistMentions)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([ticker]) => ticker);

        // Identify any tickers with consistently negative signals as "avoid"
        const avoidTickers = articles
            .filter(a => scoreHeadline(a.headline, a.summary) < -1)
            .flatMap(a => a.symbols || [])
            .filter(t => BOT_WATCHLIST.includes(t))
            .slice(0, 5);

        // Crypto sentiment (BTC/ETH/SOL mentions)
        const cryptoArticles = articles.filter(a =>
            `${a.headline} ${a.summary}`.toUpperCase().includes('BTC') ||
            `${a.headline} ${a.summary}`.toUpperCase().includes('ETH') ||
            `${a.headline} ${a.summary}`.toUpperCase().includes('CRYPTO')
        );
        const cryptoScore = cryptoArticles.reduce((s, a) => s + scoreHeadline(a.headline, a.summary), 0);
        const cryptoView = cryptoScore > 0 ? 'bullish' : cryptoScore < 0 ? 'bearish' : 'neutral';

        // VIX/volatility signals
        const vixArticles = articles.filter(a =>
            `${a.headline} ${a.summary}`.toUpperCase().includes('VIX') ||
            `${a.headline} ${a.summary}`.toUpperCase().includes('VOLATILITY') ||
            `${a.headline} ${a.summary}`.toUpperCase().includes('CRASH') ||
            `${a.headline} ${a.summary}`.toUpperCase().includes('SELL-OFF')
        );
        let vixView = 'normal';
        if (vixArticles.some(a => scoreHeadline(a.headline, a.summary) < -1)) vixView = 'elevated';
        if (vixArticles.some(a => scoreHeadline(a.headline, a.summary) < -2)) vixView = 'high';
        if (sentiment === 'bullish' && vixView === 'normal') vixView = 'low';

        // Build markdown report
        const summary = `${sentiment.toUpperCase()} · ${articles.length} articles | ${bullishCount}B ${bearishCount}R ${neutralCount}N`;
        const markdown = `# Pre-Market Research Report

**Generated:** ${new Date().toISOString()}

## Market Sentiment
**Overall:** ${sentiment.toUpperCase()}
- Bullish signals: ${bullishCount}
- Bearish signals: ${bearishCount}
- Neutral: ${neutralCount}

## Crypto View
**${cryptoView.toUpperCase()}** — ${cryptoArticles.length} crypto-related articles

## Volatility (VIX View)
**${vixView.toUpperCase()}**

## Watchlist (favor these)
${topWatchlist.length ? topWatchlist.map(t => `- ${t}`).join('\n') : 'None highlighted'}

## Avoid (reduce exposure)
${avoidTickers.length ? avoidTickers.map(t => `- ${t}`).join('\n') : 'None identified'}

## Article Summary
${articles.slice(0, 10).map(a => `- **${a.headline}** (${a.source})`).join('\n')}

---
*Automatically generated from ${articles.length} news sources (Finnhub, NewsAPI, RSS, web)*
`;

        // POST to /reports locally
        const reportBody = {
            type: 'pre-market',
            market: 'usa',
            markdown,
            signals: {
                sentiment,
                cryptoView,
                vixView,
                watchlist: topWatchlist,
                avoid: avoidTickers,
                summary,
            },
        };

        const res = await axios.post(`${BASE_URL}/reports?pin=${PIN}`, reportBody, { timeout: 10000 });
        console.log(`[ResearchGen] ✓ Posted report: ${summary}`);
        return reportBody;
    } catch (err) {
        console.error(`[ResearchGen] Error generating report:`, err.message);
        return null;
    }
}

// Export for manual calling or testing
module.exports = { generateReport };

// If run directly (not imported), generate report immediately
if (require.main === module) {
    generateReport().then(report => {
        if (report) console.log(`[ResearchGen] Report generated and posted`);
        process.exit(0);
    });
}
