// execution.js — Trade execution (paper + live ready)
const axios = require('axios');

const HEADERS = {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BASE = process.env.ALPACA_BASE_URL;

const MODE = process.env.TRADING_MODE || 'paper'; // 'paper' or 'live'

const MAX_ML_NOTIONAL = 500; // hard cap per ML trade — prevents oversized orders from position-sizing math

async function executeBuy(symbol, size, price) {
    if (size <= 0) return { success: false, reason: 'size zero' };
    const rawNotional = size * price;
    const capped = rawNotional > MAX_ML_NOTIONAL;
    const notional = Math.min(rawNotional, MAX_ML_NOTIONAL).toFixed(2);
    if (capped) console.log(`[ML] ⚠️  Notional capped: ${symbol} $${rawNotional.toFixed(2)} → $${notional} (max $${MAX_ML_NOTIONAL})`);

    try {
        const res = await axios.post(`${BASE}/orders`, {
            symbol,
            side: 'buy',
            type: 'market',
            time_in_force: 'day',
            notional,
        }, { headers: HEADERS });
        return { success: true, orderId: res.data.id, symbol, side: 'buy', notional: parseFloat(notional), mode: MODE };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

async function executeSell(symbol, size, price) {
    if (size <= 0) return { success: false, reason: 'size zero' };

    // Get current position qty
    try {
        const posRes = await axios.get(`${BASE}/positions/${symbol}`, { headers: HEADERS });
        const qty = parseFloat(posRes.data.qty);
        const sellQty = Math.min(qty, size);

        const res = await axios.post(`${BASE}/orders`, {
            symbol,
            side: 'sell',
            type: 'market',
            time_in_force: 'day',
            qty: sellQty.toString(),
        }, { headers: HEADERS });
        return { success: true, orderId: res.data.id, symbol, side: 'sell', qty: sellQty, mode: MODE };
    } catch (err) {
        return { success: false, error: err.response?.data?.message || err.message };
    }
}

async function getAccount() {
    try {
        const res = await axios.get(`${BASE}/account`, { headers: HEADERS });
        return {
            equity:    parseFloat(res.data.equity),
            cash:      parseFloat(res.data.cash),
            portfolio: parseFloat(res.data.portfolio_value),
        };
    } catch { return { equity: 0, cash: 0, portfolio: 0 }; }
}

module.exports = { executeBuy, executeSell, getAccount, MODE };
