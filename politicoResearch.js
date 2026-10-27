// politicoResearch.js — Deep sector & macro research on political trades
// Researches the sector, competitors, macro context, and learns what patterns predict returns

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const DATA_DIR = require('./dataDir');

const LEARNING_FILE = path.join(DATA_DIR, 'politico-research-learning.json');
const NEWS_API_KEY = process.env.NEWS_API_KEY;

// ── SECTOR CLASSIFICATION ─────────────────────────────────────────────────────
// Map stocks to sectors for competitive analysis
const SECTOR_MAP = {
    // Tech
    'AAPL': 'tech', 'MSFT': 'tech', 'GOOGL': 'tech', 'AMZN': 'tech', 'META': 'tech',
    'NVDA': 'tech', 'AMD': 'tech', 'PLTR': 'tech', 'COIN': 'crypto', 'ADBE': 'tech',

    // Defense/Aerospace
    'LMT': 'defense', 'RTX': 'defense', 'BA': 'defense', 'GD': 'defense', 'NOC': 'defense',

    // Finance
    'LPLA': 'finance', 'HOOD': 'finance', 'UNH': 'healthcare', 'CVS': 'healthcare',

    // Home/Furniture
    'W': 'home', 'RH': 'home', 'LAZ': 'home', 'ETSY': 'ecommerce',

    // Transportation
    'TSLA': 'auto', 'UBER': 'transport', 'DASH': 'ecommerce', 'LYFT': 'transport',

    // Other
    'VZ': 'telecom', 'T': 'telecom', 'URI': 'industrials', 'CAG': 'consumer',
};

// ── COMPETITOR MAPPER ─────────────────────────────────────────────────────────
const COMPETITORS = {
    'W': ['RH', 'LAZ', 'ETSY', 'AMZN'], // Wayfair competitors
    'TSLA': ['F', 'GM', 'NIO'], // EV/Auto
    'DASH': ['UBER', 'LYFT', 'GRUB'], // Delivery/Transport
    'COIN': ['HOOD', 'MSTR', 'GBTC'], // Crypto
    'PLTR': ['ORCL', 'CRM', 'SNOW'], // Data/Analytics
};

