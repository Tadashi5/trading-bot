// binance.js — Binance API integration for altcoins, meme coins, DeFi tokens
// Covers: ALL crypto including small caps, meme coins, DeFi, new listings
// Docs: https://binance-docs.github.io/apidocs/spot/en/
const axios = require('axios');
const crypto = require('crypto');

const BASE = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || '';

function sign(queryString) {
    return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

function signedParams(params = {}) {
    params.timestamp = Date.now();
    const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
    params.signature = sign(qs);
    return params;
}

const headers = () => ({ 'X-MBX-APIKEY': API_KEY });

// ── Public endpoints (no auth needed) ────────────────────────────────────────

async function getPrice(symbol) {
    try {
        const res = await axios.get(`${BASE}/api/v3/ticker/price`, {
            params: { symbol }, timeout: 8000,
        });
        return parseFloat(res.data.price);
    } catch { return null; }
}

async function get24hTicker(symbol) {
    try {
        const res = await axios.get(`${BASE}/api/v3/ticker/24hr`, {
            params: { symbol }, timeout: 8000,
        });
        return {
            symbol: res.data.symbol,
            price: parseFloat(res.data.lastPrice),
            change: parseFloat(res.data.priceChangePercent),
            high: parseFloat(res.data.highPrice),
            low: parseFloat(res.data.lowPrice),
            volume: parseFloat(res.data.volume),
            quoteVolume: parseFloat(res.data.quoteVolume),
            trades: parseInt(res.data.count),
        };
    } catch { return null; }
}

async function getBatchTickers(symbols) {
    try {
        // Get all tickers at once — fast
        const res = await axios.get(`${BASE}/api/v3/ticker/24hr`, { timeout: 12000 });
        const map = {};
        const symbolSet = new Set(symbols);
        for (const t of res.data) {
            if (symbolSet.has(t.symbol)) {
                map[t.symbol] = {
                    symbol: t.symbol,
                    price: parseFloat(t.lastPrice),
                    change: parseFloat(t.priceChangePercent),
                    high: parseFloat(t.highPrice),
                    low: parseFloat(t.lowPrice),
                    volume: parseFloat(t.volume),
                    quoteVolume: parseFloat(t.quoteVolume),
                    trades: parseInt(t.count),
                };
            }
        }
        return map;
    } catch { return {}; }
}

async function getKlines(symbol, interval = '1h', limit = 24) {
    try {
        const res = await axios.get(`${BASE}/api/v3/klines`, {
            params: { symbol, interval, limit }, timeout: 8000,
        });
        return res.data.map(k => ({
            openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
            closeTime: k[6], quoteVolume: parseFloat(k[7]), trades: k[8],
        }));
    } catch { return []; }
}

async function getOrderBook(symbol, limit = 10) {
    try {
        const res = await axios.get(`${BASE}/api/v3/depth`, {
            params: { symbol, limit }, timeout: 8000,
        });
        return {
            bids: res.data.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
            asks: res.data.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
        };
    } catch { return { bids: [], asks: [] }; }
}

// ── Account endpoints (auth required) ────────────────────────────────────────

async function getAccount() {
    if (!API_KEY || !API_SECRET) return null;
    try {
        const params = signedParams();
        const res = await axios.get(`${BASE}/api/v3/account`, {
            params, headers: headers(), timeout: 10000,
        });
        const balances = res.data.balances
            .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
            .map(b => ({
                asset: b.asset,
                free: parseFloat(b.free),
                locked: parseFloat(b.locked),
                total: parseFloat(b.free) + parseFloat(b.locked),
            }));
        return { balances, canTrade: res.data.canTrade };
    } catch (err) {
        return { error: err.response?.data?.msg || err.message };
    }
}

async function placeOrder(symbol, side, quantity, type = 'MARKET', price = null) {
    if (!API_KEY || !API_SECRET) return { success: false, error: 'Binance API keys not set' };
    try {
        const params = { symbol, side: side.toUpperCase(), type };
        if (type === 'MARKET') {
            if (side.toUpperCase() === 'BUY') {
                params.quoteOrderQty = quantity; // buy with USDT amount
            } else {
                params.quantity = quantity;
            }
        } else if (type === 'LIMIT') {
            params.quantity = quantity;
            params.price = price;
            params.timeInForce = 'GTC';
        }
        const signed = signedParams(params);
        const res = await axios.post(`${BASE}/api/v3/order`, null, {
            params: signed, headers: headers(), timeout: 10000,
        });
        return {
            success: true,
            orderId: res.data.orderId,
            symbol: res.data.symbol,
            side: res.data.side,
            type: res.data.type,
            status: res.data.status,
            executedQty: res.data.executedQty,
            price: res.data.price,
        };
    } catch (err) {
        return { success: false, error: err.response?.data?.msg || err.message };
    }
}

async function cancelOrder(symbol, orderId) {
    if (!API_KEY || !API_SECRET) return { success: false, error: 'Binance API keys not set' };
    try {
        const signed = signedParams({ symbol, orderId });
        await axios.delete(`${BASE}/api/v3/order`, {
            params: signed, headers: headers(), timeout: 10000,
        });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.response?.data?.msg || err.message };
    }
}

