// stream.js — Continuous market data stream via Alpaca
// Provides async iterable ticks for the ML pipeline
const axios = require('axios');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const DATA_BASE = 'https://data.alpaca.markets/v2';

const SYMBOLS = [
    'TSLA','NVDA','AMD','MSTR','COIN','SPY','AAPL','META','AMZN',
    'GOOGL','MSFT','NFLX','PLTR','GME','AMC','SOFI','RIVN','ARM',
    'SMCI','BABA','UBER','SNAP','RBLX','HOOD','IONQ',
];

// Previous closes for momentum calc
let prevCloses = {};
let avgVolumes = {};

async function initHistory() {
    try {
        const res = await axios.get(`${DATA_BASE}/stocks/bars`, {
            headers: HEADERS,
            params: { symbols: SYMBOLS.join(','), timeframe: '1Day', limit: 21, feed: 'iex' },
        });
        for (const [sym, bars] of Object.entries(res.data.bars || {})) {
            if (bars.length >= 2) {
                prevCloses[sym] = bars[bars.length - 2].c;
                avgVolumes[sym] = bars.slice(0, -1).reduce((s, b) => s + b.v, 0) / (bars.length - 1);
            }
        }
        console.log(`[Stream] Initialized history for ${Object.keys(prevCloses).length} symbols`);
    } catch (err) {
        console.error('[Stream] History init failed:', err.message);
    }
}

async function fetchTick() {
    try {
        const res = await axios.get(`${DATA_BASE}/stocks/snapshots`, {
            headers: HEADERS,
            params: { symbols: SYMBOLS.join(','), feed: 'iex' },
        });
        const ticks = [];
        for (const [sym, snap] of Object.entries(res.data || {})) {
            const price  = snap?.latestTrade?.p || snap?.dailyBar?.c;
            const volume = snap?.dailyBar?.v || 0;
            const high   = snap?.dailyBar?.h || price;
            const low    = snap?.dailyBar?.l || price;
            if (!price) continue;

            ticks.push({
                symbol: sym,
                price,
                volume,
                high,
                low,
                prevClose: prevCloses[sym] || price,
                avgVolume: avgVolumes[sym] || volume || 1,
                timestamp: Date.now(),
            });
        }
        return ticks;
    } catch (err) {
        console.error('[Stream] Tick fetch error:', err.message);
        return [];
    }
}

// Async generator — yields batches of ticks at interval
async function* stream(intervalMs = 60000) {
    await initHistory();
    while (true) {
        const ticks = await fetchTick();
        if (ticks.length) yield ticks;
        await new Promise(r => setTimeout(r, intervalMs));
    }
}

module.exports = { stream, fetchTick, initHistory, SYMBOLS };