// ── LEARNING STATE ────────────────────────────────────────────────────────────
function loadLearning() {
    try {
        return JSON.parse(fs.readFileSync(LEARNING_FILE, 'utf8'));
    } catch {
        const initial = {
            patterns: {},           // "macro_down+sector_up" → [+8%, -2%, +12%, ...]
            sectorTrends: {},       // "tech_bullish_2026-05" → confidence
            macroContext: {},       // "fed_cutting+housing_strong" → learned correlation
            stockResearch: {},      // "W_2026-05-01" → full research summary
            learnings: [],          // Chronological log of pattern discoveries
        };
        fs.writeFileSync(LEARNING_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
}

function saveLearning(learning) {
    fs.writeFileSync(LEARNING_FILE, JSON.stringify(learning, null, 2));
}

// ── RESEARCH ENGINE ──────────────────────────────────────────────────────────
// Deep research on a single political trade
async function researchTrade(ticker, buyDate, politician, amount) {
    const learning = loadLearning();
    const researchKey = `${ticker}_${buyDate}`;

    // If already researched, return cached
    if (learning.stockResearch[researchKey]) {
        return learning.stockResearch[researchKey];
    }

    console.log(`[Research] Investigating ${ticker} (bought by ${politician} on ${buyDate}, $${amount})`);

    const research = {
        ticker,
        buyDate,
        politician,
        amount,
        sector: SECTOR_MAP[ticker] || 'unknown',
        competitors: COMPETITORS[ticker] || [],
        researchedAt: new Date().toISOString(),
        findings: {
            sectorTrend: null,
            macroContext: null,
            news: [],
            competitorStatus: null,
        },
        learnings: [],
    };

    try {
        // 1. Get sector trend
        research.findings.sectorTrend = await getSectorTrend(research.sector, buyDate);

        // 2. Get macro context (Fed rates, housing, employment, trade)
        research.findings.macroContext = await getMacroContext(buyDate);

        // 3. Research news around the buy date
        research.findings.news = await getNewsAroundDate(ticker, buyDate);

        // 4. Check competitor performance
        research.findings.competitorStatus = await getCompetitorStatus(research.competitors);

        // 5. Learn from this research
        const pattern = generatePattern(research.findings);
        recordLearning(learning, pattern, research);

        // Cache it
        learning.stockResearch[researchKey] = research;
        saveLearning(learning);

        console.log(`[Research] ${ticker}: Sector ${research.findings.sectorTrend?.sentiment || 'unknown'} | Macro: ${research.findings.macroContext?.summary || 'unknown'}`);

    } catch (e) {
        console.error(`[Research] Error researching ${ticker}:`, e.message);
    }

    return research;
}

// ── SECTOR ANALYSIS ───────────────────────────────────────────────────────────
async function getSectorTrend(sector, asOfDate) {
    // Simplified: would fetch sector ETF performance, competitor stocks, etc.
    // For now, return placeholder structure
    return {
        sector,
        sentiment: 'neutral', // Would be 'bullish', 'bearish', 'neutral'
        reasoning: 'Sector data would be fetched from sector ETFs and competitor stocks',
        performanceVsSP500: 0, // % outperformance
    };
}

// ── MACRO CONTEXT ─────────────────────────────────────────────────────────────
async function getMacroContext(asOfDate) {
    // Simplified: would fetch Fed rates, housing starts, unemployment, trade news
    return {
        summary: 'Macro analysis would include Fed policy, rates, housing, employment, trade tensions',
        fedRate: null,
        housingStarts: null,
        unemployment: null,
        tradeTensions: null,
        asOfDate,
    };
}

// ── NEWS AGGREGATION ──────────────────────────────────────────────────────────
async function getNewsAroundDate(ticker, buyDate, daysWindow = 14) {
    if (!NEWS_API_KEY) {
        console.log(`[News] NewsAPI key not set — skipping news fetch for ${ticker}`);
        return [];
    }

    try {
        const startDate = new Date(buyDate);
        startDate.setDate(startDate.getDate() - daysWindow);

        const endDate = new Date(buyDate);
        endDate.setDate(endDate.getDate() + daysWindow);

        const res = await axios.get('https://newsapi.org/v2/everything', {
            params: {
                q: `${ticker} earnings OR acquisition OR FDA OR product OR earnings`,
                from: startDate.toISOString().split('T')[0],
                to: endDate.toISOString().split('T')[0],
                sortBy: 'relevancy',
                language: 'en',
                apiKey: NEWS_API_KEY,
            },
            timeout: 8000,
        });

        return (res.data.articles || []).slice(0, 5).map(a => ({
            title: a.title,
            source: a.source.name,
            publishedAt: a.publishedAt,
            description: a.description,
        }));
    } catch (e) {
        console.log(`[News] Error fetching news for ${ticker}:`, e.message);
        return [];
    }
}

// ── COMPETITOR STATUS ─────────────────────────────────────────────────────────
async function getCompetitorStatus(competitors) {
    // Simplified: would fetch competitor stock performance, revenue, margins, etc.
    return {
        competitors,
        summary: 'Competitor analysis would show relative strength, growth rates, margin trends',
    };
}

// ── PATTERN GENERATION ────────────────────────────────────────────────────────
function generatePattern(findings) {
    const parts = [];

    if (findings.sectorTrend?.sentiment) parts.push(`sector_${findings.sectorTrend.sentiment}`);
    if (findings.macroContext?.fedRate) parts.push(`rates_${findings.macroContext.fedRate}`);
    if (findings.news?.length > 0) parts.push(`news_${findings.news.length}_items`);

    return parts.join('+') || 'unknown_pattern';
}

// ── LEARNING RECORDER ─────────────────────────────────────────────────────────
function recordLearning(learning, pattern, research) {
    // Track this pattern
    if (!learning.patterns[pattern]) {
        learning.patterns[pattern] = [];
    }

    // Record the research finding
    const entry = {
        timestamp: new Date().toISOString(),
        ticker: research.ticker,
        pattern,
        findings: research.findings,
    };

    learning.patterns[pattern].push(entry);
    learning.learnings.push(entry);

    // Keep only last 100 learnings to avoid bloat
    if (learning.learnings.length > 100) {
        learning.learnings = learning.learnings.slice(-100);
    }

    console.log(`[Learning] Pattern recorded: ${pattern}`);
}

// ── PATTERN STRENGTH ──────────────────────────────────────────────────────────
function getPatternStrength(pattern) {
    const learning = loadLearning();
    const entries = learning.patterns[pattern] || [];

    return {
        pattern,
        occurrences: entries.length,
        confidence: Math.min(100, entries.length * 10), // More occurrences = higher confidence
        lastSeen: entries[entries.length - 1]?.timestamp || null,
    };
}

// ── SIMILARITY FINDER ─────────────────────────────────────────────────────────
// Given a new trade, find similar historical patterns
function findSimilarPatterns(newTrade) {
    const learning = loadLearning();
    const similar = [];

    Object.entries(learning.patterns).forEach(([pattern, entries]) => {
        if (entries.length > 0) {
            similar.push({
                pattern,
                occurrences: entries.length,
                avgConfidence: Math.min(100, entries.length * 10),
                examples: entries.slice(-3).map(e => ({ ticker: e.ticker, date: e.timestamp })),
            });
        }
    });

    return similar.sort((a, b) => b.occurrences - a.occurrences).slice(0, 5);
}

module.exports = {
    researchTrade,
    getSectorTrend,
    getMacroContext,
    getNewsAroundDate,
    getCompetitorStatus,
    getPatternStrength,
    findSimilarPatterns,
    loadLearning,
};
