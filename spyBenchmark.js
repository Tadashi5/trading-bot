// spyBenchmark.js — S&P 500 benchmark comparison
// Tracks SPY prices and calculates what a buy-and-hold strategy would return
// This lets you benchmark bot performance against passive index holding

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const DATA_DIR = require('./dataDir');

const CACHE_PATH = path.join(DATA_DIR, 'spy-cache.json');
const CACHE_DURATION = 24 * 3600 * 1000; // 24 hours

// Start date: May 5, 2026 (when performance tracking began)
const START_DATE = new Date(2026, 4, 5); // JS months are 0-indexed
const START_TIMESTAMP = START_DATE.getTime();

// Hardcoded historical SPY data (daily closes) for benchmarking
// Data from May 5, 2026 onwards. Format: { date: YYYY-MM-DD, close: price }
// This is a minimal set; in production you'd fetch from yfinance or similar
const HISTORICAL_SPY = [
    { date: '2026-05-05', close: 723.77 },
    { date: '2026-05-06', close: 733.83 },
    { date: '2026-05-07', close: 731.58 },
    { date: '2026-05-08', close: 737.62 },
    { date: '2026-05-11', close: 739.30 },
    { date: '2026-05-12', close: 738.18 },
    { date: '2026-05-13', close: 742.31 },
    { date: '2026-05-14', close: 748.17 },
    { date: '2026-05-15', close: 739.17 },
    { date: '2026-05-18', close: 738.65 },
    { date: '2026-05-19', close: 733.73 },
    { date: '2026-05-20', close: 741.25 },
    { date: '2026-05-21', close: 742.72 },
    { date: '2026-05-22', close: 745.64 },
    { date: '2026-05-26', close: 750.59 },
    { date: '2026-05-27', close: 750.46 },
    { date: '2026-05-28', close: 754.60 },
    { date: '2026-05-29', close: 756.03 },
];

let priceCache = {};

function loadCache() {
    try {
        const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        if (Date.now() - cached.timestamp < CACHE_DURATION) {
            priceCache = cached.prices || {};
            return cached.prices || {};
        }
    } catch (e) {
        // Cache doesn't exist or is stale
    }
    return {};
}

function saveCache() {
    try {
        fs.writeFileSync(CACHE_PATH, JSON.stringify({
            timestamp: Date.now(),
            prices: priceCache
        }));
    } catch (e) {
        console.error('[SPY] Cache save error:', e.message);
    }
}

// Populate initial cache from hardcoded data (force refresh with latest hardcoded data)
function initializeCache() {
    // Always reload from hardcoded data to ensure latest prices are available
    priceCache = {};
    HISTORICAL_SPY.forEach(entry => {
        priceCache[entry.date] = entry.close;
    });

    saveCache();
}

// Get SPY price for a given date (YYYY-MM-DD format)
// If we don't have it, return the most recent available price
function getPriceForDate(dateStr) {
    if (priceCache[dateStr]) return priceCache[dateStr];

    // Find the closest available date (prefer earlier if no exact match)
    const sortedDates = Object.keys(priceCache).sort();
    for (let i = sortedDates.length - 1; i >= 0; i--) {
        if (sortedDates[i] <= dateStr) {
            return priceCache[sortedDates[i]];
        }
    }

    // Fallback to first date if earlier
    return priceCache[sortedDates[0]] || 528.29;
}

// Get SPY price for a timestamp (milliseconds)
function getPriceForTimestamp(timestamp) {
    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split('T')[0];
    return getPriceForDate(dateStr);
}

// Calculate SPY equity assuming $X was invested on START_DATE
// If portfolioValue is provided, scales SPY to match initial portfolio value
function getSPYEquity(timestamp, initialInvestment = 1) {
    const spyNow = getPriceForTimestamp(timestamp);
    const spyStart = getPriceForDate('2026-05-05'); // First SPY price
    const returnMultiplier = spyNow / spyStart;
    return initialInvestment * returnMultiplier;
}

// Get S&P 500 return percentage
function getSPYReturnPct(timestamp) {
    const equity = getSPYEquity(timestamp, 100); // 100 for easy % calculation
    return equity - 100; // Return as percentage points
}

// Fetch real-time SPY price from yfinance API
async function fetchCurrentPrice() {
    try {
        const response = await axios.get('https://query1.finance.yahoo.com/v10/finance/quoteSummary/SPY', {
            params: {
                modules: 'price'
            },
            timeout: 5000
        });

        const price = response.data?.quoteSummary?.result?.[0]?.price?.regularMarketPrice;
        if (price) {
            // Cache today's price
            const today = new Date().toISOString().split('T')[0];
            priceCache[today] = price;
            saveCache();
            return price;
        }

        // Fallback to cached last price
        const dates = Object.keys(priceCache).sort();
        return dates.length > 0 ? priceCache[dates[dates.length - 1]] : 543.05;
    } catch (e) {
        console.error('[SPY] Fetch error:', e.message);
        // Return last known price on error
        const dates = Object.keys(priceCache).sort();
        return dates.length > 0 ? priceCache[dates[dates.length - 1]] : 543.05;
    }
}

// Update cache with latest SPY price from API or fallback
async function updateLatestPrice() {
    try {
        const response = await axios.get('https://query1.finance.yahoo.com/v10/finance/quoteSummary/SPY', {
            params: { modules: 'price' },
            timeout: 5000
        });
        const price = response.data?.quoteSummary?.result?.[0]?.price?.regularMarketPrice;
        if (price) {
            const today = new Date().toISOString().split('T')[0];
            priceCache[today] = price;
            saveCache();
            console.log(`[SPY] Updated ${today}: $${price}`);
            return price;
        }
    } catch (e) {
        console.error('[SPY] Update error:', e.message);
    }
    return null;
}

module.exports = {
    initializeCache,
    getPriceForDate,
    getPriceForTimestamp,
    getSPYEquity,
    getSPYReturnPct,
    fetchCurrentPrice,
    updateLatestPrice,
    START_DATE,
    START_TIMESTAMP,
};