async function getOpenOrders(symbol = null) {
    if (!API_KEY || !API_SECRET) return [];
    try {
        const params = symbol ? { symbol } : {};
        const signed = signedParams(params);
        const res = await axios.get(`${BASE}/api/v3/openOrders`, {
            params: signed, headers: headers(), timeout: 10000,
        });
        return res.data.map(o => ({
            orderId: o.orderId, symbol: o.symbol, side: o.side,
            type: o.type, price: o.price, qty: o.origQty,
            filled: o.executedQty, status: o.status,
        }));
    } catch { return []; }
}

async function getRecentTrades(symbol, limit = 10) {
    if (!API_KEY || !API_SECRET) return [];
    try {
        const signed = signedParams({ symbol, limit });
        const res = await axios.get(`${BASE}/api/v3/myTrades`, {
            params: signed, headers: headers(), timeout: 10000,
        });
        return res.data.map(t => ({
            symbol: t.symbol, side: t.isBuyer ? 'BUY' : 'SELL',
            price: parseFloat(t.price), qty: parseFloat(t.qty),
            commission: parseFloat(t.commission), commissionAsset: t.commissionAsset,
            time: new Date(t.time).toISOString(),
        }));
    } catch { return []; }
}

// ── Watchlist: popular meme/alt/defi coins ───────────────────────────────────
const MEME_COINS = [
    'DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'FLOKIUSDT', 'BONKUSDT',
    'WIFUSDT', 'BOMEUSDT', 'MEMEUSDT', 'NEIROUSDT', 'TURBO USDT',
];

const ALT_COINS = [
    'ADAUSDT', 'DOTUSDT', 'LINKUSDT', 'AVAXUSDT', 'MATICUSDT',
    'NEARUSDT', 'ATOMUSDT', 'APTUSDT', 'SUIUSDT', 'SEIUSDT',
    'INJUSDT', 'TIAUSDT', 'FETUSDT', 'RENDERUSDT', 'ARUSDT',
];

const DEFI_COINS = [
    'UNIUSDT', 'AAVEUSDT', 'MKRUSDT', 'COMPUSDT', 'SNXUSDT',
    'CRVUSDT', 'LDOUSDT', 'PENDLEUSDT', 'JUPUSDT', 'RAYUSDT',
    'GMXUSDT', 'DYDXUSDT', 'ENSUSDT', '1INCHUSDT', 'SUSHIUSDT',
];

async function scanWatchlist() {
    const allSymbols = [...MEME_COINS, ...ALT_COINS, ...DEFI_COINS].filter(s => !s.includes(' '));
    const tickers = await getBatchTickers(allSymbols);

    const categorize = (list, category) => list.filter(s => !s.includes(' ')).map(s => {
        const t = tickers[s];
        if (!t) return null;
        return { ...t, category, displaySymbol: s.replace('USDT', '') };
    }).filter(Boolean);

    return {
        meme: categorize(MEME_COINS, 'meme'),
        alt: categorize(ALT_COINS, 'alt'),
        defi: categorize(DEFI_COINS, 'defi'),
        scannedAt: new Date().toISOString(),
    };
}

// ── Top movers ───────────────────────────────────────────────────────────────
async function getTopMovers(limit = 10) {
    try {
        const res = await axios.get(`${BASE}/api/v3/ticker/24hr`, { timeout: 12000 });
        const usdt = res.data
            .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 1000000)
            .map(t => ({
                symbol: t.symbol,
                displaySymbol: t.symbol.replace('USDT', ''),
                price: parseFloat(t.lastPrice),
                change: parseFloat(t.priceChangePercent),
                volume: parseFloat(t.quoteVolume),
            }));

        const gainers = [...usdt].sort((a, b) => b.change - a.change).slice(0, limit);
        const losers = [...usdt].sort((a, b) => a.change - b.change).slice(0, limit);
        return { gainers, losers };
    } catch { return { gainers: [], losers: [] }; }
}

function isConfigured() {
    return !!(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY);
}

module.exports = {
    getPrice, get24hTicker, getBatchTickers, getKlines, getOrderBook,
    getAccount, placeOrder, cancelOrder, getOpenOrders, getRecentTrades,
    scanWatchlist, getTopMovers, isConfigured,
    MEME_COINS, ALT_COINS, DEFI_COINS,
};
